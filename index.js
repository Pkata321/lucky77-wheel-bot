/* lucky77-wheel-bot (Render) - v2
   - Group Register button (auto delete 30s)
   - Save members to Upstash Redis (new v2 keys to avoid WRONGTYPE)
   - Exclude OWNER/admin/bot from member pool
   - API for CodePen (members list, push winner DM)
*/

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

// ===================== ENV =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const API_KEY = process.env.API_KEY || "Lucky77_luckywheel_77";
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const OWNER_ID = process.env.OWNER_ID ? String(process.env.OWNER_ID) : null;
const GROUP_ID = process.env.GROUP_ID ? String(process.env.GROUP_ID) : null;

// Optional: comma separated admin ids to exclude too
const EXCLUDE_IDS = (process.env.EXCLUDE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(String);

// ===================== VALIDATION =====================
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing");
  process.exit(1);
}
if (!GROUP_ID) {
  console.error("GROUP_ID missing");
  process.exit(1);
}
if (!OWNER_ID) {
  console.error("OWNER_ID missing");
  process.exit(1);
}

// ===================== REDIS (v2 keys) =====================
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN
});

// Use NEW prefix to avoid WRONGTYPE from old keys
const KEY_PREFIX = "lucky77:v2";
const KEY_MEMBERS_SET = `${KEY_PREFIX}:members:set`; // SET of user_id (string)
const KEY_MEMBER_HASH = (userId) => `${KEY_PREFIX}:member:${userId}`; // HASH data
const KEY_WINNER_HISTORY = `${KEY_PREFIX}:winners:list`; // LIST of JSON strings

// ===================== TELEGRAM BOT =====================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let BOT_ID = null;
let BOT_USERNAME = null;

async function initBotIdentity() {
  const me = await bot.getMe();
  BOT_ID = String(me.id);
  BOT_USERNAME = me.username ? String(me.username) : null;
  console.log("Bot identity:", { BOT_ID, BOT_USERNAME });
}
initBotIdentity().catch((e) => console.error("getMe error", e));

// Exclude rule
function isExcludedUser(userId) {
  const id = String(userId);
  if (id === OWNER_ID) return true;
  if (id === BOT_ID) return true;
  if (EXCLUDE_IDS.includes(id)) return true;
  return false;
}

function displayNameFromUser(u) {
  const first = u.first_name || "";
  const last = u.last_name || "";
  const name = `${first} ${last}`.trim();
  const username = u.username ? `@${u.username}` : "";
  return (name || username || String(u.id)).trim();
}

// Save member (group register)
async function saveMemberFromUser(user, source = "group_register") {
  const userId = String(user.id);
  if (isExcludedUser(userId)) {
    return { ok: false, reason: "excluded" };
  }

  // SET add
  await redis.sadd(KEY_MEMBERS_SET, userId);

  // HASH set
  const data = {
    id: userId,
    username: user.username ? String(user.username) : "",
    first_name: user.first_name ? String(user.first_name) : "",
    last_name: user.last_name ? String(user.last_name) : "",
    name: `${user.first_name || ""} ${user.last_name || ""}`.trim(),
    source,
    registered_at: new Date().toISOString()
  };

  await redis.hset(KEY_MEMBER_HASH(userId), data);

  return { ok: true, member: data };
}

async function isRegistered(userId) {
  const exists = await redis.sismember(KEY_MEMBERS_SET, String(userId));
  return !!exists;
}

// Try DM user (will fail if user never started bot)
async function trySendDM(userId, text, extra = {}) {
  try {
    await bot.sendMessage(Number(userId), text, extra);
    return { ok: true };
  } catch (e) {
    // Common: 403 Forbidden / chat not found
    return { ok: false, error: e?.response?.body || e?.message || String(e) };
  }
}

// ===================== GROUP: join => send register button =====================
// Note: bot must be admin to reliably receive member join events & send messages
bot.on("message", async (msg) => {
  try {
    if (!msg.chat || String(msg.chat.id) !== String(GROUP_ID)) return;

    // When new members join
    if (msg.new_chat_members && msg.new_chat_members.length) {
      for (const m of msg.new_chat_members) {
        const userId = String(m.id);
        if (isExcludedUser(userId)) continue;

        // Send register prompt with inline button
        const already = await isRegistered(userId);

        const title = `🎡 Lucky77 Lucky Wheel`;
        const line1 = `မင်္ဂလာပါ ${displayNameFromUser(m)} 👋`;
        const line2 = already
          ? `✅ မင်းက Register လုပ်ပြီးသားပါ။`
          : `✅ Event ထဲဝင်ဖို့ အောက်က Register ကိုနှိပ်ပါ။`;

        const text = `${title}\n\n${line1}\n${line2}\n\n⏳ 30 စက္ကန့်အတွင်း မနှိပ်ရင် message auto-delete ဖြစ်ပါမယ်။`;

        const keyboard = {
          inline_keyboard: [
            [
              already
                ? { text: "✅ Registered", callback_data: `registered_noop:${userId}` }
                : { text: "✅ Register", callback_data: `register:${userId}` }
            ]
          ]
        };

        const sent = await bot.sendMessage(GROUP_ID, text, {
          reply_markup: keyboard
        });

        // Auto delete after 30s
        setTimeout(async () => {
          try {
            await bot.deleteMessage(GROUP_ID, sent.message_id);
          } catch (_) {
            // ignore (if already deleted / no rights)
          }
        }, 30000);
      }
    }
  } catch (e) {
    console.error("group message handler error:", e);
  }
});

// ===================== CALLBACK: register button =====================
bot.on("callback_query", async (cq) => {
  try {
    const data = cq.data || "";
    const from = cq.from;
    const fromId = String(from.id);

    // Quick answer to stop loading spinner
    const answer = async (text, alert = false) => {
      try {
        await bot.answerCallbackQuery(cq.id, { text, show_alert: alert });
      } catch (_) {}
    };

    if (data.startsWith("registered_noop:")) {
      await answer("✅ Registered ပြီးသားပါ။", false);
      return;
    }

    if (!data.startsWith("register:")) {
      await answer("Invalid action", false);
      return;
    }

    const targetId = data.split(":")[1]; // the user who should register
    if (!targetId || targetId !== fromId) {
      await answer("ဒီ Register ခလုတ်က မင်းအတွက်ပဲ သုံးလို့ရပါတယ်။", true);
      return;
    }

    if (isExcludedUser(fromId)) {
      await answer("Owner/Admin/Bot ကို Register မလုပ်ပါ။", true);
      return;
    }

    const already = await isRegistered(fromId);
    if (already) {
      await answer("✅ Registered ပြီးသားပါ။", false);

      // Update button to Registered
      if (cq.message) {
        try {
          await bot.editMessageReplyMarkup(
            {
              inline_keyboard: [[{ text: "✅ Registered", callback_data: `registered_noop:${fromId}` }]]
            },
            { chat_id: cq.message.chat.id, message_id: cq.message.message_id }
          );
        } catch (_) {}
      }
      return;
    }

    // Save
    const saved = await saveMemberFromUser(from, "group_register_button");
    if (!saved.ok) {
      await answer("Register မအောင်မြင်ပါ (excluded/unknown).", true);
      return;
    }

    // Popup (bigger alert)
    await answer("🎉 Register အောင်မြင်ပါတယ်!\n\n✅ မင်းနာမည် Lucky Wheel list ထဲ ဝင်သွားပြီ။", true);

    // Update button to Registered
    if (cq.message) {
      try {
        await bot.editMessageReplyMarkup(
          {
            inline_keyboard: [[{ text: "✅ Registered", callback_data: `registered_noop:${fromId}` }]]
          },
          { chat_id: cq.message.chat.id, message_id: cq.message.message_id }
        );
      } catch (_) {}
    }

    // Send optional DM welcome (if user started bot it will work; if not we guide)
    const welcomeText =
      "🎡 Lucky77 Lucky Wheel\n\n" +
      "✅ Register အောင်မြင်ပါတယ်။\n" +
      "Prize ပေါက်တဲ့အချိန်မှာ ဒီ DM ထဲကို auto message ပို့ပေးပါမယ်။";

    const dm = await trySendDM(fromId, welcomeText);
    if (!dm.ok) {
      // If DM fails, tell user to start bot (deep link)
      const startUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=join` : null;
      const msgText =
        `⚠️ ${displayNameFromUser(from)}\n\n` +
        `Prize DM လက်ခံဖို့ Bot ကို ၁ခါ "Start" လုပ်ရပါမယ်။\n` +
        `အောက်က Start Bot ကိုနှိပ်ပြီး /start လုပ်ပြီးပြန်လာပါ။`;

      const opts = startUrl
        ? {
            reply_markup: { inline_keyboard: [[{ text: "▶️ Start Bot", url: startUrl }]] }
          }
        : {};

      const note = await bot.sendMessage(GROUP_ID, msgText, opts);

      // auto delete that note after 30s too
      setTimeout(async () => {
        try {
          await bot.deleteMessage(GROUP_ID, note.message_id);
        } catch (_) {}
      }, 30000);
    }
  } catch (e) {
    console.error("callback_query error:", e);
  }
});

// ===================== PRIVATE CHAT: /start /register =====================
bot.onText(/\/start(?:\s+(.+))?/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const user = msg.from;

    if (msg.chat.type !== "private") return;

    const saved = await saveMemberFromUser(user, "private_start");
    const text =
      "🎡 Lucky77 Lucky Wheel\n\n" +
      "✅ Start အောင်မြင်ပါတယ်။\n" +
      "Prize ပေါက်တဲ့အချိန်မှာ ဒီ DM ထဲကို auto message ပို့ပေးပါမယ်။\n\n" +
      `Registered: ${saved.ok ? "YES" : "NO"}`;

    await bot.sendMessage(chatId, text);
  } catch (e) {
    console.error("/start error", e);
  }
});

bot.onText(/\/register/, async (msg) => {
  try {
    const user = msg.from;
    if (msg.chat.type !== "private") return;

    const already = await isRegistered(String(user.id));
    if (already) {
      await bot.sendMessage(msg.chat.id, "✅ Registered ပြီးသားပါ။");
      return;
    }

    const saved = await saveMemberFromUser(user, "private_register");
    if (saved.ok) {
      await bot.sendMessage(msg.chat.id, "🎉 Register အောင်မြင်ပါတယ် ✅");
    } else {
      await bot.sendMessage(msg.chat.id, "⚠️ Register မအောင်မြင်ပါ။");
    }
  } catch (e) {
    console.error("/register error", e);
  }
});

// ===================== EXPRESS API (for CodePen) =====================
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

function requireApiKey(req, res, next) {
  const k = req.headers["x-api-key"] || req.query.key;
  if (!k || String(k) !== String(API_KEY)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

app.get("/", (req, res) => {
  res.status(200).send(
    "Lucky77 wheel bot is running ✅\n\nEndpoints:\nGET /health\nGET /api/members?key=API_KEY\nPOST /api/winner?key=API_KEY"
  );
});

app.get("/health", async (req, res) => {
  try {
    const count = await redis.scard(KEY_MEMBERS_SET);
    res.json({
      ok: true,
      service: "lucky77-wheel-bot",
      members: Number(count) || 0,
      group_id: GROUP_ID,
      public_url: PUBLIC_URL || null
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// List members (for CodePen Settings / Members table)
app.get("/api/members", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const members = [];

    for (const id of ids || []) {
      const h = await redis.hgetall(KEY_MEMBER_HASH(id));
      if (!h || !h.id) continue;
      if (isExcludedUser(h.id)) continue;

      members.push({
        id: String(h.id),
        username: h.username || "",
        name: h.name || "",
        first_name: h.first_name || "",
        last_name: h.last_name || "",
        registered_at: h.registered_at || "",
        source: h.source || ""
      });
    }

    // Sort by registered time
    members.sort((a, b) => (a.registered_at || "").localeCompare(b.registered_at || ""));

    res.json({ ok: true, total: members.length, members });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Post winner: { user_id, prize, message? }
// -> DM winner (if possible). Also store winner history.
app.post("/api/winner", requireApiKey, async (req, res) => {
  try {
    const { user_id, prize, message } = req.body || {};
    if (!user_id || !prize) {
      return res.status(400).json({ ok: false, error: "user_id and prize required" });
    }

    const uid = String(user_id);
    const member = await redis.hgetall(KEY_MEMBER_HASH(uid));

    const winnerText =
      message ||
      `🎉 Congratulations!\n\nWinner: ${member?.username ? "@" + member.username : member?.name || uid}\nPrize: ${prize}`;

    const dm = await trySendDM(uid, winnerText);

    const item = {
      user_id: uid,
      prize: String(prize),
      dm_ok: dm.ok,
      dm_error: dm.ok ? "" : String(dm.error || ""),
      at: new Date().toISOString()
    };
    await redis.lpush(KEY_WINNER_HISTORY, JSON.stringify(item));
    await redis.ltrim(KEY_WINNER_HISTORY, 0, 200); // keep last 200

    res.json({ ok: true, dm: dm.ok, info: item });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Winner history
app.get("/api/winners", requireApiKey, async (req, res) => {
  try {
    const list = await redis.lrange(KEY_WINNER_HISTORY, 0, 200);
    const items = (list || []).map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return { raw: s };
      }
    });
    res.json({ ok: true, total: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Optional: clear v2 keys (admin only, using API key)
app.post("/api/admin/clear", requireApiKey, async (req, res) => {
  try {
    // delete v2 members + hashes + winners
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    for (const id of ids || []) {
      await redis.del(KEY_MEMBER_HASH(id));
    }
    await redis.del(KEY_MEMBERS_SET);
    await redis.del(KEY_WINNER_HISTORY);
    res.json({ ok: true, cleared: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

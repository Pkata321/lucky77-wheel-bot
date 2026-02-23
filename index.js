/* lucky77-wheel-bot (Render) - FINAL v3
   Goals:
   1) Group join => show Register button (auto delete 30s)
   2) Register click => save member to Redis immediately (NO need DM for saving)
   3) If member has username OR name => CodePen can use tg://resolve?domain=... (direct open chat)
   4) If member is ID-only => show Start Bot guide message after Register (auto delete 30s)
      - Once user starts bot in DM, then we can DM them later (notice)
   5) API for CodePen:
      - GET /api/members
      - POST /api/notice (send DM to user_id)
      - GET /api/winners
      - POST /api/winner (store winner history + DM if requested)
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

// optional excludes
const EXCLUDE_IDS = (process.env.EXCLUDE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(String);

function must(v, name) {
  if (!v) {
    console.error(`${name} missing`);
    process.exit(1);
  }
}

must(BOT_TOKEN, "BOT_TOKEN");
must(UPSTASH_REDIS_REST_URL, "UPSTASH_REDIS_REST_URL");
must(UPSTASH_REDIS_REST_TOKEN, "UPSTASH_REDIS_REST_TOKEN");
must(OWNER_ID, "OWNER_ID");
must(GROUP_ID, "GROUP_ID");

// ===================== REDIS =====================
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const KEY_PREFIX = "lucky77:v3";
const KEY_MEMBERS_SET = `${KEY_PREFIX}:members:set`;
const KEY_MEMBER_HASH = (uid) => `${KEY_PREFIX}:member:${uid}`;
const KEY_WINNER_HISTORY = `${KEY_PREFIX}:winners:list`;

// ===================== BOT =====================
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    params: {
      allowed_updates: ["message", "callback_query", "my_chat_member", "chat_member"],
    },
  },
});

let BOT_ID = null;
let BOT_USERNAME = null;

(async () => {
  try {
    const me = await bot.getMe();
    BOT_ID = String(me.id);
    BOT_USERNAME = me.username ? String(me.username) : null;
    console.log("Bot identity:", { BOT_ID, BOT_USERNAME });
  } catch (e) {
    console.error("getMe error:", e);
  }
})();

function isTargetGroup(chatId) {
  return String(chatId) === String(GROUP_ID);
}

function isExcludedUser(userId) {
  const id = String(userId);
  if (id === OWNER_ID) return true;
  if (BOT_ID && id === BOT_ID) return true;
  if (EXCLUDE_IDS.includes(id)) return true;
  return false;
}

function getNameParts(u) {
  const first = u.first_name || "";
  const last = u.last_name || "";
  const name = `${first} ${last}`.trim();
  const username = u.username ? String(u.username) : "";
  return { name, username };
}

function displayName(u) {
  const { name, username } = getNameParts(u);
  if (name) return name;
  if (username) return `@${username}`;
  return String(u.id);
}

async function isRegistered(uid) {
  const ok = await redis.sismember(KEY_MEMBERS_SET, String(uid));
  return !!ok;
}

// Save member immediately (group register)
async function saveMember(u, source) {
  const uid = String(u.id);
  if (isExcludedUser(uid)) return { ok: false, reason: "excluded" };

  const { name, username } = getNameParts(u);

  await redis.sadd(KEY_MEMBERS_SET, uid);
  await redis.hset(KEY_MEMBER_HASH(uid), {
    id: uid,
    username: username,
    name: name,
    first_name: u.first_name ? String(u.first_name) : "",
    last_name: u.last_name ? String(u.last_name) : "",
    source: String(source || ""),
    registered_at: new Date().toISOString(),
    // DM flag: set later when /start in private
    dm_ready: "0",
  });

  return {
    ok: true,
    member: { id: uid, username, name },
  };
}

// Mark DM-ready when user starts bot in private
async function setDmReady(uid) {
  try {
    await redis.hset(KEY_MEMBER_HASH(String(uid)), {
      dm_ready: "1",
      dm_ready_at: new Date().toISOString(),
    });
  } catch (_) {}
}

// Try DM (will fail if user never started bot)
async function trySendDM(uid, text) {
  try {
    await bot.sendMessage(Number(uid), text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.response?.body || e?.message || String(e) };
  }
}

async function sendAutoDelete(chatId, text, opts = {}, ms = 30000) {
  const sent = await bot.sendMessage(chatId, text, opts);
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, sent.message_id);
    } catch (_) {}
  }, ms);
  return sent;
}

// ========== Group: join -> register button ==========
async function sendRegisterButtonForUser(u) {
  const uid = String(u.id);
  if (isExcludedUser(uid)) return;

  const already = await isRegistered(uid);
  const text =
    `🎡 Lucky77 Lucky Wheel\n\n` +
    `မင်္ဂလာပါ ${displayName(u)} 👋\n` +
    (already
      ? `✅ မင်းက Register လုပ်ပြီးသားပါ။`
      : `✅ Event ထဲဝင်ဖို့ အောက်က Register ကိုနှိပ်ပါ။`) +
    `\n\n⏳ 30 စက္ကန့်အတွင်း မနှိပ်ရင် message auto-delete ဖြစ်ပါမယ်။`;

  const keyboard = {
    inline_keyboard: [
      [
        already
          ? { text: "✅ Registered", callback_data: `noop:${uid}` }
          : { text: "✅ Register", callback_data: `reg:${uid}` },
      ],
    ],
  };

  const msg = await bot.sendMessage(GROUP_ID, text, { reply_markup: keyboard });

  setTimeout(async () => {
    try {
      await bot.deleteMessage(GROUP_ID, msg.message_id);
    } catch (_) {}
  }, 30000);
}

bot.on("message", async (msg) => {
  try {
    if (!msg.chat) return;

    // Group join event
    if (isTargetGroup(msg.chat.id) && msg.new_chat_members?.length) {
      for (const m of msg.new_chat_members) {
        await sendRegisterButtonForUser(m);
      }
    }
  } catch (e) {
    console.error("message handler error:", e);
  }
});

// Group command /register (optional helper)
bot.onText(/\/register(@\w+)?/i, async (msg) => {
  try {
    if (!msg.chat) return;
    if (!isTargetGroup(msg.chat.id)) return;
    if (!["group", "supergroup"].includes(msg.chat.type)) return;

    const mention = (msg.text || "").match(/\/register(@\w+)?/i)?.[1] || "";
    if (mention && BOT_USERNAME && mention.toLowerCase() !== `@${BOT_USERNAME}`.toLowerCase()) return;

    if (msg.from) await sendRegisterButtonForUser(msg.from);
  } catch (e) {
    console.error("group /register error:", e);
  }
});

// ========== Callback: register ==========
bot.on("callback_query", async (cq) => {
  try {
    const data = cq.data || "";
    const from = cq.from;
    const fromId = String(from.id);

    const answer = async (text, alert = false) => {
      try {
        await bot.answerCallbackQuery(cq.id, { text, show_alert: alert });
      } catch (_) {}
    };

    if (data.startsWith("noop:")) {
      await answer("✅ Registered ပြီးသားပါ။", false);
      return;
    }

    if (!data.startsWith("reg:")) {
      await answer("Invalid action", false);
      return;
    }

    const targetId = data.split(":")[1];
    if (String(targetId) !== fromId) {
      await answer("ဒီ Register ခလုတ်က မင်းအတွက်ပဲ သုံးလို့ရပါတယ်။", true);
      return;
    }

    if (isExcludedUser(fromId)) {
      await answer("Owner/Admin/Bot ကို Register မလုပ်ပါ။", true);
      return;
    }

    const already = await isRegistered(fromId);
    if (already) {
      await answer("✅ Registered ပြီးသားပါ။", true);
    } else {
      const saved = await saveMember(from, "group_register");
      if (!saved.ok) {
        await answer("Register မအောင်မြင်ပါ။", true);
        return;
      }
      await answer("🎉 Register အောင်မြင်ပါတယ်!\n\n✅ Lucky Wheel list ထဲ ဝင်သွားပြီ။", true);
    }

    // lock button to Registered
    if (cq.message) {
      try {
        await bot.editMessageReplyMarkup(
          {
            inline_keyboard: [[{ text: "✅ Registered", callback_data: `noop:${fromId}` }]],
          },
          { chat_id: cq.message.chat.id, message_id: cq.message.message_id }
        );
      } catch (_) {}
    }

    // If username OR name missing => guide Start bot (for DM notice later)
    const { name, username } = getNameParts(from);
    const needStart = !username && !name;

    if (needStart) {
      // show guidance in group (auto delete)
      const startUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=dmready` : null;
      const guideText =
        `⚠️ ${displayName(from)}\n\n` +
        `မင်းရဲ့ Username / Name မရှိလို့ Direct Telegram link မလုပ်နိုင်ပါ။\n\n` +
        `Prize ပေါက်တဲ့အခါ "Notice" နဲ့ DM auto ပို့ဖို့ Bot ကို ၁ခါ "Start" လုပ်ပေးရပါမယ် ✅`;

      const opts = startUrl
        ? { reply_markup: { inline_keyboard: [[{ text: "▶️ Start Bot (DM Enable)", url: startUrl }]] } }
        : {};

      await sendAutoDelete(GROUP_ID, guideText, opts, 30000);
    }

  } catch (e) {
    console.error("callback_query error:", e);
  }
});

// ========== Private: /start marks dm_ready ==========
bot.onText(/\/start(?:\s+(.+))?/i, async (msg) => {
  try {
    if (msg.chat.type !== "private") return;
    const u = msg.from;
    if (!u) return;

    // Ensure saved
    await saveMember(u, "private_start");
    await setDmReady(u.id);

    await bot.sendMessage(
      msg.chat.id,
      "✅ DM Enable ပြီးပါပြီ။\nPrize ပေါက်တဲ့အချိန် Notice နဲ့ ဒီ DM ထဲကို message လာပါမယ် 🎉"
    );
  } catch (e) {
    console.error("/start error:", e);
  }
});

// ===================== EXPRESS API =====================
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

app.get("/health", async (req, res) => {
  try {
    const count = await redis.scard(KEY_MEMBERS_SET);
    res.json({
      ok: true,
      service: "lucky77-wheel-bot",
      members: Number(count) || 0,
      group_id: GROUP_ID,
      public_url: PUBLIC_URL || null,
      bot_username: BOT_USERNAME || null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// members list (CodePen Settings / Member panel)
app.get("/api/members", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const members = [];

    for (const id of ids || []) {
      const h = await redis.hgetall(KEY_MEMBER_HASH(id));
      if (!h || !h.id) continue;
      if (isExcludedUser(h.id)) continue;

      const name = (h.name || "").trim();
      const username = (h.username || "").trim();
      members.push({
        id: String(h.id),
        name,
        username, // no '@' here
        dm_ready: String(h.dm_ready || "0") === "1",
        registered_at: h.registered_at || "",
        source: h.source || "",
      });
    }

    members.sort((a, b) => (a.registered_at || "").localeCompare(b.registered_at || ""));
    res.json({ ok: true, total: members.length, members });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Notice (for ID-only winners): { user_id, text }
app.post("/api/notice", requireApiKey, async (req, res) => {
  try {
    const { user_id, text } = req.body || {};
    if (!user_id || !text) return res.status(400).json({ ok: false, error: "user_id and text required" });

    const uid = String(user_id);
    const dm = await trySendDM(uid, String(text));

    res.json({ ok: true, dm_ok: dm.ok, dm_error: dm.ok ? "" : String(dm.error || "") });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Winner: store winner history, optional dm via user_id
app.post("/api/winner", requireApiKey, async (req, res) => {
  try {
    const { user_id, prize, message, send_dm } = req.body || {};
    if (!user_id || !prize) return res.status(400).json({ ok: false, error: "user_id and prize required" });

    const uid = String(user_id);
    const member = await redis.hgetall(KEY_MEMBER_HASH(uid));
    const show =
      (member?.name && member.name.trim()) ||
      (member?.username && ("@" + member.username.trim())) ||
      uid;

    const text = message || `🎉 Winner!\n\n${show}\nPrize: ${prize}`;

    let dm = { ok: false, error: "" };
    if (send_dm) {
      dm = await trySendDM(uid, text);
    }

    const item = {
      user_id: uid,
      prize: String(prize),
      display: show,
      dm_ok: !!dm.ok,
      dm_error: dm.ok ? "" : String(dm.error || ""),
      at: new Date().toISOString(),
    };

    await redis.lpush(KEY_WINNER_HISTORY, JSON.stringify(item));
    await redis.ltrim(KEY_WINNER_HISTORY, 0, 200);

    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/api/winners", requireApiKey, async (req, res) => {
  try {
    const list = await redis.lrange(KEY_WINNER_HISTORY, 0, 200);
    const items = (list || []).map((s) => {
      try { return JSON.parse(s); } catch { return { raw: s }; }
    });
    res.json({ ok: true, total: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/", (req, res) => {
  res.status(200).send(
    "Lucky77 wheel bot is running ✅\n\n" +
    "GET /health\n" +
    "GET /api/members?key=API_KEY\n" +
    "POST /api/notice?key=API_KEY\n" +
    "POST /api/winner?key=API_KEY\n" +
    "GET /api/winners?key=API_KEY\n"
  );
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));

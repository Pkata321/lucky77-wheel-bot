/* lucky77-wheel-bot v2
 * - Group join -> send Register button
 * - Register click -> popup (alert) + save user + change button to "Registered ✅"
 * - If not clicked within 30s -> pin the message (requires bot pin rights)
 * - API endpoints for CodePen: list, pick, clear, notify winner DM
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN;

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const PUBLIC_URL = process.env.PUBLIC_URL; // https://lucky77-wheel-bot.onrender.com
const API_KEY = process.env.API_KEY;       // Lucky77_luckywheel_77 (your value)

const OWNER_ID = process.env.OWNER_ID ? String(process.env.OWNER_ID) : null;
// IMPORTANT: supergroup id should be like -1003542073765
const GROUP_ID = process.env.GROUP_ID ? String(process.env.GROUP_ID) : null;

// optional: exclude admins from participants (true/false)
const EXCLUDE_ADMINS = String(process.env.EXCLUDE_ADMINS || "true").toLowerCase() === "true";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN missing");
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.error("PUBLIC_URL missing");
  process.exit(1);
}
if (!API_KEY) {
  console.error("API_KEY missing");
  process.exit(1);
}
if (!GROUP_ID) {
  console.error("GROUP_ID missing (should be like -100xxxxxxxxxx)");
  process.exit(1);
}

// ---------- Redis ----------
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN
});

// v2 prefix to avoid WRONGTYPE with old keys
const PREFIX = "lucky77:v2:";
const KEY_MEMBERS_SET = `${PREFIX}members`;           // Set of user_ids
const KEY_USER_PREFIX = `${PREFIX}user:`;             // user:<id> -> JSON
const KEY_LAST_WINNERS = `${PREFIX}winners:last`;     // List (LPUSH)

// ---------- Bot ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// store pending register message ids -> used for 30s pin logic
// key: `${chatId}:${userId}` -> { chatId, userId, messageId, expiresAt }
const pendingRegister = new Map();

// ---------- Helpers ----------
function isTargetGroup(chatId) {
  return String(chatId) === String(GROUP_ID);
}

function displayNameOf(user) {
  const first = user.first_name || "";
  const last = user.last_name || "";
  const full = `${first} ${last}`.trim();
  if (full) return full;
  if (user.username) return `@${user.username}`;
  return `ID:${user.id}`;
}

async function isAlreadyRegistered(userId) {
  const exists = await redis.sismember(KEY_MEMBERS_SET, String(userId));
  return !!exists;
}

async function saveUser(user, chatId) {
  const userId = String(user.id);

  // exclude bots always
  if (user.is_bot) return { ok: false, reason: "BOT_USER" };

  // exclude owner
  if (OWNER_ID && userId === String(OWNER_ID)) return { ok: false, reason: "OWNER_EXCLUDED" };

  // exclude admins (optional)
  if (EXCLUDE_ADMINS) {
    try {
      const member = await bot.getChatMember(chatId, user.id);
      const status = member?.status; // creator/administrator/member/restricted/left/kicked
      if (status === "creator" || status === "administrator") {
        return { ok: false, reason: "ADMIN_EXCLUDED" };
      }
    } catch (e) {
      // if cannot check, do not block; just continue
    }
  }

  // add to set
  await redis.sadd(KEY_MEMBERS_SET, userId);

  // store user profile
  const profile = {
    id: userId,
    username: user.username || null,
    first_name: user.first_name || null,
    last_name: user.last_name || null,
    chat_id: String(chatId),
    registered_at: Date.now()
  };
  await redis.set(`${KEY_USER_PREFIX}${userId}`, JSON.stringify(profile));

  return { ok: true, profile };
}

function registerKeyboard(registered) {
  if (registered) {
    return {
      inline_keyboard: [
        [{ text: "Registered ✅", callback_data: "registered_done" }]
      ]
    };
  }
  return {
    inline_keyboard: [
      [{ text: "✅ Register", callback_data: "register" }]
    ]
  };
}

async function safeDeleteMessage(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (e) {
    // ignore
  }
}

async function safePinMessage(chatId, messageId) {
  try {
    await bot.pinChatMessage(chatId, messageId, { disable_notification: true });
  } catch (e) {
    // ignore
  }
}

// ---------- Join event -> send Register button ----------
bot.on("message", async (msg) => {
  if (!msg || !msg.chat) return;

  // /id command (to help get group id)
  if (msg.text && msg.text.trim() === "/id") {
    const chatId = String(msg.chat.id);
    const reply =
      `✅ Chat ID: ${chatId}\n` +
      `Type: ${msg.chat.type}\n` +
      `Title: ${msg.chat.title || "-"}\n\n` +
      `If you see t.me/c/XXXXXXXXX/... then GROUP_ID should be: -100XXXXXXXXX`;
    await bot.sendMessage(msg.chat.id, reply);
    return;
  }

  // Only handle target group
  if (!isTargetGroup(msg.chat.id)) return;

  // when user joins (new_chat_members)
  if (Array.isArray(msg.new_chat_members) && msg.new_chat_members.length > 0) {
    for (const u of msg.new_chat_members) {
      // ignore bots joining
      if (u.is_bot) continue;

      const userId = String(u.id);
      const already = await isAlreadyRegistered(userId);

      // send register message
      const text =
        `🎉 Welcome ${displayNameOf(u)}!\n\n` +
        `✅ Event ဝင်ရန် **Register** ကိုနှိပ်ပါ။\n` +
        `⏳ 30 seconds အတွင်းမနှိပ်ရင် message ကို Pin ထိုးထားပါမယ်။`;

      const sent = await bot.sendMessage(msg.chat.id, text, {
        parse_mode: "Markdown",
        reply_markup: registerKeyboard(already)
      });

      // if already registered, no need pin logic
      if (already) continue;

      // store pending for 30 sec
      const key = `${msg.chat.id}:${userId}`;
      pendingRegister.set(key, {
        chatId: msg.chat.id,
        userId,
        messageId: sent.message_id,
        expiresAt: Date.now() + 30_000
      });

      setTimeout(async () => {
        const item = pendingRegister.get(key);
        if (!item) return;

        // if user registered within 30 sec, delete message
        const nowRegistered = await isAlreadyRegistered(userId);
        if (nowRegistered) {
          await safeDeleteMessage(item.chatId, item.messageId);
          pendingRegister.delete(key);
          return;
        }

        // else pin the message
        await safePinMessage(item.chatId, item.messageId);
        pendingRegister.delete(key);
      }, 30_000);
    }
  }
});

// ---------- Button click handler ----------
bot.on("callback_query", async (q) => {
  const data = q.data;
  const msg = q.message;
  const from = q.from;

  if (!msg || !msg.chat) return;

  // only group we configured
  if (!isTargetGroup(msg.chat.id)) {
    // show popup
    try {
      await bot.answerCallbackQuery(q.id, {
        text: "❌ This bot is not configured for this group.\nGROUP_ID ကိုမှန်အောင်ပြင်ပါ။",
        show_alert: true
      });
    } catch {}
    return;
  }

  // if user presses Registered ✅ button -> do nothing popup off
  if (data === "registered_done") {
    try {
      await bot.answerCallbackQuery(q.id, {
        text: "✅ Already Registered",
        show_alert: false
      });
    } catch {}
    return;
  }

  if (data !== "register") return;

  const userId = String(from.id);

  // Already registered -> update UI and no popup
  const already = await isAlreadyRegistered(userId);
  if (already) {
    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: "Registered ✅", callback_data: "registered_done" }]] },
        { chat_id: msg.chat.id, message_id: msg.message_id }
      );
    } catch {}
    try {
      await bot.answerCallbackQuery(q.id, { text: "✅ Already Registered", show_alert: false });
    } catch {}
    return;
  }

  // Save user
  const result = await saveUser(from, msg.chat.id);

  if (!result.ok) {
    let reasonText = "❌ Cannot register.";
    if (result.reason === "ADMIN_EXCLUDED") reasonText = "❌ Admin/Owner ကို Prize ထဲမထည့်ပါ။";
    if (result.reason === "OWNER_EXCLUDED") reasonText = "❌ Owner ကို Prize ထဲမထည့်ပါ။";
    if (result.reason === "BOT_USER") reasonText = "❌ Bot ကို Prize ထဲမထည့်ပါ။";

    try {
      await bot.answerCallbackQuery(q.id, { text: reasonText, show_alert: true });
    } catch {}
    // also update UI to disabled state (optional)
    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: "Not eligible ❌", callback_data: "registered_done" }]] },
        { chat_id: msg.chat.id, message_id: msg.message_id }
      );
    } catch {}
    return;
  }

  // BIG popup message (show_alert=true)
  const popup =
    "🎉 Registered Successful!\n\n" +
    "✅ သင့်အကောင့်ဟာ Lucky77 Lucky Wheel Event Prize List ထဲဝင်ပြီးပါပြီ။\n" +
    "🏆 Prize ပေါက်တဲ့အခါ Bot က သင့်ကို DM ဖြင့် အလိုအလျောက် အသိပေးပါမယ်။\n\n" +
    "Good Luck 🍀";

  try {
    await bot.answerCallbackQuery(q.id, { text: popup, show_alert: true });
  } catch {}

  // Change button to Registered ✅ and prevent re-click
  try {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [[{ text: "Registered ✅", callback_data: "registered_done" }]] },
      { chat_id: msg.chat.id, message_id: msg.message_id }
    );
  } catch {}

  // if that message was pending pin timer, remove pending and delete message after 2 sec (nice)
  const key = `${msg.chat.id}:${userId}`;
  if (pendingRegister.has(key)) pendingRegister.delete(key);
});

// ---------- Express API (for CodePen later) ----------
const app = express();
app.use(cors());
app.use(express.json());

// Auth middleware
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api_key || req.body?.api_key;
  if (!key || String(key) !== String(API_KEY)) {
    return res.status(401).json({ ok: false, error: "Invalid API key" });
  }
  next();
}

// health
app.get("/", async (req, res) => {
  try {
    const count = await redis.scard(KEY_MEMBERS_SET);
    res.json({
      ok: true,
      service: "lucky77-wheel-bot",
      version: "2.0.0",
      group_id: GROUP_ID,
      public_url: PUBLIC_URL,
      participants: count
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// list participants
app.get("/participants", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    res.json({ ok: true, count: ids.length, ids });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// clear all
app.post("/clear", requireApiKey, async (req, res) => {
  try {
    // delete set + winners list (keep user profiles optional)
    await redis.del(KEY_MEMBERS_SET);
    await redis.del(KEY_LAST_WINNERS);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// pick random winner (returns userId)
app.post("/pick", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    if (!ids || ids.length === 0) return res.json({ ok: false, error: "No participants" });

    const idx = Math.floor(Math.random() * ids.length);
    const winnerId = String(ids[idx]);

    // store history
    await redis.lpush(KEY_LAST_WINNERS, JSON.stringify({ user_id: winnerId, ts: Date.now() }));
    await redis.ltrim(KEY_LAST_WINNERS, 0, 49); // keep last 50

    res.json({ ok: true, winner_id: winnerId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// get winners history
app.get("/winners", requireApiKey, async (req, res) => {
  try {
    const items = await redis.lrange(KEY_LAST_WINNERS, 0, 49);
    const parsed = (items || []).map((x) => {
      try { return JSON.parse(x); } catch { return x; }
    });
    res.json({ ok: true, items: parsed });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// notify winner DM
app.post("/notify-winner", requireApiKey, async (req, res) => {
  try {
    const user_id = req.body?.user_id ? String(req.body.user_id) : null;
    const text = req.body?.text ? String(req.body.text) : null;

    if (!user_id || !text) return res.status(400).json({ ok: false, error: "user_id and text required" });

    // send DM (works only if user already started/registered so bot can DM)
    await bot.sendMessage(Number(user_id), text);

    res.json({ ok: true });
  } catch (e) {
    // if user never started bot, Telegram returns 403
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Public URL: ${PUBLIC_URL}`);
});

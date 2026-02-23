/**
 * lucky77-wheel-bot (Render)
 * - Group Register Button (auto delete after 30s)
 * - Block Owner/Admin from registering
 * - Store participants in Upstash Redis (HASH)
 * - Track DM-OK users (SET) when they /start in private
 * - /id command to get chat id
 */

require("dotenv").config();

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

const BOT_TOKEN = process.env.BOT_TOKEN;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const API_KEY = process.env.API_KEY || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const OWNER_ID = process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null;
const GROUP_ID = process.env.GROUP_ID ? Number(process.env.GROUP_ID) : null;

// IMPORTANT: Use a NEW prefix to avoid WRONGTYPE from old keys
const PREFIX = process.env.KEY_PREFIX || "lucky77:v2:";

// Redis keys
const KEY_MEMBERS_HASH = `${PREFIX}members_hash`; // HASH: userId -> json string
const KEY_DM_OK_SET = `${PREFIX}dm_ok`; // SET: userId
const KEY_WINNERS_LIST = `${PREFIX}winners`; // LIST: json strings (optional)

// --- sanity checks ---
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN missing");
  process.exit(1);
}

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const app = express();
app.use(express.json());

// Telegram bot (polling)
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// -------------------------
// Helpers
// -------------------------
function isSameGroup(chatId) {
  // If GROUP_ID is not set, allow all (but recommended to set)
  if (!GROUP_ID) return true;
  return Number(chatId) === Number(GROUP_ID);
}

function displayName(u) {
  const fn = (u.first_name || "").trim();
  const ln = (u.last_name || "").trim();
  const full = `${fn} ${ln}`.trim();
  return full || "(no_name)";
}

async function isAdminOrCreator(chatId, userId) {
  try {
    const m = await bot.getChatMember(chatId, userId);
    return m && (m.status === "administrator" || m.status === "creator");
  } catch (e) {
    // If cannot check, be safe: treat as not admin
    return false;
  }
}

async function saveMember({ user_id, username, name }) {
  const payload = {
    user_id,
    username: username || null,
    name: name || null,
    created_at: new Date().toISOString(),
  };
  await redis.hset(KEY_MEMBERS_HASH, {
    [String(user_id)]: JSON.stringify(payload),
  });
  return payload;
}

async function getMember(userId) {
  const raw = await redis.hget(KEY_MEMBERS_HASH, String(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function membersCount() {
  const all = await redis.hgetall(KEY_MEMBERS_HASH);
  return all ? Object.keys(all).length : 0;
}

async function autoDelete(chatId, messageId, seconds = 30) {
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (e) {
      // ignore (no permission / already deleted)
    }
  }, seconds * 1000);
}

// -------------------------
// Express API (for CodePen later)
// -------------------------
app.get("/", async (req, res) => {
  res.json({
    ok: true,
    service: "lucky77-wheel-bot",
    public_url: PUBLIC_URL,
    group_id: GROUP_ID || null,
    members_count: await membersCount(),
  });
});

app.get("/participants", async (req, res) => {
  const all = await redis.hgetall(KEY_MEMBERS_HASH);
  const list = Object.values(all || {}).map((v) => {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }).filter(Boolean);
  res.json({ ok: true, count: list.length, participants: list });
});

// Add/Upsert participant (protected for CodePen/admin)
app.post("/participants", async (req, res) => {
  const key = req.headers["x-api-key"] || req.query.api_key || "";
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const { user_id, username, name } = req.body || {};
  if (!user_id) return res.status(400).json({ ok: false, error: "user_id required" });

  const saved = await saveMember({
    user_id: Number(user_id),
    username: username || null,
    name: name || null,
  });
  res.json({ ok: true, member: saved });
});

// Push winner history (optional)
app.post("/winners", async (req, res) => {
  const key = req.headers["x-api-key"] || req.query.api_key || "";
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const data = req.body || {};
  data.created_at = new Date().toISOString();
  await redis.lpush(KEY_WINNERS_LIST, JSON.stringify(data));
  res.json({ ok: true });
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log("Server running on port", port);
  if (PUBLIC_URL) console.log("Public URL:", PUBLIC_URL);
});

// -------------------------
// Telegram: Private /start (DM ok tracking)
// -------------------------
bot.onText(/^\/start\b/, async (msg) => {
  // only private chat
  if (msg.chat.type !== "private") return;

  const uid = msg.from.id;
  await redis.sadd(KEY_DM_OK_SET, String(uid));

  const text =
    "✅ OK! သင့်အကောင့်ကို Lucky77 Event စာရင်းအတွက် DM ဆက်သွယ်နိုင်အောင် Activate လုပ်ပြီးပါပြီ။\n\n" +
    "Group ထဲမှာ Register ကိုနှိပ်ပြီးသားဆိုရင် Prize ပေါက်တဲ့အချိန် DM ပို့လို့ရပါပြီ။";
  bot.sendMessage(msg.chat.id, text);
});

// -------------------------
// Telegram: /id command (Group ID)
// -------------------------
bot.onText(/^\/id\b/, async (msg) => {
  const chatId = msg.chat.id;
  const t = `✅ Chat ID = ${chatId}`;
  bot.sendMessage(chatId, t);
});

// -------------------------
// Telegram: On new member join => send Register button (auto delete 30s)
// -------------------------
bot.on("message", async (msg) => {
  if (!msg.chat) return;

  // if new members joined (join event)
  if (msg.new_chat_members && msg.new_chat_members.length > 0) {
    const chatId = msg.chat.id;

    // If group locked and not same group, do nothing
    if (!isSameGroup(chatId)) return;

    const registerKeyboard = {
      inline_keyboard: [
        [{ text: "✅ Register", callback_data: "REGISTER" }],
        [{ text: "🤖 Start Bot (DM Enable)", url: `https://t.me/${(await bot.getMe()).username}?start=ok` }],
      ],
    };

    const welcome =
      "🎉 Lucky77 Lucky Wheel Event\n\n" +
      "✅ Register လုပ်ရန် အောက်က Register ကိုနှိပ်ပါ။\n" +
      "⚠️ Prize ပေါက်တဲ့အချိန် DM ရချင်ရင် ‘Start Bot (DM Enable)’ ကို တစ်ခါနှိပ်ထားရမယ် (Telegram rule)။\n\n" +
      "⏳ ဒီ message ကို 30 seconds အတွင်း Auto Delete လုပ်ပါမယ်။";

    try {
      const sent = await bot.sendMessage(chatId, welcome, {
        reply_markup: registerKeyboard,
      });
      await autoDelete(chatId, sent.message_id, 30);
    } catch (e) {
      // ignore
    }
  }
});

// -------------------------
// Telegram: Callback Query for REGISTER
// -------------------------
bot.on("callback_query", async (q) => {
  const msg = q.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const user = q.from;

  // Group lock check
  if (!isSameGroup(chatId)) {
    return bot.answerCallbackQuery(q.id, {
      text: "❌ This bot is not configured for this group.",
      show_alert: true,
    });
  }

  if (q.data !== "REGISTER") return;

  // Block owner
  if (OWNER_ID && Number(user.id) === Number(OWNER_ID)) {
    return bot.answerCallbackQuery(q.id, {
      text: "❌ Owner account ကို Register မလုပ်နိုင်ပါ။",
      show_alert: true,
    });
  }

  // Block admins/creator
  const isAdmin = await isAdminOrCreator(chatId, user.id);
  if (isAdmin) {
    return bot.answerCallbackQuery(q.id, {
      text: "❌ Admin/Creator account ကို Register မလုပ်နိုင်ပါ။",
      show_alert: true,
    });
  }

  // Already registered?
  const existing = await getMember(user.id);
  if (existing) {
    // popup only (no repeated register)
    return bot.answerCallbackQuery(q.id, {
      text: "✅ Registered ပြီးသားပါ။",
      show_alert: true,
    });
  }

  // Save member immediately (no DM needed)
  const saved = await saveMember({
    user_id: user.id,
    username: user.username ? `@${user.username}` : null,
    name: displayName(user),
  });

  // Popup
  await bot.answerCallbackQuery(q.id, {
    text: "✅ Register အောင်မြင်ပါတယ်! (List ထဲဝင်ပြီးပါပြီ)",
    show_alert: true,
  });

  // Send group confirmation + auto delete 30s
  const confirmText =
    `✅ Registered!\n` +
    `• Name: ${saved.username || saved.name}\n` +
    `• ID: ${saved.user_id}\n\n` +
    `⏳ This message will be deleted in 30s.`;

  try {
    const sent = await bot.sendMessage(chatId, confirmText);
    await autoDelete(chatId, sent.message_id, 30);
  } catch (e) {
    // ignore
  }
});

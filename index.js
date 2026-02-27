"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

// ===================== ENV =====================
const {
  BOT_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  OWNER_ID,
  API_KEY,
  GROUP_ID,
  PUBLIC_URL,
  WEBHOOK_SECRET,

  EXCLUDE_IDS,
  DM_SILENT,
  PIN_REGISTER_MSG
} = process.env;

function must(v, name) {
  if (!v || String(v).trim() === "") throw new Error(`Missing env: ${name}`);
}

must(BOT_TOKEN, "BOT_TOKEN");
must(UPSTASH_REDIS_REST_URL, "UPSTASH_REDIS_REST_URL");
must(UPSTASH_REDIS_REST_TOKEN, "UPSTASH_REDIS_REST_TOKEN");
must(OWNER_ID, "OWNER_ID");
must(API_KEY, "API_KEY");
must(GROUP_ID, "GROUP_ID");
must(PUBLIC_URL, "PUBLIC_URL");
must(WEBHOOK_SECRET, "WEBHOOK_SECRET");

// ===================== CONST / KEYS =====================
const PORT = Number(process.env.PORT || 10000);
const GROUP_ID_STR = String(GROUP_ID);

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN
});

const KEY_MEMBERS_SET = "members:set";
const KEY_MEMBER_HASH_PREFIX = "member:"; // member:<id>
const KEY_HISTORY = "spin:history"; // list of json
const KEY_WINNERS = "spin:winners"; // list of json
const KEY_PRIZES = "prizes:all"; // json array
const KEY_POOL = "prize:pool"; // list
const KEY_LAST_GROUP_SEEN = "group:last_seen";
const KEY_DM_READY_PREFIX = "dm:ready:"; // dm:ready:<id> = "1"
const KEY_DM_PIN_MSG_PREFIX = "dm:pinmsg:"; // dm:pinmsg:<id> = messageId
const KEY_WELCOME_SENT_PREFIX = "welcome:sent:"; // welcome:sent:<userId> anti-spam

// ===================== HELPERS =====================
const excludedSet = new Set(
  String(EXCLUDE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function isExcludedUser(userId) {
  return excludedSet.has(String(userId));
}

function isOwner(userId) {
  return String(userId) === String(OWNER_ID);
}

function targetGroup(chat) {
  if (!chat) return false;
  const type = String(chat.type || "");
  if (type !== "group" && type !== "supergroup") return false;
  return String(chat.id) === GROUP_ID_STR;
}

function fullName(u) {
  const fn = (u.first_name || "").trim();
  const ln = (u.last_name || "").trim();
  const name = `${fn} ${ln}`.trim();
  return name || (u.username ? `@${u.username}` : String(u.id));
}

async function saveMember(u, source) {
  if (!u || !u.id) return { ok: false, reason: "no_user" };
  if (isExcludedUser(u.id)) return { ok: false, reason: "excluded" };

  const id = String(u.id);
  const username = u.username ? String(u.username) : "";
  const name = fullName(u);

  // store member record
  await redis.set(`${KEY_MEMBER_HASH_PREFIX}${id}`, JSON.stringify({
    id,
    username,
    name,
    source: source || "",
    updated_at: new Date().toISOString()
  }));

  // member set
  await redis.sadd(KEY_MEMBERS_SET, id);

  return { ok: true };
}

async function getMember(id) {
  const raw = await redis.get(`${KEY_MEMBER_HASH_PREFIX}${String(id)}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function setDmReady(userId) {
  await redis.set(`${KEY_DM_READY_PREFIX}${String(userId)}`, "1");
}

async function isDmReady(userId) {
  return (await redis.get(`${KEY_DM_READY_PREFIX}${String(userId)}`)) === "1";
}

async function safeDelete(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (_) {
    // ignore
  }
}

async function autoDelete(chatId, messageId, ms = 2500) {
  setTimeout(() => safeDelete(chatId, messageId), ms);
}

function requireApiKey(req, res) {
  const k = String(req.query.key || "");
  if (k !== String(API_KEY)) {
    res.status(401).json({ ok: false, error: "invalid_key" });
    return false;
  }
  return true;
}

async function ensurePoolFromPrizes(prizes) {
  // reset pool list
  await redis.del(KEY_POOL);
  if (!Array.isArray(prizes)) return;
  for (const p of prizes) {
    const t = String(p || "").trim();
    if (t) await redis.rpush(KEY_POOL, t);
  }
}

async function getPrizes() {
  const raw = await redis.get(KEY_PRIZES);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ===================== BOT (WEBHOOK MODE) =====================
// IMPORTANT: do NOT use polling -> avoids 409 conflict
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

let BOT_USERNAME = null;
let REGISTER_DEEP_LINK = null;

async function initBotProfile() {
  const me = await bot.getMe();
  BOT_USERNAME = me.username;
  REGISTER_DEEP_LINK = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=register` : null;
}

// ===================== EXPRESS =====================
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Webhook endpoint (Telegram -> Render)
app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  try {
    bot.processUpdate(req.body);
  } catch (e) {
    console.error("processUpdate error:", e);
  }
  res.sendStatus(200);
});

// Health (no key)
app.get("/health", async (req, res) => {
  const members = await redis.scard(KEY_MEMBERS_SET);
  const winners = await redis.llen(KEY_WINNERS);
  const remaining = await redis.llen(KEY_POOL);
  const lastGroupSeen = await redis.get(KEY_LAST_GROUP_SEEN);

  res.json({
    ok: true,
    bot_username: BOT_USERNAME,
    group_id_env: String(GROUP_ID),
    last_group_seen: lastGroupSeen ? String(lastGroupSeen) : null,
    members,
    winners,
    remaining_prizes: remaining,
    time: new Date().toISOString()
  });
});

// Members (key)
app.get("/members", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const ids = await redis.smembers(KEY_MEMBERS_SET);
  const list = [];
  for (const id of ids || []) {
    const m = await getMember(id);
    if (m) list.push(m);
  }
  res.json({ ok: true, count: list.length, members: list });
});

// Pool (key)
app.get("/pool", async (req, res) => {
  if (!requireApiKey(req, res)) return;
  const pool = await redis.lrange(KEY_POOL, 0, 9999);
  res.json({ ok: true, count: (pool || []).length, pool: pool || [] });
});

// History (key)
app.get("/history", async (req, res) => {
  if (!requireApiKey(req, res)) return;
  const items = await redis.lrange(KEY_HISTORY, 0, 200);
  const history = (items || []).map((x) => {
    try { return JSON.parse(x); } catch { return x; }
  });
  res.json({ ok: true, count: history.length, history });
});

// Config prizes (key)
app.post("/config/prizes", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  let prizes = req.body && req.body.prizes;

  if (typeof prizes === "string") {
    prizes = prizes
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (!Array.isArray(prizes) || prizes.length === 0) {
    return res.status(400).json({ ok: false, error: "prizes_required" });
  }

  await redis.set(KEY_PRIZES, JSON.stringify(prizes));
  await ensurePoolFromPrizes(prizes);

  res.json({ ok: true, prizes_count: prizes.length });
});

// Spin (key) - for CodePen
app.post("/spin", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const user_id = req.body && (req.body.user_id || req.body.userId);
  if (!user_id) return res.status(400).json({ ok: false, error: "user_id_required" });

  const id = String(user_id);
  const member = await getMember(id);

  // take prize from pool
  const prize = await redis.lpop(KEY_POOL);
  if (!prize) {
    return res.json({ ok: false, error: "no_prizes_left" });
  }

  const result = {
    user_id: id,
    name: (member && member.name) ? member.name : (req.body.name ? String(req.body.name) : id),
    username: (member && member.username) ? member.username : "",
    prize: String(prize),
    time: new Date().toISOString()
  };

  await redis.lpush(KEY_HISTORY, JSON.stringify(result));
  await redis.lpush(KEY_WINNERS, JSON.stringify(result));

  // optional: notify group
  try {
    const msg =
      `🎉 WINNER!\n` +
      `👤 ${result.name}${result.username ? ` (@${result.username})` : ""}\n` +
      `🏆 ${result.prize}`;
    await bot.sendMessage(GROUP_ID_STR, msg);
  } catch (_) {}

  res.json({ ok: true, result });
});

// Notice (key)
app.post("/notice", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const text = req.body && req.body.text ? String(req.body.text) : "";
  const user_id = req.body && (req.body.user_id || req.body.userId);

  if (!text) return res.status(400).json({ ok: false, error: "text_required" });

  try {
    if (user_id) {
      await bot.sendMessage(String(user_id), text);
    } else {
      await bot.sendMessage(GROUP_ID_STR, text);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Restart spin (key)
app.post("/restart-spin", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const prizes = await getPrizes();
  await redis.del(KEY_HISTORY);
  await redis.del(KEY_WINNERS);
  await ensurePoolFromPrizes(prizes);

  res.json({ ok: true, prizes_count: prizes.length });
});

// ===================== BOT HANDLERS =====================

// 1) Auto delete join/left service messages + track members silently
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat) return;

    // Track group activity
    if (targetGroup(msg.chat)) {
      await redis.set(KEY_LAST_GROUP_SEEN, String(msg.chat.id));
    }

    // Auto delete join/left messages (needs bot admin)
    if (targetGroup(msg.chat)) {
      const isJoin = Array.isArray(msg.new_chat_members) && msg.new_chat_members.length > 0;
      const isLeft = !!msg.left_chat_member;

      if (isJoin || isLeft) {
        // delete the service message itself
        await safeDelete(msg.chat.id, msg.message_id);

        // if new members joined, save them silently (no group reply)
        if (isJoin) {
          for (const u of msg.new_chat_members) {
            if (u && u.id) await saveMember(u, "group_join");
          }
        }
        // nothing else in group (no popup)
        return;
      }
    }
  } catch (e) {
    console.error("message handler error:", e);
  }
});

// 2) /setup_register in GROUP: bot sends register message + tries PIN (bot must have pin permission)
bot.onText(/\/setup_register/i, async (msg) => {
  try {
    if (!msg || !msg.chat) return;
    if (!targetGroup(msg.chat)) return;

    // only owner or group admins
    const fromId = msg.from && msg.from.id ? msg.from.id : null;
    if (!fromId) return;

    let isAdmin = false;
    try {
      const member = await bot.getChatMember(msg.chat.id, fromId);
      isAdmin = ["creator", "administrator"].includes(member.status);
    } catch (_) {}

    if (!isOwner(fromId) && !isAdmin) return;

    const text =
      "✅ Lucky77 Register\n\n" +
      "👇 Register လုပ်ဖို့ Button ကိုနှိပ်ပါ။\n" +
      "(DM ထဲရောက်သွားမယ်)";

    const sent = await bot.sendMessage(msg.chat.id, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Register (DM)", url: REGISTER_DEEP_LINK || "https://t.me/" }]
        ]
      }
    });

    // Try pin (works only if bot has pin permission)
    try {
      await bot.pinChatMessage(msg.chat.id, sent.message_id, { disable_notification: true });
    } catch (_) {}

    // delete the command message (clean)
    await safeDelete(msg.chat.id, msg.message_id);
  } catch (e) {
    console.error("/setup_register error:", e);
  }
});

// 3) /start register in DM: send ONE pin-able message with register button
bot.onText(/\/start(?:\s+(.+))?/i, async (msg, match) => {
  try {
    if (!msg || msg.chat.type !== "private") return;
    const u = msg.from;
    if (!u || !u.id) return;

    if (!isExcludedUser(u.id)) {
      await saveMember(u, "private_start");
      await setDmReady(u.id);
    }

    const payload = (match && match[1]) ? String(match[1]).trim().toLowerCase() : "";
    const wantPin = String(PIN_REGISTER_MSG || "1") === "1";

    // Only special flow when payload=register
    if (payload === "register") {
      // prevent duplicates: keep one message id
      if (wantPin) {
        const existingMsgId = await redis.get(`${KEY_DM_PIN_MSG_PREFIX}${String(u.id)}`);
        if (existingMsgId) {
          // no extra spam
          return;
        }
      }

      const text =
        "✅ Register လုပ်ဖို့ Button ကိုနှိပ်ပါ။\n\n" +
        "📌 ဒီ message ကို *ကိုယ်တိုင် PIN* ထားထားပါ။\n" +
        "(Bot က pin မလုပ်နိုင်ပါဘူး။ User ပဲ pin လုပ်လို့ရပါတယ်)";

      const sent = await bot.sendMessage(msg.chat.id, text, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Confirm Register", callback_data: `reg_confirm:${u.id}` }]
          ]
        }
      });

      if (wantPin) {
        await redis.set(`${KEY_DM_PIN_MSG_PREFIX}${String(u.id)}`, String(sent.message_id));
      }
      return;
    }

    // Default DM: silent (no spam)
    const silent = String(DM_SILENT || "1") === "1";
    if (!silent) {
      await bot.sendMessage(msg.chat.id, "✅ Bot Ready.");
    }
  } catch (e) {
    console.error("/start error:", e);
  }
});

// 4) Register confirm button (no extra replies; just edit message)
bot.on("callback_query", async (q) => {
  try {
    if (!q || !q.data) return;

    if (q.data.startsWith("reg_confirm:")) {
      const uid = q.data.split(":")[1];
      const from = q.from;

      // only allow same user
      if (!from || String(from.id) !== String(uid)) {
        try { await bot.answerCallbackQuery(q.id, { text: "Not allowed", show_alert: true }); } catch (_) {}
        return;
      }

      if (!isExcludedUser(from.id)) {
        await saveMember(from, "dm_register_button");
        await setDmReady(from.id);
      }

      // edit pinned message content to "registered"
      try {
        await bot.editMessageText(
          "✅ Registered ပြီးပါပြီ။\n\n📌 ဒီ message ကို PIN ထားထားပါ။",
          {
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            reply_markup: { inline_keyboard: [[{ text: "✅ Registered", callback_data: "noop" }]] }
          }
        );
      } catch (_) {}

      try { await bot.answerCallbackQuery(q.id, { text: "Registered", show_alert: false }); } catch (_) {}
      return;
    }

    // noop
    try { await bot.answerCallbackQuery(q.id); } catch (_) {}
  } catch (e) {
    console.error("callback_query error:", e);
  }
});

// ===================== START SERVER (FIX) =====================
async function startServer() {
  await initBotProfile();

  // Set webhook (avoids 409 conflict)
  const hookUrl = `${String(PUBLIC_URL).replace(/\/+$/, "")}/webhook/${WEBHOOK_SECRET}`;

  try {
    await bot.setWebHook(hookUrl, {
      allowed_updates: ["message", "callback_query", "chat_member", "my_chat_member"]
    });
    console.log("Webhook set:", hookUrl);
  } catch (e) {
    console.error("setWebHook error:", e);
  }

  // One listen only (fix EADDRINUSE)
  app.listen(PORT, () => {
    console.log("Server running on:", PORT);
    console.log("Bot:", BOT_USERNAME);
    console.log("Group:", GROUP_ID_STR);
  });
}

// crash-safe
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

startServer().catch((e) => {
  console.error("startServer fatal:", e);
  process.exit(1);
});});startServer();
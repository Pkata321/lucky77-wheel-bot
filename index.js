"use strict";

/**
 * Lucky77 Wheel Bot PRO V2 Premium (Render)
 * - Webhook only (avoid 409)
 * - Express API for CodePen (API_KEY protected)
 * - Group join: auto delete Telegram service join/left messages (need admin + delete permission)
 * - Group join: silently save member (no popup)
 * - Group shows "Join notice + DM button" (optional auto-delete that message)
 * - DM: show ONLY one Register button message; clicking edits same message to "Registered ✅"
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

// ========================= ENV =========================
const {
  BOT_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  OWNER_ID,
  API_KEY,
  GROUP_ID,
  PUBLIC_URL,
  WEBHOOK_SECRET,

  // optional
  EXCLUDE_IDS,          // "123,456"
  AUTO_DELETE_NOTICE,   // "1" => delete bot's own join-notice msg after few seconds
  NOTICE_DELETE_MS,     // "3000"
} = process.env;

function must(v, name) {
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

must(BOT_TOKEN, "BOT_TOKEN");
must(UPSTASH_REDIS_REST_URL, "UPSTASH_REDIS_REST_URL");
must(UPSTASH_REDIS_REST_TOKEN, "UPSTASH_REDIS_REST_TOKEN");
must(OWNER_ID, "OWNER_ID");
must(API_KEY, "API_KEY");
must(GROUP_ID, "GROUP_ID");
must(PUBLIC_URL, "PUBLIC_URL");
must(WEBHOOK_SECRET, "WEBHOOK_SECRET");

const PORT = Number(process.env.PORT || 10000); // Render will provide PORT

// ========================= Redis =========================
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// Redis keys
const KEY_MEMBERS_SET = "l77:members:set";
const KEY_MEMBER_HASH = (id) => `l77:member:${id}`;         // hash/object
const KEY_HISTORY_LIST = "l77:history:list";                // list of JSON strings
const KEY_PRIZES = "l77:prizes:list";                       // list of prize text
const KEY_WINNERS_LIST = "l77:winners:list";                // list of JSON strings
const KEY_LAST_GROUP_SEEN = "l77:last_group_seen";          // string

// ========================= Helpers =========================
const excludedIds = new Set(
  String(EXCLUDE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function isExcluded(userId) {
  return excludedIds.has(String(userId));
}

function targetGroup(chat) {
  if (!chat) return false;
  // group or supergroup
  const t = String(chat.type || "");
  if (t !== "group" && t !== "supergroup") return false;
  return String(chat.id) === String(GROUP_ID);
}

function deepLinkRegister(botUsername) {
  // https://t.me/<bot>?start=register
  return `https://t.me/${botUsername}?start=register`;
}

async function safeDelete(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (_) {}
}

async function autoDelete(chatId, messageId, ms = 3000) {
  setTimeout(() => safeDelete(chatId, messageId), ms);
}

function nameParts(u) {
  const first = (u && u.first_name) ? String(u.first_name) : "";
  const last = (u && u.last_name) ? String(u.last_name) : "";
  const full = `${first} ${last}`.trim();
  return { first, last, full };
}

async function saveMember(u, source = "unknown") {
  if (!u || !u.id) return { ok: false, reason: "no_user" };
  const userId = String(u.id);

  if (isExcluded(userId)) return { ok: false, reason: "excluded" };

  const { full } = nameParts(u);
  const username = u.username ? `@${u.username}` : "";

  await redis.sadd(KEY_MEMBERS_SET, userId);
  await redis.set(KEY_LAST_GROUP_SEEN, userId);

  // store as JSON string in redis key
  const obj = {
    id: userId,
    username,
    name: full,
    source,
    updated_at: new Date().toISOString(),
  };
  await redis.set(KEY_MEMBER_HASH(userId), JSON.stringify(obj));

  return { ok: true };
}

async function isRegistered(userId) {
  return await redis.sismember(KEY_MEMBERS_SET, String(userId));
}

function apiKeyOk(req) {
  const key = String(req.query.key || req.headers["x-api-key"] || "");
  return key === String(API_KEY);
}

// random helper for spin
function pickRandom(arr) {
  if (!arr.length) return null;
  const idx = crypto.randomInt(0, arr.length);
  return arr[idx];
}

// ========================= Telegram Bot (Webhook mode) =========================
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ========================= Express App =========================
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---- webhook route (secret path) ----
const HOOK_PATH = `/webhook/${WEBHOOK_SECRET}`;
app.post(HOOK_PATH, (req, res) => {
  // Telegram will POST update JSON here
  bot.processUpdate(req.body);
  res.status(200).send("OK");
});

// ---- health ----
app.get("/health", async (req, res) => {
  try {
    const me = await bot.getMe();
    const membersCount = Number(await redis.scard(KEY_MEMBERS_SET)) || 0;
    const winnersCount = Number(await redis.llen(KEY_WINNERS_LIST)) || 0;
    const remainingPrizes = Number(await redis.llen(KEY_PRIZES)) || 0;
    const lastSeen = await redis.get(KEY_LAST_GROUP_SEEN);

    res.json({
      ok: true,
      bot_username: me.username,
      group_id_env: String(GROUP_ID),
      last_group_seen: lastSeen ? Number(lastSeen) : null,
      members: membersCount,
      winners: winnersCount,
      remaining_prizes: remainingPrizes,
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// ========================= API (for CodePen) =========================
app.get("/members", async (req, res) => {
  if (!apiKeyOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const ids = await redis.smembers(KEY_MEMBERS_SET);
  res.json({ ok: true, count: ids.length, ids });
});

app.get("/pool", async (req, res) => {
  if (!apiKeyOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const prizes = await redis.lrange(KEY_PRIZES, 0, 9999);
  res.json({ ok: true, prizes, count: prizes.length });
});

app.post("/config/prizes", async (req, res) => {
  if (!apiKeyOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const prizeText = String((req.body && req.body.prizeText) || "").trim();

  if (!prizeText) return res.status(400).json({ ok: false, error: "prizeText_required" });

  const lines = prizeText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  // reset list
  await redis.del(KEY_PRIZES);
  if (lines.length) {
    // push all
    await redis.rpush(KEY_PRIZES, ...lines);
  }

  res.json({ ok: true, count: lines.length });
});

app.post("/spin", async (req, res) => {
  if (!apiKeyOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const userId = String((req.body && req.body.user_id) || "").trim();
  if (!userId) return res.status(400).json({ ok: false, error: "user_id_required" });

  // optional: require registered
  const reg = await isRegistered(userId);
  if (!reg) return res.status(403).json({ ok: false, error: "not_registered" });

  const prizes = await redis.lrange(KEY_PRIZES, 0, 9999);
  if (!prizes.length) return res.status(400).json({ ok: false, error: "no_prizes" });

  const picked = pickRandom(prizes);
  // remove one instance of picked prize from list (simple rebuild)
  const remaining = prizes.filter((p, i) => !(p === picked && remaining._removed !== true && (remaining._removed = true)));
  delete remaining._removed;

  await redis.del(KEY_PRIZES);
  if (remaining.length) await redis.rpush(KEY_PRIZES, ...remaining);

  const memberJson = await redis.get(KEY_MEMBER_HASH(userId));
  const member = memberJson ? JSON.parse(memberJson) : { id: userId };

  const win = {
    time: new Date().toISOString(),
    user_id: userId,
    username: member.username || "",
    name: member.name || "",
    prize: picked,
  };

  await redis.lpush(KEY_WINNERS_LIST, JSON.stringify(win));
  await redis.ltrim(KEY_WINNERS_LIST, 0, 499); // keep last 500
  await redis.lpush(KEY_HISTORY_LIST, JSON.stringify({ type: "spin", ...win }));
  await redis.ltrim(KEY_HISTORY_LIST, 0, 999);

  res.json({ ok: true, winner: win, remaining_prizes: remaining.length });
});

app.get("/history", async (req, res) => {
  if (!apiKeyOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const items = await redis.lrange(KEY_HISTORY_LIST, 0, 199);
  const parsed = items.map((s) => {
    try { return JSON.parse(s); } catch { return { raw: s }; }
  });
  res.json({ ok: true, items: parsed });
});

app.post("/notice", async (req, res) => {
  if (!apiKeyOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const userId = String((req.body && req.body.user_id) || "").trim();
  const text = String((req.body && req.body.text) || "").trim();
  if (!userId || !text) return res.status(400).json({ ok: false, error: "user_id_and_text_required" });

  try {
    await bot.sendMessage(userId, text, { disable_web_page_preview: true });
    await redis.lpush(KEY_HISTORY_LIST, JSON.stringify({ type: "notice", time: new Date().toISOString(), user_id: userId, text }));
    await redis.ltrim(KEY_HISTORY_LIST, 0, 999);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

app.post("/restart-spin", async (req, res) => {
  if (!apiKeyOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  // Just clear winners/history, keep members by default
  await redis.del(KEY_WINNERS_LIST);
  await redis.del(KEY_HISTORY_LIST);
  res.json({ ok: true });
});

// ========================= Telegram Behaviors =========================

// 1) Delete Telegram system join/left messages (requires bot admin + delete permission)
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat) return;
    if (!targetGroup(msg.chat)) return;

    // system join / left
    if (msg.new_chat_members && msg.new_chat_members.length) {
      await safeDelete(msg.chat.id, msg.message_id);
      return;
    }
    if (msg.left_chat_member) {
      await safeDelete(msg.chat.id, msg.message_id);
      return;
    }
  } catch (_) {}
});

// 2) Track join via chat_member updates (more reliable)
bot.on("chat_member", async (upd) => {
  try {
    const chat = upd.chat;
    if (!targetGroup(chat)) return;

    const u = upd.new_chat_member && upd.new_chat_member.user;
    if (!u || !u.id) return;

    const newStatus = upd.new_chat_member.status; // "member", "administrator", ...
    const oldStatus = upd.old_chat_member.status;

    const joined =
      (oldStatus === "left" || oldStatus === "kicked") &&
      (newStatus === "member" || newStatus === "administrator" || newStatus === "creator");

    if (joined) {
      // silently save on join (no popup)
      await saveMember(u, "group_auto");

      // send join notice with DM button (this is what you want to "bait" them to DM)
      const me = await bot.getMe();
      const url = deepLinkRegister(me.username);

      const noticeText =
        "✅ Welcome!\n\n" +
        "Register လုပ်ဖို့အောက်က button ကိုနှိပ်ပြီး DM ထဲသွားပါ။\n" +
        "(*Register မလုပ်ရင် spin မရနိုင်ပါ*)";

      const sent = await bot.sendMessage(chat.id, noticeText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📩 DM ထဲသွားပြီး Register လုပ်မယ်", url }],
          ],
        },
      });

      // optional: auto delete this notice to avoid clutter
      if (String(AUTO_DELETE_NOTICE || "") === "1") {
        const ms = Number(NOTICE_DELETE_MS || 3000);
        autoDelete(chat.id, sent.message_id, ms);
      }
    }
  } catch (_) {}
});

// 3) /start handler (DM)
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  try {
    const chatId = msg.chat.id;
    const from = msg.from;

    const payload = (match && match[1]) ? String(match[1]).trim() : "";
    const { full } = nameParts(from);

    // Save when DM starts as well
    if (from && from.id) {
      await saveMember(from, "dm_start");
    }

    // ONLY show one message with register button (no extra replies)
    const isReg = from && from.id ? await isRegistered(from.id) : false;

    const baseText =
      `👤 Name: ${full || "-"}\n` +
      `🆔 ID: ${from && from.id ? from.id : "-"}\n` +
      `🔖 Username: ${from && from.username ? "@"+from.username : "-"}\n\n` +
      (isReg ? "✅ Status: Registered\n" : "⚠️ Status: Not registered\n") +
      "\nအောက်က Register button ကိုနှိပ်ပါ။";

    // If payload is register OR normal start, show same.
    await bot.sendMessage(chatId, baseText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: isReg ? "✅ Registered" : "✅ Register", callback_data: "do_register" }],
        ],
      },
    });
  } catch (_) {}
});

// 4) Callback register button
bot.on("callback_query", async (q) => {
  try {
    if (!q || !q.data) return;

    if (q.data === "do_register") {
      const u = q.from;
      if (!u || !u.id) return;

      await saveMember(u, "dm_register_click");

      // Edit SAME message -> no new reply message
      const { full } = nameParts(u);
      const newText =
        `👤 Name: ${full || "-"}\n` +
        `🆔 ID: ${u.id}\n` +
        `🔖 Username: ${u.username ? "@"+u.username : "-"}\n\n` +
        `✅ Registered ပြီးပါပြီ`;

      if (q.message) {
        await bot.editMessageText(newText, {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: "✅ Registered", callback_data: "noop" }]] },
        });
      }

      await bot.answerCallbackQuery(q.id, { text: "Registered ✅", show_alert: false });
      return;
    }

    if (q.data === "noop") {
      await bot.answerCallbackQuery(q.id, { text: "✅", show_alert: false });
      return;
    }
  } catch (_) {}
});

// ========================= Start server + set webhook (NO DOUBLE LISTEN) =========================
async function startServer() {
  // set webhook to our render URL
  const hookUrl = `${String(PUBLIC_URL).replace(/\/+$/, "")}${HOOK_PATH}`;
  await bot.setWebHook(hookUrl, {
    secret_token: String(WEBHOOK_SECRET), // extra safety; telegram will send header
    allowed_updates: ["message", "callback_query", "chat_member"],
  });

  app.get("/", (_req, res) => {
    res.type("text").send("Lucky77 Wheel Bot PRO V2 Premium ✅");
  });

  app.listen(PORT, () => {
    console.log("Server running on PORT:", PORT);
    console.log("Webhook set to:", hookUrl);
  });
}

startServer().catch((e) => {
  console.error("START ERROR:", e);
  process.exit(1);
});});});startServer();
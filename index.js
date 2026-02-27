/* Lucky77 Wheel Bot PRO v2 Premium (Render)
   ✅ Webhook mode (NO polling) => 409 FIX
   ✅ CodePen API unchanged (same endpoints)
   ✅ Group: auto delete join/left service messages (if bot has delete rights)
   ✅ Group: send DM Register button on join/add (optional pin)
   ✅ DM /start => register + dm_ready=1
*/

"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

/* ================= ENV ================= */
const {
  BOT_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  OWNER_ID,
  API_KEY,
  GROUP_ID,            // required for single target group (supergroup id)
  PUBLIC_URL,          // your render url: https://xxxx.onrender.com
  WEBHOOK_SECRET,      // random secret path part
  EXCLUDE_IDS,         // optional "123,456"
  PIN_REGISTER_MSG,    // optional "1" => bot will try pin welcome/register message
} = process.env;

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
must(API_KEY, "API_KEY");
must(GROUP_ID, "GROUP_ID");
must(PUBLIC_URL, "PUBLIC_URL");
must(WEBHOOK_SECRET, "WEBHOOK_SECRET");

/* ================= Redis ================= */
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const KEY_PREFIX = "lucky77:pro:v2";
const KEY_MEMBERS_SET = `${KEY_PREFIX}:members:set`; // set(user_id)
const KEY_MEMBER_HASH = (id) => `${KEY_PREFIX}:member:${id}`; // hash
const KEY_WINNERS_SET = `${KEY_PREFIX}:winners:set`; // set(user_id)
const KEY_HISTORY_LIST = `${KEY_PREFIX}:history:list`; // list json
const KEY_PRIZE_BAG = `${KEY_PREFIX}:prizes:bag`; // list expanded prizes
const KEY_PRIZE_SOURCE = `${KEY_PREFIX}:prizes:source`; // raw prize text
const KEY_LAST_GROUP = `${KEY_PREFIX}:last_group_id`;
const KEY_WELCOME_SENT = (id) => `${KEY_PREFIX}:welcome_sent:${id}`; // avoid spam per user

/* ================= Bot (Webhook) ================= */
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

let BOT_ID = null;
let BOT_USERNAME = null;

(async () => {
  const me = await bot.getMe();
  BOT_ID = String(me.id);
  BOT_USERNAME = me.username ? String(me.username) : null;

  const base = String(PUBLIC_URL).replace(/\/$/, "");
  const hookUrl = `${base}/telegram/${encodeURIComponent(WEBHOOK_SECRET)}`;

  await bot.setWebHook(hookUrl, {
    allowed_updates: ["message", "callback_query", "chat_member", "my_chat_member"],
  });

  console.log("Bot Ready:", { BOT_ID, BOT_USERNAME, hookUrl });
})().catch((e) => console.error("init bot error:", e));

/* ================= Helpers ================= */
const excludeIds = (EXCLUDE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(String);

function isExcludedUser(userId) {
  const id = String(userId);
  if (id === String(OWNER_ID)) return true;
  if (BOT_ID && id === String(BOT_ID)) return true;
  if (excludeIds.includes(id)) return true;
  return false;
}

function nameParts(u) {
  const name = `${u.first_name || ""} ${u.last_name || ""}`.trim();
  const username = u.username ? String(u.username) : "";
  return { name, username };
}

async function isRegistered(userId) {
  const ok = await redis.sismember(KEY_MEMBERS_SET, String(userId));
  return !!ok;
}

async function saveMember(u, source = "group_seen") {
  const userId = String(u.id);
  if (isExcludedUser(userId)) return { ok: false, reason: "excluded" };

  const { name, username } = nameParts(u);

  await redis.sadd(KEY_MEMBERS_SET, userId);
  await redis.hset(KEY_MEMBER_HASH(userId), {
    id: userId,
    name,
    username,
    dm_ready: "0",
    source,
    registered_at: new Date().toISOString(),
  });

  return { ok: true };
}

async function setDmReady(userId) {
  await redis.hset(KEY_MEMBER_HASH(String(userId)), {
    dm_ready: "1",
    dm_ready_at: new Date().toISOString(),
  });
}

async function trySendDM(userId, text) {
  try {
    await bot.sendMessage(Number(userId), text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.response?.body || e?.message || String(e) };
  }
}

function isTargetGroup(chat) {
  if (!chat) return false;
  if (String(chat.type) !== "group" && String(chat.type) !== "supergroup") return false;
  return String(chat.id) === String(GROUP_ID);
}

function startUrl() {
  if (!BOT_USERNAME) return null;
  // deep link => open DM and auto /start payload
  return `https://t.me/${BOT_USERNAME}?start=register`;
}

async function autoDelete(chatId, messageId, ms = 3000) {
  setTimeout(() => {
    bot.deleteMessage(chatId, messageId).catch(() => {});
  }, ms);
}

async function deleteServiceMessageIfAny(msg) {
  // join/left telegram system messages can be deleted only if bot has permission
  if (!msg || !msg.chat) return;
  if (!isTargetGroup(msg.chat)) return;
  if (msg.new_chat_members?.length || msg.left_chat_member) {
    // delete system message
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  }
}

async function sendGroupRegisterNotice(chatId, user) {
  const uid = String(user.id);
  if (isExcludedUser(uid)) return;

  // anti spam: per user 1 time per 24h
  const sentKey = KEY_WELCOME_SENT(uid);
  const already = await redis.get(sentKey);
  if (already) return;

  await redis.set(sentKey, "1", { ex: 60 * 60 * 24 }); // 24h

  const url = startUrl();
  const text =
    "👋 Welcome!\n\n" +
    "🎁 Prize ပေါက်ရင် DM ကနေ ဆက်သွယ်နိုင်ဖို့\n" +
    "✅ အောက်က Register (DM) ကိုနှိပ်ပြီး Bot DM ကိုဖွင့်ပါ။";

  const sent = await bot.sendMessage(chatId, text, {
    reply_markup: url
      ? { inline_keyboard: [[{ text: "✅ Register (DM)", url }]] }
      : undefined,
  });

  // optional pin
  if (String(PIN_REGISTER_MSG || "") === "1") {
    bot.pinChatMessage(chatId, sent.message_id, { disable_notification: true }).catch(() => {});
  }

  // optional auto delete (မင်းလိုချင်ရင် comment ဖြုတ်)
  // await autoDelete(chatId, sent.message_id, 15000);
}

/* ================= Prize parse ================= */
function parsePrizeTextExpand(prizeText) {
  const lines = String(prizeText || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  const bag = [];
  for (const line of lines) {
    let m = line.match(/^(.+?)\s+(\d+)\s*time$/i);
    if (!m) m = line.match(/^(.+?)\s+(\d+)$/i);
    if (!m) continue;

    const prize = m[1].trim();
    const times = parseInt(m[2], 10);
    if (!prize || !Number.isFinite(times) || times <= 0) continue;
    for (let i = 0; i < times; i++) bag.push(prize);
  }
  return bag;
}

/* ================= Telegram: message ================= */
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat) return;

    // group
    if (isTargetGroup(msg.chat)) {
      await redis.set(KEY_LAST_GROUP, String(msg.chat.id));

      // delete join/left service message
      await deleteServiceMessageIfAny(msg);

      // if new member joined => save silently + send register DM button
      if (msg.new_chat_members?.length) {
        for (const u of msg.new_chat_members) {
          if (!isExcludedUser(u.id)) {
            // save silently (not DM-ready yet)
            const ok = await isRegistered(u.id);
            if (!ok) await saveMember(u, "group_join");
          }
          await sendGroupRegisterNotice(msg.chat.id, u);
        }
      }

      // no more group spam
      return;
    }

    // DM
    if (msg.chat.type === "private") {
      // allow /start handler below to run
      return;
    }
  } catch (e) {
    console.error("message handler error:", e);
  }
});

/* ================= Telegram: admin add members backup ================= */
bot.on("chat_member", async (upd) => {
  try {
    const chat = upd.chat;
    if (!isTargetGroup(chat)) return;

    await redis.set(KEY_LAST_GROUP, String(chat.id));

    const user = upd.new_chat_member?.user;
    const oldStatus = upd.old_chat_member?.status;
    const newStatus = upd.new_chat_member?.status;
    if (!user) return;

    const becameMember =
      (oldStatus === "left" || oldStatus === "kicked" || !oldStatus) &&
      (newStatus === "member" || newStatus === "restricted");

    if (!becameMember) return;

    if (!isExcludedUser(user.id)) {
      const ok = await isRegistered(user.id);
      if (!ok) await saveMember(user, "group_added_by_admin");
    }

    await sendGroupRegisterNotice(chat.id, user);
  } catch (e) {
    console.error("chat_member error:", e);
  }
});

/* ================= DM Register (/start) ================= */
bot.onText(/\/start(?:\s+(.+))?/i, async (msg, match) => {
  try {
    if (msg.chat.type !== "private") return;

    const u = msg.from;
    if (!u || isExcludedUser(u.id)) return;

    // ensure saved
    const ok = await isRegistered(u.id);
    if (!ok) await saveMember(u, "private_start");

    await setDmReady(u.id);

    await bot.sendMessage(
      msg.chat.id,
      "✅ Register အောင်မြင်ပါပြီ။\n\n🎁 Prize ပေါက်ရင် ဒီ DM ကနေ ဆက်သွယ်ပေးပါမယ်။"
    );
  } catch (e) {
    console.error("/start error:", e);
  }
});

/* ================= Express API ================= */
function requireApiKey(req, res, next) {
  const k = req.headers["x-api-key"] || req.query.key;
  if (!k || String(k) !== String(API_KEY)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* Webhook endpoint */
app.post("/telegram/:secret", (req, res) => {
  if (String(req.params.secret) !== String(WEBHOOK_SECRET)) {
    return res.status(403).send("Forbidden");
  }
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

/* Root help */
app.get("/", (req, res) => {
  res.send(
    "Lucky77 Wheel Bot PRO v2 Premium ✅\n\n" +
      "GET  /health\n" +
      "GET  /members?key=API_KEY\n" +
      "GET  /pool?key=API_KEY\n" +
      "POST /config/prizes?key=API_KEY  { prizeText }\n" +
      "POST /spin?key=API_KEY\n" +
      "GET  /history?key=API_KEY\n" +
      "POST /notice?key=API_KEY { user_id, text }\n" +
      "POST /restart-spin?key=API_KEY\n"
  );
});

app.get("/health", async (req, res) => {
  try {
    const members = await redis.scard(KEY_MEMBERS_SET);
    const winners = await redis.scard(KEY_WINNERS_SET);
    const bagLen = await redis.llen(KEY_PRIZE_BAG);
    const lastGroup = await redis.get(KEY_LAST_GROUP);

    res.json({
      ok: true,
      mode: "webhook",
      bot_username: BOT_USERNAME || null,
      group_id_env: GROUP_ID || null,
      last_group_seen: lastGroup || null,
      members: Number(members) || 0,
      winners: Number(winners) || 0,
      remaining_prizes: Number(bagLen) || 0,
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/members", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const members = [];

    for (const id of ids || []) {
      if (isExcludedUser(id)) continue;
      const h = await redis.hgetall(KEY_MEMBER_HASH(id));
      if (!h || !h.id) continue;

      const isWinner = await redis.sismember(KEY_WINNERS_SET, String(h.id));
      const name = (h.name || "").trim();
      const username = (h.username || "").trim().replace("@", "");
      const displayName = name || (username ? `@${username}` : String(h.id));

      members.push({
        id: String(h.id),
        name,
        username,
        display: displayName,
        dm_ready: String(h.dm_ready || "0") === "1",
        isWinner: !!isWinner,
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

app.get("/pool", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    let count = 0;

    for (const id of ids || []) {
      if (isExcludedUser(id)) continue;
      const isWinner = await redis.sismember(KEY_WINNERS_SET, String(id));
      if (!isWinner) count++;
    }

    res.json({ ok: true, count });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/config/prizes", requireApiKey, async (req, res) => {
  try {
    const { prizeText } = req.body || {};
    const bag = parsePrizeTextExpand(prizeText);

    if (!bag.length) {
      return res.status(400).json({ ok: false, error: "No valid prizes. Example: 10000Ks 4time" });
    }

    await redis.del(KEY_PRIZE_BAG);
    for (const p of bag) {
      await redis.rpush(KEY_PRIZE_BAG, String(p));
    }
    await redis.set(KEY_PRIZE_SOURCE, String(prizeText || ""));

    res.json({ ok: true, total: bag.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

function randPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

app.post("/spin", requireApiKey, async (req, res) => {
  try {
    // eligible members
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const eligible = [];
    for (const id of ids || []) {
      if (isExcludedUser(id)) continue;
      const isWinner = await redis.sismember(KEY_WINNERS_SET, String(id));
      if (!isWinner) eligible.push(String(id));
    }

    if (!eligible.length) {
      return res.status(400).json({
        ok: false,
        error: "No members left in pool. Restart Spin to reset winners.",
      });
    }

    // prizes bag
    const bagLen = await redis.llen(KEY_PRIZE_BAG);
    if (!bagLen || bagLen <= 0) {
      return res.status(400).json({
        ok: false,
        error: "No prizes left. Set prizes in Settings and Save.",
      });
    }

    const bag = await redis.lrange(KEY_PRIZE_BAG, 0, bagLen - 1);
    const prize = randPick(bag);
    await redis.lrem(KEY_PRIZE_BAG, 1, String(prize));

    // winner
    const winnerId = randPick(eligible);
    const h = await redis.hgetall(KEY_MEMBER_HASH(winnerId));

    const name = (h?.name || "").trim();
    const username = (h?.username || "").trim().replace("@", "");
    const disp = name || (username ? `@${username}` : winnerId);

    await redis.sadd(KEY_WINNERS_SET, String(winnerId));

    const item = {
      at: new Date().toISOString(),
      prize: String(prize),
      winner: {
        id: String(winnerId),
        name,
        username,
        display: disp,
        dm_ready: String(h?.dm_ready || "0") === "1",
      },
    };

    await redis.lpush(KEY_HISTORY_LIST, JSON.stringify(item));
    await redis.ltrim(KEY_HISTORY_LIST, 0, 200);

    res.json({ ok: true, prize: String(prize), winner: item.winner });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/history", requireApiKey, async (req, res) => {
  try {
    const list = await redis.lrange(KEY_HISTORY_LIST, 0, 200);
    const history = (list || []).map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return { raw: s };
      }
    });
    res.json({ ok: true, total: history.length, history });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/notice", requireApiKey, async (req, res) => {
  try {
    const { user_id, text } = req.body || {};
    if (!user_id || !text) {
      return res.status(400).json({ ok: false, error: "user_id and text required" });
    }

    const uid = String(user_id);
    const dm = await trySendDM(uid, String(text));
    res.json({ ok: true, dm_ok: dm.ok, dm_error: dm.ok ? "" : String(dm.error || "") });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/restart-spin", requireApiKey, async (req, res) => {
  try {
    await redis.del(KEY_WINNERS_SET);
    await redis.del(KEY_HISTORY_LIST);

    const raw = await redis.get(KEY_PRIZE_SOURCE);
    if (raw) {
      const bag = parsePrizeTextExpand(raw);
      await redis.del(KEY_PRIZE_BAG);
      for (const p of bag) {
        await redis.rpush(KEY_PRIZE_BAG, String(p));
      }
    }

    res.json({ ok: true, reset: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ================= Start Server ================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});});app.listen(PORT, () => console.log("Server running on", PORT));
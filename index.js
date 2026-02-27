"use strict";

/**
 * Lucky77 Wheel Bot PRO V2 Premium (Render)
 * ✅ Webhook mode => Fix 409 Conflict
 * ✅ Join service message auto delete (2s)
 * ✅ Join => silent auto save (id/name/username)
 * ✅ Pinned group message (one-time) with DM Register button
 * ✅ DM /start register => dm_ready=1 + registered msg
 * ✅ API endpoints for CodePen
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

// ================= ENV =================
const {
  BOT_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  OWNER_ID,
  API_KEY,
  GROUP_ID, // optional: target group only
  EXCLUDE_IDS, // optional: "123,456"
  PUBLIC_URL, // required for webhook mode on Render
  WEBHOOK_SECRET, // required for webhook security
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
must(PUBLIC_URL, "PUBLIC_URL");
must(WEBHOOK_SECRET, "WEBHOOK_SECRET");

// ================= Redis =================
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// ================= Keys =================
const KEY_PREFIX = "lucky77:pro:v2";
const KEY_MEMBERS_SET = `${KEY_PREFIX}:members:set`; // set(user_id)
const KEY_MEMBER_HASH = (id) => `${KEY_PREFIX}:member:${id}`; // hash
const KEY_WINNERS_SET = `${KEY_PREFIX}:winners:set`; // set(user_id)
const KEY_HISTORY_LIST = `${KEY_PREFIX}:history:list`; // list JSON
const KEY_PRIZE_BAG = `${KEY_PREFIX}:prizes:bag`; // list expanded
const KEY_PRIZE_SOURCE = `${KEY_PREFIX}:prizes:source`; // raw text
const KEY_LAST_GROUP = `${KEY_PREFIX}:last_group_id`; // debug
const KEY_PINNED_MSG_ID = (gid) => `${KEY_PREFIX}:pinned:${gid}`; // pinned msg id

// ================= Helpers =================
const excludeIds = (EXCLUDE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(String);

function isExcludedUser(userId) {
  const id = String(userId);
  if (id === String(OWNER_ID)) return true;
  if (excludeIds.includes(id)) return true;
  return false;
}

function nameParts(u) {
  const name = `${u.first_name || ""} ${u.last_name || ""}`.trim();
  const username = u.username ? String(u.username) : "";
  return { name, username };
}

function targetGroup(chat) {
  if (!chat) return false;
  const t = String(chat.type);
  if (t !== "group" && t !== "supergroup") return false;

  // If GROUP_ID set => only that group
  if (GROUP_ID && String(chat.id) !== String(GROUP_ID)) return false;

  return true;
}

async function autoDelete(chatId, messageId, ms = 2000) {
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (_) {}
  }, ms);
}

async function isRegistered(userId) {
  const ok = await redis.sismember(KEY_MEMBERS_SET, String(userId));
  return !!ok;
}

async function saveMember(u, source = "group_join") {
  const userId = String(u.id);
  if (isExcludedUser(userId)) return { ok: false, reason: "excluded" };

  const { name, username } = nameParts(u);

  // save / update
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

function requireApiKey(req, res, next) {
  const k = req.headers["x-api-key"] || req.query.key;
  if (!k || String(k) !== String(API_KEY)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// ================= Prize parse =================
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

function randPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ================= Express =================
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.send(
    "Lucky77 Wheel Bot PRO V2 Premium ✅\n\n" +
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
      const display = name || (username ? `@${username}` : String(h.id));

      members.push({
        id: String(h.id),
        name,
        username,
        display,
        dm_ready: String(h.dm_ready || "0") === "1",
        isWinner: !!isWinner,
        registered_at: h.registered_at || "",
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
    for (const p of bag) await redis.rpush(KEY_PRIZE_BAG, String(p));
    await redis.set(KEY_PRIZE_SOURCE, String(prizeText || ""));

    res.json({ ok: true, total: bag.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/spin", requireApiKey, async (req, res) => {
  try {
    // 1) eligible members
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const eligible = [];
    for (const id of ids || []) {
      if (isExcludedUser(id)) continue;
      const isWinner = await redis.sismember(KEY_WINNERS_SET, String(id));
      if (!isWinner) eligible.push(String(id));
    }
    if (!eligible.length) {
      return res.status(400).json({ ok: false, error: "No members left in pool. Restart Spin to reset winners." });
    }

    // 2) prize bag
    const bagLen = await redis.llen(KEY_PRIZE_BAG);
    if (!bagLen || bagLen <= 0) {
      return res.status(400).json({ ok: false, error: "No prizes left. Set prizes in Settings and Save." });
    }
    const bag = await redis.lrange(KEY_PRIZE_BAG, 0, bagLen - 1);
    const prize = randPick(bag);
    await redis.lrem(KEY_PRIZE_BAG, 1, String(prize));

    // 3) winner
    const winnerId = randPick(eligible);
    const h = await redis.hgetall(KEY_MEMBER_HASH(winnerId));
    const name = (h?.name || "").trim();
    const username = (h?.username || "").trim().replace("@", "");
    const display = name || (username ? `@${username}` : winnerId);

    await redis.sadd(KEY_WINNERS_SET, String(winnerId));

    const item = {
      at: new Date().toISOString(),
      prize: String(prize),
      winner: {
        id: String(winnerId),
        name,
        username,
        display,
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
    if (!user_id || !text) return res.status(400).json({ ok: false, error: "user_id and text required" });

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
      for (const p of bag) await redis.rpush(KEY_PRIZE_BAG, String(p));
    }

    res.json({ ok: true, reset: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ================= Telegram Bot (Webhook) =================
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

let BOT_USERNAME = null;
let BOT_ID = null;

async function ensurePinnedRegisterMessage(groupId) {
  const gid = String(groupId);
  const cached = await redis.get(KEY_PINNED_MSG_ID(gid));
  if (cached) return;

  const startUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=register` : null;

  const text =
    "📌 Lucky77 DM Register (Prize Contact)\n\n" +
    "✅ Prize ပေါက်သွားရင် DM ကနေ ဆက်သွယ်ပေးနိုင်ဖို့\n" +
    "အောက်က Button ကိုနှိပ်ပြီး Bot DM ကို Enable/Register လုပ်ပါ။";

  const sent = await bot.sendMessage(Number(gid), text, {
    reply_markup: startUrl
      ? { inline_keyboard: [[{ text: "▶️ Register / Enable DM", url: startUrl }]] }
      : undefined,
  });

  // Pin it (requires pin permission)
  try {
    await bot.pinChatMessage(Number(gid), sent.message_id, { disable_notification: true });
  } catch (_) {}

  await redis.set(KEY_PINNED_MSG_ID(gid), String(sent.message_id));
}

// Webhook endpoint for Telegram
const WEBHOOK_PATH = `/telegram/${encodeURIComponent(WEBHOOK_SECRET)}`;
app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

async function setupWebhook() {
  await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
  await bot.setWebHook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
}

// ================= Group Handlers =================

// Join / Add member event comes via msg.new_chat_members
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat) return;

    if (!targetGroup(msg.chat)) return;

    // debug
    await redis.set(KEY_LAST_GROUP, String(msg.chat.id));

    // ensure pinned register message exists (one-time)
    await ensurePinnedRegisterMessage(msg.chat.id);

    // If service join message exists => delete after 2s
    if (msg.new_chat_members && msg.new_chat_members.length) {
      await autoDelete(msg.chat.id, msg.message_id, 2000);

      for (const u of msg.new_chat_members) {
        if (!u) continue;
        if (isExcludedUser(u.id)) continue;
        // silent save member
        const already = await isRegistered(u.id);
        if (!already) await saveMember(u, "group_join");
        else await saveMember(u, "group_join_update");
      }
    }

    // Optional: if left messages also want delete, uncomment:
    // if (msg.left_chat_member) await autoDelete(msg.chat.id, msg.message_id, 2000);
  } catch (e) {
    console.error("group message handler error:", e);
  }
});

// Private /start (button => /start register)
bot.onText(/^\/start(?:\s+(.+))?/i, async (msg, match) => {
  try {
    if (!msg || msg.chat.type !== "private") return;

    const u = msg.from;
    if (!u) return;

    if (!isExcludedUser(u.id)) {
      await saveMember(u, "private_start");
      await setDmReady(u.id);
    }

    await bot.sendMessage(
      msg.chat.id,
      "✅ Registered ပြီးပါပြီ。\n\n📩 Prize ပေါက်ရင် ဒီ DM ကနေ ဆက်သွယ်ပေးပါမယ်။"
    );
  } catch (e) {
    console.error("/start error:", e);
  }
});

// ================= Boot =================
async function boot() {
  const me = await bot.getMe();
  BOT_ID = String(me.id);
  BOT_USERNAME = me.username ? String(me.username) : null;
  console.log("Bot Ready:", { BOT_ID, BOT_USERNAME });

  await setupWebhook();
  console.log("Webhook set:", `${PUBLIC_URL}${WEBHOOK_PATH}`);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", async () => {
  console.log("Server running on port", PORT);
  try {
    await boot();
  } catch (e) {
    console.error("Boot error:", e);
  }
});
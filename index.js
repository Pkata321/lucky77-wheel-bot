/* Lucky77 Wheel Bot (Render) - PRO v2 Premium (Webhook)
   ✅ Fix 409 Conflict: Webhook mode (NO polling)
   ✅ Group join/leave service message auto delete
   ✅ Register ONLY via DM (button) — group join does NOT auto register
   ✅ API for CodePen (API_KEY protected):
      - GET  /health
      - GET  /members
      - GET  /pool
      - POST /config/prizes
      - POST /spin
      - GET  /history
      - POST /notice
      - POST /restart-spin
*/

"use strict";

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
  PUBLIC_URL,
  WEBHOOK_SECRET, // optional
  GROUP_ID, // optional lock to one group
  EXCLUDE_IDS, // optional: "123,456"
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

// ================= Redis =================
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const KEY_PREFIX = "lucky77:pro:v2:premium";
const KEY_MEMBERS_SET = `${KEY_PREFIX}:members:set`; // set(user_id) REGISTERED ONLY
const KEY_MEMBER_HASH = (id) => `${KEY_PREFIX}:member:${id}`; // hash
const KEY_WINNERS_SET = `${KEY_PREFIX}:winners:set`; // set(user_id)
const KEY_HISTORY_LIST = `${KEY_PREFIX}:history:list`; // list JSON
const KEY_PRIZE_BAG = `${KEY_PREFIX}:prizes:bag`; // list of expanded prizes
const KEY_PRIZE_SOURCE = `${KEY_PREFIX}:prizes:source`; // raw text
const KEY_LAST_GROUP = `${KEY_PREFIX}:last_group_id`; // debug
const KEY_BOT_INFO = `${KEY_PREFIX}:bot_info`; // debug

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
  const name = `${u?.first_name || ""} ${u?.last_name || ""}`.trim();
  const username = u?.username ? String(u.username) : "";
  return { name, username };
}

function displayNameFromHash(h) {
  const name = String(h?.name || "").trim();
  const username = String(h?.username || "").trim().replace("@", "");
  if (name) return name;
  if (username) return `@${username}`;
  return String(h?.id || "");
}

async function isRegistered(userId) {
  const ok = await redis.sismember(KEY_MEMBERS_SET, String(userId));
  return !!ok;
}

async function saveMemberRegistered(u, source = "dm_register") {
  const userId = String(u.id);
  if (isExcludedUser(userId)) return { ok: false, reason: "excluded" };

  const { name, username } = nameParts(u);

  await redis.sadd(KEY_MEMBERS_SET, userId);
  await redis.hset(KEY_MEMBER_HASH(userId), {
    id: userId,
    name,
    username,
    dm_ready: "1",
    source,
    registered_at: new Date().toISOString(),
  });

  return { ok: true };
}

async function trySendDM(userId, text) {
  try {
    await bot.sendMessage(Number(userId), text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.response?.body || e?.message || String(e) };
  }
}

function targetGroup(chat) {
  if (!chat) return false;
  const t = String(chat.type);
  if (t !== "group" && t !== "supergroup") return false;

  if (GROUP_ID && String(chat.id) !== String(GROUP_ID)) return false;
  return true;
}

function requireApiKey(req, res, next) {
  const k = req.headers["x-api-key"] || req.query.key;
  if (!k || String(k) !== String(API_KEY)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// ================= Prize parse (expand) =================
function parsePrizeTextExpand(prizeText) {
  const lines = String(prizeText || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  const bag = [];
  for (const line of lines) {
    // accept:
    // "10000Ks 4time"
    // "10000Ks 4"
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
    "Lucky77 Wheel Bot PRO v2 Premium ✅ (Webhook)\n\n" +
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

// ================= Telegram Bot (Webhook mode) =================
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

let BOT_ID = null;
let BOT_USERNAME = null;

async function initBot() {
  const me = await bot.getMe();
  BOT_ID = String(me.id);
  BOT_USERNAME = me.username ? String(me.username) : null;

  await redis.set(
    KEY_BOT_INFO,
    JSON.stringify({
      BOT_ID,
      BOT_USERNAME,
      at: new Date().toISOString(),
    })
  );

  // Webhook URL
  const base = String(PUBLIC_URL).replace(/\/$/, "");
  const secretQ = WEBHOOK_SECRET ? `?secret=${encodeURIComponent(WEBHOOK_SECRET)}` : "";
  const hookUrl = `${base}/telegram${secretQ}`;

  // allowed updates
  await bot.setWebHook(hookUrl, {
    allowed_updates: ["message", "callback_query", "chat_member", "my_chat_member"],
  });

  console.log("✅ Bot Ready (Webhook):", { BOT_ID, BOT_USERNAME, hookUrl });
}

initBot().catch((e) => {
  console.error("initBot error:", e);
  process.exit(1);
});

// Webhook receiver
app.post("/telegram", async (req, res) => {
  try {
    if (WEBHOOK_SECRET) {
      const s = req.query.secret;
      if (!s || String(s) !== String(WEBHOOK_SECRET)) {
        return res.status(403).json({ ok: false });
      }
    }

    // feed update into bot
    bot.processUpdate(req.body);
    res.json({ ok: true });
  } catch (e) {
    console.error("telegram webhook error:", e);
    res.status(500).json({ ok: false });
  }
});

// ================= Premium Flow =================
//
// ✅ Group join/leave service message auto delete
// ✅ No auto register, no popup, no spam
// ✅ Register only in DM (/start)
// ✅ Optional /register in group -> shows DM button (user clicks -> DM register)
//
// Notes:
// - Bot must be admin and have Delete permission to delete service messages
//

async function tryDelete(chatId, messageId, delayMs = 600) {
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (_) {}
  }, delayMs);
}

function dmRegisterUrl() {
  if (!BOT_USERNAME) return null;
  // When user clicks, it opens bot DM with /start reg
  return `https://t.me/${BOT_USERNAME}?start=reg`;
}

// Catch service messages in group: new member / left member
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat) return;

    // Save last seen group for debugging
    if (targetGroup(msg.chat)) {
      await redis.set(KEY_LAST_GROUP, String(msg.chat.id));
    }

    if (!targetGroup(msg.chat)) return;

    // Auto delete join messages
    if (msg.new_chat_members?.length) {
      // delete the service message itself
      await tryDelete(msg.chat.id, msg.message_id, 500);
      return;
    }

    // Auto delete left messages
    if (msg.left_chat_member) {
      await tryDelete(msg.chat.id, msg.message_id, 500);
      return;
    }
  } catch (e) {
    console.error("message handler error:", e);
  }
});

// Backup join detection (Admin Add Members etc.)
bot.on("chat_member", async (upd) => {
  try {
    const chat = upd.chat;
    if (!targetGroup(chat)) return;

    await redis.set(KEY_LAST_GROUP, String(chat.id));

    // We keep silent: do not register here, do not message
    // (Premium policy: register only via DM)
  } catch (e) {
    console.error("chat_member handler error:", e);
  }
});

// /register in group -> send DM button (and optionally delete this bot message later)
bot.onText(/\/register(@\w+)?/i, async (msg) => {
  try {
    if (!msg || !msg.chat) return;
    if (!targetGroup(msg.chat)) return;

    const url = dmRegisterUrl();
    if (!url) return;

    const sent = await bot.sendMessage(
      msg.chat.id,
      "📩 Register လုပ်ရန် DM ထဲကိုဝင်ပြီး Register Button ကိုနှိပ်ပါ။",
      {
        reply_markup: {
          inline_keyboard: [[{ text: "✅ DM Register", url }]],
        },
      }
    );

    // auto delete bot prompt after 60s to keep group clean
    await tryDelete(msg.chat.id, sent.message_id, 60000);
  } catch (e) {
    console.error("/register error:", e);
  }
});

// Private /start => register (ONLY here)
bot.onText(/\/start(?:\s+(.+))?/i, async (msg, match) => {
  try {
    if (!msg || !msg.chat) return;
    if (msg.chat.type !== "private") return;

    const payload = (match && match[1]) ? String(match[1]).trim() : "";
    const u = msg.from;
    if (!u) return;

    // register always (id+name+username)
    if (!isExcludedUser(u.id)) {
      await saveMemberRegistered(u, payload ? `dm_start:${payload}` : "dm_start");
    }

    // Premium: reply minimal
    await bot.sendMessage(
      msg.chat.id,
      "✅ Register အောင်မြင်ပါပြီ။\n\n🎁 Prize ပေါက်ရင် ဒီ DM ကနေ ဆက်သွယ်ပေးပါမယ်။"
    );
  } catch (e) {
    console.error("/start error:", e);
  }
});

// ================= API =================
app.get("/health", async (req, res) => {
  try {
    const members = await redis.scard(KEY_MEMBERS_SET);
    const winners = await redis.scard(KEY_WINNERS_SET);
    const bagLen = await redis.llen(KEY_PRIZE_BAG);
    const lastGroup = await redis.get(KEY_LAST_GROUP);
    const botInfoRaw = await redis.get(KEY_BOT_INFO);

    let botInfo = null;
    try {
      botInfo = botInfoRaw ? JSON.parse(botInfoRaw) : null;
    } catch {
      botInfo = botInfoRaw || null;
    }

    res.json({
      ok: true,
      mode: "webhook",
      bot: botInfo,
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
      const uid = String(id);
      if (isExcludedUser(uid)) continue;

      const h = await redis.hgetall(KEY_MEMBER_HASH(uid));
      if (!h || !h.id) continue;

      const isWinner = await redis.sismember(KEY_WINNERS_SET, uid);

      members.push({
        id: String(h.id),
        name: String(h.name || "").trim(),
        username: String(h.username || "").trim().replace("@", ""),
        display: displayNameFromHash(h) || uid,
        dm_ready: true,
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
      const uid = String(id);
      if (isExcludedUser(uid)) continue;

      const isWinner = await redis.sismember(KEY_WINNERS_SET, uid);
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
      return res.status(400).json({
        ok: false,
        error: "No valid prizes. Example: 10000Ks 4time",
      });
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

app.post("/spin", requireApiKey, async (req, res) => {
  try {
    // 1) eligible members (registered, not excluded, not winner)
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const eligible = [];

    for (const id of ids || []) {
      const uid = String(id);
      if (isExcludedUser(uid)) continue;

      const isWinner = await redis.sismember(KEY_WINNERS_SET, uid);
      if (!isWinner) eligible.push(uid);
    }

    if (!eligible.length) {
      return res.status(400).json({
        ok: false,
        error: "No members left in pool. Restart Spin to reset winners.",
      });
    }

    // 2) prize
    const bagLen = await redis.llen(KEY_PRIZE_BAG);
    if (!bagLen || bagLen <= 0) {
      return res.status(400).json({
        ok: false,
        error: "No prizes left. Set prizes in Settings and Save.",
      });
    }

    const bag = await redis.lrange(KEY_PRIZE_BAG, 0, bagLen - 1);
    const prize = randPick(bag);
    await redis.lrem(KEY_PRIZE_BAG, 1, String(prize)); // remove one

    // 3) winner
    const winnerId = randPick(eligible);
    const h = await redis.hgetall(KEY_MEMBER_HASH(winnerId));

    const item = {
      at: new Date().toISOString(),
      prize: String(prize),
      winner: {
        id: String(winnerId),
        name: String(h?.name || "").trim(),
        username: String(h?.username || "").trim().replace("@", ""),
        display: displayNameFromHash(h) || winnerId,
        dm_ready: true,
      },
    };

    await redis.sadd(KEY_WINNERS_SET, String(winnerId));
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

// ================= Start Server =================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("✅ Server listening on", PORT);
});app.listen(PORT, () => console.log("Server running on", PORT));
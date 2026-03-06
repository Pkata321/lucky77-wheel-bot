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

  GROUP_ID,
  EXCLUDE_IDS,

  PUBLIC_URL,
  WEBHOOK_SECRET,

  CHANNEL_CHAT,
  CHANNEL_LINK,
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

if (!GROUP_ID) console.warn("⚠️ GROUP_ID not set (pin restrict target only).");
if (!CHANNEL_CHAT && !CHANNEL_LINK) console.warn("⚠️ CHANNEL_CHAT/LINK not set (channel gate disabled).");

/* ================= Redis ================= */
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

/* ================= Keys =================
   ⚠️ IMPORTANT: ဒီ PREFIX / KEY တွေ မပြောင်းပါ (Member list မပျောက်အောင်)
========================================= */
const KEY_PREFIX = "lucky77:pro:v2:remax";

const KEY_MEMBERS_SET = `${KEY_PREFIX}:members:set`;
const KEY_MEMBER_HASH = (id) => `${KEY_PREFIX}:member:${id}`;

const KEY_WINNERS_SET = `${KEY_PREFIX}:winners:set`;
const KEY_HISTORY_LIST = `${KEY_PREFIX}:history:list`;

const KEY_POOL_SET = `${KEY_PREFIX}:pool:set`;

const KEY_PRIZE_BAG = `${KEY_PREFIX}:prizes:bag`;
const KEY_PRIZE_SOURCE = `${KEY_PREFIX}:prizes:source`;

const KEY_LAST_GROUP = `${KEY_PREFIX}:last_group_id`;

const KEY_PINNED_MSG_ID = (gid) => `${KEY_PREFIX}:pinned:${gid}`;
const KEY_PIN_TEXT = `${KEY_PREFIX}:pin:text`;
const KEY_PIN_MODE = `${KEY_PREFIX}:pin:mode`;
const KEY_PIN_FILE = `${KEY_PREFIX}:pin:file_id`;

// join gate (live)
const KEY_JOIN_CAP = `${KEY_PREFIX}:join:cap`;
const KEY_JOIN_BTN = `${KEY_PREFIX}:join:btn`;

// reg dm (live)
const KEY_REG_CAP = `${KEY_PREFIX}:reg:cap`;
const KEY_REG_BTN = `${KEY_PREFIX}:reg:btn`; // also used for pinned button label
const KEY_REG_MODE = `${KEY_PREFIX}:reg:mode`;
const KEY_REG_FILE = `${KEY_PREFIX}:reg:file`;

// notice ctx
const KEY_NOTICE_CTX = (uid) => `${KEY_PREFIX}:notice:ctx:${uid}`;

// indexes
const KEY_USER_INDEX = (u) => `${KEY_PREFIX}:index:username:${u}`;
const KEY_NAME_INDEX = (n) => `${KEY_PREFIX}:index:name:${n}`;

// ===== STAGING (owner sets -> /upload applies) =====
const KEY_STG_JOIN_CAP = `${KEY_PREFIX}:stg:join:cap`;
const KEY_STG_JOIN_BTN = `${KEY_PREFIX}:stg:join:btn`;

const KEY_STG_REG_CAP = `${KEY_PREFIX}:stg:reg:cap`;
const KEY_STG_REG_BTN = `${KEY_PREFIX}:stg:reg:btn`;
const KEY_STG_REG_MODE = `${KEY_PREFIX}:stg:reg:mode`;
const KEY_STG_REG_FILE = `${KEY_PREFIX}:stg:reg:file`;

const KEY_STG_POST_CAP = `${KEY_PREFIX}:stg:post:cap`;
const KEY_STG_POST_BTN = `${KEY_PREFIX}:stg:post:btn`;
const KEY_STG_POST_MODE = `${KEY_PREFIX}:stg:post:mode`;
const KEY_STG_POST_FILE = `${KEY_PREFIX}:stg:post:file`;

/* ================= Event/Test/WinnerMeta =================
   ✅ Test Mode ON/OFF
   ✅ Turn seq
   ✅ Prize Done status
========================================================== */
const KEY_TEST_MODE = `${KEY_PREFIX}:testmode`;                 // "1" or "0"
const KEY_TURN_SEQ = `${KEY_PREFIX}:turn:seq`;                  // INCR -> 1,2,3...
const KEY_WINNER_META = (uid) => `${KEY_PREFIX}:winner:${uid}`; // hash: {turn, prize, done, at, done_at}

/* ================= Telegram Bot (Webhook) ================= */
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });
let BOT_USERNAME = null;

/* ================= Helpers ================= */
const excludeIds = (EXCLUDE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(String);

function isOwner(userId) {
  return String(userId) === String(OWNER_ID);
}
function ownerOnly(msg) {
  return msg && msg.chat && msg.chat.type === "private" && isOwner(msg.from?.id);
}
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
function normalizeName(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}
function normalizeUsername(s) {
  return String(s || "").trim().replace(/^@+/, "").toLowerCase();
}
function targetGroup(chat) {
  if (!chat) return false;
  const t = String(chat.type);
  if (t !== "group" && t !== "supergroup") return false;
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
function nowISO() {
  return new Date().toISOString();
}
function extractCmdText(text, cmd) {
  return String(text || "")
    .replace(new RegExp(`^\\/${cmd}(@\\w+)?\\s*`, "i"), "")
    .trim();
}

/* ================= Test Mode helpers ================= */
async function getTestMode() {
  const v = await redis.get(KEY_TEST_MODE);
  return String(v || "0") === "1";
}
async function setTestMode(enabled) {
  await redis.set(KEY_TEST_MODE, enabled ? "1" : "0");
  return { ok: true, enabled: !!enabled };
}

/* ================= Start URL / Keyboard ================= */
async function getStartUrl() {
  if (!BOT_USERNAME) {
    try {
      const me = await bot.getMe();
      BOT_USERNAME = me.username ? String(me.username) : null;
    } catch (_) {}
  }
  return BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=register` : "";
}
async function buildStartKeyboard(label) {
  const startUrl = await getStartUrl();
  if (!startUrl) return undefined;
  const txt = String(label || "").trim() || "▶️ Register / Enable DM";
  return { inline_keyboard: [[{ text: txt, url: startUrl }]] };
}

/* ================= Channel Gate ================= */
function getChannelLink() {
  if (CHANNEL_LINK) return String(CHANNEL_LINK);
  if (CHANNEL_CHAT) return `https://t.me/${String(CHANNEL_CHAT).replace("@", "")}`;
  return "";
}
async function isChannelMember(userId) {
  if (!CHANNEL_CHAT) return true;
  try {
    const m = await bot.getChatMember(String(CHANNEL_CHAT), Number(userId));
    const st = String(m?.status || "");
    return st === "member" || st === "administrator" || st === "creator";
  } catch (_) {
    return false;
  }
}
async function getJoinGateLive() {
  const cap =
    (await redis.get(KEY_JOIN_CAP)) ||
    "❌ Channel ကို Join ပြီးမှ Register/Enable DM လုပ်နိုင်ပါသည်。\n\n👉 အောက်က Button နဲ့ Join လုပ်ပြီး ပြန်စစ်ပါ။";
  const btn = (await redis.get(KEY_JOIN_BTN)) || "📢 Join Channel";
  return { cap: String(cap), btn: String(btn) };
}
async function sendJoinGate(chatId, userId) {
  const link = getChannelLink();
  const live = await getJoinGateLive();
  const kb = {
    inline_keyboard: [
      ...(link ? [[{ text: live.btn, url: link }]] : []),
      [{ text: "✅ Joined (Check Again)", callback_data: `chkch:${String(userId)}` }],
    ],
  };
  return bot.sendMessage(chatId, live.cap, { reply_markup: kb });
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

/* ================= Member storage (SAFE) =================
   ✅ အဓိက: Member 167 name/username မပျောက်အောင် "merge" save
========================================================== */
async function indexMemberIdentity({ id, name, username }) {
  const u = normalizeUsername(username);
  const n = normalizeName(name);
  if (u) await redis.set(KEY_USER_INDEX(u), String(id));
  if (n) await redis.set(KEY_NAME_INDEX(n), String(id));
}

async function saveMember(u, source = "group_join") {
  const userId = String(u.id);
  if (isExcludedUser(userId)) return { ok: false, reason: "excluded" };

  const { name, username } = nameParts(u);
  const cleanUsername = String(username || "").replace("@", "").trim();

  // ✅ merge safe: old display/name/username ကို မဖျက်
  const prev = await redis.hgetall(KEY_MEMBER_HASH(userId)).catch(() => ({}));
  const prevName = String(prev?.name || "").trim();
  const prevUsername = String(prev?.username || "").trim();
  const prevDisplay = String(prev?.display || "").trim();

  const nextName = String(name || "").trim() || prevName;
  const nextUsername = cleanUsername || prevUsername.replace("@", "").trim();

  const display =
    prevDisplay ||
    nextName ||
    (nextUsername ? `@${nextUsername}` : userId);

  const prevDmReady = String(prev?.dm_ready || "0");
  const prevRegAt = String(prev?.registered_at || "");

  await redis.sadd(KEY_MEMBERS_SET, userId);

  // keep pool logic the same
  const isWinner = await redis.sismember(KEY_WINNERS_SET, userId);
  if (!isWinner) await redis.sadd(KEY_POOL_SET, userId);
  else await redis.srem(KEY_POOL_SET, userId);

  await redis.hset(KEY_MEMBER_HASH(userId), {
    id: userId,
    name: nextName,
    username: nextUsername,
    display,

    dm_ready: prevDmReady === "1" ? "1" : "0",
    dm_ready_at: String(prev?.dm_ready_at || ""),

    active: "1",
    left_at: "",
    left_reason: "",

    source: String(source),
    registered_at: prevRegAt || nowISO(),
    last_seen_at: nowISO(),
  });

  await indexMemberIdentity({ id: userId, name: nextName, username: nextUsername });
  return { ok: true };
}

async function setDmReady(userId) {
  await redis.hset(KEY_MEMBER_HASH(String(userId)), {
    dm_ready: "1",
    dm_ready_at: nowISO(),
  });
}

async function markInactive(userId, reason = "left_group") {
  const uid = String(userId);
  if (isExcludedUser(uid)) return { ok: false, reason: "excluded" };

  await redis.sadd(KEY_MEMBERS_SET, uid);
  await redis.hset(KEY_MEMBER_HASH(uid), {
    active: "0",
    left_at: nowISO(),
    left_reason: String(reason),
  });
  await redis.srem(KEY_POOL_SET, uid);
  return { ok: true };
}

async function removeMemberHard(userId) {
  const uid = String(userId);

  const h = await redis.hgetall(KEY_MEMBER_HASH(uid)).catch(() => ({}));
  const u = normalizeUsername(h?.username || "");
  const n = normalizeName(h?.name || "");

  await redis.srem(KEY_MEMBERS_SET, uid);
  await redis.srem(KEY_POOL_SET, uid);
  await redis.srem(KEY_WINNERS_SET, uid);
  await redis.del(KEY_MEMBER_HASH(uid));

  // also remove winner meta if exists
  await redis.del(KEY_WINNER_META(uid)).catch(() => {});

  if (u) await redis.del(KEY_USER_INDEX(u));
  if (n) await redis.del(KEY_NAME_INDEX(n));

  return { ok: true };
}

/* ================= Auth ================= */
function requireApiKey(req, res, next) {
  const k = req.headers["x-api-key"] || req.query.key;
  if (!k || String(k) !== String(API_KEY)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

/* ================= Express ================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: "6mb" }));

/* ================= PRIZES CONFIG ================= */
app.post("/config/prizes", requireApiKey, async (req, res) => {
  try {
    const { prizeText } = req.body || {};
    const bag = parsePrizeTextExpand(prizeText);

    if (!bag.length) return res.status(400).json({ ok: false, error: "no_valid_prizes" });

    await redis.set(KEY_PRIZE_SOURCE, String(prizeText || ""));
    await redis.del(KEY_PRIZE_BAG);
    await redis.rpush(KEY_PRIZE_BAG, ...bag);

    res.json({ ok: true, bag_size: bag.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/", (req, res) => res.send("Lucky77 Wheel Bot ✅"));
/* ================= Webhook ================= */

const webhookPath = `/bot/${WEBHOOK_SECRET}`;

bot.setWebHook(`${PUBLIC_URL}${webhookPath}`);

app.post(webhookPath, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

/* ================= HEALTH ================= */

app.get("/health", async (req, res) => {
  try {
    const testMode = await getTestMode();
    const poolSize = await redis.scard(KEY_POOL_SET);

    res.json({
      ok: true,
      time: nowISO(),
      pool: poolSize,
      test_mode: testMode,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ================= CONFIG ================= */

app.get("/config", requireApiKey, async (req, res) => {
  try {
    const source = await redis.get(KEY_PRIZE_SOURCE);
    const bag = await redis.lrange(KEY_PRIZE_BAG, 0, -1);
    const testMode = await getTestMode();

    res.json({
      ok: true,
      prizes_source: source || "",
      prize_bag_size: bag.length,
      test_mode: testMode,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ================= TEST MODE ================= */

app.post("/config/testmode", requireApiKey, async (req, res) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled === "undefined") {
      return res.status(400).json({ ok: false, error: "enabled missing" });
    }

    const r = await setTestMode(Boolean(enabled));

    res.json({
      ok: true,
      test_mode: r.enabled,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ================= EVENT RESET =================
   Restart Spin button
============================================== */

app.post("/event/reset", requireApiKey, async (req, res) => {
  try {
    // reset only event data (members must stay)
await redis.del(KEY_WINNERS_SET);
await redis.del(KEY_HISTORY_LIST);
await redis.del(KEY_POOL_SET);
await redis.del(KEY_TURN_SEQ);

    const ids = await redis.smembers(KEY_MEMBERS_SET);

    for (const id of ids) {
      const m = await redis.hgetall(KEY_MEMBER_HASH(id));
      if (!m) continue;

      if (String(m.active) === "1") {
        await redis.sadd(KEY_POOL_SET, id);
      }

      await redis.del(KEY_WINNER_META(id));
    }

    res.json({
      ok: true,
      pool_reset: true,
      members_total: ids.length,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ================= POOL ================= */

app.get("/pool", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_POOL_SET);

    res.json({
      ok: true,
      pool: ids.length,
      ids,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
/* ================= MEMBERS ================= */

app.get("/members", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);

    const members = [];

    for (const id of ids) {
      const m = await redis.hgetall(KEY_MEMBER_HASH(id));
      if (!m) continue;

      const display =
  m.display ||
  m.name ||
  (m.username ? "@" + m.username : "") ||
  m.id;

members.push({
  id: m.id,
  name: m.name || "",
  username: m.username || "",
  display,
  active: String(m.active) === "1",
  dm_ready: String(m.dm_ready) === "1",
});
    }

    res.json({
      ok: true,
      total: members.length,
      members,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ================= HISTORY ================= */

app.get("/history", requireApiKey, async (req, res) => {
  try {
    const list = await redis.lrange(KEY_HISTORY_LIST, 0, -1);

    const out = [];

    for (const raw of list) {
      try {
        out.push(JSON.parse(raw));
      } catch (_) {}
    }

    res.json({
      ok: true,
      total: out.length,
      history: out,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ================= WINNERS (UI LIST) ================= */
app.get("/winners", requireApiKey, async (req, res) => {
  try {
    const list = await redis.lrange(KEY_HISTORY_LIST, 0, -1);

    const winners = [];
    for (const raw of list) {
      let it = null;
      try { it = JSON.parse(raw); } catch { continue; }
      if (!it) continue;

      const uid = String(it.user_id || "").trim();
      if (!uid) continue;

      const meta = await redis.hgetall(KEY_WINNER_META(uid)).catch(() => ({}));
      const done = String(meta?.done || "0") === "1";

      const username = String(it.username || meta?.username || "").trim();
      const hasUsername = !!username;

      winners.push({
        turn: Number(it.turn || meta?.turn || 0),
        at: String(it.at || meta?.at || ""),
        prize: String(it.prize || meta?.prize || ""),

        user_id: uid,
        name: String(it.name || meta?.name || ""),
        username,
        display: String(it.display || meta?.display || uid),

        done,
        done_at: String(meta?.done_at || ""),

        // ✅ UI button logic helper fields
        need_notice_dm: !hasUsername,          // username မရှိ => UI က Notice DM button ပြ
        telegram_username: hasUsername ? username.replace(/^@+/, "") : "",
      });
    }

    winners.sort((a, b) => Number(a.turn || 0) - Number(b.turn || 0));
    res.json({ ok: true, total: winners.length, winners });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ================= SPIN ================= */

app.post("/spin", requireApiKey, async (req, res) => {
  try {

    const pool = await redis.smembers(KEY_POOL_SET);

    if (!pool.length) {
      return res.json({
        ok: false,
        error: "pool_empty",
      });
    }
    
    // ===== ensure prize bag exists (auto rebuild) =====
let bag = await redis.lrange(KEY_PRIZE_BAG, 0, -1);

if (!bag.length) {
  const source = await redis.get(KEY_PRIZE_SOURCE);

  const built = parsePrizeTextExpand(source || "");

  if (built.length) {
    await redis.del(KEY_PRIZE_BAG);
    await redis.rpush(KEY_PRIZE_BAG, ...built);
    bag = built;
  }
}

if (!bag.length) {
  return res.json({ ok: false, error: "no_prizes" });
}
    

  
    /* ===== random member (safe pick) ===== */
let userId = null;
let member = null;

for (let i = 0; i < Math.min(pool.length, 10); i++) {
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const m = await redis.hgetall(KEY_MEMBER_HASH(pick));

  if (!m || !m.id) {
    await redis.srem(KEY_POOL_SET, pick);
    continue;
  }

  if (isExcludedUser(pick) || String(m.active) !== "1") {
    await redis.srem(KEY_POOL_SET, pick);
    continue;
  }

  userId = pick;
  member = m;
  break;
}

if (!userId || !member) {
  return res.json({ ok: false, error: "no_valid_member" });
}
    /* ===== random prize ===== */

    const prize = bag[Math.floor(Math.random() * bag.length)];

    /* ===== remove from pool ===== */

    await redis.srem(KEY_POOL_SET, userId);

    /* ===== mark winner ===== */

    await redis.sadd(KEY_WINNERS_SET, userId);

    /* ===== turn sequence ===== */

    const turn = await redis.incr(KEY_TURN_SEQ);

    /* ===== save winner meta ===== */

    await redis.hset(KEY_WINNER_META(userId), {
      user_id: userId,
      name: member.name || "",
      username: member.username || "",
      display: member.display || userId,

      prize,
      turn,

      done: "0",
      at: nowISO(),
      done_at: "",
    });

    /* ===== save history ===== */

    const record = {
      user_id: userId,
      name: member.name || "",
      username: member.username || "",
      display: member.display || userId,
      prize,
      turn,
      at: nowISO(),
    };

    await redis.rpush(KEY_HISTORY_LIST, JSON.stringify(record));

    /* ===== response ===== */

    res.json({
      ok: true,
      winner: {
        id: userId,
        name: member.name || "",
        username: member.username || "",
        display: member.display || userId,
      },
      prize,
      turn,
    });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
/* ================= NOTICE (DM WINNER) ================= */
app.post("/notice", requireApiKey, async (req, res) => {
  try {
    const { user_id, prize, text } = req.body || {};
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id missing" });

    const uid = String(user_id);
    const pz = prize ? String(prize) : "";

    const m = await redis.hgetall(KEY_MEMBER_HASH(uid));
    if (!m || !m.id) return res.status(404).json({ ok: false, error: "member_not_found" });

    const msgText =
      text && String(text).trim()
        ? String(text)
        : "Congratulations 🥳🥳🥳ပါအကိုရှင့်\n" +
          `လက်ကီး77 ရဲ့ လစဉ်ဗလာမပါလက်ကီးဝှီး အစီစဉ်မှာ ယူနစ် ${pz || "—"} ကံထူးသွားပါတယ်ရှင့်☘️\n` +
          "ဂိမ်းယူနစ်လေး ထည့်ပေးဖို့ အကို့ဂိမ်းအကောင့်လေး ပို့ပေးပါရှင့်";

    try {
      await bot.sendMessage(Number(uid), msgText);

      // ✅ DM ok
      await redis.hset(KEY_MEMBER_HASH(uid), {
        dm_ready: "1",
        dm_ready_at: nowISO(),
      });

    } catch (e) {
      // ✅ DM fail
      await redis.hset(KEY_MEMBER_HASH(uid), {
        dm_ready: "0",
      });

      return res.status(200).json({
        ok: false,
        error: "dm_failed",
        detail: e?.message || "sendMessage_failed",
      });
    }

    await redis.set(
      KEY_NOTICE_CTX(uid),
      JSON.stringify({ user_id: uid, prize: pz, at: nowISO() })
    );

    res.json({ ok: true });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


/* ================= WINNER REPLY FORWARD ================= */
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat || !msg.from) return;

    const chatType = String(msg.chat.type);
    if (chatType !== "private") return;

    const uid = String(msg.from.id);
    if (isOwner(uid)) return;

    const ctxRaw = await redis.get(KEY_NOTICE_CTX(uid));
    if (!ctxRaw) return;

    let ctx = {};
    try { ctx = JSON.parse(ctxRaw); } catch {}

    const hasText = msg.text && String(msg.text).trim();
    const hasMedia = !!(msg.photo || msg.video || msg.document || msg.voice || msg.audio);

    if (!hasText && !hasMedia) return;

    const header =
`📨 အနိုင်ရသူ Reply (Auto Forward)

အမည် : ${msg.from.first_name || "-"}
Username : ${msg.from.username ? "@" + msg.from.username : "-"}
ID : ${uid}
ဆု : ${ctx.prize || "-"}
`;

    if (hasText) {
      await bot.sendMessage(Number(OWNER_ID), `${header}\nReply:\n${msg.text}`);
    } else {
      await bot.sendMessage(Number(OWNER_ID), `${header}\nReply: (media)`);
    }

    if (hasMedia) {
      try {
        await bot.forwardMessage(Number(OWNER_ID), msg.chat.id, msg.message_id);
      } catch (_) {}
    }

  } catch (err) {
    console.error("winner reply forward error", err);
  }
});


/* ================= WINNER DONE ================= */

app.post("/winner/done", requireApiKey, async (req, res) => {
  try {

    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ ok: false });
    }

    const uid = String(user_id);

    const meta = await redis.hgetall(KEY_WINNER_META(uid));

    if (!meta) {
      return res.json({ ok: false, error: "winner_not_found" });
    }

    await redis.hset(KEY_WINNER_META(uid), {
      done: "1",
      done_at: nowISO(),
    });

    res.json({ ok: true });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
/* ================= MEMBER REGISTER ================= */

bot.onText(/\/start/, async (msg) => {
  try {
    if (!msg.from) return;

    const uid = String(msg.from.id);

    // ✅ Channel-only gate: must join channel first
    const ok = await isChannelMember(uid);
    if (!ok) {
      await sendJoinGate(uid, uid);
      return;
    }

    // ✅ joined => register + dm ready
    await saveMember(msg.from, "start_register");
    await setDmReady(uid);

    const cap =
      (await redis.get(KEY_REG_CAP)) ||
      "Registered ပြီးပါပြီ ✅\n\nLucky77 Lucky Wheel Event မှာ ပါဝင်နိုင်ပါပြီ။";

    const btn =
      (await redis.get(KEY_REG_BTN)) ||
      "Lucky Wheel";

    const kb = await buildStartKeyboard(btn);

    await bot.sendMessage(uid, cap, { reply_markup: kb });

  } catch (err) {
    console.error("register error", err);
  }
});

/* ================= CHANNEL MEMBER UPDATE ================= */
bot.on("chat_member", async (upd) => {
  try {
    if (!upd || !upd.chat || !upd.new_chat_member) return;
    if (!CHANNEL_CHAT) return;

    const chatUsername = String(upd.chat.username || "");
    const chatId = String(upd.chat.id || "");

    const targetA = String(CHANNEL_CHAT);
    const targetB = String(CHANNEL_CHAT).replace("@", "");

    const sameChannel =
      chatId === targetA ||
      chatUsername === targetB;

    if (!sameChannel) return;

    const user = upd.new_chat_member.user;
    const st = String(upd.new_chat_member.status || "");

    if (!user || !user.id) return;
    if (isExcludedUser(user.id)) return;

    if (st === "left" || st === "kicked") {
      await markInactive(String(user.id), st);
      return;
    }

    if (st === "member" || st === "administrator" || st === "creator") {
      await saveMember(user, "channel_member_update");
      return;
    }

  } catch (err) {
    console.error("chat_member update error", err);
  }
});


/* ================= OWNER COMMANDS ================= */

// ဒီအောက်မှာ ထည့် ✅
bot.onText(/\/syncmembers/, async (msg) => {
  if (!ownerOnly(msg)) return;
  if (!CHANNEL_CHAT) return bot.sendMessage(msg.chat.id, "CHANNEL_CHAT မရှိသေးပါ");

  const ids = await redis.smembers(KEY_MEMBERS_SET);
  let fixed = 0;

  for (const id of ids) {
    try {
      const m = await bot.getChatMember(String(CHANNEL_CHAT), Number(id));
      if (!m || !m.user) continue;
      await saveMember(m.user, "sync_channel");
      fixed++;
    } catch (e) {
      // optional: error log
      // console.log("sync fail", id, e.message);
    }
  }

  bot.sendMessage(msg.chat.id, `Members synced (channel) : ${fixed}`);
});


/* ================= REMOVE MEMBER ================= */

bot.onText(/\/remove (.+)/, async (msg, match) => {

  if (!ownerOnly(msg)) return;

  const key = match[1];

  let uid = null;

  if (/^\d+$/.test(key)) {
    uid = key;
  }

  if (!uid) {
    const byUser = await redis.get(KEY_USER_INDEX(normalizeUsername(key)));
    if (byUser) uid = byUser;
  }

  if (!uid) {
    const byName = await redis.get(KEY_NAME_INDEX(normalizeName(key)));
    if (byName) uid = byName;
  }

  if (!uid) {
    return bot.sendMessage(msg.chat.id, "Member not found");
  }

  await removeMemberHard(uid);

  bot.sendMessage(msg.chat.id, `Member removed : ${uid}`);

});


/* ================= CHANNEL JOIN CHECK ================= */

bot.on("callback_query", async (q) => {
  try {
    const data = q.data || "";
    if (!data.startsWith("chkch:")) return;

    const uid = String(q.from.id);

    const ok = await isChannelMember(uid);
    if (!ok) {
      await bot.answerCallbackQuery(q.id, {
        text: "Channel join မလုပ်သေးပါ",
        show_alert: true,
      });
      return;
    }

    // ✅ joined => register + dm ready
    await saveMember(q.from, "channel_check");
    await setDmReady(uid);

    await bot.answerCallbackQuery(q.id, { text: "Register OK" });

    const cap =
      (await redis.get(KEY_REG_CAP)) ||
      "Registered ပြီးပါပြီ ✅\n\nLucky77 Lucky Wheel Event မှာ ပါဝင်နိုင်ပါပြီ။";

    const btn =
      (await redis.get(KEY_REG_BTN)) ||
      "Lucky Wheel";

    const kb = await buildStartKeyboard(btn);

    await bot.sendMessage(uid, cap, { reply_markup: kb });

  } catch (err) {
    console.error("channel check error", err);
  }
});


/* ================= SERVER START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Lucky77 Wheel Bot running on ${PORT}`);
});
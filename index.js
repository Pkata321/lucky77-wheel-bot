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

if (!GROUP_ID) console.warn("GROUP_ID not set.");
if (!CHANNEL_CHAT && !CHANNEL_LINK) console.warn("CHANNEL_CHAT/LINK not set.");

/* ================= Redis ================= */
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

/* ================= Keys ================= */
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

const KEY_JOIN_CAP = `${KEY_PREFIX}:join:cap`;
const KEY_JOIN_BTN = `${KEY_PREFIX}:join:btn`;

const KEY_REG_CAP = `${KEY_PREFIX}:reg:cap`;
const KEY_REG_BTN = `${KEY_PREFIX}:reg:btn`;
const KEY_REG_MODE = `${KEY_PREFIX}:reg:mode`;
const KEY_REG_FILE = `${KEY_PREFIX}:reg:file`;

const KEY_NOTICE_CTX = (uid) => `${KEY_PREFIX}:notice:ctx:${uid}`;

const KEY_USER_INDEX = (u) => `${KEY_PREFIX}:index:username:${u}`;
const KEY_NAME_INDEX = (n) => `${KEY_PREFIX}:index:name:${n}`;

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

const KEY_TEST_MODE = `${KEY_PREFIX}:testmode`;
const KEY_TURN_SEQ = `${KEY_PREFIX}:turn:seq`;
const KEY_WINNER_META = (uid) => `${KEY_PREFIX}:winner:${uid}`;

/* ================= Bot ================= */
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

function nowISO() {
  return new Date().toISOString();
}

function extractCmdText(text, cmd) {
  return String(text || "")
    .replace(new RegExp(`^\\/${cmd}(@\\w+)?\\s*`, "i"), "")
    .trim();
}

async function autoDelete(chatId, messageId, ms = 2000) {
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (_) {}
  }, ms);
}

async function getTestMode() {
  const v = await redis.get(KEY_TEST_MODE);
  return String(v || "0") === "1";
}

async function setTestMode(enabled) {
  await redis.set(KEY_TEST_MODE, enabled ? "1" : "0");
  return { ok: true, enabled: !!enabled };
}

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
  await redis.del(KEY_WINNER_META(uid)).catch(() => {});

  if (u) await redis.del(KEY_USER_INDEX(u));
  if (n) await redis.del(KEY_NAME_INDEX(n));

  return { ok: true };
}

async function readMaybe(key) {
  const v = await redis.get(key);
  return typeof v === "undefined" ? null : v;
}

async function setIfText(key, value) {
  const v = String(value || "").trim();
  if (!v) return false;
  await redis.set(key, v);
  return true;
}

async function moveKey(src, dst) {
  const v = await readMaybe(src);
  if (v === null || v === "") return false;
  await redis.set(dst, v);
  return true;
}

async function delKeys(keys) {
  for (const k of keys) {
    try { await redis.del(k); } catch (_) {}
  }
}

async function getRegisterLive() {
  return {
    cap:
      (await readMaybe(KEY_REG_CAP)) ||
      "Registered ပြီးပါပြီ ✅\n\nLucky77 Lucky Wheel Event မှာ ပါဝင်နိုင်ပါပြီ။",
    btn:
      (await readMaybe(KEY_REG_BTN)) || "Lucky Wheel",
    mode:
      (await readMaybe(KEY_REG_MODE)) || "text",
    file:
      (await readMaybe(KEY_REG_FILE)) || "",
  };
}

async function sendRegisterDm(chatId) {
  const live = await getRegisterLive();
  const kb = await buildStartKeyboard(live.btn);

  if (live.mode === "photo" && live.file) {
    return bot.sendPhoto(chatId, live.file, {
      caption: String(live.cap || ""),
      reply_markup: kb,
    });
  }

  if (live.mode === "video" && live.file) {
    return bot.sendVideo(chatId, live.file, {
      caption: String(live.cap || ""),
      reply_markup: kb,
    });
  }

  return bot.sendMessage(chatId, String(live.cap || ""), {
    reply_markup: kb,
  });
}

async function applyUpload() {
  await moveKey(KEY_STG_JOIN_CAP, KEY_JOIN_CAP);
  await moveKey(KEY_STG_JOIN_BTN, KEY_JOIN_BTN);

  await moveKey(KEY_STG_REG_CAP, KEY_REG_CAP);
  await moveKey(KEY_STG_REG_BTN, KEY_REG_BTN);
  await moveKey(KEY_STG_REG_MODE, KEY_REG_MODE);
  await moveKey(KEY_STG_REG_FILE, KEY_REG_FILE);

  await delKeys([
    KEY_STG_JOIN_CAP,
    KEY_STG_JOIN_BTN,
    KEY_STG_REG_CAP,
    KEY_STG_REG_BTN,
    KEY_STG_REG_MODE,
    KEY_STG_REG_FILE,
  ]);
}

async function getPostStage() {
  return {
    cap: (await readMaybe(KEY_STG_POST_CAP)) || "",
    btn: (await readMaybe(KEY_STG_POST_BTN)) || "Register",
    mode: (await readMaybe(KEY_STG_POST_MODE)) || "text",
    file: (await readMaybe(KEY_STG_POST_FILE)) || "",
  };
}

async function sendChannelPostFromStage() {
  if (!CHANNEL_CHAT) throw new Error("CHANNEL_CHAT missing");

  const post = await getPostStage();
  const kb = await buildStartKeyboard(post.btn);
  const chatId = String(CHANNEL_CHAT);

  if (post.mode === "photo" && post.file) {
    return bot.sendPhoto(chatId, post.file, {
      caption: String(post.cap || ""),
      reply_markup: kb,
    });
  }

  if (post.mode === "video" && post.file) {
    return bot.sendVideo(chatId, post.file, {
      caption: String(post.cap || ""),
      reply_markup: kb,
    });
  }

  return bot.sendMessage(chatId, String(post.cap || ""), {
    reply_markup: kb,
  });
}

async function getPinLive() {
  return {
    text: (await readMaybe(KEY_PIN_TEXT)) || "",
    mode: (await readMaybe(KEY_PIN_MODE)) || "text",
    file: (await readMaybe(KEY_PIN_FILE)) || "",
  };
}

async function pushPinToGroup() {
  if (!GROUP_ID) throw new Error("GROUP_ID missing");

  const gid = String(GROUP_ID);
  const cfg = await getPinLive();

  if (!cfg.text && cfg.mode === "text") {
    throw new Error("pin_text_empty");
  }

  const oldId = await readMaybe(KEY_PINNED_MSG_ID(gid));
  if (oldId) {
    try { await bot.deleteMessage(gid, Number(oldId)); } catch (_) {}
  }

  let sent;
  if (cfg.mode === "photo" && cfg.file) {
    sent = await bot.sendPhoto(gid, cfg.file, {
      caption: String(cfg.text || ""),
    });
  } else if (cfg.mode === "video" && cfg.file) {
    sent = await bot.sendVideo(gid, cfg.file, {
      caption: String(cfg.text || ""),
    });
  } else {
    sent = await bot.sendMessage(gid, String(cfg.text || ""));
  }

  await redis.set(KEY_PINNED_MSG_ID(gid), String(sent.message_id));
  try { await bot.pinChatMessage(gid, sent.message_id, { disable_notification: true }); } catch (_) {}
  return sent;
}

async function resetEventData() {
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

  return { ok: true, members_total: ids.length };
}

async function buildStatusText() {
  const joinCap = await readMaybe(KEY_JOIN_CAP);
  const joinBtn = await readMaybe(KEY_JOIN_BTN);

  const regCap = await readMaybe(KEY_REG_CAP);
  const regBtn = await readMaybe(KEY_REG_BTN);
  const regMode = await readMaybe(KEY_REG_MODE);
  const regFile = await readMaybe(KEY_REG_FILE);

  const stgJoinCap = await readMaybe(KEY_STG_JOIN_CAP);
  const stgJoinBtn = await readMaybe(KEY_STG_JOIN_BTN);

  const stgRegCap = await readMaybe(KEY_STG_REG_CAP);
  const stgRegBtn = await readMaybe(KEY_STG_REG_BTN);
  const stgRegMode = await readMaybe(KEY_STG_REG_MODE);
  const stgRegFile = await readMaybe(KEY_STG_REG_FILE);

  const stgPostCap = await readMaybe(KEY_STG_POST_CAP);
  const stgPostBtn = await readMaybe(KEY_STG_POST_BTN);
  const stgPostMode = await readMaybe(KEY_STG_POST_MODE);
  const stgPostFile = await readMaybe(KEY_STG_POST_FILE);

  const pinText = await readMaybe(KEY_PIN_TEXT);
  const pinMode = await readMaybe(KEY_PIN_MODE);
  const pinFile = await readMaybe(KEY_PIN_FILE);

  const t = await getTestMode();

  return (
`Lucky77 Status

LIVE JOIN
cap: ${joinCap ? "yes" : "no"}
btn: ${joinBtn || "-"}

LIVE REG
cap: ${regCap ? "yes" : "no"}
btn: ${regBtn || "-"}
mode: ${regMode || "-"}
file: ${regFile ? "yes" : "no"}

STAGING JOIN
cap: ${stgJoinCap ? "yes" : "no"}
btn: ${stgJoinBtn || "-"}

STAGING REG
cap: ${stgRegCap ? "yes" : "no"}
btn: ${stgRegBtn || "-"}
mode: ${stgRegMode || "-"}
file: ${stgRegFile ? "yes" : "no"}

STAGING POST
cap: ${stgPostCap ? "yes" : "no"}
btn: ${stgPostBtn || "-"}
mode: ${stgPostMode || "-"}
file: ${stgPostFile ? "yes" : "no"}

PIN
text: ${pinText ? "yes" : "no"}
mode: ${pinMode || "-"}
file: ${pinFile ? "yes" : "no"}

TEST MODE
enabled: ${t ? "yes" : "no"}`
  );
}

function repliedPhotoFileId(msg) {
  const p = msg?.reply_to_message?.photo;
  if (!p || !Array.isArray(p) || !p.length) return "";
  return String(p[p.length - 1].file_id || "");
}

function repliedVideoFileId(msg) {
  return String(msg?.reply_to_message?.video?.file_id || "");
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

/* ================= API ================= */
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

const webhookPath = `/bot/${WEBHOOK_SECRET}`;
bot.setWebHook(`${PUBLIC_URL}${webhookPath}`);

app.post(webhookPath, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

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

app.post("/config/testmode", requireApiKey, async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled === "undefined") {
      return res.status(400).json({ ok: false, error: "enabled missing" });
    }
    const r = await setTestMode(Boolean(enabled));
    res.json({ ok: true, test_mode: r.enabled });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/event/reset", requireApiKey, async (req, res) => {
  try {
    const r = await resetEventData();
    res.json({
      ok: true,
      pool_reset: true,
      members_total: r.members_total,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/pool", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_POOL_SET);
    res.json({ ok: true, pool: ids.length, ids });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/members", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const members = [];

    for (const id of ids) {
      const m = await redis.hgetall(KEY_MEMBER_HASH(id));
      if (!m || !m.id) continue;

      const display =
        String(m.display || "").trim() ||
        String(m.name || "").trim() ||
        (m.username ? "@" + String(m.username).replace(/^@+/, "") : "") ||
        String(m.id);

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

app.get("/history", requireApiKey, async (req, res) => {
  try {
    const list = await redis.lrange(KEY_HISTORY_LIST, 0, -1);
    const out = [];
    for (const raw of list) {
      try { out.push(JSON.parse(raw)); } catch (_) {}
    }
    res.json({ ok: true, total: out.length, history: out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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

        need_notice_dm: !hasUsername,
        telegram_username: hasUsername ? username.replace(/^@+/, "") : "",
      });
    }

    winners.sort((a, b) => Number(a.turn || 0) - Number(b.turn || 0));
    res.json({ ok: true, total: winners.length, winners });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/spin", requireApiKey, async (req, res) => {
  try {
    const pool = await redis.smembers(KEY_POOL_SET);

    if (!pool.length) {
      return res.json({ ok: false, error: "pool_empty" });
    }

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

    const prize = bag[Math.floor(Math.random() * bag.length)];

    await redis.srem(KEY_POOL_SET, userId);
    await redis.sadd(KEY_WINNERS_SET, userId);

    const turn = await redis.incr(KEY_TURN_SEQ);

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
      await redis.hset(KEY_MEMBER_HASH(uid), {
        dm_ready: "1",
        dm_ready_at: nowISO(),
      });
    } catch (e) {
      await redis.hset(KEY_MEMBER_HASH(uid), { dm_ready: "0" });
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

app.post("/winner/done", requireApiKey, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ ok: false });

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

/* ================= Winner reply forward ================= */
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat || !msg.from) return;
    if (String(msg.chat.type) !== "private") return;

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

/* ================= Register flow ================= */
bot.onText(/\/start/, async (msg) => {
  try {
    if (!msg.from) return;

    const uid = String(msg.from.id);
    const ok = await isChannelMember(uid);

    if (!ok) {
      await sendJoinGate(uid, uid);
      return;
    }

    await saveMember(msg.from, "start_register");
    await setDmReady(uid);
    await sendRegisterDm(uid);
  } catch (err) {
    console.error("register error", err);
  }
});

/* ================= Channel member update ================= */
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
bot.onText(/\/joincap(?:\s+([\s\S]+))?/, async (msg, match) => {
  if (!ownerOnly(msg)) return;
  const text = String(match?.[1] || "").trim();
  if (!text) return bot.sendMessage(msg.chat.id, "Usage: /joincap <text>");
  await redis.set(KEY_STG_JOIN_CAP, text);
  bot.sendMessage(msg.chat.id, "Staged: join caption");
});

bot.onText(/\/joinbuttomlabel(?:\s+(.+))?/, async (msg, match) => {
  if (!ownerOnly(msg)) return;
  const text = String(match?.[1] || "").trim();
  if (!text) return bot.sendMessage(msg.chat.id, "Usage: /joinbuttomlabel <label>");
  await redis.set(KEY_STG_JOIN_BTN, text);
  bot.sendMessage(msg.chat.id, "Staged: join button label");
});

bot.onText(/\/regcaption(?:\s+([\s\S]+))?/, async (msg, match) => {
  if (!ownerOnly(msg)) return;
  const text = String(match?.[1] || "").trim();
  if (!text) return bot.sendMessage(msg.chat.id, "Usage: /regcaption <text>");
  await redis.set(KEY_STG_REG_CAP, text);
  bot.sendMessage(msg.chat.id, "Staged: register caption");
});

bot.onText(/\/regbuttomlabel(?:\s+(.+))?/, async (msg, match) => {
  if (!ownerOnly(msg)) return;
  const text = String(match?.[1] || "").trim();
  if (!text) return bot.sendMessage(msg.chat.id, "Usage: /regbuttomlabel <label>");
  await redis.set(KEY_STG_REG_BTN, text);
  bot.sendMessage(msg.chat.id, "Staged: register button label");
});

bot.onText(/\/regimage/, async (msg) => {
  if (!ownerOnly(msg)) return;
  const fileId = repliedPhotoFileId(msg);
  if (!fileId) return bot.sendMessage(msg.chat.id, "Reply to a photo with /regimage");
  await redis.set(KEY_STG_REG_MODE, "photo");
  await redis.set(KEY_STG_REG_FILE, fileId);
  bot.sendMessage(msg.chat.id, "Staged: register photo");
});

bot.onText(/\/regvideo/, async (msg) => {
  if (!ownerOnly(msg)) return;
  const fileId = repliedVideoFileId(msg);
  if (!fileId) return bot.sendMessage(msg.chat.id, "Reply to a video with /regvideo");
  await redis.set(KEY_STG_REG_MODE, "video");
  await redis.set(KEY_STG_REG_FILE, fileId);
  bot.sendMessage(msg.chat.id, "Staged: register video");
});

bot.onText(/\/upload$/, async (msg) => {
  if (!ownerOnly(msg)) return;
  await applyUpload();
  bot.sendMessage(msg.chat.id, "Upload apply complete ✅");
});

bot.onText(/\/postchannelcaption(?:\s+([\s\S]+))?/, async (msg, match) => {
  if (!ownerOnly(msg)) return;
  const text = String(match?.[1] || "").trim();
  if (!text) return bot.sendMessage(msg.chat.id, "Usage: /postchannelcaption <text>");
  await redis.set(KEY_STG_POST_CAP, text);
  bot.sendMessage(msg.chat.id, "Staged: channel post caption");
});

bot.onText(/\/postchannelbuttomlabel(?:\s+(.+))?/, async (msg, match) => {
  if (!ownerOnly(msg)) return;
  const text = String(match?.[1] || "").trim();
  if (!text) return bot.sendMessage(msg.chat.id, "Usage: /postchannelbuttomlabel <label>");
  await redis.set(KEY_STG_POST_BTN, text);
  bot.sendMessage(msg.chat.id, "Staged: channel post button label");
});

bot.onText(/\/postchannelimage/, async (msg) => {
  if (!ownerOnly(msg)) return;
  const fileId = repliedPhotoFileId(msg);
  if (!fileId) return bot.sendMessage(msg.chat.id, "Reply to a photo with /postchannelimage");
  await redis.set(KEY_STG_POST_MODE, "photo");
  await redis.set(KEY_STG_POST_FILE, fileId);
  bot.sendMessage(msg.chat.id, "Staged: channel post photo");
});

bot.onText(/\/postchannelvideo/, async (msg) => {
  if (!ownerOnly(msg)) return;
  const fileId = repliedVideoFileId(msg);
  if (!fileId) return bot.sendMessage(msg.chat.id, "Reply to a video with /postchannelvideo");
  await redis.set(KEY_STG_POST_MODE, "video");
  await redis.set(KEY_STG_POST_FILE, fileId);
  bot.sendMessage(msg.chat.id, "Staged: channel post video");
});

bot.onText(/\/uploadchannelpost$/, async (msg) => {
  if (!ownerOnly(msg)) return;
  try {
    await sendChannelPostFromStage();
    bot.sendMessage(msg.chat.id, "Channel post uploaded ✅");
  } catch (e) {
    bot.sendMessage(msg.chat.id, `Channel post error: ${e?.message || e}`);
  }
});

bot.onText(/\/allrestart$/, async (msg) => {
  if (!ownerOnly(msg)) return;
  const r = await resetEventData();
  bot.sendMessage(msg.chat.id, `All restart complete ✅\nMembers: ${r.members_total}`);
});

bot.onText(/\/setpin(?:\s+([\s\S]+))?/, async (msg, match) => {
  if (!ownerOnly(msg)) return;
  const text = String(match?.[1] || "").trim();
  if (!text) return bot.sendMessage(msg.chat.id, "Usage: /setpin <text>");
  await redis.set(KEY_PIN_MODE, "text");
  await redis.set(KEY_PIN_TEXT, text);
  await redis.del(KEY_PIN_FILE).catch(() => {});
  bot.sendMessage(msg.chat.id, "Pin text set");
});

bot.onText(/\/settext(?:\s+([\s\S]+))?/, async (msg, match) => {
  if (!ownerOnly(msg)) return;
  const text = String(match?.[1] || "").trim();
  if (!text) return bot.sendMessage(msg.chat.id, "Usage: /settext <text>");
  await redis.set(KEY_PIN_TEXT, text);
  if (!(await readMaybe(KEY_PIN_MODE))) await redis.set(KEY_PIN_MODE, "text");
  bot.sendMessage(msg.chat.id, "Pin caption/text updated");
});

bot.onText(/\/setphoto/, async (msg) => {
  if (!ownerOnly(msg)) return;
  const fileId = repliedPhotoFileId(msg);
  if (!fileId) return bot.sendMessage(msg.chat.id, "Reply to a photo with /setphoto");
  await redis.set(KEY_PIN_MODE, "photo");
  await redis.set(KEY_PIN_FILE, fileId);
  bot.sendMessage(msg.chat.id, "Pin photo set");
});

bot.onText(/\/setvideo/, async (msg) => {
  if (!ownerOnly(msg)) return;
  const fileId = repliedVideoFileId(msg);
  if (!fileId) return bot.sendMessage(msg.chat.id, "Reply to a video with /setvideo");
  await redis.set(KEY_PIN_MODE, "video");
  await redis.set(KEY_PIN_FILE, fileId);
  bot.sendMessage(msg.chat.id, "Pin video set");
});

bot.onText(/\/status$/, async (msg) => {
  if (!ownerOnly(msg)) return;
  const t = await buildStatusText();
  bot.sendMessage(msg.chat.id, t);
});

bot.onText(/\/update$/, async (msg) => {
  if (!ownerOnly(msg)) return;
  try {
    const sent = await pushPinToGroup();
    bot.sendMessage(msg.chat.id, `Pin updated ✅\nMessage ID: ${sent.message_id}`);
  } catch (e) {
    bot.sendMessage(msg.chat.id, `Update error: ${e?.message || e}`);
  }
});

bot.onText(/\/syncmembers$/, async (msg) => {
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
    } catch (_) {}
  }

  bot.sendMessage(msg.chat.id, `Members synced (channel): ${fixed}`);
});

bot.onText(/\/remove (.+)/, async (msg, match) => {
  if (!ownerOnly(msg)) return;

  const key = String(match?.[1] || "").trim();
  let uid = null;

  if (/^\d+$/.test(key)) uid = key;

  if (!uid) {
    const byUser = await redis.get(KEY_USER_INDEX(normalizeUsername(key)));
    if (byUser) uid = byUser;
  }

  if (!uid) {
    const byName = await redis.get(KEY_NAME_INDEX(normalizeName(key)));
    if (byName) uid = byName;
  }

  if (!uid) return bot.sendMessage(msg.chat.id, "Member not found");

  await removeMemberHard(uid);
  bot.sendMessage(msg.chat.id, `Member removed: ${uid}`);
});

/* ================= Callback ================= */
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

    await saveMember(q.from, "channel_check");
    await setDmReady(uid);

    await bot.answerCallbackQuery(q.id, { text: "Register OK" });
    await sendRegisterDm(uid);
  } catch (err) {
    console.error("channel check error", err);
  }
});

/* ================= Server start ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lucky77 Wheel Bot running on ${PORT}`);
});
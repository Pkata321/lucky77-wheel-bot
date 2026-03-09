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

if (!CHANNEL_CHAT && !CHANNEL_LINK) {
  console.warn("⚠️ CHANNEL_CHAT/LINK not set (channel gate disabled).");
}

/* ================= Redis ================= */
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

/* ================= Keys ================= */
const KEY_PREFIX = "lucky77:pro:v3:channel";

const KEY_MEMBERS_SET = `${KEY_PREFIX}:members:set`;
const KEY_MEMBER_HASH = (id) => `${KEY_PREFIX}:member:${id}`;

const KEY_POOL_SET = `${KEY_PREFIX}:pool:set`;
const KEY_WINNERS_SET = `${KEY_PREFIX}:winners:set`;
const KEY_HISTORY_LIST = `${KEY_PREFIX}:history:list`;
const KEY_PRIZE_BAG = `${KEY_PREFIX}:prizes:bag`;
const KEY_PRIZE_SOURCE = `${KEY_PREFIX}:prizes:source`;
const KEY_TURN_SEQ = `${KEY_PREFIX}:turn:seq`;
const KEY_WINNER_META = (uid) => `${KEY_PREFIX}:winner:${uid}`;
const KEY_NOTICE_CTX = (uid) => `${KEY_PREFIX}:notice:ctx:${uid}`;

const KEY_USER_INDEX = (u) => `${KEY_PREFIX}:index:username:${u}`;
const KEY_NAME_INDEX = (n) => `${KEY_PREFIX}:index:name:${n}`;

const KEY_JOIN_CAP = `${KEY_PREFIX}:join:cap`;
const KEY_JOIN_BTN = `${KEY_PREFIX}:join:btn`;

const KEY_REG_CAP = `${KEY_PREFIX}:reg:cap`;
const KEY_REG_BTN = `${KEY_PREFIX}:reg:btn`;
const KEY_REG_MODE = `${KEY_PREFIX}:reg:mode`;
const KEY_REG_FILE = `${KEY_PREFIX}:reg:file`;

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

const KEY_SCAN_STATUS = `${KEY_PREFIX}:scan:status`;
const KEY_SCAN_LAST_AT = `${KEY_PREFIX}:scan:last_at`;
const KEY_SCAN_LAST_SUMMARY = `${KEY_PREFIX}:scan:last_summary`;
const KEY_SPIN_LOCK = `${KEY_PREFIX}:spin:lock`;

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
  const id = String(userId || "");
  return id === String(OWNER_ID) || excludeIds.includes(id);
}

function nameParts(u) {
  const name = `${u?.first_name || ""} ${u?.last_name || ""}`.trim();
  const username = u?.username ? String(u.username) : "";
  return { name, username };
}

function normalizeName(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeUsername(s) {
  return String(s || "").trim().replace(/^@+/, "").toLowerCase();
}

function nowISO() {
  return new Date().toISOString();
}

async function readMaybe(key) {
  const v = await redis.get(key);
  return typeof v === "undefined" ? null : v;
}

async function moveKey(src, dst) {
  const v = await readMaybe(src);
  if (v === null || v === "") return false;
  await redis.set(dst, v);
  return true;
}

async function delKeys(keys) {
  for (const k of keys) {
    try {
      await redis.del(k);
    } catch (_) {}
  }
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

function deriveDisplay(name, username, id) {
  const cleanName = String(name || "").trim();
  const cleanUsername = String(username || "").trim().replace(/^@+/, "");
  return cleanName || (cleanUsername ? `@${cleanUsername}` : String(id));
}

async function saveMember(u, source = "register") {
  const userId = String(u?.id || "");
  if (!userId) return { ok: false, reason: "missing_id" };
  if (isExcludedUser(userId)) return { ok: false, reason: "excluded" };

  const { name, username } = nameParts(u);
  const cleanName = String(name || "").trim();
  const cleanUsername = String(username || "").trim().replace(/^@+/, "");

  const prev = await redis.hgetall(KEY_MEMBER_HASH(userId)).catch(() => ({}));
  const nextName = cleanName || String(prev?.name || "").trim();
  const nextUsername = cleanUsername || String(prev?.username || "").trim().replace(/^@+/, "");
  const display = deriveDisplay(nextName, nextUsername, userId);

  const prevDmReady = String(prev?.dm_ready || "0");
  const prevRegAt = String(prev?.registered_at || "");

  await redis.sadd(KEY_MEMBERS_SET, userId);
  await redis.hset(KEY_MEMBER_HASH(userId), {
    id: userId,
    name: nextName,
    username: nextUsername,
    display,
    active: "1",
    removed: "0",
    left_at: "",
    left_reason: "",
    dm_ready: prevDmReady === "1" ? "1" : "0",
    dm_ready_at: String(prev?.dm_ready_at || ""),
    source: String(source || "register"),
    registered_at: prevRegAt || nowISO(),
    last_seen_at: nowISO(),
    last_scan_at: String(prev?.last_scan_at || ""),
  });

  const isWinner = await redis.sismember(KEY_WINNERS_SET, userId);
  if (!isWinner) await redis.sadd(KEY_POOL_SET, userId);
  else await redis.srem(KEY_POOL_SET, userId);

  await indexMemberIdentity({ id: userId, name: nextName, username: nextUsername });
  return { ok: true, id: userId };
}

async function setDmReady(userId) {
  await redis.hset(KEY_MEMBER_HASH(String(userId)), {
    dm_ready: "1",
    dm_ready_at: nowISO(),
  });
}

async function markInactive(userId, reason = "left_channel") {
  const uid = String(userId || "");
  if (!uid) return { ok: false, reason: "missing_id" };
  if (isExcludedUser(uid)) return { ok: false, reason: "excluded" };

  await redis.sadd(KEY_MEMBERS_SET, uid);
  await redis.hset(KEY_MEMBER_HASH(uid), {
    active: "0",
    left_at: nowISO(),
    left_reason: String(reason || "left_channel"),
  });
  await redis.srem(KEY_POOL_SET, uid);
  return { ok: true };
}

async function markRemoved(userId, reason = "owner_remove") {
  const uid = String(userId || "");
  if (!uid) return { ok: false, reason: "missing_id" };

  await redis.hset(KEY_MEMBER_HASH(uid), {
    removed: "1",
    active: "0",
    left_reason: String(reason),
    left_at: nowISO(),
  });
  await redis.srem(KEY_POOL_SET, uid);
  return { ok: true };
}

async function getJoinGateLive() {
  const cap =
    (await readMaybe(KEY_JOIN_CAP)) ||
    "❌ Channel ကို Join ပြီးမှ Register/Enable DM လုပ်နိုင်ပါသည်。\n\n👉 အောက်က Button နဲ့ Join လုပ်ပြီး ပြန်စစ်ပါ။";
  const btn = (await readMaybe(KEY_JOIN_BTN)) || "📢 Join Channel";
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

async function getRegisterLive() {
  return {
    cap:
      (await readMaybe(KEY_REG_CAP)) ||
      "✅ Registered ပြီးပါပြီ。\n\n📩 Prize ပေါက်ရင် ဒီ DM ကနေ ဆက်သွယ်ပေးပါမယ်။",
    btn: (await readMaybe(KEY_REG_BTN)) || "",
    mode: (await readMaybe(KEY_REG_MODE)) || "text",
    file: (await readMaybe(KEY_REG_FILE)) || "",
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
      supports_streaming: true,
    });
  }

  return bot.sendMessage(chatId, String(live.cap || ""), {
    reply_markup: kb,
  });
}

async function proceedRegisterAndReply(chatId, user) {
  await saveMember(user, "private_start");
  await setDmReady(user.id);
  await sendRegisterDm(chatId);
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
      supports_streaming: true,
    });
  }

  return bot.sendMessage(chatId, String(post.cap || ""), {
    reply_markup: kb,
  });
}

function repliedPhotoFileId(msg) {
  const p = msg?.reply_to_message?.photo;
  if (!p || !Array.isArray(p) || !p.length) return "";
  return String(p[p.length - 1].file_id || "");
}

function repliedVideoFileId(msg) {
  return String(msg?.reply_to_message?.video?.file_id || "");
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

  const members = Number((await redis.scard(KEY_MEMBERS_SET)) || 0);
  const pool = Number((await redis.scard(KEY_POOL_SET)) || 0);
  const winners = Number((await redis.scard(KEY_WINNERS_SET)) || 0);
  const prizes = Number((await redis.llen(KEY_PRIZE_BAG)) || 0);
  const scanStatus = String((await readMaybe(KEY_SCAN_STATUS)) || "idle");
  const lastScanAt = String((await readMaybe(KEY_SCAN_LAST_AT)) || "");

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

EVENT
members: ${members}
pool: ${pool}
winners: ${winners}
remaining prizes: ${prizes}
scan: ${scanStatus}
last scan: ${lastScanAt || "-"}`);
}

async function resolveMemberIdForAny({ id, username, name }) {
  if (id) return String(id);

  const u = normalizeUsername(username);
  if (u) {
    const mapped = await redis.get(KEY_USER_INDEX(u));
    if (mapped) return String(mapped);
  }

  const n = normalizeName(name);
  if (n) {
    const mapped = await redis.get(KEY_NAME_INDEX(n));
    if (mapped) return String(mapped);
  }

  const ids = (await redis.smembers(KEY_MEMBERS_SET)) || [];
  for (const mid of ids) {
    const h = await redis.hgetall(KEY_MEMBER_HASH(mid)).catch(() => null);
    if (!h) continue;
    if (u && normalizeUsername(h.username || "") === u) return String(h.id || mid);
    if (n && (normalizeName(h.name || "") === n || normalizeName(h.display || "") === n)) {
      return String(h.id || mid);
    }
  }

  return "";
}

function parseRemovePayload(text) {
  const raw = String(text || "").replace(/^\/remove(@\w+)?\s*/i, "").trim();
  if (!raw) return null;

  const parts = raw.split(/\s+/).filter(Boolean);
  let username = "";
  let id = "";
  const nameTokens = [];

  for (const p of parts) {
    const low = p.toLowerCase();
    if (p.startsWith("@") && p.length > 1) {
      username = p.replace("@", "").trim();
      continue;
    }
    const m = low.match(/^id[:=](\d+)$/);
    if (m) {
      id = m[1];
      continue;
    }
    if (!id && /^\d+$/.test(p)) {
      id = p;
      continue;
    }
    nameTokens.push(p);
  }

  const name = nameTokens.join(" ").trim();
  if (!name && !username && !id) return null;
  return { name, username, id };
}

async function rebuildPoolFromCurrentMembers() {
  await redis.del(KEY_POOL_SET);
  const ids = (await redis.smembers(KEY_MEMBERS_SET)) || [];
  let count = 0;

  for (const id of ids.map(String)) {
    if (!id || isExcludedUser(id)) continue;
    const h = await redis.hgetall(KEY_MEMBER_HASH(id)).catch(() => null);
    if (!h || String(h.removed || "0") === "1") continue;
    if (String(h.active ?? "1") !== "1") continue;
    const isWinner = await redis.sismember(KEY_WINNERS_SET, id);
    if (isWinner) continue;
    await redis.sadd(KEY_POOL_SET, id);
    count += 1;
  }

  return count;
}

async function runScanMembers() {
  await redis.set(KEY_SCAN_STATUS, "scanning");

  const ids = (await redis.smembers(KEY_MEMBERS_SET)) || [];
  let activeCount = 0;
  let leftCount = 0;
  let skippedRemoved = 0;

  for (const id of ids.map(String)) {
    if (!id || isExcludedUser(id)) continue;

    const h = await redis.hgetall(KEY_MEMBER_HASH(id)).catch(() => null);
    if (!h) continue;
    if (String(h.removed || "0") === "1") {
      skippedRemoved += 1;
      continue;
    }

    const ok = await isChannelMember(id);
    if (ok) {
      await redis.hset(KEY_MEMBER_HASH(id), {
        active: "1",
        left_at: "",
        left_reason: "",
        last_scan_at: nowISO(),
      });
      activeCount += 1;
    } else {
      await redis.hset(KEY_MEMBER_HASH(id), {
        active: "0",
        left_at: nowISO(),
        left_reason: "left_channel",
        last_scan_at: nowISO(),
      });
      await redis.srem(KEY_POOL_SET, id);
      leftCount += 1;
    }
  }

  const poolCount = await rebuildPoolFromCurrentMembers();
  const summary = {
    scanned_at: nowISO(),
    active: activeCount,
    left: leftCount,
    skipped_removed: skippedRemoved,
    pool: poolCount,
  };

  await redis.set(KEY_SCAN_LAST_AT, summary.scanned_at);
  await redis.set(KEY_SCAN_LAST_SUMMARY, JSON.stringify(summary));
  await redis.set(KEY_SCAN_STATUS, "completed");

  return summary;
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

app.get("/", (req, res) => res.send("Lucky77 Wheel Bot ✅"));

app.get("/health", async (req, res) => {
  try {
    res.json({
      ok: true,
      members: Number((await redis.scard(KEY_MEMBERS_SET)) || 0),
      winners: Number((await redis.scard(KEY_WINNERS_SET)) || 0),
      pool: Number((await redis.scard(KEY_POOL_SET)) || 0),
      remaining_prizes: Number((await redis.llen(KEY_PRIZE_BAG)) || 0),
      scan_status: String((await readMaybe(KEY_SCAN_STATUS)) || "idle"),
      last_scan_at: String((await readMaybe(KEY_SCAN_LAST_AT)) || ""),
      channel_gate: { enabled: !!CHANNEL_CHAT, chat: CHANNEL_CHAT || null, link: getChannelLink() || null },
      time: nowISO(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/config", requireApiKey, async (req, res) => {
  try {
    const prizeSource = await redis.get(KEY_PRIZE_SOURCE);
    res.json({
      ok: true,
      prize_source: String(prizeSource || ""),
      scan_status: String((await readMaybe(KEY_SCAN_STATUS)) || "idle"),
      last_scan_at: String((await readMaybe(KEY_SCAN_LAST_AT)) || ""),
      time: nowISO(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
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
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/members", requireApiKey, async (req, res) => {
  try {
    const includeRemoved = String(req.query.include_removed || "0") === "1";
    const ids = (await redis.smembers(KEY_MEMBERS_SET)) || [];
    const cleanIds = ids.map(String).filter((id) => id && !isExcludedUser(id));
    const hashes = await Promise.all(cleanIds.map((id) => redis.hgetall(KEY_MEMBER_HASH(id)).catch(() => null)));
    const winnersArr = (await redis.smembers(KEY_WINNERS_SET)) || [];
    const winnersSet = new Set(winnersArr.map(String));

    const members = [];
    for (let i = 0; i < cleanIds.length; i++) {
      const id = String(cleanIds[i]);
      const h = hashes[i];
      if (!h) continue;

      const removed = String(h.removed || "0") === "1";
      if (removed && !includeRemoved) continue;

      const name = String(h.name || "").trim();
      const username = String(h.username || "").trim().replace(/^@+/, "");
      const display = String(h.display || "").trim() || deriveDisplay(name, username, id);
      const active = String(h.active ?? "1") === "1";
      const status = removed ? "removed" : active ? "active" : "left";

      members.push({
        id,
        name,
        username,
        display,
        active,
        status,
        removed,
        left_at: String(h.left_at || ""),
        left_reason: String(h.left_reason || ""),
        dm_ready: String(h.dm_ready || "0") === "1",
        registered_at: String(h.registered_at || ""),
        last_seen_at: String(h.last_seen_at || ""),
        last_scan_at: String(h.last_scan_at || ""),
        isWinner: winnersSet.has(id),
      });
    }

    members.sort((a, b) => (a.registered_at || "").localeCompare(b.registered_at || ""));
    res.json({
      ok: true,
      total: members.length,
      last_scan_at: String((await readMaybe(KEY_SCAN_LAST_AT)) || ""),
      members,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/pool", requireApiKey, async (req, res) => {
  try {
    const ids = (await redis.smembers(KEY_POOL_SET)) || [];
    res.json({ ok: true, count: ids.length, ids });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
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
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/winners", requireApiKey, async (req, res) => {
  try {
    const list = await redis.lrange(KEY_HISTORY_LIST, 0, 200);
    const items = (list || [])
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    items.sort((a, b) => Number(a?.turn || 0) - Number(b?.turn || 0));

    const out = [];
    for (const it of items) {
      const uid = String(it?.winner?.id || "");
      const meta = uid ? await redis.hgetall(KEY_WINNER_META(uid)).catch(() => ({})) : {};
      out.push({
        turn: Number(it?.turn || meta?.turn || 0),
        at: String(it?.at || meta?.at || ""),
        prize: String(it?.prize || meta?.prize || ""),
        user_id: uid,
        name: String(it?.winner?.name || meta?.name || ""),
        username: String(it?.winner?.username || meta?.username || ""),
        display: String(it?.winner?.display || meta?.display || uid),
        done: String(meta?.done || "0") === "1",
        done_at: String(meta?.done_at || ""),
        notice_sent: String(meta?.notice_sent || "0") === "1",
        notice_at: String(meta?.notice_at || ""),
      });
    }

    res.json({ ok: true, total: out.length, winners: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/winner/done", requireApiKey, async (req, res) => {
  try {
    const uid = String(req.body?.user_id || "").trim();
    if (!uid) return res.status(400).json({ ok: false, error: "user_id required" });

    const metaKey = KEY_WINNER_META(uid);
    const meta = await redis.hgetall(metaKey).catch(() => ({}));
    if (!meta || !meta.turn) return res.status(404).json({ ok: false, error: "winner_not_found" });

    const toggle = !!req.body?.toggle;
    const doneIn = req.body?.done;
    let nextDone = String(meta?.done || "0") === "1";
    if (toggle) nextDone = !nextDone;
    else if (typeof doneIn === "boolean") nextDone = doneIn;
    else nextDone = true;

    await redis.hset(metaKey, { done: nextDone ? "1" : "0", done_at: nowISO() });
    res.json({ ok: true, user_id: uid, done: nextDone });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/scan/status", requireApiKey, async (req, res) => {
  try {
    let summary = null;
    const raw = await readMaybe(KEY_SCAN_LAST_SUMMARY);
    if (raw) {
      try {
        summary = JSON.parse(raw);
      } catch {
        summary = null;
      }
    }
    res.json({
      ok: true,
      status: String((await readMaybe(KEY_SCAN_STATUS)) || "idle"),
      last_scan_at: String((await readMaybe(KEY_SCAN_LAST_AT)) || ""),
      summary,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/scan/members", requireApiKey, async (req, res) => {
  try {
    const summary = await runScanMembers();
    res.json({ ok: true, status: "completed", summary });
  } catch (e) {
    await redis.set(KEY_SCAN_STATUS, "error").catch(() => {});
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/spin", requireApiKey, async (req, res) => {
  try {
    const locked = await redis.get(KEY_SPIN_LOCK).catch(() => null);
    if (locked) {
      return res.status(409).json({ ok: false, error: "spin_in_progress" });
    }
    await redis.set(KEY_SPIN_LOCK, nowISO(), { ex: 15 });

    const winnerId = await redis.srandmember(KEY_POOL_SET);
    if (!winnerId) {
      await redis.del(KEY_SPIN_LOCK).catch(() => {});
      return res.status(400).json({ ok: false, error: "No members left in pool. Restart Spin." });
    }

    const bagLen = await redis.llen(KEY_PRIZE_BAG);
    if (!bagLen || bagLen <= 0) {
      await redis.del(KEY_SPIN_LOCK).catch(() => {});
      return res.status(400).json({ ok: false, error: "No prizes left. Save prizes again." });
    }

    const idx = Math.floor(Math.random() * Number(bagLen));
    let prize = await redis.lindex(KEY_PRIZE_BAG, idx).catch(() => null);
    if (!prize) prize = await redis.lindex(KEY_PRIZE_BAG, 0).catch(() => "—");
    prize = String(prize);

    const h = await redis.hgetall(KEY_MEMBER_HASH(String(winnerId))).catch(() => ({}));
    const removed = String(h?.removed || "0") === "1";
    const active = String(h?.active ?? "1") === "1";
    if (removed || !active) {
      await redis.srem(KEY_POOL_SET, String(winnerId));
      await redis.del(KEY_SPIN_LOCK).catch(() => {});
      return res.status(409).json({ ok: false, error: "invalid_pool_member_try_again" });
    }

    const name = String(h?.name || "").trim();
    const username = String(h?.username || "").trim().replace(/^@+/, "");
    const display = String(h?.display || "").trim() || deriveDisplay(name, username, winnerId);

    const winnerObj = {
      id: String(winnerId),
      name,
      username,
      display,
      dm_ready: String(h?.dm_ready || "0") === "1",
    };

    await redis.lrem(KEY_PRIZE_BAG, 1, prize);
    await redis.srem(KEY_POOL_SET, String(winnerId));
    await redis.sadd(KEY_WINNERS_SET, String(winnerId));

    const turn = Number(await redis.incr(KEY_TURN_SEQ)) || 0;
    const item = {
      turn,
      at: nowISO(),
      prize,
      winner: winnerObj,
    };

    await redis.lpush(KEY_HISTORY_LIST, JSON.stringify(item));
    await redis.ltrim(KEY_HISTORY_LIST, 0, 200);
    await redis.hset(KEY_WINNER_META(String(winnerId)), {
      user_id: String(winnerId),
      turn: String(turn),
      prize: String(prize),
      name,
      username,
      display,
      done: "0",
      done_at: "",
      at: String(item.at),
      notice_sent: String(h?.notice_sent || "0"),
      notice_at: String(h?.notice_at || ""),
    });

    await redis.del(KEY_SPIN_LOCK).catch(() => {});
    res.json({ ok: true, prize, winner: winnerObj, turn });
  } catch (e) {
    await redis.del(KEY_SPIN_LOCK).catch(() => {});
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/notice", requireApiKey, async (req, res) => {
  try {
    const { user_id, prize, text } = req.body || {};
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id required" });

    const uid = String(user_id);
    const pz = prize ? String(prize) : "";

    const msgText =
      text && String(text).trim()
        ? String(text)
        : "Congratulation 🥳🥳🥳ပါအကိုရှင့်\n" +
          `လက်ကီး77 ရဲ့ လစဉ်ဗလာမပါလက်ကီးဝှီး အစီစဉ်မှာ ယူနစ် ${pz || "—"} ကံထူးသွားပါတယ်ရှင့်☘️\n` +
          "ဂိမ်းယူနစ်လေး ထည့်ပေးဖို့ အကို့ဂိမ်းအကောင့်လေး ပို့ပေးပါရှင့်";

    await redis.set(KEY_NOTICE_CTX(uid), JSON.stringify({ user_id: uid, prize: pz, at: nowISO() }), {
      ex: 60 * 60 * 24 * 7,
    });

    const dm = await bot
      .sendMessage(Number(uid), msgText)
      .then(() => ({ ok: true }))
      .catch((err) => ({ ok: false, error: err?.message || String(err) }));

    if (dm.ok) {
      await setDmReady(uid);
      await redis.hset(KEY_WINNER_META(uid), {
        notice_sent: "1",
        notice_at: nowISO(),
      }).catch(() => {});
    }

    res.json({ ok: true, dm_ok: dm.ok, dm_error: dm.ok ? "" : String(dm.error || "") });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

async function resetEventData({ reloadPrizes = true } = {}) {
  await redis.del(KEY_WINNERS_SET);
  await redis.del(KEY_HISTORY_LIST);
  await redis.del(KEY_TURN_SEQ);
  await redis.del(KEY_POOL_SET);
  await redis.del(KEY_SPIN_LOCK).catch(() => {});

  const ids = (await redis.smembers(KEY_MEMBERS_SET)) || [];
  const cleanIds = ids.map(String).filter((id) => id && !isExcludedUser(id));

  for (const id of cleanIds) {
    await redis.del(KEY_WINNER_META(id)).catch(() => {});
  }

  for (const id of cleanIds) {
    const h = await redis.hgetall(KEY_MEMBER_HASH(id)).catch(() => null);
    if (!h) continue;
    if (String(h.removed || "0") === "1") continue;
    if (String(h.active ?? "1") !== "1") continue;
    await redis.sadd(KEY_POOL_SET, id);
  }

  if (reloadPrizes) {
    const raw = await redis.get(KEY_PRIZE_SOURCE);
    if (raw && String(raw).trim()) {
      const bag = parsePrizeTextExpand(raw);
      await redis.del(KEY_PRIZE_BAG);
      for (const p of bag) await redis.rpush(KEY_PRIZE_BAG, String(p));
    } else {
      await redis.del(KEY_PRIZE_BAG);
    }
  }

  return {
    pool: Number((await redis.scard(KEY_POOL_SET)) || 0),
    remaining_prizes: Number((await redis.llen(KEY_PRIZE_BAG)) || 0),
  };
}

app.post("/event/reset", requireApiKey, async (req, res) => {
  try {
    const result = await resetEventData({ reloadPrizes: req.body?.reload_prizes !== false });
    res.json({ ok: true, ...result, time: nowISO() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/restart-spin", requireApiKey, async (req, res) => {
  try {
    const result = await resetEventData({ reloadPrizes: true });
    res.json({ ok: true, ...result, time: nowISO() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ================= Telegram Webhook ================= */
const WEBHOOK_PATH = `/telegram/${encodeURIComponent(WEBHOOK_SECRET)}`;
app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

async function setupWebhook() {
  await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
  await bot.setWebHook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
}

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

bot.onText(/\/status$/, async (msg) => {
  if (!ownerOnly(msg)) return;
  const t = await buildStatusText();
  bot.sendMessage(msg.chat.id, t);
});

bot.onText(/\/allrestart$/, async (msg) => {
  if (!ownerOnly(msg)) return;
  const r = await resetEventData({ reloadPrizes: true });
  bot.sendMessage(msg.chat.id, `All restart complete ✅\nPool: ${r.pool}\nPrizes: ${r.remaining_prizes}`);
});

bot.onText(/\/syncmembers$/, async (msg) => {
  if (!ownerOnly(msg)) return;
  if (!CHANNEL_CHAT) return bot.sendMessage(msg.chat.id, "CHANNEL_CHAT မရှိသေးပါ");

  try {
    const summary = await runScanMembers();
    bot.sendMessage(
      msg.chat.id,
      `Completed scan ✅\nActive: ${summary.active}\nLeft: ${summary.left}\nPool: ${summary.pool}`
    );
  } catch (e) {
    bot.sendMessage(msg.chat.id, `Scan error: ${e?.message || e}`);
  }
});

bot.onText(/\/remove(?:\s+([\s\S]+))?/, async (msg) => {
  if (!ownerOnly(msg)) return;

  const payload = parseRemovePayload(msg.text || "");
  if (!payload) return bot.sendMessage(msg.chat.id, "Usage: /remove <name|username|id>");

  const uid = await resolveMemberIdForAny(payload);
  if (!uid) return bot.sendMessage(msg.chat.id, "Member not found");

  await markRemoved(uid, "owner_remove");
  bot.sendMessage(msg.chat.id, `Member removed: ${uid}`);
});

/* ================= CALLBACKS ================= */
bot.on("callback_query", async (q) => {
  try {
    const data = String(q?.data || "");
    const fromId = String(q?.from?.id || "");
    const chatId = q?.message?.chat?.id;

    if (!chatId) {
      try {
        await bot.answerCallbackQuery(q.id);
      } catch (_) {}
      return;
    }

    if (data.startsWith("chkch:")) {
      const expectedUserId = data.split(":")[1] || "";
      if (fromId !== String(expectedUserId)) {
        await bot.answerCallbackQuery(q.id, { text: "ဒီခလုတ်က သင့်အတွက်မဟုတ်ပါ။", show_alert: true });
        return;
      }

      await bot.answerCallbackQuery(q.id);
      const ok = await isChannelMember(fromId);
      if (!ok) {
        await sendJoinGate(chatId, fromId);
        return;
      }

      await proceedRegisterAndReply(chatId, q.from);
      return;
    }

    await bot.answerCallbackQuery(q.id).catch(() => {});
  } catch (e) {
    console.error("callback error:", e);
  }
});

/* ================= Message Handler ================= */
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat || !msg.from) return;
    if (String(msg.chat.type) !== "private") return;
    if (isOwner(msg.from.id)) return;

    const uid = String(msg.from.id);
    const ctxRaw = await redis.get(KEY_NOTICE_CTX(uid));
    if (!ctxRaw) return;

    let ctx = {};
    try {
      ctx = JSON.parse(ctxRaw);
    } catch (_) {}

    const { name, username } = nameParts(msg.from);
    const header =
      "📨 Winner Reply (Auto Forward)\n" +
      `• Name: ${name || "-"}\n` +
      `• Username: ${username ? "@" + username.replace(/^@+/, "") : "-"}\n` +
      `• ID: ${uid}\n` +
      `• Prize: ${ctx?.prize || "-"}`;

    await bot.sendMessage(Number(OWNER_ID), header).catch(() => {});
    await bot.forwardMessage(Number(OWNER_ID), msg.chat.id, msg.message_id).catch(() => {});
  } catch (e) {
    console.error("message handler error:", e);
  }
});

/* ================= /start register ================= */
bot.onText(/^\/start(?:\s+(.+))?/i, async (msg) => {
  try {
    if (!msg || msg.chat.type !== "private") return;
    const u = msg.from;
    if (!u) return;

    if (CHANNEL_CHAT) {
      const ok = await isChannelMember(u.id);
      if (!ok) {
        await sendJoinGate(msg.chat.id, u.id);
        return;
      }
    }

    await proceedRegisterAndReply(msg.chat.id, u);
  } catch (e) {
    console.error("/start error:", e);
  }
});

/* ================= Boot ================= */
async function boot() {
  const me = await bot.getMe();
  BOT_USERNAME = me.username ? String(me.username) : null;

  if (!(await redis.get(KEY_JOIN_CAP))) {
    await redis.set(
      KEY_JOIN_CAP,
      "❌ Channel ကို Join ပြီးမှ Register/Enable DM လုပ်နိုင်ပါသည်。\n\n👉 အောက်က Button နဲ့ Join လုပ်ပြီး ပြန်စစ်ပါ။"
    );
  }
  if (!(await redis.get(KEY_JOIN_BTN))) await redis.set(KEY_JOIN_BTN, "📢 Join Channel");

  if (!(await redis.get(KEY_REG_MODE))) await redis.set(KEY_REG_MODE, "text");
  if (!(await redis.get(KEY_REG_CAP))) {
    await redis.set(
      KEY_REG_CAP,
      "✅ Registered ပြီးပါပြီ。\n\n📩 Prize ပေါက်ရင် ဒီ DM ကနေ ဆက်သွယ်ပေးပါမယ်။"
    );
  }
  if (!(await redis.get(KEY_REG_BTN))) await redis.set(KEY_REG_BTN, "");
  if (!(await redis.get(KEY_SCAN_STATUS))) await redis.set(KEY_SCAN_STATUS, "idle");

  await setupWebhook();
  console.log("Webhook set ✅", `${PUBLIC_URL}${WEBHOOK_PATH}`);
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
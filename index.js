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
function randPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ================= Member storage ================= */
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
  const display = String(name || "").trim() || (cleanUsername ? `@${cleanUsername}` : userId);

  const prev = await redis.hgetall(KEY_MEMBER_HASH(userId)).catch(() => ({}));
  const prevDmReady = String(prev?.dm_ready || "0");
  const prevRegAt = String(prev?.registered_at || "");

  await redis.sadd(KEY_MEMBERS_SET, userId);

  const isWinner = await redis.sismember(KEY_WINNERS_SET, userId);
  if (!isWinner) await redis.sadd(KEY_POOL_SET, userId);
  else await redis.srem(KEY_POOL_SET, userId);

  await redis.hset(KEY_MEMBER_HASH(userId), {
    id: userId,
    name: String(name || "").trim(),
    username: cleanUsername,
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

  await indexMemberIdentity({ id: userId, name, username: cleanUsername });
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

app.get("/", (req, res) => res.send("Lucky77 Wheel Bot ✅"));

app.get("/health", async (req, res) => {
  try {
    const members = await redis.scard(KEY_MEMBERS_SET);
    const winners = await redis.scard(KEY_WINNERS_SET);
    const pool = await redis.scard(KEY_POOL_SET);
    const bagLen = await redis.llen(KEY_PRIZE_BAG);
    const lastGroup = await redis.get(KEY_LAST_GROUP);

    res.json({
      ok: true,
      group_id_env: GROUP_ID || null,
      last_group_seen: lastGroup || null,
      members: Number(members) || 0,
      winners: Number(winners) || 0,
      pool: Number(pool) || 0,
      remaining_prizes: Number(bagLen) || 0,
      channel_gate: { enabled: !!CHANNEL_CHAT, chat: CHANNEL_CHAT || null, link: getChannelLink() || null },
      time: nowISO(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/members", requireApiKey, async (req, res) => {
  try {
    const ids = (await redis.smembers(KEY_MEMBERS_SET)) || [];
    const cleanIds = ids.map(String).filter((id) => id && !isExcludedUser(id));

    const winnersArr = (await redis.smembers(KEY_WINNERS_SET)) || [];
    const winnersSet = new Set(winnersArr.map(String));

    const hashes = await Promise.all(cleanIds.map((id) => redis.hgetall(KEY_MEMBER_HASH(id)).catch(() => null)));

    const members = [];
    for (let i = 0; i < cleanIds.length; i++) {
      const id = String(cleanIds[i]);
      const h = hashes[i];

      const name = String(h?.name || "").trim();
      const username = String(h?.username || "").trim().replace("@", "");
      const display = String(h?.display || "").trim() || (name || (username ? `@${username}` : id));
      const active = String(h?.active ?? "1") === "1";

      members.push({
        id,
        name,
        username,
        display,
        active,
        left_at: String(h?.left_at || ""),
        dm_ready: String(h?.dm_ready || "0") === "1",
        isWinner: winnersSet.has(id),
        registered_at: String(h?.registered_at || ""),
        last_seen_at: String(h?.last_seen_at || ""),
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
    const count = await redis.scard(KEY_POOL_SET);
    res.json({ ok: true, count: Number(count) || 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/config/prizes", requireApiKey, async (req, res) => {
  try {
    const { prizeText } = req.body || {};
    const bag = parsePrizeTextExpand(prizeText);

    if (!bag.length) return res.status(400).json({ ok: false, error: "No valid prizes. Example: 10000Ks 4time" });

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
    const winnerId = await redis.srandmember(KEY_POOL_SET);
    if (!winnerId) return res.status(400).json({ ok: false, error: "No members left in pool. Restart Spin." });

    const bagLen = await redis.llen(KEY_PRIZE_BAG);
    if (!bagLen || bagLen <= 0) return res.status(400).json({ ok: false, error: "No prizes left. Save prizes again." });

    const bag = await redis.lrange(KEY_PRIZE_BAG, 0, bagLen - 1);
    const prize = randPick(bag);
    await redis.lrem(KEY_PRIZE_BAG, 1, String(prize));

    await redis.srem(KEY_POOL_SET, String(winnerId));
    await redis.sadd(KEY_WINNERS_SET, String(winnerId));

    const h = await redis.hgetall(KEY_MEMBER_HASH(String(winnerId))).catch(() => ({}));
    const name = String(h?.name || "").trim();
    const username = String(h?.username || "").trim().replace("@", "");
    const display = String(h?.display || "").trim() || (name || (username ? `@${username}` : String(winnerId)));

    const item = {
      at: nowISO(),
      prize: String(prize),
      winner: { id: String(winnerId), name, username, display, dm_ready: String(h?.dm_ready || "0") === "1" },
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
      try { return JSON.parse(s); } catch { return { raw: s }; }
    });
    res.json({ ok: true, total: history.length, history });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
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

    await redis.set(KEY_NOTICE_CTX(uid), JSON.stringify({ prize: pz, at: nowISO() }), { ex: 60 * 60 * 24 * 7 });

    const dm = await bot
      .sendMessage(Number(uid), msgText)
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, error: e?.message || String(e) }));

    res.json({ ok: true, dm_ok: dm.ok, dm_error: dm.ok ? "" : String(dm.error || "") });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/restart-spin", requireApiKey, async (req, res) => {
  try {
    await redis.del(KEY_WINNERS_SET);
    await redis.del(KEY_HISTORY_LIST);

    await redis.del(KEY_POOL_SET);

    const ids = (await redis.smembers(KEY_MEMBERS_SET)) || [];
    const cleanIds = ids.map(String).filter((id) => id && !isExcludedUser(id));

    for (const id of cleanIds) {
      const h = await redis.hgetall(KEY_MEMBER_HASH(id)).catch(() => null);
      const active = !h ? true : String(h?.active ?? "1") === "1";
      if (active) await redis.sadd(KEY_POOL_SET, String(id));
    }

    const raw = await redis.get(KEY_PRIZE_SOURCE);
    if (raw && String(raw).trim()) {
      const bag = parsePrizeTextExpand(raw);
      await redis.del(KEY_PRIZE_BAG);
      for (const p of bag) await redis.rpush(KEY_PRIZE_BAG, String(p));
    } else {
      await redis.del(KEY_PRIZE_BAG);
    }

    res.json({ ok: true, pool: Number(await redis.scard(KEY_POOL_SET)) || 0, time: nowISO() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
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

/* ================= Pinned register message ================= */
async function buildRegisterKeyboard() {
  const startUrl = await getStartUrl();
  if (!startUrl) return undefined;

  const liveBtn = (await redis.get(KEY_REG_BTN)) || "";
  const label = String(liveBtn).trim() || "▶️ Register / Enable DM";

  return { inline_keyboard: [[{ text: label, url: startUrl }]] };
}

async function getPinConfig() {
  const mode = (await redis.get(KEY_PIN_MODE)) || "text";
  const text =
    (await redis.get(KEY_PIN_TEXT)) ||
    "📌 Lucky77 DM Register (Prize Contact)\n\n✅ Prize ပေါက်သွားရင် DM ကနေ ဆက်သွယ်ပေးနိုင်ဖို့\nအောက်က Button ကိုနှိပ်ပြီး Bot DM ကို Enable/Register လုပ်ပါ။";
  const fileId = (await redis.get(KEY_PIN_FILE)) || "";
  return { mode: String(mode), text: String(text), fileId: String(fileId) };
}

async function sendAndPinRegisterMessage(groupId) {
  const gid = Number(groupId);
  const { mode, text, fileId } = await getPinConfig();
  const keyboard = await buildRegisterKeyboard();

  let sent;
  if (mode === "photo" && fileId) {
    sent = await bot.sendPhoto(gid, fileId, { caption: text, reply_markup: keyboard || undefined });
  } else if (mode === "video" && fileId) {
    sent = await bot.sendVideo(gid, fileId, { caption: text, reply_markup: keyboard || undefined, supports_streaming: true });
  } else {
    sent = await bot.sendMessage(gid, text, { reply_markup: keyboard || undefined });
  }

  try { await bot.pinChatMessage(gid, sent.message_id, { disable_notification: true }); } catch (_) {}
  await redis.set(KEY_PINNED_MSG_ID(String(groupId)), String(sent.message_id));
  return sent.message_id;
}

async function ensurePinnedRegisterMessage(groupId) {
  const gid = String(groupId);
  const cached = await redis.get(KEY_PINNED_MSG_ID(gid));
  if (cached) return;
  await sendAndPinRegisterMessage(gid);
}

/* ================= Register DM ================= */
async function getRegLive() {
  const mode = (await redis.get(KEY_REG_MODE)) || "text";
  const cap =
    (await redis.get(KEY_REG_CAP)) ||
    "✅ Registered ပြီးပါပြီ。\n\n📩 Prize ပေါက်ရင် ဒီ DM ကနေ ဆက်သွယ်ပေးပါမယ်။";
  const fileId = (await redis.get(KEY_REG_FILE)) || "";
  const btn = (await redis.get(KEY_REG_BTN)) || "";
  return { mode: String(mode), cap: String(cap), fileId: String(fileId), btn: String(btn) };
}
async function sendRegWelcome(chatId) {
  const { mode, cap, fileId } = await getRegLive();
  if (mode === "photo" && fileId) return bot.sendPhoto(chatId, fileId, { caption: cap });
  if (mode === "video" && fileId) return bot.sendVideo(chatId, fileId, { caption: cap, supports_streaming: true });
  return bot.sendMessage(chatId, cap);
}
async function proceedRegisterAndReply(chatId, u) {
  await saveMember(u, "private_start");
  await setDmReady(u.id);
  await sendRegWelcome(chatId);
}
/* ================= OWNER /remove & /add ================= */
function parseRemovePayload(text) {
  const raw = String(text || "").replace(/^\/remove(@\w+)?\s*/i, "").trim();
  if (!raw) return null;

  const parts = raw.split(/\s+/).filter(Boolean);
  let username = "";
  let id = "";
  const nameTokens = [];

  for (const p of parts) {
    const low = p.toLowerCase();
    if (p.startsWith("@") && p.length > 1) { username = p.replace("@", "").trim(); continue; }
    const m = low.match(/^id[:=](\d+)$/);
    if (m) { id = m[1]; continue; }
    if (!id && /^\d+$/.test(p)) { id = p; continue; }
    nameTokens.push(p);
  }

  const name = nameTokens.join(" ").trim();
  if (!name && !username && !id) return null;
  return { name, username, id };
}

async function resolveMemberIdForAny({ id, username, name }) {
  if (id) return String(id);

  const u = normalizeUsername(username);
  if (u) {
    const mapped = await redis.get(KEY_USER_INDEX(u));
    if (mapped) return String(mapped);

    const ids = (await redis.smembers(KEY_MEMBERS_SET)) || [];
    for (const mid of ids) {
      const h = await redis.hgetall(KEY_MEMBER_HASH(mid)).catch(() => null);
      if (!h) continue;
      if (normalizeUsername(h.username || "") === u) return String(h.id || mid);
    }
  }

  const n = normalizeName(name);
  if (n) {
    const mapped = await redis.get(KEY_NAME_INDEX(n));
    if (mapped) return String(mapped);

    const ids = (await redis.smembers(KEY_MEMBERS_SET)) || [];
    for (const mid of ids) {
      const h = await redis.hgetall(KEY_MEMBER_HASH(mid)).catch(() => null);
      if (!h) continue;
      if (normalizeName(h.name || "") === n) return String(h.id || mid);
      if (normalizeName(h.display || "") === n) return String(h.id || mid);
    }
  }
  return "";
}

function parseAddPayload(text) {
  const raw = String(text || "").replace(/^\/add(@\w+)?\s*/i, "").trim();
  if (!raw) return null;

  const parts = raw.split(/\s+/).filter(Boolean);
  let username = "";
  let id = "";
  const nameTokens = [];

  for (const p of parts) {
    const low = p.toLowerCase();
    if (p.startsWith("@") && p.length > 1) { username = p.replace("@", "").trim(); continue; }
    const m = low.match(/^id[:=](\d+)$/);
    if (m) { id = m[1]; continue; }
    if (!id && /^\d+$/.test(p)) { id = p; continue; }
    nameTokens.push(p);
  }

  const name = nameTokens.join(" ").trim();
  if (!name && !username && !id) return null;
  return { name, username, id };
}

async function addMemberManual({ id, name = "", username = "" }, source = "owner_add") {
  const uid = String(id || "").trim();
  if (!uid || !/^\d+$/.test(uid)) return { ok: false, error: "invalid_id" };
  if (isExcludedUser(uid)) return { ok: false, error: "excluded" };

  const exists = await redis.sismember(KEY_MEMBERS_SET, uid);
  if (exists) return { ok: false, error: "exists" };

  const cleanUsername = String(username || "").replace("@", "").trim();
  const cleanName = String(name || "").trim();
  const display = cleanName || (cleanUsername ? `@${cleanUsername}` : uid);

  await redis.sadd(KEY_MEMBERS_SET, uid);

  const isWinner = await redis.sismember(KEY_WINNERS_SET, uid);
  if (!isWinner) await redis.sadd(KEY_POOL_SET, uid);

  await redis.hset(KEY_MEMBER_HASH(uid), {
    id: uid,
    name: cleanName,
    username: cleanUsername,
    display,
    dm_ready: "1",
    dm_ready_at: nowISO(),
    active: "1",
    left_at: "",
    left_reason: "",
    source: String(source),
    registered_at: nowISO(),
    last_seen_at: nowISO(),
  });

  await indexMemberIdentity({ id: uid, name: cleanName, username: cleanUsername });
  return { ok: true };
}

bot.onText(/^\/remove(@\w+)?(\s+[\s\S]+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;

  const payload = parseRemovePayload(msg.text || "");
  if (!payload) return bot.sendMessage(msg.chat.id, "Usage:\n/remove <name> OR @username OR id:123");

  const uid = await resolveMemberIdForAny(payload);
  if (!uid) return bot.sendMessage(msg.chat.id, "❌ Could not resolve member id.");

  const exists = await redis.sismember(KEY_MEMBERS_SET, String(uid));
  if (!exists) return bot.sendMessage(msg.chat.id, "ℹ️ Member not found.");

  await removeMemberHard(uid);
  return bot.sendMessage(msg.chat.id, `✅ Removed member (hard): ${uid}`);
});

bot.onText(/^\/add(@\w+)?(\s+[\s\S]+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;

  const payload = parseAddPayload(msg.text || "");
  if (!payload) return bot.sendMessage(msg.chat.id, "Usage:\n/add <id> [@username] [name]");

  const resolved = await resolveMemberIdForAny(payload);
  if (resolved) {
    const exists = await redis.sismember(KEY_MEMBERS_SET, String(resolved));
    if (exists) return bot.sendMessage(msg.chat.id, `ℹ️ Already exists. (id: ${resolved})`);
  }

  if (!payload.id) return bot.sendMessage(msg.chat.id, "❌ New add needs id.\nExample:\n/add 123456789 @user Name");

  const r = await addMemberManual({ id: payload.id, name: payload.name || "", username: payload.username || "" }, "owner_add");

  if (!r.ok && r.error === "exists") return bot.sendMessage(msg.chat.id, "ℹ️ Already exists.");
  if (!r.ok && r.error === "excluded") return bot.sendMessage(msg.chat.id, "❌ This user is excluded.");
  if (!r.ok && r.error === "invalid_id") return bot.sendMessage(msg.chat.id, "❌ Invalid id.");
  if (!r.ok) return bot.sendMessage(msg.chat.id, "❌ Failed to add.");

  return bot.sendMessage(msg.chat.id, `✅ Added member: ${String(payload.id)}\n• name: ${payload.name || "-"}\n• username: ${payload.username ? "@" + String(payload.username).replace("@", "") : "-"}\n• dm_ready: 1`);
});

/* ================= OWNER STAGING COMMANDS (DM Only) ================= */

// Join Gate staging
bot.onText(/^\/joincap(@\w+)?(\s+[\s\S]+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;
  const cap = extractCmdText(msg.text, "joincap");
  if (!cap) return bot.sendMessage(msg.chat.id, "Usage:\n/joincap <text>");
  await redis.set(KEY_STG_JOIN_CAP, String(cap));
  return bot.sendMessage(msg.chat.id, "✅ Staged Join Caption saved. Use /upload to apply.");
});

bot.onText(/^\/joinbuttomlabel(@\w+)?(\s+[\s\S]+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;
  const label = extractCmdText(msg.text, "joinbuttomlabel");
  if (!label) return bot.sendMessage(msg.chat.id, "Usage:\n/joinbuttomlabel <label>");
  await redis.set(KEY_STG_JOIN_BTN, String(label));
  return bot.sendMessage(msg.chat.id, "✅ Staged Join Button Label saved. Use /upload to apply.");
});

// Register DM staging
bot.onText(/^\/regcaption(@\w+)?(\s+[\s\S]+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;
  const cap = extractCmdText(msg.text, "regcaption");
  if (!cap) return bot.sendMessage(msg.chat.id, "Usage:\n/regcaption <text>");
  await redis.set(KEY_STG_REG_CAP, String(cap));
  return bot.sendMessage(msg.chat.id, "✅ Staged Register Caption saved. Use /upload to apply.");
});

bot.onText(/^\/regbuttomlabel(@\w+)?(\s+[\s\S]+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;
  const label = extractCmdText(msg.text, "regbuttomlabel");
  if (!label) return bot.sendMessage(msg.chat.id, "Usage:\n/regbuttomlabel <label>");
  await redis.set(KEY_STG_REG_BTN, String(label));
  return bot.sendMessage(msg.chat.id, "✅ Staged Register Button Label saved. Use /upload to apply.");
});

bot.onText(/^\/regimage(@\w+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;
  const r = msg.reply_to_message;
  const photo = r?.photo?.length ? r.photo[r.photo.length - 1] : null;
  if (!photo?.file_id) return bot.sendMessage(msg.chat.id, "Reply a PHOTO then type:\n/regimage");
  await redis.set(KEY_STG_REG_MODE, "photo");
  await redis.set(KEY_STG_REG_FILE, String(photo.file_id));
  return bot.sendMessage(msg.chat.id, "✅ Staged Register IMAGE saved. Use /upload to apply.");
});

bot.onText(/^\/regvideo(@\w+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;
  const r = msg.reply_to_message;
  const vid = r?.video;
  if (!vid?.file_id) return bot.sendMessage(msg.chat.id, "Reply a VIDEO then type:\n/regvideo");
  await redis.set(KEY_STG_REG_MODE, "video");
  await redis.set(KEY_STG_REG_FILE, String(vid.file_id));
  return bot.sendMessage(msg.chat.id, "✅ Staged Register VIDEO saved. Use /upload to apply.");
});

// /upload apply (Join + Reg)
bot.onText(/^\/upload(@\w+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;

  const stgJoinCap = await redis.get(KEY_STG_JOIN_CAP);
  const stgJoinBtn = await redis.get(KEY_STG_JOIN_BTN);

  let joinApplied = 0;
  if (stgJoinCap != null) { await redis.set(KEY_JOIN_CAP, String(stgJoinCap)); await redis.del(KEY_STG_JOIN_CAP); joinApplied++; }
  if (stgJoinBtn != null) { await redis.set(KEY_JOIN_BTN, String(stgJoinBtn)); await redis.del(KEY_STG_JOIN_BTN); joinApplied++; }

  const stgRegCap = await redis.get(KEY_STG_REG_CAP);
  const stgRegBtn = await redis.get(KEY_STG_REG_BTN);
  const stgRegMode = await redis.get(KEY_STG_REG_MODE);
  const stgRegFile = await redis.get(KEY_STG_REG_FILE);

  let regApplied = 0;
  if (stgRegCap != null) { await redis.set(KEY_REG_CAP, String(stgRegCap)); await redis.del(KEY_STG_REG_CAP); regApplied++; }
  if (stgRegBtn != null) { await redis.set(KEY_REG_BTN, String(stgRegBtn)); await redis.del(KEY_STG_REG_BTN); regApplied++; }
  if (stgRegMode != null) { await redis.set(KEY_REG_MODE, String(stgRegMode)); await redis.del(KEY_STG_REG_MODE); regApplied++; }
  if (stgRegFile != null) { await redis.set(KEY_REG_FILE, String(stgRegFile)); await redis.del(KEY_STG_REG_FILE); regApplied++; }

  if (!joinApplied && !regApplied) return bot.sendMessage(msg.chat.id, "ℹ️ Nothing staged.");

  return bot.sendMessage(
    msg.chat.id,
    "✅ Applied staging:\n" +
      `• Join Gate: ${joinApplied ? "updated" : "no changes"}\n` +
      `• Register DM: ${regApplied ? "updated" : "no changes"}`
  );
});

// Channel Post staging + upload
bot.onText(/^\/postchannelcaption(@\w+)?(\s+[\s\S]+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;
  const cap = extractCmdText(msg.text, "postchannelcaption");
  if (!cap) return bot.sendMessage(msg.chat.id, "Usage:\n/postchannelcaption <text>");
  await redis.set(KEY_STG_POST_CAP, String(cap));
  return bot.sendMessage(msg.chat.id, "✅ Staged Channel Post caption saved. Use /uploadchannelpost to post.");
});

bot.onText(/^\/postchannelbuttomlabel(@\w+)?(\s+[\s\S]+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;
  const label = extractCmdText(msg.text, "postchannelbuttomlabel");
  if (!label) return bot.sendMessage(msg.chat.id, "Usage:\n/postchannelbuttomlabel <label>");
  await redis.set(KEY_STG_POST_BTN, String(label));
  return bot.sendMessage(msg.chat.id, "✅ Staged Channel Post button label saved. Use /uploadchannelpost to post.");
});

bot.onText(/^\/postchannelimage(@\w+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;
  const r = msg.reply_to_message;
  const photo = r?.photo?.length ? r.photo[r.photo.length - 1] : null;
  if (!photo?.file_id) return bot.sendMessage(msg.chat.id, "Reply a PHOTO then type:\n/postchannelimage");
  await redis.set(KEY_STG_POST_MODE, "photo");
  await redis.set(KEY_STG_POST_FILE, String(photo.file_id));
  return bot.sendMessage(msg.chat.id, "✅ Staged Channel Post IMAGE saved. Use /uploadchannelpost to post.");
});

bot.onText(/^\/postchannelvideo(@\w+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;
  const r = msg.reply_to_message;
  const vid = r?.video;
  if (!vid?.file_id) return bot.sendMessage(msg.chat.id, "Reply a VIDEO then type:\n/postchannelvideo");
  await redis.set(KEY_STG_POST_MODE, "video");
  await redis.set(KEY_STG_POST_FILE, String(vid.file_id));
  return bot.sendMessage(msg.chat.id, "✅ Staged Channel Post VIDEO saved. Use /uploadchannelpost to post.");
});

bot.onText(/^\/uploadchannelpost(@\w+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;
  if (!CHANNEL_CHAT) return bot.sendMessage(msg.chat.id, "❌ CHANNEL_CHAT env not set.");

  const cap = (await redis.get(KEY_STG_POST_CAP)) || "";
  const btn = (await redis.get(KEY_STG_POST_BTN)) || "▶️ Register / Enable DM";
  const mode = (await redis.get(KEY_STG_POST_MODE)) || "text";
  const fileId = (await redis.get(KEY_STG_POST_FILE)) || "";

  const kb = await buildStartKeyboard(btn);

  try {
    if (mode === "photo" && fileId) {
      await bot.sendPhoto(String(CHANNEL_CHAT), fileId, { caption: cap || undefined, reply_markup: kb || undefined });
    } else if (mode === "video" && fileId) {
      await bot.sendVideo(String(CHANNEL_CHAT), fileId, { caption: cap || undefined, reply_markup: kb || undefined, supports_streaming: true });
    } else {
      const text = cap && String(cap).trim() ? String(cap) : " ";
      await bot.sendMessage(String(CHANNEL_CHAT), text, { reply_markup: kb || undefined });
    }
    return bot.sendMessage(msg.chat.id, "✅ Posted to channel.");
  } catch (e) {
    return bot.sendMessage(msg.chat.id, `❌ Post failed: ${e?.message || String(e)}`);
  }
});

/* ================= CALLBACKS ================= */
bot.on("callback_query", async (q) => {
  try {
    const data = String(q?.data || "");
    const fromId = String(q?.from?.id || "");
    const chatId = q?.message?.chat?.id;

    if (!chatId) {
      try { await bot.answerCallbackQuery(q.id); } catch (_) {}
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
      if (!ok) { await sendJoinGate(chatId, fromId); return; }

      await proceedRegisterAndReply(chatId, q.from);
      return;
    }

    await bot.answerCallbackQuery(q.id).catch(() => {});
  } catch (_) {
    try { await bot.answerCallbackQuery(q.id); } catch (_) {}
  }
});

/* ================= Message Handler ================= */
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat) return;

    // forward winner replies to owner
    if (msg.chat.type === "private" && msg.from && !isOwner(msg.from.id)) {
      const uid = String(msg.from.id);
      const ctxRaw = await redis.get(KEY_NOTICE_CTX(uid));
      if (ctxRaw) {
        let ctx = {};
        try { ctx = JSON.parse(ctxRaw); } catch (_) {}
        const { name, username } = nameParts(msg.from);

        const header =
          "📨 Winner Reply (Auto Forward)\n" +
          `• Name: ${name || "-"}\n` +
          `• Username: ${username ? "@" + username.replace("@", "") : "-"}\n` +
          `• ID: ${uid}\n` +
          `• Prize: ${ctx?.prize || "-"}`;

        await bot.sendMessage(Number(OWNER_ID), header).catch(() => {});
        await bot.forwardMessage(Number(OWNER_ID), msg.chat.id, msg.message_id).catch(() => {});
      }
      return;
    }

    // group flow
    if (targetGroup(msg.chat)) {
      await redis.set(KEY_LAST_GROUP, String(msg.chat.id));
      await ensurePinnedRegisterMessage(msg.chat.id);

      if (msg.new_chat_members && msg.new_chat_members.length) {
        await autoDelete(msg.chat.id, msg.message_id, 2000);
        for (const u of msg.new_chat_members) {
          if (!u) continue;
          if (isExcludedUser(u.id)) continue;
          await saveMember(u, "group_join");
        }
      }

      if (msg.left_chat_member) {
        await autoDelete(msg.chat.id, msg.message_id, 2000);
        const u = msg.left_chat_member;
        if (u && !isExcludedUser(u.id)) await markInactive(u.id, "left_group");
      }
    }
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
      if (!ok) { await sendJoinGate(msg.chat.id, u.id); return; }
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

  if (!(await redis.get(KEY_PIN_MODE))) await redis.set(KEY_PIN_MODE, "text");
  if (!(await redis.get(KEY_PIN_TEXT))) {
    await redis.set(
      KEY_PIN_TEXT,
      "📌 Lucky77 DM Register (Prize Contact)\n\n✅ Prize ပေါက်သွားရင် DM ကနေ ဆက်သွယ်ပေးနိုင်ဖို့\nအောက်က Button ကိုနှိပ်ပြီး Bot DM ကို Enable/Register လုပ်ပါ။"
    );
  }

  if (!(await redis.get(KEY_JOIN_CAP))) {
    await redis.set(
      KEY_JOIN_CAP,
      "❌ Channel ကို Join ပြီးမှ Register/Enable DM လုပ်နိုင်ပါသည်。\n\n👉 အောက်က Button နဲ့ Join လုပ်ပြီး ပြန်စစ်ပါ။"
    );
  }
  if (!(await redis.get(KEY_JOIN_BTN))) await redis.set(KEY_JOIN_BTN, "📢 Join Channel");

  if (!(await redis.get(KEY_REG_MODE))) await redis.set(KEY_REG_MODE, "text");
  if (!(await redis.get(KEY_REG_CAP))) await redis.set(KEY_REG_CAP, "✅ Registered ပြီးပါပြီ。\n\n📩 Prize ပေါက်ရင် ဒီ DM ကနေ ဆက်သွယ်ပေးပါမယ်။");
  if (!(await redis.get(KEY_REG_BTN))) await redis.set(KEY_REG_BTN, "");

  await setupWebhook();
  console.log("Webhook set ✅", `${PUBLIC_URL}${WEBHOOK_PATH}`);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", async () => {
  console.log("Server running on port", PORT);
  try { await boot(); } catch (e) { console.error("Boot error:", e); }
});

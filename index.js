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

  GROUP_ID, // optional
  EXCLUDE_IDS, // optional "123,456"

  PUBLIC_URL,
  WEBHOOK_SECRET,

  CHANNEL_CHAT, // optional "@channel"
  CHANNEL_LINK, // optional "https://t.me/channel"
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

if (!GROUP_ID) console.warn("⚠️ GROUP_ID not set (pin update needs it).");

// ================= Redis =================
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// ================= Keys =================
const KEY_PREFIX = "lucky77:pro:v2:remax";

const KEY_MEMBERS_SET = `${KEY_PREFIX}:members:set`;
const KEY_MEMBER_HASH = (id) => `${KEY_PREFIX}:member:${id}`;
const KEY_WINNERS_SET = `${KEY_PREFIX}:winners:set`;
const KEY_HISTORY_LIST = `${KEY_PREFIX}:history:list`;

// ✅ FAST pool
const KEY_POOL_SET = `${KEY_PREFIX}:pool:set`;

// ✅ save enable switch
const KEY_SAVE_ENABLED = `${KEY_PREFIX}:save:enabled`; // "1" or "0"

// indexes (manual merge)
const KEY_USER_INDEX = (u) => `${KEY_PREFIX}:index:username:${u}`;
const KEY_NAME_INDEX = (n) => `${KEY_PREFIX}:index:name:${n}`;

// prizes
const KEY_PRIZE_BAG = `${KEY_PREFIX}:prizes:bag`;
const KEY_PRIZE_SOURCE = `${KEY_PREFIX}:prizes:source`;

// misc
const KEY_LAST_GROUP = `${KEY_PREFIX}:last_group_id`;
const KEY_PINNED_MSG_ID = (gid) => `${KEY_PREFIX}:pinned:${gid}`;
const KEY_PIN_TEXT = `${KEY_PREFIX}:pin:text`;
const KEY_PIN_MODE = `${KEY_PREFIX}:pin:mode`;
const KEY_PIN_FILE = `${KEY_PREFIX}:pin:file_id`;

// join gate
const KEY_JOIN_CAP = `${KEY_PREFIX}:join:cap`;
const KEY_JOIN_BTN = `${KEY_PREFIX}:join:btn`;

// reg dm live
const KEY_REG_CAP = `${KEY_PREFIX}:reg:cap`;
const KEY_REG_BTN = `${KEY_PREFIX}:reg:btn`;
const KEY_REG_MODE = `${KEY_PREFIX}:reg:mode`;
const KEY_REG_FILE = `${KEY_PREFIX}:reg:file`;

// notice ctx
const KEY_NOTICE_CTX = (uid) => `${KEY_PREFIX}:notice:ctx:${uid}`;

// ================= Telegram Bot (Webhook) =================
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });
let BOT_USERNAME = null;

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
    try { await bot.deleteMessage(chatId, messageId); } catch {}
  }, ms);
}

async function getSaveEnabled() {
  const v = await redis.get(KEY_SAVE_ENABLED);
  if (v === null || v === undefined || v === "") return true;
  return String(v) === "1";
}

const SAVE_STOP_MESSAGE =
  "luckywheel စာရင်းဝင်ခနတာပိတ်ထားပါတယ်ရှင့် နာရီဝက်( သို့) တစ်နာရီခန့်အကြာတွင် ပြန်လည်စာရင်းသွင်းနိုင်ပါမယ်ရှင့်။😍❤️";

// ---------- Channel Gate ----------
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
  } catch {
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

// ================= Prize expand =================
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

// ================= Auth =================
function requireApiKey(req, res, next) {
  const k = req.headers["x-api-key"] || req.query.key;
  if (!k || String(k) !== String(API_KEY)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// ================= Member save / merge =================
async function indexMemberIdentity({ id, name, username }) {
  const u = normalizeUsername(username);
  const n = normalizeName(name);
  if (u) await redis.set(KEY_USER_INDEX(u), String(id));
  if (n) await redis.set(KEY_NAME_INDEX(n), String(id));
}

async function isRegistered(userId) {
  const ok = await redis.sismember(KEY_MEMBERS_SET, String(userId));
  return !!ok;
}

async function migrateManualToRealIfNeeded(telegramUser) {
  const realId = String(telegramUser.id);
  const { name, username } = nameParts(telegramUser);

  const u = normalizeUsername(username);
  const n = normalizeName(name);

  const candidateIds = [];

  if (u) {
    const mapped = await redis.get(KEY_USER_INDEX(u));
    if (mapped && String(mapped) !== realId) candidateIds.push(String(mapped));
  }
  if (n) {
    const mapped = await redis.get(KEY_NAME_INDEX(n));
    if (mapped && String(mapped) !== realId) candidateIds.push(String(mapped));
  }

  let manualId = "";
  for (const cid of candidateIds) {
    if (!cid.startsWith("manual:")) continue;
    const exists = await redis.sismember(KEY_MEMBERS_SET, cid);
    if (exists) { manualId = cid; break; }
  }
  if (!manualId) return { migrated: false };

  const old = await redis.hgetall(KEY_MEMBER_HASH(manualId));
  const wasWinner = await redis.sismember(KEY_WINNERS_SET, manualId);

  await redis.srem(KEY_MEMBERS_SET, manualId);
  await redis.srem(KEY_POOL_SET, manualId);
  await redis.srem(KEY_WINNERS_SET, manualId);

  await redis.sadd(KEY_MEMBERS_SET, realId);

  if (wasWinner) {
    await redis.sadd(KEY_WINNERS_SET, realId);
    await redis.srem(KEY_POOL_SET, realId);
  } else {
    await redis.sadd(KEY_POOL_SET, realId);
  }

  const merged = {
    ...(old || {}),
    id: realId,
    name: name || (old?.name || ""),
    username: String(username || "").replace("@", "") || (old?.username || ""),
    dm_ready: "1",
    source: "merge_manual_to_real",
    registered_at: old?.registered_at || new Date().toISOString(),
    migrated_from: manualId,
    dm_ready_at: new Date().toISOString(),
  };

  await redis.hset(KEY_MEMBER_HASH(realId), merged);
  await redis.del(KEY_MEMBER_HASH(manualId));

  await indexMemberIdentity({ id: realId, name: merged.name, username: merged.username });

  return { migrated: true, from: manualId, to: realId };
}

async function saveMember(telegramUser, source = "group_join") {
  const saveEnabled = await getSaveEnabled();
  if (!saveEnabled) return { ok: false, reason: "save_disabled" };

  const userId = String(telegramUser.id);
  if (isExcludedUser(userId)) return { ok: false, reason: "excluded" };

  await migrateManualToRealIfNeeded(telegramUser).catch(() => {});

  const { name, username } = nameParts(telegramUser);

  // ✅ IMPORTANT: keep existing dm_ready if already registered in DM
  const prev = await redis.hgetall(KEY_MEMBER_HASH(userId)).catch(() => ({}));
  const prevDmReady = String(prev?.dm_ready || "0");

  await redis.sadd(KEY_MEMBERS_SET, userId);

  // pool add only if not winner
  const isWinner = await redis.sismember(KEY_WINNERS_SET, userId);
  if (!isWinner) await redis.sadd(KEY_POOL_SET, userId);

  await redis.hset(KEY_MEMBER_HASH(userId), {
    id: userId,
    name,
    username: String(username || "").replace("@", ""),
    dm_ready: prevDmReady === "1" ? "1" : "0",
    source,
    registered_at: prev?.registered_at || new Date().toISOString(),
    dm_ready_at: prev?.dm_ready_at || "",
  });

  await indexMemberIdentity({ id: userId, name, username });

  return { ok: true };
}

async function setDmReady(userId) {
  await redis.hset(KEY_MEMBER_HASH(String(userId)), {
    dm_ready: "1",
    dm_ready_at: new Date().toISOString(),
  });
}

async function removeMemberById(userId) {
  const uid = String(userId);
  await redis.srem(KEY_MEMBERS_SET, uid);
  await redis.srem(KEY_POOL_SET, uid);
  await redis.srem(KEY_WINNERS_SET, uid);
  await redis.del(KEY_MEMBER_HASH(uid));
  return { ok: true };
}

// ================= Manual add/remove (owner) =================
function makeManualIdFromText(txt) {
  const s = String(txt || "").trim().toLowerCase();
  const safe = s
    .replace(/\s+/g, "_")
    .replace(/[^\w@.-]+/g, "")
    .replace(/^@+/, "");
  return safe ? `manual:${safe}` : "";
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
    nameTokens.push(p);
  }

  const name = nameTokens.join(" ").trim();
  if (!name && !username && !id) return null;
  return { name: name || "", username: username || "", id: id ? String(id) : "" };
}

async function saveMemberManual({ id, username, name }, source = "owner_add") {
  let uid = (id || "").trim();

  if (!uid) {
    const base = (username || name || "").trim();
    uid = makeManualIdFromText(base);
    if (!uid) return { ok: false, error: "Cannot build manual id" };
  }

  if (isExcludedUser(uid)) return { ok: false, error: "excluded" };

  const already = await redis.sismember(KEY_MEMBERS_SET, String(uid));
  const wasWinner = await redis.sismember(KEY_WINNERS_SET, String(uid));

  await redis.sadd(KEY_MEMBERS_SET, String(uid));
  if (!wasWinner) await redis.sadd(KEY_POOL_SET, String(uid));

  const prev = await redis.hgetall(KEY_MEMBER_HASH(String(uid))).catch(() => ({}));
  const prevDmReady = String(prev?.dm_ready || "0");

  await redis.hset(KEY_MEMBER_HASH(String(uid)), {
    id: String(uid),
    name: String(name || "").trim(),
    username: String(username || "").trim().replace("@", ""),
    dm_ready: prevDmReady === "1" ? "1" : "0",
    source,
    registered_at: prev?.registered_at || new Date().toISOString(),
    dm_ready_at: prev?.dm_ready_at || "",
  });

  await indexMemberIdentity({ id: uid, name, username });

  return { ok: true, updated: !!already, id: String(uid) };
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
    if (p.startsWith("@") && p.length > 1) { username = p.replace("@", "").trim(); continue; }
    const m = low.match(/^id[:=](\d+)$/);
    if (m) { id = m[1]; continue; }
    nameTokens.push(p);
  }

  const name = nameTokens.join(" ").trim();
  if (!name && !username && !id) return null;
  return { name: name || "", username: username || "", id: id ? String(id) : "" };
}

async function resolveMemberIdForRemove({ id, username, name }) {
  if (id) return String(id);

  const u = normalizeUsername(username);
  if (u) {
    const mapped = await redis.get(KEY_USER_INDEX(u));
    if (mapped) return String(mapped);
    return makeManualIdFromText("@" + u);
  }

  const n = normalizeName(name);
  if (n) {
    const mapped = await redis.get(KEY_NAME_INDEX(n));
    if (mapped) return String(mapped);
    return makeManualIdFromText(n);
  }

  return "";
}

// ================= Express =================
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
    const saveEnabled = await getSaveEnabled();
    res.json({
      ok: true,
      members: Number(members) || 0,
      winners: Number(winners) || 0,
      pool: Number(pool) || 0,
      remaining_prizes: Number(bagLen) || 0,
      save_enabled: !!saveEnabled,
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ FIX: members always show (fallback even if hash missing)
app.get("/members", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const cleanIds = (ids || []).filter((id) => !isExcludedUser(id));

    const pipe = redis.pipeline();
    for (const id of cleanIds) {
      pipe.hgetall(KEY_MEMBER_HASH(id));
      pipe.sismember(KEY_WINNERS_SET, String(id));
    }
    const out = await pipe.exec();

    const members = [];
    for (let i = 0; i < cleanIds.length; i++) {
      const id = String(cleanIds[i]);
      const h = out[i * 2]?.result || null;
      const isWinner = !!out[i * 2 + 1]?.result;

      // fallback when hash missing
      const name = String(h?.name || "").trim();
      const username = String(h?.username || "").trim().replace("@", "");
      const display = name || (username ? `@${username}` : id);

      members.push({
        id,
        name,
        username,
        display,
        dm_ready: String(h?.dm_ready || "0") === "1",
        isWinner,
        registered_at: String(h?.registered_at || ""),
      });
    }

    // stable order: by registered_at then id
    members.sort((a, b) => {
      const aa = a.registered_at || "";
      const bb = b.registered_at || "";
      const c = aa.localeCompare(bb);
      if (c !== 0) return c;
      return String(a.id).localeCompare(String(b.id));
    });

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
    if (!bag.length) return res.status(400).json({ ok: false, error: "No valid prizes" });

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
    if (!winnerId) {
      return res.status(400).json({ ok: false, error: "No members left in pool. Restart Spin." });
    }

    const bagLen = await redis.llen(KEY_PRIZE_BAG);
    if (!bagLen || bagLen <= 0) {
      return res.status(400).json({ ok: false, error: "No prizes left. Save prizes again." });
    }

    const bag = await redis.lrange(KEY_PRIZE_BAG, 0, bagLen - 1);
    const prize = randPick(bag);
    await redis.lrem(KEY_PRIZE_BAG, 1, String(prize));

    await redis.srem(KEY_POOL_SET, String(winnerId));
    await redis.sadd(KEY_WINNERS_SET, String(winnerId));

    const h = await redis.hgetall(KEY_MEMBER_HASH(String(winnerId))).catch(() => ({}));
    const name = String(h?.name || "").trim();
    const username = String(h?.username || "").trim().replace("@", "");
    const display = name || (username ? `@${username}` : String(winnerId));

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
        : (
            "Congratulation 🥳🥳🥳ပါအကိုရှင့်\n" +
            `လက်ကီး77 ရဲ့ လစဉ်ဗလာမပါလက်ကီးဝှီး အစီစဉ်မှာ ယူနစ် ${pz || "—"} ကံထူးသွားပါတယ်ရှင့်☘️\n` +
            "ဂိမ်းယူနစ်လေး ထည့်ပေးဖို့ အကို့ဂိမ်းအကောင့်လေး ပို့ပေးပါရှင့်"
          );

    await redis.set(
      KEY_NOTICE_CTX(uid),
      JSON.stringify({ prize: pz, at: new Date().toISOString() }),
      { ex: 60 * 60 * 24 * 7 }
    );

    const dm = await bot
      .sendMessage(Number(uid), msgText)
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, error: e?.message || String(e) }));

    res.json({ ok: true, dm_ok: dm.ok, dm_error: dm.ok ? "" : String(dm.error || "") });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ Restart Spin: clears winners/history/pool+bag, BUT keeps members list
app.post("/restart-spin", requireApiKey, async (req, res) => {
  try {
    await redis.del(KEY_WINNERS_SET);
    await redis.del(KEY_HISTORY_LIST);

    // rebuild pool from members
    await redis.del(KEY_POOL_SET);
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    for (const id of ids || []) {
      if (isExcludedUser(id)) continue;
      await redis.sadd(KEY_POOL_SET, String(id));
    }

    // rebuild prize bag from last saved source
    const raw = await redis.get(KEY_PRIZE_SOURCE);
    if (raw) {
      const bag = parsePrizeTextExpand(raw);
      await redis.del(KEY_PRIZE_BAG);
      for (const p of bag) await redis.rpush(KEY_PRIZE_BAG, String(p));
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ NEW: rebuild pool only (do NOT clear history)
app.post("/rebuild-pool", requireApiKey, async (req, res) => {
  try {
    await redis.del(KEY_POOL_SET);
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    for (const id of ids || []) {
      if (isExcludedUser(id)) continue;
      const wasWinner = await redis.sismember(KEY_WINNERS_SET, String(id));
      if (!wasWinner) await redis.sadd(KEY_POOL_SET, String(id));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ================= Telegram Webhook =================
const WEBHOOK_PATH = `/telegram/${encodeURIComponent(WEBHOOK_SECRET)}`;
app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================= Register keyboard (group pin) =================
async function buildRegisterKeyboard() {
  const startUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=register` : null;
  return startUrl ? { inline_keyboard: [[{ text: "▶️ Register / Enable DM", url: startUrl }]] } : undefined;
}

async function getPinConfig() {
  const mode = (await redis.get(KEY_PIN_MODE)) || "text";
  const text =
    (await redis.get(KEY_PIN_TEXT)) ||
    "📌 Lucky77 DM Register (Prize Contact)\n\n✅ Prize ပေါက်သွားရင် DM ကနေ ဆက်သွယ်ပေးနိုင်ဖို့\nအောက်က Button ကိုနှိပ်ပြီး Bot DM ကို Enable/Register လုပ်ပါ။";
  const fileId = (await redis.get(KEY_PIN_FILE)) || "";
  return { mode, text, fileId };
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

  try { await bot.pinChatMessage(gid, sent.message_id, { disable_notification: true }); } catch {}

  await redis.set(KEY_PINNED_MSG_ID(String(groupId)), String(sent.message_id));
  return sent.message_id;
}

async function ensurePinnedRegisterMessage(groupId) {
  const gid = String(groupId);
  const cached = await redis.get(KEY_PINNED_MSG_ID(gid));
  if (cached) return;
  await sendAndPinRegisterMessage(gid);
}

// ================= Register DM =================
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
  const saveEnabled = await getSaveEnabled();
  if (!saveEnabled) {
    await bot.sendMessage(chatId, SAVE_STOP_MESSAGE);
    return { ok: false, reason: "save_disabled" };
  }

  if (!isExcludedUser(u.id)) {
    await saveMember(u, "private_start");
    await setDmReady(u.id);
  }
  await sendRegWelcome(chatId);
  return { ok: true };
}

// ================= OWNER COMMANDS =================
bot.onText(/^\/savestop$/i, async (msg) => {
  if (!ownerOnly(msg)) return;
  await redis.set(KEY_SAVE_ENABLED, "0");
  await bot.sendMessage(msg.chat.id, "✅ Save STOPPED. New registrations will be blocked.");
});

bot.onText(/^\/savestart$/i, async (msg) => {
  if (!ownerOnly(msg)) return;
  await redis.set(KEY_SAVE_ENABLED, "1");
  await bot.sendMessage(msg.chat.id, "✅ Save STARTED. Registrations are open now.");
});

// ✅ NEW: rebuild pool only (owner DM)
bot.onText(/^\/rebuildpool$/i, async (msg) => {
  if (!ownerOnly(msg)) return;
  await redis.del(KEY_POOL_SET);
  const ids = await redis.smembers(KEY_MEMBERS_SET);
  for (const id of ids || []) {
    if (isExcludedUser(id)) continue;
    const wasWinner = await redis.sismember(KEY_WINNERS_SET, String(id));
    if (!wasWinner) await redis.sadd(KEY_POOL_SET, String(id));
  }
  await bot.sendMessage(msg.chat.id, "✅ Pool rebuilt (history not cleared).");
});

bot.onText(/^\/add(@\w+)?(\s+[\s\S]+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;

  const payload = parseAddPayload(msg.text || "");
  if (!payload) {
    return bot.sendMessage(
      msg.chat.id,
      "Usage:\n/add <name> [@username] [id:123]\n\nExamples:\n/add mg mg\n/add @mgmg\n/add id:33984585\n/add mg mg @mgmg id:33984585"
    );
  }

  const result = await saveMemberManual(payload, "owner_add");
  if (!result.ok) return bot.sendMessage(msg.chat.id, "❌ Add failed: " + String(result.error || "unknown"));

  const display =
    (payload.name && payload.name.trim()) ||
    (payload.username ? "@" + payload.username.replace("@", "") : "") ||
    (payload.id ? payload.id : result.id);

  return bot.sendMessage(
    msg.chat.id,
    (result.updated ? "♻️ Updated member\n" : "✅ Added member\n") +
      `• Display: ${display}\n` +
      `• Name: ${payload.name ? payload.name : "-"}\n` +
      `• Username: ${payload.username ? "@" + payload.username.replace("@", "") : "-"}\n` +
      `• ID: ${payload.id ? payload.id : result.id}\n`
  );
});

bot.onText(/^\/remove(@\w+)?(\s+[\s\S]+)?$/i, async (msg) => {
  if (!ownerOnly(msg)) return;

  const payload = parseRemovePayload(msg.text || "");
  if (!payload) {
    return bot.sendMessage(
      msg.chat.id,
      "Usage:\n/remove <name> OR @username OR id:123\n\nExamples:\n/remove mg mg\n/remove @mgmg\n/remove id:33984585"
    );
  }

  const uid = await resolveMemberIdForRemove(payload);
  if (!uid) return bot.sendMessage(msg.chat.id, "❌ Could not resolve member id.");

  const exists = await redis.sismember(KEY_MEMBERS_SET, String(uid));
  if (!exists) return bot.sendMessage(msg.chat.id, "ℹ️ Member not found in list.");

  await removeMemberById(uid);
  return bot.sendMessage(msg.chat.id, `✅ Removed member: ${uid}`);
});

// ================= CALLBACK: channel check =================
bot.on("callback_query", async (q) => {
  try {
    const data = String(q?.data || "");
    const fromId = String(q?.from?.id || "");
    const chatId = q?.message?.chat?.id;
    if (!chatId) return;

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
  } catch {
    try { await bot.answerCallbackQuery(q.id); } catch {}
  }
});

// ================= Message handler =================
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat) return;

    // forward winner replies to owner
    if (msg.chat.type === "private" && msg.from && !isOwner(msg.from.id)) {
      const uid = String(msg.from.id);
      const ctxRaw = await redis.get(KEY_NOTICE_CTX(uid));
      if (ctxRaw) {
        let ctx = {};
        try { ctx = JSON.parse(ctxRaw); } catch {}
        const { name, username } = nameParts(msg.from);

        const header =
          "📨 Winner Reply (Auto Forward)\n" +
          `• Name: ${name || "-"}\n` +
          `• Username: ${username ? "@" + username : "-"}\n` +
          `• ID: ${uid}\n` +
          `• Prize: ${ctx?.prize || "-"}`;

        await bot.sendMessage(Number(OWNER_ID), header).catch(() => {});
        await bot.forwardMessage(Number(OWNER_ID), msg.chat.id, msg.message_id).catch(() => {});
      }
      return;
    }

    // group join
    if (targetGroup(msg.chat)) {
      await redis.set(KEY_LAST_GROUP, String(msg.chat.id));
      await ensurePinnedRegisterMessage(msg.chat.id);

      if (msg.new_chat_members && msg.new_chat_members.length) {
        await autoDelete(msg.chat.id, msg.message_id, 2000);

        const saveEnabled = await getSaveEnabled();
        if (!saveEnabled) return;

        for (const u of msg.new_chat_members) {
          if (!u) continue;
          if (isExcludedUser(u.id)) continue;

          const already = await isRegistered(u.id);
          if (!already) await saveMember(u, "group_join");
          else await saveMember(u, "group_join_update");
        }
      }

      // ✅ IMPORTANT: do NOT auto-remove on leave (keep member list)
      // if (msg.left_chat_member) { ... }  <-- removed
    }
  } catch (e) {
    console.error("message handler error:", e);
  }
});

// ================= /start register =================
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

// ================= Boot =================
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

  if (!(await redis.get(KEY_SAVE_ENABLED))) await redis.set(KEY_SAVE_ENABLED, "1");

  await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
  await bot.setWebHook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
  console.log("Webhook set ✅");
}

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", async () => {
  console.log("Server running on port", PORT);
  try { await boot(); } catch (e) { console.error("Boot error:", e); }
});
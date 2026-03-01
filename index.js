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

if (!GROUP_ID) console.warn("⚠️ GROUP_ID not set (pin needs it only to restrict target).");
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

const KEY_JOIN_CAP = `${KEY_PREFIX}:join:cap`;
const KEY_JOIN_BTN = `${KEY_PREFIX}:join:btn`;

const KEY_REG_CAP = `${KEY_PREFIX}:reg:cap`;
const KEY_REG_BTN = `${KEY_PREFIX}:reg:btn`;
const KEY_REG_MODE = `${KEY_PREFIX}:reg:mode`;
const KEY_REG_FILE = `${KEY_PREFIX}:reg:file`;

const KEY_NOTICE_CTX = (uid) => `${KEY_PREFIX}:notice:ctx:${uid}`;

const KEY_USER_INDEX = (u) => `${KEY_PREFIX}:index:username:${u}`;
const KEY_NAME_INDEX = (n) => `${KEY_PREFIX}:index:name:${n}`;

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
    try { await bot.deleteMessage(chatId, messageId); } catch (_) {}
  }, ms);
}
function nowISO() {
  return new Date().toISOString();
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

  const prev = await redis.hgetall(KEY_MEMBER_HASH(userId)).catch(() => ({}));
  const prevDmReady = String(prev?.dm_ready || "0");
  const prevRegAt = String(prev?.registered_at || "");

  const { name, username } = nameParts(u);
  const cleanUsernameNew = String(username || "").replace("@", "").trim();

  // ✅ IMPORTANT: DO NOT overwrite existing identity with empty
  const nameFinal = String(name || "").trim() || String(prev?.name || "").trim();
  const usernameFinal = cleanUsernameNew || String(prev?.username || "").trim().replace("@", "");

  // ✅ keep old display if exists, else rebuild
  const prevDisplay = String(prev?.display || "").trim();
  const displayFinal =
    prevDisplay ||
    (nameFinal ? nameFinal : (usernameFinal ? `@${usernameFinal}` : userId));

  await redis.sadd(KEY_MEMBERS_SET, userId);

  const isWinner = await redis.sismember(KEY_WINNERS_SET, userId);
  if (!isWinner) await redis.sadd(KEY_POOL_SET, userId);
  else await redis.srem(KEY_POOL_SET, userId);

  await redis.hset(KEY_MEMBER_HASH(userId), {
    id: userId,
    name: nameFinal,
    username: usernameFinal,
    display: displayFinal,

    dm_ready: prevDmReady === "1" ? "1" : "0",

    active: "1",
    left_at: "",
    left_reason: "",

    source: String(source),
    registered_at: prevRegAt || nowISO(),
    last_seen_at: nowISO(),
    dm_ready_at: String(prev?.dm_ready_at || ""),
  });

  await indexMemberIdentity({ id: userId, name: nameFinal, username: usernameFinal });
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

  // ✅ DO NOT touch name/username/display here
  await redis.hset(KEY_MEMBER_HASH(uid), {
    active: "0",
    left_at: nowISO(),
    left_reason: String(reason),
  });

  await redis.srem(KEY_POOL_SET, uid);
  return { ok: true };
}

async function removeMemberHard(userId, reason = "owner_remove") {
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

  return { ok: true, reason };
}

/* ================= OWNER /remove resolve ================= */
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

async function resolveMemberIdForRemove({ id, username, name }) {
  if (id) return String(id);

  const u = normalizeUsername(username);
  if (u) {
    const mapped = await redis.get(KEY_USER_INDEX(u));
    if (mapped) return String(mapped);

    const ids = (await redis.smembers(KEY_MEMBERS_SET)) || [];
    for (const mid of ids) {
      const h = await redis.hgetall(KEY_MEMBER_HASH(mid)).catch(() => null);
      if (!h) continue;
      const hu = normalizeUsername(h.username || "");
      if (hu && hu === u) return String(h.id || mid);
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
      const hn = normalizeName(h.name || "");
      if (hn && hn === n) return String(h.id || mid);
      const hd = normalizeName(h.display || "");
      if (hd && hd === n) return String(h.id || mid);
    }
  }

  return "";
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

app.get("/members", requireApiKey, async (req, res) => {
  try {
    const ids = (await redis.smembers(KEY_MEMBERS_SET)) || [];
    const cleanIds = ids.map(String).filter((id) => !isExcludedUser(id));

    const winnersArr = (await redis.smembers(KEY_WINNERS_SET)) || [];
    const winnersSet = new Set(winnersArr.map(String));

    const hashes = await Promise.all(
      cleanIds.map((id) => redis.hgetall(KEY_MEMBER_HASH(id)).catch(() => null))
    );

    const members = [];
    for (let i = 0; i < cleanIds.length; i++) {
      const id = String(cleanIds[i]);
      const h = hashes[i];

      const name = String(h?.name || "").trim();
      const username = String(h?.username || "").trim().replace("@", "");
      const display =
        String(h?.display || "").trim() ||
        (name || (username ? `@${username}` : id));

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

/* ================= SPIN (✅ history prize+winner always saved) ================= */
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
    const prize = randPick(bag);                 // ✅ prize string (e.g. "10000Ks")
    await redis.lrem(KEY_PRIZE_BAG, 1, String(prize));

    // winner -> move pool->winners
    await redis.srem(KEY_POOL_SET, String(winnerId));
    await redis.sadd(KEY_WINNERS_SET, String(winnerId));

    const h = await redis.hgetall(KEY_MEMBER_HASH(String(winnerId))).catch(() => ({}));
    const name = String(h?.name || "").trim();
    const username = String(h?.username || "").trim().replace("@", "");
    const display =
      String(h?.display || "").trim() ||
      (name || (username ? `@${username}` : String(winnerId)));

    // ✅ standard schema for history
    const item = {
      at: nowISO(),
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

/* ================= HISTORY (✅ normalize old entries) ================= */
app.get("/history", requireApiKey, async (req, res) => {
  try {
    const list = await redis.lrange(KEY_HISTORY_LIST, 0, 200);

    const history = (list || []).map((s) => {
      let obj = null;
      try { obj = JSON.parse(s); } catch { return { raw: s }; }

      const prize =
        String(obj?.prize ?? obj?.prize_name ?? obj?.prizeName ?? obj?.item ?? "-");

      const w = obj?.winner ?? obj?.member ?? obj?.user ?? {};
      const id = String(w?.id ?? obj?.winner_id ?? obj?.user_id ?? obj?.id ?? "-");
      const name = String(w?.name ?? "").trim();
      const username = String(w?.username ?? obj?.winner_username ?? obj?.username ?? "").replace("@", "").trim();

      const display =
        String(w?.display || "").trim() ||
        (name || (username ? `@${username}` : id));

      return {
        at: obj?.at || "",
        prize,
        winner: {
          id,
          name,
          username,
          display,
          dm_ready: String(w?.dm_ready || "0") === "1",
        },
      };
    });

    res.json({ ok: true, total: history.length, history });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ================= Restart Spin ================= */
app.post("/restart-spin", requireApiKey, async (req, res) => {
  try {
    await redis.del(KEY_WINNERS_SET);
    await redis.del(KEY_HISTORY_LIST);

    await redis.del(KEY_POOL_SET);

    const ids = (await redis.smembers(KEY_MEMBERS_SET)) || [];
    const cleanIds = ids.map(String).filter((id) => !isExcludedUser(id));

    const pipe = redis.pipeline();
    for (const id of cleanIds) pipe.hget(KEY_MEMBER_HASH(id), "active");
    const activeRes = await pipe.exec();

    const poolPipe = redis.pipeline();
    for (let i = 0; i < cleanIds.length; i++) {
      const id = cleanIds[i];
      const activeVal = activeRes?.[i]?.result;
      const active = String(activeVal ?? "1") === "1";
      if (active) poolPipe.sadd(KEY_POOL_SET, String(id));
    }
    await poolPipe.exec();

    const raw = await redis.get(KEY_PRIZE_SOURCE);
    if (raw) {
      const bag = parsePrizeTextExpand(raw);
      await redis.del(KEY_PRIZE_BAG);

      const bagPipe = redis.pipeline();
      for (const p of bag) bagPipe.rpush(KEY_PRIZE_BAG, String(p));
      await bagPipe.exec();
    }

    res.json({ ok: true, pool_rebuilt: true });
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

/* ================= Boot (kept same behavior) ================= */
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
  try {
    await boot();
  } catch (e) {
    console.error("Boot error:", e);
  }
});
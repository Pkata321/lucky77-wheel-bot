const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : null;

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing");
  process.exit(1);
}

// Redis
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// Keys
const KEY_MEMBERS = "lucky77:members"; // all members ever registered (objects)
const KEY_POOL = "lucky77:pool";       // current active pool (memberIds)

// ---------- Helpers ----------
async function getValue(key, fallback) {
  const v = await redis.get(key);
  if (v === null || v === undefined) return fallback;
  return v;
}
async function setValue(key, value) {
  await redis.set(key, value);
}

function isAdmin(msg) {
  if (!ADMIN_ID) return true;
  return String(msg.from?.id) === String(ADMIN_ID);
}

// build full name
function buildFullName(u) {
  return [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
}

// rule: name > username > id
function makeDisplay(u) {
  const fullName = buildFullName(u);
  if (fullName) return fullName;
  if (u.username) return `@${u.username}`;
  return String(u.id);
}

function normalizeMemberFromUser(u) {
  const fullName = buildFullName(u);
  const username = u.username ? String(u.username) : null;
  const id = String(u.id);

  return {
    id,
    username,               // without @
    fullName: fullName || null,
    display: fullName || (username ? `@${username}` : id),
    joinedAt: Date.now(),
  };
}

function uniqMemberUpsert(list, memberObj) {
  const idx = list.findIndex((m) => String(m.id) === String(memberObj.id));
  if (idx === -1) {
    list.push(memberObj);
  } else {
    // update display if new info available (e.g., later got username/fullName)
    const old = list[idx];
    const merged = {
      ...old,
      ...memberObj,
      joinedAt: old.joinedAt || memberObj.joinedAt,
    };
    // keep best display
    merged.display = makeBestDisplay(merged);
    list[idx] = merged;
  }
  return list;
}

function makeBestDisplay(m) {
  const fullName = (m.fullName || "").trim();
  if (fullName) return fullName;
  const uname = (m.username || "").trim();
  if (uname) return `@${uname}`;
  return String(m.id);
}

async function getMembers() {
  const v = await getValue(KEY_MEMBERS, []);
  return Array.isArray(v) ? v : (typeof v === "string" ? JSON.parse(v) : v);
}

async function saveMembers(members) {
  await setValue(KEY_MEMBERS, members);
}

async function getPoolIds() {
  const v = await getValue(KEY_POOL, []);
  return Array.isArray(v) ? v : (typeof v === "string" ? JSON.parse(v) : v);
}

async function savePoolIds(ids) {
  await setValue(KEY_POOL, ids);
}

function uniqPushId(list, id) {
  const s = String(id);
  if (!list.includes(s)) list.push(s);
  return list;
}

// ---------- Telegram ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// /start
bot.onText(/\/start/, async (msg) => {
  bot.sendMessage(msg.chat.id, "Bot is running ✅");
});

// ✅ Auto register new joiners
bot.on("new_chat_members", async (msg) => {
  try {
    const arr = msg.new_chat_members || [];
    if (!arr.length) return;

    let members = await getMembers();
    let poolIds = await getPoolIds();

    for (const u of arr) {
      const m = normalizeMemberFromUser(u);
      uniqMemberUpsert(members, m);
      uniqPushId(poolIds, m.id);
    }

    await saveMembers(members);
    await savePoolIds(poolIds);

    bot.sendMessage(
      msg.chat.id,
      `✅ Added ${arr.length} member(s)\nPool: ${poolIds.length}`
    );
  } catch (e) {
    console.error("new_chat_members error:", e);
  }
});

// ✅ Optional: existing member can self-register by typing /me
bot.onText(/\/me|\/register/, async (msg) => {
  try {
    const u = msg.from;
    const m = normalizeMemberFromUser(u);

    let members = await getMembers();
    let poolIds = await getPoolIds();

    uniqMemberUpsert(members, m);
    uniqPushId(poolIds, m.id);

    await saveMembers(members);
    await savePoolIds(poolIds);

    bot.sendMessage(msg.chat.id, `Registered ✅\n${makeBestDisplay(m)}\nPool: ${poolIds.length}`);
  } catch (e) {
    console.error("/me error:", e);
    bot.sendMessage(msg.chat.id, "Register error ❌");
  }
});

// /list (show pool displays)
bot.onText(/\/list/, async (msg) => {
  const members = await getMembers();
  const poolIds = await getPoolIds();
  if (!poolIds.length) return bot.sendMessage(msg.chat.id, "Pool empty");

  const lines = poolIds.map((id, i) => {
    const m = members.find((x) => String(x.id) === String(id));
    return `${i + 1}. ${m ? makeBestDisplay(m) : id}`;
  });

  bot.sendMessage(msg.chat.id, lines.join("\n"));
});

// /restart => bring everyone back to pool (admin)
bot.onText(/\/restart/, async (msg) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Admin only ❌");
  const members = await getMembers();
  const ids = members.map((m) => String(m.id));
  await savePoolIds(ids);
  bot.sendMessage(msg.chat.id, `Restarted ✅\nPool reset: ${ids.length}`);
});

// /clear => clear all (admin)
bot.onText(/\/clear/, async (msg) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Admin only ❌");
  await saveMembers([]);
  await savePoolIds([]);
  bot.sendMessage(msg.chat.id, "Cleared ✅");
});

// ---------- API for CodePen ----------
app.get("/", async (req, res) => {
  const poolIds = await getPoolIds();
  res.json({ ok: true, pool: poolIds.length });
});

// ✅ Members list (for Settings UI)
app.get("/members", async (req, res) => {
  const members = await getMembers();
  // return sorted by joinedAt asc
  members.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  res.json({ ok: true, count: members.length, members: members.map((m) => ({
    id: String(m.id),
    username: m.username ? `@${m.username}` : null,
    fullName: m.fullName || null,
    display: makeBestDisplay(m),
    joinedAt: m.joinedAt || null
  }))});
});

// ✅ Pool (resolved objects)
app.get("/pool", async (req, res) => {
  const members = await getMembers();
  const poolIds = await getPoolIds();

  const pool = poolIds.map((id) => {
    const m = members.find((x) => String(x.id) === String(id));
    return m
      ? { id: String(m.id), display: makeBestDisplay(m), username: m.username ? `@${m.username}` : null, fullName: m.fullName || null }
      : { id: String(id), display: String(id), username: null, fullName: null };
  });

  res.json({ ok: true, poolCount: pool.length, pool });
});

// ✅ Winner (pick random memberId from pool)
app.post("/winner", async (req, res) => {
  const members = await getMembers();
  const poolIds = await getPoolIds();
  if (!poolIds.length) return res.status(400).json({ ok: false, error: "Pool empty" });

  const idx = Math.floor(Math.random() * poolIds.length);
  const winnerId = poolIds[idx];

  poolIds.splice(idx, 1);
  await savePoolIds(poolIds);

  const m = members.find((x) => String(x.id) === String(winnerId));
  const winner = m
    ? { id: String(m.id), display: makeBestDisplay(m), username: m.username ? `@${m.username}` : null, fullName: m.fullName || null }
    : { id: String(winnerId), display: String(winnerId), username: null, fullName: null };

  res.json({ ok: true, winner, remaining: poolIds.length });
});

// ✅ Restart pool from all members
app.post("/restart", async (req, res) => {
  const members = await getMembers();
  const ids = members.map((m) => String(m.id));
  await savePoolIds(ids);
  res.json({ ok: true, poolCount: ids.length });
});

// Start
app.listen(PORT, () => console.log("Server running on port " + PORT));

process.on("SIGTERM", async () => {
  try {
    console.log("SIGTERM received. Shutting down...");
  } finally {
    process.exit(0);
  }
});

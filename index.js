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

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// ===== Redis Keys =====
const KEY_MEMBERS = "lucky77:members"; // array of member objects
const KEY_WINNERS = "lucky77:winners"; // array of winner records
const KEY_PRIZE_POOL = "lucky77:prize_pool"; // array of prize labels (expanded by count)
const KEY_PRIZE_PLAN = "lucky77:prize_plan"; // [{label,count}] stored for restart

// ===== Helpers =====
async function getJSON(key, fallback) {
  const v = await redis.get(key);
  if (!v) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }
  return v;
}
async function setJSON(key, value) {
  await redis.set(key, value);
}

function isAdmin(msg) {
  if (!ADMIN_ID) return true;
  return String(msg.from?.id) === String(ADMIN_ID);
}

function displayNameOf(member) {
  const full = [member.first_name, member.last_name].filter(Boolean).join(" ").trim();
  if (full) return full;
  if (member.username) return `@${member.username}`;
  return String(member.id);
}

function normalizeMember(tgUser) {
  return {
    id: String(tgUser.id),
    username: tgUser.username ? String(tgUser.username) : "",
    first_name: tgUser.first_name ? String(tgUser.first_name) : "",
    last_name: tgUser.last_name ? String(tgUser.last_name) : "",
    display: displayNameOf(tgUser),
    updatedAt: Date.now(),
  };
}

function upsertMember(list, tgUser) {
  const m = normalizeMember(tgUser);
  const idx = list.findIndex((x) => String(x.id) === String(m.id));
  if (idx >= 0) list[idx] = { ...list[idx], ...m };
  else list.push(m);
  return list;
}

// Prize pool build: [{label,count}] => ["10000Ks","10000Ks",...]
function buildPrizePool(prizePlan) {
  const pool = [];
  for (const p of prizePlan) {
    const label = String(p.label || "").trim();
    const count = Number(p.count || 0);
    if (!label || !Number.isFinite(count) || count <= 0) continue;
    for (let i = 0; i < count; i++) pool.push(label);
  }
  return pool;
}

// pop random item from array
function popRandom(arr) {
  if (!arr.length) return null;
  const idx = Math.floor(Math.random() * arr.length);
  const v = arr[idx];
  arr.splice(idx, 1);
  return v;
}

// ===== Telegram Bot =====
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// /start
bot.onText(/\/start/, async (msg) => {
  try {
    // also capture whoever sent message
    let members = await getJSON(KEY_MEMBERS, []);
    members = upsertMember(members, msg.from);
    await setJSON(KEY_MEMBERS, members);

    bot.sendMessage(msg.chat.id, "Bot is running ✅");
  } catch (e) {
    console.error("start error:", e);
  }
});

// new members join => store
bot.on("new_chat_members", async (msg) => {
  try {
    let members = await getJSON(KEY_MEMBERS, []);
    for (const u of msg.new_chat_members || []) {
      members = upsertMember(members, u);
    }
    await setJSON(KEY_MEMBERS, members);
  } catch (e) {
    console.error("new_chat_members error:", e);
  }
});

// also store any message sender (helps capture existing members who talk)
bot.on("message", async (msg) => {
  try {
    if (!msg.from) return;
    let members = await getJSON(KEY_MEMBERS, []);
    members = upsertMember(members, msg.from);
    await setJSON(KEY_MEMBERS, members);
  } catch (e) {}
});

// ===== API =====

// health
app.get("/", async (req, res) => {
  const members = await getJSON(KEY_MEMBERS, []);
  const prizePool = await getJSON(KEY_PRIZE_POOL, []);
  const winners = await getJSON(KEY_WINNERS, []);
  res.json({
    ok: true,
    members: members.length,
    prizesLeft: prizePool.length,
    winners: winners.length,
  });
});

// GET members
app.get("/members", async (req, res) => {
  const members = await getJSON(KEY_MEMBERS, []);
  // sort by updatedAt desc
  members.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json({ ok: true, members });
});

// GET winners history
app.get("/winners", async (req, res) => {
  const winners = await getJSON(KEY_WINNERS, []);
  res.json({ ok: true, winners });
});

// POST set prize plan (admin optional)
app.post("/prizes", async (req, res) => {
  const { prizes } = req.body || {};
  if (!Array.isArray(prizes)) {
    return res.status(400).json({ ok: false, error: "Send { prizes: [{label,count}] }" });
  }
  const plan = prizes
    .map((p) => ({ label: String(p.label || "").trim(), count: Number(p.count || 0) }))
    .filter((p) => p.label && Number.isFinite(p.count) && p.count > 0);

  const pool = buildPrizePool(plan);
  await setJSON(KEY_PRIZE_PLAN, plan);
  await setJSON(KEY_PRIZE_POOL, pool);

  res.json({ ok: true, planCount: plan.length, prizesTotal: pool.length });
});

// POST restart (reset prize pool + clear winners)
app.post("/restart", async (req, res) => {
  const plan = await getJSON(KEY_PRIZE_PLAN, []);
  const pool = buildPrizePool(plan);
  await setJSON(KEY_PRIZE_POOL, pool);
  await setJSON(KEY_WINNERS, []);
  res.json({ ok: true, prizesTotal: pool.length, winnersCleared: true });
});

// POST draw => consume 1 prize + pick 1 member not won before
app.post("/draw", async (req, res) => {
  const members = await getJSON(KEY_MEMBERS, []);
  const winners = await getJSON(KEY_WINNERS, []);
  const prizePool = await getJSON(KEY_PRIZE_POOL, []);

  if (!prizePool.length) {
    return res.status(400).json({ ok: false, error: "Prize pool empty. Set prizes or restart." });
  }
  if (!members.length) {
    return res.status(400).json({ ok: false, error: "No members yet. Let people join/send msg." });
  }

  const winnerIds = new Set(winners.map((w) => String(w.member?.id)));
  const eligible = members.filter((m) => !winnerIds.has(String(m.id)));

  if (!eligible.length) {
    return res.status(400).json({ ok: false, error: "All members already won. Restart spin." });
  }

  const prize = popRandom(prizePool);
  const member = eligible[Math.floor(Math.random() * eligible.length)];

  const record = {
    ts: Date.now(),
    prize,
    member: {
      id: String(member.id),
      username: member.username || "",
      first_name: member.first_name || "",
      last_name: member.last_name || "",
      display: member.display || displayNameOf(member),
    },
  };

  winners.unshift(record);

  await setJSON(KEY_PRIZE_POOL, prizePool);
  await setJSON(KEY_WINNERS, winners);

  res.json({
    ok: true,
    prize,
    member: record.member,
    prizesLeft: prizePool.length,
    winnersCount: winners.length,
  });
});

// Start server
app.listen(PORT, () => console.log("Server running on port " + PORT));

// Render graceful shutdown
process.on("SIGTERM", async () => {
  try {
    console.log("SIGTERM received. Shutting down...");
  } finally {
    process.exit(0);
  }
});

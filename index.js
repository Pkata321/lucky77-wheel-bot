const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors()); // ✅ IMPORTANT for CodePen fetch

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : null;
const PUBLIC_URL = process.env.PUBLIC_URL;

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!PUBLIC_URL) throw new Error("PUBLIC_URL missing");
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error("Upstash Redis env missing");
}

// =========================
// Redis
// =========================
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const KEY_MASTER = "lucky77:master";
const KEY_POOL = "lucky77:pool";

// =========================
// Helpers
// =========================
function buildMember(u) {
  const id = u?.id;
  const username = u?.username ? u.username : null;
  const full_name =
    [u?.first_name, u?.last_name].filter(Boolean).join(" ") || null;

  const display =
    username ? "@" + username : full_name ? full_name : String(id);

  return { id, username, full_name, display };
}

async function getArr(key) {
  const v = await redis.get(key);
  if (!v) return [];
  return Array.isArray(v) ? v : JSON.parse(v);
}

async function setArr(key, arr) {
  await redis.set(key, JSON.stringify(arr));
}

function upsertById(list, member) {
  const idx = list.findIndex((x) => String(x.id) === String(member.id));
  if (idx === -1) list.push(member);
  else list[idx] = member;
  return list;
}

function removeById(list, id) {
  return list.filter((x) => String(x.id) !== String(id));
}

function isAdmin(msg) {
  if (!ADMIN_ID) return true;
  return String(msg.from?.id) === String(ADMIN_ID);
}

// =========================
// Telegram Webhook Mode
// =========================
const bot = new TelegramBot(BOT_TOKEN);

(async () => {
  try {
    await bot.setWebHook(`${PUBLIC_URL}/telegram`);
    console.log("Webhook set to:", `${PUBLIC_URL}/telegram`);
  } catch (e) {
    console.error("Webhook error:", e.message);
  }
})();

app.post("/telegram", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// =========================
// Telegram Events
// =========================

// /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Bot is running ✅");
});

// New member joins group
bot.on("new_chat_members", async (msg) => {
  try {
    let master = await getArr(KEY_MASTER);
    let pool = await getArr(KEY_POOL);

    for (const u of msg.new_chat_members) {
      const m = buildMember(u);
      master = upsertById(master, m);
      pool = upsertById(pool, m);
    }

    await setArr(KEY_MASTER, master);
    await setArr(KEY_POOL, pool);
  } catch (e) {
    console.error("Join error:", e.message);
  }
});

// =========================
// API for CodePen
// =========================

// health
app.get("/", async (req, res) => {
  const pool = await getArr(KEY_POOL);
  res.json({ ok: true, poolCount: pool.length });
});

// get pool
app.get("/pool", async (req, res) => {
  const pool = await getArr(KEY_POOL);
  res.json({ ok: true, pool });
});

// pick winner (remove from pool only)
app.post("/winner", async (req, res) => {
  const pool = await getArr(KEY_POOL);

  if (!pool.length)
    return res.status(400).json({ ok: false, error: "Pool empty" });

  const idx = Math.floor(Math.random() * pool.length);
  const winner = pool[idx];

  pool.splice(idx, 1);
  await setArr(KEY_POOL, pool);

  res.json({ ok: true, winner, remaining: pool.length });
});

// restart pool from master
app.post("/restart", async (req, res) => {
  const master = await getArr(KEY_MASTER);
  await setArr(KEY_POOL, master);
  res.json({ ok: true, poolCount: master.length });
});

// clear all (admin)
bot.onText(/\/clear/, async (msg) => {
  if (!isAdmin(msg))
    return bot.sendMessage(msg.chat.id, "Admin only ❌");

  await setArr(KEY_MASTER, []);
  await setArr(KEY_POOL, []);
  bot.sendMessage(msg.chat.id, "Cleared ✅");
});

// =========================
// Start Server
// =========================
app.listen(PORT, () =>
  console.log("Server running on port " + PORT)
);

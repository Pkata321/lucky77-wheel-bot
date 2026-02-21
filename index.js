const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(cors());              // ✅ CodePen fetch() အတွက် CORS
app.use(express.json());

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : null;

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Webhook အတွက် (Render URL)
const PUBLIC_URL = process.env.PUBLIC_URL; // e.g. https://lucky77-wheel-bot.onrender.com

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing");
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.error("PUBLIC_URL missing (for webhook). Set PUBLIC_URL in Render env.");
  process.exit(1);
}

// Redis client
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// Keys
const KEY_MASTER = "lucky77:master"; // all members ever joined / added
const KEY_POOL = "lucky77:pool";     // current spin pool

// Helpers
async function getList(key) {
  const v = await redis.get(key);
  if (!v) return [];
  return Array.isArray(v) ? v : (typeof v === "string" ? JSON.parse(v) : v);
}

async function setList(key, list) {
  await redis.set(key, list);
}

// ✅ full info store (id + username + fullName)
function normalizeMember(m) {
  const id = m?.id ? String(m.id) : "";
  const username = m?.username ? String(m.username) : ""; // without @
  const fullName = [m?.first_name, m?.last_name].filter(Boolean).join(" ").trim();

  // display name priority: @username > fullName > id
  const display = username ? `@${username}` : (fullName || id);

  return { id, username, fullName, display };
}

function upsertUnique(list, memberObj) {
  if (!memberObj?.id) return list;
  const exists = list.find((x) => String(x.id) === String(memberObj.id));
  if (exists) return list;
  list.push(memberObj);
  return list;
}

function isAdmin(msg) {
  if (!ADMIN_ID) return true; // if not set, allow
  return String(msg.from?.id) === String(ADMIN_ID);
}

// Telegram bot (Webhook mode)
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

// Webhook endpoint
app.post("/telegram", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Set webhook on start
(async () => {
  const hookUrl = `${PUBLIC_URL.replace(/\/$/, "")}/telegram`;
  try {
    await bot.setWebHook(hookUrl);
    console.log("Webhook set to:", hookUrl);
  } catch (e) {
    console.error("Failed to set webhook:", e);
  }
})();

// ===== Telegram Commands =====

// /start
bot.onText(/\/start/, async (msg) => {
  bot.sendMessage(msg.chat.id, "Bot is running ✅");
});

// Group join => auto add to master + pool
bot.on("new_chat_members", async (msg) => {
  try {
    const members = msg.new_chat_members || [];
    let master = await getList(KEY_MASTER);
    let pool = await getList(KEY_POOL);

    for (const m of members) {
      const memberObj = normalizeMember(m);
      upsertUnique(master, memberObj);
      upsertUnique(pool, memberObj);
    }

    await setList(KEY_MASTER, master);
    await setList(KEY_POOL, pool);
  } catch (e) {
    console.error("new_chat_members error:", e);
  }
});

// /list (pool)
bot.onText(/\/list/, async (msg) => {
  const pool = await getList(KEY_POOL);
  if (pool.length === 0) return bot.sendMessage(msg.chat.id, "List empty");

  bot.sendMessage(
    msg.chat.id,
    pool.map((u, i) => `${i + 1}. ${u.display} (id:${u.id})`).join("\n")
  );
});

// /pick (pick winner and remove from pool only)
bot.onText(/\/pick/, async (msg) => {
  const pool = await getList(KEY_POOL);
  if (pool.length === 0) return bot.sendMessage(msg.chat.id, "List empty");

  const idx = Math.floor(Math.random() * pool.length);
  const winner = pool[idx];

  pool.splice(idx, 1);
  await setList(KEY_POOL, pool);

  bot.sendMessage(msg.chat.id, `🎉 Winner: ${winner.display}\nRemaining: ${pool.length}`);
});

// /restart (admin) => pool = master
bot.onText(/\/restart/, async (msg) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Admin only ❌");

  const master = await getList(KEY_MASTER);
  await setList(KEY_POOL, master);
  bot.sendMessage(msg.chat.id, `Restarted ✅\nPool reset (${master.length})`);
});

// /clear (admin) => clear master + pool
bot.onText(/\/clear/, async (msg) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Admin only ❌");

  await setList(KEY_MASTER, []);
  await setList(KEY_POOL, []);
  bot.sendMessage(msg.chat.id, "Cleared ✅");
});

// ===== API (for CodePen to call) =====

// health
app.get("/", async (req, res) => {
  const pool = await getList(KEY_POOL);
  res.json({ ok: true, poolCount: pool.length });
});

// GET /pool => current pool list
app.get("/pool", async (req, res) => {
  const pool = await getList(KEY_POOL);
  res.json({ ok: true, pool });
});

// POST /winner => pick winner and remove from pool
app.post("/winner", async (req, res) => {
  const pool = await getList(KEY_POOL);
  if (pool.length === 0) return res.status(400).json({ ok: false, error: "Pool empty" });

  const idx = Math.floor(Math.random() * pool.length);
  const winner = pool[idx];

  pool.splice(idx, 1);
  await setList(KEY_POOL, pool);

  res.json({ ok: true, winner, remaining: pool.length });
});

// POST /restart => pool = master
app.post("/restart", async (req, res) => {
  const master = await getList(KEY_MASTER);
  await setList(KEY_POOL, master);
  res.json({ ok: true, poolCount: master.length });
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

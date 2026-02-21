const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

const app = express();
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
  // Upstash can return object/array depending on how stored
  return Array.isArray(v) ? v : (typeof v === "string" ? JSON.parse(v) : v);
}

async function setList(key, list) {
  await redis.set(key, list);
}

function uniqPush(list, item) {
  const s = String(item || "").trim();
  if (!s) return list;
  if (!list.includes(s)) list.push(s);
  return list;
}

function isAdmin(msg) {
  if (!ADMIN_ID) return true; // if not set, allow
  return String(msg.from?.id) === String(ADMIN_ID);
}

// Telegram polling
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

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
      const name =
        m.username ? `@${m.username}` : [m.first_name, m.last_name].filter(Boolean).join(" ");
      uniqPush(master, name);
      uniqPush(pool, name);
    }

    await setList(KEY_MASTER, master);
    await setList(KEY_POOL, pool);
  } catch (e) {
    console.error("new_chat_members error:", e);
  }
});

// /add Name
bot.onText(/\/add (.+)/, async (msg, match) => {
  const name = String(match[1] || "").trim();
  if (!name) return bot.sendMessage(msg.chat.id, "Usage: /add name");

  const master = await getList(KEY_MASTER);
  const pool = await getList(KEY_POOL);

  uniqPush(master, name);
  uniqPush(pool, name);

  await setList(KEY_MASTER, master);
  await setList(KEY_POOL, pool);

  bot.sendMessage(msg.chat.id, `Added: ${name}\nTotal pool: ${pool.length}`);
});

// /addmany A,B,C
bot.onText(/\/addmany (.+)/, async (msg, match) => {
  const raw = String(match[1] || "").trim();
  if (!raw) return bot.sendMessage(msg.chat.id, "Usage: /addmany Name1, Name2, Name3");

  const names = raw.split(",").map((x) => x.trim()).filter(Boolean);

  const master = await getList(KEY_MASTER);
  const pool = await getList(KEY_POOL);

  names.forEach((n) => {
    uniqPush(master, n);
    uniqPush(pool, n);
  });

  await setList(KEY_MASTER, master);
  await setList(KEY_POOL, pool);

  bot.sendMessage(msg.chat.id, `Added ${names.length} people.\nTotal pool: ${pool.length}`);
});

// /list (pool)
bot.onText(/\/list/, async (msg) => {
  const pool = await getList(KEY_POOL);
  if (pool.length === 0) return bot.sendMessage(msg.chat.id, "List empty");

  bot.sendMessage(
    msg.chat.id,
    pool.map((n, i) => `${i + 1}. ${n}`).join("\n")
  );
});

// /pick (pick winner and remove from pool only)
bot.onText(/\/pick/, async (msg) => {
  const pool = await getList(KEY_POOL);
  if (pool.length === 0) return bot.sendMessage(msg.chat.id, "List empty");

  const idx = Math.floor(Math.random() * pool.length);
  const winner = pool[idx];

  // remove from pool only (master stays)
  pool.splice(idx, 1);
  await setList(KEY_POOL, pool);

  bot.sendMessage(msg.chat.id, `🎉 Winner: ${winner}\nRemaining: ${pool.length}`);
});

// /remove Name (remove from pool only)
bot.onText(/\/remove (.+)/, async (msg, match) => {
  const name = String(match[1] || "").trim();
  if (!name) return bot.sendMessage(msg.chat.id, "Usage: /remove name");

  const pool = await getList(KEY_POOL);
  const before = pool.length;
  const afterList = pool.filter((x) => x !== name);

  await setList(KEY_POOL, afterList);

  bot.sendMessage(msg.chat.id, `Removed: ${name}\n${before} -> ${afterList.length}`);
});

// /clear (admin optional) => clear pool + master
bot.onText(/\/clear/, async (msg) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Admin only ❌");

  await setList(KEY_MASTER, []);
  await setList(KEY_POOL, []);
  bot.sendMessage(msg.chat.id, "Cleared ✅");
});

// /restart (admin optional) => pool = master (bring names back after prize time)
bot.onText(/\/restart/, async (msg) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Admin only ❌");

  const master = await getList(KEY_MASTER);
  await setList(KEY_POOL, master);
  bot.sendMessage(msg.chat.id, `Restarted ✅\nPool reset to master (${master.length})`);
});

// ===== API (for CodePen to call) =====

// health
app.get("/", async (req, res) => {
  const pool = await getList(KEY_POOL);
  res.json({ ok: true, pool: pool.length });
});

// GET /pool => current pool list
app.get("/pool", async (req, res) => {
  const pool = await getList(KEY_POOL);
  res.json({ ok: true, pool });
});

// POST /pool body: { name: "Aung" } OR { names: ["Aung","Kyaw"] }
app.post("/pool", async (req, res) => {
  const { name, names } = req.body || {};
  let added = [];

  const master = await getList(KEY_MASTER);
  const pool = await getList(KEY_POOL);

  if (typeof name === "string" && name.trim()) {
    const n = name.trim();
    uniqPush(master, n);
    uniqPush(pool, n);
    added = [n];
  } else if (Array.isArray(names) && names.length) {
    const clean = names.map((x) => String(x).trim()).filter(Boolean);
    clean.forEach((n) => {
      uniqPush(master, n);
      uniqPush(pool, n);
    });
    added = clean;
  } else {
    return res.status(400).json({ ok: false, error: "Send {name} or {names:[...]}" });
  }

  await setList(KEY_MASTER, master);
  await setList(KEY_POOL, pool);

  res.json({ ok: true, added, poolCount: pool.length });
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

// Start
app.listen(PORT, () => console.log("Server running on port " + PORT));

// Render graceful shutdown
process.on("SIGTERM", async () => {
  try {
    console.log("SIGTERM received. Shutting down...");
  } finally {
    process.exit(0);
  }
});

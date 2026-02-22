const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

const app = express();

// ✅ CORS for CodePen / any frontend
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;

// optional admin
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : null;

// ✅ Upstash
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ✅ PUBLIC URL for webhook (set this in Render env)
// Example: https://lucky77-wheel-bot.onrender.com
const PUBLIC_URL =
  (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing");
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.error("PUBLIC_URL missing (set PUBLIC_URL in Render env)");
  process.exit(1);
}

// Redis client
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// Keys
const KEY_MASTER = "lucky77:master"; // all members ever joined / added (objects)
const KEY_POOL = "lucky77:pool"; // current pool (objects)

// Helpers
async function getList(key) {
  const v = await redis.get(key);
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return [];
    }
  }
  return v;
}

async function setList(key, list) {
  await redis.set(key, list);
}

function isAdmin(msg) {
  if (!ADMIN_ID) return true;
  return String(msg.from?.id) === String(ADMIN_ID);
}

// ✅ normalize telegram user => object
function normalizeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username || null,
    first_name: u.first_name || null,
    last_name: u.last_name || null,
  };
}

// ✅ unique push by id
function uniqPushUser(list, userObj) {
  if (!userObj || !userObj.id) return list;
  const exists = list.some((x) => String(x?.id) === String(userObj.id));
  if (!exists) list.push(userObj);
  return list;
}

// ✅ convert old string items -> objects (migration safety)
function normalizeListToUsers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => {
      if (!x) return null;
      if (typeof x === "object" && x.id) return x;
      if (typeof x === "string") {
        // old data fallback (no id)
        return { id: "legacy:" + x, username: null, first_name: x, last_name: null };
      }
      return null;
    })
    .filter(Boolean);
}

// =========================
// Telegram Bot (Webhook mode)
// =========================
const bot = new TelegramBot(BOT_TOKEN); // ✅ no polling

// Telegram webhook endpoint
app.post("/telegram", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Set webhook on startup
async function setupWebhook() {
  const webhookUrl = `${PUBLIC_URL}/telegram`;
  try {
    await bot.setWebHook(webhookUrl);
    console.log("Webhook set to:", webhookUrl);
  } catch (e) {
    console.error("setWebHook error:", e?.message || e);
  }
}

// ===== Telegram Commands =====

// /start
bot.onText(/\/start/, async (msg) => {
  bot.sendMessage(msg.chat.id, "Bot is running ✅");
});

// Group join => add to master + pool (object saved)
bot.on("new_chat_members", async (msg) => {
  try {
    const members = msg.new_chat_members || [];

    let master = normalizeListToUsers(await getList(KEY_MASTER));
    let pool = normalizeListToUsers(await getList(KEY_POOL));

    for (const m of members) {
      const u = normalizeUser(m);
      uniqPushUser(master, u);
      uniqPushUser(pool, u);
    }

    await setList(KEY_MASTER, master);
    await setList(KEY_POOL, pool);
  } catch (e) {
    console.error("new_chat_members error:", e);
  }
});

// /add (admin optional) => add replied user OR self
// ✅ best way to add exact id/username/name
bot.onText(/\/add$/, async (msg) => {
  try {
    if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Admin only ❌");

    const target = msg.reply_to_message?.from || msg.from;
    const u = normalizeUser(target);

    let master = normalizeListToUsers(await getList(KEY_MASTER));
    let pool = normalizeListToUsers(await getList(KEY_POOL));

    uniqPushUser(master, u);
    uniqPushUser(pool, u);

    await setList(KEY_MASTER, master);
    await setList(KEY_POOL, pool);

    bot.sendMessage(msg.chat.id, `Added ✅\nPool: ${pool.length}`);
  } catch (e) {
    console.error("/add error:", e);
  }
});

// /remove (admin) => remove replied user OR by id
bot.onText(/\/remove(?:\s+(.+))?/, async (msg, match) => {
  try {
    if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Admin only ❌");

    const byReply = msg.reply_to_message?.from;
    const raw = (match && match[1] ? String(match[1]) : "").trim();

    let pool = normalizeListToUsers(await getList(KEY_POOL));
    const before = pool.length;

    if (byReply?.id) {
      pool = pool.filter((x) => String(x.id) !== String(byReply.id));
    } else if (raw) {
      // allow remove by numeric id
      pool = pool.filter((x) => String(x.id) !== String(raw));
    } else {
      return bot.sendMessage(msg.chat.id, "Usage: reply user with /remove OR /remove <id>");
    }

    await setList(KEY_POOL, pool);
    bot.sendMessage(msg.chat.id, `Removed ✅\n${before} -> ${pool.length}`);
  } catch (e) {
    console.error("/remove error:", e);
  }
});

// /list (pool)
bot.onText(/\/list/, async (msg) => {
  try {
    const pool = normalizeListToUsers(await getList(KEY_POOL));
    if (!pool.length) return bot.sendMessage(msg.chat.id, "Pool empty");

    const lines = pool.map((u, i) => {
      const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
      const name = full || (u.username ? `@${u.username}` : `ID:${u.id}`);
      return `${i + 1}. ${name}`;
    });

    bot.sendMessage(msg.chat.id, lines.join("\n"));
  } catch (e) {
    console.error("/list error:", e);
  }
});

// /restart (admin) => pool = master
bot.onText(/\/restart/, async (msg) => {
  try {
    if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Admin only ❌");

    const master = normalizeListToUsers(await getList(KEY_MASTER));
    await setList(KEY_POOL, master);

    bot.sendMessage(msg.chat.id, `Restarted ✅\nPool: ${master.length}`);
  } catch (e) {
    console.error("/restart error:", e);
  }
});

// /clear (admin) => clear both
bot.onText(/\/clear/, async (msg) => {
  try {
    if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Admin only ❌");

    await setList(KEY_MASTER, []);
    await setList(KEY_POOL, []);
    bot.sendMessage(msg.chat.id, "Cleared ✅");
  } catch (e) {
    console.error("/clear error:", e);
  }
});

// =========================
// API for CodePen
// =========================

// health
app.get("/", async (req, res) => {
  const pool = normalizeListToUsers(await getList(KEY_POOL));
  res.json({ ok: true, poolCount: pool.length });
});

// GET /pool => current pool list (objects)
app.get("/pool", async (req, res) => {
  const pool = normalizeListToUsers(await getList(KEY_POOL));
  res.json({ ok: true, pool });
});

// POST /restart => pool = master (for UI restart button)
app.post("/restart", async (req, res) => {
  const master = normalizeListToUsers(await getList(KEY_MASTER));
  await setList(KEY_POOL, master);
  res.json({ ok: true, poolCount: master.length });
});

// Start server
app.listen(PORT, async () => {
  console.log("Server running on port " + PORT);
  await setupWebhook();
});

// Render graceful shutdown
process.on("SIGTERM", async () => {
  try {
    console.log("SIGTERM received. Shutting down...");
  } finally {
    process.exit(0);
  }
});

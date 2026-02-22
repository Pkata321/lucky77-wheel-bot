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

// If you set PUBLIC_URL on Render => webhook mode
// Example: https://lucky77-wheel-bot.onrender.com   (NO trailing slash)
const PUBLIC_URL = process.env.PUBLIC_URL ? String(process.env.PUBLIC_URL).trim() : "";

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

// Keys
const KEY_MASTER = "lucky77:master_members"; // all members ever joined / added
const KEY_POOL = "lucky77:pool_members";     // current pool members
const KEY_WIN_HISTORY = "lucky77:winner_history"; // optional history list

// ---------- Helpers ----------
function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function getList(key) {
  const v = await redis.get(key);
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const parsed = safeJsonParse(v);
    return Array.isArray(parsed) ? parsed : [];
  }
  // if it's an object or something unexpected
  return [];
}

async function setList(key, list) {
  await redis.set(key, list);
}

function normalizeMember(tgUser) {
  const id = tgUser?.id ? String(tgUser.id) : "";
  const username = tgUser?.username ? String(tgUser.username) : "";
  const fullName = [tgUser?.first_name, tgUser?.last_name].filter(Boolean).join(" ").trim();

  // Display priority: Full Name > @username > id
  const display =
    fullName || (username ? `@${username}` : "") || (id ? `id:${id}` : "unknown");

  return { id, username, fullName, display };
}

function memberKey(m) {
  // unique key for de-dup
  return String(m?.id || m?.username || m?.display || "").trim();
}

function uniqPushMember(list, memberObj) {
  const k = memberKey(memberObj);
  if (!k) return list;

  const exists = list.some((x) => memberKey(x) === k);
  if (!exists) list.push(memberObj);
  return list;
}

function isAdmin(msg) {
  if (!ADMIN_ID) return true; // if not set, allow
  return String(msg.from?.id) === String(ADMIN_ID);
}

function pickRandom(list) {
  if (!list || list.length === 0) return { item: null, index: -1 };
  const index = Math.floor(Math.random() * list.length);
  return { item: list[index], index };
}

// ---------- Telegram Bot ----------
let bot;

// Webhook route (Telegram will POST updates here)
app.post("/telegram", async (req, res) => {
  try {
    if (bot) bot.processUpdate(req.body);
    return res.sendStatus(200);
  } catch (e) {
    console.error("processUpdate error:", e);
    return res.sendStatus(200);
  }
});

async function initBot() {
  const useWebhook = !!PUBLIC_URL;

  if (useWebhook) {
    bot = new TelegramBot(BOT_TOKEN, { webHook: true });

    const webhookUrl = `${PUBLIC_URL.replace(/\/$/, "")}/telegram`;
    await bot.setWebHook(webhookUrl);

    console.log("Webhook set to:", webhookUrl);
  } else {
    // Local dev mode
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log("Polling mode enabled (PUBLIC_URL not set)");
  }

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
        uniqPushMember(master, memberObj);
        uniqPushMember(pool, memberObj);
      }

      await setList(KEY_MASTER, master);
      await setList(KEY_POOL, pool);
    } catch (e) {
      console.error("new_chat_members error:", e);
    }
  });

  // /add Name (manual add - creates "fake member" object)
  bot.onText(/\/add (.+)/, async (msg, match) => {
    const name = String(match[1] || "").trim();
    if (!name) return bot.sendMessage(msg.chat.id, "Usage: /add name");

    const master = await getList(KEY_MASTER);
    const pool = await getList(KEY_POOL);

    // if user manually adds, we store as display-only (no id)
    const memberObj = { id: "", username: "", fullName: name, display: name };

    uniqPushMember(master, memberObj);
    uniqPushMember(pool, memberObj);

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
      const memberObj = { id: "", username: "", fullName: n, display: n };
      uniqPushMember(master, memberObj);
      uniqPushMember(pool, memberObj);
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
      pool.map((m, i) => `${i + 1}. ${m.display || "unknown"}`).join("\n")
    );
  });

  // /pick (pick random member and remove from pool only)
  bot.onText(/\/pick/, async (msg) => {
    const pool = await getList(KEY_POOL);
    if (pool.length === 0) return bot.sendMessage(msg.chat.id, "List empty");

    const { item: winner, index } = pickRandom(pool);
    pool.splice(index, 1);
    await setList(KEY_POOL, pool);

    bot.sendMessage(msg.chat.id, `🎉 Winner: ${winner.display}\nRemaining: ${pool.length}`);
  });

  // /remove Name (remove by display match)
  bot.onText(/\/remove (.+)/, async (msg, match) => {
    const name = String(match[1] || "").trim();
    if (!name) return bot.sendMessage(msg.chat.id, "Usage: /remove name");

    const pool = await getList(KEY_POOL);
    const before = pool.length;

    const afterList = pool.filter((m) => (m.display || "") !== name);
    await setList(KEY_POOL, afterList);

    bot.sendMessage(msg.chat.id, `Removed: ${name}\n${before} -> ${afterList.length}`);
  });

  // /clear (admin) => clear pool + master + history
  bot.onText(/\/clear/, async (msg) => {
    if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Admin only ❌");

    await setList(KEY_MASTER, []);
    await setList(KEY_POOL, []);
    await setList(KEY_WIN_HISTORY, []);
    bot.sendMessage(msg.chat.id, "Cleared ✅");
  });

  // /restart (admin) => pool = master
  bot.onText(/\/restart/, async (msg) => {
    if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Admin only ❌");

    const master = await getList(KEY_MASTER);
    await setList(KEY_POOL, master);
    bot.sendMessage(msg.chat.id, `Restarted ✅\nPool reset to master (${master.length})`);
  });
}

// ---------- API (CodePen fetch) ----------
app.get("/", async (req, res) => {
  const pool = await getList(KEY_POOL);
  res.json({ ok: true, poolCount: pool.length });
});

// Current member pool
app.get("/pool", async (req, res) => {
  const pool = await getList(KEY_POOL);
  res.json({ ok: true, pool });
});

// Pick random member (option remove=true to remove from pool)
app.post("/member/pick", async (req, res) => {
  const { remove } = req.body || {};
  const pool = await getList(KEY_POOL);
  if (pool.length === 0) return res.status(400).json({ ok: false, error: "Pool empty" });

  const { item: winner, index } = pickRandom(pool);

  if (remove) {
    pool.splice(index, 1);
    await setList(KEY_POOL, pool);
  }

  res.json({ ok: true, winner, remaining: pool.length });
});

// Restart pool from master
app.post("/restart", async (req, res) => {
  const master = await getList(KEY_MASTER);
  await setList(KEY_POOL, master);
  res.json({ ok: true, poolCount: master.length });
});

// Winner history (optional)
app.get("/history", async (req, res) => {
  const h = await getList(KEY_WIN_HISTORY);
  res.json({ ok: true, history: h });
});

// Save a winner history record (CodePen can call this after prize+winner)
app.post("/history", async (req, res) => {
  const { prize, winner } = req.body || {};
  const h = await getList(KEY_WIN_HISTORY);
  h.unshift({
    ts: Date.now(),
    prize: String(prize || "").trim(),
    winner: winner || null,
  });
  await setList(KEY_WIN_HISTORY, h.slice(0, 200));
  res.json({ ok: true });
});

// Start server
app.listen(PORT, async () => {
  console.log("Server running on port " + PORT);
  try {
    await initBot();
  } catch (e) {
    console.error("initBot error:", e);
  }
});

// Render graceful shutdown
process.on("SIGTERM", async () => {
  try {
    console.log("SIGTERM received. Shutting down...");
  } finally {
    process.exit(0);
  }
});

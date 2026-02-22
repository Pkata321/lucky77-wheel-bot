"use strict";

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PUBLIC_URL =
  process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "";

const API_KEY = process.env.API_KEY ? String(process.env.API_KEY) : "";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("Redis env missing");
  process.exit(1);
}

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const bot = new TelegramBot(BOT_TOKEN);

if (PUBLIC_URL) {
  bot.setWebHook(`${PUBLIC_URL}/telegram-webhook`);
  console.log("Webhook set:", `${PUBLIC_URL}/telegram-webhook`);
}

// =======================
// Redis Keys
// =======================
const KEY_MASTER = "lucky77:members:master";
const KEY_POOL = "lucky77:members:pool";
const KEY_PRIZE_CONFIG = "lucky77:prizes:config";
const KEY_PRIZE_REMAIN = "lucky77:prizes:remain";
const KEY_HISTORY = "lucky77:history";

// =======================
// Utils
// =======================
function now() {
  return new Date().toISOString();
}

function requireApiKey(req, res) {
  if (!API_KEY) return true;
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) {
    res.status(403).json({ ok: false, error: "Forbidden" });
    return false;
  }
  return true;
}

async function getJSON(key, fallback) {
  const v = await redis.get(key);
  return v || fallback;
}

async function setJSON(key, val) {
  await redis.set(key, val);
}

function normalizeUser(u) {
  const id = String(u.id);
  const username = u.username ? String(u.username) : null;
  const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();

  const display = full || (username ? `@${username}` : id);

  return { id, username, full_name: full || null, display };
}

function uniqPush(arr, obj) {
  if (!arr.find((x) => x.id === obj.id)) arr.push(obj);
  return arr;
}

// =======================
// Telegram Webhook
// =======================
app.post("/telegram-webhook", async (req, res) => {
  try {
    const update = req.body;

    if (update.message?.new_chat_members) {
      let master = await getJSON(KEY_MASTER, []);
      let pool = await getJSON(KEY_POOL, []);

      for (const m of update.message.new_chat_members) {
        const user = normalizeUser(m);
        uniqPush(master, user);
        uniqPush(pool, user);
      }

      await setJSON(KEY_MASTER, master);
      await setJSON(KEY_POOL, pool);
    }

    await bot.processUpdate(update);
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

// =======================
// API Routes
// =======================

app.get("/", (req, res) => {
  res.json({ ok: true, time: now() });
});

// Members
app.get("/members", async (req, res) => {
  const master = await getJSON(KEY_MASTER, []);
  res.json({ ok: true, members: master });
});

app.get("/pool", async (req, res) => {
  const pool = await getJSON(KEY_POOL, []);
  res.json({ ok: true, pool });
});

// Prize Config
app.get("/prizes", async (req, res) => {
  const config = await getJSON(KEY_PRIZE_CONFIG, []);
  const remain = await getJSON(KEY_PRIZE_REMAIN, {});
  res.json({ ok: true, config, remain });
});

app.post("/prizes", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { prizes } = req.body;
  if (!Array.isArray(prizes) || !prizes.length)
    return res.json({ ok: false });

  const remain = {};
  prizes.forEach((p) => {
    remain[p.label] = p.count;
  });

  await setJSON(KEY_PRIZE_CONFIG, prizes);
  await setJSON(KEY_PRIZE_REMAIN, remain);

  res.json({ ok: true });
});

// Spin
app.post("/spin", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const pool = await getJSON(KEY_POOL, []);
  const config = await getJSON(KEY_PRIZE_CONFIG, []);
  const remain = await getJSON(KEY_PRIZE_REMAIN, {});
  const history = await getJSON(KEY_HISTORY, []);

  if (!pool.length)
    return res.json({ ok: false, error: "No members left" });

  const availablePrizes = config.filter(
    (p) => remain[p.label] > 0
  );

  if (!availablePrizes.length)
    return res.json({ ok: false, error: "No prizes left" });

  const prize =
    availablePrizes[Math.floor(Math.random() * availablePrizes.length)];

  const winner =
    pool[Math.floor(Math.random() * pool.length)];

  // update
  remain[prize.label] -= 1;
  const newPool = pool.filter((m) => m.id !== winner.id);

  history.unshift({
    ts: now(),
    prize: prize.label,
    winner,
  });

  await setJSON(KEY_PRIZE_REMAIN, remain);
  await setJSON(KEY_POOL, newPool);
  await setJSON(KEY_HISTORY, history.slice(0, 100));

  res.json({
    ok: true,
    prize: prize.label,
    winner,
  });
});

// Restart
app.post("/restart", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const master = await getJSON(KEY_MASTER, []);
  const config = await getJSON(KEY_PRIZE_CONFIG, []);

  const remain = {};
  config.forEach((p) => (remain[p.label] = p.count));

  await setJSON(KEY_POOL, master);
  await setJSON(KEY_PRIZE_REMAIN, remain);
  await setJSON(KEY_HISTORY, []);

  res.json({ ok: true });
});

// History
app.get("/history", async (req, res) => {
  const history = await getJSON(KEY_HISTORY, []);
  res.json({ ok: true, history });
});

// =======================
app.listen(PORT, () =>
  console.log("Server running on port", PORT)
);

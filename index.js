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

// IMPORTANT: set this to your Render public URL (no trailing slash)
// example: https://lucky77-wheel-bot.onrender.com
const PUBLIC_URL = process.env.PUBLIC_URL;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error("UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing");
}
if (!PUBLIC_URL) throw new Error("PUBLIC_URL missing");

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

// Keys
const KEY_MASTER = "lucky77:master"; // array of member objects (all-time)
const KEY_POOL = "lucky77:pool";     // array of member objects (spin pool)

// ---------- helpers ----------
function buildMember(u) {
  const id = u?.id;
  const username = u?.username ? `@${u.username}` : null;
  const full_name = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || null;
  const display = username || full_name || String(id);
  return { id, username, full_name, display };
}

function isAdmin(msg) {
  if (!ADMIN_ID) return true;
  return String(msg.from?.id) === String(ADMIN_ID);
}

async function getArr(key) {
  const v = await redis.get(key);
  if (!v) return [];
  return Array.isArray(v) ? v : (typeof v === "string" ? JSON.parse(v) : v);
}

async function setArr(key, arr) {
  await redis.set(key, arr);
}

function upsertById(list, member) {
  if (!member?.id) return list;
  const idx = list.findIndex((x) => String(x?.id) === String(member.id));
  if (idx === -1) list.push(member);
  else list[idx] = { ...list[idx], ...member }; // refresh name/username if changed
  return list;
}

function removeById(list, id) {
  return list.filter((x) => String(x?.id) !== String(id));
}

// ---------- Telegram bot (WEBHOOK MODE) ----------
const bot = new TelegramBot(BOT_TOKEN);

// set webhook on boot (idempotent)
(async () => {
  const hookUrl = `${PUBLIC_URL}/telegram`;
  try {
    await bot.setWebHook(hookUrl);
    console.log("Webhook set to:", hookUrl);
  } catch (e) {
    console.error("setWebHook error:", e?.message || e);
  }
})();

// Telegram webhook endpoint
app.post("/telegram", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// /start
bot.onText(/\/start/, async (msg) => {
  bot.sendMessage(msg.chat.id, "Bot is running ✅");
});

// Group join => auto add to master + pool (store full info)
bot.on("new_chat_members", async (msg) => {
  try {
    const members = msg.new_chat_members || [];
    let master = await getArr(KEY_MASTER);
    let pool = await getArr(KEY_POOL);

    for (const u of members) {
      const m = buildMember(u);
      upsertById(master, m);
      upsertById(pool, m);
    }

    await setArr(KEY_MASTER, master);
    await setArr(KEY_POOL, pool);
  } catch (e) {
    console.error("new_chat_members error:", e?.message || e);
  }
});

// /list => show pool display list
bot.onText(/\/list/, async (msg) => {
  const pool = await getArr(KEY_POOL);
  if (!pool.length) return bot.sendMessage(msg.chat.id, "List empty");

  bot.sendMessage(
    msg.chat.id,
    pool.map((m, i) => `${i + 1}. ${m.display}`).join("\n")
  );
});

// /pick => pick winner and REMOVE from pool only (master stays)
bot.onText(/\/pick/, async (msg) => {
  const pool = await getArr(KEY_POOL);
  if (!pool.length) return bot.sendMessage(msg.chat.id, "List empty");

  const idx = Math.floor(Math.random() * pool.length);
  const winner = pool[idx];

  pool.splice(idx, 1);
  await setArr(KEY_POOL, pool);

  bot.sendMessage(
    msg.chat.id,
    `🎉 Winner: ${winner.display}\nRemaining: ${pool.length}\n(ID: ${winner.id}${winner.username ? `, ${winner.username}` : ""})`
  );
});

// /restart => pool = master (bring everyone back after prize time)
bot.onText(/\/restart/, async (msg) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Admin only ❌");
  const master = await getArr(KEY_MASTER);
  await setArr(KEY_POOL, master);
  bot.sendMessage(msg.chat.id, `Restarted ✅\nPool reset (${master.length})`);
});

// /clear => clear both (admin)
bot.onText(/\/clear/, async (msg) => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "Admin only ❌");
  await setArr(KEY_MASTER, []);
  await setArr(KEY_POOL, []);
  bot.sendMessage(msg.chat.id, "Cleared ✅");
});

// ---------- API for CodePen ----------
app.get("/", async (req, res) => {
  const pool = await getArr(KEY_POOL);
  res.json({ ok: true, pool: pool.length });
});

app.get("/pool", async (req, res) => {
  const pool = await getArr(KEY_POOL);
  res.json({ ok: true, pool });
});

// POST /winner => pick winner (remove from pool)
app.post("/winner", async (req, res) => {
  const pool = await getArr(KEY_POOL);
  if (!pool.length) return res.status(400).json({ ok: false, error: "Pool empty" });

  const idx = Math.floor(Math.random() * pool.length);
  const winner = pool[idx];
  pool.splice(idx, 1);
  await setArr(KEY_POOL, pool);

  res.json({ ok: true, winner, remaining: pool.length });
});

// POST /restart => pool = master
app.post("/restart", async (req, res) => {
  const master = await getArr(KEY_MASTER);
  await setArr(KEY_POOL, master);
  res.json({ ok: true, poolCount: master.length });
});

app.listen(PORT, () => console.log("Server running on port " + PORT));

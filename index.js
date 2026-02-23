/* lucky77-wheel-bot (Render Web Service)
   - Telegram Group: /register -> posts Register button (deep-link to bot DM)
   - User must Start bot once (Telegram limitation) -> then we can DM by user_id
   - Upstash Redis stores:
       members:set (user_ids)
       member:<id>:hash (name, username, first_name, last_name, registeredAt)
       excluded:set (ids excluded from winning)  [owner/bot auto excluded]
       winners:list (recent winner logs)
       winners:set (winner ids for no-repeat in a round)
*/

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

// ===================== ENV =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID ? String(process.env.OWNER_ID) : null;
const GROUP_ID = process.env.GROUP_ID ? String(process.env.GROUP_ID) : null; // like -100xxxxxxxxxx
const PUBLIC_URL = process.env.PUBLIC_URL; // https://lucky77-wheel-bot.onrender.com
const API_KEY = process.env.API_KEY; // for CodePen calls
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN missing");
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.error("PUBLIC_URL missing (must be your Render URL)");
  process.exit(1);
}
if (!API_KEY) {
  console.error("API_KEY missing (for CodePen)");
  process.exit(1);
}

// ===================== REDIS =====================
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN
});

// Use NEW names (avoid WRONGTYPE from old keys)
const KEY_MEMBERS_SET = "lw2:members:set";
const KEY_MEMBER_HASH = (id) => `lw2:member:${id}:hash`;
const KEY_EXCLUDED_SET = "lw2:excluded:set";
const KEY_WINNERS_LIST = "lw2:winners:list";
const KEY_WINNERS_SET = "lw2:winners:set"; // no-repeat in a round

// ===================== BOT =====================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// BOT id (we fetch on start)
let BOT_ID = null;

async function ensureBotId() {
  if (BOT_ID) return BOT_ID;
  const me = await bot.getMe();
  BOT_ID = String(me.id);
  // Always exclude bot itself
  await redis.sadd(KEY_EXCLUDED_SET, BOT_ID);
  if (OWNER_ID) await redis.sadd(KEY_EXCLUDED_SET, String(OWNER_ID));
  return BOT_ID;
}

// ============== Helpers ==============
function requireApiKey(req, res, next) {
  const key = req.header("x-api-key") || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized (API_KEY)" });
  }
  next();
}

function safeUserDisplay(u) {
  // display priority: name -> @username -> id
  const fullName = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  if (u.username) return `@${u.username}`;
  return String(u.id);
}

async function upsertMemberFromTelegramUser(u) {
  const id = String(u.id);
  const fullName = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  const payload = {
    id,
    username: u.username ? String(u.username) : "",
    first_name: u.first_name ? String(u.first_name) : "",
    last_name: u.last_name ? String(u.last_name) : "",
    name: fullName,
    registeredAt: String(Date.now())
  };

  // Save member id set + hash
  await redis.sadd(KEY_MEMBERS_SET, id);
  await redis.hset(KEY_MEMBER_HASH(id), payload);

  // Exclude owner/bot always (and allow owner to exclude admins)
  await ensureBotId();
  if (OWNER_ID) await redis.sadd(KEY_EXCLUDED_SET, String(OWNER_ID));

  return payload;
}

async function isRegistered(userId) {
  const id = String(userId);
  const exists = await redis.sismember(KEY_MEMBERS_SET, id);
  return !!exists;
}

async function getMemberHash(id) {
  const h = await redis.hgetall(KEY_MEMBER_HASH(String(id)));
  if (!h || Object.keys(h).length === 0) return null;
  return h;
}

async function canWin(id) {
  const sid = String(id);
  const excluded = await redis.sismember(KEY_EXCLUDED_SET, sid);
  if (excluded) return false;

  // no-repeat winners in current round
  const alreadyWon = await redis.sismember(KEY_WINNERS_SET, sid);
  if (alreadyWon) return false;

  return true;
}

function buildWinMessage({ prize, memberDisplay }) {
  // You can edit this text later
  return `🎉 *Congratulations!* 🎉

🏆 *Winner:* ${memberDisplay}
🎁 *Prize:* *${prize}*

Lucky77 Lucky Wheel Event ✅`;
}

async function tryDmWinner(userId, text, parseMode = "Markdown") {
  try {
    await bot.sendMessage(String(userId), text, { parse_mode: parseMode });
    return { ok: true };
  } catch (e) {
    // Most common: bot was never started by this user
    return { ok: false, error: e?.message || "DM failed" };
  }
}

// ===================== Telegram: /start in DM =====================
bot.onText(/^\/start(?:\s+(.+))?$/i, async (msg, match) => {
  const chat = msg.chat;
  const from = msg.from;
  if (!from) return;

  // Only act in private chat
  if (chat.type !== "private") return;

  const startedPayload = (match && match[1]) ? String(match[1]).trim() : "";
  const already = await isRegistered(from.id);

  // Always upsert (keeps latest username/name)
  await upsertMemberFromTelegramUser(from);

  if (already) {
    await bot.sendMessage(chat.id, `✅ You are already registered.\n\nName: ${safeUserDisplay(from)}\nID: ${from.id}`);
  } else {
    // Big welcome message (you can change text)
    await bot.sendMessage(
      chat.id,
      `✅ *Registration successful!*\n\n🙌 Hello ${safeUserDisplay(from)}\n🎡 Your name is now added to *Lucky77 Lucky Wheel*.\n\nGood luck! 🍀`,
      { parse_mode: "Markdown" }
    );
  }

  // If user used deep-link start payload, we can optionally also notify group
  if (startedPayload && GROUP_ID) {
    // just a silent note (avoid spam if you want, comment out)
    try {
      await bot.sendMessage(GROUP_ID, `✅ Registered: ${safeUserDisplay(from)}`, { disable_notification: true });
    } catch (_) {}
  }
});

// ===================== Telegram: Group Commands =====================

// /register  -> send button in group to open bot DM
bot.onText(/^\/register$/i, async (msg) => {
  const chat = msg.chat;

  // Must be in group/supergroup
  if (chat.type !== "group" && chat.type !== "supergroup") return;

  // If you set GROUP_ID, restrict to that group only
  if (GROUP_ID && String(chat.id) !== String(GROUP_ID)) {
    return bot.sendMessage(chat.id, "❌ This bot is not configured for this group.");
  }

  await ensureBotId();

  // Register button opens private chat with start payload (deep link)
  // NOTE: user still must tap Start once (Telegram limitation)
  const botUsername = (await bot.getMe()).username;
  const url = `https://t.me/${botUsername}?start=register`;

  // Message (you can change)
  const text =
    "📝 *Lucky77 Registration*\n\n" +
    "1) Tap *REGISTER* button\n" +
    "2) In bot chat, tap *Start* once ✅\n\n" +
    "After that, you will be added to the Lucky Wheel list.";

  return bot.sendMessage(chat.id, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ REGISTER (Open Bot)", url }],
        [{ text: "📋 How to Register", callback_data: "lw_help_register" }]
      ]
    }
  });
});

// help callback
bot.on("callback_query", async (cq) => {
  const data = cq.data || "";
  const from = cq.from;

  if (data === "lw_help_register") {
    await bot.answerCallbackQuery(cq.id, {
      text: "Tap REGISTER → bot chat opens → press Start once. Then you are registered ✅",
      show_alert: true
    });
    return;
  }

  // Owner-only: pin reminder in group, etc. (optional)
  if (data === "lw_owner_ping") {
    if (!OWNER_ID || String(from.id) !== String(OWNER_ID)) {
      return bot.answerCallbackQuery(cq.id, { text: "Not allowed", show_alert: true });
    }
    return bot.answerCallbackQuery(cq.id, { text: "OK", show_alert: false });
  }
});

// Owner commands to manage excludes
bot.onText(/^\/exclude\s+(-?\d+)$/i, async (msg, match) => {
  if (!OWNER_ID || String(msg.from?.id) !== String(OWNER_ID)) return;
  const id = String(match[1]);
  await redis.sadd(KEY_EXCLUDED_SET, id);
  await bot.sendMessage(msg.chat.id, `✅ Excluded ID: ${id}`);
});

bot.onText(/^\/unexclude\s+(-?\d+)$/i, async (msg, match) => {
  if (!OWNER_ID || String(msg.from?.id) !== String(OWNER_ID)) return;
  const id = String(match[1]);
  await redis.srem(KEY_EXCLUDED_SET, id);
  await bot.sendMessage(msg.chat.id, `✅ Removed from excluded: ${id}`);
});

// Reset round winners (allow same member win again next round)
bot.onText(/^\/reset_round$/i, async (msg) => {
  if (!OWNER_ID || String(msg.from?.id) !== String(OWNER_ID)) return;
  await redis.del(KEY_WINNERS_SET);
  await bot.sendMessage(msg.chat.id, "✅ Round reset: winners can win again.");
});

// If you get WRONGTYPE from old keys: wipe new namespace keys
bot.onText(/^\/reset_db$/i, async (msg) => {
  if (!OWNER_ID || String(msg.from?.id) !== String(OWNER_ID)) return;
  await redis.del(KEY_MEMBERS_SET);
  await redis.del(KEY_EXCLUDED_SET);
  await redis.del(KEY_WINNERS_LIST);
  await redis.del(KEY_WINNERS_SET);
  await ensureBotId();
  await bot.sendMessage(msg.chat.id, "✅ Database reset (lw2:* keys cleared).");
});

// ===================== Express API (for CodePen) =====================
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Health
app.get("/", async (_req, res) => {
  const count = await redis.scard(KEY_MEMBERS_SET);
  res.json({
    ok: true,
    service: "lucky77-wheel-bot",
    members: count,
    time: new Date().toISOString()
  });
});

// List members (for Settings / Member panel)
app.get("/members", requireApiKey, async (_req, res) => {
  const ids = await redis.smembers(KEY_MEMBERS_SET);
  // Return minimal for UI list
  const members = [];
  for (const id of ids) {
    const h = await getMemberHash(id);
    if (!h) continue;
    members.push({
      id: String(id),
      name: h.name || "",
      username: h.username || "",
      first_name: h.first_name || "",
      last_name: h.last_name || ""
    });
  }
  // sort by numeric id or name; UI can re-sort
  res.json({ ok: true, count: members.length, members });
});

// Winner history
app.get("/winners", requireApiKey, async (_req, res) => {
  const list = await redis.lrange(KEY_WINNERS_LIST, 0, 200);
  // stored as JSON strings
  const winners = list
    .map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    })
    .filter(Boolean);
  res.json({ ok: true, count: winners.length, winners });
});

// Pick winner for a prize (Pure Random Mode)
// Body: { prize: "10000Ks" }
app.post("/winner", requireApiKey, async (req, res) => {
  const prize = (req.body?.prize || "").trim();
  if (!prize) return res.status(400).json({ ok: false, error: "Missing prize" });

  await ensureBotId();

  const ids = await redis.smembers(KEY_MEMBERS_SET);

  // Build candidates = registered members that are not excluded & not already won in round
  const candidates = [];
  for (const id of ids) {
    if (await canWin(id)) candidates.push(String(id));
  }

  if (candidates.length === 0) {
    return res.json({ ok: false, error: "No eligible members (pool empty or all excluded/already-won)" });
  }

  // Random pick
  const pickId = candidates[Math.floor(Math.random() * candidates.length)];
  const h = await getMemberHash(pickId);

  const memberDisplay =
    (h?.name && h.name.trim()) ? h.name.trim()
    : (h?.username && h.username.trim()) ? `@${h.username.trim()}`
    : String(pickId);

  // Mark as already-won (no repeat)
  await redis.sadd(KEY_WINNERS_SET, String(pickId));

  // Save winner history log
  const winnerLog = {
    ts: Date.now(),
    prize,
    user_id: String(pickId),
    name: h?.name || "",
    username: h?.username || ""
  };
  await redis.lpush(KEY_WINNERS_LIST, JSON.stringify(winnerLog));
  await redis.ltrim(KEY_WINNERS_LIST, 0, 300);

  // Try DM winner automatically
  const dmText = buildWinMessage({ prize, memberDisplay });
  const dm = await tryDmWinner(pickId, dmText, "Markdown");

  res.json({
    ok: true,
    prize,
    winner: {
      user_id: String(pickId),
      name: h?.name || "",
      username: h?.username || "",
      display: memberDisplay
    },
    dm
  });
});

// Notice button for ID-only (or DM failed)
// Body: { user_id: "123", prize:"10000Ks", message?: "..." }
app.post("/notice", requireApiKey, async (req, res) => {
  const userId = String(req.body?.user_id || "").trim();
  const prize = String(req.body?.prize || "").trim();
  const custom = String(req.body?.message || "").trim();

  if (!userId) return res.status(400).json({ ok: false, error: "Missing user_id" });
  if (!prize && !custom) return res.status(400).json({ ok: false, error: "Missing prize/message" });

  const h = await getMemberHash(userId);
  const memberDisplay =
    (h?.name && h.name.trim()) ? h.name.trim()
    : (h?.username && h.username.trim()) ? `@${h.username.trim()}`
    : String(userId);

  const msgText = custom || buildWinMessage({ prize, memberDisplay });
  const dm = await tryDmWinner(userId, msgText, "Markdown");

  res.json({ ok: true, dm });
});

// Reset round winners (API version)
app.post("/reset-round", requireApiKey, async (_req, res) => {
  await redis.del(KEY_WINNERS_SET);
  res.json({ ok: true });
});

// ===================== Start Express =====================
const port = process.env.PORT || 10000;
app.listen(port, async () => {
  await ensureBotId();
  console.log("Server running on port", port);
  console.log("Public URL:", PUBLIC_URL);
});

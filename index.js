const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// optional (admin check / protected endpoints)
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : null;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing");
  process.exit(1);
}

// Upstash Redis
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// ===== Keys =====
const KEY_MEMBERS_SET = "lucky77:members:ids"; // set of user ids who started DM
const KEY_MEMBER_PREFIX = "lucky77:member:"; // lucky77:member:<id>

// ===== Helpers =====
function isAdminMsg(msg) {
  if (!ADMIN_ID) return true;
  return String(msg.from?.id) === String(ADMIN_ID);
}

function fullName(u) {
  return [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim();
}

function displayName(u) {
  // priority: full name > @username > id
  const fn = fullName(u);
  if (fn) return fn;
  if (u?.username) return `@${u.username}`;
  return String(u?.id || "");
}

async function saveMemberFromUser(user) {
  const id = String(user.id);
  const data = {
    id,
    username: user.username ? `@${user.username}` : null,
    first_name: user.first_name || null,
    last_name: user.last_name || null,
    name: fullName(user) || null,
    display: displayName(user),
    dm_started: true,
    updated_at: new Date().toISOString(),
  };

  // Save object
  await redis.set(`${KEY_MEMBER_PREFIX}${id}`, data);
  // Add to set
  await redis.sadd(KEY_MEMBERS_SET, id);

  return data;
}

async function getAllMembers() {
  const ids = await redis.smembers(KEY_MEMBERS_SET);
  if (!ids || ids.length === 0) return [];

  const members = [];
  for (const id of ids) {
    const m = await redis.get(`${KEY_MEMBER_PREFIX}${id}`);
    if (m) members.push(m);
  }

  // sort by updated_at desc
  members.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return members;
}

// ===== Telegram Bot =====
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let BOT_USERNAME = null;
bot.getMe()
  .then((me) => {
    BOT_USERNAME = me.username;
    console.log("Bot username:", BOT_USERNAME);
  })
  .catch((e) => console.error("getMe error:", e));

// 1) Group join => send Start button
bot.on("new_chat_members", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const members = msg.new_chat_members || [];

    // Only react in groups/supergroups
    if (!["group", "supergroup"].includes(msg.chat.type)) return;

    // If bot username not ready yet, fallback (button will be sent later anyway)
    const botLink = BOT_USERNAME
      ? `https://t.me/${BOT_USERNAME}?start=join`
      : null;

    for (const u of members) {
      // skip bots
      if (u.is_bot) continue;

      // Send one welcome message (per joined user)
      const name = displayName(u);

      const text =
        `👋 Welcome ${name}\n\n` +
        `🎡 Lucky Spin Wheel ကို Prize claim လုပ်ဖို့ DM ထဲမှာ Register လုပ်ပါ။\n` +
        `အောက်က Button ကိုနှိပ်ပြီး Start လုပ်ပါ ✅\n\n` +
        `⚠️ Start လုပ်ပြီးမှ Bot က username / name / id ကိုမှတ်နိုင်ပါတယ်။`;

      if (botLink) {
        await bot.sendMessage(chatId, text, {
          reply_markup: {
            inline_keyboard: [[{ text: "✅ Start / Register (DM)", url: botLink }]],
          },
        });
      } else {
        // if bot username not available, send without link
        await bot.sendMessage(chatId, text);
      }
    }
  } catch (e) {
    console.error("new_chat_members error:", e);
  }
});

// 2) DM /start => save user info (dm_started)
bot.onText(/\/start(?:\s+(.+))?/i, async (msg, match) => {
  try {
    // Only handle in private chat for DM registration
    if (msg.chat.type !== "private") {
      return bot.sendMessage(
        msg.chat.id,
        "DM ထဲမှာ /start ကိုနှိပ်ပြီး Register လုပ်ပါ ✅"
      );
    }

    const payload = String(match?.[1] || "").trim(); // e.g. "join"
    const user = msg.from;

    const saved = await saveMemberFromUser(user);

    // DM Lock: Only /start gets response, other texts will be ignored (see below)
    const reply =
      `✅ Register Done!\n\n` +
      `Name: ${saved.name || "-"}\n` +
      `Username: ${saved.username || "-"}\n` +
      `ID: ${saved.id}\n\n` +
      `🎁 Prize win ဖြစ်ရင် ဒီ info ကိုသုံးပြီး Winner list ထဲမှာပြမယ်။`;

    if (payload) {
      return bot.sendMessage(msg.chat.id, reply);
    }
    return bot.sendMessage(msg.chat.id, reply);
  } catch (e) {
    console.error("/start error:", e);
    bot.sendMessage(msg.chat.id, "Error ဖြစ်သွားတယ်။ နောက်တခါ /start လုပ်ကြည့်ပါ။");
  }
});

// 3) DM Lock: ignore everything else in private chat (optional)
//    If you want to allow some commands later, add them before this handler.
bot.on("message", async (msg) => {
  try {
    if (msg.chat.type !== "private") return;

    const text = String(msg.text || "");
    // allow /start only
    if (text.startsWith("/start")) return;

    // ignore all other messages
    // (no reply)
  } catch (e) {}
});

// ===== HTTP API (for CodePen later) =====

// Health
app.get("/", async (req, res) => {
  res.json({ ok: true });
});

// Get members who DM-started (saved)
// If you want to protect it, require ?admin_id=xxxx or API key; for now keep simple
app.get("/members", async (req, res) => {
  try {
    // optional admin guard
    if (ADMIN_ID) {
      const q = req.query.admin_id ? String(req.query.admin_id) : "";
      if (q !== ADMIN_ID) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
    }

    const members = await getAllMembers();
    res.json({ ok: true, count: members.length, members });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("Server running on port " + PORT));

// Render graceful shutdown
process.on("SIGTERM", async () => {
  try {
    console.log("SIGTERM received. Shutting down...");
  } finally {
    process.exit(0);
  }
});

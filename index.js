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

// Owner ID (exclude)
const OWNER_ID = process.env.OWNER_ID
  ? String(process.env.OWNER_ID)
  : null;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const KEY_MEMBERS = "lucky77:members";

// =======================
// Helper Functions
// =======================

function getDisplayName(u) {
  const full = [u.first_name, u.last_name].filter(Boolean).join(" ");
  if (full) return full;
  if (u.username) return "@" + u.username;
  return String(u.id);
}

async function saveMember(user) {
  const id = String(user.id);

  // exclude owner
  if (OWNER_ID && id === OWNER_ID) return false;

  // exclude bots
  if (user.is_bot) return false;

  const memberData = {
    id,
    username: user.username ? "@" + user.username : null,
    name: getDisplayName(user),
    created_at: new Date().toISOString(),
  };

  await redis.hset(KEY_MEMBERS, {
    [id]: JSON.stringify(memberData),
  });

  return true;
}

// =======================
// Group Join -> Send Register Button
// =======================

bot.on("new_chat_members", async (msg) => {
  if (!["group", "supergroup"].includes(msg.chat.type)) return;

  for (const user of msg.new_chat_members) {
    if (user.is_bot) continue;

    await bot.sendMessage(
      msg.chat.id,
      🎡 Lucky77 Lucky Wheel Event\n\nRegister လုပ်ဖို့အောက်က Button ကိုနှိပ်ပါ,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ Register",
                callback_data: "register_member",
              },
            ],
          ],
        },
      }
    );
  }
});

// =======================
// Register Button Click
// =======================

bot.on("callback_query", async (query) => {
  if (query.data !== "register_member") return;

  const user = query.from;

  const saved = await saveMember(user);

  if (!saved) {
    return bot.answerCallbackQuery(query.id, {
      text: "❌ You are excluded from this event.",
      show_alert: true,
    });
  }

  // popup only (no group spam)
  await bot.answerCallbackQuery(query.id, {
    text:
      "🎉 ဂုဏ်ယူပါတယ်!\n\n" +
      "သင့်နာမည်က Lucky Wheel ထဲဝင်ပြီးပါပြီ 🎡\n\n" +
      "Lucky77 နဲ့အတူ မြန်မာငွေကျပ်ငါးသိန်းဖိုး Event Prize ထဲ ပါဝင်လိုက်ကြစို့!",
    show_alert: true,
  });
});

// =======================
// API for CodePen later
// =======================

app.get("/members", async (req, res) => {
  const data = await redis.hgetall(KEY_MEMBERS);
  const members = Object.values(data || {}).map((v) =>
    JSON.parse(v)
  );
  res.json({ ok: true, count: members.length, members });
});

app.get("/", (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () =>
  console.log("Server running on port " + PORT)
);

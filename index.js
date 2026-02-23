require("dotenv").config();

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

/* ================= ENV ================= */

const {
  BOT_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  OWNER_ID,
  API_KEY
} = process.env;

function must(v, name) {
  if (!v) {
    console.error(`${name} missing`);
    process.exit(1);
  }
}

must(BOT_TOKEN, "BOT_TOKEN");
must(UPSTASH_REDIS_REST_URL, "UPSTASH_REDIS_REST_URL");
must(UPSTASH_REDIS_REST_TOKEN, "UPSTASH_REDIS_REST_TOKEN");
must(OWNER_ID, "OWNER_ID");

/* ================= REDIS ================= */

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN
});

const KEY_PREFIX = "lucky77:v5";
const KEY_MEMBERS = `${KEY_PREFIX}:members`;
const KEY_MEMBER = (id) => `${KEY_PREFIX}:member:${id}`;
const KEY_WINNERS = `${KEY_PREFIX}:winners`;
const KEY_GROUP_ID = `${KEY_PREFIX}:group_id`;

/* ================= BOT ================= */

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let BOT_USERNAME = null;

(async () => {
  const me = await bot.getMe();
  BOT_USERNAME = me.username;
  console.log("Bot Ready:", BOT_USERNAME);
})();

/* ================= HELPERS ================= */

function nameParts(u) {
  const name = `${u.first_name || ""} ${u.last_name || ""}`.trim();
  const username = u.username || "";
  return { name, username };
}

function display(u) {
  const { name, username } = nameParts(u);
  if (name) return name;
  if (username) return `@${username}`;
  return String(u.id);
}

/* ================= AUTO GROUP DETECT ================= */

async function getGroupId() {
  return await redis.get(KEY_GROUP_ID);
}

async function setGroupId(id) {
  await redis.set(KEY_GROUP_ID, String(id));
  console.log("Group ID Saved:", id);
}

/* ================= REGISTER FLOW ================= */

async function saveMember(u) {
  const { name, username } = nameParts(u);

  await redis.sadd(KEY_MEMBERS, String(u.id));
  await redis.hset(KEY_MEMBER(u.id), {
    id: String(u.id),
    name,
    username,
    dm_ready: "0",
    registered_at: new Date().toISOString()
  });
}

bot.on("message", async (msg) => {
  if (!msg.chat) return;

  // Auto save group id first time bot sees group
  if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    const saved = await getGroupId();
    if (!saved) {
      await setGroupId(msg.chat.id);
    }
  }

  const groupId = await getGroupId();
  if (!groupId) return;

  if (String(msg.chat.id) === String(groupId) && msg.new_chat_members) {
    for (const m of msg.new_chat_members) {

      const text =
        `🎡 Lucky77 Lucky Wheel\n\n` +
        `မင်္ဂလာပါ ${display(m)} 👋\n\n` +
        `Event ထဲဝင်ဖို့ Register ကိုနှိပ်ပါ။`;

      const keyboard = {
        inline_keyboard: [
          [{ text: "✅ Register", callback_data: `reg:${m.id}` }]
        ]
      };

      const sent = await bot.sendMessage(groupId, text, {
        reply_markup: keyboard
      });

      setTimeout(() => {
        bot.deleteMessage(groupId, sent.message_id).catch(() => {});
      }, 30000);
    }
  }
});

/* ================= CALLBACK ================= */

bot.on("callback_query", async (cq) => {
  const data = cq.data || "";
  if (!data.startsWith("reg:")) return;

  await saveMember(cq.from);

  await bot.answerCallbackQuery(cq.id, {
    text: "🎉 Registered!",
    show_alert: true
  });

  await bot.editMessageReplyMarkup(
    {
      inline_keyboard: [[{ text: "✅ Registered", callback_data: "done" }]]
    },
    {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id
    }
  );

  const { name, username } = nameParts(cq.from);

  if (!username && !name) {
    const startUrl = `https://t.me/${BOT_USERNAME}?start=enable`;

    await bot.sendMessage(
      cq.message.chat.id,
      `⚠️ DM Enable ဖို့ Start Bot ကိုနှိပ်ပါ။`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "▶️ Start Bot", url: startUrl }]]
        }
      }
    );
  }
});

/* ================= PRIVATE START ================= */

bot.onText(/\/start/, async (msg) => {
  if (msg.chat.type !== "private") return;

  await redis.hset(KEY_MEMBER(msg.from.id), {
    dm_ready: "1"
  });

  await bot.sendMessage(
    msg.chat.id,
    "✅ DM Enable ပြီးပါပြီ။ Prize ပေါက်ရင် ဒီနေရာကို message လာပါမယ်။"
  );
});

/* ================= EXPRESS ================= */

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", async (req, res) => {
  const groupId = await getGroupId();
  res.json({ ok: true, group_id: groupId || null });
});

app.listen(process.env.PORT || 10000, () =>
  console.log("Server running")
);

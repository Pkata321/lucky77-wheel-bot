"use strict";

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const API_KEY = process.env.API_KEY;

const OWNER_ID = process.env.OWNER_ID;
const GROUP_ID = process.env.GROUP_ID;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !PUBLIC_URL) {
  console.error("Missing ENV");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

const app = express();
app.use(cors());
app.use(express.json());

app.post("/telegram", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================= KEYS =================
const K = {
  MEMBERS: "lucky77:v3:members",
  MEMBER_DATA: "lucky77:v3:member:data",
  WINNERS: "lucky77:v3:winners",
  EXCLUDE: "lucky77:v3:exclude",
};

// ================= REGISTER =================

function registerKeyboard() {
  return {
    inline_keyboard: [[{ text: "🎡 Register", callback_data: "reg" }]],
  };
}

function registeredKeyboard() {
  return {
    inline_keyboard: [[{ text: "✅ Registered", callback_data: "done" }]],
  };
}

bot.onText(/^\/register/, async (msg) => {
  if (String(msg.chat.id) !== GROUP_ID) return;

  const sent = await bot.sendMessage(
    msg.chat.id,
    "🎡 Lucky77 Lucky Wheel\n\nPress Register to join.",
    { reply_markup: registerKeyboard() }
  );

  setTimeout(async () => {
    try {
      await bot.pinChatMessage(msg.chat.id, sent.message_id);
    } catch {}
  }, 30000);
});

bot.on("callback_query", async (q) => {
  if (q.data === "done") return;

  if (q.data === "reg") {
    const user = q.from;
    const userId = String(user.id);

    const exists = await redis.sismember(K.MEMBERS, userId);
    if (exists) return;

    await redis.sadd(K.MEMBERS, userId);

    await redis.hset(K.MEMBER_DATA, {
      [userId]: JSON.stringify({
        id: userId,
        username: user.username || "",
        name: user.first_name || "",
      }),
    });

    // DM auto
    try {
      await bot.sendMessage(
        userId,
        "🎉 You are successfully registered in Lucky77 Wheel!"
      );
    } catch {}

    await bot.editMessageReplyMarkup(registeredKeyboard(), {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
    });

    await bot.deleteMessage(q.message.chat.id, q.message.message_id);

    await bot.answerCallbackQuery(q.id);
  }
});

// ================= WINNER =================

function requireKey(req, res) {
  if (req.header("x-api-key") !== API_KEY) {
    res.status(401).json({ ok: false });
    return false;
  }
  return true;
}

app.post("/winner", async (req, res) => {
  if (!requireKey(req, res)) return;

  const prize = req.body.prize;
  if (!prize) return res.json({ ok: false });

  const members = await redis.smembers(K.MEMBERS);
  const exclude = new Set(await redis.smembers(K.EXCLUDE));
  const winners = new Set(await redis.smembers(K.WINNERS));

  const pool = members.filter(
    (id) => !exclude.has(id) && !winners.has(id)
  );

  if (!pool.length) return res.json({ ok: false });

  const winnerId = pool[Math.floor(Math.random() * pool.length)];

  await redis.sadd(K.WINNERS, winnerId);

  const raw = await redis.hget(K.MEMBER_DATA, winnerId);
  const user = JSON.parse(raw);

  // Group announce
  await bot.sendMessage(
    GROUP_ID,
    `🏆 Winner: ${user.name || user.username}\n🎁 Prize: ${prize}`
  );

  // DM winner
  try {
    await bot.sendMessage(
      winnerId,
      `🎉 Congratulations!\nYou won: ${prize}`
    );
  } catch {}

  res.json({ ok: true, winner: user, prize });
});

// ================= SERVER =================

(async () => {
  await bot.setWebHook(`${PUBLIC_URL}/telegram`);
  app.listen(PORT, () => console.log("Running..."));
})();

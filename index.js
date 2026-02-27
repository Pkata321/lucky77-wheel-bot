"use strict";

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
  API_KEY,
  GROUP_ID,
  EXCLUDE_IDS,
  PUBLIC_URL,
  WEBHOOK_SECRET,
} = process.env;

if (
  !BOT_TOKEN ||
  !UPSTASH_REDIS_REST_URL ||
  !UPSTASH_REDIS_REST_TOKEN ||
  !OWNER_ID ||
  !API_KEY ||
  !PUBLIC_URL ||
  !WEBHOOK_SECRET
) {
  console.error("❌ Missing required ENV");
  process.exit(1);
}

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

/* ================= REDIS KEYS ================= */

const PREFIX = "lucky77:remax";

const KEY_MEMBERS = `${PREFIX}:members`;
const KEY_MEMBER = (id) => `${PREFIX}:member:${id}`;
const KEY_WINNERS = `${PREFIX}:winners`;
const KEY_HISTORY = `${PREFIX}:history`;
const KEY_PRIZE_BAG = `${PREFIX}:prize_bag`;
const KEY_PRIZE_SOURCE = `${PREFIX}:prize_source`;

const KEY_PIN_MODE = `${PREFIX}:pin_mode`;
const KEY_PIN_TEXT = `${PREFIX}:pin_text`;
const KEY_PIN_FILE = `${PREFIX}:pin_file`;
const KEY_PINNED_ID = `${PREFIX}:pinned_id`;

const KEY_DM_MODE = `${PREFIX}:dm_mode`;
const KEY_DM_TEXT = `${PREFIX}:dm_text`;
const KEY_DM_FILE = `${PREFIX}:dm_file`;

const excludeIds = (EXCLUDE_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

function isOwner(id) {
  return String(id) === String(OWNER_ID);
}

function isExcluded(id) {
  if (String(id) === String(OWNER_ID)) return true;
  return excludeIds.includes(String(id));
}

/* ================= EXPRESS ================= */

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/", (_, res) => res.send("Lucky77 REMAX Bot Running ✅"));

/* ================= TELEGRAM ================= */

const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

const WEBHOOK_PATH = `/telegram/${WEBHOOK_SECRET}`;

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

async function setupWebhook() {
  await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
  await bot.setWebHook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
}

/* ================= HELPERS ================= */

async function autoDelete(chatId, msgId, ms = 2000) {
  setTimeout(async () => {
    try { await bot.deleteMessage(chatId, msgId); } catch {}
  }, ms);
}

async function saveMember(u) {
  if (!u || isExcluded(u.id)) return;

  const id = String(u.id);

  await redis.sadd(KEY_MEMBERS, id);
  await redis.hset(KEY_MEMBER(id), {
    id,
    name: `${u.first_name || ""} ${u.last_name || ""}`.trim(),
    username: u.username || "",
  });
}

async function removeMember(id) {
  await redis.srem(KEY_MEMBERS, String(id));
  await redis.srem(KEY_WINNERS, String(id));
  await redis.del(KEY_MEMBER(String(id)));
}

/* ================= PIN SYSTEM ================= */

async function getPinConfig() {
  return {
    mode: (await redis.get(KEY_PIN_MODE)) || "text",
    text:
      (await redis.get(KEY_PIN_TEXT)) ||
      "📌 Register for Lucky77\n\nClick button to enable DM.",
    file: (await redis.get(KEY_PIN_FILE)) || "",
  };
}

async function sendPinned() {
  if (!GROUP_ID) return;

  const { mode, text, file } = await getPinConfig();

  const me = await bot.getMe();
  const url = `https://t.me/${me.username}?start=register`;

  const keyboard = {
    inline_keyboard: [[{ text: "▶️ Register", url }]],
  };

  let sent;

  if (mode === "photo" && file) {
    sent = await bot.sendPhoto(GROUP_ID, file, {
      caption: text,
      reply_markup: keyboard,
    });
  } else if (mode === "video" && file) {
    sent = await bot.sendVideo(GROUP_ID, file, {
      caption: text,
      reply_markup: keyboard,
      supports_streaming: true,
    });
  } else {
    sent = await bot.sendMessage(GROUP_ID, text, {
      reply_markup: keyboard,
    });
  }

  try {
    await bot.pinChatMessage(GROUP_ID, sent.message_id, {
      disable_notification: true,
    });
  } catch {}

  await redis.set(KEY_PINNED_ID, String(sent.message_id));
}

async function updatePin() {
  const old = await redis.get(KEY_PINNED_ID);
  if (old) {
    try { await bot.deleteMessage(GROUP_ID, Number(old)); } catch {}
  }
  await sendPinned();
}

/* ================= DM AUTO REPLY ================= */

async function sendDmReply(chatId) {
  const mode = (await redis.get(KEY_DM_MODE)) || "text";
  const text =
    (await redis.get(KEY_DM_TEXT)) ||
    "✅ Registered successfully!";
  const file = (await redis.get(KEY_DM_FILE)) || "";

  if (mode === "photo" && file) {
    await bot.sendPhoto(chatId, file, { caption: text });
  } else if (mode === "video" && file) {
    await bot.sendVideo(chatId, file, {
      caption: text,
      supports_streaming: true,
    });
  } else {
    await bot.sendMessage(chatId, text);
  }
}

/* ================= GROUP EVENTS ================= */

bot.on("message", async (msg) => {
  if (!msg.chat) return;

  // GROUP JOIN
  if (
    GROUP_ID &&
    String(msg.chat.id) === String(GROUP_ID) &&
    msg.new_chat_members
  ) {
    for (const u of msg.new_chat_members) {
      await saveMember(u);
    }
    await autoDelete(msg.chat.id, msg.message_id);
  }

  // GROUP LEAVE
  if (
    GROUP_ID &&
    String(msg.chat.id) === String(GROUP_ID) &&
    msg.left_chat_member
  ) {
    await removeMember(msg.left_chat_member.id);
    await autoDelete(msg.chat.id, msg.message_id);
  }
});

/* ================= PRIVATE START ================= */

bot.onText(/^\/start/, async (msg) => {
  if (msg.chat.type !== "private") return;

  await saveMember(msg.from);
  await sendDmReply(msg.chat.id);
});

/* ================= OWNER COMMANDS ================= */

function ownerOnly(msg) {
  return msg.chat.type === "private" && isOwner(msg.from.id);
}

bot.onText(/^\/setpin (.+)/, async (msg, match) => {
  if (!ownerOnly(msg)) return;
  await redis.set(KEY_PIN_TEXT, match[1]);
  await bot.sendMessage(msg.chat.id, "✅ Pin text updated");
});

bot.onText(/^\/settext$/, async (msg) => {
  if (!ownerOnly(msg)) return;
  await redis.set(KEY_PIN_MODE, "text");
  await redis.del(KEY_PIN_FILE);
  await bot.sendMessage(msg.chat.id, "✅ Pin mode = text");
});

bot.onText(/^\/setphoto$/, async (msg) => {
  if (!ownerOnly(msg)) return;
  const src = msg.reply_to_message;
  if (!src?.photo) return;
  const file = src.photo[src.photo.length - 1].file_id;
  await redis.set(KEY_PIN_MODE, "photo");
  await redis.set(KEY_PIN_FILE, file);
  await bot.sendMessage(msg.chat.id, "✅ Pin photo saved");
});

bot.onText(/^\/setvideo$/, async (msg) => {
  if (!ownerOnly(msg)) return;
  const src = msg.reply_to_message;
  if (!src?.video) return;
  await redis.set(KEY_PIN_MODE, "video");
  await redis.set(KEY_PIN_FILE, src.video.file_id);
  await bot.sendMessage(msg.chat.id, "✅ Pin video saved");
});

bot.onText(/^\/update$/, async (msg) => {
  if (!ownerOnly(msg)) return;
  await updatePin();
  await bot.sendMessage(msg.chat.id, "✅ Pin updated");
});

bot.onText(/^\/regbotDM (.+)/, async (msg, match) => {
  if (!ownerOnly(msg)) return;
  await redis.set(KEY_DM_MODE, "text");
  await redis.set(KEY_DM_TEXT, match[1]);
  await redis.del(KEY_DM_FILE);
  await bot.sendMessage(msg.chat.id, "✅ DM text updated");
});

bot.onText(/^\/setbotimage$/, async (msg) => {
  if (!ownerOnly(msg)) return;
  const src = msg.reply_to_message;
  if (!src?.photo) return;
  const file = src.photo[src.photo.length - 1].file_id;
  await redis.set(KEY_DM_MODE, "photo");
  await redis.set(KEY_DM_FILE, file);
  await bot.sendMessage(msg.chat.id, "✅ DM image set");
});

bot.onText(/^\/setbotvideo$/, async (msg) => {
  if (!ownerOnly(msg)) return;
  const src = msg.reply_to_message;
  if (!src?.video) return;
  await redis.set(KEY_DM_MODE, "video");
  await redis.set(KEY_DM_FILE, src.video.file_id);
  await bot.sendMessage(msg.chat.id, "✅ DM video set");
});

/* ================= SERVER START ================= */

const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log("🚀 Lucky77 REMAX Running");
  await setupWebhook();
});});
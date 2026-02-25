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
  API_KEY, // optional
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
  token: UPSTASH_REDIS_REST_TOKEN,
});

const KEY_PREFIX = "lucky77:pro:1";
const KEY_GROUPS = `${KEY_PREFIX}:groups:set`; // store group ids bot has seen
const KEY_MEMBERS = `${KEY_PREFIX}:members:set`; // all registered members
const KEY_MEMBER = (id) => `${KEY_PREFIX}:member:${id}`; // hash
const KEY_WINNERS = `${KEY_PREFIX}:winners:set`; // no-repeat winners
const KEY_HISTORY = `${KEY_PREFIX}:history:list`; // recent history

// prize config + prize queue
const KEY_PRIZES_JSON = `${KEY_PREFIX}:prizes:json`; // saved config json
const KEY_PRIZE_QUEUE = `${KEY_PREFIX}:prizes:queue`; // list of prizes to pop (shuffled)

/* ================= BOT ================= */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let BOT_USERNAME = null;
let BOT_ID = null;

(async () => {
  const me = await bot.getMe();
  BOT_USERNAME = me.username || null;
  BOT_ID = String(me.id);
  console.log("Bot Ready:", BOT_USERNAME);
})();

function nameParts(u) {
  const name = `${u.first_name || ""} ${u.last_name || ""}`.trim();
  const username = (u.username || "").trim();
  return { name, username };
}

function display(u) {
  const { name, username } = nameParts(u);
  if (name) return name;
  if (username) return `@${username}`;
  return String(u.id);
}

function isExcluded(userId) {
  const id = String(userId);
  if (id === String(OWNER_ID)) return true;
  if (BOT_ID && id === String(BOT_ID)) return true;
  return false;
}

async function isRegistered(userId) {
  return !!(await redis.sismember(KEY_MEMBERS, String(userId)));
}

async function saveMember(u, source = "group_register") {
  if (!u?.id) return;
  const uid = String(u.id);
  if (isExcluded(uid)) return;

  const { name, username } = nameParts(u);
  const old = await redis.hgetall(KEY_MEMBER(uid));
  const dm_ready = old?.dm_ready === "1" ? "1" : "0";

  await redis.sadd(KEY_MEMBERS, uid);
  await redis.hset(KEY_MEMBER(uid), {
    id: uid,
    name,
    username, // no @
    dm_ready,
    source,
    registered_at: old?.registered_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

async function markDmReady(u) {
  if (!u?.id) return;
  const uid = String(u.id);
  await saveMember(u, "private_start");
  await redis.hset(KEY_MEMBER(uid), {
    dm_ready: "1",
    dm_ready_at: new Date().toISOString(),
  });
}

async function tryDM(uid, text) {
  try {
    await bot.sendMessage(Number(uid), text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.response?.body || e?.message || String(e) };
  }
}

async function autoDelete(chatId, messageId, ms = 60000) {
  setTimeout(() => {
    bot.deleteMessage(chatId, messageId).catch(() => {});
  }, ms);
}

/* ================= GROUP JOIN -> REGISTER BUTTON ================= */
/**
 * ✅ GP ID issue fix:
 * - Bot does NOT check single GROUP_ID
 * - Works in ANY group/supergroup where bot exists
 * - Save group id in Redis for health/debug
 */
async function onJoinSendRegister(chatId, member) {
  if (!member?.id) return;
  if (isExcluded(member.id)) return;

  const already = await isRegistered(member.id);

  const text =
    `🎡 Lucky77 Lucky Wheel\n\n` +
    `မင်္ဂလာပါ ${display(member)} 👋\n\n` +
    (already
      ? `✅ မင်းက Register လုပ်ပြီးသားပါ။`
      : `Event ထဲဝင်ဖို့ Register ကိုနှိပ်ပါ။`) +
    `\n\n⏳ 1 မိနစ်အတွင်း auto-delete ဖြစ်ပါမယ်။`;

  const keyboard = {
    inline_keyboard: [
      [
        already
          ? { text: "✅ Registered", callback_data: "done" }
          : { text: "✅ Register", callback_data: `reg:${member.id}` },
      ],
    ],
  };

  const sent = await bot.sendMessage(chatId, text, { reply_markup: keyboard });
  autoDelete(chatId, sent.message_id, 60000);
}

bot.on("message", async (msg) => {
  try {
    if (!msg?.chat) return;

    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    if (!isGroup) return;

    // remember group id (for debug/health)
    await redis.sadd(KEY_GROUPS, String(msg.chat.id));

    // join event
    if (msg.new_chat_members?.length) {
      for (const m of msg.new_chat_members) {
        await onJoinSendRegister(msg.chat.id, m);
      }
    }
  } catch (e) {
    console.error("message handler error:", e);
  }
});

// optional helper for testing in group: /register
bot.onText(/\/register/i, async (msg) => {
  try {
    if (!msg?.chat) return;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    if (!isGroup) return;
    await onJoinSendRegister(msg.chat.id, msg.from);
  } catch (e) {
    console.error("/register error:", e);
  }
});

/* ================= CALLBACK REGISTER ================= */
bot.on("callback_query", async (cq) => {
  try {
    const data = cq.data || "";

    // ✅ If user clicks Registered again
    if (data === "done") {
      await bot.answerCallbackQuery(cq.id, {
        text: "✅ Registered လုပ်ထားပြီးသားပါ။",
        show_alert: true,
      });
      return;
    }

    if (!data.startsWith("reg:")) return;

    const targetId = data.split(":")[1];
    const fromId = String(cq.from.id);

    if (String(targetId) !== fromId) {
      await bot.answerCallbackQuery(cq.id, {
        text: "ဒီခလုတ်က မင်းအတွက်ပဲ",
        show_alert: true,
      });
      return;
    }

    if (isExcluded(fromId)) {
      await bot.answerCallbackQuery(cq.id, {
        text: "Owner/Bot ကို Register မလုပ်ပါ။",
        show_alert: true,
      });
      return;
    }

    // already?
    const already = await isRegistered(fromId);
    if (already) {
      await bot.answerCallbackQuery(cq.id, {
        text: "✅ Registered လုပ်ထားပြီးသားပါ။",
        show_alert: true,
      });
      return;
    }

    await saveMember(cq.from, "group_register");

    // lock button
    if (cq.message) {
      await bot
        .editMessageReplyMarkup(
          { inline_keyboard: [[{ text: "✅ Registered", callback_data: "done" }]] },
          { chat_id: cq.message.chat.id, message_id: cq.message.message_id }
        )
        .catch(() => {});
    }

    const { name, username } = nameParts(cq.from);

    // ✅ name/username exists -> no DM needed
    if (username || name) {
      await bot.answerCallbackQuery(cq.id, {
        text: `${display(cq.from)} Registered လုပ်ပြီးပါပြီနော် 🎉`,
        show_alert: true,
      });
      return;
    }

    // ✅ id-only -> ask start bot
    await bot.answerCallbackQuery(cq.id, {
      text: "DM Enable လုပ်ရန်လိုပါသည်",
      show_alert: true,
    });

    const startUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=enable` : null;

    const longMsg =
`⚠️ Winner ဖြစ်ရင် ဆက်သွယ်နိုင်ဖို့ DM Service Bot ဘက်က ဆက်သွယ်လို့ရအောင် Start Bot ကိုနှိပ်ပေးပါရှင့်။

📌 ညီမတို့ရဲ့ Lucky77 ဟာ American နိုင်ငံ ထောက်ခံချက်ရ ဂိမ်းဆိုဒ်ကြီးဖြစ်တာမို့ မိတ်ဆွေတို့အနေနဲ့ ယုံကြည်စိတ်ချစွာ

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

const {
  BOT_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  OWNER_ID
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

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN
});

const KEY_PREFIX = "lucky77:v7";
const KEY_MEMBERS = `${KEY_PREFIX}:members`;
const KEY_MEMBER = (id) => `${KEY_PREFIX}:member:${id}`;
const KEY_GROUP_ID = `${KEY_PREFIX}:group_id`;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let BOT_USERNAME = null;

(async () => {
  const me = await bot.getMe();
  BOT_USERNAME = me.username;
  console.log("Bot Ready:", BOT_USERNAME);
})();

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

async function getGroupId() {
  return await redis.get(KEY_GROUP_ID);
}

async function setGroupId(id) {
  await redis.set(KEY_GROUP_ID, String(id));
}

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

/* ================= JOIN ================= */

bot.on("message", async (msg) => {

  if (!msg.chat) return;

  if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    const saved = await getGroupId();
    if (!saved) await setGroupId(msg.chat.id);
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

      await bot.sendMessage(groupId, text, {
        reply_markup: keyboard
      });
    }
  }
});

/* ================= CALLBACK ================= */

bot.on("callback_query", async (cq) => {

  const data = cq.data || "";

  if (data === "done") {
    await bot.answerCallbackQuery(cq.id, {
      text: "✅ Registered လုပ်ထားပြီးသားပါ။",
      show_alert: true
    });
    return;
  }

  if (!data.startsWith("reg:")) return;

  const userId = data.split(":")[1];

  if (String(userId) !== String(cq.from.id)) {
    await bot.answerCallbackQuery(cq.id, {
      text: "ဒီခလုတ်က မင်းအတွက်ပဲ",
      show_alert: true
    });
    return;
  }

  const already = await redis.sismember(KEY_MEMBERS, String(cq.from.id));
  if (already) {
    await bot.answerCallbackQuery(cq.id, {
      text: "✅ Registered လုပ်ထားပြီးသားပါ။",
      show_alert: true
    });
    return;
  }

  await saveMember(cq.from);

  const { name, username } = nameParts(cq.from);

  if (username || name) {
    await bot.answerCallbackQuery(cq.id, {
      text: `${display(cq.from)} Registered လုပ်ပြီးပါပြီနော် 🎉`,
      show_alert: true
    });
  } else {

    await bot.answerCallbackQuery(cq.id, {
      text: "DM Enable လုပ်ရန်လိုပါသည်",
      show_alert: true
    });

    const startUrl = `https://t.me/${BOT_USERNAME}?start=enable`;

    const longMsg =
`⚠️ Winner ဖြစ်ရင် ဆက်သွယ်နိုင်ဖို့ DM Service Enable လုပ်ရန်လိုပါသည်။

📌 ညီမတို့ရဲ့ Lucky77 ဟာ American နိုင်ငံထောက်ခံချက်ရ ဂိမ်းဆိုဒ်ကြီးဖြစ်တာမို့ ယုံကြည်စိတ်ချစွာကစားနိုင်ပါတယ်ရှင့်။

ဆုမဲကံထူးမှုကြီးကို လက်မလွှတ်ရအောင် အောက်က Start Bot ကိုနှိပ်ပါရှင့်။`;

    await bot.sendMessage(cq.message.chat.id, longMsg, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "▶️ Start Bot Register", url: startUrl }]
        ]
      }
    });
  }

  await bot.editMessageReplyMarkup(
    {
      inline_keyboard: [[{ text: "✅ Registered", callback_data: "done" }]]
    },
    {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id
    }
  );
});

/* ================= PRIVATE START ================= */

bot.onText(/\/start/, async (msg) => {

  if (msg.chat.type !== "private") return;

  await redis.hset(KEY_MEMBER(msg.from.id), {
    dm_ready: "1"
  });

  await bot.sendMessage(
    msg.chat.id,
    "🎉 Lucky77 Register အောင်မြင်ပါပြီ။\n\n📩 Prize ပေါက်ရင် ဒီနေရာကနေ ဆက်သွယ်ပေးပါမယ်။"
  );
});

/* ================= SERVER ================= */

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

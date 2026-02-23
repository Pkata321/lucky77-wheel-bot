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
  GROUP_ID,
  OWNER_ID,
  API_KEY,
  PUBLIC_URL,
  EXCLUDE_IDS
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
must(GROUP_ID, "GROUP_ID");
must(OWNER_ID, "OWNER_ID");

/* ================= REDIS ================= */

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN
});

const KEY_PREFIX = "lucky77:v4";
const KEY_MEMBERS = `${KEY_PREFIX}:members`;
const KEY_MEMBER = (id) => `${KEY_PREFIX}:member:${id}`;
const KEY_WINNERS = `${KEY_PREFIX}:winners`;

/* ================= BOT ================= */

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let BOT_USERNAME = null;

(async () => {
  const me = await bot.getMe();
  BOT_USERNAME = me.username;
  console.log("Bot Ready:", BOT_USERNAME);
})();

/* ================= HELPERS ================= */

function excluded(id) {
  if (String(id) === String(OWNER_ID)) return true;
  if (EXCLUDE_IDS && EXCLUDE_IDS.split(",").includes(String(id))) return true;
  return false;
}

function nameParts(u) {
  const name = `${u.first_name || ""} ${u.last_name || ""}`.trim();
  const username = u.username ? u.username : "";
  return { name, username };
}

function display(u) {
  const { name, username } = nameParts(u);
  if (name) return name;
  if (username) return `@${username}`;
  return String(u.id);
}

/* ================= REGISTER FLOW ================= */

async function saveMember(u) {
  if (excluded(u.id)) return;

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

  // Group Join
  if (String(msg.chat.id) === String(GROUP_ID) && msg.new_chat_members) {
    for (const m of msg.new_chat_members) {
      if (excluded(m.id)) continue;

      const text =
        `🎡 Lucky77 Lucky Wheel\n\n` +
        `မင်္ဂလာပါ ${display(m)} 👋\n\n` +
        `Event ထဲဝင်ဖို့ Register ကိုနှိပ်ပါ။`;

      const keyboard = {
        inline_keyboard: [
          [{ text: "✅ Register", callback_data: `reg:${m.id}` }]
        ]
      };

      const sent = await bot.sendMessage(GROUP_ID, text, {
        reply_markup: keyboard
      });

      setTimeout(() => {
        bot.deleteMessage(GROUP_ID, sent.message_id).catch(() => {});
      }, 30000);
    }
  }
});

/* ================= CALLBACK ================= */

bot.on("callback_query", async (cq) => {
  const data = cq.data || "";
  const uid = String(cq.from.id);

  if (!data.startsWith("reg:")) return;

  if (data.split(":")[1] !== uid) {
    await bot.answerCallbackQuery(cq.id, {
      text: "ဒီခလုတ်က မင်းအတွက်ပဲ",
      show_alert: true
    });
    return;
  }

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
      GROUP_ID,
      `⚠️ Direct link မလုပ်နိုင်ပါ။\nDM Enable ဖို့ Start Bot လုပ်ပါ။`,
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

function auth(req, res, next) {
  const key = req.query.key || req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ ok: false });
  next();
}

app.get("/health", async (req, res) => {
  const count = await redis.scard(KEY_MEMBERS);
  res.json({ ok: true, members: count });
});

/* MEMBERS LIST */

app.get("/api/members", auth, async (req, res) => {
  const ids = await redis.smembers(KEY_MEMBERS);
  const list = [];

  for (const id of ids) {
    const m = await redis.hgetall(KEY_MEMBER(id));
    list.push({
      id,
      name: m.name || "",
      username: m.username || "",
      dm_ready: m.dm_ready === "1"
    });
  }

  res.json({ ok: true, members: list });
});

/* NOTICE (DM send) */

app.post("/api/notice", auth, async (req, res) => {
  const { user_id, text } = req.body;

  try {
    await bot.sendMessage(Number(user_id), text);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* WINNER HISTORY */

app.post("/api/winner", auth, async (req, res) => {
  const { user_id, prize } = req.body;

  const item = {
    user_id,
    prize,
    at: new Date().toISOString()
  };

  await redis.lpush(KEY_WINNERS, JSON.stringify(item));
  await redis.ltrim(KEY_WINNERS, 0, 200);

  res.json({ ok: true });
});

app.get("/api/winners", auth, async (req, res) => {
  const list = await redis.lrange(KEY_WINNERS, 0, 200);
  res.json({
    ok: true,
    items: list.map((x) => JSON.parse(x))
  });
});

app.listen(process.env.PORT || 10000, () =>
  console.log("Server running")
);

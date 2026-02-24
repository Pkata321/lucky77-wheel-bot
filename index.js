/* lucky77-wheel-bot (Render) - FINAL
   ✅ Join => Register button (auto delete 30s)
   ✅ Register click => save to Redis immediately (NO need DM to save)
   ✅ Registered click again => popup "Registered already" (show_alert)
   ✅ ID-only => show Start Bot 안내 + deep link (auto delete 30s)
   ✅ Exclude OWNER / BOT / EXCLUDE_IDS
   ✅ API for CodePen:
      - GET  /api/members?key=API_KEY
      - POST /api/notice?key=API_KEY   { user_id, text }
      - POST /api/winner?key=API_KEY   { user_id, prize, message?, send_dm? }
      - GET  /api/winners?key=API_KEY
*/

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

// ===================== ENV =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const API_KEY = process.env.API_KEY || "Lucky77_luckywheel_77";
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const OWNER_ID = process.env.OWNER_ID ? String(process.env.OWNER_ID) : null;
const GROUP_ID = process.env.GROUP_ID ? String(process.env.GROUP_ID) : null;

// Optional exclude ids (comma separated)
const EXCLUDE_IDS = (process.env.EXCLUDE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(String);

// ===================== VALIDATION =====================
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
must(GROUP_ID, "GROUP_ID");

// ===================== REDIS =====================
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const KEY_PREFIX = "lucky77:vFINAL";
const KEY_MEMBERS_SET = `${KEY_PREFIX}:members:set`; // SET user_id
const KEY_MEMBER_HASH = (uid) => `${KEY_PREFIX}:member:${uid}`; // HASH
const KEY_WINNER_HISTORY = `${KEY_PREFIX}:winners:list`; // LIST json

// ===================== BOT =====================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let BOT_ID = null;
let BOT_USERNAME = null;

(async () => {
  try {
    const me = await bot.getMe();
    BOT_ID = String(me.id);
    BOT_USERNAME = me.username ? String(me.username) : null;
    console.log("Bot identity:", { BOT_ID, BOT_USERNAME });
  } catch (e) {
    console.error("getMe error:", e);
  }
})();

// ===================== HELPERS =====================
function isTargetGroup(chatId) {
  return String(chatId) === String(GROUP_ID);
}

function isExcludedUser(userId) {
  const id = String(userId);
  if (id === OWNER_ID) return true;
  if (BOT_ID && id === BOT_ID) return true;
  if (EXCLUDE_IDS.includes(id)) return true;
  return false;
}

function nameParts(u) {
  const name = `${u.first_name || ""} ${u.last_name || ""}`.trim();
  const username = u.username ? String(u.username) : "";
  return { name, username };
}

function display(u) {
  const { name, username } = nameParts(u);
  if (name) return name;
  if (username) return `@${username.replace("@", "")}`;
  return String(u.id);
}

async function isRegistered(uid) {
  const ok = await redis.sismember(KEY_MEMBERS_SET, String(uid));
  return !!ok;
}

async function saveMember(u, source = "group_register") {
  const uid = String(u.id);
  if (isExcludedUser(uid)) return { ok: false, reason: "excluded" };

  const { name, username } = nameParts(u);

  await redis.sadd(KEY_MEMBERS_SET, uid);
  await redis.hset(KEY_MEMBER_HASH(uid), {
    id: uid,
    name,
    username,
    source,
    registered_at: new Date().toISOString(),
    dm_ready: "0",
  });

  return { ok: true, member: { id: uid, name, username } };
}

async function setDmReady(uid) {
  try {
    await redis.hset(KEY_MEMBER_HASH(String(uid)), {
      dm_ready: "1",
      dm_ready_at: new Date().toISOString(),
    });
  } catch (_) {}
}

async function trySendDM(uid, text) {
  try {
    await bot.sendMessage(Number(uid), text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.response?.body || e?.message || String(e) };
  }
}

async function sendAutoDelete(chatId, text, opts = {}, ms = 30000) {
  const sent = await bot.sendMessage(chatId, text, opts);
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, sent.message_id);
    } catch (_) {}
  }, ms);
  return sent;
}

// ===================== GROUP JOIN => REGISTER BUTTON =====================
async function sendRegisterButtonForUser(u) {
  const uid = String(u.id);
  if (isExcludedUser(uid)) return;

  const already = await isRegistered(uid);

  const text =
    `🎡 Lucky77 Lucky Wheel\n\n` +
    `မင်္ဂလာပါ ${display(u)} 👋\n\n` +
    (already
      ? `✅ မင်းက Register လုပ်ပြီးသားပါ။`
      : `✅ Event ထဲဝင်ဖို့ အောက်က Register ကိုနှိပ်ပါ။`) +
    `\n\n⏳ 30 စက္ကန့်အတွင်း မနှိပ်ရင် message auto-delete ဖြစ်ပါမယ်။`;

  const keyboard = {
    inline_keyboard: [
      [
        already
          ? { text: "✅ Registered", callback_data: `noop:${uid}` }
          : { text: "✅ Register", callback_data: `reg:${uid}` },
      ],
    ],
  };

  const msg = await bot.sendMessage(GROUP_ID, text, { reply_markup: keyboard });

  // ✅ 30s auto delete register message
  setTimeout(async () => {
    try {
      await bot.deleteMessage(GROUP_ID, msg.message_id);
    } catch (_) {}
  }, 30000);
}

bot.on("message", async (msg) => {
  try {
    if (!msg.chat) return;

    // ✅ only in target group
    if (isTargetGroup(msg.chat.id) && msg.new_chat_members?.length) {
      for (const m of msg.new_chat_members) {
        await sendRegisterButtonForUser(m);
      }
    }
  } catch (e) {
    console.error("message handler error:", e);
  }
});

// ===================== CALLBACK QUERY =====================
bot.on("callback_query", async (cq) => {
  try {
    const data = cq.data || "";
    const from = cq.from;
    const fromId = String(from.id);

    const answer = async (text, alert = false) => {
      try {
        await bot.answerCallbackQuery(cq.id, { text, show_alert: alert });
      } catch (_) {}
    };

    // ✅ Registered button pressed again => show popup (you asked)
    if (data.startsWith("noop:")) {
      await answer("✅ Registered လုပ်ပြီးသားပါနော်", true);
      return;
    }

    if (!data.startsWith("reg:")) {
      await answer("Invalid action", false);
      return;
    }

    const targetId = data.split(":")[1];
    if (!targetId || String(targetId) !== fromId) {
      await answer("ဒီ Register ခလုတ်က မင်းအတွက်ပဲ သုံးလို့ရပါတယ်။", true);
      return;
    }

    if (isExcludedUser(fromId)) {
      await answer("Owner/Admin/Bot ကို Register မလုပ်ပါ။", true);
      return;
    }

    const already = await isRegistered(fromId);
    if (already) {
      // ✅ already => popup too
      await answer("✅ Registered လုပ်ပြီးသားပါနော်", true);
    } else {
      const saved = await saveMember(from, "group_register_button");
      if (!saved.ok) {
        await answer("Register မအောင်မြင်ပါ။", true);
        return;
      }

      // ✅ success popup (bigger)
      await answer("🎉 Registered!\n\n✅ Register လုပ်ပြီးပါပြီနော်။", true);
    }

    // ✅ lock button to Registered (cannot register again)
    if (cq.message) {
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: "✅ Registered", callback_data: `noop:${fromId}` }]] },
          { chat_id: cq.message.chat.id, message_id: cq.message.message_id }
        );
      } catch (_) {}
    }

    // ✅ ID-only => show Start Bot 안내 message (auto delete)
    const { name, username } = nameParts(from);
    const isIdOnly = !username && !name;

    if (isIdOnly) {
      const startUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=enable` : null;

      const guideText =
        `⚠️ လူကြီးမင်းရဲ့ Username / Name မရှိသေးလို့ Winner ဖြစ်လာတဲ့အချိန် DM နဲ့ဆက်သွယ်ဖို့ မရနိုင်သေးပါ။\n\n` +
        `✅ DM Service Enable လုပ်ဖို့ အောက်က "Start Bot" ကိုနှိပ်ပေးပါရှင့်။\n\n` +
        `📌ညီမတို့ရဲ့ Lucky77 ဟာဆိုရင်တော့ american နိုင်ငံ ထောက်ခံချက်ရ ဂိမ်းဆိုဒ်ကြီးဖစ်တာမို့ မိတ်ဆွေတို့အနေနဲ့ ယုံကြည်စိတ်ချစွာ ကစားနိုင်ပါတယ်ရှင့်။\n` +
        `ခုလိုစီစဉ်ပေးထားခြင်းကလည်း လူကြီးမင်းတို့ရဲ့ ဆုမဲကံထူးမှုကြီးကို လက်မလွှတ်ရအောင် စီစဉ်ပေးထားတာမို့ တူတူပါဝင်လိုက်ကြစို့...`;

      const opts = startUrl
        ? { reply_markup: { inline_keyboard: [[{ text: "▶️ Start Bot (DM Enable)", url: startUrl }]] } }
        : {};

      await sendAutoDelete(GROUP_ID, guideText, opts, 30000);
    }

  } catch (e) {
    console.error("callback_query error:", e);
  }
});

// ===================== PRIVATE /start =====================
bot.onText(/\/start/i, async (msg) => {
  try {
    if (msg.chat.type !== "private") return;

    const u = msg.from;
    if (!u) return;

    // ensure saved
    await saveMember(u, "private_start");
    await setDmReady(u.id);

    await bot.sendMessage(
      msg.chat.id,
      "✅ DM Enable ပြီးပါပြီ။\nPrize ပေါက်တဲ့အချိန် ဒီ DM ထဲကို message လာပါမယ် 🎉"
    );
  } catch (e) {
    console.error("/start error:", e);
  }
});

// ===================== EXPRESS API =====================
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

function requireApiKey(req, res, next) {
  const k = req.headers["x-api-key"] || req.query.key;
  if (!k || String(k) !== String(API_KEY)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

app.get("/", (req, res) => {
  res.status(200).send(
    "Lucky77 wheel bot is running ✅\n\n" +
      "GET /health\n" +
      "GET /api/members?key=API_KEY\n" +
      "POST /api/notice?key=API_KEY\n" +
      "POST /api/winner?key=API_KEY\n" +
      "GET /api/winners?key=API_KEY\n"
  );
});

app.get("/health", async (req, res) => {
  try {
    const count = await redis.scard(KEY_MEMBERS_SET);
    res.json({
      ok: true,
      service: "lucky77-wheel-bot",
      members: Number(count) || 0,
      group_id: GROUP_ID,
      bot_username: BOT_USERNAME || null,
      public_url: PUBLIC_URL || null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/api/members", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const members = [];

    for (const id of ids || []) {
      const h = await redis.hgetall(KEY_MEMBER_HASH(id));
      if (!h || !h.id) continue;
      if (isExcludedUser(h.id)) continue;

      members.push({
        id: String(h.id),
        name: (h.name || "").trim(),
        username: (h.username || "").trim(), // without @
        dm_ready: String(h.dm_ready || "0") === "1",
        registered_at: h.registered_at || "",
        source: h.source || "",
      });
    }

    members.sort((a, b) => (a.registered_at || "").localeCompare(b.registered_at || ""));
    res.json({ ok: true, total: members.length, members });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// DM Notice: { user_id, text }
app.post("/api/notice", requireApiKey, async (req, res) => {
  try {
    const { user_id, text } = req.body || {};
    if (!user_id || !text) return res.status(400).json({ ok: false, error: "user_id and text required" });

    const uid = String(user_id);
    const dm = await trySendDM(uid, String(text));

    res.json({ ok: true, dm_ok: dm.ok, dm_error: dm.ok ? "" : String(dm.error || "") });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Winner log: { user_id, prize, message?, send_dm? }
app.post("/api/winner", requireApiKey, async (req, res) => {
  try {
    const { user_id, prize, message, send_dm } = req.body || {};
    if (!user_id || !prize) return res.status(400).json({ ok: false, error: "user_id and prize required" });

    const uid = String(user_id);
    const member = await redis.hgetall(KEY_MEMBER_HASH(uid));

    const show =
      (member?.name && member.name.trim()) ||
      (member?.username && ("@" + member.username.trim())) ||
      uid;

    const text = message || `🎉 Winner!\n\n${show}\nPrize: ${prize}`;

    let dm = { ok: false, error: "" };
    if (send_dm) dm = await trySendDM(uid, text);

    const item = {
      user_id: uid,
      prize: String(prize),
      display: show,
      dm_ok: !!dm.ok,
      dm_error: dm.ok ? "" : String(dm.error || ""),
      at: new Date().toISOString(),
    };

    await redis.lpush(KEY_WINNER_HISTORY, JSON.stringify(item));
    await redis.ltrim(KEY_WINNER_HISTORY, 0, 200);

    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/api/winners", requireApiKey, async (req, res) => {
  try {
    const list = await redis.lrange(KEY_WINNER_HISTORY, 0, 200);
    const items = (list || []).map((s) => {
      try { return JSON.parse(s); } catch { return { raw: s }; }
    });
    res.json({ ok: true, total: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

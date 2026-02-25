  /* Lucky77 Wheel Bot (Render) - PRO v1.0
   ✅ Group join => Register button (auto delete 60s)
   ✅ Register click => save member to Redis immediately
   ✅ If name/username missing => send Start Bot (DM Enable) guide (auto delete 60s)
   ✅ "Registered" click again => popup shows "already registered"
   ✅ API for CodePen (API_KEY protected):
      - GET  /health
      - GET  /members        (members list)
      - GET  /pool           (eligible pool count)
      - POST /config/prizes  (set prize config)
      - POST /spin           (spin => prize + random member, no-repeat winner)
      - GET  /history        (winner history)
      - POST /notice         (DM a user_id)  (for id-only members)
      - POST /restart-spin   (reset winners + restore pool)
*/

"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

// ================= ENV =================
const {
  BOT_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  OWNER_ID,
  API_KEY,
  GROUP_ID,          // optional (if empty => bot works in any group it is added to)
  EXCLUDE_IDS        // optional: "123,456"
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
must(API_KEY, "API_KEY");

// ================= Redis =================
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const KEY_PREFIX = "lucky77:pro:v1";
const KEY_MEMBERS_SET = `${KEY_PREFIX}:members:set`;        // set(user_id)
const KEY_MEMBER_HASH = (id) => `${KEY_PREFIX}:member:${id}`; // hash
const KEY_WINNERS_SET = `${KEY_PREFIX}:winners:set`;        // set(user_id) winners
const KEY_HISTORY_LIST = `${KEY_PREFIX}:history:list`;      // list JSON
const KEY_PRIZE_BAG = `${KEY_PREFIX}:prizes:bag`;           // list of prizes (expanded)
const KEY_PRIZE_SOURCE = `${KEY_PREFIX}:prizes:source`;     // raw text
const KEY_LAST_GROUP = `${KEY_PREFIX}:last_group_id`;       // for health debug

// ================= Bot =================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let BOT_ID = null;
let BOT_USERNAME = null;

(async () => {
  const me = await bot.getMe();
  BOT_ID = String(me.id);
  BOT_USERNAME = me.username ? String(me.username) : null;
  console.log("Bot Ready:", { BOT_ID, BOT_USERNAME });
})().catch((e) => console.error("getMe error:", e));

// ================= Helpers =================
const excludeIds = (EXCLUDE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(String);

function isExcludedUser(userId) {
  const id = String(userId);
  if (id === String(OWNER_ID)) return true;
  if (BOT_ID && id === String(BOT_ID)) return true;
  if (excludeIds.includes(id)) return true;
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
  if (username) return `@${username}`;
  return String(u.id);
}

async function isRegistered(userId) {
  const ok = await redis.sismember(KEY_MEMBERS_SET, String(userId));
  return !!ok;
}

async function saveMember(u, source = "group_register") {
  const userId = String(u.id);
  if (isExcludedUser(userId)) return { ok: false, reason: "excluded" };

  const { name, username } = nameParts(u);

  await redis.sadd(KEY_MEMBERS_SET, userId);
  await redis.hset(KEY_MEMBER_HASH(userId), {
    id: userId,
    name,
    username,
    dm_ready: "0", // will become 1 after /start in private
    source,
    registered_at: new Date().toISOString(),
  });

  return { ok: true };
}

async function setDmReady(userId) {
  await redis.hset(KEY_MEMBER_HASH(String(userId)), {
    dm_ready: "1",
    dm_ready_at: new Date().toISOString(),
  });
}

async function trySendDM(userId, text) {
  try {
    await bot.sendMessage(Number(userId), text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.response?.body || e?.message || String(e) };
  }
}

function targetGroup(chat) {
  if (!chat) return false;
  if (String(chat.type) !== "group" && String(chat.type) !== "supergroup") return false;

  // ✅ If GROUP_ID is set => only that group
  if (GROUP_ID && String(chat.id) !== String(GROUP_ID)) return false;

  // ✅ If GROUP_ID is not set => allow any group bot is in
  return true;
}

async function autoDelete(chatId, messageId, ms = 60000) {
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (_) {}
  }, ms);
}

function requireApiKey(req, res, next) {
  const k = req.headers["x-api-key"] || req.query.key;
  if (!k || String(k) !== String(API_KEY)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// ================= Prize parse (expand) =================
function parsePrizeTextExpand(prizeText) {
  const lines = String(prizeText || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  const bag = [];
  for (const line of lines) {
    // accept:
    // "10000Ks 4time"
    // "10000Ks 4"
    let m = line.match(/^(.+?)\s+(\d+)\s*time$/i);
    if (!m) m = line.match(/^(.+?)\s+(\d+)$/i);
    if (!m) continue;

    const prize = m[1].trim();
    const times = parseInt(m[2], 10);
    if (!prize || !Number.isFinite(times) || times <= 0) continue;
    for (let i = 0; i < times; i++) bag.push(prize);
  }
  return bag;
}

// ================= Telegram Group Flow =================
async function sendRegisterMessage(chatId, newUser) {
  const userId = String(newUser.id);
  if (isExcludedUser(userId)) return;

  const already = await isRegistered(userId);

  const text =
    `🎡 Lucky77 Lucky Wheel\n\n` +
    `မင်္ဂလာပါ ${display(newUser)} 👋\n\n` +
    (already
      ? `✅ မင်းက Register လုပ်ပြီးသားပါ။`
      : `✅ Event ထဲဝင်ဖို့ အောက်က Register ကိုနှိပ်ပါ။`) +
    `\n\n⏳ 1 minute အတွင်း ဒီ message auto-delete ဖြစ်ပါမယ်။`;

  const keyboard = {
    inline_keyboard: [
      [
        already
          ? { text: "✅ Registered", callback_data: `done:${userId}` }
          : { text: "✅ Register", callback_data: `reg:${userId}` },
      ],
    ],
  };

  const sent = await bot.sendMessage(chatId, text, { reply_markup: keyboard });
  await autoDelete(chatId, sent.message_id, 60000);
}

bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat) return;

    if (targetGroup(msg.chat)) {
      // For debugging
      await redis.set(KEY_LAST_GROUP, String(msg.chat.id));

      if (msg.new_chat_members?.length) {
        for (const m of msg.new_chat_members) {
          await sendRegisterMessage(msg.chat.id, m);
        }
      }
    }
  } catch (e) {
    console.error("message handler error:", e);
  }
});

// Registered click => popup
bot.on("callback_query", async (cq) => {
  try {
    const data = cq.data || "";
    const from = cq.from;
    const fromId = String(from.id);

    const answer = async (text, alert = true) => {
      try {
        await bot.answerCallbackQuery(cq.id, { text, show_alert: alert });
      } catch (_) {}
    };

    // done:xxxx => already registered popup
    if (data.startsWith("done:")) {
      await answer("✅ Registered လုပ်ထားပြီးသားပါ။", true);
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
      await answer("✅ Registered လုပ်ထားပြီးသားပါ။", true);
      return;
    }

    await saveMember(from, "group_register_button");

    const { name, username } = nameParts(from);
    if (username || name) {
      await answer(`${display(from)} Registered လုပ်ပြီးပါပြီနော် 🎉`, true);
    } else {
      await answer("DM Enable လုပ်ရန်လိုပါသည်", true);

      // Send guidance message (auto delete)
      const startUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=enable` : null;

      const longMsg =
`⚠️ Winner ဖြစ်ရင် ဆက်သွယ်နိုင်ဖို့ DM Service Enable လုပ်ရန်လိုပါသည်။

📌 ညီမတို့ရဲ့ Lucky77 ဟာ American နိုင်ငံထောက်ခံချက်ရ ဂိမ်းဆိုဒ်ကြီးဖြစ်တာမို့ ယုံကြည်စိတ်ချစွာကစားနိုင်ပါတယ်ရှင့်။

ဆုမဲကံထူးမှုကြီးကို လက်မလွှတ်ရအောင် အောက်က Start Bot Register ကိုနှိပ်ပါရှင့်။`;

      const sent2 = await bot.sendMessage(cq.message.chat.id, longMsg, {
        reply_markup: startUrl
          ? { inline_keyboard: [[{ text: "▶️ Start Bot Register", url: startUrl }]] }
          : undefined,
      });
      await autoDelete(cq.message.chat.id, sent2.message_id, 60000);
    }

    // Lock button to Registered (clickable => popup)
    if (cq.message) {
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: "✅ Registered", callback_data: `done:${fromId}` }]] },
          { chat_id: cq.message.chat.id, message_id: cq.message.message_id }
        );
      } catch (_) {}
    }
  } catch (e) {
    console.error("callback_query error:", e);
  }
});

// Private /start => mark dm_ready (for id-only)
bot.onText(/\/start/i, async (msg) => {
  try {
    if (msg.chat.type !== "private") return;
    const u = msg.from;
    if (!u) return;

    // Ensure member exists (save if needed)
    await saveMember(u, "private_start");
    await setDmReady(u.id);

    await bot.sendMessage(
      msg.chat.id,
      "🎉 Lucky77 Register အောင်မြင်ပါပြီ။\n\n📩 Prize ပေါက်ရင် ဒီနေရာကနေ ဆက်သွယ်ပေးပါမယ်။"
    );
  } catch (e) {
    console.error("/start error:", e);
  }
});

// ================= Express API =================
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.send(
    "Lucky77 Wheel Bot PRO v1.0 ✅\n\n" +
    "GET  /health\n" +
    "GET  /members?key=API_KEY\n" +
    "GET  /pool?key=API_KEY\n" +
    "POST /config/prizes?key=API_KEY  { prizeText }\n" +
    "POST /spin?key=API_KEY\n" +
    "GET  /history?key=API_KEY\n" +
    "POST /notice?key=API_KEY { user_id, text }\n" +
    "POST /restart-spin?key=API_KEY\n"
  );
});

app.get("/health", async (req, res) => {
  try {
    const members = await redis.scard(KEY_MEMBERS_SET);
    const winners = await redis.scard(KEY_WINNERS_SET);
    const bagLen = await redis.llen(KEY_PRIZE_BAG);
    const lastGroup = await redis.get(KEY_LAST_GROUP);

    res.json({
      ok: true,
      bot_username: BOT_USERNAME || null,
      group_id_env: GROUP_ID || null,
      last_group_seen: lastGroup || null,
      members: Number(members) || 0,
      winners: Number(winners) || 0,
      remaining_prizes: Number(bagLen) || 0,
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/members", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const members = [];

    for (const id of ids || []) {
      const h = await redis.hgetall(KEY_MEMBER_HASH(id));
      if (!h || !h.id) continue;
      if (isExcludedUser(h.id)) continue;

      const isWinner = await redis.sismember(KEY_WINNERS_SET, String(h.id));
      const name = (h.name || "").trim();
      const username = (h.username || "").trim();
      const displayName = name || (username ? `@${username.replace("@", "")}` : String(h.id));

      members.push({
        id: String(h.id),
        name,
        username: username.replace("@", ""),
        display: displayName,
        dm_ready: String(h.dm_ready || "0") === "1",
        isWinner: !!isWinner,
        registered_at: h.registered_at || "",
      });
    }

    members.sort((a, b) => (a.registered_at || "").localeCompare(b.registered_at || ""));
    res.json({ ok: true, total: members.length, members });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/pool", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    let count = 0;

    for (const id of ids || []) {
      if (isExcludedUser(id)) continue;
      const isWinner = await redis.sismember(KEY_WINNERS_SET, String(id));
      if (!isWinner) count++;
    }

    res.json({ ok: true, count });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/config/prizes", requireApiKey, async (req, res) => {
  try {
    const { prizeText } = req.body || {};
    const bag = parsePrizeTextExpand(prizeText);

    if (!bag.length) {
      return res.status(400).json({ ok: false, error: "No valid prizes. Example: 10000Ks 4time" });
    }

    // reset bag
    await redis.del(KEY_PRIZE_BAG);
    // push all
    for (const p of bag) {
      await redis.rpush(KEY_PRIZE_BAG, String(p));
    }
    await redis.set(KEY_PRIZE_SOURCE, String(prizeText || ""));

    res.json({ ok: true, total: bag.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

function randPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

app.post("/spin", requireApiKey, async (req, res) => {
  try {
    // 1) pick prize from remaining bag
    const bagLen = await redis.llen(KEY_PRIZE_BAG);
    if (!bagLen || bagLen <= 0) {
      return res.status(400).json({ ok: false, error: "No prizes left. Set prizes in Settings and Save." });
    }

    // get all prizes (small to medium ok)
    const bag = await redis.lrange(KEY_PRIZE_BAG, 0, bagLen - 1);
    const prize = randPick(bag);

    // remove one occurrence (lrem)
    await redis.lrem(KEY_PRIZE_BAG, 1, String(prize));

    // 2) pick member from pool (not winner yet)
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const eligible = [];
    for (const id of ids || []) {
      if (isExcludedUser(id)) continue;
      const isWinner = await redis.sismember(KEY_WINNERS_SET, String(id));
      if (!isWinner) eligible.push(String(id));
    }

    if (!eligible.length) {
      return res.status(400).json({ ok: false, error: "No members left in pool. Restart Spin to reset winners." });
    }

    const winnerId = randPick(eligible);
    const h = await redis.hgetall(KEY_MEMBER_HASH(winnerId));

    const name = (h?.name || "").trim();
    const username = (h?.username || "").trim().replace("@", "");
    const disp = name || (username ? `@${username}` : winnerId);

    // mark winner
    await redis.sadd(KEY_WINNERS_SET, String(winnerId));

    const item = {
      at: new Date().toISOString(),
      prize: String(prize),
      winner: {
        id: String(winnerId),
        name,
        username,
        display: disp,
        dm_ready: String(h?.dm_ready || "0") === "1",
      },
    };

    await redis.lpush(KEY_HISTORY_LIST, JSON.stringify(item));
    await redis.ltrim(KEY_HISTORY_LIST, 0, 200);

    res.json({ ok: true, prize: String(prize), winner: item.winner });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/history", requireApiKey, async (req, res) => {
  try {
    const list = await redis.lrange(KEY_HISTORY_LIST, 0, 200);
    const history = (list || []).map((s) => {
      try { return JSON.parse(s); } catch { return { raw: s }; }
    });
    res.json({ ok: true, total: history.length, history });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ID-only "Notice" DM
app.post("/notice", requireApiKey, async (req, res) => {
  try {
    const { user_id, text } = req.body || {};
    if (!user_id || !text) {
      return res.status(400).json({ ok: false, error: "user_id and text required" });
    }

    const uid = String(user_id);
    const dm = await trySendDM(uid, String(text));

    res.json({ ok: true, dm_ok: dm.ok, dm_error: dm.ok ? "" : String(dm.error || "") });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Restart => reset winners + history + restore prizes from last saved source
app.post("/restart-spin", requireApiKey, async (req, res) => {
  try {
    await redis.del(KEY_WINNERS_SET);
    await redis.del(KEY_HISTORY_LIST);

    const raw = await redis.get(KEY_PRIZE_SOURCE);
    if (raw) {
      const bag = parsePrizeTextExpand(raw);
      await redis.del(KEY_PRIZE_BAG);
      for (const p of bag) await redis.rpush(KEY_PRIZE_BAG, String(p));
    }

    res.json({ ok: true, reset: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ Fallback: group ထဲမှာ /register ရိုက်ရင် Register message ပြန်ပို့
bot.onText(/\/register(@\w+)?/i, async (msg) => {
  try {
    if (!msg || !msg.chat) return;
    if (!targetGroup(msg.chat)) return;

    // /register ကို ရိုက်တဲ့သူကို Register message ပြန်ပို့
    await sendRegisterMessage(msg.chat.id, msg.from);
  } catch (e) {
    console.error("/register error:", e);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on", PORT));

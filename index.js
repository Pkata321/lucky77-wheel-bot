/* lucky77-wheel-bot (Render) - FINAL v8
   - Group join -> Register button (auto delete 30s)
   - Register click -> save member to Redis immediately
   - Registered click again -> popup shows "already registered"
   - ID-only member -> show Start Bot (DM Enable) message (auto delete 30s)
   - CodePen API:
      GET  /health
      GET  /api/members            (x-api-key or ?key=)
      POST /api/config/prizes      (save prizeText + reset prize bag)
      POST /api/spin               (random prize+random member, no-repeat)
      POST /api/restart-spin       (reset pool + reset winners + reset prize bag)
      GET  /api/history            (winner history)
      POST /api/notice             (DM a user_id - for ID-only winners)
*/

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
  API_KEY = "Lucky77_luckywheel_77",
  GROUP_ID, // optional (if not set, auto detect + save in redis)
  EXCLUDE_IDS = "", // optional: "123,456"
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

const KEY_PREFIX = "lucky77:v8";

const KEY_MEMBERS_SET = `${KEY_PREFIX}:members:set`; // SET userId
const KEY_MEMBER_HASH = (id) => `${KEY_PREFIX}:member:${id}`; // HASH member data

const KEY_GROUP_ID = `${KEY_PREFIX}:group_id`; // string
const KEY_PRIZE_TEXT = `${KEY_PREFIX}:prizes:text`; // string
const KEY_PRIZE_BAG = `${KEY_PREFIX}:prizes:bag`; // LIST of prize names (expanded)
const KEY_POOL_SET = `${KEY_PREFIX}:pool:set`; // SET of eligible member ids (no-repeat)
const KEY_WINNERS_SET = `${KEY_PREFIX}:winners:set`; // SET of winner ids
const KEY_HISTORY_LIST = `${KEY_PREFIX}:history:list`; // LIST of JSON history

/* ================= BOT ================= */

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let BOT_ID = null;
let BOT_USERNAME = null;

const EXCLUDE_SET = new Set(
  EXCLUDE_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(String)
);

(async () => {
  try {
    const me = await bot.getMe();
    BOT_ID = String(me.id);
    BOT_USERNAME = me.username ? String(me.username) : null;
    console.log("Bot Ready:", { BOT_ID, BOT_USERNAME });
  } catch (e) {
    console.error("getMe error:", e);
  }
})();

/* ================= HELPERS ================= */

function nameParts(u) {
  const name = `${u.first_name || ""} ${u.last_name || ""}`.trim();
  const username = u.username ? String(u.username) : "";
  return { name, username };
}

function display(uOrHash) {
  // accepts Telegram user OR redis hash-like
  const first = uOrHash.first_name || "";
  const last = uOrHash.last_name || "";
  const name = (uOrHash.name || `${first} ${last}`.trim()).trim();
  const username = (uOrHash.username || "").trim();

  if (name) return name;
  if (username) return username.startsWith("@") ? username : `@${username}`;
  return String(uOrHash.id || uOrHash.user_id || "");
}

function isExcludedId(id) {
  const s = String(id);
  if (s === String(OWNER_ID)) return true;
  if (BOT_ID && s === String(BOT_ID)) return true;
  if (EXCLUDE_SET.has(s)) return true;
  return false;
}

async function getGroupId() {
  if (GROUP_ID) return String(GROUP_ID);
  const v = await redis.get(KEY_GROUP_ID);
  return v ? String(v) : null;
}

async function setGroupId(id) {
  await redis.set(KEY_GROUP_ID, String(id));
  console.log("Group ID Saved:", id);
}

async function isRegistered(id) {
  return !!(await redis.sismember(KEY_MEMBERS_SET, String(id)));
}

async function saveMember(u, source = "group_register") {
  const uid = String(u.id);
  if (isExcludedId(uid)) return { ok: false, reason: "excluded" };

  const { name, username } = nameParts(u);

  await redis.sadd(KEY_MEMBERS_SET, uid);

  await redis.hset(KEY_MEMBER_HASH(uid), {
    id: uid,
    name,
    username, // WITHOUT @
    first_name: u.first_name ? String(u.first_name) : "",
    last_name: u.last_name ? String(u.last_name) : "",
    dm_ready: "0",
    source: String(source),
    registered_at: new Date().toISOString(),
  });

  // also put into pool (no-repeat)
  await redis.sadd(KEY_POOL_SET, uid);

  return { ok: true };
}

async function setDmReady(id) {
  await redis.hset(KEY_MEMBER_HASH(String(id)), {
    dm_ready: "1",
    dm_ready_at: new Date().toISOString(),
  });
}

async function trySendDM(userId, text, extra = {}) {
  try {
    await bot.sendMessage(Number(userId), text, extra);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e?.response?.body || e?.message || String(e),
    };
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

/* ================= PRIZE PARSE =================
   Format lines:
     10000Ks 4time
     5000Ks 2time
   also allow:
     10000Ks 4
*/
function parsePrizeTextToBag(prizeText) {
  const lines = String(prizeText || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  const bag = [];
  for (const line of lines) {
    const m =
      line.match(/^(.+?)\s+(\d+)\s*time$/i) ||
      line.match(/^(.+?)\s+\(?(\d+)\)?\s*time$/i) ||
      line.match(/^(.+?)\s+(\d+)$/i);

    if (!m) continue;

    const prize = String(m[1] || "").trim();
    const times = parseInt(m[2], 10);

    if (!prize) continue;
    if (!Number.isFinite(times) || times <= 0) continue;

    for (let i = 0; i < times; i++) bag.push(prize);
  }

  // shuffle bag
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }

  return bag;
}

async function resetPrizeBagFromStoredText() {
  const prizeText = await redis.get(KEY_PRIZE_TEXT);
  const bag = parsePrizeTextToBag(prizeText || "");
  await redis.del(KEY_PRIZE_BAG);

  if (bag.length) {
    // rpush batch
    // upstash supports array
    await redis.rpush(KEY_PRIZE_BAG, ...bag);
  }
  return bag.length;
}

/* ================= GROUP JOIN -> REGISTER BUTTON ================= */

async function sendRegisterButtonForNewMember(groupId, m) {
  const uid = String(m.id);
  if (isExcludedId(uid)) return;

  const already = await isRegistered(uid);

  const text =
    `🎡 Lucky77 Lucky Wheel\n\n` +
    `မင်္ဂလာပါ ${display(m)} 👋\n\n` +
    (already
      ? `✅ မင်းက Register လုပ်ပြီးသားပါ။`
      : `✅ Event ထဲဝင်ဖို့ အောက်က Register ကိုနှိပ်ပါ။`) +
    `\n\n⏳ 30 စက္ကန့်အတွင်း မနှိပ်ရင် message auto-delete ဖြစ်ပါမယ်။`;

  const keyboard = {
    inline_keyboard: [
      [
        already
          ? { text: "✅ Registered", callback_data: `done:${uid}` }
          : { text: "✅ Register", callback_data: `reg:${uid}` },
      ],
    ],
  };

  const sent = await bot.sendMessage(groupId, text, { reply_markup: keyboard });

  // auto delete after 30s
  setTimeout(async () => {
    try {
      await bot.deleteMessage(groupId, sent.message_id);
    } catch (_) {}
  }, 30000);
}

bot.on("message", async (msg) => {
  try {
    if (!msg.chat) return;

    // auto detect group id if env GROUP_ID not set
    if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
      const current = await getGroupId();
      if (!current) await setGroupId(msg.chat.id);
    }

    const groupId = await getGroupId();
    if (!groupId) return;

    // only handle join event in target group
    if (String(msg.chat.id) !== String(groupId)) return;

    if (msg.new_chat_members && msg.new_chat_members.length) {
      for (const m of msg.new_chat_members) {
        await sendRegisterButtonForNewMember(groupId, m);
      }
    }
  } catch (e) {
    console.error("message handler error:", e);
  }
});

/* ================= CALLBACK ================= */

bot.on("callback_query", async (cq) => {
  try {
    const data = cq.data || "";
    const from = cq.from;
    const fromId = String(from.id);

    const quick = async (text, alert = true) => {
      try {
        await bot.answerCallbackQuery(cq.id, { text, show_alert: alert });
      } catch (_) {}
    };

    // Registered button click again -> popup
    if (data.startsWith("done:")) {
      await quick("✅ Registered လုပ်ထားပြီးသားပါ။", true);
      return;
    }

    if (!data.startsWith("reg:")) return;

    const targetId = String(data.split(":")[1] || "");

    if (!targetId || targetId !== fromId) {
      await quick("ဒီ Register ခလုတ်က မင်းအတွက်ပဲ သုံးလို့ရပါတယ်။", true);
      return;
    }

    if (isExcludedId(fromId)) {
      await quick("Owner/Admin/Bot ကို Register မလုပ်ပါ။", true);
      return;
    }

    const groupId = await getGroupId();

    // already registered
    const already = await isRegistered(fromId);
    if (already) {
      await quick("✅ Registered လုပ်ထားပြီးသားပါ။", true);
      return;
    }

    // save immediately
    await saveMember(from, "group_register_button");

    // popup message (name/username)
    const { name, username } = nameParts(from);

    if (username || name) {
      await quick(`${display(from)} Registered လုပ်ပြီးပါပြီနော် 🎉`, true);
    } else {
      // ID-only => guide Start Bot (DM enable)
      await quick("✅ Registered ✅\n\n⚠️ DM Enable လုပ်ရန်လိုပါသည်။", true);

      if (groupId && BOT_USERNAME) {
        const startUrl = `https://t.me/${BOT_USERNAME}?start=enable`;

        const longMsg =
          `⚠️ Winner ဖြစ်ရင် ဆက်သွယ်နိုင်ဖို့ DM Service Enable လုပ်ရန်လိုပါသည်။\n\n` +
          `📌 ညီမတို့ရဲ့ Lucky77 ဟာ American နိုင်ငံ ထောက်ခံချက်ရ ဂိမ်းဆိုဒ်ကြီးဖြစ်တာမို့ ` +
          `ယုံကြည်စိတ်ချစွာ ကစားနိုင်ပါတယ်ရှင့်။\n\n` +
          `ခုလိုစီစဥ်ပေးထားခြင်းကလည်း လူကြီးမင်းတို့ရဲ့ ဆုမဲကံထူးမှုကြီးကို ` +
          `လက်မလွှတ်ရအောင် စီစဥ်ပေးထားတာမို့ တူတူပါဝင်လိုက်ကြစို့...\n\n` +
          `⬇️ အောက်က Start Bot Register ကိုနှိပ်ပါရှင့်။`;

        await sendAutoDelete(
          groupId,
          longMsg,
          {
            reply_markup: {
              inline_keyboard: [[{ text: "▶️ Start Bot Register", url: startUrl }]],
            },
          },
          30000
        );
      }
    }

    // lock button -> Registered
    if (cq.message) {
      try {
        await bot.editMessageReplyMarkup(
          {
            inline_keyboard: [[{ text: "✅ Registered", callback_data: `done:${fromId}` }]],
          },
          { chat_id: cq.message.chat.id, message_id: cq.message.message_id }
        );
      } catch (_) {}
    }
  } catch (e) {
    console.error("callback_query error:", e);
  }
});

/* ================= PRIVATE START (DM Enable) ================= */

bot.onText(/\/start/i, async (msg) => {
  try {
    if (msg.chat.type !== "private") return;
    if (!msg.from) return;

    // ensure member saved + mark dm_ready
    await saveMember(msg.from, "private_start");
    await setDmReady(msg.from.id);

    await bot.sendMessage(
      msg.chat.id,
      "🎉 Lucky77 Register အောင်မြင်ပါပြီ။\n\n📩 Prize ပေါက်ရင် ဒီနေရာကနေ ဆက်သွယ်ပေးပါမယ်။"
    );
  } catch (e) {
    console.error("/start error:", e);
  }
});

/* ================= EXPRESS API (CodePen) ================= */

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
  res.send(
    "Lucky77 wheel bot is running ✅\n\n" +
      "GET  /health\n" +
      "GET  /api/members?key=API_KEY\n" +
      "POST /api/config/prizes?key=API_KEY\n" +
      "POST /api/spin?key=API_KEY\n" +
      "POST /api/restart-spin?key=API_KEY\n" +
      "GET  /api/history?key=API_KEY\n" +
      "POST /api/notice?key=API_KEY\n"
  );
});

app.get("/health", async (req, res) => {
  try {
    const groupId = await getGroupId();
    const members = await redis.scard(KEY_MEMBERS_SET);
    const pool = await redis.scard(KEY_POOL_SET);
    const bag = await redis.llen(KEY_PRIZE_BAG);

    res.json({
      ok: true,
      group_id: groupId,
      bot_username: BOT_USERNAME || null,
      members: Number(members) || 0,
      pool: Number(pool) || 0,
      prize_left: Number(bag) || 0,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// GET members for CodePen (table)
app.get("/api/members", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const winners = new Set((await redis.smembers(KEY_WINNERS_SET)) || []);

    const members = [];
    for (const id of ids || []) {
      if (isExcludedId(id)) continue;

      const h = await redis.hgetall(KEY_MEMBER_HASH(id));
      if (!h || !h.id) continue;

      const name = (h.name || "").trim();
      const username = (h.username || "").trim(); // without @
      const disp =
        name || (username ? `@${username.replace("@", "")}` : String(h.id));

      members.push({
        id: String(h.id),
        name,
        username,
        display: disp,
        dm_ready: String(h.dm_ready || "0") === "1",
        isWinner: winners.has(String(h.id)),
        registered_at: h.registered_at || "",
      });
    }

    members.sort((a, b) =>
      String(a.registered_at || "").localeCompare(String(b.registered_at || ""))
    );

    res.json({ ok: true, total: members.length, members });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Save prize config from CodePen (prizeText)
app.post("/api/config/prizes", requireApiKey, async (req, res) => {
  try {
    const { prizeText } = req.body || {};
    if (!prizeText || !String(prizeText).trim()) {
      return res.status(400).json({ ok: false, error: "prizeText required" });
    }

    await redis.set(KEY_PRIZE_TEXT, String(prizeText));

    // reset prize bag whenever config changes
    const count = await resetPrizeBagFromStoredText();

    res.json({ ok: true, saved: true, prize_total: count });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Spin: pick prize from bag + pick random member from pool (no-repeat)
app.post("/api/spin", requireApiKey, async (req, res) => {
  try {
    // ensure prize bag exists
    let prize = await redis.lpop(KEY_PRIZE_BAG);

    // if bag empty but prizeText exists -> rebuild once
    if (!prize) {
      const rebuilt = await resetPrizeBagFromStoredText();
      if (rebuilt > 0) {
        prize = await redis.lpop(KEY_PRIZE_BAG);
      }
    }

    if (!prize) {
      return res.status(400).json({ ok: false, error: "Prize bag empty. Set prize config first." });
    }

    // pool must have members
    const poolIds = await redis.smembers(KEY_POOL_SET);
    const pool = (poolIds || []).filter((id) => !isExcludedId(id));

    if (!pool.length) {
      return res.status(400).json({ ok: false, error: "Member pool empty. Restart spin to refill." });
    }

    // random pick
    const winnerId = pool[Math.floor(Math.random() * pool.length)];
    const h = await redis.hgetall(KEY_MEMBER_HASH(winnerId));

    const name = (h?.name || "").trim();
    const username = (h?.username || "").trim(); // without @
    const winnerDisplay = name || (username ? `@${username.replace("@", "")}` : String(winnerId));

    // no-repeat: remove from pool, add to winners set
    await redis.srem(KEY_POOL_SET, winnerId);
    await redis.sadd(KEY_WINNERS_SET, winnerId);

    const item = {
      prize: String(prize),
      winner: {
        id: String(winnerId),
        name,
        username,
        display: winnerDisplay,
        dm_ready: String(h?.dm_ready || "0") === "1",
      },
      at: new Date().toISOString(),
    };

    await redis.lpush(KEY_HISTORY_LIST, JSON.stringify(item));
    await redis.ltrim(KEY_HISTORY_LIST, 0, 300);

    res.json({ ok: true, prize: item.prize, winner: item.winner, at: item.at });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Restart spin: refill pool from members, clear winners, reset bag from stored prizeText
app.post("/api/restart-spin", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const members = (ids || []).filter((id) => !isExcludedId(id));

    await redis.del(KEY_POOL_SET);
    await redis.del(KEY_WINNERS_SET);

    if (members.length) {
      await redis.sadd(KEY_POOL_SET, ...members.map(String));
    }

    const prizeTotal = await resetPrizeBagFromStoredText();

    res.json({
      ok: true,
      pool: members.length,
      prize_total: prizeTotal,
      message: "Restart Spin ✅",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Winner history
app.get("/api/history", requireApiKey, async (req, res) => {
  try {
    const list = await redis.lrange(KEY_HISTORY_LIST, 0, 300);
    const history = (list || []).map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return { raw: s };
      }
    });
    res.json({ ok: true, total: history.length, history });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Notice DM (for ID-only winners): { user_id, text }
app.post("/api/notice", requireApiKey, async (req, res) => {
  try {
    const { user_id, text } = req.body || {};
    if (!user_id || !text) {
      return res.status(400).json({ ok: false, error: "user_id and text required" });
    }

    const uid = String(user_id);
    const h = await redis.hgetall(KEY_MEMBER_HASH(uid));
    const dmReady = String(h?.dm_ready || "0") === "1";

    if (!dmReady) {
      return res.json({
        ok: false,
        dm_ok: false,
        error: "DM not enabled yet. User must press Start Bot first.",
      });
    }

    const dm = await trySendDM(uid, String(text));

    res.json({ ok: true, dm_ok: dm.ok, dm_error: dm.ok ? "" : String(dm.error || "") });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));

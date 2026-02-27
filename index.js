/* Lucky77 Wheel Bot - PRO V2 Premium (Render)
   ✅ Webhook mode (fix 409 getUpdates conflict)
   ✅ Auto delete join/left service messages (requires bot admin + delete permission)
   ✅ Group: silent capture member (name/username/id) on join/add
   ✅ Group: auto send + auto PIN "Register" button message (deep-link to DM)
   ✅ DM: /start => mark dm_ready (optionally silent)
   ✅ API for CodePen (API_KEY protected):
      - GET  /health
      - GET  /members?key=API_KEY
      - GET  /pool?key=API_KEY
      - POST /config/prizes?key=API_KEY  { prizeText }
      - POST /spin?key=API_KEY
      - GET  /history?key=API_KEY
      - POST /notice?key=API_KEY { user_id, text }
      - POST /restart-spin?key=API_KEY
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

  // optional
  GROUP_ID, // if set, only that group/supergroup
  EXCLUDE_IDS, // "123,456"
  PUBLIC_URL, // required for webhook on Render: https://xxxx.onrender.com
  WEBHOOK_SECRET, // required for webhook: random secret string
  DM_SILENT, // "1" => DM /start no reply, default "1"
  PIN_REGISTER_MSG, // "1" => auto pin register message, default "1"
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

// webhook requirement on Render (we still allow local polling if not set)
const USE_WEBHOOK = !!(PUBLIC_URL && WEBHOOK_SECRET);

if (USE_WEBHOOK) {
  // ok
} else {
  console.warn("⚠️ PUBLIC_URL or WEBHOOK_SECRET missing => fallback to polling (may cause 409 if another instance runs)");
}

// ================= Redis =================
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// ================= Keys =================
const KEY_PREFIX = "lucky77:pro:v2";
const KEY_MEMBERS_SET = `${KEY_PREFIX}:members:set`;
const KEY_MEMBER_HASH = (id) => `${KEY_PREFIX}:member:${id}`;
const KEY_WINNERS_SET = `${KEY_PREFIX}:winners:set`;
const KEY_HISTORY_LIST = `${KEY_PREFIX}:history:list`;
const KEY_PRIZE_BAG = `${KEY_PREFIX}:prizes:bag`;
const KEY_PRIZE_SOURCE = `${KEY_PREFIX}:prizes:source`;

const KEY_LAST_GROUP = `${KEY_PREFIX}:last_group_id`;
const KEY_PINNED_MSG = (chatId) => `${KEY_PREFIX}:pinned:${chatId}`; // store message_id

// ================= Bot =================
const bot = new TelegramBot(BOT_TOKEN, USE_WEBHOOK ? { polling: false } : {
  polling: {
    params: {
      allowed_updates: ["message", "callback_query", "chat_member", "my_chat_member"],
    },
  },
});

let BOT_ID = null;
let BOT_USERNAME = null;

async function initBot() {
  const me = await bot.getMe();
  BOT_ID = String(me.id);
  BOT_USERNAME = me.username ? String(me.username) : null;

  if (USE_WEBHOOK) {
    const cleanBase = String(PUBLIC_URL).replace(/\/+$/, "");
    const hookPath = `/telegram/${encodeURIComponent(WEBHOOK_SECRET)}`;
    const hookUrl = `${cleanBase}${hookPath}`;

    await bot.setWebHook(hookUrl, {
      allowed_updates: ["message", "callback_query", "chat_member", "my_chat_member"],
    });

    console.log("✅ Webhook set:", hookUrl);
  }

  console.log("✅ Bot Ready:", { BOT_ID, BOT_USERNAME, mode: USE_WEBHOOK ? "webhook" : "polling" });
}

initBot().catch((e) => console.error("initBot error:", e));

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

async function safeDelete(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (_) {}
}

function targetGroup(chat) {
  if (!chat) return false;
  const type = String(chat.type);
  if (type !== "group" && type !== "supergroup") return false;

  if (GROUP_ID && String(chat.id) !== String(GROUP_ID)) return false;
  return true;
}

function deepLinkStart(payload) {
  if (!BOT_USERNAME) return null;
  // deep link opens DM and sends /start <payload> automatically
  return `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(payload)}`;
}

function requireApiKey(req, res, next) {
  const k = req.headers["x-api-key"] || req.query.key;
  if (!k || String(k) !== String(API_KEY)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

async function isRegistered(userId) {
  const ok = await redis.sismember(KEY_MEMBERS_SET, String(userId));
  return !!ok;
}

async function saveMember(u, source = "group_seen") {
  if (!u || !u.id) return { ok: false, reason: "no_user" };
  const userId = String(u.id);
  if (isExcludedUser(userId)) return { ok: false, reason: "excluded" };

  const { name, username } = nameParts(u);

  await redis.sadd(KEY_MEMBERS_SET, userId);
  await redis.hset(KEY_MEMBER_HASH(userId), {
    id: userId,
    name,
    username,
    dm_ready: "0",
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

// ================= Prize parse (expand) =================
function parsePrizeTextExpand(prizeText) {
  const lines = String(prizeText || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  const bag = [];
  for (const line of lines) {
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

// ================= Group Register PIN Message =================
async function ensurePinnedRegisterMessage(chatId) {
  const wantPin = String(PIN_REGISTER_MSG || "1") === "1";
  if (!wantPin) return;

  const existed = await redis.get(KEY_PINNED_MSG(chatId));
  if (existed) return; // already sent/pinned before

  const url = deepLinkStart("register");
  const text =
    "📌 DM ထဲမှာ Register လုပ်ရန်အတွက် အောက်က Register ကိုနှိပ်ပါ။\n\n" +
    "✅ Register နှိပ်လိုက်တာနဲ့ Bot DM ထဲရောက်ပြီး Auto /start register ဖြစ်ပါမယ်။";

  const sent = await bot.sendMessage(chatId, text, {
    reply_markup: url
      ? { inline_keyboard: [[{ text: "✅ Register (DM)", url }]] }
      : undefined,
  });

  // try pin (needs bot admin + pin permission)
  try {
    await bot.pinChatMessage(chatId, sent.message_id, { disable_notification: true });
  } catch (e) {
    console.warn("pin failed (need admin + pin permission):", e?.message || e);
  }

  await redis.set(KEY_PINNED_MSG(chatId), String(sent.message_id));
}

// ================= Telegram Group Flow =================
// (A) message handler catches join/left service messages => auto delete
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat) return;

    if (!targetGroup(msg.chat)) return;

    // debug
    await redis.set(KEY_LAST_GROUP, String(msg.chat.id));

    // always ensure pinned register message (only once)
    await ensurePinnedRegisterMessage(msg.chat.id);

    // ✅ joined/added service message
    if (msg.new_chat_members?.length) {
      // delete the system message itself
      await safeDelete(msg.chat.id, msg.message_id);

      for (const u of msg.new_chat_members) {
        // silent capture member
        if (!isExcludedUser(u.id)) {
          const already = await isRegistered(u.id);
          if (!already) await saveMember(u, "group_join");
        }
      }
      return;
    }

    // ✅ left/removed service message
    if (msg.left_chat_member) {
      await safeDelete(msg.chat.id, msg.message_id);
      return;
    }
  } catch (e) {
    console.error("message handler error:", e);
  }
});

// (B) Backup: admin add member event (chat_member) => capture user
bot.on("chat_member", async (upd) => {
  try {
    const chat = upd?.chat;
    if (!targetGroup(chat)) return;

    await redis.set(KEY_LAST_GROUP, String(chat.id));
    await ensurePinnedRegisterMessage(chat.id);

    const user = upd.new_chat_member?.user;
    const oldStatus = upd.old_chat_member?.status;
    const newStatus = upd.new_chat_member?.status;
    if (!user) return;

    const becameMember =
      (oldStatus === "left" || oldStatus === "kicked" || !oldStatus) &&
      (newStatus === "member" || newStatus === "restricted");

    if (!becameMember) return;

    if (!isExcludedUser(user.id)) {
      const already = await isRegistered(user.id);
      if (!already) await saveMember(user, "chat_member_add");
    }
  } catch (e) {
    console.error("chat_member handler error:", e);
  }
});

// (C) Private /start => mark dm_ready
bot.onText(/\/start(?:\s+(.+))?/i, async (msg, match) => {
  try {
    if (!msg || msg.chat.type !== "private") return;
    const u = msg.from;
    if (!u) return;

    if (!isExcludedUser(u.id)) {
      // ensure member exists
      await saveMember(u, "private_start");
      await setDmReady(u.id);
    }

    // user request: DM silent (default 1)
    const silent = String(DM_SILENT || "1") === "1";
    if (!silent) {
      await bot.sendMessage(
        msg.chat.id,
        "✅ Register အောင်မြင်ပါပြီ။\n\n📩 Prize ပေါက်ရင် ဒီ DM ကနေ ဆက်သွယ်ပေးပါမယ်။"
      );
    }
  } catch (e) {
    console.error("/start error:", e);
  }
});

// ================= Express API =================
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// webhook endpoint (fix 409)
if (USE_WEBHOOK) {
  app.post(`/telegram/${WEBHOOK_SECRET}`, (req, res) => {
    try {
      bot.processUpdate(req.body);
    } catch (e) {
      console.error("processUpdate error:", e);
    }
    res.sendStatus(200);
  });
}

app.get("/", (req, res) => {
  res.send(
    "Lucky77 Wheel Bot PRO V2 Premium ✅\n\n" +
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
      mode: USE_WEBHOOK ? "webhook" : "polling",
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
      const username = (h.username || "").trim().replace("@", "");
      const displayName = name || (username ? `@${username}` : String(h.id));

      members.push({
        id: String(h.id),
        name,
        username,
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

    await redis.del(KEY_PRIZE_BAG);
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
    // 1) eligible members first
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const eligible = [];
    for (const id of ids || []) {
      if (isExcludedUser(id)) continue;
      const isWinner = await redis.sismember(KEY_WINNERS_SET, String(id));
      if (!isWinner) eligible.push(String(id));
    }

    if (!eligible.length) {
      return res
        .status(400)
        .json({ ok: false, error: "No members left in pool. Restart Spin to reset winners." });
    }

    // 2) remaining prizes
    const bagLen = await redis.llen(KEY_PRIZE_BAG);
    if (!bagLen || bagLen <= 0) {
      return res.status(400).json({ ok: false, error: "No prizes left. Set prizes in Settings and Save." });
    }

    const bag = await redis.lrange(KEY_PRIZE_BAG, 0, bagLen - 1);
    const prize = randPick(bag);
    await redis.lrem(KEY_PRIZE_BAG, 1, String(prize));

    // 3) pick winner
    const winnerId = randPick(eligible);
    const h = await redis.hgetall(KEY_MEMBER_HASH(winnerId));

    const name = (h?.name || "").trim();
    const username = (h?.username || "").trim().replace("@", "");
    const disp = name || (username ? `@${username}` : winnerId);

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

// ================= Start server =================
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => {
  console.log("✅ Server running on", PORT);
});startServer();
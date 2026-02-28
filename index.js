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

  GROUP_ID, // recommended (for pin update from DM)
  EXCLUDE_IDS, // optional "123,456"

  PUBLIC_URL, // Render public URL e.g. https://xxx.onrender.com
  WEBHOOK_SECRET, // random secret string

  // ✅ Channel gate env (Public channel)
  CHANNEL_CHAT, // e.g. "@lucky77officialchannel"
  CHANNEL_LINK, // e.g. "https://t.me/lucky77officialchannel"
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
must(PUBLIC_URL, "PUBLIC_URL");
must(WEBHOOK_SECRET, "WEBHOOK_SECRET");

if (!GROUP_ID) console.warn("⚠️ GROUP_ID is not set. /update pin from DM needs GROUP_ID.");
if (!CHANNEL_CHAT || !CHANNEL_LINK) {
  console.warn("⚠️ CHANNEL_CHAT / CHANNEL_LINK not set. Channel member-only gate will be skipped.");
}

// ================= Redis =================
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// ================= Keys =================
const KEY_PREFIX = "lucky77:pro:v2:remax";

// members
const KEY_MEMBERS_SET = `${KEY_PREFIX}:members:set`;
const KEY_MEMBER_HASH = (id) => `${KEY_PREFIX}:member:${id}`;
const KEY_WINNERS_SET = `${KEY_PREFIX}:winners:set`;
const KEY_HISTORY_LIST = `${KEY_PREFIX}:history:list`;

// prizes
const KEY_PRIZE_BAG = `${KEY_PREFIX}:prizes:bag`;
const KEY_PRIZE_SOURCE = `${KEY_PREFIX}:prizes:source`;

// debug
const KEY_LAST_GROUP = `${KEY_PREFIX}:last_group_id`;

// pinned group register msg (existing)
const KEY_PINNED_MSG_ID = (gid) => `${KEY_PREFIX}:pinned:${gid}`;
const KEY_PIN_TEXT = `${KEY_PREFIX}:pin:text`;
const KEY_PIN_MODE = `${KEY_PREFIX}:pin:mode`;
const KEY_PIN_FILE = `${KEY_PREFIX}:pin:file_id`;

// ================= NEW CONFIG KEYS =================

// JOIN GATE (LIVE)
const KEY_JOIN_CAP = `${KEY_PREFIX}:join:cap`;
const KEY_JOIN_BTN = `${KEY_PREFIX}:join:btn`;

// JOIN GATE (PENDING)
const KEY_PENDING_JOIN_CAP = `${KEY_PREFIX}:pending:join:cap`;
const KEY_PENDING_JOIN_BTN = `${KEY_PREFIX}:pending:join:btn`;

// REGISTER DM (LIVE)
const KEY_REG_CAP = `${KEY_PREFIX}:reg:cap`;
const KEY_REG_BTN = `${KEY_PREFIX}:reg:btn`;
const KEY_REG_MODE = `${KEY_PREFIX}:reg:mode`;
const KEY_REG_FILE = `${KEY_PREFIX}:reg:file`;

// REGISTER DM (PENDING)
const KEY_PENDING_REG_CAP = `${KEY_PREFIX}:pending:reg:cap`;
const KEY_PENDING_REG_BTN = `${KEY_PREFIX}:pending:reg:btn`;
const KEY_PENDING_REG_MODE = `${KEY_PREFIX}:pending:reg:mode`;
const KEY_PENDING_REG_FILE = `${KEY_PREFIX}:pending:reg:file`;

// CHANNEL POST (LIVE)
const KEY_POST_CAP = `${KEY_PREFIX}:post:cap`;
const KEY_POST_BTN = `${KEY_PREFIX}:post:btn`;
const KEY_POST_MODE = `${KEY_PREFIX}:post:mode`;
const KEY_POST_FILE = `${KEY_PREFIX}:post:file`;

// CHANNEL POST (PENDING)
const KEY_PENDING_POST_CAP = `${KEY_PREFIX}:pending:post:cap`;
const KEY_PENDING_POST_BTN = `${KEY_PREFIX}:pending:post:btn`;
const KEY_PENDING_POST_MODE = `${KEY_PREFIX}:pending:post:mode`;
const KEY_PENDING_POST_FILE = `${KEY_PREFIX}:pending:post:file`;

// NOTICE winner context (for reply forwarding)
const KEY_NOTICE_CTX = (uid) => `${KEY_PREFIX}:notice:ctx:${uid}`;

// ================= Telegram Bot (Webhook) =================
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

let BOT_USERNAME = null;
let BOT_ID = null;

// ================= Helpers =================
const excludeIds = (EXCLUDE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(String);

function isOwner(userId) {
  return String(userId) === String(OWNER_ID);
}

function ownerOnly(msg) {
  return msg && msg.chat && msg.chat.type === "private" && isOwner(msg.from?.id);
}

function isExcludedUser(userId) {
  const id = String(userId);
  if (id === String(OWNER_ID)) return true;
  if (excludeIds.includes(id)) return true;
  return false;
}

function nameParts(u) {
  const name = `${u.first_name || ""} ${u.last_name || ""}`.trim();
  const username = u.username ? String(u.username) : "";
  return { name, username };
}

function targetGroup(chat) {
  if (!chat) return false;
  const t = String(chat.type);
  if (t !== "group" && t !== "supergroup") return false;
  if (GROUP_ID && String(chat.id) !== String(GROUP_ID)) return false;
  return true;
}

async function autoDelete(chatId, messageId, ms = 2000) {
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (_) {}
  }, ms);
}

async function isRegistered(userId) {
  const ok = await redis.sismember(KEY_MEMBERS_SET, String(userId));
  return !!ok;
}

async function saveMember(u, source = "group_join") {
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

async function removeMember(userId, reason = "left_group") {
  const uid = String(userId);
  await redis.srem(KEY_MEMBERS_SET, uid);
  await redis.srem(KEY_WINNERS_SET, uid);
  await redis.del(KEY_MEMBER_HASH(uid));
  return { ok: true, reason };
}

function requireApiKey(req, res, next) {
  const k = req.headers["x-api-key"] || req.query.key;
  if (!k || String(k) !== String(API_KEY)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// ---------- Channel Gate Helpers ----------
function getChannelLink() {
  if (CHANNEL_LINK) return String(CHANNEL_LINK);
  if (CHANNEL_CHAT) return `https://t.me/${String(CHANNEL_CHAT).replace("@", "")}`;
  return "";
}

async function isChannelMember(userId) {
  if (!CHANNEL_CHAT) return true;
  try {
    const m = await bot.getChatMember(String(CHANNEL_CHAT), Number(userId));
    const st = String(m?.status || "");
    return st === "member" || st === "administrator" || st === "creator";
  } catch (_) {
    return false;
  }
}

// (keep for manual cleanup button)
async function ensureChannelMemberOrCleanup(userId) {
  if (!CHANNEL_CHAT) return true;
  const ok = await isChannelMember(userId);
  if (!ok) {
    await removeMember(userId, "left_channel_or_not_member_manual");
    return false;
  }
  return true;
}

async function getJoinGateLive() {
  const cap =
    (await redis.get(KEY_JOIN_CAP)) ||
    "❌ Channel ကို Join ပြီးမှ Register/Enable DM လုပ်နိုင်ပါသည်。\n\n👉 အောက်က Button နဲ့ Join လုပ်ပြီး ပြန်စစ်ပါ။";
  const btn = (await redis.get(KEY_JOIN_BTN)) || "📢 Join Channel";
  return { cap: String(cap), btn: String(btn) };
}

async function sendJoinGate(chatId, userId) {
  const link = getChannelLink();
  const live = await getJoinGateLive();

  const kb = {
    inline_keyboard: [
      ...(link ? [[{ text: live.btn, url: link }]] : []),
      [{ text: "✅ Joined (Check Again)", callback_data: `chkch:${String(userId)}` }],
    ],
  };

  return bot.sendMessage(chatId, live.cap, { reply_markup: kb });
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

function randPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ================= Express =================
const app = express();
app.use(cors());
app.use(express.json({ limit: "6mb" }));

app.get("/", (req, res) => {
  res.send(
    "Lucky77 Wheel Bot — PRO V2 Premium (REMAX FULL) ✅\n\n" +
      "GET  /health\n" +
      "GET  /members?key=API_KEY\n" +
      "GET  /pool?key=API_KEY\n" +
      "POST /config/prizes?key=API_KEY  { prizeText }\n" +
      "POST /spin?key=API_KEY\n" +
      "GET  /history?key=API_KEY\n" +
      "POST /notice?key=API_KEY { user_id, prize?, text? }\n" +
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
      group_id_env: GROUP_ID || null,
      webhook_path: `/telegram/${encodeURIComponent(WEBHOOK_SECRET)}`,
      last_group_seen: lastGroup || null,
      members: Number(members) || 0,
      winners: Number(winners) || 0,
      remaining_prizes: Number(bagLen) || 0,
      channel_gate: { enabled: !!CHANNEL_CHAT, chat: CHANNEL_CHAT || null, link: getChannelLink() || null },
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ FIX: remove auto channel member checking here (to avoid loading)
app.get("/members", requireApiKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS_SET);
    const members = [];

    for (const id of ids || []) {
      if (isExcludedUser(id)) continue;

      const h = await redis.hgetall(KEY_MEMBER_HASH(id));
      if (!h || !h.id) continue;

      const isWinner = await redis.sismember(KEY_WINNERS_SET, String(h.id));
      const name = (h.name || "").trim();
      const username = (h.username || "").trim().replace("@", "");
      const display = name || (username ? `@${username}` : String(h.id));

      members.push({
        id: String(h.id),
        name,
        username,
        display,
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

// ✅ FIX: remove auto channel member checking here (to avoid loading)
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
    for (const p of bag) await redis.rpush(KEY_PRIZE_BAG, String(p));
    await redis.set(KEY_PRIZE_SOURCE, String(prizeText || ""));

    res.json({ ok: true, total: bag.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ FIX: remove auto channel member checking here (to avoid loading)
app.post("/spin", requireApiKey, async (req, res) => {
  try {
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

    const bagLen = await redis.llen(KEY_PRIZE_BAG);
    if (!bagLen || bagLen <= 0) {
      return res.status(400).json({ ok: false, error: "No prizes left. Set prizes in Settings and Save." });
    }

    const bag = await redis.lrange(KEY_PRIZE_BAG, 0, bagLen - 1);
    const prize = randPick(bag);
    await redis.lrem(KEY_PRIZE_BAG, 1, String(prize));

    const winnerId = randPick(eligible);
    const h = await redis.hgetall(KEY_MEMBER_HASH(winnerId));
    const name = (h?.name || "").trim();
    const username = (h?.username || "").trim().replace("@", "");
    const display = name || (username ? `@${username}` : winnerId);

    await redis.sadd(KEY_WINNERS_SET, String(winnerId));

    const item = {
      at: new Date().toISOString(),
      prize: String(prize),
      winner: {
        id: String(winnerId),
        name,
        username,
        display,
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

// ✅ Notice: Auto DM template + save context for forwarding replies
app.post("/notice", requireApiKey, async (req, res) => {
  try {
    const { user_id, prize, text } = req.body || {};
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id required" });

    const uid = String(user_id);
    const pz = prize ? String(prize) : "";

    const msgText =
      text && String(text).trim()
        ? String(text)
        : (
            "Congratulation 🥳🥳🥳ပါအကိုရှင့်\n" +
            `လက်ကီး77 ရဲ့ လစဉ်ဗလာမပါလက်ကီးဝှီး အစီစဉ်မှာ ယူနစ် ${pz || "—"} ကံထူးသွားပါတယ်ရှင့်☘️\n` +
            "ဂိမ်းယူနစ်လေး ထည့်ပေးဖို့ အကို့ဂိမ်းအကောင့်လေး ပို့ပေးပါရှင့်"
          );

    // Save context for forwarding user replies to OWNER (7 days)
    const ctx = JSON.stringify({ prize: pz, at: new Date().toISOString() });
    await redis.set(KEY_NOTICE_CTX(uid), ctx, { ex: 60 * 60 * 24 * 7 });

    const dm = await bot
      .sendMessage(Number(uid), msgText)
      .then(() => ({ ok: true }))
      .catch((e) => ({
        ok: false,
        error: e?.response?.body || e?.message || String(e),
      }));

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

// ================= Telegram Webhook =================
const WEBHOOK_PATH = `/telegram/${encodeURIComponent(WEBHOOK_SECRET)}`;
app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

async function setupWebhook() {
  await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
  await bot.setWebHook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
}

// ================= PIN REGISTER (GROUP) =================
async function buildRegisterKeyboard() {
  const startUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=register` : null;
  return startUrl ? { inline_keyboard: [[{ text: "▶️ Register / Enable DM", url: startUrl }]] } : undefined;
}

async function getPinConfig() {
  const mode = (await redis.get(KEY_PIN_MODE)) || "text";
  const text =
    (await redis.get(KEY_PIN_TEXT)) ||
    "📌 Lucky77 DM Register (Prize Contact)\n\n✅ Prize ပေါက်သွားရင် DM ကနေ ဆက်သွယ်ပေးနိုင်ဖို့\nအောက်က Button ကိုနှိပ်ပြီး Bot DM ကို Enable/Register လုပ်ပါ။";
  const fileId = (await redis.get(KEY_PIN_FILE)) || "";
  return { mode, text, fileId };
}

async function sendAndPinRegisterMessage(groupId) {
  const gid = Number(groupId);
  const { mode, text, fileId } = await getPinConfig();
  const keyboard = await buildRegisterKeyboard();

  let sent;
  if (mode === "photo" && fileId) {
    sent = await bot.sendPhoto(gid, fileId, { caption: text, reply_markup: keyboard || undefined });
  } else if (mode === "video" && fileId) {
    sent = await bot.sendVideo(gid, fileId, {
      caption: text,
      reply_markup: keyboard || undefined,
      supports_streaming: true,
    });
  } else {
    sent = await bot.sendMessage(gid, text, { reply_markup: keyboard || undefined });
  }

  try {
    await bot.pinChatMessage(gid, sent.message_id, { disable_notification: true });
  } catch (e) {
    console.warn("pinChatMessage failed:", e?.message || e);
  }

  await redis.set(KEY_PINNED_MSG_ID(String(groupId)), String(sent.message_id));
  return sent.message_id;
}

async function ensurePinnedRegisterMessage(groupId) {
  const gid = String(groupId);
  const cached = await redis.get(KEY_PINNED_MSG_ID(gid));
  if (cached) return;
  await sendAndPinRegisterMessage(gid);
}

// ================= REGISTER DM (LIVE) =================
async function getRegLive() {
  const mode = (await redis.get(KEY_REG_MODE)) || "text";
  const cap =
    (await redis.get(KEY_REG_CAP)) ||
    "✅ Registered ပြီးပါပြီ。\n\n📩 Prize ပေါက်ရင် ဒီ DM ကနေ ဆက်သွယ်ပေးပါမယ်။";
  const fileId = (await redis.get(KEY_REG_FILE)) || "";
  const btn = (await redis.get(KEY_REG_BTN)) || ""; // optional
  return { mode: String(mode), cap: String(cap), fileId: String(fileId), btn: String(btn) };
}

async function sendRegWelcome(chatId) {
  const { mode, cap, fileId, btn } = await getRegLive();

  const startUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=register` : null;
  const keyboard = btn && startUrl ? { inline_keyboard: [[{ text: btn, url: startUrl }]] } : undefined;

  if (mode === "photo" && fileId) {
    return bot.sendPhoto(chatId, fileId, { caption: cap, reply_markup: keyboard });
  }
  if (mode === "video" && fileId) {
    return bot.sendVideo(chatId, fileId, { caption: cap, supports_streaming: true, reply_markup: keyboard });
  }
  return bot.sendMessage(chatId, cap, { reply_markup: keyboard });
}

async function proceedRegisterAndReply(chatId, u) {
  if (!isExcludedUser(u.id)) {
    await saveMember(u, "private_start");
    await setDmReady(u.id);
  }
  await sendRegWelcome(chatId);
}

// ================= ADMIN TOOLS (MANUAL CLEANUP) =================
bot.onText(/^\/tools$/i, async (msg) => {
  try {
    if (!ownerOnly(msg)) return;

    const kb = {
      inline_keyboard: [
        [{ text: "🧹 Sync Channel Members (Cleanup)", callback_data: "admin:syncmembers" }],
      ],
    };

    await bot.sendMessage(
      msg.chat.id,
      "🔧 Admin Tools\n\nဒီ button ကို တစ်လတစ်ခါ နှိပ်ပြီး Channel member စစ်/cleanup လုပ်နိုင်ပါတယ်။",
      { reply_markup: kb }
    );
  } catch (e) {
    console.error("/tools error:", e);
  }
});

async function syncChannelMembersManual(ownerChatId) {
  if (!CHANNEL_CHAT) {
    await bot.sendMessage(ownerChatId, "ℹ️ CHANNEL_CHAT မရှိလို့ sync မလုပ်ပါ။");
    return;
  }

  const ids = await redis.smembers(KEY_MEMBERS_SET);
  const total = (ids || []).length;

  if (!total) {
    await bot.sendMessage(ownerChatId, "ℹ️ Members မရှိသေးပါ။");
    return;
  }

  let removed = 0;
  let checked = 0;

  const progressMsg = await bot.sendMessage(
    ownerChatId,
    `⏳ Sync started...\nChecked: 0/${total}\nRemoved: 0`
  );

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const id of ids || []) {
    if (isExcludedUser(id)) continue;

    const ok = await ensureChannelMemberOrCleanup(id);
    if (!ok) removed++;

    checked++;

    if (checked % 25 === 0 || checked === total) {
      try {
        await bot.editMessageText(
          `⏳ Sync running...\nChecked: ${checked}/${total}\nRemoved: ${removed}`,
          { chat_id: ownerChatId, message_id: progressMsg.message_id }
        );
      } catch (_) {}
    }

    await sleep(120);
  }

  await bot.sendMessage(
    ownerChatId,
    `✅ Sync done!\n\nTotal: ${total}\nChecked: ${checked}\nRemoved: ${removed}\nRemaining: ${Math.max(0, total - removed)}`
  );
}

// ================= CALLBACKS =================
bot.on("callback_query", async (q) => {
  try {
    const data = String(q?.data || "");
    const fromId = String(q?.from?.id || "");
    const chatId = q?.message?.chat?.id;

    if (!chatId) {
      try { await bot.answerCallbackQuery(q.id); } catch (_) {}
      return;
    }

    // admin sync button
    if (data === "admin:syncmembers") {
      if (fromId !== String(OWNER_ID)) {
        await bot.answerCallbackQuery(q.id, { text: "Owner only.", show_alert: true });
        return;
      }
      await bot.answerCallbackQuery(q.id, { text: "Sync started..." });
      await syncChannelMembersManual(chatId);
      return;
    }

    // Joined check button
    if (data.startsWith("chkch:")) {
      const expectedUserId = data.split(":")[1] || "";

      if (fromId !== String(expectedUserId)) {
        await bot.answerCallbackQuery(q.id, { text: "ဒီခလုတ်က သင့်အတွက်မဟုတ်ပါ။", show_alert: true });
        return;
      }

      await bot.answerCallbackQuery(q.id);

      const ok = await isChannelMember(fromId);
      if (!ok) {
        await sendJoinGate(chatId, fromId);
        return;
      }

      await proceedRegisterAndReply(chatId, q.from);
      return;
    }

    try { await bot.answerCallbackQuery(q.id); } catch (_) {}
  } catch (_) {
    try { await bot.answerCallbackQuery(q.id); } catch (_) {}
  }
});

// ================= GROUP + PRIVATE MESSAGE HANDLERS =================
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat) return;

    // Forward winner replies to OWNER (private messages)
    if (msg.chat.type === "private" && msg.from && !isOwner(msg.from.id)) {
      const uid = String(msg.from.id);
      const ctxRaw = await redis.get(KEY_NOTICE_CTX(uid));
      if (ctxRaw) {
        let ctx = {};
        try { ctx = JSON.parse(ctxRaw); } catch (_) {}
        const { name, username } = nameParts(msg.from);
        const prize = ctx?.prize || "";

        const header =
          "📨 Winner Reply (Auto Forward)\n" +
          `• Name: ${name || "-"}\n` +
          `• Username: ${username ? "@" + username : "-"}\n` +
          `• ID: ${uid}\n` +
          `• Prize: ${prize || "-"}`;

        await bot.sendMessage(Number(OWNER_ID), header).catch(() => {});
        await bot.forwardMessage(Number(OWNER_ID), msg.chat.id, msg.message_id).catch(() => {});
      }
      return;
    }

    if (targetGroup(msg.chat)) {
      await redis.set(KEY_LAST_GROUP, String(msg.chat.id));
      await ensurePinnedRegisterMessage(msg.chat.id);

      // JOIN
      if (msg.new_chat_members && msg.new_chat_members.length) {
        await autoDelete(msg.chat.id, msg.message_id, 2000);

        for (const u of msg.new_chat_members) {
          if (!u) continue;
          if (isExcludedUser(u.id)) continue;

          const already = await isRegistered(u.id);
          if (!already) await saveMember(u, "group_join");
          else await saveMember(u, "group_join_update");
        }
      }

      // LEAVE (group leave cleanup)
      if (msg.left_chat_member) {
        await autoDelete(msg.chat.id, msg.message_id, 2000);
        const u = msg.left_chat_member;
        if (u && !isExcludedUser(u.id)) {
          await removeMember(u.id, "left_chat_member");
        }
      }
    }
  } catch (e) {
    console.error("message handler error:", e);
  }
});

// ================= PRIVATE /start (register) =================
bot.onText(/^\/start(?:\s+(.+))?/i, async (msg) => {
  try {
    if (!msg || msg.chat.type !== "private") return;

    const u = msg.from;
    if (!u) return;

    // Channel gate (only here / button, NOT in endpoints)
    if (CHANNEL_CHAT) {
      const ok = await isChannelMember(u.id);
      if (!ok) {
        await sendJoinGate(msg.chat.id, u.id);
        return;
      }
    }

    await proceedRegisterAndReply(msg.chat.id, u);
  } catch (e) {
    console.error("/start error:", e);
  }
});

// ================= OWNER COMMANDS (DM only) =================

// ================= OWNER COMMAND: /add (DM only) =================
// ✅ Add member manually by name / username / id (any combination)
// Examples:
// /add mg mg
// /add @mgmg
// /add id:33984585
// /add mg mg @mgmg id:33984585
// /add @mgmg id:33984585

function makeManualIdFromText(txt) {
  const s = String(txt || "").trim().toLowerCase();
  // sanitize for redis key safety (no spaces / weird chars)
  const safe = s
    .replace(/\s+/g, "_")
    .replace(/[^\w@.-]+/g, "")
    .replace(/^@+/, ""); // remove leading @ if any
  return safe ? `manual:${safe}` : "";
}

function parseAddPayload(text) {
  const raw = String(text || "").replace(/^\/add(@\w+)?\s*/i, "").trim();
  if (!raw) return null;

  const parts = raw.split(/\s+/).filter(Boolean);

  let username = "";
  let id = "";
  const nameTokens = [];

  for (const p of parts) {
    const low = p.toLowerCase();

    // username: @xxx
    if (p.startsWith("@") && p.length > 1) {
      username = p.replace("@", "").trim();
      continue;
    }

    // id:123 or id=123
    const m = low.match(/^id[:=](\d+)$/);
    if (m) {
      id = m[1];
      continue;
    }

    // otherwise -> name token
    nameTokens.push(p);
  }

  const name = nameTokens.join(" ").trim();

  if (!name && !username && !id) return null;

  return {
    name: name || "",
    username: username || "",
    id: id ? String(id) : "",
  };
}

async function saveMemberManual({ id, username, name }, source = "owner_add") {
  // Keep original system keys (set + hash). If no numeric id => create manual id.
  let uid = (id || "").trim();

  if (!uid) {
    const base = (username || name || "").trim();
    if (!base) return { ok: false, error: "No usable id/username/name" };
    uid = makeManualIdFromText(base);
    if (!uid) return { ok: false, error: "Cannot build manual id" };
  }

  // Prevent excluded
  if (isExcludedUser(uid)) return { ok: false, error: "excluded" };

  const already = await redis.sismember(KEY_MEMBERS_SET, String(uid));

  await redis.sadd(KEY_MEMBERS_SET, String(uid));
  await redis.hset(KEY_MEMBER_HASH(String(uid)), {
    id: String(uid),
    name: String(name || "").trim(),
    username: String(username || "").trim().replace("@", ""),
    dm_ready: "0",
    source,
    registered_at: new Date().toISOString(),
  });

  return { ok: true, updated: !!already, id: String(uid) };
}

bot.onText(/^\/add(@\w+)?(\s+[\s\S]+)?$/i, async (msg) => {
  try {
    if (!ownerOnly(msg)) return;

    const payload = parseAddPayload(msg.text || "");
    if (!payload) {
      return bot.sendMessage(
        msg.chat.id,
        "Usage:\n" +
          "/add <name> [@username] [id:123]\n\n" +
          "Examples:\n" +
          "/add mg mg\n" +
          "/add @mgmg\n" +
          "/add id:33984585\n" +
          "/add mg mg @mgmg id:33984585"
      );
    }

    const result = await saveMemberManual(payload, "owner_add");

    if (!result.ok) {
      return bot.sendMessage(msg.chat.id, "❌ Add failed: " + String(result.error || "unknown"));
    }

    const display =
      (payload.name && payload.name.trim()) ||
      (payload.username ? "@" + payload.username.replace("@", "") : "") ||
      (payload.id ? payload.id : result.id);

    return bot.sendMessage(
      msg.chat.id,
      (result.updated ? "♻️ Updated member\n" : "✅ Added member\n") +
        `• Display: ${display}\n` +
        `• Name: ${payload.name ? payload.name : "-"}\n` +
        `• Username: ${payload.username ? "@" + payload.username.replace("@", "") : "-"}\n` +
        `• ID: ${payload.id ? payload.id : result.id}\n`
    );
  } catch (e) {
    console.error("/add error:", e);
    try {
      await bot.sendMessage(msg.chat.id, "❌ /add error: " + (e?.message || String(e)));
    } catch (_) {}
  }
});

// ---- Join Gate staging ----
bot.onText(/^\/joincap(?:\s+([\s\S]+))?/i, async (msg, match) => {
  try {
    if (!ownerOnly(msg)) return;
    const text = match && match[1] ? String(match[1]).trim() : "";
    if (!text) return bot.sendMessage(msg.chat.id, "Usage: /joincap your text");
    await redis.set(KEY_PENDING_JOIN_CAP, text);
    await bot.sendMessage(msg.chat.id, "✅ Pending Join Caption Saved. (Use /upload)");
  } catch (e) {
    console.error("/joincap error:", e);
  }
});

bot.onText(/^\/joinbuttomlabel(?:\s+([\s\S]+))?/i, async (msg, match) => {
  try {
    if (!ownerOnly(msg)) return;
    const text = match && match[1] ? String(match[1]).trim() : "";
    if (!text) return bot.sendMessage(msg.chat.id, "Usage: /joinbuttomlabel label");
    await redis.set(KEY_PENDING_JOIN_BTN, text);
    await bot.sendMessage(msg.chat.id, "✅ Pending Join Button Saved. (Use /upload)");
  } catch (e) {
    console.error("/joinbuttomlabel error:", e);
  }
});

// ---- Register DM staging ----
bot.onText(/^\/regcaption(?:\s+([\s\S]+))?/i, async (msg, match) => {
  try {
    if (!ownerOnly(msg)) return;
    const text = match && match[1] ? String(match[1]).trim() : "";
    if (!text) return bot.sendMessage(msg.chat.id, "Usage: /regcaption your caption");
    await redis.set(KEY_PENDING_REG_CAP, text);
    await bot.sendMessage(msg.chat.id, "✅ Pending Register Caption Saved. (Use /upload)");
  } catch (e) {
    console.error("/regcaption error:", e);
  }
});

bot.onText(/^\/regbuttomlabel(?:\s+([\s\S]+))?/i, async (msg, match) => {
  try {
    if (!ownerOnly(msg)) return;
    const text = match && match[1] ? String(match[1]).trim() : "";
    if (!text) return bot.sendMessage(msg.chat.id, "Usage: /regbuttomlabel label");
    await redis.set(KEY_PENDING_REG_BTN, text);
    await bot.sendMessage(msg.chat.id, "✅ Pending Register Button Saved. (Use /upload)");
  } catch (e) {
    console.error("/regbuttomlabel error:", e);
  }
});

async function setPendingRegMedia(msg, modeWanted) {
  if (!ownerOnly(msg)) return;

  const srcMsg = msg.reply_to_message ? msg.reply_to_message : msg;
  let fileId = "";

  if (modeWanted === "photo") {
    const photos = srcMsg.photo || [];
    const best = photos.length ? photos[photos.length - 1] : null;
    fileId = best ? best.file_id : "";
  } else if (modeWanted === "video") {
    fileId = srcMsg.video ? srcMsg.video.file_id : "";
  }

  if (!fileId) return bot.sendMessage(msg.chat.id, "❌ No media found. Reply photo/video with /regimage or /regvideo");

  await redis.set(KEY_PENDING_REG_MODE, modeWanted);
  await redis.set(KEY_PENDING_REG_FILE, fileId);

  return bot.sendMessage(msg.chat.id, `✅ Pending Register ${modeWanted.toUpperCase()} saved. (Use /upload)`);
}

bot.onText(/^\/regimage$/i, async (msg) => {
  try { await setPendingRegMedia(msg, "photo"); } catch (e) { console.error("/regimage error:", e); }
});

bot.onText(/^\/regvideo$/i, async (msg) => {
  try { await setPendingRegMedia(msg, "video"); } catch (e) { console.error("/regvideo error:", e); }
});

// ---- Apply staging to LIVE ----
bot.onText(/^\/upload$/i, async (msg) => {
  try {
    if (!ownerOnly(msg)) return;

    let changed = 0;
    const report = [];

    // join
    const pJoinCap = await redis.get(KEY_PENDING_JOIN_CAP);
    const pJoinBtn = await redis.get(KEY_PENDING_JOIN_BTN);
    if (pJoinCap) { await redis.set(KEY_JOIN_CAP, String(pJoinCap)); await redis.del(KEY_PENDING_JOIN_CAP); changed++; report.push("✅ Join Caption applied"); }
    if (pJoinBtn) { await redis.set(KEY_JOIN_BTN, String(pJoinBtn)); await redis.del(KEY_PENDING_JOIN_BTN); changed++; report.push("✅ Join Button applied"); }

    // reg dm
    const pRegCap = await redis.get(KEY_PENDING_REG_CAP);
    const pRegBtn = await redis.get(KEY_PENDING_REG_BTN);
    const pRegMode = await redis.get(KEY_PENDING_REG_MODE);
    const pRegFile = await redis.get(KEY_PENDING_REG_FILE);

    if (pRegCap) { await redis.set(KEY_REG_CAP, String(pRegCap)); await redis.del(KEY_PENDING_REG_CAP); changed++; report.push("✅ Reg Caption applied"); }
    if (pRegBtn) { await redis.set(KEY_REG_BTN, String(pRegBtn)); await redis.del(KEY_PENDING_REG_BTN); changed++; report.push("✅ Reg Button applied"); }

    if (pRegMode && pRegFile) {
      await redis.set(KEY_REG_MODE, String(pRegMode));
      await redis.set(KEY_REG_FILE, String(pRegFile));
      await redis.del(KEY_PENDING_REG_MODE);
      await redis.del(KEY_PENDING_REG_FILE);
      changed++;
      report.push(`✅ Reg Media applied (${String(pRegMode).toUpperCase()})`);
    }

    if (!changed) return bot.sendMessage(msg.chat.id, "ℹ️ Nothing pending to upload.");

    await bot.sendMessage(msg.chat.id, "📦 Upload Done!\n\n" + report.join("\n"));
  } catch (e) {
    console.error("/upload error:", e);
    await bot.sendMessage(msg.chat.id, "❌ Upload failed: " + (e?.message || String(e)));
  }
});

// ---- Channel Post staging ----
bot.onText(/^\/postchannelcaption(?:\s+([\s\S]+))?/i, async (msg, match) => {
  try {
    if (!ownerOnly(msg)) return;
    const text = match && match[1] ? String(match[1]).trim() : "";
    if (!text) return bot.sendMessage(msg.chat.id, "Usage: /postchannelcaption your caption");
    await redis.set(KEY_PENDING_POST_CAP, text);
    await bot.sendMessage(msg.chat.id, "✅ Pending Channel Caption Saved. (Use /uploadchannelpost)");
  } catch (e) {
    console.error("/postchannelcaption error:", e);
  }
});

bot.onText(/^\/postchannelbuttomlabel(?:\s+([\s\S]+))?/i, async (msg, match) => {
  try {
    if (!ownerOnly(msg)) return;
    const text = match && match[1] ? String(match[1]).trim() : "";
    if (!text) return bot.sendMessage(msg.chat.id, "Usage: /postchannelbuttomlabel label");
    await redis.set(KEY_PENDING_POST_BTN, text);
    await bot.sendMessage(msg.chat.id, "✅ Pending Channel Button Saved. (Use /uploadchannelpost)");
  } catch (e) {
    console.error("/postchannelbuttomlabel error:", e);
  }
});

async function setPendingPostMedia(msg, modeWanted) {
  if (!ownerOnly(msg)) return;

  const srcMsg = msg.reply_to_message ? msg.reply_to_message : msg;
  let fileId = "";

  if (modeWanted === "photo") {
    const photos = srcMsg.photo || [];
    const best = photos.length ? photos[photos.length - 1] : null;
    fileId = best ? best.file_id : "";
  } else if (modeWanted === "video") {
    fileId = srcMsg.video ? srcMsg.video.file_id : "";
  }

  if (!fileId) return bot.sendMessage(msg.chat.id, "❌ No media found. Reply photo/video with /postchannelimage or /postchannelvideo");

  await redis.set(KEY_PENDING_POST_MODE, modeWanted);
  await redis.set(KEY_PENDING_POST_FILE, fileId);

  return bot.sendMessage(msg.chat.id, `✅ Pending Channel ${modeWanted.toUpperCase()} saved. (Use /uploadchannelpost)`);
}

bot.onText(/^\/postchannelimage$/i, async (msg) => {
  try { await setPendingPostMedia(msg, "photo"); } catch (e) { console.error("/postchannelimage error:", e); }
});

bot.onText(/^\/postchannelvideo$/i, async (msg) => {
  try { await setPendingPostMedia(msg, "video"); } catch (e) { console.error("/postchannelvideo error:", e); }
});

// ---- Upload channel post (send to CHANNEL_CHAT) ----
bot.onText(/^\/uploadchannelpost$/i, async (msg) => {
  try {
    if (!ownerOnly(msg)) return;

    if (!CHANNEL_CHAT) return bot.sendMessage(msg.chat.id, "❌ CHANNEL_CHAT env မရှိပါ။");

    const cap = (await redis.get(KEY_PENDING_POST_CAP)) || (await redis.get(KEY_POST_CAP)) || "✅ Lucky77 Register";
    const btn = (await redis.get(KEY_PENDING_POST_BTN)) || (await redis.get(KEY_POST_BTN)) || "▶️ Register / Enable DM";
    const mode = (await redis.get(KEY_PENDING_POST_MODE)) || (await redis.get(KEY_POST_MODE)) || "text";
    const fileId = (await redis.get(KEY_PENDING_POST_FILE)) || (await redis.get(KEY_POST_FILE)) || "";

    const startUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=register` : null;
    const keyboard = btn && startUrl ? { inline_keyboard: [[{ text: btn, url: startUrl }]] } : undefined;

    let sent;
    if (mode === "photo" && fileId) {
      sent = await bot.sendPhoto(String(CHANNEL_CHAT), fileId, { caption: cap, reply_markup: keyboard });
    } else if (mode === "video" && fileId) {
      sent = await bot.sendVideo(String(CHANNEL_CHAT), fileId, { caption: cap, supports_streaming: true, reply_markup: keyboard });
    } else {
      sent = await bot.sendMessage(String(CHANNEL_CHAT), cap, { reply_markup: keyboard });
    }

    // Save as LIVE too
    await redis.set(KEY_POST_CAP, String(cap));
    await redis.set(KEY_POST_BTN, String(btn));
    await redis.set(KEY_POST_MODE, String(mode));
    await redis.set(KEY_POST_FILE, String(fileId || ""));

    // Clear pending post keys
    await redis.del(KEY_PENDING_POST_CAP);
    await redis.del(KEY_PENDING_POST_BTN);
    await redis.del(KEY_PENDING_POST_MODE);
    await redis.del(KEY_PENDING_POST_FILE);

    await bot.sendMessage(msg.chat.id, `✅ Channel Post Uploaded!\nMessageID: ${sent?.message_id || "-"}`);
  } catch (e) {
    console.error("/uploadchannelpost error:", e);
    await bot.sendMessage(msg.chat.id, "❌ uploadchannelpost failed: " + (e?.message || String(e)));
  }
});

// ---- All Restart ----
bot.onText(/^\/allrestart$/i, async (msg) => {
  try {
    if (!ownerOnly(msg)) return;

    await redis.del(KEY_WINNERS_SET);
    await redis.del(KEY_HISTORY_LIST);

    const raw = await redis.get(KEY_PRIZE_SOURCE);
    if (raw) {
      const bag = parsePrizeTextExpand(raw);
      await redis.del(KEY_PRIZE_BAG);
      for (const p of bag) await redis.rpush(KEY_PRIZE_BAG, String(p));
    }

    await redis.del(KEY_PENDING_JOIN_CAP);
    await redis.del(KEY_PENDING_JOIN_BTN);
    await redis.del(KEY_PENDING_REG_CAP);
    await redis.del(KEY_PENDING_REG_BTN);
    await redis.del(KEY_PENDING_REG_MODE);
    await redis.del(KEY_PENDING_REG_FILE);
    await redis.del(KEY_PENDING_POST_CAP);
    await redis.del(KEY_PENDING_POST_BTN);
    await redis.del(KEY_PENDING_POST_MODE);
    await redis.del(KEY_PENDING_POST_FILE);

    if (GROUP_ID) await redis.del(KEY_PINNED_MSG_ID(String(GROUP_ID)));

    await bot.sendMessage(
      msg.chat.id,
      "✅ ALL RESTART DONE!\n- winners/history reset\n- prize bag rebuilt\n- pending configs cleared\n- pin cache cleared"
    );
  } catch (e) {
    console.error("/allrestart error:", e);
    await bot.sendMessage(msg.chat.id, "❌ allrestart failed: " + (e?.message || String(e)));
  }
});

// ================= Existing Pin Commands (KEEP) =================
bot.onText(/^\/setpin(?:\s+([\s\S]+))?/i, async (msg, match) => {
  try {
    if (!ownerOnly(msg)) return;

    const text = match && match[1] ? String(match[1]).trim() : "";
    if (!text) return bot.sendMessage(msg.chat.id, "Usage: /setpin your caption/text");

    await redis.set(KEY_PIN_TEXT, text);
    await bot.sendMessage(msg.chat.id, "✅ Pin caption/text updated.");
  } catch (e) {
    console.error("/setpin error:", e);
  }
});

bot.onText(/^\/settext$/i, async (msg) => {
  try {
    if (!ownerOnly(msg)) return;
    await redis.set(KEY_PIN_MODE, "text");
    await redis.del(KEY_PIN_FILE);
    await bot.sendMessage(msg.chat.id, "✅ Pin mode = TEXT (no media).");
  } catch (e) {
    console.error("/settext error:", e);
  }
});

async function setPinMediaFromMessage(msg, modeWanted) {
  if (!ownerOnly(msg)) return;

  const srcMsg = msg.reply_to_message ? msg.reply_to_message : msg;

  let fileId = "";
  if (modeWanted === "photo") {
    const photos = srcMsg.photo || [];
    const best = photos.length ? photos[photos.length - 1] : null;
    fileId = best ? best.file_id : "";
  } else if (modeWanted === "video") {
    fileId = srcMsg.video ? srcMsg.video.file_id : "";
  }

  if (!fileId) {
    await bot.sendMessage(
      msg.chat.id,
      `❌ No ${modeWanted} found.\n\nHow:\n1) Send ${modeWanted}\n2) Reply that ${modeWanted} with /set${modeWanted}\n(or send ${modeWanted} with caption /set${modeWanted})`
    );
    return;
  }

  await redis.set(KEY_PIN_MODE, modeWanted);
  await redis.set(KEY_PIN_FILE, fileId);
  await bot.sendMessage(msg.chat.id, `✅ Pin mode = ${modeWanted.toUpperCase()} saved.`);
}

bot.onText(/^\/setphoto$/i, async (msg) => {
  try { await setPinMediaFromMessage(msg, "photo"); } catch (e) { console.error("/setphoto error:", e); }
});

bot.onText(/^\/setvideo$/i, async (msg) => {
  try { await setPinMediaFromMessage(msg, "video"); } catch (e) { console.error("/setvideo error:", e); }
});

bot.onText(/^\/status$/i, async (msg) => {
  try {
    if (!ownerOnly(msg)) return;
    const mode = (await redis.get(KEY_PIN_MODE)) || "text";
    const text = (await redis.get(KEY_PIN_TEXT)) || "";
    const fileId = (await redis.get(KEY_PIN_FILE)) || "";
    await bot.sendMessage(
      msg.chat.id,
      "📌 Pin Status\n\n" +
        `Mode: ${mode}\nHas File: ${fileId ? "YES" : "NO"}\nText length: ${text.length}\n\nCommands:\n/setpin <text>\n/setphoto\n/setvideo\n/settext\n/update`
    );
  } catch (e) {
    console.error("/status error:", e);
  }
});

bot.onText(/^\/update$/i, async (msg) => {
  try {
    if (!ownerOnly(msg)) return;
    if (!GROUP_ID) return bot.sendMessage(msg.chat.id, "❌ GROUP_ID မရှိပါ။ Render env မှာ GROUP_ID ထည့်ပါ။");

    const gid = Number(GROUP_ID);
    await bot.sendMessage(msg.chat.id, "⏳ Updating pinned register message...");

    const cached = await redis.get(KEY_PINNED_MSG_ID(String(gid)));
    if (cached) {
      const msgId = Number(cached);
      try {
        try { await bot.unpinChatMessage(gid, { message_id: msgId }); } catch (_) {
          try { await bot.unpinAllChatMessages(gid); } catch (_) {}
        }
        try { await bot.deleteMessage(gid, msgId); } catch (_) {}
      } finally {
        await redis.del(KEY_PINNED_MSG_ID(String(gid)));
      }
    }

    await sendAndPinRegisterMessage(gid);
    await bot.sendMessage(msg.chat.id, "✅ Updated! (Old pin removed, new pin sent & pinned)");
  } catch (e) {
    console.error("/update error:", e);
    try {
      await bot.sendMessage(msg.chat.id, "❌ Update failed: " + (e?.message || String(e)));
    } catch (_) {}
  }
});

// ================= Boot =================
async function boot() {
  const me = await bot.getMe();
  BOT_ID = String(me.id);
  BOT_USERNAME = me.username ? String(me.username) : null;
  console.log("Bot Ready:", { BOT_ID, BOT_USERNAME });

  // pin defaults (existing)
  if (!(await redis.get(KEY_PIN_MODE))) await redis.set(KEY_PIN_MODE, "text");
  if (!(await redis.get(KEY_PIN_TEXT))) {
    await redis.set(
      KEY_PIN_TEXT,
      "📌 Lucky77 DM Register (Prize Contact)\n\n✅ Prize ပေါက်သွားရင် DM ကနေ ဆက်သွယ်ပေးနိုင်ဖို့\nအောက်က Button ကိုနှိပ်ပြီး Bot DM ကို Enable/Register လုပ်ပါ။"
    );
  }

  // join defaults (live)
  if (!(await redis.get(KEY_JOIN_CAP))) {
    await redis.set(
      KEY_JOIN_CAP,
      "❌ Channel ကို Join ပြီးမှ Register/Enable DM လုပ်နိုင်ပါသည်。\n\n👉 အောက်က Button နဲ့ Join လုပ်ပြီး ပြန်စစ်ပါ။"
    );
  }
  if (!(await redis.get(KEY_JOIN_BTN))) await redis.set(KEY_JOIN_BTN, "📢 Join Channel");

  // register defaults (live)
  if (!(await redis.get(KEY_REG_MODE))) await redis.set(KEY_REG_MODE, "text");
  if (!(await redis.get(KEY_REG_CAP))) {
    await redis.set(KEY_REG_CAP, "✅ Registered ပြီးပါပြီ。\n\n📩 Prize ပေါက်ရင် ဒီ DM ကနေ ဆက်သွယ်ပေးပါမယ်။");
  }
  if (!(await redis.get(KEY_REG_BTN))) await redis.set(KEY_REG_BTN, "");

  await setupWebhook();
  console.log("Webhook set:", `${PUBLIC_URL}${WEBHOOK_PATH}`);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", async () => {
  console.log("Server running on port", PORT);
  try {
    await boot();
  } catch (e) {
    console.error("Boot error:", e);
  }
});
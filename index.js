"use strict";

/**
 * Lucky77 Wheel Bot — PRO V2 Premium (REMAX FULL)
 *
 * ✅ Webhook mode (Fix 409 Conflict)
 * ✅ Group join service message auto delete (2s)
 * ✅ Join => SILENT auto save (id/name/username) (no popup)
 * ✅ Leave => auto remove from members + winners (spin list/member list clean)
 * ✅ One pinned "Register" message in GROUP with Button to DM (/start register)
 * ✅ Owner DM commands (Pin in group):
 *    - /setpin <text>      => set pin caption/text
 *    - /setphoto           => reply to a photo (or send photo with caption "/setphoto")
 *    - /setvideo           => reply to a video (or send video with caption "/setvideo")
 *    - /settext            => pin mode to text only
 *    - /update             => delete old pin, send new (media/text + caption + button) and pin
 *    - /status             => show current pin config
 *
 * ✅ Owner DM commands (DM auto-reply for members /start):
 *    - /regbotDM <text>        => set DM auto reply text
 *    - /setbotimage            => reply to photo (or send photo caption "/setbotimage")
 *    - /setbotvideo            => reply to video (or send video caption "/setbotvideo")
 *    - /setbottext             => DM reply mode = text only
 *    - /dmstatus               => show DM reply status
 *
 * ✅ API endpoints for CodePen (API_KEY protected):
 *    GET  /health
 *    GET  /members?key=API_KEY
 *    GET  /pool?key=API_KEY
 *    POST /config/prizes?key=API_KEY  { prizeText }
 *    POST /spin?key=API_KEY
 *    GET  /history?key=API_KEY
 *    POST /notice?key=API_KEY { user_id, text }
 *    POST /restart-spin?key=API_KEY
 */

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

if (!GROUP_ID) {
  console.warn("⚠️ GROUP_ID is not set. /update pin from DM needs GROUP_ID.");
}

// ================= Redis =================
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// ================= Keys =================
const KEY_PREFIX = "lucky77:pro:v2:remax";

// members
const KEY_MEMBERS_SET = `${KEY_PREFIX}:members:set`; // set(user_id)
const KEY_MEMBER_HASH = (id) => `${KEY_PREFIX}:member:${id}`; // hash user
const KEY_WINNERS_SET = `${KEY_PREFIX}:winners:set`; // set(user_id)
const KEY_HISTORY_LIST = `${KEY_PREFIX}:history:list`; // list JSON

// prizes
const KEY_PRIZE_BAG = `${KEY_PREFIX}:prizes:bag`; // list expanded
const KEY_PRIZE_SOURCE = `${KEY_PREFIX}:prizes:source`; // raw text

// debug
const KEY_LAST_GROUP = `${KEY_PREFIX}:last_group_id`;

// pinned group register msg
const KEY_PINNED_MSG_ID = (gid) => `${KEY_PREFIX}:pinned:${gid}`;
const KEY_PIN_TEXT = `${KEY_PREFIX}:pin:text`; // caption/text
const KEY_PIN_MODE = `${KEY_PREFIX}:pin:mode`; // "text"|"photo"|"video"
const KEY_PIN_FILE = `${KEY_PREFIX}:pin:file_id`; // file_id

// DM auto reply for /start
const KEY_DM_TEXT = `${KEY_PREFIX}:dm:text`;
const KEY_DM_MODE = `${KEY_PREFIX}:dm:mode`; // "text"|"photo"|"video"
const KEY_DM_FILE = `${KEY_PREFIX}:dm:file_id`;

// ================= Helpers =================
const excludeIds = (EXCLUDE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(String);

function isOwner(userId) {
  return String(userId) === String(OWNER_ID);
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

  // If GROUP_ID set => only that group
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
    dm_ready: "0", // becomes "1" after /start private
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
  // history ကို မဖျက်ဘူး (အရင် winner history ရှိနေရမယ်)
  return { ok: true, reason };
}

async function trySendDM(userId, text) {
  try {
    await bot.sendMessage(Number(userId), text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.response?.body || e?.message || String(e) };
  }
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

    const pinMode = (await redis.get(KEY_PIN_MODE)) || "text";
    const pinHasFile = !!(await redis.get(KEY_PIN_FILE));
    const pinText = (await redis.get(KEY_PIN_TEXT)) || "";

    const dmMode = (await redis.get(KEY_DM_MODE)) || "text";
    const dmHasFile = !!(await redis.get(KEY_DM_FILE));
    const dmText = (await redis.get(KEY_DM_TEXT)) || "";

    res.json({
      ok: true,
      group_id_env: GROUP_ID || null,
      webhook_path: `/telegram/${encodeURIComponent(WEBHOOK_SECRET)}`,
      last_group_seen: lastGroup || null,
      members: Number(members) || 0,
      winners: Number(winners) || 0,
      remaining_prizes: Number(bagLen) || 0,
      pin: { mode: pinMode, has_file: pinHasFile, text_len: pinText.length },
      dm: { mode: dmMode, has_file: dmHasFile, text_len: dmText.length },
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

app.post("/spin", requireApiKey, async (req, res) => {
  try {
    // 1) eligible members (not winners)
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

    // 2) prize bag
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

app.post("/notice", requireApiKey, async (req, res) => {
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

// ================= Telegram Bot (Webhook) =================
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

let BOT_USERNAME = null;
let BOT_ID = null;

// ---- Webhook endpoint ----
const WEBHOOK_PATH = `/telegram/${encodeURIComponent(WEBHOOK_SECRET)}`;
app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

async function setupWebhook() {
  // 409 fix: ensure polling is not used + reset webhook
  await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
  await bot.setWebHook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
}

// ================= PIN REGISTER (GROUP) =================
async function buildRegisterKeyboard() {
  const startUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=register` : null;
  return startUrl
    ? { inline_keyboard: [[{ text: "▶️ Register / Enable DM", url: startUrl }]] }
    : undefined;
}

async function getPinConfig() {
  const mode = (await redis.get(KEY_PIN_MODE)) || "text"; // "text"|"photo"|"video"
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
    sent = await bot.sendPhoto(gid, fileId, {
      caption: text,
      reply_markup: keyboard || undefined,
    });
  } else if (mode === "video" && fileId) {
    sent = await bot.sendVideo(gid, fileId, {
      caption: text,
      reply_markup: keyboard || undefined,
      supports_streaming: true,
    });
  } else {
    sent = await bot.sendMessage(gid, text, {
      reply_markup: keyboard || undefined,
    });
  }

  try {
    await bot.pinChatMessage(gid, sent.message_id, { disable_notification: true });
  } catch (e) {
    console.warn("pinChatMessage failed:", e?.message || e);
  }

  await redis.set(KEY_PINNED_MSG_ID(String(groupId)), String(sent.message_id));
  return sent.message_id;
}

async function deleteOldPinnedMessage(groupId) {
  const gid = String(groupId);
  const cached = await redis.get(KEY_PINNED_MSG_ID(gid));
  if (!cached) return { ok: true, removed: false };

  const msgId = Number(cached);

  try {
    // Try unpin specific; fallback unpin all
    try {
      await bot.unpinChatMessage(Number(gid), { message_id: msgId });
    } catch (_) {
      try {
        await bot.unpinAllChatMessages(Number(gid));
      } catch (_) {}
    }

    // Delete old pinned message
    try {
      await bot.deleteMessage(Number(gid), msgId);
    } catch (_) {}
  } finally {
    await redis.del(KEY_PINNED_MSG_ID(gid));
  }

  return { ok: true, removed: true };
}

async function ensurePinnedRegisterMessage(groupId) {
  const gid = String(groupId);
  const cached = await redis.get(KEY_PINNED_MSG_ID(gid));
  if (cached) return;
  await sendAndPinRegisterMessage(gid);
}

// ================= DM AUTO REPLY (PRIVATE /start) =================
async function getDmConfig() {
  const mode = (await redis.get(KEY_DM_MODE)) || "text";
  const text =
    (await redis.get(KEY_DM_TEXT)) ||
    "✅ Registered ပြီးပါပြီ。\n\n📩 Prize ပေါက်ရင် ဒီ DM ကနေ ဆက်သွယ်ပေးပါမယ်။";
  const fileId = (await redis.get(KEY_DM_FILE)) || "";
  return { mode, text, fileId };
}

async function sendDmWelcome(chatId) {
  const { mode, text, fileId } = await getDmConfig();

  if (mode === "photo" && fileId) {
    return bot.sendPhoto(chatId, fileId, { caption: text });
  }
  if (mode === "video" && fileId) {
    return bot.sendVideo(chatId, fileId, { caption: text, supports_streaming: true });
  }
  return bot.sendMessage(chatId, text);
}

// ================= GROUP HANDLERS =================
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat) return;

    // GROUP
    if (targetGroup(msg.chat)) {
      await redis.set(KEY_LAST_GROUP, String(msg.chat.id));

      // ensure pin exists
      await ensurePinnedRegisterMessage(msg.chat.id);

      // JOIN: delete join service message + silent save new members
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

      // LEAVE: delete leave message + remove member from lists
      if (msg.left_chat_member) {
        await autoDelete(msg.chat.id, msg.message_id, 2000);
        const u = msg.left_chat_member;
        if (u && !isExcludedUser(u.id)) {
          await removeMember(u.id, "left_chat_member");
        }
      }

      return;
    }
  } catch (e) {
    console.error("group message handler error:", e);
  }
});

// ================= PRIVATE /start (register) =================
bot.onText(/^\/start(?:\s+(.+))?/i, async (msg) => {
  try {
    if (!msg || msg.chat.type !== "private") return;

    const u = msg.from;
    if (!u) return;

    if (!isExcludedUser(u.id)) {
      await saveMember(u, "private_start");
      await setDmReady(u.id);
    }

    await sendDmWelcome(msg.chat.id);
  } catch (e) {
    console.error("/start error:", e);
  }
});

// ================= OWNER COMMANDS (DM only) =================
function ownerOnly(msg) {
  return msg && msg.chat && msg.chat.type === "private" && isOwner(msg.from?.id);
}

// ----- Pin caption/text -----
bot.onText(/^\/setpin(?:\s+([\s\S]+))?/i, async (msg, match) => {
  try {
    if (!ownerOnly(msg)) return;

    const text = match && match[1] ? String(match[1]).trim() : "";
    if (!text) {
      await bot.sendMessage(msg.chat.id, "Usage: /setpin your caption/text");
      return;
    }

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

  // reply media OR caption media
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
  try {
    await setPinMediaFromMessage(msg, "photo");
  } catch (e) {
    console.error("/setphoto error:", e);
  }
});

bot.onText(/^\/setvideo$/i, async (msg) => {
  try {
    await setPinMediaFromMessage(msg, "video");
  } catch (e) {
    console.error("/setvideo error:", e);
  }
});

bot.onText(/^\/status$/i, async (msg) => {
  try {
    if (!ownerOnly(msg)) return;
    const { mode, text, fileId } = await getPinConfig();
    await bot.sendMessage(
      msg.chat.id,
      "📌 Pin Status\n\n" +
        `Mode: ${mode}\n` +
        `Has File: ${fileId ? "YES" : "NO"}\n` +
        `Text length: ${String(text || "").length}\n\n` +
        "Commands:\n" +
        "/setpin <text>\n" +
        "/setphoto (reply photo)\n" +
        "/setvideo (reply video)\n" +
        "/settext\n" +
        "/update"
    );
  } catch (e) {
    console.error("/status error:", e);
  }
});

bot.onText(/^\/update$/i, async (msg) => {
  try {
    if (!ownerOnly(msg)) return;

    if (!GROUP_ID) {
      await bot.sendMessage(msg.chat.id, "❌ GROUP_ID မရှိပါ။ Render env မှာ GROUP_ID ထည့်ပါ။");
      return;
    }

    const gid = String(GROUP_ID);

    await bot.sendMessage(msg.chat.id, "⏳ Updating pinned register message...");

    await deleteOldPinnedMessage(gid);
    await sendAndPinRegisterMessage(gid);

    await bot.sendMessage(msg.chat.id, "✅ Updated! (Old pin removed, new pin sent & pinned)");
  } catch (e) {
    console.error("/update error:", e);
    try {
      await bot.sendMessage(msg.chat.id, "❌ Update failed: " + (e?.message || String(e)));
    } catch (_) {}
  }
});

// ----- DM Reply config -----
bot.onText(/^\/regbotDM(?:\s+([\s\S]+))?/i, async (msg, match) => {
  try {
    if (!ownerOnly(msg)) return;

    const text = match && match[1] ? String(match[1]).trim() : "";
    if (!text) {
      await bot.sendMessage(msg.chat.id, "Usage: /regbotDM your reply text");
      return;
    }

    await redis.set(KEY_DM_TEXT, text);
    await bot.sendMessage(msg.chat.id, "✅ DM auto-reply text updated.");
  } catch (e) {
    console.error("/regbotDM error:", e);
  }
});

bot.onText(/^\/setbottext$/i, async (msg) => {
  try {
    if (!ownerOnly(msg)) return;
    await redis.set(KEY_DM_MODE, "text");
    await redis.del(KEY_DM_FILE);
    await bot.sendMessage(msg.chat.id, "✅ DM reply mode = TEXT (no media).");
  } catch (e) {
    console.error("/setbottext error:", e);
  }
});

async function setDmMediaFromMessage(msg, modeWanted) {
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
      `❌ No ${modeWanted} found.\n\nHow:\n1) Send ${modeWanted}\n2) Reply that ${modeWanted} with /setbot${modeWanted === "photo" ? "image" : "video"}\n(or send ${modeWanted} with caption /setbot${modeWanted === "photo" ? "image" : "video"})`
    );
    return;
  }

  await redis.set(KEY_DM_MODE, modeWanted);
  await redis.set(KEY_DM_FILE, fileId);
  await bot.sendMessage(msg.chat.id, `✅ DM reply mode = ${modeWanted.toUpperCase()} saved.`);
}

bot.onText(/^\/setbotimage$/i, async (msg) => {
  try {
    await setDmMediaFromMessage(msg, "photo");
  } catch (e) {
    console.error("/setbotimage error:", e);
  }
});

bot.onText(/^\/setbotvideo$/i, async (msg) => {
  try {
    await setDmMediaFromMessage(msg, "video");
  } catch (e) {
    console.error("/setbotvideo error:", e);
  }
});

bot.onText(/^\/dmstatus$/i, async (msg) => {
  try {
    if (!ownerOnly(msg)) return;
    const { mode, text, fileId } = await getDmConfig();
    await bot.sendMessage(
      msg.chat.id,
      "📩 DM Reply Status\n\n" +
        `Mode: ${mode}\n` +
        `Has File: ${fileId ? "YES" : "NO"}\n` +
        `Text length: ${String(text || "").length}\n\n` +
        "Commands:\n" +
        "/regbotDM <text>\n" +
        "/setbotimage (reply photo)\n" +
        "/setbotvideo (reply video)\n" +
        "/setbottext\n" +
        "/dmstatus"
    );
  } catch (e) {
    console.error("/dmstatus error:", e);
  }
});

// ================= Boot =================
async function boot() {
  const me = await bot.getMe();
  BOT_ID = String(me.id);
  BOT_USERNAME = me.username ? String(me.username) : null;
  console.log("Bot Ready:", { BOT_ID, BOT_USERNAME });

  // default pin config (only if not set yet)
  const hasPinMode = await redis.get(KEY_PIN_MODE);
  if (!hasPinMode) await redis.set(KEY_PIN_MODE, "text");

  const hasPinText = await redis.get(KEY_PIN_TEXT);
  if (!hasPinText) {
    await redis.set(
      KEY_PIN_TEXT,
      "📌 Lucky77 DM Register (Prize Contact)\n\n✅ Prize ပေါက်သွားရင် DM ကနေ ဆက်သွယ်ပေးနိုင်ဖို့\nအောက်က Button ကိုနှိပ်ပြီး Bot DM ကို Enable/Register လုပ်ပါ။"
    );
  }

  // default DM reply config
  const hasDmMode = await redis.get(KEY_DM_MODE);
  if (!hasDmMode) await redis.set(KEY_DM_MODE, "text");

  const hasDmText = await redis.get(KEY_DM_TEXT);
  if (!hasDmText) {
    await redis.set(
      KEY_DM_TEXT,
      "✅ Registered ပြီးပါပြီ。\n\n📩 Prize ပေါက်ရင် ဒီ DM ကနေ ဆက်သွယ်ပေးပါမယ်။"
    );
  }

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
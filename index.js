"use strict";

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Render usually provides this
const RENDER_EXTERNAL_HOSTNAME = process.env.RENDER_EXTERNAL_HOSTNAME;
const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  (RENDER_EXTERNAL_HOSTNAME ? `https://${RENDER_EXTERNAL_HOSTNAME}` : null);

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing");
  process.exit(1);
}

// ===== Redis =====
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// ===== Keys =====
const KEY_MEMBERS = "lucky77:members:v1"; // master list (all ever)
const KEY_WINNERS = "lucky77:winners:v1"; // winner ids (no repeat)
const KEY_HISTORY = "lucky77:history:v1"; // history records
const KEY_PRIZE_CFG = "lucky77:prize_cfg:v1"; // original prizeText + counts
const KEY_PRIZE_REMAIN = "lucky77:prize_remain:v1"; // remaining counts

// ===== Helpers =====
function nowISO() {
  return new Date().toISOString();
}

function safeStr(x) {
  return String(x ?? "").trim();
}

function displayForMember(m) {
  // rule: name if exists else @username else id
  const name = safeStr(m?.name);
  const username = safeStr(m?.username);
  const id = m?.id != null ? String(m.id) : "";
  if (name) return name;
  if (username) return username.startsWith("@") ? username : `@${username}`;
  return id || "-";
}

async function getJson(key, fallback) {
  const v = await redis.get(key);
  if (!v) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  return v;
}

async function setJson(key, obj) {
  await redis.set(key, obj);
}

function uniqById(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const id = x?.id != null ? String(x.id) : "";
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(x);
  }
  return out;
}

function parsePrizeTextToCounts(prizeText) {
  // lines: "10000Ks 4time"
  const lines = safeStr(prizeText)
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  const counts = {};
  for (const line of lines) {
    const m =
      line.match(/^(.+?)\s+\(?(\d+)\)?\s*time$/i) ||
      line.match(/^(.+?)\s+(\d+)$/i);

    if (!m) continue;
    const prize = m[1].trim();
    const times = parseInt(m[2], 10);
    if (!prize || !Number.isFinite(times) || times <= 0) continue;
    counts[prize] = (counts[prize] || 0) + times;
  }
  return counts;
}

function weightedRandomPrize(remainCounts) {
  // remainCounts: { prize: remainingNumber }
  const entries = Object.entries(remainCounts).filter(([, n]) => Number(n) > 0);
  if (!entries.length) return null;

  let total = 0;
  for (const [, n] of entries) total += Number(n);

  let r = Math.random() * total;
  for (const [prize, n] of entries) {
    r -= Number(n);
    if (r <= 0) return prize;
  }
  return entries[entries.length - 1][0];
}

async function ensurePrizeConfig() {
  // if missing config, create a default
  const cfg = await getJson(KEY_PRIZE_CFG, null);
  const remain = await getJson(KEY_PRIZE_REMAIN, null);

  if (!cfg || !cfg.counts || typeof cfg.counts !== "object") {
    const defaultPrizeText =
      "10000Ks 4time\n5000Ks 2time\n3000Ks 3time\n2000Ks 5time\n1000Ks 10time";
    const counts = parsePrizeTextToCounts(defaultPrizeText);
    await setJson(KEY_PRIZE_CFG, { prizeText: defaultPrizeText, counts, updatedAt: nowISO() });
    await setJson(KEY_PRIZE_REMAIN, { ...counts, updatedAt: nowISO() });
    return;
  }

  if (!remain || typeof remain !== "object") {
    await setJson(KEY_PRIZE_REMAIN, { ...cfg.counts, updatedAt: nowISO() });
  }
}

async function addMembersFromUpdate(msg) {
  // capture: msg.from + new_chat_members
  const members = await getJson(KEY_MEMBERS, []);

  const addOne = (u) => {
    if (!u || !u.id) return;
    const id = String(u.id);
    const username = u.username ? `@${u.username}` : "";
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();

    members.push({
      id,
      username, // store with @
      name,
      addedAt: nowISO(),
    });
  };

  if (msg?.from) addOne(msg.from);
  const newMembers = msg?.new_chat_members || [];
  for (const u of newMembers) addOne(u);

  const unique = uniqById(members);
  await setJson(KEY_MEMBERS, unique);
}

async function getEligibleMembers() {
  const members = await getJson(KEY_MEMBERS, []);
  const winners = await getJson(KEY_WINNERS, []); // array of ids
  const winSet = new Set((winners || []).map(String));
  return (members || []).filter((m) => !winSet.has(String(m.id)));
}

// ===== Telegram Bot (Webhook) =====
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Telegram basic command
bot.onText(/\/start/, async (msg) => {
  try {
    await addMembersFromUpdate(msg);
  } catch {}
  bot.sendMessage(msg.chat.id, "Bot is running ✅");
});

// capture members
bot.on("message", async (msg) => {
  try {
    await addMembersFromUpdate(msg);
  } catch (e) {
    console.error("message capture error:", e);
  }
});
bot.on("new_chat_members", async (msg) => {
  try {
    await addMembersFromUpdate(msg);
  } catch (e) {
    console.error("new_chat_members capture error:", e);
  }
});

// webhook receiver
app.post("/telegram", (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error("processUpdate error:", e);
    res.sendStatus(200);
  }
});

// set webhook on start
(async () => {
  try {
    if (PUBLIC_URL) {
      const url = `${PUBLIC_URL}/telegram`;
      await bot.setWebHook(url);
      console.log("Webhook set to:", url);
    } else {
      console.log("PUBLIC_URL not available, webhook not set. (Set PUBLIC_URL env if needed)");
    }
  } catch (e) {
    console.error("setWebHook error:", e);
  }
})();

// ===== API for CodePen =====

// health
app.get("/", async (req, res) => {
  await ensurePrizeConfig();
  const eligible = await getEligibleMembers();
  res.json({ ok: true, eligible: eligible.length });
});

// GET /members => all members ever + won?
app.get("/members", async (req, res) => {
  const members = await getJson(KEY_MEMBERS, []);
  const winners = await getJson(KEY_WINNERS, []);
  const winSet = new Set((winners || []).map(String));

  const out = (members || []).map((m) => ({
    id: m.id,
    username: m.username || "",
    name: m.name || "",
    display: displayForMember(m),
    isWinner: winSet.has(String(m.id)),
  }));

  res.json({ ok: true, members: out, total: out.length, winners: winSet.size });
});

// GET /pool => eligible members (not won yet)
app.get("/pool", async (req, res) => {
  const pool = await getEligibleMembers();
  const out = (pool || []).map((m) => ({
    id: m.id,
    username: (m.username || "").replace("@", ""), // for direct link in UI
    name: m.name || "",
    display: displayForMember(m),
  }));
  res.json({ ok: true, pool: out, count: out.length });
});

// GET /history
app.get("/history", async (req, res) => {
  const history = await getJson(KEY_HISTORY, []);
  res.json({ ok: true, history: history || [] });
});

// POST /config/prizes  body: { prizeText }
app.post("/config/prizes", async (req, res) => {
  const prizeText = safeStr(req.body?.prizeText);
  const counts = parsePrizeTextToCounts(prizeText);

  if (!prizeText || !Object.keys(counts).length) {
    return res.status(400).json({
      ok: false,
      error: "Invalid prizeText. Example: 10000Ks 4time",
    });
  }

  await setJson(KEY_PRIZE_CFG, { prizeText, counts, updatedAt: nowISO() });
  await setJson(KEY_PRIZE_REMAIN, { ...counts, updatedAt: nowISO() });

  res.json({ ok: true, counts });
});

// POST /restart-spin => reset winners + reset prize remain + clear history
app.post("/restart-spin", async (req, res) => {
  await ensurePrizeConfig();
  const cfg = await getJson(KEY_PRIZE_CFG, null);
  await setJson(KEY_WINNERS, []);
  await setJson(KEY_HISTORY, []);
  await setJson(KEY_PRIZE_REMAIN, { ...(cfg?.counts || {}), updatedAt: nowISO() });
  res.json({ ok: true });
});

// POST /spin  body: { }  (clientPrize ignored; server is source of truth)
app.post("/spin", async (req, res) => {
  await ensurePrizeConfig();

  const eligible = await getEligibleMembers();
  if (!eligible.length) {
    return res.status(400).json({ ok: false, error: "Pool empty (no eligible members)" });
  }

  const remain = await getJson(KEY_PRIZE_REMAIN, {});
  // remove meta if exists
  const remainCounts = { ...remain };
  delete remainCounts.updatedAt;

  const prize = weightedRandomPrize(remainCounts);
  if (!prize) {
    return res.status(400).json({ ok: false, error: "Prize empty (no remaining prize turns)" });
  }

  // random winner (no repeat) from eligible
  const idx = Math.floor(Math.random() * eligible.length);
  const winner = eligible[idx];

  // update winners
  const winners = await getJson(KEY_WINNERS, []);
  winners.push(String(winner.id));
  await setJson(KEY_WINNERS, winners);

  // decrement prize remain
  remainCounts[prize] = Number(remainCounts[prize] || 0) - 1;
  await setJson(KEY_PRIZE_REMAIN, { ...remainCounts, updatedAt: nowISO() });

  // history record
  const history = await getJson(KEY_HISTORY, []);
  const record = {
    prize,
    winner: {
      id: String(winner.id),
      name: winner.name || "",
      username: (winner.username || "").replace("@", ""), // no @
      display: displayForMember(winner),
    },
    at: nowISO(),
  };
  history.unshift(record);
  // keep last 200
  await setJson(KEY_HISTORY, history.slice(0, 200));

  res.json({
    ok: true,
    prize,
    remainingPrize: Number(remainCounts[prize] || 0),
    winner: record.winner,
  });
});

// ===== Start server =====
app.listen(PORT, () => console.log("Server running on port " + PORT));

// graceful shutdown
process.on("SIGTERM", async () => {
  try {
    console.log("SIGTERM received. Shutting down...");
  } finally {
    process.exit(0);
  }
});

"use strict";

const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(cors());               // ✅ CodePen fetch works
app.use(express.json());

const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : null;

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const PUBLIC_URL =
  process.env.PUBLIC_URL || `http://localhost:${PORT}`; // Render မှာ env ထည့်ရင်ပိုကောင်း

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN missing");
  process.exit(1);
}
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("❌ UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing");
  process.exit(1);
}

// ✅ Redis client
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// =========================
// Redis Keys
// =========================
const KEY_MEMBERS = "lucky77:members:v1";     // all known members (objects)
const KEY_WINNERS = "lucky77:winners:v1";     // history list [{prize, memberKey, at}]
const KEY_USED = "lucky77:used:v1";           // used member keys in current session
const KEY_PRIZE_PLAN = "lucky77:prizeplan:v1";// plan [{label,count,used}]
const KEY_SESSION = "lucky77:session:v1";     // session id string

// =========================
// Helpers
// =========================
function nowISO() {
  return new Date().toISOString();
}

function isAdmin(msgOrReq) {
  if (!ADMIN_ID) return true;
  const id =
    msgOrReq?.from?.id ??
    msgOrReq?.body?.fromId ??
    msgOrReq?.headers?.["x-admin-id"];
  return String(id) === String(ADMIN_ID);
}

// Upstash sometimes returns object/array
async function getJSON(key, fallback) {
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
async function setJSON(key, value) {
  await redis.set(key, value);
}

// member identity: prefer username, else id
function memberKeyFromUser(u) {
  const username = u?.username ? String(u.username).trim() : "";
  const id = u?.id != null ? String(u.id) : "";
  return username ? `u:${username.toLowerCase()}` : `id:${id}`;
}

function displayNameFromUser(u) {
  const first = u?.first_name ? String(u.first_name).trim() : "";
  const last = u?.last_name ? String(u.last_name).trim() : "";
  const full = [first, last].filter(Boolean).join(" ").trim();

  const username = u?.username ? `@${String(u.username).trim()}` : "";
  const id = u?.id != null ? String(u.id) : "";

  // priority: full name > username > id
  return full || username || id || "Unknown";
}

function memberSubText(u) {
  const full = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim();
  const username = u?.username ? `@${u.username}` : "";
  const id = u?.id != null ? String(u.id) : "";
  return `name: ${full || "-"} | user: ${username || "-"} | id: ${id || "-"}`;
}

function uniqUpsertMember(list, user, chatId) {
  const key = memberKeyFromUser(user);
  const existing = list.find((m) => m.key === key);
  const obj = {
    key,
    id: user?.id != null ? String(user.id) : null,
    username: user?.username ? String(user.username) : null,
    first_name: user?.first_name ? String(user.first_name) : null,
    last_name: user?.last_name ? String(user.last_name) : null,
    display: displayNameFromUser(user),
    chatId: chatId != null ? String(chatId) : null,
    lastSeenAt: nowISO(),
  };

  if (!existing) {
    list.push(obj);
  } else {
    // update fields (keep any old chatId if new missing)
    Object.assign(existing, obj, {
      chatId: obj.chatId || existing.chatId,
      lastSeenAt: obj.lastSeenAt,
    });
  }
  return key;
}

// prize plan
function normalizePrizePlan(plan) {
  // plan: [{label,count,used}]
  const out = [];
  for (const p of Array.isArray(plan) ? plan : []) {
    const label = String(p?.label || "").trim();
    const count = Number(p?.count || 0);
    const used = Number(p?.used || 0);
    if (!label || !Number.isFinite(count) || count <= 0) continue;
    out.push({ label, count, used: Math.max(0, used) });
  }
  return out;
}

function getNextPrize(plan) {
  for (const p of plan) {
    if (p.used < p.count) return p;
  }
  return null;
}

function pickRandom(arr) {
  const i = Math.floor(Math.random() * arr.length);
  return arr[i];
}

// =========================
// Telegram Bot
// =========================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// /start
bot.onText(/\/start/, async (msg) => {
  bot.sendMessage(msg.chat.id, "Bot is running ✅");
});

// capture any message sender (privacy disabled => group messages come)
bot.on("message", async (msg) => {
  try {
    if (!msg?.from) return;
    const members = await getJSON(KEY_MEMBERS, []);
    uniqUpsertMember(members, msg.from, msg.chat?.id);
    await setJSON(KEY_MEMBERS, members);
  } catch (e) {
    console.error("message capture error:", e);
  }
});

// group join => auto add new members
bot.on("new_chat_members", async (msg) => {
  try {
    const chatId = msg.chat?.id;
    const members = await getJSON(KEY_MEMBERS, []);
    const joined = msg.new_chat_members || [];
    joined.forEach((u) => uniqUpsertMember(members, u, chatId));
    await setJSON(KEY_MEMBERS, members);
  } catch (e) {
    console.error("new_chat_members error:", e);
  }
});

// =========================
// Webhook endpoint (optional)
// If you later switch to webhook, Render URL can handle it.
// For now polling is ON, so this endpoint is not required.
// =========================
app.post("/telegram", (req, res) => {
  res.json({ ok: true, note: "Polling mode active. Webhook not required." });
});

// =========================
// API Routes (CodePen uses these)
// =========================

// health
app.get("/", async (req, res) => {
  const members = await getJSON(KEY_MEMBERS, []);
  const winners = await getJSON(KEY_WINNERS, []);
  const plan = normalizePrizePlan(await getJSON(KEY_PRIZE_PLAN, []));
  res.json({
    ok: true,
    service: "lucky77-wheel-bot",
    members: members.length,
    winners: winners.length,
    hasPrizePlan: plan.length > 0,
    publicUrl: PUBLIC_URL,
    time: nowISO(),
  });
});

// get members
app.get("/members", async (req, res) => {
  const members = await getJSON(KEY_MEMBERS, []);
  // sort by lastSeenAt desc
  members.sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")));
  res.json({ ok: true, count: members.length, members });
});

// export members as text/csv-like
app.get("/members/export", async (req, res) => {
  const members = await getJSON(KEY_MEMBERS, []);
  const lines = [
    "No,display,username,id,first_name,last_name,lastSeenAt",
    ...members.map((m, i) =>
      [
        i + 1,
        (m.display || "").replaceAll(",", " "),
        m.username ? `@${m.username}` : "",
        m.id || "",
        m.first_name || "",
        m.last_name || "",
        m.lastSeenAt || "",
      ].join(",")
    ),
  ];
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(lines.join("\n"));
});

// get winners
app.get("/winners", async (req, res) => {
  const winners = await getJSON(KEY_WINNERS, []);
  res.json({ ok: true, count: winners.length, winners });
});

// reset session (allow reuse members again)
app.post("/restart", async (req, res) => {
  // If ADMIN_ID exists, require admin header or body
  if (ADMIN_ID && !isAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  await setJSON(KEY_USED, []);
  await setJSON(KEY_WINNERS, []);
  await setJSON(KEY_SESSION, `sess_${Date.now()}`);

  // reset used count in prize plan too
  const plan = normalizePrizePlan(await getJSON(KEY_PRIZE_PLAN, []));
  plan.forEach((p) => (p.used = 0));
  await setJSON(KEY_PRIZE_PLAN, plan);

  res.json({ ok: true, message: "Restarted. Used members cleared, winners cleared, prize counts reset." });
});

// set prize plan
// body: { planText: "10000Ks | 5\n5000Ks | 2" } OR { plan: [{label,count}] }
app.post("/prizes", async (req, res) => {
  // If ADMIN_ID exists, require admin header or body
  if (ADMIN_ID && !isAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  const { planText, plan } = req.body || {};
  let parsed = [];

  if (typeof planText === "string" && planText.trim()) {
    const lines = planText.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const [labelRaw, countRaw] = line.split("|").map((x) => String(x || "").trim());
      const label = labelRaw;
      const count = Number(countRaw || 0);
      if (label && Number.isFinite(count) && count > 0) parsed.push({ label, count, used: 0 });
    }
  } else if (Array.isArray(plan)) {
    parsed = plan
      .map((p) => ({
        label: String(p?.label || "").trim(),
        count: Number(p?.count || 0),
        used: 0,
      }))
      .filter((p) => p.label && Number.isFinite(p.count) && p.count > 0);
  } else {
    return res.status(400).json({ ok: false, error: "Send {planText} or {plan:[{label,count}]}" });
  }

  parsed = normalizePrizePlan(parsed);
  await setJSON(KEY_PRIZE_PLAN, parsed);

  res.json({ ok: true, count: parsed.length, plan: parsed });
});

// get prize plan
app.get("/prizes", async (req, res) => {
  const plan = normalizePrizePlan(await getJSON(KEY_PRIZE_PLAN, []));
  const next = getNextPrize(plan);
  res.json({ ok: true, plan, nextPrize: next ? { label: next.label, remaining: next.count - next.used } : null });
});

// PURE RANDOM SPIN
// Picks next available prize by plan order (first remaining).
// Picks random member that has NOT won before in this session.
app.post("/spin", async (req, res) => {
  try {
    const plan = normalizePrizePlan(await getJSON(KEY_PRIZE_PLAN, []));
    if (plan.length === 0) {
      return res.status(400).json({ ok: false, error: "Prize plan is empty. Set /prizes first." });
    }
    const nextPrize = getNextPrize(plan);
    if (!nextPrize) {
      return res.status(400).json({ ok: false, error: "All prizes finished. Use /restart to start new session." });
    }

    const members = await getJSON(KEY_MEMBERS, []);
    if (!Array.isArray(members) || members.length === 0) {
      return res.status(400).json({ ok: false, error: "No members saved yet. Let people join or send message in group." });
    }

    const usedKeys = await getJSON(KEY_USED, []);
    const usedSet = new Set(Array.isArray(usedKeys) ? usedKeys : []);

    const available = members.filter((m) => m?.key && !usedSet.has(m.key));
    if (available.length === 0) {
      return res.status(400).json({ ok: false, error: "No available members left (everyone already won). Use /restart." });
    }

    const winner = pickRandom(available);

    // mark used
    usedSet.add(winner.key);
    await setJSON(KEY_USED, Array.from(usedSet));

    // increment prize used
    nextPrize.used += 1;
    await setJSON(KEY_PRIZE_PLAN, plan);

    // record history
    const winners = await getJSON(KEY_WINNERS, []);
    const entry = {
      at: nowISO(),
      prize: nextPrize.label,
      memberKey: winner.key,
      display: winner.display,
      username: winner.username ? `@${winner.username}` : null,
      id: winner.id,
      sub: `name:${[winner.first_name, winner.last_name].filter(Boolean).join(" ").trim() || "-"} | user:${winner.username ? "@"+winner.username : "-"} | id:${winner.id || "-"}`,
    };
    winners.unshift(entry);
    await setJSON(KEY_WINNERS, winners);

    res.json({
      ok: true,
      prize: nextPrize.label,
      prizeRemainingForThis: nextPrize.count - nextPrize.used,
      member: {
        key: winner.key,
        display: winner.display,
        username: winner.username ? `@${winner.username}` : null,
        id: winner.id,
        first_name: winner.first_name,
        last_name: winner.last_name,
      },
      historyCount: winners.length,
      poolRemainingMembers: available.length - 1,
    });
  } catch (e) {
    console.error("spin error:", e);
    res.status(500).json({ ok: false, error: "Server error", detail: String(e?.message || e) });
  }
});

// =========================
// Start server
// =========================
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
  console.log("PUBLIC_URL:", PUBLIC_URL);
  console.log("Polling Telegram: ON");
});

// Render graceful shutdown
process.on("SIGTERM", async () => {
  try {
    console.log("SIGTERM received. Shutting down...");
  } finally {
    process.exit(0);
  }
});

// index.js (ESM) - Render + Node 22 OK
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(express.json());

// Render provides PORT
const PORT = process.env.PORT || 3000;

// ✅ Token from Render Environment Variables
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing. Add BOT_TOKEN in Render Environment Variables.");
  process.exit(1);
}

// ---------------------------
// Simple persistence (participants.json)
// NOTE: .gitignore ထဲထည့်ထားတာက GitHub မတက်အောင်ပဲ—Runtime မှာ file save/load လုပ်လို့ရတယ်
// Render free plan မှာ filesystem က restart တိုင်း reset ဖြစ်နိုင်တာတော့ သတိထား
// ---------------------------
const DATA_FILE = path.resolve(process.cwd(), "participants.json");

async function loadParticipants() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // sanitize to string array
    return parsed.map((x) => String(x)).filter(Boolean);
  } catch (err) {
    // file not found or invalid JSON -> start empty
    return [];
  }
}

async function saveParticipants(list) {
  const safe = Array.from(new Set(list.map((x) => String(x).trim()).filter(Boolean)));
  await fs.writeFile(DATA_FILE, JSON.stringify(safe, null, 2), "utf8");
  return safe;
}

let participants = await loadParticipants();

// ---------------------------
// Telegram Bot (Polling)
// ---------------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function pickRandom(list) {
  if (!list.length) return null;
  const idx = Math.floor(Math.random() * list.length);
  return list[idx];
}

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  const text =
    "✅ Lucky77 Wheel Bot Ready!\n\n" +
    "Commands:\n" +
    "/add <name>  - add participant\n" +
    "/list        - show participants\n" +
    "/clear       - clear all\n" +
    "/spin        - pick random winner\n" +
    "/count       - show count\n";
  await bot.sendMessage(chatId, text);
});

bot.onText(/^\/add(?:\s+(.+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const name = (match?.[1] || "").trim();

  if (!name) {
    return bot.sendMessage(chatId, "❗ Usage: /add <name>\nExample: /add Aung Aung");
  }

  participants.push(name);
  participants = await saveParticipants(participants);

  await bot.sendMessage(chatId, `✅ Added: ${name}\n👥 Total: ${participants.length}`);
});

bot.onText(/^\/list$/i, async (msg) => {
  const chatId = msg.chat.id;

  if (!participants.length) {
    return bot.sendMessage(chatId, "📭 No participants yet. Use /add <name>");
  }

  const lines = participants.map((p, i) => `${i + 1}. ${p}`).join("\n");
  await bot.sendMessage(chatId, `👥 Participants (${participants.length}):\n${lines}`);
});

bot.onText(/^\/count$/i, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, `👥 Total participants: ${participants.length}`);
});

bot.onText(/^\/clear$/i, async (msg) => {
  const chatId = msg.chat.id;
  participants = [];
  participants = await saveParticipants(participants);
  await bot.sendMessage(chatId, "🧹 Cleared all participants.");
});

bot.onText(/^\/spin$/i, async (msg) => {
  const chatId = msg.chat.id;

  if (!participants.length) {
    return bot.sendMessage(chatId, "📭 No participants to spin. Use /add <name>");
  }

  const winner = pickRandom(participants);
  await bot.sendMessage(chatId, `🎉 Winner: ${winner}`);
});

// Optional: log errors
bot.on("polling_error", (err) => console.error("Polling error:", err?.message || err));
bot.on("webhook_error", (err) => console.error("Webhook error:", err?.message || err));

// ---------------------------
// Express Routes (health)
// ---------------------------
app.get("/", (req, res) => {
  res.json({ ok: true, participants: participants.length });
});

app.get("/participants", (req, res) => {
  res.json({ ok: true, participants });
});

app.
  post("/participants", async (req, res) => {
  // body: { name: "..." } OR { names: ["a","b"] }
  const { name, names } = req.body || {};

  let added = [];
  if (typeof name === "string" && name.trim()) {
    added = [name.trim()];
  } else if (Array.isArray(names)) {
    added = names.map((x) => String(x).trim()).filter(Boolean);
  }

  if (!added.length) {
    return res.status(400).json({ ok: false, error: "Send {name} or {names:[...]}" });
  }

  participants.push(...added);
  participants = await saveParticipants(participants);

  res.json({ ok: true, added, total: participants.length });
});

app.post("/clear", async (req, res) => {
  participants = [];
  participants = await saveParticipants(participants);
  res.json({ ok: true, total: participants.length });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// Graceful shutdown (Render restarts)
process.on("SIGTERM", async () => {
  console.log("SIGTERM received. Shutting down...");
  try {
    await saveParticipants(participants);
  } catch {}
  process.exit(0);
});

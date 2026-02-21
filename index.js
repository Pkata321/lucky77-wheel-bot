"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN env var");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "participants.json");

// ---- Storage helpers ----
function loadParticipants() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("Failed to load participants.json:", e);
    return [];
  }
}

function saveParticipants(list) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save participants.json:", e);
  }
}

function pickRandom(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const idx = Math.floor(Math.random() * list.length);
  return list[idx];
}

// ---- State ----
let participants = loadParticipants();

// ---- Telegram bot (Polling) ----
// Render free instance နဲ့ polling သုံးလို့ရအောင် ဒီပုံစံထားထားတယ်။
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const text =
    "Welcome!\n\nCommands:\n" +
    "/add <name>  - add a participant\n" +
    "/list        - show participants\n" +
    "/pick        - pick a random winner\n" +
    "/clear       - clear all participants\n";
  await bot.sendMessage(chatId, text);
});

bot.onText(/\/add(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const name = (match && match[1] ? match[1] : "").trim();

  if (!name) {
    return bot.sendMessage(chatId, "Usage: /add <name>");
  }

  participants.push(name);
  saveParticipants(participants);

  // IMPORTANT: template literal must use backticks
  const reply = Added: ${name}\nTotal: ${participants.length};
  await bot.sendMessage(chatId, reply);
});

bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;

  if (!participants.length) {
    return bot.sendMessage(chatId, "No participants yet.");
  }

  const lines = participants.map((p, i) => `${i + 1}. ${p}`);
  await bot.sendMessage(chatId, lines.join("\n"));
});

bot.onText(/\/pick/, async (msg) => {
  const chatId = msg.chat.id;

  if (!participants.length) {
    return bot.sendMessage(chatId, "No participants to pick from.");
  }

  const winner = pickRandom(participants);
  await bot.sendMessage(chatId, `Winner: ${winner}`);
});

bot.onText(/\/clear/, async (msg) => {
  const chatId = msg.chat.id;

  participants = [];
  saveParticipants(participants);

  await bot.sendMessage(chatId, "Cleared all participants.");
});

// ---- Express server (Render health) ----
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ ok: true, participants: participants.length });
});

// Optional REST endpoints (if you want)
app.get("/participants", (req, res) => {
  res.json({ ok: true, participants });
});

app.post("/participants", (req, res) => {
  const { name, names } = req.body || {};
  let added = [];

  if (typeof name === "string" && name.trim()) {
    added = [name.trim()];
  } else if (Array.isArray(names)) {
    added = names.map((x) => String(x).trim()).filter(Boolean);
  }

  if (!added.length) {
    return res
      .status(400)
      .json({ ok: false, error: "Send {name:'...'} or {names:['a','b']}" });
  }

  participants.push(...added);
  saveParticipants(participants);

  res.json({ ok: true, added, total: participants.length });
});

app.post("/clear", (req, res) => {
  participants = [];
  saveParticipants(participants);
  res.json({ ok: true, total: participants.length });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown (Render restarts)
process.on("SIGTERM", () => {
  try {
    saveParticipants(participants);
  } finally {process.exit(0);
  }
});

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}

// Telegram polling
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// memory list
let participants = [];

// Telegram Commands
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Bot is running ✅");
});

bot.onText(/\/add (.+)/, (msg, match) => {
  const name = String(match[1] || "").trim();
  if (!name) {
    bot.sendMessage(msg.chat.id, "Usage: /add name");
    return;
  }
  participants.push(name);
  bot.sendMessage(msg.chat.id, "Added: " + name + "\nTotal: " + participants.length);
});

bot.onText(/\/list/, (msg) => {
  if (participants.length === 0) {
    bot.sendMessage(msg.chat.id, "List empty");
    return;
  }
  bot.sendMessage(msg.chat.id, participants.map((n, i) => `${i + 1}. ${n}`).join("\n"));
});

bot.onText(/\/clear/, (msg) => {
  participants = [];
  bot.sendMessage(msg.chat.id, "Cleared ✅");
});

bot.onText(/\/spin/, (msg) => {
  if (participants.length === 0) {
    bot.sendMessage(msg.chat.id, "List empty");
    return;
  }
  const winner = participants[Math.floor(Math.random() * participants.length)];
  bot.sendMessage(msg.chat.id, "🎉 Winner: " + winner);
});

// Health endpoint for Render
app.get("/", (req, res) => {
  res.json({ ok: true, participants: participants.length });
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

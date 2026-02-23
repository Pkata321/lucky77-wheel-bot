const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const DATA_FILE = "./participants.json";
let participants = new Map();

function loadParticipants() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        participants = new Map(arr.map(p => [String(p.userId), p]));
      }
    }
  } catch (e) {
    console.error("Load error:", e.message);
  }
}

function saveParticipants() {
  try {
    const arr = Array.from(participants.values());
    fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2), "utf8");
  } catch (e) {
    console.error("Save error:", e.message);
  }
}

loadParticipants();

function getName(user) {
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ");
  if (full) return full;
  if (user.username) return "@" + user.username;
  return "user_" + user.id;
}

bot.on("message", function (msg) {
  try {
    if (msg.new_chat_members && msg.new_chat_members.length > 0) {
      msg.new_chat_members.forEach(function (user) {
        if (user.is_bot) return;

        participants.set(String(user.id), {
          userId: user.id,
          name: getName(user),
          username: user.username || "",
          joinedAt: new Date().toISOString()
        });
      });

      saveParticipants();
    }

    if (msg.text && msg.text.toLowerCase() === "hello") {
      bot.sendMessage(msg.chat.id, "Bot is running");
    }
  } catch (e) {
    console.error("Bot error:", e.message);
  }
});

bot.on("polling_error", function (err) {
  console.error("Polling error:", err.message || err);
});

app.get("/", function (req, res) {
  res.json({
    ok: true,
    participants: participants.size
  });
});

app.get("/participants", function (req, res) {
  const list = Array.from(participants.values());
  res.json({
    ok: true,
    count: list.length,
    participants: list
  });
});

app.listen(PORT, function () {
  console.log("Server running on port " + PORT);
});

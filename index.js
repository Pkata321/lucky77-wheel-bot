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
  if (fs.existsSync(DATA_FILE)) {
    const data = JSON.parse(fs.readFileSync(DATA_FILE));
    participants = new Map(data.map(p => [String(p.userId), p]));
  }
}

function saveParticipants() {
  const arr = Array.from(participants.values());
  fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2));
}

loadParticipants();

function getName(user) {
  return (
    [user.first_name, user.last_name].filter(Boolean).join(" ") ||
    user.username ||
    user_${user.id}
  );
}

bot.on("message", (msg) => {
  if (msg.new_chat_members) {
    msg.new_chat_members.forEach((user) => {
      if (user.is_bot) return;

      participants.set(String(user.id), {
        userId: user.id,
        name: getName(user),
        username: user.username || "",
        joinedAt: new Date().toISOString(),
      });
    });

    saveParticipants();
  }
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    participants: participants.size,
  });
});

app.get("/participants", (req, res) => {
  const list = Array.from(participants.values());
  res.json({
    ok: true,
    count: list.length,
    participants: list,
  });
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

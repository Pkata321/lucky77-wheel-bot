const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN in Render Environment Variables");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const DATA_FILE = "./participants.json";
let participants = new Map();

// ===== Load/Save =====
function loadParticipants() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        participants = new Map(arr.map((p) => [String(p.userId), p]));
      }
      console.log("✅ Loaded participants:", participants.size);
    } else {
      console.log("ℹ️ participants.json not found (fresh start)");
    }
  } catch (e) {
    console.error("❌ loadParticipants error:", e.message);
  }
}

function saveParticipants() {
  try {
    const arr = Array.from(participants.values());
    fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2), "utf8");
  } catch (e) {
    console.error("❌ saveParticipants error:", e.message);
  }
}

loadParticipants();

// ===== Helpers =====
function getName(user) {
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (full) return full;
  if (user.username) return "@" + user.username;
  return "user_" + user.id;
}

// ===== Telegram handler =====
bot.on("message", async (msg) => {
  try {
    // Register users who join group
    if (msg.new_chat_members && msg.new_chat_members.length > 0) {
      const groupChatId = msg.chat.id;
      let added = 0;

      msg.new_chat_members.forEach((user) => {
        if (user.is_bot) return;

        participants.set(String(user.id), {
          userId: user.id,
          name: getName(user),
          username: user.username || "",
          groupChatId,
          joinedAt: new Date().toISOString(),
        });

        added += 1;
      });

      saveParticipants();

      if (added > 0) {
        await bot.sendMessage(
          groupChatId,
          ✅ Registered ${added} member(s).\nTotal: ${participants.size}
        );
      }
      return;
    }

    // Simple test command
    if (msg.text && msg.text.toLowerCase() === "hello") {
      await bot.sendMessage(msg.chat.id, "Hello 👋 Lucky77 Bot is running!");
    }
  } catch (e) {
    console.error("❌ bot message handler error:", e.message);
  }
});

bot.on("polling_error", (err) => {
  console.error("❌ polling_error:", err.message || err);
});

// ===== Express routes =====
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "lucky77-wheel-bot",
    participants: participants.size,
  });
});

app.get("/participants", (req, res) => {
  const list = Array.from(participants.values()).map((p) => ({
    userId: p.userId,
    name: p.name,
    username: p.username,
  }));

  res.json({ ok: true, count: list.length, participants: list });
});

app.get("/health", (req, res) => res.send("OK"));

// ===== Start =====
app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});

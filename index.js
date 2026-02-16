import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = https://api.telegram.org/bot${BOT_TOKEN};

// In-memory storage
const members = new Map(); // key: userId

// Build display name (duplicate safe)
function buildDisplay(user) {
  const name =
    ${user.first_name || ""} ${user.last_name || ""}.trim() || "Unknown";

  const username = user.username ? @${user.username} : "";

  const display = username
    ? ${name} (${username})
    : ${name} (ID:${user.id});

  return { name, username, display };
}

function upsertMember(user) {
  if (!user || !user.id) return;

  const { name, username, display } = buildDisplay(user);

  members.set(user.id, {
    id: user.id,
    name,
    username,
    display,
    addedAt: new Date().toISOString(),
  });
}

// Root check
app.get("/", (req, res) => {
  res.send("Lucky77 Bot API Running ✅");
});

// Telegram webhook
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;

    if (update.message) {
      const user = update.message.from;
      const chatId = update.message.chat.id;

      upsertMember(user);

      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "You are registered for Lucky77 🎉",
        }),
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

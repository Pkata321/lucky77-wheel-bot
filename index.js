import express from "express";
import TelegramBot from "node-telegram-bot-api";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// 👉 Render Environment Variables မှာ ထည့်ထားရမယ့် TOKEN
const token = process.env.BOT_TOKEN;

const bot = new TelegramBot(token, { polling: true });

// Group ထဲ message လာရင် reply ပြန်မယ်
bot.on("message", (msg) => {
  const chatId = msg.chat.id;

  if (msg.text === "hello") {
    bot.sendMessage(chatId, "Hello 👋 Welcome to Lucky77 Spin!");
  }
});

app.get("/", (req, res) => {
  res.send("Lucky77 Bot Running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

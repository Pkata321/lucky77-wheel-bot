import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error("BOT_TOKEN is missing!");
  process.exit(1);
}

app.get("/", (req, res) => {
  res.send("Lucky77 Bot Running ✅");
});

app.post("/webhook", async (req, res) => {
  const update = req.body;

  if (update.message) {
    const chatId = update.message.chat.id;
    const user = update.message.from;

    const name = ${user.first_name || ""} ${user.last_name || ""}
      .trim() || "Unknown";

    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: Hello ${name} 👋
      })
    });
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

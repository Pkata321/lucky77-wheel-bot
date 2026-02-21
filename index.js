// privacy-ish: you can expose hashed IDs to frontend if needed later
  return crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 16);
}

// ===== Telegram Bot =====
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

async function notifyAdmin(text) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await bot.sendMessage(ADMIN_CHAT_ID, text);
  } catch (e) {
    console.error("Admin notify failed:", e?.message || e);
  }
}

// 1) Register new group members
bot.on("message", async (msg) => {
  try {
    // group join event
    if (msg.new_chat_members?.length) {
      const groupChatId = msg.chat.id;

      for (const u of msg.new_chat_members) {
        // ignore bots (including itself)
        if (u.is_bot) continue;

        const userId = u.id;
        const p = {
          userId,
          userIdHash: hashId(userId),
          name: getDisplayName(u),
          username: u.username || "",
          joinedAt: new Date().toISOString(),
          groupChatId,
        };

        participants.set(String(userId), p);
      }

      saveParticipants();

      // Optional: group confirmation message (can comment out if noisy)
      await bot.sendMessage(
        groupChatId,
        ✅ Registered ${msg.new_chat_members.filter(m => !m.is_bot).length} member(s) for Spin.\nTotal participants: ${participants.size}
      );

      return;
    }

    // Optional demo command
    if (msg.text?.toLowerCase() === "hello") {
      await bot.sendMessage(msg.chat.id, "Hello 👋 Lucky77 Bot is running!");
    }
  } catch (e) {
    console.error("bot.on(message) error:", e?.message || e);
    await notifyAdmin(`⚠️ Bot error: ${e?.message || e}`);
  }
});

// Optional: log polling errors
bot.on("polling_error", (err) => {
  console.error("polling_error:", err?.message || err);
});

// ===== Express Routes =====
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "lucky77-wheel-bot",
    participants: participants.size,
  });
});

// For CodePen: list participants
app.get("/participants", requireKey, (req, res) => {
  const list = Array.from(participants.values()).map((p) => ({
    userId: p.userId,         // if you don't want raw id, remove this and use userIdHash only
    userIdHash: p.userIdHash,
    name: p.name,
    username: p.username,
  }));

  res.json({ ok: true, count: list.length, participants: list });
});

// Admin endpoint: clear participants (protected)
// Usage: POST /admin/clear  with header X-API-KEY
app.post("/admin/clear", requireKey, (req, res) => {
  participants.clear();
  saveParticipants();
  res.json({ ok: true, cleared: true });
});

// Health check
app.get("/health", (req, res) => res.send("OK"));

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

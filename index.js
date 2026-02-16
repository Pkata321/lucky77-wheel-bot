import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

// In-memory storage (simple)
const members = new Map(); // key: userId -> {id, name, username, display, addedAt}

function buildDisplay(user) {
const name = ${user.first_name} ${user.last_name || ""}.trim() || "Unknown";
  const username = user.username ? @${user.username} : "";
  // ✅ Duplicate-safe label:
  // username ရှိရင် ( @username ) ၊ မရှိရင် (ID:xxxx)
  const display = username ? ${name} (${username}) : ${name} (ID:${user.id});
  return { name, username, display };
}

function upsertMember(user) {
  if (!user || !user.id) return;
  const { name, username, display } = buildDisplay(user);

  const old = members.get(user.id);
  members.set(user.id, {
    id: user.id,
    name,
    username,
    display,
    addedAt: old?.addedAt || new Date().toISOString()
  });
}

app.get("/", (req, res) => res.send("Lucky77 Bot API Running"));
app.get("/health", (req, res) => res.json({ ok: true, count: members.size }));

// ✅ Wheel will use this
app.get("/members", (req, res) => {
  const list = [...members.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(m => ({ id: m.id, display: m.display, name: m.name, username: m.username }));
  res.json({ count: list.length, members: list });
});

// Telegram webhook endpoint
app.post("/telegram/webhook", (req, res) => {
  try {
    const update = req.body;

    // 1) user joined (common)
    if (update?.message?.new_chat_members?.length) {
      update.message.new_chat_members.forEach(upsertMember);
    }

    // 2) chat_member update (sometimes)
    if (update?.chat_member?.new_chat_member?.status === "member") {
      upsertMember(update.chat_member?.from);
    }

    // 3) if any message, capture sender too (optional)
    if (update?.message?.from) {
      upsertMember(update.message.from);
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: true });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

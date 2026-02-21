/**
 * Lucky77 Wheel Bot (Render)
 * - Telegram bot polls updates
 * - When a user joins the group (new_chat_members), store userId + name
 * - Expose GET /participants for CodePen (protected by X-API-KEY)
 * - Basic hardening: CORS allow origin, simple rate limit, API key gate
 *
 * ENV (Render Dashboard -> Environment):
 *   BOT_TOKEN       (required)  : Telegram bot token
 *   API_KEY         (recommended): secret key for /participants (X-API-KEY header)
 *   ALLOW_ORIGIN    (recommended): your CodePen origin or '*' (less safe)
 *   RATE_LIMIT_MAX  (optional)  : default 60 requests/min per IP
 */

import express from "express";
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));

// ===== ENV =====
const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = process.env.API_KEY || ""; // protect /participants
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const RATE_LIMIT_WINDOW_MS = 60_000;

// ===== Validate =====
if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN in Render Environment Variables");
  process.exit(1);
}

// ===== CORS =====
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-KEY");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ===== Simple Rate Limit =====
const rateMap = new Map(); // ip -> {count, resetAt}
app.use((req, res, next) => {
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";

  const now = Date.now();
  const entry = rateMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ ok: false, error: "Too many requests" });
  }
  next();
});

// ===== API Key Guard =====
function requireKey(req, res, next) {
  // If API_KEY not set, allow (not recommended)
  if (!API_KEY) return next();

  const key = req.header("X-API-KEY");
  if (key !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// ===== Storage (JSON) =====
const DATA_FILE = "./participants.json";
let participants = new Map(); // userId(str) -> participant object

function loadParticipants() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        participants = new Map(arr.map((p) => [String(p.userId), p]));
      }
      console.log(`✅ Loaded participants: ${participants.size}`);
    } else {
      console.log("ℹ️ participants.json not found (fresh start)");
    }
  } catch (e) {
    console.error("❌ loadParticipants error:", e?.message || e);
  }
}

function saveParticipants() {
  try {
    const arr = Array.from(participants.values());
    fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2), "utf8");
  } catch (e) {
    console.error("❌ saveParticipants error:", e?.message || e);
  }
}

loadParticipants();

// ===== Telegram Bot =====
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function getDisplayName(u) {
  const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  if (full) return full;
  if (u.username) return @${u.username};
  return user_${u.id};
}

// Register on group join
bot.on("message", async (msg) => {
  try {
    if (msg.new_chat_members?.length) {
      const groupChatId = msg.chat.id;

      let added = 0;
      for (const u of msg.new_chat_members) {
        if (u.is_bot) continue;

        const p = {
          userId: u.id,
          name: getDisplayName(u),
          username: u.username || "",
          groupChatId,
          joinedAt: new Date().toISOString(),
        };

        participants.set(String(u.id), p);
        added += 1;
      }

      saveParticipants();

      // optional group notify
      if (added > 0) {
        await bot.sendMessage(
          groupChatId,
          ✅ Registered ${added} member(s) for Spin.\nTotal: ${participants.size}
        );
      }
      return;
    }

    // small test
    if (msg.text?.toLowerCase() === "hello") {
      await bot.sendMessage(msg.chat.id, "Hello 👋 Lucky77 Bot is running!");
    }
  } catch (e) {
    console.error("❌ bot message handler error:", e?.message || e);
  }
});

bot.on("polling_error", (err) => {
  console.error("❌ polling_error:", err?.message || err);
});

// ===== Express Routes =====
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "lucky77-wheel-bot",
    participants: participants.size,
  });
});

// CodePen reads this (protected by X-API-KEY if set)
app.get("/participants", requireKey, (req, res) => {
  const list = Array.from(participants.values()).map((p) => ({
    userId: p.userId,     // keep for now; if you don't want raw id, tell me and I'll hide it
    name: p.name,
    username: p.username,
  }));

  res.json({ ok: true, count: list.length, participants: list });
});

// Admin: clear (protected)
app.post("/admin/clear", requireKey, (req, res) => {
  participants.clear();
  saveParticipants();
  res.json({ ok: true, cleared: true });
});

app.get("/health", (req, res) => res.send("OK"));

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

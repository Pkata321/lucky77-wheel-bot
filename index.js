'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

// ====== ENV ======
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID).trim() : null;

// ====== Storage file (persist participants) ======
const DATA_FILE = path.join(__dirname, 'participants.json');

// In-memory participants
let participants = [];

// ---------- Helpers ----------
function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function normalizeName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniquePush(arr, items) {
  const set = new Set(arr.map((x) => x.toLowerCase()));
  let addedCount = 0;

  for (const it of items) {
    const n = normalizeName(it);
    if (!n) continue;
    const key = n.toLowerCase();
    if (!set.has(key)) {
      arr.push(n);
      set.add(key);
      addedCount++;
    }
  }
  return addedCount;
}

function pickRandom(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const idx = Math.floor(Math.random() * list.length);
  return list[idx];
}

function loadParticipants() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      participants = [];
      return;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = safeJsonParse(raw, []);
    participants = Array.isArray(data) ? data.map(normalizeName).filter(Boolean) : [];
  } catch (err) {
    console.error('Failed to load participants.json:', err);
    participants = [];
  }
}

function saveParticipants() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(participants, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Failed to save participants.json:', err);
    return false;
  }
}

// Load at startup
loadParticipants();

// ====== API Routes ======
app.get('/', (req, res) => {
  res.json({
    ok: true,
    participants: participants.length
  });
});

app.get('/participants', (req, res) => {
  res.json({
    ok: true,
    total: participants.length,
    participants
  });
});

// Add participants
app.post('/participants', (req, res) => {
  // body: { name: "Aung" } OR { names: ["Aung","Kyaw"] }
  const body = req.body || {};
  const name = body.name;
  const names = body.names;

  let toAdd = [];

  if (typeof name === 'string') toAdd.push(name);
  if (Array.isArray(names)) toAdd = toAdd.concat(names);

  if (toAdd.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'Send { "name": "..." } or { "names": ["a","b"] }'
    });
  }

  const before = participants.length;
  const added = uniquePush(participants, toAdd);
  const saved = saveParticipants();

  return res.json({
    ok: true,
    added,
    before,
    total: participants.length,
    saved
  });
});

// Pick random
app.post('/pick', (req, res) => {
  const chosen = pickRandom(participants);
  if (!chosen) {
    return res.status(400).json({ ok: false, error: 'No participants yet.' });
  }
  return res.json({ ok: true, chosen, total: participants.length });
});

// Remove one
app.post('/remove', (req, res) => {
  const name = normalizeName(req.body && req.body.name);
  if (!name) {
    return res.status(400).json({ ok: false, error: 'Send { "name": "..." }' });
  }

  const before = participants.length;
  participants = participants.filter((p) => p.toLowerCase() !== name.toLowerCase());
  const removed = before - participants.length;
  const saved = saveParticipants();

  return res.json({ ok: true, removed, total: participants.length, saved });
});

// Clear
app.post('/clear', (req, res) => {
  participants = [];
  const saved = saveParticipants();
  return res.json({ ok: true, total: participants.length, saved });
});

// ====== Telegram Bot ======
let bot = null;

function isAdmin(chatUserId) {
  if (!ADMIN_ID) return true; // if not set, allow everyone
  return String(chatUserId) === String(ADMIN_ID);
}

function formatList() {
  if (participants.length === 0) return '📭 စာရင်းမရှိသေးပါ';
  return participants.map((p, i) => `${i + 1}. ${p}`).join('\n');
}

function parseCommaList(text) {
  return String(text || '')
    .split(',')
    .map((x) => normalizeName(x))
    .filter(Boolean);
}

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing. Set it in Render Environment Variables.');
} else {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.onText(/^\/start$/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      [
        '✅ Lucky77 Wheel Bot Ready!',
        '',
        'Commands:',
        '/add Name',
        '/addmany Name1, Name2, Name3',
        '/list',
        '/pick',
        '/remove Name',
        '/clear (admin only if ADMIN_ID set)'
      ].join('\n')
    );
  });

  bot.onText(/^\/list$/, (msg) => {
    bot.sendMessage(msg.chat.id, `👥 Participants (${participants.length})\n\n${formatList()}`);
  });

  bot.onText(/^\/add\s+(.+)$/i, (msg, match) => {
    const name = normalizeName(match[1]);
    if (!name) return bot.sendMessage(msg.chat.id, '❌ Name မမှန်ပါ');

    const added = uniquePush(participants, [name]);
    saveParticipants();

    if (added) {
      bot.sendMessage(msg.chat.id, `✅ Added: ${name}\nTotal: ${participants.length}`);
    } else {
      bot.sendMessage(msg.chat.id, `ℹ️ Already exists: ${name}\nTotal: ${participants.length}`);
    }
  });

  bot.onText(/^\/addmany\s+(.+)$/i, (msg, match) => {
    const list = parseCommaList(match[1]);
    if (list.length === 0) return bot.sendMessage(msg.chat.id, '❌ Name list မမှန်ပါ (comma ဖြင့်ခွဲရေး)');

    const added = uniquePush(participants, list);
    saveParticipants();

    bot.sendMessage(
      msg.chat.id,
      ✅ Added ${added} people\nTotal: ${participants.length}
    );
  });

  bot.onText(/^\/pick$/i, (msg) => {
    const chosen = pickRandom(participants);
    if (!chosen) return bot.sendMessage(msg.chat.id, '📭 စာရင်းမရှိသေးပါ။ /add နဲ့ထည့်ပါ');

    bot.sendMessage(msg.chat.id, `🎉 Winner: ${chosen}\nTotal: ${participants.length}`);
  });

  bot.onText(/^\/remove\s+(.+)$/i, (msg, match) => {
    const name = normalizeName(match[1]);
    if (!name) return bot.sendMessage(msg.chat.id, '❌ Name မမှန်ပါ');

    const before = participants.length;
    participants = participants.filter((p) => p.toLowerCase() !== name.toLowerCase());
    const removed = before - participants.length;
    saveParticipants();

    if (removed) bot.sendMessage(msg.chat.id, `✅ Removed: ${name}\nTotal: ${participants.length}`);
    else bot.sendMessage(msg.chat.id, `ℹ️ Not found: ${name}\nTotal: ${participants.length}`);
  });

  bot.onText(/^\/clear$/i, (msg) => {
    if (!isAdmin(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, '⛔ Admin only (set ADMIN_ID in Render ENV).');
    }
    participants = [];
    saveParticipants();
    bot.sendMessage(msg.chat.id, '🧹 Cleared all participants.');
  });

  bot.on('polling_error', (err) => {
    console.error('Telegram polling error:', err && err.message ? err.message : err);
  });

  console.log('✅ Telegram bot polling started');
}

// ====== Start server ======
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// ====== Graceful shutdown (Render restarts) ======
process.on('SIGTERM', () => {
  try {
    saveParticipants();
  } catch (_) {}
  process.exit(0);
});

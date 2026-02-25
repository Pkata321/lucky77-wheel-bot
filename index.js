/**
 * Lucky77 Lucky Wheel - Ver 1.0 Pro
 * - No GROUP_ID gating (fix group id mismatch / supergroup migration issues)
 * - Join => Register button (auto delete in 60s)
 * - Register => save member to Redis immediately, lock button to ✅
Registered
 * - Register message deletes after 60s whether pressed or not
 * - "ID-only" = no username => show Start Bot Register (auto delete 60s)
 * - CodePen API: members, pool, prizes config, spin, restart, history,
notice(DM)
 */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const { Redis } = require("@upstash/redis");
// ===================== ENV =====================
const {BOT_TOKEN,
UPSTASH_REDIS_REST_URL,
UPSTASH_REDIS_REST_TOKEN,
OWNER_ID,
API_KEY, // optional
AUTO_DELETE_SECONDS // optional (default 60)
} = process.env;
function must(v, name) {
if (!v) {
console.error(`${name} missing`);
process.exit(1);
}
}
must(BOT_TOKEN, "BOT_TOKEN");
must(UPSTASH_REDIS_REST_URL, "UPSTASH_REDIS_REST_URL");
must(UPSTASH_REDIS_REST_TOKEN, "UPSTASH_REDIS_REST_TOKEN");
must(OWNER_ID, "OWNER_ID");
const AUTO_DELETE_MS = Math.max(0, Number(AUTO_DELETE_SECONDS || 60)) * 1000;
// ===================== REDIS =====================
const redis = new Redis({
url: UPSTASH_REDIS_REST_URL,
token: UPSTASH_REDIS_REST_TOKEN
});
const KEY_PREFIX = "lucky77:ver1pro";
const KEY_GROUPS = `${KEY_PREFIX}:groups:set`;
const KEY_MEMBERS = `${KEY_PREFIX}:members:set`;
const KEY_POOL = `${KEY_PREFIX}:pool:set`;
const KEY_WINNERS = `${KEY_PREFIX}:winners:set`;
const KEY_MEMBER = (id) => `${KEY_PREFIX}:member:${id}`;
const KEY_HISTORY = `${KEY_PREFIX}:history:list`;
const KEY_PRIZES_JSON = `${KEY_PREFIX}:prizes:json`;
const KEY_PRIZE_REMAIN = `${KEY_PREFIX}:prizes:remain`;
// ===================== BOT =====================
// We explicitly request chat_member updates as a fallback join detector.
// Telegram notes: chat_member updates are not included by default unless
explicitly allowed. (see allowed_updates)
const bot = new TelegramBot(BOT_TOKEN, {
polling: {
params: {
allowed_updates: ["message", "callback_query", "chat_member",
"my_chat_member"]
}
}
});
let BOT_USERNAME = null;
let BOT_ID = null;
(async () => {
try {
const me = await bot.getMe();
BOT_USERNAME = me.username || null;
BOT_ID = String(me.id);
console.log("Bot Ready:", { BOT_USERNAME, BOT_ID });
} catch (e) {
console.error("getMe error:", e);
}
})();
bot.on("polling_error", (e) => console.error("polling_error:", e?.message ||
e));
// ===================== HELPERS =====================
function isOwner(id) {
return String(id) === String(OWNER_ID);
}
function isBot(id) {
return BOT_ID && String(id) === String(BOT_ID);
}
function nameParts(u) {
const name = `${u.first_name || ""} ${u.last_name || ""}`.trim();
const username = (u.username || "").trim(); // without @
return { name, username };
}
function display(uOrHash) {
const name = String(uOrHash?.name || "").trim();
const username = String(uOrHash?.username || "").trim();
const id = String(uOrHash?.id || uOrHash?.user_id || "");
if (name) return name;
if (username) return username.startsWith("@") ? username : `@${username}`;
return id;
}
async function safeSendMessage(chatId, text, opts = {}) {
try {
return await bot.sendMessage(chatId, text, opts);
} catch (e) {
console.error("sendMessage failed:", e?.response?.body || e?.message ||
e);return null;
}
}
function scheduleDelete(chatId, messageId) {
if (!AUTO_DELETE_MS) return;
setTimeout(() => {
bot.deleteMessage(chatId, messageId).catch(() => {});
}, AUTO_DELETE_MS);
}
async function markGroupSeen(chat) {
try {
if (!chat) return;
if (chat.type !== "group" && chat.type !== "supergroup") return;
await redis.sadd(KEY_GROUPS, String(chat.id));
} catch {}
}
async function isRegistered(userId) {
return !!(await redis.sismember(KEY_MEMBERS, String(userId)));
}
async function saveMember(user, source = "register") {
const uid = String(user.id);
if (isOwner(uid) || isBot(uid)) return;
const { name, username } = nameParts(user);
await redis.sadd(KEY_MEMBERS, uid);
await redis.sadd(KEY_POOL, uid);
const existing = await redis.hgetall(KEY_MEMBER(uid));
const dmReady = existing?.dm_ready === "1" ? "1" : "0";
await redis.hset(KEY_MEMBER(uid), {
id: uid,
name,
username,
dm_ready: dmReady,
source,
registered_at: existing?.registered_at || new Date().toISOString(),
updated_at: new Date().toISOString()
});
}
async function setDmReady(user) {
const uid = String(user.id);
await saveMember(user, "private_start");
await redis.hset(KEY_MEMBER(uid), {
dm_ready: "1",dm_ready_at: new Date().toISOString()
});
}
// ===================== REGISTER PROMPT =====================
async function sendRegisterPrompt(chatId, user) {
if (!user) return;
if (isOwner(user.id) || isBot(user.id)) return;
const already = await isRegistered(user.id);
const text =
`🎡 Lucky77 Lucky Wheel\n\n` +
`မင်္ဂလာပါ ${display({ id: user.id, ...nameParts(user) })} 👋\n\n` +
(already
? `✅ မင်းက Register လုပ်Çပီးသားပါ။`
: `Event ထဲဝင်ဖို့ Ŵအောက်က Register ကိုနှိပ်ပါ။`) +
`\n\n⏳ 1 minute အေတွင်း message auto-delete /ဖစ်ပါမယ်။`;
const keyboard = {
inline_keyboard: [
[
already
? { text: "✅ Registered", callback_data: "done" }
: { text: "✅ Register", callback_data: `reg:${user.id}` }
]
]
};
const msg = await safeSendMessage(chatId, text, { reply_markup:
keyboard });
if (msg?.message_id) scheduleDelete(chatId, msg.message_id);
}
// ===================== TELEGRAM UPDATES =====================
// Primary join detector: service message with new_chat_members
bot.on("message", async (msg) => {
try {
if (!msg?.chat) return;
await markGroupSeen(msg.chat);
if ((msg.chat.type === "group" || msg.chat.type === "supergroup") &&
Array.isArray(msg.new_chat_members)) {
for (const m of msg.new_chat_members) {
await sendRegisterPrompt(msg.chat.id, m);
}
}
// Optional human testing command: /register
   if ((msg.text || "").trim().toLowerCase().startsWith("/register")) {
if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
if (msg.from) await sendRegisterPrompt(msg.chat.id, msg.from);
}
}
} catch (e) {
console.error("message handler error:", e);
}
});
// Fallback join detector: chat_member update (needs allowed_updates + bot
admin)
bot.on("chat_member", async (upd) => {
try {
const chat = upd?.chat;
const newCm = upd?.new_chat_member;
const oldCm = upd?.old_chat_member;
if (!chat || !newCm?.user) return;
await markGroupSeen(chat);
if (chat.type !== "group" && chat.type !== "supergroup") return;
const oldStatus = oldCm?.status;
const newStatus = newCm?.status;
// Typical join transition: left -> member
if (oldStatus === "left" && (newStatus === "member" || newStatus ===
"restricted")) {
const user = newCm.user;
if (!user?.is_bot) {
await sendRegisterPrompt(chat.id, user);
}
}
} catch (e) {
console.error("chat_member handler error:", e);
}
});
// Callback query: must answer quickly
bot.on("callback_query", async (cq) => {
try {
const data = cq?.data || "";
const from = cq?.from;
if (!from) return;
// Registered pressed again => popup alert
if (data === "done") {
await bot.answerCallbackQuery(cq.id, {
text: "✅ Registered လုပ်ထားÇပီးသားပါ။",
show_alert: true
});
return;
}
if (!data.startsWith("reg:")) return;
const targetId = String(data.split(":")[1] || "");
if (targetId !== String(from.id)) {
await bot.answerCallbackQuery(cq.id, {
text: "ဒီခလုတ်က မင်းအေတွက်ပဲ",
show_alert: true
});
return;
}
if (isOwner(from.id) || isBot(from.id)) {
await bot.answerCallbackQuery(cq.id, {
text: "Owner/Bot ကို Register မလုပ်ပါ။",
show_alert: true
});
return;
}
const already = await isRegistered(from.id);
if (already) {
await bot.answerCallbackQuery(cq.id, {
text: "✅ Registered လုပ်ထားÇပီးသားပါ။",
show_alert: true
});
return;
}
await saveMember(from, "group_register_button");
const { name, username } = nameParts(from);
// Popup confirmation
await bot.answerCallbackQuery(cq.id, {
text: `${display({ id: from.id, name, username })} Registered လုပ်ÇပီးပါÇပီ 🎉
`,
show_alert: true
});
// Lock button to Registered
if (cq.message) {
bot.editMessageReplyMarkup(
{ inline_keyboard: [[{ text: "✅ Registered", callback_data:
"done" }]] },
{ chat_id: cq.message.chat.id, message_id: cq.message.message_id }
   ).catch(() => {});
}
// "ID-only" policy: no username => show Start Bot Register to enable DM
if (!username && cq.message?.chat) {
if (BOT_USERNAME) {
const startUrl = `https://t.me/${BOT_USERNAME}?start=enable`;
const longMsg =
`⚠ Winner /ဖစ်ရင် ဆက်သွယ်နိုင်ဖို့ DM Service Enable လုပ်ရန်လိုပါသည်။
📌 ညီမတို့ ရဲ့ Lucky77 ဟာ American နိုင်ငံŴထာက်ခံချက်ရ ိမ်းဆိုဒ်Èကီး/ဖစ်တာမို့
ယံုÆကည်စိတ်ချစွာကစားနိုင်ပါတယ်ရှင့်။
ဆုမဲကံထူးမှုÈကီးကို လက်မလွှတ်ရŴအောင် Ŵအောက်က Start Bot ကိုနှိပ်ပါရှင့်။`;
const sent = await safeSendMessage(cq.message.chat.id, longMsg, {
reply_markup: {
inline_keyboard: [[{ text: "▶ Start Bot Register", url:
startUrl }]]
}
});
if (sent?.message_id) scheduleDelete(cq.message.chat.id,
sent.message_id);
}
}
} catch (e) {
console.error("callback_query error:", e);
}
});
// Private /start => DM enable
bot.onText(/\/start/i, async (msg) => {
try {
if (msg?.chat?.type !== "private") return;
if (!msg.from) return;
await setDmReady(msg.from);
await safeSendMessage(
msg.chat.id,
"🎉 Lucky77 Register Ŵအောင်/မင်ပါÇပီ။\n\n📩 Prize Ŵပါက်ရင် ဒီŴနရာကŴန
ဆက်သွယ်Ŵပးပါမယ်။"
);
} catch (e) {
console.error("/start error:", e);
}
});
// ===================== PRIZE LOGIC =====================
function normalisePrizeArray(prizes) {const arr = Array.isArray(prizes) ? prizes : [];
const out = [];
for (const p of arr) {
const label = String(p?.label || p?.name || "").trim();
const count = Number(p?.count);
if (!label) continue;
const safeCount = Number.isFinite(count) ? Math.max(0, Math.min(9999,
Math.floor(count))) : 0;
out.push({ label, count: safeCount });
}
// merge duplicates by label (case-sensitive)
const merged = new Map();
for (const item of out) {
merged.set(item.label, (merged.get(item.label) || 0) + item.count);
}
return Array.from(merged.entries()).map(([label, count]) => ({
label,
count: Math.max(0, Math.min(9999, count))
}));
}
async function setPrizeConfig(prizes) {
const norm = normalisePrizeArray(prizes);
await redis.set(KEY_PRIZES_JSON, JSON.stringify(norm));
// reset remaining counts
await redis.del(KEY_PRIZE_REMAIN);
const map = {};
for (const p of norm) map[p.label] = String(p.count);
if (Object.keys(map).length) {
await redis.hset(KEY_PRIZE_REMAIN, map);
}
const total = norm.reduce((a, b) => a + (b.count || 0), 0);
return { total, prizes: norm };
}
async function sumPrizeRemaining() {
const all = await redis.hgetall(KEY_PRIZE_REMAIN);
const v = all || {};
let sum = 0;
for (const k of Object.keys(v)) {
const n = parseInt(String(v[k]), 10);
if (Number.isFinite(n) && n > 0) sum += n;
}
return sum;
}
async function pickPrize() {
const all = await redis.hgetall(KEY_PRIZE_REMAIN);
const v = all || {};
const items = [];
let total = 0;
for (const label of Object.keys(v)) {
const n = parseInt(String(v[label]), 10);
if (Number.isFinite(n) && n > 0) {
items.push([label, n]);
total += n;
}
}
if (total <= 0) return null;
let r = Math.floor(Math.random() * total) + 1; // 1..total
for (const [label, n] of items) {
r -= n;
if (r <= 0) {
await redis.hincrby(KEY_PRIZE_REMAIN, label, -1);
return label;
}
}
return null;
}
async function pushHistory(item) {
await redis.lpush(KEY_HISTORY, JSON.stringify(item));
await redis.ltrim(KEY_HISTORY, 0, 200);
}
// ===================== EXPRESS API =====================
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
function requireApiKey(req, res, next) {
if (!API_KEY) return next();
const k = req.query.key || req.headers["x-api-key"];
if (!k || String(k) !== String(API_KEY)) {
return res.status(401).json({ ok: false, error: "Unauthorized" });
}
next();
}
app.get("/", (req, res) => {res.status(200).send(
"Lucky77 Ver 1.0 Pro is running ✅\n\n" +
"GET /health\n" +
"GET /api/pool\n" +
"GET /api/members\n" +
"GET /api/history\n" +
"POST /api/config/prizes\n" +
"POST /api/restart-spin\n" +
"POST /api/spin\n" +
"POST /api/notice\n"
);
});
app.get("/health", async (req, res) => {
try {
const groups = await redis.smembers(KEY_GROUPS);
const members = await redis.scard(KEY_MEMBERS);
res.json({
ok: true,
bot_username: BOT_USERNAME || null,
groups_seen: (groups || []).length,
members: Number(members) || 0,
api_key_required: !!API_KEY,
auto_delete_seconds: AUTO_DELETE_MS ? AUTO_DELETE_MS / 1000 : 0
});
} catch (e) {
res.status(500).json({ ok: false, error: String(e) });
}
});
app.get("/api/pool", requireApiKey, async (req, res) => {
try {
const membersTotal = await redis.scard(KEY_MEMBERS);
const membersLeft = await redis.scard(KEY_POOL);
const prizesLeft = await sumPrizeRemaining();
res.json({
ok: true,
members_total: Number(membersTotal) || 0,
members_left: Number(membersLeft) || 0,
prizes_left: prizesLeft
});
} catch (e) {
res.status(500).json({ ok: false, error: String(e) });
}
});
app.get("/api/members", requireApiKey, async (req, res) => {
try {
const ids = await redis.smembers(KEY_MEMBERS);
   const winners = await redis.smembers(KEY_WINNERS);
const winnerSet = new Set((winners || []).map(String));
const list = [];
for (const id of ids || []) {
if (isOwner(id) || isBot(id)) continue;
const h = await redis.hgetall(KEY_MEMBER(id));
const name = String(h?.name || "").trim();
const username = String(h?.username || "").trim();
list.push({
id: String(id),
name,
username, // no @
display: name ? name : username ? `@${username.replace("@", "")}` :
String(id),
dm_ready: String(h?.dm_ready || "0") === "1",
isWinner: winnerSet.has(String(id)),
registered_at: h?.registered_at || ""
});
}
list.sort((a, b) =>
String(a.registered_at).localeCompare(String(b.registered_at)));
res.json({ ok: true, total: list.length, members: list });
} catch (e) {
res.status(500).json({ ok: false, error: String(e) });
}
});
app.get("/api/history", requireApiKey, async (req, res) => {
try {
const raw = await redis.lrange(KEY_HISTORY, 0, 200);
const history = (raw || []).map((s) => {
try {
return JSON.parse(s);
} catch {
return { raw: s };
}
});
res.json({ ok: true, total: history.length, history });
} catch (e) {
res.status(500).json({ ok: false, error: String(e) });
}
});
app.post("/api/config/prizes", requireApiKey, async (req, res) => {
try {
const { prizes } = req.body || {};
   const norm = normalisePrizeArray(prizes);
if (!norm.length) {
return res.status(400).json({ ok: false, error: "prizes array
required" });
}
const result = await setPrizeConfig(norm);
res.json({ ok: true, total_prizes: result.total, prizes:
result.prizes });
} catch (e) {
res.status(500).json({ ok: false, error: String(e) });
}
});
app.post("/api/restart-spin", requireApiKey, async (req, res) => {
try {
const raw = await redis.get(KEY_PRIZES_JSON);
if (!raw) return res.status(400).json({ ok: false, error: "No prize
config yet" });
const prizes = JSON.parse(raw);
await setPrizeConfig(prizes);
// reset winners/history
await redis.del(KEY_WINNERS);
await redis.del(KEY_HISTORY);
// refill pool from members
const ids = await redis.smembers(KEY_MEMBERS);
const eligible = (ids || []).map(String).filter((id) => !isOwner(id) && !
isBot(id));
await redis.del(KEY_POOL);
if (eligible.length) await redis.sadd(KEY_POOL, ...eligible);
res.json({
ok: true,
members_left: eligible.length,
prizes_left: await sumPrizeRemaining()
});
} catch (e) {
res.status(500).json({ ok: false, error: String(e) });
}
});
app.post("/api/spin", requireApiKey, async (req, res) => {
try {
const prize = await pickPrize();
if (!prize) return res.status(400).json({ ok: false, error: "No prizes
left" });
// Pick random member from pool (SRANDMEMBER)
const winnerId = await redis.srandmember(KEY_POOL);
if (!winnerId) return res.status(400).json({ ok: false, error: "No
members left" });
await redis.srem(KEY_POOL, String(winnerId));
await redis.sadd(KEY_WINNERS, String(winnerId));
const h = await redis.hgetall(KEY_MEMBER(winnerId));
const winner = {
id: String(winnerId),
name: String(h?.name || "").trim(),
username: String(h?.username || "").trim(), // no @
dm_ready: String(h?.dm_ready || "0") === "1"
};
winner.display = display({ id: winner.id, name: winner.name, username:
winner.username });
const item = {
prize: String(prize),
winner,
at: new Date().toISOString()
};
await pushHistory(item);
res.json({
ok: true,
prize: item.prize,
winner: item.winner,
prizes_left: await sumPrizeRemaining()
});
} catch (e) {
res.status(500).json({ ok: false, error: String(e) });
}
});
// Optional: DM a user (useful for username-less winners who have DM enabled)
app.post("/api/notice", requireApiKey, async (req, res) => {
try {
const { user_id, text } = req.body || {};
if (!user_id || !text) {
return res.status(400).json({ ok: false, error: "user_id and text
required" });
}
const uid = String(user_id);
const h = await redis.hgetall(KEY_MEMBER(uid));
const dmReady = String(h?.dm_ready || "0") === "1"
   if (!dmReady) {
return res.json({
ok: false,
dm_ok: false,
error: "DM not enabled yet. User must press Start Bot first."
});
}
try {
await bot.sendMessage(Number(uid), String(text));
res.json({ ok: true, dm_ok: true });
} catch (e) {
res.json({
ok: false,
dm_ok: false,
error: e?.response?.body || e?.message || String(e)
});
}
} catch (e) {
res.status(500).json({ ok: false, error: String(e) });
}
});
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on", PORT));
   

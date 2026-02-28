"use strict";

/* ===========================
   HARD DEFAULTS
=========================== */
const DEFAULT_API_BASE = "https://lucky77-wheel-bot.onrender.com";
const DEFAULT_API_KEY = "Lucky77_luckywheel_77";

/* ===========================
   DOM
=========================== */
const wheelCanvas = document.getElementById("wheel");
const ctx = wheelCanvas.getContext("2d");

const spinBtn = document.getElementById("spinBtn");
const poolText = document.getElementById("poolText");

const drawer = document.getElementById("drawer");
const settingsBtn = document.getElementById("settingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const saveBtn = document.getElementById("saveBtn");
const resetBtn = document.getElementById("resetBtn");

const apiBaseInput = document.getElementById("apiBaseInput");
const apiKeyInput = document.getElementById("apiKeyInput");

const prizeBuilder = document.getElementById("prizeBuilder");
const uiColorInput = document.getElementById("uiColorInput");
const wheelAccentInput = document.getElementById("wheelAccentInput");
const wheelColorsInput = document.getElementById("wheelColorsInput");

const topBannerFile = document.getElementById("topBannerFile");
const bottomBannerFile = document.getElementById("bottomBannerFile");
const pageBgFile = document.getElementById("pageBgFile");
const wheelBgFile = document.getElementById("wheelBgFile");
const bgSongFile = document.getElementById("bgSongFile");

const topBannerImg = document.getElementById("topBannerImg");
const bottomBannerImg = document.getElementById("bottomBannerImg");
const topBannerFallback = document.getElementById("topBannerFallback");
const bottomBannerFallback = document.getElementById("bottomBannerFallback");

const bgLayer = document.getElementById("bgLayer");
const wheelWrap = document.getElementById("wheelWrap");

const restartSpinBtn = document.getElementById("restartSpinBtn");
const membersBtn = document.getElementById("membersBtn");
const historyBtn = document.getElementById("historyBtn");

const membersPanel = document.getElementById("membersPanel");
const membersCloseBtn = document.getElementById("membersCloseBtn");
const membersTable = document.getElementById("membersTable");
const membersTotalText = document.getElementById("membersTotalText");

const historyPanel = document.getElementById("historyPanel");
const historyCloseBtn = document.getElementById("historyCloseBtn");
const historyList = document.getElementById("historyList");

const refreshMembersInSettingsBtn = document.getElementById("refreshMembersInSettingsBtn");
const membersInSettings = document.getElementById("membersInSettings");

/* ✅ Winner Modal */
const winnerModal = document.getElementById("winnerModal");
const winnerBackdrop = document.getElementById("winnerBackdrop");
const winnerPrizeTitle = document.getElementById("winnerPrizeTitle");
const winnerTitleText = document.getElementById("winnerTitleText");
const winnerNameText = document.getElementById("winnerNameText");
const contactBtn = document.getElementById("contactBtn");
const noticeBtn = document.getElementById("noticeBtn");
const winnerCloseBtn = document.getElementById("winnerCloseBtn");
const winnerHint = document.getElementById("winnerHint");

/* ===========================
   Loading Overlay (no stuck loading)
=========================== */
let loadingEl = null;
function ensureLoadingEl() {
  if (loadingEl) return loadingEl;
  loadingEl = document.createElement("div");
  loadingEl.id = "loadingOverlay";
  loadingEl.className = "loading hidden";
  loadingEl.innerHTML = `
    <div class="loading-card">
      <div class="spinner"></div>
      <div class="loading-text" id="loadingText">Loading...</div>
      <button class="btn mini" id="loadingCancelBtn" style="margin-top:10px;">Cancel</button>
    </div>
  `;
  document.body.appendChild(loadingEl);
  loadingEl.querySelector("#loadingCancelBtn").addEventListener("click", hideLoading);
  return loadingEl;
}
let activeAbort = null;
function showLoading(text = "Loading...") {
  const el = ensureLoadingEl();
  el.classList.remove("hidden");
  const t = el.querySelector("#loadingText");
  if (t) t.textContent = text;
}
function hideLoading() {
  const el = ensureLoadingEl();
  el.classList.add("hidden");
  if (activeAbort) {
    try { activeAbort.abort(); } catch {}
  }
  activeAbort = null;
}

/* ===========================
   Music
=========================== */
const musicBtn = document.getElementById("musicBtn");
const bgMusic = new Audio();
bgMusic.loop = true;
bgMusic.volume = 0.55;
let musicOn = false;

function updateMusicBtn() {
  musicBtn.textContent = musicOn ? "🎵 Music: ON" : "🎵 Music: OFF";
  musicBtn.classList.toggle("primary", musicOn);
}
musicBtn.addEventListener("click", async () => {
  musicOn = !musicOn;
  if (musicOn) {
    if (bgMusic.src) {
      try { await bgMusic.play(); } catch {}
    } else {
      alert("Settings ထဲမှာ MP3 Upload လုပ်ပါ");
      musicOn = false;
    }
  } else {
    bgMusic.pause();
  }
  updateMusicBtn();
});

// tick sound (WebAudio)
let audioCtx = null;
function tickSound(freq = 900, dur = 0.02, gain = 0.06) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "square";
    o.frequency.value = freq;
    g.gain.value = gain;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch {}
}
function winChime() {
  tickSound(880, 0.05, 0.08);
  setTimeout(() => tickSound(1320, 0.06, 0.08), 80);
  setTimeout(() => tickSound(1760, 0.08, 0.08), 180);
}

/* ===========================
   Storage
=========================== */
const STORAGE_KEY = "lucky77_vercel_v2";
const CACHE_MEMBERS_KEY = "lucky77_cache_members";
const CACHE_HISTORY_KEY = "lucky77_cache_history";

const defaultSettings = {
  apiBase: DEFAULT_API_BASE,
  apiKey: DEFAULT_API_KEY,

  uiColor: "#ffffff",
  wheelAccent: "#d6b25e",
  wheelColorsText: "#ffffff\n#f1f5ff\n#fff4d6\n#e9eefc",

  prizes: [
    { name: "10000Ks", times: 4 },
    { name: "5000Ks", times: 2 },
    { name: "3000Ks", times: 3 },
    { name: "2000Ks", times: 5 },
    { name: "1000Ks", times: 10 },
  ],

  pageBgDataUrl: "",
  wheelBgDataUrl: "",
  topBannerDataUrl: "",
  bottomBannerDataUrl: "",
};

function clone(x) {
  try { return structuredClone(x); } catch { return JSON.parse(JSON.stringify(x)); }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return clone(defaultSettings);
    const data = JSON.parse(raw);
    return { ...clone(defaultSettings), ...data };
  } catch {
    return clone(defaultSettings);
  }
}
function saveSettingsLocal(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function saveCache(key, value) {
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), value })); } catch {}
}
function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj?.value ?? null;
  } catch {
    return null;
  }
}
function clearCache() {
  try { localStorage.removeItem(CACHE_MEMBERS_KEY); } catch {}
  try { localStorage.removeItem(CACHE_HISTORY_KEY); } catch {}
}

/* ===========================
   Theme Apply
=========================== */
function applyThemeUI(uiColor, wheelAccent) {
  document.documentElement.style.setProperty("--ui", uiColor);
  document.documentElement.style.setProperty("--bg", uiColor);
  document.documentElement.style.setProperty("--gold", wheelAccent);
  document.documentElement.style.setProperty("--text", "#101318");
}

/* ===========================
   Images
=========================== */
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function applyBanner(dataUrl, imgEl, fallbackEl) {
  if (dataUrl) {
    imgEl.src = dataUrl;
    imgEl.style.display = "block";
    fallbackEl.style.display = "none";
  } else {
    imgEl.style.display = "none";
    fallbackEl.style.display = "block";
  }
}

function applyPageBg(dataUrl) {
  if (dataUrl) {
    bgLayer.classList.add("has-img");
    bgLayer.style.backgroundImage = `url("${dataUrl}")`;
  } else {
    bgLayer.classList.remove("has-img");
    bgLayer.style.backgroundImage = "";
  }
}

function applyWheelBg(dataUrl) {
  if (dataUrl) {
    wheelWrap.classList.add("has-img");
    wheelWrap.style.backgroundImage = `url("${dataUrl}")`;
  } else {
    wheelWrap.classList.remove("has-img");
    wheelWrap.style.backgroundImage = "";
  }
}

/* ===========================
   Drawer
=========================== */
function openSettings() { drawer.classList.add("open"); }
function closeSettings() { drawer.classList.remove("open"); }
settingsBtn.addEventListener("click", openSettings);
closeSettingsBtn.addEventListener("click", closeSettings);

/* ===========================
   API Helpers (timeout + no stuck loading)
=========================== */
function getApiBase() {
  const s = loadSettings();
  return (s.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
}
function getApiKey() {
  const s = loadSettings();
  return s.apiKey || DEFAULT_API_KEY;
}

async function fetchJsonWithTimeout(url, opt = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  activeAbort = ctrl;
  const id = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(url, { ...opt, signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); }
    catch { json = { ok: false, error: "Invalid JSON", raw: String(text || "").slice(0, 250) }; }

    if (!r.ok && json && json.ok !== true) {
      return { ok: false, error: json?.error || `HTTP ${r.status}` };
    }
    return json;
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "Timeout/Cancelled" : (e?.message || String(e)) };
  } finally {
    clearTimeout(id);
    activeAbort = null;
  }
}

async function apiGet(path, timeoutMs = 9000) {
  const base = getApiBase();
  const key = getApiKey();
  const url = `${base}${path}?key=${encodeURIComponent(key)}`;
  return fetchJsonWithTimeout(url, {}, timeoutMs);
}

async function apiPost(path, body, timeoutMs = 12000) {
  const base = getApiBase();
  const key = getApiKey();
  const url = `${base}${path}?key=${encodeURIComponent(key)}`;
  return fetchJsonWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify(body || {}),
    },
    timeoutMs
  );
}

/* ===========================
   Prize Builder (Stepper) + Add/Remove Prize
=========================== */
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function buildPrizeText(prizesArr) {
  return prizesArr
    .filter((p) => p && String(p.name || "").trim())
    .map((p) => `${String(p.name).trim()} ${clamp(Number(p.times || 1), 1, 9999)}time`)
    .join("\n");
}

function renderPrizeBuilder(prizesArr) {
  prizeBuilder.innerHTML = "";

  prizesArr.forEach((p, idx) => {
    const row = document.createElement("div");
    row.className = "prize-row";

    const left = document.createElement("div");
    left.innerHTML = `
      <div class="pname">Prize</div>
      <input data-k="name" data-i="${idx}" value="${esc(p.name || "")}" placeholder="10000Ks">
    `;

    const right = document.createElement("div");
    right.className = "stepper";
    right.innerHTML = `
      <button data-act="dec" data-i="${idx}" title="-1">-</button>
      <input data-k="times" data-i="${idx}" type="number" min="1" max="9999" value="${clamp(Number(p.times || 1), 1, 9999)}">
      <button data-act="inc" data-i="${idx}" title="+1">+</button>
      <button class="btn mini danger" data-act="remove" data-i="${idx}" title="Remove Prize">Remove</button>
    `;

    row.appendChild(left);
    row.appendChild(right);
    prizeBuilder.appendChild(row);
  });

  const addBtn = document.createElement("button");
  addBtn.className = "btn";
  addBtn.textContent = "+ Add Prize";
  addBtn.addEventListener("click", () => {
    const s = loadSettings();
    s.prizes.push({ name: "", times: 1 });
    saveSettingsLocal(s);
    renderPrizeBuilder(s.prizes);
  });
  prizeBuilder.appendChild(addBtn);

  prizeBuilder.querySelectorAll("button[data-act]").forEach((b) => {
    b.addEventListener("click", () => {
      const i = Number(b.dataset.i);
      const act = b.dataset.act;
      const s = loadSettings();
      if (!s.prizes[i]) return;

      if (act === "remove") {
        s.prizes.splice(i, 1);
        if (s.prizes.length === 0) s.prizes.push({ name: "", times: 1 });
        saveSettingsLocal(s);
        renderPrizeBuilder(s.prizes);
        return;
      }

      const cur = clamp(Number(s.prizes[i]?.times || 1), 1, 9999);
      s.prizes[i].times = clamp(cur + (act === "inc" ? 1 : -1), 1, 9999);
      saveSettingsLocal(s);
      renderPrizeBuilder(s.prizes);
    });
  });

  prizeBuilder.querySelectorAll("input[data-k]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const i = Number(inp.dataset.i);
      const k = String(inp.dataset.k);
      const s = loadSettings();
      if (!s.prizes[i]) return;

      if (k === "times") s.prizes[i].times = clamp(Number(inp.value || 1), 1, 9999);
      if (k === "name") s.prizes[i].name = String(inp.value || "");
      saveSettingsLocal(s);
    });
  });
}

/* ===========================
   Wheel drawing (UNIQUE prizes only)
=========================== */
let wheelPrizes = [];
let sliceColors = [];
let currentAngle = 0;
let spinning = false;

function parseWheelColors(text) {
  const colors = String(text || "").split("\n").map((x) => x.trim()).filter(Boolean);
  return colors.length ? colors : ["#ffffff", "#f1f5ff"];
}

function uniquePrizesFromPrizeText(prizeText) {
  const lines = String(prizeText || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const set = new Set();
  for (const line of lines) {
    let m = line.match(/^(.+?)\s+(\d+)\s*time$/i);
    if (!m) m = line.match(/^(.+?)\s+(\d+)$/i);
    if (!m) continue;
    const prize = m[1].trim();
    if (!prize) continue;
    set.add(prize);
  }
  return Array.from(set);
}

function drawWheel() {
  const cx = wheelCanvas.width / 2;
  const cy = wheelCanvas.height / 2;
  const radius = Math.min(cx, cy) - 12;

  ctx.clearRect(0, 0, wheelCanvas.width, wheelCanvas.height);

  if (wheelPrizes.length < 2) {
    ctx.fillStyle = "#101318";
    ctx.font = "bold 18px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Add Prize List in Settings", cx, cy);
    return;
  }

  const slice = (Math.PI * 2) / wheelPrizes.length;

  ctx.beginPath();
  ctx.arc(cx, cy, radius + 2, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(214,178,94,0.45)";
  ctx.lineWidth = 10;
  ctx.stroke();

  for (let i = 0; i < wheelPrizes.length; i++) {
    const start = currentAngle + i * slice;
    const end = start + slice;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, end);
    ctx.closePath();

    const c = sliceColors[i % sliceColors.length] || "#fff";
    ctx.fillStyle = c;
    ctx.fill();

    ctx.strokeStyle = "rgba(16,19,24,0.06)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(start + slice / 2);
    ctx.textAlign = "right";
    ctx.fillStyle = "#101318";
    ctx.font = "900 18px sans-serif";
    ctx.fillText(wheelPrizes[i], radius - 18, 6);
    ctx.restore();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, 80, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.fill();
  ctx.strokeStyle = "rgba(214,178,94,0.45)";
  ctx.lineWidth = 5;
  ctx.stroke();
}

/* ===========================
   Winner Modal
=========================== */
let lastWinner = null;

function showWinnerModal(prize, winnerObj) {
  lastWinner = { prize, winner: winnerObj };

  const username = String(winnerObj.username || "").replace("@", "").trim();
  const hasUsername = !!username;

  const name = String(winnerObj.name || "").trim();
  const display = String(
    winnerObj.display ||
    name ||
    (username ? `@${username}` : String(winnerObj.id || "-"))
  );

  winnerPrizeTitle.textContent = "WINNER";
  winnerTitleText.textContent = String(prize || "—");
  winnerNameText.textContent = display;

  contactBtn.style.display = hasUsername ? "inline-flex" : "none";
  noticeBtn.style.display = hasUsername ? "none" : "inline-flex";

  winnerHint.textContent = hasUsername
    ? "✅ Username ရှိလို့ Telegram အကောင့်ကို တန်းဖွင့်နိုင်ပါတယ်"
    : "✅ Username မရှိလို့ Notice နှိပ်ရင် Bot က DM ပို့မယ်";

  winnerModal.classList.remove("hidden");
  winnerModal.setAttribute("aria-hidden", "false");
  winChime();
}

function hideWinnerModal() {
  winnerModal.classList.add("hidden");
  winnerModal.setAttribute("aria-hidden", "true");
  lastWinner = null;
}
winnerCloseBtn.addEventListener("click", hideWinnerModal);
winnerBackdrop.addEventListener("click", hideWinnerModal);

contactBtn.addEventListener("click", () => {
  if (!lastWinner) return;
  const u = String(lastWinner.winner.username || "").replace("@", "").trim();
  if (!u) return;
  window.open(`https://t.me/${u}`, "_blank");
});

noticeBtn.addEventListener("click", async () => {
  if (!lastWinner) return;
  const w = lastWinner.winner;
  const prize = lastWinner.prize;

  const username = String(w.username || "").replace("@", "").trim();
  if (username) {
    window.open(`https://t.me/${username}`, "_blank");
    return;
  }

  showLoading("Sending Notice (DM)...");
  try {
    const r = await apiPost("/notice", { user_id: w.id, prize }, 10000);
    if (!r?.ok) throw new Error(r?.error || "notice failed");
    if (r.dm_ok) alert("✅ DM ပို့ပြီးပါပြီ");
    else alert("⚠️ DM မပို့နိုင်သေးပါ။ User က Bot ကို Start မလုပ်သေးနိုင်ပါတယ်");
  } catch (e) {
    alert("Notice error: " + (e.message || e));
  } finally {
    hideLoading();
  }
});

/* ===========================
   Panels
=========================== */
function showMembersPanel() { membersPanel.classList.remove("hidden"); }
function hideMembersPanel() { membersPanel.classList.add("hidden"); }
membersCloseBtn.addEventListener("click", hideMembersPanel);

function showHistoryPanel() { historyPanel.classList.remove("hidden"); }
function hideHistoryPanel() { historyPanel.classList.add("hidden"); }
historyCloseBtn.addEventListener("click", hideHistoryPanel);

/* ===========================
   Pool UI (no stuck)
=========================== */
async function refreshPoolUI() {
  try {
    const data = await apiGet("/pool", 7000);
    if (!data?.ok) throw new Error(data?.error || "pool error");
    poolText.textContent = `${data.count || 0} people in pool`;
  } catch {
    poolText.textContent = "Pool: error";
  }
}

/* ===========================
   Members UI (show cache first)
=========================== */
function contactButtonHTML(m) {
  const username = m.username ? String(m.username).replace("@", "").trim() : "";
  const id = String(m.id || "");
  const name = String(m.display || m.name || "-");

  if (m.active === false) return `<span class="small">inactive</span>`;

  if (username) {
    return `<button class="btn mini js-telegram" data-user="${esc(username)}">Telegram</button>`;
  }
  return `<button class="btn mini js-notice" data-id="${esc(id)}" data-prize="" data-name="${esc(name)}">Notice</button>`;
}

function renderMembersTable(list) {
  const rows = list
    .map((m, i) => {
      const username = m.username ? `@${String(m.username).replace("@", "")}` : "-";
      const won = m.isWinner ? "✅" : "";
      const status = (m.active === false) ? "❌ INACTIVE" : "✅ ACTIVE";
      return `<tr>
        <td>${i + 1}</td>
        <td>${esc(m.display || "-")}</td>
        <td>${esc(username)}</td>
        <td>${esc(String(m.id || "-"))}</td>
        <td>${won}</td>
        <td>${status}</td>
        <td>${contactButtonHTML(m)}</td>
      </tr>`;
    })
    .join("");

  membersTable.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>No.</th><th>Name</th><th>Username</th><th>ID</th><th>Won</th><th>Status</th><th>Action</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="7">No members yet</td></tr>`}</tbody>
    </table>
  `;
}

async function loadMembersUI() {
  showMembersPanel();
  membersTotalText.textContent = "";

  const cached = readCache(CACHE_MEMBERS_KEY);
  if (Array.isArray(cached)) {
    membersTotalText.textContent = ` • Total: ${cached.length} (cached)`;
    renderMembersTable(cached);
  } else {
    membersTable.innerHTML = `<div class="small">Loading...</div>`;
  }

  showLoading("Loading Members...");
  try {
    const data = await apiGet("/members", 15000); // ✅ increase timeout
    if (!data?.ok) throw new Error(data?.error || "members error");

    const list = Array.isArray(data.members) ? data.members : [];
    membersTotalText.textContent = ` • Total: ${list.length}`;
    renderMembersTable(list);
    saveCache(CACHE_MEMBERS_KEY, list);
  } catch (e) {
    membersTable.insertAdjacentHTML(
      "afterbegin",
      `<div class="small" style="margin-bottom:8px;">⚠️ ${esc(e.message || e)}</div>`
    );
  } finally {
    hideLoading();
  }
}

async function loadMembersInSettings() {
  membersInSettings.innerHTML = "Loading...";
  try {
    const data = await apiGet("/members", 15000); // ✅ increase timeout
    if (!data?.ok) throw new Error(data?.error || "members error");
    const list = Array.isArray(data.members) ? data.members : [];
    membersInSettings.innerHTML = list.length
      ? list
          .map((m, i) => {
            const u = m.username ? `@${String(m.username).replace("@", "")}` : "-";
            const st = (m.active === false) ? "INACTIVE" : "ACTIVE";
            return `${i + 1}. ${esc(m.display || "-")} (${esc(u)}) [${esc(String(m.id || "-"))}] • ${st}`;
          })
          .join("<br>")
      : "No members yet";
    saveCache(CACHE_MEMBERS_KEY, list);
  } catch (e) {
    membersInSettings.innerHTML = `Error: ${esc(e.message || e)}`;
  }
}

/* ===========================
   History UI (show cache first)
=========================== */
function renderHistory(list) {
  historyList.innerHTML = list.length
    ? list
        .map((h) => {
          const winnerObj = h?.winner ?? h?.member ?? h?.user ?? {};
          const prize = h?.prize ?? h?.prize_name ?? h?.prizeName ?? h?.item ?? "-";

          const display =
            winnerObj?.display ??
            winnerObj?.name ??
            (winnerObj?.username ? "@" + String(winnerObj.username).replace("@", "") : "") ??
            (winnerObj?.id ? String(winnerObj.id) : "") ??
            "-";

          const usernameRaw = winnerObj?.username ?? h?.winner_username ?? h?.username ?? "";
          const u = String(usernameRaw || "").replace("@", "").trim();

          const id = winnerObj?.id ?? h?.winner_id ?? h?.user_id ?? h?.id ?? "";
          const at = h?.at ? new Date(h.at).toLocaleString() : "";

          const showUser = u ? `@${u}` : "-";
          const showId = id ? String(id) : "-";

          let btn = "";
          if (u) {
            btn = `<button class="btn mini js-telegram" data-user="${esc(u)}">Telegram</button>`;
          } else {
            btn = `<button class="btn mini js-notice"
                      data-id="${esc(String(showId))}"
                      data-prize="${esc(String(prize || ""))}"
                      data-name="${esc(String(display))}">
                      Notice
                   </button>`;
          }

          return `
            <div class="hist-row">
              <div class="hist-main">
                <b>${esc(String(prize))}</b>
                <span>${esc(String(display))}</span>
                <span class="small">(${esc(String(showUser))})</span>
                <span class="small">[${esc(String(showId))}]</span>
                ${btn}
              </div>
              <div class="hist-time">${esc(String(at))}</div>
            </div>
          `;
        })
        .join("")
    : `<div class="small">No winners yet</div>`;
}

async function loadHistoryUI() {
  showHistoryPanel();

  const cached = readCache(CACHE_HISTORY_KEY);
  if (Array.isArray(cached)) {
    renderHistory(cached);
  } else {
    historyList.innerHTML = `<div class="small">Loading...</div>`;
  }

  showLoading("Loading History...");
  try {
    const data = await apiGet("/history", 15000); // ✅ increase timeout
    if (!data?.ok) throw new Error(data?.error || "history error");
    const list = Array.isArray(data.history) ? data.history : [];
    renderHistory(list);
    saveCache(CACHE_HISTORY_KEY, list);
  } catch (e) {
    historyList.insertAdjacentHTML(
      "afterbegin",
      `<div class="small" style="margin-bottom:8px;">⚠️ ${esc(e.message || e)}</div>`
    );
  } finally {
    hideLoading();
  }
}

/* ✅ Delegation */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  if (btn.classList.contains("js-telegram")) {
    const user = (btn.dataset.user || "").replace("@", "").trim();
    if (!user) return;
    window.open(`https://t.me/${user}`, "_blank");
    return;
  }

  if (btn.classList.contains("js-notice")) {
    const userId = btn.dataset.id;
    const prize = btn.dataset.prize || "";
    if (!userId) return;

    showLoading("Sending Notice (DM)...");
    try {
      const r = await apiPost("/notice", { user_id: userId, prize }, 12000);
      if (r?.dm_ok) alert("✅ DM ပို့ပြီးပါပြီ");
      else alert("⚠️ DM မပို့နိုင်သေးပါ");
    } catch (err) {
      alert("Notice error: " + (err.message || err));
    } finally {
      hideLoading();
    }
  }
});

/* ===========================
   Restart Spin (no stuck)
=========================== */
restartSpinBtn.addEventListener("click", async () => {
  showLoading("Restarting Spin...");
  restartSpinBtn.disabled = true;
  try {
    const data = await apiPost("/restart-spin", {}, 12000);
    if (!data?.ok) throw new Error(data?.error || "restart error");
    hideWinnerModal();
    await refreshPoolUI();
    alert("Restart Spin ✅");
  } catch (e) {
    alert("Restart error: " + (e.message || e));
  } finally {
    restartSpinBtn.disabled = false;
    hideLoading();
  }
});

/* ===========================
   Spin
=========================== */
function calcAngleToLandOnPrize(prize) {
  const idx = wheelPrizes.indexOf(String(prize));
  if (idx < 0 || wheelPrizes.length < 2) return null;

  const slice = (Math.PI * 2) / wheelPrizes.length;
  const pointerAngle = (Math.PI * 3) / 2;

  const centerOffset = (idx + 0.5) * slice;
  let target = pointerAngle - centerOffset;

  const jitter = (Math.random() * 0.6 - 0.3) * (slice * 0.6);
  target += jitter;

  while (target < 0) target += Math.PI * 2;
  while (target >= Math.PI * 2) target -= Math.PI * 2;

  return target;
}

async function spin() {
  if (spinning) return;

  if (wheelPrizes.length < 2) {
    alert("Settings ထဲမှာ Prize (အနည်းဆုံး 2 ခု) ထည့်ပါ");
    return;
  }

  spinning = true;
  spinBtn.disabled = true;
  const oldText = spinBtn.textContent;
  spinBtn.textContent = "SPIN...";

  let result;
  showLoading("Spinning...");
  try {
    result = await apiPost("/spin", {}, 12000);
    if (!result?.ok) throw new Error(result?.error || "spin error");
  } catch (e) {
    spinning = false;
    spinBtn.disabled = false;
    spinBtn.textContent = oldText;
    hideLoading();
    alert("Spin error: " + (e.message || e));
    return;
  } finally {
    hideLoading();
  }

  const prize = String(result.prize || "-");
  const winner = result.winner || {};

  let targetAngle = calcAngleToLandOnPrize(prize);
  if (targetAngle === null) targetAngle = Math.random() * Math.PI * 2;

  if (musicOn && bgMusic.src) bgMusic.play().catch(() => {});

  const extraSpins = 7 + Math.random() * 6;
  const currentNorm = ((currentAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const delta = ((targetAngle - currentNorm) + Math.PI * 2) % (Math.PI * 2);
  const finalAngle = currentAngle + extraSpins * Math.PI * 2 + delta;

  const duration = 3200;
  const startTime = performance.now();
  const startAngle = currentAngle;

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  let tickT = 0;
  function animate(now) {
    const elapsed = now - startTime;
    const t = Math.min(elapsed / duration, 1);
    const eased = easeOutCubic(t);

    currentAngle = startAngle + (finalAngle - startAngle) * eased;
    drawWheel();

    const nt = Math.floor(eased * 60);
    if (nt !== tickT) {
      tickT = nt;
      tickSound(600 + nt * 10, 0.015, 0.04);
    }

    if (t < 1) {
      requestAnimationFrame(animate);
    } else {
      showWinnerModal(prize, winner);
      refreshPoolUI();
      spinning = false;
      spinBtn.disabled = false;
      spinBtn.textContent = oldText;
    }
  }

  requestAnimationFrame(animate);
}
spinBtn.addEventListener("click", spin);

/* ===========================
   Save / Reset / Upload
=========================== */
async function pushPrizeConfigToRender(prizeText) {
  const r = await apiPost("/config/prizes", { prizeText }, 12000);
  if (!r?.ok) throw new Error(r?.error || "config/prizes error");
  return r;
}

saveBtn.addEventListener("click", async () => {
  const s = loadSettings();

  s.apiBase = (apiBaseInput.value || DEFAULT_API_BASE).trim();
  s.apiKey = (apiKeyInput.value || DEFAULT_API_KEY).trim();

  s.uiColor = uiColorInput.value || "#ffffff";
  s.wheelAccent = wheelAccentInput.value || "#d6b25e";
  s.wheelColorsText = wheelColorsInput.value || defaultSettings.wheelColorsText;

  saveSettingsLocal(s);

  applyThemeUI(s.uiColor, s.wheelAccent);
  sliceColors = parseWheelColors(s.wheelColorsText);

  const prizeText = buildPrizeText(s.prizes);
  wheelPrizes = uniquePrizesFromPrizeText(prizeText);
  drawWheel();

  saveBtn.disabled = true;
  showLoading("Saving Settings + Uploading Prizes...");

  try {
    await pushPrizeConfigToRender(prizeText);
    await refreshPoolUI();
    closeSettings();
    alert("Save ✅");
  } catch (e) {
    alert("Save to Render error: " + (e.message || e));
  } finally {
    saveBtn.disabled = false;
    hideLoading();
  }
});

resetBtn.addEventListener("click", () => {
  if (!confirm("Reset settings လုပ်မလား?")) return;
  saveSettingsLocal(clone(defaultSettings));
  clearCache(); // ✅ important
  init();
  alert("Reset done ✅");
});

pageBgFile.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const s = loadSettings();
  s.pageBgDataUrl = await fileToDataURL(f);
  saveSettingsLocal(s);
  applyPageBg(s.pageBgDataUrl);
});

wheelBgFile.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const s = loadSettings();
  s.wheelBgDataUrl = await fileToDataURL(f);
  saveSettingsLocal(s);
  applyWheelBg(s.wheelBgDataUrl);
});

topBannerFile.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const s = loadSettings();
  s.topBannerDataUrl = await fileToDataURL(f);
  saveSettingsLocal(s);
  applyBanner(s.topBannerDataUrl, topBannerImg, topBannerFallback);
});

bottomBannerFile.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const s = loadSettings();
  s.bottomBannerDataUrl = await fileToDataURL(f);
  saveSettingsLocal(s);
  applyBanner(s.bottomBannerDataUrl, bottomBannerImg, bottomBannerFallback);
});

bgSongFile.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  bgMusic.src = url;
  if (musicOn) bgMusic.play().catch(() => {});
});

/* ===========================
   Buttons
=========================== */
membersBtn.addEventListener("click", loadMembersUI);
historyBtn.addEventListener("click", loadHistoryUI);
refreshMembersInSettingsBtn.addEventListener("click", loadMembersInSettings);

/* ===========================
   Init
=========================== */
function init() {
  const s = loadSettings();

  apiBaseInput.value = s.apiBase || DEFAULT_API_BASE;
  apiKeyInput.value = s.apiKey || DEFAULT_API_KEY;

  uiColorInput.value = s.uiColor || "#ffffff";
  wheelAccentInput.value = s.wheelAccent || "#d6b25e";
  wheelColorsInput.value = s.wheelColorsText || defaultSettings.wheelColorsText;

  applyThemeUI(s.uiColor, s.wheelAccent);

  applyPageBg(s.pageBgDataUrl || "");
  applyWheelBg(s.wheelBgDataUrl || "");
  applyBanner(s.topBannerDataUrl || "", topBannerImg, topBannerFallback);
  applyBanner(s.bottomBannerDataUrl || "", bottomBannerImg, bottomBannerFallback);

  renderPrizeBuilder(s.prizes || clone(defaultSettings.prizes));

  sliceColors = parseWheelColors(s.wheelColorsText);
  const prizeText = buildPrizeText(s.prizes || []);

  wheelPrizes = uniquePrizesFromPrizeText(prizeText);
  drawWheel();

  updateMusicBtn();
  refreshPoolUI();
}
init();

/* ===========================
   Utils  ✅ FIXED (closing braces)
=========================== */
function esc(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}  }

  const json = await redis.get(KEY_PRIZES_JSON);
  let cfg = [];
  try {
    cfg = JSON.parse(json || "[]");
  } catch {
    cfg = [];
  }
  cfg = normalizePrizeConfig(cfg);
  if (!cfg.length) return { ok: false, error: "No prize config" };
  const total = await rebuildPrizeQueueFromConfig(cfg);
  return { ok: true, total };
}

async function pickWinnerNoRepeat() {
  // pool = registered members - winners - excluded
  const ids = await redis.smembers(KEY_MEMBERS);
  const winners = await redis.smembers(KEY_WINNERS);

  const winnerSet = new Set((winners || []).map(String));
  const pool = (ids || [])
    .map(String)
    .filter((id) => !winnerSet.has(id))
    .filter((id) => !isExcluded(id));

  if (!pool.length) return { ok: false, error: "No members left in pool" };

  const uid = pool[Math.floor(Math.random() * pool.length)];
  const m = await redis.hgetall(KEY_MEMBER(uid));

  const name = (m?.name || "").trim();
  const username = (m?.username || "").trim(); // without @
  const displayName = name || (username ? `@${username}` : uid);

  return {
    ok: true,
    member: {
      id: uid,
      name,
      username,
      display: displayName,
      dm_ready: m?.dm_ready === "1",
    },
    poolCount: pool.length,
  };
}

async function popPrize() {
  const left = Number(await redis.llen(KEY_PRIZE_QUEUE)) || 0;
  if (left <= 0) {
    const ensured = await ensurePrizeQueue();
    if (!ensured.ok) return { ok: false, error: ensured.error || "No prizes" };
  }
  const p = await redis.lpop(KEY_PRIZE_QUEUE);
  if (!p) return { ok: false, error: "No prize left" };
  return { ok: true, prize: String(p) };
}

/* ================= EXPRESS API (for CodePen) ================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.send(
    "Lucky77 Wheel Bot Pro ✅\n\n" +
      "GET  /health\n" +
      "GET  /api/members?key=API_KEY\n" +
      "GET  /api/pool?key=API_KEY\n" +
      "GET  /api/history?key=API_KEY\n" +
      "POST /api/config/prizes?key=API_KEY\n" +
      "POST /api/spin?key=API_KEY\n" +
      "POST /api/restart?key=API_KEY\n" +
      "POST /api/notice?key=API_KEY\n"
  );
});

app.get("/health", async (req, res) => {
  try {
    const groups = await redis.smembers(KEY_GROUPS);
    const totalMembers = await redis.scard(KEY_MEMBERS);
    const totalWinners = await redis.scard(KEY_WINNERS);
    const prizeLeft = await redis.llen(KEY_PRIZE_QUEUE);

    res.json({
      ok: true,
      bot: BOT_USERNAME || null,
      groups_seen: (groups || []).length,
      members: Number(totalMembers) || 0,
      winners: Number(totalWinners) || 0,
      prize_left: Number(prizeLeft) || 0,
      api_key_required: !!API_KEY,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ Save prize config from CodePen
// body: { prizes:[{name,count}] }  OR  { prizeText:"10000Ks 4time\n5000Ks 2time" }
app.post("/api/config/prizes", requireKey, async (req, res) => {
  try {
    let prizes = [];

    if (Array.isArray(req.body?.prizes)) {
      prizes = req.body.prizes;
    } else if (typeof req.body?.prizeText === "string") {
      // parse lines: "10000Ks 4time" or "10000Ks 10"
      const lines = req.body.prizeText
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);

      prizes = lines
        .map((line) => {
          const m =
            line.match(/^(.+?)\s+\(?(\d+)\)?\s*time$/i) ||
            line.match(/^(.+?)\s+(\d+)$/i);
          if (!m) return null;
          return { name: m[1].trim(), count: Number(m[2]) };
        })
        .filter(Boolean);
    }

    const clean = normalizePrizeConfig(prizes);
    if (!clean.length) return res.status(400).json({ ok: false, error: "No valid prizes" });

    await redis.set(KEY_PRIZES_JSON, JSON.stringify(clean));
    const total = await rebuildPrizeQueueFromConfig(clean);

    res.json({ ok: true, saved: clean, total_slots: total });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ members list for CodePen
app.get("/api/members", requireKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS);
    const winners = await redis.smembers(KEY_WINNERS);
    const winnerSet = new Set((winners || []).map(String));

    const members = [];
    for (const id of ids || []) {
      const m = await redis.hgetall(KEY_MEMBER(id));
      if (!m?.id) continue;
      if (isExcluded(m.id)) continue;

      const name = (m.name || "").trim();
      const username = (m.username || "").trim(); // no @
      const displayName = name || (username ? `@${username}` : String(m.id));

      members.push({
        id: String(m.id),
        name,
        username,
        display: displayName,
        dm_ready: m.dm_ready === "1",
        isWinner: winnerSet.has(String(m.id)),
        registered_at: m.registered_at || "",
      });
    }

    members.sort((a, b) => (a.registered_at || "").localeCompare(b.registered_at || ""));
    res.json({ ok: true, total: members.length, members });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ pool info
app.get("/api/pool", requireKey, async (req, res) => {
  try {
    const ids = await redis.smembers(KEY_MEMBERS);
    const winners = await redis.smembers(KEY_WINNERS);

    const winnerSet = new Set((winners || []).map(String));
    const pool = (ids || [])
      .map(String)
      .filter((id) => !winnerSet.has(id))
      .filter((id) => !isExcluded(id));

    res.json({ ok: true, count: pool.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ history
app.get("/api/history", requireKey, async (req, res) => {
  try {
    const list = await redis.lrange(KEY_HISTORY, 0, 200);
    const history = (list || []).map((s) => {
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

// ✅ spin: pop prize + pick winner (no-repeat), store history, mark winner
app.post("/api/spin", requireKey, async (req, res) => {
  try {
    const prizePop = await popPrize();
    if (!prizePop.ok) return res.status(400).json({ ok: false, error: prizePop.error });

    const win = await pickWinnerNoRepeat();
    if (!win.ok) return res.status(400).json({ ok: false, error: win.error });

    const prize = prizePop.prize;
    const winner = win.member;

    // mark winner no-repeat
    await redis.sadd(KEY_WINNERS, String(winner.id));

    const item = {
      at: new Date().toISOString(),
      prize,
      winner: {
        id: winner.id,
        name: winner.name,
        username: winner.username,
        display: winner.display,
        dm_ready: winner.dm_ready,
      },
    };

    await redis.lpush(KEY_HISTORY, JSON.stringify(item));
    await redis.ltrim(KEY_HISTORY, 0, 200);

    res.json({ ok: true, prize, winner, item });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ restart: clear winners + history + rebuild prize queue from saved config
app.post("/api/restart", requireKey, async (req, res) => {
  try {
    await redis.del(KEY_WINNERS);
    await redis.del(KEY_HISTORY);

    const ensured = await ensurePrizeQueue();
    if (!ensured.ok) return res.status(400).json({ ok: false, error: ensured.error });

    res.json({ ok: true, restarted: true, prize_total: ensured.total });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ notice DM for ID-only winners
// body: { user_id, text }
app.post("/api/notice", requireKey, async (req, res) => {
  try {
    const user_id = String(req.body?.user_id || "").trim();
    const text = String(req.body?.text || "").trim();
    if (!user_id || !text) return res.status(400).json({ ok: false, error: "user_id and text required" });

    const m = await redis.hgetall(KEY_MEMBER(user_id));
    const dm_ready = m?.dm_ready === "1";

    if (!dm_ready) {
      return res.json({
        ok: true,
        dm_ok: false,
        dm_error: "DM not enabled (user must /start bot)",
      });
    }

    const dm = await tryDM(user_id, text);
    res.json({ ok: true, dm_ok: dm.ok, dm_error: dm.ok ? "" : String(dm.error || "") });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));

# Lucky77 Wheel Bot — Ver 1.0 Pro (Render + CodePen)

## What it does
- Any group/supergroup where the bot exists:
  - Member join -> bot sends Register button (auto delete in 1 minute)
  - Register click -> save member into Redis
  - Registered click again -> popup shows "Registered already"
  - ID-only (no name & no username) -> bot shows Start Bot Register link (auto delete in 1 minute)
- APIs for CodePen:
  - Save Prize config (Prize + Count)
  - Spin (returns prize + winner)
  - Members list / Pool count / History
  - Notice DM (for ID-only, only after user /start)

---

## Render Environment Variables
Set these in Render -> Environment:

Required:
- BOT_TOKEN
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- OWNER_ID

Optional (Recommended):
- API_KEY  (example: Lucky77_luckywheel_77)

---

## Telegram Setup
1) Add bot into your group
2) Make bot admin (recommended permissions):
- Send messages ✅
- Delete messages ✅ (auto delete register messages)
- Manage messages ✅

3) Disable privacy:
BotFather -> /setprivacy -> choose bot -> DISABLE

---

## Health Check
GET /health

If API_KEY is set, use:
- /health?key=API_KEY (or header x-api-key)

---

## API (for CodePen)
If API_KEY is set, pass it via:
- ?key=API_KEY
OR
- header: x-api-key: API_KEY

### POST /api/config/prizes
Body (choose one):

Option A:
{
  "prizes": [
    {"name":"10000Ks","count":10},
    {"name":"5000Ks","count":2}
  ]
}

Option B:
{
  "prizeText":"10000Ks 10time\n5000Ks 2time"
}

### POST /api/spin
Returns { prize, winner } and saves history.
Winner is no-repeat (once won, will not win again until restart).

### POST /api/restart
Clears winners + history and rebuilds prize queue.

### GET /api/members
Returns members table for UI.

### GET /api/pool
Returns count of remaining pool (not yet won).

### GET /api/history
Returns winner history list.

### POST /api/notice
Body:
{ "user_id":"123", "text":"Winner message..." }

Only works if member has /start the bot (dm_ready=1).

---

## Notes
- Group ID issue is solved: bot does NOT depend on a single GROUP_ID.
- Register auto delete = 60 seconds.

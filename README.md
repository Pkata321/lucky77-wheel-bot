# Lucky77 Wheel Bot PRO v1.0 (Render)

## What it does
- Group join => bot posts **Register** button (auto delete 60s)
- Register click => save member to Redis (immediate)
- If member has **name or username** => CodePen can open chat link directly
- If member is **ID-only** => bot shows **Start Bot Register** so user can receive DM later
- CodePen API:
  - /members, /pool
  - /config/prizes
  - /spin, /history
  - /notice (DM)
  - /restart-spin

---

## Render Environment Variables
Required:
- BOT_TOKEN
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- OWNER_ID
- API_KEY

Optional:
- GROUP_ID (if set => only that group; if NOT set => works in any group bot is added)
- EXCLUDE_IDS (comma separated ids to exclude)

Example:
- API_KEY=Lucky77_luckywheel_77

---

## Telegram Setup
1) Add bot to group as **Admin**
2) BotFather -> /setprivacy -> choose bot -> **DISABLE**
3) Give permissions recommended:
   - Send Messages ✅
   - Delete Messages ✅

---

## Health
Open:
- GET /health

---

## CodePen API usage
All endpoints require API Key:
- pass as query: `?key=API_KEY`
- or header: `x-api-key: API_KEY`

Endpoints:
- GET  /members
- GET  /pool
- POST /config/prizes   { prizeText }
- POST /spin
- GET  /history
- POST /notice          { user_id, text }
- POST /restart-spin
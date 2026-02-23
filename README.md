# Lucky77 Wheel Bot (Render)

## What this bot does
- In your Telegram Group, when a member joins → bot posts a **Register** button.
- Member taps Register → bot saves their info to Redis immediately.
- If member has **username or name** → CodePen can open Telegram chat link (direct).
- If member is **ID-only** (no username & no name) → bot shows **Start Bot (DM Enable)** button so they can receive DM later.
- Provides API endpoints for CodePen:
  - Members list
  - Notice DM
  - Winner history

---

## 1) Environment Variables (Render)
Set these in Render → Environment:

- BOT_TOKEN
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- GROUP_ID
- OWNER_ID
- API_KEY (example: Lucky77_luckywheel_77)
- PUBLIC_URL (example: https://lucky77-wheel-bot.onrender.com)
- EXCLUDE_IDS (optional, comma separated)

---

## 2) Telegram settings
### Bot must be Admin in the group
Group → Manage → Administrators → add bot.
Permissions recommended:
- Send messages ✅
- Delete messages ✅ (for auto delete)
- Manage messages ✅ (safe)

### Disable bot privacy
BotFather → /setprivacy → choose bot → DISABLE

---

## 3) Health Check
Open:
- GET /health

Example:
- https://lucky77-wheel-bot.onrender.com/health

---

## 4) API (for CodePen)
All endpoints require API key:
- Provide `?key=API_KEY` or header `x-api-key: API_KEY`

### GET /api/members
Returns members list.

### POST /api/notice
Send DM to a specific user_id.
Body:
```json
{ "user_id": "123", "text": "Winner..." }

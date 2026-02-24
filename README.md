# Lucky77 Wheel Bot (Render)

## What this bot does
- In Telegram Group, member join → bot posts a Register button (auto delete 30s).
- Member taps Register → bot saves member info to Upstash Redis immediately (DM မဝင်လည်း save ဖြစ်).
- If member has username or name → CodePen can open Telegram chat link (direct).
- If member is ID-only (no username & no name) → bot shows Start Bot (DM Enable) link.
- CodePen API supports:
  - Prize config (Prize turn)
  - Spin (random prize + random member no-repeat)
  - Members list
  - Winner history
  - Notice DM (for ID-only winners)

---

## 1) Render Environment Variables
Render → Environment မှာ ထည့်ပါ

Required:
- BOT_TOKEN
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- OWNER_ID
- API_KEY (example: Lucky77_luckywheel_77)

Optional:
- GROUP_ID (မထည့်လည်းရ — bot က group ကို ပထမဆုံးမြင်တာနဲ့ auto-save လုပ်မယ်)
- EXCLUDE_IDS (comma separated) e.g. 123,456

---

## 2) Telegram Settings
### Bot must be Admin in the group
Group → Manage → Administrators → add bot.
Recommended permissions:
- Send messages ✅
- Delete messages ✅ (for auto delete)
- Manage messages ✅

### Disable bot privacy
BotFather → /setprivacy → choose bot → DISABLE

---

## 3) Health Check
Open:
- GET /health

---

## 4) CodePen API Usage
All endpoints require API key:
- ?key=API_KEY OR request header x-api-key: API_KEY

Endpoints:
- GET  /api/members
- POST /api/config/prizes  Body: { "prizeText": "10000Ks 4time\n5000Ks 2time" }
- POST /api/spin
- POST /api/restart-spin
- GET  /api/history
- POST /api/notice          Body: { "user_id": "123", "text": "Winner message..." }

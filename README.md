# Lucky77 Wheel Bot — PRO v2 Premium (Render)

✅ Webhook Mode (Fix 409 Conflict)  
✅ Group join/leave service messages auto delete (admin permission required)  
✅ Register only via DM (button) — group join does NOT auto register  
✅ API for CodePen (API_KEY protected)

---

## 1) Render Environment Variables

Required:

- BOT_TOKEN=xxxxx
- OWNER_ID=123456789
- API_KEY=Lucky77_luckywheel_77
- UPSTASH_REDIS_REST_URL=https://xxxx.upstash.io
- UPSTASH_REDIS_REST_TOKEN=xxxx
- PUBLIC_URL=https://your-service.onrender.com

Optional:

- GROUP_ID=-100xxxxxxxxxx        (set to lock bot to only one group/supergroup)
- EXCLUDE_IDS=111,222,333        (exclude these user ids from pool)
- WEBHOOK_SECRET=your_secret     (protect webhook endpoint)

---

## 2) Telegram Setup

### A) Add bot to your supergroup
- Add bot to group
- Promote to Admin
- Enable these permissions:
  - Delete messages
  - (recommended) Manage messages

### B) Register flow (Premium)
- Group join: bot stays silent (no popup)
- User must press DM Register button or type /register in group
- DM (/start) => register + dm_ready=1

---

## 3) API Endpoints

Public:
- GET /health

Protected (API_KEY):
- GET  /members?key=API_KEY
- GET  /pool?key=API_KEY
- POST /config/prizes?key=API_KEY   { "prizeText": "10000Ks 4time\n5000Ks 2time" }
- POST /spin?key=API_KEY
- GET  /history?key=API_KEY
- POST /notice?key=API_KEY          { "user_id":"123", "text":"Hello" }
- POST /restart-spin?key=API_KEY

---

## 4) Notes

### Fix 409 Conflict
This version uses Webhook mode (no polling).  
So only ONE service can receive updates and 409 will stop.

### Auto-delete join/leave messages
Telegram allows deleting service messages only if bot is admin and has Delete permission.- POST /restart-spin
# Lucky77 Wheel Bot PRO v2 Premium (Render)

## ✅ Features
- Webhook mode (NO polling) => Fix ETELEGRAM 409 Conflict
- Keeps CodePen API endpoints unchanged
- Group join/leave service message auto delete (if bot has permissions)
- Group sends "Register (DM)" button on join/add
- DM /start => register + dm_ready = 1

## ✅ Required ENV (Render)
- BOT_TOKEN
- API_KEY
- OWNER_ID
- GROUP_ID
- PUBLIC_URL (https://xxxx.onrender.com)
- WEBHOOK_SECRET (random string)
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN

Optional:
- EXCLUDE_IDS="123,456"
- PIN_REGISTER_MSG="1"

## ✅ API (same as before)
- GET  /health
- GET  /members?key=API_KEY
- GET  /pool?key=API_KEY
- POST /config/prizes?key=API_KEY   { prizeText }
- POST /spin?key=API_KEY
- GET  /history?key=API_KEY
- POST /notice?key=API_KEY         { user_id, text }
- POST /restart-spin?key=API_KEYTelegram allows deleting service messages only if bot is admin and has Delete permission.- POST /restart-spin
# Lucky77 Wheel Bot — PRO V2 Premium (Render)

## Features
- Webhook mode on Render (fix 409 getUpdates conflict)
- Auto delete group join/left service messages (requires bot admin + delete permission)
- Silent capture members on join/add (name/username/id)
- Auto send + auto pin a Register button message in group (deep link to bot DM)
- API endpoints for CodePen (API_KEY protected)

## Required ENV
- BOT_TOKEN
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- OWNER_ID
- API_KEY
- PUBLIC_URL   (Render service url, e.g. https://xxxx.onrender.com)
- WEBHOOK_SECRET (random secret string)

## Optional ENV
- GROUP_ID (target only one group/supergroup)
- EXCLUDE_IDS ("123,456")
- DM_SILENT ("1" default) => DM /start no reply
- PIN_REGISTER_MSG ("1" default) => send + pin register message

## API
- GET  /health
- GET  /members?key=API_KEY
- GET  /pool?key=API_KEY
- POST /config/prizes?key=API_KEY { prizeText }
- POST /spin?key=API_KEY
- GET  /history?key=API_KEY
- POST /notice?key=API_KEY { user_id, text }
- POST /restart-spin?key=API_KEY
# Lucky77 Wheel Bot - PRO v2 Premium (Render)

## ✅ Features
- Webhook mode (✅ fixes 409 getUpdates conflict)
- Group join/add => auto register in Redis (silent)
- Auto delete join service message (if bot has delete permission)
- API endpoints protected by API_KEY for CodePen
  - GET  /health
  - GET  /members?key=API_KEY
  - GET  /pool?key=API_KEY
  - POST /config/prizes?key=API_KEY  { prizeText }
  - POST /spin?key=API_KEY
  - GET  /history?key=API_KEY
  - POST /notice?key=API_KEY { user_id, text }
  - POST /restart-spin?key=API_KEY

## ✅ Render ENV
Required:
- BOT_TOKEN
- OWNER_ID
- API_KEY
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- PUBLIC_URL (example: https://lucky77-wheel-bot.onrender.com)
- WEBHOOK_SECRET (random string)

Optional:
- GROUP_ID (if you want only one group)
- EXCLUDE_IDS (comma list)

## ✅ Telegram
- Add bot to group
- Promote to Admin
- Enable: Delete messages
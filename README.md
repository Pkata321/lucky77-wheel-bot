# Lucky77 Wheel Bot PRO V2 Premium (Render)

## ✅ Features
- Webhook mode (Fix Telegram 409 Conflict)
- Group join => silent auto save (id/name/username) into Redis
- Auto delete join service message in 2 seconds (requires bot admin + Delete messages permission)
- One pinned message in group: “Enable DM” + button to open bot DM (auto /start register)
- Private /start register => dm_ready = 1 + registered message
- API (API_KEY protected):
  - GET  /health
  - GET  /members?key=API_KEY
  - GET  /pool?key=API_KEY
  - POST /config/prizes?key=API_KEY   { prizeText }
  - POST /spin?key=API_KEY
  - GET  /history?key=API_KEY
  - POST /notice?key=API_KEY         { user_id, text }
  - POST /restart-spin?key=API_KEY

## ✅ Required Environment Variables (Render)
- API_KEY
- BOT_TOKEN
- OWNER_ID
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- PUBLIC_URL               (e.g. https://lucky77-wheel-bot.onrender.com)
- WEBHOOK_SECRET           (random long string)

Optional:
- GROUP_ID                 (supergroup id e.g. -100xxxxxxxxxx)
- EXCLUDE_IDS              ("123,456")

## ✅ Notes
- If you use webhook mode, DO NOT run polling in another place.
- Bot must be Admin in the target group:
  - Delete messages ✅
  - Pin messages ✅- POST /restart-spin?key=API_KEY
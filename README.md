# Lucky77 Wheel Bot PRO V2 Premium (Render)

## ENV (Render Environment Variables)
Required:
- BOT_TOKEN
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- OWNER_ID
- API_KEY
- GROUP_ID
- PUBLIC_URL   (example: https://lucky77-wheel-bot.onrender.com)
- WEBHOOK_SECRET (example: Lucky77AutoBotLuckyWheel123123Aa)

Optional:
- EXCLUDE_IDS="123,456"
- AUTO_DELETE_NOTICE="1" (delete join-notice message)
- NOTICE_DELETE_MS="3000"

## Deploy steps
1) Put env vars in Render
2) Deploy (Render will run `npm start`)
3) Open: `https://<your-render-url>/health`
   Should show ok=true and bot_username

## Telegram Permissions
To auto delete join/left system messages:
- Add bot as admin in the group
- Give bot permission: Delete messages

## DM Pin (manual)
Bot will send a DM message with Register button.
You (user) can pin that DM message manually.
Bot cannot pin DM by itself (Telegram restriction).

## API for CodePen
All API endpoints require ?key=API_KEY or header x-api-key: API_KEY

- GET  /health
- GET  /members?key=API_KEY
- GET  /pool?key=API_KEY
- POST /config/prizes?key=API_KEY   { "prizeText":"A\nB\nC" }
- POST /spin?key=API_KEY           { "user_id":"123" }
- GET  /history?key=API_KEY
- POST /notice?key=API_KEY         { "user_id":"123", "text":"hello" }
- POST /restart-spin?key=API_KEY
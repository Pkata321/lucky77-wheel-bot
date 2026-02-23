# lucky77-wheel-bot (v2)

Lucky77 Lucky Wheel Event Bot (Render + Upstash Redis)

## Features
- Member join group -> Bot sends Register button
- User presses Register in group -> Popup alert + save user_id into Redis
- Button becomes Registered ✅ and cannot register twice
- If user doesn't press Register within 30 seconds, bot will Pin the register message (bot must have pin permission)
- API endpoints for CodePen (later):
  - List participants
  - Pick winner
  - Winners history
  - Notify winner via DM

---

## Setup (Render)

### 1) Deploy
Deploy as Web Service on Render.

### 2) Environment Variables (Render)
You must set:

- BOT_TOKEN = Telegram bot token
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- PUBLIC_URL = https://lucky77-wheel-bot.onrender.com
- API_KEY = Lucky77_luckywheel_77 (use this in CodePen later)
- OWNER_ID = your telegram numeric user id
- GROUP_ID = your supergroup id (IMPORTANT)

✅ If you see message link like t.me/c/3542073765/123
then your GROUP_ID should be:
-1003542073765

Optional:
- EXCLUDE_ADMINS = true/false (default: true)

### 3) BotFather settings
- Disable privacy: /setprivacy -> Disable
- Add bot to group as admin
  - Needs permission to:
    - Read messages (privacy disabled already)
    - Pin messages (if you want auto pin)

---

## Telegram Commands
- /id -> show Chat ID (use to confirm GROUP_ID)

---

## API (for CodePen later)
All API calls require API key:
- header: x-api-key: <API_KEY>
or query/body: api_key=<API_KEY>

### Health
- GET /

### Participants
- GET /participants

### Pick winner
- POST /pick

### Winners history
- GET /winners

### Notify Winner DM
- POST /notify-winner
Body:
```json
{ "user_id": "123456789", "text": "🎉 You won!" }

# lucky77-wheel-bot (v2)

Lucky77 Lucky Wheel Telegram Bot + Render API for CodePen UI.

## What it does
- In Telegram Group:
  - When a member joins, bot sends a **Register** button message.
  - Message auto-deletes after **30 seconds**.
  - Member clicks Register -> saved to Redis.
  - Button becomes **✅ Registered** (cannot register again).
- Private DM:
  - If user has started bot before, bot can DM winner messages.
  - If user never started bot, Telegram blocks bot from DM -> bot will show "Start Bot" link in group.

## Requirements
- Bot must be **Admin in the group** (to receive join events reliably & delete messages).
- Upstash Redis database (REST URL + token)

## Render (Web Service) setup

### Environment Variables
Set these in Render -> Environment:

- `BOT_TOKEN` = Telegram bot token
- `GROUP_ID` = Telegram group id (example: `-3542073765`)
- `OWNER_ID` = Owner telegram user id (numeric)
- `API_KEY` = `Lucky77_luckywheel_77` (used by CodePen to call API)
- `PUBLIC_URL` = `https://lucky77-wheel-bot.onrender.com`
- `UPSTASH_REDIS_REST_URL` = your Upstash REST URL (https://xxxxx.upstash.io)
- `UPSTASH_REDIS_REST_TOKEN` = your Upstash REST token

Optional:
- `EXCLUDE_IDS` = comma separated ids to exclude from member list (admins etc), e.g. `111,222,333`

### Start Command
Render start command:
- `npm start`

## API Endpoints (for CodePen)
All endpoints require API key via:
- header `X-API-KEY: <API_KEY>` OR query `?key=<API_KEY>`

- `GET /health`
- `GET /api/members`
- `POST /api/winner`
  Body:
  ```json
  { "user_id":"123", "prize":"10000Ks", "message":"custom text optional" }

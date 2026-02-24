# Lucky77 Wheel Bot (Render)

## Features
- Group join => Register button (auto delete 30s)
- /register in group => manual Register button (fallback)
- Register => save member to Redis immediately
- Registered button pressed again => popup "Registered already"
- ID-only => show Start Bot (DM Enable) guide
- API for CodePen:
  - GET  /api/members?key=API_KEY
  - POST /api/notice?key=API_KEY
  - POST /api/winner?key=API_KEY
  - GET  /api/winners?key=API_KEY

## ENV (Render)
BOT_TOKEN
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
OWNER_ID
API_KEY
PUBLIC_URL
(Optional) GROUP_ID
(Optional) EXCLUDE_IDS=123,456

## Telegram
- Bot must be Admin in the group:
  - Send messages ✅
  - Delete messages ✅
- BotFather => /setprivacy => DISABLE

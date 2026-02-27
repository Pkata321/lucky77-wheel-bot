# Lucky77 Wheel Bot PRO V2 Premium (Render)

## Environment Variables (Render)
Required:
- BOT_TOKEN
- GROUP_ID
- OWNER_ID
- API_KEY
- PUBLIC_URL
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- WEBHOOK_SECRET

Optional:
- EXCLUDE_IDS          (comma separated user ids)
- DM_SILENT            ("1" default; DM not spam unless register flow)
- PIN_REGISTER_MSG     ("1" default; keep single DM register message)

## Render Start Command
Use:
- npm start

⚠️ If your Render is running `src/index.js`, also copy the same code into `src/index.js`.

## Features
- Webhook mode (no 409 conflict, no polling)
- Fix EADDRINUSE (only one listen)
- Group: Admin can run /setup_register to send & PIN register message in group
- Group: Auto delete join/left service messages (needs bot admin + delete permission)
- Register button -> opens DM via deep-link (/start register)
- DM: shows a single pin-able register message (user pins manually)
- API for CodePen (API_KEY protected):
  - GET  /health
  - GET  /members?key=API_KEY
  - GET  /pool?key=API_KEY
  - POST /config/prizes?key=API_KEY   { prizes: string[] | "A\nB\nC" }
  - POST /spin?key=API_KEY           { user_id, name? }
  - GET  /history?key=API_KEY
  - POST /notice?key=API_KEY         { user_id?, text }
  - POST /restart-spin?key=API_KEY
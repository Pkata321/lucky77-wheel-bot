# lucky77-wheel-bot (Render)

Telegram group register + Upstash Redis storage for Lucky77 Lucky Wheel Event.

## Features
- When a user joins the group, bot posts a Register button (auto-deletes after 30 seconds)
- Clicking Register adds the user to the participants list (stored in Upstash Redis)
- Owner/Admin/Creator accounts are blocked from registering
- `/id` command in group prints the real Telegram chat id (use this for GROUP_ID)
- Private `/start` enables DM sending later (Telegram requires user to start the bot before bot can DM)

---

## Deploy (Render)
1) Deploy to Render as **Web Service**
2) Set Environment Variables (Render → Environment)

Required:
- `BOT_TOKEN` = Telegram bot token
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `PUBLIC_URL` = https://lucky77-wheel-bot.onrender.com
- `API_KEY` = Lucky77_luckywheel_77
- `OWNER_ID` = (your telegram numeric id)
- `GROUP_ID` = (your group chat id; use /id in the group)

Optional:
- `KEY_PREFIX` = change redis key namespace (default: lucky77:v2:)

3) Start Command: `npm start`

---

## Notes
- For DM winner notifications later, users must press `/start` in private at least once (Telegram limitation).
- Auto-delete works only if the bot has permission to delete messages in the group.

# lucky77-wheel-bot

## Setup (Render)
1) Deploy to Render as Web Service
2) Set Environment Variables:
   - BOT_TOKEN = your Telegram bot token
   - (optional) ADMIN_ID = your Telegram numeric user id (for admin-only commands)
3) Start Command: npm start

## API
- GET / -> health + participant count
- GET /participants -> list
- POST /participants body: { "name": "Aung" } OR { "names": ["Aung","Kyaw"] }
- POST /pick -> random pick
- POST /clear -> clear all
- POST /remove body: { "name": "Aung" } -> remove one

## Telegram Commands
- /add Name
- /addmany Name1, Name2, Name3
- /list
- /pick
- /remove Name
- /clear (admin only if ADMIN_ID set)

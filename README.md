# Lucky77 Wheel Bot

Telegram Group Register + Winner Auto DM

## Setup (Render)

Environment Variables:

BOT_TOKEN
PUBLIC_URL
API_KEY
OWNER_ID
GROUP_ID
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN

## Flow

/register → shows register button

User clicks → saved + DM auto sent

Winner API:

POST /winner
Header: x-api-key: YOUR_API_KEY
Body:
{
  "prize": "10000Ks"
}

Bot:
- picks random member
- excludes owner/admin/bot
- no repeat winners
- announces in group
- sends DM to winner

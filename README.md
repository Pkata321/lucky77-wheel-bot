# lucky77-wheel-bot (v2)

Telegram Lucky Wheel Bot + Render API + Upstash Redis  
Flow:
- Group: /register -> shows REGISTER button (deep link to bot)
- User must press Start once in DM (Telegram limitation)
- Bot saves: user_id + name + username
- CodePen calls API to pick a random winner for a selected prize
- Bot automatically DM winner by user_id (if user started bot already)

---

## Deploy (Render)

### 1) Create Render Web Service
- Node service
- Start command: `npm start`

### 2) Environment Variables (Render)
Required:
- `BOT_TOKEN` = Telegram Bot token
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `PUBLIC_URL` = https://your-service.onrender.com
- `API_KEY` = secret key used by CodePen (send via header `x-api-key`)
- `OWNER_ID` = your Telegram numeric ID
Optional but recommended:
- `GROUP_ID` = your group id (example: `-100xxxxxxxxxx`)

### 3) Upstash Redis
- Create Redis database in Upstash
- Copy REST URL + REST TOKEN into Render ENV

> If you had old keys causing `WRONGTYPE`, use owner command:
`/reset_db`

---

## Telegram Commands (Owner-only)
- `/exclude <id>` : exclude admin/bot/owner/etc from winning
- `/unexclude <id>`
- `/reset_round` : allow all winners to win again
- `/reset_db` : clears lw2:* keys (use carefully)

## Group Command
- `/register` : posts REGISTER button

---

## API (for CodePen)

### Auth
Send header:
- `x-api-key: <API_KEY>`

### GET /
Health + member count

### GET /members
Returns member list (id, name, username)

### GET /winners
Returns winner history logs

### POST /winner
Body:
```json
{ "prize": "10000Ks" }

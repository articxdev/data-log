# Production Log Bot

Telegram bot for logging daily production counts. Hosted on Cloudflare Workers with KV storage — zero servers, zero maintenance.

## Features

| Command | Description |
|---------|-------------|
| `/add 150` | Log 150 pcs (uses active product) |
| `/add 200 --product=IC-555` | Log with a specific product |
| `/add 80 --shift=Night --date=2026-05-20` | Override shift & date |
| `/product` | Show active product |
| `/product PCB-A` | Switch active product |
| `/products` | List all your products |
| `/today` | Today's entries & per-product breakdown |
| `/yesterday` | Yesterday's entries & total |
| `/date 2026-05-24` | Specific date with breakdown |
| `/week` / `/month` | Periodic summaries |
| `/stats` | Today / week / month / overall |
| `/total` | Lifetime total |
| `/undo` | Remove last entry |
| `/export` | Full CSV export |
| `/repair` | Recalculate totals from raw data |

**Products** — 3 defaults (`PCB-A, IC-555, Connector`). The bot remembers your last-used product per user. Just `/add 150` and it uses your active product. Use `--product=` to override temporarily.

## Deployment

### 1. Create a Telegram bot

Open [@BotFather](https://t.me/botfather), run `/newbot`, save the token.

### 2. Create KV namespace

```bash
npx wrangler login
npx wrangler kv:namespace create "KV"
```

Edit `wrangler.toml` — paste the returned `id`. Also customize `PRODUCTS` if needed.

### 3. Set secrets (never in code)

```bash
# Bot token (required)
npx wrangler secret put BOT_TOKEN

# Restrict by Telegram user ID (required for single-user)
npx wrangler secret put ALLOWED_USERS
# Enter your numeric user ID — get it from @userinfobot
```

### 4. Deploy & set webhook

```bash
npx wrangler deploy

# Point Telegram to your worker
curl -X POST "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook" \
  -d "url=https://production-log-bot.your-subdomain.workers.dev"
```

Now DM your bot on Telegram.

## Architecture

```
Telegram ──webhook──> Cloudflare Worker ──KV──> Daily entries
                            │
                     ctx.waitUntil()  ← non-blocking
```

- **KV keys**: `prod:YYYY-MM-DD` → JSON array of `{time, count, shift, note, by, product}`
- **KV key**: `stats:overall` → cached integer total
- **KV key**: `user:<id>:active_product` → last used product per user
- **KV key**: `user:<id>:products` → list of all products used by user
- **Idempotency**: deduplicates by `update_id`
- **Data safety**: all KV reads/writes wrapped in try/catch; corrupt entries auto-reset
- **Access**: only Telegram user IDs in `ALLOWED_USERS` secret can interact
- **Export**: paginated KV list (handles 1000+ keys)
- **Repair**: `/repair` re-sums every daily key if counter ever drifts

## Development

```bash
# local dev
npm install
npx wrangler dev

# expose with ngrok, then update webhook URL
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://your-ngrok.ngrok.io"
```

# Chart Scanner — Forex Structure & Bias Reader

Upload a Forex chart screenshot, pick the timeframe, and get back an
AI-generated read of market structure, bias, key levels, potential entries,
stop loss, and take profit — all analyzed server-side so your API key never
touches the browser.

## How it works

1. You upload a chart image (PNG/JPEG/WebP) and select a timeframe (1 minute
   through 1 month) in the browser.
2. The browser sends the image + timeframe to the backend (`POST /api/analyze`).
3. The backend sends the image to Claude (vision) with a structured prompt
   and parses the JSON response.
4. The frontend renders the structured result: bias, structure, entries,
   stop loss, take profit, risk/reward, and invalidation.

The Anthropic API key lives only in `server/.env` and is only ever used in
server-side code (`server/server.js`). It is never sent to, or readable by,
the browser.

## Project structure

```
forex-chart-scanner/
├── server/
│   ├── server.js            # Express app: pages, Supabase token check, upload handling, calls Claude
│   ├── analysisPrompt.js    # System/user prompt + timeframe validation (edit prompt behavior here)
│   ├── package.json
│   └── .env.example         # Copy to .env and fill in your keys
├── pages/
│   ├── landing.html         # /        one page marketing site
│   ├── login.html           # /login
│   ├── signup.html          # /signup
│   └── app.html             # /app     the scanner (logged in users)
├── public/
│   ├── style.css            # Theme, scanner and shared components
│   ├── site.css             # Landing and auth page styles
│   ├── app.js               # Scanner: upload, timeframe, scan, results
│   ├── auth-client.js       # Supabase client shared by every page
│   └── auth-pages.js        # Helpers for the log in and sign up forms
├── SUPABASE_SETUP.md        # Step by step guide to connecting accounts
├── .gitignore
└── README.md
```

Accounts are handled by Supabase. See **SUPABASE_SETUP.md**. The server
checks the user's Supabase access token before every scan, so the
Anthropic key cannot be used by anyone without an account.

## Setup

Requires Node.js 18+.

```bash
cd server
npm install
cp .env.example .env
```

Open `server/.env` and set:

```
ANTHROPIC_API_KEY=sk-ant-...your real key...
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-anon-public-key
```

Follow SUPABASE_SETUP.md for where the Supabase values come from.

The server always loads `server/.env` by its own location, so `npm start` from
`server/` and `node server/server.js` from the project root both work. If the
Supabase values are missing or wrong, the startup `[WARN]` line names the
problem without printing the value.

(Optional) Adjust in `.env`:
- `CLAUDE_MODEL` — defaults to `claude-sonnet-5`. Must be a model that
  supports image input.
- `PORT` — defaults to `3000`.
- `MAX_UPLOAD_MB` — defaults to `7` (kept under Anthropic's 10MB base64-encoded image limit).
- `CORS_ORIGIN` — origins allowed to call the API. Fine as-is for local use
  since the frontend is served from the same origin as the API.

## Run it

```bash
cd server
npm start
```

Then open **http://localhost:3000**.

For auto-restart on file changes during development:

```bash
npm run dev
```

## API

### `POST /api/analyze`
`multipart/form-data` with:
- `chart` — image file (PNG/JPEG/WebP, ≤ `MAX_UPLOAD_MB`)
- `timeframe` — one of `1m, 5m, 15m, 30m, 1H, 4H, 1D, 1W, 1M`

Returns:
```json
{
  "analysis": {
    "pair_guess": "EUR/USD",
    "timeframe_analyzed": "4H",
    "market_bias": "Bullish",
    "confidence": "Medium",
    "market_structure": { "trend": "...", "key_levels": ["..."], "chart_pattern": null },
    "potential_entries": [ { "type": "Long", "trigger": "...", "entry_zone": "...", "rationale": "..." } ],
    "stop_loss": { "suggestion": "...", "rationale": "..." },
    "take_profit": [ { "target": "...", "rationale": "..." } ],
    "risk_reward_estimate": "~1:2",
    "invalidation": "...",
    "notes": "...",
    "disclaimer": "..."
  },
  "timeframe": "4H",
  "model": "claude-sonnet-5"
}
```

### `GET /api/health`
Basic liveness check, returns `{ ok: true, model: "...", accounts: true|false }`.
`accounts` is `true` once valid Supabase settings are loaded. It never includes any key.

## Notes / design decisions

- **Rate limiting**: `/api/analyze` is limited to 8 requests/minute per IP
  (see `analyzeLimiter` in `server.js`) since each call costs real money —
  tune in `server.js` if needed.
- **Validation**: file type, file size, and timeframe are all validated
  server-side, not just in the browser.
- **Prompt/output shape**: lives entirely in `server/analysisPrompt.js`. If
  you want to change what the model returns (add fields, change tone, etc.),
  that's the one file to edit — update the JSON schema in the system prompt
  and the corresponding rendering code in `public/app.js`.
- **Accounts**: handled by Supabase (see SUPABASE_SETUP.md). The server
  checks the Supabase access token on every scan before calling Claude.

## Deploying

This is a single Node/Express process serving both the API and the static
frontend, so it deploys as one service to Render, Railway, Fly.io, a VPS,
etc. Set `ANTHROPIC_API_KEY`, `SUPABASE_URL` and `SUPABASE_ANON_KEY` (and
optionally `CLAUDE_MODEL`, `CORS_ORIGIN`) as environment variables on the
host. Do not commit `.env`.

## Pricing (planned, not built yet)

The landing page shows three one time scan packs:

| Pack | Price | Scans | Per scan |
|---|---|---|---|
| Starter | $8.99 | 20 | $0.45 |
| Trader | $12.99 | 60 | $0.22 |
| Pro | $19.99 | 150 | $0.13 |

**The code does not charge for or count scans yet.** Every logged in user
can scan freely (within the rate limit). Before taking payments:

1. **Credits**: a `credits` balance per user in Supabase, deducted by one on
   each successful scan, checked in `server.js` before Claude is called.
2. **Checkout**: Stripe or PayFast checkout for each pack, with a webhook that
   adds the credits once payment is confirmed.
3. **Measure real cost per scan**: log `message.usage` from each Claude call.
   Estimated cost is roughly $0.02 to $0.04 per scan on Claude Sonnet 5.
4. **Cap the model's thinking** so cost per scan stays predictable and the
   JSON answer is never cut off by `max_tokens`.

## Before going live

- Credits and checkout (above).
- A forgot password page (Supabase supports reset emails).
- Custom SMTP in Supabase (step 6 of SUPABASE_SETUP.md).
- Upgrade `multer` to 2.x (1.x has known vulnerabilities).
- The app returns entry, stop loss and take profit levels. Get advice on
  whether charging for that needs FSCA (or local equivalent) authorisation,
  and keep the "not financial advice" wording visible.

## Getting started from this zip

1. Unzip, then `cd forex-chart-scanner/server && npm install`.
2. Copy `.env.example` to `.env` and fill in the Anthropic and Supabase keys.
3. Follow SUPABASE_SETUP.md.
4. `npm start` and open http://localhost:3000.

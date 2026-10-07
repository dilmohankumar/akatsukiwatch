# AkatsukiWatch

Public monitoring dashboard for Cloudflare, MongoDB, AWS EC2, payments, domains/uptime and Docker logs.
Currently runs on deterministic **demo data**; real APIs plug in per provider.

## Run
    npm run install:all
    npm run dev          # API :4100, web :5173
    # or: docker compose up --build   -> http://localhost:4100

## Architecture
- `server/src/providers/<id>.js` exports `meta` (what's monitorable, credential fields),
  `dashboard(range)` (demo data) and optionally `live(range, creds)` (real API).
- A dashboard is plain JSON: `kpis`, `widgets` (line | bars | toplist | table | logs), `alerts`, `health`.
  The client renders any provider generically, so adding a provider needs no UI work.
- Credentials are bring-your-own: stored in the browser's localStorage, sent as `x-creds`, never persisted server-side.
- Logs: `/api/logs/stream` (SSE). Replace the generator in `server/src/logs.js` with a real tail.

## Going live (per provider)
1. Implement `live(range, creds)` returning the same JSON shape (and `testConnection(creds)`).
2. Run with `DATA_MODE=live`. On failure it falls back to demo data and returns `liveError`.
Sources: Cloudflare GraphQL Analytics, Atlas Admin API, AWS SDK v3 (EC2/CloudWatch/Cost Explorer),
Stripe/Razorpay APIs, GoDaddy Domains API, Docker Engine API via an agent.

## Before exposing publicly
Serve over HTTPS only, add rate limiting, and require read-only keys. Don't log request headers (`x-creds`).

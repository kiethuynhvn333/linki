# Linki

A very good alternative of bitly. Shorten a link, share it, and see how many people clicked. No sign-up: your links are tied to your browser.

Live: https://linki.linki-app.workers.dev

Built on Cloudflare Workers and D1, in plain JavaScript with no runtime dependencies.

Google Analytics loads on Linki's own pages from `GA_ID` at the top of `src/index.js`. Set `GA_ID` to `''` to remove it; short-link redirects are never tracked.

## What it does
- Paste a long URL (and an optional label) to get a short link.
- Short links redirect with a 302. Bots and link previewers are filtered out of the click count.
- "Your links" lists your links with their click counts; each link has a 30-day click chart.
- Short-link visitors aren't tracked with cookies. Unique visits are counted with a daily salted hash.

## Connect an agent

On **Your links**, copy your connector URL (`https://<host>/mcp/<token>`). In Claude: Settings → Connectors → Add custom connector → paste this URL. Cursor and other MCP clients use the same URL.

The connector is read-only and only sees this browser's links. It can list links, show daily clicks for one link, and summarize a date range. Reset on that page rotates the URL, and the old one stops working.

Linki stores a SHA-256 hash of the token. This browser keeps the raw token in a cookie so the page can show the URL again. A deployed database needs the new `mcp_tokens` table:

```
npx wrangler d1 execute linki --remote --file=schema.sql
```

## Run locally
```
npm install
npm run db:local
npm run dev        # http://localhost:8787
```

## Deploy to your own Cloudflare account (free plan)
```
npx wrangler login
npx wrangler d1 create linki          # put the printed database_id in wrangler.toml
npm run db:remote
openssl rand -hex 32 | npx wrangler secret put HASH_SECRET
npx wrangler deploy
```

## Files
- `src/index.js`: the whole app (routes, HTML, CSS, read-only MCP).
- `schema.sql`: the D1 tables.
- `wrangler.toml`: Worker and database config.
- `CHANGES.md`: notes on the current design.

## License
MIT

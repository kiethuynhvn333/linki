# Linki

A very good alternative of bitly. Shorten a link, share it, and see how many people clicked. No sign-up: your links are tied to your browser.

Live: https://linki.ing

Built on Cloudflare Workers and D1, in plain JavaScript with no runtime dependencies. `workers_dev = true` in `wrangler.toml` keeps the workers.dev hostname on as a fallback.

Google Analytics loads on Linki's own pages from `GA_ID` at the top of `src/index.js`. Set `GA_ID` to `''` to remove it. The page after a successful create also sends a `link_created` event. Short-link redirects are never tracked.

## What it does
- Paste a long URL (and an optional label) to get a short link.
- Short links redirect with a 302. Bots and link previewers are filtered out of the click count.
- The home hero shows a decorative preview card (`linki/hello`, a small chart, and 128 clicks). Creating a link replaces it with the real result card.
- "Your links" lists your links with their click counts; each link has a 30-day click chart.
- Short-link visitors aren't tracked with cookies. Unique visits are counted with a daily salted hash.
- Every page uses an SVG favicon of the header cursor, at `/favicon.svg`. `/favicon.ico` serves the same SVG.

## Connect an agent

On **Your links**, copy the connector URL the page shows. On the public site that is `https://linki.ing/mcp/<token>`. In Claude: Settings → Connectors → Add custom connector → paste this URL. Cursor and other MCP clients use the same URL.

The connector is read-only and only sees this browser's links. Its tools are `list_links`, `link_report` (daily clicks for one link; `days` defaults to 30, max 365), and `clicks_summary` (totals over a date range; `days` defaults to 7, max 365). Reset on that page rotates the URL, and the old one stops working.

Linki stores a SHA-256 hash of the token. This browser keeps the raw token in a cookie so the page can show the URL again. A deployed database needs the `mcp_tokens` table:

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
npx wrangler d1 execute linki --remote --file=schema.sql
openssl rand -hex 32 | npx wrangler secret put HASH_SECRET
npx wrangler deploy
```

Self-hosters get their own `<name>.<subdomain>.workers.dev` URL from that deploy. To add a custom domain, put this in `wrangler.toml`:

```
routes = [{ pattern = "example.com", custom_domain = true }]
```

## Files
- `src/index.js`: the whole app (routes, HTML, CSS, favicon, read-only MCP).
- `schema.sql`: the D1 tables.
- `wrangler.toml`: Worker, custom domain, and database config.
- `CHANGES.md`: notes on the current design.

## License
MIT

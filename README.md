# Linki

A very good alternative of bitly. Shorten a link, share it, and see how many people clicked. No sign-up: your links are tied to your browser.

Live: https://linki.ing

Built on Cloudflare Workers and D1, in plain JavaScript with no runtime dependencies. `workers_dev = true` in `wrangler.toml` keeps the workers.dev hostname on as a fallback.

Google Analytics loads on Linki's own pages from `GA_ID` at the top of `src/index.js`. Set `GA_ID` to `''` to remove it. The page after a successful create also sends a `link_created` event. Short-link redirects are never tracked.

## What it does
- Paste a long URL (and an optional label) to get a short link.
- Short links redirect with a 302. Bots and link previewers are filtered out of the click count.
- The home hero shows a decorative preview card (`linki/hello`, a small chart, and 128 clicks). Creating a link replaces it with the real result card.
- "Your links" lists your links with their click counts; each link has a 30-day click chart. Days follow the browser's time zone.
- A link's page has a "Delete link" button. Deleting stops the short link and removes its click history.
- Short-link visitors aren't tracked with cookies. Unique visits are counted with a daily salted hash.
- A browser gets its owner cookie when it creates its first link, and the cookie is renewed on every visit. Visitors who create nothing get no owner cookie.
- Only the homepage is open to search engines. Short links and "Your links" pages are not indexed.
- `http://` and `www.` addresses redirect to the `https://` bare domain.
- Raw click rows are deleted after 400 days by a daily cron. Total and unique counts are kept on the link.
- Every page uses an SVG favicon of the header cursor, at `/favicon.svg`. `/favicon.ico` serves the same SVG.
- The home hero is animated: the click count ticks up, the shapes float and follow the mouse, background shapes drift behind the panel, and example chips scroll under it. All of it stops under `prefers-reduced-motion`.

## Connect an agent

On **Your links**, copy the connector URL the page shows. On the public site that is `https://linki.ing/mcp/<token>`. In Claude: Settings → Connectors → Add custom connector → paste this URL. Cursor and other MCP clients use the same URL.

The connector is read-only and only sees this browser's links. Its tools are `list_links`, `link_report` (daily clicks for one link; `days` defaults to 30, max 365), and `clicks_summary` (totals over a date range; `days` defaults to 7, max 365). Reset on that page rotates the URL, and the old one stops working.

Linki stores a SHA-256 hash of the token. This browser keeps the raw token in a cookie so the page can show the URL again. The connector URL is created the first time you open **Your links** after making a link.

## Run locally
```
npm install
cp .dev.vars.example .dev.vars
npm run db:local   # applies migrations/ to the local database
npm run dev        # http://localhost:8787
```

## Test
```
npm test
```

The tests run the real Worker in Miniflare against an in-memory database built from `migrations/`. GitHub runs them on every pull request (`.github/workflows/ci.yml`).

## Deploy to your own Cloudflare account (free plan)
```
npx wrangler login
npx wrangler d1 create linki          # put the printed database_id in wrangler.toml
npx wrangler d1 migrations apply linki --remote
openssl rand -hex 32 | npx wrangler secret put HASH_SECRET
npx wrangler deploy
```

For later releases, `npm run release` runs the tests, applies any new migrations, and deploys. Apply migrations before deploying: new code expects the new columns. Without `HASH_SECRET` the Worker still runs, but it logs an error and visitor hashes use a public fallback.

Self-hosters get their own `<name>.<subdomain>.workers.dev` URL from that deploy. To add a custom domain, put this in `wrangler.toml`:

```
routes = [{ pattern = "example.com", custom_domain = true }]
```

## Files
- `src/index.js`: the whole app (routes, HTML, CSS, favicon, read-only MCP).
- `migrations/`: the D1 tables, applied in order by `wrangler d1 migrations apply`.
- `test/app.test.js`: end-to-end tests.
- `wrangler.toml`: Worker, custom domains, daily cron, logs, and database config.
- `CHANGES.md`: notes on the current design.

## License
MIT

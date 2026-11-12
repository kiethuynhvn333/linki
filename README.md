# Linki

A very good alternative of bitly. Shorten a link, share it, and see how many people clicked. No sign-up: your links are tied to your browser.

Live: https://linki.linki-app.workers.dev

Built on Cloudflare Workers and D1, in plain JavaScript with no runtime dependencies.

## What it does
- Paste a long URL (and an optional label) to get a short link.
- Short links redirect with a 302. Bots and link previewers are filtered out of the click count.
- "Your links" lists your links with their click counts; each link has a 30-day click chart.
- Visitors aren't tracked with cookies. Unique visits are counted with a daily salted hash.

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
- `src/index.js`: the whole app (routes, HTML, CSS).
- `schema.sql`: the D1 tables.
- `wrangler.toml`: Worker and database config.
- `CHANGES.md`: notes on the current design.

## License
MIT

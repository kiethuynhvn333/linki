# Linki

A very good alternative to bitly. Shorten a link, share it, and see how many people clicked. No sign-up: your links are tied to your browser.

Live: https://linki.ing

Built on Cloudflare Workers and D1, in plain JavaScript with no runtime dependencies. `workers_dev = true` in `wrangler.toml` keeps the workers.dev hostname on as a fallback.

Google Analytics loads on Linki's own pages from `GA_ID` at the top of `src/index.js`. Set `GA_ID` to `''` to remove it. The page after a successful create also sends a `link_created` event. Short-link redirects are never tracked.

## What it does
- Paste a long URL to get a short link.
- Custom names are free: type a name after `linki.ing/` and the link becomes `linki.ing/your-name`. Names use letters, numbers and hyphens, 3 to 40 characters. Spaces, capitals and accents are converted (`Khuyến mãi Tết` becomes `khuyen-mai-tet`), and short links ignore capitals.
- A link address can only lead to one place, so a name goes to whoever takes it first. If the name is taken, the link is still created, with a short ending (`spring-sale-k7`), and the page says so.
- A name can be changed later. Right after creating a link, click the name in the result box, type a new one and save; a link's own page has the same box. If the new name is taken, the page says so and you pick another one (nothing is added automatically). The old address stops working, and the click history moves to the new name. A link with more than 1,000 clicks keeps its name (`RENAME_MAX_CLICKS`).
- Limits on new links: 20 an hour and 50 a day per network address on the website, and 10 an hour and 25 a day per connector for agents (`CREATE_LIMITS` in `src/index.js`).
- Short links redirect with a 302. Bots and link previewers are filtered out of the click count.
- The home hero shows a decorative preview card (`linki.ing/hello`, a small chart, and 128 clicks). It shows the custom name as you type it. Creating a link replaces it with the real result card.
- "Your links" lists your links with their click counts; each link has a 30-day click chart. Days follow the browser's time zone.
- A link's page has a "Delete link" button. Deleting stops the short link and removes its click history.
- Short-link visitors aren't tracked with cookies. Unique visits are counted with a daily salted hash.
- A browser gets its owner cookie when it creates its first link, and the cookie is renewed on every visit. Visitors who create nothing get no owner cookie.
- Only the homepage is open to search engines. Short links and "Your links" pages are not indexed.
- `http://` and `www.` addresses redirect to the `https://` bare domain.
- Raw click rows are deleted after 400 days by a daily cron. Total and unique counts are kept on the link.
- The header logo and the favicon are the same SVG (`LOGO_SVG` in `src/index.js`), served at `/favicon.svg` and `/favicon.ico`.
- The home hero is animated: the click count ticks up, the shapes in the blue card float and follow the mouse, and example chips scroll under it. All of it stops under `prefers-reduced-motion`.
- Under the hero, the homepage lists what Linki offers in four short points (`USPS` in `src/index.js`).

## Use Linki from an AI agent (MCP)

Once you have a link, the home page shows one line under **Recent links** with a **Copy MCP link** button. **Your links** shows the same link below the list. On the public site it is `https://linki.ing/mcp/<token>`. In Claude: Settings → Connectors → Add custom connector → paste the link. Cursor and other MCP clients take the same link.

The connector only sees this browser's links. Its tools are:

- `create_link`: make a short link (`url`, and an optional custom `name`). A connector can create 10 links an hour and 25 a day.
- `list_links`: your links with total clicks and unique visitors.
- `link_report`: daily clicks for one link (`days` defaults to 30, max 365).
- `clicks_summary`: totals over a date range (`days` defaults to 7, max 365).

Anyone who has the MCP link can create links in your list and read your click counts, so treat it like a password. Reset on **Your links** replaces it, and the old link stops working.

Linki stores a SHA-256 hash of the token. This browser keeps the raw token in a cookie so the page can show the link again. The MCP link is created the first time you create a link or open **Your links** with a link in the list.

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

## Staging
`wrangler.toml` has a `staging` environment: a separate Worker (`linki-staging`) with its own database, no custom domain, and `NOINDEX` set so it stays out of search engines. Use it to try a change on a real URL before releasing.

```
npm run release:staging   # tests, staging migrations, deploy to linki-staging.<subdomain>.workers.dev
```

Set its secret once: `openssl rand -hex 32 | npx wrangler secret put HASH_SECRET --env staging`.

## Staging review mode

Staging can show a comment layer, like pins in Figma, so notes on a page can be handed to any AI tool. It stays off unless the staging Worker has a `REVIEW_KEY` secret. Production does not have that secret. Without it the site is unchanged: `/review` routes are the normal 404 page and no comment button is added.

The new tables are additive. Apply them to the staging database, not production:

```
npx wrangler d1 migrations apply linki-staging --env staging --remote
npx wrangler secret put REVIEW_KEY --env staging
npx wrangler deploy --env staging
```

Open `https://<staging-host>/?review=<REVIEW_KEY>` once in the browser you want to comment from. That sets a cookie and sends you back to the same page without the key in the address. A Comment button then sits at the bottom right of every page. Click it, click an element, and write the note. @mentions such as @Claude are kept as text and also stored so an agent can filter on them.

The shared inbox is `https://<staging-host>/review/agent/<REVIEW_KEY>`. Paste that URL into Claude, Cursor, ChatGPT, Codex, or Grok Bot and ask it to read the page. The page is markdown. Add `?format=json` for JSON, or filter with `?status=open&mention=Claude&path=/links`. A browser address bar shows the same text as plain text.

Agents that speak MCP can POST to `https://<staging-host>/mcp-review/<REVIEW_KEY>`. The tools are `list_comments`, `get_comment`, `update_comment`, and `reply`. An agent that can only POST JSON can use `POST /review/agent/<REVIEW_KEY>/comments/<id>` with `{status, note, pr_url, assignee}` and `.../reply` with `{body, author}`.

Work a comment like this: read it, make a branch and a pull request, mark it `in_progress`, then `fixed` with the pull request URL. Never push to main. Kiet approves merges.

The panel's "Copy agent link" copies the inbox URL and one line: "Read this, fix open comments in the Linki repo, open a PR, mark them fixed."

To try it locally, put a throwaway `REVIEW_KEY` in `.dev.vars` (that file stays uncommitted), apply the migrations with `--env staging --local`, and run `npx wrangler dev --env staging --local`. Leave `REVIEW_KEY` unset to match production.

## Files
- `src/index.js`: the whole app (routes, HTML, CSS, favicon, MCP).
- `migrations/`: the D1 tables, applied in order by `wrangler d1 migrations apply`.
- `test/app.test.js`: end-to-end tests.
- `wrangler.toml`: Worker, custom domains, daily cron, logs, and database config.
- `CHANGES.md`: notes on the current design.

## License
MIT

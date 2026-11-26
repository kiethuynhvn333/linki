# Linki

A very good alternative to bitly. Shorten a link, share it, and see how many people clicked. No sign-up: your links are tied to your browser.

Live: https://linki.ing

Built on Cloudflare Workers and D1, in plain JavaScript with no runtime dependencies. `workers_dev = true` in `wrangler.toml` keeps the workers.dev hostname on as a fallback.

Google Analytics loads on Linki's own pages from `GA_ID` at the top of `src/index.js`. Set `GA_ID` to `''` to remove it. The page after a successful create also sends a `link_created` event. A browser whose owner cookie is listed in `UNLIMITED_OWNERS` loads Analytics with `traffic_type: 'internal'`, so GA4's Internal Traffic filter can drop that browser. A request from a known data-center network does not load Analytics at all. Short-link redirects are never tracked.

## What it does
- Paste a long URL to get a short link.
- Custom names are free: type a name after `linki.ing/` and the link becomes `linki.ing/your-name`. Names use letters, numbers and hyphens, 3 to 40 characters. Spaces, capitals and accents are converted (`Khuyến mãi Tết` becomes `khuyen-mai-tet`), and short links ignore capitals.
- A link address can only lead to one place, so a name goes to whoever takes it first. If the name is taken, the link is still created, with a short ending (`spring-sale-k7`), and the page says so.
- A name can be changed later. Right after creating a link, click the name in the result box, type a new one and save; a link's own page has the same box. If the new name is taken, the page says so and you pick another one (nothing is added automatically). The old address keeps working and forwards to the new one, and the click history moves to the new name. A link with more than 1,000 clicks keeps its name (`RENAME_MAX_CLICKS`).
- A name is never given out again. After a rename, the old address forwards to the current one. After a delete, that name and its older names show the not-found page, and nobody can claim them. The owner of a link can rename it back to one of that link's own old names.
- Limits on new links: 20 an hour and 50 a day per network address on the website, and 10 an hour and 25 a day per connector for agents (`CREATE_LIMITS` in `src/index.js`).
- Short links redirect with a 302. Bots and link previewers are not stored as clicks. A stored click is labeled `human`, `datacenter` or `internal`. Your links and the connector reports count human clicks, plus older clicks that have no label.
- The home hero shows a decorative preview card (`linki.ing/hello`, a small chart, and 128 clicks). It shows the custom name as you type it. Creating a link replaces it with the real result card.
- "Your links" lists your links with their click counts; each link has a 30-day click chart. Days follow the browser's time zone.
- A link's page has a "Delete link" button. Deleting stops the short link, removes its click history, and retires the name. Older names that forwarded to it stop working too.
- Short-link visitors aren't tracked with cookies. Unique visits are counted with a daily salted hash.
- A browser gets its owner cookie when it creates its first link, and the cookie is renewed on every visit. Visitors who create nothing get no owner cookie.
- Only the homepage is open to search engines. Short links and "Your links" pages are not indexed.
- `http://` and `www.` addresses redirect to the `https://` bare domain.
- Raw click rows are deleted after 400 days by a daily cron. Total and unique counts are kept on the link.
- The header logo and the favicon are the same SVG (`LOGO_SVG` in `src/index.js`), served at `/favicon.svg` and `/favicon.ico`. The same mark is a PNG at `/apple-touch-icon.png` (180×180) and `/icon-512.png`.
- Sharing a Linki page, including the homepage with a query string, shows a preview card. The graphic is `/og.png` (1200×630). `og:url` and the canonical URL stay on the homepage without the query. Rebuild the PNGs with `./scripts/render-og.sh` after editing `assets/og.svg`.
- The home hero is animated: the click count ticks up, the shapes in the blue card float and follow the mouse, and example chips scroll under it. All of it stops under `prefers-reduced-motion`.
- Under the hero, the homepage lists what Linki offers in four short points (`USPS` in `src/index.js`).

## Use Linki from an AI agent (MCP)

Claude and ChatGPT connect to one address, `https://linki.ing/mcp` (on another host it is that host's `/mcp`). The first request without a token answers 401 and points at the OAuth metadata. The app registers, sends you to an approval page on this site, and you choose Allow. That approves the links saved in this browser. There is no account and no password. If the browser has no links yet, the approval page says so. Connected apps are listed under **Your links**, and Revoke removes their tokens.

The older per-browser address still works. Once you have a link, the home page shows one line under **Recent links** with a **Copy MCP link** button. **Your links** shows the same link below the list. On the public site it is `https://linki.ing/mcp/<token>`. In Claude: Settings → Connectors → Add custom connector → paste the link. Cursor and other MCP clients take the same link.

How to connect, what each tool does, the privacy policy, and support are at `/docs/mcp`, `/privacy`, and `/support`. The square icon is `/icon.svg` and `/icon-512.png` (also `/icon.png`).

The connector only sees this browser's links. Its tools are:

- `list_links`: your links with total clicks and unique visitors. Both counts are people only.
- `link_report`: daily clicks for one link (`days` defaults to 30, max 365). People only. `excluded` shows bot, datacenter and internal clicks that were left out. `include_all: true` also returns a total for each label.
- `clicks_summary`: totals over a date range (`days` defaults to 7, max 365). Same people-only rule, same `excluded` counts, and the same `include_all` option.
- `create_link`: make a short link (`url`, optional `name`, optional UTM tags, optional `campaign`). A connector can create 10 links an hour and 25 a day.
- `save_campaign`: save or update a named set of tags for this connector (`utm_source`, `utm_medium`, `utm_campaign`, optional `utm_content_pattern`, optional `notes`). At most 50. Nothing is deleted.
- `list_campaigns` and `get_campaign`: read those saved campaigns.

Before it creates a link, the agent asks one question: "Want to track clicks from this link? Where are you sharing it and what's it for?" No means a plain link and no further questions. Yes means a short conversation in plain words: where you are sharing it, what kind of post, which campaign, and how to tell versions apart (for example a1h1 for angle 1 hook 1). If a saved campaign fits, the agent offers it in one line. After a tracked link, it can offer to save that setup.

An explicit tag wins over a saved campaign, which wins over a tag already in the URL. Values are trimmed, lowercased and URL-encoded. The rest of the query and the fragment stay, and a tag is not written twice. If `utm_content` is left out while other tags or a campaign are used, and the URL does not already have one, it becomes the short name. `utm_content_pattern` (for example `a{angle}h{hook}-{lang}`) is naming guidance the agent follows. It is stored and returned as text. Saved campaigns live in the `campaigns` table (`migrations/0005_campaigns.sql`). `migrations/0006_traffic.sql` adds `links.created_via` (`web` or `mcp`), `links.traffic`, and `clicks.traffic`. Existing rows stay empty, which means unknown, and reports count those clicks with people. Apply migrations before deploying this Worker.

Anyone who has the MCP link can create links in your list and read your click counts, so treat it like a password. Reset on **Your links** replaces it, and the old link stops working. An OAuth app is separate: revoking it does not reset the MCP link, and resetting the MCP link does not disconnect an app.

Linki stores a SHA-256 hash of the connector token, and the same for OAuth codes, access tokens, and refresh tokens. This browser keeps the raw connector token in a cookie so the page can show the link again. The MCP link is created the first time you create a link or open **Your links** with a link in the list. OAuth access tokens last one hour. Refresh tokens last 90 days and are replaced on each use. Approval codes last 10 minutes.

`migrations/0007_oauth.sql` adds `oauth_clients`, `oauth_consents`, `oauth_codes`, and `oauth_tokens`. It does not change existing tables. Apply it before deploying this Worker. The daily cron also deletes expired rows from those new tables.

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

Owners named in the `UNLIMITED_OWNERS` secret skip the hourly and daily limits, on the website and through the connector. Everyone else keeps the limits above. Set it with `npx wrangler secret put UNLIMITED_OWNERS`. The value is a comma-separated list of owner IDs (the same values stored in `links.owner_id` and `mcp_tokens`). Spaces around each ID are ignored, and empty entries are ignored. Leave the secret unset or empty and behaviour is unchanged. Do not add it under `[vars]` in `wrangler.toml`.

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
- `assets/`: the share image (`og.svg`, `og.png`), the PNG icons, and the Bricolage Grotesque subset used to draw the wordmark. `scripts/render-og.sh` rebuilds the PNGs.
- `migrations/`: the D1 tables, applied in order by `wrangler d1 migrations apply`. `schema.sql` is the same tables, written so it can be applied more than once.
- `test/app.test.js`: end-to-end tests.
- `wrangler.toml`: Worker, custom domains, daily cron, logs, and database config.
- `CHANGES.md`: notes on the current design.

## License
MIT

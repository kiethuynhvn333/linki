# Free custom names and links from agents (14 Nov 2026)

From Kiet's review comments #1, #2 and #3 on staging.

- **Custom names (free).** The label box on the home form is replaced by a name box that starts with `linki.ing/`. What you type becomes the short link: `linki.ing/your-name`. Names are letters, numbers and hyphens, 3 to 40 characters. Spaces, capitals and accents are converted, and short links ignore capitals. The preview card shows the name as you type.
- **A taken name is not an error.** A link address can only lead to one place, so two people cannot both own `linki.ing/hello`. The second person gets the name plus a short ending (`hello-k7`), and the result card says so and points to the name box. Linki's own paths (`links`, `mcp`, and others in `RESERVED`) are handled the same way.
- **Rename.** The name in the result card can be edited in place: click it, type, Save (`POST /links/:code/rename`). A link's page has the same box above Delete. A taken name gives a message and the owner picks another; no ending is added. The old address stops working. Click rows move to the new name in one transaction, so a link with more than 1,000 clicks keeps its name (`RENAME_MAX_CLICKS`): a rename rewrites every click row, and the free plan allows 100,000 row writes a day. A visitor who clicked before the rename counts as a new unique visitor for the rest of that day.
- **Labels.** New links have no label. Links that already have one keep it.
- **Selling points.** Paste and go, Free custom links, No sign-up, MCP-ready. "See every click" is removed.
- **MCP entry point.** The hero has no MCP element. On the home page, one line under Recent links copies the MCP link (`mcpLine`). On Your links, the section is renamed "Use Linki from your AI agent (MCP)", sits below the list, and is smaller and quieter than the links.
- **Agents can create links.** The connector has a new `create_link` tool (`url`, optional `name`). It is no longer read-only.
- **Limits** (`CREATE_LIMITS`): the website allows 20 new links an hour and 50 a day per network address (it was 20 an hour with no daily cap, so up to 480 a day). A connector allows 10 an hour and 25 a day. Agents call from their vendor's servers, so the connector limit is counted per connector, not per address.
- No database change. A custom name is stored in `links.code`.

# Home page refresh (14 Nov 2026)

- **Headline:** "a very good alternative to bitly".
- **Logo:** a white cursor on a cobalt tile with the pink and mustard shapes of the hero card. The header and the favicon use the same SVG (`LOGO_SVG`), so they cannot drift apart.
- **Hero motion:** the click count ticks up, the bars grow in, the shapes inside the blue card float and follow the mouse, and example chips scroll under the hero. Nothing moves under `prefers-reduced-motion`.
- **Selling points:** four short points under the hero (`USPS`): Paste and go, No sign-up, See every click, Agent-ready. They replace the footer statement, which is removed from every page. Google Analytics is still documented in the README.

# Back-end hardening (13 Nov 2026)

Fixes from a code audit. Each one has a test in `test/app.test.js`.

## Fixed
- **Database writes on plain visits.** Opening Your links without a cookie created a connector row every time. A connector is now created only for an owner who has a link.
- **Owner cookie expiry.** The cookie was set once and expired after a year. It is now renewed on every visit. First-time visitors get it when they create a link, not on page load.
- **HTTPS.** `http://` and `www.` requests get a 301 to the `https://` bare domain. Pages send `Strict-Transport-Security`, a `Content-Security-Policy` (scripts need a per-response nonce), and `X-Frame-Options: DENY`.
- **Missing `HASH_SECRET`.** The fallback is no longer silent: the Worker logs an error. Logs are kept (`[observability]` in `wrangler.toml`).
- **Stats cost.** All-time unique clicks are stored on the link (`links.unique_count`), so pages no longer re-count every click. Raw click rows older than 400 days are deleted by a daily cron.
- `HEAD` requests get the same status as `GET` (the homepage used to answer 404).
- A request body that is not a form gets a 400 instead of a 500.
- Destinations with a username or password (`https://bank.com@evil.example`) are refused.
- Form posts from another site are refused (Origin check).
- The bot filter also catches common HTTP libraries and more crawlers.

## Added
- **Delete link** on the link's page (`POST /links/:code/delete`). It removes the link and its clicks.
- **Local days.** The page script stores the browser's UTC offset in a `tz` cookie. "Today" and the chart use it. Connector (MCP) reports stay in UTC.
- **Search engines.** The homepage is indexable, with a description, canonical URL and Open Graph tags. `robots.txt` allows only `/`.
- `www.linki.ing` as a second custom domain. It redirects to `linki.ing`.
- Database migrations in `migrations/` (replaces `schema.sql`), tests, and a CI workflow.

## Releasing this change
Run `npm run release`, or by hand: `npx wrangler d1 migrations apply linki --remote`, then `npx wrangler deploy`. The migration adds `links.unique_count` and fills it from existing clicks. The old code keeps working after the migration, so apply it first.

# Custom domain and favicon (12 Nov 2026)

## Custom domain
`wrangler.toml` serves the Worker at `linki.ing`:

```
workers_dev = true
routes = [
  { pattern = "linki.ing", custom_domain = true }
]
```

`workers_dev` stays on, so the workers.dev hostname remains a fallback. The public URL is https://linki.ing.

## Favicon
`src/index.js` serves an SVG of the header cursor (blue `#2665D6`, pink `#E9C0E9`, mustard `#D2A72A`) at `/favicon.svg` and `/favicon.ico`. Every HTML page links `/favicon.svg`.

# v3: style 5 "Playful blocks" (12 Nov 2026)

Implements ../SPEC-style5-playful-blocks.md. Built from v2. Only the presentation layer of src/index.js changed: CSS, and the HTML strings in homePage, linksPage, detailPage, linkList, messagePage and page. JS is unchanged from v2. Routes, field names, redirect, bot filtering, validation, cookie, SQL and schema are untouched. Evidence is in ../evidence-v3/function-check.txt (every logic function and constant is identical to original/) and in index-vs-original.diff.

## What changed
- New tokens for light and dark: paper, surface, pressed, ink, on-ink, muted, line, line-soft, zero, accent, accent-text, pink, mustard, maroon and danger.
- Fonts: Bricolage Grotesque (display), Inter (UI) and Space Mono (links), in one Google Fonts request.
- Header: brand dot plus the "Link tracker" wordmark, and a "Your links" pill. The pill gets aria-current and the pressed fill on /links and /links/:code.
- Content sits in one white rounded panel (26px radius) on the grey page.
- Home:
  - Two-column hero (form, then the cobalt result card) when a link was just created. Otherwise one column, max 640px.
  - Cobalt result card with a white short-URL field, a "Copy link" button and the pink and mustard shapes. On mobile the mustard shape is hidden and the pink one moves to the corner.
- List:
  - A coloured letter tile on each row (accent, pink, mustard, maroon, ink), with the first letter escaped through esc().
  - Title, mono chip, "Today" or "11 Nov" date, count with a "click"/"clicks" caption, and a secondary Copy button.
  - Empty state: dashed box with "Create your first link".
- Detail:
  - Title row with a short-URL pill and the primary Copy button.
  - Three colour stat tiles (cobalt, pink, mustard) that stay three across on mobile.
  - Pill-bar chart: 8px stubs on zero days, and today's bar in accent with a ring. Peak pill and "Today · N" axis.
- Message pages: the status number on a cobalt block, title, one sentence, and a "Go to the homepage" button.
- Motion is all inside prefers-reduced-motion: no-preference. Buttons lift 1px, the result card pops in, bars grow.
- CSS is 164 lines.

## Deviations from the spec (and why)
1. **The readonly short-URL fields drop "https://"** (for example `localhost:8788/c2j3fd`). data-copy and the clipboard still hold the full URL. Without this, the 24px mono field on the result card cut off the code, which is the part that matters.
2. **The result-card short URL is 22px on desktop and 18px on mobile, instead of 24px and 19px.** At 24px the URL still didn't fit next to the shapes.
3. **On mobile the list chip shows only "/code".** The host is hidden with `.chip .host{display:none}`, because at 360px the chip otherwise cut off right before the code.
4. **On mobile the detail URL pill uses 13px text**, and its input and Copy button are 44px tall (Copy padding 0 18px). That's so "localhost:8788/j9agvf" fits beside the button and every tap target is 44px.
5. **Counts use thousands separators** (1,184) via toLocaleString('en-US'), to match the mockup.
6. **Inter 700 is added to the font request**, because the spec's "Copy link" button is weight 700.
7. **List rows get 12px horizontal padding with a -12px margin** (8px on mobile), so the --paper hover background doesn't touch the text.
8. **The only control under 44px at 360 is the "Goes to <url>" link on the detail page.** It's an inline text link inside a sentence, which WCAG 2.5.8 exempts.

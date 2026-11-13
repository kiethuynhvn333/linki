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

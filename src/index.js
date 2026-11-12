// Link tracker: create short links, redirect, count clicks.
// One Cloudflare Worker + one D1 database. No framework.

const GA_ID = 'G-MEBVJJ00K8'; // set to '' to disable Google Analytics on Linki's pages
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i, l, o, 0, 1
const CODE_LENGTH = 6;
const RESERVED = new Set(['links', 'create', 'api', 'admin', 'static']);
const MAX_URL_LENGTH = 2048;
const MAX_LABEL_LENGTH = 80;
const CREATE_LIMIT_PER_HOUR = 20;
const CHART_DAYS = 30;
const BOT_RE =
  /bot|crawl|spider|slurp|facebookexternalhit|whatsapp\/|preview|curl|wget|python|headless|pingdom|uptime/i;
const BLOCKED_SCHEME_RE = /^(javascript|data|vbscript|file|mailto|tel|blob|about):/i;

// Same cursor shape and colours as the .brand logo.
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2665D6"/><stop offset=".55" stop-color="#E9C0E9"/><stop offset="1" stop-color="#D2A72A"/></linearGradient></defs><polygon fill="url(#g)" points="4,0 4,20.16 8.8,15.36 12.2,24 15.8,22.08 12.6,13.92 20,13.92"/></svg>';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (path === '/' && method === 'GET') return homePage(request, env, url);
      if (path === '/create' && method === 'POST') return createLink(request, env, url);
      if (path === '/links' && method === 'GET') return linksPage(request, env, url);
      if (path === '/mcp/reset') return resetMcp(request, env, url);
      if (path.startsWith('/mcp/')) return mcpEndpoint(request, env, url);
      if (path === '/favicon.svg' || path === '/favicon.ico') return new Response(FAVICON_SVG, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
      if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n');
      const detail = path.match(/^\/links\/([a-z0-9]{4,12})$/);
      if (detail && method === 'GET') return detailPage(request, env, url, detail[1]);
      const short = path.match(/^\/([a-z0-9]{4,12})$/);
      if (short && (method === 'GET' || method === 'HEAD')) {
        return redirect(request, env, ctx, short[1]);
      }
      return messagePage(404, 'Page not found', 'There is nothing at this address.');
    } catch (err) {
      console.error(err);
      return messagePage(500, 'Something went wrong', 'Please try again in a moment.');
    }
  },
};

// ---------- redirect ----------

async function redirect(request, env, ctx, code) {
  const link = await env.DB.prepare('SELECT destination, status FROM links WHERE code = ?')
    .bind(code)
    .first();
  if (!link) {
    return messagePage(404, 'Link not found', 'This short link does not exist.');
  }
  if (link.status !== 'active') {
    return messagePage(410, 'Link unavailable', 'This short link has been turned off.');
  }
  if (shouldCount(request)) {
    ctx.waitUntil(recordClick(request, env, code));
  }
  // 302 + no-store so browsers never cache the redirect and every click is counted.
  return new Response(null, {
    status: 302,
    headers: { Location: link.destination, 'Cache-Control': 'no-store' },
  });
}

function shouldCount(request) {
  if (request.method !== 'GET') return false;
  const ua = request.headers.get('User-Agent') || '';
  if (!ua || BOT_RE.test(ua)) return false;
  const purpose =
    (request.headers.get('Sec-Purpose') || '') + (request.headers.get('Purpose') || '');
  if (/prefetch|preview/i.test(purpose)) return false;
  return true;
}

async function recordClick(request, env, code) {
  const now = Math.floor(Date.now() / 1000);
  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ua = request.headers.get('User-Agent') || '';
  // The raw IP is never stored. The hash changes every day, so a visitor
  // cannot be followed across days.
  const visitor = (await sha256(`${secret(env)}|${day}|${code}|${ip}|${ua}`)).slice(0, 32);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO clicks (code, ts, visitor_hash) VALUES (?, ?, ?)').bind(
      code,
      now,
      visitor
    ),
    env.DB.prepare('UPDATE links SET click_count = click_count + 1 WHERE code = ?').bind(code),
  ]);
}

// ---------- create ----------

async function createLink(request, env, url) {
  const owner = getOwner(request);
  const form = await request.formData();
  const rawUrl = String(form.get('url') || '').trim();
  const label = String(form.get('label') || '').trim().slice(0, MAX_LABEL_LENGTH);

  const checked = checkDestination(rawUrl, url.hostname);
  if (checked.error) {
    return homePage(request, env, url, { error: checked.error, rawUrl, label, status: 400 });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const creatorHash = (await sha256(`${secret(env)}|creator|${ip}`)).slice(0, 32);
  const now = Math.floor(Date.now() / 1000);
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM links WHERE creator_hash = ? AND created_at > ?'
  )
    .bind(creatorHash, now - 3600)
    .first();
  if (recent.n >= CREATE_LIMIT_PER_HOUR) {
    return homePage(request, env, url, {
      error: 'You have created a lot of links in the last hour. Please try again later.',
      rawUrl,
      label,
      status: 429,
    });
  }

  let code = null;
  for (let attempt = 0; attempt < 5 && !code; attempt++) {
    const candidate = randomCode();
    if (RESERVED.has(candidate)) continue;
    try {
      await env.DB.prepare(
        'INSERT INTO links (code, owner_id, destination, label, created_at, creator_hash) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(candidate, owner.id, checked.destination, label || null, now, creatorHash)
        .run();
      code = candidate;
    } catch (err) {
      if (!/UNIQUE|constraint/i.test(String(err && err.message))) throw err;
    }
  }
  if (!code) throw new Error('Could not generate a unique code');

  const headers = new Headers({ Location: `/?new=${code}` });
  setOwnerCookie(headers, owner, url);
  return new Response(null, { status: 303, headers });
}

function checkDestination(raw, ownHost) {
  if (!raw) return { error: 'Paste a URL first.' };
  if (raw.length > MAX_URL_LENGTH) return { error: 'That URL is too long.' };
  if (BLOCKED_SCHEME_RE.test(raw)) return { error: 'Only http and https links are supported.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { error: 'That does not look like a valid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Only http and https links are supported.' };
  }
  if (!parsed.hostname.includes('.')) {
    return { error: 'That does not look like a valid URL.' };
  }
  if (parsed.hostname === ownHost) {
    return { error: 'A short link cannot point back to this site.' };
  }
  if (parsed.href.length > MAX_URL_LENGTH) return { error: 'That URL is too long.' };
  return { destination: parsed.href };
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

// ---------- pages ----------

async function homePage(request, env, url, state = {}) {
  const owner = getOwner(request);
  const links = await listLinks(env, owner.id, 5);
  let created = '';
  const newCode = url.searchParams.get('new');
  if (!state.error && newCode && /^[a-z0-9]{4,12}$/.test(newCode)) {
    const link = links.find((l) => l.code === newCode);
    if (link) {
      const shortUrl = `${url.origin}/${link.code}`;
      created = `
      <section class="rc" aria-live="polite">
        <p class="cap">Your short link is ready</p>
        <input class="short" type="text" readonly value="${esc(shortUrl.replace(/^https?:\/\//, ''))}" aria-label="Short link">
        <p class="go">Goes to ${esc(truncate(link.destination, 70))}</p>
        <button type="button" class="cl" data-copy="${esc(shortUrl)}">Copy link</button>
      </section>`;
    }
  }
  const error = state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : '';
  const preview = `
      <div class="rc pv" aria-hidden="true">
        <p class="cap">Your short link</p>
        <p class="ex">linki/hello</p>
        <div class="foot">
          <div class="bars"><span style="height:34%"></span><span style="height:55%"></span><span style="height:42%"></span><span style="height:70%"></span><span style="height:48%"></span><span style="height:84%"></span><span style="height:100%"></span></div>
          <p class="n">128 <small>clicks</small></p>
        </div>
      </div>`;
  const body = `
    <div class="hero${created ? ' has' : ''}">
      <section>
        <h1>a very good alternative of <span class="hl">bitly</span></h1>
        <p class="lede">Paste a URL, get a short link, see who clicks. No sign-up.</p>
        <form method="post" action="/create" class="create">
          <label class="sr" for="url">Destination URL</label>
          <input id="url" name="url" type="text" inputmode="url" autocomplete="off" autofocus required
            placeholder="Paste a long URL" maxlength="${MAX_URL_LENGTH}" value="${esc(state.rawUrl || '')}">
          <label class="sr" for="label">Label (optional)</label>
          <input id="label" name="label" type="text" autocomplete="off"
            placeholder="Label (optional), e.g. LinkedIn post Nov 11" maxlength="${MAX_LABEL_LENGTH}" value="${esc(state.label || '')}">
          <button class="primary" type="submit">Create link</button>
        </form>
        ${error}
      </section>
      ${created || preview}
    </div>
    ${
      links.length
        ? `<section>
            <div class="sectionhead"><h2>Recent links</h2><a href="/links">See all</a></div>
            ${linkList(links, url.origin)}
          </section>`
        : ''
    }`;
  return page('Linki', body, {
    owner,
    url,
    status: state.status || 200,
    linkCreated: Boolean(created),
  });
}

async function linksPage(request, env, url) {
  const owner = getOwner(request);
  const [links, mcp] = await Promise.all([
    listLinks(env, owner.id, 200),
    connectorForOwner(request, env, owner.id),
  ]);
  const body = `
    <div class="sectionhead top"><h1>Your links</h1><a class="button secondary" href="/">New link</a></div>
    ${
      links.length
        ? linkList(links, url.origin)
        : '<div class="empty"><p>No links yet</p><a class="button primary" href="/">Create your first link</a></div>'
    }
    ${agentSection(mcp, url)}`;
  return page('Your links', body, { owner, url, mcpToken: mcp.token || undefined });
}

function agentSection(mcp, url) {
  const connectorUrl = mcp.token ? `${url.origin}/mcp/${mcp.token}` : '';
  const hint = mcp.token
    ? 'In Claude: Settings → Connectors → Add custom connector → paste this URL.'
    : 'Reset to issue a new connector URL. The old URL stops working.';
  const urlRow = connectorUrl
    ? `<div class="up">
        <input class="short" type="text" readonly spellcheck="false" aria-label="Connector URL" title="${esc(connectorUrl)}" value="${esc(connectorUrl)}">
        <button type="button" class="primary" data-copy="${esc(connectorUrl)}">Copy</button>
      </div>`
    : '';
  return `
    <section class="agent" aria-labelledby="agent-h">
      <div class="agenthead">
        <h2 id="agent-h">Connect an agent</h2>
        <form method="post" action="/mcp/reset"><button class="secondary" type="submit">Reset</button></form>
      </div>
      <p class="hint">${esc(hint)}</p>
      ${urlRow}
    </section>`;
}

async function detailPage(request, env, url, code) {
  const owner = getOwner(request);
  const link = await env.DB.prepare(
    'SELECT code, destination, label, status, click_count, created_at FROM links WHERE code = ? AND owner_id = ?'
  )
    .bind(code, owner.id)
    .first();
  if (!link) {
    return messagePage(404, 'Link not found', 'This link is not in your list.');
  }

  const today = Math.floor(Date.now() / 86400000); // days since epoch, UTC
  const since = (today - (CHART_DAYS - 1)) * 86400;
  const [uniqueRow, daily] = await Promise.all([
    env.DB.prepare('SELECT COUNT(DISTINCT visitor_hash) AS n FROM clicks WHERE code = ?')
      .bind(code)
      .first(),
    env.DB.prepare(
      `SELECT ts / 86400 AS day, COUNT(*) AS clicks, COUNT(DISTINCT visitor_hash) AS uniques
       FROM clicks WHERE code = ? AND ts >= ? GROUP BY day`
    )
      .bind(code, since)
      .all(),
  ]);
  const byDay = new Map(daily.results.map((r) => [r.day, r]));
  const days = [];
  for (let d = today - (CHART_DAYS - 1); d <= today; d++) {
    const row = byDay.get(d);
    days.push({ day: d, clicks: row ? row.clicks : 0, uniques: row ? row.uniques : 0 });
  }
  const last30 = days.reduce((sum, d) => sum + d.clicks, 0);
  const max = Math.max(1, ...days.map((d) => d.clicks));
  const shortUrl = `${url.origin}/${link.code}`;

  const bars = days
    .map((d) => {
      const pct = d.clicks ? Math.max(4, Math.round((d.clicks / max) * 100)) : 0;
      const tip = `${formatDay(d.day)}: ${plural(d.clicks, 'click')}, ${d.uniques} unique`;
      const cls = d.day === today ? ' today' : d.clicks ? '' : ' zero';
      return `<div class="bar${cls}" title="${esc(tip)}"><span style="height:${pct}%"></span></div>`;
    })
    .join('');

  const body = `
    <p class="back"><a href="/links">&larr; All links</a></p>
    <div class="dtop">
      <div>
        <h1>${esc(link.label || link.code)}</h1>
        <p class="meta dest">Goes to <a href="${esc(link.destination)}" rel="noopener noreferrer nofollow" target="_blank">${esc(truncate(link.destination, 90))}</a> · Created ${formatDate(link.created_at)}</p>
      </div>
      <div class="up">
        <input class="short" type="text" readonly value="${esc(shortUrl.replace(/^https?:\/\//, ''))}" aria-label="Short link">
        <button type="button" class="primary" data-copy="${esc(shortUrl)}">Copy</button>
      </div>
    </div>

    <div class="stats">
      <div class="stat t1"><span class="label">Total clicks</span><span class="num">${link.click_count.toLocaleString('en-US')}</span></div>
      <div class="stat t2"><span class="label">Unique clicks</span><span class="num">${uniqueRow.n.toLocaleString('en-US')}</span></div>
      <div class="stat t3"><span class="label">Last ${CHART_DAYS} days</span><span class="num">${last30.toLocaleString('en-US')}</span></div>
    </div>

    <section class="chartcard">
      <div class="chh"><h2>Clicks per day</h2><span class="pk">Peak ${plural(max === 1 && last30 === 0 ? 0 : max, 'click')}</span></div>
      <div class="chart" role="img" aria-label="Clicks per day for the last ${CHART_DAYS} days, ${last30} in total">${bars}</div>
      <div class="axis"><span>${formatDay(days[0].day)}</span><span>Today · ${days[days.length - 1].clicks}</span></div>
    </section>
    <p class="note">Days are in UTC. Unique clicks count each visitor once per day; link previews and known bots are not counted.</p>`;
  return page(link.label || link.code, body, { owner, url });
}

async function listLinks(env, ownerId, limit) {
  const { results } = await env.DB.prepare(
    'SELECT code, destination, label, status, click_count, created_at FROM links WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
  )
    .bind(ownerId, limit)
    .all();
  return results;
}

function linkList(links, origin) {
  const host = origin.replace(/^https?:\/\//, '');
  const todayNum = Math.floor(Date.now() / 86400000);
  return `<ul class="links">${links
    .map((l, i) => {
      const shortUrl = `${origin}/${l.code}`;
      const name = l.label || l.destination.replace(/^https?:\/\/(www\.)?/i, '');
      const letter = (Array.from(name)[0] || '#').toUpperCase();
      const dayNum = Math.floor(l.created_at / 86400);
      return `
      <li>
        <a class="rowmain" href="/links/${l.code}">
          <span class="t t${(i % 5) + 1}" aria-hidden="true">${esc(letter)}</span>
          <span class="rowtext"><span class="title">${esc(l.label || truncate(l.destination, 50))}</span>
          <span class="chip"><span class="host">${esc(host)}</span>/${l.code}</span></span>
        </a>
        <span class="date">${dayNum === todayNum ? 'Today' : formatDay(dayNum)}</span>
        <span class="count"><span class="num">${l.click_count.toLocaleString('en-US')}</span><span class="cc">${l.click_count === 1 ? 'click' : 'clicks'}</span></span>
        <button type="button" class="secondary" data-copy="${esc(shortUrl)}" aria-label="Copy ${esc(shortUrl)}">Copy</button>
      </li>`;
    })
    .join('')}</ul>`;
}

function messagePage(status, title, text) {
  const body = `<section class="msg"><p class="status">${status}</p><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p><a class="button secondary" href="/">Go to the homepage</a></section>`;
  return page(title, body, { status });
}

function gaHead(linkCreated) {
  if (!GA_ID) return '';
  const event = linkCreated ? "\n  gtag('event', 'link_created');" : '';
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GA_ID}');${event}
</script>
`;
}

function page(title, body, { owner, url, status = 200, linkCreated = false, mcpToken } = {}) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${gaHead(linkCreated)}<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Inter:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap">
<style>${CSS}</style>
</head>
<body>
<header><a class="brand" href="/">Linki</a><nav><a class="pill" href="/links"${url && url.pathname.startsWith('/links') ? ' aria-current="page"' : ''}>Your links</a></nav></header>
<main class="panel">${body}</main>
<footer><p>Links are tied to this browser. No sign-up. Short-link visitors are never tracked with cookies; Linki's own pages use Google Analytics.</p></footer>
<script>${JS}</script>
</body>
</html>`;
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  if (owner && url) setOwnerCookie(headers, owner, url);
  if (mcpToken && url) setMcpCookie(headers, mcpToken, url);
  return new Response(html, { status, headers });
}

// ---------- owner cookie ----------

function getOwner(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)owner=([a-f0-9]{32})(?:;|$)/);
  if (match) return { id: match[1], isNew: false };
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { id, isNew: true };
}

function setOwnerCookie(headers, owner, url) {
  if (!owner.isNew) return;
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  headers.append(
    'Set-Cookie',
    `owner=${owner.id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`
  );
}

function setMcpCookie(headers, token, url) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  headers.append(
    'Set-Cookie',
    `mcp=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`
  );
}

function cookieValue(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0 && trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return '';
}

// ---------- mcp ----------

const MCP_TOOLS = [
  {
    name: 'list_links',
    description:
      "List this connector's short links: slug, short URL, destination, label, created date, total clicks, and unique visitors. Unique visitors are counted once per link per day.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'link_report',
    description:
      'Clicks and unique visitors per UTC day for one link. days defaults to 30 (max 365). Referrers and countries are not stored.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Short link code, for example abc123.' },
        days: {
          type: 'integer',
          minimum: 1,
          maximum: 365,
          description: 'UTC days to include, ending today. Default 30.',
        },
      },
      required: ['slug'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'clicks_summary',
    description:
      "Click and unique-visitor totals for all of this connector's links over a UTC range, plus a per-link breakdown. days defaults to 7 (max 365).",
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 1,
          maximum: 365,
          description: 'UTC days to include, ending today. Default 7.',
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

async function connectorForOwner(request, env, ownerId) {
  const presented = cookieValue(request, 'mcp');
  if (/^[A-Za-z0-9_-]{20,200}$/.test(presented)) {
    const row = await env.DB.prepare('SELECT owner_id FROM mcp_tokens WHERE token_hash = ?')
      .bind(await sha256(presented))
      .first();
    if (row && row.owner_id === ownerId) return { token: presented, isNew: false };
  }
  const existing = await env.DB.prepare('SELECT 1 AS ok FROM mcp_tokens WHERE owner_id = ?')
    .bind(ownerId)
    .first();
  if (existing) return { token: null, isNew: false };
  return { token: await issueMcpToken(env, ownerId), isNew: true };
}

async function issueMcpToken(env, ownerId) {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_tokens WHERE owner_id = ?').bind(ownerId),
    env.DB.prepare(
      'INSERT INTO mcp_tokens (token_hash, owner_id, created_at) VALUES (?, ?, ?)'
    ).bind(await sha256(token), ownerId, now),
  ]);
  return token;
}

async function resetMcp(request, env, url) {
  if (request.method !== 'POST') {
    return new Response(null, {
      status: 405,
      headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
    });
  }
  const owner = getOwner(request);
  if (owner.isNew) {
    return messagePage(
      401,
      'Reset unavailable',
      'Open Your links in this browser, then reset the connector.'
    );
  }
  const token = await issueMcpToken(env, owner.id);
  const headers = new Headers({ Location: '/links', 'Cache-Control': 'no-store' });
  setMcpCookie(headers, token, url);
  return new Response(null, { status: 303, headers });
}

async function mcpEndpoint(request, env, url) {
  const cors = mcpCors(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  let token = '';
  try {
    token = decodeURIComponent(url.pathname.slice('/mcp/'.length));
  } catch {
    return mcpJson({ error: 'Unauthorized' }, 401, cors);
  }
  try {
    const ownerId = await ownerForMcpToken(env, token);
    if (!ownerId) return mcpJson({ error: 'Unauthorized' }, 401, cors);
    if (request.method !== 'POST') {
      return mcpJson({ error: 'Method not allowed' }, 405, cors, { Allow: 'POST' });
    }
    return await mcpPost(request, env, url, ownerId, cors);
  } catch (err) {
    console.error(err);
    return rpcError(null, -32603, 'Internal error', cors, 500);
  }
}

async function ownerForMcpToken(env, token) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
  const row = await env.DB.prepare('SELECT owner_id FROM mcp_tokens WHERE token_hash = ?')
    .bind(await sha256(token))
    .first();
  return row ? row.owner_id : null;
}

async function mcpPost(request, env, url, ownerId, cors) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > 65536) return rpcError(null, -32700, 'Parse error', cors, 400);
  const raw = await request.text();
  if (raw.length > 65536) return rpcError(null, -32700, 'Parse error', cors, 400);
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return rpcError(null, -32700, 'Parse error', cors, 400);
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, -32600, 'Invalid Request', cors, 400);
  }
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  const id = hasId ? msg.id : null;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request', cors, 400);
  }
  if (hasId && id !== null && typeof id !== 'string' && typeof id !== 'number') {
    return rpcError(null, -32600, 'Invalid Request', cors, 400);
  }
  if (!hasId) {
    if (msg.method.startsWith('notifications/')) {
      return new Response(null, { status: 202, headers: cors });
    }
    return rpcError(null, -32600, 'Invalid Request', cors, 400);
  }
  if (msg.method === 'initialize') return rpcResult(id, initializeResult(msg.params), cors);
  if (msg.method === 'ping') return rpcResult(id, {}, cors);
  if (msg.method === 'tools/list') return rpcResult(id, { tools: MCP_TOOLS }, cors);
  if (msg.method === 'tools/call') {
    const result = await callTool(env, url.origin, ownerId, msg.params);
    if (result.rpcError) return rpcError(id, result.rpcError.code, result.rpcError.message, cors);
    return rpcResult(id, result, cors);
  }
  return rpcError(id, -32601, 'Method not found', cors);
}

function initializeResult(params) {
  const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : '2025-03-26';
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: 'Linki', version: '0.1.0' },
    instructions:
      "Read-only click reports for the Linki links that belong to this connector. Unique visitors are counted once per link per day. Referrers and countries are not stored.",
  };
}

async function callTool(env, origin, ownerId, params) {
  if (!params || typeof params.name !== 'string') {
    return { rpcError: { code: -32602, message: 'Invalid params' } };
  }
  let args = {};
  if (params.arguments !== undefined) {
    if (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) {
      return { rpcError: { code: -32602, message: 'Invalid params' } };
    }
    args = params.arguments;
  }
  if (params.name === 'list_links') return toolText(await reportLinks(env, origin, ownerId));
  if (params.name === 'link_report') return reportLink(env, origin, ownerId, args);
  if (params.name === 'clicks_summary') return reportSummary(env, origin, ownerId, args);
  return { rpcError: { code: -32602, message: 'Unknown tool' } };
}

async function reportLinks(env, origin, ownerId) {
  const { results } = await env.DB.prepare(
    `SELECT code, destination, label, click_count, created_at,
            (SELECT COUNT(DISTINCT visitor_hash) FROM clicks WHERE code = links.code) AS uniques
     FROM links
     WHERE owner_id = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT 201`
  )
    .bind(ownerId)
    .all();
  const truncated = results.length > 200;
  return {
    ...(truncated ? { truncated: true } : {}),
    links: (truncated ? results.slice(0, 200) : results).map((row) => linkSummary(row, origin, true)),
  };
}

async function reportLink(env, origin, ownerId, args) {
  const daysResult = readDays(args.days, 30);
  if (daysResult.error) return toolError(daysResult.error);
  const slug = typeof args.slug === 'string' ? args.slug.toLowerCase() : '';
  if (!/^[a-z0-9]{4,12}$/.test(slug)) return toolError('Link not found.');
  const link = await env.DB.prepare(
    'SELECT code, destination, label FROM links WHERE code = ? AND owner_id = ?'
  )
    .bind(slug, ownerId)
    .first();
  if (!link) return toolError('Link not found.');
  const range = dayRange(daysResult.days);
  const { results } = await env.DB.prepare(
    `SELECT ts / 86400 AS day, COUNT(*) AS clicks, COUNT(DISTINCT visitor_hash) AS uniques
     FROM clicks WHERE code = ? AND ts >= ? GROUP BY day`
  )
    .bind(slug, range.since)
    .all();
  const byDay = new Map(results.map((row) => [Number(row.day), row]));
  const daily = [];
  for (let day = range.start; day <= range.today; day++) {
    const row = byDay.get(day);
    daily.push({
      date: isoFromDay(day),
      clicks: row ? Number(row.clicks) : 0,
      unique_visitors: row ? Number(row.uniques) : 0,
    });
  }
  return toolText({
    slug: link.code,
    short_url: `${origin}/${link.code}`,
    destination: link.destination,
    label: link.label || null,
    days: daysResult.days,
    from: isoFromDay(range.start),
    to: isoFromDay(range.today),
    clicks: daily.reduce((sum, day) => sum + day.clicks, 0),
    unique_visitors: daily.reduce((sum, day) => sum + day.unique_visitors, 0),
    daily,
    note: 'Unique visitors are counted once per day. Referrers and countries are not stored.',
  });
}

async function reportSummary(env, origin, ownerId, args) {
  const daysResult = readDays(args.days, 7);
  if (daysResult.error) return toolError(daysResult.error);
  const range = dayRange(daysResult.days);
  const { results } = await env.DB.prepare(
    `SELECT l.code, l.destination, l.label, l.created_at,
            COUNT(c.id) AS clicks,
            COUNT(DISTINCT c.visitor_hash) AS uniques
     FROM links l
     LEFT JOIN clicks c ON c.code = l.code AND c.ts >= ?
     WHERE l.owner_id = ?
     GROUP BY l.code
     ORDER BY clicks DESC, l.created_at DESC`
  )
    .bind(range.since, ownerId)
    .all();
  const links = results.map((row) => linkSummary(row, origin, false));
  return toolText({
    days: daysResult.days,
    from: isoFromDay(range.start),
    to: isoFromDay(range.today),
    clicks: links.reduce((sum, link) => sum + link.clicks, 0),
    unique_visitors: links.reduce((sum, link) => sum + link.unique_visitors, 0),
    links,
    note: 'Unique visitors are counted once per link per day, so one person who opens two links counts twice. Referrers and countries are not stored.',
  });
}

function linkSummary(row, origin, allTime) {
  return {
    slug: row.code,
    short_url: `${origin}/${row.code}`,
    destination: row.destination,
    label: row.label || null,
    ...(allTime ? { created: isoFromUnix(row.created_at) } : {}),
    clicks: Number(allTime ? row.click_count : row.clicks),
    unique_visitors: Number(row.uniques),
  };
}

function readDays(value, fallback) {
  if (value === undefined) return { days: fallback };
  const n =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    return { error: 'days must be an integer from 1 to 365.' };
  }
  return { days: n };
}

function dayRange(days) {
  const today = Math.floor(Date.now() / 86400000);
  const start = today - (days - 1);
  return { today, start, since: start * 86400 };
}

function isoFromDay(dayNumber) {
  return new Date(dayNumber * 86400000).toISOString().slice(0, 10);
}

function isoFromUnix(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function toolText(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function mcpCors(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function mcpJson(body, status, cors, extra) {
  const headers = new Headers(cors);
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  if (extra) {
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function rpcResult(id, result, cors) {
  return mcpJson({ jsonrpc: '2.0', id, result }, 200, cors);
}

function rpcError(id, code, message, cors, status = 200) {
  return mcpJson({ jsonrpc: '2.0', id, error: { code, message } }, status, cors);
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// ---------- helpers ----------

function secret(env) {
  return env.HASH_SECRET || 'local-dev-secret';
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function esc(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatDay(dayNumber) {
  const d = new Date(dayNumber * 86400000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const JS = `
document.addEventListener('click', async function (e) {
  var btn = e.target.closest('[data-copy]');
  if (!btn) return;
  var text = btn.getAttribute('data-copy');
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e2) {}
    ta.remove();
  }
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  clearTimeout(btn._copiedTimer);
  btn.textContent = 'Copied';
  btn.classList.add('copied');
  btn._copiedTimer = setTimeout(function () {
    btn.textContent = btn.dataset.label;
    btn.classList.remove('copied');
  }, 1500);
});
document.querySelectorAll('input.short').forEach(function (el) {
  el.addEventListener('focus', function () { el.select(); });
});
`;

const CSS = `
:root{--paper:#F3F3F1;--surface:#FFFFFF;--pressed:#E3E3DF;--ink:#1E2330;--on-ink:#FFFFFF;--muted:#676B77;
  --line:#DCDCD8;--line-soft:#EFEFEC;--zero:#CFCFCA;--accent:#2665D6;--on-accent:#FFFFFF;--accent-text:#2665D6;
  --pink:#E9C0E9;--on-pink:#3B1036;--mustard:#D2A72A;--on-mustard:#2F2203;--maroon:#780016;--on-maroon:#FFFFFF;--danger:#C4281C;
  --display:"Bricolage Grotesque",system-ui,sans-serif;--ui:Inter,system-ui,sans-serif;--mono:"Space Mono",ui-monospace,Menlo,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#111318;--surface:#1A1D24;--pressed:#2A2D36;--ink:#F2F2EE;--on-ink:#111318;--muted:#A3A7B2;
  --line:#2E323C;--line-soft:#242730;--zero:#3A3E48;--accent-text:#8AB0FF;--maroon:#9E1B32;--danger:#FF8A7A;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--paper);color:var(--ink);font:400 16px/1.5 var(--ui);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
a{color:var(--ink);text-underline-offset:3px}
:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
p{margin:0}
h1{margin:0;font:800 44px/.98 var(--display);letter-spacing:-.035em;overflow-wrap:anywhere}
h2{margin:0;font:700 24px/1.2 var(--display);letter-spacing:-.02em}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* header, panel, footer */
header{display:flex;justify-content:space-between;align-items:center;gap:16px;width:100%;max-width:1080px;height:64px;margin:0 auto;padding:0 20px}
.brand{display:inline-flex;align-items:center;gap:8px;min-height:44px;font:700 22px/1.2 var(--display);letter-spacing:-.01em;text-decoration:none}
.brand::before{content:"";width:20px;height:24px;clip-path:polygon(4% 0,4% 84%,28% 64%,45% 100%,63% 92%,47% 58%,84% 58%);background:conic-gradient(var(--accent),var(--pink),var(--mustard),var(--accent))}
.pill{display:inline-flex;align-items:center;height:38px;padding:0 16px;border:1px solid var(--line);border-radius:999px;background:var(--surface);font-weight:600;font-size:14px;text-decoration:none}
.pill[aria-current]{background:var(--pressed)}
.panel{flex:1 0 auto;width:calc(100% - 40px);max-width:1040px;margin:0 auto;padding:34px 36px;background:var(--surface);border-radius:26px}
footer{padding:18px 16px 24px;text-align:center;font-size:13px;color:var(--muted)}

/* hero + form */
.hero{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:28px}
.hero h1{font-size:48px;line-height:1.08;text-wrap:balance}
.hl{color:var(--accent-text)}
.lede{margin-top:14px;color:var(--muted)}
.create{display:grid;justify-items:start;margin-top:22px}
input[type=text]{display:block;width:100%;min-width:0;height:48px;padding:0 18px;font:400 14px var(--ui);color:var(--ink);background:var(--paper);border:0;border-radius:16px}
input::placeholder{color:var(--muted);opacity:1}
#url{height:58px;font-size:16px;border:2px solid var(--ink)}
#label{margin-top:10px}
.create .primary{margin-top:14px}
.error{margin-top:14px;font-size:14px;font-weight:500;color:var(--danger)}

/* buttons */
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:600 15px/1 var(--ui);border-radius:999px;cursor:pointer;white-space:nowrap;text-decoration:none}
.primary{height:50px;padding:0 26px;border:0;background:var(--ink);color:var(--on-ink)}
.secondary{height:36px;padding:0 16px;border:1px solid var(--line);background:var(--surface);color:var(--ink);font-size:13px}
a.secondary{font-size:14px}
button.copied{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}

/* result card */
.rc{position:relative;overflow:hidden;display:flex;flex-direction:column;min-height:260px;padding:26px;border-radius:24px;background:var(--accent);color:var(--on-accent)}
.rc::after{content:"";position:absolute;right:-40px;bottom:-40px;width:170px;height:170px;border-radius:40px;background:var(--pink);transform:rotate(18deg)}
.rc::before{content:"";position:absolute;right:70px;bottom:-60px;width:110px;height:110px;border-radius:50%;background:var(--mustard)}
.rc>*{position:relative;z-index:1}
.rc :focus-visible{outline-color:var(--on-accent)}
.cap{font-size:13px;font-weight:600}
.rc input.short{height:auto;margin-top:14px;padding:12px 16px;border-radius:14px;background:#FFFFFF;color:#1E2330;font:700 22px/1.2 var(--mono);text-overflow:ellipsis}
.go{max-width:70%;margin-top:12px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cl{align-self:flex-start;height:44px;margin-top:auto;padding:0 22px;border:0;background:#FFFFFF;color:#1E2330;font-weight:700}
.rc .copied{background:var(--pink);color:var(--on-pink)}
.pv{min-width:0}
.pv .ex{align-self:flex-start;max-width:100%;min-width:0;margin-top:14px;padding:12px 16px;border-radius:999px;background:#fff;color:#1E2330;font:700 22px/1.2 var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pv .foot{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 16px;margin-top:auto;align-self:flex-start;max-width:100%;min-width:0}
.pv .bars{display:flex;align-items:flex-end;gap:5px;width:116px;max-width:100%;height:72px}
.pv .bars span{flex:1;min-width:0;border-radius:999px;background:#fff}
.pv .bars span:last-child{background:var(--mustard)}
.pv .n{font:800 28px/1 var(--display);letter-spacing:-.03em}
.pv .n small{margin-left:2px;font:600 13px/1 var(--ui);letter-spacing:0}

/* section heads + list */
.sectionhead{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:38px 0 8px}
.sectionhead.top{margin:0 0 20px}
.sectionhead>a:not(.button){display:inline-flex;align-items:center;min-height:44px;font-size:14px;font-weight:600}
.links{list-style:none;margin:0 -12px;padding:0}
.links li{display:grid;grid-template-columns:minmax(0,1fr) 130px 90px 80px;gap:16px;align-items:center;padding:12px;border-top:1px solid var(--line-soft);border-radius:16px}
.links li:first-child{border-top:0}
.links li:hover{background:var(--paper)}
.links li:hover+li{border-top-color:transparent}
.rowmain{display:grid;grid-template-columns:44px minmax(0,1fr);gap:16px;align-items:center;min-width:0;text-decoration:none}
.rowtext{min-width:0}
.title{display:block;font-weight:600;font-size:15px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rowmain:hover .title{text-decoration:underline}
.chip{display:inline-block;max-width:100%;margin-top:5px;padding:4px 10px;border-radius:999px;background:var(--paper);font:400 12.5px/1.4 var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:top}
.links li:hover .chip{background:var(--surface)}
.t{display:grid;place-items:center;width:44px;height:44px;border-radius:13px;font:800 18px/1 var(--display)}
.t1{background:var(--accent);color:var(--on-accent)}
.t2{background:var(--pink);color:var(--on-pink)}
.t3{background:var(--mustard);color:var(--on-mustard)}
.t4{background:var(--maroon);color:var(--on-maroon)}
.t5{background:var(--ink);color:var(--on-ink)}
.date{font-size:14px;color:var(--muted)}
.count{text-align:right}
.num{font-family:var(--display);font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
.count .num{display:block;font-size:24px}
.cc{display:block;margin-top:3px;font-size:12px;font-weight:500;color:var(--muted)}
.links .secondary{justify-self:end}
.empty{display:grid;justify-items:center;gap:20px;padding:48px;text-align:center;border:2px dashed var(--line);border-radius:22px}
.empty p{font:700 24px/1.2 var(--display)}

/* detail */
.back a{display:inline-flex;align-items:center;min-height:44px;font-size:14px;font-weight:600;text-decoration:none}
.dtop{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;margin-top:4px}
.dtop>div:first-child{min-width:0}
.meta{margin-top:10px;font-size:14px;color:var(--muted);overflow-wrap:anywhere}
.up{display:flex;align-items:center;gap:6px;flex:0 1 360px;min-width:0;padding:5px 5px 5px 18px;border-radius:999px;background:var(--paper)}
.up input.short{height:42px;padding:0;background:none;font:700 15px var(--mono);text-overflow:ellipsis}
.up .primary{flex:none;height:42px}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:28px}
.stat{position:relative;overflow:hidden;display:flex;flex-direction:column;justify-content:space-between;gap:12px;min-width:0;min-height:150px;padding:22px;border-radius:22px}
.stat::after{content:"";position:absolute;right:-26px;top:-26px;width:90px;height:90px;border-radius:50%;background:rgba(255,255,255,.16)}
.stat .label{font-size:14px;font-weight:600}
.stat .num{font-size:58px;letter-spacing:-.03em}
.chartcard{margin-top:14px;padding:24px 24px 18px;border-radius:22px;background:var(--paper)}
.chh{display:flex;justify-content:space-between;align-items:center;gap:12px}
.chh h2{font-size:22px;letter-spacing:0}
.pk{padding:6px 12px;border-radius:999px;background:var(--surface);font-size:13px;font-weight:600;white-space:nowrap}
.chart{display:flex;align-items:flex-end;gap:6px;height:200px;margin-top:22px}
.bar{flex:1;min-width:0;height:100%;display:flex;align-items:flex-end}
.bar span{display:block;width:100%;min-height:8px;background:var(--ink);border-radius:999px}
.bar.zero span{background:var(--zero)}
.bar.today span{background:var(--accent);box-shadow:0 0 0 3px var(--paper),0 0 0 5px var(--accent)}
.axis{display:flex;justify-content:space-between;margin-top:12px;font-size:13px;font-weight:600;color:var(--muted)}
.note{margin-top:14px;font-size:13px;color:var(--muted)}

/* message pages */
.msg{display:grid;justify-items:center;padding:8vh 0 24px;text-align:center}
.status{padding:8px 28px;border-radius:24px;background:var(--accent);color:var(--on-accent);font:800 96px/1 var(--display);letter-spacing:-.03em}
.msg h1{margin-top:18px;font-size:26px;font-weight:700;line-height:1.15;letter-spacing:-.02em}
.msg .muted{margin-top:8px;color:var(--muted)}
.msg .button{margin-top:24px;height:44px;font-size:14px}

@media (prefers-reduced-motion:no-preference){
  button,.button{transition:transform 120ms ease-out}
  button:hover,.button:hover{transform:translateY(-1px)}
  button:active,.button:active{transform:translateY(0) scale(.98)}
  .links li{transition:background-color 120ms ease-out}
  .rc{animation:pop 180ms ease-out}
  .bar span,.pv .bars span{transform-origin:bottom;animation:grow 400ms ease-out}
  @keyframes pop{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}
  @keyframes grow{from{transform:scaleY(0)}to{transform:none}}
}

@media (max-width:860px){
  .pv::after{width:86px;height:86px;border-radius:22px;right:-26px;top:-26px;bottom:auto}
  .pv::before{display:none}
  .pv .ex{font-size:15px;padding:8px 12px}
  .pv .bars{width:100px;height:56px}
  .pv .n{font-size:22px}
}

@media (max-width:520px){
  header{padding:0 10px}
  .pill{height:44px}
  .panel{width:calc(100% - 20px);padding:22px 18px;border-radius:22px}
  .hero,.hero.has{grid-template-columns:minmax(0,1fr);gap:18px}
  .pv .ex{font-size:18px;padding:10px 14px}
  .pv .bars{width:96px;height:48px}
  .pv .n{font-size:22px}
  .hero h1{font-size:38px}
  h1{font-size:30px}
  .lede{font-size:15px}
  .create{justify-items:stretch}
  .rc{min-height:0;padding:20px}
  .rc::after{width:96px;height:96px;border-radius:24px;right:-36px;top:-36px;bottom:auto}
  .rc::before{display:none}
  .rc input.short{font-size:18px}
  .chip .host{display:none}
  .go{max-width:100%}
  .cl{align-self:stretch;margin-top:18px}
  .secondary{height:44px}
  .sectionhead{margin-top:30px}
  .links{margin:0 -8px}
  .links li{grid-template-columns:minmax(0,1fr) auto auto;gap:12px;padding:12px 8px}
  .rowmain{gap:12px}
  .date{display:none}
  .count .num{font-size:20px}
  .dtop{flex-direction:column;align-items:stretch;gap:16px}
  .up{flex:none}
  .up input.short{height:44px;font-size:13px}
  .up .primary{height:44px;padding:0 18px}
  .stat{min-height:96px;padding:14px}
  .stat .label{font-size:12px}
  .stat .num{font-size:30px}
  .chh h2{font-size:18px}
  .chart{height:140px;gap:3px}
  .status{font-size:72px}
}
.agent{margin-top:32px;padding:20px 22px 18px;border-radius:22px;background:var(--paper)}
.agenthead{display:flex;justify-content:space-between;align-items:center;gap:12px}
.agenthead h2{font-size:22px;letter-spacing:0}
.agenthead form{margin:0;flex:none}
.agent .hint{margin-top:6px;max-width:68ch;font-size:14px;color:var(--muted)}
.agent .up{flex:1 1 auto;width:100%;max-width:none;margin-top:14px}
.agent .up input.short{min-width:0}
@media (max-width:520px){
  .agent{padding:16px}
  .agent .up{flex-wrap:wrap;height:auto;padding:8px 8px 8px 14px;border-radius:18px}
  .agent .up input.short{flex:1 1 100%;height:40px;font-size:12px}
  .agent .up .primary{flex:1 1 auto;height:44px}
}
`;

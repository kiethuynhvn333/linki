// Link tracker: create short links, redirect, count clicks.
// One Cloudflare Worker + one D1 database. No framework.

const GA_ID = 'G-MEBVJJ00K8'; // set to '' to disable Google Analytics on Linki's pages
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i, l, o, 0, 1
const CODE_LENGTH = 6;
// Names nobody can take as a custom link name: Linki's own paths, plus a few kept for later.
const RESERVED = new Set([
  'links', 'create', 'api', 'admin', 'static', 'mcp', 'mcp-review', 'review', 'new', 'app',
  'www', 'about', 'help', 'login', 'signup', 'account', 'settings', 'terms', 'privacy', 'linki',
]);
const MAX_URL_LENGTH = 2048;
const NAME_MIN_LENGTH = 3;
const NAME_MAX_LENGTH = 40;
// A link's code is a random 6-character code or a custom name: letters, numbers
// and hyphens, 3 to 40 characters, never starting or ending with a hyphen.
const CODE = '[a-z0-9][a-z0-9-]{1,38}[a-z0-9]';
const CODE_RE = new RegExp(`^${CODE}$`);
const SHORT_RE = new RegExp(`^/(${CODE})$`);
const DETAIL_RE = new RegExp(`^/links/(${CODE})$`);
const DELETE_RE = new RegExp(`^/links/(${CODE})/delete$`);
const RENAME_RE = new RegExp(`^/links/(${CODE})/rename$`);
// A rename rewrites the link's click rows, so a link with more clicks than this keeps its name.
const RENAME_MAX_CLICKS = 1000;
// New links per rolling hour and per rolling day. The website counts per network
// address. An agent counts per connector, and gets less.
const CREATE_LIMITS = { web: { hour: 20, day: 50 }, mcp: { hour: 10, day: 25 } };
const CHART_DAYS = 30;
const OWNER_COOKIE_MAX_AGE = 31536000; // one year, renewed on every visit
const CLICK_RETENTION_DAYS = 400; // raw click rows; totals live on the links row
const PRUNE_BATCH = 10000;
const BOT_RE =
  /bot|crawl|spider|slurp|facebookexternalhit|meta-externalagent|whatsapp\/|preview|curl|wget|python|headless|pingdom|uptime|monitor|go-http-client|okhttp|axios|node-fetch|undici|java\/|dalvik|libwww|httpclient|scrapy|postman|insomnia|google-inspectiontool|googleother|lighthouse|embedly|vkshare|validator|feedfetcher|mediapartners/i;
const HOME_TITLE = 'Linki — a very good alternative to bitly';
const HOME_DESCRIPTION =
  'Paste a long URL, give the short link your own name for free, and see how many people click it. No sign-up.';
const BLOCKED_SCHEME_RE = /^(javascript|data|vbscript|file|mailto|tel|blob|about):/i;

// The Linki mark: a white cursor on a cobalt tile, with the pink and mustard
// shapes of the hero card. The header logo and the favicon are this one SVG.
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><clipPath id="lt"><rect width="32" height="32" rx="9"/></clipPath></defs><g clip-path="url(#lt)"><rect width="32" height="32" fill="#2665D6"/><circle cx="9" cy="32.5" r="6.5" fill="#D2A72A"/><rect x="20" y="21" width="18" height="18" rx="5" fill="#E9C0E9" transform="rotate(18 29 30)"/></g><path d="M9 7.5 23.5 14l-6.8 2.4-2.5 6.8z" fill="#fff" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/></svg>';

const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    // HEAD is routed like GET (the runtime drops the body), so uptime checks see the real status.
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    try {
      const moved = canonicalRedirect(url);
      if (moved) return moved;
      if (method === 'POST' && !isMcpApi(path) && !sameOrigin(request, url)) {
        return messagePage(403, 'Request blocked', 'This form was sent from another site.');
      }
      if (path === '/' && method === 'GET') return homePage(request, env, url);
      if (path === '/create' && method === 'POST') return createLink(request, env, url);
      if (path === '/links' && method === 'GET') return linksPage(request, env, url);
      if (path === '/mcp/reset') return resetMcp(request, env, url);
      if (path.startsWith('/mcp/')) return mcpEndpoint(request, env, url);
      if (path === '/favicon.svg' || path === '/favicon.ico') return new Response(LOGO_SVG, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
      // Only the homepage is open to search engines. Short links and account pages are not.
      if (path === '/robots.txt') return new Response('User-agent: *\nAllow: /$\nDisallow: /\n');
      const detail = path.match(DETAIL_RE);
      if (detail && method === 'GET') return detailPage(request, env, url, detail[1]);
      const del = path.match(DELETE_RE);
      if (del && method === 'POST') return deleteLink(request, env, del[1]);
      const ren = path.match(RENAME_RE);
      if (ren && method === 'POST') return renameLink(request, env, ren[1]);
      // Short links ignore capitals, so linki.ing/Hello and linki.ing/hello are one link.
      const short = path.toLowerCase().match(SHORT_RE);
      if (short && method === 'GET') return redirect(request, env, ctx, short[1]);
      return messagePage(404, 'Page not found', 'There is nothing at this address.');
    } catch (err) {
      console.error(err);
      return messagePage(500, 'Something went wrong', 'Please try again in a moment.');
    }
  },

  // Daily cron (see wrangler.toml): drop raw click rows past the retention window.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(pruneClicks(env));
  },
};

export default {
  async fetch(request, env, ctx) {
    const response = await worker.fetch(request, env, ctx);
    // Staging sets NOINDEX so a test copy of the site never reaches search results.
    if (env.NOINDEX) response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return response;
  },
  scheduled: worker.scheduled,
};

// ---------- request guards ----------

function isLocalHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

// Send http:// and www. visitors to the https:// bare domain.
function canonicalRedirect(url) {
  if (isLocalHost(url.hostname)) return null;
  const host = url.hostname.startsWith('www.') ? url.hostname.slice(4) : url.hostname;
  if (url.protocol === 'https:' && host === url.hostname) return null;
  return new Response(null, {
    status: 301,
    headers: {
      Location: `https://${host}${url.pathname}${url.search}`,
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

function isMcpApi(path) {
  return path.startsWith('/mcp/') && path !== '/mcp/reset';
}

// Browsers send Origin on every form POST. A POST from another site is refused.
function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

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
  // The hash already includes the day, so "not seen before" means "first click today".
  // The counter update must run before the insert.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE links SET click_count = click_count + 1,
         unique_count = unique_count + (NOT EXISTS (SELECT 1 FROM clicks WHERE code = ? AND visitor_hash = ?))
       WHERE code = ?`
    ).bind(code, visitor, code),
    env.DB.prepare(
      'INSERT INTO clicks (code, ts, visitor_hash) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM links WHERE code = ?)'
    ).bind(code, now, visitor, code),
  ]);
}

// Click ids grow with time, so the oldest rows have the lowest ids. This reads at
// most PRUNE_BATCH rows per run and never scans the whole table.
async function pruneClicks(env) {
  const cutoff = Math.floor(Date.now() / 1000) - CLICK_RETENTION_DAYS * 86400;
  await env.DB.prepare(
    'DELETE FROM clicks WHERE ts < ? AND id IN (SELECT id FROM clicks ORDER BY id LIMIT ?)'
  )
    .bind(cutoff, PRUNE_BATCH)
    .run();
}

// ---------- create ----------

async function createLink(request, env, url) {
  const owner = getOwner(request);
  let form;
  try {
    form = await request.formData();
  } catch {
    return homePage(request, env, url, {
      error: 'That request could not be read. Please try again.',
      status: 400,
    });
  }
  const rawUrl = String(form.get('url') || '').trim();
  const rawName = String(form.get('name') || '').trim();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const made = await makeLink(env, {
    ownerId: owner.id,
    rawUrl,
    rawName,
    ownHost: url.hostname,
    creatorHash: (await sha256(`${secret(env)}|creator|${ip}`)).slice(0, 32),
    limit: CREATE_LIMITS.web,
  });
  if (made.error) {
    return homePage(request, env, url, { error: made.error, rawUrl, name: rawName, status: made.status });
  }

  const asked = made.taken ? `&asked=${made.taken}` : '';
  const headers = new Headers({ Location: `/?new=${made.code}${asked}`, 'Cache-Control': 'no-store' });
  setOwnerCookie(headers, owner, url);
  return new Response(null, { status: 303, headers });
}

// Creates a link for the website and for the connector. Returns { code,
// destination, taken } or { error, status }. taken is the name that was asked
// for when someone else already had it and an ending was added.
async function makeLink(env, { ownerId, rawUrl, rawName, ownHost, creatorHash, limit }) {
  const checked = checkDestination(rawUrl, ownHost);
  if (checked.error) return { error: checked.error, status: 400 };
  const named = checkName(rawName);
  if (named.error) return { error: named.error, status: 400 };

  const now = Math.floor(Date.now() / 1000);
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS day, COALESCE(SUM(created_at > ?), 0) AS hour
     FROM links WHERE creator_hash = ? AND created_at > ?`
  )
    .bind(now - 3600, creatorHash, now - 86400)
    .first();
  if (recent.hour >= limit.hour) {
    return { error: 'You have created a lot of links in the last hour. Please try again later.', status: 429 };
  }
  if (recent.day >= limit.day) {
    return { error: 'You have reached the daily limit for new links. Please try again tomorrow.', status: 429 };
  }

  // A link address can only lead to one place, so a name is first come, first
  // served. When the name is taken (or reserved), nobody is turned away: the
  // link gets the name plus a short random ending.
  const name = named.name;
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = !name ? randomCode() : attempt === 0 ? name : withEnding(name, attempt < 3 ? 2 : 4);
    if (RESERVED.has(candidate)) continue;
    try {
      await env.DB.prepare(
        'INSERT INTO links (code, owner_id, destination, created_at, creator_hash) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(candidate, ownerId, checked.destination, now, creatorHash)
        .run();
      return { code: candidate, destination: checked.destination, taken: name && candidate !== name ? name : '' };
    } catch (err) {
      if (!/UNIQUE|constraint/i.test(String(err && err.message))) throw err;
    }
  }
  throw new Error('Could not generate a unique code');
}

// Turns what was typed into a link name: "Khuyến mãi Tết!" becomes "khuyen-mai-tet".
// The page script has the same steps for the live preview (see JS).
function slugify(raw) {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX_LENGTH)
    .replace(/-+$/, '');
}

function checkName(raw) {
  if (!raw) return { name: '' };
  if (raw.length > 200) return { error: 'That name is too long.' };
  const name = slugify(raw);
  if (name.length < NAME_MIN_LENGTH) {
    return { error: `A custom name needs at least ${NAME_MIN_LENGTH} letters or numbers.` };
  }
  return { name };
}

function withEnding(name, length) {
  return `${name.slice(0, NAME_MAX_LENGTH - length - 1).replace(/-+$/, '')}-${randomCode(length)}`;
}

// Changes a link's name. Nothing is added to a taken name here: the owner is
// told and picks another one. The old address stops working.
async function renameLink(request, env, code) {
  const owner = getOwner(request);
  const json = (request.headers.get('Accept') || '').includes('application/json');
  const fail = (status, error) =>
    json ? jsonResponse({ error }, status) : messagePage(status, 'Name not changed', error);
  let form;
  try {
    form = await request.formData();
  } catch {
    return fail(400, 'That request could not be read. Please try again.');
  }
  const named = checkName(String(form.get('name') || '').trim());
  if (named.error) return fail(400, named.error);
  const name = named.name;
  if (!name) return fail(400, 'Type a name first.');
  const link = owner.isNew
    ? null
    : await env.DB.prepare('SELECT click_count FROM links WHERE code = ? AND owner_id = ?')
        .bind(code, owner.id)
        .first();
  if (!link) return fail(404, 'This link is not in your list.');

  if (name !== code) {
    if (link.click_count > RENAME_MAX_CLICKS) return fail(409, RENAME_LOCKED);
    if (RESERVED.has(name)) return fail(409, `“${name}” is not available. Try another name.`);
    try {
      // One transaction: if the name is taken, the links update fails and the clicks stay put.
      await env.DB.batch([
        env.DB.prepare(
          'UPDATE clicks SET code = ? WHERE code = ? AND EXISTS (SELECT 1 FROM links WHERE code = ? AND owner_id = ?)'
        ).bind(name, code, code, owner.id),
        env.DB.prepare('UPDATE links SET code = ? WHERE code = ? AND owner_id = ?').bind(name, code, owner.id),
      ]);
    } catch (err) {
      if (!/UNIQUE|constraint/i.test(String(err && err.message))) throw err;
      return fail(409, `“${name}” is already taken. Try another name.`);
    }
  }
  const location = form.get('back') === 'detail' ? `/links/${name}` : `/?new=${name}`;
  if (json) return jsonResponse({ ok: true, code: name, location }, 200);
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

const RENAME_LOCKED = `This link has more than ${RENAME_MAX_CLICKS.toLocaleString('en-US')} clicks, so its name can no longer be changed.`;

async function deleteLink(request, env, code) {
  const owner = getOwner(request);
  const json = (request.headers.get('Accept') || '').includes('application/json');
  const results = owner.isNew
    ? null
    : await env.DB.batch([
        env.DB.prepare(
          'DELETE FROM clicks WHERE code = ? AND EXISTS (SELECT 1 FROM links WHERE code = ? AND owner_id = ?)'
        ).bind(code, code, owner.id),
        env.DB.prepare('DELETE FROM links WHERE code = ? AND owner_id = ?').bind(code, owner.id),
      ]);
  if (!results || !results[1].meta.changes) {
    if (json) return jsonResponse({ error: 'This link is not in your list.' }, 404);
    return messagePage(404, 'Link not found', 'This link is not in your list.');
  }
  if (json) return jsonResponse({ ok: true }, 200);
  return new Response(null, {
    status: 303,
    headers: { Location: '/links?deleted=1', 'Cache-Control': 'no-store' },
  });
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
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
  // "https://bank.com@evil.example" opens evil.example. Refuse the disguise.
  if (parsed.username || parsed.password) {
    return { error: 'Links with a username or password in them are not supported.' };
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

function randomCode(length = CODE_LENGTH) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

// ---------- pages ----------

// The mark for anything about AI agents and MCP: a four-point spark.
const AGENT_ICON = '<path d="M10 2.5l1.8 4.7 4.7 1.8-4.7 1.8L10 15.5l-1.8-4.7L3.5 9l4.7-1.8z"/>';

const EDIT_ICON = '<path d="M4 16l.9-3.9 8.7-8.7a1.8 1.8 0 0 1 2.6 0l.4.4a1.8 1.8 0 0 1 0 2.6l-8.7 8.7zM11.8 5.2l3 3"/>';

// What Linki offers, in four short points under the hero: [tile colour, icon, title, text].
const USPS = [
  ['t1', '<path d="M8.5 11.5a3.5 3.5 0 0 0 5 0L16 9a3.5 3.5 0 0 0-5-5l-1 1M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1"/>',
    'Paste and go', 'Paste a long URL and get a short link in one click. Nothing to set up.'],
  ['t2', EDIT_ICON,
    'Free custom links', 'Choose what comes after linki.ing/, and change it if you change your mind. Free, with no paid plan.'],
  ['t3', '<circle cx="8.5" cy="7" r="3"/><path d="M3 17a5.5 5.5 0 0 1 11 0M14.5 4.5l3.5 3.5M18 4.5 14.5 8"/>',
    'No sign-up', 'No account and no email. Your links are saved in this browser.'],
  ['t4', AGENT_ICON,
    'MCP-ready', 'Works with Claude, Cursor and other AI agents. Create a link, then copy your MCP link to connect.'],
];

// Example chips for the home marquee: [slug, click count]. Decorative, not real links.
const MARQUEE_LINKS = [
  ['launch', 342],
  ['promo', 87],
  ['newsletter', 1204],
  ['demo', 56],
  ['hello', 128],
  ['podcast', 419],
  ['waitlist', 733],
];

async function homePage(request, env, url, state = {}) {
  const owner = getOwner(request);
  const offset = tzOffset(request);
  const links = owner.isNew ? [] : await listLinks(env, owner.id, 5);
  // The connector is issued with the first link, so the MCP link can be copied under the list.
  const mcp = links.length ? await connectorForOwner(request, env, owner, true) : null;
  let created = '';
  const newCode = url.searchParams.get('new');
  if (!state.error && newCode && CODE_RE.test(newCode)) {
    const link = links.find((l) => l.code === newCode);
    if (link) {
      const shortUrl = `${url.origin}/${link.code}`;
      const asked = url.searchParams.get('asked') || '';
      const note =
        CODE_RE.test(asked) && asked !== link.code
          ? `<p class="tk">“${esc(asked)}” was already taken, so your link has a short ending. You can change the name above.</p>`
          : '';
      created = `
      <section class="rc" aria-live="polite">
        <p class="cap">Your short link is ready</p>
        ${renameForm(link, url, 'home')}
        <p class="go">Goes to ${esc(truncate(link.destination, 70))}</p>
        ${note}
        <button type="button" class="cl" data-copy="${esc(shortUrl)}">Copy link</button>
      </section>`;
    }
  }
  const error = state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : '';
  // The example card and chips show the real host when it is short (linki.ing).
  const shortHost = url.host.length <= 16 ? url.host : 'linki';
  const preview = `
      <div class="rc pv" aria-hidden="true">
        <p class="cap">Your short link</p>
        <p class="ex" data-pre="${esc(shortHost)}/">${esc(shortHost)}/hello</p>
        <div class="foot">
          <div class="bars"><span style="height:34%"></span><span style="height:55%"></span><span style="height:42%"></span><span style="height:70%"></span><span style="height:48%"></span><span style="height:84%"></span><span style="height:100%"></span></div>
          <p class="n"><span class="cnt">128</span> <small>clicks</small></p>
        </div>
      </div>`;
  // Decorative only: example chips that scroll under the hero. The list is
  // printed twice so the CSS loop (translateX 0 to -50%) has no seam.
  const chips = MARQUEE_LINKS.map(
    ([slug, clicks]) => `<span class="mchip">${esc(shortHost)}/${slug}<small>${clicks}</small></span>`
  ).join('');
  const marquee = `
    <div class="mq" aria-hidden="true"><div class="mqt"><div class="mqg">${chips}</div><div class="mqg">${chips}</div></div></div>`;
  const usps = `
    <section class="usp" aria-labelledby="usp-h">
      <h2 id="usp-h" class="sr">Why Linki</h2>
      <ul>${USPS.map(
        ([tile, icon, title, text]) =>
          `<li><span class="ic ${tile}" aria-hidden="true"><svg viewBox="0 0 20 20">${icon}</svg></span><h3>${title}</h3><p>${text}</p></li>`
      ).join('')}</ul>
    </section>`;
  const body = `
    <div class="hero${created ? ' has' : ''}">
      <section>
        <h1>a very good alternative to <span class="hl">bitly</span></h1>
        <p class="lede">Paste a URL, name the link your way, see who clicks. Free, no sign-up.</p>
        <form method="post" action="/create" class="create">
          <label class="sr" for="url">Destination URL</label>
          <input id="url" name="url" type="text" inputmode="url" autocomplete="off" autofocus required
            placeholder="Paste a long URL" maxlength="${MAX_URL_LENGTH}" value="${esc(state.rawUrl || '')}">
          <label class="sr" for="name">Custom name for your short link (optional)</label>
          <div class="namef">
            <span class="pre" aria-hidden="true">${esc(url.host)}/</span>
            <input id="name" name="name" type="text" autocomplete="off" autocapitalize="none" spellcheck="false"
              placeholder="your-name (optional)" maxlength="60" value="${esc(state.name || '')}">
          </div>
          <button class="primary" type="submit">Create link</button>
        </form>
        ${error}
      </section>
      ${created || preview}
    </div>
    ${created ? '' : marquee}
    ${
      links.length
        ? `<section>
            <div class="sectionhead"><h2>Recent links</h2><a href="/links">See all</a></div>
            ${linkList(links, url.origin, offset)}
            ${mcpLine(mcp, url)}
          </section>`
        : ''
    }
    ${usps}`;
  const status = state.status || 200;
  return page(HOME_TITLE, body, {
    owner,
    url,
    status,
    linkCreated: Boolean(created),
    mcpToken: (mcp && mcp.token) || undefined,
    index: status === 200 && !url.search,
  });
}

async function linksPage(request, env, url) {
  const owner = getOwner(request);
  const links = owner.isNew ? [] : await listLinks(env, owner.id, 200);
  const mcp = await connectorForOwner(request, env, owner, links.length > 0);
  const notice =
    url.searchParams.get('deleted') === '1'
      ? '<p class="notice" role="status">Link deleted. Its short link no longer works.</p>'
      : '';
  const body = `
    <div class="sectionhead top"><h1>Your links</h1><a class="button secondary" href="/">New link</a></div>
    ${notice}
    ${
      links.length
        ? linkList(links, url.origin, tzOffset(request))
        : '<div class="empty"><p>No links yet</p><a class="button primary" href="/">Create your first link</a></div>'
    }
    ${agentSection(mcp, url)}`;
  return page('Your links', body, { owner, url, mcpToken: mcp.token || undefined });
}

// One quiet line under the home page's Recent links: copy the MCP link there.
function mcpLine(mcp, url) {
  const spark = `<svg class="sp" viewBox="0 0 20 20" aria-hidden="true">${AGENT_ICON}</svg>`;
  const action = mcp.token
    ? `<button type="button" class="secondary" data-copy="${esc(`${url.origin}/mcp/${mcp.token}`)}">${spark}Copy MCP link</button>`
    : `<a class="button secondary" href="/links">${spark}Get MCP link</a>`;
  return `<aside class="mcpf" aria-label="Connect your AI agent">
              <span class="ic" aria-hidden="true"><svg viewBox="0 0 20 20">${AGENT_ICON}</svg></span>
              <p><strong>Use your links from your AI agent.</strong> Paste your MCP link into Claude or Cursor to create links and check clicks from chat.</p>
              ${action}
            </aside>`;
}

// The short link with a name that can be edited in place. Save shows up once the
// name is changed (see the page script). A link that already has clicks asks first.
function renameForm(link, url, back) {
  const confirm = link.click_count
    ? ' data-confirm="Change the name? The old address will stop working for anyone who already has it."'
    : '';
  // A long address gets smaller type, so the name is not cut off.
  const size = url.host.length + link.code.length > 26 ? ' long' : '';
  return `<form class="rn${size}" method="post" action="/links/${link.code}/rename" data-rename${confirm}>
          <input type="hidden" name="back" value="${back}">
          <span class="pre" aria-hidden="true">${esc(url.host)}/</span>
          <input name="name" type="text" required autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="60"
            value="${link.code}" data-was="${link.code}" title="Click to change the name" aria-label="Name of your short link, after ${esc(url.host)}/"
            style="min-width:min(70%,${link.code.length + 1}ch)">
          <svg class="pen" viewBox="0 0 20 20" aria-hidden="true">${EDIT_ICON}</svg>
          <button type="submit">Save</button>
        </form>
        <p class="rnmsg" role="alert" hidden></p>`;
}

function agentSection(mcp, url) {
  const connectorUrl = mcp.token ? `${url.origin}/mcp/${mcp.token}` : '';
  const hint = mcp.token
    ? 'Copy this MCP link and paste it into your AI tool. Your agent can then create links and tell you how they are doing. In Claude: Settings → Connectors → Add custom connector. Cursor and other MCP clients take the same link.'
    : mcp.exists
      ? 'This browser no longer has your MCP link. Reset to get a new one. The old link stops working.'
      : 'Create a link first. Your MCP link will show up here.';
  const reset = mcp.exists
    ? '<form method="post" action="/mcp/reset"><button class="secondary" type="submit">Reset</button></form>'
    : '';
  const urlRow = connectorUrl
    ? `<div class="up">
        <input class="short" type="text" readonly spellcheck="false" aria-label="Your MCP link" title="${esc(connectorUrl)}" value="${esc(connectorUrl)}">
        <button type="button" class="secondary" data-copy="${esc(connectorUrl)}">Copy MCP link</button>
      </div>`
    : '';
  return `
    <section class="agent" aria-labelledby="agent-h">
      <div class="agenthead">
        <h2 id="agent-h"><span class="ic" aria-hidden="true"><svg viewBox="0 0 20 20">${AGENT_ICON}</svg></span><span>Use Linki from your AI agent <span class="tag">MCP</span></span></h2>
        ${reset}
      </div>
      <p class="hint">${esc(hint)}</p>
      ${urlRow}
    </section>`;
}

async function detailPage(request, env, url, code) {
  const owner = getOwner(request);
  const link = owner.isNew
    ? null
    : await env.DB.prepare(
        'SELECT code, destination, label, status, click_count, unique_count, created_at FROM links WHERE code = ? AND owner_id = ?'
      )
        .bind(code, owner.id)
        .first();
  if (!link) {
    return messagePage(404, 'Link not found', 'This link is not in your list.');
  }

  // Days are counted in the visitor's time zone (see tzOffset). The query only
  // reads the chart window, and the all-time totals come from the links row.
  const offset = tzOffset(request);
  const today = localDay(Math.floor(Date.now() / 1000), offset);
  const since = (today - (CHART_DAYS - 1)) * 86400 - offset;
  const daily = await env.DB.prepare(
    `SELECT CAST((ts + ?) / 86400 AS INTEGER) AS day, COUNT(*) AS clicks, COUNT(DISTINCT visitor_hash) AS uniques
     FROM clicks WHERE code = ? AND ts >= ? GROUP BY day`
  )
    .bind(offset, code, since)
    .all();
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
        <p class="meta dest">Goes to <a href="${esc(link.destination)}" rel="noopener noreferrer nofollow" target="_blank">${esc(truncate(link.destination, 90))}</a> · Created ${formatDate(link.created_at + offset)}</p>
      </div>
      <div class="up">
        <input class="short" type="text" readonly value="${esc(shortUrl.replace(/^https?:\/\//, ''))}" aria-label="Short link">
        <button type="button" class="primary" data-copy="${esc(shortUrl)}">Copy</button>
      </div>
    </div>

    <div class="stats">
      <div class="stat t1"><span class="label">Total clicks</span><span class="num">${link.click_count.toLocaleString('en-US')}</span></div>
      <div class="stat t2"><span class="label">Unique clicks</span><span class="num">${link.unique_count.toLocaleString('en-US')}</span></div>
      <div class="stat t3"><span class="label">Last ${CHART_DAYS} days</span><span class="num">${last30.toLocaleString('en-US')}</span></div>
    </div>

    <section class="chartcard">
      <div class="chh"><h2>Clicks per day</h2><span class="pk">Peak ${plural(max === 1 && last30 === 0 ? 0 : max, 'click')}</span></div>
      <div class="chart" role="img" aria-label="Clicks per day for the last ${CHART_DAYS} days, ${last30} in total">${bars}</div>
      <div class="axis"><span>${formatDay(days[0].day)}</span><span>Today · ${days[days.length - 1].clicks}</span></div>
    </section>
    <p class="note">${offset ? `Days follow your time zone (${utcLabel(offset)}).` : 'Days are in UTC.'} Unique clicks count each visitor once per day; link previews and known bots are not counted.</p>
    <div class="rnz">
      <p>${link.click_count > RENAME_MAX_CLICKS ? esc(RENAME_LOCKED) : 'Change the name. The old address stops working.'}</p>
      ${link.click_count > RENAME_MAX_CLICKS ? '' : `<div class="rnw">${renameForm(link, url, 'detail')}</div>`}
    </div>
    <form class="dz" method="post" action="/links/${link.code}/delete" data-confirm="Delete this link? The short link will stop working and its click history will be removed. This cannot be undone.">
      <p>Deleting stops the short link and removes its click history.</p>
      <button class="secondary danger" type="submit">Delete link</button>
    </form>`;
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

function linkList(links, origin, offset = 0) {
  const host = origin.replace(/^https?:\/\//, '');
  const todayNum = localDay(Math.floor(Date.now() / 1000), offset);
  return `<ul class="links">${links
    .map((l, i) => {
      const shortUrl = `${origin}/${l.code}`;
      const name = l.label || l.destination.replace(/^https?:\/\/(www\.)?/i, '');
      const letter = (Array.from(name)[0] || '#').toUpperCase();
      const dayNum = localDay(l.created_at, offset);
      return `
      <li>
        <a class="rowmain" href="/links/${l.code}">
          <span class="t t${(i % 5) + 1}" aria-hidden="true">${esc(letter)}</span>
          <span class="rowtext"><span class="title">${esc(l.label || truncate(l.destination, 50))}</span>
          <span class="chip"><span class="host">${esc(host)}</span>/${l.code}</span></span>
        </a>
        <span class="date">${dayNum === todayNum ? 'Today' : formatDay(dayNum)}</span>
        <span class="count"><span class="num">${l.click_count.toLocaleString('en-US')}</span><span class="cc">${l.click_count === 1 ? 'click' : 'clicks'}</span></span>
        <span class="rowbtns">
          <button type="button" class="secondary" data-copy="${esc(shortUrl)}" aria-label="Copy ${esc(shortUrl)}">Copy</button>
          <form method="post" action="/links/${l.code}/delete" data-row-delete data-confirm="Delete this link? The short link will stop working and its click history will be removed. This cannot be undone.">
            <button class="secondary del" type="submit" aria-label="Delete ${esc(shortUrl)}">Delete</button>
          </form>
        </span>
      </li>`;
    })
    .join('')}</ul>`;
}

function messagePage(status, title, text) {
  const body = `<section class="msg"><p class="status">${status}</p><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p><a class="button secondary" href="/">Go to the homepage</a></section>`;
  return page(title, body, { status });
}

function gaHead(linkCreated, nonce) {
  if (!GA_ID) return '';
  const event = linkCreated ? "\n  gtag('event', 'link_created');" : '';
  return `<script async nonce="${nonce}" src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script nonce="${nonce}">
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GA_ID}');${event}
</script>
`;
}

// Only the plain homepage is indexable. Everything else stays out of search engines.
function seoHead(index, url) {
  if (!index || !url) return '<meta name="robots" content="noindex">';
  const home = `${url.origin}/`;
  return `<meta name="description" content="${esc(HOME_DESCRIPTION)}">
<link rel="canonical" href="${esc(home)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Linki">
<meta property="og:title" content="${esc(HOME_TITLE)}">
<meta property="og:description" content="${esc(HOME_DESCRIPTION)}">
<meta property="og:url" content="${esc(home)}">
<meta name="twitter:card" content="summary">`;
}

function contentSecurityPolicy(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://*.googletagmanager.com`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com",
    "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function page(title, body, { owner, url, status = 200, linkCreated = false, mcpToken, index = false } = {}) {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const fullTitle = title.startsWith('Linki —') ? title : `${title} — Linki`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${seoHead(index, url)}
<title>${esc(fullTitle)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${gaHead(linkCreated, nonce)}<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Inter:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap">
<style>${CSS}</style>
</head>
<body>
<header><a class="brand" href="/">${LOGO_SVG.replace('<svg ', '<svg aria-hidden="true" ')}Linki</a><nav><a class="pill" href="/links"${url && url.pathname.startsWith('/links') ? ' aria-current="page"' : ''}>Your links</a></nav></header>
<main class="panel">${body}</main>
<script nonce="${nonce}">${JS}</script>
</body>
</html>`;
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': contentSecurityPolicy(nonce),
  });
  if (url && url.protocol === 'https:') {
    headers.set('Strict-Transport-Security', 'max-age=31536000');
  }
  // Returning owners get their cookie renewed. A first-time visitor gets one only
  // when they create a link (see createLink), so plain visits set no cookie.
  if (owner && !owner.isNew && url) setOwnerCookie(headers, owner, url);
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
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  headers.append(
    'Set-Cookie',
    `owner=${owner.id}; Path=/; Max-Age=${OWNER_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`
  );
}

function setMcpCookie(headers, token, url) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  headers.append(
    'Set-Cookie',
    `mcp=${token}; Path=/; Max-Age=${OWNER_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`
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

// ---------- time zone ----------

// The page script stores the browser's UTC offset in minutes in a "tz" cookie.
// Returns that offset in seconds, or 0 (UTC) when it is missing or out of range.
function tzOffset(request) {
  const raw = cookieValue(request, 'tz');
  if (!/^-?\d{1,3}$/.test(raw)) return 0;
  const minutes = Number(raw);
  return minutes >= -720 && minutes <= 840 ? minutes * 60 : 0;
}

function localDay(unixSeconds, offset) {
  return Math.floor((unixSeconds + offset) / 86400);
}

function utcLabel(offset) {
  const minutes = Math.abs(offset) / 60;
  const rest = minutes % 60;
  return `UTC${offset < 0 ? '-' : '+'}${Math.floor(minutes / 60)}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`;
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
  {
    name: 'create_link',
    description: `Create a short link for a destination URL. name is optional: your own ending for the short link, for example spring-sale. If someone already has that name, a short ending is added and the result says so. A connector can create ${CREATE_LIMITS.mcp.hour} links an hour and ${CREATE_LIMITS.mcp.day} a day.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Where the short link goes. http or https.' },
        name: {
          type: 'string',
          description: `Optional custom name: letters, numbers and hyphens, ${NAME_MIN_LENGTH} to ${NAME_MAX_LENGTH} characters. Leave it out for a random code.`,
        },
      },
      required: ['url'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

// Returns { token, exists }. token is the raw connector token when this browser
// still holds it. A connector is issued on the first visit after the owner has
// a link, so a visit with no cookie or no links never writes to the database.
async function connectorForOwner(request, env, owner, hasLinks) {
  if (owner.isNew) return { token: null, exists: false };
  const presented = cookieValue(request, 'mcp');
  if (/^[A-Za-z0-9_-]{20,200}$/.test(presented)) {
    const row = await env.DB.prepare('SELECT owner_id FROM mcp_tokens WHERE token_hash = ?')
      .bind(await sha256(presented))
      .first();
    if (row && row.owner_id === owner.id) return { token: presented, exists: true };
  }
  const existing = await env.DB.prepare('SELECT 1 AS ok FROM mcp_tokens WHERE owner_id = ?')
    .bind(owner.id)
    .first();
  if (existing) return { token: null, exists: true };
  if (!hasLinks) return { token: null, exists: false };
  return { token: await issueMcpToken(env, owner.id), exists: true };
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
    const result = await callTool(env, url, ownerId, msg.params);
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
    serverInfo: { name: 'Linki', version: '0.2.0' },
    instructions:
      "Create short links and read click reports for the Linki links that belong to this connector. Unique visitors are counted once per link per day. Referrers and countries are not stored.",
  };
}

async function callTool(env, url, ownerId, params) {
  const origin = url.origin;
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
  if (params.name === 'create_link') return createFromAgent(env, url, ownerId, args);
  return { rpcError: { code: -32602, message: 'Unknown tool' } };
}

// Agents reach Linki from their vendor's servers, so their limit is counted per
// connector, not per network address.
async function createFromAgent(env, url, ownerId, args) {
  if (typeof args.url !== 'string') return toolError('url is required.');
  if (args.name !== undefined && args.name !== null && typeof args.name !== 'string') {
    return toolError('name must be text.');
  }
  const limit = CREATE_LIMITS.mcp;
  const made = await makeLink(env, {
    ownerId,
    rawUrl: args.url.trim(),
    rawName: (args.name || '').trim(),
    ownHost: url.hostname,
    creatorHash: (await sha256(`${secret(env)}|mcp|${ownerId}`)).slice(0, 32),
    limit,
  });
  if (made.error) {
    const rule = ` A connector can create ${limit.hour} links an hour and ${limit.day} a day.`;
    return toolError(made.status === 429 ? made.error + rule : made.error);
  }
  return toolText({
    slug: made.code,
    short_url: `${url.origin}/${made.code}`,
    destination: made.destination,
    ...(made.taken
      ? { note: `The name "${made.taken}" was already taken, so a short ending was added.` }
      : {}),
  });
}

async function reportLinks(env, origin, ownerId) {
  const { results } = await env.DB.prepare(
    `SELECT code, destination, label, click_count, created_at, unique_count AS uniques
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
  if (!CODE_RE.test(slug)) return toolError('Link not found.');
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

let warnedAboutSecret = false;

function secret(env) {
  if (env.HASH_SECRET) return env.HASH_SECRET;
  if (!warnedAboutSecret) {
    warnedAboutSecret = true;
    console.error(
      'HASH_SECRET is not set, so visitor hashes use a public fallback. Set it with: wrangler secret put HASH_SECRET'
    );
  }
  return 'local-dev-secret';
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
// Home hero motion. All of it is decorative and is skipped under prefers-reduced-motion.
(function () {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // Counter: count up to the number in the markup, then tick +1 every few seconds.
  var num = document.querySelector('.pv .cnt');
  if (num) {
    var target = parseInt(num.textContent, 10) || 0;
    var value = target;
    var lastBar = document.querySelector('.pv .bars span:last-child');
    var began = null;
    var show = function (n) { num.textContent = n.toLocaleString('en-US'); };
    var pulse = function (el, frames) {
      if (el && el.animate) el.animate(frames, { duration: 520, easing: 'ease-out' });
    };
    var tick = function () {
      if (!document.hidden) {
        value += 1;
        show(value);
        pulse(lastBar, [{ transform: 'scaleY(1)' }, { transform: 'scaleY(1.14)' }, { transform: 'scaleY(1)' }]);
        pulse(num, [{ transform: 'translateY(0)' }, { transform: 'translateY(-3px)' }, { transform: 'translateY(0)' }]);
      }
      setTimeout(tick, 2600 + Math.random() * 2600);
    };
    var step = function (now) {
      if (began === null) began = now;
      var p = Math.min((now - began) / 1200, 1);
      show(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
      else setTimeout(tick, 2600);
    };
    show(0);
    requestAnimationFrame(step);
  }

  // Parallax: shapes shift a few px against the cursor. Mouse only, one write per frame.
  var layers = document.querySelectorAll('.rc');
  if (!layers.length || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  var mx = 0, my = 0, queued = false;
  window.addEventListener('pointermove', function (e) {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    mx = e.clientX / window.innerWidth - 0.5;
    my = e.clientY / window.innerHeight - 0.5;
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      for (var i = 0; i < layers.length; i++) {
        layers[i].style.setProperty('--mx', mx.toFixed(3));
        layers[i].style.setProperty('--my', my.toFixed(3));
      }
    });
  }, { passive: true });
})();

// Home: the example card shows the custom name as it is typed (same steps as slugify).
(function () {
  var name = document.getElementById('name');
  var ex = document.querySelector('.pv .ex');
  if (!name || !ex) return;
  var show = function () {
    var slug = name.value.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').replace(/[\\u0111\\u0110]/g, 'd')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    ex.textContent = ex.getAttribute('data-pre') + (slug || 'hello');
  };
  name.addEventListener('input', show);
  show();
})();

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
  if (!btn._label) btn._label = btn.innerHTML; // some buttons have an icon
  clearTimeout(btn._copiedTimer);
  btn.textContent = 'Copied';
  btn.classList.add('copied');
  btn._copiedTimer = setTimeout(function () {
    btn.innerHTML = btn._label;
    btn.classList.remove('copied');
  }, 1500);
});
// Rename: Save shows up once the name is different from the saved one.
document.querySelectorAll('form[data-rename]').forEach(function (form) {
  var input = form.querySelector('input[name=name]');
  input.addEventListener('input', function () {
    form.classList.toggle('dirty', input.value.trim() !== input.getAttribute('data-was'));
  });
});
document.querySelectorAll('input.short').forEach(function (el) {
  el.addEventListener('focus', function () { el.select(); });
});
document.addEventListener('submit', function (e) {
  var form = e.target;
  var msg = form.getAttribute('data-confirm');
  if (msg && !window.confirm(msg)) {
    e.preventDefault();
    return;
  }
  if (form.hasAttribute('data-rename')) {
    e.preventDefault();
    var note = form.parentNode.querySelector('.rnmsg');
    var save = form.querySelector('button');
    save.disabled = true;
    fetch(form.action, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form)).toString()
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.ok && data.location) { location.href = data.location; return; }
          throw new Error(data.error || 'Could not change the name.');
        });
      })
      .catch(function (err) {
        save.disabled = false;
        var message = err && err.message ? err.message : '';
        if (!message || message === 'Failed to fetch') message = 'Could not change the name.';
        note.textContent = message;
        note.hidden = false;
        form.querySelector('input[name=name]').focus({ preventScroll: true });
      });
    return;
  }
  if (!form.hasAttribute('data-row-delete')) return;
  e.preventDefault();
  var btn = form.querySelector('button');
  var row = form.closest('li');
  if (btn) btn.disabled = true;
  fetch(form.action, { method: 'POST', headers: { Accept: 'application/json' } })
    .then(function (res) {
      if (res.ok) return;
      return res.json().catch(function () { return {}; }).then(function (data) {
        var fallback = res.status === 403 ? 'This delete was blocked.' : 'Could not delete this link.';
        throw new Error((data && data.error) || fallback);
      });
    })
    .then(function () {
      var list = row.parentNode;
      var note = list.previousElementSibling;
      if (!note || !note.classList.contains('delnote')) {
        note = document.createElement('p');
        note.className = 'notice delnote';
        note.setAttribute('role', 'status');
        list.parentNode.insertBefore(note, list);
      }
      note.textContent = 'Deleted';
      row.remove();
      if (!list.children.length) list.remove();
    })
    .catch(function (err) {
      if (btn) btn.disabled = false;
      if (!row) return;
      var errEl = row.querySelector('.rowmsg');
      if (!errEl) {
        errEl = document.createElement('p');
        errEl.className = 'rowmsg';
        errEl.setAttribute('role', 'alert');
        row.appendChild(errEl);
      }
      var message = err && err.message ? err.message : '';
      if (!message || message === 'Failed to fetch') message = 'Could not delete this link.';
      errEl.textContent = message;
    });
});
// Tell the server this browser's UTC offset so "Today" and the chart use local days.
try {
  document.cookie = 'tz=' + (-new Date().getTimezoneOffset()) + '; Path=/; Max-Age=31536000; SameSite=Lax' +
    (location.protocol === 'https:' ? '; Secure' : '');
} catch (e) {}
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
.brand svg{flex:none;width:28px;height:28px}
.pill{display:inline-flex;align-items:center;height:38px;padding:0 16px;border:1px solid var(--line);border-radius:999px;background:var(--surface);font-weight:600;font-size:14px;text-decoration:none}
.pill[aria-current]{background:var(--pressed)}
.panel{flex:1 0 auto;width:calc(100% - 40px);max-width:1040px;margin:0 auto 28px;padding:34px 36px;background:var(--surface);border-radius:26px}

/* hero + form */
.hero{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:28px}
.hero h1{font-size:48px;line-height:1.08;text-wrap:balance}
.hl{color:var(--accent-text)}
.lede{margin-top:14px;color:var(--muted)}
.create{display:grid;grid-template-columns:minmax(0,1fr);justify-items:start;margin-top:22px}
input[type=text]{display:block;width:100%;min-width:0;height:48px;padding:0 18px;font:400 14px var(--ui);color:var(--ink);background:var(--paper);border:0;border-radius:16px}
input::placeholder{color:var(--muted);opacity:1}
#url{height:58px;font-size:16px;border:2px solid var(--ink)}
.namef{display:flex;align-items:center;width:100%;margin-top:10px;padding-left:18px;border-radius:16px;background:var(--paper)}
.namef:focus-within{outline:3px solid var(--ink);outline-offset:2px}
.namef .pre{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 14px var(--mono);color:var(--muted)}
.namef input{flex:1 1 7em;width:0;min-width:7em;padding:0 18px 0 1px;background:none;font:700 14px var(--mono)}
.namef input::placeholder{font-weight:400}
.namef input:focus-visible{outline:0}
.create .primary{margin-top:14px}
.error{margin-top:14px;font-size:14px;font-weight:500;color:var(--danger)}

/* buttons */
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:600 15px/1 var(--ui);border-radius:999px;cursor:pointer;white-space:nowrap;text-decoration:none}
.primary{height:50px;padding:0 26px;border:0;background:var(--ink);color:var(--on-ink)}
.secondary{height:36px;padding:0 16px;border:1px solid var(--line);background:var(--surface);color:var(--ink);font-size:13px}
a.secondary{font-size:14px}
button.copied{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}

/* result card */
.rc{position:relative;overflow:hidden;overflow:clip;display:flex;flex-direction:column;min-height:260px;padding:26px;border-radius:24px;background:var(--accent);color:var(--on-accent)}
.rc::after{content:"";position:absolute;right:-40px;bottom:-40px;width:170px;height:170px;border-radius:40px;background:var(--pink);transform:rotate(18deg)}
.rc::before{content:"";position:absolute;right:70px;bottom:-60px;width:110px;height:110px;border-radius:50%;background:var(--mustard)}
.rc>*{position:relative;z-index:1}
.rc :focus-visible{outline-color:var(--on-accent)}
.cap{font-size:13px;font-weight:600}
.rn{display:flex;align-items:center;margin-top:14px;padding:6px 6px 6px 16px;border-radius:14px;background:#FFFFFF;color:#1E2330;font:700 22px/1.2 var(--mono);cursor:text}
.rn.long{font-size:17px}
.rn:focus-within{outline:3px solid var(--on-accent);outline-offset:2px}
.rn .pre{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#676B77}
.rn input[type=text]{flex:1 1 0;width:0;height:40px;padding:0;border-radius:0;background:none;color:inherit;font:inherit;text-overflow:ellipsis}
.rn input:focus-visible{outline:0}
.rn .pen{flex:none;width:18px;height:18px;margin:0 10px;fill:none;stroke:#676B77;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
.rn button{display:none;flex:none;height:38px;padding:0 18px;border:0;background:#1E2330;color:#FFFFFF;font-size:13px}
.rn.dirty button{display:inline-flex}
.rn.dirty .pen{display:none}
.rn button:disabled{opacity:.6;cursor:default}
.rnmsg{margin-top:8px;font-size:13px;font-weight:600;color:var(--danger)}
.rc .rnmsg{align-self:flex-start;padding:8px 12px;border-radius:10px;background:var(--pink);color:var(--on-pink)}
.go{max-width:70%;margin-top:12px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tk{max-width:70%;margin:8px 0 14px;font-size:13px;font-weight:600}
.sp{flex:none;width:14px;height:14px;fill:none;stroke:var(--maroon);stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.mcpf{display:flex;align-items:center;gap:12px;margin-top:8px;padding-top:14px;border-top:1px dashed var(--line);font-size:13px;line-height:1.4;color:var(--muted)}
.mcpf .ic{width:30px;height:30px;border-radius:9px;background:var(--paper)}
.mcpf .ic svg{width:15px;height:15px}
.mcpf p{flex:1 1 0;min-width:0}
.mcpf strong{color:var(--ink);font-weight:600}
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
.pv .cnt{display:inline-block;font-variant-numeric:tabular-nums}

/* hero motion: parallax offsets and marquee. --mx/--my are set by the page script. */
.rc::after{translate:calc(var(--mx,0)*-16px) calc(var(--my,0)*-16px)}
.rc::before{translate:calc(var(--mx,0)*-9px) calc(var(--my,0)*-9px)}
.mq{overflow:hidden;margin-top:30px;padding:2px 0;-webkit-mask-image:linear-gradient(90deg,transparent,#000 9%,#000 91%,transparent);mask-image:linear-gradient(90deg,transparent,#000 9%,#000 91%,transparent)}
.mqt{display:flex;width:max-content}
.mqg{display:flex;gap:10px;padding-right:10px}
.mchip{display:inline-flex;align-items:center;gap:8px;padding:7px 8px 7px 14px;border-radius:999px;background:var(--paper);font:700 13px/1.4 var(--mono);white-space:nowrap}
.usp{margin-top:44px;padding-top:30px;border-top:1px solid var(--line-soft)}
.usp ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px}
.ic{display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:12px}
.ic svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.usp h3{margin:14px 0 4px;font:700 18px/1.2 var(--display);letter-spacing:-.01em}
.usp p{font-size:14px;line-height:1.45;color:var(--muted)}
.mchip small{padding:2px 8px;border-radius:999px;background:var(--surface);font:600 11px/1.5 var(--ui);color:var(--muted);font-variant-numeric:tabular-nums}

/* section heads + list */
.sectionhead{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:38px 0 8px}
.sectionhead.top{margin:0 0 20px}
.sectionhead>a:not(.button){display:inline-flex;align-items:center;min-height:44px;font-size:14px;font-weight:600}
.links{list-style:none;margin:0 -12px;padding:0}
.links li{display:grid;grid-template-columns:minmax(0,1fr) 130px 90px auto;gap:16px;align-items:center;padding:12px;border-top:1px solid var(--line-soft);border-radius:16px}
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
.rowbtns{display:flex;gap:8px;justify-content:flex-end;align-items:center}
.rowbtns form{margin:0}
.rowbtns .secondary{flex:none}
.rowbtns .del:hover{color:var(--maroon);border-color:var(--maroon);background:color-mix(in srgb, var(--maroon) 10%, var(--surface))}
.rowbtns button:disabled{opacity:.6;cursor:default}
.rowmsg{grid-column:1/-1;margin:0;font-size:13px;font-weight:500;color:var(--danger)}
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
  .brand svg{transition:transform 180ms ease-out}
  .brand:hover svg{transform:rotate(-8deg) scale(1.08)}
  .rc{animation:pop 180ms ease-out}
  .bar span,.pv .bars span{transform-origin:bottom;animation:grow 400ms ease-out}
  @keyframes pop{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}
  @keyframes grow{from{transform:scaleY(0)}to{transform:none}}

  /* hero motion: slow floats (7-10s, offset), staggered bars, marquee loop */
  .pv .bars span{animation:grow 560ms cubic-bezier(.2,.8,.2,1) backwards}
  .pv .bars span:nth-child(1){animation-delay:120ms}
  .pv .bars span:nth-child(2){animation-delay:190ms}
  .pv .bars span:nth-child(3){animation-delay:260ms}
  .pv .bars span:nth-child(4){animation-delay:330ms}
  .pv .bars span:nth-child(5){animation-delay:400ms}
  .pv .bars span:nth-child(6){animation-delay:470ms}
  .pv .bars span:nth-child(7){animation-delay:540ms}
  .rc::after{animation:float-sq 9s ease-in-out infinite}
  .rc::before{animation:float-dot 7s ease-in-out -2s infinite}
  .rc::after,.rc::before{transition:translate 600ms cubic-bezier(.2,.7,.2,1)}
  .mqt{animation:marquee 38s linear infinite}
  .mq:hover .mqt{animation-play-state:paused}
  @keyframes float-sq{0%,100%{transform:rotate(18deg)}50%{transform:translate(-7px,-11px) rotate(24deg)}}
  @keyframes float-dot{0%,100%{transform:none}50%{transform:translate(9px,-9px)}}
  @keyframes marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}
}

@media (max-width:860px){
  .usp ul{grid-template-columns:repeat(2,minmax(0,1fr))}
  .pv::after{width:86px;height:86px;border-radius:22px;right:-26px;top:-26px;bottom:auto}
  .pv::before{display:none}
  .pv .ex{font-size:15px;padding:8px 12px}
  .pv .bars{width:100px;height:56px}
  .pv .n{font-size:22px}
}

@media (max-width:640px){
  .links{margin:0 -8px}
  .links li{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"link count" "btns btns";gap:10px 12px;padding:12px 8px}
  .rowmain{grid-area:link;gap:12px}
  .date{display:none}
  .count{grid-area:count;align-self:center}
  .count .num{font-size:20px}
  .rowbtns{grid-area:btns;justify-content:flex-start}
  .rowbtns .secondary{height:44px;min-height:44px;padding:0 16px}
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
  .rc .rn{font-size:18px}
  .rc .rn.long{font-size:15px}
  .chip .host{display:none}
  .go,.tk{max-width:100%}
  .mcpf{flex-wrap:wrap}
  .mcpf .secondary{flex:1 1 100%}
  .cl{align-self:stretch;margin-top:18px}
  .secondary{height:44px}
  .sectionhead{margin-top:30px}
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
  .mq{margin-top:22px}
  .usp{margin-top:32px;padding-top:24px}
  .usp ul{grid-template-columns:minmax(0,1fr);gap:18px}
  .usp li{display:grid;grid-template-columns:40px minmax(0,1fr);column-gap:14px}
  .usp .ic{grid-row:span 2}
  .usp h3{margin:0 0 2px}
  @media (prefers-reduced-motion:no-preference){
    @keyframes float-sq{0%,100%{transform:rotate(18deg)}50%{transform:translate(-3px,-5px) rotate(21deg)}}
  }
}
.agent{margin-top:44px;padding-top:22px;border-top:1px solid var(--line-soft)}
.agenthead{display:flex;justify-content:space-between;align-items:center;gap:12px}
.agenthead h2{display:flex;align-items:center;gap:10px;min-width:0;font:600 15px/1.3 var(--ui);letter-spacing:0}
.agenthead .ic{width:28px;height:28px;border-radius:9px;background:var(--paper)}
.agenthead .ic svg{width:15px;height:15px}
.agenthead form{margin:0;flex:none}
.tag{display:inline-block;margin-left:4px;vertical-align:1px;padding:2px 8px;border-radius:999px;background:var(--paper);font:700 11px/1.5 var(--mono);color:var(--muted)}
.agent .hint{margin-top:8px;max-width:72ch;font-size:13px;color:var(--muted)}
.agent .up{flex:none;max-width:600px;margin-top:12px;padding:4px 4px 4px 16px}
.agent .up input.short{min-width:0;height:36px;font:400 12.5px var(--mono);color:var(--muted)}
.agent .up .secondary{flex:none}
.notice{margin:-6px 0 18px;padding:12px 16px;border-radius:14px;background:var(--paper);font-size:14px;font-weight:500}
.delnote{margin:8px 0 12px}
.rnz{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:28px;padding-top:20px;border-top:1px solid var(--line-soft);font-size:14px;color:var(--muted)}
.rnw{flex:0 1 420px;min-width:0}
.rnz .rn{margin-top:0;padding:5px 5px 5px 18px;border-radius:999px;background:var(--paper);color:var(--ink);font-size:15px}
.rnz .rn:focus-within{outline-color:var(--ink)}
.rnz .rn .pre,.rnz .rn .pen{color:var(--muted);stroke:var(--muted)}
.rnz .rn button{background:var(--ink);color:var(--on-ink)}
.rnz+.dz{margin-top:20px}
.dz{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:28px;padding-top:20px;border-top:1px solid var(--line-soft);font-size:14px;color:var(--muted)}
.danger{color:var(--danger);border-color:currentColor}
@media (max-width:520px){
  .rnz{flex-direction:column;align-items:stretch}
  .rnw{flex:none}
  .agent .up{flex-wrap:wrap;padding:8px 8px 8px 14px;border-radius:18px}
  .agent .up input.short{flex:1 1 100%;height:36px}
  .agent .up .secondary{flex:1 1 auto}
}
`;

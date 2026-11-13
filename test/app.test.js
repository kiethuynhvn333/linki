// End-to-end tests: the real Worker runs in Miniflare (the local runtime that
// ships with wrangler) against an in-memory D1 database built from migrations/.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = 'https://linki.test';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';

let mf;
let db;
let ipCounter = 0;

before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: `${ROOT}src/index.js`,
    compatibilityDate: '2025-01-01',
    d1Databases: { DB: 'linki-test' },
    bindings: { HASH_SECRET: 'test-secret' },
  });
  db = await mf.getD1Database('DB');
  for (const file of readdirSync(`${ROOT}migrations`).sort()) {
    const sql = readFileSync(`${ROOT}migrations/${file}`, 'utf8').replace(/^--.*$/gm, '');
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
});

after(async () => {
  await mf.dispose();
});

// ---------- helpers ----------

function freshIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function request(path, { method = 'GET', cookie, headers = {}, body, origin = ORIGIN } = {}) {
  return mf.dispatchFetch(`${origin}${path}`, {
    method,
    body,
    redirect: 'manual',
    headers: { 'User-Agent': BROWSER_UA, ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
}

function post(path, fields, options = {}) {
  return request(path, {
    ...options,
    method: 'POST',
    body: new URLSearchParams(fields).toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: ORIGIN,
      ...(options.headers || {}),
    },
  });
}

function setCookies(res) {
  const out = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    out[pair.slice(0, pair.indexOf('='))] = { value: pair.slice(pair.indexOf('=') + 1), line };
  }
  return out;
}

// Creates a link. Returns its code and the owner cookie to send on later requests.
async function createLink({ url = 'https://example.com/page', label = '', cookie, ip = freshIp() } = {}) {
  const res = await post('/create', { url, label }, { cookie, headers: { 'CF-Connecting-IP': ip } });
  assert.equal(res.status, 303);
  const code = res.headers.get('Location').match(/^\/\?new=([a-z0-9]+)$/)[1];
  const owner = setCookies(res).owner;
  return { code, cookie: cookie || `owner=${owner.value}`, res };
}

function click(code, { ip = '198.51.100.1', ua = BROWSER_UA, method = 'GET', headers = {} } = {}) {
  return request(`/${code}`, { method, headers: { 'User-Agent': ua, 'CF-Connecting-IP': ip, ...headers } });
}

function linkRow(code) {
  return db.prepare('SELECT click_count, unique_count FROM links WHERE code = ?').bind(code).first();
}

async function count(sql, ...params) {
  return (await db.prepare(sql).bind(...params).first()).n;
}

// Clicks are recorded after the redirect is sent, so wait for the write to land.
async function waitFor(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

async function waitForClicks(code, expected) {
  await waitFor(async () => (await linkRow(code)).click_count === expected, `${expected} clicks on ${code}`);
}

async function rpc(token, method, params) {
  const res = await request(`/mcp/${token}`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    headers: { 'Content-Type': 'application/json' },
  });
  return { status: res.status, json: await res.json() };
}

// ---------- pages, headers, search engines ----------

test('homepage is public, indexable and sets no cookie for a first-time visitor', async () => {
  const res = await request('/');
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers.getSetCookie(), []);
  assert.doesNotMatch(html, /name="robots"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/linki\.test\/">/);
  assert.match(html, /<meta name="description" content="[^"]{40,}">/);
});

test('every other page stays out of search engines', async () => {
  const { code, cookie } = await createLink();
  for (const path of ['/links', `/links/${code}`, `/?new=${code}`, '/nothing-here-at-all']) {
    const html = await (await request(path, { cookie })).text();
    assert.match(html, /<meta name="robots" content="noindex">/, path);
  }
  const robots = await (await request('/robots.txt')).text();
  assert.equal(robots, 'User-agent: *\nAllow: /$\nDisallow: /\n');
});

test('pages send security headers, and the script nonce matches the policy', async () => {
  const res = await request('/');
  const html = await res.text();
  const csp = res.headers.get('Content-Security-Policy');
  const nonce = csp.match(/'nonce-([A-Za-z0-9_-]+)'/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(res.headers.get('Strict-Transport-Security'), 'max-age=31536000');
  const scripts = html.match(/<script[^>]*>/g);
  assert.ok(scripts.length >= 1);
  for (const tag of scripts) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
});

test('HEAD requests get the same status as GET', async () => {
  assert.equal((await request('/', { method: 'HEAD' })).status, 200);
  assert.equal((await request('/links', { method: 'HEAD' })).status, 200);
});

test('http and www visitors are sent to the https bare domain', async () => {
  const plain = await request('/abc123?x=1', { origin: 'http://linki.test' });
  assert.equal(plain.status, 301);
  assert.equal(plain.headers.get('Location'), 'https://linki.test/abc123?x=1');
  const www = await request('/', { origin: 'https://www.linki.test' });
  assert.equal(www.status, 301);
  assert.equal(www.headers.get('Location'), 'https://linki.test/');
  assert.equal((await request('/', { origin: 'http://localhost:8787' })).status, 200);
});

test('a staging copy (NOINDEX set) tells search engines to stay away', async () => {
  assert.equal((await request('/')).headers.get('X-Robots-Tag'), null);
  const staging = new Miniflare({
    modules: true,
    scriptPath: `${ROOT}src/index.js`,
    compatibilityDate: '2025-01-01',
    d1Databases: { DB: 'linki-staging-test' },
    bindings: { HASH_SECRET: 'test-secret', NOINDEX: '1' },
  });
  try {
    for (const path of ['/robots.txt', '/favicon.svg', '/nothing-here-at-all']) {
      const res = await staging.dispatchFetch(`${ORIGIN}${path}`);
      assert.equal(res.headers.get('X-Robots-Tag'), 'noindex, nofollow', path);
      await res.arrayBuffer();
    }
  } finally {
    await staging.dispose();
  }
});

// ---------- creating links ----------

test('creating a link gives the browser its owner cookie and shows the result', async () => {
  const { code, cookie, res } = await createLink({ url: 'example.com/hello', label: 'My label' });
  const owner = setCookies(res).owner;
  assert.match(owner.line, /HttpOnly/);
  assert.match(owner.line, /Secure/);
  assert.match(owner.line, /Max-Age=31536000/);
  const html = await (await request(`/?new=${code}`, { cookie })).text();
  assert.match(html, /Your short link is ready/);
  assert.ok(html.includes(`linki.test/${code}`));
  assert.match(html, /My label/);
});

test('bad destinations are refused with a clear message', async () => {
  const cases = [
    ['', /Paste a URL first/],
    ['javascript:alert(1)', /Only http and https/],
    ['https://bank.example@evil.example/login', /username or password/],
    ['https://linki.test/abcdef', /cannot point back/],
    ['not a url', /does not look like a valid URL/],
  ];
  for (const [url, message] of cases) {
    const res = await post('/create', { url });
    assert.equal(res.status, 400, url);
    assert.match(await res.text(), message, url);
  }
  assert.equal(await count('SELECT COUNT(*) AS n FROM links WHERE destination LIKE ?', '%evil.example%'), 0);
});

test('a request body that is not a form gets a 400, not a server error', async () => {
  const res = await request('/create', {
    method: 'POST',
    body: '{"url":"https://example.com"}',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
  });
  assert.equal(res.status, 400);
});

test('a form posted from another site is refused', async () => {
  const before = await count('SELECT COUNT(*) AS n FROM links');
  const res = await post('/create', { url: 'https://example.com/x' }, { headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  assert.equal(await count('SELECT COUNT(*) AS n FROM links'), before);
});

test('one address can create 20 links an hour, then is asked to wait', async () => {
  const ip = freshIp();
  let cookie;
  for (let i = 0; i < 20; i++) ({ cookie } = await createLink({ cookie, ip }));
  const res = await post('/create', { url: 'https://example.com/more' }, { cookie, headers: { 'CF-Connecting-IP': ip } });
  assert.equal(res.status, 429);
});

// ---------- redirects and click counting ----------

test('a short link redirects and counts clicks and unique visitors', async () => {
  const { code } = await createLink({ url: 'https://example.com/target?a=1' });
  const res = await click(code, { ip: '198.51.100.1' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://example.com/target?a=1');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  await waitForClicks(code, 1);

  await click(code, { ip: '198.51.100.1' }); // same visitor again
  await waitForClicks(code, 2);
  await click(code, { ip: '198.51.100.2' }); // a second visitor
  await waitForClicks(code, 3);

  assert.deepEqual(await linkRow(code), { click_count: 3, unique_count: 2 });
  assert.equal(await count('SELECT COUNT(*) AS n FROM clicks WHERE code = ?', code), 3);
});

test('bots, link previews, HEAD requests and prefetches are not counted', async () => {
  const { code } = await createLink();
  const automated = [
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'facebookexternalhit/1.1',
    'curl/8.4.0',
    'Go-http-client/1.1',
    'okhttp/4.12.0',
    'axios/1.6.0',
    'node-fetch/1.0',
    'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)',
    '',
  ];
  for (const ua of automated) assert.equal((await click(code, { ua })).status, 302, ua);
  await click(code, { method: 'HEAD' });
  await click(code, { headers: { 'Sec-Purpose': 'prefetch;prerender' } });
  await click(code); // one real click, so we know the writes have landed
  await waitForClicks(code, 1);
  assert.deepEqual(await linkRow(code), { click_count: 1, unique_count: 1 });
});

test('an unknown short link is a 404', async () => {
  assert.equal((await click('zzzzzz')).status, 404);
});

// ---------- your links, cookies, connector ----------

test('visiting Your links without a cookie writes nothing and sets no cookie', async () => {
  const tokensBefore = await count('SELECT COUNT(*) AS n FROM mcp_tokens');
  for (let i = 0; i < 3; i++) {
    const res = await request('/links');
    assert.equal(res.status, 200);
    assert.deepEqual(res.headers.getSetCookie(), []);
    assert.match(await res.text(), /Create a link first/);
  }
  assert.equal(await count('SELECT COUNT(*) AS n FROM mcp_tokens'), tokensBefore);

  // An owner whose only link was deleted has a cookie but no links: still no write.
  const { code, cookie } = await createLink();
  await post(`/links/${code}/delete`, {}, { cookie });
  assert.match(await (await request('/links', { cookie })).text(), /Create a link first/);
  assert.equal(await count('SELECT COUNT(*) AS n FROM mcp_tokens'), tokensBefore);
});

test('a returning owner gets the cookie renewed on every visit', async () => {
  const { cookie } = await createLink();
  for (const path of ['/', '/links']) {
    const owner = setCookies(await request(path, { cookie })).owner;
    assert.equal(`owner=${owner.value}`, cookie, path);
    assert.match(owner.line, /Max-Age=31536000/, path);
  }
});

test('an owner with a link gets one connector URL, reused on later visits', async () => {
  const { cookie } = await createLink();
  const ownerId = cookie.split('=')[1];
  const first = await request('/links', { cookie });
  const token = setCookies(first).mcp.value;
  assert.ok((await first.text()).includes(`${ORIGIN}/mcp/${token}`));
  const second = await request('/links', { cookie: `${cookie}; mcp=${token}` });
  assert.ok((await second.text()).includes(`${ORIGIN}/mcp/${token}`));
  assert.equal(await count('SELECT COUNT(*) AS n FROM mcp_tokens WHERE owner_id = ?', ownerId), 1);
});

test('the connector reports clicks, only for its own links, and reset replaces it', async () => {
  const mine = await createLink({ label: 'Mine' });
  const theirs = await createLink({ label: 'Theirs' });
  await click(mine.code);
  await waitForClicks(mine.code, 1);
  const token = setCookies(await request('/links', { cookie: mine.cookie })).mcp.value;

  assert.equal((await rpc('a'.repeat(43), 'tools/list')).status, 401);
  assert.equal((await rpc(token, 'tools/list')).json.result.tools.length, 3);

  const list = JSON.parse((await rpc(token, 'tools/call', { name: 'list_links' })).json.result.content[0].text);
  assert.deepEqual(
    list.links.map((l) => [l.slug, l.clicks, l.unique_visitors]),
    [[mine.code, 1, 1]]
  );
  const report = (await rpc(token, 'tools/call', { name: 'link_report', arguments: { slug: mine.code, days: 7 } })).json.result;
  const data = JSON.parse(report.content[0].text);
  assert.equal(data.clicks, 1);
  assert.equal(data.daily.length, 7);
  const other = (await rpc(token, 'tools/call', { name: 'link_report', arguments: { slug: theirs.code } })).json.result;
  assert.equal(other.isError, true);

  const reset = await post('/mcp/reset', {}, { cookie: mine.cookie });
  assert.equal(reset.status, 303);
  const fresh = setCookies(reset).mcp.value;
  assert.notEqual(fresh, token);
  assert.equal((await rpc(token, 'tools/list')).status, 401);
  assert.equal((await rpc(fresh, 'tools/list')).status, 200);
  assert.equal((await post('/mcp/reset', {})).status, 401); // no cookie, nothing to reset
});

// ---------- link detail, time zone, delete ----------

test('the detail page is only visible to the link owner', async () => {
  const { code, cookie } = await createLink({ label: 'Launch post' });
  const other = await createLink();
  await click(code);
  await waitForClicks(code, 1);
  const html = await (await request(`/links/${code}`, { cookie })).text();
  assert.match(html, /Launch post/);
  assert.match(html, /Unique clicks<\/span><span class="num">1</);
  assert.match(html, /Days are in UTC\./);
  assert.equal((await request(`/links/${code}`, { cookie: other.cookie })).status, 404);
  assert.equal((await request(`/links/${code}`)).status, 404);
});

test('the chart counts days in the browser time zone when it is known', async (t) => {
  const now = Math.floor(Date.now() / 1000);
  const minuteOfDay = Math.floor((now % 86400) / 60);
  if (minuteOfDay >= 1438) return t.skip('too close to UTC midnight');
  // A click 30 minutes before the last UTC midnight is "yesterday" in UTC. Pick a
  // time zone whose next midnight is still ahead, so there it is "today".
  const localMidnight = Math.min(minuteOfDay + 60, 1439); // minutes after UTC midnight
  const tz = localMidnight <= 720 ? -localMidnight : 1440 - localMidnight;
  const { code, cookie } = await createLink();
  await db
    .prepare('INSERT INTO clicks (code, ts, visitor_hash) VALUES (?, ?, ?)')
    .bind(code, now - (now % 86400) - 1800, 'tz-test')
    .run();

  const utc = await (await request(`/links/${code}`, { cookie })).text();
  assert.match(utc, /Today · 0</);
  const local = await (await request(`/links/${code}`, { cookie: `${cookie}; tz=${tz}` })).text();
  assert.match(local, /Today · 1</);
  assert.match(local, /Days follow your time zone \(UTC[+-]\d/);
  const ignored = await (await request(`/links/${code}`, { cookie: `${cookie}; tz=99999` })).text();
  assert.match(ignored, /Days are in UTC\./);
});

test('only the owner can delete a link, and deleting removes its clicks', async () => {
  const { code, cookie } = await createLink();
  const other = await createLink();
  await click(code);
  await waitForClicks(code, 1);

  assert.equal((await post(`/links/${code}/delete`, {}, { cookie: other.cookie })).status, 404);
  assert.equal((await post(`/links/${code}/delete`, {})).status, 404);
  const blocked = await post(`/links/${code}/delete`, {}, { cookie, headers: { Origin: 'https://evil.example' } });
  assert.equal(blocked.status, 403);
  assert.equal((await click(code, { method: 'HEAD' })).status, 302);

  const res = await post(`/links/${code}/delete`, {}, { cookie });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), '/links?deleted=1');
  assert.match(await (await request('/links?deleted=1', { cookie })).text(), /Link deleted/);
  assert.equal((await click(code)).status, 404);
  assert.equal(await count('SELECT COUNT(*) AS n FROM links WHERE code = ?', code), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM clicks WHERE code = ?', code), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM links WHERE code = ?', other.code), 1);
});

// ---------- cleanup job ----------

test('the daily job removes click rows older than the retention window and keeps totals', async () => {
  const { code } = await createLink();
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare('INSERT INTO clicks (code, ts, visitor_hash) VALUES (?, ?, ?)').bind(code, now - 500 * 86400, 'old'),
    db.prepare('INSERT INTO clicks (code, ts, visitor_hash) VALUES (?, ?, ?)').bind(code, now - 300 * 86400, 'recent'),
    db.prepare('UPDATE links SET click_count = 2, unique_count = 2 WHERE code = ?').bind(code),
  ]);
  const worker = await mf.getWorker();
  await worker.scheduled({ cron: '17 3 * * *' });
  await waitFor(
    async () => (await count('SELECT COUNT(*) AS n FROM clicks WHERE visitor_hash = ?', 'old')) === 0,
    'old click pruned'
  );
  assert.equal(await count('SELECT COUNT(*) AS n FROM clicks WHERE visitor_hash = ?', 'recent'), 1);
  assert.deepEqual(await linkRow(code), { click_count: 2, unique_count: 2 });
});

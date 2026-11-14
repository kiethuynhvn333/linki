// End-to-end tests: the real Worker runs in Miniflare (the local runtime that
// ships with wrangler) against an in-memory D1 database built from migrations/.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = 'https://linki.test';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
// Obviously fake. Production never has this binding.
const REVIEW_KEY = 'test-review-key';
const REVIEW_HASH = createHash('sha256').update(REVIEW_KEY).digest('hex');

let mf;
let db;
let reviewMf;
let reviewDb;
let ipCounter = 0;

async function applyMigrations(database) {
  for (const file of readdirSync(`${ROOT}migrations`).sort()) {
    const sql = readFileSync(`${ROOT}migrations/${file}`, 'utf8').replace(/^--.*$/gm, '');
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }
}

before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: `${ROOT}src/index.js`,
    compatibilityDate: '2025-01-01',
    d1Databases: { DB: 'linki-test' },
    bindings: { HASH_SECRET: 'test-secret' },
  });
  db = await mf.getD1Database('DB');
  await applyMigrations(db);
  reviewMf = new Miniflare({
    modules: true,
    scriptPath: `${ROOT}src/index.js`,
    compatibilityDate: '2025-01-01',
    d1Databases: { DB: 'linki-review-test' },
    bindings: { HASH_SECRET: 'test-secret', REVIEW_KEY, NOINDEX: '1' },
  });
  reviewDb = await reviewMf.getD1Database('DB');
  await applyMigrations(reviewDb);
});

after(async () => {
  await mf.dispose();
  await reviewMf.dispose();
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
async function createLink({ url = 'https://example.com/page', name = '', cookie, ip = freshIp() } = {}) {
  const res = await post('/create', { url, name }, { cookie, headers: { 'CF-Connecting-IP': ip } });
  assert.equal(res.status, 303);
  const location = res.headers.get('Location');
  const code = location.match(/^\/\?new=([a-z0-9-]+)(&asked=[a-z0-9-]+)?$/)[1];
  const owner = setCookies(res).owner;
  return { code, location, cookie: cookie || `owner=${owner.value}`, res };
}

async function toolCall(token, name, args) {
  const { json } = await rpc(token, 'tools/call', { name, arguments: args });
  return json.result;
}

function click(code, { ip = '198.51.100.1', ua = BROWSER_UA, method = 'GET', headers = {} } = {}) {
  return request(`/${code}`, { method, headers: { 'User-Agent': ua, 'CF-Connecting-IP': ip, ...headers } });
}

// Where a short link leads, asked as a tool that is never counted as a click.
async function goesTo(code) {
  const res = await click(code, { ua: 'curl/8.4.0' });
  return res.status === 302 ? res.headers.get('Location') : res.status;
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

function reviewRequest(path, { method = 'GET', cookie, headers = {}, body, origin = ORIGIN } = {}) {
  return reviewMf.dispatchFetch(`${origin}${path}`, {
    method,
    body,
    redirect: 'manual',
    headers: { 'User-Agent': BROWSER_UA, ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
}

function reviewPost(path, data, cookie, headers = {}) {
  return reviewRequest(path, {
    method: 'POST',
    cookie,
    body: JSON.stringify(data),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: ORIGIN,
      ...headers,
    },
  });
}

async function reviewCookie() {
  const res = await reviewRequest(`/?review=${REVIEW_KEY}`);
  assert.equal(res.status, 302);
  const cookie = setCookies(res).review;
  assert.equal(cookie.value, REVIEW_HASH);
  return `review=${cookie.value}`;
}

async function reviewCount(sql, ...params) {
  return (await reviewDb.prepare(sql).bind(...params).first()).n;
}

const SAMPLE_COMMENT = {
  path: '/',
  selector: 'h1',
  element_desc: 'h1 "a very good alternative to bitly"',
  x_pct: 40,
  y_pct: 20,
  viewport_w: 1280,
  author: 'Kiet',
  body: 'The hero is cramped on a phone. @Claude',
};

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

test('HEAD requests get the same status as GET and no body', async () => {
  const head = await request('/', { method: 'HEAD' });
  const get = await request('/');
  assert.equal(head.status, 200);
  assert.equal(get.status, 200);
  assert.equal(head.headers.get('Content-Type'), get.headers.get('Content-Type'));
  assert.equal(await head.text(), '');
  assert.equal((await request('/links', { method: 'HEAD' })).status, 200);
  assert.equal((await request('/zzzzzz', { method: 'HEAD' })).status, 404);

  const { code } = await createLink({ url: 'https://example.com/head-target' });
  const redirect = await click(code, { method: 'HEAD' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('Location'), 'https://example.com/head-target');
  assert.equal(await redirect.text(), '');
  await click(code);
  await waitForClicks(code, 1);
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

test('the homepage shows the headline, the four selling points and no footer statement', async () => {
  const html = await (await request('/')).text();
  assert.match(html, /<h1>a very good alternative to <span class="hl">bitly<\/span><\/h1>/);
  assert.equal(html.match(/<section class="usp"/g).length, 1);
  assert.equal(html.match(/<li><span class="ic t\d"/g).length, 4);
  for (const title of ['Paste and go', 'Free custom links', 'No sign-up', 'MCP-ready']) {
    assert.ok(html.includes(`<h3>${title}</h3>`), title);
  }
  assert.doesNotMatch(html, /See every click|Agent-ready/);
  assert.doesNotMatch(html, /<footer|tied to this browser/);
  assert.doesNotMatch(await (await request('/links')).text(), /class="usp"/);
});

test('the tab title is the headline, and every page links the cursor favicon', async () => {
  const { code, cookie } = await createLink({ name: 'Tab title' });
  assert.equal(code, 'tab-title');
  const cases = [
    ['/', 'Linki — a very good alternative to bitly'],
    [`/?new=${code}`, 'Linki — a very good alternative to bitly'],
    ['/links', 'Your links — Linki'],
    [`/links/${code}`, 'tab-title — Linki'],
    ['/no/such/page', 'Page not found — Linki'],
    ['/zzzzzz', 'Link not found — Linki'],
  ];
  for (const [path, title] of cases) {
    const html = await (await request(path, { cookie })).text();
    assert.ok(html.includes(`<title>${title}</title>`), path);
    assert.ok(html.includes('<link rel="icon" href="/favicon.svg" type="image/svg+xml">'), path);
  }
  const home = await (await request('/', { cookie })).text();
  assert.ok(home.includes('property="og:title" content="Linki — a very good alternative to bitly"'));
  assert.match(home, new RegExp(`method="post" action="/links/${code}/delete" data-row-delete`));
  assert.match(home, new RegExp(`aria-label="Delete ${ORIGIN}/${code}"`));
  const yours = await (await request('/links', { cookie })).text();
  assert.match(yours, new RegExp(`action="/links/${code}/delete"`));
  assert.match(yours, />Delete</);
});

test('the header logo and the favicon are the same drawing', async () => {
  const html = await (await request('/')).text();
  const logo = html.match(/<a class="brand" href="\/">(<svg.*?<\/svg>)Linki<\/a>/)[1];
  for (const path of ['/favicon.svg', '/favicon.ico']) {
    const res = await request(path);
    assert.equal(res.headers.get('Content-Type'), 'image/svg+xml');
    assert.equal(await res.text(), logo.replace(' aria-hidden="true"', ''), path);
  }
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
    for (const path of ['/robots.txt', '/favicon.svg', '/nothing/here/at/all']) {
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
  const { code, cookie, res } = await createLink({ url: 'example.com/hello' });
  assert.match(code, /^[a-z2-9]{6}$/);
  const owner = setCookies(res).owner;
  assert.match(owner.line, /HttpOnly/);
  assert.match(owner.line, /Secure/);
  assert.match(owner.line, /Max-Age=31536000/);
  const html = await (await request(`/?new=${code}`, { cookie })).text();
  assert.match(html, /Your short link is ready/);
  assert.ok(html.includes(`linki.test/${code}`));
  assert.doesNotMatch(html, /name="label"/);
});

test('a custom name becomes the short link, for free, and capitals do not matter', async () => {
  const home = await (await request('/')).text();
  assert.match(home, /<span class="pre" aria-hidden="true"><bdi>linki\.test\/<\/bdi><\/span>/);
  assert.match(home, /<input id="name" name="name"/);

  const { code } = await createLink({ url: 'https://example.com/tet', name: 'Khuyến mãi Tết!' });
  assert.equal(code, 'khuyen-mai-tet');
  for (const path of ['/khuyen-mai-tet', '/Khuyen-Mai-TET']) {
    const res = await request(path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get('Location'), 'https://example.com/tet');
  }
});

test('a name someone already has gets a short ending, and nobody is turned away', async () => {
  const first = await createLink({ url: 'https://example.com/first', name: 'spring-sale' });
  assert.equal(first.code, 'spring-sale');
  const second = await createLink({ url: 'https://example.com/second', name: 'Spring Sale' });
  assert.match(second.code, /^spring-sale-[a-z2-9]{2}$/);
  assert.equal(second.location, `/?new=${second.code}&asked=spring-sale`);
  const html = await (await request(second.location, { cookie: second.cookie })).text();
  assert.match(html, /“spring-sale” was already taken, so your link has a short ending\. You can change the name above\./);
  assert.equal((await request('/spring-sale')).headers.get('Location'), 'https://example.com/first');
  assert.equal((await request(`/${second.code}`)).headers.get('Location'), 'https://example.com/second');

  // Linki's own paths cannot be taken as names.
  const reserved = await createLink({ name: 'links' });
  assert.match(reserved.code, /^links-[a-z2-9]{2}$/);
  assert.equal((await request('/links')).status, 200);

  // A 40-character name still fits its ending.
  const long = 'a'.repeat(40);
  assert.equal((await createLink({ name: long })).code, long);
  assert.match((await createLink({ name: long })).code, /^a{37}-[a-z2-9]{2}$/);
});

test('a name with no usable letters is refused, and the form keeps what was typed', async () => {
  for (const name of ['a', '!!', '--', '日本']) {
    const res = await post('/create', { url: 'https://example.com/x', name });
    assert.equal(res.status, 400, name);
    const html = await res.text();
    assert.match(html, /A custom name needs at least 3 letters or numbers/, name);
    assert.ok(html.includes('value="https://example.com/x"'), name);
  }
});

test('the MCP link is offered under Recent links, and the hero stays clean', async () => {
  const { code, cookie } = await createLink();
  const res = await request(`/?new=${code}`, { cookie });
  const token = setCookies(res).mcp.value;
  const html = await res.text();
  assert.equal(html.match(/<aside class="mcpf"/g).length, 1);
  assert.match(html, new RegExp(`data-copy="${ORIGIN}/mcp/${token}">.*Copy MCP link</button>`));
  assert.ok(html.indexOf('<ul class="links">') < html.indexOf('<aside class="mcpf"'));
  const hero = html.slice(html.indexOf('<div class="hero'), html.indexOf('Recent links'));
  assert.doesNotMatch(hero, /MCP/);
  assert.equal((await rpc(token, 'tools/list')).status, 200);

  // It stays under the list on later visits, and Your links shows the same link below its list.
  const later = await (await request('/', { cookie: `${cookie}; mcp=${token}` })).text();
  assert.ok(later.includes(`data-copy="${ORIGIN}/mcp/${token}"`));
  const yours = await (await request('/links', { cookie: `${cookie}; mcp=${token}` })).text();
  assert.ok(yours.includes(`${ORIGIN}/mcp/${token}`));
  assert.ok(yours.indexOf('<ul class="links">') < yours.indexOf('<section class="agent"'));
  // A browser that lost the MCP cookie is sent to Your links, where Reset gives a new one.
  assert.match(await (await request('/', { cookie })).text(), /<a class="button secondary" href="\/links">.*Get MCP link<\/a>/);
  assert.doesNotMatch(await (await request('/')).text(), /class="mcpf"/);
});

test('a link can be renamed from its result box, and the clicks move with it', async () => {
  const { code, cookie } = await createLink({ url: 'https://example.com/rename-me', name: 'rename-me' });
  await click(code);
  await waitForClicks(code, 1);
  const card = await (await request(`/?new=${code}`, { cookie })).text();
  assert.match(card, new RegExp(`<form class="rn" method="post" action="/links/${code}/rename" data-rename data-confirm="Change the name\\?`));
  assert.match(card, /name="name"[^>]*value="rename-me"/);
  assert.match(card, /<button type="button" class="pen"[^>]*aria-label="Change the name">/);
  assert.match(card, /<button type="submit" class="sv">Save<\/button>/);
  assert.doesNotMatch(card, /class="tk"|Want a different name/); // no extra line under the box

  const json = { Accept: 'application/json' };
  const ok = await post(`/links/${code}/rename`, { name: 'Renamed Link', back: 'home' }, { cookie, headers: json });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, code: 'renamed-link', location: '/?new=renamed-link' });
  assert.equal(await goesTo('rename-me'), 404);
  assert.equal(await goesTo('renamed-link'), 'https://example.com/rename-me');
  assert.deepEqual(await linkRow('renamed-link'), { click_count: 1, unique_count: 1 });
  assert.equal(await count('SELECT COUNT(*) AS n FROM clicks WHERE code = ?', 'renamed-link'), 1);
  assert.equal(await count('SELECT COUNT(*) AS n FROM clicks WHERE code = ?', 'rename-me'), 0);
  assert.match(await (await request('/?new=renamed-link', { cookie })).text(), /value="renamed-link"/);

  // Without the page script the form still works, and the detail page sends you back to it.
  const plain = await post('/links/renamed-link/rename', { name: 'renamed-again', back: 'detail' }, { cookie });
  assert.equal(plain.status, 303);
  assert.equal(plain.headers.get('Location'), '/links/renamed-again');
  const detail = await (await request('/links/renamed-again', { cookie })).text();
  assert.match(detail, /action="\/links\/renamed-again\/rename" data-rename data-confirm=/);
  // Saving the same name changes nothing.
  assert.equal((await post('/links/renamed-again/rename', { name: 'renamed-again' }, { cookie, headers: json })).status, 200);
});

test('renaming to a taken name is refused with a message, and the owner picks another', async () => {
  const mine = await createLink({ url: 'https://example.com/mine', name: 'my-first-name' });
  const theirs = await createLink({ url: 'https://example.com/theirs', name: 'their-name' });
  await click(theirs.code);
  await waitForClicks(theirs.code, 1);
  const json = { Accept: 'application/json' };
  const rename = (code, name, options = {}) =>
    post(`/links/${code}/rename`, { name }, { cookie: mine.cookie, headers: json, ...options });

  const taken = await rename(mine.code, 'Their Name');
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).error, '“their-name” is already taken. Try another name.');
  assert.equal(await goesTo('my-first-name'), 'https://example.com/mine');
  assert.equal(await goesTo('their-name'), 'https://example.com/theirs');
  assert.equal(await count('SELECT COUNT(*) AS n FROM clicks WHERE code = ?', 'their-name'), 1);

  assert.equal((await rename(mine.code, 'links')).status, 409); // one of Linki's own paths
  assert.equal((await rename(mine.code, 'a')).status, 400);
  assert.equal((await rename(mine.code, '')).status, 400);
  assert.equal((await rename(theirs.code, 'stolen')).status, 404); // not my link
  assert.equal((await rename(mine.code, 'x'.repeat(3), { cookie: undefined })).status, 404); // no cookie
  assert.equal((await rename(mine.code, 'elsewhere', { headers: { ...json, Origin: 'https://evil.example' } })).status, 403);
  assert.equal(await count('SELECT COUNT(*) AS n FROM links WHERE code IN (?, ?)', 'stolen', 'elsewhere'), 0);
  const plain = await post(`/links/${mine.code}/rename`, { name: 'their-name' }, { cookie: mine.cookie });
  assert.equal(plain.status, 409);
  assert.match(await plain.text(), /Name not changed/);

  // A link with a lot of clicks keeps its name.
  await db.prepare('UPDATE links SET click_count = 1001 WHERE code = ?').bind(mine.code).run();
  const locked = await rename(mine.code, 'too-late');
  assert.equal(locked.status, 409);
  assert.match((await locked.json()).error, /more than 1,000 clicks/);
  const detail = await (await request(`/links/${mine.code}`, { cookie: mine.cookie })).text();
  assert.match(detail, /more than 1,000 clicks/);
  assert.doesNotMatch(detail, /<form class="rn"/);
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
  assert.match(await res.text(), /in the last hour/);
});

test('one address can create 50 links a day', async () => {
  const ip = freshIp();
  const creator = createHash('sha256').update(`test-secret|creator|${ip}`).digest('hex').slice(0, 32);
  const earlier = Math.floor(Date.now() / 1000) - 2 * 3600;
  const rows = [];
  for (let i = 0; i < 49; i++) {
    rows.push(
      db
        .prepare('INSERT INTO links (code, owner_id, destination, created_at, creator_hash) VALUES (?, ?, ?, ?, ?)')
        .bind(`daycap-${i}`, 'f'.repeat(32), 'https://example.com/', earlier, creator)
    );
  }
  await db.batch(rows);
  await createLink({ ip }); // the 50th
  const res = await post('/create', { url: 'https://example.com/more' }, { headers: { 'CF-Connecting-IP': ip } });
  assert.equal(res.status, 429);
  assert.match(await res.text(), /daily limit/);
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
  const mine = await createLink();
  const theirs = await createLink();
  await click(mine.code);
  await waitForClicks(mine.code, 1);
  const token = setCookies(await request('/links', { cookie: mine.cookie })).mcp.value;

  assert.equal((await rpc('a'.repeat(43), 'tools/list')).status, 401);
  assert.deepEqual(
    (await rpc(token, 'tools/list')).json.result.tools.map((t) => t.name),
    ['list_links', 'link_report', 'clicks_summary', 'create_link']
  );

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

test('an agent can create links through the connector, with its own smaller limit', async () => {
  const ip = freshIp();
  const { code, cookie } = await createLink({ ip });
  const token = setCookies(await request('/links', { cookie })).mcp.value;

  const made = await toolCall(token, 'create_link', { url: 'example.com/from-agent', name: 'Agent Made' });
  assert.equal(made.isError, undefined);
  assert.deepEqual(JSON.parse(made.content[0].text), {
    slug: 'agent-made',
    short_url: `${ORIGIN}/agent-made`,
    destination: 'https://example.com/from-agent',
  });
  assert.equal((await request('/agent-made')).headers.get('Location'), 'https://example.com/from-agent');
  const list = JSON.parse((await toolCall(token, 'list_links', {})).content[0].text);
  assert.deepEqual(list.links.map((l) => l.slug).sort(), ['agent-made', code].sort());
  assert.match(await (await request('/links', { cookie })).text(), /agent-made/);

  const again = JSON.parse((await toolCall(token, 'create_link', { url: 'https://example.com/2', name: 'agent-made' })).content[0].text);
  assert.match(again.slug, /^agent-made-[a-z2-9]{2}$/);
  assert.match(again.note, /already taken/);

  for (const args of [{}, { url: 'javascript:alert(1)' }, { url: 'https://linki.test/x' }, { url: 'https://example.com', name: 5 }]) {
    assert.equal((await toolCall(token, 'create_link', args)).isError, true, JSON.stringify(args));
  }

  // 10 an hour per connector: two are made, eight more fit, the next is refused.
  for (let i = 0; i < 8; i++) {
    assert.equal((await toolCall(token, 'create_link', { url: `https://example.com/n${i}` })).isError, undefined);
  }
  const refused = await toolCall(token, 'create_link', { url: 'https://example.com/too-many' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /10 links an hour and 25 a day/);
  // The website limit is counted separately, per network address.
  await createLink({ cookie, ip });
});

// ---------- link detail, time zone, delete ----------

test('the detail page is only visible to the link owner', async () => {
  const { code, cookie } = await createLink({ name: 'Launch post' });
  const other = await createLink();
  await click(code);
  await waitForClicks(code, 1);
  const html = await (await request(`/links/${code}`, { cookie })).text();
  assert.match(html, /<h1>launch-post<\/h1>/);
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

test('a list delete is POST-only, and a JSON delete removes the link and its clicks', async () => {
  const { code, cookie } = await createLink();
  await click(code);
  await waitForClicks(code, 1);
  const home = await (await request('/', { cookie })).text();
  assert.match(home, new RegExp(`method="post" action="/links/${code}/delete"`));
  assert.doesNotMatch(home, new RegExp(`href="/links/${code}/delete"`));

  assert.equal((await request(`/links/${code}/delete`, { cookie })).status, 404);
  assert.equal(await count('SELECT COUNT(*) AS n FROM links WHERE code = ?', code), 1);

  const other = await createLink();
  const denied = await post(`/links/${code}/delete`, {}, {
    cookie: other.cookie,
    headers: { Accept: 'application/json' },
  });
  assert.equal(denied.status, 404);
  assert.equal((await denied.json()).error, 'This link is not in your list.');

  const blocked = await post(`/links/${code}/delete`, {}, {
    cookie,
    headers: { Accept: 'application/json', Origin: 'https://evil.example' },
  });
  assert.equal(blocked.status, 403);
  assert.equal(await count('SELECT COUNT(*) AS n FROM clicks WHERE code = ?', code), 1);

  const ok = await post(`/links/${code}/delete`, {}, {
    cookie,
    headers: { Accept: 'application/json' },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal((await click(code)).status, 404);
  const missing = await (await click(code)).text();
  assert.match(missing, /Link not found/);
  assert.match(missing, /<link rel="icon" href="\/favicon\.svg"/);
  assert.equal(await count('SELECT COUNT(*) AS n FROM links WHERE code = ?', code), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM clicks WHERE code = ?', code), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM links WHERE code = ?', other.code), 1);
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

// ---------- staging review mode ----------

test('without REVIEW_KEY every review route is the normal 404 and no comment UI is injected', async () => {
  assert.equal(await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'review_comments'"), 1);
  const paths = ['/review/comments', '/review/link', '/review/agent/test-review-key', '/mcp-review/test-review-key'];
  for (const path of paths) {
    const res = await request(path);
    assert.equal(res.status, 404, path);
    const html = await res.text();
    assert.match(html, /Page not found/, path);
    assert.doesNotMatch(html, /review-fab|data-review/, path);
  }
  for (const [path, headers] of [
    ['/review/comments', { 'Content-Type': 'application/json', Origin: ORIGIN }],
    ['/review/comments', { 'Content-Type': 'application/json', Origin: 'https://evil.example' }],
    ['/mcp-review/test-review-key', { 'Content-Type': 'application/json', Origin: 'https://evil.example' }],
    ['/review/agent/test-review-key/comments/1', { 'Content-Type': 'application/json', Origin: 'https://evil.example' }],
  ]) {
    const res = await request(path, { method: 'POST', body: '{}', headers });
    assert.equal(res.status, 404, path);
    assert.match(await res.text(), /Page not found/);
  }
  const hinted = await request('/?review=test-review-key');
  assert.equal(hinted.status, 200);
  assert.equal(setCookies(hinted).review, undefined);
  const hintedHtml = await hinted.text();
  assert.doesNotMatch(hintedHtml, /review-fab|data-review/);
  assert.match(hintedHtml, /a very good alternative to <span class="hl">bitly<\/span>/);
  const withCookie = await (await request('/', { cookie: `review=${REVIEW_HASH}` })).text();
  assert.doesNotMatch(withCookie, /review-fab|data-review/);
  assert.match(withCookie, /method="post" action="\/create"/);
});

test('a correct review key sets a hashed cookie and a wrong key sets nothing', async () => {
  const ok = await reviewRequest(`/?new=abcd&review=${REVIEW_KEY}`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('Location'), '/?new=abcd');
  assert.equal(ok.headers.get('Cache-Control'), 'no-store');
  const cookie = setCookies(ok).review;
  assert.equal(cookie.value, REVIEW_HASH);
  assert.match(cookie.line, /HttpOnly/);
  assert.match(cookie.line, /Secure/);
  assert.match(cookie.line, /SameSite=Lax/);
  assert.equal(setCookies(ok).owner, undefined);

  const bad = await reviewRequest('/links?review=not-the-key');
  assert.equal(bad.status, 200);
  assert.equal(bad.headers.get('Location'), null);
  assert.equal(setCookies(bad).review, undefined);
  const html = await bad.text();
  assert.doesNotMatch(html, /review-fab/);

  const home = await reviewRequest('/', { cookie: `review=${REVIEW_HASH}` });
  const page = await home.text();
  assert.match(page, /<body class="review-on">/);
  assert.match(page, /review-fab/);
  assert.match(page, /crosshair/);
  assert.match(page, /Copy agent link/);
  assert.doesNotMatch(page, new RegExp(REVIEW_KEY));
  const csp = home.headers.get('Content-Security-Policy');
  const nonce = csp.match(/'nonce-([A-Za-z0-9_-]+)'/)[1];
  const scripts = [...page.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const review = scripts.find((src) => src.includes('review-fab'));
  assert.ok(review);
  assert.match(page, new RegExp(`<script nonce="${nonce}">[\\s\\S]*review-fab`));
  assert.doesNotMatch(review, /gtag|\/create/);
  assert.match(page, /<h1>a very good alternative to <span class="hl">bitly<\/span><\/h1>/);
  assert.match(page, /class="create"/);
  assert.match(page, /id="name" name="name"/);
  const made = await reviewRequest('/create', {
    method: 'POST',
    body: new URLSearchParams({ url: 'https://example.com/row', name: 'pinned-row' }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
  });
  assert.equal(made.status, 303);
  const yours = await (
    await reviewRequest('/links', { cookie: `review=${REVIEW_HASH}; owner=${setCookies(made).owner.value}` })
  ).text();
  assert.match(yours, /<h1>Your links<\/h1>/);
  assert.match(yours, /Use Linki from your AI agent/);
  assert.match(yours, /class="secondary del"/);
  assert.match(yours, /review-fab/);
});

test('a custom name cannot shadow /review or /mcp-review', async () => {
  for (const name of ['review', 'mcp-review']) {
    const made = await createLink({ name, url: `https://example.com/${name}` });
    assert.match(made.code, new RegExp(`^${name}-[a-z2-9]{2}$`));
    const page = await request(`/${name}`);
    assert.equal(page.status, 404);
    assert.equal(page.headers.get('Location'), null);
    assert.match(await page.text(), /Page not found/);
    assert.equal((await request(`/${made.code}`)).headers.get('Location'), `https://example.com/${name}`);
  }
  const renamed = await createLink({ name: 'keep-me' });
  const blocked = await post(`/links/${renamed.code}/rename`, { name: 'review' }, { cookie: renamed.cookie });
  assert.equal(blocked.status, 409);
  assert.equal((await request('/keep-me')).status, 302);
  assert.equal((await request('/review')).status, 404);

  assert.equal((await reviewRequest('/review/comments')).status, 401);
  const mcp = await reviewRequest('/mcp-review/not-the-key', {
    method: 'POST',
    body: '{}',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(mcp.status, 401);
});

test('review comments can be created, listed, replied to, and resolved only with the cookie', async () => {
  const cookie = await reviewCookie();
  const linksBefore = await reviewCount('SELECT COUNT(*) AS n FROM links');
  const denied = await reviewPost('/review/comments', SAMPLE_COMMENT);
  assert.equal(denied.status, 401);
  const tampered = await reviewPost('/review/comments', SAMPLE_COMMENT, `review=${'a'.repeat(64)}`);
  assert.equal(tampered.status, 401);

  const blocked = await reviewPost('/review/comments', SAMPLE_COMMENT, cookie, { Origin: 'https://evil.example' });
  assert.equal(blocked.status, 403);
  assert.equal(await reviewCount('SELECT COUNT(*) AS n FROM review_comments'), 0);

  const created = await reviewPost('/review/comments', SAMPLE_COMMENT, cookie);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('Cache-Control'), 'no-store');
  const comment = await created.json();
  assert.equal(comment.path, '/');
  assert.equal(comment.status, 'open');
  assert.deepEqual(comment.mentions, ['Claude']);
  assert.equal(comment.author, 'Kiet');
  assert.equal(comment.viewport_w, 1280);
  assert.equal(await reviewCount('SELECT COUNT(*) AS n FROM links'), linksBefore);

  const onLinks = await reviewPost('/review/comments', {
    ...SAMPLE_COMMENT,
    path: '/links',
    selector: 'button.del',
    element_desc: 'button "Delete" in row 2 of Your links',
    body: 'Move Delete away from Copy. Email kiet@example.com stays plain.',
    author: '',
  }, cookie);
  assert.equal(onLinks.status, 201);
  const second = await onLinks.json();
  assert.equal(second.author, 'Kiet');
  assert.deepEqual(second.mentions, []);
  assert.ok(second.id > comment.id);

  const tooLong = await reviewPost('/review/comments', { ...SAMPLE_COMMENT, body: 'x'.repeat(4001) }, cookie);
  assert.equal(tooLong.status, 400);

  const listed = await reviewRequest('/review/comments?path=/', { cookie });
  const pageComments = await listed.json();
  assert.deepEqual(pageComments.comments.map((row) => row.id), [comment.id]);
  const encoded = await reviewRequest('/review/comments?path=%2Flinks', { cookie });
  assert.deepEqual((await encoded.json()).comments.map((row) => row.id), [second.id]);

  const reply = await reviewPost(`/review/comments/${comment.id}/reply`, { body: 'I will look.', author: 'Kiet' }, cookie);
  assert.equal(reply.status, 201);
  const got = await reviewRequest(`/review/comments?path=${encodeURIComponent('/')}`, { cookie });
  const withReply = (await got.json()).comments[0];
  assert.equal(withReply.replies.length, 1);
  assert.equal(withReply.replies[0].body, 'I will look.');
  const updatedAt = withReply.updated_at;

  const readOnly = await reviewRequest(`/review/comments/${comment.id}`, { cookie });
  assert.equal(readOnly.status, 405);
  assert.equal((await reviewRequest(`/review/comments?path=/`, { cookie }).then((res) => res.json())).comments[0].updated_at, updatedAt);

  const resolved = await reviewPost(`/review/comments/${comment.id}`, { status: 'fixed', pr_url: 'https://example.com/should-be-ignored' }, cookie);
  assert.equal(resolved.status, 200);
  const fixed = await resolved.json();
  assert.equal(fixed.status, 'fixed');
  assert.equal(fixed.pr_url, null);

  const missing = await reviewPost('/review/comments/999999/reply', { body: 'nope', author: 'Kiet' }, cookie);
  assert.equal(missing.status, 404);
});

test('the agent link is markdown and JSON, and a wrong key is rejected', async () => {
  const wrong = await reviewRequest('/review/agent/not-the-key');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('Cache-Control'), 'no-store');
  assert.match(await wrong.text(), /Unauthorized/);

  const res = await reviewRequest(`/review/agent/${REVIEW_KEY}?status=open&mention=Claude`);
  assert.equal(res.headers.get('Content-Type'), 'text/markdown; charset=utf-8');
  const browser = await reviewRequest(`/review/agent/${REVIEW_KEY}`, { headers: { 'Sec-Fetch-Dest': 'document' } });
  assert.equal(browser.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.match(await browser.text(), /# Linki review/);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const markdown = await res.text();
  assert.match(markdown, /https:\/\/github.com\/kiethuynhvn333\/linki/);
  assert.match(markdown, /Never push to main/);
  assert.match(markdown, /Kiet approves merges/);
  assert.doesNotMatch(markdown, /The hero is cramped/);
  assert.doesNotMatch(markdown, new RegExp(REVIEW_KEY));

  const openLinks = await reviewRequest(`/review/agent/${REVIEW_KEY}?status=open&path=/links`);
  const openMarkdown = await openLinks.text();
  assert.match(openMarkdown, /button "Delete" in row 2 of Your links/);
  assert.match(openMarkdown, /Viewport: 1280px/);
  assert.doesNotMatch(openMarkdown, /The hero is cramped/);

  const all = await (await reviewRequest(`/review/agent/${REVIEW_KEY}?format=json`)).json();
  assert.equal(all.repo, 'https://github.com/kiethuynhvn333/linki');
  assert.deepEqual(all.comments.map((row) => row.path), ['/links', '/']);
  assert.equal(all.comments[1].replies[0].body, 'I will look.');
  assert.equal(all.comments[1].status, 'fixed');

  const before = await reviewDb.prepare('SELECT updated_at FROM review_comments WHERE path = ?').bind('/links').first();
  await reviewRequest(`/review/agent/${REVIEW_KEY}`);
  const after = await reviewDb.prepare('SELECT updated_at FROM review_comments WHERE path = ?').bind('/links').first();
  assert.equal(after.updated_at, before.updated_at);
});

test('agents can update a comment over MCP and over plain POST without an Origin check', async () => {
  const cookie = await reviewCookie();
  const created = await (await reviewPost('/review/comments', {
    ...SAMPLE_COMMENT,
    path: '/links',
    body: 'Chart labels overlap. @Linki',
  }, cookie)).json();

  const denied = await reviewRequest('/mcp-review/not-the-key', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(denied.status, 401);

  const listed = await reviewRequest(`/mcp-review/${REVIEW_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    headers: { 'Content-Type': 'application/json', Origin: 'https://claude.ai' },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('Cache-Control'), 'no-store');
  const tools = (await listed.json()).result.tools.map((tool) => tool.name);
  assert.deepEqual(tools, ['list_comments', 'get_comment', 'update_comment', 'reply']);

  const pr = 'https://github.com/kiethuynhvn333/linki/pull/12';
  const updated = await reviewRequest(`/mcp-review/${REVIEW_KEY}`, {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'update_comment', arguments: { id: created.id, status: 'in_progress', note: 'On a branch.', assignee: 'Claude' } },
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  const progress = JSON.parse((await updated.json()).result.content[0].text);
  assert.equal(progress.status, 'in_progress');
  assert.equal(progress.assignee, 'Claude');

  const plain = await reviewRequest(`/review/agent/${REVIEW_KEY}/comments/${created.id}`, {
    method: 'POST',
    body: JSON.stringify({ status: 'fixed', pr_url: pr, note: 'Opened the pull request.' }),
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
  });
  assert.equal(plain.status, 200);
  const fixed = await plain.json();
  assert.equal(fixed.status, 'fixed');
  assert.equal(fixed.pr_url, pr);
  assert.equal(fixed.status_note, 'Opened the pull request.');

  const agentReply = await reviewRequest(`/review/agent/${REVIEW_KEY}/comments/${created.id}/reply`, {
    method: 'POST',
    body: JSON.stringify({ body: 'Marked fixed.', author: 'Claude' }),
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
  });
  assert.equal(agentReply.status, 201);

  const filtered = await (await reviewRequest(`/review/agent/${REVIEW_KEY}?status=fixed&mention=Linki&path=/links&format=json`)).json();
  assert.equal(filtered.comments.length, 1);
  assert.equal(filtered.comments[0].id, created.id);
  assert.equal(filtered.comments[0].replies.at(-1).body, 'Marked fixed.');

  const link = await (await reviewRequest('/review/link', { cookie })).json();
  assert.equal(link.url, `${ORIGIN}/review/agent/${REVIEW_KEY}`);
  assert.equal(link.text, `${link.url}\nRead this, fix open comments in the Linki repo, open a PR, mark them fixed.`);
  const linkDenied = await reviewRequest('/review/link');
  assert.equal(linkDenied.status, 401);
});

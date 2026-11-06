'use strict';

/**
 * Sulduz Cloud self-test.
 *
 * Boots the real server in a throwaway data directory and drives the HTTP API
 * end to end. It never touches x-ui and never writes into the production data
 * directory, so it is safe to run on any machine with a Node.js runtime.
 *
 *   npm run selftest
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3300 + Math.floor(Math.random() * 200);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-selftest-'));
const OWNER = 'selftest';
const OWNER_PASS = crypto.randomBytes(12).toString('base64url');
const SHOP = 'testshop';
const SHOP_PASS = crypto.randomBytes(12).toString('base64url');

let pass = 0;
let fail = 0;
function check(name, ok, note = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}${note ? '  — ' + note : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${note ? '  — ' + note : ''}`); }
}

function request(method, urlPath, { body, cookies, csrf, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      host: '127.0.0.1',
      port: PORT,
      path: urlPath,
      method,
      headers: { accept: 'application/json', ...headers },
      timeout: 15000,
    };
    if (payload) {
      opts.headers['content-type'] = 'application/json';
      opts.headers['content-length'] = Buffer.byteLength(payload);
    }
    if (cookies) opts.headers.cookie = cookies;
    if (csrf) opts.headers['x-csrf-token'] = csrf;
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* non-json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, raw });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookiesFrom(headers) {
  const list = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [];
  const jar = {};
  for (const line of list) {
    const pair = line.split(';')[0];
    const idx = pair.indexOf('=');
    jar[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(child) {
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await request('GET', '/api/health');
      if (res.status === 200) return;
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('server did not become ready in time');
}

/**
 * In-process fake of the x-ui API. It is only ever bound to 127.0.0.1 on a
 * random port, so the suite can create and renew real configs (wallet billing,
 * quota maths, group renewal) without touching a production panel.
 */
function startMockXui(inboundRows) {
  const clients = new Map();
  // Every call the panel makes is recorded, so a test can prove WHICH endpoint it
  // used: on the real x-ui 3.8.5 a channel only moves through bulkAttach, and the
  // suite must catch a regression back to the update query.
  const calls = [];
  // Emails the panel is not allowed to attach: the live question of what the panel
  // does when x-ui refuses an attach, without any duplicate client being deleted.
  const refuseAttach = new Set();
  // A node that does not take the whole inbound list on clients/add. The panel has
  // to notice that from the re-read and attach the leftovers through bulkAttach —
  // it must never paper over a missing channel by writing a row the node does not
  // serve, and never by creating a second client for the same customer.
  const quirks = { addKeepsOnlyFirst: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = decodeURIComponent(url.pathname.replace(/^\/panel\/api/, ''));
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }
      calls.push({ method: req.method, route, query: Object.fromEntries(url.searchParams.entries()), body });
      const send = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, msg: '', obj }));
      };
      const failMsg = (msg) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, msg, obj: null }));
      };
      const emailOf = (suffix) => route.slice(route.indexOf(suffix) + suffix.length);
      // x-ui 3.2.5+ refuses a subId already held by a different client.
      const subIdTaken = (subId, exceptEmail = '') => Boolean(subId)
        && [...clients.values()].some((c) => String(c.email) !== String(exceptEmail) && String(c.subId || '') === String(subId));
      try {
        if (route === '/inbounds/options') return send(inboundRows);
        if (route === '/inbounds/list/slim') {
          return send(inboundRows.map((row, index) => ({ id: row.id, subSortIndex: index + 1 })));
        }
        if (route === '/nodes/list') return send([]);
        if (route === '/server/status') return send({ cpu: 0, mem: { current: 0, total: 1 }, uptime: 0 });
        if (route === '/clients/list') return send([...clients.values()]);
        if (route.startsWith('/clients/get/')) {
          const client = clients.get(emailOf('/clients/get/'));
          // The real panel answers a client that is not on it with success:false
          // and "Obtain (record not found)" — not with an empty body. The double
          // has to answer the same way, or the panel would never learn that a
          // customer has no subscription on the node any more.
          if (!client) return failMsg('Obtain (record not found)');
          return send({ client, inboundIds: client.inboundIds || [] });
        }
        if (route === '/clients/add') {
          const incoming = body.client || {};
          if (subIdTaken(incoming.subId)) return failMsg(`subId already in use: ${incoming.subId}`);
          const wanted = (body.inboundIds || []).map(Number);
          clients.set(String(incoming.email), {
            ...incoming, id: incoming.id, inboundIds: quirks.addKeepsOnlyFirst ? wanted.slice(0, 1) : wanted,
          });
          return send(null);
        }
        if (route.startsWith('/clients/update/')) {
          const email = emailOf('/clients/update/');
          const current = clients.get(email);
          if (!current) return send(null);
          const next = { ...current, ...body, email };
          if (next.subId && next.subId !== current.subId && subIdTaken(next.subId, email)) {
            return failMsg(`subId already in use: ${next.subId}`);
          }
          // x-ui 3.8.5 semantics, proven live on dash: the update endpoint rewrites
          // the client in the inbounds that already hold it. A channel listed in
          // ?inboundIds= that the client is NOT in is ignored — it neither attaches
          // nor detaches anything. Channels move through bulkAttach / <email>/detach.
          const inboundIds = url.searchParams.get('inboundIds');
          if (inboundIds) {
            const listed = inboundIds.split(',').map(Number);
            next.inboundIds = (current.inboundIds || []).filter((id) => listed.includes(Number(id)));
            if (!next.inboundIds.length) next.inboundIds = current.inboundIds || [];
          }
          clients.set(email, next);
          return send(null);
        }
        if (route === '/clients/bulkAttach') {
          // The endpoint the panel's own "attach clients" dialog posts to, with the
          // same body ({emails, inboundIds}) and the same answer shape.
          const ids = (body.inboundIds || []).map(Number);
          const attached = [];
          const skipped = [];
          const errors = [];
          for (const raw of body.emails || []) {
            const email = String(raw);
            const current = clients.get(email);
            if (!current) { errors.push(`${email}: record not found`); continue; }
            const before = (current.inboundIds || []).map(Number);
            if (refuseAttach.has(email)) { skipped.push(email); continue; }
            const next = [...new Set([...before, ...ids])];
            if (next.length === before.length) skipped.push(email);
            else attached.push(email);
            clients.set(email, { ...current, inboundIds: next });
          }
          return send({ attached, skipped, errors });
        }
        if (/^\/clients\/[^/]+\/detach$/.test(route)) {
          const email = decodeURIComponent(route.split('/')[2]);
          const current = clients.get(email);
          if (!current) return failMsg(`Obtain (record not found)`);
          const drop = (body.inboundIds || []).map(Number);
          // A client lives inside the inbounds' settings: detaching the last channel
          // removes it from the panel altogether.
          const rest = (current.inboundIds || []).map(Number).filter((id) => !drop.includes(id));
          if (!rest.length) clients.delete(email);
          else clients.set(email, { ...current, inboundIds: rest });
          return send(true);
        }
        if (route.startsWith('/clients/del/')) {
          clients.delete(emailOf('/clients/del/'));
          return send(true);
        }
        if (route === '/clients/bulkEnable' || route === '/clients/bulkDisable') {
          for (const email of body.emails || []) {
            const current = clients.get(String(email));
            if (current) clients.set(String(email), { ...current, enable: route.endsWith('Enable') });
          }
          return send(true);
        }
        if (route.startsWith('/clients/links/')) {
          const email = emailOf('/clients/links/');
          // Real x-ui returns one link per inbound this client is attached to, which is
          // what makes the adopted multi-inbound case testable from the panel side.
          const attached = clients.get(email)?.inboundIds?.length ? clients.get(email).inboundIds : [1000];
          return send(attached.map((id) => `vless://mock-${email}@127.0.0.1:${1000 + Number(id)}?type=tcp#${encodeURIComponent(email)}-${id}`));
        }
        if (route.startsWith('/clients/resetTraffic/')) {
          // The real x-ui zeroes the client's OWN up/down here. Before v1.4.26 the
          // double answered `true` and left the counters alone, so a test could
          // never tell a reset that really reached the node from one that only
          // cleared the panel's copy — which the next sync would have undone.
          const target = clients.get(emailOf('/clients/resetTraffic/'));
          if (target) {
            target.up = 0;
            target.down = 0;
          }
          return send(true);
        }
        if (route === '/clients/onlines') return send([]);
        if (route === '/clients/bulkAdjust') return send((body.emails || []).map((email) => ({ email, ok: true })));
        if (route.startsWith('/clients/subLinks/')) {
          const subId = emailOf('/clients/subLinks/');
          const owner = [...clients.values()].find((c) => String(c.subId || '') === String(subId));
          if (!owner) return send([]);
          const attached = (owner.inboundIds || []).length ? owner.inboundIds : [1000];
          return send(attached.map((id) => `vless://mock-${owner.email}@127.0.0.1:${1000 + Number(id)}?type=tcp#${encodeURIComponent(owner.email)}-${id}`));
        }
        // Anything else does not exist on x-ui. Answering 404 instead of a friendly
        // `null` is what makes this double catch an invented endpoint — the panel
        // once "attached" through /clients/<email>/attach, a route the real binary
        // has never had, and the mock let it pass.
        const known = route.startsWith('/clients/') || route.startsWith('/inbounds/') || route.startsWith('/nodes/');
        if (known) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: false, msg: `not found: ${route}`, obj: null }));
          return undefined;
        }
        return send(null);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, msg: err.message, obj: null }));
        return undefined;
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, clients, calls, refuseAttach, quirks }));
  });
}

(async () => {
  console.log(`Sulduz Cloud self-test • data: ${DATA_DIR} • port: ${PORT}\n`);

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DATA_DIR,
      DB_PATH: path.join(DATA_DIR, 'panel.db'),
      BACKUP_DIR: path.join(DATA_DIR, 'backups'),
      XUI_TOKEN_FILE: path.join(DATA_DIR, 'secrets', 'xui-token'),
      ADMIN_USERNAME: '',
      ADMIN_PASSWORD: '',
      PUBLIC_URL: 'http://127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  let mockXui = null;
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  try {
    await waitForServer(child);

    // ------------------------------------------------------------- public API
    const health = await request('GET', '/api/health');
    check('health endpoint', health.status === 200 && health.json.ok === true);

    const meta = await request('GET', '/api/meta');
    check('meta is public and reports setup', meta.status === 200 && meta.json.data.setupRequired === true);

    const missing = await request('GET', '/api/does-not-exist');
    check('unknown api returns json 404', missing.status === 404 && missing.json.error.code === 'not_found');

    // ------------------------------------------------------------------ setup
    const setup = await request('POST', '/api/setup', {
      body: { username: OWNER, password: OWNER_PASS, name: 'Self Test', panelName: 'Self Test Panel' },
    });
    check('first-run setup creates owner', setup.status === 200 && setup.json.data.user.role === 'admin');
    const ownerCsrf = setup.json?.data?.csrf;
    let ownerCookies = cookiesFrom(setup.headers);

    const setupAgain = await request('POST', '/api/setup', { body: { username: 'x', password: 'y'.repeat(12) } });
    check('setup is one-shot', setupAgain.status === 403 && setupAgain.json.error.code === 'already_setup');

    const metaAfter = await request('GET', '/api/meta');
    check('setupRequired flips to false', metaAfter.json.data.setupRequired === false);

    // ------------------------------------------------------------------- auth
    const badLogin = await request('POST', '/api/auth/login', { body: { username: OWNER, password: 'wrong-password' } });
    check('wrong password rejected', badLogin.status === 401 && badLogin.json.error.code === 'invalid_credentials');

    const login = await request('POST', '/api/auth/login', { body: { username: OWNER, password: OWNER_PASS } });
    const csrf = login.json?.data?.csrf;
    const cookies = cookiesFrom(login.headers);
    check('owner login', login.status === 200 && login.json.data.user.isOwner === true);
    ownerCookies = cookies;
    check('csrf token issued', typeof csrf === 'string' && csrf.length >= 16);

    const me = await request('GET', '/api/auth/me', { cookies });
    check('session works on /auth/me', me.status === 200 && me.json.data.user.username === OWNER);

    const noCsrf = await request('PATCH', '/api/admin/settings/general', {
      cookies, body: { panelName: 'Nope' },
    });
    check('mutations require csrf header', noCsrf.status === 403 && noCsrf.json.error.code === 'csrf');

    const saved = await request('PATCH', '/api/admin/settings/general', {
      cookies, csrf, body: { panelName: 'Self Test Panel', defaultLang: 'fa' },
    });
    check('settings patch persists', saved.status === 200 && saved.json.data.saved.panelName === 'Self Test Panel');

    const badSection = await request('PATCH', '/api/admin/settings/nope', {
      cookies, csrf, body: { anything: 1 },
    });
    check('unknown settings section rejected', badSection.status === 404 || badSection.status === 422);

    // ------------------------------------------------------------------ users
    const weak = await request('POST', '/api/admin/users', {
      cookies, csrf, body: { username: 'weak', password: '123', role: 'reseller' },
    });
    check('weak password rejected on user create', weak.status === 422);

    const shop = await request('POST', '/api/admin/users', {
      cookies, csrf,
      body: { username: SHOP, password: SHOP_PASS, name: 'فروشگاه تست', role: 'reseller', max_configs: 10 },
    });
    const shopId = shop.json?.data?.user?.id;
    check('create reseller', shop.status === 201 && shopId > 0);

    const dup = await request('POST', '/api/admin/users', {
      cookies, csrf, body: { username: SHOP.toUpperCase(), password: SHOP_PASS, role: 'reseller' },
    });
    check('duplicate username rejected (case-insensitive)', dup.status === 409);

    const search = await request('GET', `/api/admin/users?search=${SHOP}`, { cookies });
    check('user search filters', search.status === 200 && search.json.data.rows.length === 1);

    // ------------------------------------------------------------- permissions
    const shopLogin = await request('POST', '/api/auth/login', { body: { username: SHOP, password: SHOP_PASS } });
    const shopCookies = cookiesFrom(shopLogin.headers);
    const shopCsrf = shopLogin.json?.data?.csrf;
    check('reseller login', shopLogin.status === 200 && shopLogin.json.data.user.role === 'reseller');

    const forbidden = await request('GET', '/api/admin/users', { cookies: shopCookies });
    check('reseller blocked from admin area', forbidden.status === 403);

    const shopOverview = await request('GET', '/api/reseller/overview', { cookies: shopCookies });
    check('reseller overview', shopOverview.status === 200 && shopOverview.json.data.configs.total === 0);

    const shopMe = await request('GET', '/api/auth/me', { cookies: shopCookies });
    check('reseller session payload', shopMe.status === 200 && shopMe.json.data.user.role === 'reseller');

    // ---------------------------------------------------------------- tickets
    const ticket = await request('POST', '/api/tickets', {
      cookies: shopCookies, csrf: shopCsrf,
      body: { subject: 'تست', body: 'متن تیکت تستی', priority: 'low' },
    });
    const ticketId = ticket.json?.data?.id;
    check('reseller opens ticket', ticket.status === 201 && ticketId > 0);

    const reply = await request('POST', `/api/tickets/${ticketId}/reply`, {
      cookies, csrf, body: { body: 'پاسخ ادمین' },
    });
    check('admin replies to ticket', reply.status === 200);

    const close = await request('POST', `/api/tickets/${ticketId}/status`, {
      cookies, csrf, body: { status: 'closed' },
    });
    check('admin closes ticket', close.status === 200 && close.json.data.status === 'closed');

    const shopTicket = await request('GET', `/api/tickets/${ticketId}`, { cookies: shopCookies });
    check('reseller sees closed ticket', shopTicket.status === 200 && shopTicket.json.data.status === 'closed');

    const shopClose = await request('POST', `/api/tickets/${ticketId}/status`, {
      cookies: shopCookies, csrf: shopCsrf, body: { status: 'open' },
    });
    check('only admin can change ticket status', shopClose.status === 403);

    // -------------------------------------------------------------- broadcast
    const broadcast = await request('POST', '/api/admin/broadcast', {
      cookies, csrf, body: { title: 'اطلاعیه', body: 'متن', audience: 'all' },
    });
    check('broadcast reaches resellers', broadcast.status === 200 && broadcast.json.data.recipients >= 1);

    const notes = await request('GET', '/api/notifications', { cookies: shopCookies });
    check('reseller notification inbox', notes.status === 200 && notes.json.data.unread >= 1);

    const readAll = await request('POST', '/api/notifications/read', {
      cookies: shopCookies, csrf: shopCsrf, body: { id: 0 },
    });
    check('mark all notifications read', readAll.status === 200);

    // -------------------------------------------------------- pricing & telegram
    const discList = await request('GET', `/api/admin/users/${shopId}/discounts`, { cookies });
    check('reseller discounts readable', discList.status === 200 && Array.isArray(discList.json.data.discounts));

    const badDisc = await request('PUT', `/api/admin/users/${shopId}/discounts`, {
      cookies, csrf, body: { discounts: [{ inboundId: 999999, percent: 150 }] },
    });
    check('invalid discount percent rejected', badDisc.status === 422 && badDisc.json.error.code === 'invalid_discount');

    const unknownInbound = await request('PUT', `/api/admin/users/${shopId}/discounts`, {
      cookies, csrf, body: { discounts: [{ inboundId: 999999, percent: 10 }] },
    });
    check('discount for unknown inbound rejected', unknownInbound.status === 404);

    const adminQuote = await request('POST', '/api/admin/pricing/quote', {
      cookies, csrf, body: { userId: shopId, inboundIds: [], gb: 30, days: 30 },
    });
    check('admin quote returns totals', adminQuote.status === 200 && adminQuote.json.data.total === 0 && typeof adminQuote.json.data.currency === 'string');

    const shopQuote = await request('POST', '/api/reseller/configs/quote', {
      cookies: shopCookies, csrf: shopCsrf, body: { inboundIds: [], gb: 30, days: 30 },
    });
    check('reseller quote works', shopQuote.status === 200 && shopQuote.json.data.count === 0 && shopQuote.json.data.sufficient === true);

    const tgTest = await request('POST', '/api/admin/settings/test-telegram', { cookies, csrf, body: {} });
    check('telegram test needs configuration', tgTest.status === 422 && tgTest.json.error.code === 'telegram_not_configured');

    // ----------------------------------------------------------------- backup
    const backup = await request('POST', '/api/admin/backups', { cookies, csrf, body: {} });
    const backupName = backup.json?.data?.name || '';
    check('create backup', backup.status === 201 && backup.json.data.size > 0);

    const backupList = await request('GET', '/api/admin/backups', { cookies });
    check('backup listed', backupList.status === 200 && backupList.json.data.rows.some((r) => r.name === backupName));
    check('backup reports telegram as unconfigured', backupList.status === 200 && backupList.json.data.telegram.configured === false);

    const schedSave = await request('PATCH', '/api/admin/backups/schedule', {
      cookies, csrf, body: { hour: 5, minute: 45, keep: 7 },
    });
    check(
      'backup schedule saves',
      schedSave.status === 200 && schedSave.json.data.hour === 5 && schedSave.json.data.minute === 45 && schedSave.json.data.keep === 7
    );
    check('backup schedule exposes timezone', typeof schedSave.json?.data?.timezone === 'string' && schedSave.json.data.timezone.length > 0);

    const schedPartial = await request('PATCH', '/api/admin/backups/schedule', { cookies, csrf, body: { auto: false } });
    check(
      'partial schedule patch keeps saved time',
      schedPartial.status === 200 && schedPartial.json.data.auto === false && schedPartial.json.data.hour === 5 && schedPartial.json.data.minute === 45
    );

    const schedForbidden = await request('PATCH', '/api/admin/backups/schedule', { cookies: shopCookies, csrf: shopCsrf, body: { hour: 1 } });
    check('reseller cannot change backup schedule', schedForbidden.status === 403);

    const tgSendNoConfig = await request('POST', `/api/admin/backups/${backupName}/telegram`, { cookies, csrf, body: {} });
    check('manual telegram send needs configuration', tgSendNoConfig.status === 422 && tgSendNoConfig.json.error.code === 'telegram_not_configured');

    // v1.4.27: switching the nightly report on is a promise that something will
    // arrive at the chosen hour, so it is refused while there is no bot to send
    // with instead of quietly doing nothing at 23:00.
    const reportNoToken = await request('PATCH', '/api/admin/settings/telegram', { cookies, csrf, body: { dailyReportEnabled: true } });
    check(
      'the nightly report cannot be switched on without a bot token',
      reportNoToken.status === 422 && reportNoToken.json?.error?.code === 'telegram_not_configured',
      `status=${reportNoToken.status} code=${reportNoToken.json?.error?.code}`
    );
    const reportDefaults = await request('GET', '/api/admin/settings', { cookies });
    const tgDefaultView = reportDefaults.json?.data?.settings?.telegram || {};
    check(
      'the report schedule ships with the defaults the settings card shows',
      tgDefaultView.dailyReportEnabled === false && tgDefaultView.dailyReportHour === 23
        && tgDefaultView.dailyReportMinute === 0 && tgDefaultView.dailyReportDaysAhead === 3
        && tgDefaultView.dailyReportResellers === true && tgDefaultView.dailyReportOwner === true,
      `tg=${JSON.stringify(tgDefaultView)}`
    );

    const tgSave = await request('PATCH', '/api/admin/settings/telegram', {
      cookies, csrf,
      body: { enabled: true, botToken: '123456:selftest-token', chatId: '-1001234567890', sendOnAuto: true },
    });
    check('telegram settings persist', tgSave.status === 200 && tgSave.json.data.saved.enabled === true);

    const settingsAfter = await request('GET', '/api/admin/settings', { cookies });
    const tgSettings = settingsAfter.json?.data?.settings?.telegram || {};
    check(
      'telegram token is redacted',
      tgSettings.botToken === '' && tgSettings.hasBotToken === true && tgSettings.chatId === '-1001234567890'
    );

    const smsSave = await request('PATCH', '/api/admin/settings/sms', {
      cookies,
      csrf,
      body: {
        enabled: true,
        provider: 'farazsms',
        apiKey: 'selftest-sms-key',
        sender: '50002178584000',
        to: '09120000000',
        events: {
          nodeOffline: { enabled: true },
          nodeOnline: { enabled: true },
          panelOffline: { enabled: true },
          panelOnline: { enabled: false },
          test: { enabled: true },
        },
      },
    });
    const savedEvents = smsSave.json?.data?.saved?.events || {};
    check(
      'per-notification SMS switches persist',
      smsSave.status === 200
        && savedEvents.nodeOffline?.enabled === true
        && savedEvents.panelOnline?.enabled === false
        && savedEvents.test?.enabled === true
        && smsSave.json?.data?.saved?.hasApiKey === true,
      JSON.stringify(savedEvents)
    );

    const legacySms = await request('PATCH', '/api/admin/settings/sms', {
      cookies,
      csrf,
      body: {
        mode: 'pattern',
        pattern: 'SJ3FgPrE0C',
        patternVar1: '{title}',
        patternNames: 'var1,var2',
        patterns: { nodeOffline: { code: 'NODE-DOWN', enabled: false } },
      },
    });
    const savedSms = legacySms.json?.data?.saved || {};
    const patternish = ['mode', 'pattern', 'patternVar1', 'patternNames', 'patterns'].filter((field) => field in savedSms);
    check(
      'pattern settings are refused and never stored',
      legacySms.status === 200
        && patternish.length === 0
        && savedSms.events?.panelOnline?.enabled === false,
      patternish.join(',')
    );

    const smsMute = await request('PATCH', '/api/admin/settings/sms', {
      cookies,
      csrf,
      body: { events: { nodeOffline: { enabled: false } } },
    });
    const mutedEvents = smsMute.json?.data?.saved?.events || {};
    check(
      'a notification can be muted while the others keep their state',
      smsMute.status === 200
        && mutedEvents.nodeOffline?.enabled === false
        && mutedEvents.nodeOnline?.enabled === true
        && mutedEvents.test?.enabled === true,
      JSON.stringify(mutedEvents)
    );

    const backupListAfter = await request('GET', '/api/admin/backups', { cookies });
    check('backup reports telegram delivery state', backupListAfter.status === 200 && backupListAfter.json.data.telegram.configured === true);

    const restoreGuard = await request('POST', '/api/admin/backups/restore', { cookies, csrf, body: {} });
    check('restore requires confirmation', restoreGuard.status === 422 || restoreGuard.status === 400);

    const backupDelete = await request('DELETE', `/api/admin/backups/${backupName}`, { cookies, csrf });
    check('delete backup', backupDelete.status === 200);

    // ------------------------------------------------------------------ audit
    const audit = await request('GET', '/api/admin/audit?action=setup.complete', { cookies });
    check('audit records setup', audit.status === 200 && audit.json.data.total >= 1);

    // -------------------------------------------------------- panel servers
    // Admins can register additional x-ui panels; tokens never come back.
    const serverList = await request('GET', '/api/admin/servers', { cookies });
    check(
      'servers list exposes panels without tokens',
      serverList.status === 200
        && Array.isArray(serverList.json.data.panels)
        && serverList.json.data.panels.every((row) => row.token === undefined),
      `panels=${serverList.json?.data?.panels?.length}`
    );
    check(
      'a fresh installation starts with no x-ui server',
      Array.isArray(serverList.json?.data?.panels) && serverList.json.data.panels.length === 0,
      `panels=${serverList.json?.data?.panels?.length}`
    );
    // Operators must be able to remove the only server they added.
    const loneCreate = await request('POST', '/api/admin/servers', {
      cookies, csrf,
      body: { name: 'Temp Panel', url: 'http://127.0.0.1:9998', token: 'temp-token' },
    });
    const loneId = loneCreate.json?.data?.server?.id || 0;
    const loneDelete = await request('DELETE', `/api/admin/servers/${loneId}`, { cookies, csrf });
    const afterLone = await request('GET', '/api/admin/servers', { cookies });
    check(
      'the only server can be deleted (panel returns to the blank state)',
      loneCreate.status === 201 && loneDelete.status === 200 && afterLone.json?.data?.panels?.length === 0,
      `create=${loneCreate.status} delete=${loneDelete.status} panels=${afterLone.json?.data?.panels?.length}`
    );

    // ------------------------------------------------ wallet billing (mock x-ui)
    // Point the primary panel at a fake x-ui so purchases and renewals run the
    // full code path — x-ui call, wallet charge, DB row — without a live panel.
    const mockRows = [
      { id: 901, remark: 'Order 30', protocol: 'vless', tag: 'tag30', port: 1000, network: 'tcp', security: 'none', listen: '', enable: true },
      { id: 902, remark: 'Order 10', protocol: 'vless', tag: 'tag10', port: 1000, network: 'tcp', security: 'none', listen: '', enable: true },
      { id: 903, remark: 'Order 20', protocol: 'vless', tag: 'tag20', port: 1000, network: 'tcp', security: 'none', listen: '', enable: true },
      { id: 904, remark: 'Order 10b', protocol: 'vless', tag: 'tag10b', port: 1000, network: 'tcp', security: 'none', listen: '', enable: true },
    ];
    mockXui = await startMockXui(mockRows);
    const urlOnly = await request('PATCH', '/api/admin/settings/xui', {
      cookies, csrf,
      body: { url: `http://127.0.0.1:${mockXui.port}`, verifyTls: false },
    });
    const afterUrlOnly = await request('GET', '/api/admin/servers', { cookies });
    check(
      'saving an address without a token does not create a server',
      urlOnly.status === 200 && afterUrlOnly.json?.data?.panels?.length === 0,
      `panels=${afterUrlOnly.json?.data?.panels?.length}`
    );
    const xuiSave = await request('PATCH', '/api/admin/settings/xui', {
      cookies, csrf,
      body: {
        url: `http://127.0.0.1:${mockXui.port}`,
        token: 'selftest-token',
        verifyTls: false,
        subBase: 'https://sub.example.com/sub',
      },
    });
    check('x-ui settings connect to the mock panel', xuiSave.status === 200 && xuiSave.json.data.xuiTest?.ok === true);
    const afterXuiSave = await request('GET', '/api/admin/servers', { cookies });
    check(
      'saving the first real connection creates the primary server',
      afterXuiSave.json?.data?.panels?.length === 1 && afterXuiSave.json.data.panels[0].hasToken === true,
      `panels=${afterXuiSave.json?.data?.panels?.length}`
    );
    const primaryId = afterXuiSave.json?.data?.panels?.[0]?.id || 0;
    // --------------------------------------------------------------- inbounds
    // Subscription order (x-ui subSortIndex) drives the admin list order. The rows
    // belong to the primary server, which now exists because of the x-ui save above.
    const Database = require('better-sqlite3');
    const panelDb = new Database(path.join(DATA_DIR, 'panel.db'));
    try {
      const insertInbound = panelDb.prepare(
        `INSERT INTO inbounds (id, server_id, xui_id, node_id, node_name, remark, protocol, tag, port, network,
           security, listen, price_fixed, price_per_gb, price_per_day, enabled, visible, sub_sort_index, updated_at)
         VALUES (?, ?, ?, 0, 'local', ?, 'vless', ?, 1000, 'tcp', 'none', '', ?, ?, ?, 1, 1, ?, ?)`
      );
      const now = Date.now();
      // The monitor may already have synced the mock inbounds; replace them so
      // the seeded rows keep stable ids for the price and order checks.
      panelDb.prepare('DELETE FROM inbounds WHERE server_id = ? AND xui_id BETWEEN 901 AND 904').run(primaryId);
      insertInbound.run(901, primaryId, 901, 'Order 30', 'tag30', 100, 10, 0, 30, now);
      insertInbound.run(902, primaryId, 902, 'Order 10', 'tag10', 0, 50, 0, 10, now);
      insertInbound.run(903, primaryId, 903, 'Order 20', 'tag20', 300, 0, 5, 20, now);
      insertInbound.run(904, primaryId, 904, 'Order 10b', 'tag10b', 0, 0, 0, 10, now);
    } finally {
      panelDb.close();
    }
    const ordered = await request('GET', '/api/admin/inbounds', { cookies });
    const orderIds = (ordered.json?.data?.rows || []).filter((row) => row.id >= 901).map((row) => row.id);
    check(
      'admin inbound list follows sub order',
      ordered.status === 200 && JSON.stringify(orderIds) === JSON.stringify([902, 904, 903, 901]),
      `ids=${orderIds.join(',')}`
    );
    const firstRow = (ordered.json?.data?.rows || [])[0] || {};
    check('inbound payload exposes subSortIndex', typeof firstRow.subSortIndex === 'number');

    const maxQuote = await request('POST', '/api/admin/pricing/quote', {
      cookies, csrf,
      body: { userId: shopId, inboundIds: [901, 902, 903], gb: 10, days: 30 },
    });
    const maxData = maxQuote.json?.data || {};
    const maxBasis = (maxData.items || []).find((item) => item.basis);
    check(
      'multi-inbound quote bills the highest inbound only',
      maxQuote.status === 200
        && maxData.total === 500
        && maxData.subtotal === 500
        && maxData.basisInboundId === 902
        && maxBasis?.inboundId === 902,
      `total=${maxData.total} basis=${maxData.basisInboundId}`
    );

    // Unlimited is admin-only: a reseller payload must never unlock it.
    const resellerUnlimited = await request('POST', '/api/reseller/configs/quote', {
      cookies: shopCookies,
      csrf: shopCsrf,
      body: { inboundIds: [902], gb: 0, days: 30, unlimited: true },
    });
    check(
      'reseller quote ignores the unlimited flag',
      resellerUnlimited.status === 200 && resellerUnlimited.json?.data?.unlimited === false,
      `unlimited=${resellerUnlimited.json?.data?.unlimited}`
    );

    // The monitor syncs on its own timer; force it here so the billing checks
    // below do not depend on timing.
    const forcedSync = await request('POST', '/api/admin/inbounds/sync', { cookies, csrf, body: { force: true } });
    check(
      'the primary server syncs the mock inbounds',
      forcedSync.status === 200 && Number(forcedSync.json?.data?.count ?? 0) >= 1,
      `count=${forcedSync.json?.data?.count}`
    );

    // ------------------------------------------- telegram subscription adoption
    // A reseller carries a numeric Telegram id: new clients are named
    // "<id>-<random>" and subscriptions that already live on a panel under that
    // id are adopted, without a wallet charge.
    const TG_ID = '700555111';
    const TG_GB = 1024 ** 3;
    const tgCreate = await request('POST', '/api/admin/users', {
      cookies, csrf,
      body: { username: 'tgshop', password: 'password123', role: 'reseller', telegram_id: TG_ID, balance: 5000000 },
    });
    const tgUserId = tgCreate.json?.data?.user?.id || 0;
    check(
      'a reseller stores its numeric telegram id',
      tgCreate.status === 201 && tgCreate.json.data.user.telegramId === TG_ID,
      `status=${tgCreate.status} id=${tgCreate.json?.data?.user?.telegramId}`
    );
    const tgBad = await request('POST', '/api/admin/users', {
      cookies, csrf, body: { username: 'tgbad', password: 'password123', role: 'reseller', telegram_id: '12ab' },
    });
    check('a non-numeric telegram id is rejected', tgBad.status === 422 && tgBad.json?.error?.code === 'invalid_telegram_id');
    const tgDup = await request('POST', '/api/admin/users', {
      cookies, csrf, body: { username: 'tgdup', password: 'password123', role: 'reseller', telegram_id: TG_ID },
    });
    check(
      'a telegram id belongs to one reseller only',
      tgDup.status === 409 && tgDup.json?.error?.code === 'telegram_id_taken',
      `status=${tgDup.status} code=${tgDup.json?.error?.code}`
    );

    // Pre-existing clients on the panel, created before this reseller existed.
    mockXui.clients.set(`${TG_ID}-11111`, {
      email: `${TG_ID}-11111`, id: 'tg-uuid-1', subId: 'tg-sub-1', security: 'auto',
      totalGB: 5 * TG_GB, expiryTime: Date.now() + 30 * 86400000, enable: true,
      up: 11, down: 22, inboundIds: [901, 902],
    });
    mockXui.clients.set(`${TG_ID}-22222`, {
      email: `${TG_ID}-22222`, id: 'tg-uuid-2', subId: 'tg-sub-2', security: 'auto',
      totalGB: 2 * TG_GB, expiryTime: 0, enable: true, up: 1, down: 2, inboundIds: [903],
    });
    mockXui.clients.set(`${TG_ID}9-33333`, {
      email: `${TG_ID}9-33333`, id: 'tg-uuid-3', subId: 'tg-sub-3', security: 'auto',
      totalGB: 1 * TG_GB, expiryTime: 0, enable: true, up: 0, down: 0, inboundIds: [901],
    });
    // Seller panels prefix the plan ("german🇩🇪-<id>-<random>") and some clients
    // carry the owner in x-ui's own tgId field; both are adopted.
    mockXui.clients.set(`german🇩🇪-${TG_ID}-44444`, {
      email: `german🇩🇪-${TG_ID}-44444`, id: 'tg-uuid-4', subId: 'tg-sub-4', security: 'auto',
      totalGB: 3 * TG_GB, expiryTime: 0, enable: true, up: 4, down: 5, inboundIds: [902],
    });
    mockXui.clients.set('tgid-only-666', {
      email: 'tgid-only-666', id: 'tg-uuid-6', subId: 'tg-sub-6', security: 'auto',
      tgId: Number(TG_ID), totalGB: 2 * TG_GB, expiryTime: 0, enable: true, up: 6, down: 7, inboundIds: [903],
    });

    const tgImport = await request('POST', `/api/admin/users/${tgUserId}/import`, { cookies, csrf, body: {} });
    check(
      'existing subscriptions are adopted by telegram id',
      tgImport.status === 200
        && tgImport.json.data.imported === 5
        && tgImport.json.data.restored === 0
        && tgImport.json.data.servers === 1,
      `imported=${tgImport.json?.data?.imported} servers=${tgImport.json?.data?.servers}`
    );
    // v1.4.17: this client is attached to inbound 901 AND 902 on the seller panel.
    // The panel used to record only the first one (configs.email was UNIQUE), which
    // is why the owner saw a single inbound on his legacy configurations.
    const adoptedRows = new Database(path.join(DATA_DIR, 'panel.db'))
      .prepare("SELECT id, inbound_id, sub_id, origin FROM configs WHERE email = ? AND deleted_at = 0 ORDER BY inbound_id")
      .all(`${TG_ID}-11111`);
    check('every inbound of an adopted client gets its own row',
      adoptedRows.length === 2 && adoptedRows.map((row) => row.inbound_id).join(',') === '901,902'
        && adoptedRows.every((row) => row.origin === 'external'),
      `rows=${adoptedRows.length} [${adoptedRows.map((row) => row.inbound_id).join(',')}]`);
    check('both rows share ONE subscription token (one customer, one pool)',
      adoptedRows.length === 2 && Boolean(adoptedRows[0].sub_id)
        && adoptedRows[0].sub_id === adoptedRows[1].sub_id,
      `tokens=${adoptedRows.map((row) => row.sub_id).join('|')}`);
    const adoptedDetail = await request('GET', `/api/admin/configs/${adoptedRows?.[0]?.id}`, { cookies });
    const adoptedGroup = adoptedDetail.json?.data?.group || [];
    check('the edit drawer of the legacy config lists both inbounds',
      adoptedDetail.status === 200 && adoptedGroup.length === 2
        && adoptedGroup.map((item) => item.inboundId).sort().join(',') === '901,902',
      `group=${adoptedGroup.length}`);
    check('adoption never created, changed or removed a client on the panel',
      mockXui.clients.get(`${TG_ID}-11111`)?.id === 'tg-uuid-1'
        && mockXui.clients.get(`${TG_ID}-11111`)?.subId === 'tg-sub-1',
      `id=${mockXui.clients.get(`${TG_ID}-11111`)?.id}`);
    const tgListAfterAdopt = await request('GET', `/api/admin/configs?userId=${tgUserId}&pageSize=50`, { cookies });
    const adoptedPackage = (tgListAfterAdopt.json?.data?.rows || [])
      .find((row) => row.email === `${TG_ID}-11111`);
    check('the customer still counts as ONE package carrying both inbounds',
      Number(adoptedPackage?.groupCount) === 2
        && (adoptedPackage?.inbounds || []).length === 2
        && Number(adoptedPackage?.used) === 33,
      `groupCount=${adoptedPackage?.groupCount} used=${adoptedPackage?.used}`);
    // The customer's own subscription link: one x-ui client behind two rows must give
    // two links, not four, and must advertise its counters once, not doubled.
    const adoptedToken = adoptedRows?.[0]?.sub_id;
    const adoptedFeed = await request('GET', `/api/sub/${adoptedToken}`);
    const adoptedLinks = Buffer.from(String(adoptedFeed?.raw || ''), 'base64').toString('utf8').split('\n').filter(Boolean);
    check('the adopted customer is served one link per inbound (no duplicates)',
      adoptedFeed.status === 200 && adoptedLinks.length === 2 && new Set(adoptedLinks).size === 2
        && adoptedLinks.every((link) => link.startsWith('vless://')),
      `status=${adoptedFeed.status} links=${adoptedLinks.length} [${adoptedLinks.join(' ')}]`.slice(0, 200));
    const adoptedInfo = String(adoptedFeed.headers?.['subscription-userinfo'] || '');
    check('the adopted feed advertises the shared client once',
      adoptedInfo.includes('upload=11') && adoptedInfo.includes('download=22')
        && adoptedInfo.includes(`total=${5 * TG_GB}`),
      `header=${adoptedInfo}`);
    // v1.4.18: this customer IS one x-ui client, and a client's subscription
    // lives on the node's own subscription server (<sub_base>/<subId>), which
    // already lists every inbound he is attached to. The panel must not insert
    // its own address between the customer and the node.
    const adoptedLinkCall = await request('GET', `/api/admin/configs/${adoptedRows?.[0]?.id}/links`, { cookies });
    const adoptedSubs = adoptedLinkCall.json?.data?.subscriptions || {};
    check('an adopted one-client package is handed the node subscription address',
      adoptedLinkCall.status === 200
        && String(adoptedLinkCall.json?.data?.subUrl || '') === 'https://sub.example.com/sub/tg-sub-1'
        && Number(adoptedSubs.clientCount) === 1 && adoptedSubs.source === 'node'
        && Number(adoptedSubs.node?.[0]?.inboundCount) === 2,
      `subUrl=${adoptedLinkCall.json?.data?.subUrl} clients=${adoptedSubs.clientCount} inbounds=${adoptedSubs.node?.[0]?.inboundCount}`);
    const tgDetail = await request('GET', `/api/admin/users/${tgUserId}`, { cookies });
    const tgEmails = (tgDetail.json?.data?.configs?.rows || []).map((row) => row.email);
    check(
      'a longer id is never matched by prefix',
      tgEmails.includes(`${TG_ID}-11111`)
        && tgEmails.includes(`${TG_ID}-22222`)
        && !tgEmails.some((email) => email.startsWith(`${TG_ID}9-`)),
      tgEmails.join(',')
    );
    check(
      'prefixed seller names and x-ui tgId are adopted as old-panel rows',
      tgEmails.includes(`german🇩🇪-${TG_ID}-44444`)
        && tgEmails.includes('tgid-only-666')
        && (tgDetail.json?.data?.configs?.rows || []).every((row) => row.origin === 'external'),
      tgEmails.join(',')
    );
    const tgImportAgain = await request('POST', `/api/admin/users/${tgUserId}/import`, { cookies, csrf, body: {} });
    check(
      'adopting twice refreshes instead of duplicating',
      tgImportAgain.json?.data?.imported === 0 && tgImportAgain.json?.data?.refreshed === 5,
      `imported=${tgImportAgain.json?.data?.imported} refreshed=${tgImportAgain.json?.data?.refreshed}`
    );

    const tgLogin = await request('POST', '/api/auth/login', { body: { username: 'tgshop', password: 'password123' } });
    const tgCookies = cookiesFrom(tgLogin.headers);
    const tgCsrf = tgLogin.json?.data?.csrf;
    const tgList = await request('GET', '/api/reseller/configs', { cookies: tgCookies });
    const tgRows = tgList.json?.data?.rows || [];
    check(
      'the reseller can manage the subscriptions they already had',
      tgLogin.status === 200 && tgRows.length === 4,
      `rows=${tgRows.length}`
    );
    const adopted = tgRows.find((row) => row.email === `${TG_ID}-11111`);
    const tgExtend = await request('POST', `/api/reseller/configs/${adopted?.id}/extend`, {
      cookies: tgCookies, csrf: tgCsrf, body: { gb: 1, days: 0 },
    });
    const adoptedClient = mockXui.clients.get(`${TG_ID}-11111`);
    check(
      'renewing an adopted multi-inbound client keeps every inbound attached',
      tgExtend.status === 200
        && (adoptedClient?.inboundIds || []).map(Number).sort().join(',') === '901,902'
        && Number(adoptedClient?.totalGB) === 6 * TG_GB,
      `status=${tgExtend.status} inbounds=${adoptedClient?.inboundIds} total=${adoptedClient?.totalGB}`
    );

    const tgNew = await request('POST', '/api/reseller/configs', {
      cookies: tgCookies, csrf: tgCsrf, body: { inboundIds: [904], gb: 1, days: 1, customerName: 'مشتری تلگرام' },
    });
    const tgNewEmail = tgNew.json?.data?.configs?.[0]?.email || '';
    check(
      'a new client is named "<telegramId>-<random>"',
      tgNew.status === 201 && tgNewEmail.startsWith(`${TG_ID}-`) && /^\d{5}$/.test(tgNewEmail.slice(TG_ID.length + 1)),
      `email=${tgNewEmail}`
    );

    // v1.4.10: adopted rows carry origin=external, the list can isolate them and
    // a per-reseller switch hides them without deleting anything in x-ui.
    const tgExtList = await request('GET', `/api/admin/configs?origin=external&userId=${tgUserId}&pageSize=50`, { cookies });
    const tgPanelList = await request('GET', `/api/admin/configs?origin=panel&userId=${tgUserId}&pageSize=50`, { cookies });
    check(
      'the config list isolates old-panel subscriptions from panel customers',
      tgExtList.status === 200 && tgExtList.json.data.total === 4
        && tgExtList.json.data.rows.every((row) => row.origin === 'external')
        && tgPanelList.status === 200 && tgPanelList.json.data.total === 1
        && tgPanelList.json.data.rows.every((row) => row.origin === 'panel'),
      `external=${tgExtList.json?.data?.total} panel=${tgPanelList.json?.data?.total}`
    );
    const tgOff = await request('PATCH', `/api/admin/users/${tgUserId}`, { cookies, csrf, body: { import_configs: false } });
    check(
      'the adoption switch can be turned off',
      tgOff.status === 200 && tgOff.json.data.user.importConfigs === false,
      `status=${tgOff.status} importConfigs=${tgOff.json?.data?.user?.importConfigs}`
    );
    const tgOffImport = await request('POST', `/api/admin/users/${tgUserId}/import`, { cookies, csrf, body: {} });
    check(
      'a switched-off reseller cannot run an adoption pass',
      tgOffImport.status === 409 && tgOffImport.json?.error?.code === 'import_disabled',
      `status=${tgOffImport.status} code=${tgOffImport.json?.error?.code}`
    );
    const tgOffList = await request('GET', '/api/reseller/configs', { cookies: tgCookies });
    const tgOffRows = tgOffList.json?.data?.rows || [];
    check(
      'switching off hides only the adopted subscriptions',
      tgOffList.status === 200 && tgOffRows.length === 1 && tgOffRows[0].origin === 'panel',
      `rows=${tgOffRows.length}`
    );
    const tgOn = await request('PATCH', `/api/admin/users/${tgUserId}`, { cookies, csrf, body: { import_configs: true } });
    check(
      'turning the switch back on re-runs adoption',
      tgOn.status === 200 && tgOn.json.data.user.importConfigs === true
        && tgOn.json.data.import?.refreshed === 5,
      `refreshed=${tgOn.json?.data?.import?.refreshed}`
    );
    const tgOnList = await request('GET', '/api/reseller/configs', { cookies: tgCookies });
    check(
      'the adopted subscriptions come back after switching on',
      (tgOnList.json?.data?.rows || []).length === 5,
      `rows=${(tgOnList.json?.data?.rows || []).length}`
    );

    // Admins can register additional x-ui panels; tokens never come back.
    const serverCreate = await request('POST', '/api/admin/servers', {
      cookies,
      csrf,
      body: { name: 'Self Test Panel 2', url: 'http://127.0.0.1:9999', token: 'selftest-token', subBase: 'https://sub.example.com:2096/sub' },
    });
    const newServerId = serverCreate.json?.data?.server?.id || 0;
    check(
      'admin can add a second x-ui server',
      serverCreate.status === 201 && newServerId > 0 && serverCreate.json.data.server.hasToken === true,
      `id=${newServerId}`
    );
    const serverPatch = await request('PATCH', `/api/admin/servers/${newServerId}`, {
      cookies,
      csrf,
      body: { name: 'Self Test Panel 2b', enabled: false },
    });
    check('admin can edit a server', serverPatch.status === 200 && serverPatch.json.data.server.name === 'Self Test Panel 2b');
    const httpsPatch = await request('PATCH', `/api/admin/servers/${newServerId}`, {
      cookies,
      csrf,
      body: { url: 'https://dash.example.com:2053/SulduzServer24' },
    });
    check(
      'an https panel address is kept as https',
      httpsPatch.status === 200 && httpsPatch.json?.data?.server?.url === 'https://dash.example.com:2053/SulduzServer24',
      `url=${httpsPatch.json?.data?.server?.url}`
    );
    const colonPatch = await request('PATCH', `/api/admin/servers/${newServerId}`, {
      cookies,
      csrf,
      body: { url: 'dash.example.com:2053:/SulduzServer24' },
    });
    check(
      'a stray colon between port and path is repaired',
      colonPatch.status === 200 && colonPatch.json?.data?.server?.url === 'http://dash.example.com:2053/SulduzServer24',
      `url=${colonPatch.json?.data?.server?.url}`
    );
    const serversNow = await request('GET', '/api/admin/servers', { cookies });
    const primaryPanel = (serversNow.json?.data?.panels || [])[0] || {};
    check(
      'resource usage (cpu/memory) is reported per server',
      serversNow.status === 200 && primaryPanel.resources?.cpu === 0 && primaryPanel.resources?.memTotal === 1,
      `resources=${JSON.stringify(primaryPanel.resources)}`
    );
    const serverReseller = await request('GET', '/api/admin/servers', { cookies: shopCookies });
    check('resellers cannot list servers', serverReseller.status === 403);
    const serverDelete = await request('DELETE', `/api/admin/servers/${newServerId}`, { cookies, csrf });
    check('admin can delete an unused server', serverDelete.status === 200);

    const billingSave = await request('PATCH', '/api/admin/settings/billing', {
      cookies, csrf, body: { enabled: true, currency: 'تومان' },
    });
    check('wallet billing can be enabled', billingSave.status === 200 && billingSave.json.data.saved.enabled === true);

    const topup = await request('POST', `/api/admin/users/${shopId}/balance`, {
      cookies, csrf, body: { amount: 100000, description: 'شارژ آزمایشی' },
    });
    check('admin tops up the reseller wallet', topup.status === 200);

    const buy = await request('POST', '/api/reseller/configs', {
      cookies: shopCookies, csrf: shopCsrf,
      body: { inboundIds: [901], gb: 10, days: 30, customerName: 'مشتری تست' },
    });
    const bought = buy.json?.data?.configs?.[0] || {};
    check('reseller creates a config against x-ui', buy.status === 201 && bought.id > 0 && Boolean(bought.email), `email=${bought.email}`);
    const afterBuy = await request('GET', '/api/auth/me', { cookies: shopCookies });
    check(
      'purchase deducts exactly the inbound tariff',
      Number(afterBuy.json?.data?.user?.balance) === 99800,
      `balance=${afterBuy.json?.data?.user?.balance}`
    );

    const deleteBusy = await request('DELETE', `/api/admin/servers/${primaryId}`, { cookies, csrf });
    check(
      'a server that still owns configs cannot be deleted',
      primaryId > 0 && deleteBusy.status === 409 && deleteBusy.json?.error?.code === 'server_in_use',
      `status=${deleteBusy.status} code=${deleteBusy.json?.error?.code}`
    );

    const renew = await request('POST', `/api/reseller/configs/${bought.id}/extend`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 5, days: 5 },
    });
    const afterRenew = await request('GET', '/api/auth/me', { cookies: shopCookies });
    check(
      'renewal deducts the wallet at the inbound tariff',
      renew.status === 200 && Number(afterRenew.json?.data?.user?.balance) === 99650,
      `balance=${afterRenew.json?.data?.user?.balance}`
    );

    // v1.4.24, at the owner's request: the reseller must be TOLD about a renewal,
    // and the message has to read like a receipt — what was added, what it cost and
    // until when the package is valid. Persian digits are normalised so the check
    // does not depend on the ICU build of the runner.
    const renewNotes = await request('GET', '/api/notifications', { cookies: shopCookies });
    const faDigits = (value) => String(value || '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d) + 0);
    const renewNote = (renewNotes.json?.data?.rows || []).find((item) => item.title === 'تمدید انجام شد') || {};
    check(
      'the reseller inbox carries a renewal confirmation naming the amount taken',
      renewNote.title === 'تمدید انجام شد'
        && String(faDigits(renewNote.body)).includes('150') && String(renewNote.body || '').includes('کسر شد'),
      `title=${renewNote.title} body=${renewNote.body}`
    );
    check(
      'and it says which package it is about, so the message is not a bare notice',
      String(renewNote.body || '').includes(String(bought.email || '')) && String(renewNote.body || '').includes('روز'),
      `email=${bought.email} body=${renewNote.body}`
    );

    // An unpaid renewal must fail before x-ui is touched and leave the wallet as is.
    const zeroOut = await request('POST', `/api/admin/users/${shopId}/balance`, {
      cookies, csrf, body: { amount: -99650, description: 'تخلیه تست' },
    });
    const poorRenew = await request('POST', `/api/reseller/configs/${bought.id}/extend`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 5, days: 0 },
    });
    check('renewal without balance is rejected', zeroOut.status === 200 && poorRenew.status === 402, `status=${poorRenew.status}`);
    const afterPoor = await request('GET', '/api/auth/me', { cookies: shopCookies });
    check('rejected renewal leaves the wallet untouched', Number(afterPoor.json?.data?.user?.balance) === 0, `balance=${afterPoor.json?.data?.user?.balance}`);

    // ------------------------------------- v1.4.23: the renewal drawer shows a price
    // The extend dialog now quotes the renewal itself, so the number it shows must
    // be exactly what extendConfig charges: the package's own rows, one charge at
    // its highest tariff, the reseller discount applied, and an answer even while
    // wallet billing is switched off (that is the case the owner complained about).
    const shopRenewQuote = await request('POST', `/api/reseller/configs/${bought.id}/extend/quote`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 5, days: 5, price: 1 },
    });
    const shopPrice = shopRenewQuote.json?.data || {};
    check(
      'renewal preview prices the tariff and ignores a client-supplied price',
      shopRenewQuote.status === 200
        && shopPrice.total === 150
        && Number(shopPrice.basis?.inboundId) === 901
        && Number(shopPrice.basis?.base) === 150
        && shopPrice.groupSize === 1
        && shopPrice.billing?.enabled === true
        && shopPrice.sufficient === false,
      `status=${shopRenewQuote.status} total=${shopPrice.total} basis=${shopPrice.basis?.inboundId} sufficient=${shopPrice.sufficient}`
    );
    const otherRenewQuote = await request('POST', `/api/reseller/configs/${bought.id}/extend/quote`, {
      cookies: tgCookies, csrf: tgCsrf, body: { gb: 5, days: 5 },
    });
    const ghostRenewQuote = await request('POST', '/api/reseller/configs/999999/extend/quote', {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 5, days: 5 },
    });
    check(
      'a renewal preview only answers for the reseller’s own package',
      otherRenewQuote.status === 403 && ghostRenewQuote.status === 404,
      `other=${otherRenewQuote.status} ghost=${ghostRenewQuote.status}`
    );

    const renewDiscount = await request('PUT', `/api/admin/users/${shopId}/discounts`, {
      cookies, csrf, body: { discounts: [{ inboundId: 901, percent: 20 }] },
    });
    const discountedQuote = await request('POST', `/api/reseller/configs/${bought.id}/extend/quote`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 5, days: 5 },
    });
    const discounted = discountedQuote.json?.data || {};
    check(
      'renewal preview applies the reseller discount to the tariff',
      renewDiscount.status === 200
        && discountedQuote.status === 200
        && discounted.total === 120
        && Number(discounted.basis?.base) === 150
        && Number(discounted.basis?.discountPercent) === 20,
      `total=${discounted.total} base=${discounted.basis?.base} percent=${discounted.basis?.discountPercent}`
    );

    // Top up, renew, and prove the wallet lost exactly the amount that was shown.
    const quoteTopup = await request('POST', `/api/admin/users/${shopId}/balance`, {
      cookies, csrf, body: { amount: 1000, description: 'شارژ تست قیمت تمدید' },
    });
    const shownRenew = await request('POST', `/api/reseller/configs/${bought.id}/extend`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 5, days: 5 },
    });
    const afterShown = await request('GET', '/api/auth/me', { cookies: shopCookies });
    check(
      'the renewal charge equals the amount the dialog showed',
      quoteTopup.status === 200
        && shownRenew.status === 200
        && Number(afterShown.json?.data?.user?.balance) === 880,
      `status=${shownRenew.status} balance=${afterShown.json?.data?.user?.balance}`
    );

    // Billing off: the dialog must still show 120, say the wallet is not touched,
    // and the renewal must go through without spending anything.
    const billingOffSave = await request('PATCH', '/api/admin/settings/billing', {
      cookies, csrf, body: { enabled: false, currency: 'تومان' },
    });
    const freeQuote = await request('POST', `/api/reseller/configs/${bought.id}/extend/quote`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 5, days: 5 },
    });
    const freePrice = freeQuote.json?.data || {};
    const freeRenew = await request('POST', `/api/reseller/configs/${bought.id}/extend`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 5, days: 5 },
    });
    const afterFree = await request('GET', '/api/auth/me', { cookies: shopCookies });
    check(
      'with billing off the dialog still shows the price and charges nothing',
      billingOffSave.status === 200
        && freeQuote.status === 200
        && freeRenew.status === 200
        && freePrice.total === 120
        && freePrice.billing?.enabled === false
        && freePrice.sufficient === true
        && Number(afterFree.json?.data?.user?.balance) === 880,
      `status=${freeQuote.status} total=${freePrice.total} enabled=${freePrice.billing?.enabled} balance=${afterFree.json?.data?.user?.balance}`
    );
    const zeroDaysQuote = await request('POST', `/api/reseller/configs/${bought.id}/extend/quote`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 0, days: 0 },
    });
    check(
      'a renewal preview with nothing entered still shows the inbound fixed price (discounted)',
      zeroDaysQuote.status === 200 && Number(zeroDaysQuote.json?.data?.total) === 80,
      `status=${zeroDaysQuote.status} total=${zeroDaysQuote.json?.data?.total}`
    );

    // Restore what the following sections assume: billing on, no discount, wallet 0.
    const clearDiscount = await request('PUT', `/api/admin/users/${shopId}/discounts`, { cookies, csrf, body: { discounts: [] } });
    const billingBackOn = await request('PATCH', '/api/admin/settings/billing', {
      cookies, csrf, body: { enabled: true, currency: 'تومان' },
    });
    const drainAgain = await request('POST', `/api/admin/users/${shopId}/balance`, {
      cookies, csrf, body: { amount: -880, description: 'تخلیه پس از تست قیمت تمدید' },
    });
    const restoredMe = await request('GET', '/api/auth/me', { cookies: shopCookies });
    check(
      'the renewal price checks leave billing and the wallet as they found them',
      clearDiscount.status === 200
        && billingBackOn.status === 200
        && drainAgain.status === 200
        && Number(restoredMe.json?.data?.user?.balance) === 0,
      `balance=${restoredMe.json?.data?.user?.balance}`
    );

    // ------------------------------------------- v1.4.25: who pays for a renewal
    // The owner's rule: when the MAIN ADMIN renews or builds on a reseller's
    // customer, the reseller's wallet is NOT touched unless the admin explicitly
    // opts in. The wallet sits at zero here on purpose — a broke reseller must
    // neither be charged for an admin's favour nor block it.
    const walletState = async () => Number((await request('GET', '/api/auth/me', { cookies: shopCookies })).json?.data?.user?.balance || 0);
    const renewLedgerCount = async () => {
      const ledger = await request('GET', '/api/reseller/transactions?pageSize=100', { cookies: shopCookies, csrf: shopCsrf });
      return (ledger.json?.data?.rows || []).filter((row) => row.type === 'renew').length;
    };
    const purchaseLedgerCount = async () => {
      const ledger = await request('GET', '/api/reseller/transactions?pageSize=100', { cookies: shopCookies, csrf: shopCsrf });
      return (ledger.json?.data?.rows || []).filter((row) => row.type === 'purchase').length;
    };
    const newestNote = async (title) => {
      const notes = await request('GET', '/api/notifications?pageSize=50', { cookies: shopCookies });
      return (notes.json?.data?.rows || [])
        .filter((item) => item.title === title)
        .sort((a, b) => Number(b.id) - Number(a.id))[0] || {};
    };

    const adminFreeQuote = await request('POST', `/api/admin/configs/${bought.id}/extend/quote`, {
      cookies, csrf, body: { gb: 5, days: 5 },
    });
    const adminFreePrice = adminFreeQuote.json?.data || {};
    check(
      'v1.4.25 an admin renewal is quoted as free by default, even on an empty wallet',
      adminFreeQuote.status === 200
        && Number(adminFreePrice.total) === 150
        && adminFreePrice.charge === false
        && adminFreePrice.charged === false
        && adminFreePrice.sufficient === true
        && adminFreePrice.actor === 'admin',
      `total=${adminFreePrice.total} charge=${adminFreePrice.charge} charged=${adminFreePrice.charged} sufficient=${adminFreePrice.sufficient} actor=${adminFreePrice.actor}`
    );
    const adminChargedQuote = await request('POST', `/api/admin/configs/${bought.id}/extend/quote`, {
      cookies, csrf, body: { gb: 5, days: 5, charge: true },
    });
    const adminChargedPrice = adminChargedQuote.json?.data || {};
    check(
      'v1.4.25 the same preview with the switch on puts the wallet back in the picture',
      adminChargedQuote.status === 200
        && Number(adminChargedPrice.total) === 150
        && adminChargedPrice.charged === true
        && adminChargedPrice.sufficient === false,
      `charged=${adminChargedPrice.charged} sufficient=${adminChargedPrice.sufficient}`
    );

    const renewBeforeFree = await renewLedgerCount();
    const beforeFreeDetail = await request('GET', `/api/admin/configs/${bought.id}`, { cookies });
    const expiryBeforeFree = Number(beforeFreeDetail.json?.data?.config?.expiryAt || 0);
    const adminFreeRenew = await request('POST', `/api/admin/configs/${bought.id}/extend`, {
      cookies, csrf, body: { gb: 5, days: 5 },
    });
    const freeRenewDetail = await request('GET', `/api/admin/configs/${bought.id}`, { cookies });
    const freeRenewNote = await newestNote('تمدید انجام شد');
    check(
      'v1.4.25 a free admin renewal succeeds on a zero wallet, renews the customer and takes nothing',
      adminFreeRenew.status === 200
        && Number(freeRenewDetail.json?.data?.config?.expiryAt) > expiryBeforeFree
        && (await walletState()) === 0
        && await renewLedgerCount() === renewBeforeFree,
      `status=${adminFreeRenew.status} expiry=${expiryBeforeFree}→${Number(freeRenewDetail.json?.data?.config?.expiryAt)} balance=${await walletState()}`
    );
    check(
      'and the reseller is TOLD it was free, instead of a charge that never happened',
      String(freeRenewNote.body || '').includes('رایگان')
        && String(freeRenewNote.body || '').includes('بدون کسر')
        && !String(freeRenewNote.body || '').includes('کسر شد')
        && String(freeRenewNote.body || '').includes('توسط مدیر'),
      `body=${freeRenewNote.body}`
    );

    const quotaBeforePaid = `${Number(adminFreeRenew.json?.data?.config?.totalGb || 0)}|${Number(adminFreeRenew.json?.data?.config?.expiryAt || 0)}`;
    const adminPoorRenew = await request('POST', `/api/admin/configs/${bought.id}/extend`, {
      cookies, csrf, body: { gb: 5, days: 5, charge: true },
    });
    const stillFreeDetail = await request('GET', `/api/admin/configs/${bought.id}`, { cookies });
    const stillFreeConfig = stillFreeDetail.json?.data?.config || {};
    check(
      'v1.4.25 an opted-in charge is still refused on an empty wallet — and writes nothing',
      adminPoorRenew.status === 402
        && adminPoorRenew.json?.error?.code === 'insufficient_balance'
        && (await walletState()) === 0
        && `${Number(stillFreeConfig.totalGb || 0)}|${Number(stillFreeConfig.expiryAt || 0)}` === quotaBeforePaid,
      `status=${adminPoorRenew.status} code=${adminPoorRenew.json?.error?.code}`
    );

    const adminPayTopup = await request('POST', `/api/admin/users/${shopId}/balance`, {
      cookies, csrf, body: { amount: 500, description: 'شارژ تست کسر مدیر' },
    });
    const renewBeforePaid = await renewLedgerCount();
    const adminPaidRenew = await request('POST', `/api/admin/configs/${bought.id}/extend`, {
      cookies, csrf, body: { gb: 5, days: 5, charge: true },
    });
    const paidRenewNote = await newestNote('تمدید انجام شد');
    check(
      'v1.4.25 ticking the switch makes the very same renewal deduct like before',
      adminPayTopup.status === 200
        && adminPaidRenew.status === 200
        && (await walletState()) === 350
        && await renewLedgerCount() === renewBeforePaid + 1
        && String(faDigits(paidRenewNote.body || '')).includes('150')
        && String(paidRenewNote.body || '').includes('کسر شد')
        && !String(paidRenewNote.body || '').includes('رایگان'),
      `status=${adminPaidRenew.status} balance=${await walletState()}`
    );

    // The rule must not be steerable from the client: the flag is only ever read
    // for an admin viewer, so a reseller posting {"charge": false} pays anyway.
    const steeredQuote = await request('POST', `/api/reseller/configs/${bought.id}/extend/quote`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 5, days: 5, charge: false },
    });
    const steeredPrice = steeredQuote.json?.data || {};
    const renewBeforeSteer = await renewLedgerCount();
    const steeredRenew = await request('POST', `/api/reseller/configs/${bought.id}/extend`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 5, days: 5, charge: false },
    });
    check(
      'a reseller cannot buy his own renewal for free by posting charge:false',
      steeredQuote.status === 200
        && steeredPrice.charged === true
        && steeredPrice.actor === 'reseller'
        && steeredRenew.status === 200
        && (await walletState()) === 200
        && await renewLedgerCount() === renewBeforeSteer + 1,
      `charged=${steeredPrice.charged} actor=${steeredPrice.actor} status=${steeredRenew.status} balance=${await walletState()}`
    );

    // The same policy on the other money surface: an admin building a package.
    const purchaseBeforeAdmin = await purchaseLedgerCount();
    const adminBuild = await request('POST', '/api/admin/configs', {
      cookies, csrf, body: { userId: shopId, inboundIds: [901], gb: 5, days: 10, customerName: 'مشتری ساخته‌شده توسط مدیر' },
    });
    const builtConfig = (adminBuild.json?.data?.configs || [])[0] || {};
    const walletAfterBuild = await walletState();
    const purchaseAfterAdmin = await purchaseLedgerCount();
    const adminBuildDeleted = await request('DELETE', `/api/admin/configs/${builtConfig.id}`, { cookies, csrf });
    check(
      'v1.4.25 an admin building a package for a reseller spends nothing of his wallet',
      adminBuild.status === 201
        && Number(adminBuild.json?.data?.configs?.length) === 1
        && walletAfterBuild === 200
        && purchaseAfterAdmin === purchaseBeforeAdmin
        && adminBuildDeleted.status === 200,
      `status=${adminBuild.status} balance=${walletAfterBuild} purchases=${purchaseBeforeAdmin}→${purchaseAfterAdmin}`
    );

    const drainAfterChargePolicy = await request('POST', `/api/admin/users/${shopId}/balance`, {
      cookies, csrf, body: { amount: -200, description: 'تخلیه پس از سیاست کسر هزینه' },
    });
    check(
      'the charge policy tests leave billing on and the wallet as they found it',
      drainAfterChargePolicy.status === 200 && (await walletState()) === 0,
      `balance=${await walletState()}`
    );

    // ------------------------- v1.4.26: what a renewal with «ریست مصرف» really does
    // The owner's second leak was inside the renewal itself: the tick ADDED the
    // new traffic and then wiped the usage the customer had already paid for, so
    // a 30GB/30d plan half consumed became 50GB/90d with the meter back at zero —
    // the reseller sold the same gigabytes twice. Now the numbers he types BECOME
    // the package (20GB/60d means 20GB/60d, not 30+20/30+60) and the tariff is
    // priced for exactly those numbers. A reset with nothing typed is refused,
    // because that is the old free reset wearing a different hat.
    const UNIT26 = 1024 ** 3;
    const DAY26 = 86400000;
    const resetTrafficCount = () => mockXui.calls.filter((call) => call.route.startsWith('/clients/resetTraffic/')).length;
    const nodeCallsSince = (from) => mockXui.calls.slice(from).map((call) => call.route);
    const stage5Topup = await request('POST', `/api/admin/users/${shopId}/balance`, {
      cookies, csrf, body: { amount: 4000, description: 'شارژ تست جایگزینی تمدید' },
    });
    const stage5Buy = await request('POST', '/api/reseller/configs', {
      cookies: shopCookies, csrf: shopCsrf,
      body: { inboundIds: [901, 902], gb: 30, days: 30, customerName: 'مشتری جایگزینی تمدید' },
    });
    const stage5Configs = stage5Buy.json?.data?.configs || [];
    const stage5Id = stage5Configs[0]?.id || 0;
    const stage5Email = String(stage5Configs[0]?.email || '');
    const setStage5Usage = (up, down) => {
      const client = mockXui.clients.get(stage5Email);
      client.up = up;
      client.down = down;
    };
    const stage5View = async () => (await request('GET', `/api/reseller/configs/${stage5Id}`, { cookies: shopCookies })).json?.data?.config || {};
    setStage5Usage(7 * UNIT26, 8 * UNIT26);
    const stage5Sync = await request('POST', '/api/admin/sync', { cookies, csrf });
    const stage5Half = await stage5View();
    check(
      'v1.4.26 the fixture is a 30GB/30d package that has used exactly half of it',
      stage5Topup.status === 200 && stage5Buy.status === 201 && stage5Configs.length === 2
        && stage5Sync.status === 200
        && Number(stage5Half.totalGb) === 30 && Number(stage5Half.used) === 15 * UNIT26,
      `buy=${stage5Buy.status} gb=${stage5Half.totalGb} used=${stage5Half.used / UNIT26}`
    );
    const replaceQuote = await request('POST', `/api/reseller/configs/${stage5Id}/extend/quote`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 20, days: 60, resetUsage: true },
    });
    const replacePrice = replaceQuote.json?.data || {};
    check(
      'v1.4.26 the preview answers a REPLACING renewal: 30GB used 15 becomes 20GB, not 50GB',
      replaceQuote.status === 200
        && replacePrice.mode === 'replace'
        && replacePrice.resetUsage === true
        && Number(replacePrice.current?.gb) === 30
        && Number(replacePrice.current?.usedGb) === 15
        && Number(replacePrice.result?.gb) === 20
        && replacePrice.result?.changedTotal === true
        && replacePrice.result?.usageCleared === true
        && Math.abs(Number(replacePrice.result?.expiryAt) - (Date.now() + 60 * DAY26)) < 5 * 60 * 1000,
      `mode=${replacePrice.mode} current=${replacePrice.current?.gb}/${replacePrice.current?.usedGb} result=${replacePrice.result?.gb} in ${Math.round((Number(replacePrice.result?.expiryAt) - Date.now()) / DAY26)}d`
    );
    // The money follows the same numbers: the tariff of the NEW size, at the
    // highest inbound of the package (902: 20GB x 50 = 1000, over 901: 300).
    check(
      'and it is priced for the renewal it is going to apply, not for a top-up',
      Number(replacePrice.total) === 1000 && Number(replacePrice.basis?.inboundId) === 902
        && replacePrice.charged === true && replacePrice.actor === 'reseller',
      `total=${replacePrice.total} basis=${replacePrice.basis?.inboundId} charged=${replacePrice.charged}`
    );
    const addQuote = await request('POST', `/api/reseller/configs/${stage5Id}/extend/quote`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 20, days: 60 },
    });
    const addPrice = addQuote.json?.data || {};
    check(
      'without the tick the old arithmetic is untouched: 30+20=50GB and the days stack',
      addQuote.status === 200 && addPrice.mode === 'add'
        && Number(addPrice.result?.gb) === 50 && addPrice.result?.usageCleared === false
        && Number(addPrice.result?.expiryAt) > Number(addPrice.current?.expiryAt),
      `mode=${addPrice.mode} result=${addPrice.result?.gb} usageCleared=${addPrice.result?.usageCleared}`
    );
    const balanceBeforeReplace = await walletState();
    const ledgerBeforeReplace = await renewLedgerCount();
    const resetCallsBeforeReplace = resetTrafficCount();
    const nodeCallsBeforeReplace = mockXui.calls.length;
    const replaceRenew = await request('POST', `/api/reseller/configs/${stage5Id}/extend`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 20, days: 60, resetUsage: true },
    });
    const replacedConfig = replaceRenew.json?.data?.config || {};
    const replacedNote = await newestNote('تمدید انجام شد');
    check(
      'v1.4.26 applying it leaves the customer with exactly 20GB/60d and a meter at zero',
      replaceRenew.status === 200
        && Number(replacedConfig.totalGb) === 20
        && Number(replacedConfig.used) === 0
        && Math.abs(Number(replacedConfig.expiryAt) - (Date.now() + 60 * DAY26)) < 5 * 60 * 1000,
      `status=${replaceRenew.status} gb=${replacedConfig.totalGb} used=${replacedConfig.used} in ${Math.round((Number(replacedConfig.expiryAt) - Date.now()) / DAY26)}d`
    );
    check(
      'the node agrees: same quota, counters zeroed there, no second client minted',
      Number(mockXui.clients.get(stage5Email)?.totalGB) === 20 * UNIT26
        && mockXui.clients.get(stage5Email)?.up === 0
        && mockXui.clients.get(stage5Email)?.down === 0
        && resetTrafficCount() === resetCallsBeforeReplace + 1
        && mockXui.calls.slice(nodeCallsBeforeReplace).filter((call) => call.route === '/clients/add').length === 0,
      `nodeGb=${mockXui.clients.get(stage5Email)?.totalGB / UNIT26} up=${mockXui.clients.get(stage5Email)?.up} resets=${resetTrafficCount() - resetCallsBeforeReplace}`
    );
    check(
      'and the reseller pays the tariff of the new plan — the reset is no longer free',
      (await walletState()) === balanceBeforeReplace - 1000
        && await renewLedgerCount() === ledgerBeforeReplace + 1,
      `balance=${balanceBeforeReplace}→${await walletState()} ledger=${ledgerBeforeReplace}→${await renewLedgerCount()}`
    );
    // The message has to tell the reseller what happened in the words he will
    // quote to the customer, so both halves are asserted separately: the money
    // that left his wallet and the meter that went to zero.
    const replacedText = String(faDigits(replacedNote.body || '')).replace(/[٬,\s]/g, '');
    check(
      'and the renewal note says what really changed: the new size, zero usage, the tariff charged',
      replacedText.includes('1000')
        && String(replacedNote.body || '').includes('مصرف صفر')
        && String(replacedNote.body || '').includes('20GB'),
      `body=${replacedNote.body}`
    );
    const emptyReset = await request('POST', `/api/reseller/configs/${stage5Id}/extend`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 0, days: 0, resetUsage: true },
    });
    const afterEmptyReset = await stage5View();
    check(
      'a reset with nothing typed is refused, because that was the free reset again',
      emptyReset.status === 422 && emptyReset.json?.error?.code === 'reset_needs_renewal'
        && Number(afterEmptyReset.totalGb) === 20 && Number(afterEmptyReset.used) === 0
        && resetTrafficCount() === resetCallsBeforeReplace + 1,
      `status=${emptyReset.status} code=${emptyReset.json?.error?.code} gb=${afterEmptyReset.totalGb} used=${afterEmptyReset.used}`
    );
    setStage5Usage(2 * UNIT26, 1 * UNIT26);
    // The panel only knows what it read from the node, so let it read the new
    // 3GB before renewing — otherwise "keeps the usage" proves nothing.
    await request('POST', '/api/admin/sync', { cookies, csrf });
    const addRenew = await request('POST', `/api/reseller/configs/${stage5Id}/extend`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 5, days: 5 },
    });
    const addedConfig = addRenew.json?.data?.config || {};
    check(
      'a renewal without the tick still adds, and keeps the usage the customer made',
      addRenew.status === 200 && Number(addedConfig.totalGb) === 25
        && Number(addedConfig.used) === 3 * UNIT26
        && Number(addRenew.json?.data?.config?.expiryAt) > Number(replacedConfig.expiryAt),
      `status=${addRenew.status} gb=${addedConfig.totalGb} used=${addedConfig.used / UNIT26}`
    );
    // The button that took the free reset's place: it READS the node and shows
    // what it says. Nothing may be written, or a "refresh" would become a way to
    // change a customer on another panel.
    const client = mockXui.clients.get(stage5Email);
    client.up = 5 * UNIT26;
    client.down = 4 * UNIT26;
    client.totalGB = 999 * UNIT26;
    const refreshCallsFrom = mockXui.calls.length;
    const refreshedOnce = await request('POST', `/api/reseller/configs/${stage5Id}/refresh`, {
      cookies: shopCookies, csrf: shopCsrf,
    });
    const refreshData = refreshedOnce.json?.data || {};
    const refreshRoutes = [...new Set(nodeCallsSince(refreshCallsFrom))];
    check(
      'v1.4.26 refresh reads the real usage of every row back from the node',
      refreshedOnce.status === 200
        && Number(refreshData.refreshed) === 1
        && Number(refreshData.clients) === 1
        && Number(refreshData.config.used) === 9 * UNIT26
        && refreshData.missing === 0 && refreshData.errors.length === 0,
      `status=${refreshedOnce.status} refreshed=${refreshData.refreshed} used=${(refreshData.config?.used || 0) / UNIT26} missing=${refreshData.missing}`
    );
    // The toast on the reseller's screen counts inbounds, so the payload has to
    // carry that number too — one client with two channels is two inbounds.
    check('and it counts what the sentence claims: inbounds, not x-ui clients',
      Number(refreshData.rows) === 2 && Number(refreshData.refreshedRows) === 2,
      `rows=${refreshData.rows} refreshedRows=${refreshData.refreshedRows} clients=${refreshData.clients}`);
    check('and it is a read: the only x-ui endpoint it touched is clients/get',
      refreshRoutes.length === 1 && refreshRoutes[0].startsWith('/clients/get/'),
      `routes=${refreshRoutes.join(',')}`);
    check('refresh never imports the node’s plan over the tariff the panel sold',
      Number(refreshData.config.totalGb) === 25,
      `gb=${refreshData.config?.totalGb}`);
    const refreshedRows = await request('GET', `/api/reseller/configs?search=${encodeURIComponent('مشتری جایگزینی تمدید')}`, { cookies: shopCookies });
    check('every inbound of the package shows the same refreshed pool',
      refreshedRows.json?.data?.rows?.[0]?.groupCount === 2
        && Number(refreshedRows.json?.data?.rows?.[0]?.used) === 9 * UNIT26,
      `rows=${refreshedRows.json?.data?.rows?.[0]?.groupCount} used=${refreshedRows.json?.data?.rows?.[0]?.used}`);
    const missingClientEmail = stage5Email;
    mockXui.clients.delete(missingClientEmail);
    const refreshMissing = await request('POST', `/api/reseller/configs/${stage5Id}/refresh`, {
      cookies: shopCookies, csrf: shopCsrf,
    });
    check('a customer who is gone from the node is reported, not silently zeroed',
      refreshMissing.status === 200 && Number(refreshMissing.json?.data?.missing) === 1
        && Number(refreshMissing.json?.data?.missingRows) === 2
        && Number(refreshMissing.json?.data?.errorRows) === 0
        && refreshMissing.json?.data?.refreshed === 0
        && String(refreshMissing.json?.data?.config?.syncStatus || '') === 'missing',
      `status=${refreshMissing.status} missing=${refreshMissing.json?.data?.missing}/${refreshMissing.json?.data?.missingRows} sync=${refreshMissing.json?.data?.config?.syncStatus}`);
    mockXui.clients.set(missingClientEmail, client);
    const stage5Cleanup = await request('DELETE', `/api/admin/configs/${stage5Id}/package`, { cookies, csrf });
    // Hand the wallet back exactly as this block found it (0): drain whatever is
    // left instead of guessing how much the three renewals above cost.
    const leftAfterStage5 = await walletState();
    const drainAfterReplacePolicy = leftAfterStage5 === 0
      ? { status: 200 }
      : await request('POST', `/api/admin/users/${shopId}/balance`, {
        cookies, csrf, body: { amount: -leftAfterStage5, description: 'تخلیه پس از تست جایگزینی تمدید' },
      });
    const stage5Gone = await request('GET', `/api/reseller/configs/${stage5Id}`, { cookies: shopCookies });
    check(
      'the v1.4.26 checks leave no customer behind and hand the wallet back',
      stage5Cleanup.status === 200 && drainAfterReplacePolicy.status === 200
        && stage5Gone.status === 404 && (await walletState()) === 0,
      `cleanup=${stage5Cleanup.status} gone=${stage5Gone.status} drained=${leftAfterStage5} balance=${await walletState()}`
    );

    // ------------------------------------------- multi-inbound package (v1.4.0)
    // The mock rejects a subId shared by two clients exactly like x-ui 3.2.5+
    // does, so this order is the regression test for "subId already in use".
    const singleLinks = await request('GET', `/api/reseller/configs/${bought.id}/links`, { cookies: shopCookies });
    check(
      'a single config keeps its x-ui subscription link',
      singleLinks.status === 200 && String(singleLinks.json?.data?.subUrl || '').startsWith('https://sub.example.com/sub/'),
      `subUrl=${singleLinks.json?.data?.subUrl}`
    );

    const multiTopup = await request('POST', `/api/admin/users/${shopId}/balance`, {
      cookies, csrf, body: { amount: 90000, description: 'شارژ تست چند اینباند' },
    });
    const multiBuy = await request('POST', '/api/reseller/configs', {
      cookies: shopCookies, csrf: shopCsrf,
      body: { inboundIds: [901, 902, 903], gb: 10, days: 30, customerName: 'مشتری چند اینباند' },
    });
    const multiConfigs = multiBuy.json?.data?.configs || [];
    check(
      'a multi-inbound order succeeds when x-ui rejects shared subIds',
      multiTopup.status === 200 && multiBuy.status === 201 && multiConfigs.length === 3,
      `status=${multiBuy.status} err=${multiBuy.json?.error?.message || ''}`
    );
    const groupToken = multiConfigs[0]?.subId || '';
    check(
      'the package keeps one customer-facing subscription token',
      Boolean(groupToken) && multiConfigs.every((config) => config.subId === groupToken),
      `tokens=${multiConfigs.map((config) => config.subId).join(',')}`
    );
    // The package rule the dialog has to honour: 901 = 150, 902 = 250 and 903 = 325
    // for +5GB/+5d, and a renewal is ONE charge at the highest of them — not 725.
    const groupQuote = await request('POST', `/api/reseller/configs/${multiConfigs[1]?.id}/extend/quote`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 5, days: 5 },
    });
    const groupPrice = groupQuote.json?.data || {};
    const adminGroupQuote = await request('POST', `/api/admin/configs/${multiConfigs[0]?.id}/extend/quote`, {
      cookies, csrf, body: { gb: 5, days: 5 },
    });
    check(
      'a package renewal is quoted once at its highest inbound, from any member',
      groupQuote.status === 200
        && Number(groupPrice.total) === 325
        && Number(groupPrice.basis?.inboundId) === 903
        && groupPrice.groupSize === 3
        && adminGroupQuote.status === 200
        && Number(adminGroupQuote.json?.data?.total) === 325,
      `reseller=${groupPrice.total} admin=${adminGroupQuote.json?.data?.total} basis=${groupPrice.basis?.inboundId}`
    );
    // v1.4.18: the whole order is ONE x-ui client attached to every inbound it
    // bought — the same shape a subscription adopted from another panel has. One
    // client means the customer's link stays on the node's own subscription
    // server, which already lists all of his inbounds, instead of moving behind
    // this panel.
    const orderClient = mockXui.clients.get(multiConfigs[0].email);
    check('a multi-inbound order is one x-ui client attached to every inbound',
      multiConfigs.every((config) => config.email === multiConfigs[0].email)
      && multiConfigs.every((config) => config.uuid === multiConfigs[0].uuid)
      && [...new Set(multiConfigs.map((config) => config.subId))].length === 1
      && (orderClient?.inboundIds || []).map(Number).sort((a, b) => a - b).join(',') === '901,902,903',
      `attached=${(orderClient?.inboundIds || []).join(',')} emails=${new Set(multiConfigs.map((config) => config.email)).size}`);
    const subFeed = await request('GET', `/api/sub/${groupToken}`);
    const decoded = Buffer.from(String(subFeed?.raw || ''), 'base64').toString('utf8').split('\n').filter(Boolean);
    check(
      'the panel still serves one subscription for the package',
      subFeed.status === 200
        && decoded.length === 3
        && decoded.every((link) => link.startsWith('vless://')),
      `status=${subFeed.status} links=${decoded.length}`
    );
    const multiLinks = await request('GET', `/api/reseller/configs/${multiConfigs[0]?.id}/links`, { cookies: shopCookies });
    check(
      'a one-client package is handed the node subscription address',
      multiLinks.status === 200 && String(multiLinks.json?.data?.subUrl || '') === `https://sub.example.com/sub/${groupToken}`,
      `subUrl=${multiLinks.json?.data?.subUrl}`
    );
    const subsPayload = multiLinks.json?.data?.subscriptions || {};
    check('the subscription box reports one client on the node',
      Number(subsPayload.clientCount) === 1 && subsPayload.source === 'node'
      && (subsPayload.node || []).length === 1 && Number(subsPayload.node[0]?.inboundCount || 0) === 3,
      `clients=${subsPayload.clientCount} source=${subsPayload.source} node=${(subsPayload.node || []).length}`);
    // Listing packages must paginate customers, not individual x-ui clients.
    const customerSearch = encodeURIComponent('مشتری چند اینباند');
    const groupedList = await request('GET', `/api/reseller/configs?search=${customerSearch}`, { cookies: shopCookies });
    const packageRow = groupedList.json?.data?.rows?.[0] || {};
    check('three inbounds appear as one reseller customer row',
      groupedList.status === 200 && groupedList.json?.data?.total === 1
      && groupedList.json.data.rows.length === 1 && packageRow.groupCount === 3);
    check('package list contains every member exactly once',
      JSON.stringify(packageRow.groupIds) === JSON.stringify(multiConfigs.map((item) => item.id))
      && new Set((packageRow.inbounds || []).map((item) => item.id)).size === 3);
    check('package quota is one shared pool, not a per-inbound amount',
      packageRow.totalBytes === 10 * 1024 ** 3
      && packageRow.used === 0
      && packageRow.inbounds?.every((item) => item.totalBytes === 10 * 1024 ** 3));
    // The entered GB is one pool for the whole package. Since v1.4.18 the package
    // is ONE x-ui client, so his own counters are the package usage — and because
    // every row repeats those counters, taking them per row would multiply the
    // customer's traffic by his inbound count.
    const gbUnit = 1024 ** 3;
    const bumpClient = (config, up, down) => {
      const client = mockXui.clients.get(config.email);
      client.up = up;
      client.down = down;
    };
    bumpClient(multiConfigs[0], 2 * gbUnit, 2 * gbUnit);
    const poolSync = await request('POST', '/api/admin/sync', { cookies, csrf });
    const pooledList = await request('GET', `/api/reseller/configs?search=${customerSearch}`, { cookies: shopCookies });
    const pooledRow = pooledList.json?.data?.rows?.[0] || {};
    check('one client’s counters are counted once for the whole package',
      poolSync.status === 200
      && pooledRow.used === 4 * gbUnit
      && pooledRow.totalBytes === 10 * gbUnit
      && pooledRow.remaining === 6 * gbUnit
      && pooledRow.status === 'active',
      `used=${pooledRow.used} remaining=${pooledRow.remaining} status=${pooledRow.status}`);
    const pooledSub = await request('GET', `/api/sub/${groupToken}`);
    const subInfo = String(pooledSub.headers['subscription-userinfo'] || '');
    check('the subscription advertises the shared pool to client apps',
      pooledSub.status === 200
      && subInfo.includes(`upload=${2 * gbUnit}`)
      && subInfo.includes(`download=${2 * gbUnit}`)
      && subInfo.includes(`total=${10 * gbUnit}`),
      `header=${subInfo}`);
    bumpClient(multiConfigs[2], 6 * gbUnit, 4 * gbUnit);
    const drainedSync = await request('POST', '/api/admin/sync', { cookies, csrf });
    const drainedList = await request('GET', `/api/reseller/configs?search=${customerSearch}`, { cookies: shopCookies });
    const drainedRow = drainedList.json?.data?.rows?.[0] || {};
    check('filling the shared pool marks the whole package depleted',
      drainedSync.status === 200
      && drainedRow.used === 10 * gbUnit
      && drainedRow.status === 'depleted',
      `used=${drainedRow.used} status=${drainedRow.status}`);
    check('every inbound of the package is disabled once the pool runs out',
      mockXui.clients.get(multiConfigs[0].email)?.enable === false);
    // v1.4.26: this very call used to be the free reset. A depleted customer's
    // meter went back to zero and the traffic he had already paid for simply
    // vanished, so the reseller could sell the same gigabytes twice. The endpoint
    // now refuses him — and refuses him WITHOUT moving anything, node included.
    const resetTrafficBeforeRefusal = mockXui.calls.filter((call) => call.route.startsWith('/clients/resetTraffic/')).length;
    const clientCallsBeforeRefusal = mockXui.calls.length;
    const refusedReset = await request('POST', `/api/reseller/configs/${multiConfigs[0].id}/reset`, {
      cookies: shopCookies, csrf: shopCsrf,
    });
    const refusedList = await request('GET', `/api/reseller/configs?search=${customerSearch}`, { cookies: shopCookies });
    const refusedRow = refusedList.json?.data?.rows?.[0] || {};
    check('a reseller reset is refused, and NOTHING about the meter moves',
      refusedReset.status === 403
        && refusedReset.json?.error?.code === 'reset_forbidden'
        && refusedRow.used === 10 * gbUnit
        && refusedRow.status === 'depleted'
        && mockXui.clients.get(multiConfigs[0].email)?.enable === false
        && mockXui.calls.filter((call) => call.route.startsWith('/clients/resetTraffic/')).length === resetTrafficBeforeRefusal
        && mockXui.calls.length === clientCallsBeforeRefusal,
      `status=${refusedReset.status} code=${refusedReset.json?.error?.code} used=${refusedRow.used} nodeUp=${mockXui.clients.get(multiConfigs[0].email)?.up}`);
    // The main admin keeps the button: he sets his own prices, and v1.4.25 already
    // made him the only actor who may renew for free. The node zeroes with him, so
    // the next sync cannot undo the reset the way a local-only clear could.
    const resetPool = await request('POST', `/api/admin/configs/${multiConfigs[0].id}/reset`, {
      cookies, csrf,
    });
    const resetList = await request('GET', `/api/reseller/configs?search=${customerSearch}`, { cookies: shopCookies });
    const resetRow = resetList.json?.data?.rows?.[0] || {};
    check('an admin reset clears the pool on the node and re-enables every inbound',
      resetPool.status === 200
        && mockXui.clients.get(multiConfigs[0].email)?.up === 0
        && mockXui.clients.get(multiConfigs[0].email)?.down === 0
        && resetRow.used === 0
        && resetRow.status === 'active'
        && mockXui.clients.get(multiConfigs[0].email)?.enable !== false,
      `status=${resetPool.status} used=${resetRow.used} enabled=${mockXui.clients.get(multiConfigs[0].email)?.enable}`);
    const quotaOnce = await request('POST', `/api/admin/configs/${multiConfigs[1].id}/quota`, {
      cookies, csrf, body: { gb: 20 },
    });
    check('editing quota on one inbound updates the shared pool everywhere',
      quotaOnce.status === 200
      && quotaOnce.json?.data?.config?.totalBytes === 20 * gbUnit
      && multiConfigs.every((config) => mockXui.clients.get(config.email)?.totalGB === 20 * gbUnit));
    const quotaBack = await request('POST', `/api/admin/configs/${multiConfigs[1].id}/quota`, {
      cookies, csrf, body: { gb: 10 },
    });
    check('the package pool can be restored to its original size',
      quotaBack.status === 200 && quotaBack.json?.data?.config?.totalBytes === 10 * gbUnit);
    const adminGrouped = await request('GET', `/api/admin/configs?userId=${shopId}&search=${customerSearch}`, { cookies });
    check('admin and reseller see the same complete customer package',
      adminGrouped.status === 200 && adminGrouped.json?.data?.total === 1
      && JSON.stringify(adminGrouped.json.data.rows[0]?.groupIds) === JSON.stringify(packageRow.groupIds));
    const emailFiltered = await request('GET', `/api/reseller/configs?search=${encodeURIComponent(multiConfigs[1]?.email)}`, { cookies: shopCookies });
    check('searching one member email still returns the entire package',
      emailFiltered.json?.data?.total === 1 && emailFiltered.json.data.rows[0]?.groupCount === 3);
    const inboundFiltered = await request('GET', '/api/reseller/configs?inboundId=902', { cookies: shopCookies });
    check('filtering by an inbound does not hide sibling inbounds',
      inboundFiltered.json?.data?.total === 1 && inboundFiltered.json.data.rows[0]?.groupCount === 3);
    const firstPage = await request('GET', '/api/reseller/configs?pageSize=1&page=1', { cookies: shopCookies });
    const secondPage = await request('GET', '/api/reseller/configs?pageSize=1&page=2', { cookies: shopCookies });
    const emptyPage = await request('GET', '/api/reseller/configs?pageSize=1&page=3', { cookies: shopCookies });
    check('pagination counts customers and never splits a package',
      firstPage.json?.data?.total === 2 && secondPage.json?.data?.total === 2
      && firstPage.json.data.rows[0]?.groupCount === 3
      && secondPage.json.data.rows[0]?.id === bought.id
      && secondPage.json.data.rows[0]?.groupCount === 1);
    check('out-of-range page keeps total without repeating a package',
      emptyPage.json?.data?.total === 2 && emptyPage.json.data.rows.length === 0);
    const noMatch = await request('GET', '/api/reseller/configs?search=absent-package-selftest', { cookies: shopCookies });
    check('unmatched customer search returns an empty list', noMatch.json?.data?.total === 0 && noMatch.json.data.rows.length === 0);
    const rotated = await request('POST', `/api/reseller/configs/${multiConfigs[0]?.id}/identity`, {
      cookies: shopCookies, csrf: shopCsrf, body: { subId: 'packagerotated1' },
    });
    const oldFeed = await request('GET', `/api/sub/${groupToken}`);
    const newFeed = await request('GET', '/api/sub/packagerotated1');
    check(
      'rotating the package token moves the whole group',
      rotated.status === 200 && newFeed.status === 200 && oldFeed.status === 404,
      `rotate=${rotated.status} old=${oldFeed.status} new=${newFeed.status}`
    );
    // Rotating a one-client package rewrites the REAL x-ui subId as well, so the
    // node address the customer already holds keeps working on the node.
    check('rotating a one-client package also moves the client’s subId on the node',
      mockXui.clients.get(String(multiConfigs[0].email))?.subId === 'packagerotated1',
      `subId=${mockXui.clients.get(String(multiConfigs[0].email))?.subId}`);

    // ------------------------------------------------- v1.4.18: one client per package
    // The owner's complaint: the subscription link was served by this panel
    // instead of the node. A package is now ONE x-ui client holding every
    // inbound he bought, so an added channel joins that client (no second
    // client, no aggregated link) and taking one channel off keeps the rest.
    const joinOrderEmail = String(multiConfigs[0].email);
    const clientsBeforeJoin = mockXui.clients.size;
    const beforeJoinClient = mockXui.clients.get(joinOrderEmail);
    const joinFeed = await request('POST', `/api/reseller/configs/${multiConfigs[0].id}/inbounds`, {
      cookies: shopCookies, csrf: shopCsrf, body: { inboundId: 904 },
    });
    const joinedConfig = joinFeed.json?.data?.config || {};
    const joinedClient = mockXui.clients.get(joinOrderEmail);
    check('a fourth inbound joins the customer’s own x-ui client instead of a new one',
      joinFeed.status === 201 && mockXui.clients.size === clientsBeforeJoin
        && String(joinedConfig.email) === joinOrderEmail
        && (joinedClient?.inboundIds || []).map(Number).sort().join(',') === '901,902,903,904',
      `status=${joinFeed.status} clients=${mockXui.clients.size} attached=${(joinedClient?.inboundIds || []).join(',')} email=${joinedConfig.email}`);
    const joinedQuota = mockXui.clients.get(joinOrderEmail);
    check('joining a channel leaves the pool, the expiry and the counters alone',
      Number(joinedQuota?.totalGB) === Number(beforeJoinClient?.totalGB)
        && Number(joinedQuota?.expiryTime) === Number(beforeJoinClient?.expiryTime)
        && String(joinedQuota?.id || '') === String(beforeJoinClient?.id || '')
        && Number(joinedQuota?.up) === Number(beforeJoinClient?.up)
        && Number(joinedQuota?.down) === Number(beforeJoinClient?.down)
        && joinedQuota?.enable !== false,
      `total=${joinedQuota?.totalGB} up=${joinedQuota?.up} down=${joinedQuota?.down} uuid=${joinedQuota?.id}`);
    const joinLinks = await request('GET', `/api/reseller/configs/${multiConfigs[0].id}/links`, { cookies: shopCookies });
    const joinSubs = joinLinks.json?.data?.subscriptions || {};
    check('the four-channel package is still one client, so its link is the node address',
      joinLinks.status === 200 && Number(joinSubs.clientCount) === 1 && joinSubs.source === 'node'
        && Number(joinSubs.node?.[0]?.inboundCount) === 4
        && String(joinLinks.json?.data?.subUrl || '') === 'https://sub.example.com/sub/packagerotated1',
      `subUrl=${joinLinks.json?.data?.subUrl} clients=${joinSubs.clientCount} inbounds=${joinSubs.node?.[0]?.inboundCount}`);
    const dropJoined = await request('DELETE', `/api/reseller/configs/${joinedConfig.id}`, {
      cookies: shopCookies, csrf: shopCsrf,
    });
    const afterDropClient = mockXui.clients.get(joinOrderEmail);
    check('taking one channel off detaches that inbound and keeps the customer connected',
      dropJoined.status === 200 && dropJoined.json?.data?.inboundDetached === true
        && dropJoined.json?.data?.detachedOnly === false && mockXui.clients.has(joinOrderEmail)
        && (afterDropClient?.inboundIds || []).map(Number).sort().join(',') === '901,902,903',
      `status=${dropJoined.status} detached=${dropJoined.json?.data?.inboundDetached} attached=${(afterDropClient?.inboundIds || []).join(',')}`);

    // A throwaway package of its own proves the other half: the last channel of a
    // customer is his client, so removing it has to remove the client (that is
    // what cuts the connection off, which is exactly what the owner wants).
    const dropOrder = await request('POST', '/api/reseller/configs', {
      cookies: shopCookies, csrf: shopCsrf,
      body: { inboundIds: [901, 902], gb: 2, days: 5, customerName: 'مشتری حذف تدریجی' },
    });
    const dropRows = dropOrder.json?.data?.configs || [];
    const dropEmail = String(dropRows[0]?.email || '');
    const dropFirst = await request('DELETE', `/api/reseller/configs/${dropRows[1]?.id}`, {
      cookies: shopCookies, csrf: shopCsrf,
    });
    check('removing one of two channels keeps the client with the remaining inbound',
      dropOrder.status === 201 && dropFirst.status === 200 && mockXui.clients.has(dropEmail)
        && (mockXui.clients.get(dropEmail)?.inboundIds || []).map(Number).join(',') === '901',
      `status=${dropFirst.status} attached=${(mockXui.clients.get(dropEmail)?.inboundIds || []).join(',')}`);
    const dropSecond = await request('DELETE', `/api/reseller/configs/${dropRows[0]?.id}`, {
      cookies: shopCookies, csrf: shopCsrf,
    });
    check('removing the last channel of the package removes his x-ui client',
      dropSecond.status === 200 && dropSecond.json?.data?.inboundDetached === false
        && mockXui.clients.has(dropEmail) === false,
      `status=${dropSecond.status} still=${mockXui.clients.has(dropEmail)}`);


    // ------------------------------------------------------------------- misc
    const key = await request('POST', '/api/auth/api-key', { cookies: shopCookies, csrf: shopCsrf, body: {} });
    const apiKey = key.json?.data?.apiKey || '';
    check('reseller api key issued', key.status === 200 && apiKey.startsWith('sc_'));

    const v1me = await request('GET', '/api/v1/me', { headers: { 'x-api-key': apiKey } });
    check('api v1 authenticates with key', v1me.status === 200 && v1me.json.data.user.username === SHOP);

    const v1List = await request('GET', `/api/v1/configs?search=${customerSearch}`, { headers: { 'x-api-key': apiKey } });
    const v1Rows = v1List.json?.data?.rows || [];
    check('API v1 retains one sanitized row per config',
      v1List.status === 200 && v1List.json?.data?.total === 3 && v1Rows.length === 3
      && v1Rows.every((item) => item.userId === shopId && item.inboundId > 0 && item.inbound?.remark && item.totalGb === 10));
    check('API v1 never exposes raw database columns or private x-ui subIds',
      v1Rows.length === 3 && v1Rows.every((item) => !('user_id' in item) && !('xui_sub_id' in item)
        && !('password' in item) && !('groupCount' in item)));
    const v1Filtered = await request('GET', '/api/v1/configs?inboundId=902', { headers: { 'x-api-key': apiKey } });
    check('API v1 inbound filtering stays flat',
      v1Filtered.json?.data?.total === 1 && v1Filtered.json.data.rows[0]?.inboundId === 902);
    // The API token is another door into the same service, so it has to meet the
    // same refusal: an automated reseller cannot buy back his meter for free.
    const v1EmptyReset = await request('POST', `/api/v1/configs/${bought.id}/extend`, {
      headers: { 'x-api-key': apiKey }, body: { gb: 0, days: 0, resetUsage: true },
    });
    check('v1.4.26 the API token cannot reset either — same 422, same untouched meter',
      v1EmptyReset.status === 422 && v1EmptyReset.json?.error?.code === 'reset_needs_renewal',
      `status=${v1EmptyReset.status} code=${v1EmptyReset.json?.error?.code}`);

    // Reproduce the reported two-inbound order and a second order with the
    // same display name. Only shared subscription identity defines a package.
    const twoBuy = await request('POST', '/api/reseller/configs', {
      cookies: shopCookies, csrf: shopCsrf,
      body: { inboundIds: [901, 902], gb: 30, days: 30, customerName: 'مشتری چند اینباند' },
    });
    const twoConfigs = twoBuy.json?.data?.configs || [];
    const twoList = await request('GET', `/api/reseller/configs?search=${customerSearch}`, { cookies: shopCookies });
    check('a two-inbound purchase produces one row with both inbounds',
      twoBuy.status === 201 && twoConfigs.length === 2
      && twoList.json?.data?.rows?.some((item) => item.id === twoConfigs[0].id && item.groupCount === 2),
      `status=${twoBuy.status} error=${twoBuy.json?.error?.code || ''}`);
    check('separate customers with the same name are not merged',
      twoList.json?.data?.total === 2 && twoList.json.data.rows.length === 2);

    // The dashboard must report customers, not x-ui client rows: three packages
    // here (1 + 3 + 2 inbounds) and six clients.
    const packageOverview = await request('GET', '/api/reseller/overview', { cookies: shopCookies });
    const packageStats = packageOverview.json?.data?.configs || {};
    check(
      'dashboard counts customer packages instead of inbounds',
      packageOverview.status === 200
        && packageStats.total === 3
        && packageStats.active === 3
        && packageStats.mixed === 0,
      `total=${packageStats.total} active=${packageStats.active} mixed=${packageStats.mixed}`
    );
    const packageMe = await request('GET', '/api/reseller/me', { cookies: shopCookies });
    check(
      'reseller profile exposes both package and row counts',
      packageMe.status === 200
        && packageMe.json.data.stats.packages === 3
        && packageMe.json.data.stats.activePackages === 3
        && packageMe.json.data.stats.configs === 6,
      `packages=${packageMe.json?.data?.stats?.packages} rows=${packageMe.json?.data?.stats?.configs}`
    );

    // One order spends exactly one customer slot, no matter how many inbounds it
    // carries; the next order is then refused by the same limit.
    const limitSet = await request('PATCH', `/api/admin/users/${shopId}`, {
      cookies, csrf, body: { max_configs: 4 },
    });
    const fourth = await request('POST', '/api/reseller/configs', {
      cookies: shopCookies, csrf: shopCsrf,
      body: { inboundIds: [901, 902], gb: 1, days: 1, customerName: 'مشتری چهارم' },
    });
    check(
      'a two-inbound order spends one customer slot',
      limitSet.status === 200 && fourth.status === 201,
      `status=${fourth.status} error=${fourth.json?.error?.code || ''}`
    );
    const fifth = await request('POST', '/api/reseller/configs', {
      cookies: shopCookies, csrf: shopCsrf,
      body: { inboundIds: [901], gb: 1, days: 1, customerName: 'مشتری پنجم' },
    });
    check(
      'the customer limit counts packages, not inbounds',
      fifth.status === 403 && fifth.json?.error?.code === 'limit_configs',
      `status=${fifth.status} code=${fifth.json?.error?.code}`
    );
    await request('PATCH', `/api/admin/users/${shopId}`, { cookies, csrf, body: { max_configs: 10 } });
    const expiringOverview = await request('GET', '/api/reseller/overview', { cookies: shopCookies });
    check(
      'an expiring package is counted once for the whole group',
      expiringOverview.json?.data?.configs.total === 4
        && expiringOverview.json.data.expiring3d === 1,
      `total=${expiringOverview.json?.data?.configs?.total} expiring=${expiringOverview.json?.data?.expiring3d}`
    );

    // Deleting a reseller hides the account but keeps its row (usernames are
    // UNIQUE), so saving the same name again has to bring that account back
    // instead of answering "username already in use".
    const REVIVE = 'revive-me';
    const reviveCreate = await request('POST', '/api/admin/users', {
      cookies, csrf,
      body: { username: REVIVE, password: 'RevivePass1', name: 'نماینده بازیابی', role: 'reseller' },
    });
    const reviveId = reviveCreate.json?.data?.user?.id;
    await request('POST', `/api/admin/users/${reviveId}/balance`, { cookies, csrf, body: { amount: 100000, description: 'شارژ بازیابی' } });
    const reviveLogin = await request('POST', '/api/auth/login', { body: { username: REVIVE, password: 'RevivePass1' } });
    const reviveCookies = cookiesFrom(reviveLogin.headers);
    const reviveCsrf = reviveLogin.json?.data?.csrf;
    const reviveBuy = await request('POST', '/api/reseller/configs', {
      cookies: reviveCookies, csrf: reviveCsrf,
      body: { inboundIds: [901], gb: 10, days: 30, customerName: 'مشتری بازیابی' },
    });
    const reviveDelete = await request('DELETE', `/api/admin/users/${reviveId}`, { cookies, csrf, body: {} });
    const reviveHidden = await request('GET', `/api/admin/users?search=${REVIVE}`, { cookies });
    check(
      'a deleted reseller leaves the list',
      reviveBuy.status === 201 && reviveDelete.status === 200 && reviveHidden.json?.data?.total === 0,
      `buy=${reviveBuy.status} del=${reviveDelete.status} listed=${reviveHidden.json?.data?.total}`
    );

    const reviveAgain = await request('POST', '/api/admin/users', {
      cookies, csrf,
      body: { username: REVIVE, password: 'RevivePass2', name: 'نماینده بازیابی', role: 'reseller' },
    });
    check(
      're-creating a deleted reseller revives the same account',
      reviveAgain.status === 201 && reviveAgain.json?.data?.revived === true && reviveAgain.json?.data?.user?.id === reviveId,
      `status=${reviveAgain.status} revived=${reviveAgain.json?.data?.revived} id=${reviveAgain.json?.data?.user?.id} expected=${reviveId}`
    );

    const reviveLogin2 = await request('POST', '/api/auth/login', { body: { username: REVIVE, password: 'RevivePass2' } });
    const reviveOverview = await request('GET', '/api/reseller/overview', { cookies: cookiesFrom(reviveLogin2.headers) });
    check(
      'the revived account signs in with the new password and keeps its customer',
      reviveLogin2.status === 200 && reviveOverview.json?.data?.configs?.total === 1,
      `login=${reviveLogin2.status} configs=${reviveOverview.json?.data?.configs?.total}`
    );
    const staleRevive = await request('GET', '/api/auth/me', { cookies: reviveCookies });
    check('the session from before the deletion is logged out', staleRevive.status === 401, `status=${staleRevive.status}`);

    const reviveLive = await request('POST', '/api/admin/users', {
      cookies, csrf, body: { username: REVIVE, password: 'RevivePass3', role: 'reseller' },
    });
    check(
      'a live reseller still blocks the same name',
      reviveLive.status === 409 && reviveLive.json?.error?.code === 'username_taken',
      `status=${reviveLive.status} code=${reviveLive.json?.error?.code}`
    );

    await request('DELETE', `/api/admin/users/${reviveId}`, { cookies, csrf, body: {} });
    const renameToDeleted = await request('PATCH', `/api/admin/users/${shopId}`, { cookies, csrf, body: { username: REVIVE } });
    check(
      'renaming onto a deleted username says the name belongs to a deleted reseller',
      renameToDeleted.status === 409 && renameToDeleted.json?.error?.code === 'username_taken_deleted',
      `status=${renameToDeleted.status} code=${renameToDeleted.json?.error?.code}`
    );
    await request('POST', '/api/admin/users', {
      cookies, csrf, body: { username: REVIVE, password: 'RevivePass4', name: 'نماینده بازیابی', role: 'reseller' },
    });

    // Direct fixtures exist ONLY in the disposable self-test database. They
    // cover legacy rows, token collisions, deletion and mixed member states.
    const fixtureDb = new Database(path.join(DATA_DIR, 'panel.db'));
    const fixtureIds = [];
    let fixtureServerId;
    try {
      fixtureServerId = Number(fixtureDb.prepare("INSERT INTO servers (name, enabled) VALUES ('Grouping fixture', 0)").run().lastInsertRowid);
      const fixture = (userId, serverId, token, label) => {
        const info = fixtureDb.prepare(`INSERT INTO configs
          (user_id, server_id, inbound_id, email, sub_id, label, total_bytes, created_at, updated_at)
          VALUES (?, ?, 901, ?, ?, ?, ?, ?, ?)`)
          .run(userId, serverId, `fixture-${crypto.randomBytes(8).toString('hex')}`, token, label, 1024 ** 3, Date.now(), Date.now());
        const id = Number(info.lastInsertRowid);
        fixtureIds.push(id);
        return id;
      };
      const otherUserId = setup.json.data.user.id;
      const foreignId = fixture(otherUserId, primaryId, 'packagerotated1', 'foreign-owner');
      const otherServerId = fixture(shopId, fixtureServerId, 'packagerotated1', 'foreign-server');
      const emptyOne = fixture(shopId, primaryId, '', 'empty-token-fixture');
      const emptyTwo = fixture(shopId, primaryId, '', 'empty-token-fixture');
      const blankList = await request('GET', '/api/reseller/configs?search=empty-token-fixture', { cookies: shopCookies });
      check('legacy rows with empty subscription tokens remain separate',
        blankList.json?.data?.total === 2 && blankList.json.data.rows.every((item) => item.groupCount === 1)
        && blankList.json.data.rows.some((item) => item.id === emptyOne)
        && blankList.json.data.rows.some((item) => item.id === emptyTwo));
      const scoped = await request('GET', `/api/reseller/configs?userId=${otherUserId}&search=${encodeURIComponent(multiConfigs[0].email)}`, { cookies: shopCookies });
      check('matching tokens cannot expose another owner or server in a package',
        scoped.json?.data?.total === 1 && scoped.json.data.rows[0]?.groupCount === 3
        && !scoped.json.data.rows[0].groupIds.includes(foreignId)
        && !scoped.json.data.rows[0].groupIds.includes(otherServerId));
      const adminScoped = await request('GET', `/api/admin/configs?userId=${otherUserId}`, { cookies });
      check('admin user filter does not expand into another reseller',
        adminScoped.json?.data?.total === 1 && adminScoped.json.data.rows[0]?.id === foreignId
        && adminScoped.json.data.rows[0]?.groupCount === 1);
      const denied = await request('GET', `/api/reseller/configs/${foreignId}`, { cookies: shopCookies });
      check('reseller cannot open another owners config', denied.status === 403);

      const alteredId = multiConfigs[1].id;
      const original = fixtureDb.prepare('SELECT * FROM configs WHERE id = ?').get(alteredId);
      try {
        fixtureDb.prepare('UPDATE configs SET enabled = 0, total_bytes = 0, expiry_at = 0, up_bytes = 123 WHERE id = ?').run(alteredId);
        const mixed = await request('GET', `/api/reseller/configs?search=${customerSearch}&status=mixed`, { cookies: shopCookies });
        const mixedRow = mixed.json?.data?.rows?.[0];
        check('status filter selects a complete package with mixed states',
          mixed.json?.data?.total === 1 && mixedRow?.groupCount === 3 && mixedRow.groupStatus === 'mixed');
        // The fixtures above added three more shop packages (foreign server and
        // two legacy token-less rows), so 4 real + 3 fixtures = 7 customers.
        const mixedOverview = await request('GET', '/api/reseller/overview', { cookies: shopCookies });
        check(
          'a package with one disabled inbound is reported as mixed',
          mixedOverview.json?.data?.configs.total === 7
            && mixedOverview.json.data.configs.mixed === 1
            && mixedOverview.json.data.configs.active === 6,
          `total=${mixedOverview.json?.data?.configs?.total} mixed=${mixedOverview.json?.data?.configs?.mixed} active=${mixedOverview.json?.data?.configs?.active}`
        );
        check('finite and unlimited member quotas and expiries are not conflated',
          mixedRow?.expiryMixed === true
          && mixedRow.inbounds.some((item) => item.configId === alteredId && item.totalBytes === 0 && item.expiryAt === 0 && item.used === 123)
          && mixedRow.inbounds.some((item) => item.totalBytes === 10 * 1024 ** 3 && item.expiryAt > 0));
        fixtureDb.prepare('UPDATE configs SET deleted_at = ? WHERE id = ?').run(Date.now(), alteredId);
        const afterDelete = await request('GET', `/api/reseller/configs?search=${encodeURIComponent(multiConfigs[0].email)}`, { cookies: shopCookies });
        check('soft-deleted members disappear without duplicating the customer',
          afterDelete.json?.data?.total === 1 && afterDelete.json.data.rows[0]?.groupCount === 2
          && !afterDelete.json.data.rows[0].groupIds.includes(alteredId));
      } finally {
        fixtureDb.prepare('UPDATE configs SET enabled = ?, total_bytes = ?, expiry_at = ?, up_bytes = ?, deleted_at = ? WHERE id = ?')
          .run(original.enabled, original.total_bytes, original.expiry_at, original.up_bytes, original.deleted_at, alteredId);
      }
      const removeMember = await request('DELETE', `/api/reseller/configs/${twoConfigs[1].id}`, { cookies: shopCookies, csrf: shopCsrf });
      const remainingMember = await request('GET', `/api/reseller/configs?search=${encodeURIComponent(twoConfigs[0].email)}`, { cookies: shopCookies });
      check('removing one of two inbounds leaves one customer row',
        removeMember.status === 200 && remainingMember.json?.data?.total === 1
        && remainingMember.json.data.rows[0]?.groupCount === 1);
    } finally {
      for (const id of fixtureIds) fixtureDb.prepare('DELETE FROM configs WHERE id = ?').run(id);
      if (fixtureServerId) fixtureDb.prepare('DELETE FROM servers WHERE id = ?').run(fixtureServerId);
      fixtureDb.close();
    }

    // ------------------------------------------- v1.4.16: fixed inbound & adopted packages
    // The bug the owner reported: a subscription adopted from the old panel has
    // no group token, so the drawer showed no inbound at all, adding one was
    // refused as "already exists", and deleting one would have deleted the live
    // client on the seller's panel. The fixed inbound is the safety base: every
    // package — including the adopted ones — must carry it.
    const FIXED = 'fixedshop';
    const fixedShop = await request('POST', '/api/admin/users', {
      cookies, csrf,
      body: { username: FIXED, password: SHOP_PASS, name: 'نماینده اینباند ثابت', role: 'reseller', balance: 100000 },
    });
    const fixedShopId = fixedShop.json?.data?.user?.id;
    const fixedLogin = await request('POST', '/api/auth/login', { body: { username: FIXED, password: SHOP_PASS } });
    const fixedCookies = cookiesFrom(fixedLogin.headers);
    const fixedCsrf = fixedLogin.json?.data?.csrf;

    const fixedDb = new Database(path.join(DATA_DIR, 'panel.db'));
    const fixedRowIds = [];
    const fixedMockEmails = [];
    try {
      // An adopted subscription is ONE live x-ui client attached to the inbounds
      // the customer bought, kept locally as one row per inbound. Since v1.4.18
      // the panel talks to that client (it adds a channel to it instead of
      // minting a second one), so the fake panel has to hold it too — otherwise
      // the fixture would be a row with no client behind it, which never happens
      // on a real node.
      const addLegacy = (inboundId, label) => {
        const email = `legacy-${crypto.randomBytes(8).toString('hex')}`;
        const info = fixedDb.prepare(`INSERT INTO configs
          (user_id, server_id, inbound_id, email, sub_id, xui_sub_id, uuid, label, customer_name,
           total_bytes, expiry_at, enabled, status, origin, up_bytes, down_bytes, created_at, updated_at)
          VALUES (?, ?, ?, ?, '', ?, ?, ?, 'مشتری قدیمی', ?, ?, 1, 'active', 'external', 7, 8, ?, ?)`)
          .run(fixedShopId, primaryId, inboundId, email, `${label}-sub`, crypto.randomUUID(), label,
            3 * 1024 ** 3, Date.now() + 30 * 86400000, Date.now(), Date.now());
        mockXui.clients.set(email, {
          email, id: `${label}-uuid`, subId: `${label}-sub`, security: 'auto',
          totalGB: 3 * 1024 ** 3, expiryTime: Date.now() + 30 * 86400000, enable: true,
          up: 7, down: 8, inboundIds: [inboundId],
        });
        fixedMockEmails.push(email);
        const id = Number(info.lastInsertRowid);
        fixedRowIds.push(id);
        return id;
      };
      const legacyA = addLegacy(902, 'legacy-a');
      const legacyB = addLegacy(904, 'legacy-b');

      const legacyDetail = await request('GET', `/api/admin/configs/${legacyA}`, { cookies });
      const legacyGroup = legacyDetail.json?.data?.group || [];
      check('an adopted config without a subscription token still lists its own inbound',
        legacyGroup.length === 1 && Number(legacyGroup[0].inboundId) === 902
        && legacyGroup[0].origin === 'external' && legacyGroup[0].removable === true,
        `group=${legacyGroup.length}`);

      // Second adopted row (legacy-b) already carries inbound 904; the old
      // (sub_id, inbound_id) test matched it because every adopted row shares
      // the empty token, so this request answered 409.
      const walletBeforeAdd = Number((await request('GET', '/api/auth/me', { cookies: fixedCookies })).json?.data?.user?.balance || 0);
      const legacyAdd = await request('POST', `/api/admin/configs/${legacyA}/inbounds`, {
        cookies, csrf, body: { inboundId: 904 },
      });
      const legacyAdded = legacyAdd.json?.data?.config || {};
      check('adding an inbound that another adopted package holds is not a false conflict',
        legacyAdd.status === 201 && Number(legacyAdded.inboundId) === 904,
        `status=${legacyAdd.status} code=${legacyAdd.json?.error?.code}`);

      const legacyAfter = await request('GET', `/api/admin/configs/${legacyA}`, { cookies });
      const afterGroup = legacyAfter.json?.data?.group || [];
      const mintedToken = String(legacyAfter.json?.data?.config?.subId || '');
      check('the new inbound joins the adopted package under one minted subscription token',
        afterGroup.length === 2 && Boolean(mintedToken)
        && afterGroup.some((item) => Number(item.inboundId) === 902)
        && afterGroup.some((item) => Number(item.inboundId) === 904),
        `group=${afterGroup.length} token=${mintedToken}`);
      const sharedToken = fixedDb.prepare('SELECT COUNT(DISTINCT sub_id) AS n FROM configs WHERE id IN (?, ?)')
        .get(legacyA, legacyAdded.id);
      check('both members of the healed package share exactly one subscription token',
        Number(sharedToken.n) === 1 && Boolean(mintedToken), `distinct=${sharedToken.n}`);

      // Wallet billing is on from the earlier block. The add above joined a
      // zero-tariff inbound, so the money path is proven on the SECOND adopted
      // package with a priced inbound: exactly one charge, and the free heal
      // below must not touch the wallet at all.
      //
      // v1.4.25: an ADMIN add is free unless he ticks «کسر از کیف پول نماینده»,
      // so the paid case has to ask for it by name — and the paired free add on
      // the next lines proves the switch is not just decoration.
      const paidAdd = await request('POST', `/api/admin/configs/${legacyB}/inbounds`, {
        cookies, csrf, body: { inboundId: 903, charge: true },
      });
      const walletAfterAdd = Number((await request('GET', '/api/auth/me', { cookies: fixedCookies })).json?.data?.user?.balance || 0);
      const addCharges = fixedDb.prepare(
        "SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND type = 'purchase' AND description LIKE 'افزودن اینباند%'"
      ).get(fixedShopId).c;
      check('adding a priced inbound with the charge switch on charges the reseller wallet once',
        paidAdd.status === 201 && walletAfterAdd < walletBeforeAdd && Number(addCharges) === 1,
        `status=${paidAdd.status} balance=${walletBeforeAdd}→${walletAfterAdd} charges=${addCharges}`);

      // The same call without the switch: the channel joins the customer's own
      // client, the wallet does not move and no ledger row is written.
      const freeAdd = await request('POST', `/api/admin/configs/${legacyB}/inbounds`, {
        cookies, csrf, body: { inboundId: 902 },
      });
      const walletAfterFreeAdd = Number((await request('GET', '/api/auth/me', { cookies: fixedCookies })).json?.data?.user?.balance || 0);
      const freeAddCharges = fixedDb.prepare(
        "SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND type = 'purchase' AND description LIKE 'افزودن اینباند%'"
      ).get(fixedShopId).c;
      const freeAdded = freeAdd.json?.data?.config || {};
      check('v1.4.25 the same add without the switch gives the customer the channel for free',
        freeAdd.status === 201 && Number(freeAdded.inboundId) === 902
        && String(freeAdded.email || '') === String(paidAdd.json?.data?.config?.email || '')
        && walletAfterFreeAdd === walletAfterAdd && Number(freeAddCharges) === 1,
        `status=${freeAdd.status} balance=${walletAfterAdd}→${walletAfterFreeAdd} charges=${freeAddCharges}`);

      // An adopted row is not this panel's customer: detaching it must leave the
      // live x-ui client alone, while a panel-created row still deletes it.
      fixedDb.prepare("UPDATE configs SET origin = 'external' WHERE id = ?").run(legacyAdded.id);
      const detach = await request('DELETE', `/api/admin/configs/${legacyAdded.id}`, { cookies, csrf });
      check('removing an adopted config only detaches it and never deletes the x-ui client',
        detach.status === 200 && detach.json?.data?.detachedOnly === true
        && mockXui.clients.has(String(legacyAdded.email)) === true,
        `status=${detach.status} detached=${detach.json?.data?.detachedOnly} client=${mockXui.clients.has(String(legacyAdded.email))}`);

      const fresh = await request('POST', '/api/reseller/configs', {
        cookies: fixedCookies, csrf: fixedCsrf,
        body: { inboundIds: [903], gb: 5, days: 10, customerName: 'مشتری جدید' },
      });
      const freshConfigs = fresh.json?.data?.configs || [];
      check('a plain package can still be created for this reseller',
        fresh.status === 201 && freshConfigs.length === 1 && Number(freshConfigs[0].inboundId) === 903,
        `status=${fresh.status}`);
      const deletePanelRow = await request('DELETE', `/api/reseller/configs/${freshConfigs[0].id}`, {
        cookies: fixedCookies, csrf: fixedCsrf,
      });
      check('deleting a panel-created config does remove its x-ui client',
        deletePanelRow.status === 200 && deletePanelRow.json?.data?.detachedOnly === false
        && mockXui.clients.has(String(freshConfigs[0].email)) === false,
        `detached=${deletePanelRow.json?.data?.detachedOnly}`);

      // The owner now names a fixed inbound for this reseller: the PATCH only
      // counts, the real write is the explicit apply call.
      const badFixed = await request('PATCH', `/api/admin/users/${fixedShopId}`, {
        cookies, csrf, body: { fixed_inbound: 999999 },
      });
      check('a fixed inbound that is not in the panel is refused',
        badFixed.status === 422 && badFixed.json?.error?.code === 'invalid_fixed_inbound',
        `status=${badFixed.status} code=${badFixed.json?.error?.code}`);

      const fixedPatch = await request('PATCH', `/api/admin/users/${fixedShopId}`, {
        cookies, csrf, body: { fixed_inbound: 901 },
      });
      const preview = fixedPatch.json?.data?.fixedInboundPreview || {};
      check('saving the fixed inbound previews how many existing packages miss it',
        fixedPatch.status === 200 && Number(fixedPatch.json?.data?.user?.fixedInbound) === 901
        && Number(preview.packages) === 2 && Number(preview.needFix) === 2 && Number(preview.healed) === 0,
        `packages=${preview.packages} needFix=${preview.needFix} healed=${preview.healed}`);

      const liveBeforeDry = fixedDb.prepare('SELECT COUNT(*) AS c FROM configs WHERE user_id = ? AND deleted_at = 0').get(fixedShopId).c;
      const dryRun = await request('POST', `/api/admin/users/${fixedShopId}/fixed-inbound/apply`, {
        cookies, csrf, body: { dryRun: true },
      });
      check('the dry run counts without writing anything',
        dryRun.status === 200 && Number(dryRun.json?.data?.needFix) === 2 && Number(dryRun.json?.data?.healed) === 0
        && fixedDb.prepare('SELECT COUNT(*) AS c FROM configs WHERE user_id = ? AND deleted_at = 0').get(fixedShopId).c === liveBeforeDry,
        `needFix=${dryRun.json?.data?.needFix} healed=${dryRun.json?.data?.healed} live=${liveBeforeDry}`);

      const walletBeforeHeal = Number((await request('GET', '/api/auth/me', { cookies: fixedCookies })).json?.data?.user?.balance || 0);
      // v1.4.20 guard, from the live defect: this heal pass on the ثنایی panel ran
      // under v1.4.17 and minted ONE NEW x-ui client per customer (34 of them, each
      // holding only Status2), which is what split one package across two clients
      // and pushed the subscription link behind this panel. The heal must move the
      // channel onto the client the customer already has, so the node must finish
      // the pass with exactly the clients it started with.
      const clientsBeforeHeal = mockXui.clients.size;
      const callsBeforeHeal = mockXui.calls.length;
      const heal = await request('POST', `/api/admin/users/${fixedShopId}/fixed-inbound/apply`, {
        cookies, csrf, body: { dryRun: false },
      });
      const healCalls = mockXui.calls.slice(callsBeforeHeal);
      check('the heal pass creates no x-ui client at all — a channel joins an existing customer',
        heal.status === 200 && mockXui.clients.size === clientsBeforeHeal
        && healCalls.some((call) => call.route === '/clients/bulkAttach')
        && healCalls.every((call) => call.route !== '/clients/add'),
        `clients=${clientsBeforeHeal}→${mockXui.clients.size} add=${healCalls.filter((call) => call.route === '/clients/add').length} bulkAttach=${healCalls.filter((call) => call.route === '/clients/bulkAttach').length}`);
      check('the heal adds the fixed inbound to every adopted package without charging',
        heal.status === 200 && Number(heal.json?.data?.healed) === 2 && Number(heal.json?.data?.skipped) === 0,
        `healed=${heal.json?.data?.healed} skipped=${heal.json?.data?.skipped} errors=${JSON.stringify(heal.json?.data?.errors || [])}`);
      const walletAfterHeal = Number((await request('GET', '/api/auth/me', { cookies: fixedCookies })).json?.data?.user?.balance || 0);
      check('the heal takes no money — the base is a safety net, not a sale',
        walletAfterHeal === walletBeforeHeal, `${walletBeforeHeal} → ${walletAfterHeal}`);

      const healedA = await request('GET', `/api/admin/configs/${legacyA}`, { cookies });
      const healedGroup = healedA.json?.data?.group || [];
      const fixedMember = healedGroup.find((item) => Number(item.inboundId) === 901) || {};
      check('the adopted package now carries the fixed inbound and it is locked',
        healedGroup.length === 2 && fixedMember.fixed === true && fixedMember.removable === false,
        `group=${healedGroup.length} fixed=${Boolean(fixedMember.fixed)}`);
      check('a healed inbound inherits the package pool instead of adding quota',
        Number(fixedMember.totalBytes) === 3 * 1024 ** 3
        && Number(fixedMember.expiryAt) > Date.now(),
        `bytes=${fixedMember.totalBytes}`);
      // v1.4.20 #88, from the live defect: the healed channel is a row THIS panel
      // wrote, so it keeps origin 'panel' while the adopted rows of the same customer
      // stay 'external'. That split is what makes removing the channel undo our own
      // write on the node instead of silently forgetting it, and it is the shape the
      // ثنایی census finds today (an adopted customer plus one channel of ours).
      check('the healed channel is a row this panel wrote, beside the adopted ones',
        String(fixedMember.origin || '') === 'panel'
        && healedGroup.filter((item) => String(item.origin || '') === 'external').length === 1,
        `origin=${fixedMember.origin} group=${healedGroup.map((item) => `${item.inboundId}:${item.origin}`).join(',')}`);

      // v1.4.18: the heal added the channel to the customer's OWN client, so the
      // package is still one client and his subscription link stays on the node —
      // this is the exact case that used to push legacy configs behind the panel.
      const legacyAEmail = String(fixedDb.prepare('SELECT email FROM configs WHERE id = ?').get(legacyA).email);
      const healedClient = mockXui.clients.get(legacyAEmail);
      const healedLinks = await request('GET', `/api/admin/configs/${legacyA}`, { cookies });
      const healedSubs = healedLinks.json?.data?.subscriptions || {};
      const healedAttached = (healedClient?.inboundIds || []).map(Number).sort((a, b) => a - b);
      // 904 stays attached on the fake panel: the row that held it was adopted,
      // and detaching an adopted row never writes to the seller's panel.
      check('healing attaches the fixed inbound to the live client of the adopted customer',
        healedClient && healedAttached.includes(901) && healedAttached.includes(902),
        `email=${legacyAEmail} attached=${healedAttached.join(',')}`);
      check('the healed adopted package is still one client, so its link stays on the node',
        healedLinks.status === 200 && Number(healedSubs.clientCount) === 1 && healedSubs.source === 'node'
        && Number(healedSubs.node?.[0]?.inboundCount) === 2
        && String(healedLinks.json?.data?.subUrl || '') === 'https://sub.example.com/sub/legacy-a-sub',
        `subUrl=${healedLinks.json?.data?.subUrl} clients=${healedSubs.clientCount} inbounds=${healedSubs.node?.[0]?.inboundCount}`);

      const dropFixed = await request('DELETE', `/api/admin/configs/${fixedMember.id}`, { cookies, csrf });
      check('the fixed inbound cannot be taken off a multi-inbound package',
        dropFixed.status === 409 && dropFixed.json?.error?.code === 'fixed_inbound_locked',
        `status=${dropFixed.status} code=${dropFixed.json?.error?.code}`);

      const secondHeal = await request('POST', `/api/admin/users/${fixedShopId}/fixed-inbound/apply`, {
        cookies, csrf, body: { dryRun: false },
      });
      check('healing again changes nothing — no duplicate inbound is created',
        secondHeal.status === 200 && Number(secondHeal.json?.data?.needFix) === 0
        && Number(secondHeal.json?.data?.already) === 2 && Number(secondHeal.json?.data?.healed) === 0,
        `needFix=${secondHeal.json?.data?.needFix} already=${secondHeal.json?.data?.already}`);


      // -------------------------------------------------- v1.4.24: whole-subscription delete
      // The owner's complaint about that 409 was there being no way to finish the job:
      // he had to peel the channels off one by one and delete the last row to make the
      // client go. deletePackage is the case his own rule allows — the base goes only
      // when the whole subscription does. And for an adopted customer it must still
      // never write to the other operator's panel.
      const pkgCallsBefore = mockXui.calls.length;
      const dropAdoptedPackage = await request('DELETE', `/api/admin/configs/${fixedMember.id}/package`, { cookies, csrf });
      const pkgCalls = mockXui.calls.slice(pkgCallsBefore);
      const adoptedLeft = fixedDb.prepare('SELECT COUNT(*) AS c FROM configs WHERE id IN (?, ?) AND deleted_at = 0')
        .get(legacyA, Number(fixedMember.id)).c;
      const pkgData = dropAdoptedPackage.json?.data || {};
      check('the whole subscription can be deleted even though its base is locked',
        dropAdoptedPackage.status === 200 && Number(pkgData.rows) === 2,
        `status=${dropAdoptedPackage.status} rows=${pkgData.rows} code=${dropAdoptedPackage.json?.error?.code}`);
      check('and every row of that package is gone, the fixed inbound included',
        adoptedLeft === 0, `rows left=${adoptedLeft}`);
      check('deleting an adopted customer deletes nothing on the seller panel',
        mockXui.clients.has(legacyAEmail) === true
        && pkgCalls.every((call) => !String(call.route || '').includes('/clients/del'))
        && (pkgData.xuiDeleted || []).length === 0,
        `client=${mockXui.clients.has(legacyAEmail)} calls=${pkgCalls.map((call) => call.route).join(',')}`);
      check('the answer says which half did NOT happen, so the UI can tell the reseller',
        pkgData.remoteDeleted === false && (pkgData.localOnly || []).length >= 1,
        JSON.stringify(pkgData).slice(0, 200));

      // A customer this panel made himself is the other case: his client really goes.
      const ownPackage = await request('POST', '/api/reseller/configs', {
        cookies: fixedCookies, csrf: fixedCsrf,
        body: { inboundIds: [903, 904], gb: 3, days: 7, customerName: 'مشتری حذف کامل' },
      });
      const ownConfigs = ownPackage.json?.data?.configs || [];
      const ownEmail = String(ownConfigs[0]?.email || '');
      const ownSubId = String(ownConfigs[0]?.subId || '');
      check('a three-channel package of our own is still one x-ui client',
        ownPackage.status === 201 && ownConfigs.length === 3
        && new Set(ownConfigs.map((item) => String(item.email))).size === 1,
        `rows=${ownConfigs.length} emails=${new Set(ownConfigs.map((item) => String(item.email))).size}`);
      const dropOwnPackage = await request('DELETE', `/api/reseller/configs/${ownConfigs[0].id}/package`, {
        cookies: fixedCookies, csrf: fixedCsrf,
      });
      const ownData = dropOwnPackage.json?.data || {};
      const ownLeft = fixedDb.prepare('SELECT COUNT(*) AS c FROM configs WHERE sub_id = ? AND deleted_at = 0').get(ownSubId).c;
      check('deleting the whole subscription removes the rows and his x-ui client together',
        dropOwnPackage.status === 200 && Number(ownData.rows) === 3 && ownLeft === 0
        && (ownData.xuiDeleted || []).includes(ownEmail) && mockXui.clients.has(ownEmail) === false,
        `status=${dropOwnPackage.status} rows=${ownData.rows} left=${ownLeft} client=${mockXui.clients.has(ownEmail)}`);
      check('and that delete is the one remote write of the whole block',
        ownData.remoteDeleted === true
        && mockXui.calls.slice(pkgCallsBefore).filter((call) => String(call.route || '').includes('/clients/del')).length === 1,
        `del=${mockXui.calls.slice(pkgCallsBefore).filter((call) => String(call.route || '').includes('/clients/del')).length}`);
      const ownNotes = await request('GET', '/api/notifications', { cookies: fixedCookies });
      check('the reseller is told his customer was removed',
        (ownNotes.json?.data?.rows || []).some((item) => item.title === 'اشتراک حذف شد'),
        `titles=${(ownNotes.json?.data?.rows || []).slice(0, 4).map((item) => item.title).join('|')}`);

      const foreignRow = fixedDb.prepare('SELECT id FROM configs WHERE user_id <> ? AND deleted_at = 0 LIMIT 1').get(fixedShopId);
      const foreignDelete = await request('DELETE', `/api/reseller/configs/${foreignRow.id}/package`, {
        cookies: fixedCookies, csrf: fixedCsrf,
      });
      check('a reseller cannot delete another reseller’s customer this way',
        foreignDelete.status === 403, `status=${foreignDelete.status} code=${foreignDelete.json?.error?.code}`);
      const foreignLeft = fixedDb.prepare('SELECT deleted_at FROM configs WHERE id = ?').get(foreignRow.id).deleted_at;
      check('and the refusal happens before anything is touched',
        Number(foreignLeft) === 0, `deleted_at=${foreignLeft}`);

      // New configs must get the base automatically, even when the reseller only
      // ticks one other inbound, and the allow list must always keep the base.
      const autoFixed = await request('POST', '/api/reseller/configs', {
        cookies: fixedCookies, csrf: fixedCsrf,
        body: { inboundIds: [903], gb: 5, days: 10, customerName: 'مشتری خودکار' },
      });
      const autoConfigs = autoFixed.json?.data?.configs || [];
      check('creating a config forces the fixed inbound into the package',
        autoFixed.status === 201 && autoConfigs.length === 2
        && autoConfigs.map((item) => Number(item.inboundId)).sort().join(',') === '901,903'
        && autoConfigs.every((item) => item.subId && item.subId === autoConfigs[0].subId),
        `rows=${autoConfigs.length} ids=${autoConfigs.map((item) => item.inboundId).join(',')}`);

      const allowList = await request('PATCH', `/api/admin/users/${fixedShopId}`, {
        cookies, csrf, body: { allowed_inbounds: [903] },
      });
      check('the allowed-inbound list always keeps the fixed inbound',
        allowList.status === 200
        && [901, 903].every((id) => (allowList.json?.data?.user?.allowedInbounds || []).includes(id)),
        `allowed=${JSON.stringify(allowList.json?.data?.user?.allowedInbounds || [])}`);

      const resellerInbounds = await request('GET', '/api/reseller/inbounds', { cookies: fixedCookies });
      const resellerRows = resellerInbounds.json?.data?.rows || [];
      check('the reseller picker marks the fixed inbound and keeps it selectable',
        Number(resellerInbounds.json?.data?.fixedInbound) === 901
        && resellerRows.some((row) => Number(row.id) === 901 && row.fixed === true),
        `fixedInbound=${resellerInbounds.json?.data?.fixedInbound} rows=${resellerRows.length}`);

      const adminPicker = await request('GET', `/api/admin/inbounds?userId=${fixedShopId}`, { cookies });
      check('the admin picker reports the same fixed inbound',
        Number(adminPicker.json?.data?.fixedInbound) === 901
        && (adminPicker.json?.data?.rows || []).some((row) => Number(row.id) === 901 && row.fixed === true));

      // A single-inbound package is the whole customer, so its base is removable
      // together with the config itself.
      const soloLegacy = addLegacy(901, 'legacy-solo');
      const soloGroup = (await request('GET', `/api/admin/configs/${soloLegacy}`, { cookies })).json?.data?.group || [];
      check('a package of one keeps its fixed inbound removable with the config',
        soloGroup.length === 1 && soloGroup[0].fixed === true && soloGroup[0].removable === true,
        `fixed=${soloGroup[0]?.fixed} removable=${soloGroup[0]?.removable}`);
      const deleteSolo = await request('DELETE', `/api/admin/configs/${soloLegacy}`, { cookies, csrf });
      check('deleting that single adopted config detaches it',
        deleteSolo.status === 200 && deleteSolo.json?.data?.detachedOnly === true,
        `status=${deleteSolo.status}`);
    } finally {
      for (const id of fixedRowIds) fixedDb.prepare('DELETE FROM configs WHERE id = ?').run(id);
      fixedDb.prepare('DELETE FROM configs WHERE user_id = ?').run(fixedShopId);
      for (const email of fixedMockEmails) mockXui.clients.delete(email);
      fixedDb.close();
    }

    // ------------------------------------------------ v1.4.18: merged packages
    // What v1.4.16–1.4.17 left on the live panel: adding a channel to an existing
    // package minted a SECOND x-ui client under the same group token, so that
    // package stopped being one client and its subscription link slid from the
    // node's address to this panel's aggregated one. Consolidation puts every
    // channel back on the client the customer already uses and deletes only the
    // duplicate client this panel created — never an adopted one.
    const MERGE_GB = 1024 ** 3;
    const splitToken = `split${crypto.randomBytes(8).toString('hex')}`;
    // The customer's own client: the subscription he really uses, on two channels.
    const ownEmail = `merge-own-${crypto.randomBytes(6).toString('hex')}`;
    // The client this panel minted for the reseller's FIXED inbound: it carries
    // that one channel and nothing else, so it is the copy that goes.
    const fixedEmail = `merge-fixed-${crypto.randomBytes(6).toString('hex')}`;
    const extToken = `ext${crypto.randomBytes(8).toString('hex')}`;
    const extEmailA = `merge-ext-a-${crypto.randomBytes(6).toString('hex')}`;
    const extEmailB = `merge-ext-b-${crypto.randomBytes(6).toString('hex')}`;
    // Declared out here because the `finally` cleanup below names them too: a
    // `const` inside the try is block-scoped and would throw there.
    const noSafeOwn = `merge-nosafe-own-${crypto.randomBytes(6).toString('hex')}`;
    const noSafeFixed = `merge-nosafe-fixed-${crypto.randomBytes(6).toString('hex')}`;
    const noSafeToken = `nosafe${crypto.randomBytes(8).toString('hex')}`;
    // Declared outside the try for the same reason as the two above: the `finally`
    // below has to clean the client of the stubborn-node order up too.
    let stubbornEmail = '';
    const splitDb = new Database(path.join(DATA_DIR, 'panel.db'));
    const splitRowIds = [];
    const addSplitRow = ({ email, inboundId, token, xuiSubId, origin }) => {
      const info = splitDb.prepare(`INSERT INTO configs
        (user_id, server_id, inbound_id, email, sub_id, xui_sub_id, uuid, label, customer_name,
         total_bytes, expiry_at, enabled, status, origin, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'بسته دونیم', 'مشتری یکپارچه', ?, ?, 1, 'active', ?, ?, ?)`)
        .run(fixedShopId, primaryId, inboundId, email, token, xuiSubId, crypto.randomUUID(),
          10 * MERGE_GB, Date.now() + 30 * 86400000, origin, Date.now(), Date.now());
      const id = Number(info.lastInsertRowid);
      splitRowIds.push(id);
      return id;
    };
    const addSplitClient = (email, subId, inboundIds) => {
      mockXui.clients.set(email, {
        email, id: crypto.randomUUID(), subId, security: 'auto',
        totalGB: 10 * MERGE_GB, expiryTime: Date.now() + 30 * 86400000, enable: true,
        up: 0, down: 0, inboundIds,
      });
    };
    try {
      // The shape the live panel really has: the customer's own client holds
      // several channels, the fixed-inbound client holds that single channel and
      // nothing else — the copy of his subscription this panel made.
      const ownRow = addSplitRow({ email: ownEmail, inboundId: 903, token: splitToken, xuiSubId: `private-${ownEmail}`, origin: 'panel' });
      addSplitRow({ email: ownEmail, inboundId: 904, token: splitToken, xuiSubId: `private-${ownEmail}`, origin: 'panel' });
      const fixedRow = addSplitRow({ email: fixedEmail, inboundId: 901, token: splitToken, xuiSubId: `private-${fixedEmail}`, origin: 'panel' });
      addSplitClient(ownEmail, `private-${ownEmail}`, [903, 904]);
      addSplitClient(fixedEmail, `private-${fixedEmail}`, [901]);

      const splitLinks = await request('GET', `/api/admin/configs/${ownRow}/links`, { cookies });
      const splitSubs = splitLinks.json?.data?.subscriptions || {};
      // The owner's rule for the address: a customer is handed the subscription the
      // NODE panel serves for his own x-ui client — never this panel's address — even
      // while the package is still spread over two clients. The combined link and the
      // other client's link stay listed underneath, and the /api/sub/<token> route
      // keeps answering for everyone who was already given it.
      check('a package held by two x-ui clients is still handed the node link of its own client',
        splitLinks.status === 200 && Number(splitSubs.clientCount) === 2 && splitSubs.source === 'node'
        && String(splitLinks.json?.data?.subUrl || '') === `https://sub.example.com/sub/private-${ownEmail}`
        && splitSubs.partial === true
        && String(splitSubs.aggregated || '') === `http://127.0.0.1/api/sub/${splitToken}`
        && Number((splitSubs.node || []).filter((item) => item.url !== splitSubs.primary).length) === 1,
        `subUrl=${splitLinks.json?.data?.subUrl} clients=${splitSubs.clientCount} source=${splitSubs.source} partial=${splitSubs.partial} aggregated=${splitSubs.aggregated}`);
      check('every client of a split package keeps its own node link in the drawer',
        Number(splitSubs.node?.length) === 2
        && (splitSubs.node || []).every((item) => String(item.url || '').startsWith('https://sub.example.com/sub/')),
        `node=${JSON.stringify((splitSubs.node || []).map((item) => item.url))}`);

      const clientsBeforeMerge = mockXui.clients.size;
      const mergeDry = await request('POST', `/api/admin/users/${fixedShopId}/consolidate`, {
        cookies, csrf, body: { dryRun: true },
      });
      const dryInfo = (mergeDry.json?.data?.details || []).find((item) => item.email === ownEmail) || {};
      check('the dry run reports the split without writing anything to x-ui',
        mergeDry.status === 200 && Number(mergeDry.json?.data?.packages) === 1
        && Number(mergeDry.json?.data?.split) === 1 && Number(mergeDry.json?.data?.merged) === 1
        && Number(dryInfo.moved) === 1 && dryInfo.dryRun === true
        && mockXui.clients.size === clientsBeforeMerge
        && String(splitDb.prepare('SELECT email FROM configs WHERE id = ?').get(fixedRow).email) === fixedEmail,
        `status=${mergeDry.status} packages=${mergeDry.json?.data?.packages} split=${mergeDry.json?.data?.split} clients=${mockXui.clients.size} own=${dryInfo.email} moved=${dryInfo.moved}`);

      const ownClientBefore = mockXui.clients.get(ownEmail) || {};
      const mergeRun = await request('POST', `/api/admin/users/${fixedShopId}/consolidate`, {
        cookies, csrf, body: { dryRun: false },
      });
      const fixedRowAfter = splitDb.prepare('SELECT * FROM configs WHERE id = ?').get(fixedRow);
      const mergedClient = mockXui.clients.get(ownEmail) || {};
      check('consolidating moves the extra channel onto the customer’s own client',
        mergeRun.status === 200 && Number(mergeRun.json?.data?.merged) === 1
        && Number(mergeRun.json?.data?.split) === 1
        && mockXui.clients.has(fixedEmail) === false && mockXui.clients.has(ownEmail) === true
        && (mergedClient.inboundIds || []).map(Number).sort((a, b) => a - b).join(',') === '901,903,904'
        && String(fixedRowAfter?.email || '') === ownEmail && String(fixedRowAfter?.sub_id || '') === splitToken
        && String(fixedRowAfter?.xui_sub_id || '') === `private-${ownEmail}`,
        `status=${mergeRun.status} merged=${mergeRun.json?.data?.merged} fixed=${mockXui.clients.has(fixedEmail)} attached=${(mergedClient.inboundIds || []).join(',')} row=${fixedRowAfter?.email}/${fixedRowAfter?.sub_id}`);
      check('the merge leaves the surviving client’s pool, expiry and identity alone',
        Number(mergedClient.totalGB) === Number(ownClientBefore.totalGB)
        && Number(mergedClient.expiryTime) === Number(ownClientBefore.expiryTime)
        && String(mergedClient.subId) === `private-${ownEmail}`
        && (mergeRun.json?.data?.errors || []).length === 0,
        `total=${mergedClient.totalGB} expiry=${mergedClient.expiryTime} subId=${mergedClient.subId} errors=${JSON.stringify(mergeRun.json?.data?.errors || [])}`);
      const mergedLinks = await request('GET', `/api/admin/configs/${ownRow}/links`, { cookies });
      const mergedSubs = mergedLinks.json?.data?.subscriptions || {};
      check('after the merge the customer’s link is the node address again',
        Number(mergedSubs.clientCount) === 1 && mergedSubs.source === 'node'
        && Number(mergedSubs.node?.[0]?.inboundCount) === 3 && mergedSubs.aggregated === ''
        && String(mergedLinks.json?.data?.subUrl || '') === `https://sub.example.com/sub/private-${ownEmail}`,
        `subUrl=${mergedLinks.json?.data?.subUrl} clients=${mergedSubs.clientCount} inbounds=${mergedSubs.node?.[0]?.inboundCount}`);

      // The live defect this guards: x-ui 3.8.5 ignores a channel listed in the
      // update endpoint's ?inboundIds= when the client is not in it yet, so the
      // merge "succeeded" while the customer lost that channel. The channel has to
      // move through bulkAttach, and the update call must not pretend to attach.
      const movedByAttach = mockXui.calls.filter((c) => c.route === '/clients/bulkAttach'
        && (c.body.emails || []).map(String).includes(String(ownEmail))
        && (c.body.inboundIds || []).map(Number).includes(901));
      const updatePretendingToAttach = mockXui.calls.filter((c) => c.route.startsWith('/clients/update/')
        && String(c.route).endsWith(String(ownEmail)) && c.query.inboundIds);
      check('a channel the client is not in yet moves through bulkAttach, not the update query',
        movedByAttach.length >= 1 && updatePretendingToAttach.length === 0,
        `bulkAttach=${movedByAttach.length} update-with-list=${updatePretendingToAttach.length}`);

      // Two adopted clients under one token are two different customers' live
      // subscriptions: merging would delete one of them, so the pass only reports.
      // Neither of them holds the fixed inbound, so the rule of the owner's fixed
      // client cannot decide between them either.
      const extRowA = addSplitRow({ email: extEmailA, inboundId: 903, token: extToken, xuiSubId: `${extEmailA}-sub`, origin: 'external' });
      addSplitRow({ email: extEmailB, inboundId: 902, token: extToken, xuiSubId: `${extEmailB}-sub`, origin: 'external' });
      addSplitClient(extEmailA, `${extEmailA}-sub`, [903]);
      addSplitClient(extEmailB, `${extEmailB}-sub`, [902]);
      const extDry = await request('POST', `/api/admin/users/${fixedShopId}/consolidate`, {
        cookies, csrf, body: { dryRun: true },
      });
      const extInfo = (extDry.json?.data?.details || []).find((item) => item.email === extEmailA) || {};
      check('a package whose second client belongs to another operator is reported, not touched',
        Number(extDry.json?.data?.packages) === 2 && Number(extDry.json?.data?.single) === 1
        && Number(extDry.json?.data?.split) === 1 && Number(extDry.json?.data?.merged) === 0
        && Number(extDry.json?.data?.skipped) === 1 && extInfo.reason === 'several-adopted-clients'
        && extInfo.skipped === true && mockXui.clients.has(extEmailA) && mockXui.clients.has(extEmailB),
        `packages=${extDry.json?.data?.packages} merged=${extDry.json?.data?.merged} skipped=${extDry.json?.data?.skipped} reason=${extInfo.reason}`);
      const extRun = await request('POST', `/api/admin/users/${fixedShopId}/consolidate`, {
        cookies, csrf, body: { dryRun: false },
      });
      check('running the pass keeps every adopted client and its rows exactly where they are',
        Number(extRun.json?.data?.merged) === 0 && Number(extRun.json?.data?.skipped) === 1
        && mockXui.clients.has(extEmailA) === true && mockXui.clients.has(extEmailB) === true
        && String(splitDb.prepare('SELECT email FROM configs WHERE id = ?').get(extRowA).email) === extEmailA,
        `merged=${extRun.json?.data?.merged} skipped=${extRun.json?.data?.skipped} clients=${mockXui.clients.has(extEmailA)}/${mockXui.clients.has(extEmailB)}`);

      // A package the pass must NOT touch still has to show the customer his own
      // node link — the adopted client leads, because that is the client the seller's
      // panel serves him under.
      const extLinks = await request('GET', `/api/admin/configs/${extRowA}/links`, { cookies });
      const extSubs = extLinks.json?.data?.subscriptions || {};
      check('two adopted clients under one token: the customer is given his own client’s node link',
        Number(extSubs.clientCount) === 2 && extSubs.source === 'node' && extSubs.partial === true
        && String(extLinks.json?.data?.subUrl || '') === `https://sub.example.com/sub/${extEmailA}-sub`
        && String(extSubs.aggregated || '') === `http://127.0.0.1/api/sub/${extToken}`
        && Number((extSubs.node || []).length) === 2,
        `subUrl=${extLinks.json?.data?.subUrl} source=${extSubs.source} node=${JSON.stringify((extSubs.node || []).map((n) => n.url))}`);
      const extFeed = await request('GET', `/api/sub/${extToken}`);
      const extFeedLinks = Buffer.from(String(extFeed?.raw || ''), 'base64').toString('utf8').split('\n').filter(Boolean);
      check('and the panel’s combined address keeps working for customers who already have it',
        extFeed.status === 200 && extFeedLinks.length === 2
        && extFeedLinks.every((link) => link.startsWith('vless://')),
        `status=${extFeed.status} links=${extFeedLinks.length}`);

      // Nothing left to do: a second pass over the same reseller is a no-op.
      const mergeAgain = await request('POST', `/api/admin/users/${fixedShopId}/consolidate`, {
        cookies, csrf, body: { dryRun: false },
      });
      check('a second pass changes nothing — the split packages are already one client each',
        mergeAgain.status === 200 && Number(mergeAgain.json?.data?.split) === 1
        && Number(mergeAgain.json?.data?.merged) === 0 && Number(mergeAgain.json?.data?.skipped) === 1
        && Number(mergeAgain.json?.data?.single) === 1,
        `split=${mergeAgain.json?.data?.split} merged=${mergeAgain.json?.data?.merged} skipped=${mergeAgain.json?.data?.skipped}`);

      // What the double must actually behave like, and what the panel must do when
      // the node refuses to take the channel: the duplicate client stays, because
      // deleting it is what would leave the customer with one channel fewer.
      const probeEmail = `merge-probe-${crypto.randomBytes(6).toString('hex')}`;
      addSplitClient(probeEmail, `probe-${probeEmail}-sub`, [901]);
      const rawUpdate = await fetch(`http://127.0.0.1:${mockXui.port}/panel/api`
        + `/clients/update/${encodeURIComponent(probeEmail)}?inboundIds=901,902`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: probeEmail, subId: `probe-${probeEmail}-sub` }),
      }).then((r) => r.json()).catch(() => null);
      check('the x-ui double behaves like 3.8.5: an update cannot attach a new channel',
        rawUpdate && rawUpdate.success === true
        && (mockXui.clients.get(probeEmail)?.inboundIds || []).map(Number).join(',') === '901',
        `attached=${(mockXui.clients.get(probeEmail)?.inboundIds || []).join(',')}`);
      mockXui.clients.delete(probeEmail);

      // What the fixed-inbound client must behave like, and what the panel must do
      // when the node refuses to take the channel: the copy that was going to go
      // stays, because deleting it is what would leave the customer with one
      // channel fewer. The refusal is put on the client that survives.
      const noSafeFixedRow = addSplitRow({ email: noSafeFixed, inboundId: 901, token: noSafeToken, xuiSubId: `private-${noSafeFixed}`, origin: 'panel' });
      const noSafeOwnRow = addSplitRow({ email: noSafeOwn, inboundId: 902, token: noSafeToken, xuiSubId: `private-${noSafeOwn}`, origin: 'panel' });
      addSplitClient(noSafeFixed, `private-${noSafeFixed}`, [901]);
      addSplitClient(noSafeOwn, `private-${noSafeOwn}`, [902]);
      mockXui.refuseAttach.add(noSafeOwn);
      const refusedRun = await request('POST', `/api/admin/users/${fixedShopId}/consolidate`, {
        cookies, csrf, body: { dryRun: false },
      });
      const refusedInfo = (refusedRun.json?.data?.details || []).find((item) => item.email === noSafeOwn) || {};
      check('when x-ui refuses the attach the fixed-inbound client is NOT deleted',
        Number(refusedRun.json?.data?.merged) === 0
        && mockXui.clients.has(noSafeFixed) === true && mockXui.clients.has(noSafeOwn) === true
        && (mockXui.clients.get(noSafeFixed)?.inboundIds || []).map(Number).join(',') === '901'
        && String(splitDb.prepare('SELECT email FROM configs WHERE id = ?').get(noSafeFixedRow).email) === noSafeFixed,
        `merged=${refusedRun.json?.data?.merged} fixed=${mockXui.clients.has(noSafeFixed)} row=${splitDb.prepare('SELECT email FROM configs WHERE id = ?').get(noSafeFixedRow)?.email} info=${JSON.stringify(refusedInfo)}`);
      const refusedErrs = refusedRun.json?.data?.errors || [];
      check('a refused attach is reported as an error instead of a silent success',
        refusedErrs.length >= 1 && refusedErrs.some((message) => /attach/i.test(String(message))),
        `errors=${JSON.stringify(refusedErrs)}`);
      mockXui.refuseAttach.delete(noSafeOwn);
      // Now that the node accepts it, the same package merges and the copy is gone.
      const fixedRun = await request('POST', `/api/admin/users/${fixedShopId}/consolidate`, {
        cookies, csrf, body: { dryRun: false },
      });
      const fixedClient = mockXui.clients.get(noSafeOwn) || {};
      check('once the attach works the same package merges and loses its fixed-inbound copy',
        Number(fixedRun.json?.data?.merged) === 1 && mockXui.clients.has(noSafeFixed) === false
        && (fixedClient.inboundIds || []).map(Number).sort((a, b) => a - b).join(',') === '901,902'
        && String(fixedClient.subId) === `private-${noSafeOwn}`,
        `merged=${fixedRun.json?.data?.merged} fixed=${mockXui.clients.has(noSafeFixed)} attached=${(fixedClient.inboundIds || []).join(',')}`);
      const noSafeLinks = await request('GET', `/api/admin/configs/${noSafeFixedRow}/links`, { cookies });
      check('and the customer of that package is handed the node address',
        noSafeLinks.json?.data?.subscriptions?.source === 'node'
        && String(noSafeLinks.json?.data?.subUrl || '').startsWith('https://sub.example.com/sub/'),
        `source=${noSafeLinks.json?.data?.subscriptions?.source} subUrl=${noSafeLinks.json?.data?.subUrl}`);

      // A node that does not take the whole channel list on clients/add must be
      // caught by the re-read the panel does right after it: the leftovers go in
      // through bulkAttach and the customer still gets ONE client. Writing a row
      // per channel — or a client per channel — is the defect the owner reported
      // on the live panel, so the count of clients is part of the assertion.
      await request('POST', `/api/admin/users/${fixedShopId}/balance`, {
        cookies, csrf, body: { amount: 90000, description: 'شارژ تست نود لجوج' },
      });
      const stubbornCallsBefore = mockXui.calls.length;
      const clientsBeforeStubborn = mockXui.clients.size;
      mockXui.quirks.addKeepsOnlyFirst = true;
      const stubbornBuy = await request('POST', '/api/reseller/configs', {
        cookies: fixedCookies, csrf: fixedCsrf,
        body: { inboundIds: [903], gb: 4, days: 15, customerName: 'مشتری نود لجوج' },
      });
      mockXui.quirks.addKeepsOnlyFirst = false;
      const stubbornConfigs = stubbornBuy.json?.data?.configs || [];
      stubbornEmail = String(stubbornConfigs[0]?.email || '');
      const stubbornClient = mockXui.clients.get(stubbornEmail) || {};
      const stubbornCalls = mockXui.calls.slice(stubbornCallsBefore);
      for (const item of stubbornConfigs) splitRowIds.push(Number(item.id));
      check('a node that took only the first channel on add is repaired through bulkAttach',
        stubbornBuy.status === 201 && stubbornConfigs.length === 2
        && (stubbornClient.inboundIds || []).map(Number).sort((a, b) => a - b).join(',') === '901,903'
        && stubbornCalls.filter((call) => call.route === '/clients/add').length === 1
        && stubbornCalls.some((call) => call.route === '/clients/bulkAttach'),
        `status=${stubbornBuy.status} rows=${stubbornConfigs.length} attached=${(stubbornClient.inboundIds || []).join(',')} add=${stubbornCalls.filter((call) => call.route === '/clients/add').length} bulk=${stubbornCalls.filter((call) => call.route === '/clients/bulkAttach').length} err=${stubbornBuy.json?.error?.message || ''}`);
      check('and even a stubborn node ends with ONE client for the package',
        new Set(stubbornConfigs.map((item) => item.email)).size === 1
        && mockXui.clients.size === clientsBeforeStubborn + 1,
        `emails=${new Set(stubbornConfigs.map((item) => item.email)).size} addedClients=${mockXui.clients.size - clientsBeforeStubborn}`);
    } finally {
      for (const id of splitRowIds) splitDb.prepare('DELETE FROM configs WHERE id = ?').run(id);
      for (const email of [ownEmail, fixedEmail, extEmailA, extEmailB, noSafeOwn, noSafeFixed, stubbornEmail]) {
        if (email) mockXui.clients.delete(email);
      }
      splitDb.close();
    }

    // ------------------------------------------- v1.4.21: the owner's tie-break
    // The rule the owner stated: a customer holds ONE subscription per x-ui panel
    // and every channel of his sits on it. The client this panel minted for the
    // reseller's fixed inbound carries that single channel and nothing else — it
    // is a copy of the customer's own subscription, not a second account of his,
    // so it is the one that goes. With one row on each side the old order (the
    // older client wins) kept exactly the wrong one and deleted the customer's
    // live link — the live defect the owner showed with his own customer.
    const tieToken = `tie${crypto.randomBytes(8).toString('hex')}`;
    const tieOwnEmail = `tie-own-${crypto.randomBytes(6).toString('hex')}`;
    const tieFixedEmail = `tie-fixed-${crypto.randomBytes(6).toString('hex')}`;
    const tieDb = new Database(path.join(DATA_DIR, 'panel.db'));
    const tieRowIds = [];
    const addTieRow = ({ email, inboundId, token, xuiSubId, origin, uuid }) => {
      const info = tieDb.prepare(`INSERT INTO configs
        (user_id, server_id, inbound_id, email, sub_id, xui_sub_id, uuid, label, customer_name,
         total_bytes, expiry_at, enabled, status, origin, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'بسته تساوی', 'مشتری تساوی', ?, ?, 1, 'active', ?, ?, ?)`)
        .run(fixedShopId, primaryId, inboundId, email, token, xuiSubId, uuid || crypto.randomUUID(),
          10 * MERGE_GB, Date.now() + 30 * 86400000, origin, Date.now(), Date.now());
      const id = Number(info.lastInsertRowid);
      tieRowIds.push(id);
      return id;
    };
    try {
      // The fixed-inbound client is written FIRST, so it also carries the older
      // row id — the exact shape of the live defect: one row on each side.
      const tieFixedRow = addTieRow({ email: tieFixedEmail, inboundId: 901, token: tieToken, xuiSubId: `private-${tieFixedEmail}`, origin: 'panel' });
      addTieRow({ email: tieOwnEmail, inboundId: 902, token: tieToken, xuiSubId: tieToken, origin: 'panel' });
      const tieClient = (email, subId, inboundIds) => ({
        email, id: crypto.randomUUID(), subId, security: 'auto',
        totalGB: 10 * MERGE_GB, expiryTime: Date.now() + 30 * 86400000, enable: true,
        up: 0, down: 0, inboundIds,
      });
      mockXui.clients.set(tieFixedEmail, tieClient(tieFixedEmail, `private-${tieFixedEmail}`, [901]));
      mockXui.clients.set(tieOwnEmail, tieClient(tieOwnEmail, tieToken, [902]));

      const tieRun = await request('POST', `/api/admin/users/${fixedShopId}/consolidate`, {
        cookies, csrf, body: { dryRun: false },
      });
      const tieOwnClient = mockXui.clients.get(tieOwnEmail) || {};
      const tieFixedRowAfter = tieDb.prepare('SELECT * FROM configs WHERE id = ?').get(tieFixedRow);
      check('the client that holds only the fixed inbound is the one that goes',
        Number(tieRun.json?.data?.merged) === 1
        && mockXui.clients.has(tieFixedEmail) === false
        && mockXui.clients.has(tieOwnEmail) === true
        && (tieOwnClient.inboundIds || []).map(Number).sort((a, b) => a - b).join(',') === '901,902'
        && String(tieFixedRowAfter?.email || '') === tieOwnEmail
        && String(tieFixedRowAfter?.sub_id || '') === tieToken,
        `merged=${tieRun.json?.data?.merged} fixed=${mockXui.clients.has(tieFixedEmail)} own=${mockXui.clients.has(tieOwnEmail)} attached=${(tieOwnClient.inboundIds || []).join(',')} row=${tieFixedRowAfter?.email}/${tieFixedRowAfter?.sub_id}`);
      const tieLinks = await request('GET', `/api/admin/configs/${tieFixedRow}/links`, { cookies });
      check('and the customer of that package keeps one node link that carries every channel',
        Number(tieLinks.json?.data?.subscriptions?.clientCount) === 1
        && Number(tieLinks.json?.data?.subscriptions?.node?.[0]?.inboundCount) === 2
        && String(tieLinks.json?.data?.subUrl || '') === `https://sub.example.com/sub/${tieToken}`,
        `clients=${tieLinks.json?.data?.subscriptions?.clientCount} inbounds=${tieLinks.json?.data?.subscriptions?.node?.[0]?.inboundCount} subUrl=${tieLinks.json?.data?.subUrl}`);
    } finally {
      for (const id of tieRowIds) tieDb.prepare('DELETE FROM configs WHERE id = ?').run(id);
      mockXui.clients.delete(tieFixedEmail);
      mockXui.clients.delete(tieOwnEmail);
      tieDb.close();
    }

    // ------------------------------------- v1.4.21: bringing a deleted client back
    // A customer whose x-ui client was deleted on the node panel has nothing left:
    // every link errors out and the package cannot even take a new channel. The
    // panel builds ONE client back — the same email, UUID and subscription id,
    // with EVERY channel of the package on it, the reseller's fixed inbound
    // included — so the customer's old link works again.
    const goneToken = `gone${crypto.randomBytes(8).toString('hex')}`;
    const goneEmail = `gone-client-${crypto.randomBytes(6).toString('hex')}`;
    const goneUuid = crypto.randomUUID();
    const bulkEmail = `bulk-client-${crypto.randomBytes(6).toString('hex')}`;
    const offEmail = `off-client-${crypto.randomBytes(6).toString('hex')}`;
    const goneDb = new Database(path.join(DATA_DIR, 'panel.db'));
    const goneRowIds = [];
    const addGoneRow = ({ email, inboundId, token, uuid, enabled }) => {
      const info = goneDb.prepare(`INSERT INTO configs
        (user_id, server_id, inbound_id, email, sub_id, xui_sub_id, uuid, label, customer_name,
         total_bytes, expiry_at, enabled, status, origin, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'بسته بی‌کلاینت', 'مشتری بی‌کلاینت', ?, ?, ?, 'active', 'panel', ?, ?)`)
        .run(fixedShopId, primaryId, inboundId, email, token, token, uuid,
          10 * MERGE_GB, Date.now() + 30 * 86400000, enabled === false ? 0 : 1, Date.now(), Date.now());
      const id = Number(info.lastInsertRowid);
      goneRowIds.push(id);
      return id;
    };
    try {
      // A package of two channels whose client was deleted on the node: the
      // fixed inbound (901) is one of them, so the rebuild has to carry it.
      const goneRow = addGoneRow({ email: goneEmail, inboundId: 902, token: goneToken, uuid: goneUuid });
      addGoneRow({ email: goneEmail, inboundId: 901, token: goneToken, uuid: goneUuid });
      const goneDetail = await request('GET', `/api/admin/configs/${goneRow}`, { cookies });
      check('a customer whose client is gone from the node is reported as such',
        goneDetail.status === 200 && goneDetail.json?.data?.client === null,
        `status=${goneDetail.status} client=${JSON.stringify(goneDetail.json?.data?.client)}`);

      const goneDry = await request('POST', `/api/admin/users/${fixedShopId}/recreate-missing`, {
        cookies, csrf, body: { dryRun: true },
      });
      check('the dry run lists the packages without a client and writes nothing',
        goneDry.status === 200 && Number(goneDry.json?.data?.missing) === 1
        && mockXui.clients.has(goneEmail) === false
        && (goneDry.json?.data?.details || []).some((item) => item.email === goneEmail),
        `status=${goneDry.status} missing=${goneDry.json?.data?.missing} details=${JSON.stringify(goneDry.json?.data?.details || [])}`);

      const goneRun = await request('POST', `/api/admin/configs/${goneRow}/recreate`, { cookies, csrf });
      const goneClient = mockXui.clients.get(goneEmail) || {};
      check('one client is built back with the same identity and every channel of the package',
        goneRun.status === 200 && mockXui.clients.has(goneEmail) === true
        && (goneClient.inboundIds || []).map(Number).sort((a, b) => a - b).join(',') === '901,902'
        && String(goneClient.subId) === goneToken
        && String(goneRun.json?.data?.email || '') === goneEmail,
        `status=${goneRun.status} attached=${(goneClient.inboundIds || []).join(',')} subId=${goneClient.subId}`);
      const goneRowAfter = goneDb.prepare('SELECT * FROM configs WHERE id = ?').get(goneRow);
      check('the panel rows point at that one client again',
        String(goneRowAfter?.email || '') === goneEmail
        && String(goneRowAfter?.sub_id || '') === goneToken
        && String(goneRowAfter?.uuid || '') === goneUuid,
        `email=${goneRowAfter?.email} token=${goneRowAfter?.sub_id} uuid=${goneRowAfter?.uuid}`);
      const goneLinks = await request('GET', `/api/admin/configs/${goneRow}/links`, { cookies });
      check('the customer is handed his node link again',
        goneLinks.json?.data?.subscriptions?.source === 'node'
        && String(goneLinks.json?.data?.subUrl || '') === `https://sub.example.com/sub/${goneToken}`
        && Number(goneLinks.json?.data?.subscriptions?.node?.[0]?.inboundCount) === 2,
        `source=${goneLinks.json?.data?.subscriptions?.source} subUrl=${goneLinks.json?.data?.subUrl}`);

      // A client that is still on the node must never be rebuilt over: it would
      // take over his traffic and his channels.
      const goneTwice = await request('POST', `/api/admin/configs/${goneRow}/recreate`, { cookies, csrf });
      check('a second rebuild is refused while the client is on the node',
        goneTwice.status === 409 && goneTwice.json?.error?.code === 'xui_client_exists'
        && (mockXui.clients.get(goneEmail)?.inboundIds || []).map(Number).sort((a, b) => a - b).join(',') === '901,902',
        `status=${goneTwice.status} code=${goneTwice.json?.error?.code}`);

      // The bulk pass: one package is restored, a package the reseller switched
      // off is left alone for the operator to decide.
      addGoneRow({ email: bulkEmail, inboundId: 903, token: `bulk${crypto.randomBytes(8).toString('hex')}`, uuid: crypto.randomUUID() });
      addGoneRow({ email: offEmail, inboundId: 904, token: `off${crypto.randomBytes(8).toString('hex')}`, uuid: crypto.randomUUID(), enabled: false });
      const bulkRun = await request('POST', `/api/admin/users/${fixedShopId}/recreate-missing`, {
        cookies, csrf, body: { dryRun: false },
      });
      check('the bulk pass restores the missing packages and leaves the switched-off one alone',
        bulkRun.status === 200 && Number(bulkRun.json?.data?.restored) === 1
        && Number(bulkRun.json?.data?.skipped) === 1
        && mockXui.clients.has(bulkEmail) === true
        && mockXui.clients.has(offEmail) === false,
        `restored=${bulkRun.json?.data?.restored} skipped=${bulkRun.json?.data?.skipped} bulk=${mockXui.clients.has(bulkEmail)} off=${mockXui.clients.has(offEmail)}`);
    } finally {
      for (const id of goneRowIds) goneDb.prepare('DELETE FROM configs WHERE id = ?').run(id);
      for (const email of [goneEmail, bulkEmail, offEmail]) mockXui.clients.delete(email);
      goneDb.close();
    }

    // ------------------------- v1.4.27: the daily traffic of the reseller home
    // The reseller's report was real and the cause is in the accrual: x-ui only
    // gives a CUMULATIVE counter, so whatever the panel could not read — because
    // it was restarting, because a sync crossed midnight, or because the rows of
    // that reseller were hidden for a few days — landed as one delta on the day it
    // woke up. His dashboard then showed a day three times the truth next to
    // empty days. The fix books a delta over the window it actually covers.
    process.env.DATA_DIR = DATA_DIR;
    process.env.BACKUP_DIR = path.join(DATA_DIR, 'backups');
    // eslint-disable-next-line global-require
    const { daySlices, spreadAcrossDays, zonedDayStartMs, zonedDayEndMs } = require('../src/utils');
    const TZ27 = 'Asia/Tehran';
    const U27 = 1024 ** 3;
    const DAY27 = 86400000;

    // (1) the day arithmetic itself, on fixed instants so it cannot drift with
    // the wall clock: Tehran is UTC+3:30 and has no DST, so its midnights land
    // on 20:30 UTC.
    const noon27 = Date.UTC(2026, 10, 2, 8, 0, 0); // 2026-11-02 11:30 Tehran
    check(
      'v1.4.27 a zoned day starts at 00:00 of its own calendar day in the panel timezone',
      zonedDayStartMs(noon27, TZ27) === Date.UTC(2026, 10, 1, 20, 30, 0)
        && zonedDayEndMs(noon27, TZ27) === Date.UTC(2026, 10, 2, 20, 30, 0),
      `start=${new Date(zonedDayStartMs(noon27, TZ27)).toISOString()} end=${new Date(zonedDayEndMs(noon27, TZ27)).toISOString()}`
    );
    const gapFrom27 = Date.UTC(2026, 10, 1, 18, 0, 0); // 21:30 Tehran on 11-01
    const gapTo27 = Date.UTC(2026, 10, 2, 6, 0, 0); // 09:30 Tehran on 11-02 — 2h30 + 9h30
    const slices27 = daySlices(gapFrom27, gapTo27, TZ27);
    check(
      'a window that crosses midnight is split at the zoned midnight, not at 00:00 UTC',
      slices27.map((slice) => slice.day).join(',') === '2026-11-01,2026-11-02'
        && slices27.map((slice) => slice.ms).join(',') === String(2.5 * 3600 * 1000) + ',' + String(9.5 * 3600 * 1000)
        && slices27[0].from === gapFrom27 && slices27[1].to === gapTo27,
      `slices=${JSON.stringify(slices27)}`
    );
    const spread27 = spreadAcrossDays(gapFrom27, gapTo27, 43200000, 43200000, TZ27);
    check(
      'and the bytes follow the time they had: 2.5h of a 12h window is a fifth of the traffic',
      spread27.length === 2
        && spread27[0].day === '2026-11-01' && spread27[0].up === 9000000 && spread27[0].down === 9000000
        && spread27[1].day === '2026-11-02' && spread27[1].up === 34200000 && spread27[1].down === 34200000,
      `spread=${JSON.stringify(spread27)}`
    );
    const threeDay = spreadAcrossDays(Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 4), 259200, 7, TZ27);
    check(
      'a three-day window writes four day rows and never loses or invents a byte',
      threeDay.map((row) => row.day).join(',') === '2026-11-01,2026-11-02,2026-11-03,2026-11-04'
        && threeDay.reduce((sum, row) => sum + row.up, 0) === 259200
        && threeDay.reduce((sum, row) => sum + row.down, 0) === 7
        && threeDay[0].up === 73800 && threeDay[1].up === 86400 && threeDay[3].up === 12600,
      `rows=${JSON.stringify(threeDay)}`
    );
    check(
      'a window inside one day still books exactly one day, and nothing is booked for no traffic',
      spreadAcrossDays(gapTo27, gapTo27 + 60000, 1000, 1000, TZ27).length === 1
        && spreadAcrossDays(gapFrom27, gapTo27, 0, 0, TZ27).length === 0
        && spreadAcrossDays(gapTo27, gapFrom27, 1000, 1000, TZ27).length === 0,
      `sameDay=${spreadAcrossDays(gapTo27, gapTo27 + 60000, 1000, 1000, TZ27).length}`
    );

    // (2) the accrual itself, through the two paths that write it: the monitor
    // sync and the manual per-package refresh. The timer is parked first, or an
    // automatic cycle would reset the window between the rewind and the sync.
    const dayKeyLocal = (ts) => new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ27, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ts));
    const usageDb27 = new Database(path.join(DATA_DIR, 'panel.db'));
    const usageRows27 = (id) => usageDb27
      .prepare('SELECT day, up_bytes, down_bytes FROM usage_daily WHERE config_id = ? ORDER BY day')
      .all(id);
    const sumRows27 = (rows, column) => rows.reduce((sum, row) => sum + Number(row[column] || 0), 0);
    const recentDays27 = [];
    for (let back = 0; back < 10; back += 1) recentDays27.push(dayKeyLocal(Date.now() - back * DAY27));
    let id27 = 0;
    let email27 = '';
    let intervalParked = false;
    try {
      const park = await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 3600 } });
      intervalParked = park.status === 200;
      check('the accrual test parks the monitor timer so a rewound window stays rewound',
        intervalParked, `status=${park.status}`);

      const build27 = await request('POST', '/api/admin/configs', {
        cookies, csrf,
        body: { userId: shopId, inboundIds: [901], gb: 30, days: 30, customerName: 'مشتری آمار روزانه' },
      });
      const cfg27 = (build27.json?.data?.configs || [])[0] || {};
      id27 = Number(cfg27.id || 0);
      email27 = String(cfg27.email || '');
      const client27 = mockXui.clients.get(email27);
      check('the accrual fixture is one package with one node client',
        build27.status === 201 && id27 > 0 && Boolean(client27),
        `status=${build27.status} id=${id27} email=${email27}`);

      // Baseline: the panel has read this client once, so every later delta is known.
      client27.up = 0;
      client27.down = 0;
      await request('POST', '/api/admin/sync', { cookies, csrf });
      usageDb27.prepare('DELETE FROM usage_daily WHERE config_id = ?').run(id27);
      const today27 = dayKeyLocal(Date.now());
      const nodeTotal = { up: 0, down: 0 };
      const moveTo = (upGb, downGb) => {
        const delta = { up: (upGb - nodeTotal.up) * U27, down: (downGb - nodeTotal.down) * U27 };
        nodeTotal.up = upGb;
        nodeTotal.down = downGb;
        client27.up = upGb * U27;
        client27.down = downGb * U27;
        return delta;
      };

      // ---- a two-day hole closed by the monitor sync: 0 → 4GB up / 2GB down
      const rewindA = Date.now() - 2 * DAY27;
      usageDb27.prepare('UPDATE configs SET last_synced_at = ? WHERE id = ?').run(rewindA, id27);
      const deltaA = moveTo(4, 2);
      const gapSync27 = await request('POST', '/api/admin/sync', { cookies, csrf });
      const gapRows27 = usageRows27(id27);
      const gapDays27 = gapRows27.map((row) => row.day);
      const todayUpA = sumRows27(gapRows27.filter((row) => row.day === today27), 'up_bytes');
      check('a two-day traffic gap is booked on the days it happened, with every byte kept',
        gapSync27.status === 200 && gapDays27.length >= 2
          && new Set(gapDays27).size === gapDays27.length
          && gapDays27.every((day) => recentDays27.includes(day))
          && sumRows27(gapRows27, 'up_bytes') === deltaA.up
          && sumRows27(gapRows27, 'down_bytes') === deltaA.down,
        `rows=${JSON.stringify(gapRows27.map((row) => `${row.day}:${row.up_bytes / U27}GB/${row.down_bytes / U27}GB`))}`);
      check('and the day the panel woke up no longer swallows the whole gap',
        todayUpA > 0 && todayUpA < deltaA.up,
        `today=${(todayUpA / U27).toFixed(2)}GB of ${(deltaA.up / U27).toFixed(0)}GB`);

      // ---- the same hole closed by the refresh button: 4/2 → 7/5 GB
      usageDb27.prepare('DELETE FROM usage_daily WHERE config_id = ?').run(id27);
      usageDb27.prepare('UPDATE configs SET last_synced_at = ? WHERE id = ?')
        .run(Date.now() - 2 * DAY27, id27);
      const deltaB = moveTo(7, 5);
      const doRefresh27 = await request('POST', `/api/reseller/configs/${id27}/refresh`, {
        cookies: shopCookies, csrf: shopCsrf,
      });
      const refreshRows27 = usageRows27(id27);
      const refreshTodayB = sumRows27(refreshRows27.filter((row) => row.day === today27), 'up_bytes');
      check('the manual refresh of a package spreads its gap the same way',
        doRefresh27.status === 200 && refreshRows27.length >= 2
          && refreshRows27.every((row) => recentDays27.includes(row.day))
          && sumRows27(refreshRows27, 'up_bytes') === deltaB.up
          && sumRows27(refreshRows27, 'down_bytes') === deltaB.down,
        `status=${doRefresh27.status} rows=${JSON.stringify(refreshRows27.map((row) => `${row.day}:${row.up_bytes / U27}GB/${row.down_bytes / U27}GB`))}`);
      check('so a refresh after a quiet weekend cannot fake a busy today',
        refreshTodayB > 0 && refreshTodayB < deltaB.up,
        `today=${(refreshTodayB / U27).toFixed(2)}GB of ${(deltaB.up / U27).toFixed(0)}GB`);

      // ---- an ordinary gap of a few seconds must still land on one day
      usageDb27.prepare('DELETE FROM usage_daily WHERE config_id = ?').run(id27);
      const deltaC = moveTo(8, 6);
      await request('POST', '/api/admin/sync', { cookies, csrf });
      const normalRows27 = usageRows27(id27);
      check('a normal sync books everything on today, exactly as before',
        normalRows27.length === 1 && normalRows27[0].day === today27
          && Number(normalRows27[0].up_bytes) === deltaC.up
          && Number(normalRows27[0].down_bytes) === deltaC.down,
        `rows=${JSON.stringify(normalRows27.map((row) => `${row.day}:${row.up_bytes}`))}`);

      // ---- the cap: an ancient window must not write a row per day of silence
      usageDb27.prepare('DELETE FROM usage_daily WHERE config_id = ?').run(id27);
      usageDb27.prepare('UPDATE configs SET last_synced_at = ? WHERE id = ?')
        .run(Date.now() - 40 * DAY27, id27);
      const deltaD = moveTo(12, 8);
      await request('POST', '/api/admin/sync', { cookies, csrf });
      const cappedRows27 = usageRows27(id27);
      const oldestAllowed27 = dayKeyLocal(Date.now() - 7 * DAY27);
      check('a month of silence is capped at a week of day rows and still books every byte',
        cappedRows27.length >= 2 && cappedRows27.length <= 8
          && cappedRows27.every((row) => row.day >= oldestAllowed27)
          && sumRows27(cappedRows27, 'up_bytes') === deltaD.up
          && sumRows27(cappedRows27, 'down_bytes') === deltaD.down,
        `rows=${cappedRows27.length} oldest=${cappedRows27[0]?.day} sumUp=${sumRows27(cappedRows27, 'up_bytes') / U27}GB`);

      // ---- what the reseller actually sees on his home page
      usageDb27.prepare('DELETE FROM usage_daily WHERE user_id = ?').run(shopId);
      usageDb27.prepare('UPDATE configs SET last_synced_at = ? WHERE id = ?')
        .run(Date.now() - 2 * DAY27, id27);
      const deltaE = moveTo(16, 10);
      await request('POST', '/api/admin/sync', { cookies, csrf });
      const ledger27 = usageDb27.prepare(
        'SELECT day, up_bytes + down_bytes AS total FROM usage_daily WHERE user_id = ?'
      ).all(shopId);
      const ledgerToday27 = ledger27.filter((row) => row.day === today27).reduce((sum, row) => sum + Number(row.total), 0);
      const ledgerAll27 = ledger27.reduce((sum, row) => sum + Number(row.total), 0);
      const overview27 = await request('GET', '/api/reseller/overview', { cookies: shopCookies });
      const seenToday27 = Number(overview27.json?.data?.today?.total || 0);
      const seenMonth27 = Number(overview27.json?.data?.month?.total || 0);
      check('the home page of the reseller reads exactly what the day ledger holds',
        overview27.status === 200 && seenToday27 === ledgerToday27 && seenMonth27 === ledgerAll27
          && ledgerAll27 >= deltaE.up + deltaE.down,
        `today=${seenToday27} ledgerToday=${ledgerToday27} month=${seenMonth27} ledgerAll=${ledgerAll27}`);
      check('and today is a share of the gap, not the whole two days of it',
        ledgerToday27 > 0 && ledgerToday27 < deltaE.up + deltaE.down
          && ledger27.length >= 2,
        `days=${ledger27.length} today=${(ledgerToday27 / U27).toFixed(2)}GB of ${((deltaE.up + deltaE.down) / U27).toFixed(0)}GB`);
    } finally {
      if (id27) {
        for (const row of usageDb27.prepare('SELECT id FROM configs WHERE email = ?').all(email27)) {
          usageDb27.prepare('DELETE FROM usage_daily WHERE config_id = ?').run(Number(row.id));
        }
        usageDb27.prepare('DELETE FROM configs WHERE id = ?').run(id27);
      }
      usageDb27.close();
      if (email27) mockXui.clients.delete(email27);
      if (intervalParked) await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 120 } });
    }

    // --------------------------- v1.4.27: the nightly telegram report
    // The owner asked for one message per reseller per day, built from the rows
    // the panel already keeps: what he bought today and what is left in his
    // wallet, what ended today, what is about to end. Nothing below talks to
    // Telegram — every send is either switched off or already marked as delivered
    // for the day, which is exactly the bookkeeping that makes a restart after the
    // scheduled hour harmless instead of a second message.
    const DAYR = 86400000;
    const GIR = 1024 ** 3;
    const rptDb = new Database(path.join(DATA_DIR, 'panel.db'));
    let rptShopId = 0;
    const rptEmails = [];
    let rptDay = '';
    let rptTimerParked = false;
    try {
      const parkR = await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 3600 } });
      rptTimerParked = parkR.status === 200;
      check('the report test parks the monitor so the fixtures keep the numbers written for them',
        rptTimerParked, `status=${parkR.status}`);

      const buildR = await request('POST', '/api/admin/users', {
        cookies, csrf,
        body: { username: 'rptshop', password: 'password123', role: 'reseller', telegram_id: '777000222', balance: 4321000 },
      });
      rptShopId = Number(buildR.json?.data?.user?.id || 0);
      check('the report reseller is created with his numeric telegram id',
        buildR.status === 201 && rptShopId > 0 && buildR.json?.data?.user?.telegramId === '777000222',
        `status=${buildR.status} id=${rptShopId}`);

      const madeR = [];
      for (const name of ['RPT-active', 'RPT-ended', 'RPT-soon', 'RPT-full']) {
        const one = await request('POST', '/api/admin/configs', {
          cookies, csrf,
          body: { userId: rptShopId, inboundIds: [901], gb: 10, days: 30, customerName: name },
        });
        const cfgOne = (one.json?.data?.configs || [])[0] || {};
        if (Number(cfgOne.id)) {
          madeR.push({ id: Number(cfgOne.id), name, email: String(cfgOne.email || '') });
          if (cfgOne.email) rptEmails.push(cfgOne.email);
        }
      }
      check('four packages of one customer each are ready for the report',
        madeR.length === 4, `made=${JSON.stringify(madeR.map((row) => row.name))}`);

      // The three cases the message is about, written the way the panel would
      // have them at the end of a day: ended this morning, two days left, and one
      // whose shared quota is used up while its expiry is still far away.
      const nowR = Date.now();
      const byName = new Map(madeR.map((row) => [row.name, row.id]));
      rptDb.prepare('UPDATE configs SET expiry_at = ? WHERE id = ?').run(nowR - 3600000, byName.get('RPT-ended'));
      rptDb.prepare('UPDATE configs SET expiry_at = ? WHERE id = ?').run(nowR + 2 * DAYR, byName.get('RPT-soon'));
      rptDb.prepare(
        'UPDATE configs SET total_bytes = ?, up_bytes = ?, down_bytes = 0, expiry_at = ?, updated_at = ? WHERE id = ?'
      ).run(GIR, GIR, nowR + 30 * DAYR, nowR, byName.get('RPT-full'));

      const prevR = await request('GET', `/api/admin/reports/daily/${rptShopId}/preview`, { cookies, csrf });
      const prevBody = prevR.json?.data || {};
      const prevText = String(prevBody.text || '');
      check('the preview is built for that reseller and mentions his id',
        prevR.status === 200 && prevBody.username === 'rptshop' && prevBody.telegramId === '777000222'
          && prevText.includes('گزارش روزانه') && prevText.includes('rptshop'),
        `status=${prevR.status} len=${prevText.length}`);
      check('and it carries the three sections the owner asked for',
        prevText.includes('خرید امروز و موجودی') && prevText.includes('امروز تمام شد')
          && prevText.includes('نزدیک اتمام') && prevText.includes('موجودی کیف پول'),
        `blocks=${prevText.split('\n\n').length}`);
      const statsR = prevBody.stats || {};
      check('the counts come out of the rows themselves, not out of the inbound list',
        statsR.packages === 4 && statsR.created === 4 && statsR.ended === 1
          && statsR.depleted === 1 && statsR.endingSoon === 1 && statsR.balance === 4321000,
        `stats=${JSON.stringify(statsR)}`);
      check('the names of the packages that ended and are about to end are in the message',
        prevText.includes('RPT-ended') && prevText.includes('RPT-soon') && prevText.includes('RPT-full'),
        `hasEnded=${prevText.includes('RPT-ended')} hasSoon=${prevText.includes('RPT-soon')}`);
      check('and the message never grows past what Telegram accepts',
        prevText.length <= 4096, `length=${prevText.length}`);

      const metaR = await request('GET', '/api/admin/reports/daily', { cookies, csrf });
      const metaBody = metaR.json?.data || {};
      rptDay = String(prevBody.day || '');
      check('the report card lists the recipients by their stored telegram id',
        metaR.status === 200 && (metaBody.recipients || []).some((row) => row.userId === rptShopId)
          && Number(metaBody.withoutTelegramId) >= 1 && metaBody.botConfigured === true
          && metaBody.telegramEnabled === true,
        `recipients=${JSON.stringify(metaBody.recipients)} without=${metaBody.withoutTelegramId}`);

      const wildR = await request('PATCH', '/api/admin/settings/telegram', {
        cookies, csrf, body: { dailyReportHour: 71, dailyReportMinute: -5, dailyReportDaysAhead: 999 },
      });
      const wildSaved = wildR.json?.data?.saved || {};
      check('an impossible hour, minute or days-ahead is clamped, not stored',
        wildR.status === 200 && wildSaved.dailyReportHour === 23 && wildSaved.dailyReportMinute === 0
          && wildSaved.dailyReportDaysAhead === 30,
        `saved=${JSON.stringify(wildSaved)}`);

      const offR = await request('PATCH', '/api/admin/settings/telegram', {
        cookies, csrf, body: { dailyReportResellers: false, dailyReportOwner: false },
      });
      check('both delivery switches persist',
        offR.status === 200 && offR.json?.data?.saved?.dailyReportResellers === false
          && offR.json?.data?.saved?.dailyReportOwner === false,
        `status=${offR.status}`);
      const offSend = await request('POST', '/api/admin/reports/daily/send', { cookies, csrf, body: {} });
      const offSummary = offSend.json?.data || {};
      check('with both switches off nothing is attempted and the reason is written down',
        offSend.status === 200 && offSummary.attempted === 0 && offSummary.sent === 0 && offSummary.failed === 0
          && (offSummary.results || []).length >= 1
          && (offSummary.results || []).every((row) => row.sent === false && String(row.reason).includes('خاموش'))
          && offSummary.owner && offSummary.owner.sent === false,
        `summary=${JSON.stringify({ attempted: offSummary.attempted, first: (offSummary.results || [])[0], owner: offSummary.owner })}`);

      // One attempt per recipient per day: the rows below say "already delivered",
      // so the run must skip every one of them rather than send a second message.
      const markSent = rptDb.prepare(
        `INSERT INTO daily_reports (user_id, kind, day, chat_id, ok, error, stats, sent_at)
         VALUES (?, 'reseller', ?, ?, 1, '', '{}', ?)
         ON CONFLICT(user_id, kind, day) DO UPDATE SET ok = 1, sent_at = excluded.sent_at`
      );
      for (const row of metaBody.recipients || []) markSent.run(row.userId, rptDay, row.telegramId, Date.now());
      await request('PATCH', '/api/admin/settings/telegram', { cookies, csrf, body: { dailyReportResellers: true } });
      const skipSend = await request('POST', '/api/admin/reports/daily/send', { cookies, csrf, body: {} });
      const skipSummary = skipSend.json?.data || {};
      check('a second run the same day skips everyone already delivered to, and sends nothing again',
        skipSend.status === 200 && skipSummary.attempted === 0 && skipSummary.sent === 0
          && skipSummary.skipped === (skipSummary.results || []).length
          && skipSummary.skipped >= 1
          && (skipSummary.results || []).every((row) => String(row.reason).includes('امروز ارسال شده بود')),
        `skipped=${skipSummary.skipped} of ${(skipSummary.results || []).length}`);

      const histR = await request('GET', '/api/admin/reports/daily', { cookies, csrf });
      const histRows = histR.json?.data?.history || [];
      check('the delivery history shows the day each report belongs to',
        histRows.length >= 1 && histRows.every((row) => row.day === rptDay)
          && histRows.some((row) => row.ok === true && row.kind === 'reseller'),
        `rows=${histRows.length} day=${rptDay}`);
      const resetR = await request('POST', '/api/admin/reports/daily/reset', { cookies, csrf, body: { day: rptDay } });
      const histAfter = await request('GET', '/api/admin/reports/daily', { cookies, csrf });
      check('the reset clears exactly the day it is given, so a re-run is possible',
        resetR.status === 200 && !(histAfter.json?.data?.history || []).some((row) => row.day === rptDay),
        `left=${(histAfter.json?.data?.history || []).length}`);

      const noIdR = await request('POST', '/api/admin/reports/daily/send', { cookies, csrf, body: { userId: shopId } });
      check('sending to a reseller who never gave a telegram id is refused before anything is built',
        noIdR.status === 422 && noIdR.json?.error?.code === 'telegram_id_required',
        `status=${noIdR.status} code=${noIdR.json?.error?.code}`);
      const ghostR = await request('GET', '/api/admin/reports/daily/987654/preview', { cookies, csrf });
      check('a preview of a reseller who does not exist says so', ghostR.status === 404, `status=${ghostR.status}`);
      const shopReport = await request('GET', '/api/admin/reports/daily', { cookies: shopCookies, csrf: shopCsrf });
      check('a reseller cannot read the fleet report', shopReport.status === 403, `status=${shopReport.status}`);
    } finally {
      if (rptShopId) {
        for (const row of rptDb.prepare('SELECT id FROM configs WHERE user_id = ?').all(rptShopId)) {
          rptDb.prepare('DELETE FROM usage_daily WHERE config_id = ?').run(Number(row.id));
        }
        rptDb.prepare('DELETE FROM usage_daily WHERE user_id = ?').run(rptShopId);
        rptDb.prepare('DELETE FROM daily_reports WHERE user_id = ?').run(rptShopId);
        rptDb.prepare('DELETE FROM configs WHERE user_id = ?').run(rptShopId);
        rptDb.prepare('DELETE FROM users WHERE id = ?').run(rptShopId);
      }
      if (rptDay) rptDb.prepare('DELETE FROM daily_reports WHERE day = ?').run(rptDay);
      rptDb.close();
      for (const email of rptEmails) mockXui.clients.delete(email);
      await request('PATCH', '/api/admin/settings/telegram', {
        cookies, csrf,
        body: {
          dailyReportEnabled: false, dailyReportHour: 23, dailyReportMinute: 0, dailyReportDaysAhead: 3,
          dailyReportResellers: true, dailyReportOwner: true,
        },
      });
      if (rptTimerParked) await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 120 } });
    }

    const v1Bad = await request('GET', '/api/v1/me', { headers: { 'x-api-key': 'sc_invalid' } });
    check('api v1 rejects bad key', v1Bad.status === 401);

    const ownerV1 = await request('GET', '/api/v1/me', { cookies, headers: { 'x-api-key': 'sc_invalid' } });
    check('api v1 ignores session cookies', ownerV1.status === 401);

    const logout = await request('POST', '/api/auth/logout', { cookies, csrf });
    check('logout', logout.status === 200);

    const afterLogout = await request('GET', '/api/auth/me', { cookies });
    check('session invalid after logout', afterLogout.status === 401);

    // --------------------------------------------------------------- shutdown
    child.kill('SIGTERM');
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 10000);
      child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    check('graceful shutdown', exited === 0, `exit=${exited}`);

    const dbFile = path.join(DATA_DIR, 'panel.db');
    check('database created in data dir', fs.existsSync(dbFile) && fs.statSync(dbFile).size > 0);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL unexpected error — ${err.message}`);
    if (serverLog) console.log(`\n--- server log ---\n${serverLog.slice(-2000)}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (mockXui) {
      try { mockXui.server.close(); } catch (_) { /* ignore */ }
    }
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    if (serverLog) console.log(`\n--- server log tail ---\n${serverLog.slice(-3000)}`);
    process.exit(1);
  }
  process.exit(0);
})();

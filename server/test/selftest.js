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
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = decodeURIComponent(url.pathname.replace(/^\/panel\/api/, ''));
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }
      const send = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, msg: '', obj }));
      };
      const emailOf = (suffix) => route.slice(route.indexOf(suffix) + suffix.length);
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
          return send(client ? { client, inboundIds: client.inboundIds || [] } : null);
        }
        if (route === '/clients/add') {
          const incoming = body.client || {};
          clients.set(String(incoming.email), { ...incoming, id: incoming.id, inboundIds: (body.inboundIds || []).map(Number) });
          return send(null);
        }
        if (route.startsWith('/clients/update/')) {
          const email = emailOf('/clients/update/');
          const current = clients.get(email);
          if (!current) return send(null);
          const next = { ...current, ...body, email };
          const inboundIds = url.searchParams.get('inboundIds');
          if (inboundIds) next.inboundIds = inboundIds.split(',').map(Number);
          clients.set(email, next);
          return send(null);
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
        if (route.startsWith('/clients/links/')) return send([]);
        if (route.startsWith('/clients/resetTraffic/')) return send(true);
        return send(null);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, msg: err.message, obj: null }));
        return undefined;
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, clients }));
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
      body: { username: SHOP, password: SHOP_PASS, name: 'فروشگاه تست', role: 'reseller', max_configs: 5 },
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

    const backupListAfter = await request('GET', '/api/admin/backups', { cookies });
    check('backup reports telegram delivery state', backupListAfter.status === 200 && backupListAfter.json.data.telegram.configured === true);

    const restoreGuard = await request('POST', '/api/admin/backups/restore', { cookies, csrf, body: {} });
    check('restore requires confirmation', restoreGuard.status === 422 || restoreGuard.status === 400);

    const backupDelete = await request('DELETE', `/api/admin/backups/${backupName}`, { cookies, csrf });
    check('delete backup', backupDelete.status === 200);

    // ------------------------------------------------------------------ audit
    const audit = await request('GET', '/api/admin/audit?action=setup.complete', { cookies });
    check('audit records setup', audit.status === 200 && audit.json.data.total >= 1);

    // --------------------------------------------------------------- inbounds
    // Subscription order (x-ui subSortIndex) drives the admin list order.
    const Database = require('better-sqlite3');
    const panelDb = new Database(path.join(DATA_DIR, 'panel.db'));
    try {
      const insertInbound = panelDb.prepare(
        `INSERT INTO inbounds (id, server_id, xui_id, node_id, node_name, remark, protocol, tag, port, network,
           security, listen, price_fixed, price_per_gb, price_per_day, enabled, visible, sub_sort_index, updated_at)
         VALUES (?, 1, ?, 0, 'local', ?, 'vless', ?, 1000, 'tcp', 'none', '', ?, ?, ?, 1, 1, ?, ?)`
      );
      const now = Date.now();
      insertInbound.run(901, 901, 'Order 30', 'tag30', 100, 10, 0, 30, now);
      insertInbound.run(902, 902, 'Order 10', 'tag10', 0, 50, 0, 10, now);
      insertInbound.run(903, 903, 'Order 20', 'tag20', 300, 0, 5, 20, now);
      insertInbound.run(904, 904, 'Order 10b', 'tag10b', 0, 0, 0, 10, now);
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
    const serverReseller = await request('GET', '/api/admin/servers', { cookies: shopCookies });
    check('resellers cannot list servers', serverReseller.status === 403);
    const serverDelete = await request('DELETE', `/api/admin/servers/${newServerId}`, { cookies, csrf });
    check('admin can delete an unused server', serverDelete.status === 200);

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

    const renew = await request('POST', `/api/reseller/configs/${bought.id}/extend`, {
      cookies: shopCookies, csrf: shopCsrf, body: { gb: 5, days: 5 },
    });
    const afterRenew = await request('GET', '/api/auth/me', { cookies: shopCookies });
    check(
      'renewal deducts the wallet at the inbound tariff',
      renew.status === 200 && Number(afterRenew.json?.data?.user?.balance) === 99650,
      `balance=${afterRenew.json?.data?.user?.balance}`
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


    // ------------------------------------------------------------------- misc
    const licenseState = await request('GET', '/api/license');
    check(
      'license status is public and reports the installation id',
      licenseState.status === 200
        && /^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/.test(licenseState.json?.data?.fingerprint || '')
        && licenseState.json?.data?.enforced === false,
      `fp=${licenseState.json?.data?.fingerprint}`
    );
    const badLicense = await request('POST', '/api/license/activate', {
      cookies, csrf, body: { license: JSON.stringify({ id: 'SC-FAKE', fingerprint: 'X', sig: 'bm90LWEtc2ln' }) },
    });
    check('a forged activation key is rejected', badLicense.status === 422, `status=${badLicense.status}`);

    const key = await request('POST', '/api/auth/api-key', { cookies: shopCookies, csrf: shopCsrf, body: {} });
    const apiKey = key.json?.data?.apiKey || '';
    check('reseller api key issued', key.status === 200 && apiKey.startsWith('sc_'));

    const v1me = await request('GET', '/api/v1/me', { headers: { 'x-api-key': apiKey } });
    check('api v1 authenticates with key', v1me.status === 200 && v1me.json.data.user.username === SHOP);

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

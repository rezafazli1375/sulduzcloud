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
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
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

/**
 * The same request against an explicit port, for the v2.1.0 listener tests.
 *
 * Two differences from `request()` on purpose. `agent: false` — Node 19+ keeps
 * connections alive per host, so after the panel moves to another port a request
 * through a pooled agent could still be answered by the socket it had to the OLD
 * port, which is exactly the thing these checks must not fake. And a refused
 * connection resolves instead of rejecting: «the port nobody listens on any more
 * answers ECONNREFUSED» is a result this suite asserts, not a crash.
 */
function onPort(port, method, urlPath, { body, cookies, csrf, headers = {}, tls = false } = {}) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const lib = tls ? https : http;
    const opts = {
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      agent: false,
      rejectUnauthorized: false,
      headers: { accept: 'application/json', ...headers },
      timeout: 15000,
    };
    if (payload) {
      opts.headers['content-type'] = 'application/json';
      opts.headers['content-length'] = Buffer.byteLength(payload);
    }
    if (cookies) opts.headers.cookie = cookies;
    if (csrf) opts.headers['x-csrf-token'] = csrf;
    const req = lib.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* non-json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, raw, error: '' });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', (err) => resolve({ status: 0, headers: {}, json: null, raw: '', error: String(err.code || err.message) }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** A port nothing is holding right now, or 0 when the OS would not say. */
function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(0));
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
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
  const quirks = { addKeepsOnlyFirst: false, failGet: new Set(), failDel: new Set() };
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
          const asked = emailOf('/clients/get/');
          // A node that is sick, not empty: the answer is an error that says
          // nothing about the client. "Not there" and "cannot tell" must never be
          // treated the same way by a delete.
          if (quirks.failGet.has(asked)) return failMsg('database is locked');
          const client = clients.get(asked);
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
          // v1.5.2: the real x-ui 3.8.5 answers a delete for a client it does not
          // have with success:false + "Obtain (record not found)". The double used
          // to answer `true`, which is exactly why the panel's "cannot delete a
          // subscription that is not on the node" bug survived every earlier run.
          const email = emailOf('/clients/del/');
          // v2.0.0: a node that refuses the delete itself (locked DB, timeout…)
          // — the cleanup sweep must keep the package when this happens.
          if (quirks.failDel.has(email)) return failMsg('database is locked');
          if (!clients.has(email)) return failMsg('Obtain (record not found)');
          clients.delete(email);
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

    // ═════════════════════════════════════════════════════════════════════ v2.1.0
    // ------------------------------- v2.1.0: the male/female activation gate first
    //
    // «اگر کسی این پنل را نصب کرد و آدرس پنل را تو مرورگر زد، باید ازش رمز و کلید
    // بخواد؛ کلید نر را خودش نشان بدهد و کلید مادگی را بگیرد.» A brand-new install
    // therefore answers NOTHING but /meta, /health and /activation until a female
    // key has been accepted — including the first-run setup form, which is exactly
    // the hole this closes: an installer that created the owner first would have
    // unlocked the panel without ever asking for a key.
    //
    // The accept path itself cannot be driven from here: the repository carries the
    // male ids and one hash per partner, never a female string, and no test may
    // invent one. What is proven below is the lock (every other call, both wrong-key
    // refusals, the recorded attempts) and the release condition (an install that
    // carries an activation record behaves like any other panel). The real key
    // landing in that record is proven out of band, by `activation set <female>` and
    // by the installer interview, against the shipped module.
    {
      const gate0 = await request('GET', '/api/activation');
      check('v2.1.0 the gate endpoint is open on a locked install',
        gate0.status === 200 && gate0.json.data.required === true && gate0.json.data.activated === false,
        `status=${gate0.status}`);
      const maleKey = String(gate0.json?.data?.maleKey || '');
      // Read from the shipped source rather than requiring the module: config.js
      // creates its data directories at require time, and a test parent process has
      // no business making those in the installed tree.
      let maleIds = [];
      try {
        const source = fs.readFileSync(path.join(ROOT, 'src/activation.js'), 'utf8');
        maleIds = [...source.matchAll(/male: '(SCM-[A-Z0-9]{4}-[A-Z0-9]{4})'/g)].map((m) => m[1]);
      } catch (_) { /* the shape check below still runs */ }
      check('v2.1.0 the male key offered is one of the ids the panel ships',
        /^SCM-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(maleKey) && maleIds.length === 5 && maleIds.includes(maleKey),
        `male=${maleKey} shipped=${maleIds.length}`);
      const gate1 = await request('GET', '/api/activation');
      check('v2.1.0 the same install keeps offering the same male key',
        String(gate1.json?.data?.maleKey || '') === maleKey, `${maleKey} vs ${gate1.json?.data?.maleKey}`);
      const gateMeta = await request('GET', '/api/meta');
      check('v2.1.0 the lock screen can still be drawn (/meta stays open)',
        gateMeta.status === 200 && gateMeta.json.data.setupRequired === true, `status=${gateMeta.status}`);
      check('v2.1.0 health stays open while locked', health.status === 200);

      const lockedUnknown = await request('GET', '/api/does-not-exist');
      check('v2.1.0 nothing behind the lock answers, not even a 404',
        lockedUnknown.status === 423 && lockedUnknown.json.error.code === 'activation_required',
        `status=${lockedUnknown.status} code=${lockedUnknown.json?.error?.code}`);
      const lockedAdmin = await request('GET', '/api/admin/users');
      check('v2.1.0 the admin API is behind the same lock',
        lockedAdmin.status === 423 && lockedAdmin.json.error.details.maleKey === maleKey,
        `status=${lockedAdmin.status}`);

      const emptyKey = await request('POST', '/api/activation', { body: { key: '   ' } });
      check('v2.1.0 a blank key is not tried',
        emptyKey.status === 422 && emptyKey.json.error.code === 'key_required', `code=${emptyKey.json?.error?.code}`);
      const wrongKey = await request('POST', '/api/activation', { body: { key: 'SCF-AAAA-BBBB-CCCC-DDDD' } });
      check('v2.1.0 a wrong female key is refused by name',
        wrongKey.status === 403 && wrongKey.json.error.code === 'activation_invalid',
        `status=${wrongKey.status} code=${wrongKey.json?.error?.code}`);
      const wrongAgain = await request('POST', '/api/activation', { body: { key: 'not-a-key-at-all' } });
      check('v2.1.0 and refused again, with no side effect',
        wrongAgain.status === 403, `status=${wrongAgain.status}`);

      const GateDatabase = require('better-sqlite3');
      const gateDb = new GateDatabase(path.join(DATA_DIR, 'panel.db'));
      const gateRow = gateDb.prepare('SELECT male_key, activated_at, attempts, source FROM activation WHERE id = 1').get() || {};
      check('v2.1.0 both wrong tries are counted against the install',
        Number(gateRow.attempts || 0) === 2 && Number(gateRow.activated_at || 0) === 0,
        `attempts=${gateRow.attempts} activated_at=${gateRow.activated_at}`);
      check('v2.1.0 the male key a stranger was shown is the one stored',
        String(gateRow.male_key || '') === maleKey, `db=${gateRow.male_key}`);
      const failedAudits = gateDb.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'activation.failed'").get().c;
      check('v2.1.0 every wrong key leaves an audit line for the owner',
        Number(failedAudits) >= 2, `rows=${failedAudits}`);

      const lockedSetup = await request('POST', '/api/setup', {
        body: { username: OWNER, password: OWNER_PASS, name: 'Self Test' },
      });
      check('v2.1.0 the first-run setup is refused until a key is accepted',
        lockedSetup.status === 423 && lockedSetup.json.error.code === 'activation_required',
        `status=${lockedSetup.status}`);
      const stillAccounts = gateDb.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      check('v2.1.0 and it really did not create the owner', Number(stillAccounts) === 0, `users=${stillAccounts}`);
      gateDb.close();

      // The release condition: this is the row activation.activate() writes when a
      // matching female key arrives (see src/activation.js, same 5 columns).
      const unlockDb = new GateDatabase(path.join(DATA_DIR, 'panel.db'));
      unlockDb.prepare(
        `INSERT INTO activation (id, male_key, fingerprint, activated_at, source) VALUES (1, ?, 'selftest', ?, 'test')
         ON CONFLICT(id) DO UPDATE SET activated_at = excluded.activated_at, source = excluded.source`
      ).run(maleKey, Date.now());
      unlockDb.close();

      const gateAfter = await request('GET', '/api/activation');
      check('v2.1.0 an install carrying an activation record is unlocked',
        gateAfter.status === 200 && gateAfter.json.data.activated === true && gateAfter.json.data.required === false,
        `activated=${gateAfter.json?.data?.activated}`);
      const unknown = await request('GET', '/api/does-not-exist');
      check('unknown api returns json 404', unknown.status === 404 && unknown.json.error.code === 'not_found');
    }

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
      cookies, csrf, body: { panelName: 'Self Test Panel', defaultLang: 'fa', tagline: 'در تست' },
    });
    // v1.5.4, item 4: the brand is pinned in code, so this one PATCH — which still
    // saves everything else it was given — must not be able to rename the panel.
    // The check keeps the shape of the old "patch persists" one on purpose: the
    // fields around the locked name are what prove the lock is a lock and not a
    // broken form.
    const savedGeneral = saved.json?.data?.saved || {};
    check('settings patch persists — only the pinned panel name is immune to it',
      saved.status === 200 && savedGeneral.panelName === require('../src/brand').PANEL_NAME
        && savedGeneral.defaultLang === 'fa' && savedGeneral.tagline === 'در تست',
      `panelName=${savedGeneral.panelName} lang=${savedGeneral.defaultLang} tagline=${savedGeneral.tagline}`);
    const showPinned = await request('GET', '/api/meta');
    check('and the name the login page shows is the pinned one, not what was typed',
      showPinned.json?.data?.panelName === require('../src/brand').PANEL_NAME,
      `public=${showPinned.json?.data?.panelName}`);

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
    //
    // The monitor's own cycle rewrites sub_sort_index from the node (the double
    // answers 1..4 in list order), so the four numbers seeded below only survive if
    // no cycle lands between the write and the read. Since 2.1.0 the listener bind
    // is awaited (src/net.js) and monitor.start() happens right after it, so the
    // boot cycle can now be running while these lines execute. Park the timer, then
    // wait for the startup cycle to be FINISHED — runCycle stamps lastRunAt only
    // after syncInbounds returns — and only then seed.
    const monitorWas31 = Number((await request('GET', '/api/admin/settings', { cookies }))
      .json?.data?.settings?.monitor?.intervalSec || 120);
    const park31 = await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 3600 } });
    let monitorIdle31 = {};
    const waitUntil31 = Date.now() + 30000;
    for (;;) {
      const serversSeen31 = await request('GET', '/api/admin/servers', { cookies });
      monitorIdle31 = serversSeen31.json?.data?.monitor || {};
      const doneStartup31 = Number(monitorIdle31.lastRunAt) > Number(monitorIdle31.startedAt) + 4000;
      if (doneStartup31 && monitorIdle31.busy !== true) break;
      if (Date.now() > waitUntil31) break;
      await sleep(200);
    }
    check('the inbound order fixture waits for the boot cycle the panel runs on its own',
      park31.status === 200 && Number(monitorIdle31.lastRunAt) > Number(monitorIdle31.startedAt) + 4000
        && monitorIdle31.busy !== true,
      `park=${park31.status} lastRun=${monitorIdle31.lastRunAt} started=${monitorIdle31.startedAt} busy=${monitorIdle31.busy}`);
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
    const unpark31 = await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: monitorWas31 } });
    check('the monitor timer is handed back at the interval it was parked from',
      unpark31.status === 200, `was=${monitorWas31} status=${unpark31.status}`);

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
    // v2.4.2 — THE STALE VOLUME BUG. A customer whose package really holds 30 GB on
    // the node was shown as 20 GB and switched off at 20. The background sync
    // copied every field of the x-ui client back to its own rows EXCEPT the
    // volume, so a number changed on the node — in x-ui itself, or by another
    // panel sharing that node — never reached the panel, and the shared-pool
    // cutoff worked from the stale copy. A three-inbound package on one client is
    // the shape the bug was reported on.
    const q242Email = multiConfigs[0].email;
    const q242Ids = multiConfigs.map((config) => Number(config.id));
    const readQ242 = () => {
      const Database = require('better-sqlite3');
      const handle = new Database(path.join(DATA_DIR, 'panel.db'));
      try {
        return handle.prepare(
          `SELECT id, total_bytes, sync_status, enabled FROM configs WHERE id IN (${q242Ids.map(() => '?').join(',')}) ORDER BY id`
        ).all(...q242Ids);
      } finally {
        handle.close();
      }
    };
    const nodeQ242 = () => mockXui.clients.get(q242Email) || {};
    const poolRowQ242 = async () => {
      const list = await request('GET', `/api/reseller/configs?search=${customerSearch}`, { cookies: shopCookies });
      return list.json?.data?.rows?.[0] || {};
    };
    // POST /api/admin/sync is monitor.runCycle('manual'), and runCycle hands back
    // the PREVIOUS result, without doing any work, when a timer cycle is still in
    // flight. Each check below edits the node and then needs the panel to have
    // read that edit, so a call that answered 200 is not enough: the cycle that
    // answered must be a manual one that started after the last one we accepted.
    let q242CycleAt = 0;
    const syncNow = async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const res = await request('POST', '/api/admin/sync', { cookies, csrf });
        const at = Number(res.json?.data?.at || 0);
        if (res.status === 200 && res.json?.data?.reason === 'manual' && at > q242CycleAt) {
          q242CycleAt = at;
          return res;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('the monitor never ran a fresh manual cycle');
    };
    // The node now says 30 GiB while the panel still says 20 — no, 10 here, the
    // size this fixture was left at — and the customer has used more than the
    // panel's number but less than the real one.
    nodeQ242().totalGB = 30 * gbUnit;
    bumpClient(multiConfigs[0], 6 * gbUnit, 6 * gbUnit);
    const mirrorSync = await syncNow();
    const mirrorCounters = mirrorSync.json?.data?.configs || {};
    const mirrorRow = await poolRowQ242();
    check('the volume the node declares is mirrored into every row of the package',
      mirrorSync.status === 200
        && Number(mirrorCounters.quotaMirrored) >= 3
        && readQ242().every((row) => Number(row.total_bytes) === 30 * gbUnit)
        && mirrorRow.totalBytes === 30 * gbUnit,
      `mirrored=${mirrorCounters.quotaMirrored} rows=${readQ242().map((row) => row.total_bytes / gbUnit).join(',')} list=${mirrorRow.totalBytes / gbUnit}`);
    check('traffic over the stale number but under the real one leaves the customer online',
      mirrorRow.used === 12 * gbUnit && mirrorRow.remaining === 18 * gbUnit
        && mirrorRow.status === 'active' && nodeQ242().enable !== false,
      `used=${mirrorRow.used / gbUnit} remaining=${mirrorRow.remaining / gbUnit} status=${mirrorRow.status} nodeEnabled=${nodeQ242().enable}`);
    // Fixing the display must not turn the cutoff into a leak: the moment he
    // crosses the REAL quota every member still stops, and this pool remembers
    // that it was the one that stopped him.
    bumpClient(multiConfigs[0], 15 * gbUnit, 15 * gbUnit);
    const cutoffSync = await syncNow();
    const cutoffRow = await poolRowQ242();
    check('the pool still cuts him off at the real quota and marks the rows it stopped',
      Number(cutoffSync.json?.data?.configs?.disabled) >= 1
        && cutoffRow.used === 30 * gbUnit && cutoffRow.status === 'depleted'
        && nodeQ242().enable === false
        && readQ242().every((row) => String(row.sync_status) === 'over_quota' && Number(row.enabled) === 0),
      `disabled=${cutoffSync.json?.data?.configs?.disabled} status=${cutoffRow.status} marks=${readQ242().map((row) => row.sync_status).join(',')}`);
    // The other half of the bug, and the reason 'over_quota' is written at all:
    // nothing used to know that the pool — not the owner, not an expiry — had
    // switched this customer off, so raising the volume on the node left him
    // disabled forever. Now that same pass lets him back in.
    nodeQ242().totalGB = 40 * gbUnit;
    const raiseSync = await syncNow();
    const raiseRow = await poolRowQ242();
    check('raising the volume on the node switches that customer back on and clears the mark',
      Number(raiseSync.json?.data?.configs?.reEnabled) >= 1
        && nodeQ242().enable !== false && raiseRow.status === 'active'
        && raiseRow.totalBytes === 40 * gbUnit && raiseRow.used === 30 * gbUnit
        && readQ242().every((row) => String(row.sync_status) === '' && Number(row.enabled) === 1),
      `reEnabled=${raiseSync.json?.data?.configs?.reEnabled} status=${raiseRow.status} rows=${readQ242().map((row) => `${row.enabled}:${row.sync_status}`).join(',')}`);
    // A node client with no volume set means unlimited ON THE NODE, not "zero
    // gigabytes sold". The panel's own number is what the reseller paid for, so a
    // 0 may never overwrite it.
    nodeQ242().totalGB = 0;
    const unlimitedSync = await syncNow();
    const unlimitedRow = await poolRowQ242();
    check('an unlimited node client never wipes the volume the panel sold',
      unlimitedSync.status === 200 && unlimitedRow.totalBytes === 40 * gbUnit
        && readQ242().every((row) => Number(row.total_bytes) === 40 * gbUnit),
      `list=${unlimitedRow.totalBytes / gbUnit} rows=${readQ242().map((row) => row.total_bytes / gbUnit).join(',')}`);
    // And the guard the owner asked for without asking: he switched a customer
    // off himself. The pool has no idea why, so it must keep its hands off him —
    // only the mark this release writes may be undone by this release.
    const handOff = await request('POST', `/api/admin/configs/${multiConfigs[0].id}/toggle`, {
      cookies, csrf, body: { enabled: false },
    });
    const handSync = await syncNow();
    const handRow = await poolRowQ242();
    check('a customer the owner switched off by hand is not brought back by the pool',
      handOff.status === 200 && nodeQ242().enable === false
        && readQ242().every((row) => Number(row.enabled) === 0 && String(row.sync_status) === '')
        && handRow.enabled === false,
      `nodeEnabled=${nodeQ242().enable} rows=${readQ242().map((row) => `${row.enabled}:${row.sync_status}`).join(',')} list=${handRow.enabled} reEnabled=${handSync.json?.data?.configs?.reEnabled}`);
    // Leave the fixture exactly as this block found it — 10 GiB pool, nothing
    // used, online — so the checks after it still describe the same customer.
    const handOn = await request('POST', `/api/admin/configs/${multiConfigs[0].id}/toggle`, {
      cookies, csrf, body: { enabled: true },
    });
    bumpClient(multiConfigs[0], 0, 0);
    nodeQ242().totalGB = 10 * gbUnit;
    const restoreSync = await syncNow();
    const restoreRow = await poolRowQ242();
    check('the volume block leaves the package as it found it: 10 GiB, unused, online',
      handOn.status === 200 && restoreSync.status === 200
        && restoreRow.totalBytes === 10 * gbUnit && restoreRow.used === 0
        && restoreRow.status === 'active' && nodeQ242().enable !== false
        && readQ242().every((row) => Number(row.total_bytes) === 10 * gbUnit
          && String(row.sync_status) === '' && Number(row.enabled) === 1),
      `gb=${restoreRow.totalBytes / gbUnit} used=${restoreRow.used} status=${restoreRow.status}`);
    // v2.4.2 also answers the second complaint: the SSH menu wrote Persian text
    // into a terminal that is not, and bidi made every page come out reversed and
    // mangled. The menu and the console CLI it calls are English-only now, so
    // nothing depends on how the terminal orders right-to-left runs. Comments may
    // stay Persian — they are never printed.
    const persianOutput = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => {
      const hash = line.indexOf('#');
      return /[\u0600-\u06FF]/.test(hash === -1 ? line : line.slice(0, hash));
    }).length;
    const menuSh = [path.join(ROOT, '..', 'menu.sh'), path.join(ROOT, 'menu.sh')]
      .find((candidate) => fs.existsSync(candidate)) || '';
    check('the SSH menu and its CLI print no Persian at all',
      Boolean(menuSh) && persianOutput(menuSh) === 0
        && persianOutput(path.join(ROOT, 'scripts', 'admin-cli.js')) === 0,
      `menu=${menuSh ? menuSh.replace(/\\/g, '/') : 'missing'} menuLines=${menuSh ? persianOutput(menuSh) : -1} cliLines=${persianOutput(path.join(ROOT, 'scripts', 'admin-cli.js'))}`);
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
      // v1.4.20 guard, from the live defect: this heal pass on the node's own panel ran
      // under v1.4.17 and minted ONE NEW x-ui client per customer (34 of them, each
      // holding only the extra channel), which is what split one package across two clients
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
      // the external-origin census finds today (an adopted customer plus one channel of ours).
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

    // --------------------- v1.4.28: hidden traffic is not his traffic
    // A reseller who switches the adoption list off for himself does not see those
    // subscriptions anywhere in his panel, yet the day ledger kept booking their
    // bytes under his user id — so his home page announced a busy day next to a
    // customer list of one package that had used nothing, and the owner's ranking
    // of resellers put him first for traffic nobody could see. Every counter that
    // reads usage_daily now goes through the same visibility rule the list, the
    // KPI cards and the night report already used.
    const visDb28 = new Database(path.join(DATA_DIR, 'panel.db'));
    const dayKey28 = (ts) => new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ts));
    const G28 = 1024 ** 3;
    const today28 = dayKey28(Date.now());
    const yesterday28 = dayKey28(Date.now() - 86400000);
    const OWN28 = 2 * G28;        // his real customer today: 1 GB up + 1 GB down
    const HID_TODAY28 = 75 * G28; // the adopted row today: 70 GB up + 5 GB down
    const HID_WEEK28 = 40 * G28;  // and more of it yesterday
    let visShopId28 = 0;
    const visIds28 = [];
    const visEmails28 = [];
    let visParked28 = false;
    try {
      const parkV = await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 3600 } });
      visParked28 = parkV.status === 200;
      check('the visibility fixture parks the monitor so its bytes stay where they were written',
        visParked28, `status=${parkV.status}`);

      const mkV = await request('POST', '/api/admin/users', {
        cookies, csrf,
        body: { username: 'visshop', password: 'password123', role: 'reseller', telegram_id: '777000333' },
      });
      visShopId28 = Number(mkV.json?.data?.user?.id || 0);
      const visLogin = await request('POST', '/api/auth/login', { body: { username: 'visshop', password: 'password123' } });
      const visCookies = cookiesFrom(visLogin.headers);
      check('the reseller of this fixture can log in to his own panel',
        mkV.status === 201 && visShopId28 > 0 && visLogin.status === 200 && Boolean(visCookies),
        `users=${mkV.status} login=${visLogin.status} id=${visShopId28}`);

      // one package of his own, made the way the panel makes them
      const ownV = await request('POST', '/api/admin/configs', {
        cookies, csrf,
        body: { userId: visShopId28, inboundIds: [901], gb: 10, days: 30, customerName: 'VIS-own' },
      });
      const ownCfg28 = (ownV.json?.data?.configs || [])[0] || {};
      const ownId28 = Number(ownCfg28.id || 0);
      const ownEmail28 = String(ownCfg28.email || '');
      if (ownId28) visIds28.push(ownId28);
      if (ownEmail28) visEmails28.push(ownEmail28);

      // and an adopted subscription: a real client on the node, a local row of
      // origin=external, and a day ledger full of bytes he hid from himself
      const hidEmail28 = `vis-hidden-${crypto.randomBytes(6).toString('hex')}`;
      const hidId28 = Number(visDb28.prepare(
        `INSERT INTO configs
           (user_id, server_id, inbound_id, email, sub_id, xui_sub_id, uuid, label, customer_name,
            total_bytes, expiry_at, enabled, status, origin, up_bytes, down_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', ?, ?, 'adopted', 'مشتری پنهان', ?, ?, 1, 'active', 'external', 7, 8, ?, ?)`
      ).run(visShopId28, primaryId, 901, hidEmail28, 'vis-hidden-sub', crypto.randomUUID(),
        70 * G28, Date.now() + 30 * 86400000, Date.now(), Date.now()).lastInsertRowid);
      visIds28.push(hidId28);
      visEmails28.push(hidEmail28);
      mockXui.clients.set(hidEmail28, {
        email: hidEmail28, id: 'vis-hidden-uuid', subId: 'vis-hidden-sub', security: 'auto',
        totalGB: 70 * G28, expiryTime: Date.now() + 30 * 86400000, enable: true,
        up: 7, down: 8, inboundIds: [901],
      });
      check('the fixture is one package of his own plus one adopted subscription he hid',
        ownV.status === 201 && ownId28 > 0 && hidId28 > 0 && Boolean(mockXui.clients.get(hidEmail28)),
        `own=${ownId28} adopted=${hidId28}`);

      // Both rows read as "synced up to this instant with these counters", so even
      // a sync that slips through books nothing and the numbers below stay exact.
      for (const pair of [[ownId28, ownEmail28], [hidId28, hidEmail28]]) {
        const client = mockXui.clients.get(pair[1]) || {};
        visDb28.prepare(
          'UPDATE configs SET up_bytes = ?, down_bytes = ?, last_up = ?, last_down = ?, last_synced_at = ? WHERE id = ?'
        ).run(Number(client.up || 0), Number(client.down || 0), Number(client.up || 0), Number(client.down || 0), Date.now(), pair[0]);
      }
      const book28 = visDb28.prepare(
        `INSERT INTO usage_daily (config_id, user_id, day, up_bytes, down_bytes) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (config_id, day) DO UPDATE SET up_bytes = excluded.up_bytes, down_bytes = excluded.down_bytes`
      );
      visDb28.prepare('DELETE FROM usage_daily WHERE user_id = ?').run(visShopId28);
      book28.run(ownId28, visShopId28, today28, 1 * G28, 1 * G28);
      book28.run(hidId28, visShopId28, today28, 70 * G28, 5 * G28);
      book28.run(hidId28, visShopId28, yesterday28, HID_WEEK28, 0);
      const ledgerAll28 = Number(visDb28.prepare(
        'SELECT COALESCE(SUM(up_bytes + down_bytes), 0) AS t FROM usage_daily WHERE user_id = ?'
      ).get(visShopId28).t);
      check('his day ledger holds both kinds of traffic under the same user id',
        ledgerAll28 === OWN28 + HID_TODAY28 + HID_WEEK28, `ledger=${(ledgerAll28 / G28).toFixed(0)}GB`);

      // The switch is flipped in the database on purpose: through the API, turning
      // it on also re-runs adoption, which would rewrite the fixture being measured.
      const setSwitch28 = (on) => visDb28.prepare('UPDATE users SET import_configs = ? WHERE id = ?').run(on ? 1 : 0, visShopId28);
      setSwitch28(false);

      const offOv28 = await request('GET', '/api/reseller/overview', { cookies: visCookies });
      const offData28 = offOv28.json?.data || {};
      const offToday28 = (offData28.series || []).find((row) => row.day === today28) || {};
      const offYday28 = (offData28.series || []).find((row) => row.day === yesterday28) || {};
      check('a reseller who hides his adopted list sees only his own traffic on his home page',
        offOv28.status === 200 && Number(offData28.today?.total) === OWN28
          && Number(offData28.week?.total) === OWN28
          && Number(offData28.month?.total) === OWN28,
        `today=${Number(offData28.today?.total) / G28}GB week=${Number(offData28.week?.total) / G28}GB month=${Number(offData28.month?.total) / G28}GB`);
      check('so his chart, his customer count and his traffic tell one story',
        Number(offToday28.total || 0) === OWN28 && Number(offYday28.total || 0) === 0
          && Number(offData28.configs?.total) === 1
          && (offData28.topConfigs || []).every((row) => Number(row.id) !== hidId28),
        `series=${Number(offToday28.total || 0) / G28}GB packages=${offData28.configs?.total}`);

      const offStats28 = await request('GET', '/api/reseller/stats?days=14', { cookies: visCookies });
      check('his stats page answers the same as his home page',
        offStats28.status === 200 && Number(offStats28.json?.data?.today?.total) === OWN28
          && Number(offStats28.json?.data?.week?.total) === OWN28
          && Number(offStats28.json?.data?.month?.total) === OWN28,
        `today=${Number(offStats28.json?.data?.today?.total) / G28}GB`);

      const offAdm28 = await request('GET', '/api/admin/stats?days=7', { cookies, csrf });
      const offMe28 = (offAdm28.json?.data?.topUsers || []).find((row) => Number(row.id) === visShopId28) || {};
      const fleetOff28 = Number(visDb28.prepare(
        `SELECT COALESCE(SUM(d.up_bytes + d.down_bytes), 0) AS t
         FROM usage_daily d JOIN configs c ON c.id = d.config_id
         WHERE d.day = ? AND (c.origin <> 'external' OR c.user_id IN (SELECT id FROM users WHERE import_configs = 1))`
      ).get(today28).t);
      check('and the owner’s ranking of resellers no longer counts traffic a reseller cannot see',
        offAdm28.status === 200 && Number(offMe28.usedBytes || 0) === OWN28,
        `ranked=${Number(offMe28.usedBytes || 0) / G28}GB`);
      check('the owner’s own “today” is the fleet’s visible traffic, hidden rows excluded',
        Number(offAdm28.json?.data?.overview?.today?.total) === fleetOff28,
        `today=${Number(offAdm28.json?.data?.overview?.today?.total) / G28}GB visibleFleet=${(fleetOff28 / G28).toFixed(2)}GB`);

      const offRpt28 = await request('GET', `/api/admin/reports/daily/${visShopId28}/preview`, { cookies, csrf });
      check('the night report of that day says the same number as the home page',
        offRpt28.status === 200 && Number(offRpt28.json?.data?.stats?.traffic) === OWN28
          && Number(offRpt28.json?.data?.stats?.packages) === 1,
        `traffic=${Number(offRpt28.json?.data?.stats?.traffic) / G28}GB packages=${offRpt28.json?.data?.stats?.packages}`);

      // The very same bytes, the moment he asks to see those subscriptions again.
      setSwitch28(true);
      const onOv28 = await request('GET', '/api/reseller/overview', { cookies: visCookies });
      const onData28 = onOv28.json?.data || {};
      const onAdm28 = await request('GET', '/api/admin/stats?days=7', { cookies, csrf });
      const onMe28 = (onAdm28.json?.data?.topUsers || []).find((row) => Number(row.id) === visShopId28) || {};
      const onRpt28 = await request('GET', `/api/admin/reports/daily/${visShopId28}/preview`, { cookies, csrf });
      check('turning the adopted list back on makes every byte of it his again',
        Number(onData28.today?.total) === OWN28 + HID_TODAY28
          && Number(onData28.week?.total) === OWN28 + HID_TODAY28 + HID_WEEK28
          && Number(onMe28.usedBytes || 0) === OWN28 + HID_TODAY28 + HID_WEEK28
          && Number(onRpt28.json?.data?.stats?.traffic) === OWN28 + HID_TODAY28,
        `today=${Number(onData28.today?.total) / G28}GB week=${Number(onData28.week?.total) / G28}GB ranked=${Number(onMe28.usedBytes || 0) / G28}GB report=${Number(onRpt28.json?.data?.stats?.traffic) / G28}GB`);
      check('nothing was deleted to make the number smaller — the ledger still holds every byte',
        Number(visDb28.prepare(
          'SELECT COALESCE(SUM(up_bytes + down_bytes), 0) AS t FROM usage_daily WHERE user_id = ?'
        ).get(visShopId28).t) === OWN28 + HID_TODAY28 + HID_WEEK28,
        'ledger untouched by the counters');

      // A ledger row whose config row is gone is still that user's traffic: the
      // visibility rule needs a row to judge, so an unmatched row is counted
      // instead of being swallowed by the join.
      book28.run(0, visShopId28, today28, 1 * G28, 0);
      const orphanOv28 = await request('GET', '/api/reseller/overview', { cookies: visCookies });
      check('a day-ledger row that outlived its config is counted, not silently dropped',
        Number(orphanOv28.json?.data?.today?.total) === OWN28 + HID_TODAY28 + G28,
        `today=${Number(orphanOv28.json?.data?.today?.total) / G28}GB`);
      visDb28.prepare('DELETE FROM usage_daily WHERE config_id = 0 AND user_id = ?').run(visShopId28);
    } finally {
      for (const id of visIds28) visDb28.prepare('DELETE FROM usage_daily WHERE config_id = ?').run(id);
      for (const id of visIds28) visDb28.prepare('DELETE FROM configs WHERE id = ?').run(id);
      if (visShopId28) {
        visDb28.prepare('DELETE FROM sessions WHERE user_id = ?').run(visShopId28);
        visDb28.prepare('DELETE FROM transactions WHERE user_id = ?').run(visShopId28);
        visDb28.prepare('DELETE FROM users WHERE id = ?').run(visShopId28);
      }
      for (const email of visEmails28) mockXui.clients.delete(email);
      visDb28.close();
      if (visParked28) await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 120 } });
    }

    // --------------------- v1.4.29: adding a channel to an existing customer is free
    // The owner's rule in his own words: once a reseller has created a customer,
    // adding an inbound to that customer must not take money from the reseller.
    // The channel joins the quota and the expiry he ALREADY paid for when he built
    // the package — attachInbound adds no bytes and no days — so the old charge
    // sold him nothing new, and on an empty wallet it refused the add outright
    // (402 insufficient_balance), which is exactly what he hit on the live panel.
    //
    // Nothing else moves: building a package and renewing one are still charged,
    // and the admin keeps his v1.4.25 «کسر از کیف پول نماینده» switch, which is now
    // the ONLY way this action can cost anyone money.
    const freeDb29 = new Database(path.join(DATA_DIR, 'panel.db'));
    const G29 = 1024 ** 3;
    let freeShopId29 = 0;
    const freeIds29 = [];
    const freeEmails29 = [];
    let freeParked29 = false;
    try {
      const parkF = await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 3600 } });
      freeParked29 = parkF.status === 200;

      const mkF = await request('POST', '/api/admin/users', {
        cookies, csrf,
        body: { username: 'addfreeshop', password: 'password123', role: 'reseller', balance: 0 },
      });
      freeShopId29 = Number(mkF.json?.data?.user?.id || 0);
      const freeLogin = await request('POST', '/api/auth/login', { body: { username: 'addfreeshop', password: 'password123' } });
      const freeCookies = cookiesFrom(freeLogin.headers);
      const freeCsrf = freeLogin.json?.data?.csrf;
      check('v1.4.29 the fixture is a reseller with an EMPTY wallet — the case the owner hit',
        parkF.status === 200 && mkF.status === 201 && freeShopId29 > 0 && freeLogin.status === 200 && Boolean(freeCsrf),
        `park=${parkF.status} user=${mkF.status} login=${freeLogin.status} id=${freeShopId29}`);

      const wallet29 = async () => Number((await request('GET', '/api/auth/me', { cookies: freeCookies })).json?.data?.user?.balance || 0);
      const ledger29 = async (type) => {
        const res = await request('GET', '/api/reseller/transactions?pageSize=100', { cookies: freeCookies, csrf: freeCsrf });
        return (res.json?.data?.rows || []).filter((row) => row.type === type).length;
      };
      const addLedger29 = () => Number(freeDb29.prepare(
        "SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND type = 'purchase' AND description LIKE 'افزودن اینباند%'"
      ).get(freeShopId29).c);
      const group29 = async (id) => {
        const res = await request('GET', `/api/admin/configs/${id}`, { cookies });
        return { config: res.json?.data?.config || {}, group: res.json?.data?.group || [] };
      };
      const tariff29 = (inboundId, gb, days) => {
        const row = freeDb29.prepare('SELECT price_fixed, price_per_gb, price_per_day FROM inbounds WHERE id = ?').get(inboundId) || {};
        return Number(row.price_fixed || 0) + Number(row.price_per_gb || 0) * gb + Number(row.price_per_day || 0) * days;
      };
      const keep29 = (cfg) => {
        const id = Number(cfg?.id || 0);
        const email = String(cfg?.email || '');
        if (id) freeIds29.push(id);
        if (email && !freeEmails29.includes(email)) freeEmails29.push(email);
        return id;
      };

      // The customer is built by the ADMIN, free (v1.4.25), so the reseller owns a
      // real 10GB/30d package while his wallet stays at zero.
      const buildA = await request('POST', '/api/admin/configs', {
        cookies, csrf,
        body: { userId: freeShopId29, inboundIds: [901], gb: 10, days: 30, customerName: 'مشتری رایگان' },
      });
      const cfgA = (buildA.json?.data?.configs || [])[0] || {};
      const idA = keep29(cfgA);
      const emailA = String(cfgA.email || '');
      const clientA0 = mockXui.clients.get(emailA) || {};
      const poolA0 = Number(clientA0.totalGB || 0);
      const expiryA0 = Number(clientA0.expiryTime || 0);
      const uuidA0 = String(clientA0.id || '');
      const clientsBefore29 = mockXui.clients.size;
      check('v1.4.29 an admin-built package gives him a customer without touching his wallet',
        buildA.status === 201 && idA > 0 && Boolean(emailA) && (await wallet29()) === 0 && await ledger29('purchase') === 0,
        `status=${buildA.status} balance=${await wallet29()} purchases=${await ledger29('purchase')}`);

      // THE regression: 902 costs 500 for this pool, the wallet holds 0, and the
      // old code answered 402 before the node was even asked.
      const addA1 = await request('POST', `/api/reseller/configs/${idA}/inbounds`, {
        cookies: freeCookies, csrf: freeCsrf, body: { inboundId: 902 },
      });
      const addedA1 = addA1.json?.data?.config || {};
      keep29(addedA1);
      check('v1.4.29 a reseller adds a PRICED inbound to his own customer on an empty wallet — no 402 any more',
        addA1.status === 201 && Number(addedA1.inboundId) === 902 && String(addedA1.email || '') === emailA,
        `status=${addA1.status} code=${addA1.json?.error?.code} inbound=${addedA1.inboundId}`);
      check('v1.4.29 nothing was taken from his wallet and no purchase row was written for the add',
        (await wallet29()) === 0 && addLedger29() === 0 && await ledger29('purchase') === 0,
        `balance=${await wallet29()} addCharges=${addLedger29()} purchases=${await ledger29('purchase')}`);

      // The flag cannot be steered from the client in EITHER direction: a reseller
      // asking to be charged is still not charged, because only an admin viewer
      // ever reads `charge`.
      const addA2 = await request('POST', `/api/reseller/configs/${idA}/inbounds`, {
        cookies: freeCookies, csrf: freeCsrf, body: { inboundId: 903, charge: true },
      });
      const addedA2 = addA2.json?.data?.config || {};
      keep29(addedA2);
      check('v1.4.29 even {"charge":true} from the reseller’s own session adds the channel for free',
        addA2.status === 201 && Number(addedA2.inboundId) === 903
          && (await wallet29()) === 0 && addLedger29() === 0,
        `status=${addA2.status} balance=${await wallet29()} addCharges=${addLedger29()}`);

      const auditOf29 = (id) => {
        const row = freeDb29.prepare(
          "SELECT details FROM audit_logs WHERE action = 'config.inbound_add' AND entity = 'config' AND entity_id = ? ORDER BY id DESC LIMIT 1"
        ).get(String(id)) || {};
        try { return JSON.parse(row.details || '{}'); } catch (_) { return {}; }
      };
      const auditA1 = auditOf29(addedA1.id);
      const auditA2 = auditOf29(addedA2.id);
      check('the audit trail says it was GIVEN AWAY and keeps the tariff it would have cost',
        auditA1.free === true && auditA1.charged === false && Number(auditA1.amount) === 0
          && Number(auditA1.waived) === tariff29(902, 10, 30)
          && auditA2.free === true && auditA2.charged === false && Number(auditA2.amount) === 0
          && Number(auditA2.waived) === tariff29(903, 10, 30),
        `waived=${auditA1.waived}/${auditA2.waived} expected=${tariff29(902, 10, 30)}/${tariff29(903, 10, 30)} charged=${auditA1.charged}/${auditA2.charged}`);

      const clientA1 = mockXui.clients.get(emailA) || {};
      const viewA = await group29(idA);
      const expiriesA = new Set(viewA.group.map((item) => Number(item.expiryAt || 0)));
      check('both channels joined the customer’s OWN client — no second client was minted',
        mockXui.clients.size === clientsBefore29
          && (clientA1.inboundIds || []).map(Number).sort((a, b) => a - b).join(',') === '901,902,903'
          && String(clientA1.id || '') === uuidA0,
        `clients=${clientsBefore29}→${mockXui.clients.size} attached=${(clientA1.inboundIds || []).join(',')} sameUuid=${String(clientA1.id || '') === uuidA0}`);
      check('free does not mean a bigger package: the pool, the expiry and the counters are what he paid for',
        Number(clientA1.totalGB || 0) === poolA0 && Number(clientA1.expiryTime || 0) === expiryA0
          && viewA.group.length === 3 && expiriesA.size === 1
          && viewA.group.every((item) => Number(item.totalBytes || 0) === 10 * G29),
        `pool=${Number(clientA1.totalGB || 0) / G29}GB group=${viewA.group.length} distinctExpiries=${expiriesA.size}`);
      const linksA = await request('GET', `/api/reseller/configs/${idA}/links`, { cookies: freeCookies });
      const subsA = linksA.json?.data?.subscriptions || {};
      check('so the customer still holds ONE subscription link on the node, now listing three channels',
        linksA.status === 200 && Number(subsA.clientCount) === 1 && subsA.source === 'node'
          && Number(subsA.node?.[0]?.inboundCount) === 3,
        `clients=${subsA.clientCount} source=${subsA.source} inbounds=${subsA.node?.[0]?.inboundCount}`);

      // The admin's v1.4.25 switch is the only paid case left, and it must still
      // behave: on this empty wallet a ticked add is refused before the node is
      // touched, while the reseller's own add of the very same channel succeeds.
      const buildB = await request('POST', '/api/admin/configs', {
        cookies, csrf,
        body: { userId: freeShopId29, inboundIds: [901], gb: 10, days: 30, customerName: 'مشتری دوم' },
      });
      const cfgB = (buildB.json?.data?.configs || [])[0] || {};
      const idB = keep29(cfgB);
      const emailB = String(cfgB.email || '');
      const paidB = await request('POST', `/api/admin/configs/${idB}/inbounds`, {
        cookies, csrf, body: { inboundId: 902, charge: true },
      });
      const viewB0 = await group29(idB);
      check('v1.4.25 is intact: an admin who TICKS the charge switch is still refused on an empty wallet',
        buildB.status === 201 && paidB.status === 402 && paidB.json?.error?.code === 'insufficient_balance'
          && viewB0.group.length === 1
          && (mockXui.clients.get(emailB)?.inboundIds || []).map(Number).join(',') === '901',
        `status=${paidB.status} code=${paidB.json?.error?.code} group=${viewB0.group.length} attached=${(mockXui.clients.get(emailB)?.inboundIds || []).join(',')}`);

      const freeB = await request('POST', `/api/reseller/configs/${idB}/inbounds`, {
        cookies: freeCookies, csrf: freeCsrf, body: { inboundId: 902 },
      });
      keep29(freeB.json?.data?.config || {});
      check('the reseller’s own add of that same channel to that same customer goes through for free',
        freeB.status === 201 && (await wallet29()) === 0 && addLedger29() === 0
          && (mockXui.clients.get(emailB)?.inboundIds || []).map(Number).sort((a, b) => a - b).join(',') === '901,902',
        `status=${freeB.status} balance=${await wallet29()} attached=${(mockXui.clients.get(emailB)?.inboundIds || []).join(',')}`);

      const adminFreeB = await request('POST', `/api/admin/configs/${idB}/inbounds`, {
        cookies, csrf, body: { inboundId: 903 },
      });
      keep29(adminFreeB.json?.data?.config || {});
      check('and an admin add WITHOUT the tick is still free, exactly as v1.4.25 left it',
        adminFreeB.status === 201 && (await wallet29()) === 0 && addLedger29() === 0,
        `status=${adminFreeB.status} balance=${await wallet29()} addCharges=${addLedger29()}`);

      // What the owner did NOT ask to change: building a package and renewing one
      // still cost the tariff. The wallet is funded here so both can be measured.
      const fund29 = await request('POST', `/api/admin/users/${freeShopId29}/balance`, {
        cookies, csrf, body: { amount: 1000, description: 'شارژ تست ساخت و تمدید' },
      });
      const purchasesBefore29 = await ledger29('purchase');
      const buildC = await request('POST', '/api/reseller/configs', {
        cookies: freeCookies, csrf: freeCsrf,
        body: { inboundIds: [903], gb: 5, days: 10, customerName: 'مشتری سوم' },
      });
      keep29((buildC.json?.data?.configs || [])[0] || {});
      const costC = tariff29(903, 5, 10);
      check('creating a NEW package still charges its tariff exactly once',
        fund29.status === 200 && buildC.status === 201 && (await wallet29()) === 1000 - costC
          && await ledger29('purchase') === purchasesBefore29 + 1,
        `status=${buildC.status} cost=${costC} balance=${await wallet29()} purchases=${purchasesBefore29}→${await ledger29('purchase')}`);

      const renewQuote29 = await request('POST', `/api/reseller/configs/${idA}/extend/quote`, {
        cookies: freeCookies, csrf: freeCsrf, body: { gb: 5, days: 5 },
      });
      const renewPrice29 = renewQuote29.json?.data || {};
      const balanceBeforeRenew29 = await wallet29();
      const renewsBefore29 = await ledger29('renew');
      const renew29 = await request('POST', `/api/reseller/configs/${idA}/extend`, {
        cookies: freeCookies, csrf: freeCsrf, body: { gb: 5, days: 5 },
      });
      check('renewing still charges what the dialog quoted — free applies to ADDING A CHANNEL only',
        renewQuote29.status === 200 && renewPrice29.charged === true && Number(renewPrice29.total) > 0
          && renew29.status === 200 && (await wallet29()) === balanceBeforeRenew29 - Number(renewPrice29.total)
          && await ledger29('renew') === renewsBefore29 + 1,
        `quoted=${renewPrice29.total} status=${renew29.status} balance=${balanceBeforeRenew29}→${await wallet29()} renews=${renewsBefore29}→${await ledger29('renew')}`);

      const billingRow29 = JSON.parse(freeDb29.prepare("SELECT value FROM settings WHERE key = 'billing'").get()?.value || '{}');
      check('the fixture leaves wallet billing switched on, as the rest of the suite assumes',
        billingRow29.enabled === true, `billing=${JSON.stringify(billingRow29)}`);
    } finally {
      for (const id of freeIds29) freeDb29.prepare('DELETE FROM usage_daily WHERE config_id = ?').run(id);
      for (const id of freeIds29) freeDb29.prepare('DELETE FROM configs WHERE id = ?').run(id);
      if (freeShopId29) {
        freeDb29.prepare('DELETE FROM notifications WHERE user_id = ?').run(freeShopId29);
        freeDb29.prepare('DELETE FROM sessions WHERE user_id = ?').run(freeShopId29);
        freeDb29.prepare('DELETE FROM transactions WHERE user_id = ?').run(freeShopId29);
        freeDb29.prepare('DELETE FROM users WHERE id = ?').run(freeShopId29);
      }
      for (const email of freeEmails29) mockXui.clients.delete(email);
      freeDb29.close();
      if (freeParked29) await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 120 } });
    }

    // --------------------- v1.5.1: a channel the admin granted is usable, hidden or not
    // The owner authorised two inbounds on the second server for one reseller so
    // she could sell subscriptions. She opened the create form and found
    // nothing to tick. Two decisions disagreed: syncServer inserts every freshly
    // discovered channel with visible = 0 — only the admin's eye toggle ever turns
    // it on — while the reseller form on the admin side lists those channels anyway.
    // listInbounds then trimmed the hidden rows out BEFORE applying the allow list,
    // so a grant nobody had un-hidden bought the reseller nothing, and the order
    // path would have refused with 403 inbound_hidden even had she seen the row.
    //
    // A second live reseller sat in the same trap and nobody noticed, because his
    // FIXED inbound happens to be hidden too and the fixed-inbound rescue put that
    // one row back: 16 channels were authorised for him and the form offered 15.
    // The visible flag is a gate on the DEFAULT offer, not a veto on
    // a grant, and nothing below flips it for anybody.
    const hidDb = new Database(path.join(DATA_DIR, 'panel.db'));
    let hidShopId = 0;
    let hidOtherId = 0;
    let hidOpenId = 0;
    const hidIds = [];
    const hidEmails = [];
    let hidParked = false;
    let hidLimit = 10;
    let hidLimitRaised = false;
    try {
      const parkH = await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 3600 } });
      hidParked = parkH.status === 200;
      // This block needs three fresh logins and the suite is already nine deep into
      // the limiter's 10-minute window by now — the second and third would come back
      // 429 rate_limited, and an empty picker would look like the bug, not like a
      // missing session. Lift the ceiling for the block, then hand it back.
      hidLimit = Number((await request('GET', '/api/admin/settings', { cookies })).json
        ?.data?.settings?.security?.loginRateLimit || 10);
      const liftH = await request('PATCH', '/api/admin/settings/security', {
        cookies, csrf, body: { loginRateLimit: 100 },
      });
      hidLimitRaised = liftH.status === 200;

      // The reported shape exactly: granted channels, NO fixed inbound to rescue him.
      const mkH = await request('POST', '/api/admin/users', {
        cookies, csrf,
        body: { username: 'hiddengrant', password: 'password123', role: 'reseller', balance: 5000000 },
      });
      hidShopId = Number(mkH.json?.data?.user?.id || 0);
      const hidLogin = await request('POST', '/api/auth/login', { body: { username: 'hiddengrant', password: 'password123' } });
      const hidCookies = cookiesFrom(hidLogin.headers);
      const hidCsrf = hidLogin.json?.data?.csrf;
      // A neighbour who was NOT granted the hidden channels.
      const mkH2 = await request('POST', '/api/admin/users', {
        cookies, csrf,
        body: { username: 'hiddenother', password: 'password123', role: 'reseller', balance: 5000000 },
      });
      hidOtherId = Number(mkH2.json?.data?.user?.id || 0);
      const hid2Login = await request('POST', '/api/auth/login', { body: { username: 'hiddenother', password: 'password123' } });
      const hid2Cookies = cookiesFrom(hid2Login.headers);
      const hid2Csrf = hid2Login.json?.data?.csrf;
      // A third with an EMPTY allow list — the default offer must not change.
      const mkH3 = await request('POST', '/api/admin/users', {
        cookies, csrf,
        body: { username: 'hiddenopen', password: 'password123', role: 'reseller', balance: 5000000 },
      });
      hidOpenId = Number(mkH3.json?.data?.user?.id || 0);
      const hid3Login = await request('POST', '/api/auth/login', { body: { username: 'hiddenopen', password: 'password123' } });
      const hid3Cookies = cookiesFrom(hid3Login.headers);

      // Three channels the panel flags hidden (901, 902, 903) and one it does not
      // (904). 901+902 go to the first reseller, 903+904 to the second.
      hidDb.prepare('UPDATE inbounds SET visible = 0 WHERE id IN (901, 902, 903)').run();
      hidDb.prepare('UPDATE inbounds SET visible = 1 WHERE id = 904').run();
      const grantH = await request('PATCH', `/api/admin/users/${hidShopId}`, {
        cookies, csrf, body: { allowed_inbounds: [901, 902] },
      });
      const grantH2 = await request('PATCH', `/api/admin/users/${hidOtherId}`, {
        cookies, csrf, body: { allowed_inbounds: [903, 904] },
      });

      const picker = async (ck) => {
        const res = await request('GET', '/api/reseller/inbounds', { cookies: ck });
        return (res.json?.data?.rows || []).map((row) => Number(row.id)).sort((a, b) => a - b);
      };
      const listed1 = await picker(hidCookies);
      const listed2 = await picker(hid2Cookies);
      const listed3 = await picker(hid3Cookies);

      check('v1.5.1 the fixture is the reported shape: two granted channels the panel flags hidden, no fixed inbound',
        mkH.status === 201 && mkH2.status === 201 && mkH3.status === 201
          && hidLimitRaised
          && hidLogin.status === 200 && hid2Login.status === 200 && hid3Login.status === 200
          && grantH.status === 200 && grantH2.status === 200
          && hidDb.prepare('SELECT visible FROM inbounds WHERE id = 901').get()?.visible === 0
          && hidDb.prepare('SELECT visible FROM inbounds WHERE id = 902').get()?.visible === 0
          && Number(hidDb.prepare('SELECT fixed_inbound FROM users WHERE id = ?').get(hidShopId)?.fixed_inbound) === 0,
        `users=${mkH.status}/${mkH2.status}/${mkH3.status} logins=${hidLogin.status}/${hid2Login.status}/${hid3Login.status} lift=${hidLimit}->100 grants=${grantH.status}/${grantH2.status}`);

      check('v1.5.1 both channels the admin ticked appear in his create form (was: an empty form)',
        listed1.join(',') === '901,902', `rows=${listed1.join(',') || 'NOTHING'}`);

      const grantedRows = (await request('GET', '/api/reseller/inbounds', { cookies: hidCookies })).json?.data?.rows || [];
      check('the granted rows still arrive flagged hidden — the fix grants, it does not un-hide',
        grantedRows.length === 2 && grantedRows.every((row) => row.visible === false),
        JSON.stringify(grantedRows.map((row) => ({ id: row.id, visible: row.visible }))));

      check('v1.5.1 a reseller who was NOT granted a hidden channel still cannot see it',
        listed2.join(',') === '903,904', `neighbour rows=${listed2.join(',')}`);

      // The strongest form of «nothing else changed»: whatever the default offer
      // happens to contain at this point in the suite (earlier blocks hide and
      // delete channels, so its size is not ours to promise), every row in it must
      // be a channel the panel actually flags visible — and the three hidden ones
      // must be absent even though 904, visible and granted to a NEIGHBOUR, is present.
      const visibleIds = new Set(hidDb.prepare('SELECT id FROM inbounds WHERE visible = 1').all()
        .map((row) => Number(row.id)));
      check('the DEFAULT offer is untouched: an empty allow list means all VISIBLE channels only',
        listed3.length > 0 && listed3.every((id) => visibleIds.has(id))
          && !listed3.includes(901) && !listed3.includes(902) && !listed3.includes(903)
          && listed3.includes(904),
        `open-list rows=${listed3.join(',')} (${listed3.length}) of ${visibleIds.size} visible in the database`);

      // The permission fix must not become a pricing story: 901 is a real priced
      // channel and the order goes through the normal charge.
      const buildH = await request('POST', '/api/reseller/configs', {
        cookies: hidCookies, csrf: hidCsrf,
        body: { inboundIds: [901], gb: 10, days: 30, customerName: 'مشتری کانال مخفی' },
      });
      const cfgH = (buildH.json?.data?.configs || [])[0] || {};
      const idH = Number(cfgH.id || 0);
      const emailH = String(cfgH.email || '');
      if (idH) hidIds.push(idH);
      if (emailH && !hidEmails.includes(emailH)) hidEmails.push(emailH);
      check('v1.5.1 ordering on the granted-but-hidden channel is accepted (was 403 inbound_hidden)',
        buildH.status === 201 && idH > 0 && Number(cfgH.inboundId) === 901,
        `status=${buildH.status} code=${buildH.json?.error?.code || '-'} id=${idH}`);

      const clientH = mockXui.clients.get(emailH) || {};
      check('the customer really joined that channel on the node',
        (clientH.inboundIds || []).map(Number).includes(901),
        `node inbounds=${JSON.stringify(clientH.inboundIds || [])}`);

      const addH = await request('POST', `/api/reseller/configs/${idH}/inbounds`, {
        cookies: hidCookies, csrf: hidCsrf, body: { inboundId: 902 },
      });
      const groupH = await request('GET', `/api/admin/configs/${idH}`, { cookies });
      const groupIds = ((groupH.json?.data?.group) || []).map((item) => Number(item.inboundId)).sort((a, b) => a - b);
      check('v1.5.1 adding the second hidden channel to his own customer works too (the addInbound path)',
        addH.status === 201 && groupIds.join(',') === '901,902',
        `status=${addH.status} code=${addH.json?.error?.code || '-'} group=${groupIds.join(',')}`);

      const denied = await request('POST', '/api/reseller/configs', {
        cookies: hid2Cookies, csrf: hid2Csrf,
        body: { inboundIds: [901], gb: 10, days: 30, customerName: 'تجاوز' },
      });
      check('a hidden channel is still closed to the reseller it was not granted to',
        denied.status === 403, `status=${denied.status} code=${denied.json?.error?.code || '-'}`);

      const adminOnHidden = await request('POST', '/api/admin/configs', {
        cookies, csrf,
        body: { userId: hidOpenId, inboundIds: [901], gb: 5, days: 10, customerName: 'مدیر روی کانال مخفی' },
      });
      const adminCfg = (adminOnHidden.json?.data?.configs || [])[0] || {};
      if (Number(adminCfg.id)) hidIds.push(Number(adminCfg.id));
      if (adminCfg.email && !hidEmails.includes(String(adminCfg.email))) hidEmails.push(String(adminCfg.email));
      check('the admin’s own pass over hidden channels is unchanged',
        adminOnHidden.status === 201, `status=${adminOnHidden.status} code=${adminOnHidden.json?.error?.code || '-'}`);

      check('none of this touched the visible flag in the database',
        hidDb.prepare('SELECT COUNT(*) AS c FROM inbounds WHERE id IN (901,902,903) AND visible = 0').get().c === 3,
        `hidden still = ${hidDb.prepare('SELECT COUNT(*) AS c FROM inbounds WHERE id IN (901,902,903) AND visible = 0').get().c}/3`);
    } finally {
      for (const id of hidIds) hidDb.prepare('DELETE FROM usage_daily WHERE config_id = ?').run(id);
      for (const id of hidIds) hidDb.prepare('DELETE FROM configs WHERE id = ?').run(id);
      for (const shop of [hidShopId, hidOtherId, hidOpenId]) {
        if (!shop) continue;
        hidDb.prepare('DELETE FROM notifications WHERE user_id = ?').run(shop);
        hidDb.prepare('DELETE FROM sessions WHERE user_id = ?').run(shop);
        hidDb.prepare('DELETE FROM transactions WHERE user_id = ?').run(shop);
        hidDb.prepare('DELETE FROM users WHERE id = ?').run(shop);
      }
      // Hand the fixture channels back exactly as the rest of the suite expects them.
      hidDb.prepare('UPDATE inbounds SET visible = 1 WHERE id IN (901, 902, 903, 904)').run();
      for (const email of hidEmails) mockXui.clients.delete(email);
      hidDb.close();
      if (hidLimitRaised) await request('PATCH', '/api/admin/settings/security', { cookies, csrf, body: { loginRateLimit: hidLimit } });
      if (hidParked) await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 120 } });
    }

    // --------------------- v1.5.2: delete what is not on the node, receipts, adoption
    //
    // (1) «کانفینگ‌هایی که جلوشون نوشته (اشتراک روی نود نیست) قابل حذف شدن نیست و
    //     هنگام حذف خطا میده». x-ui answers a delete for a client it does not have
    //     with success:false + "Obtain (record not found)". That reached the operator
    //     as a generic xui_error and aborted the action before any row was touched,
    //     so the leftover row could never be cleaned up. The node is asked FIRST now
    //     and "not there" is an outcome, not a failure. The double above answers the
    //     way the real 3.8.5 does — before v1.5.2 it answered `true` for a missing
    //     client, which is exactly why every earlier run passed over this bug.
    // (2) the mobile balance keyboard is a frontend change (admin/Resellers.jsx);
    //     it is covered by the UI harness, not by an HTTP suite.
    // (3) the receipt bot: the panel half is here (list, decide, credit exactly once,
    //     the reseller's own list). The conversation itself runs in test/bot-topup.js.
    // (4) finding a client on x-ui by uuid / email / remark and handing it to a
    //     reseller — read-only search, panel-only adoption.
    const v52Db = new Database(path.join(DATA_DIR, 'panel.db'));
    let v52ShopId = 0;
    let v52OtherId = 0;
    let v52NoImpId = 0;
    const v52Ids = [];
    const v52Emails = [];
    const v52Topups = [];
    let v52Parked = false;
    let v52Limit = 10;
    let v52LimitRaised = false;
    let v52BotTouched = false;
    let v52BotWas = { botEnabled: true, botAdminChatId: '' };
    try {
      const park52 = await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 3600 } });
      v52Parked = park52.status === 200;
      v52Limit = Number((await request('GET', '/api/admin/settings', { cookies })).json
        ?.data?.settings?.security?.loginRateLimit || 10);
      const lift52 = await request('PATCH', '/api/admin/settings/security', { cookies, csrf, body: { loginRateLimit: 100 } });
      v52LimitRaised = lift52.status === 200;

      const mk52 = await request('POST', '/api/admin/users', {
        cookies, csrf,
        body: { username: 'v152shop', password: 'password123', role: 'reseller', balance: 2000000 },
      });
      v52ShopId = Number(mk52.json?.data?.user?.id || 0);
      const login52 = await request('POST', '/api/auth/login', { body: { username: 'v152shop', password: 'password123' } });
      const ck52 = cookiesFrom(login52.headers);
      const cs52 = login52.json?.data?.csrf;
      const mk52b = await request('POST', '/api/admin/users', {
        cookies, csrf,
        body: { username: 'v152other', password: 'password123', role: 'reseller', balance: 700000 },
      });
      v52OtherId = Number(mk52b.json?.data?.user?.id || 0);
      const mk52c = await request('POST', '/api/admin/users', {
        cookies, csrf,
        body: { username: 'v152noimp', password: 'password123', role: 'reseller', balance: 0 },
      });
      v52NoImpId = Number(mk52c.json?.data?.user?.id || 0);
      // Direct SQL: PATCHing import_configs re-runs the adoption pass, which is a
      // different feature and would write rows this block does not own.
      v52Db.prepare('UPDATE users SET import_configs = 0 WHERE id = ?').run(v52NoImpId);

      // The panel's own inbound ids, read instead of assumed: an earlier block may
      // have re-synced a channel, and only xui_id is stable across that.
      const inboundMap = {};
      for (const row of v52Db.prepare('SELECT id, xui_id FROM inbounds WHERE server_id = ?').all(primaryId)) {
        inboundMap[Number(row.xui_id)] = Number(row.id);
      }
      const inA = Number(inboundMap[901] || 0);
      const inB = Number(inboundMap[902] || 0);
      const inC = Number(inboundMap[903] || 0);
      const inD = Number(inboundMap[904] || 0);
      check('v1.5.2 fixture: three resellers, four known channels and a lifted login ceiling',
        mk52.status === 201 && mk52b.status === 201 && mk52c.status === 201
          && login52.status === 200 && v52LimitRaised && v52Parked
          && inA > 0 && inB > 0 && inC > 0 && inD > 0,
        `users=${mk52.status}/${mk52b.status}/${mk52c.status} login=${login52.status} inbounds=${inA},${inB},${inC},${inD}`);

      const WRITE_ROUTE = /\/clients\/(add|update\/|del\/|bulkAttach|bulkEnable|bulkDisable|bulkAdjust|resetTraffic\/)|\/detach$/;
      const writesSince = (from) => mockXui.calls.slice(from).filter((call) => WRITE_ROUTE.test(call.route)).map((call) => call.route);
      const routeCount = (from, prefix) => mockXui.calls.slice(from).filter((call) => call.route.startsWith(prefix)).length;
      const buildPackage = async (inboundIds, customerName) => {
        const res = await request('POST', '/api/admin/configs', {
          cookies, csrf, body: { userId: v52ShopId, inboundIds, gb: 10, days: 30, customerName },
        });
        const rows = res.json?.data?.configs || [];
        for (const row of rows) {
          v52Ids.push(Number(row.id));
          if (row.email && !v52Emails.includes(String(row.email))) v52Emails.push(String(row.email));
        }
        return { res, rows, id: Number(rows[0]?.id || 0), email: String(rows[0]?.email || '') };
      };
      const rowsOf = (email) => v52Db.prepare('SELECT id, deleted_at, origin, user_id, sub_id, total_bytes FROM configs WHERE email = ?').all(email);

      // ---- (1) the whole subscription whose client is already off the node
      const gone = await buildPackage([inA, inB], 'مشتری بی‌کلاینت');
      mockXui.clients.delete(gone.email);
      const markGone = mockXui.calls.length;
      const delGone = await request('DELETE', `/api/admin/configs/${gone.id}/package`, { cookies, csrf });
      const goneData = delGone.json?.data || {};
      const goneRows = rowsOf(gone.email);
      check('v1.5.2 a subscription that is not on the node can be deleted (was: xui_error, nothing removed)',
        gone.res.status === 201 && gone.rows.length === 2
          && delGone.status === 200 && Number(goneData.rows) === 2
          && goneData.remoteDeleted === false && (goneData.alreadyGone || []).includes(gone.email)
          && goneRows.length === 2 && goneRows.every((row) => Number(row.deleted_at) > 0),
        `create=${gone.res.status} delete=${delGone.status} code=${delGone.json?.error?.code || '-'} rows=${goneData.rows} alreadyGone=${JSON.stringify(goneData.alreadyGone || [])}`);
      check('the panel asked the node and then stopped — no delete is sent for a client it does not have',
        routeCount(markGone, '/clients/get/') >= 1 && routeCount(markGone, '/clients/del/') === 0,
        `get=${routeCount(markGone, '/clients/get/')} del=${routeCount(markGone, '/clients/del/')}`);

      // ---- a node that cannot answer is still an error, and still writes nothing
      const sick = await buildPackage([inC, inD], 'مشتری نود بیمار');
      mockXui.quirks.failGet.add(sick.email);
      const markSick = mockXui.calls.length;
      const delSick = await request('DELETE', `/api/admin/configs/${sick.id}/package`, { cookies, csrf });
      const sickRows = rowsOf(sick.email);
      check('"cannot tell" is not "not there": a sick node aborts the delete and leaves every row alone',
        delSick.status === 422 && delSick.json?.error?.code === 'xui_error'
          && sickRows.length === 2 && sickRows.every((row) => Number(row.deleted_at) === 0)
          && routeCount(markSick, '/clients/del/') === 0,
        `status=${delSick.status} code=${delSick.json?.error?.code || '-'} untouched=${sickRows.filter((row) => Number(row.deleted_at) === 0).length}/2`);
      mockXui.quirks.failGet.delete(sick.email);
      const markWell = mockXui.calls.length;
      const delWell = await request('DELETE', `/api/admin/configs/${sick.id}/package`, { cookies, csrf });
      const wellData = delWell.json?.data || {};
      check('a healthy package still deletes its client on the node — exactly one delete call',
        delWell.status === 200 && wellData.remoteDeleted === true
          && (wellData.xuiDeleted || []).includes(sick.email)
          && routeCount(markWell, '/clients/del/') === 1 && !mockXui.clients.has(sick.email),
        `status=${delWell.status} del=${routeCount(markWell, '/clients/del/')} remote=${wellData.remoteDeleted}`);

      // ---- one channel of a client-less package (the single delete button)
      const single = await buildPackage([inA, inB], 'تک‌ردیف بی‌کلاینت');
      mockXui.clients.delete(single.email);
      const markSingle = mockXui.calls.length;
      const delOne = await request('DELETE', `/api/admin/configs/${single.id}`, { cookies, csrf });
      const oneRow = v52Db.prepare('SELECT deleted_at FROM configs WHERE id = ?').get(single.id) || {};
      const sibRow = v52Db.prepare('SELECT deleted_at FROM configs WHERE email = ? AND id <> ?').get(single.email, single.id) || {};
      check('v1.5.2 one channel of a client-less package is removable too, and its sibling stays',
        delOne.status === 200 && delOne.json?.data?.alreadyGone === true
          && Number(oneRow.deleted_at) > 0 && Number(sibRow.deleted_at) === 0
          && routeCount(markSingle, '/clients/del/') === 0 && writesSince(markSingle).length === 0,
        `status=${delOne.status} alreadyGone=${delOne.json?.data?.alreadyGone} writes=${writesSince(markSingle).join(',') || 'none'}`);

      // ---- (4) search the node, then hand a client to a reseller
      const nodeUuid = '3f2a9c14-7b6d-4e51-9a2f-0c8d5e7b1a52';
      const nodeEmail = 'v152node-ready';
      const nodeBytes = 20 * 1024 ** 3;
      mockXui.clients.set(nodeEmail, {
        email: nodeEmail, id: nodeUuid, subId: 'v152sub0001', comment: 'مشتری آماده ۱۵۲',
        totalGB: nodeBytes, expiryTime: Date.now() + 30 * 86400000, enable: true,
        up: 4096, down: 8192, inboundIds: [901, 902],
      });
      v52Emails.push(nodeEmail);
      const orphanEmail = 'v152node-orphan';
      mockXui.clients.set(orphanEmail, {
        email: orphanEmail, id: '9b1c7d20-4a55-4c3e-8f10-2d6e9a0b7c43', subId: 'v152sub0002',
        comment: 'کانال ناشناخته', totalGB: 0, expiryTime: 0, enable: true, up: 0, down: 0, inboundIds: [4242],
      });
      v52Emails.push(orphanEmail);

      const shortQ = await request('GET', '/api/admin/node-clients?q=a', { cookies });
      check('v1.5.2 node search refuses a one-character query instead of listing the whole node',
        shortQ.status === 422 && shortQ.json?.error?.code === 'query_too_short',
        `status=${shortQ.status} code=${shortQ.json?.error?.code || '-'}`);

      const markSearch = mockXui.calls.length;
      const byEmail = await request('GET', `/api/admin/node-clients?q=${encodeURIComponent(nodeEmail)}`, { cookies });
      const hit = (byEmail.json?.data?.rows || [])[0] || {};
      check('v1.5.2 a client is found on x-ui by email, with its channels and its uuid',
        byEmail.status === 200 && (byEmail.json?.data?.rows || []).length === 1
          && hit.email === nodeEmail && hit.uuid === nodeUuid && hit.adopted === false
          && Number(hit.knownInbounds) === 2 && (hit.inboundIds || []).join(',') === '901,902'
          && Number(hit.totalBytes) === nodeBytes,
        `status=${byEmail.status} rows=${(byEmail.json?.data?.rows || []).length} uuid=${hit.uuid} known=${hit.knownInbounds}`);
      const byUuid = await request('GET', `/api/admin/node-clients?q=${nodeUuid}`, { cookies });
      check('v1.5.2 the same client is found by UUID',
        byUuid.status === 200 && (byUuid.json?.data?.rows || []).length === 1
          && (byUuid.json?.data?.rows || [])[0]?.email === nodeEmail,
        `rows=${(byUuid.json?.data?.rows || []).length}`);
      const byRemark = await request('GET', `/api/admin/node-clients?q=${encodeURIComponent('مشتری آماده')}`, { cookies });
      check('v1.5.2 the same client is found by its remark on the node',
        byRemark.status === 200 && (byRemark.json?.data?.rows || []).length === 1
          && (byRemark.json?.data?.rows || [])[0]?.email === nodeEmail,
        `rows=${(byRemark.json?.data?.rows || []).length}`);
      check('searching is read-only: not one write reached x-ui',
        writesSince(markSearch).length === 0 && routeCount(markSearch, '/clients/list') === 3,
        `writes=${writesSince(markSearch).join(',') || 'none'} lists=${routeCount(markSearch, '/clients/list')}`);
      const wrongNode = await request('GET', '/api/admin/node-clients?q=v152node&serverId=999999', { cookies });
      check('searching a node that does not exist is a clear 404',
        wrongNode.status === 404 && wrongNode.json?.error?.code === 'server_not_found',
        `status=${wrongNode.status} code=${wrongNode.json?.error?.code || '-'}`);
      const shopSearch = await request('GET', '/api/admin/node-clients?q=v152node', { cookies: ck52 });
      check('a reseller cannot search the nodes', shopSearch.status === 403, `status=${shopSearch.status}`);
      const nodeList = await request('GET', '/api/admin/nodes', { cookies });
      check('the search page gets its node filter from a light endpoint (no CPU probe, no token)',
        nodeList.status === 200 && (nodeList.json?.data?.rows || []).length >= 1
          && (nodeList.json?.data?.rows || []).every((row) => row.id > 0 && typeof row.name === 'string' && row.token === undefined),
        `rows=${(nodeList.json?.data?.rows || []).length}`);

      const markAdopt = mockXui.calls.length;
      const adopt = await request('POST', '/api/admin/configs/adopt', {
        cookies, csrf,
        body: {
          email: nodeEmail, userId: v52ShopId, serverId: primaryId,
          label: 'کانفیگ آماده', customerName: 'مشتری نود', customerPhone: '09120000000', note: 'از جست‌وجوی نود',
        },
      });
      const adoptData = adopt.json?.data || {};
      for (const id of adoptData.configs || []) v52Ids.push(Number(id));
      const adoptedRows = rowsOf(nodeEmail).filter((row) => Number(row.deleted_at) === 0);
      check('v1.5.2 the admin can hand an existing x-ui client to a reseller: one row per known channel',
        adopt.status === 201 && Number(adoptData.imported) === 2 && Number(adoptData.restored) === 0
          && adoptedRows.length === 2
          && adoptedRows.every((row) => row.origin === 'external' && Number(row.user_id) === v52ShopId)
          && new Set(adoptedRows.map((row) => row.sub_id)).size === 1
          && Number(adoptedRows[0].total_bytes) === nodeBytes
          && (adoptData.inbounds || []).join(',') === [inA, inB].join(','),
        `status=${adopt.status} code=${adopt.json?.error?.code || '-'} imported=${adoptData.imported} rows=${adoptedRows.length} origin=${adoptedRows[0]?.origin}`);
      check('adopting writes nothing to x-ui — the customer stays connected on the node',
        writesSince(markAdopt).length === 0 && mockXui.clients.has(nodeEmail),
        `writes=${writesSince(markAdopt).join(',') || 'none'}`);
      const shopList52 = await request('GET', `/api/reseller/configs?search=${encodeURIComponent(nodeEmail)}`, { cookies: ck52 });
      const shopPkg = (shopList52.json?.data?.rows || [])[0] || {};
      check('the adopted customer appears in the reseller’s own list as ONE package with both channels',
        shopList52.status === 200 && (shopList52.json?.data?.rows || []).length === 1
          && Number(shopPkg.groupCount) === 2 && (shopPkg.inbounds || []).length === 2,
        `rows=${(shopList52.json?.data?.rows || []).length} groupCount=${shopPkg.groupCount}`);
      const again52 = await request('POST', '/api/admin/configs/adopt', {
        cookies, csrf, body: { email: nodeEmail, userId: v52ShopId, serverId: primaryId },
      });
      check('adopting the same client twice adds nothing and keeps the same group token',
        again52.status === 201 && Number(again52.json?.data?.imported) === 0
          && Number(again52.json?.data?.restored) === 0 && Number(again52.json?.data?.alreadyHis) === 2
          && String(again52.json?.data?.groupToken) === String(adoptData.groupToken)
          && rowsOf(nodeEmail).filter((row) => Number(row.deleted_at) === 0).length === 2,
        `imported=${again52.json?.data?.imported} alreadyHis=${again52.json?.data?.alreadyHis}`);
      const stranger52 = await request('POST', '/api/admin/configs/adopt', {
        cookies, csrf, body: { email: nodeEmail, userId: v52OtherId, serverId: primaryId },
      });
      check('a client that already belongs to one reseller cannot be handed to another',
        stranger52.status === 409 && stranger52.json?.error?.code === 'config_owned_by_other',
        `status=${stranger52.status} code=${stranger52.json?.error?.code || '-'}`);
      const noImp52 = await request('POST', '/api/admin/configs/adopt', {
        cookies, csrf, body: { email: orphanEmail, userId: v52NoImpId, serverId: primaryId },
      });
      check('a reseller who switched adoption off is refused with the reason',
        noImp52.status === 409 && noImp52.json?.error?.code === 'import_disabled',
        `status=${noImp52.status} code=${noImp52.json?.error?.code || '-'}`);
      const missing52 = await request('POST', '/api/admin/configs/adopt', {
        cookies, csrf, body: { email: 'v152node-not-there', userId: v52ShopId, serverId: primaryId },
      });
      check('a client that is not on the node is a clear 404, not a silent empty import',
        missing52.status === 404 && missing52.json?.error?.code === 'xui_client_missing',
        `status=${missing52.status} code=${missing52.json?.error?.code || '-'}`);
      const orphan52 = await request('POST', '/api/admin/configs/adopt', {
        cookies, csrf, body: { email: orphanEmail, userId: v52ShopId, serverId: primaryId },
      });
      check('a client whose channels this panel does not know is refused instead of writing a row it cannot serve',
        orphan52.status === 422 && orphan52.json?.error?.code === 'no_known_inbound'
          && rowsOf(orphanEmail).length === 0,
        `status=${orphan52.status} code=${orphan52.json?.error?.code || '-'} rows=${rowsOf(orphanEmail).length}`);
      const shopAdopt52 = await request('POST', '/api/admin/configs/adopt', {
        cookies: ck52, csrf: cs52, body: { email: nodeEmail, userId: v52ShopId, serverId: primaryId },
      });
      check('a reseller cannot adopt a client for himself', shopAdopt52.status === 403, `status=${shopAdopt52.status}`);
      const markAdoptedDel = mockXui.calls.length;
      const delAdopted = await request('DELETE', `/api/admin/configs/${Number((adoptData.configs || [])[0] || 0)}/package`, { cookies, csrf });
      const adoptedDelData = delAdopted.json?.data || {};
      check('the one delete button on an adopted package only forgets it here — the other panel’s client stays',
        delAdopted.status === 200 && adoptedDelData.remoteDeleted === false
          && (adoptedDelData.localOnly || []).includes(nodeEmail)
          && writesSince(markAdoptedDel).length === 0 && mockXui.clients.has(nodeEmail),
        `status=${delAdopted.status} localOnly=${JSON.stringify(adoptedDelData.localOnly || [])} writes=${writesSince(markAdoptedDel).join(',') || 'none'}`);

      // ---- (3) the receipt flow, panel half
      const insertTopup52 = v52Db.prepare(
        `INSERT INTO topup_requests (user_id, amount, status, file_kind, file_id, caption, chat_id, message_id,
           admin_chat_id, admin_message_id, decided_by, decided_at, decision_note, source, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, 'فیش واریزی', ?, 0, '', 0, 0, 0, '', 'bot', ?, ?)`
      );
      const seedTopup = (userId, amount, kind = 'photo', fileId = 'selftest-file-id') => {
        const now = Date.now();
        const info = insertTopup52.run(Number(userId), Number(amount), kind, fileId, String(userId), now, now);
        const id = Number(info.lastInsertRowid);
        v52Topups.push(id);
        return id;
      };
      const balanceOf = (id) => Number(v52Db.prepare('SELECT balance FROM users WHERE id = ?').get(id)?.balance || 0);
      const txCount = (id) => Number(v52Db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?').get(id).c);
      const t1 = seedTopup(v52ShopId, 500000);
      const t2 = seedTopup(v52ShopId, 250000);
      const t3 = seedTopup(v52ShopId, 300000);
      const t4 = seedTopup(v52ShopId, 100000);
      const t5 = seedTopup(v52OtherId, 90000);
      const t6 = seedTopup(v52ShopId, 5000, '', '');

      const list52 = await request('GET', '/api/admin/topups?status=pending', { cookies });
      const listData52 = list52.json?.data || {};
      check('v1.5.2 the admin sees the receipts with counters and the bot state on the same page',
        list52.status === 200 && (listData52.rows || []).some((row) => Number(row.id) === t1)
          && Number(listData52.counts?.pending) >= 6 && typeof listData52.bot?.enabled === 'boolean'
          && (listData52.rows || []).every((row) => row.status === 'pending'),
        `status=${list52.status} pending=${listData52.counts?.pending} bot=${JSON.stringify(listData52.bot || {})}`);
      const before52 = balanceOf(v52ShopId);
      const txBefore52 = txCount(v52ShopId);
      const ok52 = await request('POST', `/api/admin/topups/${t1}/approve`, { cookies, csrf, body: { note: 'فیش بررسی شد' } });
      const okData52 = ok52.json?.data?.request || {};
      check('v1.5.2 approving a receipt credits the wallet exactly once',
        ok52.status === 200 && okData52.status === 'approved' && Number(okData52.credited) === 500000
          && balanceOf(v52ShopId) === before52 + 500000 && txCount(v52ShopId) === txBefore52 + 1,
        `status=${ok52.status} credited=${okData52.credited} balance=${balanceOf(v52ShopId)} tx=${txCount(v52ShopId) - txBefore52}`);
      const twice52 = await request('POST', `/api/admin/topups/${t1}/approve`, { cookies, csrf, body: {} });
      check('a second approve is refused and moves no money',
        twice52.status === 409 && twice52.json?.error?.code === 'already_decided'
          && balanceOf(v52ShopId) === before52 + 500000 && txCount(v52ShopId) === txBefore52 + 1,
        `status=${twice52.status} code=${twice52.json?.error?.code || '-'}`);
      const no52 = await request('POST', `/api/admin/topups/${t2}/reject`, { cookies, csrf, body: { note: 'مبلغ فیش نمی‌خواند' } });
      check('rejecting a receipt moves no money and keeps the reason',
        no52.status === 200 && no52.json?.data?.request?.status === 'rejected'
          && no52.json?.data?.request?.decisionNote === 'مبلغ فیش نمی‌خواند'
          && balanceOf(v52ShopId) === before52 + 500000 && txCount(v52ShopId) === txBefore52 + 1,
        `status=${no52.status} balance=${balanceOf(v52ShopId)}`);
      const corrected52 = await request('POST', `/api/admin/topups/${t3}/approve`, { cookies, csrf, body: { amount: 450000 } });
      check('the admin can correct the amount on the receipt before approving it',
        corrected52.status === 200 && Number(corrected52.json?.data?.request?.credited) === 450000
          && Number(corrected52.json?.data?.request?.amount) === 450000
          && balanceOf(v52ShopId) === before52 + 950000,
        `credited=${corrected52.json?.data?.request?.credited} balance=${balanceOf(v52ShopId)}`);
      const zero52 = await request('POST', `/api/admin/topups/${t4}/approve`, { cookies, csrf, body: { amount: 0 } });
      const huge52 = await request('POST', `/api/admin/topups/${t4}/approve`, { cookies, csrf, body: { amount: 5000000000 } });
      check('an impossible amount is refused and the receipt stays pending',
        zero52.status === 422 && huge52.status === 422
          && v52Db.prepare('SELECT status FROM topup_requests WHERE id = ?').get(t4)?.status === 'pending'
          && balanceOf(v52ShopId) === before52 + 950000,
        `zero=${zero52.status} huge=${huge52.status}`);
      const noReceipt52 = await request('GET', `/api/admin/topups/${t6}/receipt`, { cookies });
      check('a receipt without a file answers 404 instead of calling Telegram',
        noReceipt52.status === 404 && noReceipt52.json?.error?.code === 'no_receipt',
        `status=${noReceipt52.status} code=${noReceipt52.json?.error?.code || '-'}`);
      const mine52 = await request('GET', '/api/reseller/topups', { cookies: ck52 });
      const mineData52 = mine52.json?.data || {};
      const mineRows52 = mineData52.rows || [];
      check('v1.5.2 the reseller sees only his own receipts, with his live balance and his own counters',
        mine52.status === 200 && mineRows52.length === 5 && mineRows52.every((row) => Number(row.id) !== t5)
          && Number(mineData52.balance) === balanceOf(v52ShopId)
          && Number(mineData52.counts?.approved) === 2 && Number(mineData52.counts?.rejected) === 1
          && Number(mineData52.counts?.pending) === 2,
        `rows=${mineRows52.length} counts=${JSON.stringify(mineData52.counts || {})} balance=${mineData52.balance}`);
      check('the reseller payload carries no Telegram file id and no chat id',
        mineRows52.every((row) => row.fileId === undefined && row.chatId === undefined && row.adminChatId === undefined),
        `keys=${Object.keys(mineRows52[0] || {}).join(',')}`);
      const shopApprove52 = await request('POST', `/api/admin/topups/${t4}/approve`, { cookies: ck52, csrf: cs52, body: {} });
      const shopAdminList52 = await request('GET', '/api/admin/topups', { cookies: ck52 });
      check('a reseller can neither read the fleet’s receipts nor approve his own',
        shopApprove52.status === 403 && shopAdminList52.status === 403,
        `approve=${shopApprove52.status} list=${shopAdminList52.status}`);
      const notified52 = v52Db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title = 'موجودی شما افزایش یافت'").get(v52ShopId).c;
      check('every approved receipt told the reseller in his panel inbox',
        Number(notified52) === 2, `notifications=${notified52}`);

      // ---- the bot's own switches, from the settings card
      const tgBefore52 = (await request('GET', '/api/admin/settings', { cookies })).json?.data?.settings?.telegram || {};
      v52BotWas = { botEnabled: tgBefore52.botEnabled !== false, botAdminChatId: String(tgBefore52.botAdminChatId || '') };
      v52BotTouched = true;
      const botOff52 = await request('PATCH', '/api/admin/settings/telegram', {
        cookies, csrf, body: { botEnabled: false, botAdminChatId: '-100555000111' },
      });
      const botState52 = await request('GET', '/api/admin/bot', { cookies });
      const botData52 = botState52.json?.data || {};
      check('v1.5.2 the reseller-bot switch and the decision chat are savable from the panel',
        botOff52.status === 200 && botOff52.json?.data?.saved?.botEnabled === false
          && botOff52.json?.data?.saved?.botAdminChatId === '-100555000111'
          && botState52.status === 200 && botData52.enabled === false && botData52.adminChatId === '-100555000111',
        `patch=${botOff52.status} state=${botState52.status} enabled=${botData52.enabled} chat=${botData52.adminChatId}`);
      check('the bot token never travels back to the browser',
        botOff52.json?.data?.saved?.botToken === '' && botOff52.json?.data?.saved?.hasBotToken === true
          && botData52.botToken === undefined && botData52.hasToken === true,
        `saved=${JSON.stringify(botOff52.json?.data?.saved?.botToken)} hasToken=${botData52.hasToken}`);
      const badChat52 = await request('PATCH', '/api/admin/settings/telegram', { cookies, csrf, body: { botAdminChatId: 'not-a-chat' } });
      check('a non-numeric decision chat is refused', badChat52.status === 422 && badChat52.json?.error?.code === 'telegram_chat_id',
        `status=${badChat52.status} code=${badChat52.json?.error?.code || '-'}`);
      const botOn52 = await request('PATCH', '/api/admin/settings/telegram', {
        cookies, csrf, body: { botEnabled: true, botAdminChatId: '-100555000111' },
      });
      const botStateOn52 = await request('GET', '/api/admin/bot', { cookies });
      check('switching the bot back on needs no restart to be reflected in its state',
        botOn52.status === 200 && botStateOn52.json?.data?.enabled === true,
        `status=${botOn52.status} enabled=${botStateOn52.json?.data?.enabled}`);

      // ---- v1.5.3: the header chip and the panel's «افزایش موجودی از طریق ربات»
      // The reseller panel polls /reseller/balance every twenty seconds, so that
      // one query has to be cheap, honest about the currency, and impossible to
      // aim at another wallet. /reseller/bot is the link the wallet page shows:
      // it is built from getMe's cached username and must degrade to "no link"
      // instead of a broken t.me address or a 500.
      const seedBotName = (name) => v52Db.prepare(
        'INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run('bot_username', JSON.stringify(name), Date.now());
      const liveBal = await request('GET', '/api/reseller/balance', { cookies: ck52 });
      const liveData = liveBal.json?.data || {};
      const pendNow = Number(v52Db.prepare("SELECT COUNT(*) AS c FROM topup_requests WHERE user_id = ? AND status = 'pending'").get(v52ShopId).c);
      check('v1.5.3 /reseller/balance answers with the wallet the panel shows: money, currency, waiting receipts',
        liveBal.status === 200 && Number(liveData.balance) === balanceOf(v52ShopId)
          && typeof liveData.currency === 'string' && liveData.currency.length > 0
          && Number(liveData.pending) === pendNow && Number(liveData.updatedAt) > 0,
        `status=${liveBal.status} balance=${liveData.balance} pending=${liveData.pending} currency=${liveData.currency}`);
      const movedBal = await request('POST', `/api/admin/topups/${t4}/approve`, { cookies, csrf, body: { amount: 120000 } });
      const afterBal = await request('GET', '/api/reseller/balance', { cookies: ck52 });
      check('a receipt approved in the panel is in the chip on the next read — no reload, no cache',
        movedBal.status === 200 && afterBal.status === 200
          && Number(afterBal.json?.data?.balance) === balanceOf(v52ShopId)
          && Number(afterBal.json?.data?.balance) === Number(liveData.balance) + 120000
          && Number(afterBal.json?.data?.pending) === pendNow - 1,
        `after=${afterBal.json?.data?.balance} expected=${balanceOf(v52ShopId)}`);
      const adminBalance = await request('GET', '/api/reseller/balance', { cookies });
      const ownerRow53 = v52Db.prepare('SELECT balance FROM users WHERE username = ?').get(OWNER) || {};
      check('the same route never reaches across a wallet: an admin reads his own number, not the shop’s',
        adminBalance.status === 200 && Number(adminBalance.json?.data?.balance) === Number(ownerRow53.balance || 0)
          && Number(adminBalance.json?.data?.balance) !== Number(afterBal.json?.data?.balance),
        `admin=${adminBalance.json?.data?.balance} shop=${afterBal.json?.data?.balance}`);
      const noAuth53 = await request('GET', '/api/reseller/balance', {});
      check('an anonymous poller gets 401, not a balance', noAuth53.status === 401, `status=${noAuth53.status}`);

      seedBotName('selftest_bot');
      const resellerBot = await request('GET', '/api/reseller/bot', { cookies: ck52 });
      const rbData = resellerBot.json?.data || {};
      check('the wallet page can promise a bot link: t.me/<bot>?start=topup, built from getMe’s cached answer',
        resellerBot.status === 200 && rbData.enabled === true && rbData.botName === 'selftest_bot'
          && rbData.link === 'https://t.me/selftest_bot?start=topup'
          && rbData.receiptsLink === 'https://t.me/selftest_bot?start=receipts'
          && rbData.balanceLink === 'https://t.me/selftest_bot?start=balance',
        `link=${rbData.link} enabled=${rbData.enabled}`);
      const adminBot53 = await request('GET', '/api/admin/bot', { cookies });
      const abData = adminBot53.json?.data || {};
      check('the settings card shows the same username and link the reseller is sent to',
        adminBot53.status === 200 && abData.botName === 'selftest_bot'
          && abData.topupLink === 'https://t.me/selftest_bot?start=topup' && abData.commands === true
          && abData.botToken === undefined,
        `name=${abData.botName} link=${abData.topupLink}`);
      seedBotName('');
      const blankBot = await request('GET', '/api/reseller/bot', { cookies: ck52 });
      const bbData = blankBot.json?.data || {};
      check('before getMe has answered, the panel gets an empty link instead of a broken one — and no 500',
        blankBot.status === 200 && bbData.botName === '' && bbData.link === ''
          && bbData.receiptsLink === '' && bbData.enabled === true,
        `status=${blankBot.status} link="${bbData.link}"`);
      const adminBlank53 = await request('GET', '/api/admin/bot', { cookies });
      check('the admin card says the commands are not registered yet rather than claiming they are',
        adminBlank53.status === 200 && adminBlank53.json?.data?.topupLink === ''
          && adminBlank53.json?.data?.commands === false,
        `commands=${adminBlank53.json?.data?.commands}`);
      v52Db.prepare("DELETE FROM bot_state WHERE key = 'bot_username'").run();
    } finally {
      for (const id of v52Ids) v52Db.prepare('DELETE FROM usage_daily WHERE config_id = ?').run(id);
      for (const id of v52Ids) v52Db.prepare('DELETE FROM configs WHERE id = ?').run(id);
      for (const id of v52Topups) v52Db.prepare('DELETE FROM topup_requests WHERE id = ?').run(id);
      for (const shop of [v52ShopId, v52OtherId, v52NoImpId]) {
        if (!shop) continue;
        v52Db.prepare('DELETE FROM notifications WHERE user_id = ?').run(shop);
        v52Db.prepare('DELETE FROM sessions WHERE user_id = ?').run(shop);
        v52Db.prepare('DELETE FROM transactions WHERE user_id = ?').run(shop);
        v52Db.prepare('DELETE FROM topup_requests WHERE user_id = ?').run(shop);
        v52Db.prepare('DELETE FROM users WHERE id = ?').run(shop);
      }
      for (const email of v52Emails) mockXui.clients.delete(email);
      mockXui.quirks.failGet.clear();
      v52Db.close();
      if (v52BotTouched) {
        await request('PATCH', '/api/admin/settings/telegram', { cookies, csrf, body: v52BotWas });
      }
      if (v52LimitRaised) await request('PATCH', '/api/admin/settings/security', { cookies, csrf, body: { loginRateLimit: v52Limit } });
      if (v52Parked) await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 120 } });
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
      // «Ended today» is the panel day that is still running, so this fixture has
      // to land inside it. It used to say "one hour ago", which just after Tehran
      // midnight is YESTERDAY — the report then had nothing to count and this check
      // went red for a reason that was the test's, not the panel's. The midpoint of
      // the day so far is always past and always today, whatever the clock reads.
      const dayStartR = require('../src/utils').zonedDayStartMs(nowR);
      const endedAtR = dayStartR + Math.floor((nowR - dayStartR) / 2);
      rptDb.prepare('UPDATE configs SET expiry_at = ? WHERE id = ?').run(endedAtR, byName.get('RPT-ended'));
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

    // ═════════════════════════════════════════════════════════════════════ v1.5.4
    //
    // The four sentences of this release that only a running server can answer:
    // پلن‌های آماده (item 7), the payment-settings guards (items 2 and 3), the
    // gateway callback page that must never credit (item 2), and پورسانت paid out
    // of a real wallet debit (item 6). The maths behind the sweep, the gateway and
    // the commission percentage is test/payment.js; this block is about what the
    // routes will accept from a browser, where a client can type anything.
    {
      const brandName = require('../src/brand').PANEL_NAME;
      const pdb = new Database(path.join(DATA_DIR, 'panel.db'));
      const cfgOf = (id) => pdb.prepare('SELECT * FROM configs WHERE id = ?').get(Number(id)) || {};
      const txCount = (userId, type) => pdb
        .prepare('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND type = ?').get(Number(userId), String(type)).c;
      const GB = 1024 ** 3;
      const PLAN = { name: 'پلن آماده تست', description: 'دو کانال، حجم و زمان ثابت', gb: 20, days: 30, price: 600, inboundIds: [901, 902] };
      const merchantFake = 'c8e8f1a2-1111-4abc-9def-0123456789ab';
      // v1.5.5 retired the بلو link. A browser tab still open from 1.5.4 posts it
      // back with every save, so this is the value the route has to swallow without
      // storing, echoing or auditing it.
      const blueFake = 'https://blue.example/pay/selftest?amount={amount}';

      try {
        // ─────────────────────────────────────────────── writing a plan (item 7)
        const noName = await request('POST', '/api/admin/plans', { cookies, csrf, body: { ...PLAN, name: '' } });
        check('a plan without a name is refused, not stored as an empty row',
          noName.status === 422 && noName.json?.error?.code === 'plan_name_required', `code=${noName.json?.error?.code}`);
        const noChannel = await request('POST', '/api/admin/plans', { cookies, csrf, body: { ...PLAN, inboundIds: [] } });
        check('a plan with no channel cannot be written — there would be nothing to build',
          noChannel.status === 422 && noChannel.json?.error?.code === 'plan_needs_inbound', `code=${noChannel.json?.error?.code}`);
        const ghostInbound = await request('POST', '/api/admin/plans', { cookies, csrf, body: { ...PLAN, inboundIds: [999999] } });
        check('and it cannot name a channel the panel does not have',
          ghostInbound.status === 422 && ghostInbound.json?.error?.code === 'inbound_not_found', `code=${ghostInbound.json?.error?.code}`);
        const tooMany = await request('POST', '/api/admin/plans', {
          cookies, csrf, body: { ...PLAN, inboundIds: [901, 902, 903, 904, 905, 906, 907] },
        });
        check('one plan is capped at six channels',
          tooMany.status === 422 && tooMany.json?.error?.code === 'too_many_inbounds', `code=${tooMany.json?.error?.code}`);
        const badGb = await request('POST', '/api/admin/plans', { cookies, csrf, body: { ...PLAN, gb: 0 } });
        const badDays = await request('POST', '/api/admin/plans', { cookies, csrf, body: { ...PLAN, days: 0 } });
        check('a plan of no volume or no duration is a typo, not a product',
          badGb.json?.error?.code === 'invalid_plan_gb' && badDays.json?.error?.code === 'invalid_plan_days',
          `${badGb.json?.error?.code} / ${badDays.json?.error?.code}`);

        // A second server's channel, written straight to the table: the rule under
        // test is about the plan, not about how the row got there.
        pdb.prepare(
          `INSERT INTO inbounds (id, server_id, xui_id, node_id, node_name, remark, protocol, tag, port, network,
             security, listen, price_fixed, price_per_gb, price_per_day, enabled, visible, sub_sort_index, updated_at)
           VALUES (?, ?, ?, 0, 'elsewhere', ?, 'vless', ?, 1000, 'tcp', 'none', '', 0, 10, 0, 1, 1, 10, ?)`
        ).run(950, 9999, 950, 'Other panel', 'tag950', Date.now());
        const mixed = await request('POST', '/api/admin/plans', { cookies, csrf, body: { ...PLAN, inboundIds: [901, 950] } });
        check('a plan mixing two servers is refused while writing it, not while buying it',
          mixed.status === 422 && mixed.json?.error?.code === 'plan_server_mismatch', `code=${mixed.json?.error?.code}`);
        pdb.prepare('DELETE FROM inbounds WHERE id = 950').run();

        const made = await request('POST', '/api/admin/plans', { cookies, csrf, body: PLAN });
        const plan = made.json?.data?.plan || {};
        const planId = Number(plan.id || 0);
        check('the owner writes volume, duration, channels and HIS OWN price into one plan',
          made.status === 201 && planId > 0 && plan.gb === 20 && plan.days === 30 && plan.price === 600
            && JSON.stringify(plan.inboundIds) === JSON.stringify([901, 902]) && plan.inbounds.length === 2,
          `id=${planId} price=${plan.price} inbounds=${JSON.stringify(plan.inboundIds)}`);

        const hidden = await request('POST', '/api/admin/plans', {
          cookies, csrf, body: { ...PLAN, name: 'پلن تمرینی', visible: false },
        });
        const hiddenId = Number(hidden.json?.data?.plan?.id || 0);
        const adminPlans = await request('GET', '/api/admin/plans', { cookies });
        const shopPlans = await request('GET', '/api/reseller/plans', { cookies: shopCookies });
        const shopPlanIds = (shopPlans.json?.data?.plans || []).map((row) => Number(row.id));
        check('the shop window a reseller sees is the visible plans, and only his',
          adminPlans.json?.data?.plans?.some((row) => Number(row.id) === hiddenId) === true
            && shopPlanIds.includes(planId) && !shopPlanIds.includes(hiddenId),
          `reseller=${JSON.stringify(shopPlanIds)} hidden=${hiddenId}`);
        const buyHidden = await request('POST', '/api/reseller/plans/new', {
          cookies: shopCookies, csrf: shopCsrf, body: { planId: hiddenId, customerName: 'مشتری پنهان' },
        });
        check('a plan that is off the shelf cannot be bought even by its id',
          buyHidden.status === 409 && buyHidden.json?.error?.code === 'plan_not_available', `code=${buyHidden.json?.error?.code}`);

        // The eye button on the plans table sends nothing but {"visible": false}.
        // That is the one request shape a plan cannot answer by re-reading its own
        // stored row carelessly: inbound_ids is JSON *text* in the database, and
        // treating it as a list of ids turns '[1,2]' into one NaN, so the plan looks
        // channel-less and the save is refused with plan_needs_inbound.
        const offShelf = await request('PATCH', `/api/admin/plans/${planId}`, {
          cookies, csrf, body: { visible: false },
        });
        const offRow = offShelf.json?.data?.plan || {};
        check('flipping visibility alone is a save, not a request to rebuild the plan',
          offShelf.status === 200 && offRow.visible === 0 && JSON.stringify(offRow.inboundIds) === JSON.stringify([901, 902]),
          `status=${offShelf.status} code=${offShelf.json?.error?.code} inbounds=${JSON.stringify(offRow.inboundIds)}`);
        const afterHideShop = await request('GET', '/api/reseller/plans', { cookies: shopCookies });
        const hiddenIds = (afterHideShop.json?.data?.plans || []).map((row) => Number(row.id));
        check('and hiding it really takes it out of the shop window',
          !hiddenIds.includes(planId), `shop=${JSON.stringify(hiddenIds)}`);
        const backOnShelf = await request('PATCH', `/api/admin/plans/${planId}`, {
          cookies, csrf, body: { visible: true },
        });
        const backRow = backOnShelf.json?.data?.plan || {};
        const afterShowShop = await request('GET', '/api/reseller/plans', { cookies: shopCookies });
        check('one more click puts it back with the same channels and the same price',
          backOnShelf.status === 200 && backRow.visible === 1 && backRow.price === 600 && backRow.gb === 20
            && (afterShowShop.json?.data?.plans || []).some((row) => Number(row.id) === planId),
          `status=${backOnShelf.status} price=${backRow.price} gb=${backRow.gb}`);
        const partialEdit = await request('PATCH', `/api/admin/plans/${planId}`, {
          cookies, csrf, body: { name: 'پلن ویرایش جزئی' },
        });
        const partialRow = partialEdit.json?.data?.plan || {};
        check('a partial edit of one field leaves every other number of the plan alone',
          partialEdit.status === 200 && partialRow.name === 'پلن ویرایش جزئی' && partialRow.days === 30
            && partialRow.price === 600 && JSON.stringify(partialRow.inboundIds) === JSON.stringify([901, 902]),
          `status=${partialEdit.status} days=${partialRow.days} price=${partialRow.price}`);

        // ─────────────────────────────────── buying a plan: the price is the row's
        const shopTopup = await request('POST', `/api/admin/users/${shopId}/balance`, {
          cookies, csrf, body: { amount: 50000, description: 'شارژ پلن تست' },
        });
        const shopBefore = Number((await request('GET', '/api/auth/me', { cookies: shopCookies })).json?.data?.user?.balance || 0);
        check('the test wallet is funded', shopTopup.status === 200 && shopBefore > 5000, `balance=${shopBefore}`);

        const tariffQuote = await request('POST', '/api/reseller/configs/quote', {
          cookies: shopCookies, csrf: shopCsrf, body: { inboundIds: [901, 902], gb: 20, days: 30 },
        });
        const tariffTotal = Number(tariffQuote.json?.data?.total || 0);
        const planQuote = await request('POST', '/api/reseller/plans/quote', {
          cookies: shopCookies, csrf: shopCsrf, body: { planId },
        });
        const quoted = planQuote.json?.data || {};
        check('the plan quote prices the plan, and still shows what the tariff would have cost',
          planQuote.status === 200 && quoted.price === 600 && quoted.tariff === tariffTotal
            && quoted.saved === Math.max(0, tariffTotal - 600) && quoted.charged === true && quoted.sufficient === true,
          `price=${quoted.price} tariff=${quoted.tariff} saved=${quoted.saved}`);

        const forged = await request('POST', '/api/reseller/plans/new', {
          cookies: shopCookies, csrf: shopCsrf,
          body: { planId, customerName: 'مشتری پلنی', price: 1, gb: 999, days: 999, inboundIds: [903], charge: 0 },
        });
        const forgedCfg = (forged.json?.data?.configs || [])[0] || {};
        const shopAfterNew = Number((await request('GET', '/api/auth/me', { cookies: shopCookies })).json?.data?.user?.balance || 0);
        check('a reseller may type a price, a volume and a channel list; none of them is read',
          forged.status === 201 && forgedCfg.id > 0 && Number(cfgOf(forgedCfg.id).total_bytes) === 20 * GB
            && shopAfterNew === shopBefore - 600,
          `debit=${shopBefore - shopAfterNew} total_bytes=${cfgOf(forgedCfg.id).total_bytes}`);

        // The renewal is the owner's sentence: «کل مصرف و زمان کاربر ریست بشه این
        // پلن از نو برای اون مشتری اعمال شد». Usage is written straight to the
        // ledger rows — what a monitor tick would have done — so that zeroing it is
        // something the test can actually see happen.
        const renewId = Number(forgedCfg.id);
        pdb.prepare('UPDATE configs SET up_bytes = ?, down_bytes = ?, expiry_at = ? WHERE id = ?')
          .run(3 * GB, 2 * GB, Date.now() - 86400000, renewId);
        const preview = await request('POST', '/api/reseller/plans/renew/preview', {
          cookies: shopCookies, csrf: shopCsrf, body: { planId, configId: renewId },
        });
        check('the renewal drawer shows the plan’s fixed numbers next to what the customer has now',
          preview.status === 200 && preview.json?.data?.plan?.id === planId
            && preview.json?.data?.usable === true && Number(preview.json?.data?.configs?.[0]?.usedGb) > 0,
          `usable=${preview.json?.data?.usable} usedGb=${preview.json?.data?.configs?.[0]?.usedGb}`);
        const renewed = await request('POST', '/api/reseller/plans/renew', {
          cookies: shopCookies, csrf: shopCsrf, body: { planId, configId: renewId, gb: 999, days: 999, price: 1 },
        });
        const renewRow = cfgOf(renewId);
        const shopAfterRenew = Number((await request('GET', '/api/auth/me', { cookies: shopCookies })).json?.data?.user?.balance || 0);
        check('applying the plan again wipes his traffic and his expiry and gives him the plan',
          renewed.status === 200 && Number(renewRow.up_bytes) + Number(renewRow.down_bytes) === 0
            && Number(renewRow.total_bytes) === 20 * GB
            && Number(renewRow.expiry_at) > Date.now() + 29 * 86400000
            && shopAfterRenew === shopAfterNew - 600,
          `used=${Number(renewRow.up_bytes) + Number(renewRow.down_bytes)} expiry=${renewRow.expiry_at} debit=${shopAfterNew - shopAfterRenew}`);
        const poorPlan = await request('POST', '/api/admin/plans', {
          cookies, csrf, body: { ...PLAN, name: 'پلن گران', price: 900000 },
        });
        const poorId = Number(poorPlan.json?.data?.plan?.id || 0);
        const tooPoor = await request('POST', '/api/reseller/plans/new', {
          cookies: shopCookies, csrf: shopCsrf, body: { planId: poorId, customerName: 'بی‌پول' },
        });
        check('a plan he cannot afford is refused before x-ui is touched',
          tooPoor.status === 402 && tooPoor.json?.error?.code === 'insufficient_balance',
          `status=${tooPoor.status} code=${tooPoor.json?.error?.code}`);
        const ghostPlan = await request('POST', '/api/reseller/plans/quote', { cookies: shopCookies, csrf: shopCsrf, body: { planId: 987654 } });
        check('a plan id that is not in the shop says so', ghostPlan.status === 404, `status=${ghostPlan.status}`);
        // `entity_id` is a TEXT column and audit.js stores it with String(), so the
        // lookup must bind a string too — an integer bind never matches the row.
        const planAudit = pdb.prepare(
          "SELECT * FROM audit_logs WHERE action = 'plan.create' AND entity = 'plan' AND entity_id = ?"
        ).get(String(planId));
        check('every plan written is in the audit book with its price',
          Boolean(planAudit) && String(planAudit.details || '').includes('"price":600'),
          String(planAudit?.details || '').slice(0, 70));

        // ──────────────────────────────────────────────── پورسانت from a real sale
        const refUser = await request('POST', '/api/admin/users', {
          cookies, csrf,
          body: { username: 'payref', password: 'Pay-Ref-12345', name: 'معرف', role: 'reseller', max_configs: 10 },
        });
        const refId = Number(refUser.json?.data?.user?.id || 0);
        // The referrer's wallet is read from the database, not from a second
        // login: this suite is one browser session after another and
        // `security.loginRateLimit` would answer 429 long before this line,
        // turning a real payout into a balance of zero. The money is what the
        // ledger says it is, so that is where the test looks.
        const balOf = (userId) => Number(pdb.prepare('SELECT balance FROM users WHERE id = ?').get(Number(userId))?.balance || 0);
        const shopHandle = String(pdb.prepare('SELECT username FROM users WHERE id = ?').get(shopId)?.username || '');
        pdb.prepare('UPDATE users SET referrer_id = ? WHERE id = ?').run(refId, shopId);
        const commissionOn = await request('PATCH', '/api/admin/settings/billing', {
          cookies, csrf, body: { enabled: true, commissionPercent: 10, commissionCapPercent: 50 },
        });
        const refBefore = balOf(refId);
        const cBuyFrom = Number((await request('GET', '/api/auth/me', { cookies: shopCookies })).json?.data?.user?.balance || 0);
        const commissionBuy = await request('POST', '/api/reseller/plans/new', {
          cookies: shopCookies, csrf: shopCsrf, body: { planId, customerName: 'مشتری پورسانتی' },
        });
        const cBuyTo = Number((await request('GET', '/api/auth/me', { cookies: shopCookies })).json?.data?.user?.balance || 0);
        const refAfter = balOf(refId);
        check('the share of a sale is paid to the reseller who brought the buyer, in the same breath',
          commissionOn.status === 200 && commissionBuy.status === 201
            && cBuyFrom - cBuyTo === 600 && refAfter - refBefore === 60,
          `buyer paid ${cBuyFrom - cBuyTo}, referrer got ${refAfter - refBefore}`);
        check('and the payout is its own ledger line, not a silent number in a column',
          txCount(refId, 'commission') === 1, `rows=${txCount(refId, 'commission')}`);
        const refNotified = pdb.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'success'").get(refId).c;
        check('the referrer is told in his own panel that the money arrived', refNotified > 0, `notices=${refNotified}`);
        const refTopup = await request('POST', `/api/admin/users/${refId}/balance`, {
          cookies, csrf, body: { amount: 5000, description: 'شارژ مستقیم' },
        });
        check('crediting a wallet is not a sale: no commission is owed on a commission',
          refTopup.status === 200 && txCount(refId, 'commission') === 1, `rows=${txCount(refId, 'commission')}`);
        await request('PATCH', '/api/admin/settings/billing', { cookies, csrf, body: { commissionPercent: 0 } });
        const offFrom = balOf(refId);
        const offBuy = await request('POST', '/api/reseller/plans/new', {
          cookies: shopCookies, csrf: shopCsrf, body: { planId, customerName: 'مشتری بی‌پورسانت' },
        });
        const offTo = balOf(refId);
        check('switching the percentage to zero really stops the payout',
          offBuy.status === 201 && offTo === offFrom && txCount(refId, 'commission') === 1,
          `delta=${offTo - offFrom}`);
        const commissionLine = pdb.prepare(
          "SELECT * FROM transactions WHERE user_id = ? AND type = 'commission' ORDER BY id DESC LIMIT 1"
        ).get(refId) || {};
        check('and the ledger line says who paid, in whose name and on what basis',
          shopHandle.length > 0 && Number(commissionLine.amount) === 60
            && String(commissionLine.description || '').includes(shopHandle)
            && String(commissionLine.description || '').includes('600'),
          `amount=${commissionLine.amount} desc=${String(commissionLine.description || '').slice(0, 60)}`);

        // ────────────────────────────── the payment settings, from the owner’s form
        // v1.5.5, item 1: «دکمه روشن و خاموش کردن درگاه هارو هم بزار». A switch that
        // turns a method ON with nothing behind it is the dead button he complained
        // about, so each switch is guarded by what it needs — receipts need a card.
        // Turning anything OFF is never refused. The installed default is receipts-on
        // with an empty list, which the rail and the bot both call out honestly, so
        // the rule is about the edge the switch crosses: off → on.
        const receiptOff = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf, body: { receiptEnabled: false },
        });
        check('switching a method off is saved and never guarded',
          receiptOff.status === 200 && receiptOff.json?.data?.saved?.receiptEnabled === false,
          `status=${receiptOff.status} code=${receiptOff.json?.error?.code}`);
        const receiptNoCards = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf, body: { receiptEnabled: true },
        });
        check('the فیش واریزی switch refuses to come on while no card number is stored',
          receiptNoCards.status === 422 && receiptNoCards.json?.error?.code === 'receipt_not_configured',
          `code=${receiptNoCards.json?.error?.code} cards=${JSON.stringify((receiptNoCards.json?.data?.saved || {}).cards)}`);
        const oneCard = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf, body: { cards: [{ number: '6037 9977 8899 1234', holder: 'فروشگاه تست' }] },
        });
        check('a card number is accepted with its spaces and stored as digits',
          oneCard.status === 200 && (oneCard.json?.data?.saved?.cards || []).length === 1
            && String(oneCard.json?.data?.saved?.cards?.[0]?.number || '') === '6037997788991234',
          JSON.stringify(oneCard.json?.data?.saved?.cards));
        const badCard = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf, body: { cards: [{ number: '6037-99xx-8899-1234', holder: 'x' }] },
        });
        check('a card number with letters in it is refused rather than saved empty',
          badCard.status === 422 && badCard.json?.error?.code === 'invalid_cards', `code=${badCard.json?.error?.code}`);
        // v1.5.5: the guard is about the SWITCH, not about the list. Once receipts are
        // running the owner is entitled to take his last card number away — the method
        // then reports itself not-ready and says why, instead of the form refusing to
        // save and leaving a card on screen that no longer exists anywhere.
        const onWithCard = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf, body: { receiptEnabled: true, cards: [{ number: '6037997788991234', holder: 'فروشگاه تست' }] },
        });
        check('receipts switch on in the same save that supplies the card',
          onWithCard.status === 200 && onWithCard.json?.data?.saved?.receiptEnabled === true,
          `status=${onWithCard.status} code=${onWithCard.json?.error?.code}`);
        const lastCardGone = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf, body: { cards: [], receiptEnabled: true },
        });
        check('and emptying the card list while receipts run is saved, not refused',
          lastCardGone.status === 200 && (lastCardGone.json?.data?.saved?.cards || []).length === 0,
          `status=${lastCardGone.status} code=${lastCardGone.json?.error?.code}`);
        const noCardMethod = await request('GET', '/api/admin/payment/status', { cookies, csrf });
        check('the method then calls itself not-ready with its own reason',
          noCardMethod.json?.data?.methods?.receipt?.ready === false
            && noCardMethod.json?.data?.methods?.receipt?.reason === 'no_cards',
          JSON.stringify(noCardMethod.json?.data?.methods?.receipt || {}));
        await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf, body: { cards: [{ number: '6037997788991234', holder: 'فروشگاه تست' }] },
        });
        const noMerchant = await request('PATCH', '/api/admin/settings/payment', { cookies, csrf, body: { zarinpalEnabled: true } });
        check('the gateway cannot be switched on with no merchant id',
          noMerchant.status === 422 && noMerchant.json?.error?.code === 'zarinpal_not_configured', `code=${noMerchant.json?.error?.code}`);
        const badMerchant = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf, body: { zarinpalMerchantId: 'not-a-uuid' },
        });
        check('and a merchant id that is not a UUID is not a merchant id',
          badMerchant.status === 422 && badMerchant.json?.error?.code === 'invalid_merchant_id', `code=${badMerchant.json?.error?.code}`);
        const withMerchant = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf, body: { zarinpalMerchantId: merchantFake, zarinpalEnabled: true },
        });
        const savedPay = withMerchant.json?.data?.saved || {};
        check('the credential is saved but never comes back out of the settings API',
          withMerchant.status === 200 && savedPay.zarinpalMerchantId === '' && savedPay.hasZarinpalMerchantId === true,
          `merchant="${savedPay.zarinpalMerchantId}" has=${savedPay.hasZarinpalMerchantId}`);
        check('and it really is in the database encrypted, not in the clear',
          !String(pdb.prepare("SELECT value FROM settings WHERE key = 'payment'").get().value).includes(merchantFake));
        const staleBlue = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf, body: { blueEnabled: true, blueLink: blueFake, blueLabel: 'بلو بانک', autoApproveCard: true },
        });
        check('a 1.5.4 tab posting the retired بلو keys saves fine and stores none of them',
          staleBlue.status === 200
            && staleBlue.json?.data?.saved?.blueEnabled === undefined
            && staleBlue.json?.data?.saved?.blueLink === undefined
            && staleBlue.json?.data?.saved?.hasBlueLink === undefined
            && staleBlue.json?.data?.saved?.autoApproveCard === undefined,
          JSON.stringify(Object.keys(staleBlue.json?.data?.saved || {}).filter((k) => /blue|card/i.test(k))));
        check('the retired values never reach the database row either, not even as an empty box',
          !/blueLink|blueEnabled|blueLabel|autoApproveCard/
            .test(String(pdb.prepare("SELECT value FROM settings WHERE key = 'payment'").get().value)));
        check('and the audit entry names only the keys the panel actually wrote',
          (() => {
            const row = pdb.prepare("SELECT details FROM audit_logs WHERE action = 'settings.update' ORDER BY id DESC LIMIT 1").get() || {};
            const keys = JSON.parse(String(row.details || '{}')).keys || [];
            return Array.isArray(keys) && !keys.some((k) => /blue|autoApproveCard/.test(String(k)));
          })(),
          String((pdb.prepare("SELECT details FROM audit_logs WHERE action = 'settings.update' ORDER BY id DESC LIMIT 1").get() || {}).details || '').slice(0, 120));
        const noCeiling = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf, body: { autoApproveEnabled: true, autoApproveMaxAmount: 0, autoApproveReceipt: true },
        });
        check('auto-approval cannot be released with no money ceiling',
          noCeiling.status === 422 && noCeiling.json?.error?.code === 'auto_approve_ceiling_required', `code=${noCeiling.json?.error?.code}`);
        const noMethod = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf, body: { autoApproveEnabled: true, autoApproveMaxAmount: 50000, autoApproveReceipt: false },
        });
        check('nor with neither method chosen',
          noMethod.status === 422 && noMethod.json?.error?.code === 'auto_approve_no_method', `code=${noMethod.json?.error?.code}`);
        const sweepOn = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf, body: { autoApproveEnabled: true, autoApproveMaxAmount: 50000, autoApproveReceipt: true, autoApproveAfterMinutes: 15 },
        });
        check('with a ceiling and one method the schedule is on',
          sweepOn.status === 200 && sweepOn.json?.data?.saved?.autoApproveEnabled === true,
          `status=${sweepOn.status}`);
        // The admin tab posts the WHOLE payment object on every save, and the two
        // secret boxes are always empty inside it — they come back redacted. So the
        // guards above have to read a blank secret as "unchanged" exactly the way the
        // write does, or the tab becomes unsavable for good the moment a real
        // credential is stored: every later save, even one that only sets a ceiling,
        // would be refused for a merchant id the panel already has.
        const rawPayBefore = String(pdb.prepare("SELECT value FROM settings WHERE key = 'payment'").get().value);
        const formShape = {
          cards: [{ number: '6037997788991234', holder: 'فروشگاه تست' }],
          zarinpalEnabled: true, zarinpalMerchantId: '', zarinpalSandbox: true,
          receiptEnabled: true,
        };
        const blankFormNoCeiling = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf,
          body: { ...formShape, autoApproveEnabled: true, autoApproveMaxAmount: 0, autoApproveReceipt: true },
        });
        check('a save posting the redacted blanks is refused for its ceiling, not for a merchant id it already has',
          blankFormNoCeiling.status === 422 && blankFormNoCeiling.json?.error?.code === 'auto_approve_ceiling_required',
          `code=${blankFormNoCeiling.json?.error?.code}`);
        const blankForm = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf,
          body: { ...formShape, autoApproveEnabled: true, autoApproveMaxAmount: 50000, autoApproveReceipt: true },
        });
        const rawPayAfter = String(pdb.prepare("SELECT value FROM settings WHERE key = 'payment'").get().value);
        // A save re-encrypts the section, and every secret is sealed with a fresh
        // random IV, so the CIPHERTEXT of an untouched credential changes on every
        // save. Comparing the stored bytes would have failed on correct behaviour.
        // What has to survive is the plaintext the panel reads back — so the proof
        // decrypts both rows and never looks at the seal.
        const reveal = require('../src/crypto').decryptSecret;
        const merchantKept = reveal(String(JSON.parse(rawPayAfter).zarinpalMerchantId || ''));
        check('and the same save goes through without erasing the one credential that exists',
          blankForm.status === 200 && blankForm.json?.data?.saved?.hasZarinpalMerchantId === true
            && merchantKept === merchantFake && !rawPayAfter.includes(merchantFake)
            && !rawPayAfter.includes(blueFake),
          JSON.stringify({
            status: blankForm.status, code: blankForm.json?.error?.code,
            merchantKept: merchantKept === merchantFake,
            stillSealed: String(JSON.parse(rawPayAfter).zarinpalMerchantId || '').startsWith('enc1:'),
            sealRotated: JSON.parse(rawPayAfter).zarinpalMerchantId
              !== JSON.parse(rawPayBefore).zarinpalMerchantId,
          }));
        const methodsR = await request('GET', '/api/reseller/payments/methods', { cookies: shopCookies });
        const methodsData = methodsR.json?.data || {};
        check('the reseller’s wallet page is built from what the owner actually configured',
          methodsR.status === 200 && (methodsData.cards || []).length === 1
            && methodsData.receipt?.enabled === true && methodsData.receipt?.ready === true
            && methodsData.zarinpal?.enabled === true,
          JSON.stringify({ cards: (methodsData.cards || []).length, receipt: methodsData.receipt?.ready, zp: methodsData.zarinpal?.enabled }));
        check('and it carries no بلو entry for the reseller to click',
          !('blue' in methodsData) && !('cardToCard' in methodsData) && !('card' in methodsData),
          Object.keys(methodsData).sort().join(','));
        const blueLinkR = await request('GET', '/api/reseller/payments/blue?amount=500', { cookies: shopCookies });
        check('the old بلو endpoint answers 404 rather than a link to a dead page',
          blueLinkR.status === 404, `status=${blueLinkR.status}`);
        const cardRouteR = await request('POST', '/api/reseller/payments/claim', {
          cookies: shopCookies, csrf: shopCsrf, body: { method: 'card', amount: 5000 },
        });
        check('card-to-card is closed as a route too, with the two live methods named',
          cardRouteR.status === 422 && cardRouteR.json?.error?.code === 'method_removed'
            && /فیش واریزی/.test(String(cardRouteR.json?.error?.message || '')),
          `code=${cardRouteR.json?.error?.code} status=${cardRouteR.status}`);
        const viaClaim = await request('POST', '/api/reseller/payments/claim', {
          cookies: shopCookies, csrf: shopCsrf, body: { method: 'zarinpal', amount: 5000 },
        });
        check('the claim form is not a shortcut into the gateway',
          viaClaim.status === 422 && viaClaim.json?.error?.code === 'use_gateway', `code=${viaClaim.json?.error?.code}`);
        const wrongCard = await request('POST', '/api/reseller/payments/claim', {
          cookies: shopCookies, csrf: shopCsrf, body: { method: 'receipt', amount: 5000, cardNumber: '1111111111111111' },
        });
        check('he cannot name a card the owner never typed',
          wrongCard.status === 422 && wrongCard.json?.error?.code === 'unknown_card', `code=${wrongCard.json?.error?.code}`);
        const hisClaim = await request('POST', '/api/reseller/payments/claim', {
          cookies: shopCookies, csrf: shopCsrf, body: { method: 'receipt', amount: 5000, cardNumber: '6037-9977-8899-1234' },
        });
        const claimRow = hisClaim.json?.data?.request || hisClaim.json?.data || {};
        check('a receipt that names one of his published cards is filed, and waits for a person',
          hisClaim.status < 300 && String(claimRow.status || '') === 'pending' && Number(claimRow.amount) === 5000
            && String(claimRow.cardNumber || '') === '6037997788991234' && claimRow.method === 'receipt',
          `status=${claimRow.status} card=${claimRow.cardNumber} id=${claimRow.id}`);

        // ───────────────────────────────── the schedule, run from the admin screen
        const oldClaimId = Number(claimRow.id || 0);
        pdb.prepare('UPDATE topup_requests SET created_at = ?, updated_at = ? WHERE id = ?')
          .run(Date.now() - 20 * 60000, Date.now() - 20 * 60000, oldClaimId);
        const paidBefore = Number((await request('GET', '/api/auth/me', { cookies: shopCookies })).json?.data?.user?.balance || 0);
        const runSweep = await request('POST', '/api/admin/topups/auto-approve/run', { cookies, csrf, body: {} });
        const paidAfter = Number((await request('GET', '/api/auth/me', { cookies: shopCookies })).json?.data?.user?.balance || 0);
        check('the admin can run the schedule himself and see what it released',
          runSweep.status === 200 && paidAfter === paidBefore + 5000
            && String(pdb.prepare('SELECT status FROM topup_requests WHERE id = ?').get(oldClaimId).status) === 'approved',
          `approved=${runSweep.json?.data?.approved} balance=${paidBefore}→${paidAfter}`);
        check('an automatic decision is booked to the system, never borrowed from an admin',
          Number(pdb.prepare('SELECT decided_by FROM topup_requests WHERE id = ?').get(oldClaimId).decided_by) === 0);

        // ─────────────────────────────────── the gateway callback: talk to the hand
        const noAuthority = await request('GET', '/api/payments/zarinpal/callback', {});
        check('a callback with no tracking code says so and pays nothing',
          noAuthority.status === 400 && noAuthority.json?.ok !== true);
        const forgedCallback = await request('GET', '/api/payments/zarinpal/callback?Authority=AUTH-FORGED', {});
        check('a callback naming a code this panel never issued is refused — nothing is credited',
          forgedCallback.status === 404 && /پیدا نشد/.test(forgedCallback.raw || ''),
          `status=${forgedCallback.status}`);
        const zpOrder = await request('POST', '/api/reseller/payments/claim', {
          cookies: shopCookies, csrf: shopCsrf, body: { method: 'receipt', amount: 12000 },
        });
        const zpId = Number((zpOrder.json?.data?.request || zpOrder.json?.data || {}).id || 0);
        pdb.prepare("UPDATE topup_requests SET method = 'zarinpal', reference = 'AUTH-SELFTEST' WHERE id = ?").run(zpId);
        const balanceAtCancel = Number((await request('GET', '/api/auth/me', { cookies: shopCookies })).json?.data?.user?.balance || 0);
        const cancelled = await request('GET', '/api/payments/zarinpal/callback?Authority=AUTH-SELFTEST&Status=FAIL', {});
        const zpNow = pdb.prepare('SELECT status FROM topup_requests WHERE id = ?').get(zpId) || {};
        const balanceAfterCancel = Number((await request('GET', '/api/auth/me', { cookies: shopCookies })).json?.data?.user?.balance || 0);
        check('the bank saying “he did not pay” is believed: the order stays pending and no money moves',
          cancelled.status === 200 && /انجام نشد/.test(cancelled.raw || '') && String(zpNow.status) === 'pending'
            && balanceAfterCancel === balanceAtCancel,
          `status=${zpNow.status} balance=${balanceAtCancel}→${balanceAfterCancel}`);

        // ────────────────────────────── the brand on the wire, and the fresh schema
        const renamed = await request('PATCH', '/api/admin/settings/general', {
          cookies, csrf, body: { panelName: 'پنل دیگری' },
        });
        check('the settings route cannot rename the panel even for an admin',
          renamed.status === 200 && renamed.json?.data?.saved?.panelName === brandName,
          `panelName=${renamed.json?.data?.saved?.panelName}`);
        check('and the name is not what the database says it is',
          String(JSON.parse(pdb.prepare("SELECT value FROM settings WHERE key = 'general'").get().value).panelName) === brandName);
        const tables = pdb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
        const planCols = pdb.prepare('PRAGMA table_info(plans)').all().map((row) => row.name);
        check('a fresh install carries the two new tables this release needs',
          tables.includes('plans') && tables.includes('topup_requests') && planCols.includes('price')
            && planCols.includes('inbound_ids') && planCols.includes('visible') && planCols.includes('server_id'),
          `tables=${tables.length} planCols=${planCols.length}`);
        // v1.5.8: plan_purchases is the twentieth table, and plans grew the three
        // shelf columns (category / per_user_limit / allowed_users).
        // v2.1.0 adds two more: config_trash (the admin Trash) and activation
        // (the male/female key gate), so a fresh install now carries 22 tables.
        check('v1.5.8 adds the take-ledger beside the nineteen tables of 1.5.4',
          tables.length === 22 && tables.includes('plan_purchases') && tables.includes('config_trash')
            && tables.includes('activation')
            && planCols.includes('category') && planCols.includes('per_user_limit') && planCols.includes('allowed_users'),
          tables.join(','));

        await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf,
          body: { zarinpalEnabled: false, receiptEnabled: false, autoApproveEnabled: false, autoApproveReceipt: false, cards: [] },
        });
        await request('PATCH', '/api/admin/settings/billing', { cookies, csrf, body: { commissionPercent: 0, commissionCapPercent: 50 } });
        pdb.prepare('UPDATE users SET referrer_id = 0 WHERE id = ?').run(shopId);
      } finally {
        pdb.close();
      }
    }

    // ═════════════════════════════════════════════════════════════════════ v1.5.5
    //
    // Items 4 and 5 — the two that cannot be proven from one table alone.
    //
    // A package is the group CONFIG_GROUP_KEY_SQL builds, and that key carries
    // user_id, so a transfer that rewrote only the row the admin clicked would
    // leave ONE subscription with two owners and two quotas. Item 5 writes the
    // برچسب where the node can see it: the x-ui client's own `comment`. The mock
    // keeps every client it was handed, so `mockXui.clients` is the node's answer
    // and panel.db is ours — the checks below read the same fact from both sides
    // and refuse a release where they disagree.
    {
      const tdb = new Database(path.join(DATA_DIR, 'panel.db'));
      const P25 = 'Move-Pass-12345';
      const LABEL25 = 'برچسب جابه‌جایی';
      const NAME25 = 'مشتری انتقالی';
      const PHONE25 = '09120000000';
      const LINE25 = (label) => `${label} | ${NAME25} | ${PHONE25}`;
      const cfg25 = (id) => tdb.prepare('SELECT * FROM configs WHERE id = ?').get(Number(id)) || {};
      const rowsOf25 = (email) => tdb.prepare('SELECT * FROM configs WHERE email = ? ORDER BY id').all(String(email));
      const live25 = (userId) => Number(tdb.prepare(
        'SELECT COUNT(*) AS c FROM configs WHERE user_id = ? AND deleted_at = 0'
      ).get(Number(userId)).c);
      const booked25 = (userId) => Number(tdb.prepare(
        'SELECT COUNT(*) AS c FROM usage_daily WHERE user_id = ?'
      ).get(Number(userId)).c);
      const money25 = (userId) => Number(tdb.prepare('SELECT balance FROM users WHERE id = ?').get(Number(userId))?.balance || 0);
      const tx25 = (userId) => Number(tdb.prepare('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?').get(Number(userId)).c);
      const notes25 = (userId, title) => tdb.prepare(
        'SELECT * FROM notifications WHERE user_id = ? AND title = ?'
      ).all(Number(userId), String(title));
      const onNode25 = (email) => String(mockXui.clients.get(String(email))?.comment || '');
      const pushCalls25 = (email) => mockXui.calls.filter((call) => call.route === `/clients/update/${email}`).length;
      const code25 = (res) => String(res.json?.error?.code || '');
      const dayKey25 = (ts) => new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(ts));
      const mkUser25 = async (username, extra = {}) => {
        const created = await request('POST', '/api/admin/users', {
          cookies, csrf, body: { username, password: P25, role: 'reseller', balance: 0, ...extra },
        });
        return { id: Number(created.json?.data?.user?.id || 0), status: created.status };
      };
      const login25 = async (username) => {
        const res = await request('POST', '/api/auth/login', { body: { username, password: P25 } });
        return { status: res.status, cookies: cookiesFrom(res.headers), csrf: res.json?.data?.csrf };
      };
      const move25 = (id, body, who) => request('POST', `/api/admin/configs/${id}/transfer`, {
        ...(who || { cookies, csrf }), body,
      });

      let limit25 = 10;
      let lifted25 = false;
      let parked25 = false;
      try {
        // One browser session after another, all from 127.0.0.1: five reseller
        // logins would sit in the limiter's basket and come back 429, which a
        // later check would read as «the reseller cannot do it». Same lift-and-
        // restore the other blocks use.
        const secRead25 = await request('GET', '/api/admin/settings', { cookies });
        limit25 = Number(secRead25.json?.data?.settings?.security?.loginRateLimit || 10);
        lifted25 = (await request('PATCH', '/api/admin/settings/security', {
          cookies, csrf, body: { loginRateLimit: 100 },
        })).status === 200;
        // A sync landing between two of these checks would rewrite the node's
        // client and the counters under them.
        parked25 = (await request('PATCH', '/api/admin/settings/monitor', {
          cookies, csrf, body: { intervalSec: 3600 },
        })).status === 200;

        const src25 = await mkUser25('movesrc');
        const dst25 = await mkUser25('movedst');
        const capped25 = await mkUser25('movecapped', { max_configs: 1 });
        const off25 = await mkUser25('moveoff');
        const perm25 = await mkUser25('moveperm');
        const clash25 = await mkUser25('moveclash');
        const srcSess25 = await login25('movesrc');
        const dstSess25 = await login25('movedst');
        const permSess25 = await login25('moveperm');
        const srcId25 = src25.id;
        const dstId25 = dst25.id;
        check('v1.5.5 the fixtures exist: six resellers, three of them signed in, the monitor parked',
          [srcId25, dst25.id, capped25.id, off25.id, perm25.id, clash25.id].every((id) => id > 0)
            && srcSess25.status === 200 && dstSess25.status === 200 && permSess25.status === 200
            && lifted25 && parked25,
          `src=${srcId25} dst=${dstId25} login=${srcSess25.status}/${dstSess25.status}/${permSess25.status}`);

        // ───────────────────────────────── item 5: the برچسب the node has to carry
        const build25 = await request('POST', '/api/admin/configs', {
          cookies, csrf,
          body: {
            userId: srcId25, inboundIds: [901, 902], gb: 10, days: 30,
            label: LABEL25, customerName: NAME25, customerPhone: PHONE25,
          },
        });
        const built25 = build25.json?.data?.configs || [];
        const pkgId25 = Number(built25[0]?.id || 0);
        const pkgEmail25 = String(built25[0]?.email || '');
        check('v1.5.5 a new package is ONE x-ui client whose comment is the label line',
          build25.status === 201 && built25.length === 2
            && built25.every((row) => String(row.email || '') === pkgEmail25)
            && onNode25(pkgEmail25) === LINE25(LABEL25),
          `rows=${built25.length} node="${onNode25(pkgEmail25)}"`);

        const renamed25 = await request('PATCH', `/api/admin/configs/${pkgId25}`, {
          cookies, csrf, body: { label: 'برچسب تازه' },
        });
        const sync25 = renamed25.json?.data?.config?.commentSync || {};
        check('v1.5.5 renaming the label pushes the new line to the node and says that it did',
          renamed25.status === 200 && sync25.pushed === true
            && onNode25(pkgEmail25) === LINE25('برچسب تازه')
            && pushCalls25(pkgEmail25) === 1,
          `pushed=${sync25.pushed} node="${onNode25(pkgEmail25)}"`);
        check('and every channel of the package carries the new label, not only the row clicked',
          rowsOf25(pkgEmail25).length === 2
            && rowsOf25(pkgEmail25).every((row) => String(row.label) === 'برچسب تازه'),
          rowsOf25(pkgEmail25).map((row) => row.label).join(' / '));

        // The node is told only when the IDENTITY changed. A remark about a
        // channel has nowhere to go on x-ui, so this save must not call it at all.
        const noteOnly25 = await request('PATCH', `/api/admin/configs/${pkgId25}`, {
          cookies, csrf, body: { note: 'یادداشت مدیر' },
        });
        check('a note alone is not an identity change: it is saved and the node is not called',
          noteOnly25.status === 200 && noteOnly25.json?.data?.config?.commentSync?.pushed === false
            && pushCalls25(pkgEmail25) === 1 && String(cfg25(pkgId25).note) === 'یادداشت مدیر',
          `pushed=${noteOnly25.json?.data?.config?.commentSync?.pushed} calls=${pushCalls25(pkgEmail25)}`);

        // ─────────────────────────────── what an unreachable node must NOT cost
        const clientBack25 = mockXui.clients.get(pkgEmail25);
        mockXui.clients.delete(pkgEmail25);
        const whileGone25 = await request('PATCH', `/api/admin/configs/${pkgId25}`, {
          cookies, csrf, body: { label: 'برچسب غایب' },
        });
        const syncGone25 = whileGone25.json?.data?.config?.commentSync || {};
        check('a client that is not on the node costs nobody the text he typed: the save stands',
          whileGone25.status === 200 && syncGone25.pushed === false
            && syncGone25.reason === 'client_missing' && String(cfg25(pkgId25).label) === 'برچسب غایب',
          `pushed=${syncGone25.pushed} reason=${syncGone25.reason} label=${cfg25(pkgId25).label}`);

        // Rebuild is the third door into the same sentence (item 5 names create,
        // edit and — implicitly — the restore the owner already uses).
        const rebuilt25 = await request('POST', `/api/admin/configs/${pkgId25}/recreate`, {
          cookies, csrf, body: {},
        });
        check('and a rebuilt subscription carries the same label line as the panel still has',
          rebuilt25.status === 200 && onNode25(pkgEmail25) === LINE25('برچسب غایب'),
          `status=${rebuilt25.status} node="${onNode25(pkgEmail25)}"`);

        // x-ui's own field width, not ours: three 80/80/32 fields would be 198.
        const long25 = await request('PATCH', `/api/admin/configs/${pkgId25}`, {
          cookies, csrf,
          body: { label: 'ل'.repeat(90), customerName: 'ن'.repeat(90), customerPhone: '0'.repeat(40) },
        });
        const cappedComment25 = onNode25(pkgEmail25);
        check('the line is cut to the width the node panel actually has, not past it',
          long25.status === 200 && cappedComment25.length === 120
            && rowsOf25(pkgEmail25).every((row) => String(row.label).length === 80),
          `nodeLen=${cappedComment25.length} labelLen=${String(cfg25(pkgId25).label).length}`);
        await request('PATCH', `/api/admin/configs/${pkgId25}`, {
          cookies, csrf, body: { label: LABEL25, customerName: NAME25, customerPhone: PHONE25 },
        });

        // Someone else's customer is not editable through the reseller door, and
        // an edit that got that far would have rewritten a node client he does not
        // own. The label the owner just typed has to still be the one on the node.
        const otherTry25 = await request('PATCH', `/api/reseller/configs/${pkgId25}`, {
          cookies: permSess25.cookies, csrf: permSess25.csrf, body: { label: 'دست‌نخورده' },
        });
        check('a reseller cannot relabel another reseller’s customer, on the node or off it',
          otherTry25.status >= 400 && onNode25(pkgEmail25) === LINE25(LABEL25),
          `status=${otherTry25.status} code=${code25(otherTry25)} node="${onNode25(pkgEmail25)}"`);

        // ────────────────────────────────────── item 4: moving the customer over
        const asReseller25 = await move25(pkgId25, { toUserId: dstId25 }, srcSess25);
        check('v1.5.5 only the admin can move a customer: the reseller’s own session is refused',
          asReseller25.status === 403, `status=${asReseller25.status} code=${code25(asReseller25)}`);

        const preview25 = await move25(pkgId25, { toUserId: dstId25, dryRun: true });
        const pv25 = preview25.json?.data || {};
        check('the dialog first asks what WILL move, and a dry run that moves nothing is the point',
          preview25.status === 200 && pv25.dryRun === true && pv25.moved === 0
            && (pv25.rows || []).length === 2 && (pv25.inbounds || []).length === 2
            && pv25.totalGb === 10 && pv25.fromReseller === 'movesrc' && pv25.toReseller === 'movedst'
            && Number(cfg25(pkgId25).user_id) === srcId25 && live25(dstId25) === 0,
          JSON.stringify({ moved: pv25.moved, rows: (pv25.rows || []).length, gb: pv25.totalGb, owner: cfg25(pkgId25).user_id }));

        // One reseller is switched off: «he cannot take a customer» is a
        // different answer from «he does not exist», and the panel must say which.
        const offR25 = await request('PATCH', `/api/admin/users/${off25.id}`, {
          cookies, csrf, body: { status: 'disabled' },
        });
        const refusal25 = await Promise.all([
          move25(pkgId25, {}),
          move25(pkgId25, { toUserId: 999999 }),
          move25(pkgId25, { toUserId: 1 }),
          move25(pkgId25, { toUserId: off25.id }),
        ]);
        const codes25 = refusal25.map((res) => `${res.status}:${code25(res)}`);
        check('four wrong targets are four different answers, and none of them moves a row',
          offR25.status === 200 && codes25[0] === '422:reseller_required' && codes25[1] === '404:user_not_found'
            && codes25[2] === '409:target_is_admin' && codes25[3] === '409:reseller_inactive'
            && Number(cfg25(pkgId25).user_id) === srcId25,
          codes25.join(' '));

        // v2.4.0: channel permission controls NEW orders, not an ownership move.
        // A hidden channel with no grant must not block the transfer preview or
        // the real hand-over; a partial grant is equally irrelevant.
        const grant25 = async (ids) => (await request('PATCH', `/api/admin/users/${perm25.id}`, {
          cookies, csrf, body: { allowed_inbounds: ids },
        })).status === 200;
        tdb.prepare('UPDATE inbounds SET visible = 0 WHERE id IN (901, 902)').run();
        const granted0 = await grant25([903]);
        const previewBlocked25 = await move25(pkgId25, { toUserId: perm25.id, dryRun: true });
        const movedNoGrant25 = await move25(pkgId25, { toUserId: perm25.id });
        check('v2.4.0 a target with no grant for these channels can preview and receive the whole package',
          granted0 && previewBlocked25.status === 200 && previewBlocked25.json?.data?.moved === 0
            && movedNoGrant25.status === 200 && movedNoGrant25.json?.data?.moved === 2
            && rowsOf25(pkgEmail25).every((row) => Number(row.user_id) === perm25.id),
          `preview=${previewBlocked25.status} moved=${movedNoGrant25.status}:${code25(movedNoGrant25)}`);
        const granted1 = await grant25([901]);
        const movedHalfGrant25 = await move25(pkgId25, { toUserId: srcId25 });
        const returnedHalfGrant25 = await move25(pkgId25, { toUserId: perm25.id });
        check('a partial grant changes nothing: ownership can move in both directions',
          granted1 && movedHalfGrant25.status === 200 && returnedHalfGrant25.status === 200
            && rowsOf25(pkgEmail25).every((row) => Number(row.user_id) === perm25.id),
          `back=${movedHalfGrant25.status}:${code25(movedHalfGrant25)} again=${returnedHalfGrant25.status}:${code25(returnedHalfGrant25)}`);
        const granted2 = await grant25([901, 902]);
        const returnedFullGrant25 = await move25(pkgId25, { toUserId: srcId25 });
        tdb.prepare('UPDATE inbounds SET visible = 1 WHERE id IN (901, 902)').run();
        check('putting the channels back in view still puts the customer back where he started',
          granted2 && returnedFullGrant25.status === 200 && Number(cfg25(pkgId25).user_id) === srcId25 && live25(perm25.id) === 0,
          `status=${returnedFullGrant25.status} owner=${cfg25(pkgId25).user_id}`);

        // His caps are checked too, so a move cannot smuggle past max_configs.
        const cappedBuild25 = await request('POST', '/api/admin/configs', {
          cookies, csrf, body: { userId: capped25.id, inboundIds: [903], gb: 5, days: 10, customerName: 'سقف' },
        });
        const overLimit25 = await move25(pkgId25, { toUserId: capped25.id });
        check('and a reseller at his config ceiling cannot be handed a customer either',
          cappedBuild25.status === 201 && live25(capped25.id) === 1
            && overLimit25.status === 403 && code25(overLimit25) === 'limit_configs'
            && Number(cfg25(pkgId25).user_id) === srcId25,
          `capped=${live25(capped25.id)} status=${overLimit25.status} code=${code25(overLimit25)}`);

        // The ledger is the part a move must carry with it: stats.js and reports.js
        // read usage_daily.user_id, not configs.user_id.
        const memberIds25 = rowsOf25(pkgEmail25).map((row) => Number(row.id));
        const book25 = tdb.prepare(
          'INSERT INTO usage_daily (config_id, user_id, day, up_bytes, down_bytes) VALUES (?, ?, ?, ?, ?)'
        );
        for (const id of memberIds25) {
          book25.run(id, srcId25, dayKey25(Date.now() - 86400000), 1024, 2048);
          book25.run(id, srcId25, dayKey25(Date.now()), 4096, 8192);
        }
        const walletBefore25 = [money25(srcId25), money25(dstId25)];
        const txBefore25 = [tx25(srcId25), tx25(dstId25)];        const nodeCallsBefore25 = mockXui.calls.length;
        const moved25 = await move25(pkgId25, { toUserId: dstId25, note: 'انتقال دستی مدیر' });
        const mv25 = moved25.json?.data || {};
        check('v1.5.5 the real move rewrites EVERY row of the package at once, and only that',
          moved25.status === 200 && mv25.moved === 2 && (mv25.rows || []).length === 2
            && rowsOf25(pkgEmail25).length === 2
            && rowsOf25(pkgEmail25).every((row) => Number(row.user_id) === dstId25)
            && live25(srcId25) === 0 && live25(dstId25) === 2,
          `moved=${mv25.moved} src=${live25(srcId25)} dst=${live25(dstId25)}`);
        check('the traffic history follows the customer, so the old owner stops charting him',
          mv25.usageRows === 4 && booked25(srcId25) === 0 && booked25(dstId25) === 4,
          `usageRows=${mv25.usageRows} src=${booked25(srcId25)} dst=${booked25(dstId25)}`);
        check('and one package stays ONE package: two channels, one quota, no split in half',
          new Set(rowsOf25(pkgEmail25).map((row) => Number(row.total_bytes))).size === 1
            && Number(rowsOf25(pkgEmail25)[0].total_bytes) === 10 * 1024 ** 3
            && new Set(rowsOf25(pkgEmail25).map((row) => String(row.sub_id))).size === 1,
          rowsOf25(pkgEmail25).map((row) => `${row.total_bytes}/${row.sub_id}`).join(' '));
        check('no money moves with a customer: neither wallet pays, neither is paid, no ledger row',
          walletBefore25.join(',') === '0,0'
            && [money25(srcId25), money25(dstId25)].join(',') === walletBefore25.join(',')
            && [tx25(srcId25), tx25(dstId25)].join(',') === txBefore25.join(',') && tx25(dstId25) === 0,
          `src=${money25(srcId25)}/${tx25(srcId25)} dst=${money25(dstId25)}/${tx25(dstId25)}`);
        check('the node is not touched at all — his subscription did not change hands, only his seller',
          mockXui.calls.length === nodeCallsBefore25 && onNode25(pkgEmail25) === LINE25(LABEL25),
          `calls=${mockXui.calls.length - nodeCallsBefore25} node="${onNode25(pkgEmail25)}"`);

        const backAgain25 = await move25(pkgId25, { toUserId: dstId25 });
        check('the same target twice is a mistake, not a second move',
          backAgain25.status === 422 && code25(backAgain25) === 'same_reseller',
          `code=${code25(backAgain25)}`);

        const toNote25 = notes25(dstId25, 'مشتری به شما منتقل شد').slice(-1)[0] || {};
        const fromNote25 = notes25(srcId25, 'مشتری منتقل شد').slice(-1)[0] || {};
        check('both resellers are told in their own panel, with the customer named',
          String(toNote25.body || '').includes(pkgEmail25)
            && String(toNote25.body || '').includes('movesrc')
            && String(fromNote25.body || '').includes('movedst')
            && String(toNote25.link) === '/reseller/configs',
          `to=${String(toNote25.body || '').slice(0, 60)} from=${String(fromNote25.body || '').slice(0, 60)}`);
        const audit25 = tdb.prepare(
          "SELECT * FROM audit_logs WHERE action = 'config.transfer' ORDER BY id DESC LIMIT 1"
        ).get() || {};
        const auditDetails25 = String(audit25.details || '');
        check('the audit trail names both sides, every row that moved and the reason typed',
          audit25.entity === 'config' && String(audit25.role) === 'admin'
            && Number(audit25.user_id) === Number(me.json?.data?.user?.id)
            && auditDetails25.includes(`"fromUserId":${srcId25}`) && auditDetails25.includes(`"toUserId":${dstId25}`)
            && auditDetails25.includes('انتقال دستی مدیر') && /"usageRows":4/.test(auditDetails25),
          `user=${audit25.user_id} role=${audit25.role} ${auditDetails25.slice(0, 110)}`);

        const srcList25 = await request('GET', `/api/reseller/configs?search=${pkgEmail25}`, {
          cookies: srcSess25.cookies, csrf: srcSess25.csrf,
        });
        const dstList25 = await request('GET', `/api/reseller/configs?search=${pkgEmail25}`, {
          cookies: dstSess25.cookies, csrf: dstSess25.csrf,
        });
        const sees = (res) => res.status === 200 && String(res.raw || '').includes(pkgEmail25);
        check('the lists on the two screens agree with the database: one sees him, the other does not',
          sees(dstList25) === true && sees(srcList25) === false,
          `src=${sees(srcList25)} dst=${sees(dstList25)}`);

        // The UNIQUE(email, inbound_id) index is exactly what makes this state
        // impossible through the API, so the duplicate that the guard exists for
        // has to be built by hand — index down, row in, guard checked, row out,
        // index back up.
        let clashProof25 = '';
        try {
          tdb.exec('DROP INDEX IF EXISTS idx_configs_email_inbound');
          tdb.prepare(
            `INSERT INTO configs (user_id, inbound_id, email, sub_id, xui_sub_id, uuid, label, customer_name,
               total_bytes, expiry_at, enabled, status, created_at, updated_at, deleted_at)
             VALUES (?, 901, ?, '', '', '', '', '', ?, ?, 1, 'active', ?, ?, 0)`
          ).run(clash25.id, pkgEmail25, 10 * 1024 ** 3, Date.now() + 30 * 86400000, Date.now(), Date.now());
          const clashR25 = await move25(pkgId25, { toUserId: clash25.id });
          clashProof25 = `${clashR25.status}:${code25(clashR25)}`;
          check('a customer already registered on that channel under the target is refused, not merged',
            clashR25.status === 409 && code25(clashR25) === 'already_with_target'
              && memberIds25.every((id) => Number(cfg25(id).user_id) === dstId25),
            clashProof25);
        } finally {
          tdb.prepare('DELETE FROM configs WHERE user_id = ? AND email = ?').run(clash25.id, pkgEmail25);
          tdb.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_configs_email_inbound ON configs(email, inbound_id)');
        }

        const homeAgain25 = await move25(pkgId25, { toUserId: srcId25 });
        check('and a move back is the same move the other way — the ledger goes with him again',
          homeAgain25.status === 200 && homeAgain25.json?.data?.moved === 2
            && rowsOf25(pkgEmail25).every((row) => Number(row.user_id) === srcId25)
            && booked25(srcId25) === 4 && booked25(dstId25) === 0,
          JSON.stringify(homeAgain25.json?.data || {}));

        // Items 4 and 5 meeting: the new owner edits his own customer's label,
        // and the node — which never changed hands — gets the new line.
        const newOwnerRename25 = await request('PATCH', `/api/reseller/configs/${pkgId25}`, {
          cookies: srcSess25.cookies, csrf: srcSess25.csrf, body: { label: 'برچسب نماینده' },
        });
        check('the reseller who now owns him can relabel him, and the node hears it',
          newOwnerRename25.status === 200 && newOwnerRename25.json?.data?.config?.commentSync?.pushed === true
            && onNode25(pkgEmail25) === LINE25('برچسب نماینده'),
          `status=${newOwnerRename25.status} node="${onNode25(pkgEmail25)}"`);
        const wireVersion25 = (await request('GET', '/api/health')).json?.version;
        check('this build is v2.4.2 on the wire too', wireVersion25 === '2.4.2', `version=${wireVersion25}`);
      } finally {
        if (lifted25) await request('PATCH', '/api/admin/settings/security', { cookies, csrf, body: { loginRateLimit: limit25 } });
        tdb.close();
      }
    }

    // ═════════════════════════════════════════════════════════════════════ v1.5.6
    //
    // «امکان انتقال چند کانفینگ به یک نماینده» — the tick boxes on جستجوی کانفینگ.
    //
    // One endpoint, two verbs, because the search page mixes both kinds of hit: a
    // client this panel already holds is MOVED (the whole package, ledger and all),
    // a client nobody here holds is ADOPTED. The batch reuses transferCustomer and
    // adoptNodeClient untouched, so every guard they have decides each item here
    // too. The checks read the same fact from panel.db AND from mockXui.clients and
    // refuse a release where the two disagree — or where a preview wrote anything.
    {
      const bdb = new Database(path.join(DATA_DIR, 'panel.db'));
      const P26 = 'Bulk-Pass-12345';
      const cfg26 = (id) => bdb.prepare('SELECT * FROM configs WHERE id = ?').get(Number(id)) || {};
      const rowsOf26 = (email) => bdb.prepare('SELECT * FROM configs WHERE email = ? ORDER BY id').all(String(email));
      const liveOf26 = (email) => rowsOf26(email).filter((row) => Number(row.deleted_at) === 0);
      const live26 = (userId) => Number(bdb.prepare(
        'SELECT COUNT(*) AS c FROM configs WHERE user_id = ? AND deleted_at = 0'
      ).get(Number(userId)).c);
      const booked26 = (userId) => Number(bdb.prepare(
        'SELECT COUNT(*) AS c FROM usage_daily WHERE user_id = ?'
      ).get(Number(userId)).c);
      const notes26 = (userId, title) => bdb.prepare(
        'SELECT * FROM notifications WHERE user_id = ? AND title = ?'
      ).all(Number(userId), String(title));
      const noteCount26 = () => Number(bdb.prepare('SELECT COUNT(*) AS c FROM notifications').get().c);
      const audits26 = (action) => Number(bdb.prepare(
        'SELECT COUNT(*) AS c FROM audit_logs WHERE action = ?'
      ).get(String(action)).c);
      const configCount26 = () => Number(bdb.prepare('SELECT COUNT(*) AS c FROM configs').get().c);
      const owners26 = () => JSON.stringify(bdb.prepare(
        'SELECT id, user_id FROM configs ORDER BY id'
      ).all().map((row) => [Number(row.id), Number(row.user_id)]));
      const code26 = (res) => String(res.json?.error?.code || '');
      const dayKey26 = (ts) => new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(ts));
      const WRITE26 = /\/clients\/(add|update\/|del\/|bulkAttach|bulkEnable|bulkDisable|bulkAdjust|resetTraffic\/)|\/detach$/;
      const writes26 = (from) => mockXui.calls.slice(from).filter((call) => WRITE26.test(call.route)).map((call) => call.route);
      const mkUser26 = async (username, extra = {}) => {
        const created = await request('POST', '/api/admin/users', {
          cookies, csrf, body: { username, password: P26, role: 'reseller', balance: 0, ...extra },
        });
        return { id: Number(created.json?.data?.user?.id || 0), status: created.status };
      };
      const login26 = async (username) => {
        const res = await request('POST', '/api/auth/login', { body: { username, password: P26 } });
        return { status: res.status, cookies: cookiesFrom(res.headers), csrf: res.json?.data?.csrf };
      };
      const bulk26 = (items, toUserId, extra = {}, who) => request('POST', '/api/admin/configs/bulk-assign', {
        ...(who || { cookies, csrf }),
        body: { items, toUserId, ...extra },
      });
      const item26 = (email) => ({ email, serverId: primaryId });
      const seed26 = (email, comment, inboundIds, gb = 10) => {
        mockXui.clients.set(email, {
          email, id: `uuid-${email}`, subId: `sub-${email}`, comment,
          totalGB: gb * 1024 ** 3, expiryTime: Date.now() + 30 * 86400000, enable: true,
          up: 1024, down: 2048, inboundIds,
        });
        return email;
      };

      let limit26 = 10;
      let lifted26 = false;
      // Marked AFTER the fixtures: building the three test packages really does
      // call /clients/add, and that is the point of a package — what must never
      // touch the node is the handing-over itself.
      let blockStart26 = 0;
      try {
        const secRead26 = await request('GET', '/api/admin/settings', { cookies });
        limit26 = Number(secRead26.json?.data?.settings?.security?.loginRateLimit || 10);
        lifted26 = (await request('PATCH', '/api/admin/settings/security', {
          cookies, csrf, body: { loginRateLimit: 100 },
        })).status === 200;
        await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 3600 } });

        const src26 = await mkUser26('bulksrc');
        const dst26 = await mkUser26('bulkdst');
        const capped26 = await mkUser26('bulkcapped', { max_configs: 1 });
        const off26 = await mkUser26('bulkoff');
        const perm26 = await mkUser26('bulkperm');
        const permSess26 = await login26('bulkperm');
        bdb.prepare('UPDATE users SET import_configs = 0 WHERE id = ?').run(off26.id);

        const build26 = async (name) => {
          const res = await request('POST', '/api/admin/configs', {
            cookies, csrf,
            body: { userId: src26.id, inboundIds: [901, 902], gb: 10, days: 30, label: name, customerName: name },
          });
          const rows = res.json?.data?.configs || [];
          return { status: res.status, id: Number(rows[0]?.id || 0), email: String(rows[0]?.email || ''), ids: rows.map((row) => Number(row.id)) };
        };
        const pkgA26 = await build26('بستهٔ الف');
        const pkgB26 = await build26('بستهٔ ب');
        const pkgC26 = await build26('بستهٔ ج');
        const book26 = bdb.prepare(
          'INSERT INTO usage_daily (config_id, user_id, day, up_bytes, down_bytes) VALUES (?, ?, ?, ?, ?)'
        );
        for (const pkg of [pkgA26, pkgB26, pkgC26]) {
          for (const id of pkg.ids) {
            book26.run(id, src26.id, dayKey26(Date.now() - 86400000), 1024, 2048);
            book26.run(id, src26.id, dayKey26(Date.now()), 4096, 8192);
          }
        }
        const nodeA26 = seed26('v156node-a', 'مشتری آمادهٔ الف', [901, 902], 20);
        const nodeB26 = seed26('v156node-b', 'مشتری آمادهٔ ب', [901], 5);
        const nodeC26 = seed26('v156node-c', 'مشتری آمادهٔ ج', [902], 5);
        const nodeD26 = seed26('v156node-d', 'مشتری آمادهٔ د', [901], 5);
        const nodeE26 = seed26('v156node-e', 'مشتری آمادهٔ ه', [902], 5);
        const nodeF26 = seed26('v156node-f', 'مشتری آمادهٔ و', [901, 902], 15);
        const orphan26 = seed26('v156node-orphan', 'کانال ناشناخته', [4242], 0);
        const missing26 = 'v156node-not-there';
        blockStart26 = mockXui.calls.length;

        check('v1.5.6 the fixtures exist: five resellers, three two-channel packages, six node clients, the monitor parked',
          [src26.id, dst26.id, capped26.id, off26.id, perm26.id].every((id) => id > 0)
            && permSess26.status === 200 && lifted26
            && [pkgA26, pkgB26, pkgC26].every((pkg) => pkg.status === 201 && pkg.ids.length === 2)
            && live26(src26.id) === 6 && booked26(src26.id) === 12,
          `src=${src26.id} dst=${dst26.id} login=${permSess26.status} live=${live26(src26.id)} booked=${booked26(src26.id)}`);

        // ───────────────────────────── the preview: a question, not an action
        const mixed26 = [item26(pkgA26.email), item26(pkgB26.email), item26(nodeA26), item26(nodeB26)];
        const before26 = {
          configs: configCount26(), owners: owners26(), notes: noteCount26(),
          transfer: audits26('config.transfer'), adopt: audits26('config.adopt'), bulk: audits26('config.bulk_assign'),
          bookedSrc: booked26(src26.id), bookedDst: booked26(dst26.id),
        };
        const markPreview26 = mockXui.calls.length;
        const preview26 = await bulk26(mixed26, dst26.id, { dryRun: true, note: 'پیش‌نمایش' });
        const pv26 = preview26.json?.data || {};
        const pvRows26 = pv26.results || [];
        check('v1.5.6 one preview classifies a mixed selection: two moves and two adoptions, each with its own rows',
          preview26.status === 200 && pv26.dryRun === true && pv26.total === 4
            && pv26.moved === 2 && pv26.adopted === 2 && pv26.failed === 0 && pv26.already === 0
            && pvRows26[0].action === 'transfer' && pvRows26[1].action === 'transfer'
            && pvRows26[2].action === 'adopt' && pvRows26[3].action === 'adopt'
            && pvRows26[0].configs.length === 2 && pvRows26[2].inboundCount === 2 && pvRows26[3].inboundCount === 1
            && String(pvRows26[0].from[0]) === 'bulksrc',
          `status=${preview26.status} moved=${pv26.moved} adopted=${pv26.adopted} actions=${pvRows26.map((row) => row.action).join(',')} counts=${pvRows26.map((row) => row.inboundCount).join(',')}`);
        check('and the preview wrote NOTHING: no row, no owner, no ledger, no notification, no audit, no node call',
          configCount26() === before26.configs && owners26() === before26.owners
            && noteCount26() === before26.notes && booked26(src26.id) === before26.bookedSrc
            && booked26(dst26.id) === before26.bookedDst
            && audits26('config.transfer') === before26.transfer && audits26('config.adopt') === before26.adopt
            && audits26('config.bulk_assign') === before26.bulk
            && writes26(markPreview26).length === 0,
          `configs=${configCount26()}/${before26.configs} notes=${noteCount26()}/${before26.notes} bulk=${audits26('config.bulk_assign')} writes=${writes26(markPreview26).join(',') || 'none'}`);

        const badPreview26 = await bulk26([item26(pkgC26.email), item26(missing26), item26(orphan26)], dst26.id, { dryRun: true });
        const bp26 = badPreview26.json?.data || {};
        const bpRows26 = bp26.results || [];
        check('a preview names the two that cannot land — a client the node no longer has and a channel nobody knows',
          badPreview26.status === 200 && bp26.moved === 1 && bp26.failed === 2
            && bpRows26[0].ok === true && bpRows26[1].code === 'xui_client_missing' && bpRows26[2].code === 'no_known_inbound'
            && configCount26() === before26.configs && owners26() === before26.owners,
          `moved=${bp26.moved} failed=${bp26.failed} codes=${bpRows26.map((row) => row.code || 'ok').join(',')}`);

        // ───────────────────────────── the real batch
        const markRun26 = mockXui.calls.length;
        const run26 = await bulk26(mixed26, dst26.id, { note: 'واگذاری گروهی' });
        const rn26 = run26.json?.data || {};
        check('v1.5.6 the real batch hands all four over in one click, and every row of each package moves',
          run26.status === 200 && rn26.moved === 2 && rn26.adopted === 2 && rn26.failed === 0 && rn26.rows === 7
            && [pkgA26, pkgB26].every((pkg) => rowsOf26(pkg.email).every((row) => Number(row.user_id) === dst26.id))
            && live26(dst26.id) === 7 && live26(src26.id) === 2
            && booked26(dst26.id) === 8 && booked26(src26.id) === 4,
          `status=${run26.status} moved=${rn26.moved} adopted=${rn26.adopted} rows=${rn26.rows} dst=${live26(dst26.id)} booked=${booked26(dst26.id)}/${booked26(src26.id)}`);
        const adoptedA26 = liveOf26(nodeA26);
        const adoptedB26 = liveOf26(nodeB26);
        check('the adopted customers are external rows, one group token each, named after the remark they already carried',
          adoptedA26.length === 2 && adoptedB26.length === 1
            && [...adoptedA26, ...adoptedB26].every((row) => row.origin === 'external' && Number(row.user_id) === dst26.id)
            && new Set(adoptedA26.map((row) => row.sub_id)).size === 1
            && String(adoptedA26[0].label) === 'مشتری آمادهٔ الف' && String(adoptedB26[0].label) === 'مشتری آمادهٔ ب'
            && Number(adoptedA26[0].total_bytes) === 20 * 1024 ** 3,
          `rows=${adoptedA26.length}/${adoptedB26.length} label=${adoptedA26[0]?.label} origin=${adoptedA26[0]?.origin}`);
        check('a hand-over never writes to x-ui: every client is still on the node, exactly as it was',
          writes26(markRun26).length === 0
            && [pkgA26.email, pkgB26.email, nodeA26, nodeB26].every((email) => mockXui.clients.has(email)),
          `writes=${writes26(markRun26).join(',') || 'none'}`);
        const toBulk26 = notes26(dst26.id, 'چند کانفیگ به لیست شما اضافه شد');
        const fromBulk26 = notes26(src26.id, 'چند مشتری منتقل شد');
        check('twenty customers are not twenty pings: ONE notification to the target and ONE to the source',
          toBulk26.length === 1 && fromBulk26.length === 1
            && notes26(dst26.id, 'مشتری به شما منتقل شد').length === 0
            && notes26(dst26.id, 'کانفیگ به لیست شما اضافه شد').length === 0
            && notes26(src26.id, 'مشتری منتقل شد').length === 0
            && String(toBulk26[0].body).includes(nodeA26) && String(fromBulk26[0].body).includes('bulkdst'),
          `to=${toBulk26.length} from=${fromBulk26.length} single=${notes26(dst26.id, 'مشتری به شما منتقل شد').length}`);
        const bulkAudit26 = bdb.prepare(
          "SELECT * FROM audit_logs WHERE action = 'config.bulk_assign' ORDER BY id DESC LIMIT 1"
        ).get() || {};
        const bulkDetails26 = String(bulkAudit26.details || '');
        check('one audit line for the whole batch, with the per-customer outcome inside it',
          audits26('config.bulk_assign') === 1 && String(bulkAudit26.entity) === 'user'
            && Number(bulkAudit26.entity_id) === dst26.id
            && bulkDetails26.includes('"moved":2') && bulkDetails26.includes('"adopted":2')
            && bulkDetails26.includes('واگذاری گروهی') && bulkDetails26.includes(nodeA26),
          `count=${audits26('config.bulk_assign')} entity=${bulkAudit26.entity} ${bulkDetails26.slice(0, 90)}`);

        const again26 = await bulk26(mixed26, dst26.id);
        const ag26 = again26.json?.data || {};
        check('running the same batch again changes nothing: all four answer «already his»',
          again26.status === 200 && ag26.already === 4 && ag26.moved === 0 && ag26.adopted === 0 && ag26.failed === 0
            && configCount26() === before26.configs + 3 && live26(dst26.id) === 7,
          `already=${ag26.already} moved=${ag26.moved} configs=${configCount26()}`);

        // ───────────────────────────── partial success is the point
        const partial26 = await bulk26([item26(nodeC26), item26(missing26), item26(orphan26)], dst26.id);
        const pt26 = partial26.json?.data || {};
        check('v1.5.6 one failure does not sink the batch: the good customer lands, the two bad ones keep their reason',
          partial26.status === 200 && pt26.adopted === 1 && pt26.failed === 2
            && liveOf26(nodeC26).length === 1 && Number(liveOf26(nodeC26)[0].user_id) === dst26.id
            && liveOf26(missing26).length === 0 && liveOf26(orphan26).length === 0
            && (pt26.results || [])[1].code === 'xui_client_missing' && (pt26.results || [])[2].code === 'no_known_inbound',
          `adopted=${pt26.adopted} failed=${pt26.failed} codes=${(pt26.results || []).map((row) => row.code || 'ok').join(',')}`);

        // ───────────────────────────── the ceiling is counted across the batch
        const capPreview26 = await bulk26([item26(pkgA26.email), item26(pkgB26.email)], capped26.id, { dryRun: true });
        const cp26 = capPreview26.json?.data || {};
        check('a target with room for ONE package is told so in the preview, not after the second move',
          capPreview26.status === 200 && cp26.moved === 1 && cp26.failed === 1
            && (cp26.results || [])[0].ok === true && (cp26.results || [])[1].code === 'limit_configs'
            && live26(capped26.id) === 0,
          `moved=${cp26.moved} failed=${cp26.failed} code=${(cp26.results || [])[1]?.code} live=${live26(capped26.id)}`);
        const capRun26 = await bulk26([item26(pkgA26.email), item26(pkgB26.email)], capped26.id);
        const cr26 = capRun26.json?.data || {};
        check('and the real run delivers exactly what the preview promised: one moves, one is refused',
          capRun26.status === 200 && cr26.moved === 1 && cr26.failed === 1 && live26(capped26.id) === 2
            && rowsOf26(pkgA26.email).every((row) => Number(row.user_id) === capped26.id)
            && rowsOf26(pkgB26.email).every((row) => Number(row.user_id) === dst26.id),
          `moved=${cr26.moved} failed=${cr26.failed} capped=${live26(capped26.id)}`);

        const offRun26 = await bulk26([item26(nodeD26), item26(nodeE26)], off26.id);
        const or26 = offRun26.json?.data || {};
        check('a reseller who switched adoption off refuses every adoption, and nothing is written for him',
          offRun26.status === 200 && or26.failed === 2 && or26.adopted === 0 && live26(off26.id) === 0
            && (or26.results || []).every((row) => row.code === 'import_disabled')
            && liveOf26(nodeD26).length === 0 && liveOf26(nodeE26).length === 0,
          `failed=${or26.failed} codes=${(or26.results || []).map((row) => row.code).join(',')} live=${live26(off26.id)}`);

        // ───────────────────────────── who may ask, and what a bad ask answers
        const shopBulk26 = await bulk26(mixed26, dst26.id, {}, { cookies: permSess26.cookies, csrf: permSess26.csrf });
        check('a reseller cannot hand configs to anybody, himself included', shopBulk26.status === 403, `status=${shopBulk26.status}`);
        // v1.5.8 raised the batch ceiling from 100 to 1000 — the overflow probe
        // must overflow the NEW ceiling, not the old one.
        const tooMany26 = Array.from({ length: 1001 }, (_, i) => item26(`v156fake-${i}`));
        const badAsks26 = await Promise.all([
          bulk26([], dst26.id),
          bulk26(tooMany26, dst26.id),
          bulk26([item26(pkgC26.email)], 0),
          bulk26([item26(pkgC26.email)], 999999),
          bulk26([item26(pkgC26.email)], 1),
        ]);
        check('five wrong asks are five different answers, and none of them moves a row',
          badAsks26.map((res) => `${res.status}:${code26(res)}`).join(' ')
            === '422:items_required 422:too_many_items 422:reseller_required 404:user_not_found 409:target_is_admin'
            && rowsOf26(pkgC26.email).every((row) => Number(row.user_id) === src26.id),
          badAsks26.map((res) => `${res.status}:${code26(res)}`).join(' '));
        const dup26 = await bulk26([item26(pkgC26.email), item26(pkgC26.email)], dst26.id, { dryRun: true });
        check('the same customer ticked twice is one customer, not two',
          dup26.status === 200 && dup26.json?.data?.total === 1 && dup26.json?.data?.moved === 1,
          `total=${dup26.json?.data?.total}`);

        // ───────────────────────────── one item still behaves like v1.5.5
        // Earlier batches in this block already sent dst the aggregated note, so
        // the promise is «a single move adds none of them», not «exactly one ever».
        const bulkNotesBefore26 = notes26(dst26.id, 'چند کانفیگ به لیست شما اضافه شد').length;
        const soloMove26 = await bulk26([item26(pkgC26.email)], dst26.id, { note: 'تکی' });
        const sm26 = soloMove26.json?.data || {};
        check('a single move keeps the v1.5.5 notifications: each side is told about that one customer',
          soloMove26.status === 200 && sm26.moved === 1
            && notes26(dst26.id, 'مشتری به شما منتقل شد').length === 1
            && notes26(src26.id, 'مشتری منتقل شد').length === 1
            && notes26(dst26.id, 'چند کانفیگ به لیست شما اضافه شد').length === bulkNotesBefore26
            && rowsOf26(pkgC26.email).every((row) => Number(row.user_id) === dst26.id),
          `moved=${sm26.moved} to=${notes26(dst26.id, 'مشتری به شما منتقل شد').length} from=${notes26(src26.id, 'مشتری منتقل شد').length} bulk=${notes26(dst26.id, 'چند کانفیگ به لیست شما اضافه شد').length}/${bulkNotesBefore26}`);
        const soloAdopt26 = await bulk26([item26(nodeF26)], dst26.id, {
          label: 'برچسب تکی', customerName: 'مشتری تکی', customerPhone: '09120000000',
        });
        const sa26 = soloAdopt26.json?.data || {};
        const soloRows26 = liveOf26(nodeF26);
        check('a single adoption still takes the typed label, name and phone — a batch never stamps one name on everybody',
          soloAdopt26.status === 200 && sa26.adopted === 1 && soloRows26.length === 2
            && soloRows26.every((row) => String(row.label) === 'برچسب تکی'
              && String(row.customer_name) === 'مشتری تکی' && String(row.customer_phone) === '09120000000')
            && notes26(dst26.id, 'کانفیگ به لیست شما اضافه شد').length === 1,
          `adopted=${sa26.adopted} label=${soloRows26[0]?.label} note=${notes26(dst26.id, 'کانفیگ به لیست شما اضافه شد').length}`);

        // v2.4.0: the search page's batch path must be just as permission-blind
        // as the single transfer. Use a fresh target so earlier count assertions
        // stay meaningful, and put the package back before the final node guard.
        const noGrant26 = await mkUser26('bulknogrant');
        await request('PATCH', `/api/admin/users/${noGrant26.id}`, { cookies, csrf, body: { allowed_inbounds: [903] } });
        const vis26 = bdb.prepare('SELECT id, visible FROM inbounds WHERE id IN (901, 902) ORDER BY id').all();
        bdb.prepare('UPDATE inbounds SET visible = 0 WHERE id IN (901, 902)').run();
        try {
          const noGrantPreview26 = await bulk26([item26(pkgC26.email)], noGrant26.id, { dryRun: true });
          const noGrantRun26 = await bulk26([item26(pkgC26.email)], noGrant26.id);
          const landedNoGrant26 = rowsOf26(pkgC26.email);
          const returned26 = await bulk26([item26(pkgC26.email)], dst26.id);
          const noGrantPreviewData26 = noGrantPreview26.json?.data || {};
          const noGrantRunData26 = noGrantRun26.json?.data || {};
          const returnedData26 = returned26.json?.data || {};
          check('v2.4.0 bulk search transfer ignores hidden and ungranted inbounds too',
            noGrant26.id > 0 && noGrantPreview26.status === 200 && noGrantPreviewData26.moved === 1
              && noGrantRun26.status === 200 && noGrantRunData26.moved === 1
              && landedNoGrant26.length > 0
              && landedNoGrant26.every((row) => Number(row.user_id) === noGrant26.id)
              && returned26.status === 200 && returnedData26.moved === 1
              && rowsOf26(pkgC26.email).every((row) => Number(row.user_id) === dst26.id),
            `preview=${noGrantPreview26.status}:${code26(noGrantPreview26)} moved=${noGrantPreviewData26.moved} failed=${noGrantPreviewData26.failed} results=${JSON.stringify(noGrantPreviewData26.results || [])}`
              + ` run=${noGrantRun26.status}:${code26(noGrantRun26)} moved=${noGrantRunData26.moved} failed=${noGrantRunData26.failed} results=${JSON.stringify(noGrantRunData26.results || [])}`
              + ` back=${returned26.status}:${code26(returned26)} moved=${returnedData26.moved} failed=${returnedData26.failed} results=${JSON.stringify(returnedData26.results || [])}`
              + ` ids=src:${src26.id} dst:${dst26.id} noGrant:${noGrant26.id} targets=${noGrantPreviewData26.toUserId}/${noGrantRunData26.toUserId}/${returnedData26.toUserId}`
              + ` owners=${rowsOf26(pkgC26.email).map((row) => Number(row.user_id)).join(',')}`);
        } finally {
          for (const row of vis26) bdb.prepare('UPDATE inbounds SET visible = ? WHERE id = ?').run(Number(row.visible), Number(row.id));
        }
        check('the whole v1.5.6 block never wrote to a node: handing over is a panel-only fact',
          writes26(blockStart26).length === 0,
          `writes=${writes26(blockStart26).join(',') || 'none'}`);
      } finally {
        if (lifted26) await request('PATCH', '/api/admin/settings/security', { cookies, csrf, body: { loginRateLimit: limit26 } });
        bdb.close();
      }
    }

    // ═════════════════════════════════════════════════════════════════════ v1.5.8
    //
    // The owner's three sentences, each proven against a running server:
    //   ۱) «۲۱۰ تا کانفینگ با پیشوند speed دارم ولی جستجو ۶۰ تا میاره» — the search
    //      must return EVERY hit, and say so honestly when a caller caps it.
    //   ۲) «کانفیگ‌هایی که روی نود ثبت نشده رو هم به فیلتر وضعیت اضافه کن» — the
    //      mark comes from a REAL refresh against the mock node (client deleted →
    //      «record not found»), not from a hand-written column, and the grouped
    //      list, the reseller list, API v1 and the CSV must agree about it.
    //   ۳) «پلن‌های تست / عمومی / اختصاصی + محدودیت گرفتن برای هر نماینده» — the
    //      exclusive shelf exists only for its named resellers, the take limit
    //      counts new AND renewal, and a refusal moves neither money nor a node.
    {
      const bdb = new Database(path.join(DATA_DIR, 'panel.db'));
      const P28 = 'Shelf-Pass-12345';
      const code28 = (res) => String(res.json?.error?.code || '');
      const mkUser28 = async (username, extra = {}) => {
        const created = await request('POST', '/api/admin/users', {
          cookies, csrf, body: { username, password: P28, role: 'reseller', balance: 0, max_configs: 100, ...extra },
        });
        return { id: Number(created.json?.data?.user?.id || 0), status: created.status };
      };
      const login28 = async (username) => {
        const res = await request('POST', '/api/auth/login', { body: { username, password: P28 } });
        return { status: res.status, cookies: cookiesFrom(res.headers), csrf: res.json?.data?.csrf };
      };
      const seed28 = (email, comment, inboundIds, gb = 5) => {
        mockXui.clients.set(email, {
          email, id: `uuid-${email}`, subId: `sub-${email}`, comment,
          totalGB: gb * 1024 ** 3, expiryTime: Date.now() + 30 * 86400000, enable: true,
          up: 0, down: 0, inboundIds,
        });
        return email;
      };
      const build28 = async (userId, name) => {
        const res = await request('POST', '/api/admin/configs', {
          cookies, csrf,
          body: { userId, inboundIds: [901, 902], gb: 5, days: 30, label: name, customerName: name },
        });
        const rows = res.json?.data?.configs || [];
        return { status: res.status, id: Number(rows[0]?.id || 0), email: String(rows[0]?.email || ''), ids: rows.map((row) => Number(row.id)) };
      };
      const syncOf28 = (email) => bdb.prepare(
        'SELECT sync_status FROM configs WHERE email = ? AND deleted_at = 0 ORDER BY id'
      ).all(String(email)).map((row) => String(row.sync_status));
      const takes28 = (planId, userId) => bdb.prepare(
        'SELECT * FROM plan_purchases WHERE plan_id = ? AND user_id = ? ORDER BY id'
      ).all(Number(planId), Number(userId));
      const live28 = (userId) => Number(bdb.prepare(
        'SELECT COUNT(*) AS c FROM configs WHERE user_id = ? AND deleted_at = 0'
      ).get(Number(userId)).c);
      const bal28 = (userId) => Number(bdb.prepare('SELECT balance FROM users WHERE id = ?').get(Number(userId))?.balance || 0);
      const WRITE28 = /\/clients\/(add|update\/|del\/|bulkAttach|bulkEnable|bulkDisable|bulkAdjust|resetTraffic\/)|\/detach$/;

      const speedEmails28 = [];
      let limit28 = 10;
      let lifted28 = false;
      let parked28 = false;
      try {
        const secRead28 = await request('GET', '/api/admin/settings', { cookies });
        limit28 = Number(secRead28.json?.data?.settings?.security?.loginRateLimit || 10);
        lifted28 = (await request('PATCH', '/api/admin/settings/security', {
          cookies, csrf, body: { loginRateLimit: 100 },
        })).status === 200;
        parked28 = (await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 3600 } })).status === 200;
        // The money assertions below need billing ON and commission OFF — the
        // state v1.5.4 left behind, stated here so the block does not depend on it.
        await request('PATCH', '/api/admin/settings/billing', { cookies, csrf, body: { enabled: true, commissionPercent: 0 } });

        // ───────────────────────────── ۱) the 210 «speed» clients, all of them
        for (let i = 0; i < 210; i += 1) {
          speedEmails28.push(seed28(`v158speed-${String(i).padStart(3, '0')}`, 'مشتری سرعت', [901, 902], 10));
        }
        seed28('v158plain-one', 'کانال بی‌ربط', [901], 5);
        const markSearch28 = mockXui.calls.length;
        const all28 = await request('GET', `/api/admin/node-clients?q=v158speed&serverId=${primaryId}`, { cookies });
        const ad28 = all28.json?.data || {};
        check('the owner\'s 210 «speed» clients all come back — no silent page of 60',
          all28.status === 200 && (ad28.rows || []).length === 210 && ad28.truncated === false && ad28.limit === 1000,
          `rows=${(ad28.rows || []).length} truncated=${ad28.truncated} limit=${ad28.limit}`);
        const small28 = await request('GET', `/api/admin/node-clients?q=v158speed&serverId=${primaryId}&limit=50`, { cookies });
        check('a caller that names a small limit still gets it, and is told the list was cut',
          small28.status === 200 && (small28.json?.data?.rows || []).length === 50 && small28.json?.data?.truncated === true,
          `rows=${(small28.json?.data?.rows || []).length} truncated=${small28.json?.data?.truncated}`);
        const huge28 = await request('GET', `/api/admin/node-clients?q=v158speed&serverId=${primaryId}&limit=999999`, { cookies });
        check('even a greedy limit is capped at 5000, and the match is still the whole 210',
          huge28.status === 200 && huge28.json?.data?.limit === 5000
            && (huge28.json?.data?.rows || []).length === 210 && huge28.json?.data?.truncated === false,
          `limit=${huge28.json?.data?.limit} rows=${(huge28.json?.data?.rows || []).length}`);
        check('the search stayed a read: not one write reached the node',
          mockXui.calls.slice(markSearch28).filter((call) => WRITE28.test(call.route)).length === 0,
          `writes=${mockXui.calls.slice(markSearch28).filter((call) => WRITE28.test(call.route)).map((call) => call.route).join(',') || 'none'}`);

        // ───────────────────────────── ۲) «روی نود ثبت نشده» from a real refresh
        const shop28 = await mkUser28('v158shop', { balance: 1000000 });
        const other28 = await mkUser28('v158other', { balance: 1000000 });
        const shopSess28 = await login28('v158shop');
        const otherSess28 = await login28('v158other');
        const pkgOk28 = await build28(shop28.id, 'بسته سالم');
        const pkgGone28 = await build28(shop28.id, 'بسته گم‌شده');
        const goneClient28 = mockXui.clients.get(pkgGone28.email);
        mockXui.clients.delete(pkgGone28.email);
        const refreshGone28 = await request('POST', `/api/admin/configs/${pkgGone28.id}/refresh`, { cookies, csrf });
        check('a refresh that finds no client marks EVERY row of the package, not just the opened one',
          refreshGone28.status === 200 && refreshGone28.json?.data?.missingRows === 2
            && syncOf28(pkgGone28.email).every((s) => s === 'missing') && syncOf28(pkgOk28.email).every((s) => s === ''),
          `missingRows=${refreshGone28.json?.data?.missingRows} gone=${syncOf28(pkgGone28.email).join(',')} ok=${syncOf28(pkgOk28.email).join(',')}`);
        const missList28 = await request('GET', `/api/admin/configs?status=missing&userId=${shop28.id}`, { cookies });
        const md28 = missList28.json?.data || {};
        check('the status filter finds the broken package whole and leaves the healthy one alone',
          missList28.status === 200 && md28.total === 1 && (md28.rows || []).length === 1
            && md28.rows[0].email === pkgGone28.email && md28.rows[0].missingCount === 2
            && md28.rows[0].syncStatus === 'missing' && md28.rows[0].groupCount === 2,
          `total=${md28.total} missingCount=${md28.rows?.[0]?.missingCount} sync=${md28.rows?.[0]?.syncStatus}`);
        const bothList28 = await request('GET', `/api/admin/configs?userId=${shop28.id}`, { cookies });
        check('without the filter both packages are still listed', bothList28.json?.data?.total === 2, `total=${bothList28.json?.data?.total}`);
        mockXui.quirks.failGet.add(pkgOk28.email);
        const refreshSick28 = await request('POST', `/api/admin/configs/${pkgOk28.id}/refresh`, { cookies, csrf });
        mockXui.quirks.failGet.delete(pkgOk28.email);
        check('a node that answers with an error is «cannot tell», not «not there»',
          refreshSick28.status === 200 && refreshSick28.json?.data?.errorRows === 2
            && refreshSick28.json?.data?.missingRows === 0 && syncOf28(pkgOk28.email).every((s) => s === ''),
          `errorRows=${refreshSick28.json?.data?.errorRows} missingRows=${refreshSick28.json?.data?.missingRows}`);
        const shopMiss28 = await request('GET', '/api/reseller/configs?status=missing', { cookies: shopSess28.cookies });
        check('the reseller\'s own list has the same filter and the same answer',
          shopMiss28.status === 200 && shopMiss28.json?.data?.total === 1
            && shopMiss28.json?.data?.rows?.[0]?.email === pkgGone28.email,
          `total=${shopMiss28.json?.data?.total}`);
        const key28 = await request('POST', '/api/auth/api-key', { cookies: shopSess28.cookies, csrf: shopSess28.csrf, body: {} });
        const apiKey28 = key28.json?.data?.apiKey || '';
        const flatMiss28 = await request('GET', '/api/v1/configs?status=missing', { headers: { 'x-api-key': apiKey28 } });
        check('API v1 keeps row semantics: both broken channels, one row each',
          flatMiss28.status === 200 && flatMiss28.json?.data?.total === 2
            && (flatMiss28.json?.data?.rows || []).every((row) => row.email === pkgGone28.email),
          `total=${flatMiss28.json?.data?.total}`);
        const csvMiss28 = await request('GET', `/api/admin/configs/export.csv?status=missing&userId=${shop28.id}`, { cookies });
        const csvText28 = String(csvMiss28.raw || '');
        check('the CSV export obeys the same filter: the broken package only, one line per channel',
          csvMiss28.status === 200 && csvText28.includes(pkgGone28.email) && !csvText28.includes(pkgOk28.email)
            && csvText28.trim().split('\n').length === 3,
          `lines=${csvText28.trim().split('\n').length}`);
        mockXui.clients.set(pkgGone28.email, goneClient28);
        const refreshBack28 = await request('POST', `/api/admin/configs/${pkgGone28.id}/refresh`, { cookies, csrf });
        const missAfter28 = await request('GET', `/api/admin/configs?status=missing&userId=${shop28.id}`, { cookies });
        check('putting the client back and refreshing clears the mark — the filter follows the node',
          refreshBack28.status === 200 && refreshBack28.json?.data?.refreshedRows === 2
            && syncOf28(pkgGone28.email).every((s) => s === '') && missAfter28.json?.data?.total === 0,
          `refreshedRows=${refreshBack28.json?.data?.refreshedRows} total=${missAfter28.json?.data?.total}`);

        // ───────────────────────────── ۳) the three shelves and the take limit
        const PLAN28 = { name: 'پلن پایه ۱۵۸', gb: 2, days: 30, price: 0, inboundIds: [901] };
        const badShape28 = await Promise.all([
          request('POST', '/api/admin/plans', { cookies, csrf, body: { ...PLAN28, category: 'vip' } }),
          request('POST', '/api/admin/plans', { cookies, csrf, body: { ...PLAN28, per_user_limit: 100001 } }),
          request('POST', '/api/admin/plans', { cookies, csrf, body: { ...PLAN28, category: 'exclusive', allowed_users: [] } }),
          request('POST', '/api/admin/plans', { cookies, csrf, body: { ...PLAN28, category: 'exclusive', allowed_users: [1] } }),
          request('POST', '/api/admin/plans', { cookies, csrf, body: { ...PLAN28, category: 'exclusive', allowed_users: [999999] } }),
          request('POST', '/api/admin/plans', { cookies, csrf, body: { ...PLAN28, category: 'exclusive', allowed_users: Array.from({ length: 501 }, (_, i) => i + 1) } }),
        ]);
        check('six wrong plan shapes are six honest refusals, none of them stored',
          badShape28.map((res) => `${res.status}:${code28(res)}`).join(' ')
            === '422:invalid_plan_category 422:invalid_plan_limit 422:exclusive_needs_reseller 422:invalid_plan_reseller 422:invalid_plan_reseller 422:too_many_resellers',
          badShape28.map((res) => `${res.status}:${code28(res)}`).join(' '));
        const mkPlan28 = async (body) => {
          const res = await request('POST', '/api/admin/plans', { cookies, csrf, body: { ...PLAN28, ...body } });
          return { status: res.status, plan: res.json?.data?.plan || {}, code: code28(res) };
        };
        const test28 = await mkPlan28({ name: 'پلن تست ۱۵۸', gb: 1, days: 7, price: 0, category: 'test', per_user_limit: 1 });
        const pub28 = await mkPlan28({ name: 'پلن عمومی ۱۵۸', gb: 2, days: 30, price: 100, inboundIds: [901, 902], category: 'public', per_user_limit: 2, allowed_users: [shop28.id] });
        const excl28 = await mkPlan28({ name: 'پلن اختصاصی ۱۵۸', gb: 3, days: 30, price: 50, category: 'exclusive', allowed_users: [shop28.id] });
        check('the three shelves are written with their limit and their activation list',
          test28.status === 201 && test28.plan.category === 'test' && test28.plan.perUserLimit === 1
            && pub28.status === 201 && pub28.plan.category === 'public' && pub28.plan.perUserLimit === 2
            && excl28.status === 201 && excl28.plan.category === 'exclusive'
            && (excl28.plan.allowedUsers || []).length === 1 && excl28.plan.allowedUsers[0].username === 'v158shop'
            && excl28.plan.sold === 0,
          `test=${test28.code || test28.plan.category} pub=${pub28.code || pub28.plan.category} excl=${excl28.code || excl28.plan.category}`);
        check('a non-exclusive plan cannot keep a restriction list that nothing enforces',
          Array.isArray(pub28.plan.allowedUsers) && pub28.plan.allowedUsers.length === 0,
          JSON.stringify(pub28.plan.allowedUsers));
        // A row as 1.5.6 would have left it: no shelf, no limit, no list.
        const legacyIns28 = bdb.prepare(
          `INSERT INTO plans (name, description, gb, days, price, inbound_ids, server_id, visible, sort, category, per_user_limit, allowed_users, created_at, updated_at)
           VALUES ('پلن قدیمی ۱۵۸', '', 1, 7, 0, '[901]', ?, 1, 0, '', 0, '', ?, ?)`
        ).run(primaryId, Date.now(), Date.now());
        const legacyId28 = Number(legacyIns28.lastInsertRowid);
        const adminList28 = await request('GET', '/api/admin/plans', { cookies });
        const legacyView28 = (adminList28.json?.data?.plans || []).find((p) => Number(p.id) === legacyId28) || {};
        check('a plan written before 1.5.8 lands on the public shelf, unlimited, for everyone',
          legacyView28.category === 'public' && legacyView28.perUserLimit === 0,
          `category=${legacyView28.category} limit=${legacyView28.perUserLimit}`);
        const shopPlans28 = await request('GET', '/api/reseller/plans', { cookies: shopSess28.cookies });
        const otherPlans28 = await request('GET', '/api/reseller/plans', { cookies: otherSess28.cookies });
        const planIds28 = (res) => (res.json?.data?.plans || []).map((p) => Number(p.id));
        const shopIds28 = planIds28(shopPlans28);
        const otherIds28 = planIds28(otherPlans28);
        check('the exclusive plan is in its reseller\'s window and in nobody else\'s',
          shopIds28.includes(excl28.plan.id) && !otherIds28.includes(excl28.plan.id)
            && shopIds28.includes(test28.plan.id) && otherIds28.includes(test28.plan.id)
            && shopIds28.includes(pub28.plan.id) && otherIds28.includes(pub28.plan.id),
          `shop=${JSON.stringify(shopIds28)} other=${JSON.stringify(otherIds28)}`);
        const shopExcl28 = (shopPlans28.json?.data?.plans || []).find((p) => Number(p.id) === excl28.plan.id) || {};
        check('a reseller never reads the activation list or the sales counter, only his own quota',
          !('allowedUsers' in shopExcl28) && !('sold' in shopExcl28) && shopExcl28.taken === 0 && shopExcl28.remaining === null,
          `keys=${Object.keys(shopExcl28).join(',')}`);
        const otherCfg28 = await build28(other28.id, 'مشتری بیرونی');
        const outsider28 = await Promise.all([
          request('POST', '/api/reseller/plans/quote', { cookies: otherSess28.cookies, csrf: otherSess28.csrf, body: { planId: excl28.plan.id } }),
          request('POST', '/api/reseller/plans/new', { cookies: otherSess28.cookies, csrf: otherSess28.csrf, body: { planId: excl28.plan.id, customerName: 'دور زدن' } }),
          request('POST', '/api/reseller/plans/renew', { cookies: otherSess28.cookies, csrf: otherSess28.csrf, body: { planId: excl28.plan.id, configId: otherCfg28.id } }),
        ]);
        check('quoting, buying and renewing an exclusive plan are all refused for an outsider, even by id',
          outsider28.every((res) => res.status === 403 && code28(res) === 'plan_not_for_you'),
          outsider28.map((res) => `${res.status}:${code28(res)}`).join(' '));
        const outsiderPrev28 = await request('POST', '/api/reseller/plans/renew/preview', {
          cookies: otherSess28.cookies, csrf: otherSess28.csrf, body: { planId: excl28.plan.id, configId: otherCfg28.id },
        });
        check('the renewal preview says «not usable» instead of offering a dead button',
          outsiderPrev28.status === 200 && outsiderPrev28.json?.data?.usable === false,
          `usable=${outsiderPrev28.json?.data?.usable}`);

        // The take limit: one free test take, then a clean 409 on BOTH paths.
        const quoteOf28 = (planId, sess) => request('POST', '/api/reseller/plans/quote', {
          cookies: sess.cookies, csrf: sess.csrf, body: { planId },
        });
        const q0 = await quoteOf28(test28.plan.id, shopSess28);
        check('the quote carries the reseller\'s own counter before he buys',
          q0.status === 200 && q0.json?.data?.taken === 0 && q0.json?.data?.remaining === 1 && q0.json?.data?.limitReached === false,
          `taken=${q0.json?.data?.taken} remaining=${q0.json?.data?.remaining}`);
        const buyTest28 = await request('POST', '/api/reseller/plans/new', {
          cookies: shopSess28.cookies, csrf: shopSess28.csrf, body: { planId: test28.plan.id, customerName: 'مشتری تست' },
        });
        const testCfgId28 = Number(buyTest28.json?.data?.configs?.[0]?.id || 0);
        const ledger1 = takes28(test28.plan.id, shop28.id);
        check('one take is one ledger row, pointing at the package it built',
          buyTest28.status === 201 && ledger1.length === 1 && ledger1[0].kind === 'new'
            && Number(ledger1[0].config_id) === testCfgId28 && Number(ledger1[0].created_at) > 1700000000000,
          `rows=${ledger1.length} kind=${ledger1[0]?.kind} config=${ledger1[0]?.config_id}`);
        const q1 = await quoteOf28(test28.plan.id, shopSess28);
        const liveBefore28 = live28(shop28.id);
        const buyAgain28 = await request('POST', '/api/reseller/plans/new', {
          cookies: shopSess28.cookies, csrf: shopSess28.csrf, body: { planId: test28.plan.id, customerName: 'دوباره' },
        });
        const renewAgain28 = await request('POST', '/api/reseller/plans/renew', {
          cookies: shopSess28.cookies, csrf: shopSess28.csrf, body: { planId: test28.plan.id, configId: testCfgId28 },
        });
        check('the second take — new OR renewal — is a clean 409 before any wallet or node write',
          q1.json?.data?.limitReached === true && q1.json?.data?.remaining === 0
            && buyAgain28.status === 409 && code28(buyAgain28) === 'plan_limit_reached'
            && renewAgain28.status === 409 && code28(renewAgain28) === 'plan_limit_reached'
            && live28(shop28.id) === liveBefore28 && takes28(test28.plan.id, shop28.id).length === 1,
          `buy=${buyAgain28.status}:${code28(buyAgain28)} renew=${renewAgain28.status}:${code28(renewAgain28)} live=${live28(shop28.id)}/${liveBefore28}`);
        const prevExh28 = await request('POST', '/api/reseller/plans/renew/preview', {
          cookies: shopSess28.cookies, csrf: shopSess28.csrf, body: { planId: test28.plan.id, configId: testCfgId28 },
        });
        check('the renewal preview agrees: exhausted means unusable',
          prevExh28.status === 200 && prevExh28.json?.data?.usable === false
            && prevExh28.json?.data?.limitReached === true && prevExh28.json?.data?.remaining === 0,
          `usable=${prevExh28.json?.data?.usable} remaining=${prevExh28.json?.data?.remaining}`);

        // A priced plan with limit 2: new + renewal both count, the third is refused.
        const balBefore28 = bal28(shop28.id);
        const buyPub28 = await request('POST', '/api/reseller/plans/new', {
          cookies: shopSess28.cookies, csrf: shopSess28.csrf, body: { planId: pub28.plan.id, customerName: 'مشتری عمومی' },
        });
        const pubCfgId28 = Number(buyPub28.json?.data?.configs?.[0]?.id || 0);
        const renewPub28 = await request('POST', '/api/reseller/plans/renew', {
          cookies: shopSess28.cookies, csrf: shopSess28.csrf, body: { planId: pub28.plan.id, configId: pubCfgId28 },
        });
        const ledgerPub28 = takes28(pub28.plan.id, shop28.id);
        check('buying and renewing are both «takes»: two ledger rows, two wallet debits',
          buyPub28.status === 201 && renewPub28.status === 200
            && ledgerPub28.map((row) => row.kind).join(',') === 'new,renew'
            && balBefore28 - bal28(shop28.id) === 200,
          `kinds=${ledgerPub28.map((row) => row.kind).join(',')} debit=${balBefore28 - bal28(shop28.id)}`);
        const balAtLimit28 = bal28(shop28.id);
        const thirdPub28 = await request('POST', '/api/reseller/plans/new', {
          cookies: shopSess28.cookies, csrf: shopSess28.csrf, body: { planId: pub28.plan.id, customerName: 'سومین' },
        });
        check('the third take is refused and a refusal never touches the wallet',
          thirdPub28.status === 409 && code28(thirdPub28) === 'plan_limit_reached' && bal28(shop28.id) === balAtLimit28,
          `status=${thirdPub28.status}:${code28(thirdPub28)} balance=${bal28(shop28.id)}/${balAtLimit28}`);
        const adminPub28 = await request('GET', '/api/admin/plans', { cookies });
        const pubAdmin28 = (adminPub28.json?.data?.plans || []).find((p) => Number(p.id) === pub28.plan.id) || {};
        check('the owner sees the sales counter of his plan', pubAdmin28.sold === 2, `sold=${pubAdmin28.sold}`);

        // Limit 0 = unlimited, on the exclusive shelf, for the named reseller.
        const exclBuy1 = await request('POST', '/api/reseller/plans/new', {
          cookies: shopSess28.cookies, csrf: shopSess28.csrf, body: { planId: excl28.plan.id, customerName: 'اختصاصی یک' },
        });
        const exclBuy2 = await request('POST', '/api/reseller/plans/new', {
          cookies: shopSess28.cookies, csrf: shopSess28.csrf, body: { planId: excl28.plan.id, customerName: 'اختصاصی دو' },
        });
        const exclQuote28 = await quoteOf28(excl28.plan.id, shopSess28);
        check('limit 0 means unlimited: the named reseller takes his exclusive plan twice',
          exclBuy1.status === 201 && exclBuy2.status === 201
            && exclQuote28.json?.data?.remaining === null && exclQuote28.json?.data?.taken === 2,
          `buys=${exclBuy1.status}/${exclBuy2.status} remaining=${exclQuote28.json?.data?.remaining} taken=${exclQuote28.json?.data?.taken}`);
        const raise28 = await request('PATCH', `/api/admin/plans/${test28.plan.id}`, { cookies, csrf, body: { per_user_limit: 2 } });
        const afterRaise28 = await request('POST', '/api/reseller/plans/new', {
          cookies: shopSess28.cookies, csrf: shopSess28.csrf, body: { planId: test28.plan.id, customerName: 'بعد از افزایش' },
        });
        check('raising the ceiling reopens the plan without erasing the ledger',
          raise28.status === 200 && raise28.json?.data?.plan?.category === 'test' && raise28.json?.data?.plan?.perUserLimit === 2
            && afterRaise28.status === 201 && takes28(test28.plan.id, shop28.id).length === 2,
          `limit=${raise28.json?.data?.plan?.perUserLimit} buy=${afterRaise28.status} rows=${takes28(test28.plan.id, shop28.id).length}`);

        // Activation is a live switch: one reseller, several resellers, then nobody.
        const moveExcl28 = await request('PATCH', `/api/admin/plans/${excl28.plan.id}`, { cookies, csrf, body: { allowed_users: [other28.id] } });
        const shopAfterMove28 = await quoteOf28(excl28.plan.id, shopSess28);
        const otherAfterMove28 = await quoteOf28(excl28.plan.id, otherSess28);
        check('moving the activation: the old reseller loses the plan and the new one gains it',
          moveExcl28.status === 200 && shopAfterMove28.status === 403 && otherAfterMove28.status === 200,
          `shop=${shopAfterMove28.status} other=${otherAfterMove28.status}`);
        const bothExcl28 = await request('PATCH', `/api/admin/plans/${excl28.plan.id}`, {
          cookies, csrf, body: { allowed_users: [shop28.id, other28.id] },
        });
        const qShopBoth28 = await quoteOf28(excl28.plan.id, shopSess28);
        const qOtherBoth28 = await quoteOf28(excl28.plan.id, otherSess28);
        check('one exclusive plan can be activated for several resellers at once',
          bothExcl28.status === 200 && (bothExcl28.json?.data?.plan?.allowedUsers || []).length === 2
            && qShopBoth28.status === 200 && qOtherBoth28.status === 200,
          `list=${(bothExcl28.json?.data?.plan?.allowedUsers || []).length} shop=${qShopBoth28.status} other=${qOtherBoth28.status}`);
        const toPublic28 = await request('PATCH', `/api/admin/plans/${excl28.plan.id}`, { cookies, csrf, body: { category: 'public' } });
        check('moving an exclusive plan to the public shelf drops its activation list',
          toPublic28.status === 200 && toPublic28.json?.data?.plan?.category === 'public'
            && (toPublic28.json?.data?.plan?.allowedUsers || []).length === 0,
          `category=${toPublic28.json?.data?.plan?.category} list=${JSON.stringify(toPublic28.json?.data?.plan?.allowedUsers)}`);
      } finally {
        if (lifted28) await request('PATCH', '/api/admin/settings/security', { cookies, csrf, body: { loginRateLimit: limit28 } });
        if (parked28) await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: 120 } });
        for (const email of speedEmails28) mockXui.clients.delete(email);
        mockXui.clients.delete('v158plain-one');
        bdb.close();
      }
    }

    // ═════════════════════════════════════════════════════════════════════ v2.0.0
    //
    // Three new areas, one block:
    //   ۱) «جستجوی پیشرفتهٔ کانفینگ» — field / status / ownership / inbound /
    //      quota / expiring filters plus sorting, filter-only search, and an
    //      honest matched/truncated count.
    //   ۲) «حذف زمان‌بندی‌شدهٔ اشتراک‌های تمام‌شده» — grace windows, the depleted
    //      stamp, a top-up keeping the subscription, adopted clients staying on
    //      the other panel, a refusing node keeping its package, the cap.
    //   ۳) «ارسال کانفینگ به تلگرام خود نماینده» — the HTTP guards. The full
    //      send, the caption and the QR round-trip live in test/send-config.js.
    //
    // The 60s timer only ticks when settings.cleanup.enabled is true. This block
    // keeps that switch FALSE and drives every sweep through POST /cleanup/run
    // (runCleanup itself does not read `enabled`), so no background tick can
    // race the assertions.
    {
      const bdb = new Database(path.join(DATA_DIR, 'panel.db'));
      const P20 = 'Cleanup-Pass-12345';
      const DAY20 = 86400000;
      const NOW20 = Date.now();
      const code20 = (res) => String(res.json?.error?.code || '');
      const mkUser20 = async (username, extra = {}) => {
        const created = await request('POST', '/api/admin/users', {
          cookies, csrf, body: { username, password: P20, role: 'reseller', balance: 0, max_configs: 100, ...extra },
        });
        return { id: Number(created.json?.data?.user?.id || 0), status: created.status };
      };
      const login20 = async (username) => {
        const res = await request('POST', '/api/auth/login', { body: { username, password: P20 } });
        return { status: res.status, cookies: cookiesFrom(res.headers), csrf: res.json?.data?.csrf };
      };
      const build20 = async (userId, name) => {
        const res = await request('POST', '/api/admin/configs', {
          cookies, csrf,
          body: { userId, inboundIds: [901, 902], gb: 5, days: 30, label: name, customerName: name },
        });
        const rows = res.json?.data?.configs || [];
        return { status: res.status, id: Number(rows[0]?.id || 0), email: String(rows[0]?.email || '') };
      };
      const rowsOf20 = (email) => bdb.prepare('SELECT * FROM configs WHERE email = ? ORDER BY id').all(String(email));
      const alive20 = (email) => rowsOf20(email).filter((row) => !row.deleted_at).length;
      const setExpiry20 = (email, ms) => bdb.prepare('UPDATE configs SET expiry_at = ? WHERE email = ?').run(Number(ms), String(email));
      const setUsed20 = (email, bytes) => bdb.prepare('UPDATE configs SET up_bytes = ? WHERE email = ?').run(Number(bytes), String(email));
      const cleanupPatch = (body) => request('PATCH', '/api/admin/settings/cleanup', { cookies, csrf, body });
      const preview20 = () => request('GET', '/api/admin/cleanup/preview', { cookies });
      const run20 = () => request('POST', '/api/admin/cleanup/run', { cookies, csrf });
      const resultOf20 = (summary, email) => (summary?.results || []).find((row) => row.email === email);
      const search20 = (params) => request('GET', `/api/admin/node-clients?serverId=${primaryId}&${params}`, { cookies });
      const WRITE20 = /\/clients\/(add|update\/|del\/|bulkAttach|bulkEnable|bulkDisable|bulkAdjust|resetTraffic\/)|\/detach$/;
      const seedEmails20 = [];
      const seed20 = (email, opts = {}) => {
        mockXui.clients.set(email, {
          email, id: `uuid-${email}`, uuid: String(opts.uuid || ''), subId: `sub-${email}`,
          comment: String(opts.comment || ''), totalGB: opts.totalGB ?? 10 * 1024 ** 3,
          expiryTime: opts.expiryTime ?? NOW20 + 30 * DAY20, enable: opts.enable !== false,
          up: Number(opts.up || 0), down: Number(opts.down || 0), inboundIds: opts.inboundIds || [901],
        });
        seedEmails20.push(email);
        return email;
      };
      let limit20 = 10;
      let lifted20 = false;
      let tgWas20 = null;
      try {
        const secRead20 = await request('GET', '/api/admin/settings', { cookies });
        limit20 = Number(secRead20.json?.data?.settings?.security?.loginRateLimit || 10);
        lifted20 = (await request('PATCH', '/api/admin/settings/security', {
          cookies, csrf, body: { loginRateLimit: 100 },
        })).status === 200;

        const shop20 = await mkUser20('v200shop', { balance: 1000000 });
        const stranger20 = await mkUser20('v200stranger');
        const admin20 = await mkUser20('v200admin', { role: 'admin' });
        const shopSess20 = await login20('v200shop');
        const strangerSess20 = await login20('v200stranger');
        const adminSess20 = await login20('v200admin');

        // ───────────────────────────── ۱) the advanced search, on seeded clients
        const uuidActive20 = 'f47ac10b-58cc-4372-a567-0e02b2c3d200';
        seed20('v200s-active', { comment: 'مشتری فعال', inboundIds: [901, 902], uuid: uuidActive20, up: 1024 ** 3, down: 1024 ** 3 });
        seed20('v200s-expired', { expiryTime: NOW20 - DAY20 });
        seed20('v200s-depleted', { inboundIds: [902], up: 6 * 1024 ** 3, down: 4 * 1024 ** 3 });
        seed20('v200s-disabled', { enable: false });
        seed20('v200s-unlimited', { inboundIds: [901, 902], totalGB: 0, expiryTime: 0 });
        seed20('v200s-soon', { inboundIds: [902], expiryTime: NOW20 + 2 * DAY20 });
        seed20('zzz-other-200', { comment: 'v200needle برچسب' });
        // Adopted + long expired: the sweep's external-row fixture. Its email is
        // outside the v200s prefix so the search counts below stay exact.
        seed20('v200ext-old', { expiryTime: NOW20 - 30 * DAY20 });
        const adoptA20 = await request('POST', '/api/admin/configs/adopt', {
          cookies, csrf, body: { email: 'v200s-active', userId: shop20.id, serverId: primaryId },
        });
        const adoptE20 = await request('POST', '/api/admin/configs/adopt', {
          cookies, csrf, body: { email: 'v200ext-old', userId: shop20.id, serverId: primaryId },
        });
        check('both fixtures adopt cleanly before the search runs',
          adoptA20.status === 201 && adoptE20.status === 201, `a=${adoptA20.status} e=${adoptE20.status}`);

        const mark20 = mockXui.calls.length;
        const byEmail20 = await search20('q=v200s&field=email');
        check('the field selector narrows the text to the email alone',
          byEmail20.status === 200 && (byEmail20.json?.data?.rows || []).length === 6
            && byEmail20.json.data.rows.every((row) => row.email.startsWith('v200s-')),
          `rows=${(byEmail20.json?.data?.rows || []).length}`);
        const byRemark20 = await search20('q=v200needle&field=remark');
        const byEmailNeedle20 = await search20('q=v200needle&field=email');
        check('a remark-only needle finds the labelled client — and the email field does not',
          byRemark20.status === 200 && (byRemark20.json?.data?.rows || []).length === 1
            && byRemark20.json.data.rows[0].email === 'zzz-other-200'
            && byEmailNeedle20.status === 200 && (byEmailNeedle20.json?.data?.rows || []).length === 0,
          `remark=${(byRemark20.json?.data?.rows || []).length} email=${(byEmailNeedle20.json?.data?.rows || []).length}`);
        const byUuid20 = await search20(`q=${uuidActive20}&field=uuid`);
        const bySub20 = await search20('q=sub-v200s-expired&field=subid');
        check('uuid and subscription-id each have their own field',
          byUuid20.status === 200 && (byUuid20.json?.data?.rows || []).length === 1
            && byUuid20.json.data.rows[0].email === 'v200s-active'
            && bySub20.status === 200 && (bySub20.json?.data?.rows || []).length === 1
            && bySub20.json.data.rows[0].email === 'v200s-expired',
          `uuid=${(byUuid20.json?.data?.rows || []).length} sub=${(bySub20.json?.data?.rows || []).length}`);
        const stExp20 = await search20('q=v200s&status=expired');
        const stDep20 = await search20('q=v200s&status=depleted');
        const stDis20 = await search20('q=v200s&status=disabled');
        const stAct20 = await search20('q=v200s&status=active');
        check('the status filter splits the six exactly: 1 expired, 1 depleted, 1 disabled, 3 active',
          (stExp20.json?.data?.rows || []).length === 1 && stExp20.json.data.rows[0].email === 'v200s-expired'
            && (stDep20.json?.data?.rows || []).length === 1 && stDep20.json.data.rows[0].email === 'v200s-depleted'
            && (stDis20.json?.data?.rows || []).length === 1 && stDis20.json.data.rows[0].email === 'v200s-disabled'
            && (stAct20.json?.data?.rows || []).length === 3,
          `exp=${(stExp20.json?.data?.rows || []).length} dep=${(stDep20.json?.data?.rows || []).length} dis=${(stDis20.json?.data?.rows || []).length} act=${(stAct20.json?.data?.rows || []).length}`);
        const filterOnly20 = await search20('q=&status=depleted');
        const foRows20 = filterOnly20.json?.data?.rows || [];
        check('«همهٔ تمام‌شده‌های این نود» — a filter alone is a legitimate search',
          filterOnly20.status === 200 && foRows20.length >= 1
            && foRows20.every((row) => row.status === 'depleted')
            && foRows20.some((row) => row.email === 'v200s-depleted'),
          `status=${filterOnly20.status} rows=${foRows20.length}`);
        const oneChar20 = await search20('q=a&status=expired');
        const noQuery20 = await search20('q=');
        check('one character is still too short even with a filter, and nothing at all is refused',
          oneChar20.status === 422 && code20(oneChar20) === 'query_too_short'
            && noQuery20.status === 422 && code20(noQuery20) === 'query_too_short',
          `one=${oneChar20.status} none=${noQuery20.status}`);
        const quotaUn20 = await search20('q=v200s&quota=unlimited');
        const quotaLi20 = await search20('q=v200s&quota=limited');
        check('the quota filter separates the unlimited client from the five limited ones',
          (quotaUn20.json?.data?.rows || []).length === 1 && quotaUn20.json.data.rows[0].email === 'v200s-unlimited'
            && (quotaLi20.json?.data?.rows || []).length === 5,
          `un=${(quotaUn20.json?.data?.rows || []).length} li=${(quotaLi20.json?.data?.rows || []).length}`);
        const soon20 = await search20('q=v200s&expiringDays=5');
        check('«تا ۵ روز دیگر منقضی می‌شوند» finds exactly the one expiring soon',
          soon20.status === 200 && (soon20.json?.data?.rows || []).length === 1
            && soon20.json.data.rows[0].email === 'v200s-soon',
          `rows=${(soon20.json?.data?.rows || []).length}`);
        const inb902id20 = Number(bdb.prepare('SELECT id FROM inbounds WHERE server_id = ? AND xui_id = 902').get(primaryId)?.id || 0);
        const byInb20 = await search20(`q=v200s&inboundId=${inb902id20}`);
        check('the inbound filter keeps only the clients attached to that channel',
          inb902id20 > 0 && (byInb20.json?.data?.rows || []).length === 4
            && byInb20.json.data.rows.every((row) => (row.inboundIds || []).includes(902)),
          `inb=${inb902id20} rows=${(byInb20.json?.data?.rows || []).length}`);
        const ownAd20 = await search20('q=v200s&ownership=adopted');
        const ownFr20 = await search20('q=v200s&ownership=free');
        check('ownership tells the adopted client apart from the five free ones',
          (ownAd20.json?.data?.rows || []).length === 1 && ownAd20.json.data.rows[0].email === 'v200s-active'
            && ownAd20.json.data.rows[0].adopted === true && (ownFr20.json?.data?.rows || []).length === 5,
          `adopted=${(ownAd20.json?.data?.rows || []).length} free=${(ownFr20.json?.data?.rows || []).length}`);
        const sortUsed20 = await search20('q=v200s&sortBy=used&sortDir=desc');
        const suRows20 = sortUsed20.json?.data?.rows || [];
        check('sorting by usage puts the drained client first and never rises afterwards',
          suRows20.length === 6 && suRows20[0].email === 'v200s-depleted'
            && suRows20.every((row, i) => i === 0 || Number(suRows20[i - 1].used) >= Number(row.used)),
          `first=${suRows20[0]?.email}`);
        const capped20 = await search20('q=v200s&sortBy=email&limit=2');
        check('a small limit cuts the page but reports the whole match honestly',
          capped20.status === 200 && (capped20.json?.data?.rows || []).length === 2
            && capped20.json.data.matched === 6 && capped20.json.data.truncated === true,
          `rows=${(capped20.json?.data?.rows || []).length} matched=${capped20.json?.data?.matched}`);
        const bogus20 = await search20('q=v200s&status=bogus');
        check('an unknown enum value degrades to «no filter», not an error',
          bogus20.status === 200 && bogus20.json?.data?.filters?.status === ''
            && (bogus20.json?.data?.rows || []).length === 6,
          `status=${bogus20.status} filters.status=${bogus20.json?.data?.filters?.status}`);
        check('the whole advanced search stayed a read: not one write reached the node',
          mockXui.calls.slice(mark20).filter((call) => WRITE20.test(call.route)).length === 0,
          `writes=${mockXui.calls.slice(mark20).filter((call) => WRITE20.test(call.route)).map((call) => call.route).join(',') || 'none'}`);

        // ───────────────────────────── ۲) the scheduled sweep
        const cols20 = bdb.prepare('PRAGMA table_info(configs)').all().map((row) => row.name);
        const settingsCount20 = Number(bdb.prepare('SELECT COUNT(*) AS c FROM settings').get().c);
        const setRead20 = await request('GET', '/api/admin/settings', { cookies });
        const cleanupCfg20 = setRead20.json?.data?.settings?.cleanup || {};
        // v2.1.0: the twelfth row is `banner` (the owner's notice bar).
        check('the fresh schema carries the sweep: configs.depleted_at and the eleventh settings row, born off',
          cols20.includes('depleted_at') && settingsCount20 === 12
            && cleanupCfg20.enabled === false && Number(cleanupCfg20.graceDays) === 7,
          `depleted_at=${cols20.includes('depleted_at')} settings=${settingsCount20} enabled=${cleanupCfg20.enabled}`);
        const deadSwitch20 = await cleanupPatch({ enabled: true, expired: false, depleted: false });
        check('a schedule switched on with both states off is refused',
          deadSwitch20.status === 422 && code20(deadSwitch20) === 'cleanup_nothing_selected',
          `status=${deadSwitch20.status} code=${code20(deadSwitch20)}`);
        const clamp20 = await cleanupPatch({ graceDays: 9999, intervalHours: 9999, maxPerRun: 99999 });
        check('greedy numbers are clamped, not accepted',
          clamp20.status === 200 && Number(clamp20.json?.data?.saved?.graceDays) === 365
            && Number(clamp20.json?.data?.saved?.intervalHours) === 168
            && Number(clamp20.json?.data?.saved?.maxPerRun) === 500,
          `grace=${clamp20.json?.data?.saved?.graceDays} interval=${clamp20.json?.data?.saved?.intervalHours} max=${clamp20.json?.data?.saved?.maxPerRun}`);
        await cleanupPatch({ graceDays: 7, intervalHours: 6, maxPerRun: 50 });
        const fakeRun20 = await cleanupPatch({ lastRunAt: 5, lastSummary: 'fake' });
        const afterFake20 = (await request('GET', '/api/admin/settings', { cookies })).json?.data?.settings?.cleanup || {};
        check('the form cannot fake the last-run bookkeeping',
          fakeRun20.status === 200 && Number(afterFake20.lastRunAt || 0) === 0 && String(afterFake20.lastSummary || '') === '',
          `lastRunAt=${afterFake20.lastRunAt} lastSummary=${afterFake20.lastSummary}`);
        const resPreview20 = await request('GET', '/api/admin/cleanup/preview', { cookies: shopSess20.cookies });
        const resRun20 = await request('POST', '/api/admin/cleanup/run', { cookies: shopSess20.cookies, csrf: shopSess20.csrf });
        check('the sweep is the admin\'s: a reseller gets 403 on both preview and run',
          resPreview20.status === 403 && resRun20.status === 403, `preview=${resPreview20.status} run=${resRun20.status}`);
        const on20 = await cleanupPatch({ enabled: true });
        const off20 = await cleanupPatch({ enabled: false });
        check('the master switch turns on and off cleanly',
          on20.status === 200 && on20.json?.data?.saved?.enabled === true
            && off20.status === 200 && off20.json?.data?.saved?.enabled === false,
          `on=${on20.status} off=${off20.status}`);

        // Five packages for shop20, each in a different state. The sweep reads
        // the panel's own rows (packageStatusSql), so the DB edits below are the
        // fixture — the node keeps serving every client until a delete lands.
        const expiredOld20 = await build20(shop20.id, 'منقضی قدیمی');
        const expiredFresh20 = await build20(shop20.id, 'منقضی تازه');
        const depletedPkg20 = await build20(shop20.id, 'تمام‌شده');
        const activePkg20 = await build20(shop20.id, 'سالم');
        const toppedUp20 = await build20(shop20.id, 'شارژ شده');
        setExpiry20(expiredOld20.email, NOW20 - 20 * DAY20);
        setExpiry20(expiredFresh20.email, NOW20 - 2 * DAY20);
        setUsed20(depletedPkg20.email, 5 * 1024 ** 3);
        setUsed20(toppedUp20.email, 5 * 1024 ** 3);
        bdb.prepare('UPDATE configs SET depleted_at = ? WHERE email = ?').run(NOW20 - 10 * DAY20, toppedUp20.email);
        bdb.prepare('UPDATE configs SET total_bytes = ? WHERE email = ?').run(10 * 1024 ** 3, toppedUp20.email);
        await cleanupPatch({ expired: true, depleted: true, graceDays: 7, maxPerRun: 500, includeExternal: false, notifyReseller: false });

        const delCallsBefore20 = mockXui.calls.filter((call) => call.route.startsWith('/clients/del/')).length;
        const pv20 = await preview20();
        const pd20 = pv20.json?.data || {};
        const pvOld20 = resultOf20(pd20, expiredOld20.email);
        const pvDep20 = resultOf20(pd20, depletedPkg20.email);
        check('the preview says exactly what would happen: the old expired goes, the full one gets its stamp',
          pv20.status === 200 && pd20.dryRun === true
            && pvOld20?.action === 'would_delete' && pvOld20?.reason === 'expired_grace'
            && pvDep20?.action === 'would_stamp'
            && !resultOf20(pd20, expiredFresh20.email) && !resultOf20(pd20, activePkg20.email),
          `old=${pvOld20?.action} dep=${pvDep20?.action}`);
        check('the preview wrote nothing: rows alive, no stamp, no delete on the node',
          alive20(expiredOld20.email) === 2 && alive20(depletedPkg20.email) === 2
            && rowsOf20(depletedPkg20.email).every((row) => Number(row.depleted_at) === 0)
            && mockXui.calls.filter((call) => call.route.startsWith('/clients/del/')).length === delCallsBefore20,
          `oldAlive=${alive20(expiredOld20.email)} depAlive=${alive20(depletedPkg20.email)}`);
        const r120 = await run20();
        const rd120 = r120.json?.data || {};
        check('the first sweep deletes the long-expired and stamps the newly-full, nothing else',
          r120.status === 200 && resultOf20(rd120, expiredOld20.email)?.action === 'deleted'
            && resultOf20(rd120, depletedPkg20.email)?.action === 'stamped'
            && alive20(expiredOld20.email) === 0 && alive20(expiredFresh20.email) === 2 && alive20(activePkg20.email) === 2
            && rowsOf20(depletedPkg20.email).every((row) => Number(row.depleted_at) > 0),
          `old=${resultOf20(rd120, expiredOld20.email)?.action} dep=${resultOf20(rd120, depletedPkg20.email)?.action}`);
        check('a topped-up customer keeps his subscription and loses the old stamp',
          alive20(toppedUp20.email) === 2 && rowsOf20(toppedUp20.email).every((row) => Number(row.depleted_at) === 0),
          `alive=${alive20(toppedUp20.email)} stamp=${rowsOf20(toppedUp20.email)[0]?.depleted_at}`);
        const auditDel20 = bdb.prepare("SELECT details FROM audit_logs WHERE action = 'config.auto_delete' ORDER BY id DESC").all().map((row) => String(row.details));
        const auditRun20 = Number(bdb.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'cleanup.run'").get().c);
        check('the sweep leaves its trail: an auto-delete audit naming the customer and the reason, plus a run audit',
          auditDel20.some((details) => details.includes(expiredOld20.email) && details.includes('expired_grace')) && auditRun20 >= 1,
          `autoDeletes=${auditDel20.length} runs=${auditRun20}`);
        const afterRun20 = (await request('GET', '/api/admin/settings', { cookies })).json?.data?.settings?.cleanup || {};
        let sumParsed20 = null;
        try { sumParsed20 = JSON.parse(String(afterRun20.lastSummary || '')); } catch (_) { sumParsed20 = null; }
        check('the settings row remembers the last run',
          Number(afterRun20.lastRunAt || 0) > 0 && sumParsed20 && Number(sumParsed20.deleted) >= 1,
          `lastRunAt=${afterRun20.lastRunAt} summary=${String(afterRun20.lastSummary || '').slice(0, 80)}`);
        const r220 = await run20();
        const rd220 = r220.json?.data || {};
        check('the second sweep respects the grace window: the stamped package is skipped, not deleted',
          r220.status === 200 && Number(rd220.skippedGrace) >= 1
            && alive20(depletedPkg20.email) === 2 && !resultOf20(rd220, depletedPkg20.email),
          `skippedGrace=${rd220.skippedGrace} alive=${alive20(depletedPkg20.email)}`);
        bdb.prepare('UPDATE configs SET depleted_at = ? WHERE email = ?').run(NOW20 - 8 * DAY20, depletedPkg20.email);
        const r320 = await run20();
        const rd320 = r320.json?.data || {};
        const depRes320 = resultOf20(rd320, depletedPkg20.email);
        check('once the grace window passes, the full package goes too — with its own reason',
          depRes320?.action === 'deleted' && depRes320?.reason === 'depleted_grace' && alive20(depletedPkg20.email) === 0,
          `action=${depRes320?.action} reason=${depRes320?.reason}`);
        check('an adopted customer is never swept while includeExternal is off',
          Number(rd320.skippedExternal) >= 1 && alive20('v200ext-old') >= 1 && mockXui.clients.has('v200ext-old'),
          `skippedExternal=${rd320.skippedExternal} alive=${alive20('v200ext-old')}`);
        await cleanupPatch({ includeExternal: true });
        const delMarkExt20 = mockXui.calls.length;
        await run20();
        check('with includeExternal on, only the local rows go — the other panel\'s client stays',
          alive20('v200ext-old') === 0 && mockXui.clients.has('v200ext-old')
            && mockXui.calls.slice(delMarkExt20).every((call) => !call.route.includes('/clients/del/v200ext-old')),
          `alive=${alive20('v200ext-old')} onNode=${mockXui.clients.has('v200ext-old')}`);
        await cleanupPatch({ includeExternal: false });

        // The per-run cap, measured against whatever is eligible right now.
        const capA20 = await build20(shop20.id, 'سقف الف');
        const capB20 = await build20(shop20.id, 'سقف ب');
        setExpiry20(capA20.email, NOW20 - 20 * DAY20);
        setExpiry20(capB20.email, NOW20 - 20 * DAY20);
        const eligible20 = Number(((await preview20()).json?.data || {}).eligible || 0);
        await cleanupPatch({ maxPerRun: 1 });
        const rCap20 = (await run20()).json?.data || {};
        check('the per-run cap holds: one goes, the rest are counted as capped',
          eligible20 >= 2 && Number(rCap20.deleted) === 1 && Number(rCap20.capped) === eligible20 - 1,
          `eligible=${eligible20} deleted=${rCap20.deleted} capped=${rCap20.capped}`);
        await cleanupPatch({ maxPerRun: 500 });
        const rRest20 = (await run20()).json?.data || {};
        check('raising the cap clears the backlog on the next sweep',
          Number(rRest20.deleted) === eligible20 - 1 && alive20(capA20.email) + alive20(capB20.email) === 0,
          `deleted=${rRest20.deleted} expected=${eligible20 - 1}`);

        const refusePkg20 = await build20(shop20.id, 'نود سرسخت');
        setExpiry20(refusePkg20.email, NOW20 - 20 * DAY20);
        mockXui.quirks.failDel.add(refusePkg20.email);
        const rRef20 = (await run20()).json?.data || {};
        const refRes20 = resultOf20(rRef20, refusePkg20.email);
        mockXui.quirks.failDel.delete(refusePkg20.email);
        check('a node that refuses the delete keeps the package — the sweep reports the failure',
          refRes20?.action === 'failed' && Number(rRef20.failed) >= 1
            && alive20(refusePkg20.email) === 2 && mockXui.clients.has(refusePkg20.email),
          `action=${refRes20?.action} alive=${alive20(refusePkg20.email)}`);
        const gonePkg20 = await build20(shop20.id, 'رفته از نود');
        setExpiry20(gonePkg20.email, NOW20 - 20 * DAY20);
        mockXui.clients.delete(gonePkg20.email);
        const rGone20 = (await run20()).json?.data || {};
        const goneRes20 = resultOf20(rGone20, gonePkg20.email);
        check('a client already off the node is a success — and the refused package goes on the retry',
          goneRes20?.action === 'deleted' && Number(goneRes20?.alreadyGone) >= 1
            && alive20(gonePkg20.email) === 0 && alive20(refusePkg20.email) === 0,
          `action=${goneRes20?.action} alreadyGone=${goneRes20?.alreadyGone} refuseAlive=${alive20(refusePkg20.email)}`);
        const notesBefore20 = Number(bdb.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title = 'اشتراک حذف شد'").get(shop20.id).c);
        await cleanupPatch({ notifyReseller: true });
        const notifyPkg20 = await build20(shop20.id, 'با خبر');
        setExpiry20(notifyPkg20.email, NOW20 - 20 * DAY20);
        await run20();
        const notesAfter20 = Number(bdb.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title = 'اشتراک حذف شد'").get(shop20.id).c);
        check('with the notice on, the reseller is told which subscription the sweep removed',
          notesAfter20 === notesBefore20 + 1 && alive20(notifyPkg20.email) === 0,
          `notes=${notesBefore20}→${notesAfter20}`);

        // ───────────────────────────── ۳) «ارسال به تلگرام من» — the HTTP guards
        // (the successful send, the caption and the QR itself are proven in
        // test/send-config.js with a recorded bot transport — no network here).
        const sendNoId20 = await request('POST', `/api/reseller/configs/${activePkg20.id}/send-telegram`, { cookies: shopSess20.cookies, csrf: shopSess20.csrf });
        check('without a numeric Telegram id on the account the send is refused honestly',
          sendNoId20.status === 422 && code20(sendNoId20) === 'telegram_id_required',
          `status=${sendNoId20.status} code=${code20(sendNoId20)}`);
        bdb.prepare('UPDATE users SET telegram_id = ? WHERE id = ?').run('770200777', shop20.id);
        const tgRead20 = await request('GET', '/api/admin/settings', { cookies });
        tgWas20 = { botEnabled: Boolean(tgRead20.json?.data?.settings?.telegram?.botEnabled) };
        await request('PATCH', '/api/admin/settings/telegram', { cookies, csrf, body: { botEnabled: false } });
        const sendBotOff20 = await request('POST', `/api/reseller/configs/${activePkg20.id}/send-telegram`, { cookies: shopSess20.cookies, csrf: shopSess20.csrf });
        check('with the bot switched off the send is refused too',
          sendBotOff20.status === 422 && code20(sendBotOff20) === 'bot_disabled',
          `status=${sendBotOff20.status} code=${code20(sendBotOff20)}`);
        const sendStranger20 = await request('POST', `/api/reseller/configs/${activePkg20.id}/send-telegram`, { cookies: strangerSess20.cookies, csrf: strangerSess20.csrf });
        check('another reseller cannot send someone else\'s config to his own chat',
          sendStranger20.status === 403, `status=${sendStranger20.status}`);
        const sendAdmin20 = await request('POST', `/api/admin/configs/${activePkg20.id}/send-telegram`, { cookies: adminSess20.cookies, csrf: adminSess20.csrf });
        check('the admin route exists and asks for the same numeric id',
          sendAdmin20.status === 422 && code20(sendAdmin20) === 'telegram_id_required',
          `status=${sendAdmin20.status} code=${code20(sendAdmin20)}`);
      } finally {
        await cleanupPatch({ enabled: false, expired: true, depleted: true, graceDays: 7, intervalHours: 6, maxPerRun: 50, includeExternal: false, notifyReseller: true });
        if (tgWas20) await request('PATCH', '/api/admin/settings/telegram', { cookies, csrf, body: { botEnabled: tgWas20.botEnabled } });
        if (lifted20) await request('PATCH', '/api/admin/settings/security', { cookies, csrf, body: { loginRateLimit: limit20 } });
        for (const email of seedEmails20) mockXui.clients.delete(email);
        bdb.close();
      }
    }

    // ═════════════════════════════════════════════════════════════════════ v2.1.0
    //
    // Four new areas, one block:
    //   ۱) the live listener — the panel port, the public address and the two
    //      certificate paths are not stored text any more; they ARE the socket the
    //      panel answers on, so every claim here is proved by knocking on the port.
    //   ۲) the admin Trash — a deleted package leaves a snapshot with the email,
    //      uuid and subscription token it had, and «همون اشتراک قبلیشو میخوام» has
    //      to come back with the volume and the days that were still unused.
    //   ۳) the owner's banner — green or red, for all resellers or for the ones he
    //      picked, inside an optional window.
    //   ۴) the shape a fresh 2.1.0 install boots with.
    //
    // Anything where the port is in play goes through `onPort()`, never through
    // `request()`: Node keeps sockets alive per host, so a pooled agent could
    // answer from a connection to a port the panel already let go — and that is
    // exactly the thing these checks must never fake.
    {
      const tdb = new Database(path.join(DATA_DIR, 'panel.db'));
      const P21 = 'Trash-Pass-12345';
      const DAY21 = 86400000;
      const GB21 = 1024 ** 3;
      const NOW21 = Date.now();
      const code21 = (res) => String(res.json?.error?.code || '');
      const netOf21 = (res) => res.json?.data?.net || {};
      const settingsRead21 = async () => (await request('GET', '/api/admin/settings', { cookies })).json?.data?.settings || {};
      const generalRead21 = async () => (await settingsRead21()).general || {};
      const patchGeneral21 = (body, { port, tls = false } = {}) => onPort(Number(port || PORT), 'PATCH',
        '/api/admin/settings/general', { body, cookies, csrf, tls });
      const patchBanner21 = (body) => request('PATCH', '/api/admin/settings/banner', { cookies, csrf, body });
      const health21 = (port, tls = false) => onPort(port, 'GET', '/api/health', { tls });
      const trashList21 = (params) => request('GET', `/api/admin/trash?${params}`, { cookies });
      const trashRow21 = (id) => tdb.prepare('SELECT * FROM config_trash WHERE id = ?').get(Number(id)) || {};
      const newestTrash21 = (email) => tdb.prepare('SELECT * FROM config_trash WHERE email = ? ORDER BY id DESC LIMIT 1').get(String(email)) || {};
      const rowsOf21 = (email) => tdb.prepare('SELECT * FROM configs WHERE email = ? ORDER BY id').all(String(email));
      const alive21 = (email) => rowsOf21(email).filter((row) => !row.deleted_at);
      const buriedOf21 = (email) => rowsOf21(email).filter((row) => Number(row.deleted_at) > 0);
      const rowIdOf21 = (email, inboundId) => Number(tdb.prepare(
        'SELECT id FROM configs WHERE email = ? AND inbound_id = ? AND deleted_at = 0'
      ).get(String(email), Number(inboundId))?.id || 0);
      const build21 = async (userId, name, { gb = 5, days = 30 } = {}) => {
        const res = await request('POST', '/api/admin/configs', {
          cookies, csrf,
          body: { userId, inboundIds: [901, 902], gb, days, label: name, customerName: name },
        });
        const made = res.json?.data?.configs || [];
        return {
          status: res.status,
          id: Number(made[0]?.id || 0),
          email: String(made[0]?.email || ''),
          uuid: String(made[0]?.uuid || ''),
          ids: made.map((row) => Number(row.id)),
        };
      };
      const deleteRow21 = (id) => request('DELETE', `/api/admin/configs/${id}`, { cookies, csrf });
      const deletePackage21 = (id) => request('DELETE', `/api/admin/configs/${id}/package`, { cookies, csrf });
      const restore21 = (id, body = {}) => request('POST', `/api/admin/trash/${id}/restore`, { cookies, csrf, body });
      const setUsage21 = (email, up, down) => tdb.prepare('UPDATE configs SET up_bytes = ?, down_bytes = ? WHERE email = ?')
        .run(Number(up), Number(down), String(email));
      const setExpiry21 = (email, ms) => tdb.prepare('UPDATE configs SET expiry_at = ? WHERE email = ?').run(Number(ms), String(email));
      const mkUser21 = async (username, extra = {}) => {
        const created = await request('POST', '/api/admin/users', {
          cookies, csrf, body: { username, password: P21, role: 'reseller', balance: 4000000, max_configs: 100, ...extra },
        });
        return { id: Number(created.json?.data?.user?.id || 0), status: created.status };
      };
      const login21 = async (username) => {
        const res = await request('POST', '/api/auth/login', { body: { username, password: P21 } });
        return { status: res.status, cookies: cookiesFrom(res.headers), csrf: res.json?.data?.csrf };
      };
      const seedEmails21 = [];
      const seed21 = (email, opts = {}) => {
        mockXui.clients.set(email, {
          email, id: `uuid-${email}`, subId: `sub-${email}`, security: 'auto', comment: '',
          totalGB: opts.totalGB ?? 2 * GB21, expiryTime: opts.expiryTime ?? NOW21 + 30 * DAY21,
          enable: true, up: 0, down: 0, inboundIds: opts.inboundIds || [901],
        });
        seedEmails21.push(email);
        return email;
      };
      const onPosix21 = process.platform !== 'win32';
      const certDir21 = fs.mkdtempSync(path.join(os.tmpdir(), 'sc210-cert-'));
      const certPair21 = () => {
        const cert = path.join(certDir21, 'sc210.crt');
        const key = path.join(certDir21, 'sc210.key');
        const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
          '-out', cert, '-days', '2', '-subj', 'CN=127.0.0.1'], { encoding: 'utf8' });
        if (made.status !== 0 || !fs.existsSync(cert) || !fs.existsSync(key)) return null;
        return { cert, key };
      };
      let was21 = null;
      let bannerWas21 = null;
      let limit21 = 10;
      let lifted21 = false;
      let busy21 = null;
      let movedTo21 = 0;
      try {
        const secRead21 = await request('GET', '/api/admin/settings', { cookies });
        limit21 = Number(secRead21.json?.data?.settings?.security?.loginRateLimit || 10);
        lifted21 = (await request('PATCH', '/api/admin/settings/security', {
          cookies, csrf, body: { loginRateLimit: 100 },
        })).status === 200;

        // ───────────────────────── ۱) «تغییر پورت پنل» — the settings ARE the socket
        was21 = await generalRead21();
        const sysHome21 = netOf21(await request('GET', '/api/admin/system', { cookies }));
        check('the system read knows the socket the panel is really on',
          sysHome21.listening === true && Number(sysHome21.port) === PORT && sysHome21.tls === false
            && Number(sysHome21.desiredPort) === Number(was21.panelPort || PORT),
          `port=${sysHome21.port} desired=${sysHome21.desiredPort}`);

        const lowPort21 = await patchGeneral21({ panelPort: 80 });
        const wordPort21 = await patchGeneral21({ panelPort: 'پنل' });
        check('a port below 1024 and a port that is not a number are both refused',
          lowPort21.status === 422 && code21(lowPort21) === 'invalid_panel_port'
            && wordPort21.status === 422 && code21(wordPort21) === 'invalid_panel_port',
          `low=${code21(lowPort21)} word=${code21(wordPort21)}`);
        const genAfterBad21 = await generalRead21();
        check('a refused port writes nothing — the stored number is still the live one',
          Number(genAfterBad21.panelPort) === Number(was21.panelPort),
          `stored=${genAfterBad21.panelPort} was=${was21.panelPort}`);

        busy21 = http.createServer();
        await new Promise((resolve) => busy21.listen(0, '127.0.0.1', resolve));
        const busyPort21 = busy21.address().port;
        const busyTry21 = await patchGeneral21({ panelPort: busyPort21 });
        const netBusy21 = netOf21(busyTry21);
        check('a port somebody else holds is TRIED before anything is written, then refused',
          busyTry21.status === 422 && code21(busyTry21) === 'panel_port_busy' && !netBusy21.port,
          `code=${code21(busyTry21)} body=${JSON.stringify(netBusy21)}`);
        const busyHealth21 = await health21(PORT);
        const genAfterBusy21 = await generalRead21();
        check('the refusal costs nothing: the panel answers and the number was not stored',
          busyHealth21.status === 200 && Number(genAfterBusy21.panelPort) === Number(was21.panelPort),
          `health=${busyHealth21.status} stored=${genAfterBusy21.panelPort}`);
        await new Promise((resolve) => busy21.close(resolve));
        busy21 = null;

        const movePort21 = await freePort();
        const moveOut21 = await patchGeneral21({ panelPort: movePort21 });
        const netMove21 = netOf21(moveOut21);
        movedTo21 = movePort21;
        check('a free port is really taken over — the answer comes back with the new number',
          moveOut21.status === 200 && netMove21.changed === true && Number(netMove21.port) === movePort21,
          `status=${moveOut21.status} changed=${netMove21.changed} port=${netMove21.port}`);
        const newHealth21 = await health21(movePort21);
        const oldHealth21 = await health21(PORT);
        check('the panel answers on the new port and the old one is empty',
          newHealth21.status === 200 && oldHealth21.status === 0 && /ECONNREFUSED/.test(String(oldHealth21.error)),
          `new=${newHealth21.status} old=${oldHealth21.error}`);
        const meOnNew21 = await onPort(movePort21, 'GET', '/api/auth/me', { cookies });
        const sysOnNew21 = netOf21(await onPort(movePort21, 'GET', '/api/admin/system', { cookies }));
        check('the session that was logged in before the move works after it, on the new port',
          meOnNew21.status === 200 && Number(sysOnNew21.port) === movePort21
            && Number(sysOnNew21.desiredPort) === movePort21,
          `me=${meOnNew21.status} reported=${sysOnNew21.port}/${sysOnNew21.desiredPort}`);
        const moveBack21 = await patchGeneral21({ panelPort: PORT }, { port: movePort21 });
        const netBack21 = netOf21(moveBack21);
        movedTo21 = 0;
        check('moving back is asked through the port the panel is standing on right now',
          moveBack21.status === 200 && netBack21.changed === true && Number(netBack21.port) === PORT,
          `status=${moveBack21.status} port=${netBack21.port}`);
        const homeHealth21 = await health21(PORT);
        const goneHealth21 = await health21(movePort21);
        check('and both sockets are proved again after the move back',
          homeHealth21.status === 200 && goneHealth21.status === 0,
          `home=${homeHealth21.status} moved=${goneHealth21.error}`);

        const badUrl21 = await patchGeneral21({ publicUrl: 'sulduz.example.test' });
        check('an address without http(s):// is refused before it can break a subscribe link',
          badUrl21.status === 422 && code21(badUrl21) === 'invalid_public_url', `code=${code21(badUrl21)}`);
        const goodUrl21 = await patchGeneral21({ publicUrl: 'https://panel.example.test/' });
        const genUrl21 = await generalRead21();
        check('a full address is stored without its trailing slash and is live at once',
          goodUrl21.status === 200 && genUrl21.publicUrl === 'https://panel.example.test'
            && netOf21(goodUrl21).publicUrl === 'https://panel.example.test',
          `stored=${genUrl21.publicUrl}`);

        const relCert21 = await patchGeneral21({ sslCertPath: 'etc/ssl/sc210.crt' });
        check('a certificate path has to be absolute — a relative one would be a guess',
          relCert21.status === 422 && code21(relCert21) === 'invalid_cert_path', `code=${code21(relCert21)}`);
        const halfPair21 = await patchGeneral21({ sslCertPath: '/etc/ssl/sc210-full.crt' });
        check('one box of the pair is refused: half a key pair silently means no HTTPS',
          halfPair21.status === 422 && code21(halfPair21) === 'cert_pair_incomplete', `code=${code21(halfPair21)}`);
        const absent21 = await patchGeneral21({ sslCertPath: path.join(certDir21, 'sc210-absent.crt'), sslKeyPath: path.join(certDir21, 'sc210-absent.key') });
        const netAbsent21 = netOf21(absent21);
        const absentHealth21 = await health21(PORT);
        check('two paths to files that are not there save, name the file, and do not touch the socket',
          absent21.status === 200 && netAbsent21.changed === false && netAbsent21.tls === false
            && String(netAbsent21.tlsError).includes('sc210-absent.crt') && absentHealth21.status === 200,
          `changed=${netAbsent21.changed} err=${String(netAbsent21.tlsError).slice(0, 60)}`);
        await patchGeneral21({ sslCertPath: '', sslKeyPath: '' });

        // The same-port HTTPS switch is the regression this version was written to
        // close: one process cannot hold one port twice, so binding TLS over the
        // port the panel is already sitting on used to fail with EADDRINUSE while
        // the form said it was on.
        const pair21 = onPosix21 ? certPair21() : null;
        if (pair21) {
          const tlsOn21 = await patchGeneral21({ sslCertPath: pair21.cert, sslKeyPath: pair21.key });
          const netTls21 = netOf21(tlsOn21);
          check('a real key pair switches the SAME port to HTTPS',
            tlsOn21.status === 200 && netTls21.changed === true && netTls21.tls === true
              && netTls21.scheme === 'https' && Number(netTls21.port) === PORT,
            `changed=${netTls21.changed} tls=${netTls21.tls} scheme=${netTls21.scheme} err=${String(netTls21.tlsError).slice(0, 60)}`);
          const httpsHealth21 = await health21(PORT, true);
          const httpsMe21 = await onPort(PORT, 'GET', '/api/auth/me', { cookies, tls: true });
          const plainNow21 = await health21(PORT, false);
          check('the panel answers over TLS — session included — and no longer in plain text',
            httpsHealth21.status === 200 && httpsMe21.status === 200 && plainNow21.status !== 200,
            `https=${httpsHealth21.status} me=${httpsMe21.status} plain=${plainNow21.status}/${plainNow21.error}`);
          const tlsOff21 = await patchGeneral21({ sslCertPath: '', sslKeyPath: '' }, { tls: true });
          const netOff21 = netOf21(tlsOff21);
          const plainBack21 = await health21(PORT);
          check('clearing both boxes moves the same port back to HTTP and the panel is plain again',
            tlsOff21.status === 200 && netOff21.changed === true && netOff21.tls === false
              && netOff21.scheme === 'http' && plainBack21.status === 200,
            `changed=${netOff21.changed} scheme=${netOff21.scheme} health=${plainBack21.status}`);
        } else {
          check('the TLS switch needs openssl on a posix box (skipped here)', true, `platform=${process.platform}`);
        }

        // ─────────────────────────────────────── ۲) the Trash and the exact rebuild
        const shop21 = await mkUser21('sc210shop', { telegram_id: '7021070210' });
        const other21 = await mkUser21('sc210other');
        const gone21 = await mkUser21('sc210gone');
        check('the three representatives the Trash tests need are alive',
          shop21.status === 201 && other21.status === 201 && gone21.status === 201,
          `shop=${shop21.id} other=${other21.id} gone=${gone21.id}`);

        const peel21 = await build21(shop21.id, 'sc210peel');
        const peelClient21 = mockXui.clients.get(peel21.email) || {};
        check('the fixture package is one client standing on two channels',
          peel21.status === 201 && peel21.ids.length === 2 && alive21(peel21.email).length === 2
            && (peelClient21.inboundIds || []).join(',') === '901,902',
          `rows=${peel21.ids.length} node=${peelClient21.inboundIds}`);
        const peelRow90221 = rowIdOf21(peel21.email, 902);
        const peelDel21 = await deleteRow21(peelRow90221);
        const peelSnaps21 = Number(tdb.prepare('SELECT COUNT(*) AS c FROM config_trash WHERE email = ?').get(peel21.email).c);
        const peelNode21 = mockXui.clients.get(peel21.email) || {};
        check('taking one channel off a live package is not a deletion — nothing enters the Trash',
          peelDel21.status === 200 && peelSnaps21 === 0 && alive21(peel21.email).length === 1
            && (peelNode21.inboundIds || []).join(',') === '901',
          `snaps=${peelSnaps21} node=${peelNode21.inboundIds}`);
        const peelRow90121 = rowIdOf21(peel21.email, 901);
        const lastDel21 = await deleteRow21(peelRow90121);
        const peelTr21 = newestTrash21(peel21.email);
        check('deleting the LAST channel leaves exactly one snapshot, with the identity inside',
          lastDel21.status === 200 && Number(peelTr21.id) > 0 && peelTr21.mode === 'soft'
            && peelTr21.reason === 'channel_last' && String(peelTr21.email) === peel21.email
            && String(peelTr21.uuid).length > 0 && Number(peelTr21.total_bytes) === 5 * GB21,
          `mode=${peelTr21.mode} reason=${peelTr21.reason} uuid=${String(peelTr21.uuid).slice(0, 8)}`);
        const peelRestore21 = await restore21(Number(peelTr21.id), { userId: shop21.id });
        const peelRevived21 = peelRestore21.json?.data?.revived || [];
        check('the restore brings the buried row ITSELF back — same id, not a copy',
          peelRestore21.status === 200 && peelRevived21.length === 1 && Number(peelRevived21[0]) === peelRow90121
            && alive21(peel21.email).length === 1,
          `revived=${peelRevived21} want=${peelRow90121} alive=${alive21(peel21.email).length}`);
        check('the channel that was set aside weeks ago stays set aside',
          buriedOf21(peel21.email).some((row) => Number(row.inbound_id) === 902 && Number(row.deleted_at) > 0),
          `buried=${buriedOf21(peel21.email).map((row) => row.inbound_id)}`);
        const peelNodeBack21 = mockXui.clients.get(peel21.email) || {};
        check('and the node has him again on the one channel the package still has',
          (peelNodeBack21.inboundIds || []).join(',') === '901' && String(peelNodeBack21.id) === String(peelTr21.uuid),
          `node=${peelNodeBack21.inboundIds} uuid=${String(peelNodeBack21.id).slice(0, 8)}`);
        check('the snapshot is stamped restored and cannot be restored a second time',
          Number(trashRow21(Number(peelTr21.id)).restored_at) > 0
            && (await restore21(Number(peelTr21.id), { userId: shop21.id })).status === 409);
        const twice21 = await restore21(Number(peelTr21.id), { userId: shop21.id });
        check('…and the refusal is named, not a database error',
          code21(twice21) === 'already_restored', `code=${code21(twice21)}`);

        const pkg21 = await build21(shop21.id, 'sc210pkg');
        tdb.prepare('UPDATE configs SET customer_name = ? WHERE email = ?').run('سارا ۲۱۰', pkg21.email);
        setUsage21(pkg21.email, 1 * GB21, 1 * GB21);
        setExpiry21(pkg21.email, NOW21 + 10 * DAY21);
        const addCallsBefore21 = mockXui.calls.filter((call) => call.route === '/clients/add').length;
        const pkgDel21 = await deletePackage21(pkg21.id);
        const pkgTr21 = newestTrash21(pkg21.email);
        const pkgMembers21 = JSON.parse(String(pkgTr21.rows_json || '[]'));
        check('deleting the whole customer is ONE snapshot carrying BOTH channels',
          pkgDel21.status === 200 && Number(pkgTr21.id) > 0 && pkgMembers21.length === 2
            && Number(tdb.prepare('SELECT COUNT(*) AS c FROM config_trash WHERE email = ?').get(pkg21.email).c) === 1,
          `members=${pkgMembers21.length}`);
        check('and it keeps what was still unused: ۲ گیگ رفته، ۳ گیگ مانده، ۱۰ روز',
          Number(pkgTr21.total_bytes) === 5 * GB21 && Number(pkgTr21.used_bytes) === 2 * GB21
            && Number(pkgTr21.left_bytes) === 3 * GB21 && Number(pkgTr21.left_days) === 10
            && String(pkgTr21.customer_name) === 'سارا ۲۱۰',
          `used=${pkgTr21.used_bytes} left=${pkgTr21.left_bytes} days=${pkgTr21.left_days} who=${pkgTr21.customer_name}`);
        const listQ21 = await trashList21('q=7021070210&includeRestored=1&pageSize=200');
        const qRows21 = listQ21.json?.data?.rows || [];
        check('the search reads the client email, so a customer is found by his node name',
          listQ21.status === 200 && qRows21.length >= 2 && qRows21.every((row) => String(row.email).startsWith('7021070210')),
          `rows=${qRows21.length}`);
        const listLabel21 = await trashList21('q=sc210pkg&pageSize=200');
        check('…and by the label or the customer name he was typed under',
          (listLabel21.json?.data?.rows || []).some((row) => row.label === 'sc210pkg'),
          `rows=${(listLabel21.json?.data?.rows || []).length}`);
        const hardBefore21 = Number(tdb.prepare("SELECT COUNT(*) AS c FROM config_trash WHERE mode = 'hard'").get().c);
        const listHard21 = await trashList21('mode=hard&pageSize=200');
        check('the mode filter counts what the database really holds',
          Number(listHard21.json?.data?.total) === hardBefore21
            && (listHard21.json?.data?.rows || []).every((row) => row.mode === 'hard'),
          `total=${listHard21.json?.data?.total} db=${hardBefore21}`);
        const listShop21 = await trashList21(`userId=${shop21.id}&includeRestored=1&pageSize=200`);
        check('one representative cannot read the Trash of another',
          (listShop21.json?.data?.rows || []).every((row) => Number(row.userId) === shop21.id)
            && (listShop21.json?.data?.rows || []).length >= 2,
          `rows=${(listShop21.json?.data?.rows || []).length}`);
        const detail21 = await request('GET', `/api/admin/trash/${pkgTr21.id}`, { cookies });
        const det21 = detail21.json?.data || {};
        check('the dialog before the rebuild shows both channels, that they are usable, and ۳ گیگ left',
          detail21.status === 200 && (det21.inbounds || []).length === 2 && det21.usable === true
            && Number(det21.entry?.leftGb) === 3 && (det21.rows || []).length === 2,
          `inbounds=${(det21.inbounds || []).length} leftGb=${det21.entry?.leftGb} usable=${det21.usable}`);

        // A live row with the same email means the customer never really went away:
        // rebuilding would hand one client two owners. The row is put back by hand
        // here — that state is a fixture, and the guard is the thing under test.
        const healRow21 = Number((pkgMembers21.find((item) => Number(item.inbound_id) === 901) || {}).id || 0);
        if (healRow21) tdb.prepare('UPDATE configs SET deleted_at = 0, enabled = 1 WHERE id = ?').run(healRow21);
        const clashRestore21 = await restore21(Number(pkgTr21.id), { userId: shop21.id });
        const addCallsAfterClash21 = mockXui.calls.filter((call) => call.route === '/clients/add').length;
        check('one row of the same customer already in the panel stops the restore — before x-ui is touched',
          clashRestore21.status === 409 && code21(clashRestore21) === 'client_exists'
            && addCallsAfterClash21 === addCallsBefore21,
          `status=${clashRestore21.status} code=${code21(clashRestore21)} adds=${addCallsAfterClash21 - addCallsBefore21}`);
        if (healRow21) tdb.prepare('UPDATE configs SET deleted_at = ?, enabled = 0 WHERE id = ?').run(Date.now(), healRow21);

        tdb.prepare('UPDATE inbounds SET enabled = 0 WHERE id IN (901, 902)').run();
        const disRestore21 = await restore21(Number(pkgTr21.id), { userId: shop21.id });
        check('a channel that has been switched off is refused by name',
          disRestore21.status === 422 && code21(disRestore21) === 'inbound_disabled',
          `status=${disRestore21.status} code=${code21(disRestore21)}`);
        tdb.prepare('UPDATE inbounds SET enabled = 1 WHERE id IN (901, 902)').run();
        const noneInbound21 = await restore21(Number(pkgTr21.id), { userId: shop21.id, inboundIds: [99999] });
        check('channel ids that no longer exist leave nothing to rebuild on',
          noneInbound21.status === 422 && code21(noneInbound21) === 'inbound_required',
          `code=${code21(noneInbound21)}`);

        const realRestore21 = await restore21(Number(pkgTr21.id), { userId: shop21.id });
        const rr21 = realRestore21.json?.data || {};
        const rrRows21 = alive21(pkg21.email);
        check('the customer comes back on BOTH channels, as the very rows he had',
          realRestore21.status === 200 && rrRows21.length === 2 && (rr21.ids || []).length === 2
            && (rr21.revived || []).length === 2
            && rrRows21.map((row) => Number(row.id)).sort().join(',') === pkg21.ids.slice().sort().join(','),
          `alive=${rrRows21.length} revived=${(rr21.revived || []).length} ids=${(rr21.ids || []).join(',')}`);
        check('same uuid, same subscription token — his own app keeps working, no new link',
          rrRows21.every((row) => String(row.uuid) === String(pkgTr21.uuid))
            && rrRows21.every((row) => String(row.sub_id) === String(pkgTr21.sub_id))
            && rrRows21.every((row) => String(row.xui_sub_id) === String((pkgMembers21[0] || {}).xui_sub_id)),
          `uuid=${String(rr21.uuid).slice(0, 8)} sub=${String((pkgMembers21[0] || {}).xui_sub_id).slice(0, 8)}`);
        const rrNode21 = mockXui.clients.get(pkg21.email) || {};
        check('and the node has him on both channels again',
          (rrNode21.inboundIds || []).map(Number).sort((a, b) => a - b).join(',') === '901,902'
            && String(rrNode21.id) === String(pkgTr21.uuid),
          `node=${rrNode21.inboundIds} uuid=${String(rrNode21.id).slice(0, 8)}`);
        check('with the plain rule he comes back with what was LEFT — ۳ گیگ, not the old ۵',
          rrRows21.every((row) => Number(row.total_bytes) === 3 * GB21),
          `total=${rrRows21.map((row) => row.total_bytes / GB21)}`);
        check('and the clock runs from the days that were unused, not from the old date',
          rrRows21.every((row) => Math.abs(Number(row.expiry_at) - (Date.now() + 10 * DAY21)) < DAY21),
          `left=${rrRows21.map((row) => Math.round((row.expiry_at - NOW21) / DAY21))}`);
        check('a rebuilt client starts with an EMPTY traffic counter — five gig is really five gig',
          rrRows21.every((row) => Number(row.up_bytes) === 0 && Number(row.down_bytes) === 0
            && Number(row.depleted_at) === 0),
          `used=${rrRows21.map((row) => (row.up_bytes + row.down_bytes) / GB21)}`);
        const listNoRestored21 = await trashList21('q=7021070210&pageSize=200');
        const listAllBack21 = await trashList21('q=7021070210&includeRestored=1&pageSize=200');
        const dbAll21 = Number(tdb.prepare("SELECT COUNT(*) AS c FROM config_trash WHERE lower(email) LIKE '%7021070210%'").get().c);
        check('a rebuilt entry drops out of the default list and is back when asked for',
          Number(listAllBack21.json?.data?.total) === dbAll21
            && (listAllBack21.json?.data?.rows || []).some((row) => row.restoredAt > 0)
            && !(listNoRestored21.json?.data?.rows || []).some((row) => row.restoredAt > 0),
          `all=${listAllBack21.json?.data?.total} db=${dbAll21} kept=${(listNoRestored21.json?.data?.rows || []).length}`);
        const counts21 = listAllBack21.json?.data?.counts || {};
        const dbCounts21 = tdb.prepare('SELECT SUM(CASE WHEN restored_at = 0 THEN 1 ELSE 0 END) AS kept, SUM(CASE WHEN restored_at > 0 THEN 1 ELSE 0 END) AS back FROM config_trash').get();
        check('the kept/back counters are the whole table, not the filtered page',
          Number(counts21.kept) === Number(dbCounts21.kept || 0) && Number(counts21.back) === Number(dbCounts21.back || 0),
          `kept=${counts21.kept}/${dbCounts21.kept} back=${counts21.back}/${dbCounts21.back}`);

        // «همون دوره و حجم قبلی» only means something when what was LEFT differs
        // from what the package WAS — so this is a fresh customer with real
        // traffic (۵ گیگ sold, ۲ رفته, ۸ روز مانده) rather than the package above,
        // whose second snapshot had just been rebuilt from its own leftovers.
        const keepPkg21 = await build21(shop21.id, 'sc210keep');
        setUsage21(keepPkg21.email, 1 * GB21, 1 * GB21);
        const keepExpiry21 = NOW21 + 8 * DAY21;
        setExpiry21(keepPkg21.email, keepExpiry21);
        const keepDel21 = await deletePackage21(keepPkg21.id);
        const keepTr21 = newestTrash21(keepPkg21.email);
        check('the snapshot holds the two different numbers: ۵ گیگ sold, ۳ گیگ and ۸ روز left',
          keepDel21.status === 200 && Number(keepTr21.total_bytes) === 5 * GB21
            && Number(keepTr21.used_bytes) === 2 * GB21 && Number(keepTr21.left_bytes) === 3 * GB21
            && Number(keepTr21.left_days) === 8 && Number(keepTr21.expiry_at) === keepExpiry21,
          `total=${keepTr21.total_bytes / GB21} used=${keepTr21.used_bytes / GB21} left=${keepTr21.left_bytes / GB21} days=${keepTr21.left_days}`);
        const keepRestore21 = await restore21(Number(keepTr21.id), { userId: shop21.id, keepUsageWindow: true });
        const keepRows21 = alive21(keepPkg21.email);
        check('«همون دوره و حجم قبلی» gives the ORIGINAL date back and the FULL volume',
          keepRestore21.status === 200 && keepRows21.length === 2
            && keepRows21.every((row) => Number(row.total_bytes) === 5 * GB21)
            && keepRows21.every((row) => Number(row.expiry_at) === keepExpiry21),
          `total=${keepRows21.map((row) => row.total_bytes / GB21)} expiry=${keepRows21.map((row) => row.expiry_at === keepExpiry21)}`);
        check('but the counters still come back EMPTY — five gig on a fresh client is five gig unused',
          keepRows21.every((row) => Number(row.up_bytes) === 0 && Number(row.down_bytes) === 0
            && Number(row.depleted_at) === 0),
          `used=${keepRows21.map((row) => (row.up_bytes + row.down_bytes) / GB21)}`);
        const keepList21 = await trashList21('q=sc210keep&pageSize=200');
        check('an entry rebuilt whole is out of the kept list, and the audit says so',
          (keepList21.json?.data?.rows || []).length === 0
            && (keepList21.json?.data?.counts || {}).kept === Number(dbCounts21.kept)
            && (keepList21.json?.data?.counts || {}).back === Number(dbCounts21.back) + 1,
          `rows=${(keepList21.json?.data?.rows || []).length} kept=${(keepList21.json?.data?.counts || {}).kept}/${dbCounts21.kept} back=${(keepList21.json?.data?.counts || {}).back}/${Number(dbCounts21.back) + 1}`);

        const expPkg21 = await build21(shop21.id, 'sc210exp', { gb: 2, days: 7 });
        setExpiry21(expPkg21.email, NOW21 - 6 * DAY21);
        await deletePackage21(expPkg21.id);
        const expTr21 = newestTrash21(expPkg21.email);
        const expRestore21 = await restore21(Number(expTr21.id), { userId: shop21.id });
        const expRows21 = alive21(expPkg21.email);
        check('a customer whose time had run out does NOT come back unlimited',
          Number(expTr21.left_days) === 0 && expRestore21.status === 200 && expRows21.length === 2
            && expRows21.every((row) => Number(row.expiry_at) === Number(expTr21.expiry_at))
            && expRows21.every((row) => Number(row.expiry_at) > 0 && Number(row.expiry_at) < Date.now()),
          `left=${expTr21.left_days} expiry=${expRows21.map((row) => row.expiry_at === expTr21.expiry_at)}`);

        const gonePkg21 = await build21(gone21.id, 'sc210gone-pkg', { gb: 1, days: 3 });
        const hardMark21 = Number(tdb.prepare("SELECT COUNT(*) AS c FROM config_trash WHERE mode = 'hard'").get().c);
        const purgeUser21 = await request('DELETE', `/api/admin/users/${gone21.id}?purge=1`, { cookies, csrf });
        const goneSnaps21 = tdb.prepare("SELECT id FROM config_trash WHERE user_id = ? AND mode = 'hard' ORDER BY id").all(gone21.id);
        check('deleting a representative with purge leaves one HARD snapshot per channel',
          purgeUser21.status === 200 && goneSnaps21.length === 2
            && Number(tdb.prepare('SELECT COUNT(*) AS c FROM configs WHERE email = ?').get(gonePkg21.email).c) === 0,
          `snaps=${goneSnaps21.length} rows=${tdb.prepare('SELECT COUNT(*) AS c FROM configs WHERE email = ?').get(gonePkg21.email).c}`);
        const purgedRestore21 = await restore21(Number(goneSnaps21[0]?.id || 0), {});
        check('his snapshot cannot rebuild itself — the owner account is gone',
          purgedRestore21.status === 422 && code21(purgedRestore21) === 'user_not_found',
          `code=${code21(purgedRestore21)}`);
        const handedRestore21 = await restore21(Number(goneSnaps21[0]?.id || 0), { userId: shop21.id });
        const hr21 = handedRestore21.json?.data || {};
        const handedOwner21 = Number(tdb.prepare('SELECT user_id FROM configs WHERE id = ?').get(Number((hr21.ids || [])[0] || 0))?.user_id || 0);
        check('handed to a live representative it rebuilds him there as a brand-new row',
          handedRestore21.status === 200 && (hr21.revived || []).length === 0 && (hr21.ids || []).length === 1
            && handedOwner21 === shop21.id,
          `revived=${(hr21.revived || []).length} owner=${handedOwner21}/${shop21.id}`);

        const extEmail21 = seed21('sc210ext-1', { inboundIds: [901], totalGB: 2 * GB21 });
        const adopt21 = await request('POST', '/api/admin/configs/adopt', {
          cookies, csrf, body: { email: extEmail21, userId: other21.id, serverId: primaryId },
        });
        const adoptedRow21 = rowIdOf21(extEmail21, 901);
        const extDel21 = await deletePackage21(adoptedRow21);
        const extTr21 = newestTrash21(extEmail21);
        const extRestore21 = await restore21(Number(extTr21.id), { userId: other21.id });
        check('an adopted subscription is refused: deleting it only forgot it here, so rebuilding it would create a client this panel never owned',
          adopt21.status === 201 && extDel21.status === 200 && extRestore21.status === 422
            && code21(extRestore21) === 'external_snapshot' && mockXui.clients.has(extEmail21) === true,
          `adopt=${adopt21.status} del=${extDel21.status} restore=${extRestore21.status}/${code21(extRestore21)}`);
        const purgeTr21 = await request('DELETE', `/api/admin/trash/${extTr21.id}`, { cookies, csrf });
        const afterPurge21 = await request('GET', `/api/admin/trash/${extTr21.id}`, { cookies });
        check('purging an entry erases it for good, and it really is gone afterwards',
          purgeTr21.status === 200 && afterPurge21.status === 404 && Number(trashRow21(Number(extTr21.id)).id || 0) === 0,
          `purge=${purgeTr21.status} read=${afterPurge21.status}`);
        const shopSess21 = await login21('sc210shop');
        const resellerTrash21 = await request('GET', '/api/admin/trash', { cookies: shopSess21.cookies });
        check('a representative has no Trash at all', resellerTrash21.status === 403, `status=${resellerTrash21.status}`);
        const trAudit21 = tdb.prepare("SELECT details FROM audit_logs WHERE action = 'config.trash_restore' AND details LIKE ? ORDER BY id DESC LIMIT 1")
          .get(`%${pkg21.email}%`) || {};
        const trAuditJson21 = JSON.parse(String(trAudit21.details || '{}'));
        check('every rebuild is audited with the email, the channels and what was revived',
          trAuditJson21.email === pkg21.email && (trAuditJson21.inboundIds || []).length === 2
            && (trAuditJson21.revived || []).length === 2,
          `audit=${String(trAudit21.details || '').slice(0, 60)}`);

        // ────────────────────────────────────── ۳) «بنر اطلاع‌رسانی» سبز/قرمز
        bannerWas21 = (await settingsRead21()).banner || {};
        const emptyOn21 = await patchBanner21({ enabled: true, text: '' });
        check('the banner cannot be switched on with an empty message',
          emptyOn21.status === 422 && code21(emptyOn21) === 'banner_empty', `code=${code21(emptyOn21)}`);
        const noAudience21 = await patchBanner21({ enabled: true, text: 'قطعی داریم', targets: 'selected', userIds: [] });
        check('«selected» with nobody picked is refused too',
          noAudience21.status === 422 && code21(noAudience21) === 'banner_no_audience', `code=${code21(noAudience21)}`);
        const badWindow21 = await patchBanner21({ enabled: true, text: 'قطعی', targets: 'all', startsAt: NOW21 + DAY21, endsAt: NOW21 });
        check('a window that ends before it starts is refused',
          badWindow21.status === 422 && code21(badWindow21) === 'banner_window', `code=${code21(badWindow21)}`);
        const textSave21 = await patchBanner21({
          enabled: true,
          text: '\n  تخفیف   ویژه  برای\n حساب  کاربری   شما   اعمال  شد  ',
          tone: 'blue',
          targets: 'all',
        });
        const bannerRow21 = (await settingsRead21()).banner || {};
        check('the message is folded to one line and an unknown tone becomes green',
          textSave21.status === 200 && bannerRow21.text === 'تخفیف ویژه برای حساب کاربری شما اعمال شد'
            && bannerRow21.tone === 'green', `text=${bannerRow21.text} tone=${bannerRow21.tone}`);
        await patchBanner21({ text: 'x'.repeat(400) });
        const longRow21 = (await settingsRead21()).banner || {};
        check('three hundred characters is the limit the box keeps',
          String(longRow21.text).length === 300, `len=${String(longRow21.text).length}`);
        await patchBanner21({ text: 'تخفیف ویژه برای حساب کاربری شما اعمال شد', tone: 'green', targets: 'all' });
        const shopBanner21 = await request('GET', '/api/banner', { cookies: shopSess21.cookies });
        const adminBanner21 = await request('GET', '/api/banner', { cookies });
        const anonBanner21 = await request('GET', '/api/banner', {});
        check('a green bar for all representatives reaches the reseller panel',
          shopBanner21.status === 200 && shopBanner21.json?.data?.tone === 'green'
            && String(shopBanner21.json?.data?.text).includes('تخفیف ویژه'),
          `status=${shopBanner21.status} data=${JSON.stringify(shopBanner21.json?.data || null)}`);
        check('…and never shows over the owner\'s own screen, nor over an anonymous one',
          adminBanner21.status === 200 && adminBanner21.json?.data === null && anonBanner21.status === 401,
          `admin=${JSON.stringify(adminBanner21.json?.data)} anon=${anonBanner21.status}`);
        const otherSess21 = await login21('sc210other');
        const picked21 = await patchBanner21({ tone: 'red', targets: 'selected', userIds: [other21.id, 987654] });
        const aud21 = picked21.json?.data?.audience || {};
        check('the picked ids come back resolved — the one that does not exist is flagged, not dropped',
          picked21.status === 200 && Number(aud21.count) === 1 && (aud21.rows || []).length === 2
            && aud21.rows[0]?.username === 'sc210other' && aud21.rows[1]?.gone === true,
          `count=${aud21.count} rows=${JSON.stringify((aud21.rows || []).map((row) => [row.username, row.gone]))}`);
        const otherBanner21 = await request('GET', '/api/banner', { cookies: otherSess21.cookies });
        const shopBanner22 = await request('GET', '/api/banner', { cookies: shopSess21.cookies });
        check('the red bar reaches exactly the representative who was picked',
          otherBanner21.json?.data?.tone === 'red' && shopBanner22.json?.data === null,
          `other=${JSON.stringify(otherBanner21.json?.data)} shop=${JSON.stringify(shopBanner22.json?.data)}`);
        const future21 = await patchBanner21({ targets: 'all', startsAt: NOW21 + 60 * DAY21, endsAt: 0 });
        const futureView21 = await request('GET', '/api/banner', { cookies: otherSess21.cookies });
        check('a banner written before an outage is not up yet',
          future21.status === 200 && futureView21.json?.data === null,
          `status=${futureView21.status} data=${JSON.stringify(futureView21.json?.data)}`);
        const over21 = await patchBanner21({ startsAt: NOW21 - 2 * DAY21, endsAt: NOW21 - DAY21 });
        const overView21 = await request('GET', '/api/banner', { cookies: otherSess21.cookies });
        check('…and comes down by itself once its window has passed',
          over21.status === 200 && overView21.json?.data === null,
          `data=${JSON.stringify(overView21.json?.data)}`);
        const off21 = await patchBanner21({ enabled: false });
        const offRow21 = (await settingsRead21()).banner || {};
        check('switching it off keeps the text for the next crisis',
          off21.status === 200 && offRow21.enabled === false && String(offRow21.text).length > 0,
          `enabled=${offRow21.enabled} text=${String(offRow21.text).length}`);

        // ─────────────────────────────────────── ۴) what a fresh 2.1.0 boots with
        const tables21 = tdb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
        const trashCols21 = tdb.prepare('PRAGMA table_info(config_trash)').all().map((row) => row.name);
        const settingsKeys21 = tdb.prepare('SELECT key FROM settings ORDER BY key').all().map((row) => row.key);
        check('the two new tables are there and the rest of the schema is untouched',
          tables21.includes('config_trash') && tables21.includes('activation') && tables21.length === 22,
          tables21.join(','));
        check('the Trash stores the identity AND the arithmetic a rebuild needs',
          ['email', 'sub_id', 'uuid', 'total_bytes', 'used_bytes', 'left_bytes', 'left_days', 'expiry_at',
            'inbound_ids', 'rows_json', 'mode', 'restored_at'].every((col) => trashCols21.includes(col)),
          trashCols21.join(','));
        check('the twelfth settings row is the banner, born switched off',
          settingsKeys21.length === 12 && settingsKeys21.includes('banner')
            && Boolean((await settingsRead21()).banner) === true && bannerWas21.enabled === false,
          `rows=${settingsKeys21.length} was=${JSON.stringify(bannerWas21.enabled)}`);
      } finally {
        // The listener goes back FIRST: every check after this block is made
        // against the port the harness booted with, so a failure inside the block
        // must not be able to leave the panel answering somewhere else.
        for (const candidate of [PORT, movedTo21].filter((port, index, all) => Number(port) > 0 && all.indexOf(port) === index)) {
          const sysTry21 = await onPort(candidate, 'GET', '/api/admin/system', { cookies });
          if (sysTry21.status !== 200) continue;
          await onPort(candidate, 'PATCH', '/api/admin/settings/general', {
            body: {
              panelPort: PORT,
              publicUrl: String((was21 || {}).publicUrl || ''),
              sslCertPath: '',
              sslKeyPath: '',
            },
            cookies, csrf, tls: Boolean(netOf21(sysTry21).tls),
          });
          break;
        }
        const homeAgain21 = await health21(PORT);
        const netHomeAgain21 = netOf21(await onPort(PORT, 'GET', '/api/admin/system', { cookies }));
        check('the listener is home: the port the suite booted with, in plain http',
          homeAgain21.status === 200 && netHomeAgain21.tls === false && Number(netHomeAgain21.port) === PORT,
          `health=${homeAgain21.status} tls=${netHomeAgain21.tls} port=${netHomeAgain21.port}`);
        if (bannerWas21) {
          await patchBanner21({
            enabled: Boolean(bannerWas21.enabled),
            text: String(bannerWas21.text || ''),
            tone: String(bannerWas21.tone || 'green'),
            targets: String(bannerWas21.targets || 'all'),
            userIds: Array.isArray(bannerWas21.userIds) ? bannerWas21.userIds : [],
            startsAt: 0,
            endsAt: 0,
          });
        }
        tdb.prepare('UPDATE inbounds SET enabled = 1 WHERE id IN (901, 902)').run();
        if (lifted21) await request('PATCH', '/api/admin/settings/security', { cookies, csrf, body: { loginRateLimit: limit21 } });
        if (busy21) { try { busy21.close(); } catch (_) { /* already gone */ } }
        for (const email of seedEmails21) mockXui.clients.delete(email);
        fs.rmSync(certDir21, { recursive: true, force: true });
        tdb.close();
      }
    }

    // ═════════════════════════════════════════════════════════════════════ v2.3.0
    //
    // Five asks from the resellers' complaints, one block. Everything here is
    // proved through the HTTP API against the live database, because 2.3.0 is
    // about money: what the book says has to be what the wallet actually did.
    //   ۱) بدهی — the admin may write a wallet below zero and a deduction may
    //      take it there, while a purchase still refuses to buy on credit.
    //   ۲) ابطال فیش — an approved receipt can be voided exactly once, and
    //      voiding it takes the money back through the same function a manual
    //      debit uses, leaving the original decision visible.
    //   ۳) پلن بدون مجوز اینباند — a ready-made plan is the OWNER's product, so
    //      a reseller who holds no grant for its channel can still take it,
    //      while the ordinary create path keeps asking for the grant.
    //   ۴) کار گروهی — ticks fold into packages and every package goes through
    //      the single-config service: a batch is never cheaper, freer, longer
    //      or more permissive than the same click on one row.
    //   ۵) تراکنش‌ها — one fleet-wide read of the ledger with the two filters
    //      the owner named plus direction, and the sign taken from the TYPE
    //      and never from the column (the two writers disagree about the sign).
    {
      const tdb = new Database(path.join(DATA_DIR, 'panel.db'));
      const P23 = 'Ledger-Pass-12345';
      const DAY23 = 86400000;
      const GB23 = 1024 ** 3;
      const NOW23 = Date.now();
      const code23 = (res) => String(res.json?.error?.code || '');
      const data23 = (res) => res.json?.data || {};
      const book23 = (params, extra = {}) => request('GET', `/api/admin/transactions?${params}`, { cookies, ...extra });
      const balance23 = (id) => Number(tdb.prepare('SELECT balance FROM users WHERE id = ?').get(Number(id))?.balance || 0);
      const ledger23 = (id) => tdb.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id').all(Number(id));
      const auditCount23 = (action) => Number(tdb.prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE action = ?').get(action).c);
      const auditLast23 = (action) => JSON.parse(String(tdb.prepare(
        'SELECT details FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1'
      ).get(action)?.details || '{}'));
      const alive23 = (email) => tdb.prepare('SELECT * FROM configs WHERE email = ? AND deleted_at = 0 ORDER BY id').all(String(email));
      const buried23 = (email) => tdb.prepare('SELECT * FROM configs WHERE email = ? AND deleted_at > 0 ORDER BY id').all(String(email));
      const setBalance23 = (id, balance) => request('PATCH', `/api/admin/users/${id}`, { cookies, csrf, body: { balance } });
      const mkUser23 = async (username, extra = {}) => {
        const made = await request('POST', '/api/admin/users', {
          cookies, csrf, body: { username, password: P23, role: 'reseller', balance: 0, max_configs: 100, ...extra },
        });
        return Number(data23(made).user?.id || 0);
      };
      const login23 = async (username) => {
        const res = await request('POST', '/api/auth/login', { body: { username, password: P23 } });
        return { status: res.status, cookies: cookiesFrom(res.headers), csrf: String(res.json?.data?.csrf || '') };
      };
      const build23 = async (userId, name, inboundIds, { gb = 5, days = 30 } = {}) => {
        const res = await request('POST', '/api/admin/configs', {
          cookies, csrf, body: { userId, inboundIds, gb, days, label: name, customerName: name },
        });
        const made = data23(res).configs || [];
        return { status: res.status, ids: made.map((row) => Number(row.id)), email: String(made[0]?.email || '') };
      };
      const extendAdmin23 = (body, who = { cookies, csrf }) => request('POST', '/api/admin/configs/bulk-extend', { ...who, body });
      const deleteAdmin23 = (body, who = { cookies, csrf }) => request('POST', '/api/admin/configs/bulk-delete', { ...who, body });
      const itemOf23 = (res, id) => (data23(res).results || []).find((row) => Number(row.id) === Number(id)) || {};
      const seedTopup23 = (userId, amount, auto = 0, createdAt = Date.now()) => {
        const now = createdAt;
        const info = tdb.prepare(
          `INSERT INTO topup_requests (user_id, amount, status, file_kind, file_id, caption, chat_id, message_id,
             admin_chat_id, admin_message_id, decided_by, decided_at, decision_note, source, method, reference,
             auto_approved, created_at, updated_at)
           VALUES (?, ?, 'pending', 'photo', 'sc230-file', 'فیش واریزی', '', 0, '', 0, 0, 0, '', 'panel',
             'receipt', ?, ?, ?, ?)`
        ).run(Number(userId), Number(amount), `SC230-${crypto.randomBytes(6).toString('hex')}`,
          Number(auto) || 0, now, now);
        return Number(info.lastInsertRowid);
      };
      const decide23 = (verb, id, body = {}, who = { cookies, csrf }) =>
        request('POST', `/api/admin/topups/${id}/${verb}`, { ...who, body });
      let monitorWas23 = 120;
      let billingWas23 = null;
      let securityWas23 = null;
      let paymentWas23 = null;
      let lifted23 = false;
      let parked23 = false;
      let visWas902 = 1;
      let disabled903 = false;
      const planIds23 = [];
      const userIds23 = [];
      const mail23 = [];
      const nodeIds23 = [];
      try {
        const read23 = await request('GET', '/api/admin/settings', { cookies });
        monitorWas23 = Number(data23(read23).settings?.monitor?.intervalSec || 120);
        billingWas23 = { ...(data23(read23).settings?.billing || {}) };
        securityWas23 = { ...(data23(read23).settings?.security || {}) };
        paymentWas23 = { ...(data23(read23).settings?.payment || {}) };
        // Ten logins per ten minutes is the fleet's own rule, and the blocks
        // above spent that window long before this one starts. Four fixture
        // wallets have to sign in here, so the limit is lifted for the block and
        // put back exactly as it was in the `finally` below.
        lifted23 = (await request('PATCH', '/api/admin/settings/security', {
          cookies, csrf, body: { loginRateLimit: 100 },
        })).status === 200;
        parked23 = (await request('PATCH', '/api/admin/settings/monitor', {
          cookies, csrf, body: { intervalSec: 3600 },
        })).status === 200;
        await request('PATCH', '/api/admin/settings/billing', { cookies, csrf, body: { enabled: true, commissionPercent: 0 } });

        const debtId23 = await mkUser23('sc230debt');
        const grantId23 = await mkUser23('sc230plan');
        const bulkId23 = await mkUser23('sc230bulk');
        const otherId23 = await mkUser23('sc230other');
        userIds23.push(debtId23, grantId23, bulkId23, otherId23);

        // Everything below talks through the reseller's own session. If a fixture
        // cannot sign in, every one of those checks is a 401 and proves nothing,
        // so the block says so once, here, with the status that came back.
        const signed23 = await login23('sc230debt');
        check('the four fixture wallets exist and can actually sign in',
          debtId23 > 0 && grantId23 > 0 && bulkId23 > 0 && otherId23 > 0 && signed23.status === 200,
          `ids=${[debtId23, grantId23, bulkId23, otherId23].join(',')} login=${signed23.status}`);

        // ────────────────────────────── ۱) «اعمال بدهی و موجودی منفی»
        const negWrite23 = await setBalance23(debtId23, -250000);
        const afterNeg23 = balance23(debtId23);
        check('the admin can write a wallet below zero and it is stored, not clamped',
          negWrite23.status === 200 && afterNeg23 === -250000, `status=${negWrite23.status} balance=${afterNeg23}`);

        const ceilBefore23 = Number(tdb.prepare('SELECT max_gb_per_config AS v FROM users WHERE id = ?').get(debtId23).v);
        const ceilTry23 = await request('PATCH', `/api/admin/users/${debtId23}`, {
          cookies, csrf, body: { max_gb_per_config: -5 },
        });
        const ceilAfter23 = Number(tdb.prepare('SELECT max_gb_per_config AS v FROM users WHERE id = ?').get(debtId23).v);
        check('only the wallet goes negative — a ceiling below zero is still refused',
          ceilTry23.status === 422 && code23(ceilTry23) === 'invalid_limit' && ceilAfter23 === ceilBefore23,
          `code=${code23(ceilTry23)} stored=${ceilAfter23} was=${ceilBefore23}`);

        const notANumber23 = await setBalance23(debtId23, 'همه‌چیز');
        check('a wallet that is not a number is refused instead of becoming zero',
          notANumber23.status === 422 && code23(notANumber23) === 'invalid_limit' && balance23(debtId23) === -250000,
          `code=${code23(notANumber23)} balance=${balance23(debtId23)}`);

        const deepDebit23 = await request('POST', `/api/admin/users/${debtId23}/balance`, {
          cookies, csrf, body: { amount: -100000, description: 'کسر بابت بسته‌ای که رایگان تمدید شد' },
        });
        const debitLine23 = ledger23(debtId23).slice(-1)[0] || {};
        check('a deduction that ends below zero goes through and the book prints the debt',
          deepDebit23.status === 200 && Number(data23(deepDebit23).balance) === -350000
            && debitLine23.type === 'debit' && Number(debitLine23.amount) === 100000
            && Number(debitLine23.balance_after) === -350000,
          `balance=${data23(deepDebit23).balance} line=${debitLine23.type}/${debitLine23.amount}/${debitLine23.balance_after}`);

        const debtor23 = signed23;
        // 901 is the priced channel (fixed 100 + 10/GB); 904 is free and would
        // have made this a successful 0-toman order, proving nothing about debt.
        const onCredit23 = await request('POST', '/api/reseller/configs', {
          cookies: debtor23.cookies, csrf: debtor23.csrf,
          body: { inboundIds: [901], gb: 1, days: 1, customerName: 'خرید روی بدهی' },
        });
        check('debt is a record, not credit: a purchase still stops at 402',
          onCredit23.status === 402 && code23(onCredit23) === 'insufficient_balance'
            && balance23(debtId23) === -350000,
          `status=${onCredit23.status} code=${code23(onCredit23)} balance=${balance23(debtId23)}`);

        // ────────────────────────────── ۲) «ابطال فیش جعلی یا تکراری»
        const tGood23 = seedTopup23(otherId23, 400);
        const approved23 = await decide23('approve', tGood23);
        const afterApprove23 = balance23(otherId23);
        check('the approve step still credits the wallet — the baseline the void is judged against',
          approved23.status === 200 && afterApprove23 === 400, `status=${approved23.status} balance=${afterApprove23}`);

        const reversed23 = await decide23('reverse', tGood23, { note: 'فیش تکراری: همین شماره تراکنش دیروز ثبت شده بود' });
        const revData23 = data23(reversed23).request || {};
        check('voiding an approved receipt takes the money back and says who, when and why',
          reversed23.status === 200 && balance23(otherId23) === 0 && revData23.status === 'reversed'
            && Number(revData23.reversedBy) > 0 && Number(revData23.reversedAt) > 0
            && String(revData23.reverseNote).includes('فیش تکراری'),
          `status=${reversed23.status} balance=${balance23(otherId23)} row=${revData23.status}/${revData23.reversedBy}/${revData23.reverseNote}`);

        const revLines23 = ledger23(otherId23);
        const revDebit23 = revLines23.filter((row) => row.type === 'debit').slice(-1)[0] || {};
        check('the claw-back is an ordinary ledger line — the same debit a manual کسر writes',
          revLines23.filter((row) => row.type === 'credit').length === 1
            && Number(revDebit23.amount) === 400 && Number(revDebit23.balance_after) === 0
            && String(revDebit23.description).includes('ابطال'),
          `lines=${revLines23.map((row) => `${row.type}:${row.amount}`).join(',')} note=${revDebit23.description}`);

        const revKeeps23 = await request('GET', `/api/admin/topups/${tGood23}`, { cookies });
        const keepData23 = data23(revKeeps23).request || {};
        check('voiding does not erase the decision it is voiding — the approval is still readable',
          revKeeps23.status === 200 && Number(keepData23.decidedBy) > 0 && Number(keepData23.decidedAt) > 0
            && keepData23.status === 'reversed',
          `decidedBy=${keepData23.decidedBy} status=${keepData23.status}`);

        const twice23 = await decide23('reverse', tGood23, { note: 'دوباره' });
        const balanceAfterTwice23 = balance23(otherId23);
        check('the same receipt cannot be clawed back twice',
          twice23.status === 409 && code23(twice23) === 'already_reversed' && balance23(otherId23) === balanceAfterTwice23,
          `code=${code23(twice23)} balance=${balanceAfterTwice23}`);

        const tPending23 = seedTopup23(otherId23, 100);
        const onPending23 = await decide23('reverse', tPending23);
        const tRejected23 = seedTopup23(otherId23, 100);
        await decide23('reject', tRejected23, { note: 'رد شده' });
        const onRejected23 = await decide23('reverse', tRejected23);
        check('only an approved receipt can be voided — pending and rejected both answer 409',
          onPending23.status === 409 && code23(onPending23) === 'not_approved'
            && onRejected23.status === 409 && code23(onRejected23) === 'not_approved',
          `pending=${code23(onPending23)} rejected=${code23(onRejected23)}`);

        const otherSess23 = await login23('sc230other');
        const byReseller23 = await decide23('reverse', tPending23, {}, { cookies: otherSess23.cookies, csrf: otherSess23.csrf });
        const seenByReseller23 = await request('GET', `/api/admin/topups/${tPending23}`, { cookies: otherSess23.cookies });
        check('a reseller cannot void his own receipt, and cannot even read the admin half',
          byReseller23.status === 403 && seenByReseller23.status === 403 && balance23(otherId23) === 0,
          `reverse=${byReseller23.status} read=${seenByReseller23.status}`);

        // The void this check is about has to be judged against a receipt the
        // SWEEP paid out, not one an admin clicked: approve() writes
        // auto_approved = 0 for a person, so seeding the flag and approving by
        // hand would have proved the audit line false — which is exactly what
        // the code then does. So the switch is opened, the receipt is filed two
        // days ago, and the real schedule releases it.
        const payPatch23 = await request('PATCH', '/api/admin/settings/payment', {
          cookies, csrf,
          body: {
            autoApproveEnabled: true, autoApproveReceipt: true, autoApproveMaxAmount: 20000,
            autoApproveAfterMinutes: 1, autoApproveDailyLimit: 0,
          },
        });
        const tAuto23 = seedTopup23(debtId23, 20000, 0, NOW23 - 2 * DAY23);
        const sweep23 = await request('POST', '/api/admin/topups/auto-approve/run', { cookies, csrf, body: {} });
        const autoRow23 = tdb.prepare(
          'SELECT status, auto_approved, decided_by FROM topup_requests WHERE id = ?'
        ).get(tAuto23) || {};
        check('the sweep — not a person — is what paid this receipt out',
          payPatch23.status === 200 && sweep23.status === 200 && autoRow23.status === 'approved'
            && Number(autoRow23.auto_approved) === 1 && Number(autoRow23.decided_by) === 0,
          `pay=${payPatch23.status} run=${JSON.stringify(data23(sweep23)).slice(0, 120)} row=${autoRow23.status}/${autoRow23.auto_approved}/${autoRow23.decided_by}`);
        const debtVoid23 = await decide23('reverse', tAuto23, { note: 'فیش جعلی' });
        const debtVoidData23 = data23(debtVoid23).request || {};
        check('clawing back a fake auto-approval takes the debtor deeper, which is the whole point',
          debtVoid23.status === 200 && Number(debtVoidData23.clawedBack) === 20000
            && Number(debtVoidData23.balance) === -350000 && balance23(debtId23) === -350000,
          `status=${debtVoid23.status} claw=${debtVoidData23.clawedBack} balance=${debtVoidData23.balance}/${balance23(debtId23)}`);
        const voidAudit23 = auditLast23('topup.reverse');
        check('the audit names the row, the money, the wallet it left and that the sweep let it through',
          Number(voidAudit23.amount) === 20000 && Number(voidAudit23.balance) === -350000
            && voidAudit23.wasAutoApproved === true && String(voidAudit23.note) === 'فیش جعلی',
          `audit=${JSON.stringify(voidAudit23).slice(0, 160)}`);

        const revList23 = await request('GET', '/api/admin/topups?status=reversed', { cookies });
        const revListData23 = data23(revList23);
        check('the reversed shelf lists them and the tab counter counts them',
          revList23.status === 200 && Number(revListData23.counts?.reversed) >= 2
            && (revListData23.rows || []).every((row) => row.status === 'reversed')
            && (revListData23.rows || []).some((row) => Number(row.id) === tGood23),
          `counts=${JSON.stringify(revListData23.counts || {})} rows=${(revListData23.rows || []).length}`);

        // ────────────────────────────── ۳) «پلن فعال شود حتی بدون اینباند»
        const grantPatch23 = await request('PATCH', `/api/admin/users/${grantId23}`, {
          cookies, csrf, body: { allowed_inbounds: [903] },
        });
        visWas902 = Number(tdb.prepare('SELECT visible FROM inbounds WHERE id = 902').get().visible);
        tdb.prepare('UPDATE inbounds SET visible = 0 WHERE id = 902').run();
        const noGrant23 = await login23('sc230plan');
        const hisInbounds23 = await request('GET', '/api/reseller/inbounds', { cookies: noGrant23.cookies });
        const shown23 = (hisInbounds23.json?.data?.rows || []).map((row) => Number(row.id));
        check('the channel grant still rules the ordinary picker — nothing here was opened up',
          grantPatch23.status === 200 && !shown23.includes(902) && shown23.includes(903),
          `shown=${shown23.join(',')}`);

        const mkPlan23 = async (body) => {
          const made = await request('POST', '/api/admin/plans', { cookies, csrf, body });
          planIds23.push(Number(data23(made).plan?.id || 0));
          return made;
        };
        const planMain23 = await mkPlan23({
          name: 'پلن بدون مجوز', gb: 5, days: 30, price: 100, inboundIds: [902], category: 'public',
        });
        const hisPlans23 = await request('GET', '/api/reseller/plans', { cookies: noGrant23.cookies });
        const onShelf23 = (data23(hisPlans23).plans || []).map((row) => Number(row.id));
        check('a plan built on a channel he was never granted is still on his shelf',
          planMain23.status === 201 && onShelf23.includes(Number(data23(planMain23).plan.id)),
          `shelf=${onShelf23.join(',')} want=${data23(planMain23).plan?.id}`);

        const quoteMain23 = await request('POST', '/api/reseller/plans/quote', {
          cookies: noGrant23.cookies, csrf: noGrant23.csrf, body: { planId: Number(data23(planMain23).plan.id) },
        });
        const quoteData23 = data23(quoteMain23);
        check('the quote prices it at the owner’s number, not the tariff',
          quoteMain23.status === 200 && Number(quoteData23.price) === 100 && Number(quoteData23.tariff) === 250
            && Number(quoteData23.saved) === 150 && quoteData23.charged === true,
          `price=${quoteData23.price} tariff=${quoteData23.tariff} saved=${quoteData23.saved}`);

        const topupForPlan23 = seedTopup23(grantId23, 5000);
        await decide23('approve', topupForPlan23);
        const buyMain23 = await request('POST', '/api/reseller/plans/new', {
          cookies: noGrant23.cookies, csrf: noGrant23.csrf,
          body: { planId: Number(data23(planMain23).plan.id), customerName: 'مشتری پلن بی‌مجوز' },
        });
        const bought23 = (data23(buyMain23).configs || [])[0] || {};
        const boughtRows23 = alive23(String(bought23.email || ''));
        check('and he can actually take it: the package is built on the channel he cannot pick by hand',
          buyMain23.status === 201 && boughtRows23.length === 1 && Number(boughtRows23[0].inbound_id) === 902,
          `status=${buyMain23.status} rows=${boughtRows23.length} inbound=${boughtRows23[0]?.inbound_id}`);
        if (bought23.email) mail23.push(String(bought23.email));
        const planLines23 = ledger23(grantId23);
        const planPurchase23 = planLines23.filter((row) => row.type === 'purchase').slice(-1)[0] || {};
        // chargeReseller writes purchase/renew lines as the amount LEAVING, so the
        // column is negative; the magnitude is what the plan cost.
        check('the plan’s own price is what left the wallet — one line, ten times cheaper than the tariff',
          planLines23.filter((row) => row.type === 'purchase').length === 1
            && Math.abs(Number(planPurchase23.amount)) === 100 && Number(planPurchase23.balance_after) === 4900
            && balance23(grantId23) === 4900,
          `line=${planPurchase23.amount}/${planPurchase23.balance_after} balance=${balance23(grantId23)}`);
        const planSnap23 = JSON.parse(String(planPurchase23.config_snapshot || 'null'));
        check('v2.4.0 the purchase line points to the exact config and keeps only display-safe details',
          Number(planPurchase23.config_id) === Number(boughtRows23[0].id)
            && planSnap23?.email === String(boughtRows23[0].email)
            && planSnap23?.inbounds?.length === 1
            && !/secret|uuid|sub_id|customer_phone/i.test(String(planPurchase23.config_snapshot))
            && !String(planPurchase23.config_snapshot).includes(String(boughtRows23[0].uuid)),
          `config=${planPurchase23.config_id}/${boughtRows23[0].id} snapshot=${String(planPurchase23.config_snapshot).slice(0, 140)}`);

        const directTry23 = await request('POST', '/api/reseller/configs', {
          cookies: noGrant23.cookies, csrf: noGrant23.csrf,
          body: { inboundIds: [902], gb: 1, days: 1, customerName: 'دستی از کانال بسته' },
        });
        check('the plan is the exception, not the new rule: hand-picking a channel he was never granted is still refused',
          directTry23.status === 403 && code23(directTry23) === 'inbound_forbidden',
          `status=${directTry23.status} code=${code23(directTry23)}`);

        const planExclusive23 = await mkPlan23({
          name: 'پلن اختصاصی دیگری', gb: 2, days: 7, price: 0, inboundIds: [901],
          category: 'exclusive', allowed_users: [otherId23],
        });
        const hiddenForHim23 = (await request('GET', '/api/reseller/plans', { cookies: noGrant23.cookies })).json?.data?.plans || [];
        const exclQuote23 = await request('POST', '/api/reseller/plans/quote', {
          cookies: noGrant23.cookies, csrf: noGrant23.csrf, body: { planId: Number(data23(planExclusive23).plan.id) },
        });
        check('an exclusive plan still belongs only to the resellers it names',
          planExclusive23.status === 201 && !hiddenForHim23.some((row) => Number(row.id) === Number(data23(planExclusive23).plan.id))
            && exclQuote23.status === 403 && code23(exclQuote23) === 'plan_not_for_you',
          `quote=${exclQuote23.status}/${code23(exclQuote23)}`);

        // The plan is made while its channel is still alive — createPlan refuses a
        // disabled inbound with inbound_disabled, and this check is about the shelf
        // reacting to a channel that was switched off AFTER the plan existed.
        const planOnDead23 = await mkPlan23({ name: 'پلن روی کانال خاموش', gb: 1, days: 1, price: 0, inboundIds: [903] });
        const deadPlanId23 = Number(data23(planOnDead23).plan?.id || 0);
        tdb.prepare('UPDATE inbounds SET enabled = 0 WHERE id = 903').run();
        disabled903 = true;
        const afterDisable23 = await request('GET', '/api/reseller/plans', { cookies: noGrant23.cookies });
        const resellerAfter23 = (await request('GET', '/api/reseller/plans', { cookies: noGrant23.cookies })).json?.data?.plans || [];
        const adminAfter23 = (await request('GET', '/api/admin/plans', { cookies })).json?.data?.plans || [];
        const onHisShelf23 = resellerAfter23.some((row) => Number(row.id) === deadPlanId23);
        const onOwnerScreen23 = adminAfter23.some((row) => Number(row.id) === deadPlanId23);
        check('a plan whose channel is switched off disappears from the shelf but not from the owner’s screen',
          planOnDead23.status === 201 && deadPlanId23 > 0 && afterDisable23.status === 200
            && !onHisShelf23 && onOwnerScreen23,
          `make=${planOnDead23.status} id=${deadPlanId23} shelf=${onHisShelf23}(${resellerAfter23.length}) admin=${onOwnerScreen23}(${adminAfter23.length})`);
        tdb.prepare('UPDATE inbounds SET enabled = 1 WHERE id = 903').run();
        disabled903 = false;

        const otherPanel23 = Number(tdb.prepare("INSERT INTO servers (name, enabled) VALUES ('v2.3.0 fixture', 0)").run().lastInsertRowid);
        nodeIds23.push(otherPanel23);
        tdb.prepare(
          `INSERT INTO inbounds (id, server_id, xui_id, node_id, node_name, remark, protocol, tag, port, network,
             security, listen, price_fixed, price_per_gb, price_per_day, enabled, visible, sub_sort_index, updated_at)
           VALUES (921, ?, 921, 0, 'local', 'Fixed 921', 'vless', 'tag921', 1000, 'tcp', 'none', '', 0, 10, 0, 1, 1, 40, ?)`
        ).run(otherPanel23, Date.now());
        const fixedTry23 = await request('PATCH', `/api/admin/users/${grantId23}`, { cookies, csrf, body: { fixed_inbound: 921 } });
        const afterFixed23 = (await request('GET', '/api/reseller/plans', { cookies: noGrant23.cookies })).json?.data?.plans || [];
        const fixedQuote23 = await request('POST', '/api/reseller/plans/quote', {
          cookies: noGrant23.cookies, csrf: noGrant23.csrf, body: { planId: Number(data23(planMain23).plan.id) },
        });
        check('one subscription still cannot span two panels: a fixed inbound elsewhere keeps that plan off his shelf',
          fixedTry23.status === 200 && !afterFixed23.some((row) => Number(row.id) === Number(data23(planMain23).plan.id))
            && fixedQuote23.status === 403 && code23(fixedQuote23) === 'plan_not_for_you',
          `fixed=${fixedTry23.status} quote=${fixedQuote23.status}/${code23(fixedQuote23)}`);
        await request('PATCH', `/api/admin/users/${grantId23}`, { cookies, csrf, body: { fixed_inbound: 0 } });

        // ────────────────────────────── ۴) «چند کانفیگ را یک‌جا تمدید/حذف کن»
        const noTicks23 = await extendAdmin23({ gb: 5 });
        const nothingToAdd23 = await extendAdmin23({ ids: [1, 2], gb: 0, days: 0 });
        const tooMany23 = await extendAdmin23({ ids: Array.from({ length: 1001 }, (_, i) => i + 1), gb: 5 });
        check('a batch that was never told what to do says so before it touches anything',
          noTicks23.status === 422 && code23(noTicks23) === 'ids_required'
            && nothingToAdd23.status === 422 && code23(nothingToAdd23) === 'nothing_to_add'
            && tooMany23.status === 422 && code23(tooMany23) === 'too_many_items',
          `ids=${code23(noTicks23)} empty=${code23(nothingToAdd23)} many=${code23(tooMany23)}`);

        const pkgA23 = await build23(bulkId23, 'بسته الف', [901, 902], { gb: 5, days: 30 });
        const pkgB23 = await build23(bulkId23, 'بسته ب', [903], { gb: 5, days: 30 });
        const pkgC23 = await build23(otherId23, 'بسته دیگری', [904], { gb: 5, days: 30 });
        mail23.push(pkgA23.email, pkgB23.email, pkgC23.email);
        await setBalance23(bulkId23, 1000);
        const ticks23 = [...pkgA23.ids, ...pkgB23.ids];

        const preview23 = await extendAdmin23({ ids: ticks23, gb: 5, days: 0, dryRun: true });
        const pv23 = data23(preview23);
        check('two ticks of the same customer fold into one package, and the batch counts packages, not rows',
          preview23.status === 200 && Number(pv23.total) === 3 && Number(pv23.packages) === 2
            && Number(pv23.merged) === 1 && Number(pv23.rows) === 3,
          `total=${pv23.total} packages=${pv23.packages} merged=${pv23.merged} rows=${pv23.rows}`);
        check('the preview prices each package at its own most expensive channel',
          (pv23.results || []).length === 2 && Number(itemOf23(preview23, pkgA23.ids[0]).amount) === 250
            && Number(itemOf23(preview23, pkgB23.ids[0]).amount) === 300 && Number(pv23.tariff) === 550
            && pv23.results.every((row) => row.ok === true),
          `amounts=${(pv23.results || []).map((row) => row.amount).join(',')} tariff=${pv23.tariff}`);

        const callsBefore23 = mockXui.calls.length;
        const auditBeforeExt23 = auditCount23('config.bulk_extend');
        const snapshotA23 = alive23(pkgA23.email).map((row) => `${row.total_bytes}:${row.expiry_at}`).join('|');
        const ledgerBefore23 = ledger23(bulkId23).length;
        const previewTwice23 = await extendAdmin23({ ids: ticks23, gb: 5, days: 0, dryRun: true });
        const previewAgain23 = data23(previewTwice23);
        check('a preview is a preview: the node, the ledger, the audit and the rows did not move',
          previewAgain23.renewed === 2 && mockXui.calls.length === callsBefore23
            && auditCount23('config.bulk_extend') === auditBeforeExt23 && ledger23(bulkId23).length === ledgerBefore23
            && alive23(pkgA23.email).map((row) => `${row.total_bytes}:${row.expiry_at}`).join('|') === snapshotA23,
          `calls=${mockXui.calls.length - callsBefore23} audits=${auditCount23('config.bulk_extend') - auditBeforeExt23} ledger=${ledger23(bulkId23).length - ledgerBefore23}`);

        await setBalance23(bulkId23, 300);
        const bulkSess23 = await login23('sc230bulk');
        const runsOut23 = await request('POST', '/api/reseller/configs/bulk-extend', {
          cookies: bulkSess23.cookies, csrf: bulkSess23.csrf, body: { ids: ticks23, gb: 5, days: 0, dryRun: true },
        });
        const runsOutData23 = data23(runsOut23);
        const outItem23 = itemOf23(runsOut23, pkgB23.ids[0]);
        check('the preview names the wallet that runs out, at the item it runs out on',
          runsOut23.status === 200 && itemOf23(runsOut23, pkgA23.ids[0]).ok === true
            && outItem23.ok === false && outItem23.code === 'insufficient_balance'
            && Number(runsOutData23.renewed) === 1 && Number(runsOutData23.failed) === 1,
          `a=${itemOf23(runsOut23, pkgA23.ids[0]).ok} b=${outItem23.code} renewed=${runsOutData23.renewed}`);

        await setBalance23(bulkId23, 1000);
        const realRun23 = await request('POST', '/api/reseller/configs/bulk-extend', {
          cookies: bulkSess23.cookies, csrf: bulkSess23.csrf, body: { ids: ticks23, gb: 5, days: 0 },
        });
        const realData23 = data23(realRun23);
        check('a reseller’s batch is charged exactly what a batch of single clicks would have charged',
          realRun23.status === 200 && Number(realData23.renewed) === 2 && Number(realData23.amount) === 550
            && balance23(bulkId23) === 450 && ledger23(bulkId23).filter((row) => row.type === 'renew').length === 2,
          `status=${realRun23.status} renewed=${realData23.renewed} amount=${realData23.amount} balance=${balance23(bulkId23)}`);
        const renewLines23 = ledger23(bulkId23).filter((row) => row.type === 'renew');
        const renewSnaps23 = renewLines23.map((row) => JSON.parse(String(row.config_snapshot || 'null')));
        check('v2.4.0 each renewal names its own package, including every inbound of a multi-inbound customer',
          renewLines23.length === 2
            && renewLines23.map((row) => Number(row.config_id)).sort((a, b) => a - b)
              .join(',') === [pkgA23.ids[0], pkgB23.ids[0]].sort((a, b) => a - b).join(',')
            && renewSnaps23.map((snap) => snap?.inbounds?.length).sort((a, b) => a - b).join(',') === '1,2'
            && renewSnaps23.every((snap) => snap?.email && !/"uuid"|"sub_id"|"customer_phone"/i.test(JSON.stringify(snap))),
          `links=${renewLines23.map((row) => `${row.config_id}:${row.config_snapshot?.length || 0}`).join(',')}`);
        const rowsA23 = alive23(pkgA23.email);
        const clientA23 = mockXui.clients.get(pkgA23.email) || {};
        check('the shared pool stays shared: two rows, one client, one volume',
          rowsA23.length === 2 && rowsA23.every((row) => Number(row.total_bytes) === 10 * GB23)
            && Number(clientA23.totalGB) === 10 * GB23 && rowsA23.every((row) => Number(row.expiry_at) === Number(rowsA23[0].expiry_at)),
          `bytes=${rowsA23.map((row) => row.total_bytes / GB23).join(',')} node=${clientA23.totalGB / GB23}`);

        const cRowsBefore23 = alive23(pkgC23.email).map((row) => Number(row.total_bytes)).join('|');
        const foreignTick23 = await request('POST', '/api/reseller/configs/bulk-extend', {
          cookies: bulkSess23.cookies, csrf: bulkSess23.csrf,
          body: { ids: [...pkgA23.ids, ...pkgC23.ids], gb: 1, days: 0, dryRun: true },
        });
        const foreignItem23 = itemOf23(foreignTick23, pkgC23.ids[0]);
        check('a tick on somebody else’s customer fails as that item, and the rest of the batch still answers',
          foreignTick23.status === 200 && Number(data23(foreignTick23).failed) === 1
            && Number(foreignItem23.rows) === 0 && String(foreignItem23.code) === 'forbidden'
            && alive23(pkgC23.email).map((row) => Number(row.total_bytes)).join('|') === cRowsBefore23,
          `failed=${data23(foreignTick23).failed} code=${foreignItem23.code} rows=${foreignItem23.rows}`);

        const adminFree23 = await extendAdmin23({ ids: ticks23, gb: 5, days: 0 });
        const adminFreeData23 = data23(adminFree23);
        check('an admin batch with no tick takes nothing and still names the money it is not taking',
          adminFree23.status === 200 && adminFreeData23.charge === false && Number(adminFreeData23.amount) === 0
            && Number(adminFreeData23.tariff) === 550 && balance23(bulkId23) === 450
            && (adminFreeData23.results || []).every((row) => row.charged === false),
          `charge=${adminFreeData23.charge} amount=${adminFreeData23.amount} tariff=${adminFreeData23.tariff} balance=${balance23(bulkId23)}`);

        await setBalance23(bulkId23, 2000);
        const adminPaid23 = await extendAdmin23({ ids: ticks23, gb: 5, days: 0, charge: true });
        const adminPaidData23 = data23(adminPaid23);
        check('and the same batch with the tick on does take it, from the package owner’s wallet',
          adminPaid23.status === 200 && adminPaidData23.charge === true
            && Number(adminPaidData23.amount) === 550 && balance23(bulkId23) === 1450
            && ledger23(bulkId23).filter((row) => row.type === 'renew').length === 4,
          `amount=${adminPaidData23.amount} balance=${balance23(bulkId23)} renews=${ledger23(bulkId23).filter((row) => row.type === 'renew').length}`);

        const bulkAudit23 = auditLast23('config.bulk_extend');
        check('the audit records the batch as a batch — ticks, packages, merged, money and the per-item outcome',
          Number(bulkAudit23.total) === 3 && Number(bulkAudit23.packages) === 2 && Number(bulkAudit23.merged) === 1
            && Number(bulkAudit23.amount) === 550 && Array.isArray(bulkAudit23.items) && bulkAudit23.items.length === 2,
          `audit=${JSON.stringify(bulkAudit23).slice(0, 180)}`);

        const delPreview23 = await deleteAdmin23({ ids: [...pkgA23.ids, ...pkgB23.ids], dryRun: true });
        const delPv23 = data23(delPreview23);
        check('the delete preview says which clients the node will actually lose',
          delPreview23.status === 200 && Number(delPv23.packages) === 2 && Number(delPv23.rows) === 3
            && Number(delPv23.remote) === 3 && Number(delPv23.localOnly) === 0,
          `packages=${delPv23.packages} rows=${delPv23.rows} remote=${delPv23.remote} local=${delPv23.localOnly}`);

        const extEmail23 = `sc230-ext-${crypto.randomBytes(5).toString('hex')}`;
        mail23.push(extEmail23);
        const extId23 = Number(tdb.prepare(
          `INSERT INTO configs (user_id, server_id, inbound_id, email, sub_id, xui_sub_id, uuid, label,
             customer_name, total_bytes, expiry_at, enabled, status, origin, created_at, updated_at)
           VALUES (?, ?, 901, ?, ?, ?, ?, 'بیرونی', 'مشتری بیرونی', ?, ?, 1, 'active', 'external', ?, ?)`
        ).run(bulkId23, primaryId, extEmail23, `sub-${extEmail23}`, `uuid-${extEmail23}`,
          crypto.randomUUID(), 3 * GB23, NOW23 + 20 * DAY23, NOW23, NOW23).lastInsertRowid);
        mockXui.clients.set(extEmail23, {
          email: extEmail23, id: `uuid-${extEmail23}`, subId: `sub-${extEmail23}`, security: 'auto', comment: '',
          totalGB: 3 * GB23, expiryTime: NOW23 + 20 * DAY23, enable: true, up: 0, down: 0, inboundIds: [901],
        });
        const mixedDel23 = await deleteAdmin23({ ids: [extId23, ...pkgA23.ids], dryRun: true });
        const mixedData23 = data23(mixedDel23);
        check('a customer adopted from another panel is counted as forgotten here, not as deleted there',
          mixedDel23.status === 200 && Number(mixedData23.packages) === 2 && Number(mixedData23.remote) === 2
            && Number(mixedData23.localOnly) === 1 && Number(itemOf23(mixedDel23, extId23).forgotten) === 1,
          `remote=${mixedData23.remote} local=${mixedData23.localOnly} ext=${JSON.stringify(itemOf23(mixedDel23, extId23))}`);

        const auditBeforeDel23 = auditCount23('config.bulk_delete');
        const bulkDel23 = await deleteAdmin23({ ids: [extId23, ...pkgA23.ids, ...pkgB23.ids] });
        const delData23 = data23(bulkDel23);
        const aGone23 = alive23(pkgA23.email);
        const aBuried23 = buried23(pkgA23.email);
        check('the batch really deletes: every row of every package buried, and the node loses only its own clients',
          bulkDel23.status === 200 && Number(delData23.deleted) === 3 && Number(delData23.rows) === 4
            && aGone23.length === 0 && aBuried23.length === 2
            && !mockXui.clients.has(pkgA23.email) && !mockXui.clients.has(pkgB23.email)
            && mockXui.clients.has(extEmail23) && alive23(extEmail23).length === 0,
          `deleted=${delData23.deleted} rows=${delData23.rows} live=${aGone23.length} node=${mockXui.clients.has(extEmail23)}`);
        check('a bulk delete leaves the same Trash snapshots a single delete would have left',
          auditCount23('config.bulk_delete') === auditBeforeDel23 + 1
            && Number(tdb.prepare('SELECT COUNT(*) AS c FROM config_trash WHERE email IN (?, ?)').get(pkgA23.email, pkgB23.email).c) === 2,
          `audits=${auditCount23('config.bulk_delete') - auditBeforeDel23} trash=${tdb.prepare('SELECT COUNT(*) AS c FROM config_trash WHERE email IN (?, ?)').get(pkgA23.email, pkgB23.email).c}`);

        const trashRow23 = tdb.prepare('SELECT id FROM config_trash WHERE email = ? ORDER BY id LIMIT 1').get(pkgB23.email) || {};
        const restore23 = await request('POST', `/api/admin/trash/${Number(trashRow23.id || 0)}/restore`, { cookies, csrf, body: {} });
        const restored23 = alive23(pkgB23.email);
        check('and one of them comes back through the Trash exactly as the batch found it',
          restore23.status === 200 && restored23.length === 1 && Number(restored23[0].total_bytes) === 20 * GB23,
          `status=${restore23.status} rows=${restored23.length} bytes=${restored23[0]?.total_bytes / GB23}GB`);

        // ────────────────────────────── ۵) «منوی تراکنش‌ها»
        const bookAsReseller23 = await request('GET', '/api/admin/transactions', { cookies: bulkSess23.cookies });
        check('the book is the owner’s: a reseller session is turned away from it',
          bookAsReseller23.status === 403, `status=${bookAsReseller23.status}`);

        const bookAll23 = await book23('pageSize=200');
        const bookRows23 = data23(bookAll23).rows || [];
        check('every line carries a magnitude and a direction instead of the column’s own sign',
          bookAll23.status === 200 && bookRows23.length > 0 && bookRows23.every((row) =>
            typeof row.magnitude === 'number' && ['in', 'out'].includes(row.direction)
              && Number(row.magnitude) >= 0 && row.amount === undefined
              && Number(row.signed) === (row.direction === 'out' ? -Number(row.magnitude) : Number(row.magnitude))),
          `rows=${bookRows23.length} sample=${JSON.stringify(bookRows23[0] || {}).slice(0, 160)}`);

        const sideOf23 = {};
        for (const row of bookRows23) {
          if ([debtId23, grantId23, bulkId23, otherId23].includes(Number(row.userId))) sideOf23[row.type] = row.direction;
        }
        check('the direction follows the type: a purchase and a renewal leave, a top-up and a کسر arrive as money out',
          sideOf23.purchase === 'out' && sideOf23.renew === 'out' && sideOf23.credit === 'in' && sideOf23.debit === 'out',
          `sides=${JSON.stringify(sideOf23)}`);

        const bookMine23 = await book23(`userId=${bulkId23}&pageSize=200`);
        const mineRows23 = data23(bookMine23).rows || [];
        check('filtering by reseller leaves nothing but his wallet, and says so back',
          bookMine23.status === 200 && mineRows23.length > 0
            && mineRows23.every((row) => Number(row.userId) === Number(bulkId23))
            && Number(data23(bookMine23).filters?.userId) === Number(bulkId23),
          `rows=${mineRows23.length} filters=${JSON.stringify(data23(bookMine23).filters || {})}`);
        const deletedDetail23 = mineRows23.find((row) => row.type === 'renew' && Number(row.configId) === Number(pkgA23.ids[0]));
        const restoredDetail23 = mineRows23.find((row) => row.type === 'renew' && Number(row.configId) === Number(pkgB23.ids[0]));
        const plainMoney23 = mineRows23.filter((row) => ['credit', 'debit'].includes(row.type));
        const restoredAnchor23 = tdb.prepare('SELECT id, user_id, server_id, email, deleted_at FROM configs WHERE id = ?').get(Number(pkgB23.ids[0]));
        const restoredTrash23 = tdb.prepare('SELECT id, head_config_id, restored_at FROM config_trash WHERE email = ? ORDER BY id').all(pkgB23.email);
        check('v2.4.0 the ledger API explains deleted and restored packages without touching money rows',
          deletedDetail23?.config?.deleted === true && deletedDetail23.config.email === pkgA23.email
            && restoredDetail23?.config?.deleted === false && restoredDetail23.config.email === pkgB23.email
            && plainMoney23.every((row) => Number(row.configId) === 0 && row.config === null),
          `deleted=${deletedDetail23?.config?.deleted}/${deletedDetail23?.config?.email} restored=${restoredDetail23?.config?.deleted}/${restoredDetail23?.config?.email} plain=${plainMoney23.length}`
            + ` anchor=${pkgB23.ids[0]} db=${JSON.stringify(restoredAnchor23)} live=${JSON.stringify(alive23(pkgB23.email).map((row) => ({ id: row.id, user_id: row.user_id, server_id: row.server_id, deleted_at: row.deleted_at })))}`
            + ` trash=${JSON.stringify(restoredTrash23)} detail=${JSON.stringify(restoredDetail23?.config)}`);

        const bookRenew23 = await book23('type=renew&pageSize=200');
        const renewRows23 = data23(bookRenew23).rows || [];
        check('filtering by kind leaves only that kind, and the counts and sums follow the same filter',
          bookRenew23.status === 200 && renewRows23.length > 0 && renewRows23.every((row) => row.type === 'renew')
            && Number(data23(bookRenew23).byType?.renew?.count) === renewRows23.length
            && Number(data23(bookRenew23).sums?.out) === Number(data23(bookRenew23).byType?.renew?.sum)
            && Number(data23(bookRenew23).sums?.in) === 0,
          `n=${renewRows23.length} byType=${JSON.stringify(data23(bookRenew23).byType || {})} sums=${JSON.stringify(data23(bookRenew23).sums || {})}`);

        const bookOut23 = await book23('direction=out&pageSize=200');
        const outRows23 = data23(bookOut23).rows || [];
        check('«هر چه از این کیف پول رفت» is answered by type, so a negative credit cannot disguise itself',
          bookOut23.status === 200 && outRows23.length > 0 && outRows23.every((row) => row.direction === 'out')
            && !outRows23.some((row) => row.type === 'credit') && Number(data23(bookOut23).sums?.in) === 0,
          `rows=${outRows23.length} types=${[...new Set(outRows23.map((row) => row.type))].join(',')}`);

        const bookIn23 = await book23('direction=in&pageSize=200');
        const inRows23 = data23(bookIn23).rows || [];
        check('and the other half is everything that ARRIVED — top-ups and commissions — with nothing that left mixed into it',
          bookIn23.status === 200 && inRows23.length > 0 && inRows23.every((row) => ['credit', 'commission'].includes(row.type))
            && Number(data23(bookIn23).sums?.countIn) === inRows23.length,
          `rows=${inRows23.length} countIn=${data23(bookIn23).sums?.countIn} types=${[...new Set(inRows23.map((row) => row.type))].join(',')}`);

        const bookJunk23 = await book23('type=everything&direction=sideways');
        const bookPlain23 = await book23('pageSize=200');
        check('a filter that is not one of the five kinds is ignored rather than an error or a hidden clause',
          bookJunk23.status === 200 && Number(data23(bookJunk23).total) === Number(data23(bookPlain23).total)
            && data23(bookJunk23).filters?.type === '' && data23(bookJunk23).filters?.direction === '',
          `total=${data23(bookJunk23).total} vs ${data23(bookPlain23).total}`);

        const debtTruth23 = Number(tdb.prepare(
          'SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND balance_after < 0'
        ).get(debtId23).c);
        const bookDebt23 = await book23(`userId=${debtId23}&pageSize=1`);
        const debtData23 = data23(bookDebt23);
        check('the debt card counts the whole filtered book, not the rows the page happens to show',
          bookDebt23.status === 200 && (debtData23.rows || []).length === 1
            && Number(debtData23.total) > 1 && Number(debtData23.debt) === debtTruth23 && debtTruth23 >= 1,
          `page=${(debtData23.rows || []).length} total=${debtData23.total} debt=${debtData23.debt} truth=${debtTruth23}`);

        const actors23 = data23(bookAll23).actors || [];
        const actorIds23 = actors23.map((row) => Number(row.id));
        const bookEmpty23 = await book23(`userId=${bulkId23}&direction=in`);
        check('the reseller dropdown is built from the ledger itself, so it never needs a user list',
          actors23.length > 0 && actorIds23.includes(Number(bulkId23)) && actorIds23.includes(Number(debtId23))
            && actors23.every((row) => Number(row.count) > 0)
            && Number(data23(bookEmpty23).total) === 0 && (data23(bookEmpty23).actors || []).length === actors23.length,
          `actors=${actors23.length} empty=${data23(bookEmpty23).total}`);

        const bookPage23 = await book23('pageSize=1&page=2');
        const page2Data23 = data23(bookPage23);
        check('pagination keeps the same filters and the same totals on every page',
          bookPage23.status === 200 && (page2Data23.rows || []).length === 1
            && Number(page2Data23.page) === 2 && Number(page2Data23.total) === Number(data23(bookAll23).total)
            && Number(page2Data23.debt) === Number(data23(bookAll23).debt),
          `page=${page2Data23.page} total=${page2Data23.total}/${data23(bookAll23).total} debt=${page2Data23.debt}/${data23(bookAll23).debt}`);

        tdb.prepare('UPDATE users SET referrer_id = ?, commission_percent = 0 WHERE id = ?').run(otherId23, grantId23);
        await request('PATCH', '/api/admin/settings/billing', { cookies, csrf, body: { enabled: true, commissionPercent: 5 } });
        const commissionRenew23 = await extendAdmin23({ ids: [Number(boughtRows23[0].id)], gb: 1, days: 0, charge: true });
        const buyerCommissionLine23 = ledger23(grantId23).filter((row) => row.type === 'renew').slice(-1)[0] || {};
        const referrerLine23 = ledger23(otherId23).filter((row) => row.type === 'commission').slice(-1)[0] || {};
        check('v2.4.0 the matching commission carries the same package link as the purchase it paid on',
          commissionRenew23.status === 200 && Number(buyerCommissionLine23.config_id) > 0
            && Number(referrerLine23.config_id) === Number(buyerCommissionLine23.config_id)
            && String(referrerLine23.config_snapshot) === String(buyerCommissionLine23.config_snapshot)
            && Number(referrerLine23.amount) > 0,
          `buyer=${buyerCommissionLine23.config_id} referrer=${referrerLine23.config_id} amount=${referrerLine23.amount}`);
      } catch (err) {
        fail += 1;
        console.log(`  FAIL v2.3.0 block threw — ${err.message}`);
      } finally {
        try {
          tdb.prepare('UPDATE inbounds SET visible = ? WHERE id = 902').run(Number(visWas902));
          if (disabled903) tdb.prepare('UPDATE inbounds SET enabled = 1 WHERE id = 903').run();
          for (const id of planIds23) tdb.prepare('UPDATE plans SET deleted_at = ? WHERE id = ?').run(Date.now(), Number(id));
          for (const email of mail23) mockXui.clients.delete(email);
          tdb.prepare('DELETE FROM configs WHERE email LIKE ?').run('sc230-%');
          tdb.prepare('DELETE FROM config_trash WHERE email LIKE ?').run('sc230-%');
          tdb.prepare('DELETE FROM topup_requests WHERE reference LIKE ?').run('SC230-%');
          if (nodeIds23.length) {
            const marks = nodeIds23.map(() => '?').join(',');
            tdb.prepare(`DELETE FROM inbounds WHERE server_id IN (${marks})`).run(...nodeIds23);
            tdb.prepare(`DELETE FROM servers WHERE id IN (${marks})`).run(...nodeIds23);
          }
          for (const id of userIds23) {
            tdb.prepare('DELETE FROM transactions WHERE user_id = ?').run(Number(id));
            tdb.prepare('DELETE FROM users WHERE id = ?').run(Number(id));
          }
          tdb.close();
        } catch (_) { /* the throwaway database is deleted anyway */ }
        if (parked23) await request('PATCH', '/api/admin/settings/monitor', { cookies, csrf, body: { intervalSec: monitorWas23 } });
        if (lifted23 && securityWas23.loginRateLimit !== undefined) {
          await request('PATCH', '/api/admin/settings/security', {
            cookies, csrf, body: { loginRateLimit: Number(securityWas23.loginRateLimit) },
          });
        }
        if (paymentWas23.autoApproveEnabled !== undefined) {
          // The sweep is switched back off before this block lets go of the
          // process, or the next block would find receipts it never filed.
          await request('PATCH', '/api/admin/settings/payment', {
            cookies, csrf,
            body: {
              autoApproveEnabled: Boolean(paymentWas23.autoApproveEnabled),
              autoApproveReceipt: Boolean(paymentWas23.autoApproveReceipt),
              autoApproveMaxAmount: Number(paymentWas23.autoApproveMaxAmount || 0),
              autoApproveAfterMinutes: Number(paymentWas23.autoApproveAfterMinutes || 15),
              autoApproveDailyLimit: Number(paymentWas23.autoApproveDailyLimit || 0),
            },
          });
        }
        if (billingWas23 && billingWas23.enabled !== undefined) {
          await request('PATCH', '/api/admin/settings/billing', {
            cookies, csrf,
            body: { enabled: Boolean(billingWas23.enabled), commissionPercent: Number(billingWas23.commissionPercent || 0) },
          });
        }
      }
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

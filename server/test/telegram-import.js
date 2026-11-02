'use strict';

/**
 * Telegram-id adoption test.
 *
 * Creates a throwaway data directory, seeds one reachable server plus one
 * disabled/broken server, and stubs the x-ui client list. It checks that
 * pre-existing subscriptions are adopted by "<telegramId>-", that unrelated
 * ids never match, that re-running is idempotent, that live rows owned by
 * someone else are never stolen, that soft-deleted rows are restored and that
 * importing never charges the wallet.
 *
 *   npm run telegram-test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-tg-'));
process.env.DATA_DIR = DATA_DIR;
process.env.BACKUP_DIR = path.join(DATA_DIR, 'backups');
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = require('../src/db');
const usersService = require('../src/services/users');
const configsService = require('../src/services/configs');
const xui = require('../src/xui');
const { sanitizeUser } = require('../src/utils');

let pass = 0;
let fail = 0;
function check(name, ok, note = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}${note ? '  — ' + note : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${note ? '  — ' + note : ''}`); }
}

const GB = 1024 * 1024 * 1024;
const NOW = Date.now();
const FUTURE = NOW + 30 * 86400000;

const clients = new Map();
const requestedServers = [];

function seed() {
  const db = getDb();
  const ts = NOW;
  db.prepare(
    `INSERT INTO servers (id, name, url, token, enabled, sort, created_at, updated_at)
     VALUES (1, 'panel-a', 'http://127.0.0.1:1', 'tok', 1, 0, ?, ?)`
  ).run(ts, ts);
  db.prepare(
    `INSERT INTO servers (id, name, url, token, enabled, sort, created_at, updated_at)
     VALUES (2, 'panel-off', 'http://127.0.0.1:2', 'tok', 0, 1, ?, ?)`
  ).run(ts, ts);
  db.prepare(
    `INSERT INTO servers (id, name, url, token, enabled, sort, created_at, updated_at)
     VALUES (3, 'panel-down', 'http://127.0.0.1:3', 'tok', 1, 2, ?, ?)`
  ).run(ts, ts);
  db.prepare(
    `INSERT INTO inbounds (id, server_id, xui_id, remark, protocol, enabled, visible, updated_at)
     VALUES (10, 1, 11, 'in-11', 'vless', 1, 1, ?), (20, 1, 12, 'in-12', 'vless', 1, 1, ?)`
  ).run(ts, ts);

  clients.set('700100200-11111', {
    email: '700100200-11111', inboundIds: [11, 12], subId: 'sub-1', uuid: 'uuid-1',
    flow: '', totalBytes: 10 * GB, expiryAt: FUTURE, enabled: true,
    up: 100, down: 200, lastOnlineAt: NOW - 1000, comment: 'first', createdAt: NOW - 86400000,
  });
  clients.set('700100200_22222', {
    email: '700100200_22222', inboundIds: [12], subId: 'sub-2', uuid: 'uuid-2',
    totalBytes: 5 * GB, expiryAt: 0, enabled: false,
    up: 1, down: 2, lastOnlineAt: 0, createdAt: 0,
  });
  clients.set('700100200', {
    email: '700100200', inboundIds: [11], subId: 'sub-3', uuid: 'uuid-3',
    totalBytes: 1 * GB, expiryAt: FUTURE, enabled: true,
    up: 3, down: 4, lastOnlineAt: 0, createdAt: 0,
  });
  // The list endpoint is allowed to omit the attachment; one getClient heals it.
  clients.set('700100200-88888', {
    email: '700100200-88888', subId: 'sub-8', uuid: 'uuid-8',
    totalBytes: 2 * GB, expiryAt: FUTURE, enabled: true,
    up: 5, down: 6, lastOnlineAt: 0, createdAt: 0,
  });
  clients.set('700100200-77777', {
    email: '700100200-77777', inboundIds: [11], subId: 'live-sub', uuid: 'live-uuid',
    totalBytes: 3 * GB, expiryAt: FUTURE, enabled: true,
    up: 7, down: 8, lastOnlineAt: 0, createdAt: 0,
  });
  // Matched, but its DB row belongs to another reseller -> never stolen.
  clients.set('700100200-66666', {
    email: '700100200-66666', inboundIds: [11], subId: 'other-sub', uuid: 'other-uuid',
    totalBytes: 4 * GB, expiryAt: FUTURE, enabled: true, up: 9, down: 10, createdAt: 0,
  });
  // Prefix trap: a longer id that merely starts with the same digits.
  clients.set('7001002000-33333', {
    email: '7001002000-33333', inboundIds: [11], subId: 'sub-x', uuid: 'uuid-x',
    totalBytes: 1, expiryAt: 0, enabled: true, up: 0, down: 0, createdAt: 0,
  });
  clients.set('999999-44444', {
    email: '999999-44444', inboundIds: [11], subId: 'sub-y', uuid: 'uuid-y',
    totalBytes: 1, expiryAt: 0, enabled: true, up: 0, down: 0, createdAt: 0,
  });
  // Matched but its inbound is unknown on this server -> skipped, never invented.
  clients.set('700100200-55555', {
    email: '700100200-55555', inboundIds: [99], subId: 'sub-z', uuid: 'uuid-z',
    totalBytes: 1, expiryAt: 0, enabled: true, up: 0, down: 0, createdAt: 0,
  });
}

function stubXui() {
  xui.listClients = async (server) => {
    requestedServers.push(Number(server.id));
    if (Number(server.id) === 3) throw new Error('panel is unreachable');
    return [...clients.values()];
  };
  xui.getClient = async (email) => {
    const row = clients.get(String(email));
    if (!row) return null;
    if (row.email === '700100200-88888') return { ...row, inboundIds: [11], subId: 'sub-8', uuid: 'uuid-8' };
    return { ...row, inboundIds: row.inboundIds || [] };
  };
  // syncInbounds (used when a matched inbound is not known yet) must be a no-op.
  xui.inbounds = async () => [];
  xui.nodes = async () => [];
  xui.inboundsSlim = async () => [];
}

async function run() {
  seed();
  stubXui();
  const db = getDb();

  // --------------------------------------------------------- telegram field
  const other = usersService.createUser({
    username: 'othershop', password: 'password123', role: 'reseller', telegram_id: '999999',
  });
  check('telegram id is stored and exposed by sanitizeUser',
    other.telegram_id === '999999' && sanitizeUser(other).telegramId === '999999');

  let err = null;
  try {
    usersService.createUser({ username: 'badshop', password: 'password123', telegram_id: '12ab' });
  } catch (caught) { err = caught; }
  check('non-numeric telegram id is rejected', err && err.status === 422 && err.code === 'invalid_telegram_id');

  err = null;
  try {
    usersService.createUser({ username: 'dupshop', password: 'password123', telegram_id: '999999' });
  } catch (caught) { err = caught; }
  check('a telegram id cannot be reused by another user', err && err.status === 409 && err.code === 'telegram_id_taken');

  const shop = usersService.createUser({
    username: 'tgshop', password: 'password123', role: 'reseller', telegram_id: '@700100200',
  });
  check('a leading @ is accepted and stripped', shop.telegram_id === '700100200');

  // ------------------------------------------------------ client naming x-y
  check('new clients are named "<telegramId>-<number>"',
    /^700100200-\d+$/.test(configsService.emailFor(shop)), configsService.emailFor(shop));
  const legacy = usersService.createUser({ username: 'legacy', password: 'password123', role: 'reseller' });
  check('users without a telegram id keep the username-based name',
    /^legacy-\d+$/.test(configsService.emailFor(legacy)));

  // A live row owned by the other reseller and a soft-deleted row to restore.
  db.prepare(
    `INSERT INTO configs (user_id, inbound_id, server_id, email, sub_id, xui_sub_id, uuid, total_bytes,
       expiry_at, enabled, status, created_at, updated_at)
     VALUES (?, 10, 1, '700100200-66666', '', 'old-sub', 'old-uuid', 1000, 0, 1, 'active', ?, ?)`
  ).run(Number(other.id), NOW, NOW);
  db.prepare(
    `INSERT INTO configs (user_id, inbound_id, server_id, email, sub_id, xui_sub_id, uuid, total_bytes,
       expiry_at, enabled, status, created_at, updated_at, deleted_at)
     VALUES (?, 10, 1, '700100200-77777', '', 'dead-sub', 'dead-uuid', 1, 0, 0, 'expired', ?, ?, ?)`
  ).run(Number(other.id), NOW, NOW, NOW);

  // ------------------------------------------------------------- first run
  const first = await configsService.importTelegramClients(shop);
  check('imported new subscriptions + restored the deleted one',
    first.imported === 4 && first.restored === 1,
    `imported=${first.imported} restored=${first.restored} skipped=${first.skipped} conflicts=${first.conflicts}`);
  check('an unreachable panel is reported, not fatal', first.failed === 1 && first.errors.length === 1, first.errors.join(' | '));
  check('disabled panels are never queried',
    !requestedServers.includes(2) && requestedServers.includes(1) && requestedServers.includes(3),
    requestedServers.join(','));
  check('unrelated ids and unknown inbounds are not imported',
    first.conflicts === 1 && first.skipped === 1,
    `conflicts=${first.conflicts} skipped=${first.skipped}`);

  const rows = db.prepare('SELECT * FROM configs WHERE user_id = ? ORDER BY email').all(Number(shop.id));
  const byEmail = new Map(rows.map((row) => [row.email, row]));
  check('prefix traps and foreign ids stay out of the reseller list',
    !byEmail.has('7001002000-33333') && !byEmail.has('999999-44444') && !byEmail.has('700100200-55555'));
  const multi = byEmail.get('700100200-11111');
  check('imported row keeps quota, usage, subId and uuid',
    multi
      && Number(multi.total_bytes) === 10 * GB
      && Number(multi.up_bytes) === 100
      && Number(multi.down_bytes) === 200
      && multi.xui_sub_id === 'sub-1'
      && multi.uuid === 'uuid-1'
      && Number(multi.server_id) === 1
      && multi.sub_id === '',
    multi ? `${multi.total_bytes}/${multi.up_bytes}/${multi.down_bytes}` : 'missing');
  check('a multi-inbound client maps to its first known inbound',
    multi && Number(multi.inbound_id) === 10);
  check('the attachment lookup fills an inbound missing from the list',
    Boolean(byEmail.get('700100200-88888')) && Number(byEmail.get('700100200-88888').inbound_id) === 10);
  check('the bare telegram id is adopted too', Boolean(byEmail.get('700100200')));
  check('a disabled client is imported disabled',
    byEmail.get('700100200_22222') && Number(byEmail.get('700100200_22222').enabled) === 0);
  check('a soft-deleted row is revived for the new owner',
    (() => {
      const row = byEmail.get('700100200-77777');
      return row
        && !Number(row.deleted_at)
        && Number(row.user_id) === Number(shop.id)
        && row.xui_sub_id === 'live-sub'
        && Number(row.total_bytes) === 3 * GB;
    })());
  check('the live row of another reseller is untouched',
    (() => {
      const row = db.prepare("SELECT user_id FROM configs WHERE email = '700100200-66666'").get();
      return row && Number(row.user_id) === Number(other.id);
    })());

  const tx = db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c;
  check('importing never charges the wallet', Number(tx) === 0, `transactions=${tx}`);

  // ------------------------------------------------------------ second run
  const second = await configsService.importTelegramClients(shop);
  check('re-running is idempotent',
    second.imported === 0 && second.restored === 0 && second.skipped === 6 && second.conflicts === 1,
    `imported=${second.imported} restored=${second.restored} skipped=${second.skipped} conflicts=${second.conflicts}`);

  const noId = await configsService.importTelegramClients(legacy);
  check('a user without a telegram id imports nothing', noId.imported === 0 && noId.servers === 0);

  // ------------------------------------------------ package + stats integration
  const stats = usersService.userStats(shop.id);
  check('imported subscriptions appear in the reseller stats',
    stats.packages === 5 && stats.configs === 5, `packages=${stats.packages} rows=${stats.configs}`);
  const listing = configsService.listConfigs({}, { role: 'admin', id: 1 });
  const shopRows = listing.rows.filter((row) => Number(row.userId) === Number(shop.id));
  check('the grouped config list shows every imported subscription',
    shopRows.length === 5, `rows=${shopRows.length}`);
}

run()
  .catch((err) => {
    fail += 1;
    console.error('  FAIL unexpected error:', err);
  })
  .finally(() => {
    closeDb();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    console.log(`\ntelegram-import: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });

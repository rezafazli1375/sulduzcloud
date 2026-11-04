'use strict';

/**
 * Telegram-id adoption test (v1.4.10).
 *
 * Creates a throwaway data directory, seeds one reachable server plus one
 * disabled/broken server, and stubs the x-ui client list. It checks that
 * pre-existing subscriptions are adopted by telegram id — whether the client is
 * named "<id>-<random>" or "<plan>-<id>-<random>" like the seller panels do —
 * that unrelated ids never match, that re-running refreshes instead of
 * duplicating, that live rows owned by someone else are never stolen, that
 * soft-deleted rows are restored, and that the per-reseller adoption switch
 * hides (never deletes) the adopted rows.
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
const TG = '700100200';

const clients = new Map();
const requestedServers = [];
const xuiWrites = [];

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
  // The id sitting in the random-suffix position is not an owner marker.
  clients.set('abc-700100200', {
    email: 'abc-700100200', inboundIds: [11], subId: 'sub-trap', uuid: 'uuid-trap',
    totalBytes: 1, expiryAt: 0, enabled: true, up: 0, down: 0, createdAt: 0,
  });
  // Matched but its inbound is unknown on this server -> skipped, never invented.
  clients.set('700100200-55555', {
    email: '700100200-55555', inboundIds: [99], subId: 'sub-z', uuid: 'uuid-z',
    totalBytes: 1, expiryAt: 0, enabled: true, up: 0, down: 0, createdAt: 0,
  });
  // Seller-panel naming: "<plan>-<id>-<random>".
  clients.set('german🇩🇪-700100200-39960', {
    email: 'german🇩🇪-700100200-39960', inboundIds: [12], subId: 'sub-de', uuid: 'uuid-de',
    totalBytes: 6 * GB, expiryAt: FUTURE, enabled: true,
    up: 20, down: 30, lastOnlineAt: 0, createdAt: 0, comment: 'DE plan',
  });
  // Ownership may also be carried by x-ui's own tgId field.
  clients.set('unrelated-name-111-000', {
    email: 'unrelated-name-111-000', inboundIds: [11], subId: 'sub-tgid', uuid: 'uuid-tgid',
    tgId: TG, totalBytes: 2 * GB, expiryAt: FUTURE, enabled: true,
    up: 40, down: 50, lastOnlineAt: 0, createdAt: 0,
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
  // Adoption is a read-only operation: it must never create, change or remove a
  // client on the seller panel. Any write here is a bug, so make it loud.
  for (const name of ['addClient', 'updateClient', 'deleteClient', 'resetTraffic',
    'setEnabled', 'setIdentity', 'adjustMany', 'attachInbounds', 'detachInbounds']) {
    xui[name] = async () => {
      xuiWrites.push(name);
      throw new Error(`adoption must never write to x-ui (${name})`);
    };
  }
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
  check('a leading @ is accepted and stripped', shop.telegram_id === TG);
  check('the adoption switch defaults to on and is exposed to the UI',
    shop.import_configs === 1 && sanitizeUser(shop).importConfigs === true);

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
  check('the matcher finds every naming style (own, prefixed, tgId, bare id)',
    first.matched === 9, `matched=${first.matched}`);
  check('imported new subscriptions + restored the deleted one',
    first.imported === 7 && first.restored === 1,
    `imported=${first.imported} restored=${first.restored} skipped=${first.skipped} conflicts=${first.conflicts}`);
  check('every inbound of an adopted client is recorded, not only the first',
    first.attached === 9, `attached=${first.attached}`);
  check('an unreachable panel is reported, not fatal', first.failed === 1 && first.errors.length === 1, first.errors.join(' | '));
  check('disabled panels are never queried',
    !requestedServers.includes(2) && requestedServers.includes(1) && requestedServers.includes(3),
    requestedServers.join(','));
  check('unrelated ids and unknown inbounds are not imported',
    first.conflicts === 1 && first.skipped === 1,
    `conflicts=${first.conflicts} skipped=${first.skipped}`);

  const rows = db.prepare('SELECT * FROM configs WHERE user_id = ? ORDER BY email, id').all(Number(shop.id));
  const rowsOf = (email) => rows.filter((row) => row.email === email);
  const byEmail = new Map(rows.map((row) => [row.email, row]));
  check('prefix traps, suffix traps and foreign ids stay out of the reseller list',
    !byEmail.has('7001002000-33333') && !byEmail.has('999999-44444')
      && !byEmail.has('700100200-55555') && !byEmail.has('abc-700100200'));
  const multi = rowsOf('700100200-11111')[0];
  const multiSiblings = rowsOf('700100200-11111');
  check('imported row keeps quota, usage, subId and uuid',
    multi
      && Number(multi.total_bytes) === 10 * GB
      && Number(multi.up_bytes) === 100
      && Number(multi.down_bytes) === 200
      && multi.xui_sub_id === 'sub-1'
      && multi.uuid === 'uuid-1'
      && Number(multi.server_id) === 1,
    multi ? `${multi.total_bytes}/${multi.up_bytes}/${multi.down_bytes}` : 'missing');
  check('v1.4.17: one adopted client on two inbounds becomes two rows',
    multiSiblings.length === 2
      && multiSiblings.map((row) => Number(row.inbound_id)).sort().join(',') === '10,20'
      && multiSiblings.every((row) => row.origin === 'external' && row.xui_sub_id === 'sub-1'),
    `rows=${multiSiblings.length} [${multiSiblings.map((row) => row.inbound_id).join(',')}]`);
  check('v1.4.17: both siblings share ONE group token (one customer, one pool)',
    multiSiblings.length === 2 && multiSiblings[0].sub_id
      && multiSiblings.every((row) => row.sub_id === multiSiblings[0].sub_id),
    multiSiblings.map((row) => `'${row.sub_id}'`).join(' vs '));
  check('imported rows are marked as external (old panel)',
    Boolean(byEmail.get('german🇩🇪-700100200-39960'))
      && byEmail.get('german🇩🇪-700100200-39960').origin === 'external',
    byEmail.get('german🇩🇪-700100200-39960')?.origin);
  check('a seller-panel style name is adopted', Boolean(byEmail.get('german🇩🇪-700100200-39960')));
  check('x-ui tgId is enough to adopt a differently named client', Boolean(byEmail.get('unrelated-name-111-000')));
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
  check('adoption never writes to the seller panel (read-only, no client created or removed)',
    xuiWrites.length === 0, xuiWrites.join(','));

  // ------------------------------------------------------------ second run
  // The panel changed under us: quota, usage, expiry, uuid, subId and enable
  // must follow; a reseller-edited note must survive the refresh.
  db.prepare("UPDATE configs SET note = 'keep me', customer_name = 'Cust' WHERE email = '700100200-11111'").run();
  const live = clients.get('700100200-11111');
  const newExpiry = FUTURE + 86400000;
  Object.assign(live, {
    totalBytes: 15 * GB, up: 500, down: 600, enabled: false,
    uuid: 'uuid-1b', subId: 'sub-1b', expiryAt: newExpiry,
  });

  const second = await configsService.importTelegramClients(shop);
  check('re-running refreshes, never duplicates',
    second.imported === 0 && second.restored === 0 && second.refreshed === 8
      && second.skipped === 1 && second.conflicts === 1,
    `imported=${second.imported} restored=${second.restored} refreshed=${second.refreshed} skipped=${second.skipped} conflicts=${second.conflicts}`);
  const refreshed = db.prepare("SELECT * FROM configs WHERE email = '700100200-11111'").get();
  check('a refresh copies live quota, usage, expiry, uuid and enabled',
    Number(refreshed.total_bytes) === 15 * GB
      && Number(refreshed.up_bytes) === 500
      && Number(refreshed.down_bytes) === 600
      && Number(refreshed.expiry_at) === newExpiry
      && refreshed.uuid === 'uuid-1b'
      && refreshed.xui_sub_id === 'sub-1b'
      && Number(refreshed.enabled) === 0,
    `total=${refreshed.total_bytes} up=${refreshed.up_bytes} expiry=${refreshed.expiry_at} enabled=${refreshed.enabled}`);
  check('a refresh keeps the reseller note and customer name',
    refreshed.note === 'keep me' && refreshed.customer_name === 'Cust',
    `${refreshed.note}/${refreshed.customer_name}`);
  check('re-running keeps exactly the two rows of that client (no duplicates)',
    db.prepare("SELECT COUNT(*) AS c FROM configs WHERE email = '700100200-11111'").get().c === 2);
  // ------------------------------------------------- v1.4.17: one customer, two inbounds
  const legacyPackage = configsService.listConfigs({ userId: shop.id }, { role: 'admin', id: 1 })
    .rows.find((row) => row.email === '700100200-11111');
  check('the adopted package lists every inbound the client is attached to',
    legacyPackage
      && legacyPackage.groupCount === 2
      && (legacyPackage.inbounds || []).map((item) => item.id).sort().join(',') === '10,20',
    legacyPackage ? `groupCount=${legacyPackage.groupCount} inbounds=${JSON.stringify(legacyPackage.inbounds)}` : 'package missing');
  check('the shared client is counted ONCE in the pool, not once per inbound',
    legacyPackage
      && Number(legacyPackage.used) === 1100
      && Number(legacyPackage.totalBytes) === 15 * GB,
    legacyPackage ? `used=${legacyPackage.used} quota=${legacyPackage.totalBytes}` : 'package missing');
  // 11111 is the only two-inbound customer; its 500+600 must not be summed twice.
  // 22222:3 700100200:7 88888:11 77777:15 german:50 unrelated:90 => 176
  check('the reseller traffic total does not double-count it',
    usersService.userStats(shop.id).usedBytes === 1276,
    `usedBytes=${usersService.userStats(shop.id).usedBytes}`);
  const drawer = configsService.packageView(refreshed);
  check('the edit drawer of an adopted config shows both inbounds',
    drawer && (drawer.inbounds || []).map((item) => item.id).sort().join(',') === '10,20',
    drawer ? `inbounds=${JSON.stringify((drawer.inbounds || []).map((item) => item.id))}` : 'no drawer');

  // A package can hold an adopted customer AND a client this panel created for him
  // (the fixed-inbound heal and «افزودن اینباند» both do that). Each x-ui client must
  // then contribute its own counters once: the adopted one is repeated on its two
  // rows, the new one appears once. 1100 + 150, never 500+600+500+600+150.
  const mixedToken = refreshed.sub_id;
  db.prepare(`INSERT INTO configs
      (user_id, server_id, inbound_id, email, sub_id, xui_sub_id, uuid, label, customer_name,
       total_bytes, expiry_at, enabled, status, origin, up_bytes, down_bytes, created_at, updated_at)
      VALUES (?, ?, ?, 'mixed-client-999', ?, '', 'uuid-mixed', 'added', '', ?, ?, 1, 'active', 'external', 100, 50, ?, ?)`)
    .run(refreshed.user_id, refreshed.server_id, refreshed.inbound_id, mixedToken,
      refreshed.total_bytes, refreshed.expiry_at, Date.now(), Date.now());
  const mixedPackage = configsService.listConfigs({ userId: shop.id }, { role: 'admin', id: 1 })
    .rows.find((row) => row.subId === mixedToken);
  check('a package with the adopted client plus a new client counts each of them once',
    mixedPackage && mixedPackage.groupCount === 3 && Number(mixedPackage.used) === 1250,
    mixedPackage ? `groupCount=${mixedPackage.groupCount} used=${mixedPackage.used}` : 'package missing');
  const mixedRow = db.prepare("SELECT * FROM configs WHERE email = 'mixed-client-999'").get();
  check('the drawer of that mixed package agrees with the list',
    Number(configsService.packageView(mixedRow).used) === 1250
      && Number(configsService.packageView(refreshed).used) === 1250,
    `used=${configsService.packageView(mixedRow).used}`);
  check('the reseller total adds the new client without repeating the adopted one',
    usersService.userStats(shop.id).usedBytes === 1426,
    `usedBytes=${usersService.userStats(shop.id).usedBytes}`);
  db.prepare("DELETE FROM configs WHERE email = 'mixed-client-999'").run();

  const noId = await configsService.importTelegramClients(legacy);
  check('a user without a telegram id imports nothing', noId.imported === 0 && noId.servers === 0);

  // ------------------------------------------------ package + stats integration
  const stats = usersService.userStats(shop.id);
  check('imported subscriptions appear in the reseller stats',
    stats.packages === 7 && stats.configs === 8 && stats.externalPackages === 7,
    `packages=${stats.packages} rows=${stats.configs} external=${stats.externalPackages}`);
  const listing = configsService.listConfigs({}, { role: 'admin', id: 1 });
  const shopRows = listing.rows.filter((row) => Number(row.userId) === Number(shop.id));
  check('the grouped config list shows every imported subscription',
    shopRows.length === 7, `rows=${shopRows.length}`);
  check('every adopted row reports origin=external',
    shopRows.every((row) => row.origin === 'external'));

  // --------------------------------------------------------- origin filters
  const externalOnly = configsService.listConfigs({ origin: 'external' }, { role: 'admin', id: 1 });
  const panelOnly = configsService.listConfigs({ origin: 'panel' }, { role: 'admin', id: 1 });
  check('the origin filter separates old-panel subscriptions',
    externalOnly.rows.filter((row) => Number(row.userId) === Number(shop.id)).length === 7
      && panelOnly.rows.filter((row) => Number(row.userId) === Number(shop.id)).length === 0,
    `external=${externalOnly.total} panel=${panelOnly.total}`);
  const csvRows = configsService.exportRows({ origin: 'external' }, { role: 'admin' });
  check('CSV export honours the origin filter',
    csvRows.length === 8 && csvRows.every((row) => row.origin === 'external'), `rows=${csvRows.length}`);

  // ------------------------------------------------- adoption switch off/on
  const off = usersService.updateUser(shop.id, { import_configs: false });
  check('the switch can be turned off', sanitizeUser(off).importConfigs === false);
  const offImport = await configsService.importTelegramClients(off);
  check('a switched-off reseller imports nothing', offImport.enabled === false && offImport.matched === 0);
  check('switching off deletes nothing from the database',
    db.prepare("SELECT COUNT(*) AS c FROM configs WHERE user_id = ? AND origin = 'external'").get(Number(shop.id)).c === 8);
  const offStats = usersService.userStats(shop.id);
  check('hidden adopted subscriptions leave the stats',
    offStats.packages === 0 && offStats.configs === 0 && offStats.externalPackages === 0,
    `packages=${offStats.packages} rows=${offStats.configs}`);
  const offAdminList = configsService.listConfigs({ userId: shop.id }, { role: 'admin', id: 1 });
  const offResellerList = configsService.listConfigs({}, { role: 'reseller', id: shop.id });
  const offCsv = configsService.exportRows({}, { role: 'admin' });
  check('switching off hides the adopted rows from admin and reseller lists',
    offAdminList.rows.length === 0 && offResellerList.rows.length === 0
      && offCsv.filter((row) => Number(row.userId) === Number(shop.id)).length === 0,
    `admin=${offAdminList.rows.length} reseller=${offResellerList.rows.length}`);

  const backOn = usersService.updateUser(shop.id, { import_configs: true });
  const onImport = await configsService.importTelegramClients(backOn);
  check('turning it back on re-adopts the same rows',
    sanitizeUser(backOn).importConfigs === true && onImport.refreshed === 8
      && db.prepare("SELECT COUNT(*) AS c FROM configs WHERE user_id = ? AND origin = 'external'").get(Number(shop.id)).c === 8,
    `refreshed=${onImport.refreshed}`);
  const onList = configsService.listConfigs({ userId: shop.id }, { role: 'admin', id: 1 });
  check('turning it back on shows the rows again', onList.rows.length === 7, `rows=${onList.rows.length}`);

  // -------------------------------------------- separation from real customers
  db.prepare(
    `INSERT INTO configs (user_id, inbound_id, server_id, email, sub_id, xui_sub_id, uuid, total_bytes,
       expiry_at, enabled, status, created_at, updated_at)
     VALUES (?, 10, 1, 'panel-made-1', '', 'p-sub', 'p-uuid', ?, ?, 1, 'active', ?, ?)`
  ).run(Number(shop.id), 2 * GB, FUTURE, NOW, NOW);
  const mixedStats = usersService.userStats(shop.id);
  check('customers created in this panel are counted apart from adopted ones',
    mixedStats.packages === 8 && mixedStats.externalPackages === 7,
    `packages=${mixedStats.packages} external=${mixedStats.externalPackages}`);
  const mixedExternal = configsService.listConfigs({ userId: shop.id, origin: 'external' }, { role: 'admin', id: 1 });
  const mixedPanel = configsService.listConfigs({ userId: shop.id, origin: 'panel' }, { role: 'admin', id: 1 });
  check('the two lists never mix',
    mixedExternal.rows.length === 7 && mixedPanel.rows.length === 1
      && mixedExternal.rows.every((row) => row.origin === 'external')
      && mixedPanel.rows.every((row) => row.origin === 'panel'),
    `external=${mixedExternal.rows.length} panel=${mixedPanel.rows.length}`);
  const off2 = usersService.updateUser(shop.id, { import_configs: false });
  const off2List = configsService.listConfigs({ userId: shop.id }, { role: 'admin', id: 1 });
  const off2Stats = usersService.userStats(shop.id);
  check('switching off hides only the adopted rows, the panel customer stays',
    off2List.rows.length === 1 && off2List.rows[0].origin === 'panel'
      && off2Stats.packages === 1 && off2Stats.externalPackages === 0,
    `rows=${off2List.rows.length} packages=${off2Stats.packages}`);
  check('the reseller still owns the hidden rows after switching off',
    Number(off2.import_configs) === 0
      && db.prepare("SELECT COUNT(*) AS c FROM configs WHERE user_id = ? AND origin = 'external' AND deleted_at = 0").get(Number(shop.id)).c === 8);

  // A reseller created with the switch already off imports nothing on create.
  const offUser = usersService.createUser({
    username: 'offshop', password: 'password123', role: 'reseller', telegram_id: '555666777', import_configs: false,
  });
  check('the switch can be set at creation time',
    sanitizeUser(offUser).importConfigs === false && offUser.import_configs === 0);
  const offUserImport = await configsService.importTelegramClients(offUser);
  check('a reseller created switched off has no adoption pass',
    offUserImport.enabled === false && offUserImport.matched === 0);

  // --------------------------- v1.4.17: the quota enforcer must not cut an adopted customer
  // x-ui reports ONE set of counters per client, and an adopted customer is kept as
  // one row per inbound with those same numbers repeated on every row. Adding them
  // per row makes a three-inbound customer who used 4 GiB of his shared 10 GiB pool
  // look 12 GiB deep, and the background sync would then switch off a paying
  // customer who still has two thirds of his traffic left — on the SELLER's panel.
  const heavyTg = '700100300';
  const heavy = `${heavyTg}-90000`;
  db.prepare(
    `INSERT INTO inbounds (id, server_id, xui_id, remark, protocol, enabled, visible, updated_at)
     VALUES (30, 1, 13, 'in-13', 'vless', 1, 1, ?)`
  ).run(Date.now());
  clients.set(heavy, {
    email: heavy, inboundIds: [11, 12, 13], subId: 'sub-heavy', uuid: 'uuid-heavy', flow: '',
    totalBytes: 10 * GB, expiryAt: FUTURE, enabled: true,
    up: 2 * GB, down: 2 * GB, lastOnlineAt: NOW, comment: 'three inbounds', createdAt: NOW - 5000,
  });
  const heavyShop = usersService.createUser({
    username: 'heavyshop', password: 'password123', role: 'reseller', telegram_id: heavyTg,
  });
  await configsService.importTelegramClients(heavyShop);
  const heavyRows = db.prepare('SELECT * FROM configs WHERE email = ? AND deleted_at = 0 ORDER BY id').all(heavy);
  check('a customer on three seller inbounds is adopted as three rows under one token',
    heavyRows.length === 3 && new Set(heavyRows.map((item) => item.sub_id)).size === 1
      && new Set(heavyRows.map((item) => Number(item.inbound_id))).size === 3,
    `rows=${heavyRows.length}`);

  const writesBefore = xuiWrites.length;
  const sync = await configsService.syncConfigs({});
  check('a full sync does not switch off a customer who is inside his shared pool',
    xuiWrites.length === writesBefore && sync.disabled === 0,
    `writes=${xuiWrites.slice(writesBefore).join(',')} disabled=${sync.disabled}`);
  check('every row of that customer is still enabled in the panel',
    db.prepare('SELECT COUNT(*) AS c FROM configs WHERE email = ? AND enabled = 1').get(heavy).c === 3);
  const heavyPackage = configsService.listConfigs({ userId: heavyShop.id }, { role: 'admin', id: 1 }).rows[0];
  check('the pool of that customer reads 4 GiB, not 12 GiB',
    heavyPackage && heavyPackage.groupCount === 3
      && Number(heavyPackage.used) === 4 * GB
      && Number(heavyPackage.totalBytes) === 10 * GB,
    heavyPackage ? `used=${heavyPackage.used} quota=${heavyPackage.totalBytes} n=${heavyPackage.groupCount}` : 'package missing');

  // When the client really does use more than the pool, the panel switches the CLIENT
  // off — once, not once per inbound row.
  Object.assign(clients.get(heavy), { up: 7 * GB, down: 4 * GB });
  await configsService.syncConfigs({});
  const attempts = xuiWrites.slice(writesBefore);
  check('a genuinely over-quota customer is written to once per client, not per inbound',
    attempts.length === 1 && attempts[0] === 'setEnabled', attempts.join(','));
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

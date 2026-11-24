'use strict';

const Database = require('better-sqlite3');
const service = require('../src/services/transactions');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE configs (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL DEFAULT 0, server_id INTEGER NOT NULL DEFAULT 1,
      inbound_id INTEGER NOT NULL DEFAULT 0, email TEXT NOT NULL DEFAULT '', sub_id TEXT NOT NULL DEFAULT '',
      uuid TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', customer_name TEXT NOT NULL DEFAULT '',
      customer_phone TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'panel', deleted_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE inbounds (
      id INTEGER PRIMARY KEY, node_name TEXT NOT NULL DEFAULT '', remark TEXT NOT NULL DEFAULT '',
      protocol TEXT NOT NULL DEFAULT '', port INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, config_id INTEGER NOT NULL DEFAULT 0, config_snapshot TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
    );
    CREATE TABLE config_trash (
      id INTEGER PRIMARY KEY AUTOINCREMENT, head_config_id INTEGER NOT NULL, user_id INTEGER NOT NULL DEFAULT 0,
      server_id INTEGER NOT NULL DEFAULT 1, email TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '',
      customer_name TEXT NOT NULL DEFAULT '', rows_json TEXT NOT NULL DEFAULT '[]', inbound_ids TEXT NOT NULL DEFAULT '[]',
      restored_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function insertConfig(db, { id, userId = 7, inboundId = 901, email = 'customer@example.test', subId = '', origin = 'panel', deletedAt = 0 }) {
  db.prepare(`
    INSERT INTO configs (id, user_id, server_id, inbound_id, email, sub_id, uuid, label, customer_name,
      customer_phone, origin, deleted_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, inboundId, email, subId, `secret-uuid-${id}`, `Label ${id}`, `Customer ${id}`, '09120000000', origin, deletedAt);
}

console.log('\n── transaction config snapshots ──');
{
  const db = makeDb();
  try {
    const row = {
      id: 10, user_id: 7, server_id: 2, inbound_id: 901, email: 'customer@example.test',
      label: 'Package A', customer_name: 'Customer A', uuid: 'secret-uuid', sub_id: 'secret-subscription',
      customer_phone: '09120000000',
    };
    const members = [row, { id: 11, inbound_id: 902 }];
    const inbounds = [
      { id: 901, remark: 'Channel A', protocol: 'vless', port: 443, server_name: 'Node A' },
      { id: 902, remark: 'Channel B', protocol: 'vmess', port: 8443, node_name: 'Node B' },
    ];
    const linked = service.capture(row, members, inbounds);
    const saved = JSON.parse(linked.snapshot);
    check('capture keeps the selected package anchor and every inbound',
      linked.configId === 10 && saved.inbounds.length === 2
      && saved.inbounds[0].inboundId === 901 && saved.inbounds[1].inboundId === 902,
      `anchor=${linked.configId} inbounds=${saved.inbounds.length}`);
    check('node names come from either the inbound or its server',
      saved.inbounds[0].nodeName === 'Node A' && saved.inbounds[1].nodeName === 'Node B',
      `${saved.inbounds[0].nodeName}/${saved.inbounds[1].nodeName}`);
    check('the snapshot never copies UUID, subscription token or phone',
      !/secret-uuid|secret-subscription|09120000000/.test(linked.snapshot)
      && !/"uuid"|"sub_id"|"xui_sub_id"|"customer_phone"|"packageKey"/i.test(linked.snapshot),
      linked.snapshot);

    insertConfig(db, { id: 10, inboundId: 901, email: row.email, subId: 'sub-a' });
    insertConfig(db, { id: 11, inboundId: 902, email: 'customer-11@example.test', subId: 'sub-a' });
    db.prepare('INSERT INTO inbounds (id, node_name, remark, protocol, port) VALUES (901, ?, ?, ?, ?)')
      .run('Node A', 'Channel A', 'vless', 443);
    db.prepare('INSERT INTO inbounds (id, node_name, remark, protocol, port) VALUES (902, ?, ?, ?, ?)')
      .run('Node B', 'Channel B', 'vmess', 8443);
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, balance_after, description, created_at, config_id, config_snapshot)
      VALUES (7, 'purchase', -100, 900, 'purchase', 1000, 10, ?)
    `).run(linked.snapshot);
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, balance_after, description, created_at)
      VALUES (7, 'credit', 1000, 1000, 'top-up', 1001)
    `).run();

    const first = service.presentRows(db, db.prepare('SELECT * FROM transactions ORDER BY id').all());
    check('page enrichment preserves the ledger row and adds safe config details',
      first.length === 2 && first[0].id === 1 && first[0].type === 'purchase'
      && first[0].amount === -100 && first[0].configId === 10
      && first[0].config.email === row.email && first[0].config.deleted === false
      && first[1].id === 2 && first[1].configId === 0 && first[1].config === null,
      JSON.stringify(first[0]).slice(0, 160));

    db.prepare('UPDATE configs SET deleted_at = 123 WHERE id IN (10, 11)').run();
    const soft = service.presentRows(db, db.prepare('SELECT * FROM transactions WHERE id = 1').all())[0];
    check('a soft-deleted package keeps its identity and is marked deleted',
      soft.config.deleted === true && soft.config.customerName === 'Customer A' && soft.config.inbounds.length === 2,
      JSON.stringify(soft.config));

    db.prepare('DELETE FROM configs WHERE id IN (10, 11)').run();
    db.prepare(`
      INSERT INTO config_trash (head_config_id, user_id, server_id, email, label, customer_name, rows_json, inbound_ids)
      VALUES (10, 7, 2, ?, ?, ?, '[]', '[901,902]')
    `).run(row.email, row.label, row.customer_name);
    const hard = service.presentRows(db, db.prepare('SELECT * FROM transactions WHERE id = 1').all())[0];
    check('a hard-deleted package remains explainable from its saved snapshot',
      hard.config.deleted === true && hard.config.email === row.email && hard.config.id === 10,
      JSON.stringify(hard.config));

    db.prepare(`
      INSERT INTO configs (id, user_id, server_id, inbound_id, email, sub_id, uuid, label, customer_name,
        customer_phone, origin, deleted_at)
      VALUES (10, 8, 2, 901, 'restored@example.test', 'sub-a', 'new-secret', 'Restored', 'Restored Customer', '', 'panel', 0)
    `).run();
    const restored = service.presentRows(db, db.prepare('SELECT * FROM transactions WHERE id = 1').all())[0];
    check('a restored live package is no longer labelled deleted',
      restored.config.deleted === false && restored.config.id === 10,
      JSON.stringify(restored.config));
    check('restoring does not replace the transaction identity with a renamed live row',
      restored.config.email === row.email && restored.config.label === row.label
        && restored.config.customerName === row.customer_name,
      JSON.stringify(restored.config));
  } finally {
    db.close();
  }
}

console.log('\n── immutable display identity and credential-like imports ──');
{
  const db = makeDb();
  try {
    const row = {
      id: 10, user_id: 7, server_id: 1, inbound_id: 901, email: 'stable@example.test',
      label: 'Name at sale', customer_name: 'Customer at sale',
    };
    const linked = service.capture(row, [row], [{ id: 901, remark: 'Channel at sale', protocol: 'vless', port: 443 }]);
    insertConfig(db, { id: 10, inboundId: 901, email: row.email, subId: 'stable-sub' });
    db.prepare('INSERT INTO inbounds (id, remark, protocol, port) VALUES (901, ?, ?, ?)')
      .run('Channel at sale', 'vless', 443);
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, created_at, config_id, config_snapshot)
      VALUES (7, 'purchase', -100, 1000, 10, ?)
    `).run(linked.snapshot);
    db.prepare('UPDATE configs SET user_id = 99, label = ?, customer_name = ? WHERE id = 10')
      .run('Name today', 'Customer today');
    db.prepare("UPDATE inbounds SET remark = 'Channel today' WHERE id = 901").run();
    const shown = service.presentRows(db, db.prepare('SELECT * FROM transactions').all())[0];
    check('rename, transfer and inbound edits never rewrite the sale-time snapshot',
      shown.config.email === row.email && shown.config.label === row.label
      && shown.config.customerName === row.customer_name && shown.config.inbounds[0].remark === 'Channel at sale'
      && shown.config.deleted === false,
      JSON.stringify(shown.config));

    const rawUuid = '12345678-1234-1234-1234-123456789abc';
    const unsafe = service.capture({
      id: 70, user_id: 7, server_id: 1, inbound_id: 901, email: rawUuid,
      label: 'a'.repeat(32), customer_name: 'Imported customer',
    }, [{
      id: 70, user_id: 7, server_id: 1, inbound_id: 901, email: rawUuid,
      label: 'a'.repeat(32), customer_name: 'Imported customer',
    }], [{ id: 901, remark: 'vless://secret-token@example.test:443', protocol: 'vless', port: 443, node_name: rawUuid }]);
    const unsafeSaved = JSON.parse(unsafe.snapshot);
    check('UUID and subscription-URI identities are suppressed on the server too',
      unsafeSaved.email === '' && unsafeSaved.label === '' && unsafeSaved.customerName === 'Imported customer'
      && unsafeSaved.inbounds[0].remark === '' && unsafeSaved.inbounds[0].nodeName === ''
      && !unsafe.snapshot.includes(rawUuid) && !unsafe.snapshot.includes('secret-token'),
      unsafe.snapshot);
    const unsafeShown = service.present({
      config_id: 70,
      config_email: rawUuid,
      config_label: 'b'.repeat(32),
      config_customer_name: 'Live imported customer',
      config_deleted_at: 0,
      config_snapshot: JSON.stringify({
        email: rawUuid, label: 'c'.repeat(32), customerName: 'Imported customer', serverId: 1,
        inbounds: [{ inboundId: 901, remark: 'vmess://another-secret', nodeName: rawUuid }],
      }),
    });
    check('old or malformed saved display fields are sanitized again on read',
      unsafeShown.config.email === '' && unsafeShown.config.label === '' && unsafeShown.config.inbounds[0].remark === ''
      && !JSON.stringify(unsafeShown).includes(rawUuid) && !JSON.stringify(unsafeShown).includes('another-secret'),
      JSON.stringify(unsafeShown.config));
  } finally {
    db.close();
  }
}

console.log('\n── Trash restore with a new config row id ──');
{
  const db = makeDb();
  try {
    const oldRow = {
      id: 10, user_id: 7, server_id: 1, inbound_id: 901, email: 'new-row@example.test',
      label: 'Historical package', customer_name: 'Historical customer',
    };
    const linked = service.capture(oldRow, [oldRow], [{ id: 901, remark: 'Historical channel', protocol: 'vless', port: 443 }]);
    insertConfig(db, { id: 10, inboundId: 901, email: oldRow.email, subId: 'old-sub', deletedAt: 123 });
    insertConfig(db, { id: 50, userId: 9, inboundId: 901, email: oldRow.email, subId: 'new-sub' });
    insertConfig(db, { id: 51, userId: 9, inboundId: 902, email: oldRow.email, subId: 'new-sub' });
    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, created_at, config_id, config_snapshot)
      VALUES (7, 'renew', -100, 1000, 10, ?)
    `).run(linked.snapshot);
    db.prepare('INSERT INTO config_trash (head_config_id, restored_at) VALUES (10, 0)').run();
    const ledger = () => service.presentRows(db, db.prepare('SELECT * FROM transactions').all())[0];
    check('an unrelated active customer with the same email is not treated as a restore',
      ledger().config.deleted === true && ledger().config.id === 10,
      JSON.stringify(ledger().config));
    db.prepare('UPDATE config_trash SET restored_at = 500 WHERE head_config_id = 10').run();
    check('a proven Trash restore recognises the replacement package and its new row id',
      ledger().configId === 10 && ledger().config.id === 50 && ledger().config.deleted === false
      && ledger().config.email === oldRow.email,
      JSON.stringify(ledger().config));
    insertConfig(db, { id: 60, userId: 10, inboundId: 901, email: oldRow.email, subId: 'different-sub' });
    check('two possible active packages are left ambiguous instead of guessing',
      ledger().config.deleted === true && ledger().config.id === 10,
      JSON.stringify(ledger().config));
    db.prepare('DELETE FROM configs WHERE id = 60').run();
    check('the unique restored package is active even after an ownership hand-over',
      ledger().config.id === 50 && ledger().config.deleted === false,
      JSON.stringify(ledger().config));
  } finally {
    db.close();
  }
}

console.log('\n── conservative legacy recovery ──');
{
  const db = makeDb();
  try {
    db.prepare('INSERT INTO inbounds (id, node_name, remark, protocol, port) VALUES (901, ?, ?, ?, ?)')
      .run('Node A', 'Channel A', 'vless', 443);
    db.prepare('INSERT INTO inbounds (id, node_name, remark, protocol, port) VALUES (902, ?, ?, ?, ?)')
      .run('Node B', 'Channel B', 'vmess', 8443);
    insertConfig(db, { id: 10, userId: 7, inboundId: 901, email: 'legacy-a@example.test', subId: 'sub-a' });
    insertConfig(db, { id: 11, userId: 7, inboundId: 902, email: 'legacy-a-2@example.test', subId: 'sub-a' });
    insertConfig(db, { id: 20, userId: 8, inboundId: 901, email: 'ambiguous-a@example.test' });
    insertConfig(db, { id: 21, userId: 8, inboundId: 902, email: 'ambiguous-b@example.test' });
    const tx = (userId, type, amount, createdAt) => Number(db.prepare(`
      INSERT INTO transactions (user_id, type, amount, created_at) VALUES (?, ?, ?, ?)
    `).run(userId, type, amount, createdAt).lastInsertRowid);
    const audit = (entityId, userId, price, createdAt, extra = {}) => db.prepare(`
      INSERT INTO audit_logs (action, entity, entity_id, details, created_at) VALUES ('config.create', 'config', ?, ?, ?)
    `).run(String(entityId), JSON.stringify({ userId, price, ...extra }), createdAt);

    tx(7, 'purchase', -100, 1000);
    audit('10,11', 7, 100, 1005);
    tx(8, 'purchase', -200, 2000);
    audit('20', 8, 200, 2005);
    audit('21', 8, 200, 2006);
    tx(9, 'renew', -300, 3000);
    tx(10, 'purchase', -400, 4000);
    audit('30', 10, 400, 4005, { charged: false });
    tx(11, 'purchase', -500, 5000);
    audit('31', 11, 500, 40000);
    tx(12, 'purchase', -600, 6000);
    tx(12, 'purchase', -600, 6001);
    audit('32', 12, 600, 6002);
    tx(13, 'purchase', -700, 7000);
    audit('70', 13, 700, 7005);
    tx(14, 'purchase', -800, 8000);
    audit('80', 14, 800, 8005);
    db.prepare(`
      INSERT INTO config_trash (head_config_id, user_id, server_id, email, label, customer_name, rows_json, inbound_ids)
      VALUES (80, 14, 1, ?, ?, ?, ?, '[901]')
    `).run('trashed@example.test', 'Trashed', 'Trashed Customer', JSON.stringify([
      { id: 80, user_id: 14, server_id: 1, inbound_id: 901, email: 'trashed@example.test', label: 'Trashed', customer_name: 'Trashed Customer' },
    ]));

    const recoveryStarted = Date.now();
    const result = service.backfillLegacy(db);
    const recoveryFinished = Date.now();
    check('only exact, unique audit evidence is linked',
      result.linked === 2 && result.ambiguous === 1 && result.unresolved === 7,
      JSON.stringify(result));
    const rows = db.prepare('SELECT * FROM transactions ORDER BY id').all();
    const recoveredAt = JSON.parse(rows[0].config_snapshot).capturedAt;
    check('recovered current state is timestamped as recovery, not as the old sale',
      recoveredAt >= recoveryStarted && recoveredAt <= recoveryFinished && recoveredAt !== rows[0].created_at,
      `recoveredAt=${recoveredAt} soldAt=${rows[0].created_at}`);
    check('a unique old purchase links to the first config of its whole package',
      rows[0].config_id === 10 && JSON.parse(rows[0].config_snapshot).inbounds.length === 2
      && JSON.parse(rows[0].config_snapshot).legacyRecovered === true,
      `id=${rows[0].config_id} snapshot=${rows[0].config_snapshot}`);
    check('ambiguous, free, stale, duplicated and unproven lines stay unlinked',
      rows.slice(1, 7).every((row) => Number(row.config_id) === 0) && rows[7].config_id === 0,
      rows.map((row) => row.config_id).join(','));
    check('Trash evidence can explain a hard-deleted legacy package without inventing credentials',
      rows[8].config_id === 80 && JSON.parse(rows[8].config_snapshot).email === 'trashed@example.test'
      && !/secret-uuid|secret-subscription|09120000000/.test(rows[8].config_snapshot),
      rows[8].config_snapshot);
    check('running recovery again is idempotent and leaves the unproven queue alone',
      JSON.stringify(service.backfillLegacy(db)) === JSON.stringify({ linked: 0, ambiguous: 1, unresolved: 7 }),
      JSON.stringify(service.backfillLegacy(db)));
    db.prepare('DELETE FROM transactions').run();
    check('an empty legacy queue is a clean no-op',
      JSON.stringify(service.backfillLegacy(db)) === JSON.stringify({ linked: 0, ambiguous: 0, unresolved: 0 }),
      JSON.stringify(service.backfillLegacy(db)));
  } finally {
    db.close();
  }
}

console.log(`\ntransactions-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

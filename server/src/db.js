'use strict';

const Database = require('better-sqlite3');
const config = require('./config');

let dbInstance = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reseller',
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  lang TEXT NOT NULL DEFAULT 'fa',
  permissions TEXT NOT NULL DEFAULT '[]',
  max_configs INTEGER NOT NULL DEFAULT 0,
  max_total_gb REAL NOT NULL DEFAULT 0,
  max_gb_per_config REAL NOT NULL DEFAULT 0,
  max_days_per_config INTEGER NOT NULL DEFAULT 0,
  allowed_inbounds TEXT NOT NULL DEFAULT '[]',
  balance INTEGER NOT NULL DEFAULT 0,
  api_key TEXT,
  note TEXT NOT NULL DEFAULT '',
  token_version INTEGER NOT NULL DEFAULT 1,
  last_login_at INTEGER NOT NULL DEFAULT 0,
  last_login_ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key) WHERE api_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS reseller_discounts (
  user_id INTEGER NOT NULL,
  inbound_id INTEGER NOT NULL,
  percent INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, inbound_id)
);

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL DEFAULT '',
  verify_tls INTEGER NOT NULL DEFAULT 0,
  sub_base TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER,
  message TEXT NOT NULL DEFAULT '',
  last_checked_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_servers_enabled ON servers(enabled, sort);

CREATE TABLE IF NOT EXISTS inbounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL DEFAULT 1,
  xui_id INTEGER NOT NULL DEFAULT 0,
  node_id INTEGER NOT NULL DEFAULT 0,
  node_name TEXT NOT NULL DEFAULT '',
  node_address TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 0,
  network TEXT NOT NULL DEFAULT '',
  security TEXT NOT NULL DEFAULT '',
  listen TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  visible INTEGER NOT NULL DEFAULT 1,
  price_fixed INTEGER NOT NULL DEFAULT 0,
  price_per_gb INTEGER NOT NULL DEFAULT 0,
  price_per_day INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  sub_sort_index INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(server_id, xui_id)
);

CREATE TABLE IF NOT EXISTS configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  inbound_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  sub_id TEXT NOT NULL DEFAULT '',
  xui_sub_id TEXT NOT NULL DEFAULT '',
  uuid TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  flow TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  total_bytes INTEGER NOT NULL DEFAULT 0,
  expiry_at INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  sync_status TEXT NOT NULL DEFAULT '',
  up_bytes INTEGER NOT NULL DEFAULT 0,
  down_bytes INTEGER NOT NULL DEFAULT 0,
  last_up INTEGER NOT NULL DEFAULT 0,
  last_down INTEGER NOT NULL DEFAULT 0,
  last_online_at INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_configs_user ON configs(user_id);
CREATE INDEX IF NOT EXISTS idx_configs_inbound ON configs(inbound_id);
CREATE INDEX IF NOT EXISTS idx_configs_status ON configs(status);
CREATE INDEX IF NOT EXISTS idx_configs_sub ON configs(sub_id);
-- Panel v1.4.17: one x-ui client can be attached to several inbounds at the same
-- time (that is exactly how a seller panel builds a multi-inbound subscription),
-- so the email alone is no longer unique - a customer is the pair
-- (email, inbound_id). The old UNIQUE(email) made the importer keep only the
-- FIRST inbound of such a client and silently drop the rest.
CREATE UNIQUE INDEX IF NOT EXISTS idx_configs_email_inbound ON configs(email, inbound_id);

CREATE TABLE IF NOT EXISTS usage_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  up_bytes INTEGER NOT NULL DEFAULT 0,
  down_bytes INTEGER NOT NULL DEFAULT 0,
  UNIQUE(config_id, day)
);
CREATE INDEX IF NOT EXISTS idx_usage_user_day ON usage_daily(user_id, day);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  last_reply_by TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, updated_at);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  is_staff INTEGER NOT NULL DEFAULT 0,
  read_by_admin INTEGER NOT NULL DEFAULT 0,
  read_by_user INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages ON ticket_messages(ticket_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'system',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  read_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all',
  recipients INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}',
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);

CREATE TABLE IF NOT EXISTS server_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unknown',
  latency_ms INTEGER,
  message TEXT NOT NULL DEFAULT '',
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_status ON server_status(kind, ref_id, checked_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL DEFAULT 0,
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
`;

function ensureColumn(db, table, column, ddl) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function migrate(db) {
  // Panel v1.1.5: inbound display order follows the x-ui subscription order.
  ensureColumn(db, 'inbounds', 'sub_sort_index', 'INTEGER NOT NULL DEFAULT 0');
  // Panel v1.3.0: several x-ui panels ("servers") behind one dashboard. The
  // inbound primary key becomes panel-wide, with the original x-ui id kept in
  // `xui_id`; existing rows map 1:1 so configs keep their references.
  rebuildInbounds(db);
  ensureColumn(db, 'configs', 'server_id', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'server_status', 'server_id', 'INTEGER NOT NULL DEFAULT 1');
  db.exec('CREATE INDEX IF NOT EXISTS idx_inbounds_server ON inbounds(server_id, sub_sort_index, id)');
  // Panel v1.4.0: x-ui 3.2.5+ rejects a subId shared by two clients, so the
  // subscription id stored on the x-ui client (`xui_sub_id`) is unique per
  // config while `sub_id` remains the customer group token. Existing rows
  // used one shared value; map it over so their sub links keep working.
  ensureColumn(db, 'configs', 'xui_sub_id', "TEXT NOT NULL DEFAULT ''");
  db.prepare("UPDATE configs SET xui_sub_id = sub_id WHERE xui_sub_id = '' AND sub_id <> ''").run();
  // Panel v1.4.9: a reseller can carry their numeric Telegram id. It names new
  // x-ui clients ("<id>-<random>") and lets the panel adopt subscriptions that
  // already exist on a server under that id. Empty values stay unlimited.
  ensureColumn(db, 'users', 'telegram_id', "TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id) WHERE telegram_id <> '' AND deleted_at = 0");
  // Panel v1.4.10: each reseller decides whether subscriptions that already
  // exist on the panels under their Telegram id are pulled into their list.
  // Turning it off only hides those rows; the clients stay untouched in x-ui.
  ensureColumn(db, 'users', 'import_configs', 'INTEGER NOT NULL DEFAULT 1');
  // `origin` records who WROTE the row: this panel or the adoption pass that pulled
  // an existing subscription out of a seller's x-ui panel. It is a per-row fact, not
  // a per-client one — since v1.4.18 a channel added to an adopted customer joins his
  // existing client but stays a row of ours ('panel'), which is what lets removing it
  // undo our own write instead of deleting something on the seller's panel.
  ensureColumn(db, 'configs', 'origin', "TEXT NOT NULL DEFAULT 'panel'");
  // Panel v1.4.16: every reseller can name one FIXED inbound. It is the base of
  // a package — pre-selected when a config is created and never removable — so a
  // package can never end up with zero inbounds and a customer can never be left
  // without a subscription by removing the wrong inbound.
  ensureColumn(db, 'users', 'fixed_inbound', 'INTEGER NOT NULL DEFAULT 0');
  // Panel v1.4.17: the old column-level UNIQUE(email) is replaced by
  // UNIQUE(email, inbound_id). See rebuildConfigs().
  rebuildConfigs(db);
}

/**
 * `configs.email` was declared UNIQUE when the panel assumed one row per x-ui
 * client. A client adopted out of an existing panel is routinely attached to
 * several inbounds at once, and that is exactly what the importer has to record,
 * so the constraint moves to the pair (email, inbound_id).
 *
 * SQLite cannot drop a column-level UNIQUE, so the table is rebuilt in place:
 * the definition is regenerated from the live column list (which is already the
 * final one because every ensureColumn() ran first), all rows are copied with
 * their original ids, the secondary indexes are recreated and the new unique
 * index is added. Nothing references configs by id, so the ids staying stable
 * also keeps usage_daily and every stored link valid.
 */
function rebuildConfigs(db) {
  const info = db.prepare('PRAGMA index_list(configs)').all();
  const uniqueEmailOnly = info.some((idx) => {
    if (Number(idx.unique) !== 1) return false;
    if (idx.origin !== 'u' && idx.origin !== 1) return false;
    const cols = db.prepare(`PRAGMA index_info('${idx.name}')`).all().map((c) => c.name);
    return cols.length === 1 && cols[0] === 'email';
  });
  if (!uniqueEmailOnly) return;

  const columns = db.prepare('PRAGMA table_info(configs)').all();
  const names = columns.map((col) => col.name);
  const defs = columns.map((col) => {
    let def = `"${col.name}" ${col.type || 'TEXT'}`;
    if (Number(col.pk) === 1) def += ' PRIMARY KEY AUTOINCREMENT';
    else if (Number(col.notnull) === 1) def += ' NOT NULL';
    if (col.dflt_value !== null && col.dflt_value !== undefined) def += ` DEFAULT ${col.dflt_value}`;
    return def;
  });
  // sqlite_master carries the CREATE statement of every explicit index; the
  // automatic ones (the UNIQUE constraint being removed, the primary key) have
  // no SQL and are rebuilt by the table definition itself. idx_configs_email_inbound
  // is created explicitly below, so it is not replayed here.
  const otherIndexes = db.prepare(
    `SELECT sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'configs' AND sql IS NOT NULL
        AND name <> 'idx_configs_email_inbound'`
  ).all().map((row) => row.sql);

  const before = Number(db.prepare('SELECT COUNT(*) AS c FROM configs').get().c);
  const tx = db.transaction(() => {
    const colList = names.map((name) => `"${name}"`).join(', ');
    db.exec(`CREATE TABLE configs_new (\n  ${defs.join(',\n  ')}\n)`);
    db.exec(`INSERT INTO configs_new (${colList}) SELECT ${colList} FROM configs`);
    db.exec('DROP TABLE configs');
    db.exec('ALTER TABLE configs_new RENAME TO configs');
    for (const sql of otherIndexes) db.exec(sql);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_configs_email_inbound ON configs(email, inbound_id)');
  });
  tx();

  const after = Number(db.prepare('SELECT COUNT(*) AS c FROM configs').get().c);
  if (after !== before) {
    throw new Error(`[db] configs rebuild changed the row count (${before} -> ${after})`);
  }
  const bad = db.prepare('PRAGMA integrity_check').get();
  if (String(Object.values(bad || {})[0]) !== 'ok') {
    throw new Error(`[db] configs rebuild left the database unhealthy: ${JSON.stringify(bad)}`);
  }
  console.log(`[db] configs rebuilt without UNIQUE(email): ${after} rows, ids preserved`);
}

function rebuildInbounds(db) {
  const columns = db.prepare('PRAGMA table_info(inbounds)').all().map((row) => row.name);
  if (columns.includes('xui_id')) return;
  const tx = db.transaction(() => {
    db.exec(`CREATE TABLE inbounds_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL DEFAULT 1,
      xui_id INTEGER NOT NULL DEFAULT 0,
      node_id INTEGER NOT NULL DEFAULT 0,
      node_name TEXT NOT NULL DEFAULT '',
      node_address TEXT NOT NULL DEFAULT '',
      remark TEXT NOT NULL DEFAULT '',
      protocol TEXT NOT NULL DEFAULT '',
      tag TEXT NOT NULL DEFAULT '',
      port INTEGER NOT NULL DEFAULT 0,
      network TEXT NOT NULL DEFAULT '',
      security TEXT NOT NULL DEFAULT '',
      listen TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      visible INTEGER NOT NULL DEFAULT 1,
      price_fixed INTEGER NOT NULL DEFAULT 0,
      price_per_gb INTEGER NOT NULL DEFAULT 0,
      price_per_day INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0,
      sub_sort_index INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(server_id, xui_id)
    )`);
    db.exec(`INSERT INTO inbounds_new (id, server_id, xui_id, node_id, node_name, node_address, remark,
        protocol, tag, port, network, security, listen, enabled, visible, price_fixed, price_per_gb,
        price_per_day, sort, sub_sort_index, updated_at)
      SELECT id, 1, id, node_id, node_name, node_address, remark,
        protocol, tag, port, network, security, listen, enabled, visible, price_fixed, price_per_gb,
        price_per_day, sort, sub_sort_index, updated_at
      FROM inbounds`);
    db.exec('DROP TABLE inbounds');
    db.exec('ALTER TABLE inbounds_new RENAME TO inbounds');
  });
  tx();
  console.log('[db] inbounds migrated for multi-server support');
}

function getDb() {
  if (dbInstance) return dbInstance;
  dbInstance = new Database(config.dbPath);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('synchronous = NORMAL');
  dbInstance.pragma('busy_timeout = 8000');
  dbInstance.pragma('foreign_keys = ON');
  dbInstance.exec(SCHEMA);
  migrate(dbInstance);
  return dbInstance;
}

function closeDb() {
  if (!dbInstance) return;
  try { dbInstance.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  try { dbInstance.close(); } catch (_) {}
  dbInstance = null;
}

module.exports = { getDb, closeDb };

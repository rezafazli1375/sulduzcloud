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
  email TEXT NOT NULL UNIQUE,
  sub_id TEXT NOT NULL DEFAULT '',
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

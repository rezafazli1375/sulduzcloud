'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc240-migration-'));
const dbPath = path.join(dir, 'panel.db');
process.env.DATA_DIR = dir;
process.env.BACKUP_DIR = path.join(dir, 'backups');
process.env.DB_PATH = dbPath;
process.env.NODE_ENV = 'test';

let db;
try {
  // The v2.3.0 table, before either v2.4.0 column existed. getDb() runs SCHEMA
  // before migrate(), which is exactly where a premature config index used to
  // make an otherwise valid upgrade crash.
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    INSERT INTO transactions (user_id, type, amount, balance_after, description, created_by, created_at)
    VALUES (7, 'credit', 1000, 1000, 'kept exactly', 0, 123456);
  `);
  db.close();
  db = null;

  const panelDb = require('../src/db');
  db = panelDb.getDb();
  const columns = db.prepare('PRAGMA table_info(transactions)').all().map((row) => row.name);
  assert(columns.includes('config_id'), 'config_id was not added');
  assert(columns.includes('config_snapshot'), 'config_snapshot was not added');
  const row = db.prepare('SELECT * FROM transactions WHERE id = 1').get();
  assert.equal(row.user_id, 7);
  assert.equal(row.type, 'credit');
  assert.equal(row.amount, 1000);
  assert.equal(row.balance_after, 1000);
  assert.equal(row.description, 'kept exactly');
  assert.equal(row.created_at, 123456);
  assert.equal(row.config_id, 0);
  assert.equal(row.config_snapshot, '');
  const index = db.prepare("PRAGMA index_info('idx_transactions_config')").all().map((item) => item.name);
  assert.deepEqual(index, ['config_id', 'created_at']);
  console.log('migration240-test: old wallet preserved, columns added, index created after migration');
} finally {
  if (db) panelDbClose();
  fs.rmSync(dir, { recursive: true, force: true });
}

function panelDbClose() {
  try { require('../src/db').closeDb(); } catch (_) {}
}

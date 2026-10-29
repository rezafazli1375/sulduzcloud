'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb, closeDb } = require('../db');
const { getSetting } = require('../settings');
const { ApiError } = require('../utils');
const { audit } = require('../audit');
const { pendingPath, markerPath } = require('../restore');

const NAME_RE = /^[A-Za-z0-9._-]+\.db$/;

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function createBackup(reason = 'manual', req) {
  const db = getDb();
  const name = `panel-${stamp()}${reason === 'auto' ? '-auto' : ''}.db`;
  const target = path.join(config.backupDir, name);
  await db.backup(target);
  pruneBackups();
  audit(req, 'backup.create', 'backup', name, { reason });
  return { name, size: fs.statSync(target).size, createdAt: Date.now() };
}

function listBackups() {
  if (!fs.existsSync(config.backupDir)) return [];
  return fs
    .readdirSync(config.backupDir)
    .filter((name) => NAME_RE.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(config.backupDir, name));
      return { name, size: stat.size, createdAt: stat.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function pruneBackups() {
  const keep = Math.max(1, Number(getSetting('backup').keep || 14));
  const files = listBackups();
  const autoFiles = files.filter((f) => f.name.includes('-auto'));
  const manualFiles = files.filter((f) => !f.name.includes('-auto'));
  const remove = [];
  // Keep the newest `keep` automatic backups, never delete manual ones.
  for (const file of autoFiles.slice(keep)) remove.push(file.name);
  // Keep at most 50 manual snapshots to bound disk usage.
  for (const file of manualFiles.slice(50)) remove.push(file.name);
  for (const name of remove) {
    try { fs.unlinkSync(path.join(config.backupDir, name)); } catch (_) {}
  }
  return remove.length;
}

function backupPath(name) {
  if (!NAME_RE.test(String(name || ''))) throw new ApiError(400, 'invalid_name', 'Invalid backup name');
  const full = path.join(config.backupDir, name);
  if (!full.startsWith(path.resolve(config.backupDir))) throw new ApiError(400, 'invalid_name', 'Invalid backup path');
  if (!fs.existsSync(full)) throw new ApiError(404, 'not_found', 'Backup file not found');
  return full;
}

function deleteBackup(name, req) {
  const full = backupPath(name);
  fs.unlinkSync(full);
  audit(req, 'backup.delete', 'backup', name, {});
  return { ok: true };
}

function validateDatabase(file) {
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    for (const required of ['users', 'configs', 'settings', 'inbounds']) {
      if (!tables.includes(required)) throw new ApiError(422, 'invalid_backup', `Backup is missing the ${required} table`);
    }
    const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    return { tables: tables.length, users: Number(users) };
  } finally {
    db.close();
  }
}

function stageRestore(tempFile, req) {
  validateDatabase(tempFile);
  fs.copyFileSync(tempFile, pendingPath());
  fs.writeFileSync(
    markerPath(),
    JSON.stringify({ requestedAt: Date.now(), by: req?.user?.id || 0, name: path.basename(tempFile) }, null, 2)
  );
  audit(req, 'backup.restore_staged', 'backup', path.basename(tempFile), {});
  return { ok: true, restart: true };
}

function applyRestoreNow() {
  closeDb();
}

function autoBackupEnabled() {
  return Boolean(getSetting('backup').auto);
}

// Schedule exposed to the panel. Times are wall-clock times in the panel
// timezone (settings → general), which is what the owner configures.
function scheduleInfo() {
  const cfg = getSetting('backup');
  const timezone = getSetting('general').timezone || 'UTC';
  return {
    auto: Boolean(cfg.auto),
    hour: Number(cfg.hour ?? 3),
    minute: Number(cfg.minute ?? 30),
    keep: Math.max(1, Number(cfg.keep || 14)),
    timezone,
  };
}

module.exports = {
  createBackup,
  listBackups,
  pruneBackups,
  backupPath,
  deleteBackup,
  validateDatabase,
  stageRestore,
  applyRestoreNow,
  autoBackupEnabled,
  scheduleInfo,
};

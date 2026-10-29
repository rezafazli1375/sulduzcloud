'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

function pendingPath() {
  return path.join(config.dataDir, 'restore.pending');
}

function markerPath() {
  return path.join(config.dataDir, 'restore.pending.json');
}

// Must run before the database is opened.
function applyPendingRestore() {
  const pending = pendingPath();
  if (!fs.existsSync(pending)) return false;
  try {
    fs.mkdirSync(config.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (fs.existsSync(config.dbPath)) {
      fs.copyFileSync(config.dbPath, path.join(config.backupDir, `pre-restore-${stamp}.db`));
    }
    for (const suffix of ['-wal', '-shm']) {
      const file = `${config.dbPath}${suffix}`;
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.copyFileSync(pending, config.dbPath);
    fs.unlinkSync(pending);
    if (fs.existsSync(markerPath())) fs.unlinkSync(markerPath());
    console.log('[restore] pending database restore applied successfully');
    return true;
  } catch (err) {
    console.error('[restore] failed to apply pending restore:', err.message);
    return false;
  }
}

module.exports = { applyPendingRestore, pendingPath, markerPath };

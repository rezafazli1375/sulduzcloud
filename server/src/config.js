'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile(file) {
  try {
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (err) {
    console.error('[config] unable to read env file:', err.message);
  }
}

loadEnvFile(path.join(ROOT, '.env'));

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(ROOT, 'backups');

function ensureDir(dir, mode = 0o750) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode });
  return dir;
}

ensureDir(DATA_DIR, 0o750);
ensureDir(BACKUP_DIR, 0o750);

function loadRuntimeSecrets() {
  const file = path.join(DATA_DIR, 'runtime-secrets.json');
  let data = {};
  try {
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (err) {
    console.error('[config] unable to read runtime secrets:', err.message);
  }
  let changed = false;
  if (!data.jwtSecret) {
    data.jwtSecret = crypto.randomBytes(48).toString('hex');
    changed = true;
  }
  if (!data.encryptionKey) {
    data.encryptionKey = crypto.randomBytes(32).toString('hex');
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (_) {}
  }
  return data;
}

const runtimeSecrets = loadRuntimeSecrets();

// Written by install.sh / the SSH menu. Empty means "unknown": cookies stay
// non-secure until a public HTTPS address is configured.
const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  backupDir: BACKUP_DIR,
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'panel.db'),
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3100),
  nodeEnv: process.env.NODE_ENV || 'production',
  isProduction: (process.env.NODE_ENV || 'production') === 'production',
  publicUrl,
  cookieSecure: publicUrl.startsWith('https://'),
  jwtSecret: process.env.JWT_SECRET || runtimeSecrets.jwtSecret,
  encryptionKey: process.env.ENCRYPTION_KEY || runtimeSecrets.encryptionKey,
  xuiUrl: process.env.XUI_URL || 'http://127.0.0.1:2053',
  xuiTokenFile: process.env.XUI_TOKEN_FILE || path.join(DATA_DIR, 'secrets', 'xui-token'),
  timezone: process.env.PANEL_TZ || 'Asia/Tehran',
  webDist: process.env.WEB_DIST || path.resolve(ROOT, '..', 'web', 'dist'),
  version: '1.3.6',
  sessionDaysDefault: 7,
};

try {
  process.env.TZ = config.timezone;
} catch (_) {}

module.exports = config;

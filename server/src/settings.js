'use strict';

const fs = require('fs');
const config = require('./config');
const { getDb } = require('./db');
const { encryptSecret, decryptSecret, isEncrypted, maskSecret } = require('./crypto');
const { safeJsonParse } = require('./utils');

const SECRET_FIELDS = {
  xui: ['token'],
  smtp: ['pass'],
  sms: ['apiKey'],
  telegram: ['botToken'],
};

const DEFAULTS = {
  general: {
    panelName: 'Sulduz Cloud',
    tagline: 'پنل مدیریت نمایندگی‌های سرویس',
    description: 'سیستم مدیریت کانفیگ و نمایندگی',
    supportUrl: '',
    website: '',
    telegram: '',
    defaultLang: 'fa',
    timezone: 'Asia/Tehran',
  },
  xui: {
    url: config.xuiUrl,
    token: '',
    verifyTls: false,
    subBase: '',
  },
  monitor: {
    enabled: true,
    intervalSec: 120,
    failureThreshold: 2,
    alertEmail: true,
    alertSms: true,
    expiryAlerts: true,
    expiryDays: [3, 1],
    trafficAlertPercent: 90,
    retentionDays: 30,
  },
  smtp: {
    enabled: false,
    host: '',
    port: 587,
    secure: false,
    user: '',
    pass: '',
    from: '',
    to: '',
  },
  sms: {
    enabled: false,
    provider: 'kavenegar',
    // 'pattern' sends a pre-approved template (delivered without operator
    // review); 'text' sends free text, which Kavenegar/FarazSMS may hold for
    // manual approval.
    mode: 'pattern',
    apiKey: '',
    sender: '',
    to: '',
    pattern: '',
    patternVar1: '{title}',
    patternVar2: '{body}',
    patternVar3: '',
    customUrl: '',
    customMethod: 'POST',
    customHeaders: '',
    customBody: '{"to":"{to}","text":"{text}"}',
  },
  billing: {
    enabled: false,
    currency: 'تومان',
  },
  backup: {
    auto: true,
    hour: 3,
    minute: 30,
    keep: 14,
  },
  telegram: {
    enabled: false,
    botToken: '',
    chatId: '',
    sendOnAuto: true,
  },
  security: {
    sessionDays: 7,
    loginRateLimit: 10,
  },
};

function extractToken(raw) {
  if (!raw) return '';
  const text = String(raw).replace(/\r/g, '').trim();
  if (!text) return '';
  const explicit = text.match(/apiToken:\s*([A-Za-z0-9_-]{20,})/);
  if (explicit) return explicit[1];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^[A-Za-z0-9_-]{24,}$/.test(lines[i])) return lines[i];
    const match = lines[i].match(/[A-Za-z0-9_-]{32,}/);
    if (match) return match[0];
  }
  return '';
}

function rawGet(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function rawSet(key, obj) {
  const db = getDb();
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, JSON.stringify(obj), Date.now());
}

function decryptSection(key, obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const field of SECRET_FIELDS[key] || []) {
    if (out[field]) out[field] = decryptSecret(out[field]);
  }
  return out;
}

function encryptSection(key, obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const field of SECRET_FIELDS[key] || []) {
    if (out[field] !== undefined && out[field] !== null && out[field] !== '') {
      out[field] = encryptSecret(out[field]);
    }
  }
  return out;
}

function getSetting(key) {
  if (!(key in DEFAULTS)) return {};
  const raw = rawGet(key);
  const parsed = raw ? safeJsonParse(raw, {}) : {};
  return { ...structuredCloneSafe(DEFAULTS[key]), ...decryptSection(key, parsed) };
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function setSetting(key, obj) {
  const current = getSetting(key);
  const next = { ...current, ...(obj || {}) };
  rawSet(key, encryptSection(key, next));
  return getSetting(key);
}

function updateSection(key, patch, { keepSecrets = true } = {}) {
  const current = getSetting(key);
  const next = { ...current };
  for (const [field, value] of Object.entries(patch || {})) {
    if (!(field in DEFAULTS[key])) continue;
    const secret = (SECRET_FIELDS[key] || []).includes(field);
    if (secret && keepSecrets && (value === undefined || value === null || value === '' || value === maskSecret())) {
      continue;
    }
    next[field] = value;
  }
  rawSet(key, encryptSection(key, next));
  return getSetting(key);
}

function redactSection(key, obj) {
  if (!obj) return obj;
  const out = { ...obj };
  for (const field of SECRET_FIELDS[key] || []) {
    const has = Boolean(out[field]);
    out[field] = '';
    out[`has${field.charAt(0).toUpperCase()}${field.slice(1)}`] = has;
  }
  return out;
}

function ensureDefaults() {
  const db = getDb();
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [key, value] of Object.entries(DEFAULTS)) {
    insert.run(key, JSON.stringify(value), Date.now());
  }

  // Seed the x-ui token from the protected file on first run.
  const xui = getSetting('xui');
  if (!xui.token) {
    try {
      if (fs.existsSync(config.xuiTokenFile)) {
        const token = extractToken(fs.readFileSync(config.xuiTokenFile, 'utf8'));
        if (token) {
          updateSection('xui', { token, url: xui.url || config.xuiUrl }, { keepSecrets: false });
          console.log('[settings] x-ui API token seeded from protected file');
        }
      }
    } catch (err) {
      console.error('[settings] unable to seed x-ui token:', err.message);
    }
  }

  // Migrate any plaintext secrets that were inserted before encryption.
  for (const [key, fields] of Object.entries(SECRET_FIELDS)) {
    const raw = rawGet(key);
    if (!raw) continue;
    const parsed = safeJsonParse(raw, {});
    let changed = false;
    for (const field of fields) {
      if (parsed[field] && !isEncrypted(parsed[field])) {
        parsed[field] = encryptSecret(parsed[field]);
        changed = true;
      }
    }
    if (changed) rawSet(key, parsed);
  }
}

function publicMeta() {
  const general = getSetting('general');
  const billing = getSetting('billing');
  const db = getDb();
  const users = db.prepare('SELECT COUNT(*) AS c FROM users WHERE deleted_at = 0').get();
  return {
    panelName: general.panelName,
    tagline: general.tagline,
    description: general.description,
    supportUrl: general.supportUrl,
    website: general.website,
    telegram: general.telegram,
    defaultLang: general.defaultLang,
    timezone: general.timezone,
    billing: { enabled: Boolean(billing.enabled), currency: billing.currency },
    version: config.version,
    setupRequired: Number(users.c || 0) === 0,
  };
}

function allRedacted() {
  return {
    general: redactSection('general', getSetting('general')),
    xui: redactSection('xui', getSetting('xui')),
    monitor: redactSection('monitor', getSetting('monitor')),
    smtp: redactSection('smtp', getSetting('smtp')),
    sms: redactSection('sms', getSetting('sms')),
    billing: redactSection('billing', getSetting('billing')),
    backup: redactSection('backup', getSetting('backup')),
    telegram: redactSection('telegram', getSetting('telegram')),
    security: redactSection('security', getSetting('security')),
  };
}

module.exports = {
  DEFAULTS,
  SECRET_FIELDS,
  extractToken,
  ensureDefaults,
  getSetting,
  setSetting,
  updateSection,
  redactSection,
  publicMeta,
  allRedacted,
};

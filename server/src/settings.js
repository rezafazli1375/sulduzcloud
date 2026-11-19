'use strict';

const fs = require('fs');
const config = require('./config');
const brand = require('./brand');
const { getDb } = require('./db');
const { encryptSecret, decryptSecret, isEncrypted, maskSecret } = require('./crypto');
const { safeJsonParse } = require('./utils');

const SECRET_FIELDS = {
  xui: ['token'],
  smtp: ['pass'],
  sms: ['apiKey'],
  telegram: ['botToken'],
  // A ZarinPal merchant id is a credential of the owner's own money account. It is
  // stored encrypted and handed back to the admin form masked, exactly like the bot
  // token. (v1.5.5 dropped `blueLink` with the بلو gateway itself.)
  payment: ['zarinpalMerchantId'],
};

// v1.5.4: fields the panel refuses to change, whoever asks. The brand name is the
// one thing the owner wants identical on every install of this software, so it is
// a constant in src/brand.js rather than a setting — and it is stripped from every
// write, so even a direct API call cannot rename the panel.
const LOCKED_FIELDS = {
  general: ['panelName'],
};

function isLocked(section, field) {
  return (LOCKED_FIELDS[section] || []).includes(field);
}

// v1.4.13 removed the SMS pattern/template feature. These keys can still be
// present in a settings row written by an older panel; they are dropped on read
// and rewritten once on boot so nothing pattern-shaped survives the upgrade.
const LEGACY_SMS_KEYS = ['mode', 'pattern', 'patternVar1', 'patternVar2', 'patternVar3', 'patternNames', 'patterns'];

// v1.5.5 removed two payment methods the owner decided he does not want: the بلو
// prepared link and card-to-card (a receipt is still paid into one of his cards, he
// just does not want "card to card" offered as a separate thing). The keys can still
// sit in a `payment` row written by 1.5.4 — including an encrypted بلو link nobody
// can reach any more — so they are dropped on read and rewritten on the next save,
// the same way the removed SMS patterns were handled in v1.4.13.
const RETIRED_PAYMENT_KEYS = ['blueEnabled', 'blueLink', 'blueLabel', 'autoApproveCard'];

const DEFAULTS = {
  general: {
    // Not editable: src/brand.js answers this one (v1.5.4).
    panelName: brand.PANEL_NAME,
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
    apiKey: '',
    sender: '',
    to: '',
    // Per-notification SMS switches. Every alert is sent as the panel's own
    // text message; `enabled: false` mutes only the SMS channel for that
    // notification (the in-panel and email channels stay active).
    events: {
      nodeOffline: { enabled: true },
      nodeOnline: { enabled: true },
      panelOffline: { enabled: true },
      panelOnline: { enabled: true },
      test: { enabled: true },
    },
    customUrl: '',
    customMethod: 'POST',
    customHeaders: '',
    customBody: '{"to":"{to}","text":"{text}"}',
  },
  billing: {
    enabled: false,
    currency: 'تومان',
    // v1.5.4: پورسانت — the share of what one reseller pays that goes to the
    // reseller who brought him. 0 keeps the whole feature off; a reseller may
    // carry his own percentage (users.commission_percent), which wins here.
    commissionPercent: 0,
    commissionCapPercent: 50,
  },
  // How a reseller puts money into his wallet. Since v1.5.5 there are two ways, and
  // each one has its own switch so the owner can offer either, both, or neither:
  //
  //   receiptEnabled  — فیش واریزی: the reseller pays into one of `cards` and sends
  //                     the receipt (from the panel or from the bot) for approval;
  //   cards           — the owner's card numbers for those receipts, up to MAX_CARDS.
  //                     The bot reads them out to the reseller (v1.5.5) so he knows
  //                     which number to pay into. A card number is not a secret —
  //                     it is what money is sent TO — so it is stored plainly;
  //   zarinpal*       — the ZarinPal REST API v4 (request → StartPay → callback →
  //                     verify). The merchant id is a credential;
  //   autoApprove*    — the scheduled release of pending receipts, topups.js.
  payment: {
    cards: [],
    receiptEnabled: true,
    zarinpalEnabled: false,
    zarinpalMerchantId: '',
    zarinpalSandbox: false,
    autoApproveEnabled: false,
    autoApproveReceipt: true,
    autoApproveAfterMinutes: 15,
    autoApproveMaxAmount: 0,
    autoApproveDailyLimit: 0,
    autoApproveIntervalMinutes: 1,
  },
  backup: {
    auto: true,
    hour: 3,
    minute: 30,
    keep: 14,
  },
  // v2.0.0: scheduled removal of finished subscriptions. Off by default — an
  // upgrade must never start deleting anyone's customers by itself. The sweep
  // (services/cleanup.js) runs every `intervalHours` while `enabled`, and only
  // touches packages that have been expired / fully used for `graceDays` days,
  // so a customer who renews within the grace window keeps his subscription.
  //
  //   expired / depleted   — which finished states are swept at all;
  //   graceDays            — days a package must have STAYED finished. Expiry
  //                          counts from expiry_at; depletion from the moment
  //                          the sweep first saw it full (configs.depleted_at);
  //   includeExternal      — adopted packages (origin='external') belong to a
  //                          client on ANOTHER operator's panel. Off means they
  //                          are never swept; on means their rows are forgotten
  //                          here (deletePackage never deletes remotely anyway);
  //   notifyReseller       — the in-panel «اشتراک حذف شد» notice per deletion;
  //   maxPerRun            — ceiling per sweep, so one tick cannot wipe a fleet;
  //   lastRunAt/lastSummary— written by the sweep itself, read by the settings
  //                          tab. Not user-editable through the form guards.
  cleanup: {
    enabled: false,
    expired: true,
    depleted: true,
    graceDays: 7,
    intervalHours: 6,
    includeExternal: false,
    notifyReseller: true,
    maxPerRun: 50,
    lastRunAt: 0,
    lastSummary: '',
  },
  telegram: {
    enabled: false,
    botToken: '',
    chatId: '',
    sendOnAuto: true,
    // v1.5.2: the same bot becomes two-way. A reseller whose numeric Telegram id
    // is on his account can read his balance and his numbers, and send a payment
    // receipt that the admin approves with one tap. `botAdminChatId` is where the
    // receipts go; empty means the panel chat above.
    botEnabled: true,
    botAdminChatId: '',
    // Nightly report. The hour/minute are wall-clock times in the timezone the
    // traffic ledger itself is bucketed by (PANEL_TZ, Asia/Tehran by default), so
    // "today" in the message is the same day the dashboard chart calls today.
    dailyReportEnabled: false,
    dailyReportHour: 23,
    dailyReportMinute: 0,
    dailyReportResellers: true,
    dailyReportOwner: true,
    // How far ahead "نزدیک به اتمام" looks, in days.
    dailyReportDaysAhead: 3,
  },
  security: {
    sessionDays: 7,
    loginRateLimit: 10,
  },
};

// The owner can publish several of his own card numbers. Since v1.5.5 they belong to
// one thing only — فیش واریزی — and they answer two questions: which number does a
// reseller pay into (the bot reads this list out, services/bot.js) and which one did
// he actually use (topup_requests.card_number). A card number is not a secret (it is
// what money is sent TO), so it is stored plainly and handed to the reseller panel
// as it is.
const MAX_CARDS = 12;

function normalizeCards(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const number = String(entry.number || '').replace(/[\s-]/g, '');
    if (!/^\d{10,24}$/.test(number)) continue;
    if (out.some((card) => card.number === number)) continue;
    out.push({
      holder: String(entry.holder || '').trim().slice(0, 60),
      number,
      bank: String(entry.bank || '').trim().slice(0, 40),
      note: String(entry.note || '').trim().slice(0, 120),
    });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}

// The retired payment keys are dropped everywhere the section is read or written, so
// a row saved by 1.5.4 cannot hand a بلو link back to any consumer, and the next
// save of that tab rewrites the row without them.
function prunePaymentKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const field of RETIRED_PAYMENT_KEYS) delete out[field];
  return out;
}

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
  const merged = { ...structuredCloneSafe(DEFAULTS[key]), ...decryptSection(key, parsed) };
  // The brand name is code, not data (v1.5.4): whatever an old row says, the
  // panel is called what src/brand.js says. Doing it on read means a database
  // written by an earlier version — or edited by hand — cannot rename the panel
  // either, and every consumer (meta, bot footer, reports, SMS) agrees.
  if (key === 'general') merged.panelName = brand.PANEL_NAME;
  if (key === 'payment') {
    merged.cards = normalizeCards(merged.cards);
    // بلو and card-to-card are gone (v1.5.5): never surface their retired keys.
    return prunePaymentKeys(merged);
  }
  if (key !== 'sms') return merged;

  // Per-event merge so an event added in a later version never wipes the
  // owner's saved switches.
  const stored = merged.events && typeof merged.events === 'object' ? merged.events : {};
  const events = {};
  for (const [event, defaults] of Object.entries(DEFAULTS.sms.events)) {
    events[event] = { ...structuredCloneSafe(defaults), ...(stored[event] || {}) };
  }
  for (const [event, value] of Object.entries(stored)) {
    if (!events[event] && value && typeof value === 'object') events[event] = { enabled: value.enabled !== false };
  }
  merged.events = events;
  // Pattern settings are gone: never surface legacy keys to the API or the UI.
  for (const legacy of LEGACY_SMS_KEYS) delete merged[legacy];
  return merged;
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function setSetting(key, obj) {
  const current = getSetting(key);
  const next = { ...current, ...(obj || {}) };
  for (const field of LOCKED_FIELDS[key] || []) next[field] = current[field];
  rawSet(key, encryptSection(key, key === 'payment' ? prunePaymentKeys(next) : next));
  return getSetting(key);
}

/**
 * The one rule for a secret field a settings form has handed back.
 *
 * Secrets never leave the panel in the clear (see redactSection), so the admin
 * form shows an empty box with "saved — leaving this empty keeps what is stored"
 * under it. That means an empty — or all-bullets — submission is "I did not touch
 * this field", not "erase it". updateSection below and every guard that reads the
 * payment section before saving have to use this one rule, or the two disagree and
 * a real credential makes the tab unsavable: the guard would see the form's own
 * blank merchant id and answer "gateway on, no credentials" forever.
 */
function isUnchangedSecret(key, field, value) {
  if (!(SECRET_FIELDS[key] || []).includes(field)) return false;
  if (value === undefined || value === null) return true;
  const text = String(value).trim();
  return text === '' || text === maskSecret() || /^\u2022+$/.test(text);
}

function updateSection(key, patch, { keepSecrets = true } = {}) {
  const current = getSetting(key);
  const next = { ...current };
  for (const [field, value] of Object.entries(patch || {})) {
    if (!(field in DEFAULTS[key])) continue;
    if (isLocked(key, field)) continue;
    if (keepSecrets && isUnchangedSecret(key, field, value)) continue;
    next[field] = value;
  }
  if (key === 'payment') next.cards = normalizeCards(next.cards);
  rawSet(key, encryptSection(key, key === 'payment' ? prunePaymentKeys(next) : next));
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

function migrateSmsShape() {
  const raw = rawGet('sms');
  if (!raw) return false;
  const parsed = safeJsonParse(raw, {});
  if (!LEGACY_SMS_KEYS.some((field) => field in parsed)) return false;

  // Keep the per-notification on/off decisions the owner made; drop everything
  // pattern-related (codes, template names, variable mappings).
  const stored = parsed.patterns && typeof parsed.patterns === 'object' ? parsed.patterns : {};
  const events = {};
  for (const [event, defaults] of Object.entries(DEFAULTS.sms.events)) {
    events[event] = { enabled: stored[event] && typeof stored[event] === 'object' ? stored[event].enabled !== false : defaults.enabled };
  }
  for (const [event, value] of Object.entries(stored)) {
    if (value && typeof value === 'object') events[event] = { enabled: value.enabled !== false };
  }

  const next = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (LEGACY_SMS_KEYS.includes(field)) continue;
    next[field] = value;
  }
  next.events = { ...events, ...(parsed.events && typeof parsed.events === 'object' ? parsed.events : {}) };
  // Secrets are already stored encrypted; rawSet writes the object back as is.
  rawSet('sms', next);
  return true;
}

/**
 * v1.5.5 removed the بلو link and card-to-card. A `payment` row written by 1.5.4
 * still carries those four keys — one of them an encrypted credential — so the first
 * boot after the upgrade rewrites the row without them. getSetting already refuses to
 * surface them; this is what actually takes them out of the database.
 */
function migratePaymentShape() {
  const raw = rawGet('payment');
  if (!raw) return false;
  const parsed = safeJsonParse(raw, {});
  if (!RETIRED_PAYMENT_KEYS.some((field) => field in parsed)) return false;
  // Secrets that remain are already stored encrypted: write the pruned object back.
  rawSet('payment', prunePaymentKeys(parsed));
  return true;
}

function ensureDefaults() {
  const db = getDb();
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [key, value] of Object.entries(DEFAULTS)) {
    insert.run(key, JSON.stringify(value), Date.now());
  }

  if (migrateSmsShape()) console.log('[settings] SMS settings migrated to the text-only shape (patterns removed)');
  if (migratePaymentShape()) console.log('[settings] payment settings migrated (بلو link and card-to-card removed)');

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
    payment: redactSection('payment', getSetting('payment')),
    backup: redactSection('backup', getSetting('backup')),
    cleanup: redactSection('cleanup', getSetting('cleanup')),
    telegram: redactSection('telegram', getSetting('telegram')),
    security: redactSection('security', getSetting('security')),
  };
}

module.exports = {
  DEFAULTS,
  SECRET_FIELDS,
  LEGACY_SMS_KEYS,
  RETIRED_PAYMENT_KEYS,
  LOCKED_FIELDS,
  MAX_CARDS,
  isLocked,
  normalizeCards,
  prunePaymentKeys,
  extractToken,
  ensureDefaults,
  migrateSmsShape,
  migratePaymentShape,
  getSetting,
  setSetting,
  updateSection,
  isUnchangedSecret,
  redactSection,
  publicMeta,
  allRedacted,
};

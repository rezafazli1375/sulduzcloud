'use strict';

const crypto = require('crypto');
const config = require('./config');

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status || 400;
    this.code = code || 'error';
    this.details = details || null;
  }
}

function nowMs() {
  return Date.now();
}

function dayKey(ts = Date.now(), timeZone = config.timezone) {
  return zonedDayLabel(Number(ts) || Date.now(), timeZone)
    || new Date(ts).toISOString().slice(0, 10);
}

function addDaysMs(baseMs, days) {
  return Number(baseMs || 0) + Math.round(Number(days || 0) * 86400000);
}

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

// Building an Intl.DateTimeFormat costs ~0.6 ms on the live box while using one
// costs ~0.014 ms, and the day arithmetic below runs on every x-ui client the
// sync cycle touches. So the formatters are built once per timezone and reused.
const formatCache = new Map();

function cachedFormat(kind, timeZone) {
  const key = `${kind}|${timeZone}`;
  let fmt = formatCache.get(key);
  if (fmt) return fmt;
  const base = { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' };
  const options = kind === 'day'
    ? base
    : { ...base, hour: '2-digit', minute: '2-digit', second: '2-digit' };
  fmt = new Intl.DateTimeFormat(kind === 'day' ? 'en-CA' : 'en-US', { ...options, timeZone });
  if (formatCache.size > 64) formatCache.clear();
  formatCache.set(key, fmt);
  return fmt;
}

function zonedParts(ts, timeZone = config.timezone) {
  try {
    const parts = cachedFormat('day', timeZone).formatToParts(new Date(ts));
    const pick = (type) => Number(parts.find((p) => p.type === type)?.value);
    const year = pick('year');
    const month = pick('month');
    const day = pick('day');
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    return { year, month, day };
  } catch (_) {
    return null;
  }
}

const pad2 = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD' from a zonedParts() reading, or '' when the reading failed.
function zonedDayLabelFromParts(parts) {
  if (!parts) return '';
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

// 'YYYY-MM-DD' of the zoned calendar day holding `ts`, or '' for a zone the
// runtime does not know. This is the same label dayKey() stores in the ledger.
function zonedDayLabel(ts, timeZone = config.timezone) {
  return zonedDayLabelFromParts(zonedParts(ts, timeZone));
}

// How far ahead of UTC the wall clock reads at instant `ts` (ms), for a timezone.
// A zone's offset is constant inside an hour everywhere this panel runs (Iran
// dropped DST in 2022 and Tehran is the default), so it is memoised per hour.
const offsetCache = new Map();

function zonedOffsetMs(ts, timeZone = config.timezone) {
  const at = Number(ts);
  if (!Number.isFinite(at)) return 0;
  const key = `${timeZone}|${Math.floor(at / HOUR_MS)}`;
  const hit = offsetCache.get(key);
  if (hit !== undefined) return hit;
  let offset = 0;
  try {
    const parts = cachedFormat('full', timeZone).formatToParts(new Date(at));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    offset = asUtc - Math.floor(at / 1000) * 1000;
  } catch (_) {
    offset = 0;
  }
  if (offsetCache.size > 4096) offsetCache.clear();
  offsetCache.set(key, offset);
  return offset;
}

// UTC instant of wall-clock midnight that opens the given zoned calendar day.
// Solved against the guess so a zone that observes DST still gets its real
// 23/24/25-hour day instead of a flat 86400000 ms bucket. A calendar day has
// exactly one midnight, so the answer is worth remembering: the sync cycle asks
// for the same handful of days once per client.
const dayStartCache = new Map();

function utcOfZonedDay(year, month, day, timeZone = config.timezone) {
  const key = `${timeZone}|${year}-${pad2(month)}-${pad2(day)}`;
  const hit = dayStartCache.get(key);
  if (hit !== undefined) return hit;
  const naive = Date.UTC(year, month - 1, day);
  let guess = naive;
  for (let i = 0; i < 4; i += 1) {
    const next = naive - zonedOffsetMs(guess, timeZone);
    if (next === guess) break;
    guess = next;
  }
  if (dayStartCache.size > 4096) dayStartCache.clear();
  dayStartCache.set(key, guess);
  return guess;
}

function nextZonedDay(parts) {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function zonedDayStartMs(ts = Date.now(), timeZone = config.timezone) {
  const at = Number(ts);
  if (!Number.isFinite(at)) return NaN;
  const parts = zonedParts(at, timeZone);
  if (!parts) return Math.floor(at / DAY_MS) * DAY_MS;
  return utcOfZonedDay(parts.year, parts.month, parts.day, timeZone);
}

// Wall-clock midnight that CLOSES the zoned day containing `ts`, i.e. the first
// midnight strictly after it.
function zonedDayEndMs(ts = Date.now(), timeZone = config.timezone) {
  const at = Number(ts);
  if (!Number.isFinite(at)) return NaN;
  const parts = zonedParts(at, timeZone);
  if (!parts) return Math.floor(at / DAY_MS) * DAY_MS + DAY_MS;
  const next = nextZonedDay(parts);
  return utcOfZonedDay(next.year, next.month, next.day, timeZone);
}

/**
 * Split [fromMs, toMs) into the zoned calendar days it touches.
 * Returns [{ day: 'YYYY-MM-DD', from, to, ms }] oldest first, contiguous, and
 * covering exactly the window handed in. An empty or inverted window gives [].
 */
function daySlices(fromMs, toMs, timeZone = config.timezone) {
  const from = Math.floor(Number(fromMs) || 0);
  const to = Math.floor(Number(toMs) || 0);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const slices = [];
  let cursor = from;
  while (cursor < to && slices.length < 400) {
    // One read of the clock for both the day's label and the midnight that
    // closes it, in the zone we were asked for (not the panel default).
    const parts = zonedParts(cursor, timeZone);
    if (!parts) return [];
    const next = nextZonedDay(parts);
    let end = utcOfZonedDay(next.year, next.month, next.day, timeZone);
    // A broken/unknown zone must never spin: fall back to a UTC-day boundary.
    if (!Number.isFinite(end) || end <= cursor) end = Math.floor(cursor / DAY_MS) * DAY_MS + DAY_MS;
    const stop = Math.min(to, end);
    slices.push({ day: zonedDayLabelFromParts(parts), from: cursor, to: stop, ms: stop - cursor });
    cursor = stop;
  }
  return slices;
}

/**
 * Spread bytes that were only noticed NOW over the days they were actually
 * transferred in. x-ui gives a cumulative counter, so the panel can only know
 * the total moved between two reads, not when inside that window each byte went;
 * the honest reading is to share it by elapsed time and keep the total exact.
 * Everything is booked: the slices always add up to `up` and `down`.
 * Returns [{ day, up, down }] with zero-bytes slices dropped.
 */
function spreadAcrossDays(fromMs, toMs, up, down, timeZone = config.timezone) {
  const totalUp = Math.max(0, Math.round(Number(up) || 0));
  const totalDown = Math.max(0, Math.round(Number(down) || 0));
  if (totalUp === 0 && totalDown === 0) return [];
  const slices = daySlices(fromMs, toMs, timeZone);
  if (!slices.length) return [];
  const span = slices.reduce((sum, slice) => sum + slice.ms, 0) || 1;
  const out = [];
  let putUp = 0;
  let putDown = 0;
  for (let i = 0; i < slices.length; i += 1) {
    const last = i === slices.length - 1;
    const sliceUp = last ? totalUp - putUp : Math.floor((totalUp * slices[i].ms) / span);
    const sliceDown = last ? totalDown - putDown : Math.floor((totalDown * slices[i].ms) / span);
    putUp += sliceUp;
    putDown += sliceDown;
    if (sliceUp > 0 || sliceDown > 0) out.push({ day: slices[i].day, up: sliceUp, down: sliceDown });
  }
  return out;
}

function gbToBytes(gb) {
  const n = Number(gb || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1024 * 1024 * 1024);
}

function bytesToGb(bytes) {
  const n = Number(bytes || 0);
  if (n <= 0) return 0;
  return Math.round((n / (1024 * 1024 * 1024)) * 100) / 100;
}

function randomToken(length = 24) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; i < bytes.length && out.length < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function randomPassword(length = 14) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; i < bytes.length && out.length < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function randomUUID() {
  return crypto.randomUUID();
}

function generateClientEmail(userId) {
  return `r${Number(userId) || 0}-${randomToken(8)}`;
}

function safeJsonParse(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function parsePermissions(value) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
}

function parseNumberArray(value) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed)
    ? parsed.map((v) => Number(v)).filter((v) => Number.isFinite(v))
    : [];
}

function statusOf(configRow, at = Date.now()) {
  if (!configRow) return 'unknown';
  if (configRow.deleted_at) return 'deleted';
  if (!configRow.enabled) return 'disabled';
  const expiry = Number(configRow.expiry_at || 0);
  if (expiry > 0 && expiry <= at) return 'expired';
  const total = Number(configRow.total_bytes || 0);
  const used = Number(configRow.up_bytes || 0) + Number(configRow.down_bytes || 0);
  if (total > 0 && used >= total) return 'depleted';
  return 'active';
}

// A customer package is every config of one reseller on one server that shares
// the subscription token. Names are not identities, and legacy rows without a
// token stay independent - with one exception: a subscription adopted out of a
// seller panel keeps the SAME x-ui email on every inbound it is attached to, so
// those rows are grouped by email and stay one customer with several inbounds.
// `c` must be the configs table alias in the query.
const CONFIG_GROUP_KEY_SQL = `(CASE WHEN c.sub_id <> ''
  THEN 'G:' || c.user_id || ':' || c.server_id || ':' || c.sub_id
  WHEN c.origin = 'external' AND c.email <> ''
    THEN 'E:' || c.user_id || ':' || c.server_id || ':' || c.email
  ELSE 'C:' || c.id END)`;

// Traffic of one package, counted per x-ui CLIENT and only then added together:
//   • a package the panel created itself has one distinct client per inbound, so
//     their counters simply add up;
//   • a subscription adopted from another panel is ONE client sitting on several
//     inbounds, stored as one row per inbound with the seller's counters repeated on
//     every row — that client must be counted once, not once per inbound;
//   • a package can hold both at once (an adopted customer given a new inbound), so
//     each client contributes its own highest row and the clients are summed.
// The inner predicate mirrors groupRows(): the group is (user, server, token), or for
// tokenless adopted rows (user, server, email), or that one row alone.
// `c` must be the configs table alias of the grouped query.
const CONFIG_GROUP_USED_SQL = `(
  SELECT SUM(member_total) FROM (
    SELECT MAX(c2.up_bytes + c2.down_bytes) AS member_total
    FROM configs c2
    WHERE c2.deleted_at = 0
      AND (CASE
        WHEN c.sub_id <> '' THEN c2.user_id = c.user_id AND c2.server_id = c.server_id AND c2.sub_id = c.sub_id
        WHEN c.origin = 'external' AND c.email <> ''
          THEN c2.user_id = c.user_id AND c2.server_id = c.server_id AND c2.email = c.email AND c2.origin = 'external'
        ELSE c2.id = c.id
      END)
    GROUP BY c2.email
  ))`;

function sanitizeUser(row) {
  if (!row) return null;
  const permissions = parsePermissions(row.permissions);
  const isOwner = row.role === 'admin' && permissions.includes('*');
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    name: row.name || '',
    email: row.email || '',
    phone: row.phone || '',
    telegramId: row.telegram_id || '',
    importConfigs: Number(row.import_configs ?? 1) !== 0,
    status: row.status,
    lang: row.lang || 'fa',
    permissions,
    isOwner,
    limits: {
      maxConfigs: Number(row.max_configs || 0),
      maxTotalGb: Number(row.max_total_gb || 0),
      maxGbPerConfig: Number(row.max_gb_per_config || 0),
      maxDaysPerConfig: Number(row.max_days_per_config || 0),
    },
    allowedInbounds: parseNumberArray(row.allowed_inbounds),
    fixedInbound: Number(row.fixed_inbound || 0),
    balance: Number(row.balance || 0),
    note: row.note || '',
    apiKey: row.role === 'reseller' ? row.api_key || '' : undefined,
    lastLoginAt: Number(row.last_login_at || 0),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    deletedAt: Number(row.deleted_at || 0),
  };
}

function sanitizeConfig(row, inbound, reseller, at = Date.now()) {
  if (!row) return null;
  const totalBytes = Number(row.total_bytes || 0);
  const up = Number(row.up_bytes || 0);
  const down = Number(row.down_bytes || 0);
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    subId: row.sub_id || '',
    uuid: row.uuid || '',
    label: row.label || '',
    customerName: row.customer_name || '',
    customerPhone: row.customer_phone || '',
    note: row.note || '',
    inboundId: row.inbound_id,
    serverId: Number(row.server_id || 0),
    inbound: inbound
      ? {
          id: inbound.id,
          serverId: Number(inbound.server_id || 0),
          serverName: inbound.server_name || '',
          remark: inbound.remark,
          protocol: inbound.protocol,
          port: inbound.port,
          network: inbound.network,
          security: inbound.security,
          nodeName: inbound.node_name || '',
          visible: Boolean(inbound.visible),
          enabled: Boolean(inbound.enabled),
          priceFixed: Number(inbound.price_fixed || 0),
          pricePerGb: Number(inbound.price_per_gb || 0),
          pricePerDay: Number(inbound.price_per_day || 0),
        }
      : null,
    reseller: reseller
      ? {
        id: reseller.id,
        username: reseller.username,
        name: reseller.name || '',
        // The drawer needs both to decide what is addable and what is locked:
        // the fixed inbound is the base of every package and never removable,
        // and an empty allowed list means "every visible inbound".
        fixedInbound: Number(reseller.fixed_inbound || 0),
        allowedInbounds: parseNumberArray(reseller.allowed_inbounds),
      }
      : null,
    totalGb: bytesToGb(totalBytes),
    totalBytes,
    expiryAt: Number(row.expiry_at || 0),
    enabled: Boolean(row.enabled),
    status: statusOf(row, at),
    // 'external' marks a subscription adopted from an existing x-ui panel; the
    // UI separates those from customers created through this panel.
    origin: row.origin === 'external' ? 'external' : 'panel',
    syncStatus: row.sync_status || '',
    up,
    down,
    used: up + down,
    remaining: totalBytes > 0 ? Math.max(0, totalBytes - up - down) : null,
    usagePercent: totalBytes > 0 ? Math.min(100, Math.round(((up + down) / totalBytes) * 1000) / 10) : null,
    lastOnlineAt: Number(row.last_online_at || 0),
    lastSyncedAt: Number(row.last_synced_at || 0),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

function pageParams(query, defaultSize = 20, maxSize = 100) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number.parseInt(query.pageSize, 10) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (m) => `\\${m}`);
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers, rows) {
  const head = headers.map((h) => csvEscape(h.label)).join(',');
  const body = rows
    .map((row) => headers.map((h) => csvEscape(typeof h.value === 'function' ? h.value(row) : row[h.value])).join(','))
    .join('\n');
  return `\uFEFF${head}\n${body}\n`;
}

function tcpLatency(host, port, timeoutMs = 3500) {
  return new Promise((resolve) => {
    let settled = false;
    const started = Date.now();
    let socket;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket && socket.destroy(); } catch (_) {}
      resolve(value);
    };
    try {
      // eslint-disable-next-line global-require
      const net = require('net');
      socket = net.connect({ host, port: Number(port), timeout: timeoutMs });
      socket.once('connect', () => finish(Date.now() - started));
      socket.once('timeout', () => finish(null));
      socket.once('error', () => finish(null));
    } catch (_) {
      finish(null);
    }
  });
}

function timingSafeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (_) {
    return false;
  }
}

function asyncH(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function logError(...args) {
  const ts = new Date().toISOString();
  console.error(`[${ts}]`, ...args);
}

module.exports = {
  ApiError,
  nowMs,
  dayKey,
  addDaysMs,
  zonedParts,
  zonedDayLabel,
  zonedOffsetMs,
  nextZonedDay,
  zonedDayStartMs,
  zonedDayEndMs,
  daySlices,
  spreadAcrossDays,
  gbToBytes,
  bytesToGb,
  randomToken,
  randomPassword,
  randomUUID,
  generateClientEmail,
  safeJsonParse,
  parsePermissions,
  parseNumberArray,
  statusOf,
  CONFIG_GROUP_KEY_SQL,
  CONFIG_GROUP_USED_SQL,
  sanitizeUser,
  sanitizeConfig,
  pageParams,
  escapeLike,
  csvEscape,
  toCsv,
  tcpLatency,
  timingSafeEqual,
  asyncH,
  clamp,
  log,
  logError,
};

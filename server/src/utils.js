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

function dayKey(ts = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts));
  } catch (_) {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

function addDaysMs(baseMs, days) {
  return Number(baseMs || 0) + Math.round(Number(days || 0) * 86400000);
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
      ? { id: reseller.id, username: reseller.username, name: reseller.name || '' }
      : null,
    totalGb: bytesToGb(totalBytes),
    totalBytes,
    expiryAt: Number(row.expiry_at || 0),
    enabled: Boolean(row.enabled),
    status: statusOf(row, at),
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

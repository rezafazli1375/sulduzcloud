'use strict';

const { getDb } = require('../db');
const settings = require('../settings');
const { ApiError } = require('../utils');
const { encryptSecret, decryptSecret } = require('../crypto');
const { audit } = require('../audit');

// Every x-ui panel the dashboard talks to is a "server". Row 1 is seeded from
// the legacy `settings.xui` section so existing installs keep working.

function now() {
  return Date.now();
}

function decryptToken(value) {
  if (!value) return '';
  try {
    return decryptSecret(value);
  } catch (_err) {
    return '';
  }
}

function toServer(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    url: String(row.url || ''),
    token: decryptToken(row.token),
    verifyTls: Boolean(row.verify_tls),
    subBase: String(row.sub_base || ''),
    enabled: Boolean(row.enabled),
    sort: Number(row.sort || 0),
    status: String(row.status || ''),
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    message: String(row.message || ''),
    lastCheckedAt: Number(row.last_checked_at || 0),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

function publicShape(server) {
  if (!server) return null;
  const { token, ...rest } = server;
  return { ...rest, hasToken: Boolean(token) };
}

function rawRow(id) {
  return getDb().prepare('SELECT * FROM servers WHERE id = ?').get(Number(id));
}

function countServers() {
  return Number(getDb().prepare('SELECT COUNT(*) AS c FROM servers').get().c || 0);
}

/**
 * Seed the first server from the legacy settings.xui section. Runs lazily so
 * old databases upgrade without a manual step.
 */
function ensureDefaultServer() {
  if (countServers() > 0) return null;
  const xui = settings.getSetting('xui');
  const url = String(xui.url || '').trim();
  if (!url) return null;
  const db = getDb();
  const ts = now();
  const info = db.prepare(
    `INSERT INTO servers (name, url, token, verify_tls, sub_base, enabled, sort, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, '', ?, ?)`
  ).run(
    'پنل اصلی',
    url,
    xui.token ? encryptSecret(String(xui.token)) : '',
    xui.verifyTls ? 1 : 0,
    String(xui.subBase || ''),
    ts,
    ts
  );
  const server = toServer(rawRow(info.lastInsertRowid));
  console.log(`[servers] default server seeded (#${server.id})`);
  return server;
}

function listServers({ includeDisabled = true } = {}) {
  ensureDefaultServer();
  const rows = getDb().prepare('SELECT * FROM servers ORDER BY sort ASC, id ASC').all();
  return rows
    .map(toServer)
    .filter((server) => includeDisabled || server.enabled);
}

function getServer(id) {
  if (id === undefined || id === null || Number(id) <= 0) return null;
  return toServer(rawRow(id));
}

function defaultServer() {
  ensureDefaultServer();
  const row = getDb().prepare('SELECT * FROM servers ORDER BY sort ASC, id ASC LIMIT 1').get();
  return toServer(row);
}

function resolveServer(id) {
  const server = getServer(id) || defaultServer();
  if (!server) {
    throw new ApiError(503, 'xui_not_configured', 'x-ui panel address is not configured');
  }
  if (!server.url) {
    throw new ApiError(503, 'xui_not_configured', `Server «${server.name || server.id}» has no address`);
  }
  if (!server.token) {
    throw new ApiError(503, 'xui_no_token', `API token for server «${server.name || server.id}» is not configured`);
  }
  return server;
}

function serverLabel(server) {
  return server ? `${server.name || 'server'} (#${server.id})` : 'server';
}

function normalizeUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) throw new ApiError(422, 'invalid_url', 'Panel address is required');
  if (!/^https?:\/\//i.test(text)) return `http://${text}`;
  return text;
}

function createServer(input, req) {
  const db = getDb();
  const name = String(input?.name || '').trim().slice(0, 80);
  if (!name) throw new ApiError(422, 'name_required', 'Server name is required');
  const url = normalizeUrl(input?.url);
  const token = String(input?.token || '').trim();
  const ts = now();
  const info = db.prepare(
    `INSERT INTO servers (name, url, token, verify_tls, sub_base, enabled, sort, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)`
  ).run(
    name,
    url,
    token ? encryptSecret(token) : '',
    input?.verifyTls ? 1 : 0,
    String(input?.subBase || '').trim(),
    input?.enabled === false ? 0 : 1,
    Number(input?.sort || 0),
    ts,
    ts
  );
  audit(req, 'server.create', 'server', Number(info.lastInsertRowid), { name, url });
  return publicShape(getServer(Number(info.lastInsertRowid)));
}

function updateServer(id, patch, req) {
  const db = getDb();
  const current = rawRow(id);
  if (!current) throw new ApiError(404, 'server_not_found', 'Server not found');
  const fields = [];
  const values = [];
  if (patch?.name !== undefined) {
    const name = String(patch.name || '').trim().slice(0, 80);
    if (!name) throw new ApiError(422, 'name_required', 'Server name is required');
    fields.push('name = ?');
    values.push(name);
  }
  if (patch?.url !== undefined) {
    fields.push('url = ?');
    values.push(normalizeUrl(patch.url));
  }
  if (patch?.token !== undefined && String(patch.token || '').trim() !== '') {
    fields.push('token = ?');
    values.push(encryptSecret(String(patch.token).trim()));
  }
  if (patch?.verifyTls !== undefined) {
    fields.push('verify_tls = ?');
    values.push(patch.verifyTls ? 1 : 0);
  }
  if (patch?.subBase !== undefined) {
    fields.push('sub_base = ?');
    values.push(String(patch.subBase || '').trim());
  }
  if (patch?.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (patch?.sort !== undefined) {
    fields.push('sort = ?');
    values.push(Math.round(Number(patch.sort || 0)));
  }
  if (!fields.length) return publicShape(toServer(current));
  fields.push('updated_at = ?');
  values.push(now(), Number(id));
  db.prepare(`UPDATE servers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  audit(req, 'server.update', 'server', Number(id), Object.keys(patch || {}));
  return publicShape(getServer(Number(id)));
}

function recordServerStatus(server, { ok, latencyMs = null, message = '' }) {
  const db = getDb();
  db.prepare(
    'UPDATE servers SET status = ?, latency_ms = ?, message = ?, last_checked_at = ?, updated_at = ? WHERE id = ?'
  ).run(ok ? 'online' : 'offline', latencyMs === null ? null : Number(latencyMs), String(message || ''), now(), now(), Number(server.id));
}

async function testServer(id, req) {
  // Lazy require: xui depends on this module for endpoint resolution.
  const xui = require('../xui');
  const server = getServer(id);
  if (!server) throw new ApiError(404, 'server_not_found', 'Server not found');
  if (!server.url) throw new ApiError(422, 'invalid_url', 'Panel address is required');
  if (!server.token) throw new ApiError(422, 'xui_no_token', 'API token is not configured for this server');
  const started = Date.now();
  try {
    const result = await xui.testConnection(server);
    recordServerStatus(server, { ok: true, latencyMs: result.latencyMs ?? Date.now() - started, message: '' });
    if (req) audit(req, 'server.test', 'server', server.id, { ok: true, latencyMs: result.latencyMs });
    return { ...result, server: publicShape(getServer(server.id)) };
  } catch (err) {
    recordServerStatus(server, { ok: false, latencyMs: Date.now() - started, message: err.message });
    if (req) audit(req, 'server.test', 'server', server.id, { ok: false, error: err.message });
    throw err;
  }
}

function deleteServer(id, req) {
  const db = getDb();
  const server = rawRow(id);
  if (!server) throw new ApiError(404, 'server_not_found', 'Server not found');
  if (countServers() <= 1) {
    throw new ApiError(422, 'server_last', 'At least one server must stay configured');
  }
  const used = Number(db.prepare('SELECT COUNT(*) AS c FROM configs WHERE server_id = ? AND deleted_at = 0').get(Number(id)).c || 0);
  if (used > 0) {
    throw new ApiError(409, 'server_in_use', 'This server still owns configs; move or delete them first');
  }
  const inboundIds = db.prepare('SELECT id FROM inbounds WHERE server_id = ?').all(Number(id)).map((row) => Number(row.id));
  const tx = db.transaction(() => {
    if (inboundIds.length) {
      const placeholders = inboundIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM reseller_discounts WHERE inbound_id IN (${placeholders})`).run(...inboundIds);
    }
    db.prepare('DELETE FROM inbounds WHERE server_id = ?').run(Number(id));
    db.prepare('DELETE FROM server_status WHERE server_id = ?').run(Number(id));
    db.prepare('DELETE FROM servers WHERE id = ?').run(Number(id));
  });
  tx();
  audit(req, 'server.delete', 'server', Number(id), { name: server.name, url: server.url });
  return { deleted: true };
}

module.exports = {
  listServers,
  getServer,
  defaultServer,
  resolveServer,
  ensureDefaultServer,
  createServer,
  updateServer,
  deleteServer,
  testServer,
  recordServerStatus,
  publicShape,
  serverLabel,
};

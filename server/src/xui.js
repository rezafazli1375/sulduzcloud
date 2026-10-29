'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const servers = require('./services/servers');
const { ApiError } = require('./utils');

/**
 * Resolve the x-ui endpoint for a request. Every helper accepts an optional
 * `server` row (from services/servers.js) or `serverId`; without one the
 * default (first) server is used, which keeps legacy single-panel code working.
 */
function request(method, path, body, opts = {}) {
  const server = opts.server || servers.resolveServer(opts.serverId);
  const base = String(server.url || '').replace(/\/+$/, '');
  const url = new URL(`${base}/panel/api${path}`);
  const isHttps = url.protocol === 'https:';
  const payload = body === undefined ? null : JSON.stringify(body);
  const timeoutMs = opts.timeoutMs || 25000;

  return new Promise((resolve, reject) => {
    const transport = isHttps ? https : http;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          Authorization: `Bearer ${server.token}`,
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
        rejectUnauthorized: isHttps ? Boolean(server.verifyTls) : true,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new ApiError(502, 'xui_auth', `x-ui rejected the API token (HTTP ${res.statusCode})`));
          }
          if (res.statusCode === 404) {
            return reject(new ApiError(502, 'xui_route', `x-ui endpoint not found: ${method} ${path}`));
          }
          if (res.statusCode >= 500) {
            return reject(new ApiError(502, 'xui_server', `x-ui server error (HTTP ${res.statusCode})`));
          }
          if (!json || typeof json !== 'object') {
            return reject(new ApiError(502, 'xui_bad_response', 'x-ui returned an invalid response'));
          }
          if (json.success === false) {
            const msg = String(json.msg || 'x-ui error').replace(/\s+/g, ' ').trim();
            return reject(new ApiError(422, 'xui_error', msg));
          }
          return resolve(json.obj);
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('x-ui request timed out'));
    });
    req.on('error', (err) => {
      reject(new ApiError(502, 'xui_unreachable', `Cannot reach x-ui: ${err.code || err.message}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const enc = (value) => encodeURIComponent(String(value));

/**
 * Normalise a client row returned by x-ui into a plain object with the
 * fields the panel needs. x-ui returns different shapes for list/get.
 */
function normalizeClient(raw, inboundIds) {
  if (!raw) return null;
  const traffic = raw.traffic || raw.Traffic || {};
  const up = Number(raw.up ?? traffic.up ?? 0);
  const down = Number(raw.down ?? traffic.down ?? 0);
  return {
    id: raw.id !== undefined && raw.id !== null ? String(raw.id) : '',
    email: String(raw.email || ''),
    subId: String(raw.subId || ''),
    uuid: String(raw.uuid || ''),
    password: String(raw.password || ''),
    flow: String(raw.flow || ''),
    security: String(raw.security || ''),
    limitIp: Number(raw.limitIp || 0),
    limitHwid: Number(raw.limitHwid || 0),
    totalBytes: Number(raw.totalGB || traffic.total || 0),
    expiryAt: Number(raw.expiryTime || traffic.expiryTime || 0),
    enabled: raw.enable !== false,
    comment: String(raw.comment || ''),
    tgId: Number(raw.tgId || 0),
    group: String(raw.group || ''),
    reset: Number(raw.reset || 0),
    resetDay: Number(raw.resetDay || 0),
    resetMax: Number(raw.resetMax || 0),
    trafficReset: String(raw.trafficReset || 'never'),
    trafficResetDay: Number(raw.trafficResetDay || 1),
    up,
    down,
    used: up + down,
    lastOnlineAt: Number(traffic.lastOnline || raw.lastOnline || 0),
    inboundIds: Array.isArray(raw.inboundIds)
      ? raw.inboundIds.map(Number)
      : Array.isArray(inboundIds)
        ? inboundIds.map(Number)
        : [],
    createdAt: Number(raw.createdAt || 0),
  };
}

function buildClientPayload(client) {
  // /clients/update REPLACES the stored row instead of patching it, so every
  // field we want to keep must be sent back. The VLESS/VMess identity lives in
  // `id` (a UUID string) — omitting it wipes the client's UUID.
  const body = {
    email: client.email,
    subId: client.subId || undefined,
    security: client.security || 'auto',
    flow: client.flow || undefined,
    limitIp: Number(client.limitIp || 0),
    limitHwid: Number(client.limitHwid || 0),
    totalGB: Math.max(0, Math.round(Number(client.totalBytes ?? client.totalGB ?? 0))),
    expiryTime: Math.max(0, Math.round(Number(client.expiryAt ?? client.expiryTime ?? 0))),
    enable: client.enabled !== false,
    tgId: Number(client.tgId || 0),
    comment: client.comment || '',
    reset: Number(client.reset || 0),
    resetDay: Number(client.resetDay || 0),
    resetMax: Number(client.resetMax || 0),
    trafficReset: client.trafficReset || 'never',
    trafficResetDay: Number(client.trafficResetDay || 1),
    group: client.group || '',
  };
  const uuid = String(client.uuid || '').trim();
  if (uuid) body.id = uuid;
  if (client.password) body.password = String(client.password);
  if (client.auth) body.auth = String(client.auth);
  return body;
}

async function listClients(server) {
  const rows = await request('GET', '/clients/list', undefined, { server });
  return Array.isArray(rows) ? rows.map((r) => normalizeClient(r)) : [];
}

async function getClient(email, server) {
  const obj = await request('GET', `/clients/get/${enc(email)}`, undefined, { server });
  if (!obj) return null;
  const client = obj.client || obj.Client || obj;
  return normalizeClient(client, obj.inboundIds);
}

async function addClient(client, inboundIds, server) {
  const payload = {
    client: {
      // VLESS/VMess identity is passed as `id` (UUID string); a `uuid` key is
      // ignored by the API and makes x-ui mint a different UUID.
      id: client.uuid || undefined,
      email: client.email,
      subId: client.subId,
      flow: client.flow || '',
      security: client.security || 'auto',
      limitIp: Number(client.limitIp || 0),
      limitHwid: Number(client.limitHwid || 0),
      totalGB: Math.max(0, Math.round(Number(client.totalBytes || 0))),
      expiryTime: Math.max(0, Math.round(Number(client.expiryAt || 0))),
      enable: client.enabled !== false,
      tgId: 0,
      comment: client.comment || '',
      reset: 0,
    },
    inboundIds: inboundIds.map(Number),
  };
  await request('POST', '/clients/add', payload, { server });
  return getClient(client.email, server);
}

async function updateClient(email, patch, inboundIds, server) {
  const current = await getClient(email, server);
  if (!current) throw new ApiError(404, 'xui_client_missing', 'Client does not exist on the x-ui panel');
  const merged = {
    ...current,
    ...patch,
    email: current.email,
    inboundIds: inboundIds && inboundIds.length ? inboundIds.map(Number) : current.inboundIds,
  };
  const body = buildClientPayload(merged);
  const query = merged.inboundIds && merged.inboundIds.length
    ? `?inboundIds=${merged.inboundIds.join(',')}`
    : '';
  await request('POST', `/clients/update/${enc(current.email)}${query}`, body, { server });
  return getClient(current.email, server);
}

async function deleteClient(email, keepTraffic = false, server) {
  await request('POST', `/clients/del/${enc(email)}${keepTraffic ? '?keepTraffic=1' : ''}`, undefined, { server });
  return true;
}

async function resetTraffic(email, server) {
  await request('POST', `/clients/resetTraffic/${enc(email)}`, undefined, { server });
  return true;
}

async function setEnabled(email, enabled, server) {
  // bulkEnable/bulkDisable only flip the flag and update the running Xray; they
  // never rewrite the client row, so the UUID/counters stay untouched.
  await request('POST', enabled ? '/clients/bulkEnable' : '/clients/bulkDisable', { emails: [email] }, { server });
  return getClient(email, server);
}

async function setIdentity(email, { uuid, subId }, server) {
  const current = await getClient(email, server);
  if (!current) throw new ApiError(404, 'xui_client_missing', 'Client does not exist on the x-ui panel');
  const merged = {
    ...current,
    ...(uuid ? { uuid: String(uuid) } : {}),
    ...(subId ? { subId: String(subId) } : {}),
    email: current.email,
  };
  const body = buildClientPayload(merged);
  await request('POST', `/clients/update/${enc(current.email)}`, body, { server });
  return getClient(current.email, server);
}

async function adjustMany(emails, { addDays = 0, addBytes = 0 } = {}, server) {
  if (!emails || !emails.length) return [];
  return request('POST', '/clients/bulkAdjust', {
    emails,
    addDays: Number(addDays || 0),
    addBytes: Math.round(Number(addBytes || 0)),
  }, { server });
}

async function attachInbounds(email, inboundIds, server) {
  await request('POST', `/clients/${enc(email)}/attach`, { inboundIds: inboundIds.map(Number) }, { server });
  return true;
}

async function detachInbounds(email, inboundIds, server) {
  await request('POST', `/clients/${enc(email)}/detach`, { inboundIds: inboundIds.map(Number) }, { server });
  return true;
}

async function clientLinks(email, server) {
  const rows = await request('GET', `/clients/links/${enc(email)}`, undefined, { server });
  return Array.isArray(rows) ? rows.filter((l) => typeof l === 'string' && l.length > 8) : [];
}

async function subLinks(subId, server) {
  const rows = await request('GET', `/clients/subLinks/${enc(subId)}`, undefined, { server });
  return Array.isArray(rows) ? rows.filter((l) => typeof l === 'string' && l.length > 8) : [];
}

async function onlines(server) {
  const rows = await request('POST', '/clients/onlines', {}, { server });
  return Array.isArray(rows) ? rows : [];
}

async function inbounds(server) {
  const rows = await request('GET', '/inbounds/options', undefined, { server });
  return Array.isArray(rows) ? rows : [];
}

// `/inbounds/options` omits subSortIndex, so the subscription order is read
// from the slim list (same inbounds, but a lighter payload than /inbounds/list).
async function inboundsSlim(server) {
  const rows = await request('GET', '/inbounds/list/slim', undefined, { server });
  return Array.isArray(rows) ? rows : [];
}

async function nodes(server) {
  const rows = await request('GET', '/nodes/list', undefined, { server });
  return Array.isArray(rows) ? rows : [];
}

async function serverStatus(server) {
  return request('GET', '/server/status', undefined, { server });
}

async function testConnection(server) {
  const started = Date.now();
  const inboundList = await inbounds(server);
  const latency = Date.now() - started;
  return { ok: true, latencyMs: latency, inbounds: Array.isArray(inboundList) ? inboundList.length : 0 };
}

module.exports = {
  request,
  normalizeClient,
  buildClientPayload,
  listClients,
  getClient,
  addClient,
  updateClient,
  deleteClient,
  resetTraffic,
  setEnabled,
  setIdentity,
  adjustMany,
  attachInbounds,
  detachInbounds,
  clientLinks,
  subLinks,
  onlines,
  inbounds,
  inboundsSlim,
  nodes,
  serverStatus,
  testConnection,
};

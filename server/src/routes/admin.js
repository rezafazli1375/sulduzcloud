'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { getDb, closeDb } = require('../db');
const settings = require('../settings');
const auth = require('../auth');
const usersService = require('../services/users');
const inboundsService = require('../services/inbounds');
const serversService = require('../services/servers');
const configsService = require('../services/configs');
const pricing = require('../services/pricing');
const statsService = require('../services/stats');
const backupService = require('../services/backup');
const telegram = require('../services/telegram');
const monitor = require('../services/monitor');
const ticketsService = require('../services/tickets');
const notify = require('../notify');
const xui = require('../xui');
const { ApiError, asyncH, sanitizeUser, pageParams, toCsv, bytesToGb } = require('../utils');
const { audit, listAudit } = require('../audit');

const router = express.Router();
router.use(auth.requireAdmin);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(config.dataDir, 'tmp');
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `restore-${Date.now()}.db`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, true);
  },
});

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** First finite number found at one of the given keys (x-ui versions differ). */
function pickNumber(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const value = key.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), source);
    if (value !== undefined && value !== null && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

/**
 * Normalise the x-ui `/panel/api/server/status` payload into the flat resource
 * shape the dashboard renders for every panel (CPU %, RAM and disk in bytes).
 */
function panelResources(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const mem = obj.mem || obj.memory || {};
  const disk = obj.disk || obj.diskUsage || {};
  const xray = obj.xray || {};
  return {
    cpu: pickNumber(obj, ['cpu', 'cpuUsage', 'cpu.percent', 'cpuPercent']),
    memCurrent: pickNumber(mem, ['current', 'used']),
    memTotal: pickNumber(mem, ['total']),
    diskCurrent: pickNumber(disk, ['current', 'used']),
    diskTotal: pickNumber(disk, ['total']),
    uptime: pickNumber(obj, ['uptime', 'uptimeSeconds']),
    xrayState: String(xray.state || obj.xrayState || ''),
    coreVersion: String(xray.version || obj.coreVersion || ''),
  };
}

function latestStatuses() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT s.* FROM server_status s
     JOIN (SELECT kind, ref_id, server_id, MAX(checked_at) AS checked_at FROM server_status GROUP BY kind, ref_id, server_id) latest
       ON latest.kind = s.kind AND latest.ref_id = s.ref_id AND latest.server_id = s.server_id AND latest.checked_at = s.checked_at`
  ).all();
  const map = new Map();
  for (const row of rows) map.set(`${row.kind}:${Number(row.server_id || 0)}:${row.ref_id}`, row);
  return map;
}

// ---------------------------------------------------------------- dashboard

router.get('/overview', auth.requirePerm('stats'), (req, res) => {
  res.json({ ok: true, data: statsService.adminOverview() });
});

// ------------------------------------------------------------------- users

router.get('/users', auth.requirePerm('users'), (req, res) => {
  const data = usersService.listUsers({
    search: String(req.query.search || ''),
    status: String(req.query.status || ''),
    role: String(req.query.role || ''),
    page: num(req.query.page, 1),
    pageSize: Math.min(200, num(req.query.pageSize, 20)),
  });
  res.json({ ok: true, data });
});

router.get('/users/export.csv', auth.requirePerm('users'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM users WHERE deleted_at = 0 ORDER BY id ASC').all();
  const csv = toCsv(
    [
      { label: 'ID', value: 'id' },
      { label: 'Username', value: 'username' },
      { label: 'Role', value: 'role' },
      { label: 'Name', value: 'name' },
      { label: 'Email', value: 'email' },
      { label: 'Phone', value: 'phone' },
      { label: 'Status', value: 'status' },
      { label: 'Balance', value: 'balance' },
      { label: 'Created', value: (r) => new Date(r.created_at).toISOString() },
    ],
    rows
  );
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="resellers.csv"').send(csv);
});

router.post('/users', auth.requirePerm('users'), (req, res) => {
  const user = usersService.createUser(req.body || {}, req);
  res.status(201).json({ ok: true, data: { user: sanitizeUser(user), stats: usersService.userStats(user.id) } });
});

router.get('/users/:id', auth.requirePerm('users'), (req, res) => {
  const user = usersService.getUser(num(req.params.id));
  if (!user) throw new ApiError(404, 'not_found', 'User not found');
  const db = getDb();
  const transactions = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(user.id);
  res.json({
    ok: true,
    data: {
      user: sanitizeUser(user),
      stats: usersService.userStats(user.id),
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amount,
        balanceAfter: t.balance_after,
        description: t.description,
        createdAt: t.created_at,
      })),
      configs: configsService.listConfigs({ userId: user.id, page: 1, pageSize: 5 }, { role: 'admin' }),
    },
  });
});

router.patch('/users/:id', auth.requirePerm('users'), (req, res) => {
  const user = usersService.updateUser(num(req.params.id), req.body || {}, req);
  res.json({ ok: true, data: { user: sanitizeUser(user), stats: usersService.userStats(user.id) } });
});

router.post('/users/:id/status', auth.requirePerm('users'), (req, res) => {
  const user = usersService.setStatus(num(req.params.id), String(req.body?.status || ''), req);
  res.json({ ok: true, data: { user: sanitizeUser(user) } });
});

router.post('/users/:id/password', auth.requirePerm('users'), (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 8) throw new ApiError(422, 'weak_password', 'رمز عبور حداقل ۸ کاراکتر باشد');
  const user = usersService.updateUser(num(req.params.id), { password }, req);
  res.json({ ok: true, data: { user: sanitizeUser(user) } });
});

router.post('/users/:id/api-key', auth.requirePerm('users'), (req, res) => {
  const result = usersService.regenerateApiKey(num(req.params.id), req);
  res.json({ ok: true, data: result });
});

router.post('/users/:id/balance', auth.requirePerm('users'), (req, res) => {
  const result = usersService.adjustBalance(
    num(req.params.id),
    num(req.body?.amount),
    String(req.body?.description || ''),
    req
  );
  res.json({ ok: true, data: result });
});

router.delete('/users/:id', auth.requirePerm('users'), (req, res) => {
  const result = usersService.deleteUser(
    num(req.params.id),
    { purgeConfigs: String(req.query.purge || '') === '1' },
    req
  );
  res.json({ ok: true, data: result });
});

// ---------------------------------------------------------- pricing/discounts

router.get('/users/:id/discounts', auth.requirePerm('users'), (req, res) => {
  const user = usersService.getUser(num(req.params.id));
  if (!user) throw new ApiError(404, 'not_found', 'User not found');
  res.json({
    ok: true,
    data: {
      user: sanitizeUser(user),
      billing: pricing.billingInfo(),
      discounts: pricing.discountsFor(user.id),
    },
  });
});

router.put('/users/:id/discounts', auth.requirePerm('users'), (req, res) => {
  const discounts = pricing.replaceDiscounts(num(req.params.id), req.body?.discounts || [], req);
  res.json({ ok: true, data: { discounts } });
});

router.post('/pricing/quote', auth.requirePerm('configs'), (req, res) => {
  const body = req.body || {};
  const result = pricing.quote({
    userId: num(body.userId),
    inboundIds: body.inboundIds || (body.inboundId ? [body.inboundId] : []),
    gb: num(body.gb),
    days: num(body.days),
    unlimited: Boolean(body.unlimited),
  });
  res.json({ ok: true, data: result });
});

// ------------------------------------------------------------------ configs

router.get('/configs', auth.requirePerm('configs'), (req, res) => {
  const data = configsService.listConfigs(
    {
      userId: num(req.query.userId, 0),
      inboundId: num(req.query.inboundId, 0),
      status: String(req.query.status || ''),
      search: String(req.query.search || ''),
      expiringDays: num(req.query.expiringDays, 0),
      page: num(req.query.page, 1),
      pageSize: Math.min(200, num(req.query.pageSize, 20)),
    },
    { role: 'admin' }
  );
  res.json({ ok: true, data });
});

router.get('/configs/export.csv', auth.requirePerm('configs'), (req, res) => {
  const rows = configsService.exportRows(
    {
      userId: num(req.query.userId, 0),
      inboundId: num(req.query.inboundId, 0),
      status: String(req.query.status || ''),
      search: String(req.query.search || ''),
    },
    { role: 'admin' }
  );
  const csv = toCsv(
    [
      { label: 'ID', value: 'id' },
      { label: 'Email', value: 'email' },
      { label: 'Reseller', value: (r) => (r.reseller ? r.reseller.username : '') },
      { label: 'Inbound', value: (r) => (r.inbound ? r.inbound.remark : '') },
      { label: 'Label', value: 'label' },
      { label: 'Customer', value: 'customerName' },
      { label: 'Phone', value: 'customerPhone' },
      { label: 'Status', value: 'status' },
      { label: 'Total GB', value: 'totalGb' },
      { label: 'Used GB', value: (r) => bytesToGb(r.used) },
      { label: 'Expiry', value: (r) => (r.expiryAt ? new Date(r.expiryAt).toISOString() : 'unlimited') },
      { label: 'Created', value: (r) => new Date(r.createdAt).toISOString() },
    ],
    rows
  );
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="configs.csv"').send(csv);
});

router.post('/configs', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const body = req.body || {};
  const configs = await configsService.createConfigs(
    {
      userId: num(body.userId),
      inboundIds: body.inboundIds || (body.inboundId ? [body.inboundId] : []),
      gb: num(body.gb),
      days: num(body.days),
      label: body.label,
      customerName: body.customerName,
      customerPhone: body.customerPhone,
      note: body.note,
      unlimited: Boolean(body.unlimited),
    },
    req
  );
  res.status(201).json({ ok: true, data: { configs } });
}));

router.get('/configs/:id', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const { row, config } = configsService.detailView(num(req.params.id), { role: 'admin' });
  const links = await configsService.linksFor(row);
  res.json({ ok: true, data: { config, group: configsService.groupFor(row), ...links } });
}));

router.get('/configs/:id/links', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const { row, config } = configsService.detailView(num(req.params.id), { role: 'admin' });
  const links = await configsService.linksFor(row);
  res.json({ ok: true, data: { config, group: configsService.groupFor(row), ...links } });
}));

router.patch('/configs/:id', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const config = await configsService.updateMeta(num(req.params.id), req.body || {}, req, { role: 'admin' });
  res.json({ ok: true, data: { config } });
}));

router.post('/configs/:id/extend', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const config = await configsService.extendConfig(
    num(req.params.id),
    {
      gb: num(req.body?.gb),
      days: num(req.body?.days),
      price: num(req.body?.price),
      resetUsage: Boolean(req.body?.resetUsage),
    },
    req,
    { role: 'admin' }
  );
  res.json({ ok: true, data: { config } });
}));

router.post('/configs/:id/quota', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const config = await configsService.setQuota(num(req.params.id), req.body || {}, req, { role: 'admin' });
  res.json({ ok: true, data: { config } });
}));

router.post('/configs/:id/toggle', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const config = await configsService.toggleConfig(num(req.params.id), Boolean(req.body?.enabled), req, { role: 'admin' });
  res.json({ ok: true, data: { config } });
}));

router.post('/configs/:id/identity', auth.requirePerm('configs'), asyncH(async (req, res) => {
  await configsService.updateIdentity(
    num(req.params.id),
    { uuid: req.body?.uuid, subId: req.body?.subId },
    req,
    { role: 'admin' }
  );
  const { row, config } = configsService.detailView(num(req.params.id), { role: 'admin' });
  const links = await configsService.linksFor(row);
  res.json({ ok: true, data: { config, group: configsService.groupFor(row), ...links } });
}));

router.post('/configs/:id/inbounds', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const config = await configsService.addInbound(num(req.params.id), num(req.body?.inboundId), req, { role: 'admin' });
  res.status(201).json({ ok: true, data: { config } });
}));

router.post('/configs/:id/reset', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const config = await configsService.resetUsage(num(req.params.id), req, { role: 'admin' });
  res.json({ ok: true, data: { config } });
}));

router.delete('/configs/:id', auth.requirePerm('configs'), asyncH(async (req, res) => {
  await configsService.removeConfig(num(req.params.id), {}, req, { role: 'admin' });
  res.json({ ok: true, data: { deleted: true } });
}));

// ---------------------------------------------------------------- inbounds

router.get('/inbounds', auth.requirePerm('inbounds'), (req, res) => {
  const statuses = latestStatuses();
  const discountUserId = num(req.query.userId, 0);
  const discountMap = discountUserId ? pricing.discountMap(discountUserId) : null;
  const rows = inboundsService.listInbounds({ includeHidden: true }).map((row) => {
    // Local inbounds live on the x-ui panel itself (node_id = 0); their health
    // is tracked under that server's `panel` row, not a `node` row.
    const status = statuses.get(
      row.nodeId ? `node:${row.serverId}:${row.nodeId}` : `panel:${row.serverId}:0`
    );
    return {
      ...row,
      discountPercent: discountMap ? discountMap.get(row.id) || 0 : 0,
      nodeStatus: status ? status.status : 'unknown',
      nodeLatencyMs: status ? status.latency_ms : null,
    };
  });
  res.json({ ok: true, data: { rows, servers: serversService.listServers().map(serversService.publicShape) } });
});

router.post('/inbounds/sync', auth.requirePerm('inbounds'), asyncH(async (req, res) => {
  const result = await inboundsService.syncInbounds({
    forceSubOrder: true,
    serverId: num(req.body?.serverId, 0),
  });
  res.json({ ok: true, data: result });
}));

router.post('/inbounds/visibility', auth.requirePerm('inbounds'), (req, res) => {
  const result = inboundsService.bulkVisibility(req.body?.ids, Boolean(req.body?.visible), req);
  res.json({ ok: true, data: result });
});

router.patch('/inbounds/:id', auth.requirePerm('inbounds'), (req, res) => {
  const row = inboundsService.updateInbound(num(req.params.id), req.body || {}, req);
  res.json({ ok: true, data: { inbound: row } });
});

// ----------------------------------------------------------------- servers

router.get('/servers', auth.requirePerm('servers'), asyncH(async (req, res) => {
  const statuses = latestStatuses();
  const db = getDb();
  const panelRows = serversService.listServers();

  // Resource usage (CPU / RAM / disk) is read from every enabled panel in
  // parallel so the dashboard can show one card per server. A slow or offline
  // panel only loses its own numbers; the others still render.
  const resources = new Map();
  const resourceErrors = new Map();
  await Promise.all(panelRows
    .filter((server) => server.enabled && server.url && server.token)
    .map(async (server) => {
      try {
        const raw = await xui.serverStatus(server, { timeoutMs: 8000 });
        resources.set(server.id, panelResources(raw));
      } catch (err) {
        resourceErrors.set(server.id, err.message);
      }
    }));

  const panels = panelRows.map((server) => {
    const st = statuses.get(`panel:${server.id}:0`);
    return {
      ...serversService.publicShape(server),
      status: st ? st.status : server.status || 'unknown',
      latencyMs: st ? st.latency_ms : server.latencyMs,
      message: st ? st.message : server.message,
      checkedAt: st ? st.checked_at : server.lastCheckedAt,
      resources: resources.get(server.id) || null,
      resourcesError: resourceErrors.get(server.id) || '',
    };
  });

  // Live nodes are read from the default panel only; the monitor keeps the
  // status history for every panel in the background.
  const primary = serversService.defaultServer();
  let nodes = [];
  let live = primary ? resources.get(primary.id) || null : null;
  let liveError = primary ? resourceErrors.get(primary.id) || '' : '';
  if (primary) {
    try { nodes = await xui.nodes(primary); } catch (err) { liveError = liveError || err.message; }
  }
  const series = db.prepare(
    `SELECT server_id, ref_id, status, latency_ms, checked_at FROM server_status
     WHERE kind = 'node' AND server_id = ? AND checked_at > ? ORDER BY checked_at ASC`
  ).all(primary ? primary.id : 0, Date.now() - 24 * 3600 * 1000).map((r) => ({
    serverId: r.server_id,
    nodeId: r.ref_id,
    status: r.status,
    latencyMs: r.latency_ms,
    checkedAt: r.checked_at,
  }));
  res.json({
    ok: true,
    data: {
      panels,
      nodes: nodes.map((n) => {
        const st = statuses.get(`node:${primary.id}:${n.id}`);
        return {
          id: n.id,
          serverId: primary.id,
          serverName: primary.name,
          name: n.name || n.remark,
          address: n.address,
          port: n.port,
          enable: Boolean(n.enable),
          status: n.status,
          // x-ui reports node heartbeats in seconds; normalise to ms for the UI.
          heartbeat: Number(n.lastHeartbeat || 0) > 0 && Number(n.lastHeartbeat) < 1e12
            ? Number(n.lastHeartbeat) * 1000
            : Number(n.lastHeartbeat || 0),
          latencyMs: st ? st.latency_ms : null,
          checkedAt: st ? st.checked_at : 0,
        };
      }),
      panel: (() => {
        const first = panels[0];
        return first
          ? { status: first.status, latencyMs: first.latencyMs, message: first.message, checkedAt: first.checkedAt }
          : { status: 'unknown' };
      })(),
      live,
      liveError,
      series,
      monitor: monitor.status(),
    },
  });
}));

// Create / edit / remove the x-ui panels this dashboard controls.
router.post('/servers', auth.requirePerm('servers'), (req, res) => {
  const server = serversService.createServer(req.body || {}, req);
  monitor.runCycle('server-add').catch(() => {});
  res.status(201).json({ ok: true, data: { server } });
});

router.patch('/servers/:id', auth.requirePerm('servers'), (req, res) => {
  const server = serversService.updateServer(num(req.params.id), req.body || {}, req);
  // Re-check in the background so the list shows the new status right away.
  monitor.runCycle('server-edit').catch(() => {});
  res.json({ ok: true, data: { server } });
});

router.delete('/servers/:id', auth.requirePerm('servers'), (req, res) => {
  res.json({ ok: true, data: serversService.deleteServer(num(req.params.id), req) });
});

router.post('/servers/:id/test', auth.requirePerm('servers'), asyncH(async (req, res) => {
  const result = await serversService.testServer(num(req.params.id), req);
  res.json({ ok: true, data: result });
}));

router.post('/servers/check', auth.requirePerm('servers'), asyncH(async (req, res) => {
  const result = await monitor.runCycle('manual');
  res.json({ ok: true, data: result });
}));

// ------------------------------------------------------------------- stats

router.get('/stats', auth.requirePerm('stats'), (req, res) => {
  const days = Math.min(180, Math.max(1, num(req.query.days, 30)));
  const db = getDb();
  const overview = statsService.adminOverview();
  const revenueRows = db.prepare(
    `SELECT date(created_at / 1000, 'unixepoch') AS day, type, SUM(ABS(amount)) AS amount, COUNT(*) AS n
     FROM transactions WHERE created_at >= ? GROUP BY day, type ORDER BY day ASC`
  ).all(Date.now() - days * 86400000);
  res.json({
    ok: true,
    data: {
      overview,
      days,
      series: statsService.trafficSeries(days),
      topUsers: statsService.topUsers(days, 12),
      topConfigs: statsService.topConfigs(days, 12),
      inbounds: statsService.inboundBreakdown(),
      revenue: revenueRows.map((r) => ({ day: r.day, type: r.type, amount: r.amount, count: r.n })),
    },
  });
});

router.get('/transactions', auth.requirePerm('stats'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query, 30, 200);
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c;
  const rows = db.prepare(
    `SELECT t.*, u.username FROM transactions t LEFT JOIN users u ON u.id = t.user_id
     ORDER BY t.created_at DESC LIMIT ? OFFSET ?`
  ).all(pageSize, offset);
  res.json({
    ok: true,
    data: {
      total,
      page,
      pageSize,
      rows: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        username: r.username,
        type: r.type,
        amount: r.amount,
        balanceAfter: r.balance_after,
        description: r.description,
        createdAt: r.created_at,
      })),
    },
  });
});

// ---------------------------------------------------------------- settings

router.get('/settings', auth.requirePerm('settings'), (req, res) => {
  res.json({ ok: true, data: { settings: settings.allRedacted(), version: config.version } });
});

router.patch('/settings/:section', auth.requirePerm('settings'), asyncH(async (req, res) => {
  const section = String(req.params.section || '');
  if (!(section in settings.DEFAULTS)) throw new ApiError(404, 'unknown_section', 'Unknown settings section');
  const patch = req.body || {};
  // Only allow keys defined in the defaults for this section.
  const clean = {};
  for (const key of Object.keys(settings.DEFAULTS[section])) {
    if (patch[key] !== undefined) clean[key] = patch[key];
  }
  // Type guards for critical values.
  if (section === 'monitor') {
    if (clean.intervalSec !== undefined) clean.intervalSec = Math.min(3600, Math.max(60, num(clean.intervalSec, 120)));
    if (clean.failureThreshold !== undefined) clean.failureThreshold = Math.min(10, Math.max(1, num(clean.failureThreshold, 2)));
    if (clean.retentionDays !== undefined) clean.retentionDays = Math.min(365, Math.max(3, num(clean.retentionDays, 30)));
    if (clean.expiryDays !== undefined) {
      clean.expiryDays = String(clean.expiryDays)
        .split(',')
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(0, 5);
    }
  }
  if (section === 'backup') {
    // Guard each field separately: a partial patch (e.g. only the auto toggle)
    // must not reset the previously saved schedule.
    if (clean.hour !== undefined) clean.hour = Math.min(23, Math.max(0, num(clean.hour, 3)));
    if (clean.minute !== undefined) clean.minute = Math.min(59, Math.max(0, num(clean.minute, 30)));
    if (clean.keep !== undefined) clean.keep = Math.min(60, Math.max(1, num(clean.keep, 14)));
  }
  if (section === 'security') {
    if (clean.sessionDays !== undefined) clean.sessionDays = Math.min(90, Math.max(1, num(clean.sessionDays, 7)));
    if (clean.loginRateLimit !== undefined) clean.loginRateLimit = Math.min(100, Math.max(3, num(clean.loginRateLimit, 10)));
  }
  if (section === 'smtp' && clean.port !== undefined) clean.port = Math.min(65535, Math.max(1, num(clean.port, 587)));
  const saved = settings.updateSection(section, clean);
  audit(req, 'settings.update', 'settings', section, { keys: Object.keys(clean) });
  if (section === 'monitor' || section === 'backup') monitor.reconfigure();
  let xuiTest = null;
  if (section === 'xui') {
    // The legacy x-ui settings card keeps working: mirror it onto the primary
    // server row so both admin screens edit the same connection. A fresh panel
    // starts with no server at all, so saving a real address + token here
    // creates the first one.
    const primary = serversService.defaultServer();
    if (primary) {
      const patch = {
        verifyTls: Boolean(saved.verifyTls),
        subBase: saved.subBase,
      };
      if (saved.url) patch.url = saved.url;
      if (saved.token) patch.token = saved.token;
      serversService.updateServer(primary.id, patch, req);
    } else if (saved.url && saved.token) {
      serversService.createServer(
        {
          name: 'پنل اصلی',
          url: saved.url,
          token: saved.token,
          verifyTls: Boolean(saved.verifyTls),
          subBase: saved.subBase,
        },
        req
      );
    }
    try { xuiTest = await xui.testConnection(); } catch (err) { xuiTest = { ok: false, error: err.message }; }
    monitor.runCycle('settings').catch(() => {});
  }
  res.json({ ok: true, data: { section, saved: settings.redactSection(section, saved), xuiTest } });
}));

router.post('/settings/test-email', auth.requirePerm('settings'), asyncH(async (req, res) => {
  const result = await notify.testEmail();
  res.json({ ok: true, data: result });
}));

router.post('/settings/test-sms', auth.requirePerm('settings'), asyncH(async (req, res) => {
  const result = await notify.testSms();
  res.json({ ok: true, data: result });
}));

router.post('/settings/test-xui', auth.requirePerm('settings'), asyncH(async (req, res) => {
  const result = await xui.testConnection();
  res.json({ ok: true, data: result });
}));

router.post('/settings/test-telegram', auth.requirePerm('settings'), asyncH(async (req, res) => {
  const result = await telegram.test();
  res.json({ ok: true, data: result });
}));

// ---------------------------------------------------------------- backups

router.get('/backups', auth.requirePerm('backups'), (req, res) => {
  const tg = telegram.config();
  res.json({
    ok: true,
    data: {
      rows: backupService.listBackups(),
      auto: backupService.autoBackupEnabled(),
      schedule: backupService.scheduleInfo(),
      telegram: { enabled: tg.enabled, configured: telegram.ready(tg), sendOnAuto: tg.sendOnAuto },
    },
  });
});

router.patch('/backups/schedule', auth.requirePerm('backups'), asyncH(async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.auto !== undefined) patch.auto = Boolean(body.auto);
  if (body.hour !== undefined) patch.hour = Math.min(23, Math.max(0, num(body.hour, 3)));
  if (body.minute !== undefined) patch.minute = Math.min(59, Math.max(0, num(body.minute, 30)));
  if (body.keep !== undefined) patch.keep = Math.min(60, Math.max(1, num(body.keep, 14)));
  settings.updateSection('backup', patch);
  audit(req, 'backup.schedule', 'settings', 'backup', patch);
  res.json({ ok: true, data: backupService.scheduleInfo() });
}));

router.post('/backups/:name/telegram', auth.requirePerm('backups'), asyncH(async (req, res) => {
  const full = backupService.backupPath(req.params.name);
  const result = await telegram.sendBackup(full, req.params.name, 'manual');
  audit(req, 'backup.telegram', 'backup', req.params.name, {});
  res.json({ ok: true, data: result });
}));

router.post('/backups', auth.requirePerm('backups'), asyncH(async (req, res) => {
  const info = await backupService.createBackup('manual', req);
  res.status(201).json({ ok: true, data: info });
}));

router.get('/backups/:name/download', auth.requirePerm('backups'), (req, res) => {
  const full = backupService.backupPath(req.params.name);
  res.download(full, req.params.name);
});

router.delete('/backups/:name', auth.requirePerm('backups'), (req, res) => {
  res.json({ ok: true, data: backupService.deleteBackup(req.params.name, req) });
});

router.post('/backups/restore', auth.requirePerm('backups'), upload.single('file'), asyncH(async (req, res) => {
  if (!req.file) throw new ApiError(422, 'file_required', 'Select a backup file');
  if (String(req.body?.confirm || '') !== 'RESTORE') {
    fs.unlinkSync(req.file.path);
    throw new ApiError(422, 'confirm_required', 'Type RESTORE to confirm');
  }
  let info;
  try {
    info = backupService.stageRestore(req.file.path, req);
  } finally {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
  }
  audit(req, 'backup.restore', 'backup', req.file.originalname, {});
  res.json({ ok: true, data: { ...info, message: 'Restore staged, panel is restarting' } });
  setTimeout(() => {
    try { closeDb(); } catch (_) {}
    process.exit(0);
  }, 700);
}));

// ------------------------------------------------------------------ audit

router.get('/audit', auth.requirePerm('audit'), (req, res) => {
  res.json({
    ok: true,
    data: listAudit({
      page: num(req.query.page, 1),
      pageSize: Math.min(100, num(req.query.pageSize, 30)),
      userId: num(req.query.userId, 0),
      action: String(req.query.action || ''),
      entity: String(req.query.entity || ''),
    }),
  });
});

// ----------------------------------------------------------------- admin tickets

router.get('/tickets', auth.requirePerm('tickets'), (req, res) => {
  res.json({
    ok: true,
    data: ticketsService.listTickets({
      viewer: req.user,
      status: String(req.query.status || ''),
      page: num(req.query.page, 1),
      pageSize: Math.min(100, num(req.query.pageSize, 20)),
    }),
  });
});

// -------------------------------------------------------------- broadcasts

router.post('/broadcast', auth.requirePerm('broadcasts'), (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 140);
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  const audience = String(req.body?.audience || 'all');
  if (!title || !body) throw new ApiError(422, 'missing_fields', 'Title and message are required');
  const db = getDb();
  let users = [];
  if (audience === 'selected') {
    const ids = (req.body?.userIds || []).map(Number).filter((n) => Number.isFinite(n));
    if (!ids.length) throw new ApiError(422, 'no_recipients', 'Select at least one recipient');
    users = ids;
  } else if (audience === 'admin') {
    users = db.prepare("SELECT id FROM users WHERE role = 'admin' AND deleted_at = 0").all().map((r) => r.id);
  } else {
    users = db.prepare("SELECT id FROM users WHERE role = 'reseller' AND deleted_at = 0").all().map((r) => r.id);
  }
  let count = 0;
  for (const userId of users) {
    notify.notifyUser(userId, { type: 'broadcast', title, body, link: '/notifications' });
    count += 1;
  }
  db.prepare('INSERT INTO broadcasts (title, body, audience, recipients, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title, body, audience, count, req.user.id, Date.now());
  audit(req, 'broadcast.send', 'broadcast', '', { title, audience, count });
  res.json({ ok: true, data: { recipients: count } });
});

router.get('/broadcasts', auth.requirePerm('broadcasts'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 50').all();
  res.json({
    ok: true,
    data: {
      rows: rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        audience: r.audience,
        recipients: r.recipients,
        createdAt: r.created_at,
      })),
    },
  });
});

// ------------------------------------------------------------------ sync

router.post('/sync', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const result = await monitor.runCycle('manual');
  res.json({ ok: true, data: result });
}));

module.exports = router;

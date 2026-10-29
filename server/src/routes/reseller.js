'use strict';

const express = require('express');
const { getDb } = require('../db');
const auth = require('../auth');
const usersService = require('../services/users');
const inboundsService = require('../services/inbounds');
const configsService = require('../services/configs');
const pricing = require('../services/pricing');
const statsService = require('../services/stats');
const { ApiError, asyncH, bytesToGb, toCsv, pageParams } = require('../utils');

const router = express.Router();
router.use(auth.requireAuth);

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

router.get('/overview', (req, res) => {
  const data = statsService.resellerOverview(req.user.id);
  const discountMap = pricing.discountMap(req.user.id);
  const inbounds = inboundsService
    .listInbounds({ includeHidden: false, allowed: usersService.allowedInboundIds(req.user) })
    .map((row) => ({
      id: row.id,
      remark: row.remark,
      protocol: row.protocol,
      network: row.network,
      port: row.port,
      nodeName: row.nodeName,
      serverName: row.serverName,
      enabled: row.enabled,
      priceFixed: row.priceFixed,
      pricePerGb: row.pricePerGb,
      pricePerDay: row.pricePerDay,
      discountPercent: discountMap.get(row.id) || 0,
    }));
  res.json({ ok: true, data: { ...data, inbounds, billing: pricing.billingInfo() } });
});

router.get('/inbounds', (req, res) => {
  const allowed = usersService.allowedInboundIds(req.user);
  const discountMap = pricing.discountMap(req.user.id);
  const rows = inboundsService.listInbounds({ includeHidden: false, allowed })
    .map((row) => ({ ...row, discountPercent: discountMap.get(row.id) || 0 }));
  res.json({
    ok: true,
    data: {
      rows,
      allowedInbounds: allowed,
      limits: usersService.userStats(req.user.id),
      billing: pricing.billingInfo(),
    },
  });
});

router.post('/configs/quote', (req, res) => {
  const body = req.body || {};
  const allowed = usersService.allowedInboundIds(req.user);
  const ids = (body.inboundIds || (body.inboundId ? [body.inboundId] : []))
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .filter((id) => !allowed || allowed.includes(id));
  const result = pricing.quote({
    userId: req.user.id,
    inboundIds: ids,
    gb: num(body.gb),
    days: num(body.days),
    // Unlimited quotas are an admin-only option; resellers always get a metered plan.
    unlimited: false,
  });
  res.json({ ok: true, data: result });
});

router.get('/configs', (req, res) => {
  const data = configsService.listConfigs(
    {
      inboundId: num(req.query.inboundId, 0),
      status: String(req.query.status || ''),
      search: String(req.query.search || ''),
      expiringDays: num(req.query.expiringDays, 0),
      page: num(req.query.page, 1),
      pageSize: Math.min(100, num(req.query.pageSize, 20)),
    },
    req.user
  );
  res.json({ ok: true, data });
});

router.get('/configs/export.csv', (req, res) => {
  const rows = configsService.exportRows(
    {
      inboundId: num(req.query.inboundId, 0),
      status: String(req.query.status || ''),
      search: String(req.query.search || ''),
    },
    req.user
  );
  const csv = toCsv(
    [
      { label: 'Email', value: 'email' },
      { label: 'Inbound', value: (r) => (r.inbound ? r.inbound.remark : '') },
      { label: 'Label', value: 'label' },
      { label: 'Customer', value: 'customerName' },
      { label: 'Status', value: 'status' },
      { label: 'Total GB', value: 'totalGb' },
      { label: 'Used GB', value: (r) => bytesToGb(r.used) },
      { label: 'Expiry', value: (r) => (r.expiryAt ? new Date(r.expiryAt).toISOString() : 'unlimited') },
    ],
    rows
  );
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="my-configs.csv"').send(csv);
});

router.post('/configs', asyncH(async (req, res) => {
  const body = req.body || {};
  const configs = await configsService.createConfigs(
    {
      userId: req.user.id,
      inboundIds: body.inboundIds || (body.inboundId ? [body.inboundId] : []),
      gb: num(body.gb),
      days: num(body.days),
      label: body.label,
      customerName: body.customerName,
      customerPhone: body.customerPhone,
      note: body.note,
      unlimited: false,
    },
    req
  );
  res.status(201).json({ ok: true, data: { configs } });
}));

router.get('/configs/:id', asyncH(async (req, res) => {
  const { row, config } = configsService.configDetail(num(req.params.id), req.user);
  const links = await configsService.linksFor(row);
  res.json({ ok: true, data: { config, group: configsService.groupFor(row), ...links } });
}));

router.get('/configs/:id/links', asyncH(async (req, res) => {
  const { row, config } = configsService.configDetail(num(req.params.id), req.user);
  const links = await configsService.linksFor(row);
  res.json({ ok: true, data: { config, group: configsService.groupFor(row), ...links } });
}));

router.patch('/configs/:id', asyncH(async (req, res) => {
  const allowed = {};
  for (const key of ['label', 'customerName', 'customerPhone', 'note']) {
    if (req.body?.[key] !== undefined) allowed[key] = req.body[key];
  }
  const config = await configsService.updateMeta(num(req.params.id), allowed, req, req.user);
  res.json({ ok: true, data: { config } });
}));

router.post('/configs/:id/extend', asyncH(async (req, res) => {
  const config = await configsService.extendConfig(
    num(req.params.id),
    {
      gb: num(req.body?.gb),
      days: num(req.body?.days),
      resetUsage: Boolean(req.body?.resetUsage),
    },
    req,
    req.user
  );
  res.json({ ok: true, data: { config } });
}));

router.post('/configs/:id/toggle', asyncH(async (req, res) => {
  const config = await configsService.toggleConfig(num(req.params.id), Boolean(req.body?.enabled), req, req.user);
  res.json({ ok: true, data: { config } });
}));

router.post('/configs/:id/identity', asyncH(async (req, res) => {
  const config = await configsService.updateIdentity(
    num(req.params.id),
    { uuid: req.body?.uuid, subId: req.body?.subId },
    req,
    req.user
  );
  const row = configsService.getConfigRow(config.id);
  const links = await configsService.linksFor(row);
  res.json({ ok: true, data: { config, group: configsService.groupFor(row), ...links } });
}));

router.post('/configs/:id/inbounds', asyncH(async (req, res) => {
  const config = await configsService.addInbound(num(req.params.id), num(req.body?.inboundId), req, req.user);
  res.status(201).json({ ok: true, data: { config } });
}));

router.post('/configs/:id/reset', asyncH(async (req, res) => {
  const config = await configsService.resetUsage(num(req.params.id), req, req.user);
  res.json({ ok: true, data: { config } });
}));

router.delete('/configs/:id', asyncH(async (req, res) => {
  await configsService.removeConfig(num(req.params.id), {}, req, req.user);
  res.json({ ok: true, data: { deleted: true } });
}));

router.get('/stats', (req, res) => {
  const days = Math.min(90, Math.max(1, num(req.query.days, 30)));
  res.json({
    ok: true,
    data: {
      days,
      series: statsService.trafficSeries(days, req.user.id),
      topConfigs: statsService.topConfigs(days, 10, req.user.id),
      inbounds: statsService.inboundBreakdown(req.user.id),
      configs: statsService.statusCounts(req.user.id),
      today: statsService.sumRange(1, req.user.id),
      week: statsService.sumRange(7, req.user.id),
      month: statsService.sumRange(30, req.user.id),
    },
  });
});

router.get('/transactions', (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query, 20, 100);
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?').get(req.user.id).c;
  const rows = db.prepare(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(req.user.id, pageSize, offset);
  res.json({
    ok: true,
    data: {
      total,
      page,
      pageSize,
      balance: Number(req.user.balance || 0),
      rows: rows.map((r) => ({
        id: r.id,
        type: r.type,
        amount: r.amount,
        balanceAfter: r.balance_after,
        description: r.description,
        createdAt: r.created_at,
      })),
    },
  });
});

router.get('/me', (req, res) => {
  res.json({
    ok: true,
    data: {
      user: require('../utils').sanitizeUser(req.user),
      stats: usersService.userStats(req.user.id),
    },
  });
});

module.exports = router;

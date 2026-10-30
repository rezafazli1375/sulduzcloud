'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db');
const usersService = require('../services/users');
const inboundsService = require('../services/inbounds');
const configsService = require('../services/configs');
const statsService = require('../services/stats');
const { ApiError, asyncH, sanitizeUser } = require('../utils');

const router = express.Router();

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.get('x-api-key') || req.user?.id || req.ip || 'anonymous').slice(0, 80),
  message: { ok: false, error: { code: 'rate_limited', message: 'Too many requests' } },
});

router.use(apiLimiter);

router.use(asyncH(async (req, res, next) => {
  const header = String(req.get('x-api-key') || '');
  const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const key = header || bearer;
  if (!key) throw new ApiError(401, 'api_key_required', 'Provide the API key in X-API-Key');
  const user = getDb().prepare('SELECT * FROM users WHERE api_key = ? AND deleted_at = 0').get(key);
  if (!user || user.status !== 'active') throw new ApiError(401, 'invalid_api_key', 'Invalid API key');
  if (user.role !== 'reseller') throw new ApiError(403, 'forbidden', 'API keys are available for reseller accounts');
  req.user = user;
  return next();
}));

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

router.get('/me', (req, res) => {
  res.json({
    ok: true,
    data: {
      user: sanitizeUser(req.user),
      stats: usersService.userStats(req.user.id),
    },
  });
});

router.get('/inbounds', (req, res) => {
  const allowed = usersService.allowedInboundIds(req.user);
  const rows = inboundsService.listInbounds({ includeHidden: false, allowed });
  res.json({ ok: true, data: { rows } });
});

router.get('/configs', (req, res) => {
  const data = configsService.listConfigs(
    {
      status: String(req.query.status || ''),
      search: String(req.query.search || ''),
      inboundId: num(req.query.inboundId, 0),
      page: num(req.query.page, 1),
      pageSize: Math.min(100, num(req.query.pageSize, 20)),
      // API clients work with x-ui clients, so one row per config is expected.
      flat: true,
    },
    req.user
  );
  res.json({ ok: true, data });
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
    },
    req
  );
  res.status(201).json({ ok: true, data: { configs } });
}));

router.get('/configs/:id', asyncH(async (req, res) => {
  const { row, config } = configsService.configDetail(num(req.params.id), req.user);
  const links = await configsService.linksFor(row);
  res.json({ ok: true, data: { config, ...links } });
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

router.delete('/configs/:id', asyncH(async (req, res) => {
  await configsService.removeConfig(num(req.params.id), {}, req);
  res.json({ ok: true, data: { deleted: true } });
}));

router.get('/usage', (req, res) => {
  const days = Math.min(90, Math.max(1, num(req.query.days, 30)));
  res.json({
    ok: true,
    data: {
      days,
      series: statsService.trafficSeries(days, req.user.id),
      today: statsService.sumRange(1, req.user.id),
      week: statsService.sumRange(7, req.user.id),
      month: statsService.sumRange(30, req.user.id),
    },
  });
});

module.exports = router;

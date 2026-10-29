'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const settings = require('../settings');
const { getDb } = require('../db');
const auth = require('../auth');
const usersService = require('../services/users');
const ticketsService = require('../services/tickets');
const notify = require('../notify');
const monitor = require('../services/monitor');
const license = require('../license');
const { ApiError, asyncH, sanitizeUser } = require('../utils');
const { audit } = require('../audit');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: () => {
    try { return Math.max(3, Number(settings.getSetting('security').loginRateLimit || 10)); } catch (_) { return 10; }
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: { code: 'rate_limited', message: 'Too many attempts, try again later' } },
});

function usersCount() {
  return Number(getDb().prepare('SELECT COUNT(*) AS c FROM users WHERE deleted_at = 0').get().c || 0);
}

router.get('/health', (req, res) => {
  res.json({ ok: true, version: config.version, time: Date.now() });
});

router.get('/meta', (req, res) => {
  const csrf = auth.ensureCsrfCookie(req, res);
  res.json({ ok: true, data: { ...settings.publicMeta(), csrf } });
});

// Licence state is public on purpose: the activation screen must be able to
// show the installation id before anybody logs in.
router.get('/license', (req, res) => {
  const state = license.status();
  res.json({
    ok: true,
    data: {
      valid: state.valid,
      reason: state.reason,
      fingerprint: state.fingerprint,
      license: state.license,
      enforced: license.enforced(),
    },
  });
});

router.post('/license/activate', auth.requireAuth, (req, res) => {
  if (req.user.role !== 'admin') throw new ApiError(403, 'forbidden', 'Admin only');
  const result = license.activate(req.body?.license || req.body?.key || '');
  if (!result.ok) throw new ApiError(422, result.reason, 'Activation key was rejected');
  audit(req, 'license.activate', 'license', result.state?.license?.id || '', {});
  res.json({ ok: true, data: { ...result.state } });
});

router.get('/setup/status', (req, res) => {
  res.json({ ok: true, data: { setupRequired: usersCount() === 0 } });
});

router.post('/setup', asyncH(async (req, res) => {
  if (usersCount() > 0) throw new ApiError(403, 'already_setup', 'The panel is already configured');
  const { username, password, name, panelName } = req.body || {};
  const user = usersService.createUser(
    {
      username,
      password,
      name: name || 'Owner',
      role: 'admin',
      status: 'active',
      permissions: ['*'],
      lang: 'fa',
    },
    req
  );
  if (panelName) settings.updateSection('general', { panelName: String(panelName).slice(0, 60) });
  auth.setSessionCookie(res, user, req);
  const csrf = auth.setCsrfCookie(res);
  audit(req, 'setup.complete', 'user', user.id, {});
  res.json({ ok: true, data: { user: sanitizeUser(user), csrf, meta: settings.publicMeta() } });
}));

router.post('/auth/login', loginLimiter, asyncH(async (req, res) => {
  const { username, password } = req.body || {};
  const user = usersService.getUserByUsername(String(username || '').trim());
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    audit({ ...req, user: null }, 'auth.login_failed', 'user', username || '', {});
    throw new ApiError(401, 'invalid_credentials', 'نام کاربری یا رمز عبور نادرست است');
  }
  if (user.status !== 'active') throw new ApiError(403, 'account_disabled', 'این حساب غیرفعال شده است');
  const db = getDb();
  db.prepare('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?')
    .run(Date.now(), String(req.ip || ''), user.id);
  const fresh = usersService.getUser(user.id);
  auth.setSessionCookie(res, fresh, req);
  const csrf = auth.setCsrfCookie(res);
  audit({ ...req, user: fresh }, 'auth.login', 'user', fresh.id, {});
  res.json({ ok: true, data: { user: sanitizeUser(fresh), csrf, meta: settings.publicMeta() } });
}));

router.post('/auth/logout', auth.requireAuth, (req, res) => {
  audit(req, 'auth.logout', 'user', req.user.id, {});
  auth.revokeSession(req.sessionSid);
  auth.clearSessionCookie(res);
  res.clearCookie(auth.CSRF_COOKIE, { path: '/' });
  res.json({ ok: true, data: { loggedOut: true } });
});

router.get('/auth/me', auth.requireAuth, (req, res) => {
  const csrf = auth.ensureCsrfCookie(req, res);
  res.json({ ok: true, data: { user: sanitizeUser(req.user), csrf, meta: settings.publicMeta() } });
});

router.post('/auth/password', auth.requireAuth, asyncH(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!auth.verifyPassword(currentPassword, req.user.password_hash)) {
    throw new ApiError(422, 'wrong_password', 'رمز عبور فعلی نادرست است');
  }
  if (String(newPassword || '').length < 8) throw new ApiError(422, 'weak_password', 'رمز جدید حداقل ۸ کاراکتر باشد');
  const db = getDb();
  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?')
    .run(auth.hashPassword(newPassword), Date.now(), req.user.id);
  const fresh = usersService.getUser(req.user.id);
  auth.setSessionCookie(res, fresh, req);
  audit(req, 'auth.password_change', 'user', req.user.id, {});
  res.json({ ok: true, data: { user: sanitizeUser(fresh) } });
}));

router.patch('/auth/profile', auth.requireAuth, asyncH(async (req, res) => {
  const patch = {};
  for (const key of ['name', 'email', 'phone', 'lang']) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  const user = usersService.updateUser(req.user.id, patch, req);
  res.json({ ok: true, data: { user: sanitizeUser(user) } });
}));

router.post('/auth/api-key', auth.requireAuth, asyncH(async (req, res) => {
  if (req.user.role !== 'reseller') throw new ApiError(403, 'forbidden', 'Only resellers have API keys');
  const result = usersService.regenerateApiKey(req.user.id, req);
  res.json({ ok: true, data: result });
}));

router.get('/notifications', auth.requireAuth, (req, res) => {
  const page = Number(req.query.page || 1);
  const pageSize = Math.min(100, Number(req.query.pageSize || 30));
  const data = notify.listNotifications(req.user.id, {
    page,
    pageSize,
    unreadOnly: req.query.unread === '1',
  });
  res.json({ ok: true, data });
});

router.post('/notifications/read', auth.requireAuth, (req, res) => {
  notify.markRead(req.user.id, req.body?.id || 0);
  res.json({ ok: true, data: { read: true } });
});

router.get('/tickets', auth.requireAuth, (req, res) => {
  const data = ticketsService.listTickets({
    viewer: req.user,
    status: req.query.status || '',
    page: Number(req.query.page || 1),
    pageSize: Math.min(100, Number(req.query.pageSize || 20)),
  });
  res.json({ ok: true, data });
});

router.post('/tickets', auth.requireAuth, (req, res) => {
  const ticket = ticketsService.createTicket(req.body || {}, req);
  res.status(201).json({ ok: true, data: ticket });
});

router.get('/tickets/:id', auth.requireAuth, (req, res) => {
  res.json({ ok: true, data: ticketsService.getTicket(Number(req.params.id), req.user) });
});

router.post('/tickets/:id/reply', auth.requireAuth, (req, res) => {
  const ticket = ticketsService.replyTicket(Number(req.params.id), req.body?.body, req);
  res.json({ ok: true, data: ticket });
});

router.post('/tickets/:id/status', auth.requireAuth, (req, res) => {
  if (req.user.role !== 'admin') throw new ApiError(403, 'forbidden', 'Admin only');
  const ticket = ticketsService.setStatus(Number(req.params.id), String(req.body?.status || ''), req);
  res.json({ ok: true, data: ticket });
});

router.get('/nodes/status', auth.requireAuth, asyncH(async (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT s.* FROM server_status s
     JOIN (SELECT kind, ref_id, MAX(checked_at) AS checked_at FROM server_status GROUP BY kind, ref_id) latest
       ON latest.kind = s.kind AND latest.ref_id = s.ref_id AND latest.checked_at = s.checked_at
     ORDER BY s.kind = 'panel' DESC, s.name ASC`
  ).all();
  const panel = rows.find((r) => r.kind === 'panel');
  const nodes = rows.filter((r) => r.kind === 'node');
  res.json({
    ok: true,
    data: {
      panel: panel
        ? { name: panel.name, status: panel.status, latencyMs: panel.latency_ms, message: panel.message, checkedAt: panel.checked_at }
        : { name: 'Master Panel', status: 'unknown', latencyMs: null, checkedAt: 0 },
      nodes: nodes.map((n) => ({
        id: n.ref_id,
        name: n.name,
        status: n.status,
        latencyMs: n.latency_ms,
        message: n.message,
        checkedAt: n.checked_at,
      })),
      monitor: monitor.status(),
    },
  });
}));

module.exports = router;

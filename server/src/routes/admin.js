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
const transactionsService = require('../services/transactions');
const pricing = require('../services/pricing');
const plansService = require('../services/plans');
const statsService = require('../services/stats');
const backupService = require('../services/backup');
const telegram = require('../services/telegram');
const bot = require('../services/bot');
const topups = require('../services/topups');
const payment = require('../services/payment');
const reports = require('../services/reports');
const monitor = require('../services/monitor');
const cleanupService = require('../services/cleanup');
const ticketsService = require('../services/tickets');
const trashService = require('../services/trash');
const bannerService = require('../services/banner');
const notify = require('../notify');
const xui = require('../xui');
const net = require('../net');
const activation = require('../activation');
const { ApiError, asyncH, sanitizeUser, pageParams, toCsv, bytesToGb, txMoney, TX_TYPES, TX_OUT_TYPES } = require('../utils');
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
      { label: 'Telegram', value: 'telegram_id' },
      { label: 'Status', value: 'status' },
      { label: 'Balance', value: 'balance' },
      { label: 'Created', value: (r) => new Date(r.created_at).toISOString() },
    ],
    rows
  );
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="resellers.csv"').send(csv);
});

router.post('/users', auth.requirePerm('users'), asyncH(async (req, res) => {
  // A name that belongs to a deleted reseller revives that account (see
  // users.createUser), so the UI can say "restored" instead of "created".
  const holder = usersService.usernameHolder((req.body || {}).username);
  const revived = Boolean(holder && holder.deleted_at > 0);
  const user = usersService.createUser(req.body || {}, req);
  // A Telegram id lets the panel adopt subscriptions the reseller already owns
  // on any connected server. Importing never charges the wallet and cannot fail
  // the account creation.
  let imported = null;
  if (String(user.telegram_id || '').trim() && Number(user.import_configs ?? 1) !== 0) {
    try {
      imported = await configsService.importTelegramClients(user, req);
    } catch (err) {
      console.error('[admin] telegram import failed on user create:', err.message);
      imported = { imported: 0, restored: 0, failed: 1, errors: [err.message] };
    }
  }
  res.status(201).json({ ok: true, data: { user: sanitizeUser(user), stats: usersService.userStats(user.id), import: imported, revived } });
}));

router.get('/users/:id', auth.requirePerm('users'), (req, res) => {
  const user = usersService.getUser(num(req.params.id));
  if (!user) throw new ApiError(404, 'not_found', 'User not found');
  const db = getDb();
  const transactions = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(user.id);
  // v1.5.4: the two commission numbers an owner wants when he sets a rate — what
  // this reseller has RECEIVED for referring people, and what his own spending
  // has PAID OUT to whoever brought him. Both are read off the ledger rather than
  // recomputed, so the figures agree with the transactions he can scroll through.
  const earned = db.prepare("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM transactions WHERE user_id = ? AND type = 'commission'").get(user.id);
  const paid = db.prepare(
    'SELECT COALESCE(SUM(t.amount),0) AS s, COUNT(*) AS c FROM transactions t WHERE t.type = ? AND t.user_id = (SELECT referrer_id FROM users WHERE id = ?)'
  ).get('commission', user.id);
  const referrer = Number(user.referrer_id || 0) > 0
    ? db.prepare('SELECT id, username, name FROM users WHERE id = ?').get(Number(user.referrer_id))
    : null;
  res.json({
    ok: true,
    data: {
      user: sanitizeUser(user),
      referrer: referrer ? { id: Number(referrer.id), username: String(referrer.username || ''), name: String(referrer.name || '') } : null,
      commission: {
        earned: Number(earned.s || 0),
        earnedCount: Number(earned.c || 0),
        paidByReferrer: Number(paid.s || 0),
        paidCount: Number(paid.c || 0),
        percent: Number(user.commission_percent || 0),
        fleetPercent: Math.max(0, Math.min(50, Math.round(Number(settings.getSetting('billing').commissionPercent || 0)))),
      },
      stats: usersService.userStats(user.id),
      transactions: transactionsService.presentRows(db, transactions).map((t) => ({
        id: t.id,
        type: t.type,
        // v2.3.0, item 3: one direction rule for every transaction read-out.
        ...txMoney(t),
        configId: t.configId,
        config: t.config,
        balanceAfter: t.balance_after,
        description: t.description,
        createdAt: t.created_at,
      })),
      configs: configsService.listConfigs({ userId: user.id, page: 1, pageSize: 5 }, { role: 'admin' }),
    },
  });
});

router.patch('/users/:id', auth.requirePerm('users'), asyncH(async (req, res) => {
  const before = usersService.getUser(num(req.params.id));
  const user = usersService.updateUser(num(req.params.id), req.body || {}, req);
  // Setting or changing the Telegram id re-runs the adoption pass, so a
  // reseller added before the id was known still gets their subscriptions.
  // Turning the switch back on also fetches them again immediately.
  const idChanged = String(before?.telegram_id || '') !== String(user.telegram_id);
  const enabledNow = Number(user.import_configs ?? 1) !== 0;
  const wasEnabled = Number(before?.import_configs ?? 1) !== 0;
  let imported = null;
  if (String(user.telegram_id || '').trim() && enabledNow && (idChanged || !wasEnabled)) {
    try {
      imported = await configsService.importTelegramClients(user, req);
    } catch (err) {
      console.error('[admin] telegram import failed on user update:', err.message);
      imported = { imported: 0, restored: 0, failed: 1, errors: [err.message] };
    }
  }
  // A fresh fixed inbound usually means the reseller's OLD packages do not
  // carry it yet. Count them (read-only) so the UI can offer the heal with the
  // exact number instead of writing to another panel unexpectedly.
  let fixedInboundPreview = null;
  const fixedId = Number(user.fixed_inbound || 0);
  if (fixedId > 0 && Number(before?.fixed_inbound || 0) !== fixedId) {
    try {
      fixedInboundPreview = await configsService.applyFixedInbound(Number(user.id), { dryRun: true }, req);
    } catch (err) {
      console.error('[admin] fixed inbound preview failed:', err.message);
    }
  }
  res.json({ ok: true, data: { user: sanitizeUser(user), stats: usersService.userStats(user.id), import: imported, fixedInboundPreview } });
}));

router.post('/users/:id/import', auth.requirePerm('users'), asyncH(async (req, res) => {
  const user = usersService.getUser(num(req.params.id));
  if (!user) throw new ApiError(404, 'not_found', 'User not found');
  if (!String(user.telegram_id || '').trim()) {
    throw new ApiError(422, 'telegram_id_required', 'ابتدا شناسه عددی تلگرام این نماینده را ثبت کنید / Set this reseller\'s Telegram ID first');
  }
  if (Number(user.import_configs ?? 1) === 0) {
    throw new ApiError(409, 'import_disabled', 'دریافت کانفیگ‌های قبلی برای این نماینده خاموش است؛ اول روشنش کنید / Previous-config import is switched off for this reseller');
  }
  const result = await configsService.importTelegramClients(user, req);
  res.json({ ok: true, data: result });
}));

// Panel v1.4.16: give every existing package of this reseller their fixed
// inbound. `dryRun` only counts, so the UI can show what will change before the
// panel writes a single client — adopted subscriptions live on another panel and
// their owners are connected, so nothing here happens silently.
router.post('/users/:id/fixed-inbound/apply', auth.requirePerm('users'), asyncH(async (req, res) => {
  const dryRun = req.body?.dryRun === true || String(req.body?.dryRun) === 'true';
  const result = await configsService.applyFixedInbound(num(req.params.id), { dryRun }, req);
  res.json({ ok: true, data: { ...result, dryRun } });
}));

// Panel v1.4.18: merge the packages of this reseller that are spread over more
// than one x-ui client back onto the customer's own client. Only such a package
// needs this panel's aggregated link; a package that is one client is listed by
// the node's own subscription server, which is where the owner wants his
// customers' links to live. `dryRun` only counts: the write attaches the extra
// channels to the client the customer already uses and removes the duplicate
// client THIS panel created — an adopted client is never deleted.
router.post('/users/:id/consolidate', auth.requirePerm('users'), asyncH(async (req, res) => {
  const dryRun = req.body?.dryRun === true || String(req.body?.dryRun) === 'true';
  const result = await configsService.consolidatePackages({ userId: num(req.params.id), dryRun }, req);
  res.json({ ok: true, data: { ...result, dryRun } });
}));

// Panel v1.4.21: the same thing for the OTHER direction — customers whose x-ui
// client is gone from the node panel. `dryRun` only lists them; the write puts
// one client back per package and never touches a package that is switched off.
router.post('/users/:id/recreate-missing', auth.requirePerm('users'), asyncH(async (req, res) => {
  const dryRun = req.body?.dryRun === true || String(req.body?.dryRun) === 'true';
  const result = await configsService.recreateMissingPackages({ userId: num(req.params.id), dryRun }, req);
  res.json({ ok: true, data: { ...result, dryRun } });
}));

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

router.delete('/users/:id', auth.requirePerm('users'), asyncH(async (req, res) => {
  const result = await usersService.deleteUser(
    num(req.params.id),
    { purgeConfigs: String(req.query.purge || '') === '1' },
    req
  );
  res.json({ ok: true, data: result });
}));

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
    // v1.4.25: the build form shows the admin the tariff of a free order, so the
    // quote must say plainly that this money is not going to be taken.
    charge: Boolean(body.charge),
  });
  res.json({ ok: true, data: result });
});

// ---------------------------------------------------------------- plans (v1.5.4)
//
// Ready-made packages the owner prices himself: a volume, a duration, the
// channels he picked and HIS price instead of the tariff. Authoring lives here;
// buying lives on the reseller side, where no route reads a price from the body.

router.get('/plans', auth.requirePerm('configs'), (req, res) => {
  // An admin sees everything by default, including the hidden ones — he is the
  // one who has to notice that a plan points at a channel that no longer exists.
  res.json({ ok: true, data: { plans: plansService.listPlans({ viewer: req.user }) } });
});

router.post('/plans', auth.requirePerm('configs'), (req, res) => {
  const plan = plansService.createPlan(req.body || {}, req);
  res.status(201).json({ ok: true, data: { plan } });
});

router.patch('/plans/:id', auth.requirePerm('configs'), (req, res) => {
  const plan = plansService.updatePlan(num(req.params.id), req.body || {}, req);
  res.json({ ok: true, data: { plan } });
});

router.delete('/plans/:id', auth.requirePerm('configs'), (req, res) => {
  const removed = plansService.deletePlan(num(req.params.id), req);
  res.json({ ok: true, data: removed });
});

// ------------------------------------------------------------------ configs

router.get('/configs', auth.requirePerm('configs'), (req, res) => {
  const data = configsService.listConfigs(
    {
      userId: num(req.query.userId, 0),
      inboundId: num(req.query.inboundId, 0),
      status: String(req.query.status || ''),
      search: String(req.query.search || ''),
      origin: String(req.query.origin || ''),
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
      origin: String(req.query.origin || ''),
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
      { label: 'Origin', value: 'origin' },
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
      // v1.4.25: an admin building a package for a reseller does not spend the
      // reseller's wallet unless he ticks the switch.
      charge: Boolean(body.charge),
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

// v1.5.5, item 4: give one customer to another reseller. The whole package moves,
// so the admin is shown exactly what will move first: dryRun answers with the
// preview and writes nothing, and the button posts the same body with dryRun off.
router.post('/configs/:id/transfer', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const result = await configsService.transferCustomer(
    num(req.params.id),
    {
      toUserId: num(req.body?.toUserId, 0),
      note: String(req.body?.note || ''),
      dryRun: Boolean(req.body?.dryRun),
    },
    req,
    req.user,
  );
  res.json({ ok: true, data: result });
}));

router.post('/configs/:id/extend', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const config = await configsService.extendConfig(
    num(req.params.id),
    {
      gb: num(req.body?.gb),
      days: num(req.body?.days),
      price: num(req.body?.price),
      resetUsage: Boolean(req.body?.resetUsage),
      // v1.4.25: the admin's own tick decides whether the reseller pays. Absent
      // or false means the renewal is free — this route is the only place the
      // flag is ever read, and the reseller route has no equivalent.
      charge: Boolean(req.body?.charge),
    },
    req,
    { role: 'admin' }
  );
  res.json({ ok: true, data: { config } });
}));

// Same read-only renewal price the reseller drawer gets, so an admin renewing on
// behalf of a reseller sees the amount the panel will charge before confirming.
// It answers `charged` for the tick the drawer is showing, so the money on screen
// is the money the wallet will actually see move — and since v1.4.26 the
// `resetUsage` tick is forwarded too, because with it the typed numbers are the
// package's new size and expiry rather than a delta, and the preview has to show
// the same outcome the renewal will write.
router.post('/configs/:id/extend/quote', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const data = configsService.quoteRenewalPrice(
    num(req.params.id),
    {
      gb: num(req.body?.gb),
      days: num(req.body?.days),
      charge: Boolean(req.body?.charge),
      resetUsage: Boolean(req.body?.resetUsage),
    },
    { role: 'admin' },
    req
  );
  res.json({ ok: true, data });
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
  const config = await configsService.addInbound(
    num(req.params.id),
    num(req.body?.inboundId),
    req,
    { role: 'admin' },
    // v1.4.25: adding a channel is free for the reseller unless the admin ticks
    // the charge switch; the heal pass has always been free for its own reason.
    { charge: Boolean(req.body?.charge) }
  );
  res.status(201).json({ ok: true, data: { config } });
}));

router.post('/configs/:id/reset', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const config = await configsService.resetUsage(num(req.params.id), req, { role: 'admin' });
  res.json({ ok: true, data: { config } });
}));

// v1.4.26: the same «رفرش» the reseller drawer got — read the customer back off
// his node and make the panel's copy current. Read-only against x-ui.
router.post('/configs/:id/refresh', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const data = await configsService.refreshPackage(num(req.params.id), req, { role: 'admin' });
  res.json({ ok: true, data });
}));

// Panel v1.4.21: put ONE x-ui client back for a customer whose client was
// deleted on the node panel — same email, UUID and subscription id, every
// channel of the package on it, the reseller's fixed inbound included.
router.post('/configs/:id/recreate', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const result = await configsService.recreatePackageClient(num(req.params.id), req, { role: 'admin' });
  res.json({ ok: true, data: result });
}));

// v2.0.0: «ارسال به تلگرام من» — the QR of the subscription link plus the link
// itself, as ONE message to the caller's own Telegram chat. req.user carries the
// numeric telegram_id from the account row; the body is never trusted for a chat.
router.post('/configs/:id/send-telegram', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const result = await configsService.sendToTelegram(num(req.params.id), req, req.user);
  res.json({ ok: true, data: result });
}));

router.delete('/configs/:id', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const result = await configsService.removeConfig(num(req.params.id), {}, req, { role: 'admin' });
  res.json({
    ok: true,
    data: {
      deleted: true,
      detachedOnly: Boolean(result.detachedOnly),
      inboundDetached: Boolean(result.inboundDetached),
      keptInbounds: Number(result.keptInbounds || 0),
      alreadyGone: Boolean(result.alreadyGone),
    },
  });
}));

// Panel v1.4.24: remove the customer's WHOLE subscription. The single delete above
// refuses to drop the reseller's fixed inbound while the package has other channels
// (that lock is the owner's own rule); this is the case the rule allows — the
// customer goes away entirely. Adopted rows are still only forgotten locally, so
// nothing is ever written to another operator's panel from here.
router.delete('/configs/:id/package', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const result = await configsService.deletePackage(num(req.params.id), req, { role: 'admin' });
  res.json({ ok: true, data: result });
}));

// v2.3.0, item 6: the two bulk paths for everything ticked in the config list.
// `ids` are the config ids of the rows; a customer whose rows were ticked twice
// counts once, and every package then goes through the SAME service the single
// action uses — this route cannot invent its own price or its own delete.
// dryRun answers per package what will happen and which one will fail.
router.post('/configs/bulk-extend', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const result = await configsService.bulkExtendConfigs(
    {
      ids: Array.isArray(req.body?.ids) ? req.body.ids : [],
      gb: num(req.body?.gb),
      days: num(req.body?.days),
      resetUsage: Boolean(req.body?.resetUsage),
      // v1.4.25 rule, unchanged: only an admin's own tick makes the reseller pay.
      charge: Boolean(req.body?.charge),
      dryRun: Boolean(req.body?.dryRun),
    },
    req,
    { role: 'admin' }
  );
  res.json({ ok: true, data: result });
}));

router.post('/configs/bulk-delete', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const result = await configsService.bulkDeletePackages(
    {
      ids: Array.isArray(req.body?.ids) ? req.body.ids : [],
      dryRun: Boolean(req.body?.dryRun),
    },
    req,
    { role: 'admin' }
  );
  res.json({ ok: true, data: result });
}));

// ---------------------------------------------------------------- inbounds

router.get('/inbounds', auth.requirePerm('inbounds'), (req, res) => {
  const statuses = latestStatuses();
  const discountUserId = num(req.query.userId, 0);
  const discountMap = discountUserId ? pricing.discountMap(discountUserId) : null;
  // Opening a reseller's editor or config form passes their id: the fixed
  // inbound of that reseller is flagged so the UI can lock and badge it.
  const fixedInbound = discountUserId
    ? usersService.fixedInboundId(usersService.getUser(discountUserId) || {})
    : 0;
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
      fixed: fixedInbound > 0 && Number(row.id) === fixedInbound,
    };
  });
  res.json({ ok: true, data: { rows, fixedInbound, servers: serversService.listServers().map(serversService.publicShape) } });
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

// v2.3.0, item 3: «منوی کناری یک گزینه تراکنش‌ها». The ledger has always held every
// wallet move — a purchase, a renewal, a top-up, a deduction, a claw-back, a
// commission — but until now it could only be read through a reseller's own wallet
// page or the revenue chart. This is the fleet-wide book: two filters the owner
// asked for (which reseller, which kind of move) plus the direction, because a
// dispute is nearly always "show me everything that left this wallet".
//
// `amount` on every row is the ABSOLUTE number and `direction` says which way it
// moved; the raw column sign is deliberately not exposed (see txMoney in utils.js).
// `actors` is built from the ledger itself so the reseller dropdown never asks for
// a user list this page has no permission to read.
router.get('/transactions', auth.requirePerm('stats'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query, 30, 200);
  const db = getDb();
  const userId = num(req.query.userId, 0);
  const type = TX_TYPES.includes(String(req.query.type || '')) ? String(req.query.type) : '';
  const direction = ['in', 'out'].includes(String(req.query.direction || '')) ? String(req.query.direction) : '';

  const where = [];
  const params = [];
  if (userId > 0) {
    where.push('t.user_id = ?');
    params.push(userId);
  }
  if (type) {
    where.push('t.type = ?');
    params.push(type);
  }
  // Which way the money went is a property of the type, never of the stored sign.
  const outList = [...TX_OUT_TYPES].map((item) => `'${item}'`).join(', ');
  if (direction === 'in') where.push(`t.type NOT IN (${outList})`);
  else if (direction === 'out') where.push(`t.type IN (${outList})`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM transactions t ${clause}`).get(...params).c);
  const rows = db.prepare(
    `SELECT t.*, u.username, c.username AS created_by_name
     FROM transactions t
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN users c ON c.id = t.created_by
     ${clause}
     ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  const byType = {};
  for (const r of db.prepare(`SELECT t.type, COUNT(*) AS n, SUM(ABS(t.amount)) AS sum FROM transactions t ${clause} GROUP BY t.type`).all(...params)) {
    byType[r.type] = { count: Number(r.n), sum: Number(r.sum || 0) };
  }
  const sums = { in: 0, out: 0, countIn: 0, countOut: 0 };
  for (const [kind, v] of Object.entries(byType)) {
    const side = TX_OUT_TYPES.has(kind) ? 'out' : 'in';
    sums[side] += v.sum;
    sums[side === 'out' ? 'countOut' : 'countIn'] += v.count;
  }
  const actors = db.prepare(
    `SELECT u.id, u.username, COUNT(t.id) AS count FROM transactions t
     JOIN users u ON u.id = t.user_id GROUP BY u.id, u.username ORDER BY count DESC, u.username ASC LIMIT 500`
  ).all().map((r) => ({ id: Number(r.id), username: String(r.username || ''), count: Number(r.count) }));

  // v2.3.0, item 5: how many of the filtered lines left a wallet below zero.
  // Counted over the whole filtered set, not just the 30 rows on the page, so the
  // card on the screen is a fact about the ledger and not about pagination.
  const debtClause = `WHERE ${[...where, 't.balance_after < 0'].join(' AND ')}`;
  const debt = Number(db.prepare(`SELECT COUNT(*) AS c FROM transactions t ${debtClause}`).get(...params).c);

  res.json({
    ok: true,
    data: {
      total,
      page,
      pageSize,
      filters: { userId, type, direction },
      byType,
      sums,
      debt,
      actors,
      rows: transactionsService.presentRows(db, rows).map((r) => ({
        id: r.id,
        userId: r.user_id,
        username: r.username || `#${r.user_id}`,
        type: r.type,
        ...txMoney(r),
        configId: r.configId,
        config: r.config,
        balanceAfter: r.balance_after,
        description: r.description,
        createdBy: r.created_by,
        createdByName: String(r.created_by_name || ''),
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
  if (section === 'sms' && clean.events !== undefined) {
    // Only the known notifications, and only their on/off flag: the SMS channel
    // has no other per-event setting since the pattern feature was removed.
    const known = Object.keys(settings.DEFAULTS.sms.events);
    const events = {};
    for (const [event, value] of Object.entries(clean.events || {})) {
      if (!known.includes(event)) continue;
      events[event] = { enabled: value && typeof value === 'object' ? value.enabled !== false : Boolean(value) };
    }
    clean.events = events;
  }
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
  if (section === 'cleanup') {
    // v2.0.0: the sweep's own bookkeeping is written by runCleanup, never by the
    // form — a browser tab must not be able to fake "last ran" and skip a sweep.
    delete clean.lastRunAt;
    delete clean.lastSummary;
    if (clean.graceDays !== undefined) clean.graceDays = Math.min(365, Math.max(0, num(clean.graceDays, 7)));
    if (clean.intervalHours !== undefined) clean.intervalHours = Math.min(168, Math.max(1, num(clean.intervalHours, 6)));
    if (clean.maxPerRun !== undefined) clean.maxPerRun = Math.min(500, Math.max(1, num(clean.maxPerRun, 50)));
    for (const key of ['enabled', 'expired', 'depleted', 'includeExternal', 'notifyReseller']) {
      if (clean[key] !== undefined) clean[key] = Boolean(clean[key]);
    }
    // A schedule switched on with BOTH states off would tick forever and delete
    // nothing — the same dead-switch rule the payment rails follow. Guard on the
    // MERGED row so a partial save (only the switch) respects the stored flags.
    const storedCleanup = settings.getSetting('cleanup');
    const mergedCleanup = { ...storedCleanup, ...clean };
    if (mergedCleanup.enabled && !mergedCleanup.expired && !mergedCleanup.depleted) {
      throw new ApiError(422, 'cleanup_nothing_selected',
        'حداقل یکی از «منقضی‌شده» یا «تمام‌شده» باید انتخاب شود / Pick at least one finished state to sweep');
    }
  }
  if (section === 'telegram') {
    // The nightly report schedule lives in this section, and the same rule that
    // protects the backup hour applies to it: a partial save may not zero it.
    if (clean.dailyReportHour !== undefined) clean.dailyReportHour = Math.min(23, Math.max(0, num(clean.dailyReportHour, 23)));
    if (clean.dailyReportMinute !== undefined) clean.dailyReportMinute = Math.min(59, Math.max(0, num(clean.dailyReportMinute, 0)));
    if (clean.dailyReportDaysAhead !== undefined) clean.dailyReportDaysAhead = Math.min(30, Math.max(1, num(clean.dailyReportDaysAhead, 3)));
    for (const key of ['dailyReportEnabled', 'dailyReportResellers', 'dailyReportOwner']) {
      if (clean[key] !== undefined) clean[key] = Boolean(clean[key]);
    }
    if (clean.dailyReportEnabled === true && !String(clean.botToken || telegram.config().botToken || '').trim()) {
      throw new ApiError(422, 'telegram_not_configured', 'برای گزارش شبانه ابتدا توکن ربات را ذخیره کنید / Save the bot token before switching the nightly report on');
    }
    // v1.5.2: the two-way reseller bot. Same rule as the nightly report — the
    // switch may not be turned on without a token, or it would look alive and
    // answer nothing. The decision chat is optional (empty = the panel chat).
    if (clean.botEnabled !== undefined) clean.botEnabled = Boolean(clean.botEnabled);
    if (clean.botAdminChatId !== undefined) {
      const raw = String(clean.botAdminChatId || '').trim();
      if (raw && !/^-?\d{4,20}$/.test(raw)) {
        throw new ApiError(422, 'telegram_chat_id', 'آیدی عددی چت مدیر معتبر نیست / The admin chat id must be numeric');
      }
      clean.botAdminChatId = raw;
    }
    if (clean.botEnabled === true && !String(clean.botToken || telegram.config().botToken || '').trim()) {
      throw new ApiError(422, 'telegram_not_configured', 'برای ربات نماینده‌ها ابتدا توکن ربات را ذخیره کنید / Save the bot token before switching the reseller bot on');
    }
  }
  if (section === 'billing') {
    // v1.5.4: پورسانت. A percentage is only ever a share of a real charge, so it
    // is bounded where it is written rather than in the payout code: the fleet
    // default can never exceed the cap the owner sets, and neither can go past
    // half the price of a sale. A negative or absurd number here would turn the
    // commission line into a way to inflate wallets.
    if (clean.commissionPercent !== undefined) clean.commissionPercent = Math.min(50, Math.max(0, num(clean.commissionPercent, 0)));
    if (clean.commissionCapPercent !== undefined) clean.commissionCapPercent = Math.min(50, Math.max(0, num(clean.commissionCapPercent, 50)));
  }
  if (section === 'payment') {
    // How money gets INTO a wallet, and whether the panel may release it without a
    // person. Both sides of that need guards, because every field here either talks
    // to a bank or credits one. v1.5.5: two methods left, each with its own switch —
    // فیش واریزی and ZarinPal.
    //
    // A form still open in a browser tab from 1.5.4 posts the retired fields back
    // with every save. They would be dropped on write anyway (updateSection only
    // accepts keys that are in DEFAULTS), but dropping them here keeps them out of
    // the audit entry too, so the log says what the panel actually stored.
    for (const key of settings.RETIRED_PAYMENT_KEYS) delete clean[key];
    if (clean.cards !== undefined) {
      const list = Array.isArray(clean.cards) ? clean.cards : [];
      // normalizeCards drops anything malformed; refusing outright when nothing
      // survived a real submission is more honest than silently saving an empty
      // list and leaving the reseller with no card to pay into.
      const normalized = settings.normalizeCards(list);
      if (list.length && !normalized.length) {
        throw new ApiError(422, 'invalid_cards', 'شماره کارت معتبر نیست (۱۰ تا ۲۴ رقم، بدون حروف) / Card numbers must be 10-24 digits');
      }
      clean.cards = normalized;
    }
    for (const key of ['zarinpalEnabled', 'zarinpalSandbox', 'receiptEnabled', 'autoApproveEnabled', 'autoApproveReceipt']) {
      if (clean[key] !== undefined) clean[key] = Boolean(clean[key]);
    }
    if (clean.zarinpalMerchantId !== undefined) {
      const raw = String(clean.zarinpalMerchantId).trim();
      if (raw && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
        throw new ApiError(422, 'invalid_merchant_id', 'آیدی مرچنت زرین‌پال یک UUID معتبر نیست / The ZarinPal merchant id must be a valid UUID');
      }
      clean.zarinpalMerchantId = raw.toLowerCase();
    }
    if (clean.autoApproveAfterMinutes !== undefined) clean.autoApproveAfterMinutes = Math.min(1440, Math.max(1, num(clean.autoApproveAfterMinutes, 15)));
    if (clean.autoApproveIntervalMinutes !== undefined) clean.autoApproveIntervalMinutes = Math.min(60, Math.max(1, num(clean.autoApproveIntervalMinutes, 1)));
    if (clean.autoApproveMaxAmount !== undefined) clean.autoApproveMaxAmount = Math.min(topups.MAX_AMOUNT, Math.max(0, Math.round(num(clean.autoApproveMaxAmount, 0))));
    if (clean.autoApproveDailyLimit !== undefined) clean.autoApproveDailyLimit = Math.min(100, Math.max(0, Math.round(num(clean.autoApproveDailyLimit, 0))));
    // Guard against saving a half-configured gateway or an unbounded sweep — the
    // same rule the nightly report and the reseller bot follow, one setting
    // section at a time.
    //
    // The merge has to skip a secret the form did not touch, because the form
    // cannot echo it back: /admin/settings hands this tab an empty merchant id every
    // time, with "saved — leaving this empty keeps what is stored" under the box. A
    // plain overlay would put that blank over the real value, and then the first
    // guard below would refuse EVERY later save of this tab — including one that
    // only sets the auto-approval ceiling — with "save the merchant id first".
    // settings.isUnchangedSecret is the same rule updateSection uses to write, so
    // guard and write agree.
    const storedPayment = { ...settings.getSetting('payment') };
    const merged = { ...storedPayment };
    for (const [field, value] of Object.entries(clean)) {
      if (settings.isUnchangedSecret('payment', field, value)) continue;
      merged[field] = value;
    }
    if (merged.zarinpalEnabled && !String(merged.zarinpalMerchantId || '').trim()) {
      throw new ApiError(422, 'zarinpal_not_configured', 'ابتدا آیدی مرچنت زرین‌پال را ذخیره کنید / Save the ZarinPal merchant id before switching the gateway on');
    }
    // His reason for asking for a switch was a button that offered nothing. Flipping
    // فیش واریزی on with no card of his own in the list is exactly that, so it is
    // refused at the switch rather than at the reseller's end. Only when THIS save
    // turns it on: an install that runs receipts-off until he gets round to typing a
    // card must stay savable — and so must the save that takes his last card away
    // while receipts are already running. Reading the stored switch, instead of
    // asking whether the list is empty, is what tells those two apart; the second
    // one lands in `no_cards`, which the rail and the reseller's page both explain.
    const receiptsWereOn = Boolean(storedPayment.receiptEnabled);
    if (clean.receiptEnabled === true && !receiptsWereOn && !(merged.cards || []).length) {
      throw new ApiError(422, 'receipt_not_configured', 'ابتدا حداقل یک شماره کارت برای فیش واریزی ثبت کنید / Add at least one card number before switching receipts on');
    }
    if (merged.autoApproveEnabled && Math.round(Number(merged.autoApproveMaxAmount || 0)) <= 0) {
      throw new ApiError(422, 'auto_approve_ceiling_required',
        'تایید خودکار بدون سقف مبلغ فعال نمی‌شود / Auto-approval needs a maximum amount before it can be switched on');
    }
    if (merged.autoApproveEnabled && !merged.autoApproveReceipt) {
      throw new ApiError(422, 'auto_approve_no_method',
        'تایید خودکار برای فیش واریزی انتخاب نشده است / Switch on auto-approval for deposit receipts');
    }
  }
  if (section === 'security') {
    if (clean.sessionDays !== undefined) clean.sessionDays = Math.min(90, Math.max(1, num(clean.sessionDays, 7)));
    if (clean.loginRateLimit !== undefined) clean.loginRateLimit = Math.min(100, Math.max(3, num(clean.loginRateLimit, 10)));
  }
  if (section === 'smtp' && clean.port !== undefined) clean.port = Math.min(65535, Math.max(1, num(clean.port, 587)));
  if (section === 'general') {
    // v2.1.0: the three network fields the owner asked for. They are not stored
    // text — src/net.js turns them into the socket this panel listens on and the
    // address every subscribe link and payment callback is built from, so they get
    // the same type guards the smtp port has always had, plus a shape check.
    if (clean.panelPort !== undefined) {
      const port = net.clampPort(clean.panelPort);
      if (!port) {
        throw new ApiError(422, 'invalid_panel_port',
          `پورت پنل باید بین ${net.MIN_PORT} و ${net.MAX_PORT} باشد / the panel port must be between ${net.MIN_PORT} and ${net.MAX_PORT}`);
      }
      // Asking for a port somebody else already holds used to be saved first and
      // failed later: the old socket kept answering, so the screen stayed alive,
      // while the stored number guaranteed a service that would not boot. The new
      // port is tried on a throwaway socket here instead, and a busy one is simply
      // refused — nothing is written, and the panel keeps running where it is.
      const busy = await net.probe(port);
      if (!busy.ok) {
        throw new ApiError(422, 'panel_port_busy',
          `پورت ${port} روی این سرور آزاد نیست (${busy.error}) — پنل همچنان روی ${net.describe().port} کار می‌کند / port ${port} is not available on this server (${busy.error}); the panel is still listening on ${net.describe().port}`);
      }
      clean.panelPort = port;
    }
    if (clean.publicUrl !== undefined) {
      const raw = String(clean.publicUrl || '').trim().replace(/\/+$/, '');
      if (raw && !/^https?:\/\/[^\s/?#]+\.[^\s/?#]+/i.test(raw) && !/^https?:\/\/(\d{1,3}\.){3}\d{1,3}(:\d+)?$/i.test(raw)) {
        throw new ApiError(422, 'invalid_public_url',
          'آدرس پنل باید با http:// یا https:// شروع شود و یک میزبان معتبر باشد / the panel address must be a full http(s) URL');
      }
      clean.publicUrl = raw;
    }
    for (const key of ['sslCertPath', 'sslKeyPath']) {
      if (clean[key] === undefined) continue;
      const raw = String(clean[key] || '').trim().slice(0, 300);
      // An absolute path only: the panel would otherwise resolve it against its own
      // working directory, which nobody can read off a settings form.
      if (raw && !raw.startsWith('/')) {
        throw new ApiError(422, 'invalid_cert_path', 'مسیر گواهی باید مطلق باشد (با / شروع شود) / certificate paths must be absolute');
      }
      clean[key] = raw;
    }
    if (clean.sslCertPath !== undefined || clean.sslKeyPath !== undefined) {
      // Half a key pair is the dead-switch case again: HTTPS would silently stay
      // off while the form shows a path in one box. Checked against the merged
      // row, because saving only one of the two boxes is how it happens.
      const merged = { ...settings.getSetting('general'), ...clean };
      if (Boolean(merged.sslCertPath) !== Boolean(merged.sslKeyPath)) {
        throw new ApiError(422, 'cert_pair_incomplete',
          'برای HTTPS هر دو مسیر — کلید عمومی و کلید خصوصی — لازم است / fill both the public key and the private key path');
      }
    }
  }
  if (section === 'banner') {
    // v2.1.0: the owner's notice bar. Normalised over the MERGED row so a partial
    // save (flipping the switch only) keeps the text and the audience he already
    // set, and so the stored shape is always what services/banner.js reads.
    const merged = { ...settings.getSetting('banner'), ...clean };
    const next = bannerService.normalize(merged);
    if (clean.enabled === true && !next.text) {
      throw new ApiError(422, 'banner_empty', 'متن بنر خالی است / write the message before switching the banner on');
    }
    if (clean.enabled === true && next.targets === 'selected' && !next.userIds.length) {
      throw new ApiError(422, 'banner_no_audience',
        'هیچ نماینده‌ای انتخاب نشده است / pick at least one reseller, or choose «همهٔ نمایندگان»');
    }
    if (next.startsAt && next.endsAt && next.endsAt <= next.startsAt) {
      throw new ApiError(422, 'banner_window', 'پایان بازهٔ نمایش قبل از شروع آن است / the banner window ends before it starts');
    }
    clean.enabled = next.enabled;
    clean.text = next.text;
    clean.tone = next.tone;
    clean.targets = next.targets;
    if (clean.userIds !== undefined) clean.userIds = next.userIds;
    if (clean.startsAt !== undefined) clean.startsAt = next.startsAt;
    if (clean.endsAt !== undefined) clean.endsAt = next.endsAt;
  }
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
  // v2.1.0: the network fields are not decoration — the saved port, address and
  // certificate paths are applied to the live listener here. net.apply() opens the
  // new socket BEFORE it closes the old one, so a port somebody else is holding,
  // or a key file this user cannot read, leaves the panel answering on the socket
  // it is answering on now. That outcome is reported to the form rather than
  // thrown, because the settings themselves did save.
  let netResult = null;
  if (section === 'general') netResult = await net.apply();
  // The banner tab picks people by name, so the saved ids come back resolved:
  // «۳ نماینده» with the names under it, and an account that has since been
  // deleted stays in the list and is flagged instead of silently dropping out.
  let bannerAudience = null;
  if (section === 'banner') bannerAudience = bannerService.audience(saved);
  res.json({
    ok: true,
    data: { section, saved: settings.redactSection(section, saved), xuiTest, net: netResult, audience: bannerAudience },
  });
}));

// ------------------------------------------------------ v2.1.0: listener + gate
//
// One read for the settings tab: what socket the panel is really on (which can
// differ from what the form says when a move failed), whether HTTPS took, and the
// activation state with the male key of THIS install.

router.get('/system', auth.requirePerm('settings'), (req, res) => {
  res.json({ ok: true, data: { net: net.describe(), activation: activation.status() } });
});

// --------------------------------------------------------- v2.1.0: the Trash
//
// Every package this panel deleted left a snapshot here (services/trash.js), with
// the email, uuid and subscription token it had and how much time and volume were
// still unused. Listing and reading it needs the same permission as the configs
// themselves; putting one back calls x-ui, so it is a real create and is audited
// as `config.trash_restore`.

router.get('/trash', auth.requirePerm('configs'), (req, res) => {
  const { page, pageSize } = pageParams(req.query, 25, 200);
  const data = trashService.listTrash({
    q: String(req.query.q || ''),
    userId: Number(req.query.userId || 0),
    mode: String(req.query.mode || ''),
    includeRestored: req.query.includeRestored === '1',
    page,
    pageSize,
  });
  res.json({ ok: true, data });
});

router.get('/trash/:id', auth.requirePerm('configs'), (req, res) => {
  res.json({ ok: true, data: trashService.detail(Number(req.params.id)) });
});

router.post('/trash/:id/restore', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const body = req.body || {};
  const data = await trashService.restore(Number(req.params.id), {
    userId: Number(body.userId || 0),
    inboundIds: Array.isArray(body.inboundIds) ? body.inboundIds.map(Number) : null,
    keepUsageWindow: Boolean(body.keepUsageWindow),
    req,
  });
  res.json({ ok: true, data });
}));

router.delete('/trash/:id', auth.requirePerm('configs'), (req, res) => {
  res.json({ ok: true, data: trashService.purge(Number(req.params.id), req) });
});

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

// --------------------------------------------------- nightly telegram report

router.get('/reports/daily', auth.requirePerm('settings'), (req, res) => {
  const cfg = reports.reportConfig();
  const tg = telegram.config();
  res.json({
    ok: true,
    data: {
      schedule: cfg,
      botConfigured: Boolean(cfg.botToken),
      panelChatConfigured: Boolean(cfg.panelChatId),
      telegramEnabled: tg.enabled,
      recipients: reports.recipients().map((row) => ({
        userId: Number(row.id),
        username: row.username,
        name: row.name || '',
        telegramId: String(row.telegram_id || ''),
      })),
      withoutTelegramId: getDb().prepare(
        "SELECT COUNT(*) AS c FROM users WHERE role = 'reseller' AND status = 'active' AND deleted_at = 0 AND telegram_id = ''"
      ).get().c,
      history: reports.history(30),
    },
  });
});

// The preview is the honest way to read the message before anything is sent: it
// runs the same code the nightly timer runs, and writes nothing.
router.get('/reports/daily/:userId/preview', auth.requirePerm('settings'), (req, res) => {
  res.json({ ok: true, data: reports.preview(Number(req.params.userId)) });
});

router.post('/reports/daily/send', auth.requirePerm('settings'), asyncH(async (req, res) => {
  const body = req.body || {};
  const userId = Number(body.userId || 0);
  if (userId) {
    const built = reports.preview(userId);
    if (!built.telegramId) throw new ApiError(422, 'telegram_id_required', 'ابتدا شناسه عددی تلگرام این نماینده را ثبت کنید / No Telegram ID is saved for this reseller');
    await telegram.sendMessageTo(built.telegramId, built.text);
    reports.recordSend(userId, 'reseller', built.day, built.telegramId, true, '', built.stats);
    audit(req, 'report.daily_send', 'user', userId, { day: built.day, chatId: built.telegramId });
    return res.json({ ok: true, data: { sent: 1, failed: 0, results: [{ userId, username: built.username, chatId: built.telegramId, sent: true }] } });
  }
  const summary = await reports.sendDaily({ force: Boolean(body.force) });
  audit(req, 'report.daily_send_all', 'settings', 'daily_report', {
    day: summary.day, sent: summary.sent, failed: summary.failed, skipped: summary.skipped,
  });
  return res.json({ ok: true, data: summary });
}));

router.post('/reports/daily/reset', auth.requirePerm('settings'), (req, res) => {
  const day = String(req.body?.day || '');
  getDb().prepare('DELETE FROM daily_reports WHERE day = ?').run(day);
  audit(req, 'report.daily_reset', 'settings', 'daily_report', { day });
  res.json({ ok: true, data: { day } });
});

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

// ------------------------------------------- v1.5.2: wallet receipts (top-ups)

router.get('/topups', auth.requirePerm('users'), (req, res) => {
  const data = topups.listRequests({
    status: String(req.query.status || ''),
    userId: num(req.query.userId, 0),
    // v1.5.4: which way the money came, and whether a person or the schedule
    // decided it. Both are optional; anything unknown is refused by the service.
    method: String(req.query.method || ''),
    decision: String(req.query.decision || ''),
    page: num(req.query.page, 1),
    pageSize: num(req.query.pageSize, 30),
  });
  res.json({ ok: true, data: { ...data, bot: bot.status() } });
});

router.get('/topups/:id', auth.requirePerm('users'), (req, res) => {
  res.json({ ok: true, data: { request: topups.getRequest(num(req.params.id, 0)) } });
});

// The receipt picture itself, proxied through the panel so the admin can judge
// it here as well as in Telegram. Only the file_id stored on the row is ever
// fetched, the bot token stays server-side, and nothing is cached in the browser.
router.get('/topups/:id/receipt', auth.requirePerm('users'), asyncH(async (req, res) => {
  const request = topups.getRequest(num(req.params.id, 0));
  if (!request.fileId) throw new ApiError(404, 'no_receipt', 'این درخواست فشی ندارد / This request has no receipt file');
  const file = await telegram.fetchFile(request.fileId);
  audit(req, 'topup.receipt_view', 'topup', request.id, { kind: request.fileKind });
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Disposition', `inline; filename="receipt-${request.id}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(file.buffer);
}));

router.post('/topups/:id/approve', auth.requirePerm('users'), asyncH(async (req, res) => {
  const body = req.body || {};
  const result = topups.approve(
    num(req.params.id, 0),
    {
      amount: body.amount === undefined || body.amount === null || body.amount === '' ? undefined : num(body.amount, 0),
      note: String(body.note || ''),
      actor: { id: req.user.id, role: 'admin' },
      source: 'panel',
    },
    req
  );
  // Take the buttons away from the Telegram copy too, so the same receipt cannot
  // be decided twice from two places. The money is already committed.
  bot.syncAdminMessage(result, 'approved', req.user.username).catch(() => {});
  res.json({ ok: true, data: { request: result } });
}));

router.post('/topups/:id/reject', auth.requirePerm('users'), asyncH(async (req, res) => {
  const result = topups.reject(
    num(req.params.id, 0),
    { note: String(req.body?.note || ''), actor: { id: req.user.id, role: 'admin' }, source: 'panel' },
    req
  );
  bot.syncAdminMessage(result, 'rejected', req.user.username).catch(() => {});
  res.json({ ok: true, data: { request: result } });
}));

// v2.3.0, item 4: void a receipt the owner only recognised as fake or duplicated
// after it was paid out — the auto-approval sweep makes that a real case. The
// amount the row credited is taken back through the same wallet function the
// panel and the bot use, so the ledger, the balance and the audit trail all match
// a manual deduction. Only an 'approved' row can be reversed, once.
router.post('/topups/:id/reverse', auth.requirePerm('users'), asyncH(async (req, res) => {
  const result = topups.reverse(
    num(req.params.id, 0),
    { note: String(req.body?.note || ''), actor: { id: req.user.id, role: 'admin' }, source: 'panel' },
    req
  );
  bot.syncAdminMessage(result, 'reversed', req.user.username).catch(() => {});
  res.json({ ok: true, data: { request: result } });
}));

// v1.5.4: run the scheduled auto-approval by hand. The owner asked for a
// schedule, and the schedule runs on its own timer (src/index.js); this endpoint
// exists so he can see what the sweep WOULD do before he leaves money to it
// overnight, and so a switch he just changed takes effect without waiting for
// the next tick. Same function, same guards, same ledger — the only difference
// is who pushed the button.
router.post('/topups/auto-approve/run', auth.requirePerm('users'), (req, res) => {
  const summary = topups.runAutoApprove();
  for (const item of summary.results || []) {
    if (!item.approved) continue;
    const row = topups.getRequest(item.id);
    if (row?.fileId || row?.source === 'bot') {
      bot.syncAdminMessage(row, 'approved', 'تایید خودکار').catch(() => {});
    }
  }
  audit(req, 'topup.auto_approve_run', 'topup', '', summary);
  res.json({ ok: true, data: summary });
});

// ---- v2.0.0: scheduled cleanup of finished subscriptions --------------------
// The preview runs the exact sweep with dryRun — nothing is written, not even
// the depleted stamp — so the owner reads tonight's deletions before they exist.
// The manual run is the same function the timer calls, for right after a save.
router.get('/cleanup/preview', auth.requirePerm('settings'), asyncH(async (req, res) => {
  const summary = await cleanupService.runCleanup({ dryRun: true });
  res.json({ ok: true, data: summary });
}));

router.post('/cleanup/run', auth.requirePerm('settings'), asyncH(async (req, res) => {
  const summary = await cleanupService.runCleanup();
  res.json({ ok: true, data: summary });
}));

// What the payment methods look like from the reseller's side, with the same
// reasons the panel gives: not what is switched on, but WHY something is off.
router.get('/payment/status', auth.requirePerm('settings'), (req, res) => {
  const methods = payment.methods();
  const cfg = settings.getSetting('payment');
  res.json({
    ok: true,
    data: {
      methods,
      autoApprove: {
        switch: Boolean(cfg.autoApproveEnabled),
        ...payment.autoApprove(),
        intervalMinutes: Math.min(60, Math.max(1, Number(cfg.autoApproveIntervalMinutes) || 1)),
      },
      pending: topups.listRequests({ status: 'pending', page: 1, pageSize: 1 }).counts,
    },
  });
});

// The bot's own health: is it polling, did another consumer take the token, and
// where do receipts go. A restart is offered because a 409 Conflict stops the
// poller for good — after the owner removes the other consumer he needs a way to
// bring it back without SSH.
router.get('/bot', auth.requirePerm('settings'), (req, res) => {
  const cfg = telegram.botConfig();
  // v1.5.3: the owner's card shows the same link the reseller panel offers, plus
  // the keyboard he is supposed to see. cachedBotUsername() never waits on
  // Telegram: an empty name here means the poller has not introduced itself yet.
  const name = bot.cachedBotUsername();
  res.json({
    ok: true,
    data: {
      ...bot.status(),
      hasToken: Boolean(cfg.botToken),
      adminChatId: cfg.adminChatId,
      botName: name,
      topupLink: bot.deepLink('topup', name),
      commands: Boolean(name),
      pending: topups.listRequests({ status: 'pending', page: 1, pageSize: 1 }).counts.pending,
    },
  });
});

router.post('/bot/restart', auth.requirePerm('settings'), asyncH(async (req, res) => {
  bot.stop();
  const started = await bot.start();
  audit(req, 'bot.restart', 'settings', 'telegram', started);
  res.json({ ok: true, data: { ...started, status: bot.status() } });
}));

// ------------------------------- v1.5.2: find a client on x-ui and adopt it

// Just the enabled nodes, for the search page's filter. /admin/servers also
// probes CPU/RAM on every panel and needs the servers permission — neither is
// wanted here.
router.get('/nodes', auth.requirePerm('configs'), (req, res) => {
  res.json({
    ok: true,
    data: {
      rows: serversService.listServers({ includeDisabled: false })
        .map((server) => ({ id: Number(server.id), name: String(server.name || '') })),
    },
  });
});

router.get('/node-clients', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const data = await configsService.searchNodeClients({
    q: String(req.query.q || ''),
    serverId: num(req.query.serverId, 0),
    // v1.5.8: no route-level cap of its own — the service default (a whole node's
    // worth of hits) applies unless the caller names a limit.
    limit: num(req.query.limit, 0),
    // v2.0.0: advanced filters. The service validates every enum itself, so the
    // route only forwards what the browser sent.
    field: String(req.query.field || 'all'),
    status: String(req.query.status || ''),
    ownership: String(req.query.ownership || ''),
    inboundId: num(req.query.inboundId, 0),
    quota: String(req.query.quota || ''),
    expiringDays: num(req.query.expiringDays, 0),
    sortBy: String(req.query.sortBy || ''),
    sortDir: String(req.query.sortDir || 'asc'),
  });
  res.json({ ok: true, data });
}));

router.post('/configs/adopt', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const body = req.body || {};
  const result = await configsService.adoptNodeClient(
    {
      email: String(body.email || ''),
      userId: num(body.userId, 0),
      serverId: num(body.serverId, 0),
      label: String(body.label || ''),
      customerName: String(body.customerName || ''),
      customerPhone: String(body.customerPhone || ''),
      note: String(body.note || ''),
    },
    req,
    req.user
  );
  res.status(201).json({ ok: true, data: result });
}));

// v1.5.6: the same hand-over for everything the admin ticked on the search page.
// One item per client, each decided by the adopt/transfer guards it already had;
// dryRun answers with the per-item plan and writes nothing.
router.post('/configs/bulk-assign', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const body = req.body || {};
  const result = await configsService.bulkAssignNodeClients(
    {
      // v1.5.8: no silent slice here — a truncated batch is the same lie as a
      // truncated search. The service dedupes and refuses anything over its own
      // ceiling (BULK_ASSIGN_LIMIT) with a named 422.
      items: Array.isArray(body.items) ? body.items : [],
      toUserId: num(body.toUserId ?? body.userId, 0),
      note: String(body.note || ''),
      label: String(body.label || ''),
      customerName: String(body.customerName || ''),
      customerPhone: String(body.customerPhone || ''),
      dryRun: Boolean(body.dryRun),
    },
    req,
    req.user,
  );
  res.json({ ok: true, data: result });
}));

// ------------------------------------------------------------------ sync

router.post('/sync', auth.requirePerm('configs'), asyncH(async (req, res) => {
  const result = await monitor.runCycle('manual');
  res.json({ ok: true, data: result });
}));

module.exports = router;

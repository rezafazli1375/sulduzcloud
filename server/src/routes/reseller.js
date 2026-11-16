'use strict';

const express = require('express');
const { getDb } = require('../db');
const auth = require('../auth');
const usersService = require('../services/users');
const inboundsService = require('../services/inbounds');
const configsService = require('../services/configs');
const pricing = require('../services/pricing');
const statsService = require('../services/stats');
const topups = require('../services/topups');
const payment = require('../services/payment');
const plansService = require('../services/plans');
const settings = require('../settings');
const telegram = require('../services/telegram');
const bot = require('../services/bot');
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
  const fixedId = usersService.fixedInboundId(req.user);
  const discountMap = pricing.discountMap(req.user.id);
  let rows = inboundsService.listInbounds({ includeHidden: false, allowed })
    .map((row) => ({ ...row, discountPercent: discountMap.get(row.id) || 0, fixed: Number(row.id) === fixedId }));
  // The fixed inbound is this reseller's guaranteed base, so the create form
  // must always be able to show and lock it — even if it is hidden from the
  // general list or was left out of an explicit allow list.
  if (fixedId > 0 && !rows.some((row) => Number(row.id) === fixedId)) {
    const fixed = inboundsService.listInbounds({ includeHidden: true }).find((row) => Number(row.id) === fixedId);
    if (fixed) {
      rows = [{ ...fixed, discountPercent: discountMap.get(fixed.id) || 0, fixed: true }, ...rows];
    }
  }
  res.json({
    ok: true,
    data: {
      rows,
      allowedInbounds: allowed,
      fixedInbound: fixedId,
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
  // Mirror createConfigs: the fixed inbound always joins the package, so the
  // quoted price must already include it instead of surprising the reseller.
  const fixedId = usersService.fixedInboundId(req.user);
  if (ids.length && fixedId > 0 && !ids.includes(fixedId)) ids.unshift(fixedId);
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
      origin: String(req.query.origin || ''),
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
      origin: String(req.query.origin || ''),
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
      { label: 'Origin', value: 'origin' },
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
  const { row, config } = configsService.detailView(num(req.params.id), req.user);
  const links = await configsService.linksFor(row);
  res.json({ ok: true, data: { config, group: configsService.groupFor(row), ...links } });
}));

router.get('/configs/:id/links', asyncH(async (req, res) => {
  const { row, config } = configsService.detailView(num(req.params.id), req.user);
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
  // No `charge` is forwarded here on purpose (v1.4.25): a reseller is always
  // charged for his own customer, and the service only ever reads the flag for an
  // admin viewer — so a reseller session posting {"charge": false} changes nothing.
  // `resetUsage` IS forwarded: since v1.4.26 it is a renewal MODE (the typed size
  // and days become the package) and it is charged like any other renewal, so it
  // is not a way to reach the free reset this route no longer offers.
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

// The renewal dialog shows the price before the reseller applies it. It answers
// whether or not wallet billing is switched on — the reseller is entitled to know
// the amount of a renewal he is about to confirm. Since v1.4.26 it also answers
// the OUTCOME (`current` / `result`), because with the reset tick the numbers he
// types are not a delta: the drawer must show what the package will BE.
router.post('/configs/:id/extend/quote', (req, res) => {
  const data = configsService.quoteRenewalPrice(
    num(req.params.id),
    { gb: num(req.body?.gb), days: num(req.body?.days), resetUsage: Boolean(req.body?.resetUsage) },
    req.user
  );
  res.json({ ok: true, data });
});

router.post('/configs/:id/toggle', asyncH(async (req, res) => {
  const config = await configsService.toggleConfig(num(req.params.id), Boolean(req.body?.enabled), req, req.user);
  res.json({ ok: true, data: { config } });
}));

router.post('/configs/:id/identity', asyncH(async (req, res) => {
  await configsService.updateIdentity(
    num(req.params.id),
    { uuid: req.body?.uuid, subId: req.body?.subId },
    req,
    req.user
  );
  const { row, config } = configsService.detailView(num(req.params.id), req.user);
  const links = await configsService.linksFor(row);
  res.json({ ok: true, data: { config, group: configsService.groupFor(row), ...links } });
}));

// v1.4.29: adding a channel to a customer this reseller already has costs him
// nothing — he paid for the shared quota and expiry when he built the package,
// and the new inbound adds neither. No `charge` is forwarded, and the service
// would ignore it from a reseller session anyway.
router.post('/configs/:id/inbounds', asyncH(async (req, res) => {
  const config = await configsService.addInbound(num(req.params.id), num(req.body?.inboundId), req, req.user);
  res.status(201).json({ ok: true, data: { config } });
}));

// v1.4.26: the free traffic reset is gone from the reseller panel. The route is
// kept as a door that clearly refuses, instead of a 404 that would make a stale
// browser tab look like a server fault — the service answers 403 `reset_forbidden`
// with the way out in the message (renew with the reset tick, which is charged).
router.post('/configs/:id/reset', asyncH(async (req, res) => {
  const config = await configsService.resetUsage(num(req.params.id), req, req.user);
  res.json({ ok: true, data: { config } });
}));

// The button that took the reset's place: re-read this customer from his node and
// put the node's own counters into the panel's copy. x-ui is only READ — no write,
// no restart, nothing that could hurt the customer.
router.post('/configs/:id/refresh', asyncH(async (req, res) => {
  const data = await configsService.refreshPackage(num(req.params.id), req, req.user);
  res.json({ ok: true, data });
}));

// Panel v1.4.21: the customer's x-ui client was deleted on the node panel, so
// every link 404s and the package cannot even take a new channel. This puts ONE
// client back — the same email, UUID and subscription id, with every channel of
// the package on it, the reseller's fixed inbound included.
router.post('/configs/:id/recreate', asyncH(async (req, res) => {
  const result = await configsService.recreatePackageClient(num(req.params.id), req, req.user);
  res.json({ ok: true, data: result });
}));

router.delete('/configs/:id', asyncH(async (req, res) => {
  const result = await configsService.removeConfig(num(req.params.id), {}, req, req.user);
  // detachedOnly  — an adopted row: nothing was written to the other panel.
  // inboundDetached — the channel came off the customer's own x-ui client and he
  // stays connected through his other inbounds; the UI has to say so.
  res.json({
    ok: true,
    data: {
      deleted: true,
      detachedOnly: Boolean(result.detachedOnly),
      inboundDetached: Boolean(result.inboundDetached),
      keptInbounds: Number(result.keptInbounds || 0),
    },
  });
}));

// Panel v1.4.24: the reseller's own way to end a customer's subscription. Taking
// the fixed inbound off a package that still has other channels is refused by
// design (that is the guaranteed base of the package), so the drawer needs the one
// action the rule allows: remove everything at once. A reseller can only ever
// reach his own customers — configDetail() checks the owner before anything runs.
router.delete('/configs/:id/package', asyncH(async (req, res) => {
  const result = await configsService.deletePackage(num(req.params.id), req, req.user);
  res.json({ ok: true, data: result });
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

// v1.5.2: his own payment receipts, sent through the Telegram bot, and what the
// admin decided. Only his rows, and never the Telegram file ids or the admin's
// chat — those belong to the panel side of the flow.
router.get('/topups', (req, res) => {
  const data = topups.listRequests({
    userId: req.user.id,
    status: String(req.query.status || ''),
    page: num(req.query.page, 1),
    pageSize: num(req.query.pageSize, 20),
  });
  res.json({
    ok: true,
    data: {
      total: data.total,
      counts: data.counts,
      balance: Number(req.user.balance || 0),
      rows: data.rows.map((row) => ({
        id: row.id,
        amount: row.amount,
        status: row.status,
        caption: row.caption,
        decisionNote: row.decisionNote,
        decidedAt: row.decidedAt,
        source: row.source,
        createdAt: row.createdAt,
      })),
    },
  });
});

// v1.5.3: the header chip asks for nothing but his own wallet, every ~20 seconds
// and on every tab that comes back to the foreground. req.user is re-read from
// the users row on each request (auth middleware), so this number is as live as
// the bot's «موجودی» button — and after the admin charges him in Telegram the
// panel shows the new balance without him reloading anything. `pending` is the
// same count the receipt page shows, so «در انتظار تایید» never disagrees.
router.get('/balance', (req, res) => {
  res.json({
    ok: true,
    data: {
      balance: Number(req.user.balance || 0),
      currency: String(settings.getSetting('billing').currency || 'تومان'),
      pending: topups.pendingCount(req.user.id),
      updatedAt: Date.now(),
    },
  });
});

// v1.5.3: «افزایش موجودی از طریق ربات تلگرام». The link is a /start deep link, so
// tapping it opens THIS chat with this bot and lands the reseller straight in the
// receipt conversation — the button the owner asked for. The username comes from
// the bot's own getMe, cached in bot_state by the poller: when the poller is off
// (or Telegram did not answer yet) the link is empty and the card says so
// honestly instead of offering a broken t.me/… URL. No secret is exposed here:
// a bot username is public information.
router.get('/bot', asyncH(async (req, res) => {
  const name = await bot.botUsername();
  const cfg = telegram.botConfig();
  res.json({
    ok: true,
    data: {
      enabled: Boolean(cfg.enabled),
      botName: name,
      link: bot.deepLink('topup', name),
      receiptsLink: bot.deepLink('receipts', name),
      balanceLink: bot.deepLink('balance', name),
    },
  });
}));

// --------------------------------------- v1.5.4: how a wallet gets filled
//
// Four ways in, and they are NOT the same kind of thing (services/payment.js
// spells out why): the card numbers and the بلو link are things the reseller acts
// on OUTSIDE this panel, so all the panel can record is his claim; ZarinPal is the
// one route that can come back with proof of a real payment. Every path here
// therefore ends in the same topup_requests table with the same rules — a pending
// row, capped amount, the admin or the schedule deciding — and only topups.approve()
// moves money. That is deliberate: two different screens offering two different
// "pay now" buttons must not be able to credit the same order twice.

router.get('/payments/methods', (req, res) => {
  res.json({ ok: true, data: payment.methods() });
});

// The owner's prepared بلو link, with this reseller's amount filled in. Nothing is
// written here: opening a link is not a payment, and a row for it would put an
// unpaid claim in front of the admin. He comes back with /payments/claim once the
// bank has actually taken the money, and quotes the tracking code he was shown.
router.get('/payments/blue', (req, res) => {
  const amount = topups.cleanAmount(num(req.query.amount, 0));
  const link = payment.blueLinkFor(amount);
  res.json({ ok: true, data: { ...link, currency: String(settings.getSetting('billing').currency || 'تومان') } });
});

// A claim: «I paid» — by receipt, card-to-card, or through the بلو link.
router.post('/payments/claim', asyncH(async (req, res) => {
  const body = req.body || {};
  const method = topups.cleanMethod(body.method);
  if (method === 'zarinpal') {
    throw new ApiError(422, 'use_gateway',
      'پرداخت آنلاین از طریق درگاه انجام می‌شود، نه این فرم / Pay online through the gateway instead of this form');
  }
  const request = topups.createRequest({
    userId: req.user.id,
    amount: num(body.amount, 0),
    method,
    cardNumber: String(body.cardNumber || ''),
    reference: String(body.reference || ''),
    caption: String(body.note || '').slice(0, 1000),
    source: 'panel',
    paidAt: num(body.paidAt, 0),
  });
  res.status(201).json({
    ok: true,
    data: {
      request: {
        id: request.id, amount: request.amount, status: request.status,
        method: request.method, methodLabel: request.methodLabel,
        reference: request.reference, cardNumber: request.cardNumber, createdAt: request.createdAt,
      },
      pending: topups.pendingCount(req.user.id),
      balance: Number(req.user.balance || 0),
    },
  });
}));

// ZarinPal step 1 — and the only step that talks to a bank.
//
// The row is created BEFORE the gateway is asked, so there is something for the
// callback to come back to, and the amount the reseller is billed for is the
// amount written down here rather than a number a later request can bring with
// it. The authority ZarinPal returns becomes the row's reference, which is the
// only thing the callback is allowed to identify a payment by.
router.post('/payments/zarinpal/start', asyncH(async (req, res) => {
  const amount = topups.cleanAmount(num(req.body?.amount, 0));
  const zp = payment.zarinpal();
  if (!zp.enabled) {
    throw new ApiError(409, 'zarinpal_disabled', 'پرداخت آنلاین در این پنل فعال نیست / Online payment is not enabled on this panel');
  }
  const request = topups.createRequest({
    userId: req.user.id, amount, method: 'zarinpal', source: 'panel',
    caption: 'پرداخت آنلاین زرین‌پال',
  });
  let start = null;
  try {
    start = await payment.zarinpalRequest({
      amount,
      description: `شارژ کیف پول نماینده ${req.user.username} #${request.id}`,
      mobile: String(req.user.phone || ''),
      email: String(req.user.email || ''),
      orderId: request.id,
    });
  } catch (err) {
    // The gateway said no, so nothing was billed and nothing may linger: the row
    // is rejected rather than left as a pending claim nobody paid. The reason is
    // kept in the decision note, which is exactly what the admin would ask.
    topups.reject(request.id, { note: `درگاه: ${String(err?.message || err).slice(0, 200)}`, actor: null, source: 'gateway' });
    throw err;
  }
  topups.setReference(request.id, start.authority);
  res.json({
    ok: true,
    data: {
      topupId: request.id,
      amount: request.amount,
      rial: start.rial,
      authority: start.authority,
      paymentUrl: start.paymentUrl,
      sandbox: zp.sandbox,
    },
  });
}));

// The reseller's own gateway orders, so the wallet page can say "this one is
// still with the bank" without guessing from a pending count.
router.get('/payments/orders', (req, res) => {
  const data = topups.listRequests({ userId: req.user.id, page: num(req.query.page, 1), pageSize: num(req.query.pageSize, 20) });
  res.json({
    ok: true,
    data: {
      total: data.total,
      counts: data.counts,
      balance: Number(req.user.balance || 0),
      rows: data.rows.map((row) => ({
        id: row.id,
        amount: row.amount,
        status: row.status,
        method: row.method,
        methodLabel: row.methodLabel,
        reference: row.reference,
        cardNumber: row.cardNumber,
        autoApproved: row.autoApproved,
        decidedAt: row.decidedAt,
        decisionNote: row.decisionNote,
        createdAt: row.createdAt,
      })),
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.5.4 — پلن‌های آماده. The owner writes the plan (volume, days, channels and
// HIS price); the reseller only ever picks one by id. That is why no route here
// reads a price, a gb, a days or an inbound list from the body: the numbers come
// from the plans row, and the only field the client controls is which plan.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/plans', (req, res) => {
  res.json({ ok: true, data: { plans: plansService.listPlans({ viewer: req.user }) } });
});

// What this plan costs me, what the tariff would have cost, and whether my
// wallet covers it. Read-only — the drawer shows it before any money moves.
router.post('/plans/quote', asyncH(async (req, res) => {
  const data = plansService.quote(num(req.body?.planId, 0), req.user);
  res.json({ ok: true, data });
}));

// Buy a plan for a NEW customer. The customer fields are the reseller's; the
// package and the price are the owner's.
router.post('/plans/new', asyncH(async (req, res) => {
  const body = req.body || {};
  const data = await plansService.applyNew(
    {
      planId: num(body.planId, 0),
      customerName: body.customerName,
      customerPhone: body.customerPhone,
      label: body.label,
      note: body.note,
    },
    req
  );
  res.status(201).json({ ok: true, data });
}));

// Buy a plan for an EXISTING customer: his usage and expiry are reset and the
// plan is applied to him from scratch — the owner's wording, implemented by the
// v1.4.26 replace-renewal inside configs.extendConfig.
router.post('/plans/renew', asyncH(async (req, res) => {
  const body = req.body || {};
  const data = await plansService.applyRenew({ planId: num(body.planId, 0), configId: num(body.configId, 0) }, req);
  res.json({ ok: true, data });
}));

// The renewal drawer needs the customer's CURRENT numbers next to the plan's, so
// it can say what changes instead of what gets added.
router.post('/plans/renew/preview', asyncH(async (req, res) => {
  const { row } = configsService.detailView(num(req.body?.configId, 0), req.user);
  const data = plansService.renewalPreview(num(req.body?.planId, 0), row, req.user);
  res.json({ ok: true, data });
}));

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

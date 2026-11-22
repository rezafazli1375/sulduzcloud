'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const settings = require('../settings');
const { getDb } = require('../db');
const auth = require('../auth');
const usersService = require('../services/users');
const serversService = require('../services/servers');
const ticketsService = require('../services/tickets');
const topups = require('../services/topups');
const payment = require('../services/payment');
const xui = require('../xui');
const notify = require('../notify');
const monitor = require('../services/monitor');
const banner = require('../services/banner');
const activation = require('../activation');
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

// Key guessing gets its own, much tighter, budget than login: there are five real
// answers, so a few hundred tries an hour changes the odds for nobody.
const activationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: { code: 'rate_limited', message: 'Too many attempts, try again in an hour' } },
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

router.get('/setup/status', (req, res) => {
  res.json({ ok: true, data: { setupRequired: usersCount() === 0 } });
});

// ------------------------------------------------ v2.1.0: activation gate
//
// The owner's condition for letting a stranger run this panel: the install shows
// one MALE key and stays locked until the matching FEMALE half is typed. This is
// the only way in — src/index.js answers 423 for every other API call while the
// gate is up, and `/meta`, `/health` and `/activation` itself stay open so the
// screen that asks can be drawn.
//
// Only the male id and the hash of the female half are in the shipped code
// (src/activation.js); the keys themselves are the owner's, which is why an
// install cannot be unlocked by reading the repository.

router.get('/activation', (req, res) => {
  res.json({ ok: true, data: activation.status() });
});

router.post('/activation', activationLimiter, asyncH(async (req, res) => {
  const key = String((req.body || {}).key || '').trim();
  if (!key) throw new ApiError(422, 'key_required', 'کلید فعال‌سازی را وارد کنید / enter the activation key');
  const result = activation.activate(key, { source: 'web' });
  if (!result.ok) {
    audit({ ...req, user: null }, 'activation.failed', 'activation', result.male, {});
    throw new ApiError(403, 'activation_invalid', 'این کلید فعالسازی با سریال این نصب سازگار نیست / this activation key does not match the serial of this install');
  }
  audit({ ...req, user: null }, 'activation.success', 'activation', result.male, {});
  res.json({ ok: true, data: { ...activation.status(), unlocked: true } });
}));

// ------------------------------------------------ v2.1.0: the owner's banner
//
// One small read: the shell asks it on load and every minute, because a message
// about an outage that only appears after a refresh is a message nobody gets.
// null means "show nothing" — switched off, no text, outside its window, or this
// account is not one of the ones the owner picked.

router.get('/banner', auth.requireAuth, (req, res) => {
  res.json({ ok: true, data: banner.forUser(req.user, settings.getSetting('banner')) });
});

router.post('/setup', asyncH(async (req, res) => {
  if (usersCount() > 0) throw new ApiError(403, 'already_setup', 'The panel is already configured');
  // v1.5.4: the brand name is NOT taken from this form any more. The owner asked
  // that his name survive somebody else's install, so the panel is called what
  // src/brand.js says and a setup POST — or the settings screen behind it — has
  // no way to rename it. Anything sent as panelName is simply not read.
  const { username, password, name } = req.body || {};
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

// ------------------------------------------------------------- subscriptions
// One aggregated subscription per customer package. x-ui 3.2.5+ rejects a
// subId shared by two clients (`subId already in use`), so a multi-inbound
// package cannot be served by the x-ui subscription server. The group token
// (configs.sub_id) is unguessable and acts like an x-ui sub URL: no session.
const subCache = new Map();
const SUB_CACHE_MS = 60 * 1000;

router.get('/sub/:token', asyncH(async (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(token)) throw new ApiError(404, 'not_found', 'Subscription not found');
  const db = getDb();
  const rows = db.prepare(
    `SELECT c.* FROM configs c LEFT JOIN inbounds i ON i.id = c.inbound_id
     WHERE c.sub_id = ? AND c.deleted_at = 0
     ORDER BY COALESCE(i.sub_sort_index, 0), c.inbound_id`
  ).all(token);
  if (!rows.length) throw new ApiError(404, 'not_found', 'Subscription not found');

  // The package is one shared pool: every member row carries the same limit and
  // the latest expiry wins. Client apps read these numbers from the
  // `subscription-userinfo` header.
  //
  // Usage depends on HOW MANY x-ui clients stand behind the package. A package the
  // panel created itself has one client per inbound, so the pool fills up only when
  // the counters of all those clients are added together. A subscription adopted
  // from another panel is ONE client attached to several inbounds, and the panel
  // stores it as one row per inbound — every row carrying the same live counters.
  // Summing those would multiply the customer's usage by his inbound count, so each
  // client contributes its own highest row (same rule as the panel's own lists).
  const perClient = new Map();
  for (const row of rows) {
    const key = String(row.email || '') || `id:${row.id}`;
    const seen = perClient.get(key) || { up: 0, down: 0 };
    perClient.set(key, {
      up: Math.max(seen.up, Number(row.up_bytes || 0)),
      down: Math.max(seen.down, Number(row.down_bytes || 0)),
    });
  }
  const quota = rows.reduce((max, row) => Math.max(max, Number(row.total_bytes || 0)), 0);
  const upload = [...perClient.values()].reduce((sum, item) => sum + item.up, 0);
  const download = [...perClient.values()].reduce((sum, item) => sum + item.down, 0);
  const expireAt = rows.reduce((max, row) => Math.max(max, Number(row.expiry_at || 0)), 0);
  const userinfoHeader = `upload=${upload}; download=${download}; total=${quota}; expire=${expireAt > 0 ? Math.floor(expireAt / 1000) : 0}`;

  const applyHeaders = (target) => {
    target.set('Cache-Control', 'no-store');
    target.set('subscription-userinfo', userinfoHeader);
    target.set('profile-update-interval', '12');
    const site = String(settings.getSetting('general').website || config.publicUrl || '').trim();
    if (site) target.set('profile-web-page-url', site.replace(/\/+$/, ''));
  };

  const cached = subCache.get(token);
  if (cached && Date.now() - cached.at < SUB_CACHE_MS) {
    applyHeaders(res);
    return res.type('text/plain').send(cached.body);
  }

  const links = [];
  // x-ui answers with EVERY link that client has, so the fetch is per client and not
  // per row: an adopted customer on three inbounds is three rows of one client, and
  // asking three times would hand the app nine links, six of them duplicates. A row
  // the reseller switched off is still skipped, but a disabled row never hides the
  // client from a sibling that is enabled.
  const fetched = new Set();
  for (const row of rows) {
    if (!row.enabled) continue;
    const key = `${Number(row.server_id || 0)}|${String(row.email)}`;
    if (fetched.has(key)) continue;
    fetched.add(key);
    try {
      const server = serversService.resolveServer(row.server_id || 0);
      links.push(...await xui.clientLinks(row.email, server));
    } catch (err) {
      console.error(`[sub] link fetch failed for ${row.email}:`, err.message);
    }
  }
  if (subCache.size > 1000) subCache.clear();
  const body = Buffer.from([...new Set(links)].join('\n'), 'utf8').toString('base64');
  subCache.set(token, { at: Date.now(), body });
  applyHeaders(res);
  return res.type('text/plain').send(body);
}));

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

// ------------------------------------------- v1.5.4: ZarinPal's callback
//
// This is the one URL in the panel a stranger can hit with no session, so what
// it is allowed to do is deliberately tiny. The reseller lands here from the
// bank with ?Authority=…&Status=OK, and that query string proves nothing —
// anybody can type it. The ONLY thing that credits a wallet is the server-to-server
// verify for that authority, which ZarinPal answers yes to at most once. No
// authority, no row, no money: an unknown authority has nothing to verify
// against, and a row that is no longer pending has already been paid into.
//
// The page is self-contained HTML on purpose. This is the last screen a payer
// sees, sometimes on a connection that just bounced through a bank's redirect,
// and it must render even if the SPA failed to load.

function paymentPage(req, res, { status, title, lines, tone = 'info', link = '/wallet', linkLabel = 'بازگشت به کیف پول' }) {
  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const meta = settings.publicMeta();
  const langDir = 'rtl';
  const accent = tone === 'ok' ? '#16a34a' : tone === 'warn' ? '#d97706' : '#64748b';
  const csrf = auth.ensureCsrfCookie(req, res);
  res.status(status).type('html').send(`<!doctype html>
<html lang="fa" dir="${langDir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(meta.panelName)} — ${esc(title)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1120;
    font:14px/1.9 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;color:#e2e8f0}
  .card{width:min(92vw,460px);background:#111827;border:1px solid #1f2937;border-radius:16px;
    padding:22px 20px;text-align:center}
  .dot{width:54px;height:54px;border-radius:50%;background:${accent};display:grid;place-items:center;
    margin:0 auto 14px;font-size:26px;color:#fff}
  h1{margin:0 0 6px;font-size:17px}
  p{margin:0 0 8px;color:#94a3b8}
  ul{list-style:none;margin:10px 0 0;padding:0;text-align:right;color:#cbd5e1}
  li{background:#0b1120;border:1px solid #1f2937;border-radius:10px;padding:8px 12px;margin-bottom:6px;word-break:break-all}
  li b{color:#e2e8f0;font-weight:600}
  a{display:inline-block;margin-top:16px;background:#2563eb;color:#fff;text-decoration:none;
    border-radius:10px;padding:10px 18px;font-weight:600}
  .brand{margin-top:14px;color:#475569;font-size:12px}
</style>
</head>
<body>
  <main class="card">
    <div class="dot">${tone === 'ok' ? '✓' : tone === 'warn' ? '!' : 'i'}</div>
    <h1>${esc(title)}</h1>
    <ul>${lines.map((line) => `<li>${esc(line.label)}: <b>${esc(line.value)}</b></li>`).join('')}</ul>
    <a href="${esc(link)}">${esc(linkLabel)}</a>
    <div class="brand">${esc(meta.panelName)} ${esc(config.version)}</div>
  </main>
</body>
</html>`);
}

router.get('/payments/zarinpal/callback', asyncH(async (req, res) => {
  const authority = String(req.query.Authority || req.query.authority || '').trim();
  const bankStatus = String(req.query.Status || req.query.status || '').trim().toUpperCase();
  if (!authority) {
    return paymentPage(req, res, {
      status: 400, tone: 'warn', title: 'کد پرداخت نامشخص است',
      lines: [{ label: 'وضعیت', value: 'هیچ شناسه‌ای در آدرس بازگشت نبود' }],
    });
  }
  const row = topups.findByReference(authority);
  if (!row) {
    // Nothing in this panel was ever ordered under this authority. Say so and pay
    // nothing — the honest answer, and the one that cannot be argued with.
    return paymentPage(req, res, {
      status: 404, tone: 'warn', title: 'درخواست پرداخت پیدا نشد',
      lines: [{ label: 'کد پیگیری', value: authority }, { label: 'نتیجه', value: 'هیچ سفارشی با این کد ثبت نشده است' }],
    });
  }
  if (row.status !== 'pending') {
    return paymentPage(req, res, {
      status: 200, tone: row.status === 'approved' ? 'ok' : 'warn',
      title: row.status === 'approved' ? 'این پرداخت قبلاً ثبت شده است' : 'این درخواست بسته شده است',
      lines: [
        { label: 'شماره درخواست', value: `#${Number(row.id)}` },
        { label: 'مبلغ', value: Number(row.amount).toLocaleString('en-US') },
        { label: 'وضعیت', value: row.status === 'approved' ? 'تایید و شارژ شده' : 'رد شده' },
      ],
    });
  }
  // The bank says the payer left the page. Whether he actually paid is a question
  // only verify() can answer, so a NAK here costs nothing and stops the call.
  if (bankStatus && bankStatus !== 'OK') {
    return paymentPage(req, res, {
      status: 200, tone: 'warn', title: 'پرداخت انجام نشد',
      lines: [
        { label: 'شماره درخواست', value: `#${Number(row.id)}` },
        { label: 'مبلغ', value: Number(row.amount).toLocaleString('en-US') },
        { label: 'وضعیت', value: 'در بانک لغو شد — هیچ مبلغی شارژ نشده است' },
      ],
    });
  }
  let proof = null;
  try {
    proof = await payment.zarinpalVerify({ authority, amount: Number(row.amount) });
  } catch (err) {
    console.error('[zarinpal] verify failed:', err?.message || err);
    return paymentPage(req, res, {
      status: 502, tone: 'warn', title: 'استعلام از بانک ممکن نشد',
      lines: [
        { label: 'شماره درخواست', value: `#${Number(row.id)}` },
        { label: 'مبلغ', value: Number(row.amount).toLocaleString('en-US') },
        { label: 'وضعیت', value: 'درخواست شما در صف مانده و پشتیبانی آن را بررسی می‌کند' },
      ],
    });
  }
  if (!proof.ok) {
    // ZarinPal did not confirm the money (code != 100, or the authority was
    // already settled elsewhere). The row stays pending on purpose: a human looks
    // at it, and the reseller is told the truth instead of a fake failure.
    return paymentPage(req, res, {
      status: 200, tone: 'warn', title: 'پرداخت تایید نشد',
      lines: [
        { label: 'شماره درخواست', value: `#${Number(row.id)}` },
        { label: 'مبلغ', value: Number(row.amount).toLocaleString('en-US') },
        { label: 'کد بانک', value: proof.code || 'نامشخص' },
        { label: 'وضعیت', value: 'مبلغی شارژ نشده است؛ با پشتیبانی تماس بگیرید' },
      ],
    });
  }
  let credited = null;
  try {
    credited = topups.approve(Number(row.id), {
      // No actor: the gateway proved the payment, the panel's own status lock
      // keeps this idempotent, and the ref_id is recorded as the receipt number.
      actor: null,
      source: 'gateway',
      reference: proof.refId,
      paidAt: Date.now(),
      note: `درگاه زرین‌پال — ref_id ${proof.refId}${proof.cardPan ? ` — کارت ${String(proof.cardPan).slice(-4)}` : ''}`,
    });
  } catch (err) {
    if (err?.code === 'already_decided') {
      return paymentPage(req, res, {
        status: 200, tone: 'ok', title: 'این پرداخت قبلاً ثبت شده است',
        lines: [{ label: 'شماره درخواست', value: `#${Number(row.id)}` }],
      });
    }
    console.error('[zarinpal] credit failed:', err?.message || err);
    return paymentPage(req, res, {
      status: 500, tone: 'warn', title: 'شارژ کیف پول انجام نشد',
      lines: [
        { label: 'شماره درخواست', value: `#${Number(row.id)}` },
        { label: 'کد پیگیری بانک', value: proof.refId },
        { label: 'وضعیت', value: 'پول از بانک آمده ولی شارژ ثبت نشده — با پشتیبانی تماس بگیرید' },
      ],
    });
  }
  return paymentPage(req, res, {
    status: 200, tone: 'ok', title: 'پرداخت موفق — کیف پول شارژ شد',
    lines: [
      { label: 'شماره درخواست', value: `#${Number(row.id)}` },
      { label: 'مبلغ شارژ شده', value: Number(credited.credited ?? row.amount).toLocaleString('en-US') },
      { label: 'موجودی جدید', value: Number(credited.balance ?? 0).toLocaleString('en-US') },
      { label: 'کد پیگیری بانک', value: proof.refId },
    ],
  });
}));

module.exports = router;

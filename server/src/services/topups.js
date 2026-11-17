'use strict';

/**
 * Wallet top-up requests (v1.5.2, payment methods added in v1.5.4).
 *
 * A reseller sends his payment receipt through the Telegram bot; the admin sees
 * the picture with two buttons and decides. This module owns the row and the
 * money, so the bot, the admin API, the panel's own list, the gateway callback and
 * the auto-approval sweep all go through the same rules:
 *
 *   - the wallet moves ONLY on 'pending' → 'approved', inside one transaction
 *     with the status change, so a double tap cannot credit twice — which is also
 *     what keeps a gateway callback and an admin's button from paying the same
 *     order twice;
 *   - the amount is a positive integer, capped, and the admin may correct it
 *     before approving (the receipt is what he is really approving);
 *   - every decision is audited and the reseller is notified in the panel;
 *   - an automated decision is audited as the system, never as an admin, because
 *     a sweep that credits a wallet has no person behind it to take the credit
 *     (or the blame).
 *
 * Nothing here talks to Telegram: the bot layer delivers the messages, this layer
 * owns the data. That keeps the whole flow testable without a network.
 */

const { getDb } = require('../db');
const usersService = require('./users');
const payment = require('./payment');
const { ApiError, pageParams } = require('../utils');
const { audit } = require('../audit');
const { notifyUser, notifyAdmins } = require('../notify');

// A receipt is a human decision, not an API: the cap only exists so a typo
// ("50000000000") cannot empty or inflate a wallet by accident.
const MAX_AMOUNT = 1_000_000_000;
const MAX_PENDING_PER_USER = 10;
const STATUSES = ['pending', 'approved', 'rejected'];

// Every way money comes in, since v1.5.5: a deposit receipt a person (or the
// schedule) settles, and a gateway order ZarinPal settles itself. 1.5.4 also offered
// کارت به کارت and a بلو link and the owner asked for both to go — they are no longer
// creatable, `cleanMethod` refuses them, but a row already in the table keeps its
// Persian label, because withdrawing the method and rewriting his wallet history are
// two different things and he only asked for one.
const METHODS = ['receipt', 'zarinpal'];
const LEGACY_METHODS = ['card', 'blue'];
const METHOD_LABEL = {
  receipt: 'فیش واریزی',
  card: 'کارت به کارت',
  zarinpal: 'زرین‌پال',
  blue: 'بلو بانک',
};
// What the admin list may be filtered by: the live methods and, for old data, the
// retired ones.
const FILTER_METHODS = [...METHODS, ...LEGACY_METHODS];

function cleanMethod(value) {
  const method = String(value || 'receipt').trim().toLowerCase();
  if (LEGACY_METHODS.includes(method)) {
    throw new ApiError(422, 'method_removed',
      'این روش پرداخت از پنل حذف شده است؛ فیش واریزی یا درگاه آنلاین را انتخاب کنید / This payment method has been removed from the panel');
  }
  if (!METHODS.includes(method)) {
    throw new ApiError(422, 'invalid_method', `روش پرداخت ناشناخته است / Unknown payment method: ${method}`);
  }
  return method;
}

function cleanReference(value) {
  // A bank tracking code, a ZarinPal authority, a ref_id. Kept as visible ASCII
  // digits/letters so the admin can read it off the screen and search for it.
  return String(value || '').replace(/\s+/g, '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 64);
}

function cleanAmount(value) {
  const amount = Math.round(Number(value || 0));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError(422, 'invalid_amount', 'مبلغ باید عدد مثبت باشد / Amount must be a positive number');
  }
  if (amount > MAX_AMOUNT) {
    throw new ApiError(422, 'amount_too_large', `مبلغ بیش از حد مجاز است (حداکثر ${MAX_AMOUNT}) / Amount exceeds the allowed maximum`);
  }
  return amount;
}

function rowOf(id) {
  return getDb().prepare('SELECT * FROM topup_requests WHERE id = ?').get(Number(id));
}

function view(row, extra = {}) {
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    amount: Number(row.amount || 0),
    status: String(row.status || 'pending'),
    fileKind: String(row.file_kind || ''),
    fileId: String(row.file_id || ''),
    caption: String(row.caption || ''),
    chatId: String(row.chat_id || ''),
    messageId: Number(row.message_id || 0),
    adminChatId: String(row.admin_chat_id || ''),
    adminMessageId: Number(row.admin_message_id || 0),
    decidedBy: Number(row.decided_by || 0),
    decidedAt: Number(row.decided_at || 0),
    decisionNote: String(row.decision_note || ''),
    source: String(row.source || 'bot'),
    method: String(row.method || 'receipt'),
    methodLabel: METHOD_LABEL[String(row.method || 'receipt')] || String(row.method || 'receipt'),
    reference: String(row.reference || ''),
    cardNumber: String(row.card_number || ''),
    paidAt: Number(row.paid_at || 0),
    autoApproved: Number(row.auto_approved || 0) === 1,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    ...extra,
  };
}

function pendingCount(userId) {
  return getDb()
    .prepare("SELECT COUNT(*) AS c FROM topup_requests WHERE user_id = ? AND status = 'pending'")
    .get(Number(userId)).c;
}

/**
 * Record a receipt. The file itself stays on Telegram's servers — only its
 * file_id is kept, which is what lets the admin be shown the same picture
 * without this panel storing anybody's banking document.
 */
function createRequest({
  userId, amount, fileKind = '', fileId = '', caption = '', chatId = '', messageId = 0, source = 'bot',
  method = 'receipt', reference = '', cardNumber = '', paidAt = 0,
} = {}) {
  const db = getDb();
  const user = db.prepare('SELECT id, username, status, deleted_at FROM users WHERE id = ?').get(Number(userId));
  if (!user || user.deleted_at) throw new ApiError(404, 'user_not_found', 'Reseller not found');
  const value = cleanAmount(amount);
  if (pendingCount(user.id) >= MAX_PENDING_PER_USER) {
    throw new ApiError(429, 'too_many_pending',
      'درخواست‌های در انتظار شما زیاد است؛ صبر کنید مدیر بررسی کند / Too many pending receipts — wait for the admin to review them');
  }
  const kind = cleanMethod(method);
  // v1.5.5: the owner's switch. A wallet with فیش واریزی turned off takes no
  // receipts — from the panel or from the bot, because both come through here.
  if (kind === 'receipt' && !payment.receipt().enabled) {
    throw new ApiError(409, 'receipt_disabled',
      'ثبت فیش واریزی در این پنل غیرفعال است / Deposit receipts are disabled on this panel');
  }
  const card = String(cardNumber || '').replace(/\D/g, '').slice(0, 24);
  // A claim that names one of the owner's own cards must name a real one: a typo
  // would otherwise send the money to a card nobody is watching, and the admin
  // would be deciding between a receipt and a number that never existed.
  if (card && kind !== 'zarinpal') {
    const known = payment.cards();
    if (known.length && !known.some((entry) => entry.number === card)) {
      throw new ApiError(422, 'unknown_card', 'این شماره کارت در پنل تعریف نشده است / This card number is not one of the panel\'s');
    }
  }
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO topup_requests (user_id, amount, status, file_kind, file_id, caption, chat_id, message_id,
      admin_chat_id, admin_message_id, decided_by, decided_at, decision_note, source,
      method, reference, card_number, paid_at, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, '', 0, 0, 0, '', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Number(user.id), value, String(fileKind || ''), String(fileId || ''), String(caption || '').slice(0, 1000),
    String(chatId || ''), Number(messageId) || 0, String(source || 'bot'),
    kind, cleanReference(reference), card, Number(paidAt) || 0, now, now
  );
  const id = Number(info.lastInsertRowid);
  audit(null, 'topup.request', 'topup', id, {
    userId: Number(user.id), amount: value, source: String(source || 'bot'), method: kind, card,
  });
  return view(rowOf(id), { username: user.username });
}

function listRequests({
  status = '', userId = 0, method = '', decision = '', page = 1, pageSize = 30,
} = {}) {
  const db = getDb();
  const { pageSize: limit, offset } = pageParams({ page, pageSize }, 30, 100);
  const where = [];
  const params = [];
  const wanted = String(status || '').trim();
  if (wanted) {
    if (!STATUSES.includes(wanted)) throw new ApiError(422, 'invalid_status', 'Unknown status');
    where.push('t.status = ?');
    params.push(wanted);
  }
  if (Number(userId) > 0) { where.push('t.user_id = ?'); params.push(Number(userId)); }
  // v1.5.4: the payment method and who decided are filters, not decoration. A
  // gateway order has to be findable apart from a photo of a receipt, and the
  // nightly sweep tells the admin to review "the auto ones" by hand afterwards.
  const wantedMethod = String(method || '').trim().toLowerCase();
  if (wantedMethod) {
    if (!FILTER_METHODS.includes(wantedMethod)) {
      throw new ApiError(422, 'invalid_method', `روش پرداخت ناشناخته است / Unknown payment method: ${wantedMethod}`);
    }
    where.push('t.method = ?');
    params.push(wantedMethod);
  }
  const wantedDecision = String(decision || '').trim().toLowerCase();
  if (wantedDecision === 'auto') where.push('t.auto_approved = 1');
  else if (wantedDecision === 'manual') where.push('t.auto_approved = 0');
  else if (wantedDecision) {
    throw new ApiError(422, 'invalid_decision', 'نوع تصمیم ناشناخته است / Unknown decision filter');
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM topup_requests t ${clause}`).get(...params).c;
  const rows = db.prepare(
    `SELECT t.*, u.username, u.balance, d.username AS decided_by_name
       FROM topup_requests t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN users d ON d.id = t.decided_by
       ${clause} ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const counts = { pending: 0, approved: 0, rejected: 0 };
  // The counters follow the same scope as the list: a reseller asking for his own
  // receipts must never learn how many the whole fleet has sent — and once the
  // admin filters by method, a tab that still counts the other methods lies to him.
  for (const row of db.prepare(`SELECT t.status, COUNT(*) AS c FROM topup_requests t ${clause} GROUP BY t.status`).all(...params)) {
    counts[row.status] = Number(row.c);
  }
  return {
    total,
    counts,
    rows: rows.map((row) => view(row, {
      username: String(row.username || ''),
      balance: Number(row.balance || 0),
      decidedByName: String(row.decided_by_name || ''),
    })),
  };
}

function getRequest(id) {
  const row = rowOf(id);
  if (!row) throw new ApiError(404, 'not_found', 'Top-up request not found');
  const user = getDb().prepare('SELECT username, balance FROM users WHERE id = ?').get(Number(row.user_id)) || {};
  return view(row, { username: String(user.username || ''), balance: Number(user.balance || 0) });
}

/**
 * Approve a request and credit the wallet. `actor` is { id, role } — the admin
 * who tapped the button, whether he did it in Telegram, in the panel, or through
 * a gateway callback. `auto: true` marks the row as decided by the schedule,
 * which is a different thing in the book and on the admin's screen.
 *
 * The status update is the lock: it only matches a row that is still pending, so
 * two taps (or a tap and a gateway callback at the same moment) produce one credit
 * and one clear "already decided" answer.
 */
function approve(id, { amount, note = '', actor = null, source = 'panel', auto = false, reference = '', paidAt = 0 } = {}, req) {
  const db = getDb();
  const row = rowOf(id);
  if (!row) throw new ApiError(404, 'not_found', 'Top-up request not found');
  if (row.status !== 'pending') {
    throw new ApiError(409, 'already_decided',
      `این درخواست قبلاً ${row.status === 'approved' ? 'تایید' : 'رد'} شده است / This request was already decided`);
  }
  // The admin may correct the number on the receipt; the reseller's own claim is
  // only the default.
  const value = amount === undefined || amount === null || amount === '' ? Number(row.amount) : cleanAmount(amount);
  const now = Date.now();
  const adminId = Number(actor?.id || 0);
  const kind = String(row.method || 'receipt');
  const label = METHOD_LABEL[kind] || METHOD_LABEL.receipt;
  // Where the decision came from, spelled out for the ledger, because a reseller
  // reading his book months later must be able to tell a gateway payment from a
  // receipt he sent in Telegram.
  const via = auto ? ' (تایید خودکار)' : source === 'bot' ? ' (ربات تلگرام)' : source === 'gateway' ? ' (درگاه)' : '';
  const description = `شارژ کیف پول از ${label} #${Number(row.id)}${via}`;
  // A sweep has no admin behind it, so it must not be recorded as one.
  const actorReq = req || (auto || source === 'gateway' ? { user: null } : { user: { id: adminId, role: 'admin' } });
  // A gateway row already carries its AUTHORITY (that is how the callback found
  // it), and the proof of payment is a DIFFERENT number — the ref_id. Keeping
  // both, authority first, is what lets the admin trace one order through both
  // ZarinPal screens a month later. Overwriting would have thrown away the only
  // handle the request itself was made under.
  const given = cleanReference(reference);
  const stored = cleanReference(row.reference);
  const ref = !given ? stored : !stored || given === stored ? given : `${stored} / ${given}`.slice(0, 64);
  let result = null;
  const tx = db.transaction(() => {
    const changed = db.prepare(
      `UPDATE topup_requests SET status = 'approved', amount = ?, decided_by = ?, decided_at = ?,
        decision_note = ?, source = CASE WHEN source = 'bot' THEN 'bot' ELSE ? END,
        auto_approved = ?, paid_at = ?, reference = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    ).run(
      value, adminId, now, String(note || '').slice(0, 500), String(source || 'panel'),
      auto ? 1 : 0, Number(paidAt) || now, ref, now, Number(row.id)
    );
    if (Number(changed.changes) !== 1) {
      throw new ApiError(409, 'already_decided', 'این درخواست قبلاً بررسی شده است / This request was already decided');
    }
    result = usersService.adjustBalance(Number(row.user_id), value, description, actorReq);
  });
  tx();
  notifyUser(Number(row.user_id), {
    type: 'success',
    title: 'موجودی شما افزایش یافت',
    body: `${label} #${Number(row.id)} تایید شد — ${value.toLocaleString('en-US')} به کیف پول شما اضافه شد. موجودی: ${Number(result.balance).toLocaleString('en-US')}`,
    link: '/wallet',
  });
  audit(actorReq, 'topup.approve', 'topup', Number(row.id), {
    userId: Number(row.user_id), amount: value, balance: Number(result.balance),
    source: String(source || 'panel'), method: kind, auto: Boolean(auto),
  });
  return { ...getRequest(row.id), balance: Number(result.balance), credited: value };
}

/**
 * Scheduled auto-approval for deposit receipts (v1.5.4 item 3, narrowed in v1.5.5).
 *
 * The owner asked for a timer that approves payments nobody has looked at yet.
 * That is a switch that hands out money without a person, so every guard in
 * payment.autoApprove() is applied here, and a request only passes when ALL of
 * these are true at once:
 *   - it is older than `afterMinutes` (the waiting period he configured);
 *   - its method is one he enabled — a gateway payment is never in this list,
 *     because ZarinPal confirms itself, and a card-to-card or بلو row left over
 *     from 1.5.4 is not either, because those methods no longer exist;
 *   - it is at or below `autoApproveMaxAmount`, a ceiling without which the
 *     switch cannot be turned on at all;
 *   - the reseller has not already hit his daily count of auto-approvals.
 *
 * Each row still goes through approve(), so the pending-status lock, the ledger
 * line, the notification and the audit entry are the same as an admin's click —
 * the only difference is that the sweep, not a person, wrote it.
 */
function runAutoApprove({ now = Date.now(), limit = 25 } = {}) {
  const db = getDb();
  const raw = payment.paymentSettings();
  // Report the reason the sweep did nothing rather than a bare 0, so the panel
  // log answers "why didn't my pending receipt get approved at 03:00?" on its own.
  if (!Boolean(raw.autoApproveEnabled)) return { enabled: false, reason: 'disabled', checked: 0, approved: 0, skipped: 0 };
  if (!(Math.round(Number(raw.autoApproveMaxAmount || 0)) > 0)) {
    return { enabled: false, reason: 'no_ceiling', checked: 0, approved: 0, skipped: 0 };
  }
  const cfg = payment.autoApprove();
  const allowed = Object.entries(cfg.methods).filter(([, on]) => on).map(([method]) => method);
  if (!allowed.length) return { enabled: false, reason: 'no_methods', checked: 0, approved: 0, skipped: 0 };

  const cutoff = now - cfg.afterMinutes * 60000;
  const placeholders = allowed.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT * FROM topup_requests
      WHERE status = 'pending' AND method IN (${placeholders})
        AND amount <= ? AND created_at <= ?
      ORDER BY created_at ASC, id ASC LIMIT ?`
  ).all(...allowed, cfg.maxAmount, cutoff, Math.min(50, Math.max(1, Number(limit) || 25)));

  const results = [];
  let approved = 0;
  let skipped = 0;
  for (const row of rows) {
    // The daily ceiling is a count of what the SWEEP already credited today, not
    // of everything the reseller paid — an admin's approvals are his own doing.
    if (cfg.dailyLimit > 0) {
      const since = now - 86400000;
      const done = db.prepare(
        "SELECT COUNT(*) AS c FROM topup_requests WHERE user_id = ? AND auto_approved = 1 AND decided_at >= ?"
      ).get(Number(row.user_id), since).c;
      if (Number(done) >= cfg.dailyLimit) {
        skipped += 1;
        results.push({ id: Number(row.id), userId: Number(row.user_id), skipped: 'daily_limit' });
        continue;
      }
    }
    try {
      approve(row.id, {
        actor: null,
        source: 'auto',
        auto: true,
        note: `تایید خودکار پس از ${cfg.afterMinutes} دقیقه بی‌برخورد (سقف ${cfg.maxAmount.toLocaleString('en-US')})`,
      });
      approved += 1;
      results.push({ id: Number(row.id), userId: Number(row.user_id), amount: Number(row.amount), method: String(row.method), approved: true });
    } catch (err) {
      // Someone beat the sweep to the button. That is the correct outcome, not a
      // failure worth shouting about; anything else is, and the row stays pending.
      if (err?.code === 'already_decided') {
        skipped += 1;
        results.push({ id: Number(row.id), skipped: 'already_decided' });
        continue;
      }
      skipped += 1;
      results.push({ id: Number(row.id), skipped: err?.code || 'error', error: err?.message || String(err) });
      console.error(`[topups] auto-approve #${Number(row.id)} failed: ${err?.message || err}`);
    }
  }

  if (approved) {
    const total = results.reduce((sum, item) => sum + (item.approved ? Number(item.amount || 0) : 0), 0);
    notifyAdmins({
      type: 'info',
      title: 'تایید خودکار شارژ کیف پول',
      body: `${approved} درخواست به صورت خودکار تایید شد — مجموع ${total.toLocaleString('en-US')}. بازبینی دستی با فیلتر «خودکار» در دسترس است.`,
      link: '/topups',
    });
  }
  return {
    enabled: true,
    checked: rows.length,
    approved,
    skipped,
    methods: allowed,
    afterMinutes: cfg.afterMinutes,
    maxAmount: cfg.maxAmount,
    dailyLimit: cfg.dailyLimit,
    results,
  };
}

/** The row a gateway callback belongs to, found by the authority it quotes. */
function findByReference(reference) {
  const ref = cleanReference(reference);
  if (!ref) return null;
  return getDb().prepare('SELECT * FROM topup_requests WHERE reference = ? ORDER BY id DESC LIMIT 1').get(ref) || null;
}

/**
 * Stamp a gateway's own tracking code onto a still-pending row.
 *
 * The ZarinPal flow needs this: the panel creates the row first (so there is
 * something for the callback to come back to), asks the gateway for an authority,
 * and stores that authority as the row's reference. Only a pending row can be
 * stamped — once a decision exists the reference is part of the record of what
 * was decided, and rewriting it would rewrite history.
 */
function setReference(id, reference) {
  const ref = cleanReference(reference);
  const db = getDb();
  const info = db.prepare("UPDATE topup_requests SET reference = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(ref, Date.now(), Number(id));
  if (Number(info.changes) !== 1) {
    throw new ApiError(409, 'already_decided', 'این درخواست دیگر در انتظار نیست / This request is no longer pending');
  }
  return rowOf(id);
}

function reject(id, { note = '', actor = null, source = 'panel' } = {}, req) {
  const db = getDb();
  const row = rowOf(id);
  if (!row) throw new ApiError(404, 'not_found', 'Top-up request not found');
  if (row.status !== 'pending') {
    throw new ApiError(409, 'already_decided',
      `این درخواست قبلاً ${row.status === 'approved' ? 'تایید' : 'رد'} شده است / This request was already decided`);
  }
  const now = Date.now();
  const adminId = Number(actor?.id || 0);
  const changed = db.prepare(
    `UPDATE topup_requests SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`
  ).run(adminId, now, String(note || '').slice(0, 500), now, Number(row.id));
  if (Number(changed.changes) !== 1) {
    throw new ApiError(409, 'already_decided', 'این درخواست قبلاً بررسی شده است / This request was already decided');
  }
  // v1.5.4: what he is being told about is a card claim or a gateway order as
  // often as a picture now, so the notice names the method the row was made under
  // instead of always saying «فیش».
  const label = METHOD_LABEL[String(row.method || 'receipt')] || METHOD_LABEL.receipt;
  notifyUser(Number(row.user_id), {
    type: 'warning',
    title: `${label} رد شد`,
    body: `${label} #${Number(row.id)} تایید نشد${note ? ` — ${String(note).slice(0, 300)}` : ''}. در صورت اشتباه با پشتیبانی تماس بگیرید.`,
    link: '/wallet',
  });
  audit(req || { user: { id: adminId, role: 'admin' } }, 'topup.reject', 'topup', Number(row.id), {
    userId: Number(row.user_id), amount: Number(row.amount), note: String(note || ''), source: String(source || 'panel'),
    method: String(row.method || 'receipt'),
  });
  return getRequest(row.id);
}

/** Where the admin's copy of a receipt was posted, so the bot can edit it later. */
function rememberAdminMessage(id, chatId, messageId) {
  getDb().prepare('UPDATE topup_requests SET admin_chat_id = ?, admin_message_id = ?, updated_at = ? WHERE id = ?')
    .run(String(chatId || ''), Number(messageId) || 0, Date.now(), Number(id));
}

module.exports = {
  MAX_AMOUNT,
  MAX_PENDING_PER_USER,
  STATUSES,
  METHODS,
  LEGACY_METHODS,
  FILTER_METHODS,
  METHOD_LABEL,
  cleanAmount,
  cleanMethod,
  cleanReference,
  createRequest,
  listRequests,
  getRequest,
  findByReference,
  setReference,
  pendingCount,
  approve,
  reject,
  runAutoApprove,
  rememberAdminMessage,
  view,
};
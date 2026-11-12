'use strict';

/**
 * Wallet top-up requests (v1.5.2).
 *
 * A reseller sends his payment receipt through the Telegram bot; the admin sees
 * the picture with two buttons and decides. This module owns the row and the
 * money, so the bot, the admin API and the panel's own list all go through the
 * same rules:
 *
 *   - the wallet moves ONLY on 'pending' → 'approved', inside one transaction
 *     with the status change, so a double tap cannot credit twice;
 *   - the amount is a positive integer, capped, and the admin may correct it
 *     before approving (the receipt is what he is really approving);
 *   - every decision is audited and the reseller is notified in the panel.
 *
 * Nothing here talks to Telegram: the bot layer delivers the messages, this layer
 * owns the data. That keeps the whole flow testable without a network.
 */

const { getDb } = require('../db');
const usersService = require('./users');
const { ApiError, pageParams } = require('../utils');
const { audit } = require('../audit');
const { notifyUser } = require('../notify');

// A receipt is a human decision, not an API: the cap only exists so a typo
// ("50000000000") cannot empty or inflate a wallet by accident.
const MAX_AMOUNT = 1_000_000_000;
const MAX_PENDING_PER_USER = 10;
const STATUSES = ['pending', 'approved', 'rejected'];

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
} = {}) {
  const db = getDb();
  const user = db.prepare('SELECT id, username, status, deleted_at FROM users WHERE id = ?').get(Number(userId));
  if (!user || user.deleted_at) throw new ApiError(404, 'user_not_found', 'Reseller not found');
  const value = cleanAmount(amount);
  if (pendingCount(user.id) >= MAX_PENDING_PER_USER) {
    throw new ApiError(429, 'too_many_pending',
      'درخواست‌های در انتظار شما زیاد است؛ صبر کنید مدیر بررسی کند / Too many pending receipts — wait for the admin to review them');
  }
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO topup_requests (user_id, amount, status, file_kind, file_id, caption, chat_id, message_id,
      admin_chat_id, admin_message_id, decided_by, decided_at, decision_note, source, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, '', 0, 0, 0, '', ?, ?, ?)`
  ).run(
    Number(user.id), value, String(fileKind || ''), String(fileId || ''), String(caption || '').slice(0, 1000),
    String(chatId || ''), Number(messageId) || 0, String(source || 'bot'), now, now
  );
  const id = Number(info.lastInsertRowid);
  audit(null, 'topup.request', 'topup', id, { userId: Number(user.id), amount: value, source: String(source || 'bot') });
  return view(rowOf(id), { username: user.username });
}

function listRequests({ status = '', userId = 0, page = 1, pageSize = 30 } = {}) {
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
  // receipts must never learn how many the whole fleet has sent.
  const countClause = Number(userId) > 0 ? 'WHERE user_id = ?' : '';
  const countParams = Number(userId) > 0 ? [Number(userId)] : [];
  for (const row of db.prepare(`SELECT status, COUNT(*) AS c FROM topup_requests ${countClause} GROUP BY status`).all(...countParams)) {
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
 * Approve a receipt and credit the wallet. `actor` is { id, role } — the admin
 * who tapped the button, whether he did it in Telegram or in the panel.
 *
 * The status update is the lock: it only matches a row that is still pending, so
 * two taps (or a tap and a panel click at the same moment) produce one credit and
 * one clear "already decided" answer.
 */
function approve(id, { amount, note = '', actor = null, source = 'panel' } = {}, req) {
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
  const description = `شارژ کیف پول از فیش واریزی #${Number(row.id)}${source === 'bot' ? ' (ربات تلگرام)' : ''}`;
  let result = null;
  const tx = db.transaction(() => {
    const changed = db.prepare(
      `UPDATE topup_requests SET status = 'approved', amount = ?, decided_by = ?, decided_at = ?,
        decision_note = ?, source = CASE WHEN source = 'bot' THEN 'bot' ELSE ? END, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    ).run(value, adminId, now, String(note || '').slice(0, 500), String(source || 'panel'), now, Number(row.id));
    if (Number(changed.changes) !== 1) {
      throw new ApiError(409, 'already_decided', 'این درخواست قبلاً بررسی شده است / This request was already decided');
    }
    result = usersService.adjustBalance(Number(row.user_id), value, description, req || { user: { id: adminId, role: 'admin' } });
  });
  tx();
  notifyUser(Number(row.user_id), {
    type: 'success',
    title: 'موجودی شما افزایش یافت',
    body: `فیش #${Number(row.id)} تایید شد — ${value.toLocaleString('en-US')} به کیف پول شما اضافه شد. موجودی: ${Number(result.balance).toLocaleString('en-US')}`,
    link: '/wallet',
  });
  audit(req || { user: { id: adminId, role: 'admin' } }, 'topup.approve', 'topup', Number(row.id), {
    userId: Number(row.user_id), amount: value, balance: Number(result.balance), source: String(source || 'panel'),
  });
  return { ...getRequest(row.id), balance: Number(result.balance), credited: value };
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
  notifyUser(Number(row.user_id), {
    type: 'warning',
    title: 'فیش واریزی رد شد',
    body: `فیش #${Number(row.id)} تایید نشد${note ? ` — ${String(note).slice(0, 300)}` : ''}. در صورت اشتباه با پشتیبانی تماس بگیرید.`,
    link: '/wallet',
  });
  audit(req || { user: { id: adminId, role: 'admin' } }, 'topup.reject', 'topup', Number(row.id), {
    userId: Number(row.user_id), amount: Number(row.amount), note: String(note || ''), source: String(source || 'panel'),
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
  cleanAmount,
  createRequest,
  listRequests,
  getRequest,
  pendingCount,
  approve,
  reject,
  rememberAdminMessage,
  view,
};
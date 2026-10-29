'use strict';

const { getDb } = require('./db');
const { getSetting } = require('./settings');
const { ApiError } = require('./utils');

function insertNotification({ userId, type = 'system', title = '', body = '', link = '', meta = {}, dedupeKey = null }) {
  const db = getDb();
  if (dedupeKey) {
    const exists = db.prepare('SELECT id FROM notifications WHERE dedupe_key = ?').get(dedupeKey);
    if (exists) return null;
  }
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO notifications (user_id, type, title, body, link, meta, dedupe_key, read_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    Number(userId),
    String(type),
    String(title || ''),
    String(body || ''),
    String(link || ''),
    JSON.stringify(meta || {}),
    dedupeKey || null,
    now
  );
  return info.lastInsertRowid;
}

function notifyUser(userId, payload) {
  return insertNotification({ ...payload, userId });
}

function notifyAdmins(payload) {
  const db = getDb();
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at = 0").all();
  const ids = [];
  for (const row of admins) {
    const id = insertNotification({ ...payload, userId: row.id });
    if (id) ids.push(id);
  }
  return ids;
}

function notifyAll(payload) {
  const db = getDb();
  const users = db.prepare("SELECT id FROM users WHERE status = 'active' AND deleted_at = 0").all();
  let count = 0;
  for (const row of users) {
    if (insertNotification({ ...payload, userId: row.id })) count += 1;
  }
  return count;
}

function smtpTransport() {
  const smtp = getSetting('smtp');
  if (!smtp.enabled || !smtp.host) return null;
  // eslint-disable-next-line global-require
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port || 587),
    secure: Boolean(smtp.secure),
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass || '' } : undefined,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 12000,
    greetingTimeout: 8000,
    socketTimeout: 20000,
  });
}

async function sendMail(to, subject, text, html) {
  const smtp = getSetting('smtp');
  if (!smtp.enabled) throw new ApiError(400, 'smtp_disabled', 'Email notifications are disabled');
  const transport = smtpTransport();
  if (!transport) throw new ApiError(400, 'smtp_incomplete', 'SMTP host is not configured');
  const recipients = String(to || smtp.to || '').split(/[,;\s]+/).filter(Boolean);
  if (!recipients.length) throw new ApiError(400, 'smtp_no_recipient', 'No email recipient configured');
  const from = smtp.from || smtp.user || recipients[0];
  const info = await transport.sendMail({
    from,
    to: recipients.join(', '),
    subject: subject || 'Sulduz Cloud',
    text: text || '',
    html: html || undefined,
  });
  return { accepted: info.accepted || [], rejected: info.rejected || [] };
}

async function sendSms(text, to) {
  const sms = getSetting('sms');
  if (!sms.enabled) throw new ApiError(400, 'sms_disabled', 'SMS notifications are disabled');
  const recipient = String(to || sms.to || '').replace(/[^\d,]/g, '');
  if (!recipient) throw new ApiError(400, 'sms_no_recipient', 'No SMS recipient configured');
  const message = String(text || '').slice(0, 900);

  if (sms.provider === 'kavenegar') {
    if (!sms.apiKey) throw new ApiError(400, 'sms_incomplete', 'Kavenegar API key is missing');
    const url = new URL(`https://api.kavenegar.com/v1/${encodeURIComponent(sms.apiKey)}/sms/send.json`);
    url.searchParams.set('receptor', recipient);
    url.searchParams.set('message', message);
    if (sms.sender) url.searchParams.set('sender', sms.sender);
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || Number(json.return?.status) !== 200) {
      throw new ApiError(502, 'sms_failed', `SMS provider error: ${json.return?.message || res.status}`);
    }
    return { ok: true, provider: 'kavenegar' };
  }

  if (sms.provider === 'custom') {
    if (!sms.customUrl) throw new ApiError(400, 'sms_incomplete', 'Custom SMS URL is missing');
    let headers = {};
    try { headers = sms.customHeaders ? JSON.parse(sms.customHeaders) : {}; } catch (_) { headers = {}; }
    const bodyTemplate = sms.customBody || '{"to":"{to}","text":"{text}"}';
    const rendered = bodyTemplate
      .replaceAll('{to}', recipient)
      .replaceAll('{text}', message.replace(/"/g, '\\"'));
    const method = String(sms.customMethod || 'POST').toUpperCase();
    const init = { method, headers: { 'Content-Type': 'application/json', ...headers }, signal: AbortSignal.timeout(15000) };
    if (method !== 'GET') init.body = rendered;
    const res = await fetch(sms.customUrl, init);
    if (!res.ok) throw new ApiError(502, 'sms_failed', `SMS provider returned HTTP ${res.status}`);
    return { ok: true, provider: 'custom' };
  }

  throw new ApiError(400, 'sms_provider', `Unknown SMS provider: ${sms.provider}`);
}

async function testEmail() {
  const smtp = getSetting('smtp');
  const to = smtp.to || smtp.user;
  await sendMail(to, 'Sulduz Cloud — تست ایمیل', 'این یک پیام آزمایشی از پنل Sulduz Cloud است.');
  return { ok: true, to };
}

async function testSms() {
  const sms = getSetting('sms');
  await sendSms('Sulduz Cloud: پیام آزمایشی', sms.to);
  return { ok: true, to: sms.to };
}

async function alertAdmins({ title, body }) {
  notifyAdmins({ type: 'alert', title, body, link: '/admin/servers' });
  const monitor = getSetting('monitor');
  const results = { email: false, sms: false, errors: [] };
  if (monitor.alertEmail) {
    try { await sendMail('', title, body); results.email = true; } catch (err) { results.errors.push(`email: ${err.message}`); }
  }
  if (monitor.alertSms) {
    try { await sendSms(`${title}\n${body}`); results.sms = true; } catch (err) { results.errors.push(`sms: ${err.message}`); }
  }
  return results;
}

function listNotifications(userId, { page = 1, pageSize = 30, unreadOnly = false } = {}) {
  const db = getDb();
  const where = ['user_id = ?'];
  const params = [Number(userId)];
  if (unreadOnly) where.push('read_at = 0');
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS c FROM notifications ${clause}`).get(...params).c;
  const unread = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at = 0').get(Number(userId)).c;
  const rows = db.prepare(
    `SELECT * FROM notifications ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
  return {
    total,
    unread,
    rows: rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      meta: (() => { try { return JSON.parse(r.meta || '{}'); } catch (_) { return {}; } })(),
      readAt: r.read_at,
      createdAt: r.created_at,
    })),
  };
}

function markRead(userId, id) {
  const db = getDb();
  if (id) {
    db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?').run(Date.now(), Number(id), Number(userId));
  } else {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at = 0').run(Date.now(), Number(userId));
  }
  return true;
}

module.exports = {
  insertNotification,
  notifyUser,
  notifyAdmins,
  notifyAll,
  sendMail,
  sendSms,
  testEmail,
  testSms,
  alertAdmins,
  listNotifications,
  markRead,
};

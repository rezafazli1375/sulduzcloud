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

const SMS_TEXT_MAX = 900;

function normalizeSmsNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^0098\d{10}$/.test(digits)) return `0${digits.slice(4)}`;
  if (/^98\d{10}$/.test(digits)) return `0${digits.slice(2)}`;
  return digits;
}

function smsTargets(sms, to) {
  // Numbers are separated by commas/semicolons; spaces inside a number
  // ("0912 000 0000") are formatting and get stripped.
  return String(to || sms.to || '')
    .split(/[,;\n]+/)
    .map(normalizeSmsNumber)
    .filter(Boolean);
}

async function sendSmsText(sms, recipients, message) {
  if (sms.provider === 'kavenegar') {
    if (!sms.apiKey) throw new ApiError(400, 'sms_incomplete', 'Kavenegar API key is missing');
    const url = new URL(`https://api.kavenegar.com/v1/${encodeURIComponent(sms.apiKey)}/sms/send.json`);
    url.searchParams.set('receptor', recipients.join(','));
    url.searchParams.set('message', message);
    if (sms.sender) url.searchParams.set('sender', sms.sender);
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || Number(json.return?.status) !== 200) {
      throw new ApiError(502, 'sms_failed', `SMS provider error: ${json.return?.message || res.status}`);
    }
    return { ok: true, provider: 'kavenegar', mode: 'text', recipients };
  }

  if (sms.provider === 'farazsms') {
    // FarazSMS v1 web service (docs.farazsms.com): the static panel API key goes
    // in the Api-Key header, the sender line in `line_number`, and every number
    // must be plain digits ("english" format, no +98 prefix).
    if (!sms.apiKey) throw new ApiError(400, 'sms_incomplete', 'FarazSMS API key is missing');
    const line = String(sms.sender || '').trim();
    if (!line) throw new ApiError(400, 'sms_incomplete', 'FarazSMS line number (sender) is missing');
    const res = await fetch('https://api.iranpayamak.com/ws/v1/sms/simple', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Api-Key': String(sms.apiKey),
      },
      body: JSON.stringify({
        text: message,
        line_number: line,
        number_format: 'english',
        recipients,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || String(json.status || '').toLowerCase() === 'error') {
      throw new ApiError(502, 'sms_failed', `FarazSMS error: ${json.message || `HTTP ${res.status}`}`);
    }
    return { ok: true, provider: 'farazsms', mode: 'text', recipients };
  }

  throw new ApiError(400, 'sms_provider', `Unknown SMS provider: ${sms.provider}`);
}

// Every notification is delivered as the panel's own free text. The owner can
// mute any single notification; that only skips the SMS channel, the in-panel
// and email channels stay active.
async function sendSms(text, to, options = {}) {
  const sms = getSetting('sms');
  if (!sms.enabled) throw new ApiError(400, 'sms_disabled', 'SMS notifications are disabled');
  const recipients = smsTargets(sms, to);
  if (!recipients.length) throw new ApiError(400, 'sms_no_recipient', 'No SMS recipient configured');
  const message = String(text || '').slice(0, SMS_TEXT_MAX);

  const event = String(options.event || '');
  if (event && sms.events?.[event]?.enabled === false) {
    return { ok: true, skipped: 'event_disabled', event, recipients: [] };
  }

  if (sms.provider === 'custom') {
    if (!sms.customUrl) throw new ApiError(400, 'sms_incomplete', 'Custom SMS URL is missing');
    let headers = {};
    try { headers = sms.customHeaders ? JSON.parse(sms.customHeaders) : {}; } catch (_) { headers = {}; }
    const bodyTemplate = sms.customBody || '{"to":"{to}","text":"{text}"}';
    // Alert texts are multi-line, so the substituted values have to stay valid
    // JSON string content: quotes, backslashes and control characters escape.
    const jsonSafe = (value) => JSON.stringify(String(value)).slice(1, -1);
    const rendered = bodyTemplate
      .replaceAll('{to}', jsonSafe(recipients.join(',')))
      .replaceAll('{text}', jsonSafe(message));
    const method = String(sms.customMethod || 'POST').toUpperCase();
    const init = { method, headers: { 'Content-Type': 'application/json', ...headers }, signal: AbortSignal.timeout(15000) };
    if (method !== 'GET') init.body = rendered;
    const res = await fetch(sms.customUrl, init);
    if (!res.ok) throw new ApiError(502, 'sms_failed', `SMS provider returned HTTP ${res.status}`);
    return { ok: true, provider: 'custom', mode: 'text', recipients };
  }

  if (sms.provider !== 'kavenegar' && sms.provider !== 'farazsms') {
    throw new ApiError(400, 'sms_provider', `Unknown SMS provider: ${sms.provider}`);
  }

  return sendSmsText(sms, recipients, message);
}

async function testEmail() {
  const smtp = getSetting('smtp');
  const to = smtp.to || smtp.user;
  await sendMail(to, 'Sulduz Cloud — تست ایمیل', 'این یک پیام آزمایشی از پنل Sulduz Cloud است.');
  return { ok: true, to };
}

async function testSms() {
  const sms = getSetting('sms');
  const panelName = String(getSetting('general').panelName || 'Sulduz Cloud').trim();
  const result = await sendSms(`${panelName}\nپیام آزمایشی`, sms.to, { event: 'test' });
  return { ...result, to: sms.to };
}

// `data` is the event's own metadata; it is not part of the SMS any more (the
// message is plain text) but callers keep sending it for the notification meta.
async function alertAdmins({ event = '', data = {}, title, body }) {
  notifyAdmins({ type: 'alert', title, body, link: '/admin/servers' });
  const monitor = getSetting('monitor');
  const results = { email: false, sms: false, errors: [] };
  if (monitor.alertEmail) {
    try { await sendMail('', title, body); results.email = true; } catch (err) { results.errors.push(`email: ${err.message}`); }
  }
  if (monitor.alertSms) {
    try {
      const result = await sendSms(`${title}\n${body}`, undefined, { event });
      results.sms = !result.skipped;
      if (result.skipped) results.skipped = result.skipped;
    } catch (err) { results.errors.push(`sms: ${err.message}`); }
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

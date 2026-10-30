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
// Kavenegar caps each verify template token at 100 characters; staying inside
// the same bound keeps one mapping safe for both providers.
const SMS_VAR_MAX = 100;
const SMS_VAR_PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

// Notifications that can carry SMS. Besides {title}/{body}/{text}/{date}, each
// event exposes its own details as variables so a dedicated pattern can say
// exactly what happened (e.g. «نود {node} روی {server} قطع شد»).
const SMS_EVENTS = {
  test: ['panel'],
  nodeOffline: ['node', 'server', 'address', 'failures'],
  nodeOnline: ['node', 'server'],
  panelOffline: ['server', 'error'],
  panelOnline: ['server'],
};

// Accept 09…, 0098… and 98… but always use the local 09… form.
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

function smsToday() {
  const timezone = getSetting('general').timezone || 'Asia/Tehran';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

// Operator-controlled providers (Kavenegar/FarazSMS) only deliver pre-approved
// patterns without manual review, so the message is projected onto template
// variables. Every message exposes:
//   {title} first line · {body} remaining lines · {text} whole message · {date}
// plus the event's own keys (see SMS_EVENTS).
function smsValues({ title = '', body = '', text = '', data = {} } = {}) {
  const lines = String(text || [title, body].filter(Boolean).join('\n')).replace(/\r/g, '').split('\n');
  const values = {
    title: String(title || lines[0] || '').trim(),
    body: String(body || lines.slice(1).join('\n')).trim(),
    text: lines.join('\n').trim(),
    date: smsToday(),
  };
  for (const [key, value] of Object.entries(data || {})) {
    if (value === null || value === undefined) continue;
    values[String(key).toLowerCase()] = String(value).replace(/\s+/g, ' ').trim();
  }
  return values;
}

function renderSmsVars(mapping, values) {
  const rendered = (Array.isArray(mapping) ? mapping : []).slice(0, 3).map((template) => (
    String(template ?? '')
      .replace(SMS_VAR_PLACEHOLDER, (_, key) => values[key.toLowerCase()] || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SMS_VAR_MAX)
  ));
  while (rendered.length && !rendered[rendered.length - 1]) rendered.pop();
  return rendered;
}

// Each notification can use its own approved pattern. An empty per-event code
// falls back to the shared default pattern (pattern/patternVar1..3); a per-event
// pattern without its own mapping keeps the built-in title/body split.
function smsEventConfig(sms, event, values) {
  const saved = (sms.patterns && sms.patterns[event]) || {};
  const code = String(saved.code || '').trim();
  if (!code) {
    return {
      event,
      source: 'default',
      pattern: String(sms.pattern || '').trim(),
      names: sms.patternNames,
      vars: renderSmsVars([sms.patternVar1, sms.patternVar2, sms.patternVar3], values),
    };
  }
  const mapping = [saved.var1, saved.var2, saved.var3];
  const templates = mapping.some((value) => String(value ?? '').trim())
    ? mapping
    : ['{title}', '{body}', ''];
  return {
    event,
    source: 'event',
    pattern: code,
    names: String(saved.names || '').trim() || sms.patternNames,
    vars: renderSmsVars(templates, values),
  };
}

async function sendSmsPattern(sms, recipients, config) {
  const pattern = String(config.pattern || '').trim();
  if (!pattern) {
    throw new ApiError(400, 'sms_pattern_missing',
      'الگوی پیامک (پترن) تنظیم نشده است؛ نام یا کد پترن تأییدشده را در تنظیمات پیامک وارد کنید.');
  }
  const vars = Array.isArray(config.vars) ? config.vars : [];
  if (!vars.length) throw new ApiError(400, 'sms_empty', 'SMS message is empty');
  const names = String(config.names || '')
    .split(/[,;\s]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  const meta = {
    event: config.event || '',
    source: config.source || 'default',
    pattern,
    recipients,
    vars,
    names,
  };

  if (sms.provider === 'kavenegar') {
    // Kavenegar verify/lookup: the template name is registered in the panel and
    // its tokens (token, token2, token3) fill the approved text. One request per
    // number keeps the quota/error of each delivery separate.
    if (!sms.apiKey) throw new ApiError(400, 'sms_incomplete', 'Kavenegar API key is missing');
    for (const recipient of recipients) {
      const url = new URL(`https://api.kavenegar.com/v1/${encodeURIComponent(sms.apiKey)}/verify/lookup.json`);
      url.searchParams.set('receptor', recipient);
      url.searchParams.set('template', pattern);
      url.searchParams.set('type', 'sms');
      ['token', 'token2', 'token3'].forEach((name, index) => {
        if (vars[index]) url.searchParams.set(name, vars[index]);
      });
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15000) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || Number(json.return?.status) !== 200) {
        throw new ApiError(502, 'sms_failed', `Kavenegar error: ${json.return?.message || `HTTP ${res.status}`}`);
      }
    }
    return { ok: true, provider: 'kavenegar', mode: 'pattern', ...meta };
  }

  if (sms.provider === 'farazsms') {
    // FarazSMS pattern endpoint (docs.iranpayamak.com): one request per number.
    // Attribute keys must match the variable names defined in the pattern, so
    // `names` (per-event or global) labels them in rendered order.
    if (!sms.apiKey) throw new ApiError(400, 'sms_incomplete', 'FarazSMS API key is missing');
    const line = String(sms.sender || '').trim();
    if (!line) throw new ApiError(400, 'sms_incomplete', 'FarazSMS line number (sender) is missing');
    const attributes = {};
    vars.forEach((value, index) => {
      attributes[names[index] || `var${index + 1}`] = value;
    });
    for (const recipient of recipients) {
      const res = await fetch('https://api.iranpayamak.com/ws/v1/sms/pattern', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Api-Key': String(sms.apiKey),
        },
        body: JSON.stringify({
          code: pattern,
          attributes,
          recipient,
          line_number: line,
          number_format: 'english',
        }),
        signal: AbortSignal.timeout(15000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || String(json.status || '').toLowerCase() === 'error') {
        const reason = (Array.isArray(json.messages) && json.messages[0]) || json.message || `HTTP ${res.status}`;
        throw new ApiError(502, 'sms_failed', `FarazSMS error: ${reason}`);
      }
    }
    return { ok: true, provider: 'farazsms', mode: 'pattern', ...meta };
  }

  throw new ApiError(400, 'sms_provider', `Unknown SMS provider: ${sms.provider}`);
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

async function sendSms(text, to, options = {}) {
  const sms = getSetting('sms');
  if (!sms.enabled) throw new ApiError(400, 'sms_disabled', 'SMS notifications are disabled');
  const recipients = smsTargets(sms, to);
  if (!recipients.length) throw new ApiError(400, 'sms_no_recipient', 'No SMS recipient configured');
  const message = String(text || '').slice(0, SMS_TEXT_MAX);

  if (sms.provider === 'custom') {
    if (!sms.customUrl) throw new ApiError(400, 'sms_incomplete', 'Custom SMS URL is missing');
    let headers = {};
    try { headers = sms.customHeaders ? JSON.parse(sms.customHeaders) : {}; } catch (_) { headers = {}; }
    const bodyTemplate = sms.customBody || '{"to":"{to}","text":"{text}"}';
    const rendered = bodyTemplate
      .replaceAll('{to}', recipients.join(','))
      .replaceAll('{text}', message.replace(/"/g, '\\"'));
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

  // Pattern (pre-approved template) is the default: operator-controlled bulk
  // text needs manual approval, approved patterns are delivered immediately.
  if (String(sms.mode || 'pattern') === 'text') return sendSmsText(sms, recipients, message);

  const values = smsValues({
    title: options.title,
    body: options.body,
    text: message,
    data: options.data,
  });
  const config = options.event
    ? smsEventConfig(sms, options.event, values)
    : {
      event: '',
      source: 'default',
      pattern: String(sms.pattern || '').trim(),
      names: sms.patternNames,
      vars: renderSmsVars([sms.patternVar1, sms.patternVar2, sms.patternVar3], values),
    };
  return sendSmsPattern(sms, recipients, config);
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
  // Two lines so {title} receives the panel name and {body} the test text.
  const result = await sendSms(`${panelName}\nپیام آزمایشی`, sms.to, {
    event: 'test',
    title: panelName,
    body: 'پیام آزمایشی',
    data: { panel: panelName },
  });
  return { ...result, to: sms.to };
}

async function alertAdmins({ event = '', data = {}, title, body }) {
  notifyAdmins({ type: 'alert', title, body, link: '/admin/servers' });
  const monitor = getSetting('monitor');
  const results = { email: false, sms: false, errors: [] };
  if (monitor.alertEmail) {
    try { await sendMail('', title, body); results.email = true; } catch (err) { results.errors.push(`email: ${err.message}`); }
  }
  if (monitor.alertSms) {
    try {
      await sendSms(`${title}\n${body}`, undefined, { event, data, title, body });
      results.sms = true;
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

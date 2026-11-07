'use strict';

/**
 * The nightly report (panel v1.4.27).
 *
 * Once a day, at a wall-clock time the owner chooses, every reseller who gave the
 * panel his numeric Telegram id receives:
 *   • what he bought today and what is left in his wallet,
 *   • the subscriptions that ENDED today,
 *   • the subscriptions that are ABOUT to end.
 * and the owner can receive one digest of the whole fleet on the panel chat.
 *
 * Three rules the whole file is written against:
 *   - every number is read out of rows the panel already keeps. Nothing is
 *     estimated, and where the panel genuinely cannot know (a renewal made while
 *     the tariff is switched off leaves no money row) the message says so instead
 *     of printing a zero that would lie;
 *   - a reseller is addressed by `users.telegram_id` only. The bot token is never
 *     combined with anything the message carries, and a chat that was never
 *     started is reported back with Telegram's own words — «ربات استارت نشده» is
 *     a result, not a silence;
 *   - one attempt per (recipient, day). `daily_reports` is what makes a restart
 *     ten seconds after the scheduled hour harmless.
 */

const config = require('../config');
const { getDb } = require('../db');
const settings = require('../settings');
const telegram = require('./telegram');
const configsService = require('./configs');
const {
  ApiError, clamp, dayKey, zonedDayStartMs, zonedDayEndMs,
} = require('../utils');

const DAY_MS = 86400000;
const GIB = 1024 ** 3;
const TEXT_MAX = 4096;
const LIST_MAX = 20;

// ------------------------------------------------------------------ settings

function reportConfig() {
  const cfg = settings.getSetting('telegram');
  return {
    enabled: Boolean(cfg.dailyReportEnabled),
    hour: clamp(Number.isFinite(Number(cfg.dailyReportHour)) ? Number(cfg.dailyReportHour) : 23, 0, 23),
    minute: clamp(Number.isFinite(Number(cfg.dailyReportMinute)) ? Number(cfg.dailyReportMinute) : 0, 0, 59),
    toResellers: cfg.dailyReportResellers !== false,
    toOwner: cfg.dailyReportOwner !== false,
    daysAhead: clamp(Number.isFinite(Number(cfg.dailyReportDaysAhead)) ? Number(cfg.dailyReportDaysAhead) : 3, 1, 30),
    botToken: String(cfg.botToken || '').trim(),
    panelChatId: String(cfg.chatId || '').trim(),
  };
}

// ------------------------------------------------------------------ formatting

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function faNum(value) {
  const n = Math.round(Number(value) || 0);
  try {
    return new Intl.NumberFormat('fa-IR').format(n);
  } catch (_) {
    return String(n);
  }
}

function faBytes(value) {
  const n = Number(value) || 0;
  if (n >= GIB) return `${(n / GIB).toFixed(n / GIB >= 10 ? 0 : 2)} گیگ`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} مگ`;
  if (n > 0) return `${(n / 1024).toFixed(0)} کیلوبایت`;
  return '—';
}

function faDate(ts, withTime = false) {
  const n = Number(ts) || 0;
  if (!n) return '—';
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      timeZone: config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    }).format(new Date(n));
  } catch (_) {
    return new Date(n).toISOString().slice(0, withTime ? 16 : 10);
  }
}

function faTime(ts) {
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ts));
  } catch (_) {
    return new Date(ts).toISOString().slice(11, 16);
  }
}

// ------------------------------------------------------------------ the data

/**
 * Collapse the rows a reseller owns into customer packages, exactly the way the
 * rest of the panel does it (one x-ui client may sit on several inbounds and be
 * stored as one row per inbound). Traffic and quota are then counted per CLIENT so
 * a three-inbound customer is not read as three customers.
 */
function packagesOf(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = configsService.packageKeyOf(row);
    if (!map.has(key)) {
      map.set(key, {
        key,
        userId: Number(row.user_id),
        label: String(row.customer_name || row.label || row.email || `#${row.id}`),
        email: row.email || '',
        quota: 0,
        expiryAt: 0,
        createdAt: Number(row.created_at) || Number.MAX_SAFE_INTEGER,
        updatedAt: 0,
        enabled: false,
        inbounds: 0,
        perClient: new Map(),
      });
    }
    const pack = map.get(key);
    pack.inbounds += 1;
    pack.quota = Math.max(pack.quota, Number(row.total_bytes || 0));
    pack.expiryAt = Math.max(pack.expiryAt, Number(row.expiry_at || 0));
    pack.createdAt = Math.min(pack.createdAt, Number(row.created_at) || Number.MAX_SAFE_INTEGER);
    pack.updatedAt = Math.max(pack.updatedAt, Number(row.updated_at || 0));
    pack.enabled = pack.enabled || Boolean(row.enabled);
    if (!pack.label && row.customer_name) pack.label = row.customer_name;
    const clientKey = String(row.email || '').toLowerCase() || `id:${row.id}`;
    const total = Number(row.up_bytes || 0) + Number(row.down_bytes || 0);
    if (total > (pack.perClient.get(clientKey) || 0)) pack.perClient.set(clientKey, total);
  }
  const packages = [];
  for (const pack of map.values()) {
    pack.used = [...pack.perClient.values()].reduce((sum, value) => sum + value, 0);
    pack.percent = pack.quota > 0 ? Math.min(100, Math.round((pack.used / pack.quota) * 100)) : null;
    pack.forever = !pack.expiryAt;
    // A package without an expiry date never "ends", so it can never belong in
    // the ended / about-to-end lists no matter how far the window looks.
    packages.push(pack);
  }
  return packages;
}

function windowOf(at) {
  const start = zonedDayStartMs(at);
  return { day: dayKey(at), start, end: zonedDayEndMs(at) };
}

function moneyOfDay(userId, fromMs, toMs) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT type, amount, description, created_at FROM transactions
       WHERE user_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at`
    )
    .all(Number(userId), fromMs, toMs);
  const out = { spend: 0, topup: 0, rows, renewals: 0, purchases: 0 };
  for (const row of rows) {
    const amount = Number(row.amount || 0);
    if (amount < 0) out.spend += -amount;
    else out.topup += amount;
    if (row.type === 'renew') out.renewals += 1;
    if (row.type === 'purchase') out.purchases += 1;
  }
  return out;
}

/**
 * Everything one report line is built from. `at` is the instant the report is
 * about, so a manual send and the nightly timer give the same answer.
 */
function collect(userId, at = Date.now()) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at = 0').get(Number(userId));
  if (!user) throw new ApiError(404, 'not_found', 'Reseller not found');
  const win = windowOf(at);
  const ahead = reportConfig().daysAhead;
  const monitor = settings.getSetting('monitor');
  const alertPercent = clamp(Number(monitor.trafficAlertPercent || 90), 50, 100);
  // The same visibility rule the reseller's own list uses: an adopted subscription
  // he switched off for himself must not come back in a report either.
  const hiddenAdopted = Number(user.import_configs ?? 1) === 0;
  const rows = db
    .prepare(
      `SELECT * FROM configs WHERE user_id = ? AND deleted_at = 0
       ${hiddenAdopted ? "AND origin <> 'external'" : ''}`
    )
    .all(Number(userId));
  const packages = packagesOf(rows);

  const created = packages.filter((pack) => pack.createdAt >= win.start && pack.createdAt < Math.min(win.end, at + 1));
  const endedToday = packages.filter(
    (pack) => !pack.forever && pack.expiryAt >= win.start && pack.expiryAt <= at
  );
  const depletedToday = packages.filter(
    (pack) => pack.quota > 0 && pack.used >= pack.quota && pack.updatedAt >= win.start && pack.expiryAt > at
  );
  const endingSoon = packages
    .filter((pack) => !pack.forever && pack.expiryAt > at && pack.expiryAt <= at + ahead * DAY_MS)
    .sort((a, b) => a.expiryAt - b.expiryAt);
  const almostOutOfQuota = packages
    .filter((pack) => pack.percent !== null && pack.percent >= alertPercent && pack.used < pack.quota)
    .sort((a, b) => (b.percent || 0) - (a.percent || 0));

  const billing = settings.getSetting('billing');
  const money = moneyOfDay(userId, win.start, win.end);
  const stats = {
    packages: packages.length,
    active: packages.filter((pack) => pack.enabled && (pack.forever || pack.expiryAt > at)).length,
    created: created.length,
    createdGb: created.reduce((sum, pack) => sum + pack.quota, 0),
    ended: endedToday.length,
    depleted: depletedToday.length,
    endingSoon: endingSoon.length,
    almostOutOfQuota: almostOutOfQuota.length,
    spend: money.spend,
    topup: money.topup,
    renewals: money.renewals,
    balance: Number(user.balance || 0),
    billingEnabled: Boolean(billing.enabled),
    currency: String(billing.currency || 'تومان'),
    traffic: 0,
  };
  // The day ledger is read through the same rule: a subscription this reseller
  // hid from himself must not come back as traffic in his night report either,
  // or the message and his home page would disagree about the same day. The join
  // is a LEFT one so a ledger row that outlived its config is still his traffic.
  const trafficRow = db
    .prepare(
      `SELECT COALESCE(SUM(d.up_bytes + d.down_bytes), 0) AS total
       FROM usage_daily d LEFT JOIN configs c ON c.id = d.config_id
       WHERE d.user_id = ? AND d.day = ? ${hiddenAdopted ? "AND (c.id IS NULL OR c.origin <> 'external')" : ''}`
    )
    .get(Number(userId), win.day);
  stats.traffic = Number(trafficRow?.total || 0);

  return {
    user, stats, win, ahead, alertPercent,
    lists: { created, endedToday, depletedToday, endingSoon, almostOutOfQuota },
    money,
  };
}

// ------------------------------------------------------------------ the text

function lineList(title, packs, lineOf) {
  if (!packs.length) return [];
  const shown = packs.slice(0, LIST_MAX).map((pack) => `• ${lineOf(pack)}`);
  const rest = packs.length - shown.length;
  if (rest > 0) shown.push(`… و ${faNum(rest)} مورد دیگر`);
  return [`<b>${title}</b>\n${shown.join('\n')}`];
}

function bulletBlock(title, lines) {
  if (!lines.length) return `<b>${title}</b>\n<code>—</code>`;
  const shown = lines.slice(0, LIST_MAX);
  const rest = lines.length - shown.length;
  const body = rest > 0 ? [...shown, `… و ${faNum(rest)} مورد دیگر`] : shown;
  return `<b>${title}</b>\n${body.map((line) => `• ${line}`).join('\n')}`;
}

function packageLine(pack, at) {
  const parts = [esc(pack.label)];
  if (pack.quota > 0) parts.push(`${faBytes(pack.quota)}`);
  if (pack.percent !== null) parts.push(`${faNum(pack.percent)}٪ مصرف‌شده`);
  if (!pack.forever) {
    const left = Math.max(0, Math.round((pack.expiryAt - at) / DAY_MS));
    parts.push(left > 0 ? `${faNum(left)} روز مانده` : 'امروز پایان می‌یابد');
  } else {
    parts.push('بدون انقضا');
  }
  return parts.join(' · ');
}

function resellerText(data, at = Date.now()) {
  const { user, stats, ahead, alertPercent, lists } = data;
  const currency = esc(stats.currency);
  const block = [];
  block.push(
    `📊 <b>گزارش روزانه</b> — ${esc(faDate(at))}\n`
      + `نماینده: <code>${esc(user.username)}</code>${user.name ? ` (${esc(user.name)})` : ''}`
  );

  // 1) what was bought today + what is left in the wallet
  const bought = [
    `بسته‌های ساخته‌شده امروز: <b>${faNum(stats.created)}</b>${stats.created ? ` (${faBytes(stats.createdGb)})` : ''}`,
    stats.billingEnabled
      ? `تمدیدهای امروز: <b>${faNum(stats.renewals)}</b> · هزینهٔ امروز: <b>${faNum(stats.spend)}</b> ${currency}`
        + (stats.topup ? ` · شارژ امروز: ${faNum(stats.topup)} ${currency}` : '')
      : '<i>تعرفه خاموش است؛ تمدید و هزینهٔ امروز در دفتر مالی ثبت نمی‌شود</i>',
    `موجودی کیف پول: <b>${faNum(stats.balance)}</b> ${currency}`,
    `ترافیک امروز: <b>${faBytes(stats.traffic)}</b>`,
  ];
  block.push(`🛒 <b>خرید امروز و موجودی</b>\n${bought.map((line) => `• ${line}`).join('\n')}`);
  if (lists.created.length) {
    block.push(...lineList(
      'بسته‌های جدید امروز',
      lists.created,
      (pack) => `${packageLine(pack, at)} · انقضا ${esc(faDate(pack.expiryAt))}`
    ));
  }

  // 2) subscriptions that ended today, by expiry or by quota
  const ended = [
    ...lists.endedToday.map((pack) => `${esc(pack.label)} · ${faBytes(pack.quota)} · پایان ${esc(faDate(pack.expiryAt, true))}`),
    ...lists.depletedToday.map((pack) => `${esc(pack.label)} · حجمش تمام شد (${faBytes(pack.quota)} مصرف شده)`),
  ];
  block.push(`⛔ ${bulletBlock(`امروز تمام شد: ${faNum(ended.length)}`, ended)}`);

  // 3) what is about to end, by date or by shared quota
  const soon = [
    ...lists.endingSoon.map((pack) => `${packageLine(pack, at)} · تاریخ ${esc(faDate(pack.expiryAt))}`),
    ...lists.almostOutOfQuota.map((pack) => `${esc(pack.label)} · ${faNum(pack.percent)}٪ از ${faBytes(pack.quota)} مصرف شده`),
  ];
  block.push(`⏳ ${bulletBlock(`نزدیک اتمام (${faNum(ahead)} روز / بیش از ${faNum(alertPercent)}٪ حجم): ${faNum(soon.length)}`, soon)}`);

  block.push(`فعال: <b>${faNum(stats.active)}</b> از <b>${faNum(stats.packages)}</b> بسته`);
  const panelName = esc(String(settings.getSetting('general').panelName || 'Sulduz Cloud'));
  const text = `${block.join('\n\n')}\n<i>${panelName} · ${esc(faTime(at))}</i>`;
  if (text.length <= TEXT_MAX) return text;
  return `${text.slice(0, TEXT_MAX - 40)}\n…<i>متن بلند بود و بریده شد</i>`;
}

function digestText(data, results, at = Date.now()) {
  const lines = [];
  for (const result of results) {
    const one = data.get(result.userId);
    const name = result.username || `#${result.userId}`;
    const counts = one
      ? `خرید ${faNum(one.stats.created)} · تمام‌شده ${faNum(one.stats.ended + one.stats.depleted)} · نزدیک اتمام ${faNum(one.stats.endingSoon + one.stats.almostOutOfQuota)}`
      : '—';
    lines.push(`• <code>${esc(name)}</code>: ${counts} — ${result.sent ? '✅ ارسال شد' : `❌ ${esc(result.reason || 'ارسال نشد')}`}`);
  }
  const totals = [...data.values()].reduce(
    (acc, item) => {
      acc.created += item.stats.created;
      acc.ended += item.stats.ended + item.stats.depleted;
      acc.soon += item.stats.endingSoon + item.stats.almostOutOfQuota;
      acc.spend += item.stats.spend;
      acc.traffic += item.stats.traffic;
      return acc;
    },
    { created: 0, ended: 0, soon: 0, spend: 0, traffic: 0 }
  );
  const sentOk = results.filter((result) => result.sent).length;
  const currency = settings.getSetting('billing').currency || 'تومان';
  return [
    `🗓 <b>گزارش شبانهٔ نماینده‌ها</b> — ${esc(faDate(at))}`,
    `نماینده‌ها: <b>${faNum(results.length)}</b> · ارسال موفق: <b>${faNum(sentOk)}</b> · بی‌آی‌دی یا ناموفق: <b>${faNum(results.length - sentOk)}</b>`,
    `جمع امروز: خرید <b>${faNum(totals.created)}</b> بسته · تمام‌شده <b>${faNum(totals.ended)}</b> · نزدیک اتمام <b>${faNum(totals.soon)}</b>`,
    `هزینهٔ امروز همهٔ نماینده‌ها: <b>${faNum(totals.spend)}</b> ${esc(currency)} · ترافیک: <b>${faBytes(totals.traffic)}</b>`,
    lines.length ? lines.join('\n') : '<code>نماینده‌ای آیدی تلگرام ندارد</code>',
  ].join('\n\n');
}

// ------------------------------------------------------------------ recipients

function recipients() {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, username, name, telegram_id FROM users
       WHERE role = 'reseller' AND status = 'active' AND deleted_at = 0
         AND telegram_id <> '' ORDER BY id`
    )
    .all();
}

function alreadySent(userId, kind, day) {
  const row = getDb()
    .prepare('SELECT ok, error, sent_at FROM daily_reports WHERE user_id = ? AND kind = ? AND day = ?')
    .get(Number(userId), kind, day);
  return Boolean(row && Number(row.ok) === 1);
}

function record(userId, kind, day, chatId, ok, error, stats) {
  // A day counts as delivered as soon as one attempt got through, and a later
  // failure must not take that proof away: it would flip the once-per-day guard
  // back to "not sent" and the next run — or the next boot of the timer — would
  // hand the same reseller the same report a second time.
  const db = getDb();
  const before = db
    .prepare('SELECT id, ok FROM daily_reports WHERE user_id = ? AND kind = ? AND day = ?')
    .get(Number(userId), kind, day);
  if (before && Number(before.ok) === 1 && !ok) return;
  db.prepare(
    `INSERT INTO daily_reports (user_id, kind, day, chat_id, ok, error, stats, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, kind, day) DO UPDATE SET
       chat_id = excluded.chat_id, ok = excluded.ok, error = excluded.error,
       stats = excluded.stats, sent_at = excluded.sent_at`
  ).run(
    Number(userId), kind, day, String(chatId || ''), ok ? 1 : 0, String(error || '').slice(0, 300),
    JSON.stringify(stats || {}), Date.now()
  );
}

// A chat that was never started, a blocked bot, a bad id: the owner has to see
// WHICH one it was, because "the reseller says he got nothing" is otherwise
// unanswerable.
function reasonOf(err) {
  const message = String(err?.message || err || 'unknown');
  if (/can't initiate conversation|chat not found|bot was blocked|user is deactivated/i.test(message)) {
    return `ربات استارت نشده · ${message.replace(/^Telegram:\s*/i, '').slice(0, 120)}`;
  }
  return message.slice(0, 200);
}

/**
 * Build the report for one reseller without sending anything. Used by the
 * preview route and by the nightly timer.
 */
function preview(userId, at = Date.now()) {
  const data = collect(userId, at);
  return {
    userId: data.user.id,
    username: data.user.username,
    telegramId: String(data.user.telegram_id || ''),
    day: data.win.day,
    text: resellerText(data, at),
    stats: data.stats,
  };
}

/**
 * Send the nightly reports. Returns what happened per recipient; it never throws
 * for one bad chat because one reseller must not stop the others.
 */
async function sendDaily({ at = Date.now(), force = false } = {}) {
  const cfg = reportConfig();
  const win = windowOf(at);
  const summary = {
    day: win.day, at, attempted: 0, sent: 0, failed: 0, skipped: 0,
    noTelegramId: 0, results: [], owner: null,
  };
  const rows = recipients();
  const allResellers = getDb()
    .prepare("SELECT id, username FROM users WHERE role = 'reseller' AND status = 'active' AND deleted_at = 0 AND telegram_id = ''")
    .all();
  summary.noTelegramId = allResellers.length;

  const data = new Map();
  const results = [];
  for (const row of rows) {
    const chatId = String(row.telegram_id || '').trim();
    const item = { userId: Number(row.id), username: row.username, chatId, sent: false, reason: '' };
    if (!cfg.toResellers) {
      item.reason = 'ارسال برای نماینده‌ها خاموش است';
      results.push(item);
      continue;
    }
    if (!/^-?\d+$/.test(chatId)) {
      item.reason = 'آیدی عددی معتبر نیست';
      results.push(item);
      continue;
    }
    let built;
    try {
      built = collect(row.id, at);
      data.set(item.userId, built);
      item.stats = built.stats;
    } catch (err) {
      item.reason = reasonOf(err);
      results.push(item);
      summary.failed += 1;
      continue;
    }
    if (!force && alreadySent(item.userId, 'reseller', win.day)) {
      item.reason = 'امروز ارسال شده بود';
      item.skipped = true;
      results.push(item);
      summary.skipped += 1;
      continue;
    }
    const text = resellerText(built, at);
    summary.attempted += 1;
    try {
      await telegram.sendMessageTo(chatId, text);
      item.sent = true;
      summary.sent += 1;
      record(item.userId, 'reseller', win.day, chatId, true, '', built.stats);
    } catch (err) {
      item.reason = reasonOf(err);
      summary.failed += 1;
      record(item.userId, 'reseller', win.day, chatId, false, item.reason, built.stats);
    }
    results.push(item);
  }
  summary.results = results;

  if (cfg.toOwner) {
    if (!cfg.panelChatId) {
      summary.owner = { sent: false, reason: 'Chat ID پنل در تنظیمات تلگرام خالی است' };
    } else if (!force && alreadySent(0, 'owner', win.day)) {
      summary.owner = { sent: false, skipped: true, reason: 'امروز ارسال شده بود' };
    } else {
      const text = digestText(data, results, at);
      try {
        await telegram.sendMessageTo(cfg.panelChatId, text);
        summary.owner = { sent: true, chatId: cfg.panelChatId };
        record(0, 'owner', win.day, cfg.panelChatId, true, '', {
          resellers: results.length, sent: summary.sent, failed: summary.failed, skipped: summary.skipped,
        });
      } catch (err) {
        summary.owner = { sent: false, reason: reasonOf(err) };
        record(0, 'owner', win.day, cfg.panelChatId, false, summary.owner.reason, {});
      }
    }
  } else {
    summary.owner = { sent: false, reason: 'ارسال خلاصه برای مدیر خاموش است' };
  }
  return summary;
}

function history(limit = 40) {
  return getDb()
    .prepare('SELECT * FROM daily_reports ORDER BY day DESC, kind, user_id LIMIT ?')
    .all(Math.min(200, Math.max(1, Number(limit) || 40)))
    .map((row) => ({
      id: row.id,
      userId: Number(row.user_id),
      kind: row.kind,
      day: row.day,
      chatId: row.chat_id,
      ok: Boolean(row.ok),
      error: row.error,
      sentAt: Number(row.sent_at),
      stats: (() => { try { return JSON.parse(row.stats || '{}'); } catch (_) { return {}; } })(),
    }));
}

module.exports = {
  reportConfig,
  recipients,
  collect,
  packagesOf,
  windowOf,
  preview,
  sendDaily,
  history,
  recordSend: record,
  resellerText,
  digestText,
  reasonOf,
};

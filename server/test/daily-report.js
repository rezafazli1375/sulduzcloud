'use strict';

/**
 * The nightly reseller report, end to end (v1.4.27).
 *
 * Owner's request (verbatim): «اگر نمایندگان ربات تلگرام متصل به پنل یا همان ربات
 * پشتیبان گیری رو استارت کرده باشند بر اساس اون آیدی عددی تلگرامی که تو تنظیمات
 * نماینده ثبت کردیم آمار زیر رو اخر روز یا شب ارسال کنه: میزان خرید روز و موجودی
 * باقی مانده / اشتراک هایی که امروز تموم شدن و غیر فعال شدن / اشتراک هایی که نزدیک
 * به تموم شدن هستن».
 *
 * selftest.js drives the routes through a SPAWNED server, so it can never let a
 * real delivery happen: telegram.js posts to api.telegram.org and every token in a
 * test is a lie. That leaves the branch that matters — the one that walks the
 * recipients, builds each message, sends it, writes the result down and moves on
 * when one chat refuses — unexecuted. This file runs the service IN PROCESS with
 * telegram.sendMessageTo replaced by a recorder, so that branch really runs.
 *
 * Nothing here can reach the network: global.fetch is replaced by a function that
 * counts the attempt and fails it, and DATA_DIR is a throwaway directory, so no
 * production row and no real Telegram chat is involved.
 *
 *   npm run report-test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-report-'));
process.env.DATA_DIR = DATA_DIR;
process.env.BACKUP_DIR = path.join(DATA_DIR, 'backups');
process.env.NODE_ENV = 'test';
process.env.PANEL_TZ = 'Asia/Tehran';

// The one rule this file exists to enforce: no real Telegram call, ever.
let networkAttempts = 0;
global.fetch = async (url) => {
  networkAttempts += 1;
  throw new Error(`network call blocked by the report test: ${String(url).slice(0, 60)}`);
};

const { getDb, closeDb } = require('../src/db');
const settings = require('../src/settings');
const usersService = require('../src/services/users');
const telegram = require('../src/services/telegram');
const reports = require('../src/services/reports');
const config = require('../src/config');
const { dayKey, zonedDayStartMs } = require('../src/utils');

let pass = 0;
let fail = 0;
function check(name, ok, note = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}${note ? `  — ${note}` : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${note ? `  — ${note}` : ''}`); }
}

const GB = 1024 ** 3;
const DAY_MS = 86400000;
const NOW = Date.now();
const WIN = { day: dayKey(NOW, config.timezone), start: zonedDayStartMs(NOW, config.timezone) };

// The fixture has to land inside the panel's own day whatever clock it runs on: a
// suite executed five minutes after midnight in Tehran cannot call "two hours ago"
// today, and every "ended today" assertion would silently flip to yesterday.
const MOMENT_TODAY = Math.min(NOW, WIN.start + 60_000);                       // already inside the day
const EARLIER_TODAY = Math.max(WIN.start + 60_000, NOW - 3_600_000);            // for the wallet ledger
const ENDED_AT = Math.min(NOW, WIN.start + 3_600_000);                          // an expiry that passed

const PANEL_CHAT = '-1001234567890';
const GHOST_CHAT = '700600222';

// What the recorder saw. Every entry is one sendMessageTo call.
const sent = [];
telegram.sendMessageTo = async (chatId, text) => {
  const target = String(chatId || '').trim();
  if (!/^-?\d+$/.test(target)) throw new Error('آیدی عددی تلگرام معتبر نیست');
  sent.push({ chatId: target, text });
  // The chat the reseller never started with the bot — Telegram's own words.
  if (target === GHOST_CHAT) throw new Error("Telegram: bot can't initiate conversation with a user");
  return { message_id: sent.length };
};

const chatsOf = (from = 0) => sent.slice(from).map((one) => one.chatId).join(',');
const count = (sql, ...args) => Number(getDb().prepare(sql).get(...args).n);

function addConfig(userId, {
  name, email, gb, usedGb, expiryAt,
  createdAt = NOW - 10 * DAY_MS, updatedAt = NOW - DAY_MS, origin = 'panel', enabled = 1, inboundId = 10,
}) {
  getDb()
    .prepare(
      `INSERT INTO configs (user_id, inbound_id, email, sub_id, label, customer_name, total_bytes, expiry_at,
        enabled, status, up_bytes, down_bytes, last_up, last_down, last_synced_at, created_at, updated_at, origin, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, 0, ?, ?, ?, ?, 0)`
    )
    .run(
      userId, inboundId, email, `sub-${email}`, name, name,
      Math.round(gb * GB), Math.round(expiryAt), enabled,
      Math.round(usedGb * GB), Math.round(usedGb * GB), NOW, createdAt, updatedAt, origin
    );
}

function addMoney(userId, type, amount, description) {
  getDb()
    .prepare('INSERT INTO transactions (user_id, type, amount, balance_after, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(userId, type, amount, 0, description, EARLIER_TODAY);
}

function addUsage(userId, day, up, down) {
  getDb()
    .prepare('INSERT INTO usage_daily (config_id, user_id, day, up_bytes, down_bytes) VALUES (0, ?, ?, ?, ?)')
    .run(userId, day, up, down);
}

function makeReseller(username, { telegramId = '', balance = 0, importConfigs = 1, status = 'active' } = {}) {
  const created = usersService.createUser({ username, password: 'Report-Pass-12345', role: 'reseller', telegram_id: telegramId, balance });
  getDb().prepare('UPDATE users SET import_configs = ?, status = ? WHERE id = ?').run(importConfigs, status, created.id);
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(created.id);
}

async function main() {
  const db = getDb();

  const ok1 = makeReseller('tgok', { telegramId: '700600111', balance: 4321000 });
  const ghost = makeReseller('tgghost', { telegramId: GHOST_CHAT });
  const noId = makeReseller('tgnoid');
  const parked = makeReseller('tgdisabled', { telegramId: '700600333', status: 'disabled' });
  const hidden = makeReseller('tghide', { telegramId: '700600444', importConfigs: 0 });

  // tgok owns every situation the owner named, plus one three-inbound customer.
  addConfig(ok1.id, { name: 'خرید-امروز', email: 'tgok-new', gb: 30, usedGb: 1, expiryAt: NOW + 30 * DAY_MS, createdAt: MOMENT_TODAY });
  addConfig(ok1.id, { name: 'تمام-شد-امروز', email: 'tgok-ended', gb: 10, usedGb: 4, expiryAt: ENDED_AT });
  addConfig(ok1.id, { name: 'نزدیک-اتمام', email: 'tgok-soon', gb: 20, usedGb: 5, expiryAt: NOW + 2 * DAY_MS });
  addConfig(ok1.id, { name: 'حجم-تمام', email: 'tgok-depleted', gb: 10, usedGb: 10, expiryAt: NOW + 20 * DAY_MS, updatedAt: NOW });
  addConfig(ok1.id, { name: 'حجم-۹۵درصد', email: 'tgok-ninety', gb: 10, usedGb: 9.5, expiryAt: NOW + 25 * DAY_MS });
  addConfig(ok1.id, { name: 'سه-اینباندی', email: 'tgok-multi', gb: 40, usedGb: 8, expiryAt: NOW + 15 * DAY_MS, inboundId: 10 });
  addConfig(ok1.id, { name: 'سه-اینباندی', email: 'tgok-multi', gb: 40, usedGb: 8, expiryAt: NOW + 15 * DAY_MS, inboundId: 20 });
  addConfig(ok1.id, { name: 'سه-اینباندی', email: 'tgok-multi', gb: 40, usedGb: 9, expiryAt: NOW + 15 * DAY_MS, inboundId: 30 });
  addMoney(ok1.id, 'purchase', -37500, 'خرید اشتراک');
  addMoney(ok1.id, 'renew', -110000, 'تمدید');
  addMoney(ok1.id, 'topup', 100000, 'افزایش موجودی');
  addUsage(ok1.id, WIN.day, 2 * GB, GB / 2);

  addConfig(ghost.id, { name: 'مشتری-Ghost', email: 'tgghost-1', gb: 5, usedGb: 1, expiryAt: NOW + 9 * DAY_MS });
  addConfig(noId.id, { name: 'مشتری-بی‌آیدی', email: 'tgnoid-1', gb: 5, usedGb: 1, expiryAt: NOW + 9 * DAY_MS });
  addConfig(parked.id, { name: 'مشتری-غیرفعال', email: 'tgdis-1', gb: 5, usedGb: 1, expiryAt: NOW + 9 * DAY_MS });
  // hidden is the reseller who switched adopted subscriptions off for himself
  addConfig(hidden.id, { name: 'نود-پنهان', email: 'tghide-ext', gb: 8, usedGb: 2, expiryAt: NOW + 4 * DAY_MS, origin: 'external' });
  addConfig(hidden.id, { name: 'پنل-دیده', email: 'tghide-panel', gb: 8, usedGb: 3, expiryAt: NOW + 4 * DAY_MS, origin: 'panel' });

  const okRows = db.prepare('SELECT * FROM configs WHERE user_id = ? AND deleted_at = 0').all(ok1.id);
  const okPackages = reports.packagesOf(okRows);
  const multi = okPackages.find((pack) => pack.email === 'tgok-multi') || {};
  check('the fixture is five resellers, and eight rows for tgok are six customer packages',
    count("SELECT count(*) AS n FROM users WHERE role = 'reseller' AND deleted_at = 0") === 5
      && okRows.length === 8 && okPackages.length === 6,
    `rows=${okRows.length} packages=${okPackages.length}`);

  // ------------------------------------------------------------ ships switched off
  check('the report ships switched off, so an upgrade cannot start messaging people',
    reports.reportConfig().enabled === false, `enabled=${reports.reportConfig().enabled}`);

  settings.updateSection('telegram', {
    enabled: true, botToken: '123456:report-test-token', chatId: PANEL_CHAT,
    dailyReportEnabled: true, dailyReportHour: 23, dailyReportMinute: 30, dailyReportDaysAhead: 3,
  });
  const cfg = reports.reportConfig();
  check('the schedule, the bot and both recipients come out of the saved settings',
    cfg.enabled === true && cfg.hour === 23 && cfg.minute === 30 && cfg.toResellers === true
      && cfg.toOwner === true && cfg.daysAhead === 3 && cfg.panelChatId === PANEL_CHAT && cfg.botToken.length > 0,
    `hour=${cfg.hour}:${cfg.minute} ahead=${cfg.daysAhead}`);

  // -------------------------------------------------------------------- collect
  const data = reports.collect(ok1.id, NOW);
  const s = data.stats;
  check('the three things the owner named are counted out of the rows themselves',
    s.created === 1 && s.ended === 1 && s.depleted === 1 && s.endingSoon === 1 && s.almostOutOfQuota === 1,
    JSON.stringify({ created: s.created, ended: s.ended, depleted: s.depleted, soon: s.endingSoon, quota: s.almostOutOfQuota }));
  check('a customer on three inbounds is one package in the report, not three',
    okPackages.filter((pack) => pack.email === 'tgok-multi').length === 1
      && multi.inbounds === 3 && multi.used === Math.round(9 * GB) && multi.quota === Math.round(40 * GB),
    `inbounds=${multi.inbounds} used=${multi.used}`);
  check('what is left in the wallet is the reseller balance, not the fleet total',
    s.balance === 4321000 && s.packages === 6 && s.active === 5,
    `balance=${s.balance} active=${s.active}/${s.packages}`);
  check('the traffic line reads the day ledger the accrual writes, not the node counter',
    s.traffic === Math.round(2.5 * GB), `traffic=${s.traffic}`);

  // while the tariff is off the money lines must say so instead of printing zero
  const offText = reports.resellerText(data, NOW);
  check('with the tariff switched off the report says so, and does not pretend nothing was spent',
    offText.includes('تعرفه خاموش است') && !offText.includes('۱۴۷٬۵۰۰'), '');

  settings.updateSection('billing', { enabled: true, currency: 'تومان' });
  const priced = reports.collect(ok1.id, NOW);
  check('with the tariff on, the day of spending and the day of top-up come from the wallet ledger',
    priced.stats.spend === 147500 && priced.stats.topup === 100000 && priced.stats.renewals === 1,
    JSON.stringify({ spend: priced.stats.spend, topup: priced.stats.topup, renewals: priced.stats.renewals }));

  const text = reports.resellerText(priced, NOW);
  // Persian text uses the ۰-۹ digits, which `\d` does not match, so the date is
  // checked after translating it back to ASCII.
  const ascii = (s) => String(s).replace(/[۰-۹]/g, (d) => String(d.codePointAt(0) - 0x6f0));
  const faDateSeen = (ascii(text).match(/14\d\d\/\d\d\/\d\d/) || [''])[0];
  check('the message is dated in the panel timezone and inside what Telegram accepts',
    text.includes('گزارش روزانه') && /14\d\d\/\d\d\/\d\d/.test(ascii(text)) && text.length < 4096,
    `length=${text.length} date=${faDateSeen}`);
  check('it carries all three sections the owner asked for',
    text.includes('خرید امروز و موجودی') && text.includes('امروز تمام شد') && text.includes('نزدیک اتمام'),
    `blocks=${text.split('<b>').length - 1}`);
  check('the packages that ended, ran out of volume, or are about to end are named',
    text.includes('تمام-شد-امروز') && text.includes('حجم-تمام') && text.includes('نزدیک-اتمام')
      && text.includes('حجم-۹۵درصد'), '');
  check('the wallet balance and the day of spending are both stated in Persian figures',
    text.includes('موجودی کیف پول') && text.includes('۴٬۳۲۱٬۰۰۰') && text.includes('۱۴۷٬۵۰۰'), '');
  check('a customer name can never forge Telegram markup',
    !/<(?!\/?(?:b|i|code|u|s|strike|blockquote)\b)[^>]*>/.test(text), '');

  const hiddenData = reports.collect(hidden.id, NOW);
  check('a reseller who switched adopted subscriptions off does not get them back in a report',
    hiddenData.stats.packages === 1 && !reports.resellerText(hiddenData, NOW).includes('نود-پنهان'),
    `packages=${hiddenData.stats.packages}`);

  // ------------------------------------------------------------------ recipients
  const list = reports.recipients();
  check('the recipient list is active resellers with a saved telegram id, ordered by id',
    list.map((row) => row.username).join(',') === 'tgok,tgghost,tghide',
    `recipients=${list.map((row) => `${row.username}:${row.telegram_id}`).join(' ')}`);
  check('the ones with no telegram id are counted, so the owner can see who is missing out',
    count("SELECT count(*) AS n FROM users WHERE role = 'reseller' AND status = 'active' AND deleted_at = 0 AND telegram_id = ''") === 1, '');

  // --------------------------------------------------------------------- the run
  sent.length = 0;
  const run1 = await reports.sendDaily({ at: NOW });
  check('one run attempts every recipient, delivers the reachable chats and records the one that refused',
    run1.attempted === 3 && run1.sent === 2 && run1.failed === 1 && run1.skipped === 0,
    JSON.stringify({ attempted: run1.attempted, sent: run1.sent, failed: run1.failed, skipped: run1.skipped }));
  check('the chats contacted are exactly the three recipients plus the owner, and no stranger',
    chatsOf() === `700600111,${GHOST_CHAT},700600444,${PANEL_CHAT}`, `chats=${chatsOf()}`);
  check('each reseller message is his own: the one sent to tghide does not name tgok',
    sent[2].chatId === '700600444' && sent[2].text.includes('tghide') && !sent[2].text.includes('tgok'), '');
  check('the owner gets a digest of the whole fleet, not a copy of one reseller message',
    sent[sent.length - 1].chatId === PANEL_CHAT && sent[sent.length - 1].text.includes('شبانهٔ نماینده‌ها')
      && sent[sent.length - 1].text.includes('tgok') && sent[sent.length - 1].text.includes('tgghost'),
    `len=${sent[sent.length - 1].text.length}`);
  check('a chat that was never started is written down with that reason, in Persian',
    /ربات استارت نشده/.test((run1.results.find((one) => one.username === 'tgghost') || {}).reason || ''),
    (run1.results.find((one) => one.username === 'tgghost') || {}).reason);
  check('one refusal does not stop the reseller after it',
    run1.results.length === 3 && run1.results.filter((one) => one.sent).length === 2, '');
  check('the delivery is remembered per recipient per day, success and failure alike',
    count('SELECT count(*) AS n FROM daily_reports WHERE day = ?', WIN.day) === 4
      && count('SELECT count(*) AS n FROM daily_reports WHERE day = ? AND ok = 1', WIN.day) === 3,
    `rows=${count('SELECT count(*) AS n FROM daily_reports WHERE day = ?', WIN.day)}`);

  const before2 = sent.length;
  const run2 = await reports.sendDaily({ at: NOW });
  check('the same day run again sends nobody a second message, and retries only what failed',
    run2.attempted === 1 && run2.sent === 0 && run2.skipped === 2
      && chatsOf(before2) === GHOST_CHAT && run2.owner.sent === false && run2.owner.skipped === true,
    `attempted=${run2.attempted} skipped=${run2.skipped} chats=${chatsOf(before2)} owner=${JSON.stringify(run2.owner)}`);
  check('the retry of the failed chat updates its row instead of adding a second one',
    count("SELECT count(*) AS n FROM daily_reports WHERE kind = 'reseller' AND user_id = ?", ghost.id) === 1, '');

  const before3 = sent.length;
  const run3 = await reports.sendDaily({ at: NOW, force: true });
  check('a forced run — the button on the settings page — ignores the ledger and sends again',
    run3.attempted === 3 && run3.sent === 2 && sent.length - before3 === 4,
    `attempted=${run3.attempted} sent=${run3.sent} calls=${sent.length - before3}`);

  // ------------------------------------------------------------- the two switches
  settings.updateSection('telegram', { dailyReportResellers: false });
  sent.length = 0;
  const run4 = await reports.sendDaily({ at: NOW, force: true });
  check('with the reseller switch off only the owner digest leaves the server',
    run4.attempted === 0 && run4.sent === 0 && chatsOf() === PANEL_CHAT && run4.owner.sent === true,
    `chats=${chatsOf()}`);
  check('and every reseller is told why he was not sent to',
    run4.results.length === 3 && run4.results.every((one) => /خاموش/.test(one.reason || '')), '');

  settings.updateSection('telegram', { dailyReportResellers: true, dailyReportOwner: false });
  sent.length = 0;
  const run5 = await reports.sendDaily({ at: NOW, force: true });
  check('with the owner switch off the resellers still get theirs and no digest is built',
    run5.sent === 2 && run5.owner.sent === false && /خاموش/.test(run5.owner.reason)
      && !sent.some((one) => one.chatId === PANEL_CHAT),
    `sent=${run5.sent} owner=${JSON.stringify(run5.owner)}`);

  settings.updateSection('telegram', { dailyReportOwner: true, chatId: '' });
  sent.length = 0;
  const run6 = await reports.sendDaily({ at: NOW, force: true });
  check('an empty panel chat id is reported as that, and the resellers are still served',
    run6.owner.sent === false && /خالی/.test(run6.owner.reason) && run6.sent === 2
      && !sent.some((one) => one.chatId === PANEL_CHAT),
    JSON.stringify(run6.owner));

  // The owner chat now refuses, after his digest already went out that day. The
  // row must keep its proof of success: losing it would make the once-per-day
  // guard say "not sent" and hand the panel a second digest on the next run.
  settings.updateSection('telegram', { chatId: GHOST_CHAT });
  sent.length = 0;
  const run7 = await reports.sendDaily({ at: NOW, force: true });
  const ownerRow = getDb()
    .prepare("SELECT ok, chat_id FROM daily_reports WHERE kind = 'owner' AND day = ?")
    .get(WIN.day);
  check('a failed digest cannot erase the proof the same day was already delivered',
    run7.owner.sent === false && ownerRow.ok === 1 && ownerRow.chat_id === PANEL_CHAT,
    JSON.stringify({ owner: run7.owner, row: ownerRow }));
  settings.updateSection('telegram', { chatId: PANEL_CHAT });

  // ------------------------------------------------------------- length and lists
  const many = makeReseller('tgmany', { telegramId: '700600555' });
  for (let i = 1; i <= 40; i += 1) {
    addConfig(many.id, { name: `مشتری ${i}`, email: `tgmany-${i}`, gb: 5, usedGb: 1, expiryAt: NOW + 2 * DAY_MS });
  }
  const manyText = reports.resellerText(reports.collect(many.id, NOW), NOW);
  check('forty customers still fit one Telegram message, with the rest counted, not dropped',
    manyText.length <= 4096 && manyText.includes('مورد دیگر') && manyText.includes('۲۰'),
    `length=${manyText.length}`);

  const escaped = makeReseller('tgesc', { telegramId: '700600666' });
  addConfig(escaped.id, { name: '<b>احمد</b> & علی', email: 'tgesc-1', gb: 5, usedGb: 1, expiryAt: NOW + 2 * DAY_MS });
  const escText = reports.resellerText(reports.collect(escaped.id, NOW), NOW);
  check('a customer named with angle brackets arrives escaped',
    escText.includes('&lt;b&gt;') && !escText.includes('<b>احمد</b>'), `len=${escText.length}`);

  // ------------------------------------------------------------------ the guards
  check('no report run ever reached the network: api.telegram.org was never called',
    networkAttempts === 0, `networkAttempts=${networkAttempts}`);
  check('the history the settings page reads is that table, newest day first',
    reports.history(50).length === 4 && reports.history(50).every((row) => row.day === WIN.day),
    `rows=${reports.history(50).length}`);
  check('a preview is built without sending anything, which is what the Eye button does',
    (() => {
      const before = sent.length;
      const one = reports.preview(ok1.id, NOW);
      return sent.length === before && one.userId === ok1.id && one.telegramId === '700600111'
        && one.day === WIN.day && one.text.includes('گزارش روزانه') && one.stats.packages === 6;
    })(), `stats=${JSON.stringify(reports.preview(ok1.id, NOW).stats).slice(0, 140)}`);
}

main()
  .catch((err) => {
    fail += 1;
    console.log(`  FAIL the report suite threw: ${err && err.stack ? err.stack : err}`);
  })
  .finally(() => {
    console.log(`\nreport-test: ${pass} passed, ${fail} failed  (throwaway data dir removed)`);
    try { closeDb(); } catch (_) { /* already closed */ }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    process.exit(fail === 0 ? 0 : 1);
  });

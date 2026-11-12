'use strict';

/**
 * The panel's own two-way Telegram bot (v1.5.3).
 *
 * A reseller talks to the SAME bot the panel already uses for backups and the
 * nightly report — no second bot, no second token. He can:
 *   • see his wallet balance and his last transactions,
 *   • see his packages by state — active, running out, out of volume, expired,
 *     disabled — and his traffic,
 *   • send a payment receipt, which is forwarded to the admin's chat with
 *     «تایید و شارژ» / «رد» buttons. The wallet moves only when the admin taps تایید.
 *
 * An admin gets his OWN keyboard in the same chat: the reseller list with every
 * wallet, the pending receipts, and a charge/deduct conversation that targets a
 * reseller by his numeric Telegram id (or username) and moves the wallet through
 * usersService.adjustBalance — the very function the panel's own edit drawer
 * calls, so a bot charge and a panel charge write the same transaction row.
 *
 * Rules this file is written against:
 *   - identity is `users.telegram_id` and nothing else. A chat that is not linked
 *     to an account is told so (with its own numeric id, so the owner can link
 *     it) and is never shown anybody's data;
 *   - only an admin may decide a receipt or touch a wallet: either his own
 *     telegram_id belongs to an admin account, or the tap happened in the
 *     configured admin chat. The admin money flow re-checks that on EVERY step,
 *     so a stolen callback payload cannot move a balance;
 *   - the money lives in services/topups.js and services/users.js. This file only
 *     delivers messages and asks for confirmation before it calls them, so the
 *     panel's own approve button and the Telegram button cannot disagree;
 *   - every amount is re-parsed and re-capped on the confirm tap: the number that
 *     is executed is the number on the confirmation screen, never a stale one;
 *   - the bot must never take the panel down: every update is handled inside a
 *     try/catch, the offset is stored BEFORE handling (a poison update cannot
 *     loop forever), and a 409 Conflict — another poller or a webhook owns this
 *     bot — stops polling with one clear log line instead of hammering Telegram.
 *
 * Long polling is safe here because the panel's bot has no webhook: start()
 * checks getWebhookInfo first and refuses to poll if one is set.
 */

const config = require('../config');
const { getDb } = require('../db');
const settings = require('../settings');
const telegram = require('./telegram');
const topups = require('./topups');
const usersService = require('./users');
const stats = require('./stats');
const { ApiError, log, logError } = require('../utils');

const POLL_TIMEOUT_SEC = 25;
const STEP_TTL_MS = 30 * 60 * 1000;
const IDLE_SLEEP_MS = 15000;
const TEXT_MAX = 4096;
const GIB = 1024 ** 3;
const DAY_MS = 86400000;
const PAGE_ROWS = 8;

// Reseller keyboard. Six buttons, the money path first, because that is what a
// reseller actually comes here for; آمار اشتراک‌ها is the «تموم‌شده / در حال اتمام»
// view the owner asked for, and آمار مصرف stays the traffic view it grew out of.
const BTN_BALANCE = '💰 موجودی';
const BTN_TOPUP = '💳 افزایش موجودی';
const BTN_PACKAGES = '📦 آمار اشتراک‌ها';
const BTN_RECEIPTS = '🧾 فیش‌های من';
const BTN_STATS = '📊 آمار مصرف';
const BTN_HELP = '📖 راهنما';
const BTN_CANCEL = '❌ لغو';

// Admin keyboard: the owner's own views, never mixed with the reseller's.
const BTN_A_RESELLERS = '👥 آمار نمایندگان';
const BTN_A_MONEY = '💰 شارژ/کسر نماینده';
const BTN_A_PENDING = '🧾 فیش‌های در انتظار';
const BTN_A_HELP = '📖 راهنمای مدیر';

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
  if (n >= GIB) return `${(n / GIB).toFixed(n / GIB >= 10 ? 1 : 2)} گیگ`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} مگ`;
  if (n > 0) return `${(n / 1024).toFixed(0)} کیلوبایت`;
  return '۰';
}

/**
 * The direction of a wallet move, read from whatever the caller holds: the '+'
 * and '-' that ride in a callback payload, the '-1' a step stores, or a plain
 * negative number. Number('-') is NaN, so a bare sign character has to be read as
 * text first — deciding the direction of a charge by Number() alone would silently
 * turn a deduction into an increase.
 */
function isMinus(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim();
  if (raw.startsWith('-')) return true;
  return Number(raw) < 0;
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

function currency() {
  return String(settings.getSetting('billing').currency || 'تومان');
}

function panelName() {
  return String(settings.getSetting('general').panelName || 'Sulduz Cloud');
}

function clip(text) {
  const body = String(text || '');
  return body.length <= TEXT_MAX ? body : `${body.slice(0, TEXT_MAX - 30)}\n…<i>متن بریده شد</i>`;
}

// ------------------------------------------------------------------ small state

function stateGet(key) {
  const row = getDb().prepare('SELECT value FROM bot_state WHERE key = ?').get(String(key));
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch (_) {
    return null;
  }
}

function stateSet(key, value) {
  getDb()
    .prepare(
      `INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(String(key), JSON.stringify(value === undefined ? null : value), Date.now());
}

function stateDel(key) {
  getDb().prepare('DELETE FROM bot_state WHERE key = ?').run(String(key));
}

const chatKey = (chatId) => `chat:${String(chatId)}`;

/** The conversation step of one chat, or null when it expired / never existed. */
function stepOf(chatId) {
  const state = stateGet(chatKey(chatId));
  if (!state || !state.step) return null;
  if (Date.now() - Number(state.at || 0) > STEP_TTL_MS) {
    stateDel(chatKey(chatId));
    return null;
  }
  return state;
}

function setStep(chatId, patch) {
  const current = stepOf(chatId) || {};
  stateSet(chatKey(chatId), { ...current, ...patch, at: Date.now() });
}

function clearStep(chatId) {
  stateDel(chatKey(chatId));
}

// ------------------------------------------------------------------ identity

function userByTelegramId(telegramId) {
  const id = String(telegramId || '').trim();
  if (!/^\d{4,20}$/.test(id)) return null;
  return getDb().prepare('SELECT * FROM users WHERE telegram_id = ? AND deleted_at = 0').get(id) || null;
}

/**
 * Who is allowed to decide a receipt. An admin account linked to this telegram
 * id may decide from anywhere; anybody writing in the configured admin chat may
 * decide too (that chat IS the owner's own chat or his private admin group).
 * Returns { id, role, username } or null.
 */
function adminActor(fromId, chatId) {
  const db = getDb();
  const own = userByTelegramId(fromId);
  if (own && own.role === 'admin' && own.status === 'active') {
    return { id: Number(own.id), role: 'admin', username: own.username };
  }
  const adminChat = String(telegram.botConfig().adminChatId || '').trim();
  if (adminChat && String(chatId) === adminChat) {
    const owner = db
      .prepare("SELECT id, username FROM users WHERE role = 'admin' AND deleted_at = 0 ORDER BY id LIMIT 1")
      .get();
    return { id: Number(owner?.id || 0), role: 'admin', username: String(owner?.username || 'owner') };
  }
  return null;
}

// ------------------------------------------------------------------ keyboards

/**
 * v1.5.3: which reseller is the admin talking about? A numeric Telegram id is
 * the exact answer and the one the panel shows everywhere; a username is the
 * convenient one. Either has to resolve to a live RESSELLER account — an admin
 * must not be able to charge the owner's own wallet by typing a name, and a
 * deleted reseller must not get money he cannot spend.
 */
function resellerByIdentity(raw) {
  const needle = String(raw || '').trim().replace(/^@/, '');
  if (!needle) return null;
  let found = null;
  if (/^\d{4,20}$/.test(needle)) found = userByTelegramId(needle);
  else found = getDb().prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE AND deleted_at = 0").get(needle) || null;
  if (!found || found.role === 'admin' || found.status !== 'active') return null;
  return found;
}

/**
 * The bot's own username, from getMe, cached in bot_state: the panel needs it
 * for the «افزایش موجودی از طریق ربات» link, and the help text wants it for
 * /start deep links. Best effort — an empty answer only means the link cannot
 * be promised yet, never that the bot is down.
 */
async function botUsername(force = false) {
  if (!force) {
    const cached = stateGet('bot_username');
    if (cached) return String(cached || '');
  }
  try {
    const me = await telegram.call('getMe', {}, { timeoutMs: 15000 });
    const username = String(me?.username || '');
    stateSet('bot_username', username);
    return username;
  } catch (err) {
    logError('[bot] getMe failed:', err.message);
    return String(stateGet('bot_username') || '');
  }
}

/**
 * The username already in the cache, with no network call at all: the panel's
 * header and settings card render synchronously and must never wait on Telegram
 * for a label. Empty means the poller has not fetched getMe yet.
 */
function cachedBotUsername() {
  return String(stateGet('bot_username') || '');
}

/**
 * The one link the panel shows for «افزایش موجودی از طریق ربات». `payload` is
 * the /start argument, so a link can open any section, not only the top-up.
 * Without a known username it is empty — the panel then says the bot has not
 * announced itself yet instead of showing a broken link.
 */
function deepLink(payload = 'topup', name = '') {
  const bot = String(name || cachedBotUsername() || '').trim();
  if (!bot) return '';
  return `https://t.me/${bot}?start=${String(payload || 'menu')}`;
}

/**
 * The native command menu. Resellers get the wallet commands in private chats;
 * the admin's own commands go only to the chat the receipts are posted in, so a
 * reseller never sees a «pending» he cannot use. Failure is a log line: the
 * buttons work with or without the menu.
 */
async function registerCommands() {
  const commands = [
    { command: 'start', description: 'منوی ربات' },
    { command: 'balance', description: 'موجودی کیف پول' },
    { command: 'packages', description: 'آمار اشتراک‌ها' },
    { command: 'stats', description: 'آمار مصرف' },
    { command: 'topup', description: 'افزایش موجودی با فیش' },
    { command: 'receipts', description: 'فیش‌های من' },
    { command: 'help', description: 'راهنما' },
    { command: 'cancel', description: 'لغو درخواست جاری' },
  ];
  const adminCommands = [
    { command: 'start', description: 'منوی مدیر' },
    { command: 'resellers', description: 'آمار نمایندگان و موجودی‌ها' },
    { command: 'money', description: 'افزایش یا کاهش موجودی نماینده' },
    { command: 'pending', description: 'فیش‌های در انتظار' },
    { command: 'balance', description: 'موجودی خودتان' },
    { command: 'help', description: 'راهنما' },
  ];
  const adminChat = String(telegram.botConfig().adminChatId || '').trim();
  try {
    await telegram.call('setMyCommands', { commands, scope: { type: 'all_private_chats' } }, { timeoutMs: 15000 });
    if (adminChat && /^-?\d{4,20}$/.test(adminChat)) {
      await telegram.call(
        'setMyCommands',
        { commands: adminCommands, scope: { type: 'chat', chat_id: Number(adminChat) } },
        { timeoutMs: 15000 }
      );
    }
  } catch (err) {
    logError('[bot] setMyCommands failed:', err.message);
  }
  return { commands: commands.length, adminCommands: adminCommands.length, adminChat: Boolean(adminChat) };
}

// ------------------------------------------------------------------ keyboards

function menuKeyboard() {
  return {
    keyboard: [
      [{ text: BTN_BALANCE }, { text: BTN_PACKAGES }],
      [{ text: BTN_TOPUP }, { text: BTN_RECEIPTS }],
      [{ text: BTN_STATS }, { text: BTN_HELP }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/**
 * v1.5.3: the admin's own reply keyboard. It appears in the chat the receipts are
 * posted to — the configured admin chat, or a private chat with an account whose
 * telegram_id belongs to an admin — so the two keyboards never fight over one
 * reseller's menu.
 */
function adminMenuKeyboard() {
  return {
    keyboard: [
      [{ text: BTN_A_RESELLERS }, { text: BTN_A_MONEY }],
      [{ text: BTN_A_PENDING }, { text: BTN_A_HELP }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function cancelKeyboard() {
  return { keyboard: [[{ text: BTN_CANCEL }]], resize_keyboard: true, one_time_keyboard: true };
}

function decisionKeyboard(id) {
  return {
    inline_keyboard: [[
      { text: '✅ تایید و شارژ', callback_data: `topup:ok:${Number(id)}` },
      { text: '❌ رد', callback_data: `topup:no:${Number(id)}` },
    ]],
  };
}

/** Step 2 of the admin money flow: which way does this wallet move? */
function moneyChoiceKeyboard(userId) {
  const id = Number(userId);
  return {
    inline_keyboard: [
      [
        { text: '➕ افزایش موجودی', callback_data: `bal:set:${id}:+` },
        { text: '➖ کاهش موجودی', callback_data: `bal:set:${id}:-` },
      ],
      [{ text: '❌ لغو', callback_data: 'bal:cancel' }],
    ],
  };
}

/**
 * Step 3: the last look before money moves. The amount and the sign are carried
 * in the payload and re-checked on the tap, so what gets executed is what the
 * admin just read — and a stale button cannot spend a newer amount.
 */
function moneyConfirmKeyboard(userId, sign, amount) {
  const id = Number(userId);
  const delta = Math.round(Number(amount));
  const minus = isMinus(sign);
  return {
    inline_keyboard: [
      [
        {
          text: minus ? `⚠️ کسر ${faNum(delta)}` : `✅ ثبت ${faNum(delta)}`,
          callback_data: `bal:do:${id}:${minus ? '-' : '+'}:${delta}`,
        },
      ],
      [{ text: '❌ تغییر نمی‌دهم', callback_data: 'bal:cancel' }],
    ],
  };
}

/** Paging for the reseller list, so a fleet of ten does not scroll forever. */
function pagerKeyboard(page, hasPrev, hasNext) {
  const row = [];
  if (hasPrev) row.push({ text: '⬅️ قبلی', callback_data: `rs:pg:${Number(page) - 1}` });
  if (hasNext) row.push({ text: 'بعدی ➡', callback_data: `rs:pg:${Number(page) + 1}` });
  if (!row.length) return undefined;
  return { inline_keyboard: [row] };
}

// ------------------------------------------------------------------ sending

async function reply(chatId, text, extra = {}) {
  return telegram.call('sendMessage', {
    chat_id: String(chatId),
    text: clip(text),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

async function replyMenu(chatId, text) {
  return reply(chatId, text, { reply_markup: menuKeyboard() });
}

async function replyAdminMenu(chatId, text) {
  return reply(chatId, text, { reply_markup: adminMenuKeyboard() });
}

// ------------------------------------------------------------------ the texts

function balanceText(user) {
  const db = getDb();
  const pending = topups.pendingCount(user.id);
  const rows = db
    .prepare(
      `SELECT type, amount, balance_after, description, created_at FROM transactions
       WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 5`
    )
    .all(Number(user.id));
  const unit = esc(currency());
  const lines = [
    `💰 <b>موجودی کیف پول</b>`,
    `نماینده: <code>${esc(user.username)}</code>${user.name ? ` (${esc(user.name)})` : ''}`,
    `موجودی: <b>${faNum(user.balance)}</b> ${unit}`,
  ];
  if (pending > 0) lines.push(`فیش در انتظار بررسی: <b>${faNum(pending)}</b>`);
  if (rows.length) {
    lines.push('', '🧾 <b>آخرین تراکنش‌ها</b>');
    for (const row of rows) {
      const sign = row.type === 'credit' ? '+' : '−';
      lines.push(`• ${sign}${faNum(row.amount)} ${unit} · ${esc(faDate(row.created_at, true))} · مانده ${faNum(row.balance_after)}`);
      if (row.description) lines.push(`  <i>${esc(String(row.description).slice(0, 90))}</i>`);
    }
  } else {
    lines.push('', '<i>هنوز تراکنشی ثبت نشده است.</i>');
  }
  lines.push('', `<i>${esc(panelName())}</i>`);
  return lines.join('\n');
}

function statsText(user) {
  const overview = stats.resellerOverview(Number(user.id));
  const c = overview.configs;
  const unit = esc(currency());
  const lines = [
    `📊 <b>آمار شما</b> — ${esc(faDate(Date.now()))}`,
    `نماینده: <code>${esc(user.username)}</code>`,
    '',
    `👥 بسته‌ها: <b>${faNum(c.total)}</b>`,
    `• فعال: ${faNum(c.active)} · منقضی: ${faNum(c.expired)} · حجم‌تمام‌شده: ${faNum(c.depleted)} · غیرفعال: ${faNum(c.disabled)}`,
    '',
    '📶 <b>ترافیک مشتریان شما</b>',
    `• امروز: <b>${faBytes(overview.today.total)}</b>`,
    `• ۷ روز: <b>${faBytes(overview.week.total)}</b>`,
    `• ۳۰ روز: <b>${faBytes(overview.month.total)}</b>`,
    '',
    `⏳ نزدیک انقضا (۳ روز): <b>${faNum(overview.expiring3d)}</b>`,
    `🎫 تیکت باز: <b>${faNum(overview.openTickets)}</b>`,
    `💰 موجودی: <b>${faNum(overview.balance)}</b> ${unit}`,
  ];
  const pending = topups.pendingCount(user.id);
  if (pending > 0) lines.push(`🧾 فیش در انتظار بررسی: <b>${faNum(pending)}</b>`);
  if (overview.topConfigs?.length) {
    lines.push('', '🏆 <b>پرمصرف‌ترین بسته‌ها (۷ روز)</b>');
    for (const row of overview.topConfigs.slice(0, 5)) {
      lines.push(`• ${esc(row.customerName || row.label || row.email)} — ${faBytes(row.usedBytes)}`);
    }
  }
  lines.push('', `<i>${esc(panelName())}</i>`);
  return lines.join('\n');
}

/**
 * v1.5.3: «آمار اشتراک‌ها». statusCounts() counts packages through the very same
 * grouping the panel's list and the dashboard use, so this chat, the KPI cards
 * and the config list can never disagree about what one customer is; the two
 * lists below the buckets are the packages the reseller has to act on.
 */
function packagesText(user) {
  const b = stats.packageBuckets(Number(user.id), 3, 6);
  const lines = [
    `📦 <b>آمار اشتراک‌های شما</b> — ${esc(faDate(Date.now()))}`,
    `نماینده: <code>${esc(user.username)}</code>`,
    '',
    `👥 بسته‌ها: <b>${faNum(b.total)}</b>`,
    `• ✅ فعال: <b>${faNum(b.active)}</b>`,
    `• ⏳ در حال اتمام (۳ روز): <b>${faNum(b.soon)}</b>`,
    `• 🛑 حجم تمام‌شده: <b>${faNum(b.depleted)}</b>`,
    `• ⌛ منقضی‌شده: <b>${faNum(b.expired)}</b>`,
    `• ⛔ غیرفعال: <b>${faNum(b.disabled)}</b>`,
  ];
  if (b.mixed > 0) lines.push(`• ◽ وضعیت ترکیبی: <b>${faNum(b.mixed)}</b>`);
  lines.push(
    '',
    `📶 حجم مصرفی: <b>${faBytes(b.usedBytes)}</b> از <b>${faBytes(b.quotaBytes)}</b>`,
    ''
  );
  if (b.expiringSoon.length) {
    lines.push('⏳ <b>نزدیک انقضا</b>');
    for (const row of b.expiringSoon) {
      lines.push(`• ${esc(row.name)} — ${faNum(row.daysLeft)} روز مانده · ${faBytes(row.leftGb * GIB)} باقی‌مانده`);
    }
  } else {
    lines.push('<i>اشتراکی در آستانهٔ انقضا نیست.</i>');
  }
  if (b.depletedList.length) {
    lines.push('', '🛑 <b>حجم تمام‌شده</b>');
    for (const row of b.depletedList) {
      lines.push(`• ${esc(row.name)} — ${faNum(row.percent)}٪ مصرف‌شده`);
    }
  }
  const pending = topups.pendingCount(user.id);
  if (pending > 0) lines.push('', `🧾 فیش در انتظار بررسی: <b>${faNum(pending)}</b> — دکمهٔ «${BTN_TOPUP}» برای واریزی جدید.`);
  lines.push('', `<i>${esc(panelName())}</i>`);
  return lines.join('\n');
}

/** Every receipt this reseller sent, with what the admin decided about it. */
function receiptsText(user) {
  const data = topups.listRequests({ userId: Number(user.id), page: 1, pageSize: 8 });
  const unit = esc(currency());
  const tone = { pending: '⏳', approved: '✅', rejected: '❌' };
  const lines = [
    '🧾 <b>فیش‌های واریزی شما</b>',
    `نماینده: <code>${esc(user.username)}</code>`,
    `در انتظار: <b>${faNum(data.counts.pending)}</b> · تاییدشده: <b>${faNum(data.counts.approved)}</b> · ردشده: <b>${faNum(data.counts.rejected)}</b>`,
    '',
  ];
  if (!data.rows.length) {
    lines.push('<i>هنوز فیشی ارسال نکرده‌اید. دکمهٔ «' + esc(BTN_TOPUP) + '» را بزنید.</i>');
  }
  for (const row of data.rows) {
    lines.push(`${tone[row.status] || '•'} #${Number(row.id)} · <b>${faNum(row.amount)}</b> ${unit} · ${esc(faDate(row.createdAt, true))}`);
    if (row.status === 'approved') {
      lines.push(`  <i>تایید شد${row.decidedByName ? ` توسط ${esc(row.decidedByName)}` : ''} · موجودی آن لحظه ${faNum(row.balance)} ${unit}</i>`);
    } else if (row.decisionNote) {
      lines.push(`  <i>یادداشت مدیر: ${esc(String(row.decisionNote).slice(0, 120))}</i>`);
    } else if (row.status === 'pending') {
      lines.push('  <i>در انتظار تایید مدیر</i>');
    }
  }
  lines.push('', `<i>${esc(panelName())}</i>`);
  return lines.join('\n');
}

function helpText(user, botName = '') {
  const lines = [
    '📖 <b>راهنمای ربات</b>',
    '',
    `${BTN_BALANCE} — موجودی کیف پول و آخرین تراکنش‌ها`,
    `${BTN_PACKAGES} — اشتراک‌های فعال، در حال اتمام، حجم‌تمام‌شده و منقضی`,
    `${BTN_TOPUP} — افزایش موجودی با ارسال فیش واریزی`,
    `${BTN_RECEIPTS} — وضعیت همهٔ فیش‌هایی که فرستاده‌اید`,
    `${BTN_STATS} — آمار مصرف و ترافیک مشتریان شما`,
    '',
    '<b>روش افزایش موجودی</b>',
    `۱) دکمهٔ «${BTN_TOPUP}» را بزنید (یا دستور /topup).`,
    '۲) مبلغ واریزی را به تومان بفرستید؛ مثلا <code>500000</code>.',
    '۳) عکس یا فایل فیش واریزی را بفرستید.',
    '۴) فیش برای مدیر ارسال می‌شود؛ پس از تایید او موجودی شما افزایش پیدا می‌کند و همین‌جا خبر می‌گیرید.',
    '',
    botName
      ? `از پنل هم می‌توانید: بخش کیف پول دکمهٔ «افزایش موجودی از طریق ربات» شما را مستقیم به این چت می‌آورد — <code>t.me/${esc(botName)}?start=topup</code>`
      : 'از پنل هم می‌توانید درخواست واریز بفرستید (بخش کیف پول).',
    '',
    'دستورها: /start /balance /packages /stats /topup /receipts /help /cancel',
    '',
    `<i>شناسهٔ تلگرام شما: <code>${esc(user?.telegram_id || '')}</code></i>`,
  ];
  return lines.join('\n');
}

/** What the admin's own keyboard offers, in his own chat. */
function adminHelpText(actor, pending) {
  const unit = esc(currency());
  return [
    '📖 <b>راهنمای مدیر</b>',
    '',
    `${BTN_A_RESELLERS} — فهرست نمایندگان با موجودی، بسته‌ها و مصرف ۷ روز`,
    `${BTN_A_MONEY} — افزایش یا کاهش موجودی یک نماینده با شناسهٔ عددی تلگرام یا نام کاربری او`,
    `${BTN_A_PENDING} — فیش‌های واریزی در انتظار تصمیم`,
    `${BTN_A_HELP} — همین راهنما`,
    '',
    '<b>روش شارژ دستی نماینده</b>',
    `۱) دکمهٔ «${BTN_A_MONEY}» را بزنید.`,
    '۲) شناسهٔ عددی تلگرام یا نام کاربری نماینده را بفرستید؛ مثلا <code>1234567890</code> یا <code>reseller-name</code>.',
    `۳) جهت را انتخاب کنید: «➕ افزایش موجودی» یا «➖ کاهش موجودی».`,
    `۴) مبلغ را به ${unit} بفرستید؛ فقط عدد.`,
    '۵) آخرین صفحه با «✅ ثبت» تایید می‌شود؛ تا آن دکمه هیچ پولی جابه‌جا نمی‌شود.',
    '',
    'دستورها: /resellers /money /pending /balance /help',
    '',
    `<i>فیش در انتظار: <b>${faNum(pending)}</b></i>`,
    '',
    `<i>${esc(panelName())}</i>`,
  ].join('\n');
}

/**
 * The reseller fleet, one page of it: who has how much money, how many packages,
 * and what their customers consumed in 7 days. Balances are what the wallet will
 * spend on the next receipt, so they come from the users row the bot charges too.
 */
function resellersText(page = 1) {
  const pageSize = PAGE_ROWS;
  const data = usersService.listUsers({ role: 'reseller', page: Number(page) || 1, pageSize });
  const unit = esc(currency());
  const lines = [
    `👥 <b>آمار نمایندگان</b> — ${esc(faDate(Date.now()))}`,
    `مجموع موجودی‌ها: <b>${faNum(data.rows.reduce((sum, row) => sum + Number(row.balance || 0), 0))}</b> ${unit} · ربات: <b>${telegram.botConfig().enabled ? 'روشن' : 'خاموش'}</b>`,
    '',
  ];
  if (!data.rows.length) lines.push('<i>نماینده‌ای ثبت نشده است.</i>');
  for (const row of data.rows) {
    const s = row.stats || {};
    lines.push(
      `<b>${esc(row.username)}</b>${row.name ? ` (${esc(row.name)})` : ''}`,
      `  شناسه: <code>${esc(row.telegramId || '—')}</code> · ${row.status === 'active' ? '✅' : '⛔'}`,
      `  موجودی: <b>${faNum(row.balance)}</b> ${unit} · بسته: ${faNum(s.packages)} (فعال ${faNum(s.activePackages)})`,
      `  مصرف مشتریان: ${faBytes(Number(s.usedBytes || 0))}`
    );
  }
  const size = Math.max(1, Math.ceil(data.total / pageSize));
  lines.push('', `<i>صفحه ${faNum(Number(page) || 1)} از ${faNum(size)} · مجموع ${faNum(data.total)} نماینده</i>`);
  lines.push('', `<i>${esc(panelName())}</i>`);
  return { text: lines.join('\n'), page: Number(page) || 1, pages: size, total: Number(data.total || 0) };
}

function unlinkedText(fromId) {
  return [
    '👋 <b>سلام</b>',
    '',
    'این حساب تلگرام هنوز به هیچ نماینده‌ای در پنل متصل نیست.',
    `شناسهٔ عددی شما: <code>${esc(fromId)}</code>`,
    '',
    'این شناسه را به مدیر پنل بدهید تا آن را در حساب نمایندگی شما ثبت کند؛ بعد از آن موجودی، آمار و ارسال فیش واریزی برای شما فعال می‌شود.',
    '',
    `<i>${esc(panelName())}</i>`,
  ].join('\n');
}

// ------------------------------------------------------------------ receipt flow

/** «۵۰۰,۰۰۰ تومان» / «500000» / Persian digits → 500000, or null. */
function parseAmount(raw) {
  const text = String(raw || '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[,٬،\s]/g, '')
    .replace(/تومان|تومن|ریال|toman|rial/gi, '');
  if (!/^\d{1,12}$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** The photo/document a reseller sent, as { kind, fileId } — or null. */
function fileOf(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const best = message.photo[message.photo.length - 1];
    if (best?.file_id) return { kind: 'photo', fileId: String(best.file_id) };
  }
  if (message.document?.file_id) {
    const mime = String(message.document.mime_type || '');
    // A receipt is a picture or a PDF. Anything else (an apk, a zip) is refused
    // rather than forwarded to the owner's chat.
    if (mime.startsWith('image/') || mime === 'application/pdf') {
      return { kind: 'document', fileId: String(message.document.file_id) };
    }
    return { kind: 'rejected', fileId: '' };
  }
  return null;
}

function adminReceiptText(request, user) {
  const unit = esc(currency());
  const pending = topups.pendingCount(user.id);
  return [
    `🧾 <b>فیش واریزی جدید</b> #${Number(request.id)}`,
    `نماینده: <code>${esc(user.username)}</code>${user.name ? ` (${esc(user.name)})` : ''}`,
    `مبلغ اعلامی: <b>${faNum(request.amount)}</b> ${unit}`,
    `موجودی فعلی: ${faNum(user.balance)} ${unit}`,
    `فیش‌های در انتظار این نماینده: ${faNum(pending)}`,
    `زمان: ${esc(faDate(request.createdAt, true))}`,
    '',
    'با «تایید و شارژ» مبلغ بالا به کیف پول او اضافه می‌شود.',
    'اگر مبلغ فیش فرق دارد، آن را در پنل (بخش فیش‌های واریزی) اصلاح و تایید کنید.',
  ].join('\n');
}

/** Forward the receipt to the admin chat with the two decision buttons. */
async function postToAdmin(request, user) {
  const adminChat = String(telegram.botConfig().adminChatId || '').trim();
  if (!adminChat) {
    log('[bot] receipt stored but no admin chat is configured; decide it in the panel');
    return { posted: false, reason: 'no_admin_chat' };
  }
  const caption = clip(adminReceiptText(request, user));
  const payload = {
    chat_id: adminChat,
    caption,
    parse_mode: 'HTML',
    reply_markup: decisionKeyboard(request.id),
  };
  let sent = null;
  if (request.fileKind === 'photo' && request.fileId) {
    sent = await telegram.call('sendPhoto', { ...payload, photo: request.fileId });
  } else if (request.fileId) {
    sent = await telegram.call('sendDocument', { ...payload, document: request.fileId });
  } else {
    sent = await telegram.call('sendMessage', { chat_id: adminChat, text: caption, parse_mode: 'HTML', reply_markup: decisionKeyboard(request.id) });
  }
  const messageId = Number(sent?.message_id || 0);
  if (messageId) topups.rememberAdminMessage(request.id, adminChat, messageId);
  return { posted: true, chatId: adminChat, messageId };
}

/** Both halves are known: store the request, forward it, tell the reseller. */
async function finishReceipt(chatId, user, state, message) {
  let request = null;
  try {
    const amount = topups.cleanAmount(state.amount);
    request = topups.createRequest({
      userId: Number(user.id),
      amount,
      fileKind: state.fileKind || '',
      fileId: state.fileId || '',
      caption: String(message?.caption || state.caption || '').slice(0, 1000),
      chatId: String(chatId),
      messageId: Number(message?.message_id || 0),
      source: 'bot',
    });
  } catch (err) {
    // A refused receipt (too many waiting, an impossible amount) must still get an
    // answer: silence would leave the reseller sending the same picture again.
    const reason = err instanceof ApiError ? err.message : 'ثبت فیش ممکن نشد؛ بعداً دوباره تلاش کنید.';
    await replyMenu(chatId, `⚠️ ${esc(reason)}`);
    return { ok: false, reason: 'request_refused', message: reason };
  }
  clearStep(chatId);
  let delivery = { posted: false, reason: 'not_attempted' };
  try {
    delivery = await postToAdmin(request, user);
  } catch (err) {
    logError('[bot] forwarding receipt to admin failed:', err.message);
    delivery = { posted: false, reason: err.message };
  }
  const unit = esc(currency());
  const lines = [
    '✅ <b>فیش شما ثبت شد</b>',
    `شمارهٔ درخواست: <code>#${Number(request.id)}</code>`,
    `مبلغ: <b>${faNum(request.amount)}</b> ${unit}`,
    delivery.posted
      ? 'فیش برای مدیر ارسال شد. پس از تایید، موجودی شما افزایش پیدا می‌کند و همین‌جا به شما خبر می‌دهیم.'
      : 'درخواست در پنل ثبت شد و مدیر آن را بررسی می‌کند. پس از تایید، موجودی شما افزایش پیدا می‌کند.',
    '',
    `موجودی فعلی: ${faNum(user.balance)} ${unit}`,
  ];
  await replyMenu(chatId, lines.join('\n'));
  return { ok: true, request, delivery };
}

async function startTopup(chatId, user) {
  setStep(chatId, { step: 'amount', amount: 0, fileKind: '', fileId: '' });
  const unit = esc(currency());
  await reply(chatId, [
    `🧾 <b>افزایش موجودی با فیش واریزی</b>`,
    '',
    `۱) مبلغ واریزی را به ${unit} بفرستید؛ مثلا <code>500000</code>.`,
    '۲) سپس عکس یا فایل فیش را بفرستید.',
    '',
    'می‌توانید اول عکس فیش را بفرستید و بعد مبلغ را بنویسید.',
    `برای بی‌خیال شدن «${BTN_CANCEL}» یا /cancel را بزنید.`,
  ].join('\n'), { reply_markup: cancelKeyboard() });
  return { ok: true, step: 'amount' };
}

/** The pending receipts, the way both /pending and the admin button show them. */
function pendingListText(list) {
  const unit = esc(currency());
  const lines = [`🧾 <b>فیش‌های در انتظار: ${faNum(list.counts.pending)}</b>`];
  for (const row of list.rows) {
    lines.push(`• #${Number(row.id)} · <code>${esc(row.username)}</code> · ${faNum(row.amount)} ${unit} · ${esc(faDate(row.createdAt, true))}`);
  }
  if (!list.rows.length) lines.push('<i>موردی نیست.</i>');
  return lines.join('\n');
}

// ---------------------------------------------------------------- admin money flow

/**
 * v1.5.3 step 1 of a manual wallet move: which reseller? The numeric Telegram id
 * is what the panel shows everywhere, the username is what the owner remembers,
 * so both are accepted — but only a live RESELLER account resolves.
 */
async function askResellerTarget(chatId) {
  setStep(chatId, { step: 'adm_target' });
  await reply(chatId, [
    '💰 <b>افزایش یا کاهش موجودی یک نماینده</b>',
    '',
    'شناسهٔ عددی تلگرام یا نام کاربری نماینده را بفرستید.',
    `مثلا <code>1234567890</code> یا <code>reseller-name</code>.`,
    '',
    `برای بی‌خیال شدن «${BTN_CANCEL}» یا /cancel را بزنید.`,
  ].join('\n'), { reply_markup: cancelKeyboard() });
  return { ok: true, step: 'adm_target' };
}

/** Step 2: the target is known, so the admin sees the wallet before touching it. */
async function pickMoneyDirection(chatId, raw) {
  const target = resellerByIdentity(raw);
  if (!target) {
    await reply(chatId, [
      '⚠️ نماینده‌ای با این شناسه پیدا نشد.',
      '',
      'شناسهٔ عددی تلگرام یا نام کاربری نماینده را درست بفرستید؛ برای لغو «' + esc(BTN_CANCEL) + '» را بزنید.',
    ].join('\n'), { reply_markup: cancelKeyboard() });
    return { ok: false, reason: 'reseller_not_found' };
  }
  const balance = Number(target.balance || 0);
  setStep(chatId, {
    step: 'adm_direction',
    target: { id: Number(target.id), username: String(target.username || ''), telegramId: String(target.telegram_id || ''), balance },
  });
  await reply(chatId, [
    `نماینده: <code>${esc(target.username)}</code>${target.name ? ` (${esc(target.name)})` : ''}`,
    `شناسهٔ تلگرام: <code>${esc(target.telegram_id || '—')}</code>`,
    `موجودی فعلی: <b>${faNum(balance)}</b> ${esc(currency())}`,
    '',
    'جهت را انتخاب کنید:',
  ].join('\n'), { reply_markup: moneyChoiceKeyboard(target.id) });
  return { ok: true, step: 'adm_direction', userId: Number(target.id) };
}

/** Step 3: the direction is fixed in the state; now the amount, on the keypad. */
async function askMoneyAmount(chatId, state, sign) {
  const target = state.target || {};
  const minus = isMinus(sign);
  setStep(chatId, { step: 'adm_amount', sign: minus ? '-' : '+' });
  await reply(chatId, [
    `💳 <b>${minus ? 'کاهش' : 'افزایش'} موجودی</b> <code>${esc(target.username)}</code>`,
    `موجودی فعلی: <b>${faNum(Number(target.balance || 0))}</b> ${esc(currency())}`,
    minus ? `حداکثر قابل کسر: <b>${faNum(Number(target.balance || 0))}</b> ${esc(currency())}` : '',
    '',
    'مبلغ را فقط با عدد بفرستید؛ مثلا <code>500000</code>.',
    `با «${BTN_CANCEL}» هیچ پولی جابه‌جا نمی‌شود.`,
  ].filter(Boolean).join('\n'), { reply_markup: cancelKeyboard() });
  return { ok: true, step: 'adm_amount', sign: minus ? '-' : '+' };
}

/**
 * Step 4: nothing moves until the admin taps ✅ on this screen. The amount is
 * re-parsed and re-capped here, so the number on the confirm button is the number
 * that will be executed — a stale chat cannot smuggle a different amount in.
 */
async function confirmMoneyAmount(chatId, state, raw) {
  const target = state.target || {};
  const sign = state.sign === '-' ? '-' : '+';
  const parsed = parseAmount(raw);
  if (parsed === null) {
    await reply(chatId, [
      '⚠️ مبلغ را فقط با عدد بفرستید؛ مثلا <code>500000</code>.',
      `برای بی‌خیال شدن «${BTN_CANCEL}» را بزنید.`,
    ].join('\n'), { reply_markup: cancelKeyboard() });
    return { ok: false, reason: 'bad_amount' };
  }
  let amount = parsed;
  try {
    amount = topups.cleanAmount(parsed);
  } catch (err) {
    await reply(chatId, `⚠️ ${esc(err.message)}`);
    return { ok: false, reason: 'amount_rejected' };
  }
  const balance = Number(target.balance || 0);
  if (sign === '-' && amount > balance) {
    await reply(chatId, [
      `⚠️ موجودی <code>${esc(target.username)}</code> فقط <b>${faNum(balance)}</b> ${esc(currency())} است.`,
      'این مبلغ را نمی‌توان کم کرد؛ مقدار کمتر را بفرستید.',
    ].join('\n'), { reply_markup: cancelKeyboard() });
    return { ok: false, reason: 'insufficient_balance' };
  }
  setStep(chatId, { step: 'adm_confirm', amount, sign });
  await reply(chatId, [
    '⚠️ <b>تایید نهایی</b>',
    '',
    `نماینده: <code>${esc(target.username)}</code>`,
    `${sign === '-' ? 'کاهش' : 'افزایش'}: <b>${faNum(amount)}</b> ${esc(currency())}`,
    `موجودی فعلی: ${faNum(balance)} ${esc(currency())}`,
    `موجودی پس از این کار: <b>${faNum(sign === '-' ? balance - amount : balance + amount)}</b> ${esc(currency())}`,
    '',
    'با «ثبت» موجودی تغییر می‌کند و در کیف پول یک تراکنش ثبت می‌شود.',
  ].join('\n'), { reply_markup: moneyConfirmKeyboard(target.id, sign, amount) });
  return { ok: true, step: 'adm_confirm', amount, sign };
}

/**
 * The one place the bot moves money. It calls the very function the panel's edit
 * drawer calls, so the wallet row, the transaction and the audit line are written
 * exactly the same way from both sides. The admin gate is re-checked here, and
 * the amount is re-capped from the FRESH balance: this is the last line before a
 * write, and it is the one that must not be bypassed.
 */
async function runMoneyMove(state, actor) {
  const target = state.target || {};
  const amount = Math.round(Number(state.amount || 0));
  if (!amount) throw new ApiError(422, 'invalid_amount', 'مبلغ نامعتبر است');
  if (amount > topups.MAX_AMOUNT) throw new ApiError(422, 'amount_too_large', 'مبلغ بیش از حد مجاز است');
  const user = usersService.getUser(Number(target.id));
  if (!user || user.role === 'admin' || user.deleted_at) {
    throw new ApiError(404, 'not_found', 'این نماینده دیگر در دسترس نیست');
  }
  const delta = isMinus(state.sign) ? -amount : amount;
  const description = `شارژ دستی نماینده از ربات تلگرام · ${user.username}`;
  const result = usersService.adjustBalance(Number(user.id), delta, description, { user: { id: actor.id, role: 'admin' } });
  return { user, delta, result };
}

// ------------------------------------------------------------------ messages

/**
 * v1.5.3: everything an admin can do from the bot, in his own chat or the
 * configured admin chat. The money conversation is driven by the stored step, so
 * a half-finished one survives a restart of the panel only as far as the step
 * does (30 minutes), and every reply re-checks adminActor() before it reads.
 */
async function handleAdminMessage(message, chatId, fromId, text, actor) {
  const state = stepOf(chatId);
  const parts = String(text || '').split(/\s+/);
  const command = (parts[0] || '').toLowerCase().replace(/@.*$/, '');
  const unit = esc(currency());

  if (command === '/cancel' || text === BTN_CANCEL) {
    clearStep(chatId);
    await replyAdminMenu(chatId, '❌ درخواست جاری لغو شد.');
    return { ok: true, action: 'admin_cancel' };
  }

  // ---- inside the manual wallet move
  if (state?.step === 'adm_target') {
    if (!text) return { ok: false, reason: 'no_identity' };
    return pickMoneyDirection(chatId, text);
  }
  if (state?.step === 'adm_amount') {
    return confirmMoneyAmount(chatId, state, text);
  }
  if (state?.step === 'adm_confirm') {
    if (parseAmount(text) !== null) return confirmMoneyAmount(chatId, state, text);
    await reply(chatId, [
      '⚠️ برای ثبت دکمهٔ «✅ ثبت» را بزنید.',
      'برای تغییر مبلغ، عدد تازه را بفرستید؛ برای بی‌خیال شدن «' + esc(BTN_CANCEL) + '».',
    ].join('\n'), { reply_markup: cancelKeyboard() });
    return { ok: false, reason: 'await_confirm' };
  }
  if (state?.step === 'adm_direction') {
    await reply(chatId, [
      '⚠️ جهت را از دکمه‌های «افزایش موجودی» و «کاهش موجودی» انتخاب کنید.',
      'برای شروع دوباره «' + esc(BTN_CANCEL) + '» را بزنید.',
    ].join('\n'));
    return { ok: false, reason: 'await_direction' };
  }

  const pending = topups.listRequests({ status: 'pending', page: 1, pageSize: 10 });

  if (command === '/pending' || text === BTN_A_PENDING) {
    clearStep(chatId);
    await reply(chatId, pendingListText(pending), { reply_markup: adminMenuKeyboard() });
    return { ok: true, action: 'admin_pending' };
  }
  if (command === '/resellers' || text === BTN_A_RESELLERS) {
    clearStep(chatId);
    const list = resellersText(1);
    await reply(chatId, list.text, { reply_markup: pagerKeyboard(1, false, list.pages > 1) });
    return { ok: true, action: 'admin_resellers', page: list.page, pages: list.pages, total: list.total };
  }
  if (command === '/money' || text === BTN_A_MONEY) {
    return askResellerTarget(chatId, actor);
  }
  if (command === '/balance') {
    const self = usersService.getUser(actor.id);
    await reply(chatId, self ? balanceText(self) : 'حساب شما در پنل پیدا نشد.');
    return { ok: true, action: 'admin_balance' };
  }
  if (command === '/help' || text === BTN_A_HELP) {
    clearStep(chatId);
    await replyAdminMenu(chatId, adminHelpText(actor, pending.counts.pending));
    return { ok: true, action: 'admin_help' };
  }
  if (command === '/start' || !text) {
    await replyAdminMenu(chatId, [
      '👋 <b>سلام مدیر</b>',
      `فیش‌های در انتظار: <b>${faNum(pending.counts.pending)}</b>`,
      'با دکمه‌های پایین همین پیام از آمار نمایندگان، شارژ و کسر موجودی و فیش‌ها استفاده کنید.',
      'روی هر فیش هم دکمه‌های «تایید و شارژ» و «رد» هست؛ هر دو راه فقط یک بار پول جابه‌جا می‌کند.',
    ].join('\n'));
    return { ok: true, action: 'admin_menu' };
  }
  // A reseller command an admin typed by mistake: answer with the admin menu
  // instead of the wallet data, because nothing here has a reseller account.
  if (['/stats', '/topup', '/packages', '/receipts'].includes(command)) {
    await reply(chatId, 'این دکمه‌ها برای نماینده‌هاست. شما مدیر پنل هستید — از منوی بالا استفاده کنید.', { reply_markup: adminMenuKeyboard() });
    return { ok: true, action: 'admin_reseller_command' };
  }
  await replyAdminMenu(chatId, 'متوجه نشدم. از دکمه‌های زیر یا /help استفاده کنید.');
  return { ok: true, action: 'admin_fallback' };
}

async function handleMessage(message) {
  const chatId = String(message?.chat?.id || '');
  const fromId = String(message?.from?.id || '');
  if (!chatId || !fromId) return { ok: false, reason: 'no_chat' };
  // Only private chats are served: a group must never become a place where one
  // reseller reads another's wallet, and the admin chat is reached by forwarding.
  if (message.chat.type !== 'private') {
    if (String(chatId) === String(telegram.botConfig().adminChatId || '')) {
      const actor = adminActor(fromId, chatId);
      if (actor) return handleAdminMessage(message, chatId, fromId, String(message.text || '').trim(), actor);
    }
    return { ok: false, reason: 'not_private' };
  }

  const user = userByTelegramId(fromId);
  const text = String(message.text || '').trim();
  const file = fileOf(message);

  // v1.5.3: an admin's own chat — private or the configured group — is served by
  // the ADMIN keyboard. His wallet has no reseller buttons in it, and a receipt
  // he could send here would be his own money.
  const adminHere = adminActor(fromId, chatId);
  if (adminHere) return handleAdminMessage(message, chatId, fromId, text, adminHere);

  if (!user) {
    // adminActor() above already covers every admin, linked or not: what is left
    // here is a stranger's chat, and a stranger never reads a wallet.
    clearStep(chatId);
    await reply(chatId, unlinkedText(fromId));
    return { ok: false, reason: 'unlinked' };
  }

  if (user.status !== 'active') {
    await reply(chatId, '⛔ حساب نمایندگی شما غیرفعال است. با مدیر پنل تماس بگیرید.');
    return { ok: false, reason: 'inactive' };
  }

  const command = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  const state = stepOf(chatId);

  if (command === '/cancel' || text === BTN_CANCEL) {
    clearStep(chatId);
    await replyMenu(chatId, '❌ درخواست جاری لغو شد.');
    return { ok: true, action: 'cancel' };
  }
  if (command === '/start' || command === '/help' || text === BTN_HELP) {
    clearStep(chatId);
    const name = await botUsername();
    // A panel link carries a payload (t.me/<bot>?start=topup): the deep link is
    // the button the owner asked for, so it opens exactly that conversation.
    const payload = (text.split(/\s+/)[1] || '').toLowerCase();
    if (command === '/start' && payload) {
      const welcome = [
        `👋 <b>خوش آمدید ${esc(user.name || user.username)}</b>`,
        `موجودی کیف پول: <b>${faNum(user.balance)}</b> ${esc(currency())}`,
        '',
      ];
      if (payload === 'topup') return startTopup(chatId, user);
      const DEEP = {
        menu: { text: () => 'از دکمه‌های زیر استفاده کنید:', action: 'deep_menu' },
        balance: { text: () => balanceText(user), action: 'deep_balance', label: 'موجودی' },
        stats: { text: () => statsText(user), action: 'deep_stats', label: 'آمار مصرف' },
        packages: { text: () => packagesText(user), action: 'deep_packages', label: 'آمار اشتراک‌ها' },
        receipts: { text: () => receiptsText(user), action: 'deep_receipts', label: 'فیش‌های من' },
      };
      const deep = DEEP[payload] || null;
      if (!deep) {
        await replyMenu(chatId, [...welcome, `دکمهٔ «${esc(payload)}» را نمی‌شناسم؛ از دکمه‌های زیر استفاده کنید:`].join('\n'));
        return { ok: false, reason: 'unknown_deep_link' };
      }
      // The link IS the panel's «افزایش موجودی از طریق ربات» button: name the
      // section it opened, then answer exactly like that button press would.
      if (deep.label) {
        await replyMenu(chatId, [...welcome, `🔗 از لینک پنل به بخش <b>${esc(deep.label)}</b> آمدید:`].join('\n'));
      }
      await replyMenu(chatId, deep.text());
      return { ok: true, action: deep.action };
    }
    if (command === '/start') {
      await replyMenu(chatId, [
        `👋 <b>خوش آمدید ${esc(user.name || user.username)}</b>`,
        `موجودی کیف پول: <b>${faNum(user.balance)}</b> ${esc(currency())}`,
        '',
        'از دکمه‌های زیر استفاده کنید:',
      ].join('\n'));
    }
    await reply(chatId, helpText(user, name));
    return { ok: true, action: 'help' };
  }
  if (command === '/balance' || text === BTN_BALANCE) {
    clearStep(chatId);
    await replyMenu(chatId, balanceText(user));
    return { ok: true, action: 'balance' };
  }
  if (command === '/stats' || text === BTN_STATS) {
    clearStep(chatId);
    await replyMenu(chatId, statsText(user));
    return { ok: true, action: 'stats' };
  }
  if (command === '/packages' || text === BTN_PACKAGES) {
    clearStep(chatId);
    await replyMenu(chatId, packagesText(user));
    return { ok: true, action: 'packages' };
  }
  if (command === '/receipts' || text === BTN_RECEIPTS) {
    clearStep(chatId);
    await replyMenu(chatId, receiptsText(user));
    return { ok: true, action: 'receipts' };
  }
  if (command === '/topup' || text === BTN_TOPUP) {
    return startTopup(chatId, user);
  }

  // ---- inside the receipt conversation
  if (file) {
    if (file.kind === 'rejected') {
      await reply(chatId, '⚠️ فقط عکس یا فایل PDF فیش پذیرفته می‌شود. لطفاً تصویر رسید را بفرستید.');
      return { ok: false, reason: 'bad_file' };
    }
    const next = { fileKind: file.kind, fileId: file.fileId, caption: String(message.caption || '') };
    if (state?.step === 'amount' && Number(state.amount) > 0) {
      return finishReceipt(chatId, user, { ...state, ...next }, message);
    }
    if (state?.step === 'receipt') {
      return finishReceipt(chatId, user, { ...state, ...next }, message);
    }
    setStep(chatId, { step: 'amount', amount: Number(state?.amount || 0), ...next });
    await reply(chatId, [
      '🖼 فیش دریافت شد.',
      `حالا مبلغ واریزی را به ${esc(currency())} بفرستید؛ مثلا <code>500000</code>.`,
    ].join('\n'), { reply_markup: cancelKeyboard() });
    return { ok: true, action: 'receipt_file' };
  }

  if (state?.step === 'amount' || state?.step === 'receipt') {
    const amount = parseAmount(text);
    if (amount === null) {
      await reply(chatId, [
        '⚠️ مبلغ را فقط با عدد بفرستید؛ مثلا <code>500000</code>.',
        `برای بی‌خیال شدن «${BTN_CANCEL}» را بزنید.`,
      ].join('\n'), { reply_markup: cancelKeyboard() });
      return { ok: false, reason: 'bad_amount' };
    }
    let value = amount;
    try {
      value = topups.cleanAmount(amount);
    } catch (err) {
      await reply(chatId, `⚠️ ${esc(err.message)}`);
      return { ok: false, reason: 'amount_rejected' };
    }
    if (state.fileId) {
      return finishReceipt(chatId, user, { ...state, amount: value }, message);
    }
    setStep(chatId, { step: 'receipt', amount: value, fileKind: '', fileId: '' });
    await reply(chatId, [
      `✅ مبلغ: <b>${faNum(value)}</b> ${esc(currency())}`,
      'حالا عکس یا فایل PDF فیش واریزی را بفرستید.',
    ].join('\n'), { reply_markup: cancelKeyboard() });
    return { ok: true, action: 'receipt_amount' };
  }

  // A number outside the flow is a hint, not a silent wallet change.
  if (parseAmount(text) !== null) {
    await replyMenu(chatId, `برای افزایش موجودی دکمهٔ «${BTN_TOPUP}» را بزنید و فیش واریزی را بفرستید.`);
    return { ok: true, action: 'amount_hint' };
  }

  await replyMenu(chatId, `متوجه نشدم. از دکمه‌های زیر یا /help استفاده کنید.`);
  return { ok: true, action: 'fallback' };
}

// ------------------------------------------------------------------ callbacks

async function editAdminMessage(chatId, messageId, text, isMedia) {
  const payload = {
    chat_id: String(chatId),
    message_id: Number(messageId),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [] },
  };
  try {
    if (isMedia) return await telegram.call('editMessageCaption', { ...payload, caption: clip(text) });
    return await telegram.call('editMessageText', { ...payload, text: clip(text), disable_web_page_preview: true });
  } catch (err) {
    // «message is not modified» is a success for our purposes: the keyboard is
    // already gone. Anything else is logged, never thrown at the poller.
    if (!/not modified/i.test(String(err.message || ''))) {
      logError('[bot] editing the admin message failed:', err.message);
    }
    return null;
  }
}

/**
 * A text that has to REPLACE an inline-keyboard screen: edit the tapped message
 * when we know its id, and fall back to a plain (button-free) send when the
 * update arrived without one. Used by the admin money flow, where a live «تایید»
 * button must never outlive the decision it belongs to.
 */
async function showAdminText(chatId, messageId, text) {
  const id = Number(messageId || 0);
  if (id > 0) return editAdminMessage(chatId, id, text, false);
  try {
    return await reply(chatId, text);
  } catch (err) {
    logError('[bot] sending the admin follow-up failed:', err.message);
    return null;
  }
}

/**
 * A decision made in the PANEL must also take the buttons away from the copy in
 * the admin's Telegram chat, otherwise the owner can tap «تایید» on a receipt he
 * already rejected here. Best effort: the money is already decided, so a
 * Telegram failure is logged and never propagated.
 */
async function syncAdminMessage(request, decision, actorName = '') {
  const chatId = String(request?.adminChatId || '').trim();
  const messageId = Number(request?.adminMessageId || 0);
  if (!chatId || !messageId) return { synced: false, reason: 'no_admin_message' };
  const media = request.fileKind === 'photo' || request.fileKind === 'document';
  const unit = esc(currency());
  const stamp = `${esc(faDate(Date.now(), true))}${actorName ? ` · ${esc(actorName)}` : ''} · پنل`;
  const tail = decision === 'approved'
    ? `\n\n✅ <b>در پنل تایید شد</b> — ${faNum(request.amount)} ${unit} به کیف پول ${esc(request.username || '')} اضافه شد.\n<i>${stamp}</i>`
    : `\n\n❌ <b>در پنل رد شد</b>\n<i>${stamp}</i>`;
  const original = [
    `🧾 <b>فیش واریزی</b> #${Number(request.id)}`,
    `نماینده: <code>${esc(request.username || '')}</code>`,
    `مبلغ: <b>${faNum(request.amount)}</b> ${unit}`,
  ].join('\n');
  await editAdminMessage(chatId, messageId, `${original}${tail}`, media);
  return { synced: true };
}

/**
 * v1.5.3: the admin's own inline buttons — the money flow and the reseller pager.
 * `adminActor` is re-checked here and on every step, so tapping a button from an
 * old message (or in a chat that is not the admin's) cannot move a wallet; the
 * confirm payload carries target, direction AND amount, and all three have to
 * still match the stored step before a single row is written.
 * `messageId` is the id of the message the tap came from: the confirmation
 * screen is edited in place, so no live «تایید» button survives a move.
 */
async function handleAdminCallback(data, chatId, fromId, answer, messageId = 0) {
  const actor = adminActor(fromId, chatId);
  if (!actor) {
    await answer('⛔ فقط مدیر پنل می‌تواند موجودی نماینده را تغییر دهد.', true);
    return { ok: false, reason: 'not_admin' };
  }
  const state = stepOf(chatId);

  if (data === 'bal:cancel') {
    clearStep(chatId);
    await answer('❌ لغو شد — هیچ مبلغی تغییر نکرد.');
    await replyAdminMenu(chatId, '❌ درخواست تغییر موجودی لغو شد. برای شروع دوباره «' + BTN_A_MONEY + '» را بزنید.');
    return { ok: true, action: 'money_cancel' };
  }

  if (data.startsWith('rs:pg:')) {
    const page = Math.min(500, Math.max(1, Number(data.slice(6)) || 1));
    const list = resellersText(page);
    await answer(`صفحه ${faNum(list.page)} از ${faNum(list.pages)}`);
    await reply(chatId, list.text, { reply_markup: pagerKeyboard(list.page, list.page > 1, list.page < list.pages) });
    return { ok: true, action: 'admin_resellers_page', page: list.page, pages: list.pages, total: list.total };
  }

  let match = /^bal:set:(\d+):([+-])$/.exec(data);
  if (match) {
    if (!state?.target || Number(state.target.id) !== Number(match[1])) {
      await answer('⚠️ این پیام کهنه است. «' + BTN_A_MONEY + '» را دوباره بزنید.', true);
      return { ok: false, reason: 'stale_step' };
    }
    return askMoneyAmount(chatId, state, match[2]);
  }

  match = /^bal:do:(\d+):([+-]):(\d{1,12})$/.exec(data);
  if (!match) {
    await answer('دستور ناشناخته');
    return { ok: false, reason: 'unknown_callback' };
  }
  const uid = Number(match[1]);
  const sign = match[2];
  const amount = Number(match[3]);
  const fresh = state?.step === 'adm_confirm' && state.sign === sign && Number(state.amount) === amount;
  if (!fresh || !state.target || Number(state.target.id) !== uid) {
    // The buttons of a confirmation the panel (or another chat) already answered
    // must not move money a second time or from stale numbers.
    await answer('⚠️ این تایید کهنه است. اگر مبلغی جابه‌جا شده، در کیف پول نماینده دیده می‌شود.', true);
    return { ok: false, reason: 'stale_confirmation' };
  }
  let moved = null;
  try {
    moved = await runMoneyMove(state, actor);
  } catch (err) {
    const message = err instanceof ApiError ? err.message : String(err.message || err || 'خطا');
    logError('[bot] manual balance move failed:', message);
    clearStep(chatId);
    await answer(`⚠️ ${String(message).slice(0, 180)}`, true);
    // Nothing moved, but the «تایید» buttons must not stay live on a failed
    // attempt — the owner might tap it again after fixing the cause.
    await showAdminText(chatId, messageId, `⚠️ <b>جابه‌جایی انجام نشد</b>\n<i>${esc(message)}</i>`);
    return { ok: false, reason: 'move_failed', message };
  }
  clearStep(chatId);
  const unit = esc(currency());
  const receipt = [
    moved.delta > 0 ? '✅ <b>موجودی افزایش یافت</b>' : '✅ <b>موجودی کاهش یافت</b>',
    `نماینده: <code>${esc(moved.user.username)}</code>`,
    `${moved.delta > 0 ? 'افزایش' : 'کاهش'}: <b>${faNum(Math.abs(moved.delta))}</b> ${unit}`,
    `موجودی جدید: <b>${faNum(moved.result.balance)}</b> ${unit}`,
    ``,
    `توسط: ${esc(actor.username)} · ${esc(faDate(Date.now(), true))}`,
    '<i>این کار در پنل هم در تراکنش‌های کیف پول ثبت شد.</i>',
  ].join('\n');
  await answer(moved.delta > 0 ? `✅ ثبت شد — موجودی: ${faNum(moved.result.balance)}` : '✅ کسر شد');
  // Replace the confirmation screen with the receipt, so no button is left live.
  await showAdminText(chatId, messageId, receipt);
  // The reseller hears about it in his own chat, the same way a receipt decision
  // reaches him. Best effort: the money already moved.
  const resellerChat = String(moved.user.telegram_id || '').trim();
  if (/^\d{4,20}$/.test(resellerChat)) {
    try {
      await replyMenu(resellerChat, [
        moved.delta > 0 ? '💰 <b>موجودی شما افزایش یافت</b>' : '💸 <b>موجودی شما کاهش یافت</b>',
        `مبلغ: <b>${faNum(Math.abs(moved.delta))}</b> ${unit}`,
        `موجودی جدید: <b>${faNum(moved.result.balance)}</b> ${unit}`,
        '<i>توسط مدیر پنل · در صورت اشتباه با پشتیبانی تماس بگیرید.</i>',
      ].join('\n'));
    } catch (err) {
      logError('[bot] telling the reseller about a manual move failed:', err.message);
    }
  }
  return { ok: true, action: moved.delta > 0 ? 'charged' : 'deducted', userId: uid, amount: Math.abs(moved.delta), balance: Number(moved.result.balance || 0) };
}

async function handleCallback(callback) {
  const data = String(callback?.data || '');
  const chatId = String(callback?.message?.chat?.id || '');
  const fromId = String(callback?.from?.id || '');
  const answer = (text, alert = false) => telegram.call('answerCallbackQuery', {
    callback_query_id: callback.id,
    text: String(text || '').slice(0, 190),
    show_alert: alert,
  }).catch(() => null);

  // v1.5.3: an admin keyboard lives on its own callback namespaces.
  if (!data.startsWith('topup:')) {
    return handleAdminCallback(data, chatId, fromId, answer, Number(callback?.message?.message_id || 0));
  }

  const match = /^topup:(ok|no):(\d+)$/.exec(data);

  if (!match) {
    await answer('دستور ناشناخته');
    return { ok: false, reason: 'unknown_callback' };
  }
  const actor = adminActor(fromId, chatId);
  if (!actor) {
    await answer('⛔ فقط مدیر پنل می‌تواند فیش را تایید یا رد کند.', true);
    return { ok: false, reason: 'not_admin' };
  }
  const id = Number(match[2]);
  const approving = match[1] === 'ok';
  let request = null;
  try {
    request = topups.getRequest(id);
  } catch (err) {
    await answer('این درخواست پیدا نشد.', true);
    return { ok: false, reason: 'not_found' };
  }

  const media = request.fileKind === 'photo' || request.fileKind === 'document';
  const original = String(callback.message?.caption || callback.message?.text || '');
  let result = null;
  try {
    result = approving
      ? topups.approve(id, { actor, source: 'bot' }, { user: { id: actor.id, role: 'admin' } })
      : topups.reject(id, { actor, source: 'bot' }, { user: { id: actor.id, role: 'admin' } });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'already_decided') {
      await answer('این فیش قبلاً بررسی شده است.', true);
      await editAdminMessage(chatId, callback.message?.message_id, `${original}\n\n<i>قبلاً بررسی شده بود.</i>`, media);
      return { ok: false, reason: 'already_decided' };
    }
    logError('[bot] top-up decision failed:', err.message);
    await answer(`⚠️ ${String(err.message || 'خطا').slice(0, 150)}`, true);
    return { ok: false, reason: 'decision_failed', message: err.message };
  }

  const unit = esc(currency());
  const stamp = `${esc(faDate(Date.now(), true))} · ${esc(actor.username)}`;
  const tail = approving
    ? `\n\n✅ <b>تایید شد</b> — ${faNum(result.credited)} ${unit} به کیف پول ${esc(result.username)} اضافه شد.\nموجودی جدید: <b>${faNum(result.balance)}</b> ${unit}\n<i>${stamp}</i>`
    : `\n\n❌ <b>رد شد</b>\n<i>${stamp}</i>`;
  await editAdminMessage(chatId, callback.message?.message_id, `${original}${tail}`, media);
  await answer(approving ? `✅ تایید شد — موجودی جدید: ${faNum(result.balance)}` : '❌ فیش رد شد');

  // Tell the reseller in his own chat too; the panel notification is already
  // written by topups, so a Telegram failure here changes nothing about the money.
  const resellerChat = String(request.chatId || '').trim();
  if (/^\d{4,20}$/.test(resellerChat)) {
    const text = approving
      ? [
        '✅ <b>فیش واریزی شما تایید شد</b>',
        `شمارهٔ درخواست: <code>#${id}</code>`,
        `مبلغ شارژ: <b>${faNum(result.credited)}</b> ${unit}`,
        `موجودی جدید: <b>${faNum(result.balance)}</b> ${unit}`,
      ].join('\n')
      : [
        '❌ <b>فیش واریزی شما رد شد</b>',
        `شمارهٔ درخواست: <code>#${id}</code>`,
        'در صورت اشتباه با پشتیبانی پنل تماس بگیرید.',
      ].join('\n');
    try {
      await replyMenu(resellerChat, text);
    } catch (err) {
      logError('[bot] notifying the reseller failed:', err.message);
    }
  }
  return { ok: true, action: approving ? 'approved' : 'rejected', id, balance: Number(result.balance || 0) };
}

// ------------------------------------------------------------------ one update

async function handleUpdate(update) {
  if (!update || typeof update !== 'object') return { ok: false, reason: 'empty' };
  if (update.callback_query) return handleCallback(update.callback_query);
  if (update.message) return handleMessage(update.message);
  return { ok: false, reason: 'ignored' };
}

// ------------------------------------------------------------------ the poller

let running = false;
let stopped = false;
let failures = 0;
let pollAbort = null;
let idleTimer = null;
let conflict = false;

const sleep = (ms) => new Promise((resolve) => {
  idleTimer = setTimeout(() => { idleTimer = null; resolve(); }, ms);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
});

function offsetValue() {
  const stored = stateGet('offset');
  // Number(null) is 0, so the obvious `Number.isFinite(Number(stored))` test
  // answers 0 for a database that has never polled — and offset 0 means "send me
  // the whole backlog", which is exactly what a first boot must not ask for.
  // Nothing stored has to stay null so loop() drops the backlog first.
  if (stored === null || stored === undefined || stored === '') return null;
  const value = Number(stored);
  return Number.isFinite(value) ? value : null;
}

/**
 * Drop whatever piled up while the panel was down. A restart must not re-send
 * old receipts or re-answer old taps, so the first poll confirms the backlog
 * instead of processing it.
 */
async function dropBacklog() {
  const result = await telegram.call('getUpdates', { offset: -1, timeout: 0, limit: 1 }, { timeoutMs: 15000 });
  const last = Array.isArray(result) && result.length ? Number(result[result.length - 1].update_id) : 0;
  stateSet('offset', last ? last + 1 : 0);
  return last;
}

async function loop() {
  while (!stopped) {
    const cfg = telegram.botConfig();
    if (!cfg.enabled) {
      // The switch in settings is read live, so turning the bot on does not need
      // a restart — and turning it off stops the network calls at once.
      await sleep(IDLE_SLEEP_MS);
      continue;
    }
    try {
      if (offsetValue() === null) await dropBacklog();
      const offset = offsetValue() || 0;
      pollAbort = new AbortController();
      const updates = await telegram.call(
        'getUpdates',
        { offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ['message', 'callback_query'] },
        { timeoutMs: (POLL_TIMEOUT_SEC + 10) * 1000, signal: pollAbort.signal }
      );
      pollAbort = null;
      failures = 0;
      for (const update of Array.isArray(updates) ? updates : []) {
        if (stopped) break;
        // Stored first: an update that throws must not be fetched again forever.
        stateSet('offset', Number(update.update_id) + 1);
        try {
          await handleUpdate(update);
        } catch (err) {
          logError(`[bot] update ${update.update_id} failed:`, err && err.stack ? err.stack : err);
        }
      }
    } catch (err) {
      pollAbort = null;
      const message = String(err?.message || err || '');
      if (/409|Conflict/i.test(message)) {
        conflict = true;
        stopped = true;
        logError('[bot] polling stopped: another getUpdates consumer or a webhook owns this bot (409 Conflict). Remove it, then restart the panel.');
        break;
      }
      if (stopped) break;
      failures += 1;
      const wait = Math.min(60000, 2000 * failures);
      if (failures === 1 || failures % 10 === 0) {
        logError(`[bot] polling failed (${failures}): ${message} — retrying in ${Math.round(wait / 1000)}s`);
      }
      await sleep(wait);
    }
  }
  running = false;
}

/**
 * Start the poller. Returns why it did not start when it did not: the test
 * environment never polls (the bot suite drives handleUpdate directly), and a
 * bot with a webhook is left to that webhook.
 */
async function start() {
  if (running) return { started: true, already: true };
  if (process.env.NODE_ENV === 'test') return { started: false, reason: 'test_env' };
  stopped = false;
  conflict = false;
  failures = 0;
  const cfg = telegram.botConfig();
  if (cfg.botToken) {
    try {
      const hook = await telegram.call('getWebhookInfo', {}, { timeoutMs: 15000 });
      if (hook?.url) {
        log('[bot] a webhook is set on this bot; long polling stays off so the two do not fight');
        return { started: false, reason: 'webhook_set' };
      }
    } catch (err) {
      logError('[bot] getWebhookInfo failed, polling anyway:', err.message);
    }
  }
  running = true;
  // v1.5.3: the panel link and the /start deep links both need the bot's own
  // username, and the native command menu is what makes the keyboard feel
  // professional. Both talk to Telegram, so they run after the poller is up and
  // never decide anything: a getMe/setMyCommands failure only costs the menu.
  if (cfg.enabled) {
    botUsername()
      .then((name) => (name ? log(`[bot] bot username: @${name}`) : null))
      .catch((err) => logError('[bot] getMe failed:', err.message));
    registerCommands().catch((err) => logError('[bot] setMyCommands failed:', err.message));
  }
  loop().catch((err) => {
    running = false;
    logError('[bot] poller crashed:', err && err.stack ? err.stack : err);
  });
  log(`[bot] two-way Telegram bot ${cfg.enabled ? 'started' : 'idle (switched off in settings)'}`);
  return { started: true, enabled: cfg.enabled };
}

function stop() {
  stopped = true;
  running = false;
  if (pollAbort) {
    try { pollAbort.abort(); } catch (_) {}
    pollAbort = null;
  }
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function status() {
  const cfg = telegram.botConfig();
  return {
    enabled: cfg.enabled,
    running,
    conflict,
    failures,
    adminChatId: cfg.adminChatId ? 'set' : '',
    offset: offsetValue(),
  };
}

module.exports = {
  start,
  stop,
  status,
  handleUpdate,
  handleMessage,
  handleCallback,
  handleAdminMessage,
  handleAdminCallback,
  parseAmount,
  fileOf,
  isMinus,
  balanceText,
  statsText,
  helpText,
  packagesText,
  receiptsText,
  adminActor,
  adminHelpText,
  resellerByIdentity,
  resellersText,
  pendingListText,
  botUsername,
  cachedBotUsername,
  deepLink,
  registerCommands,
  userByTelegramId,
  stateGet,
  stateSet,
  stateDel,
  offsetValue,
  dropBacklog,
  stepOf,
  setStep,
  clearStep,
  postToAdmin,
  syncAdminMessage,
  menuKeyboard,
  adminMenuKeyboard,
  moneyChoiceKeyboard,
  moneyConfirmKeyboard,
  pagerKeyboard,
  BTN_BALANCE,
  BTN_PACKAGES,
  BTN_RECEIPTS,
  BTN_STATS,
  BTN_TOPUP,
  BTN_HELP,
  BTN_CANCEL,
  BTN_A_RESELLERS,
  BTN_A_MONEY,
  BTN_A_PENDING,
  BTN_A_HELP,
  DAY_MS,
};
'use strict';

/**
 * The panel's own two-way Telegram bot (v1.5.2).
 *
 * A reseller talks to the SAME bot the panel already uses for backups and the
 * nightly report — no second bot, no second token. He can:
 *   • see his wallet balance and his last transactions,
 *   • see his own stats (packages, traffic today/7d/30d, expiring soon),
 *   • send a payment receipt, which is forwarded to the admin's chat with
 *     «تایید» / «رد» buttons. The wallet moves only when the admin taps تایید.
 *
 * Rules this file is written against:
 *   - identity is `users.telegram_id` and nothing else. A chat that is not linked
 *     to an account is told so (with its own numeric id, so the owner can link
 *     it) and is never shown anybody's data;
 *   - only an admin may decide a receipt: either his own telegram_id belongs to
 *     an admin account, or the tap happened in the configured admin chat;
 *   - the money lives in services/topups.js. This file only delivers messages,
 *     so the panel's own approve button and the Telegram button cannot disagree;
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
const stats = require('./stats');
const { ApiError, log, logError } = require('../utils');

const POLL_TIMEOUT_SEC = 25;
const STEP_TTL_MS = 30 * 60 * 1000;
const IDLE_SLEEP_MS = 15000;
const TEXT_MAX = 4096;
const GIB = 1024 ** 3;
const DAY_MS = 86400000;

const BTN_BALANCE = '💰 موجودی';
const BTN_STATS = '📊 آمار من';
const BTN_TOPUP = '🧾 ارسال فیش واریزی';
const BTN_HELP = '📖 راهنما';
const BTN_CANCEL = '❌ لغو';

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

function menuKeyboard() {
  return {
    keyboard: [
      [{ text: BTN_BALANCE }, { text: BTN_STATS }],
      [{ text: BTN_TOPUP }, { text: BTN_HELP }],
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

function helpText(user) {
  const lines = [
    '📖 <b>راهنمای ربات</b>',
    '',
    `${BTN_BALANCE} — موجودی کیف پول و آخرین تراکنش‌ها`,
    `${BTN_STATS} — آمار بسته‌ها و ترافیک مشتریان شما`,
    `${BTN_TOPUP} — افزایش موجودی با فیش واریزی`,
    '',
    '<b>روش افزایش موجودی</b>',
    `۱) دکمهٔ «${BTN_TOPUP}» را بزنید (یا دستور /topup).`,
    '۲) مبلغ واریزی را به تومان بفرستید؛ مثلا <code>500000</code>.',
    '۳) عکس یا فایل فیش واریزی را بفرستید.',
    '۴) فیش برای مدیر ارسال می‌شود؛ پس از تایید او موجودی شما افزایش پیدا می‌کند و همین‌جا خبر می‌گیرید.',
    '',
    'دستورها: /start /balance /stats /topup /help /cancel',
    '',
    `<i>شناسهٔ تلگرام شما: <code>${esc(user?.telegram_id || '')}</code></i>`,
  ];
  return lines.join('\n');
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

// ------------------------------------------------------------------ messages

async function handleMessage(message) {
  const chatId = String(message?.chat?.id || '');
  const fromId = String(message?.from?.id || '');
  if (!chatId || !fromId) return { ok: false, reason: 'no_chat' };
  // Only private chats are served: a group must never become a place where one
  // reseller reads another's wallet, and the admin chat is reached by forwarding.
  if (message.chat.type !== 'private') {
    if (String(chatId) === String(telegram.botConfig().adminChatId || '')) {
      const actor = adminActor(fromId, chatId);
      if (actor && String(message.text || '').trim().startsWith('/pending')) {
        const list = topups.listRequests({ status: 'pending', page: 1, pageSize: 10 });
        const lines = [`🧾 <b>فیش‌های در انتظار: ${faNum(list.counts.pending)}</b>`];
        for (const row of list.rows) {
          lines.push(`• #${row.id} · ${esc(row.username)} · ${faNum(row.amount)} ${esc(currency())} · ${esc(faDate(row.createdAt, true))}`);
        }
        if (!list.rows.length) lines.push('<i>موردی نیست.</i>');
        await reply(chatId, lines.join('\n'));
        return { ok: true, action: 'admin_pending' };
      }
    }
    return { ok: false, reason: 'not_private' };
  }

  const user = userByTelegramId(fromId);
  const text = String(message.text || '').trim();
  const file = fileOf(message);

  if (!user) {
    // An admin who is not linked to a telegram_id still gets his own chat served.
    const actor = adminActor(fromId, chatId);
    if (actor && String(chatId) === String(telegram.botConfig().adminChatId || '')) {
      if (text === '/pending') {
        const list = topups.listRequests({ status: 'pending', page: 1, pageSize: 10 });
        const lines = [`🧾 <b>فیش‌های در انتظار: ${faNum(list.counts.pending)}</b>`];
        for (const row of list.rows) {
          lines.push(`• #${row.id} · ${esc(row.username)} · ${faNum(row.amount)} ${esc(currency())}`);
        }
        if (!list.rows.length) lines.push('<i>موردی نیست.</i>');
        await reply(chatId, lines.join('\n'));
        return { ok: true, action: 'admin_pending' };
      }
      await reply(chatId, [
        '👋 <b>سلام مدیر</b>',
        'فیش‌های واریزی نماینده‌ها به همین چت ارسال می‌شود و با دکمه‌های زیر هر فیش تایید یا رد می‌شوند.',
        'دستور /pending فهرست فیش‌های در انتظار را نشان می‌دهد.',
        'برای دیدن موجودی و آمار خودتان، شناسهٔ تلگرامتان را در حساب کاربری پنل ثبت کنید.',
      ].join('\n'));
      return { ok: true, action: 'admin_hello' };
    }
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
    if (command === '/start') {
      await replyMenu(chatId, [
        `👋 <b>خوش آمدید ${esc(user.name || user.username)}</b>`,
        `موجودی کیف پول: <b>${faNum(user.balance)}</b> ${esc(currency())}`,
        '',
        'از دکمه‌های زیر استفاده کنید:',
      ].join('\n'));
      await reply(chatId, helpText(user));
      return { ok: true, action: 'start' };
    }
    await replyMenu(chatId, helpText(user));
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

async function handleCallback(callback) {
  const data = String(callback?.data || '');
  const match = /^topup:(ok|no):(\d+)$/.exec(data);
  const chatId = String(callback?.message?.chat?.id || '');
  const fromId = String(callback?.from?.id || '');
  const answer = (text, alert = false) => telegram.call('answerCallbackQuery', {
    callback_query_id: callback.id,
    text: String(text || '').slice(0, 190),
    show_alert: alert,
  }).catch(() => null);

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
  parseAmount,
  fileOf,
  balanceText,
  statsText,
  helpText,
  adminActor,
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
  BTN_BALANCE,
  BTN_STATS,
  BTN_TOPUP,
  BTN_HELP,
  BTN_CANCEL,
  DAY_MS,
};
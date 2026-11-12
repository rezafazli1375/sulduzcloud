'use strict';

/**
 * The two-way reseller bot and the wallet receipts, end to end (v1.5.2).
 *
 * Owner's request (verbatim): «ربات متصل به این برنامه رو توسعه بدیم و پیشرفته
 * بکنیم نماینده بتونه موجود خود و آمار خود را از ربات مشاهده کنه / و همچنین بتونه
 * با ارسال فیش واریزی موجودی خودش افزایش بده / البته ربات فیش واریزی به تلگرام
 * مدیر بفرسته دکمه تایید یا رد داشته باشه اگر مدیر دکمه تایید زد موجودی نماینده
 * افزایش پیدا کنه».
 *
 * selftest.js drives the HTTP routes through a SPAWNED server, so it can only
 * cover the panel half of this feature. The conversation itself — identity, the
 * two-step receipt, the admin's buttons, the single credit — runs here, IN
 * PROCESS, with telegram.call replaced by a recorder. Every message the bot
 * would have sent is captured with its payload, so the checks can prove WHICH
 * chat got WHAT, with which keyboard.
 *
 * Nothing here can reach the network: global.fetch is replaced by a function
 * that counts the attempt and fails it, and DATA_DIR is a throwaway directory.
 * The one exception is the receipt-download check, which swaps in a local fake
 * for the duration of one call and puts the blocker straight back.
 *
 *   npm run bot-test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-bot-'));
process.env.DATA_DIR = DATA_DIR;
process.env.BACKUP_DIR = path.join(DATA_DIR, 'backups');
process.env.NODE_ENV = 'test';
process.env.PANEL_TZ = 'Asia/Tehran';

// The one rule this file exists to enforce: no real Telegram call, ever.
let networkAttempts = 0;
const blockedFetch = async (url) => {
  networkAttempts += 1;
  throw new Error(`network call blocked by the bot test: ${String(url).slice(0, 60)}`);
};
global.fetch = blockedFetch;

const { getDb, closeDb } = require('../src/db');
const settings = require('../src/settings');
const usersService = require('../src/services/users');
const telegram = require('../src/services/telegram');
const topups = require('../src/services/topups');
const bot = require('../src/services/bot');
const config = require('../src/config');
const { dayKey } = require('../src/utils');

let pass = 0;
let fail = 0;
function check(name, ok, note = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}${note ? `  — ${note}` : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${note ? `  — ${note}` : ''}`); }
}

const GB = 1024 ** 3;
const DAY_MS = 86400000;
const NOW = Date.now();
const fa = (n) => new Intl.NumberFormat('fa-IR').format(Math.round(Number(n) || 0));

const PANEL_CHAT = '-1009000000002';
const ADMIN_CHAT = '-1009000000001';
const SHOP_TG = '770152001';
const OTHER_TG = '770152002';
const PARKED_TG = '770152003';
const ADMIN_TG = '770152900';
// An admin who never registered his Telegram id: he decides from the admin chat.
const UNLINKED_ADMIN_TG = '770152901';
const STRANGER_TG = '770152999';

// Every telegram.call the bot makes, with its full payload.
const calls = [];
let messageSeq = 500;
telegram.call = async (method, payload = {}) => {
  calls.push({ method, payload });
  switch (method) {
    case 'sendMessage':
    case 'sendPhoto':
    case 'sendDocument':
      messageSeq += 1;
      return { message_id: messageSeq, chat: { id: payload.chat_id } };
    case 'answerCallbackQuery':
    case 'editMessageText':
    case 'editMessageCaption':
      return true;
    case 'getWebhookInfo':
      return { url: '' };
    case 'getUpdates':
      return [{ update_id: 9001 }];
    case 'getFile':
      return { file_path: 'photos/receipt-152.jpg' };
    case 'getMe':
      return { username: 'sulduzcloud_bot' };
    default:
      return null;
  }
};

const SENDS = ['sendMessage', 'sendPhoto', 'sendDocument'];
const sentTo = (chatId) => calls.filter((one) => SENDS.includes(one.method) && String(one.payload.chat_id) === String(chatId));
const lastTo = (chatId) => sentTo(chatId)[sentTo(chatId).length - 1] || null;
const textOf = (one) => String(one?.payload?.text || one?.payload?.caption || '');
const lastOf = (method) => [...calls].reverse().find((one) => one.method === method) || null;

let updateSeq = 0;
const message = (fromId, chatId, extra = {}, type = 'private') => {
  updateSeq += 1;
  return {
    update_id: updateSeq,
    message: {
      message_id: 1000 + updateSeq,
      date: Math.floor(Date.now() / 1000),
      chat: { id: String(chatId), type },
      from: { id: String(fromId), is_bot: false, first_name: 'تست' },
      ...extra,
    },
  };
};
const says = (fromId, chatId, text, type = 'private') => message(fromId, chatId, { text }, type);
const sendsPhoto = (fromId, chatId, fileId) => message(fromId, chatId, {
  photo: [{ file_id: `${fileId}-small`, width: 90 }, { file_id: fileId, width: 800 }],
});
const sendsDoc = (fromId, chatId, fileId, mime) => message(fromId, chatId, { document: { file_id: fileId, mime_type: mime } });
const taps = (fromId, chatId, data, messageId) => {
  updateSeq += 1;
  return {
    update_id: updateSeq,
    callback_query: {
      id: `cb-${updateSeq}`,
      from: { id: String(fromId) },
      data,
      message: {
        message_id: Number(messageId) || 1,
        chat: { id: String(chatId), type: 'private' },
        caption: '🧾 <b>فیش واریزی جدید</b>',
      },
    },
  };
};

const balanceOf = (id) => Number(getDb().prepare('SELECT balance FROM users WHERE id = ?').get(Number(id))?.balance || 0);
const txCount = (id) => Number(getDb().prepare('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?').get(Number(id)).c);
const rowOf = (id) => getDb().prepare('SELECT * FROM users WHERE id = ?').get(Number(id));

function makeUser(username, { telegramId = '', balance = 0, role = 'reseller', status = 'active' } = {}) {
  const created = usersService.createUser({ username, password: 'Bot-Suite-12345', role, telegram_id: telegramId, balance });
  if (status !== 'active') getDb().prepare('UPDATE users SET status = ? WHERE id = ?').run(status, created.id);
  return rowOf(created.id);
}

function addConfig(userId, { email, gb, usedGb, expiryAt, inboundId = 10 }) {
  const info = getDb()
    .prepare(
      `INSERT INTO configs (user_id, inbound_id, email, sub_id, label, customer_name, total_bytes, expiry_at,
        enabled, status, up_bytes, down_bytes, last_up, last_down, last_synced_at, created_at, updated_at, origin, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, 0, ?, 0, ?, ?, ?, 'panel', 0)`
    )
    .run(
      userId, inboundId, email, `sub-${email}`, email, email,
      Math.round(gb * GB), Math.round(expiryAt), Math.round(usedGb * GB), Math.round(usedGb * GB),
      NOW, NOW - 5 * DAY_MS, NOW
    );
  return Number(info.lastInsertRowid);
}

async function main() {
  settings.setSetting('telegram', {
    enabled: true,
    botToken: '123456:bot-suite-token',
    chatId: PANEL_CHAT,
    botEnabled: true,
    botAdminChatId: ADMIN_CHAT,
  });
  const owner = makeUser('botowner', { role: 'admin', telegramId: ADMIN_TG });
  const shop = makeUser('botshop', { telegramId: SHOP_TG, balance: 1250000 });
  const other = makeUser('botother', { telegramId: OTHER_TG, balance: 40000 });
  makeUser('botparked', { telegramId: PARKED_TG, status: 'disabled' });

  const cfgA = addConfig(shop.id, { email: 'botshop-a', gb: 10, usedGb: 3, expiryAt: NOW + 2 * DAY_MS });
  addConfig(shop.id, { email: 'botshop-b', gb: 5, usedGb: 0.5, expiryAt: NOW + 20 * DAY_MS, inboundId: 11 });
  getDb().prepare('INSERT INTO usage_daily (config_id, user_id, day, up_bytes, down_bytes) VALUES (?, ?, ?, ?, ?)')
    .run(cfgA, shop.id, dayKey(NOW, config.timezone), Math.round(1.5 * GB), Math.round(1.5 * GB));

  const cfg = telegram.botConfig();
  check('the bot is configured from the panel settings alone — no second token, no second bot',
    cfg.enabled === true && cfg.adminChatId === ADMIN_CHAT && cfg.botToken === '123456:bot-suite-token',
    `enabled=${cfg.enabled} adminChat=${cfg.adminChatId}`);

  // ------------------------------------------------------------------ identity
  const unlinked = await bot.handleUpdate(says(STRANGER_TG, STRANGER_TG, '/start'));
  const unText = textOf(lastTo(STRANGER_TG));
  check('a chat linked to no account is told its own numeric id and nobody’s data',
    unlinked.ok === false && unlinked.reason === 'unlinked'
      && unText.includes(STRANGER_TG) && unText.includes('متصل نیست') && !unText.includes('botshop'),
    `reason=${unlinked.reason} idShown=${unText.includes(STRANGER_TG)}`);

  const group = await bot.handleUpdate(says(SHOP_TG, '-100777000', '/balance', 'supergroup'));
  check('a group never becomes a place where one reseller reads another’s wallet',
    group.ok === false && group.reason === 'not_private' && sentTo('-100777000').length === 0,
    `reason=${group.reason}`);

  const start = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, '/start'));
  const startCalls = sentTo(SHOP_TG);
  check('a linked reseller gets the four-button menu and the guide',
    start.action === 'start' && startCalls.length === 2
      && (startCalls[0].payload.reply_markup?.keyboard || []).length === 2
      && textOf(startCalls[1]).includes('/topup') && textOf(startCalls[0]).includes(fa(1250000)),
    `action=${start.action} messages=${startCalls.length}`);

  const bal = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, bot.BTN_BALANCE));
  const balText = textOf(lastTo(SHOP_TG));
  check('«موجودی» shows his wallet, his name and his last transactions',
    bal.action === 'balance' && balText.includes('موجودی کیف پول') && balText.includes('botshop')
      && balText.includes(fa(1250000)) && lastTo(SHOP_TG).payload.reply_markup?.keyboard?.length === 2,
    `action=${bal.action}`);

  const st = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, bot.BTN_STATS));
  const stText = textOf(lastTo(SHOP_TG));
  check('«آمار من» reports his own packages, traffic and expiring subscriptions',
    st.action === 'stats' && stText.includes('آمار شما') && stText.includes('بسته‌ها')
      && stText.includes(fa(2)) && stText.includes('گیگ') && stText.includes('نزدیک انقضا'),
    `action=${st.action} len=${stText.length}`);

  const otherBal = await bot.handleUpdate(says(OTHER_TG, OTHER_TG, '/balance'));
  const otherText = textOf(lastTo(OTHER_TG));
  check('one reseller never sees another reseller’s wallet',
    otherBal.action === 'balance' && otherText.includes('botother') && otherText.includes(fa(40000))
      && !otherText.includes('botshop'),
    `action=${otherBal.action}`);

  const parked = await bot.handleUpdate(says(PARKED_TG, PARKED_TG, '/balance'));
  check('a disabled reseller account is refused', parked.ok === false && parked.reason === 'inactive',
    `reason=${parked.reason}`);

  const hint = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, '700000'));
  check('a number outside the conversation is a hint, never a silent wallet change',
    hint.action === 'amount_hint' && topups.pendingCount(shop.id) === 0 && balanceOf(shop.id) === 1250000,
    `action=${hint.action} pending=${topups.pendingCount(shop.id)}`);

  const fallback = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, 'سلام وقت بخیر'));
  check('an unrelated message is answered with the menu, not with silence',
    fallback.action === 'fallback' && textOf(lastTo(SHOP_TG)).includes('/help'),
    `action=${fallback.action}`);

  // ------------------------------------------------- the receipt, amount first
  const opened = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, bot.BTN_TOPUP));
  check('«ارسال فیش واریزی» opens a two-step conversation',
    opened.step === 'amount' && bot.stepOf(SHOP_TG)?.step === 'amount'
      && textOf(lastTo(SHOP_TG)).includes('مبلغ'),
    `step=${bot.stepOf(SHOP_TG)?.step}`);

  const amountStep = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, '500000'));
  check('the amount is accepted and the picture is asked for — no request yet',
    amountStep.action === 'receipt_amount' && Number(bot.stepOf(SHOP_TG)?.amount) === 500000
      && topups.pendingCount(shop.id) === 0,
    `action=${amountStep.action} amount=${bot.stepOf(SHOP_TG)?.amount}`);

  const before = balanceOf(shop.id);
  const picture = await bot.handleUpdate(sendsPhoto(SHOP_TG, SHOP_TG, 'receipt-1'));
  const req1 = picture.request || {};
  check('the picture completes the request: one pending row, and not one toman moved',
    picture.ok === true && Number(req1.amount) === 500000 && req1.status === 'pending'
      && req1.fileKind === 'photo' && req1.fileId === 'receipt-1'
      && balanceOf(shop.id) === before && topups.pendingCount(shop.id) === 1 && bot.stepOf(SHOP_TG) === null,
    `id=${req1.id} amount=${req1.amount} balance=${balanceOf(shop.id)}`);

  const adminPost = sentTo(ADMIN_CHAT)[0] || {};
  const buttons = adminPost.payload?.reply_markup?.inline_keyboard?.[0] || [];
  check('the receipt is forwarded to the admin chat with «تایید» and «رد» buttons',
    adminPost.method === 'sendPhoto' && adminPost.payload.photo === 'receipt-1'
      && buttons.some((one) => one.callback_data === `topup:ok:${req1.id}`)
      && buttons.some((one) => one.callback_data === `topup:no:${req1.id}`)
      && textOf(adminPost).includes('botshop') && textOf(adminPost).includes(fa(500000)),
    `method=${adminPost.method} buttons=${buttons.map((one) => one.callback_data).join('|')}`);
  const stored1 = topups.getRequest(req1.id);
  check('where the admin copy was posted is remembered, so its buttons can be taken back later',
    stored1.adminChatId === ADMIN_CHAT && stored1.adminMessageId > 0,
    `chat=${stored1.adminChatId} message=${stored1.adminMessageId}`);
  check('the reseller is told his receipt is waiting for a decision',
    textOf(lastTo(SHOP_TG)).includes('فیش شما ثبت شد') && textOf(lastTo(SHOP_TG)).includes(`#${req1.id}`),
    `len=${textOf(lastTo(SHOP_TG)).length}`);

  // ------------------------------------------------- the receipt, picture first
  const fileFirst = await bot.handleUpdate(sendsPhoto(SHOP_TG, SHOP_TG, 'receipt-2'));
  check('the picture may come first — the bot then asks for the amount',
    fileFirst.action === 'receipt_file' && bot.stepOf(SHOP_TG)?.fileId === 'receipt-2',
    `action=${fileFirst.action}`);
  const faAmount = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, '۲۵۰٬۰۰۰ تومان'));
  const req2 = faAmount.request || {};
  check('Persian digits, thousands separators and the word «تومان» are all understood',
    faAmount.ok === true && Number(req2.amount) === 250000 && req2.fileId === 'receipt-2'
      && req2.fileKind === 'photo',
    `amount=${req2.amount}`);
  check('parseAmount reads the shapes a reseller actually types, and refuses the rest',
    bot.parseAmount('500000') === 500000 && bot.parseAmount('۵۰۰۰۰۰') === 500000
      && bot.parseAmount('٥٠٠٠٠٠') === 500000 && bot.parseAmount('500,000 تومان') === 500000
      && bot.parseAmount('۱۲۰۰۰۰۰ تومن') === 1200000
      && bot.parseAmount('abc') === null && bot.parseAmount('-5') === null
      && bot.parseAmount('0') === null && bot.parseAmount('') === null && bot.parseAmount('12.5') === null,
    'ten shapes');

  // ------------------------------------------------------------- the refusals
  const zip = await bot.handleUpdate(sendsDoc(SHOP_TG, SHOP_TG, 'apk-1', 'application/zip'));
  check('only a picture or a PDF is accepted as a receipt',
    zip.ok === false && zip.reason === 'bad_file' && textOf(lastTo(SHOP_TG)).includes('PDF'),
    `reason=${zip.reason}`);
  const pdf = await bot.handleUpdate(sendsDoc(SHOP_TG, SHOP_TG, 'receipt-3', 'application/pdf'));
  check('a PDF receipt is accepted and kept as a document',
    pdf.action === 'receipt_file' && bot.stepOf(SHOP_TG)?.fileKind === 'document',
    `kind=${bot.stepOf(SHOP_TG)?.fileKind}`);
  const badAmount = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, 'بعدا می‌فرستم'));
  check('a non-number inside the conversation keeps it open instead of losing the picture',
    badAmount.reason === 'bad_amount' && bot.stepOf(SHOP_TG)?.fileId === 'receipt-3',
    `reason=${badAmount.reason}`);
  const cancelled = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, bot.BTN_CANCEL));
  check('«لغو» closes the conversation', cancelled.action === 'cancel' && bot.stepOf(SHOP_TG) === null,
    `action=${cancelled.action}`);

  await bot.handleUpdate(says(SHOP_TG, SHOP_TG, '/topup'));
  const huge = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, '999999999999'));
  check('an impossible amount is refused inside the conversation',
    huge.ok === false && huge.reason === 'amount_rejected' && textOf(lastTo(SHOP_TG)).includes('حداکثر'),
    `reason=${huge.reason}`);
  await bot.handleUpdate(says(SHOP_TG, SHOP_TG, '/cancel'));

  while (topups.pendingCount(shop.id) < topups.MAX_PENDING_PER_USER) {
    topups.createRequest({ userId: shop.id, amount: 1000, fileKind: 'photo', fileId: 'filler', chatId: SHOP_TG });
  }
  await bot.handleUpdate(says(SHOP_TG, SHOP_TG, bot.BTN_TOPUP));
  await bot.handleUpdate(says(SHOP_TG, SHOP_TG, '1000'));
  const over = await bot.handleUpdate(sendsPhoto(SHOP_TG, SHOP_TG, 'receipt-over'));
  check('an eleventh waiting receipt is refused with an answer, not with silence',
    over.ok === false && over.reason === 'request_refused'
      && textOf(lastTo(SHOP_TG)).includes('در انتظار')
      && topups.pendingCount(shop.id) === topups.MAX_PENDING_PER_USER,
    `reason=${over.reason} pending=${topups.pendingCount(shop.id)}`);

  // ------------------------------------------------------------- the decisions
  const strangerTap = await bot.handleUpdate(taps(STRANGER_TG, STRANGER_TG, `topup:ok:${req1.id}`, stored1.adminMessageId));
  const alert = lastOf('answerCallbackQuery');
  check('a stranger cannot approve a receipt, and is told so out loud',
    strangerTap.ok === false && strangerTap.reason === 'not_admin'
      && balanceOf(shop.id) === before && topups.getRequest(req1.id).status === 'pending'
      && alert?.payload?.show_alert === true,
    `reason=${strangerTap.reason} alert=${alert?.payload?.show_alert}`);

  const okTap = await bot.handleUpdate(taps(ADMIN_TG, ADMIN_CHAT, `topup:ok:${req1.id}`, stored1.adminMessageId));
  const afterApprove = balanceOf(shop.id);
  check('the admin taps «تایید و شارژ» and the wallet is credited exactly once',
    okTap.ok === true && okTap.action === 'approved' && Number(okTap.balance) === before + 500000
      && afterApprove === before + 500000 && txCount(shop.id) === 1
      && topups.getRequest(req1.id).status === 'approved'
      && Number(topups.getRequest(req1.id).decidedBy) === Number(owner.id),
    `action=${okTap.action} balance=${afterApprove} tx=${txCount(shop.id)}`);
  const edit = lastOf('editMessageCaption');
  check('the buttons are taken away from the admin copy the moment it is decided',
    Boolean(edit) && String(edit.payload.chat_id) === ADMIN_CHAT
      && Number(edit.payload.message_id) === stored1.adminMessageId
      && Array.isArray(edit.payload.reply_markup?.inline_keyboard)
      && edit.payload.reply_markup.inline_keyboard.length === 0
      && String(edit.payload.caption).includes('تایید شد'),
    `method=editMessageCaption message=${edit?.payload?.message_id}`);
  check('the reseller is told in his own chat, with his new balance',
    textOf(lastTo(SHOP_TG)).includes('فیش واریزی شما تایید شد') && textOf(lastTo(SHOP_TG)).includes(fa(afterApprove)),
    `len=${textOf(lastTo(SHOP_TG)).length}`);
  check('the panel inbox carries the same news',
    Number(getDb().prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title = 'موجودی شما افزایش یافت'").get(shop.id).c) === 1,
    'one notification');

  const twiceTap = await bot.handleUpdate(taps(ADMIN_TG, ADMIN_CHAT, `topup:ok:${req1.id}`, stored1.adminMessageId));
  check('a second tap on the same receipt credits nothing',
    twiceTap.ok === false && twiceTap.reason === 'already_decided'
      && balanceOf(shop.id) === afterApprove && txCount(shop.id) === 1,
    `reason=${twiceTap.reason} balance=${balanceOf(shop.id)}`);

  const stored2 = topups.getRequest(req2.id);
  const noTap = await bot.handleUpdate(taps(UNLINKED_ADMIN_TG, ADMIN_CHAT, `topup:no:${req2.id}`, stored2.adminMessageId));
  check('an admin who never linked his Telegram id may still decide from the admin chat — a rejection moves no money',
    noTap.ok === true && noTap.action === 'rejected' && balanceOf(shop.id) === afterApprove
      && topups.getRequest(req2.id).status === 'rejected'
      && textOf(lastTo(SHOP_TG)).includes('فیش واریزی شما رد شد'),
    `action=${noTap.action} balance=${balanceOf(shop.id)}`);

  // A decision taken in the PANEL must retract the Telegram buttons too.
  const panelReq = topups.createRequest({
    userId: shop.id, amount: 700000, fileKind: 'photo', fileId: 'receipt-panel', chatId: SHOP_TG, source: 'bot',
  });
  await bot.postToAdmin(panelReq, rowOf(shop.id));
  const panelDecided = topups.approve(panelReq.id, { actor: { id: owner.id, role: 'admin' }, source: 'panel' }, { user: { id: owner.id, role: 'admin' } });
  const synced = await bot.syncAdminMessage(panelDecided, 'approved', owner.username);
  const syncEdit = lastOf('editMessageCaption');
  check('a decision made in the panel also takes the Telegram buttons away',
    synced.synced === true && String(syncEdit.payload.caption).includes('در پنل تایید شد')
      && syncEdit.payload.reply_markup.inline_keyboard.length === 0
      && balanceOf(shop.id) === afterApprove + 700000,
    `synced=${synced.synced} balance=${balanceOf(shop.id)}`);

  const unknown = await bot.handleUpdate(taps(ADMIN_TG, ADMIN_CHAT, 'something:else', 1));
  check('an unknown button is answered, not crashed on', unknown.reason === 'unknown_callback', `reason=${unknown.reason}`);
  const ghost = await bot.handleUpdate(taps(ADMIN_TG, ADMIN_CHAT, 'topup:ok:999999', 1));
  check('a button for a request that no longer exists is answered', ghost.reason === 'not_found', `reason=${ghost.reason}`);

  const pendingCmd = await bot.handleUpdate(says(UNLINKED_ADMIN_TG, ADMIN_CHAT, '/pending'));
  check('/pending lists the waiting receipts in the admin chat',
    pendingCmd.action === 'admin_pending' && textOf(lastTo(ADMIN_CHAT)).includes('فیش‌های در انتظار'),
    `action=${pendingCmd.action}`);

  // ------------------------------------------------- the receipt file in the panel
  // fetchFile asks Telegram twice: getFile for the path, then the file itself.
  // Both go through the module's own `call`/fetch, NOT the recorded export above,
  // so this fake has to answer both shapes — and it is the only fetch allowed to
  // succeed in this suite, restored to the blocker on the very next line.
  const bytes = Buffer.from('fake-jpeg-bytes-for-the-receipt-proxy');
  const fileFetches = [];
  const apiFetches = [];
  global.fetch = async (url, opts = {}) => {
    const target = String(url);
    if (target.includes('/file/bot')) {
      fileFetches.push(target);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    }
    apiFetches.push({ url: target, body: JSON.parse(String(opts.body || '{}')) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { file_path: 'photos/receipt-152.jpg' } }),
    };
  };
  let file = null;
  let fileError = null;
  try { file = await telegram.fetchFile('receipt-1'); } catch (err) { fileError = err; }
  global.fetch = blockedFetch;
  check('the panel can show the receipt: the file is fetched server-side and typed by its extension',
    !fileError && file?.mime === 'image/jpeg' && file.buffer.equals(bytes)
      && fileFetches.length === 1 && fileFetches[0].includes('/file/bot') && file.name === 'receipt-152.jpg',
    `mime=${file?.mime} bytes=${file?.buffer?.length} error=${fileError?.message || '-'}`);
  check('the file id asked of Telegram is the one on the row, never a browser value',
    apiFetches.length === 1 && apiFetches[0].url.endsWith('/getFile') && apiFetches[0].body.file_id === 'receipt-1'
      && fileFetches[0].endsWith('/photos/receipt-152.jpg'),
    `api=${apiFetches[0]?.url.split('/').pop()} id=${apiFetches[0]?.body?.file_id}`);
  let noFile = null;
  try { await telegram.fetchFile(''); } catch (err) { noFile = err; }
  check('a request with no file id never reaches Telegram', noFile?.code === 'file_required' && networkAttempts === 0,
    `code=${noFile?.code}`);

  // ------------------------------------------------------------- poller safety
  const started = await bot.start();
  check('the poller never starts inside a test run', started.started === false && started.reason === 'test_env',
    `reason=${started.reason}`);
  const state = bot.status();
  check('the bot reports its own state for the settings page',
    state.enabled === true && state.running === false && state.conflict === false && state.adminChatId === 'set',
    JSON.stringify(state));
  // A database that has never polled has no offset row. Number(null) is 0, and
  // offset 0 means "send me every update still waiting" — so a first boot that
  // reads it as 0 processes the backlog instead of confirming it, and a restart
  // re-sends old receipts. These three checks pin the first boot down.
  check('a database that has never polled keeps a null offset, not 0',
    bot.stateGet('offset') === null && bot.offsetValue() === null && bot.status().offset === null,
    `stored=${bot.stateGet('offset')} offset=${bot.status().offset}`);
  const sendsBeforeDrop = calls.filter((one) => SENDS.includes(one.method)).length;
  const callsBeforeDrop = calls.length;
  const dropped = await bot.dropBacklog();
  const dropCall = lastOf('getUpdates');
  check('the first poll confirms the backlog instead of processing it',
    dropped === 9001 && dropCall?.payload?.offset === -1 && dropCall?.payload?.limit === 1
      && bot.offsetValue() === 9002 && calls.length === callsBeforeDrop + 1,
    `offset=${dropCall?.payload?.offset} last=${dropped} next=${bot.offsetValue()} calls=${calls.length - callsBeforeDrop}`);
  check('dropping the backlog never messages anyone',
    calls.filter((one) => SENDS.includes(one.method)).length === sendsBeforeDrop,
    `sends=${calls.filter((one) => SENDS.includes(one.method)).length - sendsBeforeDrop}`);
  bot.stateSet('offset', 9002);
  check('the getUpdates offset lives in the database, so a restart never replays old receipts',
    bot.stateGet('offset') === 9002 && bot.status().offset === 9002,
    `offset=${bot.status().offset}`);
  bot.setStep(SHOP_TG, { step: 'amount', amount: 1000 });
  getDb().prepare('UPDATE bot_state SET value = ? WHERE key = ?')
    .run(JSON.stringify({ step: 'amount', amount: 1000, at: Date.now() - 31 * 60 * 1000 }), `chat:${SHOP_TG}`);
  check('a half-finished conversation expires instead of haunting the next message',
    bot.stepOf(SHOP_TG) === null, 'ttl=30m');
  bot.stop();

  check('no bot run ever reached the network: api.telegram.org was never called',
    networkAttempts === 0, `networkAttempts=${networkAttempts}`);
}

main()
  .catch((err) => {
    fail += 1;
    console.log(`  FAIL the bot suite threw: ${err && err.stack ? err.stack : err}`);
  })
  .finally(() => {
    console.log(`\nbot-test: ${pass} passed, ${fail} failed  (throwaway data dir removed)`);
    try { bot.stop(); } catch (_) { /* already stopped */ }
    try { closeDb(); } catch (_) { /* already closed */ }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    process.exit(fail === 0 ? 0 : 1);
  });
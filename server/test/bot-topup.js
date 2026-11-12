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
  check('a linked reseller gets the six-button menu and the guide',
    start.action === 'help' && startCalls.length === 2
      && (startCalls[0].payload.reply_markup?.keyboard || []).length === 3
      && textOf(startCalls[1]).includes('/topup') && textOf(startCalls[0]).includes(fa(1250000)),
    `action=${start.action} messages=${startCalls.length}`);

  const bal = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, bot.BTN_BALANCE));
  const balText = textOf(lastTo(SHOP_TG));
  check('«موجودی» shows his wallet, his name and his last transactions',
    bal.action === 'balance' && balText.includes('موجودی کیف پول') && balText.includes('botshop')
      && balText.includes(fa(1250000)) && lastTo(SHOP_TG).payload.reply_markup?.keyboard?.length === 3,
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

  // ------------------------------------------------- v1.5.3: the six buttons
  // The owner asked for «مشاهده موجودی / افزایش موجودی و ارسال فیش / آمار» as
  // buttons. They are a reply keyboard, so they live under the chat instead of
  // inside one message — and every one of them must answer with the same text the
  // matching slash command produces, or the panel link and the keypad disagree.
  const kb = bot.menuKeyboard();
  check('v1.5.3: the reseller keypad is exactly six buttons in three rows, and it stays put',
    kb.keyboard.length === 3 && kb.keyboard.every((row) => row.length === 2)
      && kb.keyboard.flat().length === 6 && kb.resize_keyboard === true && kb.is_persistent === true
      && [bot.BTN_BALANCE, bot.BTN_PACKAGES, bot.BTN_TOPUP, bot.BTN_RECEIPTS, bot.BTN_STATS, bot.BTN_HELP]
        .every((label) => kb.keyboard.flat().some((one) => one.text === label)),
    `rows=${kb.keyboard.length} persistent=${kb.is_persistent}`);

  const pkgs = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, bot.BTN_PACKAGES));
  const pkText = textOf(lastTo(SHOP_TG));
  check('«آمار اشتراک‌ها» buckets his own packages — total, active, expiring in 3 days, depleted — and no other shop’s',
    pkgs.action === 'packages' && pkText.includes('آمار اشتراک‌های شما') && pkText.includes('در حال اتمام')
      && pkText.includes(fa(2)) && pkText.includes('botshop-a') && !pkText.includes('botother'),
    `action=${pkgs.action} len=${pkText.length}`);
  const pkCmd = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, '/packages'));
  check('the /packages command and its button answer with one and the same text',
    pkCmd.action === 'packages' && textOf(lastTo(SHOP_TG)) === pkText, 'identical');

  const rc = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, bot.BTN_RECEIPTS));
  check('«فیش‌های من» answers with his own receipt history, and says so when there is none yet',
    rc.action === 'receipts' && textOf(lastTo(SHOP_TG)).includes('فیش‌های واریزی شما')
      && textOf(lastTo(SHOP_TG)).includes('در انتظار'),
    `action=${rc.action}`);

  const helpBtn = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, bot.BTN_HELP));
  const helpMsg = textOf(lastTo(SHOP_TG));
  check('the guide lists the five working buttons, the panel’s bot link and the reseller’s own numeric id',
    helpBtn.action === 'help'
      && [bot.BTN_BALANCE, bot.BTN_PACKAGES, bot.BTN_TOPUP, bot.BTN_RECEIPTS, bot.BTN_STATS]
        .every((label) => helpMsg.includes(label))
      && helpMsg.includes('t.me/sulduzcloud_bot?start=topup') && helpMsg.includes('/receipts')
      && helpMsg.includes(SHOP_TG),
    `len=${helpMsg.length}`);

  // ---- the deep links the panel buttons open
  const deepTopup = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, '/start topup'));
  check('the panel link ?start=topup lands straight in the top-up conversation',
    deepTopup.step === 'amount' && bot.stepOf(SHOP_TG)?.step === 'amount'
      && textOf(lastTo(SHOP_TG)).includes('افزایش موجودی با فیش واریزی'),
    `step=${bot.stepOf(SHOP_TG)?.step}`);
  for (const [payload, action, needle] of [
    ['balance', 'deep_balance', 'موجودی کیف پول'],
    ['packages', 'deep_packages', 'آمار اشتراک‌های شما'],
    ['receipts', 'deep_receipts', 'فیش‌های واریزی شما'],
    ['stats', 'deep_stats', 'آمار شما'],
  ]) {
    const deep = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, `/start ${payload}`));
    const said = textOf(lastTo(SHOP_TG));
    const told = sentTo(SHOP_TG).slice(-2)[0];
    check(`?start=${payload} says which section it opened and answers like the «${payload}» button`,
      deep.ok === true && deep.action === action && said.includes(needle)
        && textOf(told).includes('از لینک پنل'),
      `action=${deep.action}`);
  }
  const deepMenu = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, '/start menu'));
  check('a link that only points at the keypad does not pretend to show anything',
    deepMenu.action === 'deep_menu' && textOf(lastTo(SHOP_TG)).includes('از دکمه‌های زیر استفاده کنید'),
    `action=${deepMenu.action}`);
  const deepBogus = await bot.handleUpdate(says(SHOP_TG, SHOP_TG, '/start wallet2000'));
  const bogusText = textOf(lastTo(SHOP_TG));
  check('an unknown ?start payload is answered with the keypad and no section at all — his own balance line is fine, a wallet page is not',
    deepBogus.ok === false && deepBogus.reason === 'unknown_deep_link'
      && bogusText.includes('نمی‌شناسم') && !bogusText.includes('آخرین تراکنش‌ها')
      && !bogusText.includes('آمار اشتراک‌ها') && bot.stepOf(SHOP_TG) === null
      && lastTo(SHOP_TG).payload.reply_markup?.keyboard?.length === 3,
    `reason=${deepBogus.reason}`);

  // ---- the bot's own username, cached, and the links built from it
  const getMeCalls = calls.filter((one) => one.method === 'getMe').length;
  const botName = await bot.botUsername();
  check('getMe ran exactly once for the whole conversation and its answer is cached in the database',
    botName === 'sulduzcloud_bot' && getMeCalls === 1 && bot.cachedBotUsername() === 'sulduzcloud_bot'
      && bot.stateGet('bot_username') === 'sulduzcloud_bot'
      && calls.filter((one) => one.method === 'getMe').length === 1,
    `name=@${botName} getMe=${getMeCalls}`);
  const beforeCached = calls.filter((one) => one.method === 'getMe').length;
  const cachedAgain = await bot.botUsername();
  check('the cached username costs no second network call: the poller already answered for the panel',
    cachedAgain === 'sulduzcloud_bot' && calls.filter((one) => one.method === 'getMe').length === beforeCached,
    `getMe calls=${beforeCached}`);
  check('the deep link is exactly the button the panel shows — t.me/<bot>?start=<section>',
    bot.deepLink('topup') === 'https://t.me/sulduzcloud_bot?start=topup'
      && bot.deepLink('receipts') === 'https://t.me/sulduzcloud_bot?start=receipts'
      && bot.deepLink('menu', 'another_bot') === 'https://t.me/another_bot?start=menu',
    bot.deepLink('topup'));
  const savedName = bot.stateGet('bot_username');
  bot.stateSet('bot_username', '');
  const noLink = bot.deepLink('topup');
  bot.stateSet('bot_username', savedName);
  check('a bot that has not announced itself yields no link at all, rather than a broken one',
    noLink === '' && bot.deepLink('topup') !== '', `link="${noLink}"`);

  // ---- the native command menu, scoped so a reseller never sees admin commands
  const cmdCallsBefore = calls.length;
  const reg = await bot.registerCommands();
  const scoped = calls.slice(cmdCallsBefore).filter((one) => one.method === 'setMyCommands');
  check('the command menu is registered twice: wallet commands in private chats, admin commands only in the admin chat',
    reg.commands === 8 && reg.adminCommands === 6 && scoped.length === 2
      && scoped[0].payload.scope.type === 'all_private_chats'
      && !scoped[0].payload.commands.some((one) => ['pending', 'resellers', 'money'].includes(one.command))
      && scoped[0].payload.commands.some((one) => one.command === 'packages')
      && scoped[1].payload.scope.type === 'chat'
      && Number(scoped[1].payload.scope.chat_id) === Number(ADMIN_CHAT)
      && scoped[1].payload.commands.some((one) => one.command === 'money'),
    `reseller=${reg.commands} admin=${reg.adminCommands} calls=${scoped.length}`);
  check('every description is Persian and within Telegram’s 250-character limit',
    scoped.every((one) => one.payload.commands.every((cmd) => /^[a-z_]{1,32}$/.test(cmd.command)
      && cmd.description.length > 0 && cmd.description.length <= 256
      && !cmd.description.includes('لغوَ'))),
    'names + descriptions');

  await bot.handleUpdate(says(SHOP_TG, SHOP_TG, '/cancel'));

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

  // ------------------------------------------- v1.5.3: the admin's own keypad
  // The owner asked for «دکمه امار کلی نمایندگان و موجودی هاشون» and «افزایش یا
  // کاهش موجودی یک نماینده بر اساس ایدی عددی تلگرام» — for HIM, separately from
  // the resellers. So the admin chat gets its own keyboard, and the money move is
  // a four-step conversation whose every step re-checks who is typing.
  for (let i = 1; i <= 7; i += 1) {
    makeUser(`pager${String(i).padStart(2, '0')}`, { telegramId: `7701590${String(i).padStart(2, '0')}`, balance: 1000 * i });
  }
  const adminStart = await bot.handleUpdate(says(ADMIN_TG, ADMIN_TG, '/start'));
  const adminKbRows = lastTo(ADMIN_TG).payload.reply_markup?.keyboard || [];
  const adminLabels = adminKbRows.flat().map((one) => one.text);
  check('v1.5.3: an admin gets his OWN keypad — the buttons a reseller uses never appear in his chat',
    adminStart.action === 'admin_menu' && adminKbRows.length === 2 && adminLabels.length === 4
      && adminLabels.join('|') === [bot.BTN_A_RESELLERS, bot.BTN_A_MONEY, bot.BTN_A_PENDING, bot.BTN_A_HELP].join('|')
      && !adminLabels.includes(bot.BTN_TOPUP) && !adminLabels.includes(bot.BTN_RECEIPTS),
    `rows=${adminKbRows.length} labels=${adminLabels.length}`);
  const adminHelp = await bot.handleUpdate(says(ADMIN_TG, ADMIN_TG, bot.BTN_A_HELP));
  const ahText = textOf(lastTo(ADMIN_TG));
  check('the admin guide explains all four buttons and the five-step manual move',
    adminHelp.action === 'admin_help'
      && [bot.BTN_A_RESELLERS, bot.BTN_A_MONEY, bot.BTN_A_PENDING, bot.BTN_A_HELP].every((label) => ahText.includes(label))
      && ahText.includes('/resellers /money /pending /balance /help') && ahText.includes('فیش در انتظار'),
    `len=${ahText.length}`);

  const resellerList = await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, bot.BTN_A_RESELLERS));
  const listMsg = lastTo(ADMIN_CHAT);
  const listText = textOf(listMsg);
  check('«آمار نمایندگان» gives each reseller his numeric telegram id, live balance, packages and traffic',
    resellerList.action === 'admin_resellers' && resellerList.page === 1
      && listText.includes('آمار نمایندگان') && listText.includes('pager01') && listText.includes('770159001')
      && listText.includes(fa(1000)) && listText.includes('مجموع موجودی‌ها') && listText.includes('⛔')
      && !listText.includes('botowner') && !listText.includes('botshop'),
    `action=${resellerList.action}`);
  check('a fleet of ten is paged, not scrolled: eight rows per page and the next page is one tap away',
    (listText.match(/شناسه:/g) || []).length === 8 && resellerList.pages === 2
      && listMsg.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === 'rs:pg:2',
    `rows=${(listText.match(/شناسه:/g) || []).length} pages=${resellerList.pages}`);
  const page2 = await bot.handleUpdate(taps(ADMIN_TG, ADMIN_CHAT, 'rs:pg:2', messageSeq));
  const p2Text = textOf(lastTo(ADMIN_CHAT));
  check('the next page carries the rest of the fleet, and the balance printed is the one the wallet holds',
    page2.action === 'admin_resellers_page' && page2.page === 2 && p2Text.includes('botshop')
      && p2Text.includes('botother') && p2Text.includes(fa(balanceOf(shop.id)))
      && (p2Text.match(/شناسه:/g) || []).length === 2,
    `page=${page2.page} rows=${(p2Text.match(/شناسه:/g) || []).length}`);

  // ---- the manual move, by numeric telegram id
  const shopBefore = balanceOf(shop.id);
  const shopTxBefore = txCount(shop.id);
  const moneyOpened = await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, bot.BTN_A_MONEY));
  check('«شارژ/کسر نماینده» opens a conversation and asks for the numeric id or the username',
    moneyOpened.step === 'adm_target' && bot.stepOf(ADMIN_CHAT)?.step === 'adm_target'
      && textOf(lastTo(ADMIN_CHAT)).includes('شناسهٔ عددی تلگرام یا نام کاربری')
      && lastTo(ADMIN_CHAT).payload.reply_markup?.keyboard?.[0]?.[0]?.text === bot.BTN_CANCEL,
    `step=${bot.stepOf(ADMIN_CHAT)?.step}`);
  const noShop = await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, 'no-such-shop'));
  check('a name that is not a live reseller is refused before any wallet is shown',
    noShop.ok === false && noShop.reason === 'reseller_not_found'
      && bot.stepOf(ADMIN_CHAT)?.step === 'adm_target' && balanceOf(shop.id) === shopBefore,
    `reason=${noShop.reason}`);
  const selfTarget = await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, String(owner.username)));
  check('an admin is never a target: the owner cannot charge his own wallet through the bot',
    selfTarget.ok === false && selfTarget.reason === 'reseller_not_found' && balanceOf(owner.id) === 0
      && txCount(owner.id) === 0,
    `reason=${selfTarget.reason}`);
  const parkedTarget = await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, 'botparked'));
  check('a disabled reseller is refused too — money he cannot spend is not moved',
    parkedTarget.reason === 'reseller_not_found', `reason=${parkedTarget.reason}`);

  const picked = await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, SHOP_TG));
  const dirMsgId = messageSeq;
  const dirButtons = (lastTo(ADMIN_CHAT).payload.reply_markup?.inline_keyboard || []).flat();
  check('the numeric id resolves to one reseller and his live balance is shown before anything moves',
    picked.ok === true && picked.step === 'adm_direction' && Number(picked.userId) === Number(shop.id)
      && textOf(lastTo(ADMIN_CHAT)).includes('botshop') && textOf(lastTo(ADMIN_CHAT)).includes(fa(shopBefore))
      && dirButtons.map((one) => one.callback_data).join('|')
        === `bal:set:${shop.id}:+|bal:set:${shop.id}:-|bal:cancel`,
    `buttons=${dirButtons.map((one) => one.callback_data).join('|')}`);
  const wrongTarget = await bot.handleUpdate(taps(ADMIN_TG, ADMIN_CHAT, `bal:set:${other.id}:+`, dirMsgId));
  check('the direction buttons of a newer screen cannot retarget the move onto another wallet',
    wrongTarget.ok === false && wrongTarget.reason === 'stale_step' && balanceOf(other.id) === 40000
      && lastOf('answerCallbackQuery')?.payload?.show_alert === true,
    `reason=${wrongTarget.reason}`);
  const awaitDirection = await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, '50000'));
  check('typing an amount before choosing a direction is refused: only the buttons set the sign',
    awaitDirection.ok === false && awaitDirection.reason === 'await_direction'
      && bot.stepOf(ADMIN_CHAT)?.step === 'adm_direction' && balanceOf(shop.id) === shopBefore,
    `reason=${awaitDirection.reason}`);

  const signUp = await bot.handleUpdate(taps(ADMIN_TG, ADMIN_CHAT, `bal:set:${shop.id}:+`, dirMsgId));
  check('«➕ افزایش موجودی» stores the sign, so the number that follows can only be added',
    signUp.ok === true && signUp.step === 'adm_amount' && signUp.sign === '+'
      && bot.stepOf(ADMIN_CHAT)?.sign === '+' && textOf(lastTo(ADMIN_CHAT)).includes('افزایش موجودی'),
    `sign=${bot.stepOf(ADMIN_CHAT)?.sign}`);
  const badMoney = await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, 'پنجاه هزار تومان'));
  check('a non-number in the money conversation moves nothing and keeps it open',
    badMoney.ok === false && badMoney.reason === 'bad_amount'
      && bot.stepOf(ADMIN_CHAT)?.step === 'adm_amount' && balanceOf(shop.id) === shopBefore,
    `reason=${badMoney.reason}`);
  const bigMoney = await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, '999999999999'));
  check('an impossible amount hits the same cap the panel receipts obey',
    bigMoney.ok === false && bigMoney.reason === 'amount_rejected'
      && textOf(lastTo(ADMIN_CHAT)).includes('حداکثر') && balanceOf(shop.id) === shopBefore,
    `reason=${bigMoney.reason}`);
  const confirmUp = await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, '۲۰۰٬۰۰۰'));
  const upMsgId = messageSeq;
  const upButton = (lastTo(ADMIN_CHAT).payload.reply_markup?.inline_keyboard || [[]])[0][0] || {};
  check('the confirm screen shows before and after, and its button carries exactly that amount',
    confirmUp.ok === true && confirmUp.step === 'adm_confirm' && Number(confirmUp.amount) === 200000
      && confirmUp.sign === '+' && textOf(lastTo(ADMIN_CHAT)).includes(fa(shopBefore))
      && textOf(lastTo(ADMIN_CHAT)).includes(fa(shopBefore + 200000))
      && upButton.callback_data === `bal:do:${shop.id}:+:200000` && String(upButton.text).includes(fa(200000)),
    `payload=${upButton.callback_data}`);
  const forgedUp = await bot.handleUpdate(taps(ADMIN_TG, ADMIN_CHAT, `bal:do:${shop.id}:+:900000`, upMsgId));
  check('a hand-made payload with a bigger number does not match the screen and moves nothing',
    forgedUp.ok === false && forgedUp.reason === 'stale_confirmation' && balanceOf(shop.id) === shopBefore,
    `reason=${forgedUp.reason}`);
  const charged = await bot.handleUpdate(taps(ADMIN_TG, ADMIN_CHAT, `bal:do:${shop.id}:+:200000`, upMsgId));
  check('the tap credits the wallet through the very function the panel drawer calls',
    charged.ok === true && charged.action === 'charged' && balanceOf(shop.id) === shopBefore + 200000
      && txCount(shop.id) === shopTxBefore + 1 && Number(charged.balance) === shopBefore + 200000
      && bot.stepOf(ADMIN_CHAT) === null,
    `action=${charged.action} balance=${balanceOf(shop.id)}`);
  const receiptEdit = lastOf('editMessageText');
  check('the ✅ screen is REPLACED by the receipt, so no live button is left behind',
    Boolean(receiptEdit) && String(receiptEdit.payload.chat_id) === ADMIN_CHAT
      && Number(receiptEdit.payload.message_id) === upMsgId
      && receiptEdit.payload.reply_markup.inline_keyboard.length === 0
      && String(receiptEdit.payload.text).includes('موجودی افزایش یافت')
      && String(receiptEdit.payload.text).includes(fa(shopBefore + 200000)),
    `message=${receiptEdit?.payload?.message_id}`);
  const creditTx = getDb().prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(shop.id);
  check('the move is written the way a panel move is: bot-named description and the admin as created_by',
    creditTx.type === 'credit' && Number(creditTx.amount) === 200000
      && Number(creditTx.created_by) === Number(owner.id)
      && String(creditTx.description).includes('ربات تلگرام') && String(creditTx.description).includes('botshop'),
    `type=${creditTx.type} by=${creditTx.created_by}`);
  const balanceAudit = getDb().prepare("SELECT * FROM audit_logs WHERE action = 'user.balance' ORDER BY id DESC LIMIT 1").get();
  check('the audit line the wallet drawer writes is there too, with the delta and the admin who did it',
    Number(balanceAudit?.user_id) === Number(owner.id) && String(balanceAudit?.details || '').includes('200000'),
    `audit=${balanceAudit?.action}`);
  check('the reseller hears about it in his own chat, with the new balance, without asking',
    textOf(lastTo(SHOP_TG)).includes('موجودی شما افزایش یافت')
      && textOf(lastTo(SHOP_TG)).includes(fa(shopBefore + 200000))
      && lastTo(SHOP_TG).payload.reply_markup?.keyboard?.length === 3,
    `len=${textOf(lastTo(SHOP_TG)).length}`);
  const twiceUp = await bot.handleUpdate(taps(ADMIN_TG, ADMIN_CHAT, `bal:do:${shop.id}:+:200000`, upMsgId));
  check('a second tap on the same ✅ — even on the old message — credits nothing',
    twiceUp.ok === false && twiceUp.reason === 'stale_confirmation'
      && balanceOf(shop.id) === shopBefore + 200000 && txCount(shop.id) === shopTxBefore + 1,
    `reason=${twiceUp.reason}`);

  // ---- the deduction
  await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, bot.BTN_A_MONEY));
  await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, SHOP_TG));
  const minusDirId = messageSeq;
  await bot.handleUpdate(taps(ADMIN_TG, ADMIN_CHAT, `bal:set:${shop.id}:-`, minusDirId));
  const shopMid = balanceOf(shop.id);
  const confirmDown = await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, '100000'));
  const minusMsgId = messageSeq;
  check('«➖ کاهش موجودی» is the other sign of the same conversation: −100000, never +100000',
    confirmDown.sign === '-' && bot.stepOf(ADMIN_CHAT)?.sign === '-' && confirmDown.step === 'adm_confirm'
      && textOf(lastTo(ADMIN_CHAT)).includes('کاهش')
      && textOf(lastTo(ADMIN_CHAT)).includes(fa(shopMid - 100000))
      && (lastTo(ADMIN_CHAT).payload.reply_markup?.inline_keyboard || [[]])[0][0].callback_data
        === `bal:do:${shop.id}:-:100000`,
    `sign=${bot.stepOf(ADMIN_CHAT)?.sign}`);
  const overDraft = await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, String(shopMid + 1)));
  check('an amount larger than the wallet is refused at the confirm step and the screen stays put',
    overDraft.ok === false && overDraft.reason === 'insufficient_balance'
      && balanceOf(shop.id) === shopMid && bot.stepOf(ADMIN_CHAT)?.step === 'adm_confirm',
    `reason=${overDraft.reason}`);
  const forgedDown = await bot.handleUpdate(taps(ADMIN_TG, ADMIN_CHAT, `bal:do:${shop.id}:-:${shopMid + 5000}`, minusMsgId));
  check('a forged deeper deduction is refused too: the button must match the number on the screen',
    forgedDown.ok === false && forgedDown.reason === 'stale_confirmation' && balanceOf(shop.id) === shopMid,
    `reason=${forgedDown.reason}`);
  const txBeforeDeduct = txCount(shop.id);
  const deducted = await bot.handleUpdate(taps(ADMIN_TG, ADMIN_CHAT, `bal:do:${shop.id}:-:100000`, minusMsgId));
  check('the real deduction takes 100000 out, records a debit and writes its receipt in place of the button',
    deducted.ok === true && deducted.action === 'deducted' && balanceOf(shop.id) === shopMid - 100000
      && txCount(shop.id) === txBeforeDeduct + 1 && Number(deducted.balance) === shopMid - 100000,
    `action=${deducted.action} balance=${balanceOf(shop.id)}`);
  const debitTx = getDb().prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(shop.id);
  const deductEdit = lastOf('editMessageText');
  check('the wallet is never allowed to go negative, and the reseller is told what was taken',
    debitTx.type === 'debit' && Number(debitTx.amount) === 100000 && balanceOf(shop.id) >= 0
      && String(deductEdit?.payload?.text || '').includes('موجودی کاهش یافت')
      && textOf(lastTo(SHOP_TG)).includes('موجودی شما کاهش یافت'),
    `type=${debitTx.type} balance=${balanceOf(shop.id)}`);

  // ---- leaving the conversation, and the people who may not enter it
  await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, bot.BTN_A_MONEY));
  await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, OTHER_TG));
  const otherBefore = balanceOf(other.id);
  const cancelledMoney = await bot.handleUpdate(taps(ADMIN_TG, ADMIN_CHAT, 'bal:cancel', messageSeq));
  check('«❌ لغو» closes the move with nothing written and the admin menu back on screen',
    cancelledMoney.ok === true && cancelledMoney.action === 'money_cancel' && bot.stepOf(ADMIN_CHAT) === null
      && balanceOf(other.id) === otherBefore && txCount(other.id) === 0
      && textOf(lastTo(ADMIN_CHAT)).includes('لغو شد')
      && lastTo(ADMIN_CHAT).payload.reply_markup?.keyboard?.length === 2,
    `action=${cancelledMoney.action}`);
  const strangerBal = await bot.handleUpdate(taps(STRANGER_TG, STRANGER_TG, `bal:do:${shop.id}:+:1000`, 1));
  const resellerBal = await bot.handleUpdate(taps(SHOP_TG, SHOP_TG, `bal:do:${shop.id}:+:1000`, 1));
  check('neither a stranger nor a reseller may tap a wallet payload, and both are told so out loud',
    strangerBal.reason === 'not_admin' && resellerBal.reason === 'not_admin'
      && balanceOf(shop.id) === shopMid - 100000
      && calls.filter((one) => one.method === 'answerCallbackQuery' && one.payload.show_alert === true).length >= 2,
    `stranger=${strangerBal.reason} reseller=${resellerBal.reason}`);
  const adminResellerCmd = await bot.handleUpdate(says(ADMIN_TG, ADMIN_CHAT, '/topup'));
  check('a reseller command in the admin chat sends him to his own menu instead of opening a receipt',
    adminResellerCmd.action === 'admin_reseller_command' && topups.pendingCount(owner.id) === 0
      && textOf(lastTo(ADMIN_CHAT)).includes('شما مدیر پنل هستید'),
    `action=${adminResellerCmd.action}`);
  check('resellerByIdentity accepts only a live reseller, by id or by name, with or without the @',
    bot.resellerByIdentity(SHOP_TG)?.username === 'botshop'
      && bot.resellerByIdentity('BotShop')?.id === shop.id && bot.resellerByIdentity('@botshop')?.id === shop.id
      && bot.resellerByIdentity(ADMIN_TG) === null && bot.resellerByIdentity('botparked') === null
      && bot.resellerByIdentity('nope') === null && bot.resellerByIdentity('') === null
      && bot.resellerByIdentity('12') === null,
    'seven shapes');
  check('the direction of a move is read from the text, not from Number(): «-», «-1» and −500 all mean minus',
    bot.isMinus('-') === true && bot.isMinus(-1) === true && bot.isMinus(-500) === true
      && bot.isMinus('−۱۰۰') === false && bot.isMinus('+') === false && bot.isMinus('1') === false
      && bot.isMinus(null) === false && bot.isMinus(undefined) === false,
    'the sign that decides whether money is added or taken');

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
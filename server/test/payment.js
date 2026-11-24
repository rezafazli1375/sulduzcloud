'use strict';

/**
 * v1.5.4 built the money-in paths; v1.5.5 cut two of them and moved the card
 * numbers into the one method that kept them. This suite covers both, because the
 * rows a live panel already has were written by 1.5.4.
 *
 * The owner's sentences behind this file (verbatim):
 *   «درگاه پرداخت زرین پال هم اضافه کن به پنل و پرداخت با لینک آماده بلو بانک رو
 *     و همچنین قابلیت تعریف چند شماره کارت برای فیش واریزی و کارت به کارت»
 *   «قابلیت زمان بندی تایید خودکار برای فیش های واریزی و کارت به کارت»
 *   «اسم پنل ثابت و غیر قابل تغییر باشد»
 *   «قابلیت پورسانت باشه — درصدی از خرید یک نماینده به نماینده دیگه برسه»
 *   — then, on 1.5.5:
 *   «درگاه پرداخت بلوبانک و کارت به کارت حذف کن و همچنین دکمه روشن و خاموش کردن
 *     درگاه هارو هم بزار»
 *   «برای ثبت فیش واریزی مشتری از طریق ربات برای نماینده شماره کارت نشون نمیده
 *     که بدونه کدوم شماره کارت باید مبلغ واریز کنه»
 *
 * Like bot-test, this suite runs IN PROCESS against a throwaway DATA_DIR: no
 * server is spawned and nothing is allowed to open a socket. `global.fetch` is a
 * scripted fake of ZarinPal's v4 API, and it REFUSES any host that is not one of
 * the two ZarinPal hosts, counting the attempt — so a green run here is also
 * proof that the gateway code, the settings layer and the money paths never
 * reached a bank, Telegram or the live panel while they were tested.
 *
 * What it deliberately does NOT cover: the HTTP routes (selftest.js drives those
 * through a spawned server with the fake x-ui), the Telegram bot's buttons
 * (bot-test), and the nightly report (report-test). Here the subject is the
 * decision rule itself — one credit per payment, the ceiling of the sweep, the
 * pinned brand name, the commission percentage.
 *
 *   npm run payment-test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-payment-'));
process.env.DATA_DIR = DATA_DIR;
process.env.BACKUP_DIR = path.join(DATA_DIR, 'backups');
process.env.NODE_ENV = 'test';
process.env.PANEL_TZ = 'Asia/Tehran';

let pass = 0;
let fail = 0;
function check(name, ok, note = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}${note ? `  — ${note}` : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${note ? `  — ${note}` : ''}`); }
}

// ─────────────────────────────────────────────────────────────────────────────
// The scripted ZarinPal. Any other host is a bug, not a test fixture.
// ─────────────────────────────────────────────────────────────────────────────
const ZP_LIVE = 'https://payment.zarinpal.com';
const ZP_SANDBOX = 'https://sandbox.zarinpal.com';
const gateway = { calls: [], reply: null, status: 200, broken: false };
let strayAttempts = 0;

global.fetch = async (url, opts = {}) => {
  const target = String(url);
  if (!(target.startsWith(ZP_LIVE) || target.startsWith(ZP_SANDBOX))) {
    strayAttempts += 1;
    throw new Error(`payment test refused a network call to ${target.slice(0, 90)}`);
  }
  let body = null;
  try { body = JSON.parse(opts.body || 'null'); } catch (_) { body = null; }
  gateway.calls.push({ url: target, body, headers: opts.headers || {}, signal: opts.signal });
  if (gateway.broken) {
    return {
      ok: gateway.status >= 200 && gateway.status < 300,
      status: gateway.status,
      json: async () => { throw new Error('body was not JSON'); },
    };
  }
  return {
    ok: gateway.status >= 200 && gateway.status < 300,
    status: gateway.status,
    json: async () => gateway.reply,
  };
};

function resetGateway(next = {}) {
  gateway.calls.length = 0;
  gateway.reply = null;
  gateway.status = 200;
  gateway.broken = false;
  Object.assign(gateway, next);
}

const { getDb, closeDb } = require('../src/db');
const config = require('../src/config');
const settings = require('../src/settings');
const brand = require('../src/brand');
const usersService = require('../src/services/users');
const configsService = require('../src/services/configs');
const payment = require('../src/services/payment');
const topups = require('../src/services/topups');
const notify = require('../src/notify');

const MERCHANT = 'c8e8f1a2-1111-4abc-9def-0123456789ab';
const CARD_A = '6037991122334455';
const CARD_B = '6219861034567890';
const CARD_C = '5057851234567891';
const PANEL_URL = 'https://panel.example.test';
// What the panel was actually started with: in a test run PUBLIC_URL is unset,
// which is exactly the state the "no address to send the payer back to" guard is
// written for. The suite only fakes a public address further down, and only to
// test the calls that need one.
const NO_URL = String(process.env.PUBLIC_URL || config.publicUrl || '');

const db = () => getDb();
const rawSetting = (key) => String(db().prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '');
const balanceOf = (id) => Number(db().prepare('SELECT balance FROM users WHERE id = ?').get(Number(id))?.balance || 0);
const userRow = (id) => db().prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
const txRows = (id) => db().prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id').all(Number(id));
const notes = (id) => txRows(id).map((row) => String(row.description || ''));
const notices = (id) => db().prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id').all(Number(id));
const auditRows = (action) => db().prepare("SELECT * FROM audit_logs WHERE action = ? ORDER BY id").all(String(action));

function makeUser(username, extra = {}) {
  const created = usersService.createUser({
    username, password: 'Pay-Suite-12345', role: 'reseller', ...extra,
  });
  return userRow(created.id);
}
const setPay = (patch) => settings.setSetting('payment', patch);
const pay = () => payment.paymentSettings();

function codeOf(fn) {
  try { fn(); return null; } catch (err) { return err?.code || 'no_code'; }
}
async function codeOfAsync(fn) {
  try { await fn(); return null; } catch (err) { return err?.code || 'no_code'; }
}

// A row aged to `minutes` ago, because the sweep decides on AGE and the suite
// cannot wait fifteen minutes for one check.
function age(id, minutes) {
  const when = Date.now() - minutes * 60000;
  db().prepare('UPDATE topup_requests SET created_at = ?, updated_at = ? WHERE id = ?').run(when, when, Number(id));
  return when;
}

async function main() {
  const owner = makeUser('payowner', { role: 'admin', balance: 0 });
  const actor = { user: { id: owner.id, role: 'admin' } };

  // ═══════════════════════════════ 1. the block as shipped ═══════════════════
  console.log('\n── v1.5.5 payment defaults ──');
  const fresh = payment.methods();
  // v1.5.5, item 1: the owner looked at the three ways 1.5.4 offered and asked for
  // two of them to go — «درگاه پرداخت بلوبانک و کارت به کارت حذف کن». The shape
  // this call returns is what the wallet page renders, so the retired entries must
  // be ABSENT, not switched off: a key that is merely false still invites someone
  // to render a button for it later.
  check('a fresh panel offers a receipt and a gateway, and nothing else',
    fresh.cards.length === 0 && fresh.zarinpal.enabled === false
      && fresh.receipt.enabled === true && fresh.receipt.ready === false,
    `cards=${fresh.cards.length} zp=${fresh.zarinpal.enabled} receipt=${fresh.receipt.enabled}`);
  check('the بلو link and کارت به کارت are gone from the method list, not merely off',
    !('blue' in fresh) && !('cardToCard' in fresh) && !('card' in fresh)
      && Object.keys(fresh).sort().join(',') === 'cards,currency,receipt,zarinpal',
    Object.keys(fresh).sort().join(','));
  check('a receipt with no card number behind it says why it is not ready',
    fresh.receipt.reason === 'no_cards' && fresh.receipt.hasCards === false,
    `reason=${fresh.receipt.reason}`);
  check('and says WHY the gateway is missing instead of showing a dead button',
    fresh.zarinpal.reason === 'not_configured' && fresh.zarinpal.ready === false,
    `reason=${fresh.zarinpal.reason}`);
  check('the currency the reseller is quoted in is the owner’s billing currency',
    typeof fresh.currency === 'string' && fresh.currency.length > 0, fresh.currency);
  const sweepOff = payment.autoApprove();
  check('auto-approval ships switched off and with no money ceiling',
    sweepOff.enabled === false && sweepOff.maxAmount === 0 && sweepOff.dailyLimit === 0
      && sweepOff.afterMinutes === 15 && sweepOff.intervalMinutes === 1,
    `enabled=${sweepOff.enabled} max=${sweepOff.maxAmount}`);
  check('the sweep is pointed at the receipt alone — the gateway proves itself',
    sweepOff.methods.receipt === true && sweepOff.methods.zarinpal === false
      && Object.keys(sweepOff.methods).length === 2,
    JSON.stringify(sweepOff.methods));

  // ════════════════════════════ 2. credentials at rest ═══════════════════════
  console.log('\n── the owner’s bank credentials ──');
  setPay({ zarinpalMerchantId: MERCHANT });
  const rawPayment = rawSetting('payment');
  check('the merchant id is not written in the clear',
    !rawPayment.includes(MERCHANT) && rawPayment.length > 20,
    `rawLen=${rawPayment.length}`);
  check('yet the panel reads it back whole, because it is encrypted and not hashed',
    pay().zarinpalMerchantId === MERCHANT && pay().zarinpalEnabled === false,
    `merchantLen=${String(pay().zarinpalMerchantId || '').length}`);
  const redacted = settings.redactSection('payment', pay());
  check('the admin form is handed a mask, never the secret itself',
    redacted.zarinpalMerchantId === '' && redacted.hasZarinpalMerchantId === true,
    `hasMerchant=${redacted.hasZarinpalMerchantId}`);
  check('saving the form again without retyping the merchant id keeps it',
    (() => {
      settings.updateSection('payment', { zarinpalEnabled: true, zarinpalSandbox: false, zarinpalMerchantId: '' });
      return pay().zarinpalMerchantId === MERCHANT;
    })(),
    `kept=${pay().zarinpalMerchantId === MERCHANT} enabled=${pay().zarinpalEnabled}`);
  check('a genuine replacement does overwrite the old one',
    (() => {
      setPay({ zarinpalMerchantId: 'aaaaaaaa-2222-4333-8444-555566667777' });
      const replaced = pay().zarinpalMerchantId;
      setPay({ zarinpalMerchantId: MERCHANT });
      return replaced === 'aaaaaaaa-2222-4333-8444-555566667777' && pay().zarinpalMerchantId === MERCHANT;
    })());
  // v1.5.5, item 1: the four keys 1.5.4 wrote are retired. An install that upgrades
  // in place still has them in its `payment` row — including a بلو link that is now
  // an encrypted string nobody can reach — so the read must hide them and the boot
  // migration must delete them, the way the removed SMS patterns were handled.
  const RETIRED = ['blueEnabled', 'blueLink', 'blueLabel', 'autoApproveCard'];
  db().prepare("UPDATE settings SET value = ? WHERE key = 'payment'").run(JSON.stringify({
    cards: [{ number: CARD_A, holder: 'قدیمی' }],
    receiptEnabled: true, zarinpalEnabled: false, zarinpalMerchantId: '', zarinpalSandbox: false,
    autoApproveEnabled: false, autoApproveReceipt: true, autoApproveAfterMinutes: 15,
    autoApproveMaxAmount: 0, autoApproveDailyLimit: 0, autoApproveIntervalMinutes: 1,
    blueEnabled: true, blueLink: 'enc1:AGhvc3Qtbm8tbG9uZ2VyLXVzZWQ', blueLabel: 'بلو — فروشگاه', autoApproveCard: true,
  }));
  check('a payment row written by 1.5.4 answers without the retired keys',
    RETIRED.every((field) => !(field in pay())),
    RETIRED.filter((field) => field in pay()).join(',') || 'none');
  check('its card list survives the upgrade — the owner keeps what he typed',
    pay().cards.length === 1 && pay().cards[0].number === CARD_A,
    `cards=${pay().cards.length}`);
  check('the boot migration reports the row as needing work, then reports it clean',
    (() => {
      const first = settings.migratePaymentShape();
      const stored = rawSetting('payment');
      const second = settings.migratePaymentShape();
      return first === true && second === false && RETIRED.every((field) => !stored.includes(field));
    })(),
    `retired=${RETIRED.filter((field) => rawSetting('payment').includes(field)).join(',') || 'none'}`);
  check('and no write path puts a retired key back',
    (() => {
      setPay(Object.fromEntries(RETIRED.map((field) => [field, 'x'])));
      const stored = rawSetting('payment');
      return settings.updateSection('payment', { receiptEnabled: true }).blueEnabled === undefined
        && !RETIRED.some((field) => field in pay())
        && !stored.includes('blueLink');
    })(),
    RETIRED.filter((field) => field in pay()).join(',') || 'none');
  // The checks above rewrote the whole row; put the gateway back the way the rest
  // of the suite (and ZarinPal's own section) expects to find it.
  setPay({ zarinpalMerchantId: MERCHANT, zarinpalEnabled: true });

  // ═══════════════════════════ 3. several card numbers ═══════════════════════
  console.log('\n── تعریف چند شماره کارت ──');
  const messy = settings.updateSection('payment', {
    cards: [
      { number: '6037-9911 2233 4455', holder: 'فروشگاه', bank: 'ملل' },
      { number: 'not-a-card-1234', holder: 'bad', bank: '' },
      { number: CARD_A, holder: 'duplicate', bank: '' },
      { number: CARD_B.replace(/(\d{4})(\d{4})(\d{4})(\d{4})/, '$1-$2-$3-$4'), holder: 'دوم', bank: 'بلو' },
      { number: CARD_C, holder: '', bank: '' },
      'a bare string',
      null,
    ],
  });
  check('several cards are accepted, in the order they were entered',
    messy.cards.length === 3 && messy.cards[0].number === CARD_A && messy.cards[2].number === CARD_C,
    `count=${messy.cards.length}`);
  check('spaces and dashes are stripped and a number with letters is refused',
    messy.cards.every((card) => /^\d{16}$/.test(card.number))
      && !JSON.stringify(messy.cards).includes('not-a-card'),
    messy.cards.map((card) => card.number).join(','));
  check('the same card typed twice is stored once',
    new Set(messy.cards.map((card) => card.number)).size === messy.cards.length);
  // v1.5.5, item 2: since v1.5.4 the card list answers one question only — «کدام
  // کارت؟» — and it is what the bot reads out to a reseller before he pays. A
  // receipt method is ready the moment the owner has a number for him to use.
  check('the receipt becomes ready the moment one card exists, and shows all of them',
    payment.methods().receipt.ready === true && payment.methods().receipt.hasCards === true
      && payment.methods().receipt.reason === '' && payment.methods().cards.length === 3,
    `ready=${payment.methods().receipt.ready} cards=${payment.methods().cards.length}`);
  const many = settings.updateSection('payment', {
    cards: Array.from({ length: 15 }, (_unused, index) => ({ number: `61000000000000${String(index).padStart(2, '0')}` })),
  });
  check('the list is capped, so one reseller screen cannot grow forever',
    many.cards.length === settings.MAX_CARDS, `${many.cards.length}/${settings.MAX_CARDS}`);
  setPay({ cards: [{ number: CARD_A, holder: 'اول' }, { number: CARD_B, holder: 'دوم' }] });

  // ═══════════ 4. the two retired methods refuse, in both directions ═════════
  console.log('\n── روش‌های حذف‌شده: بلو و کارت به کارت ──');
  const shop0 = makeUser('payearly', { balance: 0 });
  const messageOf = (fn) => {
    try { fn(); return ''; } catch (err) { return String(err?.message || ''); }
  };
  check('the payment service exports no بلو helper at all',
    payment.blue === undefined && payment.blueLinkFor === undefined,
    `blue=${typeof payment.blue} blueLinkFor=${typeof payment.blueLinkFor}`);
  check('a کارت به کارت request is refused with a message that names the two ways left',
    (() => {
      const code = codeOf(() => topups.createRequest({ userId: shop0.id, amount: 5000, method: 'card' }));
      const text = messageOf(() => topups.createRequest({ userId: shop0.id, amount: 5000, method: 'card' }));
      return code === 'method_removed' && text.includes('حذف شده')
        && text.includes('فیش واریزی') && text.includes('درگاه');
    })(),
    String(codeOf(() => topups.createRequest({ userId: shop0.id, amount: 5000, method: 'card' }))));
  check('and so is a بلو one, whether or not an old row still carries its link',
    codeOf(() => topups.createRequest({ userId: shop0.id, amount: 30000, method: 'blue' })) === 'method_removed');
  check('a method that never existed is still refused as unknown, not as removed',
    codeOf(() => topups.createRequest({ userId: shop0.id, amount: 5000, method: 'paypal' })) === 'invalid_method');
  check('neither retired method leaves a row behind',
    Number(db().prepare("SELECT COUNT(*) AS c FROM topup_requests WHERE method IN ('card','blue')").get().c) === 0);
  check('the receipt has its own switch, and with it off no receipt is accepted',
    (() => {
      setPay({ receiptEnabled: false });
      const offCode = codeOf(() => topups.createRequest({ userId: shop0.id, amount: 5000, method: 'receipt' }));
      setPay({ receiptEnabled: true });
      const onCode = codeOf(() => topups.createRequest({ userId: shop0.id, amount: 5000, method: 'receipt' }));
      return offCode === 'receipt_disabled' && onCode === null;
    })(),
    `on=${codeOf(() => topups.createRequest({ userId: shop0.id, amount: 5001, method: 'receipt' }))}`);
  check('the gateway has its own switch too, and off means off on the reseller’s screen',
    (() => {
      setPay({ zarinpalEnabled: false });
      const built = payment.methods().zarinpal;
      setPay({ zarinpalEnabled: true });
      return built.enabled === false && built.ready === false && built.reason === 'not_configured'
        && payment.methods().zarinpal.enabled === true;
    })(),
    `enabled=${payment.methods().zarinpal.enabled} reason=${payment.methods().zarinpal.reason}`);

  // ═══════════════════════════ 5. ZarinPal, step by step ════════════════════
  console.log('\n── درگاه زرین‌پال ──');
  resetGateway();
  config.publicUrl = '';
  const noUrlCode = await codeOfAsync(() => payment.zarinpalRequest({ amount: 5000 }));
  const notReady = payment.methods();
  check('a merchant id with no public address is refused before any call is made',
    noUrlCode === 'no_public_url' && gateway.calls.length === 0,
    `PUBLIC_URL at start: ${NO_URL ? NO_URL : '(empty)'}`);
  check('and the reseller is told the gateway is not ready for that same reason',
    notReady.zarinpal.ready === false && notReady.zarinpal.reason === 'no_public_url',
    notReady.zarinpal.reason);
  // The rest of this section needs an address ZarinPal can send a man back to.
  config.publicUrl = `${PANEL_URL}/`;

  check('below 100 تومان the panel refuses instead of building a doomed order',
    (await codeOfAsync(() => payment.zarinpalRequest({ amount: 99 }))) === 'amount_too_small'
      && gateway.calls.length === 0);
  resetGateway({ reply: { code: 100, data: { authority: 'AUTH-1' } } });
  const req50000 = await payment.zarinpalRequest({
    amount: 50000,
    description: `شارژ کیف پول نماینده ${'x'.repeat(140)}`,
    mobile: '09120000000',
    email: 'payer@example.test',
    orderId: 42,
  });
  const sentBody = gateway.calls[0]?.body || {};
  check('step 1 posts to the LIVE host the version of the API it claims',
    gateway.calls.length === 1 && gateway.calls[0].url === `${ZP_LIVE}/pg/v4/payment/request.json`,
    gateway.calls[0]?.url);
  check('the amount at the gateway is the rial figure, ten times the تومان on screen',
    sentBody.amount === 500000 && req50000.rial === 500000,
    `gateway=${sentBody.amount} panel=${req50000.rial}`);
  check('the callback the bank is sent back to is this panel’s own address',
    sentBody.callback_url === `${PANEL_URL}/api/payments/zarinpal/callback`,
    sentBody.callback_url);
  check('the merchant id is sent, the description is cut to the gateway’s 100 characters',
    sentBody.merchant_id === MERCHANT && String(sentBody.description).length === 100,
    `descLen=${String(sentBody.description).length}`);
  check('the order id, the payer’s phone and his e-mail travel as metadata',
    sentBody.metadata.order_id === 42 && sentBody.metadata.mobile === '09120000000'
      && sentBody.metadata.email === 'payer@example.test',
    JSON.stringify(sentBody.metadata));
  check('the reseller gets an authority and a payment page built from it',
    req50000.authority === 'AUTH-1'
      && req50000.paymentUrl === `${ZP_LIVE}/pg/StartPay/AUTH-1`,
    req50000.paymentUrl);
  check('every gateway call carries a timeout so a stuck bank cannot hang the panel',
    Boolean(gateway.calls[0].signal));
  resetGateway({ reply: { code: 100, data: { authority: 'AUTH-SB' } } });
  setPay({ zarinpalSandbox: true });
  const sandboxReq = await payment.zarinpalRequest({ amount: 1000 });
  check('the sandbox switch moves both the API call and the payment page',
    sandboxReq.paymentUrl.startsWith(`${ZP_SANDBOX}/pg/StartPay/`)
      && gateway.calls[0].url.startsWith(ZP_SANDBOX),
    sandboxReq.paymentUrl);
  setPay({ zarinpalSandbox: false });
  resetGateway({ reply: { code: -1, message: 'INVALID_MERCHANT_ID', errors: null } });
  check('a gateway that answers without an authority becomes a clear error, not a blank page',
    (await codeOfAsync(() => payment.zarinpalRequest({ amount: 1000 }))) === 'zarinpal_request_failed',
    String((gateway.reply || {}).message));
  resetGateway({ status: 502, reply: null });
  check('an HTTP failure at the bank is reported as a gateway failure',
    (await codeOfAsync(() => payment.zarinpalRequest({ amount: 1000 }))) === 'gateway_http');
  resetGateway({ status: 200, broken: true, reply: null });
  check('a body that is not JSON is still "no authority" rather than a crash',
    (await codeOfAsync(() => payment.zarinpalRequest({ amount: 1000 }))) === 'zarinpal_request_failed');
  resetGateway({ reply: { code: 100, data: { authority: 'AUTH-V' } } });
  check('a verify with no authority is refused before it reaches the bank',
    (await codeOfAsync(() => payment.zarinpalVerify({ amount: 1000 }))) === 'authority_required'
      && gateway.calls.length === 0);
  resetGateway({ reply: { code: 100, data: { ref_id: 1234567890123, card_pan: '60379911223344XX', fee: 3000 } } });
  const proof = await payment.zarinpalVerify({ authority: 'AUTH-V', amount: 50000 });
  check('verify is the ONLY thing that can prove a payment, and it returns the bank’s receipt',
    proof.ok === true && proof.refId === '1234567890123' && proof.cardPan === '60379911223344XX'
      && proof.fee === 3000,
    `code=${proof.code} ref=${proof.refId}`);
  check('verify quotes the rial amount, the same figure the request was made for',
    gateway.calls[0].body.amount === 500000 && gateway.calls[0].body.authority === 'AUTH-V',
    `amount=${gateway.calls[0].body.amount}`);
  resetGateway({ reply: { code: 10, data: { ref_id: 0 }, message: 'VERIFIED_FAILED' } });
  check('a bank that says no, says no: ok=false and nothing was credited',
    (await payment.zarinpalVerify({ authority: 'AUTH-X', amount: 1000 })).ok === false);
  setPay({ zarinpalEnabled: false });
  const callsBeforeOff = gateway.calls.length;
  const offCode = await codeOfAsync(() => payment.zarinpalRequest({ amount: 1000 }));
  const offVerify = await codeOfAsync(() => payment.zarinpalVerify({ authority: 'AUTH-1', amount: 1000 }));
  setPay({ zarinpalEnabled: true });
  check('a gateway switched off cannot be talked to at all, in either direction',
    offCode === 'zarinpal_disabled' && offVerify === 'zarinpal_disabled'
      && gateway.calls.length === callsBeforeOff,
    `request=${offCode} verify=${offVerify}`);

  // ═══════════════ 6. one payment, one credit — whoever taps ═════════════════
  console.log('\n── یک پرداخت، یک شارژ ──');
  const shop = makeUser('payshop', { balance: 1000 });
  resetGateway({ reply: { code: 100, data: { authority: 'AUTH-42' } } });
  const order = topups.createRequest({ userId: shop.id, amount: 50000, method: 'zarinpal', source: 'panel', caption: 'پرداخت آنلاین زرین‌پال' });
  await payment.zarinpalRequest({ amount: 50000, orderId: order.id });
  topups.setReference(order.id, 'AUTH-42');
  check('the row exists BEFORE the gateway is asked, so the callback has something to come back to',
    topups.findByReference('AUTH-42')?.id === order.id && order.status === 'pending',
    `ref=${order.reference || topups.getRequest(order.id).reference}`);
  resetGateway({ reply: { code: 100, data: { ref_id: 9876543210 } } });
  const credited = topups.approve(order.id, { actor: null, source: 'gateway', reference: '9876543210' });
  check('the callback credits the wallet once, with the amount the panel wrote down',
    credited.status === 'approved' && credited.credited === 50000 && balanceOf(shop.id) === 51000,
    `balance=${balanceOf(shop.id)}`);
  check('both bank numbers are kept: the authority the order was made under, and the receipt',
    credited.reference === 'AUTH-42 / 9876543210',
    credited.reference);
  check('the ledger line names the gateway, so a book read months later explains itself',
    notes(shop.id).some((text) => text.includes('زرین‌پال') && text.includes('(درگاه)')),
    String(notes(shop.id).slice(-1)[0]).slice(0, 70));
  check('a settled order cannot be paid twice, not by a second callback',
    codeOf(() => topups.approve(order.id, { actor: null, source: 'gateway', reference: '111' })) === 'already_decided'
      && balanceOf(shop.id) === 51000 && txRows(shop.id).length === 1);
  check('a callback that arrives again finds either nothing or a closed row — never a pending one',
    (() => {
      const again = topups.findByReference('AUTH-42');
      return !again || again.status !== 'pending';
    })());
  check('the reseller is told in his own panel, and nobody posed as an admin to do it',
    notices(shop.id).some((row) => row.type === 'success' && String(row.link) === '/wallet')
      && credited.decidedBy === 0,
    `decidedBy=${credited.decidedBy}`);
  const gatewayAudit = auditRows('topup.approve').slice(-1)[0] || {};
  check('the audit trail records the gateway as the source of that credit',
    String(gatewayAudit.details || '').includes('"source":"gateway"'),
    String(gatewayAudit.details || '').slice(0, 90));

  // ═══════════════════ 7. the scheduled auto-approval sweep ═════════════════
  console.log('\n── زمان‌بندی تایید خودکار ──');
  const claimer = makeUser('payclaim', { balance: 0 });
  const before = topups.createRequest({ userId: claimer.id, amount: 4000, method: 'receipt', source: 'bot', caption: 'فیش' });
  setPay({ autoApproveEnabled: false });
  const off = topups.runAutoApprove();
  check('with the switch off the sweep touches nothing and says so',
    off.enabled === false && off.reason === 'disabled' && off.approved === 0,
    JSON.stringify(off));
  setPay({ autoApproveEnabled: true, autoApproveMaxAmount: 0 });
  check('the switch cannot be released with no money ceiling — the sweep reports it',
    topups.runAutoApprove().reason === 'no_ceiling' && payment.autoApprove().enabled === false);
  setPay({ autoApproveMaxAmount: 100000, autoApproveReceipt: false });
  check('a sweep with its one method unchecked releases nothing either',
    topups.runAutoApprove().reason === 'no_methods' && balanceOf(claimer.id) === 0);
  setPay({ autoApproveReceipt: true, autoApproveAfterMinutes: 15 });
  const tooYoung = topups.runAutoApprove();
  check('a receipt younger than the waiting period still waits for a person',
    tooYoung.checked === 0 && topups.getRequest(before.id).status === 'pending' && balanceOf(claimer.id) === 0,
    `checked=${tooYoung.checked}`);
  age(before.id, 16);
  const bigOne = topups.createRequest({ userId: claimer.id, amount: 500000, method: 'receipt' });
  age(bigOne.id, 20);
  // v1.5.5: an install that upgrades from 1.5.4 can still hold pending claims filed
  // under the two retired methods. They cannot be created any more, but the money
  // may genuinely have been sent, so the rows must survive untouched and — this is
  // the part that matters — the schedule must never decide them on its own.
  const legacy = makeUser('paylegacy', { balance: 0 });
  const legacyAt = (minutes) => Date.now() - minutes * 60000;
  const insertLegacy = (method, minutes, reference) => Number(db().prepare(
    `INSERT INTO topup_requests (user_id, amount, status, file_kind, file_id, caption, chat_id, message_id,
       admin_chat_id, admin_message_id, decided_by, decided_at, decision_note, source,
       method, reference, card_number, paid_at, created_at, updated_at)
     VALUES (?, 30000, 'pending', '', '', 'درخواست ۱٫۵٫۴', '', 0, '', 0, 0, 0, '', 'bot', ?, ?, '', 0, ?, ?)`
  ).run(legacy.id, method, reference, legacyAt(minutes), legacyAt(minutes)).lastInsertRowid);
  const legacyCard = insertLegacy('card', 30, 'TRK-9001');
  const legacyBlue = insertLegacy('blue', 60, 'BLU-7001');
  const swept = topups.runAutoApprove();
  check('an old receipt under the ceiling is released, and the reseller’s wallet moves once',
    swept.approved === 1 && swept.checked === 1 && balanceOf(claimer.id) === 4000,
    `approved=${swept.approved} checked=${swept.checked} balance=${balanceOf(claimer.id)}`);
  check('the sweep only ever considers the method that still exists',
    JSON.stringify(swept.methods) === '["receipt"]', String(swept.methods));
  // `?? -1`, not `|| -1`: the whole point of this check is that the number stored
  // is zero, and `0 || -1` is -1 — a helper that reads a legitimate 0 as a missing
  // row would fail exactly the case it is written to prove.
  const sweepAudit = auditRows('topup.approve').slice(-1)[0] || {};
  check('the sweep is credited to the system, never to an admin',
    topups.getRequest(before.id).decidedBy === 0
      && Number(sweepAudit.user_id ?? -1) === 0
      && String(sweepAudit.role || '') === 'system',
    `decidedBy=${topups.getRequest(before.id).decidedBy} audit.user_id=${sweepAudit.user_id} role=${sweepAudit.role}`);
  check('the ledger says plainly that nobody looked at it',
    notes(claimer.id).every((text) => text.includes('تایید خودکار')),
    String(notes(claimer.id).slice(-1)[0]).slice(0, 80));
  check('a receipt above the ceiling is left for a person no matter how old it is',
    topups.getRequest(bigOne.id).status === 'pending',
    topups.getRequest(bigOne.id).status);
  check('a leftover کارت به کارت claim is NEVER swept — the schedule does not know that method',
    topups.getRequest(legacyCard).status === 'pending'
      && !swept.results.some((row) => row.id === legacyCard)
      && balanceOf(legacy.id) === 0,
    `card=${topups.getRequest(legacyCard).status}`);
  check('and neither is a leftover بلو claim, even one older than the waiting period',
    topups.getRequest(legacyBlue).status === 'pending'
      && !swept.results.some((row) => row.id === legacyBlue),
    `blue=${topups.getRequest(legacyBlue).status}`);
  check('but a person can still settle the old claim, because the money may be real',
    (() => {
      const done = topups.approve(legacyCard, { actor: { id: owner.id, role: 'admin' }, source: 'admin' });
      return done.status === 'approved' && done.reference === 'TRK-9001'
        && balanceOf(legacy.id) === 30000 && done.method === 'card';
    })(),
    `balance=${balanceOf(legacy.id)}`);
  check('the admin is told what the schedule did, with the total it gave away',
    notices(owner.id).some((row) => row.type === 'info' && String(row.link) === '/topups'
      && String(row.body).includes('4,000')),
    String((notices(owner.id).slice(-1)[0] || {}).body || '').slice(0, 80));
  const daily = makeUser('paydaily', { balance: 0 });
  const d1 = topups.createRequest({ userId: daily.id, amount: 1000, method: 'receipt' });
  const d2 = topups.createRequest({ userId: daily.id, amount: 1000, method: 'receipt' });
  age(d1.id, 40); age(d2.id, 39);
  setPay({ autoApproveDailyLimit: 1 });
  const second = topups.runAutoApprove();
  check('a per-reseller daily count bounds how often the schedule hands out money',
    second.approved === 1 && balanceOf(daily.id) === 1000
      && topups.getRequest(d1.id).status === 'approved'
      && topups.getRequest(d2.id).status === 'pending'
      && second.results.some((row) => row.skipped === 'daily_limit'),
    `approved=${second.approved} balance=${balanceOf(daily.id)}`);
  setPay({ autoApproveEnabled: false, autoApproveDailyLimit: 0 });
  check('the waiting period and the interval are clamped, not trusted',
    (() => {
      setPay({ autoApproveAfterMinutes: 999999, autoApproveIntervalMinutes: 9999 });
      const cfg = payment.autoApprove();
      setPay({ autoApproveAfterMinutes: 15, autoApproveIntervalMinutes: 1 });
      return cfg.afterMinutes === 1440 && cfg.intervalMinutes === 60;
    })(),
    `after=${payment.autoApprove().afterMinutes} interval=${payment.autoApprove().intervalMinutes}`);

  // ════════════════════ 8. finding the rows back (filters) ══════════════════
  console.log('\n── فیلترهای دفتر فیش‌ها ──');
  // The retired methods cannot be paid into any more, but an admin who is looking
  // for a 1.5.4 claim still has to be able to FIND it — the filter list is wider
  // than the create list on purpose.
  const byCard = topups.listRequests({ method: 'card' });
  check('the admin can list one payment method apart from the others, retired ones too',
    byCard.rows.length === 1 && byCard.rows.every((row) => row.method === 'card'),
    `rows=${byCard.rows.length}`);
  const byBlue = topups.listRequests({ method: 'blue' });
  check('and a بلو row is still reachable, though no form can make a new one',
    byBlue.rows.length === 1 && byBlue.rows[0].status === 'pending'
      && codeOf(() => topups.createRequest({ userId: shop0.id, amount: 1000, method: 'blue' })) === 'method_removed',
    `rows=${byBlue.rows.length} status=${(byBlue.rows[0] || {}).status}`);
  const byAuto = topups.listRequests({ decision: 'auto' });
  const byManual = topups.listRequests({ decision: 'manual' });
  check('and one tab shows the rows the schedule decided, another the ones a person did',
    byAuto.rows.length === 2 && byAuto.rows.every((row) => row.autoApproved === true)
      && byManual.rows.every((row) => row.autoApproved === false),
    `auto=${byAuto.rows.length} manual=${byManual.rows.length}`);
  check('the counters follow the same filter, so a tab never lies about its own total',
    byCard.counts.pending + byCard.counts.approved + byCard.counts.rejected === byCard.total
      && byCard.total === byCard.rows.length,
    `total=${byCard.total} counts=${JSON.stringify(byCard.counts)}`);
  const labelSet = new Set([...topups.listRequests({ pageSize: 100 }).rows].map((row) => `${row.method}:${row.methodLabel}`));
  check('every row labels itself in Persian, the retired ones included',
    labelSet.has('receipt:فیش واریزی') && labelSet.has('card:کارت به کارت')
      && labelSet.has('zarinpal:زرین‌پال') && labelSet.has('blue:بلو بانک'),
    [...labelSet].join(' | '));
  check('an unknown method or decision is refused instead of silently listing everything',
    codeOf(() => topups.listRequests({ method: 'paypal' })) === 'invalid_method'
      && codeOf(() => topups.listRequests({ decision: 'maybe' })) === 'invalid_decision'
      && codeOf(() => topups.listRequests({ status: 'paid' })) === 'invalid_status');
  // v1.5.5, item 2: the card number a receipt names is now part of the receipt
  // itself (the bot offers the owner’s list before he pays), so the same guard
  // moves from the deleted کارت به کارت method onto فیش واریزی.
  check('a receipt naming a card the owner never typed is rejected at the door',
    codeOf(() => topups.createRequest({ userId: shop.id, amount: 5000, method: 'receipt', cardNumber: '1111111111111111' })) === 'unknown_card');
  check('the same card written with spaces or dashes is still recognised as his',
    (() => {
      const ok = topups.createRequest({ userId: shop.id, amount: 5000, method: 'receipt', cardNumber: '6037 9911-2233 4455' });
      return ok.cardNumber === CARD_A && ok.method === 'receipt';
    })());
  check('a gateway order is not held to the card list',
    !codeOf(() => topups.createRequest({ userId: shop.id, amount: 5000, method: 'zarinpal', cardNumber: '1111111111111111' })));
  check('a receipt may be filed with no card named at all — the list is a help, not a demand',
    (() => {
      const bare = topups.createRequest({ userId: shop0.id, amount: 6000, method: 'receipt' });
      return bare.cardNumber === '' && bare.status === 'pending';
    })());

  // ═════════════════════ 9. the brand that cannot be renamed ═════════════════
  console.log('\n── نام ثابت پنل ──');
  check('the panel name is a constant in code and the default agrees with it',
    settings.DEFAULTS.general.panelName === brand.PANEL_NAME && brand.PANEL_NAME === 'Sulduz Cloud',
    brand.PANEL_NAME);
  check('the settings form cannot rename the panel',
    settings.setSetting('general', { panelName: 'پنل دیگری' }).panelName === brand.PANEL_NAME);
  check('neither can a PATCH that claims to',
    settings.updateSection('general', { panelName: 'Another Brand' }).panelName === brand.PANEL_NAME,
    `locked=${settings.isLocked('general', 'panelName')}`);
  check('a database edited by hand is still overruled on read',
    (() => {
      db().prepare('UPDATE settings SET value = ? WHERE key = \'general\'')
        .run(JSON.stringify({ panelName: 'Hand Edited', tagline: 't', description: '', supportUrl: '', website: '', telegram: '', defaultLang: 'fa', timezone: 'Asia/Tehran' }));
      const storedSays = String(JSON.parse(rawSetting('general')).panelName || '');
      const answer = settings.getSetting('general').panelName;
      return storedSays === 'Hand Edited' && answer === brand.PANEL_NAME;
    })(),
    settings.getSetting('general').panelName);
  check('every consumer that asks gets the same name — settings, public meta, setup',
    settings.getSetting('general').panelName === brand.PANEL_NAME
      && settings.publicMeta().panelName === brand.PANEL_NAME
      && settings.redactSection('general', settings.getSetting('general')).panelName === brand.PANEL_NAME,
    settings.publicMeta().panelName);
  check('everything else in that section is still editable — only the name is pinned',
    settings.setSetting('general', { tagline: 'استقلال' }).tagline === 'استقلال'
      && settings.getSetting('general').panelName === brand.PANEL_NAME);
  check('this build is v2.4.0', config.version === '2.4.0', config.version);

  // ═══════════════════════════ 10. پورسانت maths ════════════════════════════
  console.log('\n── پورسانت معرفی ──');
  const referrer = makeUser('payparent', { balance: 0 });
  const buyer = makeUser('paychild', { balance: 1000000 });
  const noReferrer = configsService.commissionFor(userRow(buyer.id), 100000);
  check('a reseller nobody brought earns his referrer nothing', noReferrer === null);
  db().prepare('UPDATE users SET referrer_id = ?, commission_percent = 0 WHERE id = ?').run(referrer.id, buyer.id);
  settings.setSetting('billing', { enabled: true, commissionPercent: 5, commissionCapPercent: 50 });
  const fleetRate = configsService.commissionFor(userRow(buyer.id), 100000);
  check('the fleet percentage is what pays when the pair has no deal of their own',
    fleetRate?.commission === 5000 && fleetRate?.percent === 5 && fleetRate?.basis === 'fleet'
      && fleetRate?.referrerId === referrer.id,
    JSON.stringify(fleetRate));
  db().prepare('UPDATE users SET commission_percent = 12 WHERE id = ?').run(buyer.id);
  const ownRate = configsService.commissionFor(userRow(buyer.id), 100000);
  check('an agreed rate for this reseller wins over the fleet default',
    ownRate?.commission === 12000 && ownRate?.basis === 'own',
    `percent=${ownRate?.percent}`);
  settings.setSetting('billing', { commissionCapPercent: 8 });
  check('and the owner’s cap still bounds the agreed rate',
    configsService.commissionFor(userRow(buyer.id), 100000).percent === 8);
  // 90 as a cap and 60 as an agreed rate are numbers no settings form will store —
  // admin.js clamps both to 50 on the way in. Hand-editing the database is the only
  // way to get them there, and the payout code must not take that on faith: half
  // the price of a sale is the most a commission may ever be, to anybody.
  settings.setSetting('billing', { commissionCapPercent: 90 });
  db().prepare('UPDATE users SET commission_percent = 60 WHERE id = ?').run(buyer.id);
  const bothAbsurd = configsService.commissionFor(userRow(buyer.id), 100000);
  check('no cap, however typed, gets past half the price of a sale',
    bothAbsurd.cap === 50 && bothAbsurd.percent === 50 && bothAbsurd.commission === 50000,
    `cap=${bothAbsurd.cap} percent=${bothAbsurd.percent} commission=${bothAbsurd.commission}`);
  db().prepare('UPDATE users SET commission_percent = 0 WHERE id = ?').run(buyer.id);
  settings.setSetting('billing', { commissionPercent: 90, commissionCapPercent: 90 });
  check('the fleet default is bounded the same way, so one bad number cannot gut the book',
    configsService.commissionFor(userRow(buyer.id), 100000).percent === 50,
    `percent=${configsService.commissionFor(userRow(buyer.id), 100000).percent}`);
  settings.setSetting('billing', { commissionCapPercent: 50, commissionPercent: 0 });
  db().prepare('UPDATE users SET commission_percent = 0 WHERE id = ?').run(buyer.id);
  check('0٪ means off — nothing is computed, nothing is paid',
    configsService.commissionFor(userRow(buyer.id), 100000) === null);
  settings.setSetting('billing', { commissionPercent: 5 });
  check('a purchase of nothing pays nothing',
    configsService.commissionFor(userRow(buyer.id), 0) === null
      && configsService.commissionFor(userRow(buyer.id), -100) === null);
  db().prepare('UPDATE users SET referrer_id = ? WHERE id = ?').run(buyer.id, buyer.id);
  check('a reseller cannot refer himself into free money',
    configsService.commissionFor(userRow(buyer.id), 100000) === null);
  db().prepare('UPDATE users SET referrer_id = ? WHERE id = ?').run(referrer.id, buyer.id);
  db().prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(referrer.id);
  check('a referrer who was switched off simply stops earning; the sale still happens',
    configsService.commissionFor(userRow(buyer.id), 100000) === null);
  db().prepare("UPDATE users SET status = 'active' WHERE id = ?").run(referrer.id);
  check('the share is rounded to a whole unit of the currency, never a fraction',
    (() => {
      const odd = configsService.commissionFor(userRow(buyer.id), 33333);
      return Number.isInteger(odd.commission) && odd.commission === 1667;
    })(),
    String(configsService.commissionFor(userRow(buyer.id), 33333).commission));
  check('a commission is a credit, so crediting cannot loop: the payout has no referrer of its own',
    configsService.commissionFor(userRow(referrer.id), 5000) === null);

  // ═══════════════════ 11. the red counter on اعلان‌ها (item 5) ══════════════
  console.log('\n── شمارنده قرمز اعلان‌ها ──');
  const badgeUser = makeUser('paybadge', { balance: 0 });
  notify.notifyUser(badgeUser.id, { type: 'broadcast', title: 'تلفن پشتیبانی', body: 'یک', link: '/notifications' });
  notify.notifyUser(badgeUser.id, { type: 'broadcast', title: 'تلفن پشتیبانی', body: 'دو', link: '/notifications' });
  notify.notifyUser(badgeUser.id, { type: 'success', title: 'شارژ', body: 'سه', link: '/wallet' });
  const bell = notify.listNotifications(badgeUser.id, { pageSize: 8 });
  check('the bell counts every unread row, the badge only the owner’s messages',
    bell.unread === 3 && bell.unreadBroadcast === 2,
    `unread=${bell.unread} broadcast=${bell.unreadBroadcast}`);
  check('the badge number arrives with the same request the dropdown uses',
    Object.prototype.hasOwnProperty.call(bell, 'unreadBroadcast') && Array.isArray(bell.rows)
      && bell.rows.length === 3);
  const firstBroadcast = bell.rows.filter((row) => row.type === 'broadcast')[0];
  notify.markRead(badgeUser.id, firstBroadcast.id);
  check('opening one of the owner’s messages drops the red number by one',
    notify.listNotifications(badgeUser.id, {}).unreadBroadcast === 1);
  notify.markRead(badgeUser.id, 0);
  check('«علامت‌گذاری همه» clears it, and a wallet credit never put a number there',
    notify.listNotifications(badgeUser.id, {}).unreadBroadcast === 0
      && notify.unreadByType(badgeUser.id, 'success') === 0);

  // ═══════════════════════════════ 12. no network ═══════════════════════════
  check('nothing in this suite reached any host but ZarinPal',
    strayAttempts === 0, `stray=${strayAttempts} zp=${gateway.calls.length}`);

  console.log(`\npayment suite: ${pass} passed, ${fail} failed  (data dir ${DATA_DIR})`);
  closeDb();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error('payment suite crashed:', err && err.stack ? err.stack : err);
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});

'use strict';

/**
 * Payment methods (v1.5.5).
 *
 * Two ways for a reseller to put money in, each with its own switch, because the
 * owner looked at the three v1.5.4 offered him and asked for the بلو link and
 * card-to-card to go:
 *
 *   1. ZarinPal — a real gateway with a server-to-server API. The panel asks for
 *      an authority, sends the reseller to ZarinPal's own page, and ZarinPal sends
 *      him back. ONLY the verify call below proves the money arrived, and it is
 *      the only thing that may credit a wallet from this route. A reseller
 *      arriving at the callback with a hand-typed ?Status=OK has paid nothing;
 *      the verify for that authority simply fails and the row stays pending.
 *
 *   2. Deposit receipt (فیش واریزی) — he pays into one of the owner's own card
 *      numbers in `cards` and sends the receipt, from the panel or from the bot.
 *      `receiptEnabled` is his switch for it, and since v1.5.5 the bot reads those
 *      numbers out to him before he pays (services/bot.js startTopup), which is
 *      what he asked for: without them a reseller has no idea where to send money.
 *      Nothing can confirm the payment, so a receipt is a CLAIM and waits for the
 *      admin — or for the scheduled auto-approval, if he switched it on for it.
 *
 * Money itself is never moved here. Every credit goes through services/topups.js
 * approve(), which is the single place the wallet moves for an incoming payment
 * and the reason a gateway callback and an admin's button cannot both credit.
 */

const config = require('../config');
const { getSetting } = require('../settings');
const { ApiError } = require('../utils');

const ZARINPAL_BASE = 'https://payment.zarinpal.com/pg';
const ZARINPAL_SANDBOX = 'https://sandbox.zarinpal.com/pg';

// ZarinPal's v4 API takes amounts in RIALS. The panel's wallet is labelled in
// whatever the owner typed in billing.currency, and for him that is تومان, so a
// payment of 100 تومان is 1000 at the gateway. One constant, stated once: a
// reseller who pays the Toman figure would be charged a tenth of what the panel
// then credits him.
const RIALS_PER_TOMAN = 10;

function paymentSettings() {
  return getSetting('payment');
}

function cards() {
  return Array.isArray(paymentSettings().cards) ? paymentSettings().cards : [];
}

function zarinpal() {
  const cfg = paymentSettings();
  const merchantId = String(cfg.zarinpalMerchantId || '').trim();
  // Real and sandbox merchant ids are both UUIDs, so the host cannot be guessed
  // from the id — the owner says which account he pasted. A sandbox id against
  // the live host answers "merchant not found" and the money never moves, which
  // is the failure worth being explicit about in the settings form.
  const sandbox = Boolean(cfg.zarinpalSandbox);
  return {
    enabled: Boolean(cfg.zarinpalEnabled) && Boolean(merchantId),
    merchantId,
    sandbox,
    base: sandbox ? ZARINPAL_SANDBOX : ZARINPAL_BASE,
  };
}

/**
 * فیش واریزی as a method: switched on by the owner, and only worth offering once he
 * has actually typed a card number — a receipt with nowhere to pay is a dead button,
 * and this panel does not render those.
 */
function receipt() {
  const cfg = paymentSettings();
  const list = cards();
  return {
    enabled: Boolean(cfg.receiptEnabled),
    cards: list,
    ready: Boolean(cfg.receiptEnabled) && list.length > 0,
    reason: !cfg.receiptEnabled ? 'disabled' : list.length ? '' : 'no_cards',
  };
}

function publicBaseUrl() {
  return String(config.publicUrl || '').trim().replace(/\/+$/, '');
}

function tomanToRial(amount) {
  return Math.round(Math.max(0, Number(amount || 0)) * RIALS_PER_TOMAN);
}

/**
 * What the wallet page offers. The card list is the point of the call; the two
 * entries say honestly WHY they are missing when they are off, so the reseller is
 * never shown a button that cannot work.
 */
function methods() {
  const zp = zarinpal();
  const rp = receipt();
  const base = publicBaseUrl();
  return {
    cards: rp.cards,
    receipt: {
      enabled: rp.enabled,
      ready: rp.ready,
      hasCards: rp.cards.length > 0,
      reason: rp.reason,
    },
    zarinpal: {
      enabled: zp.enabled,
      // Off until the panel has an address ZarinPal can send a man back to:
      // without PUBLIC_URL the callback would point at 127.0.0.1 and every
      // paid order would die pending.
      ready: zp.enabled && Boolean(base),
      reason: !zp.enabled ? 'not_configured' : base ? '' : 'no_public_url',
    },
    currency: String(getSetting('billing').currency || 'تومان'),
  };
}

async function postJson(url, body, timeoutMs = 20000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  if (!res.ok) {
    throw new ApiError(502, 'gateway_http', `زرین‌پال HTTP ${res.status} / ZarinPal returned HTTP ${res.status}`);
  }
  return json || {};
}

/** Step 1: ask ZarinPal for an authority. Returns {authority, paymentUrl}. */
async function zarinpalRequest({ amount, description = '', mobile = '', email = '', orderId = 0 } = {}) {
  const zp = zarinpal();
  if (!zp.enabled) throw new ApiError(409, 'zarinpal_disabled', 'درگاه زرین‌پال فعال نیست / ZarinPal is not enabled');
  const base = publicBaseUrl();
  if (!base) {
    throw new ApiError(409, 'no_public_url',
      'پنل آدرس عمومی ندارد؛ PUBLIC_URL را در .env تنظیم کنید / The panel has no public address, so ZarinPal has nowhere to send the payer back to');
  }
  const rial = tomanToRial(amount);
  if (rial < 1000) {
    throw new ApiError(422, 'amount_too_small', 'حداقل مبلغ برای پرداخت آنلاین ۱۰۰ تومان است / The online minimum is 100');
  }
  const metadata = { order_id: Number(orderId) || 0 };
  if (mobile) metadata.mobile = String(mobile);
  if (email) metadata.email = String(email);
  const body = await postJson(`${zp.base}/v4/payment/request.json`, {
    merchant_id: zp.merchantId,
    amount: rial,
    description: String(description || 'شارژ کیف پول').slice(0, 100),
    callback_url: `${base}/api/payments/zarinpal/callback`,
    metadata,
  });
  const authority = String(body?.data?.authority || '').trim();
  if (!authority) {
    const message = String(body?.message || body?.errors || 'no authority').slice(0, 200);
    throw new ApiError(502, 'zarinpal_request_failed', `زرین‌پال: ${message}`);
  }
  return { authority, paymentUrl: `${zp.base}/StartPay/${encodeURIComponent(authority)}`, rial };
}

/**
 * Step 2, and the only proof. ZarinPal's verify is one-shot: a second call for the
 * same authority returns "already verified", which is why the caller must have
 * settled the row before it gets here (topups.approve's status lock is what makes
 * that true).
 */
async function zarinpalVerify({ authority, amount } = {}) {
  const zp = zarinpal();
  if (!zp.enabled) throw new ApiError(409, 'zarinpal_disabled', 'درگاه زرین‌پال فعال نیست / ZarinPal is not enabled');
  if (!String(authority || '').trim()) throw new ApiError(422, 'authority_required', 'authority is required');
  const body = await postJson(`${zp.base}/v4/payment/verify.json`, {
    merchant_id: zp.merchantId,
    authority: String(authority).trim(),
    amount: tomanToRial(amount),
  });
  const data = body?.data || {};
  return {
    ok: Number(body?.code) === 100 && Boolean(data.ref_id),
    code: Number(body?.code || 0),
    refId: String(data.ref_id || ''),
    cardPan: String(data.card_pan || ''),
    fee: Number(data.fee || 0),
    message: String(body?.message || ''),
  };
}

/**
 * The scheduled auto-approval: «زمان‌بندی تایید خودکار».
 *
 * It is deliberately narrow, because this is a switch that gives money away
 * without anybody looking:
 *   - off unless he turns it on;
 *   - a request must be at least `afterMinutes` old (that is the schedule) so a
 *     payment made five minutes before a sweep still waits for a person;
 *   - `maxAmount` is REQUIRED, not optional — enabling the switch with no ceiling
 *     is refused in the settings route, so no build of this panel can auto-credit
 *     an unbounded amount;
 *   - an optional daily ceiling per reseller bounds repeated claims;
 *   - receipts are what it sweeps. A gateway payment is not in this list at all:
 *     ZarinPal confirms itself, it does not need a sweep. Card-to-card had its own
 *     switch until v1.5.5 removed the method; a `card` row written by 1.5.4 keeps
 *     its history but is never swept, because it is no longer a method on the list.
 */
function autoApprove() {
  const cfg = paymentSettings();
  const maxAmount = Math.round(Number(cfg.autoApproveMaxAmount || 0));
  return {
    enabled: Boolean(cfg.autoApproveEnabled) && maxAmount > 0,
    // What the admin asked for, method by method.
    methods: {
      receipt: Boolean(cfg.autoApproveReceipt),
      zarinpal: false,
    },
    afterMinutes: Math.min(1440, Math.max(1, Number(cfg.autoApproveAfterMinutes) || 15)),
    maxAmount,
    dailyLimit: Math.max(0, Math.round(Number(cfg.autoApproveDailyLimit || 0))),
    intervalMinutes: Math.min(60, Math.max(1, Number(cfg.autoApproveIntervalMinutes) || 1)),
  };
}

module.exports = {
  ZARINPAL_BASE,
  ZARINPAL_SANDBOX,
  RIALS_PER_TOMAN,
  paymentSettings,
  cards,
  zarinpal,
  receipt,
  publicBaseUrl,
  tomanToRial,
  methods,
  zarinpalRequest,
  zarinpalVerify,
  autoApprove,
};

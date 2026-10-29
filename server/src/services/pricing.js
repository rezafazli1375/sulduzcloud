'use strict';

const { getDb } = require('../db');
const settings = require('../settings');
const usersService = require('./users');
const { ApiError } = require('../utils');
const { audit } = require('../audit');

// Discounts are stored per (reseller, inbound) as an integer percentage (0-100).
// A discount of 0 means "no discount" and rows are removed when reset to 0.

const MAX_PERCENT = 100;

function billingInfo() {
  const billing = settings.getSetting('billing');
  return { enabled: Boolean(billing.enabled), currency: String(billing.currency || '') };
}

function normalizePercent(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > MAX_PERCENT) {
    throw new ApiError(422, 'invalid_discount', `Discount must be between 0 and ${MAX_PERCENT}%`);
  }
  return n;
}

function getInboundRow(id) {
  return getDb().prepare('SELECT * FROM inbounds WHERE id = ?').get(Number(id));
}

function discountPercent(userId, inboundId) {
  if (!userId || !inboundId) return 0;
  const row = getDb()
    .prepare('SELECT percent FROM reseller_discounts WHERE user_id = ? AND inbound_id = ?')
    .get(Number(userId), Number(inboundId));
  return row ? Math.min(MAX_PERCENT, Math.max(0, Number(row.percent || 0))) : 0;
}

function discountsFor(userId) {
  if (!userId) return [];
  return getDb()
    .prepare('SELECT inbound_id, percent, updated_at FROM reseller_discounts WHERE user_id = ? AND percent > 0 ORDER BY inbound_id ASC')
    .all(Number(userId))
    .map((row) => ({
      inboundId: Number(row.inbound_id),
      percent: Number(row.percent || 0),
      updatedAt: Number(row.updated_at || 0),
    }));
}

function discountMap(userId) {
  const map = new Map();
  for (const row of discountsFor(userId)) map.set(row.inboundId, row.percent);
  return map;
}

function replaceDiscounts(userId, entries, req) {
  const user = usersService.getUser(userId);
  if (!user) throw new ApiError(404, 'user_not_found', 'Reseller not found');
  const db = getDb();
  const now = Date.now();
  const clean = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const inboundId = Number(entry?.inboundId ?? entry?.inbound_id);
    if (!Number.isFinite(inboundId)) continue;
    const percent = normalizePercent(entry?.percent);
    if (!getInboundRow(inboundId)) throw new ApiError(404, 'inbound_not_found', `Inbound ${inboundId} not found`);
    if (percent > 0) clean.set(inboundId, percent);
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM reseller_discounts WHERE user_id = ?').run(Number(userId));
    const insert = db.prepare(
      'INSERT INTO reseller_discounts (user_id, inbound_id, percent, updated_at) VALUES (?, ?, ?, ?)'
    );
    for (const [inboundId, percent] of clean.entries()) insert.run(Number(userId), inboundId, percent, now);
  });
  tx();
  audit(req, 'pricing.discounts', 'user', Number(userId), { discounts: [...clean.entries()] });
  return discountsFor(userId);
}

function basePrice(inbound, gb, days) {
  if (!inbound) return 0;
  const fixed = Number(inbound.price_fixed || 0);
  const perGb = Number(inbound.price_per_gb || 0);
  const perDay = Number(inbound.price_per_day || 0);
  return Math.max(0, Math.round(fixed + perGb * Number(gb || 0) + perDay * Number(days || 0)));
}

function applyPercent(amount, percent) {
  const p = Math.min(MAX_PERCENT, Math.max(0, Number(percent || 0)));
  return Math.max(0, Math.round(Number(amount || 0) * (1 - p / 100)));
}

function priceFor(inbound, gb, days, userId) {
  return applyPercent(basePrice(inbound, gb, days), discountPercent(userId, inbound?.id));
}

function describeInbound(inbound, gb, days, userId) {
  const base = basePrice(inbound, gb, days);
  const percent = discountPercent(userId, inbound?.id);
  const total = applyPercent(base, percent);
  return {
    inboundId: Number(inbound.id),
    remark: inbound.remark || `#${inbound.id}`,
    protocol: inbound.protocol || '',
    nodeName: inbound.node_name || '',
    priceFixed: Number(inbound.price_fixed || 0),
    pricePerGb: Number(inbound.price_per_gb || 0),
    pricePerDay: Number(inbound.price_per_day || 0),
    base,
    discountPercent: percent,
    discount: base - total,
    total,
  };
}

function quote({ userId = 0, inboundIds = [], gb = 0, days = 0, unlimited = false } = {}) {
  const amountGb = unlimited ? 0 : Math.max(0, Number(gb || 0));
  const amountDays = Math.max(0, Math.round(Number(days || 0)));
  const ids = (Array.isArray(inboundIds) ? inboundIds : [inboundIds])
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const user = userId ? usersService.getUser(userId) : null;
  const items = [];
  for (const id of ids) {
    const inbound = getInboundRow(id);
    if (!inbound) continue;
    items.push(describeInbound(inbound, amountGb, amountDays, user ? user.id : 0));
  }
  // A multi-inbound package is billed once, at the price of its most expensive
  // inbound (reseller discounts already applied) — never as a sum of tariffs.
  let basisIndex = -1;
  for (let i = 0; i < items.length; i += 1) {
    if (basisIndex === -1 || items[i].total > items[basisIndex].total) basisIndex = i;
  }
  items.forEach((item, index) => { item.basis = index === basisIndex; });
  const basis = basisIndex >= 0 ? items[basisIndex] : null;
  const subtotal = basis ? basis.base : 0;
  const discountTotal = basis ? basis.discount : 0;
  const total = basis ? basis.total : 0;
  const balance = user ? Number(user.balance || 0) : 0;
  const billing = billingInfo();
  return {
    billing,
    gb: amountGb,
    days: amountDays,
    unlimited: Boolean(unlimited),
    count: items.length,
    subtotal,
    discountTotal,
    total,
    basisInboundId: basis ? basis.inboundId : 0,
    currency: billing.currency,
    balance,
    sufficient: !billing.enabled || total <= 0 || balance >= total,
    items,
  };
}

module.exports = {
  MAX_PERCENT,
  billingInfo,
  discountPercent,
  discountsFor,
  discountMap,
  replaceDiscounts,
  basePrice,
  priceFor,
  quote,
};

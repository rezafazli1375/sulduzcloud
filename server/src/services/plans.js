'use strict';

/**
 * v1.5.4 — پلن‌های آماده (ready-made plans).
 *
 * A plan is a package the OWNER has priced himself: a fixed volume, a fixed
 * duration, the one or two channels he picked, and HIS price — not the
 * per-gigabyte tariff. A reseller can buy a plan twice over:
 *
 *   • to open a NEW customer   (applyNew)   — the same thing as building a
 *     package by hand, except the numbers and the price come from the plan;
 *   • to RENEW an existing one (applyRenew) — and a renewal with a plan means
 *     what the owner said it means: the customer's used traffic and expiry are
 *     reset and the plan is applied to him from scratch.
 *
 * The money rule, stated plainly because it is the whole point of this file:
 * the price is read from the `plans` row on the server, never from the request.
 * A reseller posting {"price": 1000} changes nothing — he has no way to name a
 * price at all, only to choose which plan he buys. This is the same discipline
 * as v1.4.25, where the reseller route stopped forwarding `charge`.
 *
 * The plan price replaces the tariff; it is not discounted again. Per-inbound
 * reseller discounts belong to the tariff model, and applying them on top of a
 * price the owner fixed by hand would take money off a number he chose himself.
 * The quote still shows what the tariff WOULD have cost so both sides can see
 * the difference.
 */

const { getDb } = require('../db');
const usersService = require('./users');
// v2.3.0 note: `./inbounds` is deliberately NOT required here any more. Deciding
// whether a reseller may take a plan used to ask the channel permission layer;
// a ready-made plan is the owner's product, so that question is no longer asked.
const pricing = require('./pricing');
const configsService = require('./configs');
const { ApiError, safeJsonParse, bytesToGb } = require('../utils');
const { audit } = require('../audit');

const MAX_NAME = 80;
const MAX_DESCRIPTION = 300;
const MAX_INBOUNDS = 6;
const MAX_GB = 1024;
const MAX_DAYS = 3650;
const MAX_PRICE = 100000000000;

// v1.5.8 — the owner's three shelves: پلن‌های تست / عمومی / اختصاصی. A test plan
// is usually free and limited to one take per reseller; a public plan is for
// everyone; an exclusive plan is activated for a NAMED list of resellers and is
// invisible to everybody else. The per-reseller take limit applies to all three.
const PLAN_CATEGORIES = ['test', 'public', 'exclusive'];
const MAX_PER_USER_LIMIT = 100000;
const MAX_ALLOWED_USERS = 500;

function planRow(id) {
  return getDb().prepare('SELECT * FROM plans WHERE id = ? AND deleted_at = 0').get(Number(id));
}

function inboundRow(id) {
  return getDb().prepare('SELECT * FROM inbounds WHERE id = ?').get(Number(id));
}

/** The JSON blob in `inbound_ids` is the only place a plan names its channels. */
function idsOf(row) {
  const raw = safeJsonParse(row?.inbound_ids, []);
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
}

/** v1.5.8: the JSON list of reseller ids an exclusive plan is activated for. */
function allowedUsersOf(row) {
  const raw = safeJsonParse(row?.allowed_users, []);
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
}

function categoryOf(row) {
  const value = String(row?.category || 'public');
  return PLAN_CATEGORIES.includes(value) ? value : 'public';
}

/**
 * Validate the activation list of an exclusive plan: every id must be a live
 * reseller, because a typo would silently lock the plan away from the person it
 * was meant for. Admins are refused — the owner buys nothing from his own shop.
 */
function cleanAllowedUsers(value) {
  const list = Array.isArray(value) ? value : [value];
  const ids = [...new Set(list.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (ids.length > MAX_ALLOWED_USERS) {
    throw new ApiError(422, 'too_many_resellers', `حداکثر ${MAX_ALLOWED_USERS} نماینده / At most ${MAX_ALLOWED_USERS} resellers`);
  }
  const db = getDb();
  const find = db.prepare('SELECT id, role FROM users WHERE id = ? AND deleted_at = 0');
  for (const id of ids) {
    const user = find.get(id);
    if (!user || String(user.role) !== 'reseller') {
      throw new ApiError(422, 'invalid_plan_reseller', `کاربر #${id} یک نمایندهٔ فعال نیست / User ${id} is not an active reseller`);
    }
  }
  return ids;
}

/** How many times this reseller has already taken this plan (new + renewal). */
function countTakes(planId, userId) {
  return Number(getDb()
    .prepare('SELECT COUNT(*) AS c FROM plan_purchases WHERE plan_id = ? AND user_id = ?')
    .get(Number(planId), Number(userId)).c || 0);
}

/** null = unlimited; otherwise how many more takes this reseller has left. */
function remainingFor(row, userId) {
  const limit = Math.max(0, Number(row?.per_user_limit || 0));
  if (!limit) return null;
  return Math.max(0, limit - countTakes(row.id, userId));
}

function recordTake(row, userId, configId, kind) {
  getDb().prepare(
    'INSERT INTO plan_purchases (plan_id, user_id, config_id, kind, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(Number(row.id), Number(userId), Number(configId || 0), String(kind), Date.now());
}

function cleanIds(value) {
  const list = Array.isArray(value) ? value : [value];
  const ids = [...new Set(list.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (ids.length > MAX_INBOUNDS) {
    throw new ApiError(422, 'too_many_inbounds', `یک پلن حداکثر ${MAX_INBOUNDS} اینباند می‌تواند داشته باشد / A plan can carry up to ${MAX_INBOUNDS} inbounds`);
  }
  return ids;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanText(value, max, field) {
  const text = String(value ?? '').trim();
  if (text.length > max) {
    throw new ApiError(422, `invalid_${field}`, `حداکثر ${max} نویسه / At most ${max} characters`);
  }
  return text;
}

/**
 * Validate the channels and the numbers of a plan.
 *
 * All of a plan's inbounds must live on one x-ui panel, because one package can
 * only be built on one server (createConfigs checks the same rule and refuses a
 * mixed order) — catching it here means the owner learns about it while writing
 * the plan instead of a reseller discovering it when he tries to buy it.
 */
function resolveInbounds(ids) {
  if (!ids.length) throw new ApiError(422, 'plan_needs_inbound', 'حداقل یک اینباند برای پلن انتخاب کنید / Pick at least one inbound for this plan');
  const rows = [];
  for (const id of ids) {
    const inbound = inboundRow(id);
    if (!inbound) throw new ApiError(422, 'inbound_not_found', `اینباند #${id} در پنل پیدا نشد / Inbound ${id} is not in the panel`);
    if (!Number(inbound.enabled)) {
      throw new ApiError(422, 'inbound_disabled', `اینباند «${inbound.remark}» غیرفعال است / The inbound «${inbound.remark}» is disabled`);
    }
    rows.push(inbound);
  }
  const serverId = Number(rows[0].server_id);
  if (rows.some((row) => Number(row.server_id) !== serverId)) {
    throw new ApiError(422, 'plan_server_mismatch', 'همه اینباندهای یک پلن باید روی یک سرور باشند / All inbounds of one plan must be on the same server');
  }
  return { rows, serverId };
}

/**
 * The channel list for a plan, from the request if it named one and from the
 * stored row if it did not.
 *
 * The second branch matters because the stored column is JSON *text*: handing
 * '[1,2]' to cleanIds would turn it into one NaN, the plan would look like it
 * had no channels at all, and a PATCH that only flips `visible` — the eye button
 * on the plans table — would be refused with plan_needs_inbounds. Parsing the
 * blob back with idsOf is what makes a partial update of a plan possible.
 */
function keepIds(data, existing) {
  if (data.inbound_ids !== undefined) return data.inbound_ids;
  if (data.inboundIds !== undefined) return data.inboundIds;
  return existing ? idsOf(existing) : [];
}

/**
 * Build the stored shape from a request body. `existing` lets PATCH stay
 * partial: a field that is absent keeps the value it had, so the admin can flip
 * `visible` without resending the whole plan.
 */
function toStored(data = {}, existing = null) {
  const keep = (field, fallback) => {
    if (data[field] !== undefined) return data[field];
    if (existing !== null && existing[field] !== undefined) return existing[field];
    return fallback;
  };
  const name = cleanText(keep('name', ''), MAX_NAME, 'name');
  if (!name) throw new ApiError(422, 'plan_name_required', 'نام پلن الزامی است / The plan needs a name');
  const description = cleanText(keep('description', ''), MAX_DESCRIPTION, 'description');

  const gb = Math.round(num(keep('gb', 0)) * 1000) / 1000;
  if (!(gb > 0) || gb > MAX_GB) {
    throw new ApiError(422, 'invalid_plan_gb', `حجم پلن باید بین ۰ تا ${MAX_GB} گیگابایت باشد / Plan volume must be between 0 and ${MAX_GB} GB`);
  }
  const days = Math.round(num(keep('days', 0)));
  if (days <= 0 || days > MAX_DAYS) {
    throw new ApiError(422, 'invalid_plan_days', `مدت پلن باید بین ۱ تا ${MAX_DAYS} روز باشد / Plan duration must be between 1 and ${MAX_DAYS} days`);
  }
  // Zero is a legitimate price: a free plan. It is charged as nothing, which the
  // wallet rules already handle (a 0 amount never touches the ledger).
  const price = Math.max(0, Math.round(num(keep('price', 0))));
  if (price > MAX_PRICE) {
    throw new ApiError(422, 'invalid_plan_price', 'قیمت پلن منطقی نیست / The plan price is out of range');
  }

  const ids = cleanIds(keepIds(data, existing));
  const { rows, serverId } = resolveInbounds(ids);
  const visible = data.visible === undefined
    ? (existing ? Number(existing.visible ?? 1) : 1)
    : (data.visible ? 1 : 0);
  const sort = Math.round(num(keep('sort', 0)));

  // v1.5.8 — the shelf, the take limit and the activation list. PATCH stays
  // partial here too: a field that is absent keeps the value it had.
  const category = String(keep('category', 'public'));
  if (!PLAN_CATEGORIES.includes(category)) {
    throw new ApiError(422, 'invalid_plan_category', 'دستهٔ پلن باید تست، عمومی یا اختصاصی باشد / Plan category must be test, public or exclusive');
  }
  const rawLimit = data.per_user_limit !== undefined ? data.per_user_limit
    : (data.perUserLimit !== undefined ? data.perUserLimit
      : (existing ? Number(existing.per_user_limit || 0) : 0));
  const perUserLimit = Math.max(0, Math.round(num(rawLimit)));
  if (perUserLimit > MAX_PER_USER_LIMIT) {
    throw new ApiError(422, 'invalid_plan_limit', 'محدودیت دریافت پلن منطقی نیست / The per-reseller limit is out of range');
  }
  const rawAllowed = data.allowed_users !== undefined ? data.allowed_users
    : (data.allowedUsers !== undefined ? data.allowedUsers
      : (existing ? allowedUsersOf(existing) : []));
  let allowedUsers = cleanAllowedUsers(rawAllowed);
  if (category === 'exclusive' && !allowedUsers.length) {
    throw new ApiError(422, 'exclusive_needs_reseller', 'پلن اختصاصی باید حداقل برای یک نماینده فعال شود / An exclusive plan must be activated for at least one reseller');
  }
  // The list only MEANS something on the exclusive shelf; keeping it on a public
  // plan would read as a restriction that is not enforced.
  if (category !== 'exclusive') allowedUsers = [];

  return {
    name,
    description,
    gb,
    days,
    price,
    inboundIds: rows.map((row) => Number(row.id)),
    serverId,
    visible,
    sort,
    category,
    perUserLimit,
    allowedUsers,
  };
}

function view(row, { inbounds = null, viewer = null } = {}) {
  const ids = idsOf(row);
  const list = inbounds === null
    ? ids.map((id) => inboundRow(id)).filter(Boolean)
    : inbounds;
  const category = categoryOf(row);
  const perUserLimit = Math.max(0, Number(row.per_user_limit || 0));
  const out = {
    id: Number(row.id),
    name: String(row.name || ''),
    description: String(row.description || ''),
    gb: Number(row.gb || 0),
    days: Number(row.days || 0),
    price: Number(row.price || 0),
    serverId: Number(row.server_id || 0),
    inboundIds: ids,
    inbounds: list.map((inbound) => ({
      id: Number(inbound.id),
      remark: inbound.remark || `#${inbound.id}`,
      protocol: inbound.protocol || '',
      port: Number(inbound.port || 0),
      serverId: Number(inbound.server_id || 0),
      enabled: Boolean(Number(inbound.enabled)),
    })),
    visible: Number(row.visible ? 1 : 0),
    sort: Number(row.sort || 0),
    category,
    perUserLimit,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
  // WHO an exclusive plan is activated for is the owner's business decision —
  // a reseller must not be able to read the list of his competitors. He only ever
  // sees plans already filtered to himself.
  if (viewer?.role === 'admin') {
    const allowed = allowedUsersOf(row);
    const find = getDb().prepare('SELECT id, username, name FROM users WHERE id = ?');
    out.allowedUsers = allowed.map((id) => {
      const user = find.get(id);
      return { id, username: String(user?.username || ''), name: String(user?.name || '') };
    });
    out.sold = Number(getDb()
      .prepare('SELECT COUNT(*) AS c FROM plan_purchases WHERE plan_id = ?')
      .get(Number(row.id)).c || 0);
  }
  return out;
}

/**
 * Plans a viewer may see. An admin sees everything including hidden rows; a
 * reseller sees every visible plan the OWNER put on his shelf — since v2.3.0 the
 * channel permission list is not part of the answer, because a reseller who is
 * offered a plan must be able to sell it (see canResell for what is still asked).
 *
 * A plan whose inbound list has since been deleted from the panel is skipped for
 * a reseller (his order would fail) but still shown to the admin, who is the one
 * able to fix it.
 */
function listPlans({ viewer = null, includeHidden = null } = {}) {
  const db = getDb();
  const isAdmin = viewer?.role === 'admin';
  const showHidden = includeHidden === null ? isAdmin : Boolean(includeHidden);
  const rows = db
    .prepare(`SELECT * FROM plans WHERE deleted_at = 0 ${showHidden ? '' : 'AND visible = 1'} ORDER BY sort ASC, id ASC`)
    .all();
  const out = [];
  for (const row of rows) {
    // The switch can ask for hidden rows, but it can never hand them to someone
    // who is not an admin — hiding a plan is the owner saying "not for sale yet".
    if (!isAdmin && !Number(row.visible)) continue;
    const item = view(row, { viewer });
    if (!isAdmin) {
      if (!item.inbounds.length || item.inbounds.length !== item.inboundIds.length) continue;
      if (!canResell(row, viewer)) continue;
      // v1.5.8: the reseller sees his own counter, so the card can say «۱ بار
      // دیگر می‌توانید بگیرید» instead of letting the buy button fail on him.
      item.taken = countTakes(row.id, viewer.id);
      item.remaining = remainingFor(row, viewer.id);
    }
    out.push(item);
  }
  return out;
}

/**
 * Can this reseller take this plan?
 *
 * v2.3.0 — the owner's complaint from his resellers: «امکان دریافت پلن‌های آماده
 * رو ندارن چون اون اینباند‌های توی پنل براشون فعال نیست». A ready-made plan is
 * the OWNER's product: he chose its channels and its price, and he put it on the
 * shelf for the resellers to sell. Asking every reseller to also hold a per-channel
 * grant for channels he never picked was turning the shelf into an empty room.
 *
 * So the channel PERMISSION is no longer part of this answer. What is still
 * checked, because each one is a fact about the plan rather than a favour:
 *   • an exclusive plan exists only for the resellers it names;
 *   • the plan still has its channels, and they are still enabled on the node —
 *     a plan built on a deleted or disabled channel would fail the order;
 *   • a reseller with a FIXED inbound can only take plans on that inbound's panel,
 *     because his base channel always joins the package and one subscription
 *     cannot span two panels (createConfigs enforces the same rule).
 * The wallet, the per-reseller take limit and the reseller's own ceilings are
 * checked on the way in, exactly as before.
 */
function canResell(row, reseller) {
  // v1.5.8: an exclusive plan exists only for the resellers it names. This one
  // gate covers the shop window, the quote, the purchase and the renewal alike.
  if (categoryOf(row) === 'exclusive' && !allowedUsersOf(row).includes(Number(reseller?.id || 0))) return false;
  const ids = idsOf(row);
  if (!ids.length) return false;
  for (const id of ids) {
    const inbound = inboundRow(id);
    if (!inbound || !Number(inbound.enabled)) return false;
  }
  // A package is one client on one panel, so a reseller whose fixed channel sits
  // elsewhere cannot buy a plan on this one: createConfigs would add his fixed
  // inbound to the order and then refuse the mixed-server package.
  const fixedId = usersService.fixedInboundId(reseller);
  if (fixedId > 0) {
    const fixed = inboundRow(fixedId);
    if (fixed && Number(fixed.server_id) !== Number(row.server_id || 0)) return false;
  }
  return true;
}

function createPlan(data, req) {
  const db = getDb();
  const stored = toStored(data);
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO plans (name, description, gb, days, price, inbound_ids, server_id, visible, sort, category, per_user_limit, allowed_users, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      stored.name, stored.description, stored.gb, stored.days, stored.price,
      JSON.stringify(stored.inboundIds), stored.serverId, stored.visible, stored.sort,
      stored.category, stored.perUserLimit, JSON.stringify(stored.allowedUsers), now, now
    );
  const row = planRow(info.lastInsertRowid);
  audit(req, 'plan.create', 'plan', Number(row.id), { name: row.name, gb: row.gb, days: row.days, price: row.price, inboundIds: stored.inboundIds, category: stored.category, perUserLimit: stored.perUserLimit, allowedUsers: stored.allowedUsers });
  return view(row, { inbounds: stored.inboundIds.map(inboundRow), viewer: req?.user });
}

function updatePlan(id, data, req) {
  const db = getDb();
  const existing = planRow(id);
  if (!existing) throw new ApiError(404, 'plan_not_found', 'پلن پیدا نشد / Plan not found');
  const stored = toStored(data, existing);
  const now = Date.now();
  db.prepare(
    `UPDATE plans SET name = ?, description = ?, gb = ?, days = ?, price = ?, inbound_ids = ?,
      server_id = ?, visible = ?, sort = ?, category = ?, per_user_limit = ?, allowed_users = ?, updated_at = ? WHERE id = ?`
  ).run(
    stored.name, stored.description, stored.gb, stored.days, stored.price,
    JSON.stringify(stored.inboundIds), stored.serverId, stored.visible, stored.sort,
    stored.category, stored.perUserLimit, JSON.stringify(stored.allowedUsers), now, Number(existing.id)
  );
  const row = planRow(existing.id);
  audit(req, 'plan.update', 'plan', Number(row.id), { name: row.name, gb: row.gb, days: row.days, price: row.price, inboundIds: stored.inboundIds, category: stored.category, perUserLimit: stored.perUserLimit, allowedUsers: stored.allowedUsers });
  return view(row, { inbounds: stored.inboundIds.map(inboundRow), viewer: req?.user });
}

/** Soft delete: the plan leaves the shop window, its history stays. */
function deletePlan(id, req) {
  const db = getDb();
  const row = planRow(id);
  if (!row) throw new ApiError(404, 'plan_not_found', 'پلن پیدا نشد / Plan not found');
  const now = Date.now();
  db.prepare('UPDATE plans SET deleted_at = ?, visible = 0, updated_at = ? WHERE id = ?').run(now, now, Number(row.id));
  audit(req, 'plan.delete', 'plan', Number(row.id), { name: row.name });
  return { id: Number(row.id), name: row.name };
}

function requirePlan(id) {
  const row = planRow(id);
  if (!row) throw new ApiError(404, 'plan_not_found', 'پلن پیدا نشد / Plan not found');
  if (!Number(row.visible)) throw new ApiError(409, 'plan_not_available', 'این پلن دیگر قابل خرید نیست / This plan is no longer on sale');
  return row;
}

/**
 * What buying this plan costs this reseller, and what it would have cost at the
 * tariff. Read-only: the wallet is not consulted for a decision here, only
 * reported, so the drawer can say "your balance is not enough" before the tap.
 */
function quote(planId, reseller) {
  const row = requirePlan(planId);
  if (!canResell(row, reseller)) {
    throw new ApiError(403, 'plan_not_for_you', 'این پلن برای شما قابل استفاده نیست / This plan is not available to you');
  }
  const ids = idsOf(row);
  const gb = Number(row.gb || 0);
  const days = Number(row.days || 0);
  const price = Math.max(0, Math.round(Number(row.price || 0)));
  const tariff = pricing.quote({ userId: reseller.id, inboundIds: ids, gb, days });
  const balance = Number(reseller.balance || 0);
  const billing = pricing.billingInfo();
  const charged = Boolean(billing.enabled && price > 0);
  // v1.5.8: how many times this reseller already took this plan, and how many
  // takes are left. `remaining === null` means "no limit configured".
  const taken = countTakes(row.id, reseller.id);
  const remaining = remainingFor(row, reseller.id);
  return {
    plan: view(row),
    gb,
    days,
    price,
    tariff: tariff.total,
    saved: Math.max(0, tariff.total - price),
    currency: billing.currency,
    billing,
    charged,
    balance,
    sufficient: !charged || balance >= price,
    taken,
    remaining,
    limitReached: remaining === 0,
  };
}

/**
 * v1.5.8 per-reseller take limit. Both buying paths (new customer and renewal)
 * call this BEFORE any wallet movement or x-ui write, so an exhausted plan is a
 * clean 409 and never a half-charged package.
 */
function assertTakeAvailable(row, reseller) {
  if (remainingFor(row, reseller.id) === 0) {
    throw new ApiError(
      409,
      'plan_limit_reached',
      'سهمیهٔ دریافت این پلن برای شما تمام شده است / You have reached your limit for this plan'
    );
  }
}

/**
 * Buy a plan for a NEW customer.
 *
 * The customer fields (name, phone, label, note) come from the form; the volume,
 * the duration, the channels and the price come from the plan row. `charge` is
 * never read from the request body, and `priceOverride` is set here from the
 * database — the only way a non-tariff price can enter createConfigs.
 */
async function applyNew({ planId, customerName = '', customerPhone = '', label = '', note = '' } = {}, req) {
  const reseller = req?.user;
  if (!reseller) throw new ApiError(401, 'unauthorized', 'Login required');
  const row = requirePlan(planId);
  if (!canResell(row, reseller)) {
    throw new ApiError(403, 'plan_not_for_you', 'این پلن برای شما قابل استفاده نیست / This plan is not available to you');
  }
  const quoteData = quote(row.id, reseller);
  assertTakeAvailable(row, reseller);
  const configs = await configsService.createConfigs(
    {
      userId: Number(reseller.id),
      inboundIds: idsOf(row),
      gb: quoteData.gb,
      days: quoteData.days,
      label: String(label || '').slice(0, 80),
      customerName: String(customerName || '').slice(0, 80),
      customerPhone: String(customerPhone || '').slice(0, 32),
      note: String(note || '').slice(0, 500),
      unlimited: false,
      priceOverride: quoteData.price,
      planId: Number(row.id),
      planName: String(row.name || ''),
    },
    req
  );
  // One ledger row per successful take — the package itself may span several
  // inbounds, but the reseller took the plan ONCE.
  recordTake(row, reseller.id, Number(configs?.[0]?.id || 0), 'new');
  return { plan: view(row), configs, price: quoteData.price, tariff: quoteData.tariff };
}

/**
 * Buy a plan for an EXISTING customer — the "apply this plan again" path the
 * owner described: his used traffic and his expiry are reset and the plan
 * becomes his package from scratch.
 *
 * That is exactly the renewal mode built in v1.4.26 (`resetUsage: true` with an
 * explicit size and duration), so this route does not re-implement it: it hands
 * the plan's numbers plus the plan's price to extendConfig, which charges the
 * wallet, writes one ledger line, updates x-ui for every inbound of the package
 * and rolls the whole thing back if the panel refuses.
 */
async function applyRenew({ planId, configId } = {}, req) {
  const reseller = req?.user;
  if (!reseller) throw new ApiError(401, 'unauthorized', 'Login required');
  const row = requirePlan(planId);
  if (!canResell(row, reseller)) {
    throw new ApiError(403, 'plan_not_for_you', 'این پلن برای شما قابل استفاده نیست / This plan is not available to you');
  }
  const quoteData = quote(row.id, reseller);
  assertTakeAvailable(row, reseller);
  const config = await configsService.extendConfig(
    Number(configId),
    {
      gb: quoteData.gb,
      days: quoteData.days,
      price: quoteData.price,
      resetUsage: true,
      planId: Number(row.id),
      planName: String(row.name || ''),
    },
    req,
    reseller
  );
  // A renewal is a take too — the owner's limit counts buying the plan again,
  // not only new customers.
  recordTake(row, reseller.id, Number(config?.id || configId), 'renew');
  return {
    plan: view(row),
    config,
    price: quoteData.price,
    tariff: quoteData.tariff,
    usedGbBefore: bytesToGb(Number(config?.used || 0)),
  };
}

/** Preflight for the renewal drawer: does this plan fit this customer's package? */
function renewalPreview(planId, row, reseller) {
  const plan = planRow(planId);
  if (!plan) throw new ApiError(404, 'plan_not_found', 'پلن پیدا نشد / Plan not found');
  const members = configsService.packageRows ? configsService.packageRows(row) : [row];
  const remaining = remainingFor(plan, reseller.id);
  return {
    plan: view(plan),
    gb: Number(plan.gb || 0),
    days: Number(plan.days || 0),
    price: Math.max(0, Math.round(Number(plan.price || 0))),
    configs: members.map((member) => ({
      id: Number(member.id),
      email: member.email,
      inboundId: Number(member.inbound_id),
      usedGb: bytesToGb(Number(member.up_bytes || 0) + Number(member.down_bytes || 0)),
      totalGb: bytesToGb(Number(member.total_bytes || 0)),
      expiryAt: Number(member.expiry_at || 0),
    })),
    // v1.5.8: an exhausted take limit makes the plan unusable for renewal too.
    usable: canResell(plan, reseller) && remaining !== 0,
    remaining,
    limitReached: remaining === 0,
  };
}

module.exports = {
  MAX_INBOUNDS,
  MAX_GB,
  MAX_DAYS,
  PLAN_CATEGORIES,
  planRow,
  idsOf,
  allowedUsersOf,
  categoryOf,
  countTakes,
  remainingFor,
  view,
  canResell,
  listPlans,
  createPlan,
  updatePlan,
  deletePlan,
  requirePlan,
  quote,
  applyNew,
  applyRenew,
  renewalPreview,
};

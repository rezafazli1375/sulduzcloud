'use strict';

const { getDb } = require('../db');
const xui = require('../xui');
const settings = require('../settings');
const usersService = require('./users');
const pricing = require('./pricing');
const serversService = require('./servers');
const {
  ApiError,
  dayKey,
  gbToBytes,
  sanitizeConfig,
  statusOf,
  generateClientEmail,
  randomToken,
  randomUUID,
  escapeLike,
  safeJsonParse,
  pageParams,
} = require('../utils');
const { audit } = require('../audit');
const { notifyUser } = require('../notify');

const DAY_MS = 86400000;

function getInboundRow(id) {
  return getDb()
    .prepare(`SELECT i.*, COALESCE(s.name, '') AS server_name
      FROM inbounds i LEFT JOIN servers s ON s.id = i.server_id WHERE i.id = ?`)
    .get(Number(id));
}

function getResellerRow(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ? AND deleted_at = 0').get(Number(id));
}

function getConfigRow(id) {
  return getDb().prepare('SELECT * FROM configs WHERE id = ?').get(Number(id));
}

// Every x-ui operation needs the server that owns the row. resolveServer falls
// back to the default panel so legacy rows (server_id = 0/1) keep working.
function serverOfConfig(row) {
  return serversService.resolveServer(row?.server_id || 0);
}

function serverOfInbound(inbound) {
  return serversService.resolveServer(inbound?.server_id || 0);
}

function hydrate(row) {
  if (!row) return null;
  const inbound = getInboundRow(row.inbound_id);
  const reseller = getResellerRow(row.user_id);
  return sanitizeConfig(row, inbound, reseller);
}

function subUrlFor(config, server) {
  const xuiCfg = settings.getSetting('xui');
  let base = String((server && server.subBase) || '').replace(/\/+$/, '');
  // The legacy settings.xui.subBase only belongs to the primary panel.
  if (!base) {
    const primary = serversService.defaultServer();
    if (!primary || Number(primary.id) === Number(server?.id || 0)) {
      base = String(xuiCfg.subBase || '').replace(/\/+$/, '');
    }
  }
  if (!base || !config.sub_id) return '';
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return `${base}/${encodeURIComponent(config.sub_id)}`;
}

function priceFor(inbound, gb, days, userId) {
  return pricing.priceFor(inbound, gb, days, userId);
}

function billingEnabled() {
  return Boolean(settings.getSetting('billing').enabled);
}

function chargeReseller(reseller, amount, description, type, req) {
  if (!billingEnabled() || !amount || amount <= 0) return null;
  const db = getDb();
  const current = usersService.getUser(reseller.id);
  if (Number(current.balance || 0) < amount) {
    throw new ApiError(402, 'insufficient_balance', 'موجودی کیف پول کافی نیست / Insufficient wallet balance');
  }
  const next = Number(current.balance || 0) - amount;
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET balance = ?, updated_at = ? WHERE id = ?').run(next, now, current.id);
    db.prepare(
      'INSERT INTO transactions (user_id, type, amount, balance_after, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(current.id, type, -amount, next, description, req?.user?.id || 0, now);
  });
  tx();
  return next;
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 18);
}

// Client names follow "<reseller>-<5 random digits>", e.g. shop-85743.
// The numeric suffix keeps the x-ui email readable while staying unique.
function emailFor(user) {
  const base = slug(user?.username) || `r${Number(user?.id) || 0}`;
  const exists = getDb().prepare('SELECT 1 FROM configs WHERE email = ?');
  for (let i = 0; i < 12; i += 1) {
    const candidate = `${base}-${Math.floor(10000 + Math.random() * 90000)}`;
    if (!exists.get(candidate)) return candidate;
  }
  return generateClientEmail(user?.id);
}

async function rollbackCreated(ids, created) {
  const db = getDb();
  for (const item of created) {
    const email = typeof item === 'string' ? item : item.email;
    const server = typeof item === 'string' ? undefined : item.server;
    try {
      await xui.deleteClient(email, false, server);
    } catch (err) {
      console.error(`[configs] rollback: x-ui delete failed for ${email}:`, err.message);
    }
  }
  if (ids.length) {
    try {
      db.prepare(`DELETE FROM configs WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    } catch (err) {
      console.error('[configs] rollback: db cleanup failed:', err.message);
    }
  }
}

async function createConfigs(input, req) {
  const db = getDb();
  const user = getResellerRow(input.userId);
  if (!user) throw new ApiError(404, 'user_not_found', 'Reseller not found');
  if (user.status !== 'active') throw new ApiError(403, 'user_disabled', 'This reseller account is disabled');

  const inboundIds = (Array.isArray(input.inboundIds) ? input.inboundIds : [input.inboundId])
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (!inboundIds.length) throw new ApiError(422, 'inbound_required', 'Select at least one inbound');

  const gb = Math.max(0, Number(input.gb || 0));
  const days = Math.max(0, Math.round(Number(input.days || 0)));
  if (gb <= 0 && input.unlimited !== true) throw new ApiError(422, 'gb_required', 'Traffic volume must be greater than zero');
  if (days <= 0 && input.unlimited !== true) throw new ApiError(422, 'days_required', 'Duration must be greater than zero');

  const allowed = usersService.allowedInboundIds(user);
  const priced = [];
  let totalPrice = 0;

  for (const inboundId of inboundIds) {
    const inbound = getInboundRow(inboundId);
    if (!inbound) throw new ApiError(404, 'inbound_not_found', `Inbound ${inboundId} not found`);
    if (!inbound.enabled) throw new ApiError(422, 'inbound_disabled', `Inbound ${inbound.remark} is disabled`);
    if (allowed && !allowed.includes(inboundId)) {
      throw new ApiError(403, 'inbound_forbidden', 'This reseller cannot use the selected inbound');
    }
    if (!inbound.visible && req?.user?.role !== 'admin') {
      throw new ApiError(403, 'inbound_hidden', 'This inbound is not available');
    }
    const price = pricing.priceFor(inbound, gb, days, user.id);
    priced.push({ inboundId, inbound, price, server: serverOfInbound(inbound) });
    // Multi-inbound orders are billed once at the most expensive inbound's tariff.
    totalPrice = Math.max(totalPrice, price);
  }
  // A subscription id only spans clients of one x-ui panel, so an order must
  // not mix inbounds from different servers.
  const orderServer = priced[0] ? Number(priced[0].server.id) : 0;
  if (priced.some((item) => Number(item.server.id) !== orderServer)) {
    throw new ApiError(422, 'server_mismatch', 'همه اینباندهای یک سفارش باید روی یک سرور باشند / All inbounds in one order must belong to the same server');
  }
  usersService.checkLimits(user, {
    gb: gb * inboundIds.length,
    days,
    count: inboundIds.length,
    gbEach: gb,
  });

  // Fail fast before touching x-ui when the wallet cannot cover the order.
  if (billingEnabled() && totalPrice > 0 && Number(user.balance || 0) < totalPrice) {
    throw new ApiError(402, 'insufficient_balance', 'موجودی کیف پول کافی نیست / Insufficient wallet balance');
  }

  const now = Date.now();
  const expiryAt = days > 0 ? now + days * DAY_MS : 0;
  const totalBytes = gb > 0 ? gbToBytes(gb) : 0;
  const created = [];
  const createdIds = [];
  const createdEmails = [];
  // One subscription ID per order: every inbound of this customer is listed by
  // the same /sub/<subId> URL instead of handing out one link per inbound.
  const subId = randomToken(16);

  try {
    for (const { inboundId, inbound, server } of priced) {
      const email = emailFor(user);
      const uuid = randomUUID();
      const comment = [input.label, input.customerName, input.customerPhone].filter(Boolean).join(' | ').slice(0, 120);
      const client = {
        email,
        subId,
        uuid,
        flow: '',
        totalBytes,
        expiryAt,
        enabled: true,
        comment,
      };
      const createdClient = await xui.addClient(client, [Number(inbound.xui_id)], server);
      createdEmails.push({ email, server });
      const info = db.prepare(
        `INSERT INTO configs (user_id, inbound_id, server_id, email, sub_id, uuid, flow, label, customer_name, customer_phone,
          note, total_bytes, expiry_at, enabled, status, sync_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, 1, 'active', '', ?, ?)`
      ).run(
        user.id,
        inboundId,
        Number(server.id),
        email,
        subId,
        String(createdClient?.uuid || uuid),
        String(input.label || '').slice(0, 80),
        String(input.customerName || '').slice(0, 80),
        String(input.customerPhone || '').slice(0, 32),
        String(input.note || '').slice(0, 500),
        totalBytes,
        expiryAt,
        now,
        now
      );
      createdIds.push(Number(info.lastInsertRowid));
      created.push(hydrate(getConfigRow(info.lastInsertRowid)));
    }

    // Charge only after every client exists in x-ui; the whole order is rolled
    // back below when the wallet or the panel rejects it.
    if (billingEnabled() && totalPrice > 0) {
      chargeReseller(user, totalPrice, `ایجاد ${inboundIds.length} کانفیگ (${gb} GB / ${days} روز)`, 'purchase', req);
    }
  } catch (err) {
    await rollbackCreated(createdIds, createdEmails);
    throw err instanceof ApiError
      ? err
      : new ApiError(502, 'xui_error', `ساخت کانفیگ ناموفق بود: ${err.message}`);
  }

  audit(req, 'config.create', 'config', created.map((c) => c.id).join(','), {
    userId: user.id,
    inboundIds,
    gb,
    days,
    count: created.length,
    price: totalPrice,
  });
  if (req?.user && req.user.role === 'reseller') {
    notifyUser(req.user.id, {
      type: 'info',
      title: 'کانفیگ جدید ساخته شد',
      body: `${created.length} کانفیگ با ${gb} گیگابایت و ${days} روز ایجاد شد.`,
      link: '/reseller/configs',
    });
  }
  return created;
}

function buildWhere(filters, viewer) {
  const now = Date.now();
  const where = ['c.deleted_at = 0'];
  const params = [];
  if (viewer && viewer.role !== 'admin') { where.push('c.user_id = ?'); params.push(Number(viewer.id)); }
  else if (filters.userId) { where.push('c.user_id = ?'); params.push(Number(filters.userId)); }
  if (filters.inboundId) { where.push('c.inbound_id = ?'); params.push(Number(filters.inboundId)); }
  if (filters.search) {
    where.push('(c.email LIKE ? ESCAPE \'\\\' OR c.label LIKE ? ESCAPE \'\\\' OR c.customer_name LIKE ? ESCAPE \'\\\' OR c.customer_phone LIKE ? ESCAPE \'\\\')');
    const like = `%${escapeLike(filters.search)}%`;
    params.push(like, like, like, like);
  }
  const statusExpr = `CASE
      WHEN c.enabled = 0 THEN 'disabled'
      WHEN c.expiry_at > 0 AND c.expiry_at <= ${now} THEN 'expired'
      WHEN c.total_bytes > 0 AND (c.up_bytes + c.down_bytes) >= c.total_bytes THEN 'depleted'
      ELSE 'active' END`;
  if (filters.status) {
    const allowed = ['active', 'expired', 'depleted', 'disabled'];
    if (allowed.includes(String(filters.status))) {
      where.push(`${statusExpr} = '${String(filters.status)}'`);
    }
  }
  if (filters.expiringDays) {
    const until = now + Number(filters.expiringDays) * DAY_MS;
    where.push(`c.expiry_at > 0 AND c.expiry_at > ${now} AND c.expiry_at <= ${until}`);
  }
  return { clause: `WHERE ${where.join(' AND ')}`, params, statusExpr };
}

function listConfigs(filters = {}, viewer) {
  const db = getDb();
  const { page, pageSize, offset } = pageParams(filters, 20, 200);
  const { clause, params, statusExpr } = buildWhere(filters, viewer);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM configs c ${clause}`).get(...params).c;
  const rows = db.prepare(
    `SELECT c.*, ${statusExpr} AS computed_status FROM configs c ${clause}
     ORDER BY c.created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);
  const inboundCache = new Map();
  const resellerCache = new Map();
  const result = rows.map((row) => {
    if (!inboundCache.has(row.inbound_id)) inboundCache.set(row.inbound_id, getInboundRow(row.inbound_id));
    if (!resellerCache.has(row.user_id)) resellerCache.set(row.user_id, getResellerRow(row.user_id));
    const config = sanitizeConfig(row, inboundCache.get(row.inbound_id), resellerCache.get(row.user_id));
    if (row.computed_status && row.computed_status !== config.status) config.status = row.computed_status;
    return config;
  });
  return { total, page, pageSize, rows: result };
}

function configDetail(id, viewer) {
  const row = getConfigRow(id);
  if (!row || row.deleted_at) throw new ApiError(404, 'not_found', 'Config not found');
  if (viewer && viewer.role !== 'admin' && Number(row.user_id) !== Number(viewer.id)) {
    throw new ApiError(403, 'forbidden', 'You do not have access to this config');
  }
  return { row, config: hydrate(row) };
}

async function linksFor(row) {
  let links = [];
  let error = '';
  let client = null;
  const server = serverOfConfig(row);
  try {
    links = await xui.clientLinks(row.email, server);
  } catch (err) {
    error = err.message;
  }
  try {
    client = await xui.getClient(row.email, server);
    // x-ui is the source of truth for the identity; heal a stale local copy so
    // the UUID editor never shows a value that differs from the live client.
    if (client && client.uuid && client.uuid !== row.uuid) {
      getDb().prepare('UPDATE configs SET uuid = ?, updated_at = ? WHERE id = ?').run(client.uuid, Date.now(), row.id);
      row.uuid = client.uuid;
    }
  } catch (err) {
    if (!error) error = err.message;
  }
  return {
    links,
    subUrl: subUrlFor(row, server),
    error,
    client: client ? { uuid: client.uuid, subId: client.subId, inboundIds: client.inboundIds } : null,
  };
}

async function applyToXui(row, patch) {
  const inbound = getInboundRow(row.inbound_id);
  const server = serverOfConfig(row);
  const ids = inbound ? [Number(inbound.xui_id)] : [];
  const updated = await xui.updateClient(row.email, patch, ids, server);
  return updated;
}

async function extendConfig(id, { gb = 0, days = 0, price = 0, resetUsage = false } = {}, req, viewer) {
  const { row } = configDetail(id, viewer);
  const addBytes = gbToBytes(Math.max(0, Number(gb || 0)));
  const addDays = Math.max(0, Math.round(Number(days || 0)));
  if (!addBytes && !addDays && !resetUsage) throw new ApiError(422, 'nothing_to_add', 'Enter traffic or days to add');

  // A customer with several inbounds is one package: renewing from any of its
  // configs applies to the whole group and is charged once, at the highest
  // inbound tariff of the group (not the sum of tariffs).
  const siblings = groupRows(row);
  const targets = siblings.length ? siblings : [row];
  const reseller = getResellerRow(row.user_id);
  let amount = Math.round(Number(price || 0));
  if (!amount && reseller) {
    for (const target of targets) {
      const inbound = getInboundRow(target.inbound_id);
      if (!inbound) continue;
      amount = Math.max(amount, pricing.priceFor(inbound, gb, addDays, reseller.id));
    }
  }
  if (billingEnabled() && amount > 0 && reseller && Number(reseller.balance || 0) < amount) {
    throw new ApiError(402, 'insufficient_balance', 'موجودی کیف پول کافی نیست / Insufficient wallet balance');
  }

  const updates = targets.map((target) => {
    const currentExpiry = Number(target.expiry_at || 0);
    const base = currentExpiry > 0 ? Math.max(Date.now(), currentExpiry) : Date.now();
    const currentTotal = Number(target.total_bytes || 0);
    return {
      row: target,
      currentExpiry,
      currentTotal,
      newExpiry: addDays > 0 ? base + addDays * DAY_MS : currentExpiry,
      newTotal: addBytes > 0 ? (currentTotal > 0 ? currentTotal + addBytes : addBytes) : currentTotal,
    };
  });

  const applied = [];
  try {
    for (const update of updates) {
      try {
        await applyToXui(update.row, {
          totalBytes: update.newTotal,
          expiryAt: update.newExpiry,
          enabled: true,
        });
      } catch (err) {
        // A sibling whose x-ui client vanished must not block the rest of the
        // package; the config being extended itself still fails loudly.
        if (err?.code === 'xui_client_missing' && Number(update.row.id) !== Number(row.id)) {
          console.error(`[configs] extend: sibling ${update.row.email} missing in x-ui, skipped`);
          continue;
        }
        throw err;
      }
      applied.push(update);
    }
    if (billingEnabled() && amount > 0) {
      chargeReseller(reseller, amount, `تمدید ${targets.length} کانفیگ (+${gb}GB / +${addDays}d)`, 'renew', req);
    }
  } catch (err) {
    for (const update of applied.reverse()) {
      try {
        await applyToXui(update.row, {
          totalBytes: update.currentTotal,
          expiryAt: update.currentExpiry,
          enabled: Boolean(update.row.enabled),
        });
      } catch (revertErr) {
        console.error(`[configs] extend: revert failed for ${update.row.email}:`, revertErr.message);
      }
    }
    throw err;
  }

  const now = Date.now();
  const updateDb = db().prepare(
    `UPDATE configs SET total_bytes = ?, expiry_at = ?, enabled = 1, sync_status = '', last_synced_at = ?, updated_at = ?
     WHERE id = ?`
  );
  const resetDb = db().prepare('UPDATE configs SET up_bytes = 0, down_bytes = 0, last_up = 0, last_down = 0 WHERE id = ?');
  for (const update of applied) {
    if (resetUsage) {
      try {
        await xui.resetTraffic(update.row.email, serverOfConfig(update.row));
      } catch (err) {
        console.error(`[configs] extend: reset traffic failed for ${update.row.email}:`, err.message);
      }
    }
    updateDb.run(update.newTotal, update.newExpiry, now, now, update.row.id);
    if (resetUsage) resetDb.run(update.row.id);
  }

  audit(req, 'config.extend', 'config', row.id, {
    gb,
    days,
    resetUsage,
    amount,
    groupSize: targets.length,
    applied: applied.length,
  });
  if (reseller) {
    notifyUser(reseller.id, {
      type: 'success',
      title: 'کانفیگ تمدید شد',
      body: `${row.email} — ${gb ? `+${gb}GB ` : ''}${addDays ? `+${addDays} روز` : ''}`.trim()
        + (targets.length > 1 ? ` (${targets.length} اینباند)` : ''),
      link: '/reseller/configs',
    });
  }
  return hydrate(getConfigRow(row.id));
}

function db() {
  return getDb();
}

async function setQuota(id, patch, req, viewer) {
  const { row } = configDetail(id, viewer);
  const next = {};
  if (patch.gb !== undefined) next.totalBytes = gbToBytes(Math.max(0, Number(patch.gb || 0)));
  if (patch.expiryAt !== undefined) next.expiryAt = Math.max(0, Number(patch.expiryAt || 0));
  if (patch.days !== undefined) {
    const days = Math.max(0, Math.round(Number(patch.days || 0)));
    next.expiryAt = days > 0 ? Date.now() + days * DAY_MS : 0;
  }
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (!Object.keys(next).length) throw new ApiError(422, 'nothing_to_change', 'Nothing to change');
  await applyToXui(row, next);
  const fields = [];
  const values = [];
  if (next.totalBytes !== undefined) { fields.push('total_bytes = ?'); values.push(next.totalBytes); }
  if (next.expiryAt !== undefined) { fields.push('expiry_at = ?'); values.push(next.expiryAt); }
  if (next.enabled !== undefined) { fields.push('enabled = ?'); values.push(next.enabled ? 1 : 0); }
  fields.push('sync_status = ?', 'last_synced_at = ?', 'updated_at = ?');
  values.push('', Date.now(), Date.now(), row.id);
  db().prepare(`UPDATE configs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  audit(req, 'config.quota', 'config', row.id, next);
  return hydrate(getConfigRow(row.id));
}

async function toggleConfig(id, enabled, req, viewer) {
  const { row } = configDetail(id, viewer);
  await xui.setEnabled(row.email, Boolean(enabled), serverOfConfig(row));
  db().prepare('UPDATE configs SET enabled = ?, sync_status = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, '', Date.now(), row.id);
  audit(req, 'config.toggle', 'config', row.id, { enabled: Boolean(enabled) });
  return hydrate(getConfigRow(row.id));
}

async function resetUsage(id, req, viewer) {
  const { row } = configDetail(id, viewer);
  await xui.resetTraffic(row.email, serverOfConfig(row));
  db().prepare('UPDATE configs SET up_bytes = 0, down_bytes = 0, last_up = 0, last_down = 0, updated_at = ? WHERE id = ?')
    .run(Date.now(), row.id);
  audit(req, 'config.reset_usage', 'config', row.id, {});
  return hydrate(getConfigRow(row.id));
}

async function updateMeta(id, patch, req, viewer) {
  const { row } = configDetail(id, viewer);
  const fields = [];
  const values = [];
  for (const [key, column, max] of [
    ['label', 'label', 80],
    ['customerName', 'customer_name', 80],
    ['customerPhone', 'customer_phone', 32],
    ['note', 'note', 500],
  ]) {
    if (patch[key] !== undefined) { fields.push(`${column} = ?`); values.push(String(patch[key] || '').slice(0, max)); }
  }
  if (!fields.length) return hydrate(row);
  fields.push('updated_at = ?');
  values.push(Date.now(), row.id);
  db().prepare(`UPDATE configs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  audit(req, 'config.update', 'config', row.id, Object.keys(patch));
  return hydrate(getConfigRow(row.id));
}

async function removeConfig(id, { hard = false, silent = false } = {}, req, viewer) {
  const { row } = configDetail(id, viewer);
  try {
    await xui.deleteClient(row.email, false, serverOfConfig(row));
  } catch (err) {
    if (!silent) throw err;
    console.error(`[configs] x-ui delete failed for ${row.email}:`, err.message);
  }
  const db = getDb();
  if (hard) {
    db.prepare('DELETE FROM configs WHERE id = ?').run(row.id);
    db.prepare('DELETE FROM usage_daily WHERE config_id = ?').run(row.id);
  } else {
    db.prepare('UPDATE configs SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), row.id);
  }
  audit(req, 'config.delete', 'config', row.id, { email: row.email, hard });
  return { ok: true };
}

/**
 * Every config that shares a subscription ID belongs to the same customer
 * group: one /sub/<subId> link lists all of them.
 */
function groupRows(row) {
  if (!row || !row.sub_id) return [];
  return getDb()
    .prepare('SELECT * FROM configs WHERE sub_id = ? AND user_id = ? AND server_id = ? AND deleted_at = 0 ORDER BY id')
    .all(row.sub_id, row.user_id, Number(row.server_id || 0) || 1);
}

function groupFor(row) {
  return groupRows(row).map((r) => {
    const config = hydrate(r);
    return {
      id: config.id,
      email: config.email,
      inboundId: config.inboundId,
      inbound: config.inbound,
      totalGb: config.totalGb,
      totalBytes: config.totalBytes,
      expiryAt: config.expiryAt,
      enabled: config.enabled,
      status: config.status,
      used: config.used,
    };
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function updateIdentity(id, patch = {}, req, viewer) {
  const { row } = configDetail(id, viewer);
  const next = {};
  if (patch.uuid !== undefined) {
    const value = String(patch.uuid || '').trim();
    if (value && !UUID_RE.test(value)) {
      throw new ApiError(422, 'uuid_invalid', 'UUID must look like 8-4-4-4-12 hex');
    }
    next.uuid = value || randomUUID();
  }
  if (patch.subId !== undefined) {
    const value = String(patch.subId || '').trim();
    if (value && !/^[A-Za-z0-9_-]{4,64}$/.test(value)) {
      throw new ApiError(422, 'sub_invalid', 'Subscription ID must be 4-64 letters, digits, - or _');
    }
    next.subId = value || randomToken(16);
  }
  if (!next.uuid && !next.subId) throw new ApiError(422, 'nothing_to_change', 'Nothing to change');

  await xui.setIdentity(row.email, next, serverOfConfig(row));

  const db = getDb();
  const fields = [];
  const values = [];
  if (next.uuid) { fields.push('uuid = ?'); values.push(next.uuid); }
  if (next.subId) { fields.push('sub_id = ?'); values.push(next.subId); }
  fields.push('updated_at = ?');
  values.push(Date.now(), row.id);
  db.prepare(`UPDATE configs SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  // The subscription URL is keyed by subId; move the whole customer group so
  // the single link keeps listing every inbound after a rotation.
  if (next.subId && row.sub_id && next.subId !== row.sub_id) {
    const siblings = db
      .prepare('SELECT * FROM configs WHERE sub_id = ? AND user_id = ? AND deleted_at = 0 AND id <> ?')
      .all(row.sub_id, row.user_id, row.id);
    for (const sibling of siblings) {
      try {
        await xui.setIdentity(sibling.email, { subId: next.subId }, serverOfConfig(sibling));
        db.prepare('UPDATE configs SET sub_id = ?, updated_at = ? WHERE id = ?').run(next.subId, Date.now(), sibling.id);
      } catch (err) {
        console.error(`[configs] subId propagation failed for ${sibling.email}:`, err.message);
      }
    }
  }
  audit(req, 'config.identity', 'config', row.id, { uuid: Boolean(next.uuid), subId: Boolean(next.subId) });
  return hydrate(getConfigRow(row.id));
}

async function addInbound(id, inboundId, req, viewer) {
  const db = getDb();
  const { row } = configDetail(id, viewer);
  const target = Number(inboundId);
  const inbound = getInboundRow(target);
  if (!inbound) throw new ApiError(404, 'inbound_not_found', 'Inbound not found');
  if (!inbound.enabled) throw new ApiError(422, 'inbound_disabled', `Inbound ${inbound.remark} is disabled`);
  if (!inbound.visible && viewer?.role !== 'admin') {
    throw new ApiError(403, 'inbound_hidden', 'This inbound is not available');
  }
  const user = getResellerRow(row.user_id);
  if (!user) throw new ApiError(404, 'user_not_found', 'Reseller not found');
  const server = serverOfInbound(inbound);
  const targetServer = serverOfConfig(row);
  // A customer's inbounds share one subscription id, which lives on a single
  // x-ui panel; cross-server groups would need two different sub links.
  if (Number(server.id) !== Number(targetServer.id)) {
    throw new ApiError(422, 'server_mismatch', 'This inbound belongs to a different x-ui panel than the config');
  }
  const allowed = usersService.allowedInboundIds(user);
  if (allowed && !allowed.includes(target)) {
    throw new ApiError(403, 'inbound_forbidden', 'This reseller cannot use the selected inbound');
  }
  const exists = db
    .prepare('SELECT 1 FROM configs WHERE sub_id = ? AND inbound_id = ? AND deleted_at = 0')
    .get(row.sub_id, target);
  if (exists) throw new ApiError(409, 'inbound_exists', 'This customer already has this inbound');

  // The new inbound inherits the customer's current quota and expiry window.
  const totalBytes = Number(row.total_bytes || 0);
  const expiryAt = Number(row.expiry_at || 0);
  const totalGb = totalBytes > 0 ? Math.round((totalBytes / 1024 / 1024 / 1024) * 100) / 100 : 0;
  const remainingDays = expiryAt > 0 ? Math.max(1, Math.ceil((expiryAt - Date.now()) / DAY_MS)) : 0;
  const amount = pricing.priceFor(inbound, totalGb, remainingDays, user.id);
  usersService.checkLimits(user, { count: 1, gb: totalGb, gbEach: totalGb, days: remainingDays });

  if (billingEnabled() && amount > 0 && Number(user.balance || 0) < amount) {
    throw new ApiError(402, 'insufficient_balance', 'موجودی کیف پول کافی نیست / Insufficient wallet balance');
  }

  const email = emailFor(user);
  const uuid = randomUUID();
  const comment = [row.label, row.customer_name, row.customer_phone].filter(Boolean).join(' | ').slice(0, 120);
  const createdClient = await xui.addClient(
    { email, subId: row.sub_id, uuid, flow: '', totalBytes, expiryAt, enabled: Boolean(row.enabled), comment },
    [Number(inbound.xui_id)],
    server
  );
  let insertedId = 0;
  try {
    const info = db.prepare(
      `INSERT INTO configs (user_id, inbound_id, server_id, email, sub_id, uuid, flow, label, customer_name, customer_phone,
        note, total_bytes, expiry_at, enabled, status, sync_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'active', '', ?, ?)`
    ).run(
      row.user_id,
      target,
      Number(server.id),
      email,
      row.sub_id,
      String(createdClient?.uuid || uuid),
      String(row.label || '').slice(0, 80),
      String(row.customer_name || '').slice(0, 80),
      String(row.customer_phone || '').slice(0, 32),
      String(row.note || '').slice(0, 500),
      totalBytes,
      expiryAt,
      row.enabled ? 1 : 0,
      Date.now(),
      Date.now()
    );
    insertedId = Number(info.lastInsertRowid);
    if (billingEnabled() && amount > 0) {
      chargeReseller(user, amount, `افزودن اینباند ${inbound.remark} به ${row.customer_name || email}`, 'purchase', req);
    }
  } catch (err) {
    try {
      await xui.deleteClient(email, false, server);
    } catch (cleanupErr) {
      console.error(`[configs] addInbound: cleanup failed for ${email}:`, cleanupErr.message);
    }
    if (insertedId) db.prepare('DELETE FROM configs WHERE id = ?').run(insertedId);
    throw err;
  }

  audit(req, 'config.inbound_add', 'config', insertedId, { source: row.id, inboundId: target, amount });
  return hydrate(getConfigRow(insertedId));
}

async function syncConfigs({ pruneUsageDays } = {}) {
  const db = getDb();
  const started = Date.now();
  // Each x-ui panel keeps its own client list; key the map per server so two
  // panels with identical emails cannot overwrite each other.
  const map = new Map();
  const serverList = serversService.listServers({ includeDisabled: false });
  for (const server of serverList) {
    let clients = [];
    try {
      clients = await xui.listClients(server);
    } catch (err) {
      console.error(`[configs] client sync failed for server ${server.id}:`, err.message);
      continue;
    }
    for (const client of clients) map.set(`${server.id}:${String(client.email).toLowerCase()}`, client);
  }
  const rows = db.prepare('SELECT * FROM configs WHERE deleted_at = 0').all();
  const today = dayKey();
  const upsertUsage = db.prepare(
    `INSERT INTO usage_daily (config_id, user_id, day, up_bytes, down_bytes) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(config_id, day) DO UPDATE SET
       up_bytes = usage_daily.up_bytes + excluded.up_bytes,
       down_bytes = usage_daily.down_bytes + excluded.down_bytes`
  );
  const updateConfig = db.prepare(
    `UPDATE configs SET up_bytes = ?, down_bytes = ?, last_up = ?, last_down = ?, last_online_at = ?,
       enabled = ?, uuid = ?, sync_status = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`
  );
  let synced = 0;
  let missing = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const sid = Number(row.server_id || 0) || (serverList[0] ? Number(serverList[0].id) : 0);
      const client = map.get(`${sid}:${String(row.email).toLowerCase()}`);
      if (!client) {
        missing += 1;
        updateConfig.run(row.up_bytes, row.down_bytes, row.last_up, row.last_down, row.last_online_at,
          row.enabled, row.uuid, 'missing', Date.now(), Date.now(), row.id);
        continue;
      }
      const up = Number(client.up || 0);
      const down = Number(client.down || 0);
      let deltaUp = up - Number(row.last_up || 0);
      let deltaDown = down - Number(row.last_down || 0);
      if (deltaUp < 0) deltaUp = 0;
      if (deltaDown < 0) deltaDown = 0;
      if ((deltaUp > 0 || deltaDown > 0) && dayKey() === today) {
        upsertUsage.run(row.id, row.user_id, today, deltaUp, deltaDown);
      }
      updateConfig.run(up, down, up, down, client.lastOnlineAt || 0,
        client.enabled ? 1 : 0, client.uuid || row.uuid, '', Date.now(), Date.now(), row.id);
      synced += 1;
    }
  });
  tx();
  if (pruneUsageDays) {
    const cutoff = new Date(Date.now() - pruneUsageDays * DAY_MS).toISOString().slice(0, 10);
    db.prepare('DELETE FROM usage_daily WHERE day < ?').run(cutoff);
  }
  return { synced, missing, total: rows.length, durationMs: Date.now() - started };
}

function expiredNotifications() {
  const db = getDb();
  const monitor = settings.getSetting('monitor');
  if (!monitor.expiryAlerts) return { sent: 0 };
  const days = Array.isArray(monitor.expiryDays) ? monitor.expiryDays : [3, 1];
  const now = Date.now();
  let sent = 0;
  for (const day of days) {
    const limit = day * DAY_MS;
    const rows = db.prepare(
      `SELECT c.*, u.phone, u.email, u.lang FROM configs c JOIN users u ON u.id = c.user_id
       WHERE c.deleted_at = 0 AND c.enabled = 1 AND c.expiry_at > 0
         AND c.expiry_at > ? AND c.expiry_at <= ?`
    ).all(now, now + limit);
    for (const row of rows) {
      const key = `expiry:${row.id}:${day}:${new Date(row.expiry_at).toISOString().slice(0, 10)}`;
      const inserted = notifyUser(row.user_id, {
        type: 'warning',
        title: `کانفیگ ${row.email} به‌زودی منقضی می‌شود`,
        body: `کمتر از ${day} روز تا پایان اعتبار باقی مانده است.`,
        link: '/reseller/configs',
        dedupeKey: key,
        meta: { configId: row.id, days: day },
      });
      if (inserted) sent += 1;
    }
  }
  const percent = Number(monitor.trafficAlertPercent || 90);
  const usedRows = db.prepare(
    `SELECT c.* FROM configs c
     WHERE c.deleted_at = 0 AND c.enabled = 1 AND c.total_bytes > 0
       AND (c.up_bytes + c.down_bytes) * 100 >= c.total_bytes * ?`
  ).all(percent);
  for (const row of usedRows) {
    const key = `traffic:${row.id}:${percent}:${dayKey()}`;
    const inserted = notifyUser(row.user_id, {
      type: 'warning',
      title: `حجم کانفیگ ${row.email} در حال اتمام است`,
      body: `بیش از ${percent}٪ از حجم کانفیگ مصرف شده است.`,
      link: '/reseller/configs',
      dedupeKey: key,
      meta: { configId: row.id, percent },
    });
    if (inserted) sent += 1;
  }
  return { sent };
}

function exportRows(filters, viewer) {
  const db = getDb();
  const { clause, params } = buildWhere({ ...filters, page: 1, pageSize: 100000 }, viewer);
  const rows = db.prepare(`SELECT c.* FROM configs c ${clause} ORDER BY c.created_at DESC`).all(...params);
  return rows.map((row) => hydrate(row));
}

module.exports = {
  createConfigs,
  listConfigs,
  configDetail,
  hydrate,
  getConfigRow,
  linksFor,
  subUrlFor,
  extendConfig,
  setQuota,
  toggleConfig,
  resetUsage,
  updateMeta,
  removeConfig,
  groupFor,
  updateIdentity,
  addInbound,
  syncConfigs,
  expiredNotifications,
  exportRows,
  priceFor,
  getInboundRow,
};

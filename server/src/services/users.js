'use strict';

const { getDb } = require('../db');
const { hashPassword } = require('../auth');
const { ApiError, sanitizeUser, parsePermissions, safeJsonParse, randomToken, escapeLike, CONFIG_GROUP_KEY_SQL, CONFIG_GROUP_USED_SQL } = require('../utils');
const { audit } = require('../audit');

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

function getUser(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at = 0').get(Number(id));
}

function getUserByUsername(username) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND deleted_at = 0').get(String(username || ''));
}

// Who owns a name, live or deleted. The create endpoint uses it to tell the UI
// that an old account came back instead of a brand new one being made.
function usernameHolder(username) {
  const db = getDb();
  return db.prepare('SELECT id, deleted_at FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').trim());
}

function userStats(userId) {
  const db = getDb();
  const row = db.prepare(
    `SELECT COUNT(*) AS configs,
            COALESCE(SUM(CASE WHEN enabled = 1 AND (expiry_at = 0 OR expiry_at > ?) AND (total_bytes = 0 OR up_bytes + down_bytes < total_bytes) THEN 1 ELSE 0 END), 0) AS active,
            COALESCE(SUM(up_bytes + down_bytes), 0) AS used
     FROM configs WHERE user_id = ? AND deleted_at = 0
       AND (origin <> 'external' OR user_id IN (SELECT id FROM users WHERE import_configs = 1))`
  ).get(Date.now(), Number(userId));
  // Row counts above stay for API v1, which is documented as one row per inbound.
  // Packages are the customer-facing unit: every inbound of one subscription is
  // a single customer with ONE shared traffic pool, exactly like the grouped
  // config list and the dashboard. Quota is the pool size (largest member
  // quota), never the sum of per-inbound quotas.
  const now = Date.now();
  const packages = db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(quota), 0) AS quota,
            COALESCE(SUM(used), 0) AS used,
            COALESCE(SUM(CASE WHEN (expiry_at = 0 OR expiry_at > ${now}) AND (quota = 0 OR used < quota)
                               AND disabled_n < members AND active_n = members THEN 1 ELSE 0 END), 0) AS active
     FROM (
       SELECT ${CONFIG_GROUP_KEY_SQL} AS gkey, COUNT(*) AS members,
         SUM(CASE WHEN c.enabled = 1 AND (c.expiry_at = 0 OR c.expiry_at > ${now})
                   AND (c.total_bytes = 0 OR c.up_bytes + c.down_bytes < c.total_bytes) THEN 1 ELSE 0 END) AS active_n,
         SUM(CASE WHEN c.enabled = 0 THEN 1 ELSE 0 END) AS disabled_n,
         MAX(c.expiry_at) AS expiry_at,
         MAX(c.total_bytes) AS quota,
         ${CONFIG_GROUP_USED_SQL} AS used
       FROM configs c WHERE c.user_id = ? AND c.deleted_at = 0
         AND (c.origin <> 'external' OR c.user_id IN (SELECT id FROM users WHERE import_configs = 1))
       GROUP BY gkey
     )`
  ).get(Number(userId));
  // Adopted subscriptions are grouped by the x-ui email, so one customer with
  // several inbounds is one package here, not several.
  const external = db.prepare(
    `SELECT COUNT(DISTINCT ${CONFIG_GROUP_KEY_SQL}) AS c FROM configs c WHERE c.user_id = ? AND c.deleted_at = 0 AND c.origin = 'external'
       AND c.user_id IN (SELECT id FROM users WHERE import_configs = 1)`
  ).get(Number(userId)).c;
  return {
    configs: Number(row.configs || 0),
    active: Number(row.active || 0),
    packages: Number(packages.total || 0),
    activePackages: Number(packages.active || 0),
    externalPackages: Number(external || 0),
    quotaBytes: Number(packages.quota || 0),
    usedBytes: Number(packages.used || 0),
  };
}

function listUsers({ search = '', status = '', role = '', page = 1, pageSize = 20 } = {}) {
  const db = getDb();
  const where = ['u.deleted_at = 0'];
  const params = [];
  if (search) {
    where.push('(u.username LIKE ? ESCAPE \'\\\' OR u.name LIKE ? ESCAPE \'\\\' OR u.email LIKE ? ESCAPE \'\\\' OR u.phone LIKE ? ESCAPE \'\\\' OR u.telegram_id LIKE ? ESCAPE \'\\\')');
    const like = `%${escapeLike(search)}%`;
    params.push(like, like, like, like, like);
  }
  if (status) { where.push('u.status = ?'); params.push(status); }
  if (role) { where.push('u.role = ?'); params.push(role); }
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS c FROM users u ${clause}`).get(...params).c;
  const rows = db.prepare(
    `SELECT u.* FROM users u ${clause} ORDER BY u.role = 'admin' DESC, u.id DESC LIMIT ? OFFSET ?`
  ).all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
  return {
    total,
    rows: rows.map((row) => ({ ...sanitizeUser(row), stats: userStats(row.id) })),
  };
}

function normalizePermissions(value, role) {
  if (role === 'admin') {
    const perms = parsePermissions(value);
    if (perms.includes('*')) return ['*'];
    const allowed = ['users', 'configs', 'inbounds', 'servers', 'tickets', 'stats', 'settings', 'backups', 'audit', 'broadcasts'];
    return perms.filter((p) => allowed.includes(p));
  }
  return [];
}

function validateUserPayload(data, { partial = false } = {}) {
  const out = {};
  if (data.username !== undefined || !partial) {
    const username = String(data.username || '').trim();
    if (!USERNAME_RE.test(username)) {
      throw new ApiError(422, 'invalid_username', 'Username must be 3-32 characters (letters, digits, . _ -)');
    }
    out.username = username;
  }
  if (data.password !== undefined && data.password !== '') {
    if (String(data.password).length < 8) {
      throw new ApiError(422, 'weak_password', 'Password must be at least 8 characters');
    }
    out.password = String(data.password);
  } else if (!partial) {
    throw new ApiError(422, 'password_required', 'Password is required');
  }
  for (const [key, max] of [['name', 80], ['email', 120], ['phone', 32], ['note', 500]]) {
    if (data[key] !== undefined) out[key] = String(data[key] || '').slice(0, max);
  }
  if (data.telegram_id !== undefined || data.telegramId !== undefined) {
    // Numeric Telegram user id only; a leading @ is tolerated because admins
    // often paste the handle form. It names new clients and finds existing ones.
    const raw = String(data.telegram_id ?? data.telegramId ?? '').trim().replace(/^@/, '');
    if (raw && !/^\d{4,20}$/.test(raw)) {
      throw new ApiError(422, 'invalid_telegram_id', 'شناسه تلگرام باید عددی و بین ۴ تا ۲۰ رقم باشد / Telegram ID must be 4-20 digits');
    }
    out.telegram_id = raw;
  }
  if (data.import_configs !== undefined || data.importConfigs !== undefined) {
    const value = data.import_configs ?? data.importConfigs;
    out.import_configs = value === false || value === 0 || value === '0' ? 0 : 1;
  }
  if (data.email !== undefined && out.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) {
    throw new ApiError(422, 'invalid_email', 'Email address is not valid');
  }
  if (data.role !== undefined) {
    if (!['admin', 'reseller'].includes(data.role)) throw new ApiError(422, 'invalid_role', 'Invalid role');
    out.role = data.role;
  }
  if (data.status !== undefined) {
    if (!['active', 'disabled'].includes(data.status)) throw new ApiError(422, 'invalid_status', 'Invalid status');
    out.status = data.status;
  }
  if (data.lang !== undefined) out.lang = data.lang === 'en' ? 'en' : 'fa';
  if (data.permissions !== undefined) out.permissions = normalizePermissions(data.permissions, out.role || data.role || 'reseller');
  for (const field of ['max_configs', 'max_total_gb', 'max_gb_per_config', 'max_days_per_config', 'balance']) {
    if (data[field] !== undefined) {
      const n = Number(data[field]);
      if (!Number.isFinite(n) || n < 0) throw new ApiError(422, 'invalid_limit', `${field} must be a non-negative number`);
      out[field] = field === 'balance' ? Math.round(n) : n;
    }
  }
  if (data.allowed_inbounds !== undefined) {
    const arr = Array.isArray(data.allowed_inbounds) ? data.allowed_inbounds : safeJsonParse(data.allowed_inbounds, []);
    out.allowed_inbounds = JSON.stringify(arr.map(Number).filter((n) => Number.isFinite(n)));
  }
  // Panel v1.4.16: one inbound is the FIXED base of this reseller's packages.
  // 0 = "no fixed inbound" (keeps the old free-for-all behaviour); otherwise it
  // must be an inbound the panel actually knows about and that is still enabled,
  // because a locked inbound that cannot accept clients would break every
  // package it belongs to.
  const fixedRaw = data.fixed_inbound ?? data.fixedInbound;
  if (fixedRaw !== undefined) {
    const fixedId = Number(fixedRaw || 0);
    if (!Number.isInteger(fixedId) || fixedId < 0) {
      throw new ApiError(422, 'invalid_fixed_inbound', 'اینباند ثابت نامعتبر است / Invalid fixed inbound');
    }
    if (fixedId > 0) {
      const inbound = getDb().prepare('SELECT id, enabled, remark FROM inbounds WHERE id = ?').get(fixedId);
      if (!inbound) throw new ApiError(422, 'invalid_fixed_inbound', 'این اینباند در پنل وجود ندارد / Fixed inbound not found');
      if (!inbound.enabled) {
        throw new ApiError(422, 'fixed_inbound_disabled', `اینباند «${inbound.remark}» غیرفعال است / The fixed inbound is disabled`);
      }
    }
    out.fixed_inbound = fixedId;
  }
  // The fixed inbound is always usable: silently add it to a non-empty allow
  // list so the create form can pre-select it without the admin ticking twice.
  if (out.fixed_inbound > 0 && out.allowed_inbounds !== undefined) {
    const ids = safeJsonParse(out.allowed_inbounds, []);
    if (ids.length && !ids.includes(out.fixed_inbound)) {
      out.allowed_inbounds = JSON.stringify([...ids, out.fixed_inbound]);
    }
  }
  return out;
}

function reviveUser(id, clean, req) {
  const db = getDb();
  const previous = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!previous) throw new ApiError(409, 'username_taken', 'This username is already in use');
  const now = Date.now();
  const keep = (field, fallback) => (clean[field] !== undefined ? clean[field] : fallback);
  db.prepare(
    `UPDATE users SET
       username = ?, password_hash = ?, role = ?, name = ?, email = ?, phone = ?, telegram_id = ?, import_configs = ?,
       status = ?, lang = ?, permissions = ?, max_configs = ?, max_total_gb = ?, max_gb_per_config = ?,
       max_days_per_config = ?, allowed_inbounds = ?, fixed_inbound = ?, balance = ?, note = ?,
       deleted_at = 0, token_version = token_version + 1, updated_at = ?
     WHERE id = ?`
  ).run(
    clean.username,
    hashPassword(clean.password),
    keep('role', previous.role),
    keep('name', previous.name),
    keep('email', previous.email),
    keep('phone', previous.phone),
    keep('telegram_id', previous.telegram_id),
    clean.import_configs === undefined ? Number(previous.import_configs ?? 1) : Number(clean.import_configs),
    keep('status', 'active') || 'active',
    keep('lang', previous.lang),
    clean.permissions !== undefined
      ? JSON.stringify(clean.permissions)
      : (previous.permissions || JSON.stringify(clean.role === 'admin' ? ['*'] : [])),
    keep('max_configs', previous.max_configs),
    keep('max_total_gb', previous.max_total_gb),
    keep('max_gb_per_config', previous.max_gb_per_config),
    keep('max_days_per_config', previous.max_days_per_config),
    keep('allowed_inbounds', previous.allowed_inbounds || '[]'),
    keep('fixed_inbound', Number(previous.fixed_inbound || 0)),
    keep('balance', previous.balance),
    keep('note', previous.note),
    now,
    Number(id)
  );
  // deleteUser() stamps the user row and the configs it hid with one timestamp,
  // so matching it restores exactly that batch and never brings back a config
  // the owner removed on its own.
  const restored = db.prepare('UPDATE configs SET deleted_at = 0 WHERE user_id = ? AND deleted_at = ?')
    .run(Number(id), previous.deleted_at).changes;
  audit(req, 'user.revive', 'user', Number(id), { username: clean.username, role: keep('role', previous.role), restoredConfigs: restored });
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
}

function createUser(data, req) {
  const db = getDb();
  const clean = validateUserPayload(data, { partial: false });
  const existing = db.prepare('SELECT id, deleted_at, status FROM users WHERE username = ? COLLATE NOCASE').get(clean.username);
  if (existing && existing.deleted_at === 0) throw new ApiError(409, 'username_taken', 'This username is already in use');
  if (clean.telegram_id) {
    const taken = db.prepare('SELECT id FROM users WHERE telegram_id = ? AND deleted_at = 0').get(clean.telegram_id);
    if (taken) throw new ApiError(409, 'telegram_id_taken', 'این شناسه تلگرام قبلاً برای نماینده دیگری ثبت شده است / This Telegram ID already belongs to another user');
  }
  // A deleted reseller keeps its row — and usernames are UNIQUE in the table —
  // so saving the same name again revives that account instead of failing. The
  // owner gets the same id, wallet history and tickets back with the new
  // password, and only the configs that the deletion itself hid return with it.
  if (existing) return reviveUser(existing.id, clean, req);
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO users (username, password_hash, role, name, email, phone, telegram_id, import_configs, status, lang, permissions,
      max_configs, max_total_gb, max_gb_per_config, max_days_per_config, allowed_inbounds, fixed_inbound,
      balance, api_key, note, token_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(
    clean.username,
    hashPassword(clean.password),
    clean.role || 'reseller',
    clean.name || '',
    clean.email || '',
    clean.phone || '',
    clean.telegram_id || '',
    clean.import_configs === undefined ? 1 : Number(clean.import_configs),
    clean.status || 'active',
    clean.lang || 'fa',
    JSON.stringify(clean.permissions || (clean.role === 'admin' ? ['*'] : [])),
    Number(clean.max_configs || 0),
    Number(clean.max_total_gb || 0),
    Number(clean.max_gb_per_config || 0),
    Number(clean.max_days_per_config || 0),
    clean.allowed_inbounds || '[]',
    Number(clean.fixed_inbound || 0),
    Number(clean.balance || 0),
    null,
    clean.note || '',
    now,
    now
  );
  const row = getUser(info.lastInsertRowid);
  audit(req, 'user.create', 'user', row.id, { username: row.username, role: row.role });
  return row;
}

function updateUser(id, data, req) {
  const db = getDb();
  const current = getUser(id);
  if (!current) throw new ApiError(404, 'not_found', 'User not found');
  const clean = validateUserPayload(data, { partial: true });
  if (clean.username && clean.username.toLowerCase() !== current.username.toLowerCase()) {
    const clash = db.prepare('SELECT id, deleted_at FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(clean.username, Number(id));
    if (clash && clash.deleted_at === 0) throw new ApiError(409, 'username_taken', 'This username is already in use');
    if (clash) {
      throw new ApiError(409, 'username_taken_deleted', 'این نام کاربری متعلق به یک نمایندگی حذف‌شده است / This username belongs to a deleted reseller');
    }
  }
  if (clean.telegram_id && clean.telegram_id !== String(current.telegram_id || '')) {
    const clash = db.prepare('SELECT id FROM users WHERE telegram_id = ? AND deleted_at = 0 AND id != ?').get(clean.telegram_id, Number(id));
    if (clash) throw new ApiError(409, 'telegram_id_taken', 'این شناسه تلگرام قبلاً برای نماینده دیگری ثبت شده است / This Telegram ID already belongs to another user');
  }
  if (current.role === 'admin' && clean.role === 'reseller') {
    const owners = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND permissions LIKE '%\"*\"%' AND deleted_at = 0 AND status = 'active'").get().c;
    if (owners <= 1 && parsePermissions(current.permissions).includes('*')) {
      throw new ApiError(422, 'last_owner', 'You cannot demote the only owner account');
    }
  }
  const fields = [];
  const values = [];
  const assign = (column, value) => { fields.push(`${column} = ?`); values.push(value); };
  if (clean.username) assign('username', clean.username);
  if (clean.password) { assign('password_hash', hashPassword(clean.password)); assign('token_version', Number(current.token_version || 1) + 1); }
  for (const key of ['name', 'email', 'phone', 'note', 'role', 'status', 'lang', 'telegram_id', 'import_configs']) {
    if (clean[key] !== undefined) assign(key, clean[key]);
  }
  if (clean.permissions !== undefined) assign('permissions', JSON.stringify(clean.permissions));
  for (const key of ['max_configs', 'max_total_gb', 'max_gb_per_config', 'max_days_per_config', 'balance']) {
    if (clean[key] !== undefined) assign(key, clean[key]);
  }
  // The fixed inbound is the guaranteed base of this reseller's packages, so it
  // must never end up outside an explicit allow list — whichever half of the
  // pair the admin edited. An empty list means "everything visible" anyway.
  const effectiveFixed = clean.fixed_inbound !== undefined
    ? Number(clean.fixed_inbound || 0)
    : Number(current.fixed_inbound || 0);
  if (clean.allowed_inbounds !== undefined) {
    const ids = safeJsonParse(clean.allowed_inbounds, []);
    assign('allowed_inbounds', effectiveFixed > 0 && ids.length && !ids.includes(effectiveFixed)
      ? JSON.stringify([...ids, effectiveFixed])
      : clean.allowed_inbounds);
  }
  if (clean.fixed_inbound !== undefined) {
    assign('fixed_inbound', clean.fixed_inbound);
    if (effectiveFixed > 0 && clean.allowed_inbounds === undefined) {
      const currentIds = safeJsonParse(current.allowed_inbounds, []);
      if (currentIds.length && !currentIds.includes(effectiveFixed)) {
        assign('allowed_inbounds', JSON.stringify([...currentIds, effectiveFixed]));
      }
    }
  }
  if (!fields.length) return current;
  assign('updated_at', Date.now());
  if (clean.status && clean.status !== 'active') assign('token_version', Number(current.token_version || 1) + 1);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values, Number(id));
  audit(req, 'user.update', 'user', Number(id), { fields: fields.map((f) => f.split(' ')[0]) });
  return getUser(id);
}

function deleteUser(id, { purgeConfigs = false } = {}, req) {
  const db = getDb();
  const user = getUser(id);
  if (!user) throw new ApiError(404, 'not_found', 'User not found');
  if (user.role === 'admin' && parsePermissions(user.permissions).includes('*')) {
    const owners = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND permissions LIKE '%\"*\"%' AND deleted_at = 0 AND status = 'active'").get().c;
    if (owners <= 1) throw new ApiError(422, 'last_owner', 'You cannot delete the only owner account');
  }
  let removed = 0;
  if (purgeConfigs) {
    // eslint-disable-next-line global-require
    const configsService = require('./configs');
    const configs = db.prepare('SELECT * FROM configs WHERE user_id = ? AND deleted_at = 0').all(Number(id));
    for (const cfg of configs) {
      try {
        configsService.removeConfig(cfg.id, { hard: true, silent: true, force: true }, req);
        removed += 1;
      } catch (err) {
        console.error(`[users] failed to remove config ${cfg.email}:`, err.message);
      }
    }
  }
  const now = Date.now();
  db.prepare('UPDATE users SET deleted_at = ?, status = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?')
    .run(now, 'disabled', now, Number(id));
  db.prepare('UPDATE configs SET deleted_at = ? WHERE user_id = ? AND deleted_at = 0 AND ? = 0').run(now, Number(id), purgeConfigs ? 1 : 0);
  audit(req, 'user.delete', 'user', Number(id), { username: user.username, purgeConfigs, removed });
  return { ok: true, removed };
}

function setStatus(id, status, req) {
  if (!['active', 'disabled'].includes(status)) throw new ApiError(422, 'invalid_status', 'Invalid status');
  return updateUser(id, { status }, req);
}

function regenerateApiKey(id, req) {
  const db = getDb();
  const user = getUser(id);
  if (!user) throw new ApiError(404, 'not_found', 'User not found');
  const key = `sc_${randomToken(40)}`;
  db.prepare('UPDATE users SET api_key = ?, updated_at = ? WHERE id = ?').run(key, Date.now(), Number(id));
  audit(req, 'user.api_key', 'user', Number(id), {});
  return { apiKey: key };
}

function adjustBalance(id, amount, description, req) {
  const db = getDb();
  const user = getUser(id);
  if (!user) throw new ApiError(404, 'not_found', 'User not found');
  const delta = Math.round(Number(amount || 0));
  if (!Number.isFinite(delta) || delta === 0) throw new ApiError(422, 'invalid_amount', 'Amount must be a non-zero number');
  const next = Number(user.balance || 0) + delta;
  if (next < 0) throw new ApiError(422, 'insufficient_balance', 'Balance cannot become negative');
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET balance = ?, updated_at = ? WHERE id = ?').run(next, now, Number(id));
    db.prepare(
      'INSERT INTO transactions (user_id, type, amount, balance_after, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(Number(id), delta > 0 ? 'credit' : 'debit', Math.abs(delta), next, String(description || ''), req?.user?.id || 0, now);
  });
  tx();
  audit(req, 'user.balance', 'user', Number(id), { delta, balance: next, description });
  return { balance: next, transaction: delta };
}

// `count` is how many new customer packages this action adds: one per order,
// zero when an inbound is appended to a customer who already exists.
function checkLimits(user, { gb = 0, days = 0, count: adding = 1, gbEach = 0 } = {}) {
  const db = getDb();
  const row = db.prepare(
    `SELECT COUNT(*) AS packages, COALESCE(SUM(quota), 0) AS quota
     FROM (
       SELECT ${CONFIG_GROUP_KEY_SQL} AS gkey, MAX(c.total_bytes) AS quota
       FROM configs c WHERE c.user_id = ? AND c.deleted_at = 0
         AND c.origin <> 'external'
       GROUP BY gkey
     )`
  ).get(Number(user.id));
  const count = Number(row.packages || 0);
  const quota = Number(row.quota || 0);
  const maxConfigs = Number(user.max_configs || 0);
  const addPackages = Math.max(0, Number(adding || 0));
  if (maxConfigs > 0 && count + addPackages > maxConfigs) {
    throw new ApiError(403, 'limit_configs', `Config limit reached (${maxConfigs})`);
  }
  const gbBytes = Math.round(Number(gb || 0) * 1024 * 1024 * 1024);
  const perConfig = Number(user.max_gb_per_config || 0);
  const singleGb = Number(gbEach || gb || 0);
  if (perConfig > 0 && singleGb > 0 && singleGb > perConfig) {
    throw new ApiError(403, 'limit_gb_per_config', `Maximum ${perConfig} GB per config`);
  }
  const daysPerConfig = Number(user.max_days_per_config || 0);
  if (daysPerConfig > 0 && days > 0 && days > daysPerConfig) {
    throw new ApiError(403, 'limit_days_per_config', `Maximum ${daysPerConfig} days per config`);
  }
  const totalMax = Number(user.max_total_gb || 0);
  if (totalMax > 0 && gb > 0 && (quota + gbBytes) > Math.round(totalMax * 1024 * 1024 * 1024)) {
    throw new ApiError(403, 'limit_total_gb', `Total traffic limit reached (${totalMax} GB)`);
  }
  return { count, quota };
}

function allowedInboundIds(user) {
  const ids = safeJsonParse(user.allowed_inbounds, []);
  if (!Array.isArray(ids) || !ids.length) return null; // null = all
  return ids.map(Number).filter((n) => Number.isFinite(n));
}

// 0 = this reseller has no fixed inbound. Otherwise the id is the base every
// package of theirs must carry: create forms pre-select it, the edit drawer
// locks it, and the heal pass adds it to legacy subscriptions that lack it.
function fixedInboundId(user) {
  return Number(user?.fixed_inbound || 0) || 0;
}

module.exports = {
  USERNAME_RE,
  getUser,
  getUserByUsername,
  usernameHolder,
  userStats,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  setStatus,
  regenerateApiKey,
  adjustBalance,
  checkLimits,
  allowedInboundIds,
  fixedInboundId,
  normalizePermissions,
};

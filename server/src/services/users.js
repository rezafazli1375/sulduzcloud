'use strict';

const { getDb } = require('../db');
const { hashPassword } = require('../auth');
const { ApiError, sanitizeUser, parsePermissions, safeJsonParse, randomToken, escapeLike, CONFIG_GROUP_KEY_SQL } = require('../utils');
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

function userStats(userId) {
  const db = getDb();
  const row = db.prepare(
    `SELECT COUNT(*) AS configs,
            COALESCE(SUM(CASE WHEN enabled = 1 AND (expiry_at = 0 OR expiry_at > ?) AND (total_bytes = 0 OR up_bytes + down_bytes < total_bytes) THEN 1 ELSE 0 END), 0) AS active,
            COALESCE(SUM(total_bytes), 0) AS quota,
            COALESCE(SUM(up_bytes + down_bytes), 0) AS used
     FROM configs WHERE user_id = ? AND deleted_at = 0`
  ).get(Date.now(), Number(userId));
  // Row counts above stay for API v1, which is documented as one row per inbound.
  // Packages are the customer-facing unit: every inbound of one subscription is
  // a single customer, exactly like the grouped config list and the dashboard.
  const packages = db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN active_n = members THEN 1 ELSE 0 END), 0) AS active
     FROM (
       SELECT ${CONFIG_GROUP_KEY_SQL} AS gkey, COUNT(*) AS members,
         SUM(CASE WHEN c.enabled = 1 AND (c.expiry_at = 0 OR c.expiry_at > ${Date.now()})
                   AND (c.total_bytes = 0 OR c.up_bytes + c.down_bytes < c.total_bytes) THEN 1 ELSE 0 END) AS active_n
       FROM configs c WHERE c.user_id = ? AND c.deleted_at = 0
       GROUP BY gkey
     )`
  ).get(Number(userId));
  return {
    configs: Number(row.configs || 0),
    active: Number(row.active || 0),
    packages: Number(packages.total || 0),
    activePackages: Number(packages.active || 0),
    quotaBytes: Number(row.quota || 0),
    usedBytes: Number(row.used || 0),
  };
}

function listUsers({ search = '', status = '', role = '', page = 1, pageSize = 20 } = {}) {
  const db = getDb();
  const where = ['u.deleted_at = 0'];
  const params = [];
  if (search) {
    where.push('(u.username LIKE ? ESCAPE \'\\\' OR u.name LIKE ? ESCAPE \'\\\' OR u.email LIKE ? ESCAPE \'\\\' OR u.phone LIKE ? ESCAPE \'\\\')');
    const like = `%${escapeLike(search)}%`;
    params.push(like, like, like, like);
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
  return out;
}

function createUser(data, req) {
  const db = getDb();
  const clean = validateUserPayload(data, { partial: false });
  const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(clean.username);
  if (existing) throw new ApiError(409, 'username_taken', 'This username is already in use');
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO users (username, password_hash, role, name, email, phone, status, lang, permissions,
      max_configs, max_total_gb, max_gb_per_config, max_days_per_config, allowed_inbounds,
      balance, api_key, note, token_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(
    clean.username,
    hashPassword(clean.password),
    clean.role || 'reseller',
    clean.name || '',
    clean.email || '',
    clean.phone || '',
    clean.status || 'active',
    clean.lang || 'fa',
    JSON.stringify(clean.permissions || (clean.role === 'admin' ? ['*'] : [])),
    Number(clean.max_configs || 0),
    Number(clean.max_total_gb || 0),
    Number(clean.max_gb_per_config || 0),
    Number(clean.max_days_per_config || 0),
    clean.allowed_inbounds || '[]',
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
    const clash = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(clean.username, Number(id));
    if (clash) throw new ApiError(409, 'username_taken', 'This username is already in use');
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
  for (const key of ['name', 'email', 'phone', 'note', 'role', 'status', 'lang']) {
    if (clean[key] !== undefined) assign(key, clean[key]);
  }
  if (clean.permissions !== undefined) assign('permissions', JSON.stringify(clean.permissions));
  for (const key of ['max_configs', 'max_total_gb', 'max_gb_per_config', 'max_days_per_config', 'balance']) {
    if (clean[key] !== undefined) assign(key, clean[key]);
  }
  if (clean.allowed_inbounds !== undefined) assign('allowed_inbounds', clean.allowed_inbounds);
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
        configsService.removeConfig(cfg.id, { hard: true, silent: true }, req);
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
    `SELECT COUNT(*) AS packages, COALESCE(SUM(total_bytes), 0) AS quota
     FROM (
       SELECT ${CONFIG_GROUP_KEY_SQL} AS gkey, SUM(c.total_bytes) AS total_bytes
       FROM configs c WHERE c.user_id = ? AND c.deleted_at = 0
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

module.exports = {
  USERNAME_RE,
  getUser,
  getUserByUsername,
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
  normalizePermissions,
};

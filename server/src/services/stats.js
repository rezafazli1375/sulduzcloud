'use strict';

const { getDb } = require('../db');
const { dayKey, statusOf, CONFIG_GROUP_KEY_SQL } = require('../utils');

const DAY_MS = 86400000;

function dayRange(days) {
  const out = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i -= 1) out.push(dayKey(now - i * DAY_MS));
  return out;
}

// Counts customers (packages), not x-ui clients: a two-inbound package is one
// customer. A package is ONE shared traffic pool (like a 3x-ui subscription):
// its quota is the largest member quota and its usage is the sum of every
// member's counters. Status follows the package, not each inbound; partially
// inconsistent members (manual disable, mixed expiry) are reported as `mixed`.
function statusCounts(userId = 0) {
  const db = getDb();
  const scope = userId ? 'AND c.user_id = ?' : '';
  const params = userId ? [Number(userId)] : [];
  const now = Date.now();
  const activeMember = `c.enabled = 1 AND (c.expiry_at = 0 OR c.expiry_at > ${now})
                   AND (c.total_bytes = 0 OR c.up_bytes + c.down_bytes < c.total_bytes)`;
  const row = db.prepare(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN expiry_at > 0 AND expiry_at <= ${now} THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN (expiry_at = 0 OR expiry_at > ${now}) AND quota > 0 AND used >= quota THEN 1 ELSE 0 END) AS depleted,
      SUM(CASE WHEN (expiry_at = 0 OR expiry_at > ${now}) AND (quota = 0 OR used < quota)
                AND disabled_n = members THEN 1 ELSE 0 END) AS disabled,
      SUM(CASE WHEN (expiry_at = 0 OR expiry_at > ${now}) AND (quota = 0 OR used < quota)
                AND disabled_n < members AND active_n = members THEN 1 ELSE 0 END) AS active,
      COALESCE(SUM(used), 0) AS used,
      COALESCE(SUM(quota), 0) AS quota
     FROM (
       SELECT ${CONFIG_GROUP_KEY_SQL} AS gkey,
         COUNT(*) AS members,
         SUM(CASE WHEN ${activeMember} THEN 1 ELSE 0 END) AS active_n,
         SUM(CASE WHEN c.enabled = 0 THEN 1 ELSE 0 END) AS disabled_n,
         MAX(c.expiry_at) AS expiry_at,
         MAX(c.total_bytes) AS quota,
         SUM(c.up_bytes + c.down_bytes) AS used
       FROM configs c WHERE c.deleted_at = 0 ${scope}
       GROUP BY gkey
     )`
  ).get(...params);
  const total = Number(row.total || 0);
  const active = Number(row.active || 0);
  const expired = Number(row.expired || 0);
  const depleted = Number(row.depleted || 0);
  const disabled = Number(row.disabled || 0);
  return {
    total,
    active,
    expired,
    depleted,
    disabled,
    mixed: Math.max(0, total - active - expired - depleted - disabled),
    usedBytes: Number(row.used || 0),
    quotaBytes: Number(row.quota || 0),
  };
}

function trafficSeries(days = 14, userId = 0) {
  const db = getDb();
  const keys = dayRange(days);
  const from = keys[0];
  const scope = userId ? 'AND user_id = ?' : '';
  const params = userId ? [Number(userId)] : [];
  const rows = db.prepare(
    `SELECT day, SUM(up_bytes) AS up, SUM(down_bytes) AS down
     FROM usage_daily WHERE day >= ? ${scope} GROUP BY day`
  ).all(from, ...params);
  const map = new Map(rows.map((r) => [r.day, r]));
  return keys.map((day) => {
    const row = map.get(day) || {};
    return {
      day,
      up: Number(row.up || 0),
      down: Number(row.down || 0),
      total: Number(row.up || 0) + Number(row.down || 0),
    };
  });
}

function sumRange(days, userId = 0) {
  const db = getDb();
  const from = dayKey(Date.now() - (days - 1) * DAY_MS);
  const scope = userId ? 'AND user_id = ?' : '';
  const params = userId ? [Number(userId)] : [];
  const row = db.prepare(
    `SELECT COALESCE(SUM(up_bytes), 0) AS up, COALESCE(SUM(down_bytes), 0) AS down
     FROM usage_daily WHERE day >= ? ${scope}`
  ).get(from, ...params);
  return { up: Number(row.up || 0), down: Number(row.down || 0), total: Number(row.up || 0) + Number(row.down || 0) };
}

function topUsers(days = 7, limit = 8) {
  const db = getDb();
  const from = dayKey(Date.now() - (days - 1) * DAY_MS);
  const rows = db.prepare(
    `SELECT u.id, u.username, u.name, SUM(d.up_bytes + d.down_bytes) AS used
     FROM usage_daily d JOIN users u ON u.id = d.user_id
     WHERE d.day >= ? AND u.deleted_at = 0
     GROUP BY u.id ORDER BY used DESC LIMIT ?`
  ).all(from, Number(limit));
  return rows.map((r) => ({ id: r.id, username: r.username, name: r.name, usedBytes: Number(r.used || 0) }));
}

function topConfigs(days = 7, limit = 8, userId = 0) {
  const db = getDb();
  const from = dayKey(Date.now() - (days - 1) * DAY_MS);
  const scope = userId ? 'AND d.user_id = ?' : '';
  const params = userId ? [Number(userId)] : [];
  const rows = db.prepare(
    `SELECT c.id, c.email, c.label, c.customer_name, SUM(d.up_bytes + d.down_bytes) AS used
     FROM usage_daily d JOIN configs c ON c.id = d.config_id
     WHERE d.day >= ? ${scope} GROUP BY c.id ORDER BY used DESC LIMIT ?`
  ).all(from, ...params, Number(limit));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    label: r.label,
    customerName: r.customer_name,
    usedBytes: Number(r.used || 0),
  }));
}

function inboundBreakdown(userId = 0) {
  const db = getDb();
  const scope = userId ? 'AND c.user_id = ?' : '';
  const params = userId ? [Number(userId)] : [];
  const rows = db.prepare(
    `SELECT i.id, i.remark, i.protocol, i.node_name, COUNT(c.id) AS configs,
       COALESCE(SUM(c.up_bytes + c.down_bytes), 0) AS used
     FROM inbounds i LEFT JOIN configs c ON c.inbound_id = i.id AND c.deleted_at = 0 ${scope}
     GROUP BY i.id ORDER BY configs DESC`
  ).all(...params);
  return rows.map((r) => ({
    id: r.id,
    remark: r.remark,
    protocol: r.protocol,
    nodeName: r.node_name,
    configs: Number(r.configs || 0),
    usedBytes: Number(r.used || 0),
  }));
}

function expiringSoon(days = 3, userId = 0) {
  const db = getDb();
  const now = Date.now();
  const scope = userId ? 'AND c.user_id = ?' : '';
  const params = userId ? [Number(userId)] : [];
  // One customer package counts once even when several inbounds expire together.
  return db.prepare(
    `SELECT COUNT(*) AS c FROM (
       SELECT ${CONFIG_GROUP_KEY_SQL} AS gkey FROM configs c
       WHERE c.deleted_at = 0 AND c.enabled = 1 AND c.expiry_at > ? AND c.expiry_at <= ? ${scope}
       GROUP BY gkey
     )`
  ).get(now, now + days * DAY_MS, ...params).c;
}

function revenue(days = 30) {
  const db = getDb();
  const from = Date.now() - days * DAY_MS;
  const row = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS spent,
            COUNT(*) AS transactions
     FROM transactions WHERE created_at >= ?`
  ).get(from);
  return { spent: Number(row.spent || 0), transactions: Number(row.transactions || 0) };
}

function adminOverview() {
  const db = getDb();
  const users = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN role = 'reseller' THEN 1 ELSE 0 END) AS resellers,
       SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins,
       SUM(CASE WHEN status = 'active' AND role = 'reseller' THEN 1 ELSE 0 END) AS active
     FROM users WHERE deleted_at = 0`
  ).get();
  const tickets = db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE status = 'open'").get().c;
  return {
    users: {
      total: Number(users.total || 0),
      resellers: Number(users.resellers || 0),
      admins: Number(users.admins || 0),
      active: Number(users.active || 0),
    },
    configs: statusCounts(),
    today: sumRange(1),
    week: sumRange(7),
    month: sumRange(30),
    expiring3d: expiringSoon(3),
    openTickets: Number(tickets || 0),
    series: trafficSeries(14),
    topUsers: topUsers(7),
    inbounds: inboundBreakdown(),
    revenue: revenue(30),
  };
}

function resellerOverview(userId) {
  const db = getDb();
  const stats = statusCounts(userId);
  const user = db.prepare('SELECT balance, max_configs, max_total_gb, max_gb_per_config, max_days_per_config FROM users WHERE id = ?')
    .get(Number(userId)) || {};
  const openTickets = db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE user_id = ? AND status != 'closed'").get(Number(userId)).c;
  return {
    configs: stats,
    today: sumRange(1, userId),
    week: sumRange(7, userId),
    month: sumRange(30, userId),
    expiring3d: expiringSoon(3, userId),
    series: trafficSeries(14, userId),
    topConfigs: topConfigs(7, 6, userId),
    inbounds: inboundBreakdown(userId),
    balance: Number(user.balance || 0),
    limits: {
      maxConfigs: Number(user.max_configs || 0),
      maxTotalGb: Number(user.max_total_gb || 0),
      maxGbPerConfig: Number(user.max_gb_per_config || 0),
      maxDaysPerConfig: Number(user.max_days_per_config || 0),
    },
    openTickets: Number(openTickets || 0),
  };
}

function refreshStatuses() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM configs WHERE deleted_at = 0').all();
  const update = db.prepare('UPDATE configs SET status = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const row of rows) update.run(statusOf(row), row.id);
  });
  tx();
}

module.exports = {
  statusCounts,
  trafficSeries,
  sumRange,
  topUsers,
  topConfigs,
  inboundBreakdown,
  expiringSoon,
  revenue,
  adminOverview,
  resellerOverview,
  refreshStatuses,
  dayRange,
};

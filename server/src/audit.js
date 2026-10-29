'use strict';

const { getDb } = require('./db');

function audit(req, action, entity, entityId, details = {}) {
  try {
    const db = getDb();
    const user = req && req.user;
    const headers = (req && req.headers) || {};
    const forwarded = headers['x-forwarded-for'] || '';
    const ip = req ? String(req.ip || forwarded || '').split(',')[0].trim() : '';
    let ua = headers['user-agent'] || '';
    if (!ua && req && typeof req.get === 'function') {
      try { ua = req.get('user-agent') || ''; } catch (_) {}
    }
    db.prepare(
      `INSERT INTO audit_logs (user_id, role, action, entity, entity_id, details, ip, ua, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      user ? user.id : 0,
      user ? user.role : 'system',
      String(action || 'unknown'),
      String(entity || ''),
      entityId === undefined || entityId === null ? '' : String(entityId),
      JSON.stringify(details || {}),
      ip,
      String(ua).slice(0, 300),
      Date.now()
    );
  } catch (err) {
    console.error('[audit] failed:', err.message);
  }
}

function systemAudit(action, entity, entityId, details) {
  return audit(null, action, entity, entityId, details);
}

function listAudit({ page = 1, pageSize = 30, userId = 0, action = '', entity = '' } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (userId) { where.push('a.user_id = ?'); params.push(Number(userId)); }
  if (action) { where.push('a.action = ?'); params.push(action); }
  if (entity) { where.push('a.entity = ?'); params.push(entity); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs a ${clause}`).get(...params).c;
  const rows = db.prepare(
    `SELECT a.*, u.username
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     ${clause} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username || 'system',
      role: r.role,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      details: (() => { try { return JSON.parse(r.details || '{}'); } catch (_) { return {}; } })(),
      ip: r.ip,
      ua: r.ua,
      createdAt: r.created_at,
    })),
  };
}

module.exports = { audit, systemAudit, listAudit };

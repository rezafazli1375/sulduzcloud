'use strict';

const { getDb } = require('../db');
const { ApiError } = require('../utils');
const { audit } = require('../audit');
const { notifyAdmins, notifyUser } = require('../notify');

function listTickets({ viewer, status = '', page = 1, pageSize = 20 } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (viewer && viewer.role !== 'admin') { where.push('t.user_id = ?'); params.push(Number(viewer.id)); }
  if (status) { where.push('t.status = ?'); params.push(String(status)); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM tickets t ${clause}`).get(...params).c;
  const rows = db.prepare(
    `SELECT t.*, u.username, u.name,
       (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count,
       (SELECT m.body FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
     FROM tickets t JOIN users u ON u.id = t.user_id ${clause}
     ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`
  ).all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      name: r.name,
      subject: r.subject,
      status: r.status,
      priority: r.priority,
      lastReplyBy: r.last_reply_by,
      messageCount: Number(r.message_count || 0),
      lastMessage: String(r.last_message || '').slice(0, 160),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  };
}

function getTicket(id, viewer) {
  const db = getDb();
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(id));
  if (!ticket) throw new ApiError(404, 'not_found', 'Ticket not found');
  if (viewer && viewer.role !== 'admin' && Number(ticket.user_id) !== Number(viewer.id)) {
    throw new ApiError(403, 'forbidden', 'You do not have access to this ticket');
  }
  const messages = db.prepare(
    `SELECT m.*, u.username, u.name FROM ticket_messages m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.ticket_id = ? ORDER BY m.created_at ASC`
  ).all(Number(id));
  if (viewer && viewer.role === 'admin') {
    db.prepare('UPDATE ticket_messages SET read_by_admin = 1 WHERE ticket_id = ?').run(Number(id));
  } else {
    db.prepare('UPDATE ticket_messages SET read_by_user = 1 WHERE ticket_id = ?').run(Number(id));
  }
  return {
    ...ticket,
    messages: messages.map((m) => ({
      id: m.id,
      body: m.body,
      isStaff: Boolean(m.is_staff),
      username: m.username,
      createdAt: m.created_at,
    })),
  };
}

function createTicket({ subject, body, priority = 'normal' }, req) {
  const db = getDb();
  const title = String(subject || '').trim().slice(0, 140);
  const text = String(body || '').trim().slice(0, 4000);
  if (!title) throw new ApiError(422, 'subject_required', 'Subject is required');
  if (!text) throw new ApiError(422, 'body_required', 'Message body is required');
  const now = Date.now();
  const tx = db.transaction(() => {
    const info = db.prepare(
      'INSERT INTO tickets (user_id, subject, status, priority, last_reply_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.user.id, title, 'open', ['low', 'normal', 'high'].includes(priority) ? priority : 'normal', 'user', now, now);
    db.prepare(
      'INSERT INTO ticket_messages (ticket_id, user_id, body, is_staff, read_by_admin, read_by_user, created_at) VALUES (?, ?, ?, 0, 0, 1, ?)'
    ).run(info.lastInsertRowid, req.user.id, text, now);
    notifyAdmins({
      type: 'ticket',
      title: `تیکت جدید: ${title}`,
      body: `از طرف ${req.user.username}`,
      link: `/admin/tickets/${info.lastInsertRowid}`,
    });
    return info.lastInsertRowid;
  });
  const id = tx();
  audit(req, 'ticket.create', 'ticket', id, { subject: title });
  return getTicket(id, req.user);
}

function replyTicket(id, body, req) {
  const db = getDb();
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(id));
  if (!ticket) throw new ApiError(404, 'not_found', 'Ticket not found');
  const isStaff = req.user.role === 'admin';
  if (!isStaff && Number(ticket.user_id) !== Number(req.user.id)) {
    throw new ApiError(403, 'forbidden', 'You do not have access to this ticket');
  }
  if (ticket.status === 'closed') throw new ApiError(422, 'ticket_closed', 'This ticket is closed');
  const text = String(body || '').trim().slice(0, 4000);
  if (!text) throw new ApiError(422, 'body_required', 'Message body is required');
  const now = Date.now();
  db.prepare(
    'INSERT INTO ticket_messages (ticket_id, user_id, body, is_staff, read_by_admin, read_by_user, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(Number(id), req.user.id, text, isStaff ? 1 : 0, isStaff ? 1 : 0, isStaff ? 0 : 1, now);
  db.prepare("UPDATE tickets SET updated_at = ?, status = CASE WHEN status = 'open' THEN 'answered' ELSE status END, last_reply_by = ? WHERE id = ?")
    .run(now, isStaff ? 'staff' : 'user', Number(id));
  if (isStaff) {
    notifyUser(ticket.user_id, {
      type: 'ticket',
      title: `پاسخ به تیکت: ${ticket.subject}`,
      body: text.slice(0, 200),
      link: `/reseller/tickets/${ticket.id}`,
    });
  } else {
    notifyAdmins({
      type: 'ticket',
      title: `پاسخ جدید در تیکت: ${ticket.subject}`,
      body: `${req.user.username}: ${text.slice(0, 160)}`,
      link: `/admin/tickets/${ticket.id}`,
    });
  }
  audit(req, 'ticket.reply', 'ticket', Number(id), { isStaff });
  return getTicket(id, req.user);
}

function setStatus(id, status, req) {
  const db = getDb();
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(id));
  if (!ticket) throw new ApiError(404, 'not_found', 'Ticket not found');
  if (!['open', 'answered', 'closed'].includes(status)) throw new ApiError(422, 'invalid_status', 'Invalid status');
  db.prepare('UPDATE tickets SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?')
    .run(status, Date.now(), status === 'closed' ? Date.now() : 0, Number(id));
  audit(req, 'ticket.status', 'ticket', Number(id), { status });
  return getTicket(id, req.user);
}

module.exports = { listTickets, getTicket, createTicket, replyTicket, setStatus };

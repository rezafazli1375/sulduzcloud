'use strict';

// Panel v2.1.0 — the admin Trash («زباله‌دان»).
//
// The owner's ask: a subscription that has been deleted completely must not be
// gone from the RECORD, only from the node. He keeps meeting the same customer
// weeks later — «همون اشتراک قبلیشو میخوام» — and what he needs is the email,
// the uuid, the subscribe token and how much time and volume were still left.
// So every deletion this panel performs leaves one snapshot row behind, before
// the rows are hidden or erased, and the Trash page can put that exact customer
// back: same email, same uuid, same subscription token, same inbounds.
//
// Two modes are recorded, because they are genuinely different facts:
//
//   soft — the configs rows still exist with deleted_at set (what the delete
//          button does today); the snapshot is what the Trash page lists, so a
//          later database cleanup can still not take the history away;
//   hard — the rows were DELETEd (a hard remove), so this snapshot is ALL that
//          is left of the customer here.
//
// This module never requires services/configs.js: the caller hands it the rows it
// already has, so there is no cycle between the two files and the snapshot stays
// a pure function of data the delete path is holding anyway.

const { getDb } = require('../db');
const xui = require('../xui');
const serversService = require('./servers');
const {
  ApiError, bytesToGb, clientComment, escapeLike, randomToken, safeJsonParse,
} = require('../utils');
const { audit } = require('../audit');

const DAY_MS = 86400000;

/**
 * Traffic of one package the way the panel counts it everywhere else: per x-ui
 * client, one client counted once even when it sits on several inbounds.
 */
function usedOf(rows) {
  const perClient = new Map();
  for (const row of rows) {
    const key = String(row.email || `#${row.id}`);
    const value = Number(row.up_bytes || 0) + Number(row.down_bytes || 0);
    perClient.set(key, Math.max(perClient.get(key) || 0, value));
  }
  let total = 0;
  for (const value of perClient.values()) total += value;
  return total;
}

function inboundIdsOf(rows) {
  return [...new Set(rows.map((row) => Number(row.inbound_id)).filter((n) => Number.isFinite(n) && n > 0))];
}

/**
 * Write the snapshot of the package that is about to be deleted.
 * `rows` is every member row, `head` the row the operator acted on.
 * Returns the trash id, or 0 when there was nothing to record.
 */
function snapshot(rows, { head, mode = 'soft', reason = '', req = null, by = '' } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (!list.length) return 0;
  const db = getDb();
  const anchor = head || list[0];
  const now = Date.now();
  const totalBytes = Math.max(0, ...list.map((row) => Number(row.total_bytes || 0)));
  const expiryAt = Math.max(0, ...list.map((row) => Number(row.expiry_at || 0)));
  const used = usedOf(list);
  const headRow = list.find((row) => Number(row.id) === Number(anchor.id)) || anchor;
  const leftBytes = totalBytes > 0 ? Math.max(0, totalBytes - used) : 0;
  const leftDays = expiryAt > now ? Math.ceil((expiryAt - now) / DAY_MS) : 0;
  const origin = list.every((row) => String(row.origin || 'panel') === 'external') ? 'external' : 'panel';

  const info = db.prepare(
    `INSERT INTO config_trash (user_id, server_id, head_config_id, email, sub_id, uuid, label, customer_name,
        customer_phone, note, origin, total_bytes, used_bytes, expiry_at, left_bytes, left_days,
        inbound_ids, rows_json, mode, reason, deleted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Number(anchor.user_id || headRow.user_id || 0),
    Number(headRow.server_id || 1),
    Number(anchor.id || 0),
    String(anchor.email || ''),
    String(anchor.sub_id || ''),
    String(anchor.uuid || ''),
    String(anchor.label || ''),
    String(anchor.customer_name || ''),
    String(anchor.customer_phone || ''),
    String(anchor.note || ''),
    origin,
    totalBytes,
    used,
    expiryAt,
    leftBytes,
    leftDays,
    JSON.stringify(inboundIdsOf(list)),
    JSON.stringify(list.map((row) => ({
      id: Number(row.id),
      inbound_id: Number(row.inbound_id),
      server_id: Number(row.server_id || 1),
      email: String(row.email || ''),
      sub_id: String(row.sub_id || ''),
      xui_sub_id: String(row.xui_sub_id || ''),
      uuid: String(row.uuid || ''),
      flow: String(row.flow || ''),
      password: String(row.password || ''),
      label: String(row.label || ''),
      customer_name: String(row.customer_name || ''),
      customer_phone: String(row.customer_phone || ''),
      note: String(row.note || ''),
      total_bytes: Number(row.total_bytes || 0),
      expiry_at: Number(row.expiry_at || 0),
      origin: String(row.origin || 'panel'),
    }))),
    String(mode === 'hard' ? 'hard' : 'soft'),
    String(reason || '').slice(0, 60),
    String(req?.user?.username || by || '').slice(0, 40),
    now
  );
  return Number(info.lastInsertRowid);
}

function view(row) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    username: String(row.username || ''),
    serverId: Number(row.server_id),
    serverName: String(row.server_name || ''),
    configId: Number(row.head_config_id),
    email: String(row.email || ''),
    subId: String(row.sub_id || ''),
    uuid: String(row.uuid || ''),
    label: String(row.label || ''),
    customerName: String(row.customer_name || ''),
    customerPhone: String(row.customer_phone || ''),
    note: String(row.note || ''),
    origin: String(row.origin || 'panel'),
    totalBytes: Number(row.total_bytes || 0),
    usedBytes: Number(row.used_bytes || 0),
    leftBytes: Number(row.left_bytes || 0),
    leftGb: Number(bytesToGb(Number(row.left_bytes || 0)).toFixed(2)),
    expiryAt: Number(row.expiry_at || 0),
    leftDays: Number(row.left_days || 0),
    inboundIds: safeJsonParse(row.inbound_ids, []),
    rowCount: safeJsonParse(row.rows_json, []).length,
    mode: String(row.mode || 'soft'),
    reason: String(row.reason || ''),
    deletedBy: String(row.deleted_by || ''),
    createdAt: Number(row.created_at || 0),
    restoredAt: Number(row.restored_at || 0),
  };
}

/** Newest first, with the optional filters the Trash page offers. */
function listTrash({ q = '', userId = 0, mode = '', includeRestored = false, page = 1, pageSize = 25 } = {}) {
  const db = getDb();
  const where = ['1=1'];
  const args = [];
  if (!includeRestored) where.push('t.restored_at = 0');
  if (Number(userId) > 0) { where.push('t.user_id = ?'); args.push(Number(userId)); }
  if (mode === 'soft' || mode === 'hard') { where.push('t.mode = ?'); args.push(mode); }
  const needle = String(q || '').trim().toLowerCase();
  if (needle) {
    where.push("(lower(t.email) LIKE ? ESCAPE '\\' OR lower(t.uuid) LIKE ? ESCAPE '\\' OR lower(t.sub_id) LIKE ? ESCAPE '\\' OR lower(t.customer_name) LIKE ? ESCAPE '\\' OR lower(t.label) LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(needle)}%`;
    args.push(like, like, like, like, like);
  }
  const whereSql = where.join(' AND ');
  const limit = Math.min(200, Math.max(1, Number(pageSize) || 25));
  const pageNo = Math.max(1, Number(page) || 1);
  const rows = db.prepare(
    `SELECT t.*, u.username AS username, s.name AS server_name
       FROM config_trash t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN servers s ON s.id = t.server_id
      WHERE ${whereSql}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ? OFFSET ?`
  ).all(...args, limit, (pageNo - 1) * limit);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM config_trash t WHERE ${whereSql}`).get(...args).c;
  const counts = db.prepare(
    "SELECT SUM(CASE WHEN restored_at = 0 THEN 1 ELSE 0 END) AS kept, SUM(CASE WHEN restored_at > 0 THEN 1 ELSE 0 END) AS back FROM config_trash"
  ).get();
  return {
    rows: rows.map(view),
    total: Number(total || 0),
    page: pageNo,
    pageSize: limit,
    counts: { kept: Number(counts.kept || 0), back: Number(counts.back || 0) },
  };
}

function getEntry(id) {
  const row = getDb().prepare(
    `SELECT t.*, u.username AS username, s.name AS server_name
       FROM config_trash t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN servers s ON s.id = t.server_id
      WHERE t.id = ?`
  ).get(Number(id));
  if (!row) throw new ApiError(404, 'not_found', 'این مورد در زباله‌دان نیست / this entry is not in the trash');
  return row;
}

/** What the restore dialog shows before it writes: the payload, in/out. */
function detail(id) {
  const row = getEntry(id);
  const members = safeJsonParse(row.rows_json, []);
  const db = getDb();
  const targets = members.length
    ? [...new Set(members.map((item) => Number(item.inbound_id)))]
    : safeJsonParse(row.inbound_ids, []).map(Number);
  const inboundOf = db.prepare('SELECT id, remark, xui_id, server_id, enabled FROM inbounds WHERE id = ?');
  const inbounds = targets.filter((n) => Number.isFinite(n) && n > 0).map((inboundId) => {
    const inbound = inboundOf.get(inboundId);
    return {
      inboundId,
      remark: inbound ? String(inbound.remark || '') : '',
      serverId: inbound ? Number(inbound.server_id) : Number(row.server_id),
      enabled: Boolean(inbound?.enabled),
      exists: Boolean(inbound),
    };
  });
  return {
    entry: view(row),
    inbounds,
    rows: members,
    usable: inbounds.some((item) => item.exists && item.enabled),
  };
}

/**
 * Put the customer back on the node and in the panel, with the identity he had.
 *
 * Same email, same uuid, same subscription token: that is the whole point of the
 * snapshot, and it is why the customer's existing apps keep working after the
 * restore instead of needing a fresh link. The expiry is rebuilt from the days
 * that were LEFT at deletion time (an expired snapshot stays expired unless the
 * operator extends it in the same call), and the quota is the size the package
 * was — a new client starts with zero counters, so `left_bytes` is what he gets
 * back rather than the original total when the operator asks for it.
 *
 * Nothing is charged: this is the owner undoing his own deletion.
 */
async function restore(id, { userId = 0, inboundIds = null, keepUsageWindow = false, req = null } = {}) {
  const row = getEntry(id);
  if (Number(row.restored_at || 0) > 0) {
    throw new ApiError(409, 'already_restored', 'این مورد قبلاً بازگردانده شده است / this entry was already restored');
  }
  const db = getDb();
  const members = safeJsonParse(row.rows_json, []);
  const targetUserId = Number(userId || row.user_id || 0);
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at = 0 AND status = 'active'").get(targetUserId);
  if (!user) throw new ApiError(422, 'user_not_found', 'نمایندهٔ این اشتراک دیگر فعال نیست / the reseller of this subscription is not active');

  // Which channels to rebuild: what the caller ticked, else everything that still
  // exists and is enabled. One server only — a subscription token cannot span two
  // x-ui panels, which is the same rule an ordinary order enforces.
  const email = String(row.email || '');
  if (!email) throw new ApiError(422, 'no_email', 'این ردیف ایمیل x-ui ندارد / the snapshot has no client email');
  // An adopted («دریافت‌شده») row stands for a client of ANOTHER operator's panel.
  // Deleting it only forgot it here — deletePackage never sent a delete to the node
  // — so rebuilding it would create a client this panel never owned beside a
  // subscription that still works over there. The Trash says no, and points at the
  // one action that is honest for this case: re-import him.
  const isExternal = (item) => String(item.origin || 'panel') === 'external';
  const ownMembers = members.filter((item) => !isExternal(item));
  if (members.length && !ownMembers.length) {
    throw new ApiError(422, 'external_snapshot',
      'این اشتراک از پنل دیگری دریافت شده بود؛ حذفش فقط فراموش‌کردن همین‌جا بود، پس ساخته هم نمی‌شود — برای برگرداندنش دوباره دریافتش کنید / this subscription was adopted from another panel, so deleting it only forgot it here and restoring it must not create a new client — re-import it instead');
  }
  const stored = safeJsonParse(row.inbound_ids, []).map(Number);
  const wanted = (Array.isArray(inboundIds) && inboundIds.length
    ? inboundIds
    : (ownMembers.length ? inboundIdsOf(ownMembers) : (members.length ? inboundIdsOf(members) : stored)))
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  const found = wanted
    .map((inboundId) => db.prepare('SELECT * FROM inbounds WHERE id = ?').get(inboundId))
    .filter(Boolean);
  // A mixed package — own channel plus adopted channel — rebuilds the channels
  // this panel actually built, and nothing else.
  const ownChannels = ownMembers.length ? new Set(inboundIdsOf(ownMembers)) : null;
  const inboundRows = ownChannels ? found.filter((item) => ownChannels.has(Number(item.id))) : found;
  if (!inboundRows.length) {
    throw new ApiError(422, 'inbound_required', 'هیچ اینباند معتبری برای ساخت مجدد نمانده است / no usable inbound is left to rebuild on');
  }
  const serverId = Number(inboundRows[0].server_id || row.server_id || 1);
  if (inboundRows.some((item) => Number(item.server_id) !== serverId)) {
    throw new ApiError(422, 'server_mismatch', 'اینباندهای انتخابی روی یک سرور نیستند / the selected inbounds are on different servers');
  }
  const blocked = inboundRows.filter((item) => !Number(item.enabled));
  if (blocked.length) {
    throw new ApiError(422, 'inbound_disabled', `اینباند «${blocked[0].remark}» غیرفعال است / that inbound is disabled`);
  }

  // A live row with this email on this server means the customer never really
  // went away (a soft delete that was healed, or a re-import). Building again
  // would give one email two rows and one client two owners.
  const clash = db.prepare(
    'SELECT id, user_id, deleted_at FROM configs WHERE email = ? AND server_id = ? AND deleted_at = 0'
  ).get(email, serverId);
  if (clash) throw new ApiError(409, 'client_exists', `کلاینت ${email} همین حالا در پنل هست / this client is already in the panel`);

  const first = members[0] || {};
  const uuid = String(first.uuid || row.uuid || '');
  // Two tokens live on a row: `sub_id` is the customer group token of THIS panel,
  // `xui_sub_id` is the subscription id the node's own subscription server answers
  // on (v1.4.0 split them so two channels of one customer never collide). The
  // rebuilt client needs the node token; the new rows keep the group token.
  const nodeSubId = String(first.xui_sub_id || first.sub_id || row.sub_id || '');
  const groupToken = String(first.sub_id || row.sub_id || '') || randomToken(16);
  const now = Date.now();
  const daysLeft = Number(row.left_days || 0);
  const originalExpiry = Number(row.expiry_at || 0);
  // keepUsageWindow restores the ORIGINAL expiry date, which is what the owner
  // wants when the customer was deleted by mistake ten minutes ago; the default
  // rebuilds from the time that was left, which is what «همون اشتراک قبلی» means
  // weeks later. A snapshot with nothing left was already expired, and he comes
  // back expired: 0 here means «بدون انقضا», which would hand an unlimited
  // subscription to a package that had used its days up.
  const expiryAt = keepUsageWindow && originalExpiry > 0
    ? originalExpiry
    : (daysLeft > 0 ? now + daysLeft * DAY_MS : originalExpiry);
  const totalBytes = keepUsageWindow
    ? Number(row.total_bytes || 0)
    : (Number(row.left_bytes || 0) || Number(row.total_bytes || 0));
  const comment = clientComment({
    label: first.label || row.label, customerName: first.customer_name || row.customer_name,
    customerPhone: first.customer_phone || row.customer_phone,
  });

  const xuiIds = [...new Set(inboundRows.map((item) => Number(item.xui_id)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!xuiIds.length) {
    throw new ApiError(422, 'inbound_not_on_node', 'اینباندهای انتخابی روی نود شناسایی نمی‌شوند / the selected inbounds have no x-ui id');
  }
  const server = serversService.getServer(serverId);
  if (!server) throw new ApiError(422, 'server_not_found', 'سرور این اشتراک در پنل نیست / the server of this subscription is gone');

  const created = await xui.addClient(
    {
      email,
      subId: nodeSubId || undefined,
      uuid: uuid || undefined,
      flow: String(first.flow || ''),
      totalBytes,
      expiryAt,
      enabled: true,
      comment,
    },
    xuiIds,
    server
  );
  const liveSubId = String(created?.subId || nodeSubId || '');
  const liveUuid = String(created?.uuid || uuid || '');

  const insert = db.prepare(
    `INSERT INTO configs (user_id, inbound_id, server_id, email, sub_id, xui_sub_id, uuid, password, flow, label,
        customer_name, customer_phone, note, total_bytes, expiry_at, enabled, status, sync_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', '', ?, ?)`
  );
  // The delete button hides a row, it does not remove it — and (email, inbound_id)
  // is unique, so the buried row still holds that place. Inserting the same
  // customer on the same channel again is a constraint error, not a restore, and
  // reviving the row that is already there is also the better answer: his config
  // id, his traffic history and his transactions come back with him.
  const buried = db.prepare(
    'SELECT id FROM configs WHERE email = ? AND inbound_id = ? AND deleted_at > 0 ORDER BY id DESC LIMIT 1'
  );
  const revive = db.prepare(
    `UPDATE configs SET user_id = ?, server_id = ?, sub_id = ?, xui_sub_id = ?, uuid = ?, password = ?, flow = ?,
        label = ?, customer_name = ?, customer_phone = ?, note = ?, total_bytes = ?, expiry_at = ?,
        enabled = 1, status = 'active', sync_status = '', deleted_at = 0,
        up_bytes = 0, down_bytes = 0, depleted_at = 0, updated_at = ?
      WHERE id = ?`
  );
  const ids = [];
  const revived = [];
  for (const inbound of inboundRows) {
    const source = members.find((item) => Number(item.inbound_id) === Number(inbound.id)) || members[0] || row;
    const gone = buried.get(email, Number(inbound.id));
    if (gone) {
      revive.run(
        user.id,
        serverId,
        groupToken,
        liveSubId,
        liveUuid,
        String(source.password || ''),
        String(source.flow || ''),
        String(source.label || row.label || ''),
        String(source.customer_name || row.customer_name || ''),
        String(source.customer_phone || row.customer_phone || ''),
        String(source.note || row.note || ''),
        totalBytes,
        expiryAt,
        now,
        Number(gone.id)
      );
      ids.push(Number(gone.id));
      revived.push(Number(gone.id));
      continue;
    }
    const info = insert.run(
      user.id,
      Number(inbound.id),
      serverId,
      email,
      groupToken,
      liveSubId,
      liveUuid,
      String(source.password || ''),
      String(source.flow || ''),
      String(source.label || row.label || ''),
      String(source.customer_name || row.customer_name || ''),
      String(source.customer_phone || row.customer_phone || ''),
      String(source.note || row.note || ''),
      totalBytes,
      expiryAt,
      now,
      now
    );
    ids.push(Number(info.lastInsertRowid));
  }
  db.prepare('UPDATE config_trash SET restored_at = ? WHERE id = ?').run(now, Number(row.id));
  audit(req, 'config.trash_restore', 'config', ids.join(','), {
    trashId: Number(row.id),
    email,
    userId: user.id,
    inboundIds: inboundRows.map((item) => Number(item.id)),
    totalBytes,
    expiryAt,
    keptWindow: Boolean(keepUsageWindow),
    revived,
  });
  return {
    configId: ids[0],
    ids,
    revived,
    email,
    uuid: liveUuid,
    subId: liveSubId,
    totalBytes,
    expiryAt,
    leftDays: expiryAt > now ? Math.ceil((expiryAt - now) / DAY_MS) : 0,
    inboundIds: inboundRows.map((item) => Number(item.id)),
    serverId,
  };
}

/** Forget the snapshot for good (the only place a trash row can disappear). */
function purge(id, req = null) {
  const row = getEntry(id);
  getDb().prepare('DELETE FROM config_trash WHERE id = ?').run(Number(row.id));
  audit(req, 'config.trash_purge', 'config', Number(row.id), { email: String(row.email || '') });
  return { id: Number(row.id), deleted: true };
}

module.exports = { snapshot, listTrash, detail, restore, purge, usedOf, view };

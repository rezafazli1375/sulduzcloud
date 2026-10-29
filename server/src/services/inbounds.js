'use strict';

const { getDb } = require('../db');
const xui = require('../xui');
const serversService = require('./servers');
const { ApiError } = require('../utils');
const { audit } = require('../audit');

function nodeMap(server) {
  return xui.nodes(server).then((rows) => {
    const map = new Map();
    for (const node of rows) {
      map.set(Number(node.id), {
        id: Number(node.id),
        name: node.name || node.remark || `node-${node.id}`,
        address: node.address || '',
        status: node.status || 'unknown',
        lastHeartbeat: node.lastHeartbeat || 0,
        enable: Boolean(node.enable),
      });
    }
    return map;
  });
}

// The slim list is the only source of `subSortIndex`, but it weighs a few MB
// (client stats), so the automatic monitor cycle refreshes it at most every
// 15 minutes per server. Manual sync from the admin UI always forces a refresh.
const SUB_ORDER_TTL_MS = 15 * 60 * 1000;
const subOrderFetchedAt = new Map();

async function loadSubOrder(force, server) {
  const key = Number(server.id);
  const fetchedAt = subOrderFetchedAt.get(key) || 0;
  if (!force && fetchedAt && Date.now() - fetchedAt < SUB_ORDER_TTL_MS) return null;
  try {
    const slim = await xui.inboundsSlim(server);
    subOrderFetchedAt.set(key, Date.now());
    return new Map(
      slim.map((row) => [Number(row.id), Math.max(0, Number(row.subSortIndex || 0))])
    );
  } catch (err) {
    subOrderFetchedAt.set(key, Date.now());
    console.error(`[inbounds] sub order sync failed for server ${key}:`, err.message);
    return null;
  }
}

async function syncServer(server, { forceSubOrder = false } = {}) {
  const rows = await xui.inbounds(server);
  const nodes = await nodeMap(server).catch(() => new Map());
  // A failure here must not abort the sync: inbounds keep their stored order.
  const subSort = await loadSubOrder(forceSubOrder, server);
  const db = getDb();
  const now = Date.now();
  const findExisting = db.prepare('SELECT id FROM inbounds WHERE server_id = ? AND xui_id = ?');
  const insert = db.prepare(
    `INSERT INTO inbounds (server_id, xui_id, node_id, node_name, node_address, remark, protocol, tag, port,
       network, security, listen, enabled, visible, sub_sort_index, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, COALESCE(?, 0), ?)`
  );
  const update = db.prepare(
    `UPDATE inbounds SET node_id = ?, node_name = ?, node_address = ?, remark = ?, protocol = ?, tag = ?,
       port = ?, network = ?, security = ?, listen = ?, enabled = ?,
       sub_sort_index = COALESCE(?, sub_sort_index), updated_at = ?
     WHERE id = ?`
  );
  const seen = new Set();
  let removed = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const xuiId = Number(row.id);
      const nodeId = Number(row.nodeId || 0);
      const node = nodes.get(nodeId);
      seen.add(xuiId);
      const sortVal = subSort && subSort.has(xuiId) ? subSort.get(xuiId) : null;
      const existing = findExisting.get(Number(server.id), xuiId);
      const fields = [
        nodeId,
        node ? node.name : nodeId ? `node-${nodeId}` : 'local',
        node ? node.address : row.nodeAddress || '',
        String(row.remark || ''),
        String(row.protocol || ''),
        String(row.tag || ''),
        Number(row.port || 0),
        String(row.network || ''),
        String(row.security || ''),
        String(row.listen || ''),
        row.enable === false ? 0 : 1,
        sortVal,
        now,
      ];
      if (existing) {
        update.run(...fields, existing.id);
      } else {
        insert.run(Number(server.id), xuiId, ...fields);
      }
    }
    if (seen.size) {
      // Inbounds deleted from x-ui must disappear here too; only prune when the
      // API actually returned a snapshot, so a failed/empty call never wipes the list.
      const ids = [...seen];
      const placeholders = ids.map(() => '?').join(',');
      const stale = db.prepare(
        `SELECT id FROM inbounds WHERE server_id = ? AND xui_id NOT IN (${placeholders})`
      ).all(Number(server.id), ...ids).map((row) => Number(row.id));
      if (stale.length) {
        const marks = stale.map(() => '?').join(',');
        removed = db.prepare(`DELETE FROM inbounds WHERE id IN (${marks})`).run(...stale).changes;
        if (removed) {
          db.prepare(`DELETE FROM reseller_discounts WHERE inbound_id IN (${marks})`).run(...stale);
        }
      }
    }
  });
  tx();
  return { server: Number(server.id), count: seen.size, nodes: nodes.size, removed, subOrder: subSort ? subSort.size : null };
}

async function syncInbounds({ forceSubOrder = false, serverId = 0 } = {}) {
  if (serverId) {
    const target = serversService.getServer(serverId);
    if (!target) throw new ApiError(404, 'server_not_found', 'Server not found');
    return syncServer(serversService.resolveServer(serverId), { forceSubOrder });
  }
  const servers = serversService.listServers({ includeDisabled: true });
  if (!servers.length) {
    const server = serversService.resolveServer(0);
    return syncServer(server, { forceSubOrder });
  }
  const results = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    try {
      results.push({ ok: true, ...(await syncServer(server, { forceSubOrder })) });
    } catch (err) {
      results.push({ ok: false, server: server.id, error: err.message });
      console.error(`[inbounds] sync failed for server ${server.id}:`, err.message);
    }
  }
  const total = results.reduce((acc, item) => ({
    count: acc.count + Number(item.count || 0),
    nodes: acc.nodes + Number(item.nodes || 0),
    removed: acc.removed + Number(item.removed || 0),
  }), { count: 0, nodes: 0, removed: 0 });
  return { ...total, servers: results };
}

function listInbounds({ includeHidden = true, allowed = null, serverId = 0 } = {}) {
  const db = getDb();
  const params = [];
  let where = '';
  if (serverId) {
    where = 'WHERE i.server_id = ?';
    params.push(Number(serverId));
  }
  const rows = db.prepare(
    `SELECT i.*, COALESCE(s.name, '') AS server_name, COALESCE(s.sort, 0) AS server_sort,
       (SELECT COUNT(*) FROM configs c WHERE c.inbound_id = i.id AND c.deleted_at = 0) AS config_count,
       (SELECT COALESCE(SUM(c.up_bytes + c.down_bytes), 0) FROM configs c WHERE c.inbound_id = i.id AND c.deleted_at = 0) AS used_bytes
     FROM inbounds i LEFT JOIN servers s ON s.id = i.server_id ${where}
     ORDER BY server_sort ASC, i.server_id ASC, i.sub_sort_index ASC, i.id ASC`
  ).all(...params);
  return rows
    .filter((row) => includeHidden || row.visible)
    .filter((row) => !allowed || allowed.includes(Number(row.id)))
    .map((row) => ({
      id: row.id,
      serverId: Number(row.server_id),
      serverName: row.server_name,
      xuiId: Number(row.xui_id),
      nodeId: row.node_id,
      nodeName: row.node_name,
      nodeAddress: row.node_address,
      remark: row.remark,
      protocol: row.protocol,
      tag: row.tag,
      port: row.port,
      network: row.network,
      security: row.security,
      listen: row.listen,
      enabled: Boolean(row.enabled),
      visible: Boolean(row.visible),
      priceFixed: Number(row.price_fixed || 0),
      pricePerGb: Number(row.price_per_gb || 0),
      pricePerDay: Number(row.price_per_day || 0),
      sort: Number(row.sort || 0),
      subSortIndex: Number(row.sub_sort_index || 0),
      configCount: Number(row.config_count || 0),
      usedBytes: Number(row.used_bytes || 0),
      updatedAt: Number(row.updated_at || 0),
    }));
}

function getInbound(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM inbounds WHERE id = ?').get(Number(id));
}

function updateInbound(id, patch, req) {
  const db = getDb();
  const current = getInbound(id);
  if (!current) throw new ApiError(404, 'not_found', 'Inbound not found');
  const fields = [];
  const values = [];
  const allow = {
    visible: (v) => (v ? 1 : 0),
    price_fixed: (v) => Math.max(0, Math.round(Number(v) || 0)),
    price_per_gb: (v) => Math.max(0, Math.round(Number(v) || 0)),
    price_per_day: (v) => Math.max(0, Math.round(Number(v) || 0)),
    sort: (v) => Math.round(Number(v) || 0),
  };
  for (const [key, cast] of Object.entries(allow)) {
    if (patch[key] !== undefined) { fields.push(`${key} = ?`); values.push(cast(patch[key])); }
  }
  if (!fields.length) return listInbounds().find((row) => row.id === Number(id));
  fields.push('updated_at = ?');
  values.push(Date.now(), Number(id));
  db.prepare(`UPDATE inbounds SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  audit(req, 'inbound.update', 'inbound', Number(id), Object.keys(patch));
  return listInbounds().find((row) => row.id === Number(id));
}

function bulkVisibility(ids, visible, req) {
  const db = getDb();
  const list = (ids || []).map(Number).filter((n) => Number.isFinite(n));
  if (!list.length) return { updated: 0 };
  const placeholders = list.map(() => '?').join(',');
  const info = db.prepare(`UPDATE inbounds SET visible = ?, updated_at = ? WHERE id IN (${placeholders})`)
    .run(visible ? 1 : 0, Date.now(), ...list);
  audit(req, 'inbound.visibility', 'inbound', list.join(','), { visible });
  return { updated: info.changes };
}

module.exports = { syncInbounds, listInbounds, getInbound, updateInbound, bulkVisibility, nodeMap };

'use strict';

/**
 * The stable link between a wallet line and the customer package it paid for.
 * `config_snapshot` is deliberately small: enough to identify the package after
 * a rename, transfer, soft delete or Trash purge, but never UUIDs, subscription
 * tokens, phone numbers or node credentials.
 */
const RAW_UUID = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i;
const COMPACT_UUID = /^[0-9a-f]{32}$/i;
const CONFIG_URI = /\b[a-z][a-z0-9+.-]*:\/\/\S+/i;

// Imported x-ui clients sometimes use a UUID or a whole subscription URI as their
// email/remark. The ledger is display data, never a second place for credentials.
function safeText(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || RAW_UUID.test(text) || COMPACT_UUID.test(text) || CONFIG_URI.test(text)) return '';
  return text;
}

function snapshot(row, members = [], inbounds = [], options = {}) {
  const list = members.length ? members : [row];
  const byInbound = new Map((inbounds || []).map((item) => [Number(item.id), item]));
  return {
    email: safeText(row?.email),
    label: safeText(row?.label),
    customerName: safeText(row?.customer_name),
    ownerId: Number(row?.user_id || 0),
    serverId: Number(row?.server_id || 0),
    capturedAt: Number(options.capturedAt || Date.now()),
    legacyRecovered: Boolean(options.legacyRecovered),
    deleted: Boolean(options.deleted),
    inbounds: list.slice(0, 100).map((member) => {
      const inbound = byInbound.get(Number(member.inbound_id)) || {};
      return {
        configId: Number(member.id || 0),
        inboundId: Number(member.inbound_id || 0),
        remark: safeText(inbound.remark),
        protocol: safeText(inbound.protocol),
        port: Number(inbound.port || 0),
        nodeName: safeText(inbound.node_name || inbound.server_name),
      };
    }),
  };
}

function capture(row, members = [], inbounds = []) {
  const list = members.length ? members : [row];
  const anchor = row || list[0];
  return {
    configId: Number(anchor?.id || 0),
    snapshot: anchor ? JSON.stringify(snapshot(anchor, list, inbounds)) : '',
  };
}

function parseSnapshot(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function activePackageKey(row) {
  if (row.sub_id) return `sub:${String(row.sub_id)}`;
  if (String(row.origin || '') === 'external') return `email:${String(row.email || '').toLowerCase()}`;
  return `row:${Number(row.id || 0)}`;
}

// Trash normally revives the buried row, but a hard-deleted customer is inserted
// with a NEW id. After a proven Trash restore, match that replacement only when
// the saved customer identity and server resolve to exactly one active package.
// Ownership is deliberately absent: handing a customer to another reseller must
// not break his old wallet history.
function activeReplacement(db, config, saved) {
  const email = safeText(config?.email || saved?.email);
  const serverId = Number(config?.server_id || saved?.serverId || 0);
  if (!email || !serverId) return null;
  const candidates = db.prepare(
    `SELECT id, email, sub_id, origin, server_id FROM configs
     WHERE deleted_at = 0 AND server_id = ? AND lower(email) = lower(?) ORDER BY id LIMIT 201`
  ).all(serverId, email);
  // An unbounded identity is not evidence of one replacement.
  if (!candidates.length || candidates.length > 200) return null;
  const packages = new Map();
  for (const candidate of candidates) {
    const key = activePackageKey(candidate);
    if (!packages.has(key)) packages.set(key, candidate);
  }
  return packages.size === 1 ? packages.values().next().value : null;
}

/**
 * Attach only the display-safe live/Trash state to a page of ledger rows. Reads
 * are bounded by the page and by each historical email/server identity, and no
 * join can duplicate transactions when a package has several Trash snapshots.
 * Raw config credentials never leave the database.
 */
function presentRows(db, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ids = [...new Set(list.map((row) => Number(row.config_id || 0)).filter((id) => id > 0))];
  if (!ids.length) return list.map((row) => ({ ...row, ...present(row) }));
  const marks = ids.map(() => '?').join(',');
  const configs = new Map(db.prepare(
    `SELECT id, email, label, customer_name, user_id, server_id, sub_id, origin, deleted_at
     FROM configs WHERE id IN (${marks})`
  ).all(...ids).map((row) => [Number(row.id), row]));
  const trash = new Map();
  for (const row of db.prepare(
    `SELECT id, head_config_id, restored_at FROM config_trash WHERE head_config_id IN (${marks}) ORDER BY id`
  ).all(...ids)) trash.set(Number(row.head_config_id), { id: Number(row.id), restoredAt: Number(row.restored_at || 0) });
  const replacements = new Map();
  const savedById = new Map(list.map((row) => [Number(row.config_id || 0), parseSnapshot(row.config_snapshot)]));
  for (const id of ids) {
    const historical = configs.get(id);
    if (historical && Number(historical.deleted_at || 0) === 0) continue;
    // A new customer may legitimately reuse the same email later. Only a Trash
    // entry actually restored from this package is evidence of a replacement.
    if (Number(trash.get(id)?.restoredAt || 0) <= 0) continue;
    replacements.set(id, activeReplacement(db, historical, savedById.get(id)));
  }
  return list.map((row) => {
    const id = Number(row.config_id || 0);
    const historical = configs.get(id);
    const replacement = replacements.get(id);
    const saved = parseSnapshot(row.config_snapshot);
    // Snapshot identity is immutable sale-time evidence. Live state only answers
    // whether that same package is still present; it must not overwrite a later
    // rename or a restored package's saved details.
    const live = saved ? {} : {
      email: historical?.email || replacement?.email || '',
      label: historical?.label || replacement?.label || '',
      customerName: historical?.customer_name || replacement?.customer_name || '',
    };
    const current = replacement || historical;
    const active = Boolean(replacement || (historical && Number(historical.deleted_at || 0) === 0));
    return { ...row, ...present({
      ...row,
      config_live_id: active ? Number(current?.id || id) : 0,
      config_email: live.email,
      config_label: live.label,
      config_customer_name: live.customerName,
      config_identity_from_snapshot: Boolean(saved),
      config_active: active ? 1 : 0,
      config_deleted_at: active ? 0 : Number(historical?.deleted_at || 0),
      config_trash_id: trash.get(id)?.id || 0,
    }), configId: id };
  });
}

/** Additive API shape used by the owner's ledger and user-detail read-out. */
function present(row) {
  const configId = Number(row.config_id || 0);
  if (!configId) return { configId: 0, config: null };
  const saved = parseSnapshot(row.config_snapshot);
  // Page enrichment may intentionally omit live display fields while keeping
  // immutable snapshot identity. A direct read still gets the live fallback.
  const live = saved && row.config_identity_from_snapshot ? {} : row.config_email
    ? {
        email: safeText(row.config_email),
        label: safeText(row.config_label),
        customerName: safeText(row.config_customer_name),
      }
    : {};
  const base = { ...live, ...(saved || {}) };
  const liveId = Number(row.config_live_id || configId);
  return {
    configId,
    config: {
      // Keep the ledger's immutable configId above; this id names the current
      // row when Trash had to insert a replacement for a hard-deleted package.
      id: liveId,
      email: safeText(base.email),
      label: safeText(base.label),
      customerName: safeText(base.customerName),
      ownerId: Number(base.ownerId || 0),
      serverId: Number(base.serverId || 0),
      capturedAt: Number(base.capturedAt || 0),
      legacyRecovered: Boolean(base.legacyRecovered),
      // A live, restored row wins over an old deletion snapshot. Without a live
      // row the package is deleted (soft, hard, or Trash-only); the saved identity
      // still explains which customer the historical wallet line belonged to.
      deleted: !(liveId > 0 && row.config_active !== undefined && Number(row.config_active) === 1),
      inbounds: Array.isArray(base.inbounds)
        ? base.inbounds.slice(0, 100).map((item, index) => ({
            configId: Number((typeof item === 'number' ? (index === 0 ? configId : 0) : item?.configId) || 0),
            inboundId: Number((typeof item === 'number' ? item : item?.inboundId) || 0),
            remark: safeText(typeof item === 'number' ? '' : item?.remark),
            protocol: safeText(typeof item === 'number' ? '' : item?.protocol),
            port: Number((typeof item === 'number' ? 0 : item?.port) || 0),
            nodeName: safeText(typeof item === 'number' ? '' : item?.nodeName),
          }))
        : [],
    },
  };
}

function jsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function jsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function packageMembers(db, row) {
  if (!row) return [];
  if (row.sub_id) {
    return db.prepare(
      'SELECT * FROM configs WHERE sub_id = ? AND user_id = ? AND server_id = ? AND deleted_at = 0 ORDER BY id'
    ).all(row.sub_id, row.user_id, Number(row.server_id || 0));
  }
  if (String(row.origin || '') === 'external' && row.email) {
    return db.prepare(
      `SELECT * FROM configs WHERE email = ? AND user_id = ? AND server_id = ?
       AND origin = 'external' AND deleted_at = 0 ORDER BY id`
    ).all(row.email, row.user_id, Number(row.server_id || 0));
  }
  return [row];
}

function inboundRows(db, members) {
  if (!members.length) return [];
  const marks = members.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM inbounds WHERE id IN (${marks})`).all(...members.map((row) => Number(row.inbound_id)));
}

/**
 * Recover only associations that old audit/plan rows prove uniquely. No
 * description parsing, no current-owner guessing and no nearest-time guess when
 * two transactions fit: ambiguous history stays config_id = 0.
 */
function backfillLegacy(db) {
  const transactions = db.prepare(
    "SELECT * FROM transactions WHERE type IN ('purchase','renew') AND config_id = 0"
  ).all();
  if (!transactions.length) return { linked: 0, ambiguous: 0, unresolved: 0 };

  const byKey = new Map();
  for (const tx of transactions) {
    const key = `${tx.type}|${Number(tx.user_id)}|${Math.abs(Number(tx.amount))}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(tx);
  }
  const candidates = new Map();
  const consider = (tx, configId, source) => {
    if (!tx || !configId) return;
    if (!candidates.has(Number(tx.id))) candidates.set(Number(tx.id), new Map());
    candidates.get(Number(tx.id)).set(Number(configId), source);
  };

  const audits = db.prepare(
    "SELECT * FROM audit_logs WHERE action = 'config.create' AND entity = 'config'"
  ).all();
  for (const audit of audits) {
    const details = jsonObject(audit.details);
    const price = Math.abs(Number(details.price || 0));
    if (!price || !details.userId || details.charged === false || details.free === true) continue;
    const ids = String(audit.entity_id || '').split(',').map(Number).filter((id) => id > 0);
    if (!ids.length) continue;
    const matches = (byKey.get(`purchase|${Number(details.userId)}|${price}`) || []).filter((tx) => {
      const delta = Number(audit.created_at) - Number(tx.created_at);
      // The wallet line is written first, then the create audit. A narrow window
      // plus exact payer/type/amount is evidence; anything wider is not.
      return delta >= 0 && delta <= 15000;
    });
    // Two equal wallet lines in the same window are not proof of which one paid
    // for this package. Leave both untouched rather than attach both to it.
    if (matches.length !== 1) continue;
    consider(matches[0], ids[0], 'audit');
  }

  // plan_purchases has no payer-independent amount for renewals, and plans can
  // be repriced later, so it is deliberately not used to guess old associations.

  const update = db.prepare('UPDATE transactions SET config_id = ?, config_snapshot = ? WHERE id = ? AND config_id = 0');
  const configById = db.prepare('SELECT * FROM configs WHERE id = ?');
  const trashByHead = db.prepare('SELECT * FROM config_trash WHERE head_config_id = ? ORDER BY id DESC LIMIT 1');
  let linked = 0;
  let ambiguous = 0;
  // The association is historical, but the display fields come from the config
  // or Trash as it exists NOW. Record the recovery time, not the sale time, so a
  // later rename/inbound edit cannot masquerade as sale-time evidence.
  const recoveredAt = Date.now();
  for (const [txId, choices] of candidates) {
    if (choices.size !== 1) {
      ambiguous += 1;
      continue;
    }
    const configId = [...choices.keys()][0];
    const row = configById.get(configId);
    const members = row ? packageMembers(db, row) : [];
    let saved = '';
    if (row) {
      saved = JSON.stringify(snapshot(row, members, inboundRows(db, members), {
        capturedAt: recoveredAt,
        legacyRecovered: true,
        deleted: Number(row.deleted_at || 0) > 0,
      }));
    } else {
      const trashed = trashByHead.get(configId);
      if (!trashed) continue;
      let trashMembers = jsonArray(trashed.rows_json).filter((item) => item && typeof item === 'object');
      if (!trashMembers.length) {
        trashMembers = jsonArray(trashed.inbound_ids).map(Number).filter((id) => id > 0).map((inboundId, index) => ({
          id: index === 0 ? configId : 0,
          inbound_id: inboundId,
        }));
      }
      saved = JSON.stringify(snapshot(trashed, trashMembers, inboundRows(db, trashMembers), {
        capturedAt: recoveredAt,
        legacyRecovered: true,
        deleted: true,
      }));
    }
    const changed = update.run(configId, saved, txId);
    linked += Number(changed.changes || 0);
  }
  return { linked, ambiguous, unresolved: transactions.length - linked };
}

module.exports = { snapshot, capture, parseSnapshot, present, presentRows, backfillLegacy };

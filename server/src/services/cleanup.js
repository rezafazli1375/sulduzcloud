'use strict';

// v2.0.0: scheduled removal of finished subscriptions.
//
// The owner asked for «اشتراک‌هایی که تمام شده و منقضی شده باشند زمان‌بندی حذف
// داشته باشند». This is that schedule. It is OFF by default, and even when on it
// only removes a package that has STAYED finished for the whole grace window:
//
//   expired  — every channel's expiry is in the past (packageStatusSql's own
//              definition), and the LAST expiry is at least graceDays old;
//   depleted — the shared quota is fully used. x-ui counters carry no "became
//              full at" moment, so the first sweep that sees a package full
//              stamps configs.depleted_at on its rows and the grace counts from
//              that stamp. A customer who tops up inside the window keeps his
//              subscription; if he empties it again later the stamp is refreshed.
//
// Deletion reuses configs.deletePackage — the exact code path a person's delete
// button takes — so the node-side rules are identical: adopted (external)
// clients are never deleted on the other operator's panel, a client already off
// the node is a success, and a node that refuses leaves the package untouched.
// With includeExternal off (the default) adopted packages are not swept at all.

const { getDb } = require('../db');
const settings = require('../settings');
const configs = require('./configs');
const { systemAudit } = require('../audit');
const { CONFIG_GROUP_KEY_SQL, CONFIG_GROUP_USED_SQL } = require('../utils');

const DAY_MS = 86400000;

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * One sweep. `dryRun` answers with exactly what WOULD happen and writes nothing
 * — not even the depleted_at stamp — so the settings tab can show a preview.
 * A real run persists lastRunAt/lastSummary on the settings row and writes one
 * system audit entry; each deletion additionally audits 'config.auto_delete'.
 */
async function runCleanup({ dryRun = false } = {}) {
  const cfg = settings.getSetting('cleanup');
  const db = getDb();
  const now = Date.now();
  const graceDays = clampInt(cfg.graceDays, 0, 365, 7);
  const graceMs = graceDays * DAY_MS;
  const maxPerRun = clampInt(cfg.maxPerRun, 1, 500, 50);
  const wantExpired = Boolean(cfg.expired);
  const wantDepleted = Boolean(cfg.depleted);
  const includeExternal = Boolean(cfg.includeExternal);

  const summary = {
    enabled: Boolean(cfg.enabled),
    dryRun: Boolean(dryRun),
    checked: 0,
    eligible: 0,
    deleted: 0,
    stamped: 0,
    skippedExternal: 0,
    skippedGrace: 0,
    capped: 0,
    failed: 0,
    results: [],
    ranAt: now,
  };
  if (!wantExpired && !wantDepleted) return summary;

  // One row per package: the head id deletePackage takes, the aggregates that
  // decide its state, and the earliest depletion stamp any member carries.
  const groups = db.prepare(
    `SELECT MIN(c.id) AS headId, c.user_id AS userId, c.email AS email,
            MAX(c.expiry_at) AS expiryAt,
            MAX(c.total_bytes) AS totalBytes,
            ${CONFIG_GROUP_USED_SQL} AS used,
            SUM(CASE WHEN c.origin = 'external' THEN 1 ELSE 0 END) AS externalRows,
            MIN(CASE WHEN c.depleted_at > 0 THEN c.depleted_at ELSE NULL END) AS depletedAt,
            COUNT(*) AS rows,
            ${configs.packageStatusSql(now)} AS status
       FROM configs c
      WHERE c.deleted_at = 0
      GROUP BY ${CONFIG_GROUP_KEY_SQL}`
  ).all();
  summary.checked = groups.length;

  // CONFIG_GROUP_KEY_SQL speaks in the alias `c`, so the UPDATE targets carry
  // it too — without the alias SQLite cannot resolve c.sub_id.
  const stamp = db.prepare(
    `UPDATE configs AS c SET depleted_at = ?, updated_at = ?
      WHERE deleted_at = 0 AND ${CONFIG_GROUP_KEY_SQL} = ?`
  );
  const clearStamp = db.prepare(
    `UPDATE configs AS c SET depleted_at = 0
      WHERE deleted_at = 0 AND depleted_at > 0 AND ${CONFIG_GROUP_KEY_SQL} = ?`
  );
  const keyOf = db.prepare(`SELECT ${CONFIG_GROUP_KEY_SQL} AS gkey FROM configs c WHERE c.id = ?`);

  let acted = 0;
  for (const group of groups) {
    const status = String(group.status || '');
    const gkey = keyOf.get(Number(group.headId))?.gkey;
    if (status !== 'depleted' && Number(group.depletedAt || 0) > 0 && !dryRun) {
      // The package was topped up / extended since the stamp: the old moment no
      // longer describes it. Clear so a later depletion starts its own window.
      clearStamp.run(gkey);
    }
    if (status !== 'expired' && status !== 'depleted') continue;
    if (status === 'expired' && !wantExpired) continue;
    if (status === 'depleted' && !wantDepleted) continue;
    if (Number(group.externalRows || 0) > 0 && !includeExternal) {
      summary.skippedExternal += 1;
      continue;
    }

    let since = 0;
    if (status === 'expired') {
      since = Number(group.expiryAt || 0);
    } else {
      const stamped = Number(group.depletedAt || 0);
      if (!stamped) {
        // First sighting: start the grace window now, delete on a later sweep.
        if (!dryRun) {
          stamp.run(now, now, gkey);
          summary.stamped += 1;
          summary.results.push({ configId: Number(group.headId), email: String(group.email || ''), action: 'stamped', status });
        } else {
          summary.results.push({ configId: Number(group.headId), email: String(group.email || ''), action: 'would_stamp', status });
        }
        continue;
      }
      since = stamped;
    }
    if (now - since < graceMs) {
      summary.skippedGrace += 1;
      continue;
    }
    summary.eligible += 1;
    if (acted >= maxPerRun) {
      summary.capped += 1;
      continue;
    }
    const reason = status === 'expired' ? 'expired_grace' : 'depleted_grace';
    if (dryRun) {
      acted += 1;
      summary.deleted += 1;
      summary.results.push({ configId: Number(group.headId), email: String(group.email || ''), action: 'would_delete', status, reason });
      continue;
    }
    try {
      const result = await configs.deletePackage(Number(group.headId), null, null, {
        auto: true,
        notify: Boolean(cfg.notifyReseller),
        reason,
      });
      acted += 1;
      summary.deleted += 1;
      summary.results.push({
        configId: Number(group.headId),
        email: String(group.email || ''),
        action: 'deleted',
        status,
        reason,
        rows: Number(result?.rows || 0),
        xuiDeleted: (result?.xuiDeleted || []).length,
        alreadyGone: (result?.alreadyGone || []).length,
      });
    } catch (err) {
      // One refusing node must not stop the rest of the sweep.
      summary.failed += 1;
      summary.results.push({ configId: Number(group.headId), email: String(group.email || ''), action: 'failed', status, reason, error: String(err.message || err) });
    }
  }

  if (!dryRun) {
    const compact = {
      checked: summary.checked,
      eligible: summary.eligible,
      deleted: summary.deleted,
      stamped: summary.stamped,
      skippedExternal: summary.skippedExternal,
      skippedGrace: summary.skippedGrace,
      capped: summary.capped,
      failed: summary.failed,
    };
    settings.updateSection('cleanup', { lastRunAt: now, lastSummary: JSON.stringify(compact) });
    systemAudit('cleanup.run', 'settings', 'cleanup', compact);
  }
  return summary;
}

module.exports = { runCleanup };
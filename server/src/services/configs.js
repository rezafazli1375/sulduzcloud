'use strict';

const { getDb } = require('../db');
const xui = require('../xui');
const config = require('../config');
const settings = require('../settings');
const usersService = require('./users');
const pricing = require('./pricing');
const serversService = require('./servers');
const inboundsService = require('./inbounds');
const {
  ApiError,
  dayKey,
  gbToBytes,
  bytesToGb,
  sanitizeConfig,
  statusOf,
  randomToken,
  randomUUID,
  escapeLike,
  safeJsonParse,
  pageParams,
  CONFIG_GROUP_KEY_SQL,
  CONFIG_GROUP_USED_SQL,
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

function publicBaseUrl() {
  return String(config.publicUrl || '').trim().replace(/\/+$/, '');
}

// One x-ui client = one subscription id on the node's own subscription server.
// The client is identified by the panel that holds it and its email, which is
// exactly how distinctClients() groups the rows of a package.
function clientKeyOf(row) {
  return `${Number(row?.server_id || 0)}|${String(row?.email || '').toLowerCase()}`;
}

// The live x-ui clients behind a customer package, each with its rows. A
// subscription adopted from another panel is ONE client kept as one row per
// inbound, so his rows collapse into a single group; a package that really
// holds several clients keeps one group per client.
function packageClientGroups(row) {
  return distinctClients(packageRows(row));
}

function isOneClientPackage(row) {
  return packageClientGroups(row).length <= 1;
}

/**
 * The subscription URL the customer should be handed.
 *
 * A package is ONE x-ui client attached to several inbounds whenever the client
 * was adopted from a panel or ordered through this panel since v1.4.18. That
 * client's own subscription link lives on the node — the base configured per
 * server (sub_base, e.g. https://sbs.example.com:8443/sub) — and x-ui already
 * lists every inbound the client is attached to there, so the panel has nothing
 * to aggregate and must not insert itself between the customer and the node.
 *
 * Only when a package genuinely spans MORE THAN ONE x-ui client can no single
 * node link cover it: x-ui 3.2.5+ rejects a subId already in use, so each client
 * carries its own private subId and this panel serves one combined subscription
 * for the group token instead.
 */
function nodeSubUrlFor(config, server) {
  const xuiCfg = settings.getSetting('xui');
  let base = String((server && server.subBase) || '').replace(/\/+$/, '');
  // The legacy settings.xui.subBase only belongs to the primary panel.
  if (!base) {
    const primary = serversService.defaultServer();
    if (!primary || Number(primary.id) === Number(server?.id || 0)) {
      base = String(xuiCfg.subBase || '').replace(/\/+$/, '');
    }
  }
  // A single config uses the same value for both, so preferring the per-client
  // subId keeps the classic link and the adopted one working the same way.
  const subId = String(config.xui_sub_id || config.sub_id || '');
  if (!base || !subId) return '';
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return `${base}/${encodeURIComponent(subId)}`;
}

function panelSubUrlFor(config) {
  if (!config || !config.sub_id) return '';
  const base = publicBaseUrl();
  return base ? `${base}/api/sub/${encodeURIComponent(config.sub_id)}` : '';
}

function subUrlFor(config, server) {
  const nodeUrl = nodeSubUrlFor(config, server);
  if (isOneClientPackage(config)) return nodeUrl || panelSubUrlFor(config);
  return panelSubUrlFor(config) || nodeUrl;
}

/**
 * Every subscription link a package can be reached by, for the detail drawer:
 * the node link of each x-ui client it holds, plus the panel's aggregated link
 * when there is more than one client. `primary` is what the panel hands out.
 */
function subscriptionsOf(row, server) {
  const srv = server || serverOfConfig(row);
  const groups = packageClientGroups(row);
  const node = groups.map((members) => {
    const head = members.find((item) => item.xui_sub_id) || members[0] || {};
    return {
      email: String(head.email || ''),
      subId: String(head.xui_sub_id || head.sub_id || ''),
      url: nodeSubUrlFor(head, srv),
      origin: String(head.origin || 'panel'),
      inboundCount: members.length,
    };
  }).filter((item) => item.url);
  const aggregated = panelSubUrlFor(row);
  const multiple = groups.length > 1;
  return {
    clientCount: groups.length,
    node,
    aggregated: multiple ? aggregated : '',
    primary: (!multiple && node[0]?.url) ? node[0].url : (aggregated || node[0]?.url || ''),
    source: (!multiple && node[0]?.url) ? 'node' : (aggregated ? 'panel' : node[0]?.url ? 'node' : ''),
  };
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

// Client names follow "<telegram-id>-<5 random digits>", e.g. 123456789-85743.
// The numeric suffix keeps the x-ui email readable while staying unique, and
// the prefix ties every subscription to its reseller (see importTelegramClients).
// Accounts without a Telegram id keep the older "<username>-<digits>" shape.
function emailFor(user) {
  const telegramId = String(user?.telegram_id ?? user?.telegramId ?? '').trim();
  const base = telegramId || slug(user?.username) || `r${Number(user?.id) || 0}`;
  const exists = getDb().prepare('SELECT 1 FROM configs WHERE email = ?');
  for (let i = 0; i < 24; i += 1) {
    const candidate = `${base}-${Math.floor(10000 + Math.random() * 90000)}`;
    if (!exists.get(candidate)) return candidate;
  }
  return `${base}-${String(Date.now()).slice(-6)}`;
}

// A Telegram id can appear anywhere in a client name: this panel writes
// "<telegramId>-<random>", while seller panels prefix the plan ("german🇩🇪-<id>-<random>",
// "SG-<id>-<random>"). Comparing whole digit runs keeps a longer id from matching
// by prefix; the id must not be the last run, because the last run is the random
// suffix and could accidentally equal a short id.
function telegramIdMatches(email, telegramId) {
  const value = String(email || '').trim();
  const id = String(telegramId || '').trim();
  if (!value || !id) return false;
  if (value === id) return true;
  if (value.startsWith(`${id}-`) || value.startsWith(`${id}_`) || value.startsWith(`${id} `)) return true;
  const runs = value.match(/\d+/g) || [];
  return runs.some((run, index) => run === id && index < runs.length - 1);
}

/**
 * Adopt every x-ui client that already exists under this reseller's Telegram id.
 * Called when a reseller is created/edited and from the manual "fetch" action.
 * Existing subscriptions are never charged and never taken from another
 * reseller; running it twice is idempotent.
 */
async function importTelegramClients(user, req) {
  const summary = {
    telegramId: String(user?.telegram_id || '').trim(),
    enabled: true, matched: 0, servers: 0, imported: 0, restored: 0, refreshed: 0,
    attached: 0, skipped: 0, conflicts: 0, failed: 0, errors: [],
  };
  if (!user || !summary.telegramId) return summary;
  // The reseller (or the admin on their behalf) turned adoption off: nothing is
  // imported and the already-adopted rows stay hidden by listConfigs.
  if (Number(user.import_configs ?? 1) === 0) {
    summary.enabled = false;
    return summary;
  }
  const db = getDb();
  const serverList = serversService.listServers({ includeDisabled: false });
  summary.servers = serverList.length;
  const findInbound = db.prepare('SELECT id FROM inbounds WHERE server_id = ? AND xui_id = ?');
  // One adopted x-ui client can be attached to several inbounds, and each of them
  // is a row of its own here, so every lookup by email has to see all of them.
  const findEmailRows = db.prepare('SELECT id, inbound_id, user_id, origin, sub_id, deleted_at FROM configs WHERE email = ?');
  const insertConfig = db.prepare(
    `INSERT INTO configs (user_id, inbound_id, server_id, email, sub_id, xui_sub_id, uuid, flow, label,
      customer_name, customer_phone, note, total_bytes, expiry_at, enabled, status, sync_status,
      up_bytes, down_bytes, last_up, last_down, last_online_at, last_synced_at, created_at, updated_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?, ?, ?, 'active', '', ?, ?, ?, ?, ?, ?, ?, ?, 'external')`
  );
  const restoreConfig = db.prepare(
    `UPDATE configs SET user_id = ?, inbound_id = ?, server_id = ?, email = ?, sub_id = ?, xui_sub_id = ?,
       uuid = ?, flow = ?, label = '', customer_name = '', customer_phone = '', note = ?, total_bytes = ?,
       expiry_at = ?, enabled = ?, status = 'active', sync_status = '', up_bytes = ?, down_bytes = ?,
       last_up = ?, last_down = ?, last_online_at = ?, last_synced_at = ?, created_at = ?, updated_at = ?,
       origin = 'external', deleted_at = 0
     WHERE id = ?`
  );
  // Live quota/usage/expiry of an already adopted subscription. Notes and the
  // customer fields stay as the reseller edited them. The group token is only
  // filled in when the row has none yet: a customer whose link already works
  // keeps the token their subscription URL is built from.
  const refreshConfig = db.prepare(
    `UPDATE configs SET inbound_id = ?, server_id = ?, xui_sub_id = ?, uuid = ?, flow = ?,
       total_bytes = ?, expiry_at = ?, enabled = ?, up_bytes = ?, down_bytes = ?,
       last_up = ?, last_down = ?, last_online_at = ?, last_synced_at = ?, sync_status = '',
       sub_id = CASE WHEN sub_id = '' THEN ? ELSE sub_id END, updated_at = ?
     WHERE id = ?`
  );

  for (const server of serverList) {
    let clients = [];
    try {
      clients = await xui.listClients(server);
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(`${server.name || server.id}: ${err.message}`);
      continue;
    }
    const matched = clients.filter((client) => (
      String(client.tgId || '') === summary.telegramId
      || telegramIdMatches(client.email, summary.telegramId)
    ));
    if (!matched.length) continue;
    summary.matched += matched.length;

    // A matched client may sit on an inbound this panel has not discovered yet
    // (fresh panel, first sync). Refresh that server once before mapping.
    const known = (client) => (client.inboundIds || [])
      .some((xuiId) => findInbound.get(Number(server.id), Number(xuiId)));
    if (matched.some((client) => !known(client))) {
      try {
        await inboundsService.syncInbounds({ serverId: Number(server.id) });
      } catch (err) {
        summary.errors.push(`${server.name || server.id} inbound sync: ${err.message}`);
      }
    }

    for (const client of matched) {
      try {
        let inboundIds = (client.inboundIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (!inboundIds.length) {
          // The list endpoint does not always carry the attachment; one lookup
          // per matched client keeps the imported row attached correctly.
          const full = await xui.getClient(client.email, server);
          if (full) {
            inboundIds = (full.inboundIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
            client.uuid = full.uuid || client.uuid;
            client.subId = full.subId || client.subId;
            client.totalBytes = full.totalBytes || client.totalBytes;
            client.expiryAt = full.expiryAt || client.expiryAt;
            client.enabled = full.enabled;
            client.up = full.up;
            client.down = full.down;
            client.lastOnlineAt = full.lastOnlineAt || client.lastOnlineAt;
          }
        }
        // Every inbound this client is attached to and this panel knows about is
        // part of the same customer. Taking only the first one used to hide the
        // rest of the subscription from the edit drawer, which is what the owner
        // reported for the adopted (old) configs.
        const attached = [];
        const seenInbound = new Set();
        for (const xuiId of inboundIds) {
          const inbound = findInbound.get(Number(server.id), Number(xuiId));
          if (!inbound || seenInbound.has(Number(inbound.id))) continue;
          seenInbound.add(Number(inbound.id));
          attached.push(inbound);
        }
        if (!attached.length) {
          summary.skipped += 1;
          continue;
        }
        summary.attached += attached.length;

        const now = Date.now();
        const up = Number(client.up || 0);
        const down = Number(client.down || 0);

        const rows = findEmailRows.all(client.email);
        if (rows.some((item) => !item.deleted_at && Number(item.user_id) !== Number(user.id))) {
          // Never move a live subscription to another reseller.
          summary.conflicts += 1;
          continue;
        }
        // One group token for the whole customer, so the drawer, the shared pool
        // and the subscription URL see one customer with several inbounds. A
        // token that already exists on any sibling is reused: the customer's
        // current link must keep working.
        const tokenHolder = rows.find((item) => !item.deleted_at && item.sub_id)
          || rows.find((item) => item.sub_id);
        const groupToken = tokenHolder ? String(tokenHolder.sub_id) : randomToken(16);

        for (const inbound of attached) {
          const existing = rows.find((item) => Number(item.inbound_id) === Number(inbound.id));
          const common = [
            Number(user.id),
            Number(inbound.id),
            Number(server.id),
            String(client.email),
            groupToken,
            String(client.subId || ''),
            String(client.uuid || ''),
            String(client.flow || ''),
            String(client.comment || '').slice(0, 500),
            Number(client.totalBytes || 0),
            Number(client.expiryAt || 0),
            client.enabled === false ? 0 : 1,
            up,
            down,
            up,
            down,
            Number(client.lastOnlineAt || 0),
            now,
            Number(client.createdAt || now),
            now,
          ];
          if (existing && !existing.deleted_at) {
            // Re-running the fetch refreshes the adopted subscriptions. Rows that
            // were created through this panel are left to the normal sync.
            if (existing.origin === 'external') {
              refreshConfig.run(
                Number(inbound.id),
                Number(server.id),
                String(client.subId || ''),
                String(client.uuid || ''),
                String(client.flow || ''),
                Number(client.totalBytes || 0),
                Number(client.expiryAt || 0),
                client.enabled === false ? 0 : 1,
                up,
                down,
                up,
                down,
                Number(client.lastOnlineAt || 0),
                now,
                groupToken,
                now,
                Number(existing.id)
              );
              summary.refreshed += 1;
            } else {
              summary.skipped += 1;
            }
            continue;
          }
          if (existing) {
            restoreConfig.run(...common, Number(existing.id));
            summary.restored += 1;
          } else {
            insertConfig.run(...common);
            summary.imported += 1;
          }
        }
      } catch (err) {
        summary.failed += 1;
        summary.errors.push(`${client.email}: ${err.message}`);
      }
    }
  }
  // Importing never touches the wallet: these subscriptions were paid for
  // before the reseller existed in this panel.
  if (summary.imported || summary.restored || summary.refreshed) {
    audit(req, 'config.import', 'user', Number(user.id), summary);
  }
  return summary;
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

  const inboundIds = [...new Set((Array.isArray(input.inboundIds) ? input.inboundIds : [input.inboundId])
    .map(Number)
    .filter((n) => Number.isFinite(n)))];
  if (!inboundIds.length) throw new ApiError(422, 'inbound_required', 'Select at least one inbound');
  // Panel v1.4.16: the reseller's fixed inbound is the base of every package, so
  // it joins the order even when the form did not tick it. Choosing only the
  // fixed inbound keeps the classic single-inbound behaviour; a package that
  // always carries its base can never be left without a channel to connect on.
  const fixedId = usersService.fixedInboundId(user);
  if (fixedId > 0 && !inboundIds.includes(fixedId)) {
    const fixedInbound = getInboundRow(fixedId);
    if (!fixedInbound) {
      throw new ApiError(422, 'invalid_fixed_inbound', 'این اینباند ثابت در پنل پیدا نشد / The fixed inbound is no longer in the panel');
    }
    if (!fixedInbound.enabled) {
      throw new ApiError(422, 'fixed_inbound_disabled', `اینباند «${fixedInbound.remark}» غیرفعال است / The fixed inbound is disabled`);
    }
    const firstInbound = getInboundRow(inboundIds[0]);
    if (firstInbound && Number(firstInbound.server_id) !== Number(fixedInbound.server_id)) {
      throw new ApiError(422, 'fixed_inbound_server_mismatch', 'اینباند ثابت این نماینده روی پنل دیگری است / This reseller’s fixed inbound is on another server');
    }
    inboundIds.unshift(fixedId);
  }

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
    if (allowed && !allowed.includes(inboundId) && inboundId !== fixedId) {
      throw new ApiError(403, 'inbound_forbidden', 'This reseller cannot use the selected inbound');
    }
    if (!inbound.visible && req?.user?.role !== 'admin' && inboundId !== fixedId) {
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
  // Every inbound in one order belongs to one customer package: one customer
  // slot, and the entered GB is the size of the SHARED pool (not per inbound).
  usersService.checkLimits(user, {
    gb,
    days,
    count: 1,
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
  // One group token per order, and since v1.4.18 the order is also ONE x-ui
  // client attached to every inbound that was ordered. A client carries its own
  // subscription id on the node's subscription server, so <sub_base>/<subId>
  // already lists all of the customer's inbounds — the link he is handed stays
  // on the node address configured per server, exactly like the subscriptions
  // this panel adopts. The token and the x-ui subId are the same value, so a
  // rotation of either keeps both links pointing at the same place.
  const subId = randomToken(16);
  const email = emailFor(user);
  const uuid = randomUUID();
  const comment = [input.label, input.customerName, input.customerPhone].filter(Boolean).join(' | ').slice(0, 120);

  try {
    const server = priced[0].server;
    // All inbounds of one order are on one panel (checked above), so one client
    // can be attached to all of them in a single x-ui call.
    const xuiIds = [...new Set(priced.map((item) => Number(item.inbound.xui_id)).filter((n) => Number.isFinite(n) && n > 0))];
    const createdClient = await xui.addClient(
      {
        email,
        subId,
        uuid,
        flow: '',
        totalBytes,
        expiryAt,
        enabled: true,
        comment,
      },
      xuiIds,
      server
    );
    createdEmails.push({ email, server });
    const liveSubId = String(createdClient?.subId || subId);
    const liveUuid = String(createdClient?.uuid || uuid);

    for (const { inboundId } of priced) {
      const info = db.prepare(
        `INSERT INTO configs (user_id, inbound_id, server_id, email, sub_id, xui_sub_id, uuid, flow, label, customer_name,
          customer_phone, note, total_bytes, expiry_at, enabled, status, sync_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, 1, 'active', '', ?, ?)`
      ).run(
        user.id,
        inboundId,
        Number(server.id),
        email,
        subId,
        liveSubId,
        liveUuid,
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
      chargeReseller(user, totalPrice, `ایجاد بسته ${inboundIds.length} اینباندی (${gb} GB مشترک / ${days} روز)`, 'purchase', req);
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
      body: `${created.length} اینباند با ${gb} گیگابایت مشترک و ${days} روز ایجاد شد.`,
      link: '/reseller/configs',
    });
  }
  return created;
}

const CONFIG_STATUSES = ['active', 'expired', 'depleted', 'disabled', 'mixed'];

function buildWhere(filters, viewer, { withStatus = true } = {}) {
  const now = Date.now();
  const where = ['c.deleted_at = 0'];
  const params = [];
  if (viewer && viewer.role !== 'admin') { where.push('c.user_id = ?'); params.push(Number(viewer.id)); }
  else if (filters.userId) { where.push('c.user_id = ?'); params.push(Number(filters.userId)); }
  // Adopted subscriptions (origin='external') leave the list while their owner
  // has the adoption switch off. Nothing is deleted; turning it back on shows
  // the exact same rows again.
  where.push("(c.origin <> 'external' OR c.user_id IN (SELECT id FROM users WHERE import_configs = 1))");
  if (filters.origin === 'panel' || filters.origin === 'external') {
    where.push('c.origin = ?');
    params.push(String(filters.origin));
  }
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
  // Row-level status applies to the flat (API v1) view and CSV exports; the
  // grouped customer list filters complete packages instead (see listConfigs).
  if (withStatus && filters.status && CONFIG_STATUSES.includes(String(filters.status))) {
    where.push(`${statusExpr} = ?`);
    params.push(String(filters.status));
  }
  if (filters.expiringDays) {
    const until = now + Number(filters.expiringDays) * DAY_MS;
    where.push(`c.expiry_at > 0 AND c.expiry_at > ${now} AND c.expiry_at <= ${until}`);
  }
  return { clause: `WHERE ${where.join(' AND ')}`, params, statusExpr };
}

// Match groupRows(): a package belongs to one reseller on one server. Names
// are not identities, and legacy rows without a token must stay independent.
// `flat: true` preserves the original sanitized API v1 response contract.
const GROUP_KEY_SQL = CONFIG_GROUP_KEY_SQL;

// One customer package is ONE shared traffic pool, exactly like tagging several
// inbounds to a single 3x-ui subscription: the quota is the package size (every
// member is created with it) and the usage is the sum of all member counters.
// `base` is the config the caller opened; its identity fields stay on the row.
function mergeGroup(members, base = null) {
  const first = base || members[0];
  const now = Date.now();
  // Traffic is counted per x-ui CLIENT and only then added together. A package the
  // panel created itself holds one distinct client per inbound, so their counters
  // genuinely add up. An adopted customer is ONE client attached to several inbounds:
  // every one of its rows carries the SAME live counters, and summing them would
  // report the traffic once per inbound. A package can also hold both at once (an
  // adopted customer given a new inbound), so each distinct email contributes its own
  // highest row and those are summed. Must mirror CONFIG_GROUP_USED_SQL.
  const perClient = new Map();
  for (const member of members) {
    const key = String(member.email || '') || `id:${member.id}`;
    const seen = perClient.get(key) || { used: 0, up: 0, down: 0 };
    perClient.set(key, {
      used: Math.max(seen.used, Number(member.used || 0)),
      up: Math.max(seen.up, Number(member.up || 0)),
      down: Math.max(seen.down, Number(member.down || 0)),
    });
  }
  const combine = (key) => [...perClient.values()].reduce((sum, item) => sum + item[key], 0);
  const used = combine('used');
  const up = combine('up');
  const down = combine('down');
  const quota = members.reduce((max, m) => Math.max(max, Number(m.totalBytes || 0)), 0);
  const expiryAt = members.reduce((max, m) => Math.max(max, Number(m.expiryAt || 0)), 0);
  const enabledCount = members.filter((m) => m.enabled).length;
  let status = 'active';
  if (expiryAt > 0 && expiryAt <= now) status = 'expired';
  else if (quota > 0 && used >= quota) status = 'depleted';
  else if (enabledCount === 0) status = 'disabled';
  else if (enabledCount < members.length || members.some((m) => m.status !== 'active')) status = 'mixed';
  return {
    ...first,
    up,
    down,
    used,
    totalBytes: quota,
    totalGb: bytesToGb(quota),
    remaining: quota > 0 ? Math.max(0, quota - used) : null,
    usagePercent: quota > 0 ? Math.min(100, Math.round((used / quota) * 1000) / 10) : null,
    expiryAt,
    enabled: enabledCount > 0,
    status,
    groupCount: members.length,
    groupIds: members.map((m) => m.id),
    groupStatus: status,
    expiryMixed: members.some((m) => Number(m.expiryAt || 0) !== Number(first.expiryAt || 0)),
    inbounds: members.map((m) => ({
      id: m.inboundId,
      configId: m.id,
      remark: m.inbound?.remark || `#${m.inboundId}`,
      protocol: m.inbound?.protocol || '',
      network: m.inbound?.network || '',
      serverName: m.inbound?.serverName || '',
      status: m.status,
      totalBytes: m.totalBytes,
      used: m.used,
      expiryAt: m.expiryAt,
      enabled: m.enabled,
    })),
  };
}

// Package-level status expressed over SQL aggregates; must mirror mergeGroup:
// expired -> depleted (aggregate usage) -> disabled (all members) -> active or mixed.
function packageStatusSql(now = Date.now()) {
  return `CASE
    WHEN MAX(c.expiry_at) > 0 AND MAX(c.expiry_at) <= ${now} THEN 'expired'
    WHEN MAX(c.total_bytes) > 0 AND ${CONFIG_GROUP_USED_SQL} >= MAX(c.total_bytes) THEN 'depleted'
    WHEN SUM(c.enabled) = 0 THEN 'disabled'
    WHEN SUM(CASE WHEN c.enabled = 1 AND (c.expiry_at = 0 OR c.expiry_at > ${now})
              AND (c.total_bytes = 0 OR c.up_bytes + c.down_bytes < c.total_bytes) THEN 1 ELSE 0 END) = COUNT(*)
      THEN 'active'
    ELSE 'mixed' END`;
}

function listConfigs(filters = {}, viewer) {
  const db = getDb();
  const { page, pageSize, offset } = pageParams(filters, 20, 200);
  // Grouped listings filter whole packages; flat listings keep row semantics.
  const { clause, params, statusExpr } = buildWhere(filters, viewer, { withStatus: Boolean(filters.flat) });
  const wantedStatus = !filters.flat && CONFIG_STATUSES.includes(String(filters.status)) ? String(filters.status) : '';
  const inboundCache = new Map();
  const resellerCache = new Map();
  const sanitizeRow = (row) => {
    if (!inboundCache.has(row.inbound_id)) inboundCache.set(row.inbound_id, getInboundRow(row.inbound_id));
    if (!resellerCache.has(row.user_id)) resellerCache.set(row.user_id, getResellerRow(row.user_id));
    const config = sanitizeConfig(row, inboundCache.get(row.inbound_id), resellerCache.get(row.user_id));
    if (row.computed_status && row.computed_status !== config.status) config.status = row.computed_status;
    return config;
  };

  if (filters.flat) {
    const total = db.prepare(`SELECT COUNT(*) AS c FROM configs c ${clause}`).get(...params).c;
    const rows = db.prepare(
      `SELECT c.*, ${statusExpr} AS computed_status FROM configs c ${clause}
       ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);
    return { total, page, pageSize, rows: rows.map(sanitizeRow) };
  }

  const having = wantedStatus ? `HAVING ${packageStatusSql()} = ?` : '';
  const havingParams = wantedStatus ? [wantedStatus] : [];
  const total = Number(db.prepare(
    `SELECT COUNT(*) AS c FROM (
       SELECT ${GROUP_KEY_SQL} AS gkey FROM configs c ${clause} GROUP BY gkey ${having}
     )`
  ).get(...params, ...havingParams).c || 0);
  const pageKeys = db.prepare(
    `SELECT ${GROUP_KEY_SQL} AS gkey FROM configs c ${clause}
     GROUP BY gkey ${having}
     ORDER BY MAX(c.created_at) DESC, MIN(c.id) DESC
     LIMIT ? OFFSET ?`
  ).all(...params, ...havingParams, pageSize, offset);
  if (!pageKeys.length) return { total, page, pageSize, rows: [] };

  const keys = pageKeys.map((item) => item.gkey);
  const marks = keys.map(() => '?').join(',');
  // Filters select matching packages, not a truncated list of their members.
  // Keep ownership restrictions when expanding each package to its full list.
  const scope = buildWhere({ userId: filters.userId }, viewer);
  const members = db.prepare(
    `SELECT c.*, ${GROUP_KEY_SQL} AS gkey, ${statusExpr} AS computed_status FROM configs c
     ${scope.clause} AND ${GROUP_KEY_SQL} IN (${marks})
     ORDER BY c.id`
  ).all(...scope.params, ...keys);

  const byKey = new Map();
  for (const row of members) {
    if (!byKey.has(row.gkey)) byKey.set(row.gkey, []);
    byKey.get(row.gkey).push(sanitizeRow(row));
  }
  const rows = [];
  for (const key of keys) {
    const groupMembers = byKey.get(key) || [];
    if (!groupMembers.length) continue;
    rows.push(mergeGroup(groupMembers));
  }
  return { total, page, pageSize, rows };
}

function configDetail(id, viewer) {
  const row = getConfigRow(id);
  if (!row || row.deleted_at) throw new ApiError(404, 'not_found', 'Config not found');
  if (viewer && viewer.role !== 'admin' && Number(row.user_id) !== Number(viewer.id)) {
    throw new ApiError(403, 'forbidden', 'You do not have access to this config');
  }
  return { row, config: hydrate(row) };
}

// The panel drawer always shows the customer package: one shared traffic pool,
// one expiry and one status, with the opened config's identity kept on top.
function packageView(row) {
  const db = getDb();
  const members = packageRows(row);
  const list = members.map((item) => hydrate(item)).filter(Boolean);
  if (!list.length) return hydrate(row);
  return mergeGroup(list, list.find((item) => Number(item.id) === Number(row.id)) || list[0]);
}

function detailView(id, viewer) {
  const { row } = configDetail(id, viewer);
  return { row, config: packageView(row) };
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
    if (client && client.subId && client.subId !== row.xui_sub_id) {
      getDb().prepare('UPDATE configs SET xui_sub_id = ?, updated_at = ? WHERE id = ?').run(client.subId, Date.now(), row.id);
      row.xui_sub_id = client.subId;
    }
  } catch (err) {
    if (!error) error = err.message;
  }
  const subscriptions = subscriptionsOf(row, server);
  return {
    links,
    subUrl: subscriptions.primary,
    subscriptions,
    error,
    // The customer-facing subscription id is the group token; the per-client
    // x-ui subId stays private to the panel.
    client: client ? { uuid: client.uuid, subId: row.sub_id, inboundIds: client.inboundIds } : null,
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
  const targets = packageRows(row);
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

  // The added GB grows ONE shared pool, so the new pool size is computed once
  // from the package quota and written to every member (this also heals members
  // whose stored quota drifted apart).
  const groupQuota = targets.reduce((max, target) => Math.max(max, Number(target.total_bytes || 0)), 0);
  const sharedTotal = addBytes > 0 ? (groupQuota > 0 ? groupQuota + addBytes : addBytes) : groupQuota;
  const groupExpiry = targets.reduce((max, target) => Math.max(max, Number(target.expiry_at || 0)), 0);
  const sharedExpiry = addDays > 0
    ? (groupExpiry > 0 ? Math.max(Date.now(), groupExpiry) : Date.now()) + addDays * DAY_MS
    : 0;
  const updates = targets.map((target) => {
    const currentExpiry = Number(target.expiry_at || 0);
    return {
      row: target,
      currentExpiry,
      currentTotal: Number(target.total_bytes || 0),
      newExpiry: addDays > 0 ? sharedExpiry : currentExpiry,
      newTotal: addBytes > 0 ? sharedTotal : Number(target.total_bytes || 0),
    };
  });

  const byRowId = new Map(updates.map((item) => [Number(item.row.id), item]));
  // One batch per x-ui client: an adopted customer is one client spread over
  // several rows, and renewing him must be one panel write, not one per inbound.
  const applied = [];
  try {
    for (const client of distinctClients(targets)) {
      const batch = client.map((item) => byRowId.get(Number(item.id))).filter(Boolean);
      if (!batch.length) continue;
      try {
        await applyToXui(batch[0].row, {
          totalBytes: batch[0].newTotal,
          expiryAt: batch[0].newExpiry,
          enabled: true,
        });
      } catch (err) {
        // A sibling whose x-ui client vanished must not block the rest of the
        // package; the config being extended itself still fails loudly.
        if (err?.code === 'xui_client_missing' && !client.some((item) => Number(item.id) === Number(row.id))) {
          console.error(`[configs] extend: sibling ${batch[0].row.email} missing in x-ui, skipped`);
          continue;
        }
        throw err;
      }
      applied.push(batch);
    }
    if (billingEnabled() && amount > 0) {
      chargeReseller(reseller, amount, `تمدید بسته ${targets.length} اینباندی (+${gb}GB مشترک / +${addDays}d)`, 'renew', req);
    }
  } catch (err) {
    for (const batch of applied.reverse()) {
      try {
        await applyToXui(batch[0].row, {
          totalBytes: batch[0].currentTotal,
          expiryAt: batch[0].currentExpiry,
          enabled: Boolean(batch[0].row.enabled),
        });
      } catch (revertErr) {
        console.error(`[configs] extend: revert failed for ${batch[0].row.email}:`, revertErr.message);
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
  for (const batch of applied) {
    if (resetUsage) {
      try {
        await xui.resetTraffic(batch[0].row.email, serverOfConfig(batch[0].row));
      } catch (err) {
        console.error(`[configs] extend: reset traffic failed for ${batch[0].row.email}:`, err.message);
      }
    }
    for (const update of batch) {
      updateDb.run(update.newTotal, update.newExpiry, now, now, update.row.id);
      if (resetUsage) resetDb.run(update.row.id);
    }
  }

  audit(req, 'config.extend', 'config', row.id, {
    gb,
    days,
    resetUsage,
    amount,
    groupSize: targets.length,
    applied: applied.reduce((sum, batch) => sum + batch.length, 0),
  });
  if (reseller) {
    notifyUser(reseller.id, {
      type: 'success',
      title: 'کانفیگ تمدید شد',
      body: `${row.email} — ${gb ? `+${gb}GB ` : ''}${addDays ? `+${addDays} روز` : ''}`.trim()
        + (targets.length > 1 ? ` (${targets.length} اینباند، حجم مشترک)` : ''),
      link: '/reseller/configs',
    });
  }
  return packageView(getConfigRow(row.id));
}

function db() {
  return getDb();
}

// Quota, expiry and enable/disable belong to the PACKAGE. Editing them writes
// the same value to every inbound of the subscription so the shared pool stays
// one number, exactly like a 3x-ui client attached to several inbounds.
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

  const targets = packageRows(row);
  const applied = [];
  try {
    for (const client of distinctClients(targets)) {
      try {
        await applyToXui(client[0], next);
      } catch (err) {
        if (err?.code === 'xui_client_missing' && !client.some((item) => Number(item.id) === Number(row.id))) {
          console.error(`[configs] quota: sibling ${client[0].email} missing in x-ui, skipped`);
          continue;
        }
        throw err;
      }
      applied.push(...client);
    }
  } catch (err) {
    for (const client of distinctClients(applied).reverse()) {
      try {
        await applyToXui(client[0], {
          totalBytes: Number(client[0].total_bytes || 0),
          expiryAt: Number(client[0].expiry_at || 0),
          enabled: Boolean(client[0].enabled),
        });
      } catch (revertErr) {
        console.error(`[configs] quota: revert failed for ${client[0].email}:`, revertErr.message);
      }
    }
    throw err;
  }

  const fields = [];
  const values = [];
  if (next.totalBytes !== undefined) { fields.push('total_bytes = ?'); values.push(next.totalBytes); }
  if (next.expiryAt !== undefined) { fields.push('expiry_at = ?'); values.push(next.expiryAt); }
  if (next.enabled !== undefined) { fields.push('enabled = ?'); values.push(next.enabled ? 1 : 0); }
  fields.push('sync_status = ?', 'last_synced_at = ?', 'updated_at = ?');
  values.push('', Date.now(), Date.now());
  const update = db().prepare(`UPDATE configs SET ${fields.join(', ')} WHERE id = ?`);
  for (const target of applied) update.run(...values, target.id);
  audit(req, 'config.quota', 'config', row.id, { ...next, groupSize: applied.length });
  return packageView(getConfigRow(row.id));
}

async function toggleConfig(id, enabled, req, viewer) {
  const { row } = configDetail(id, viewer);
  const value = Boolean(enabled);
  const targets = packageRows(row);
  const applied = [];
  try {
    for (const client of distinctClients(targets)) {
      try {
        await xui.setEnabled(client[0].email, value, serverOfConfig(client[0]));
      } catch (err) {
        if (err?.code === 'xui_client_missing' && !client.some((item) => Number(item.id) === Number(row.id))) {
          console.error(`[configs] toggle: sibling ${client[0].email} missing in x-ui, skipped`);
          continue;
        }
        throw err;
      }
      applied.push(...client);
    }
  } catch (err) {
    for (const client of distinctClients(applied).reverse()) {
      try {
        await xui.setEnabled(client[0].email, !value, serverOfConfig(client[0]));
      } catch (revertErr) {
        console.error(`[configs] toggle: revert failed for ${client[0].email}:`, revertErr.message);
      }
    }
    throw err;
  }
  const now = Date.now();
  const update = db().prepare('UPDATE configs SET enabled = ?, sync_status = ?, updated_at = ? WHERE id = ?');
  for (const target of applied) update.run(value ? 1 : 0, '', now, target.id);
  audit(req, 'config.toggle', 'config', row.id, { enabled: value, groupSize: applied.length });
  return packageView(getConfigRow(row.id));
}

// Resetting usage clears the whole shared pool, so every inbound starts at
// zero. A package that was cut off for running out of traffic is re-enabled,
// because the pool is no longer exhausted.
async function resetUsage(id, req, viewer) {
  const { row } = configDetail(id, viewer);
  const targets = packageRows(row);
  const clients = distinctClients(targets);
  const quota = targets.reduce((max, target) => Math.max(max, Number(target.total_bytes || 0)), 0);
  // The pool is per x-ui client: an adopted customer's counters repeat on every
  // one of his rows, so summing rows would call him depleted when he isn't.
  const used = clients
    .reduce((sum, client) => sum + Math.max(...client.map((target) => Number(target.up_bytes || 0) + Number(target.down_bytes || 0))), 0);
  const wasDepleted = quota > 0 && used >= quota;
  const clearRow = db().prepare('UPDATE configs SET up_bytes = 0, down_bytes = 0, last_up = 0, last_down = 0, updated_at = ? WHERE id = ?');
  let reset = 0;
  for (const client of clients) {
    try {
      await xui.resetTraffic(client[0].email, serverOfConfig(client[0]));
      for (const target of client) clearRow.run(Date.now(), target.id);
      reset += 1;
    } catch (err) {
      if (err?.code === 'xui_client_missing' && !client.some((item) => Number(item.id) === Number(row.id))) {
        console.error(`[configs] reset: sibling ${client[0].email} missing in x-ui, skipped`);
        continue;
      }
      throw err;
    }
  }
  if (wasDepleted) {
    for (const client of clients) {
      try {
        await xui.setEnabled(client[0].email, true, serverOfConfig(client[0]));
        for (const target of client) {
          db().prepare('UPDATE configs SET enabled = 1, sync_status = ?, updated_at = ? WHERE id = ?')
            .run('', Date.now(), target.id);
        }
      } catch (err) {
        console.error(`[configs] reset: re-enable failed for ${client[0].email}:`, err.message);
      }
    }
  }
  audit(req, 'config.reset_usage', 'config', row.id, { groupSize: reset, reEnabled: wasDepleted });
  return packageView(getConfigRow(row.id));
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

async function removeConfig(id, { hard = false, silent = false, force = false } = {}, req, viewer) {
  const { row } = configDetail(id, viewer);
  const user = getResellerRow(row.user_id);
  const fixedId = usersService.fixedInboundId(user);
  const members = packageRows(row);
  // The fixed inbound is the base of the package: while the customer has other
  // inbounds, dropping the base would silently take away the channel the
  // reseller guaranteed. A package that is only the base can still be deleted,
  // and `force` (used when a whole reseller is purged) overrides the lock.
  if (!force && fixedId > 0 && Number(row.inbound_id) === fixedId && members.length > 1) {
    throw new ApiError(409, 'fixed_inbound_locked', 'این اینباند ثابت نماینده است؛ تا بسته عضو دیگری دارد از بسته برداشته نمی‌شود / The reseller’s fixed inbound cannot be removed while the package has other inbounds');
  }
  const isExternal = String(row.origin || 'panel') === 'external';
  // The rows of one customer can all stand for the SAME x-ui client: an adopted
  // subscription is one client kept as one row per inbound, and since v1.4.18 a
  // multi-inbound order is created that way too. Removing one channel from such a
  // package takes that inbound off the client — deleting the client would drop
  // every other inbound the customer is connected through.
  const siblings = members.filter((item) => Number(item.id) !== Number(row.id) && clientKeyOf(item) === clientKeyOf(row));
  const keepIds = [...new Set(siblings
    .map((item) => Number(getInboundRow(item.inbound_id)?.xui_id || 0))
    .filter((n) => Number.isFinite(n) && n > 0))];
  const sharedClient = siblings.length > 0 && keepIds.length > 0;
  if (isExternal) {
    // Adopted subscriptions live on another operator's panel and their owners
    // are connected right now. Removing the row here forgets the subscription
    // locally and never sends a delete to that panel.
    console.warn(`[configs] detaching adopted config ${row.email} without touching x-ui`);
  } else if (sharedClient) {
    try {
      await xui.setInbounds(row.email, keepIds, serverOfConfig(row));
    } catch (err) {
      if (!silent) throw err;
      console.error(`[configs] x-ui detach failed for ${row.email}:`, err.message);
    }
  } else {
    try {
      await xui.deleteClient(row.email, false, serverOfConfig(row));
    } catch (err) {
      if (!silent) throw err;
      console.error(`[configs] x-ui delete failed for ${row.email}:`, err.message);
    }
  }
  const db = getDb();
  if (hard) {
    db.prepare('DELETE FROM configs WHERE id = ?').run(row.id);
    db.prepare('DELETE FROM usage_daily WHERE config_id = ?').run(row.id);
  } else {
    db.prepare('UPDATE configs SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), row.id);
  }
  audit(req, 'config.delete', 'config', row.id, {
    email: row.email, hard, detachedOnly: isExternal, inboundDetached: sharedClient, keptInbounds: keepIds.length,
  });
  return {
    ok: true, detachedOnly: isExternal, inboundDetached: sharedClient, keptInbounds: keepIds.length,
  };
}

/**
 * Every config that shares a subscription ID belongs to the same customer
 * group: one /sub/<subId> link lists all of them.
 *
 * Subscriptions adopted out of an existing panel carry no token of ours, but the
 * same x-ui client is attached to several inbounds there and keeps one email
 * across all of them, so those rows are grouped by (email, reseller, server).
 * Without that the panel would treat every inbound of one adopted customer as a
 * separate customer and show only one inbound each.
 */
function groupRows(row) {
  if (!row) return [];
  const db = getDb();
  if (row.sub_id) {
    return db
      .prepare('SELECT * FROM configs WHERE sub_id = ? AND user_id = ? AND server_id = ? AND deleted_at = 0 ORDER BY id')
      .all(row.sub_id, row.user_id, Number(row.server_id || 0) || 1);
  }
  if (String(row.origin || '') === 'external' && row.email) {
    return db
      .prepare(`SELECT * FROM configs WHERE email = ? AND user_id = ? AND server_id = ?
         AND origin = 'external' AND deleted_at = 0 ORDER BY id`)
      .all(row.email, row.user_id, Number(row.server_id || 0) || 1);
  }
  return [];
}

/**
 * The live members of this config's package. Subscriptions adopted out of an
 * existing panel carry no group token, so groupRows() is empty for them and the
 * edit drawer used to show "no inbound" at all — and an added inbound was
 * written with the same empty token, so it never joined the customer. A config
 * without a token IS a package of one, so it lists itself.
 */
function packageRows(row) {
  if (!row) return [];
  const members = groupRows(row);
  return members.length ? members : [row];
}

/**
 * The package a row belongs to — the JavaScript mirror of CONFIG_GROUP_KEY_SQL and of
 * packageRows(): one group per subscription token, or, for a tokenless subscription
 * adopted from another panel, one group per x-ui client email.
 *
 * Anything that aggregates a package in JavaScript has to use this key. A subscription
 * adopted from the seller panel is ONE x-ui client kept as one row per inbound with the
 * client's own counters repeated on every row, so a group built from the token alone
 * (or from the row id) would either split that customer into several packages or add his
 * traffic once per inbound — and the shared-pool enforcement would then switch off a
 * customer who has only used a third of his quota.
 */
function packageKeyOf(row) {
  if (!row) return '';
  if (row.sub_id) return `G:${row.user_id}:${row.server_id}:${row.sub_id}`;
  if (String(row.origin || '') === 'external' && row.email) {
    return `E:${row.user_id}:${row.server_id}:${String(row.email).toLowerCase()}`;
  }
  return `C:${row.id}`;
}

/**
 * Group panel rows by the x-ui CLIENT they stand for. A package the panel made
 * has one client per row (distinct emails sharing a token), so this returns
 * single-row groups and behaves exactly as before. An adopted customer is ONE
 * x-ui client stored as one row per inbound, so his rows collapse into one
 * group: quota, expiry, enable/disable and traffic reset are then sent to the
 * seller panel once per customer instead of once per inbound, while every row
 * still gets its own database update.
 */
function distinctClients(rows) {
  const byClient = new Map();
  for (const row of rows || []) {
    if (!row) continue;
    const key = `${Number(row.server_id || 0)}|${String(row.email || '').toLowerCase()}`;
    if (!byClient.has(key)) byClient.set(key, []);
    byClient.get(key).push(row);
  }
  return [...byClient.values()];
}

function groupFor(row) {
  const fixedId = usersService.fixedInboundId(getResellerRow(row?.user_id));
  const list = packageRows(row).map((r) => {
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
      origin: config.origin,
      // The drawer keeps this row's remove button disabled while the package has
      // other members: the fixed inbound is the base of the subscription, so
      // dropping it would leave the customer without the channel the reseller
      // promised. A package of one can still be deleted as a whole.
      fixed: fixedId > 0 && Number(config.inboundId) === fixedId,
    };
  });
  return list.map((item) => ({ ...item, removable: !item.fixed || list.length === 1 }));
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
  const subChanged = Boolean(next.subId) && next.subId !== row.sub_id;
  if (!next.uuid && !subChanged) return hydrate(row);

  const db = getDb();
  const members = packageRows(row);
  const groups = distinctClients(members);
  // One client behind the whole package ⇒ the customer link IS that client's
  // node link, so a rotation has to change the real x-ui subId (and every row of
  // the client) or the link he already has would silently stay the old one.
  const oneClient = groups.length <= 1;
  const sameClient = oneClient ? members : members.filter((item) => clientKeyOf(item) === clientKeyOf(row));
  const touchClientRows = (sets, values) => {
    const sql = `UPDATE configs SET ${sets}, updated_at = ? WHERE id = ?`;
    for (const item of sameClient) db.prepare(sql).run(...values, Date.now(), Number(item.id));
  };

  if (next.uuid) {
    await xui.setIdentity(row.email, { uuid: next.uuid }, serverOfConfig(row));
    touchClientRows('uuid = ?', [next.uuid]);
    row.uuid = next.uuid;
  }

  if (subChanged) {
    if (oneClient) {
      try {
        await xui.setIdentity(row.email, { subId: next.subId }, serverOfConfig(row));
      } catch (err) {
        // x-ui refuses a subId that another client already holds.
        throw err instanceof ApiError
          ? err
          : new ApiError(502, 'xui_error', `تغییر شناسه اشتراک ناموفق بود: ${err.message}`);
      }
      // Token and client subId stay one value: the node link is built from the
      // client subId and the panel's aggregated link from the token, and both
      // must move together so an old link never keeps working half-way.
      touchClientRows('sub_id = ?, xui_sub_id = ?', [next.subId, next.subId]);
      row.sub_id = next.subId;
      row.xui_sub_id = next.subId;
    } else {
      // Several x-ui clients in one package: the only link that can join them is
      // the one this panel serves for the group token, so rotate the token.
      db.prepare(
        'UPDATE configs SET sub_id = ?, updated_at = ? WHERE sub_id = ? AND user_id = ? AND deleted_at = 0'
      ).run(next.subId, Date.now(), row.sub_id, row.user_id);
      row.sub_id = next.subId;
    }
  }
  audit(req, 'config.identity', 'config', row.id, { uuid: Boolean(next.uuid), subId: subChanged });
  return hydrate(getConfigRow(row.id));
}

/**
 * Attach one more inbound to an existing customer package. `row` may be any
 * live member. `options.free` skips pricing, limits and the wallet: the fixed
 * inbound heal adds a channel the customer already pays for as part of the
 * package's shared pool, so charging again would be wrong.
 */
async function attachInbound(row, inbound, req, { free = false } = {}) {
  const db = getDb();
  const target = Number(inbound.id);
  const user = getResellerRow(row.user_id);
  if (!user) throw new ApiError(404, 'user_not_found', 'Reseller not found');
  const server = serverOfInbound(inbound);
  const targetServer = serverOfConfig(row);
  // A customer's inbounds share one subscription id, which lives on a single
  // x-ui panel; cross-server groups would need two different sub links.
  if (Number(server.id) !== Number(targetServer.id)) {
    throw new ApiError(422, 'server_mismatch', 'این اینباند روی پنل دیگری است / This inbound belongs to a different x-ui panel than the config');
  }
  const allowed = usersService.allowedInboundIds(user);
  if (allowed && !allowed.includes(target)) {
    throw new ApiError(403, 'inbound_forbidden', 'This reseller cannot use the selected inbound');
  }

  // The new inbound joins the package's shared pool: it inherits the pool size
  // and expiry window (max across members, healing any drift) and adds NO quota.
  const members = packageRows(row);
  const totalBytes = members.reduce((max, item) => Math.max(max, Number(item.total_bytes || 0)), 0);
  const expiryAt = members.reduce((max, item) => Math.max(max, Number(item.expiry_at || 0)), 0);
  const totalGb = bytesToGb(totalBytes);
  const remainingDays = expiryAt > 0 ? Math.max(1, Math.ceil((expiryAt - Date.now()) / DAY_MS)) : 0;
  const amount = free ? 0 : pricing.priceFor(inbound, totalGb, remainingDays, user.id);
  // This joins the customer's existing package instead of creating a new one,
  // and a heal pass adds no quota either, so limits only gate a paid add.
  if (!free) usersService.checkLimits(user, { count: 0, gb: 0, gbEach: totalGb, days: remainingDays });

  if (billingEnabled() && amount > 0 && Number(user.balance || 0) < amount) {
    throw new ApiError(402, 'insufficient_balance', 'موجودی کیف پول کافی نیست / Insufficient wallet balance');
  }

  // v1.4.18: the new channel joins the customer's EXISTING x-ui client instead of
  // creating a second one. One client keeps one subscription link on the node's
  // own subscription server (<sub_base>/<subId>) that already lists every inbound
  // he has; minting another client would split one customer across two links and
  // force this panel to aggregate them again — the very thing that moved his
  // subscription off the node address.
  const hostRows = members.filter((item) => clientKeyOf(item) === clientKeyOf(row));
  const host = hostRows.find((item) => item.xui_sub_id) || hostRows[0] || row;
  const email = String(host.email || '') || emailFor(user);
  const uuid = String(host.uuid || '') || randomUUID();
  // A package adopted from another panel carries no group token of ours. Minting
  // one here keeps the bookkeeping (and the panel's aggregated link) usable as a
  // fallback, while the customer link itself stays the client's node link below.
  const groupToken = host.sub_id || randomToken(16);
  const xuiId = Number(inbound.xui_id);
  let attachedClient;
  try {
    // updateClient() keeps the client's current attachments and adds this one,
    // and an empty patch writes the live counters back unchanged: the customer's
    // quota, expiry and UUID on the node are exactly what they were.
    attachedClient = await xui.updateClient(email, {}, [xuiId], server);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'xui_client_missing') {
      throw new ApiError(404, 'xui_client_missing', `اشتراک این مشتری روی پنل نود پیدا نشد / This customer’s subscription is no longer on the node panel: ${email}`);
    }
    throw err instanceof ApiError ? err : new ApiError(502, 'xui_error', `افزودن اینباند ناموفق بود: ${err.message}`);
  }
  const xuiSubId = String(attachedClient?.subId || host.xui_sub_id || groupToken);

  let insertedId = 0;
  try {
    const info = db.transaction(() => {
      // Every row of the customer shares the token and the client identity, so
      // the package has one link, one pool and one UUID.
      if (host.sub_id !== groupToken || !host.sub_id) {
        db.prepare('UPDATE configs SET sub_id = ?, updated_at = ? WHERE email = ? AND server_id = ? AND deleted_at = 0')
          .run(groupToken, Date.now(), host.email, Number(server.id));
        row.sub_id = groupToken;
      }
      return db.prepare(
        `INSERT INTO configs (user_id, inbound_id, server_id, email, sub_id, xui_sub_id, uuid, flow, label, customer_name,
          customer_phone, note, total_bytes, expiry_at, enabled, status, sync_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'active', '', ?, ?)`
      ).run(
        row.user_id,
        target,
        Number(server.id),
        email,
        groupToken,
        xuiSubId,
        String(attachedClient?.uuid || uuid),
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
    })();
    insertedId = Number(info.lastInsertRowid);
    if (billingEnabled() && amount > 0) {
      chargeReseller(user, amount, `افزودن اینباند ${inbound.remark} به ${row.customer_name || email}`, 'purchase', req);
    }
  } catch (err) {
    // Undo only what this call added: the channel comes off the client again.
    // A client this panel did not create is never deleted.
    try {
      const keep = (attachedClient?.inboundIds || []).map(Number).filter((id) => id !== xuiId);
      if (keep.length) await xui.setInbounds(email, keep, server);
    } catch (cleanupErr) {
      console.error(`[configs] addInbound: rollback failed for ${email}:`, cleanupErr.message);
    }
    if (insertedId) db.prepare('DELETE FROM configs WHERE id = ?').run(insertedId);
    throw err;
  }

  audit(req, 'config.inbound_add', 'config', insertedId, {
    source: row.id, inboundId: target, inbound: inbound.remark, amount, healed: free,
  });
  return insertedId;
}

async function addInbound(id, inboundId, req, viewer) {
  const { row } = configDetail(id, viewer);
  const target = Number(inboundId);
  const inbound = getInboundRow(target);
  if (!inbound) throw new ApiError(404, 'inbound_not_found', 'Inbound not found');
  if (!inbound.enabled) throw new ApiError(422, 'inbound_disabled', `Inbound ${inbound.remark} is disabled`);
  if (!inbound.visible && viewer?.role !== 'admin') {
    throw new ApiError(403, 'inbound_hidden', 'This inbound is not available');
  }
  // Duplicate detection is scoped to THIS customer's package. The old query
  // matched on (sub_id, inbound_id) and every adopted row shares the empty
  // token, so adding any inbound to an old config answered "already has it".
  const members = packageRows(row);
  if (members.some((item) => Number(item.inbound_id) === target)) {
    throw new ApiError(409, 'inbound_exists', 'این مشتری همین اینباند را در بسته دارد / This customer already has this inbound');
  }
  const insertedId = await attachInbound(row, inbound, req);
  return hydrate(getConfigRow(insertedId));
}

/**
 * Add the reseller's fixed inbound to every one of their packages that lacks
 * it — the automatic heal the owner asked for when he introduced the fixed
 * inbound, so legacy (adopted) subscriptions get the same guaranteed base as
 * new ones. `dryRun` only counts. Nothing is charged and a package that already
 * carries the base is left alone. Since v1.4.18 the base is attached to the
 * customer's OWN x-ui client (attachInbound), so healing keeps a package one
 * client and its subscription link on the node address instead of minting a
 * second client and pushing the link behind this panel.
 */
async function applyFixedInbound(userId, { dryRun = false } = {}, req) {
  const db = getDb();
  const user = getResellerRow(userId);
  if (!user) throw new ApiError(404, 'user_not_found', 'Reseller not found');
  const fixedId = usersService.fixedInboundId(user);
  if (!fixedId) {
    throw new ApiError(422, 'fixed_inbound_required', 'ابتدا اینباند ثابت این نماینده را انتخاب کنید / Set this reseller’s fixed inbound first');
  }
  const inbound = getInboundRow(fixedId);
  if (!inbound) throw new ApiError(422, 'invalid_fixed_inbound', 'این اینباند ثابت در پنل پیدا نشد / The fixed inbound is no longer in the panel');
  if (!inbound.enabled) {
    throw new ApiError(422, 'fixed_inbound_disabled', `اینباند «${inbound.remark}» غیرفعال است / The fixed inbound is disabled`);
  }

  // Packages are (server, group token) pairs; a tokenless row is a package of
  // one, so scan live rows and let packageRows() do the grouping. The lowest
  // id anchors each package so one attach happens per customer, not per row.
  const rows = db
    .prepare('SELECT * FROM configs WHERE user_id = ? AND deleted_at = 0 ORDER BY id')
    .all(Number(user.id));
  const seen = new Set();
  const summary = {
    fixedInbound: fixedId, inbound: inbound.remark, serverId: Number(inbound.server_id || 0),
    packages: 0, already: 0, needFix: 0, healed: 0, skipped: 0, errors: [],
  };
  for (const row of rows) {
    const members = packageRows(row);
    // One attach per CUSTOMER, not per row: an adopted client spread over three
    // inbounds is one package, and keying by the token alone would call it three
    // packages of one and attach the fixed inbound three times.
    const key = packageKeyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    summary.packages += 1;
    if (members.some((item) => Number(item.inbound_id) === fixedId)) {
      summary.already += 1;
      continue;
    }
    // One subscription link spans one x-ui panel: a legacy package whose base
    // lives on another panel cannot take this inbound without splitting it.
    const server = serverOfInbound(inbound);
    if (Number(server.id) !== Number(serverOfConfig(members[0]).id)) {
      summary.skipped += 1;
      summary.errors.push(`${members[0].email}: این بسته روی پنل دیگری است / package is on another panel`);
      continue;
    }
    summary.needFix += 1;
    if (dryRun) continue;
    try {
      await attachInbound(members[0], inbound, req, { free: true });
      summary.healed += 1;
    } catch (err) {
      summary.skipped += 1;
      summary.errors.push(`${members[0].email}: ${err.message}`);
    }
  }
  if (!dryRun && summary.healed) audit(req, 'user.fixed_inbound_apply', 'user', Number(user.id), summary);
  return summary;
}

/**
 * Merge one package that is spread over MORE THAN ONE x-ui client back onto the
 * customer's own client.
 *
 * A split is what v1.4.16…1.4.17 left behind when an inbound was added to an
 * adopted package: it minted a second client under the same group token, so the
 * package stopped being one client and its subscription link moved from the
 * node's address to this panel's aggregated one. Attaching the extra channels to
 * the client the customer already uses, and moving the rows onto that client,
 * gives him one link again — on the node — and the duplicate client this panel
 * created is removed. A client adopted from another operator is never deleted:
 * a package that would need that is skipped.
 *
 * `dryRun` only reports. Nothing here changes quota, expiry or the UUID.
 */
async function consolidatePackage(row, { dryRun = false } = {}, req) {
  const db = getDb();
  const members = packageRows(row);
  const groups = distinctClients(members);
  if (groups.length < 2) {
    return {
      changed: false, reason: 'already-one-client', email: (groups[0] || [])[0]?.email || row.email,
      clients: groups.length, rows: members.length, moved: 0,
    };
  }
  // The client to keep: an adopted subscription owns the customer's live link and
  // his counters, so it wins; otherwise the client with the most rows, and on a
  // tie the oldest row.
  const rank = (items) => [String(items[0]?.origin || '') === 'external' ? 1 : 0, items.length, -Number(items[0]?.id || 0)];
  const sorted = [...groups].sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return right[i] - left[i];
    }
    return 0;
  });
  const hostRows = sorted[0];
  const host = hostRows.find((item) => item.xui_sub_id) || hostRows[0];
  const extra = sorted.slice(1);
  const server = serverOfConfig(host);
  const doomedExternal = extra.find((items) => String(items[0]?.origin || '') === 'external');
  const info = {
    changed: true,
    email: String(host.email || ''),
    subId: String(host.xui_sub_id || host.sub_id || ''),
    serverId: Number(server.id || 0),
    keeps: hostRows.length,
    moved: extra.flat().length,
    movedEmails: extra.map((items) => String(items[0]?.email || '')),
    movesInbounds: extra.flat().map((item) => Number(item.inbound_id)),
    dryRun: Boolean(dryRun),
    skipped: Boolean(doomedExternal),
  };
  if (doomedExternal) {
    // Two adopted customers share this group token — merging would delete a
    // subscription this panel does not own. Leave it to the operator.
    info.reason = 'several-adopted-clients';
    info.changed = false;
    return info;
  }
  if (dryRun) return info;

  const xuiIds = [...new Set(extra.flat()
    .map((item) => Number(getInboundRow(item.inbound_id)?.xui_id || 0))
    .filter((n) => Number.isFinite(n) && n > 0))];
  if (xuiIds.length) {
    // Attach first: the customer's own client covers every channel before the
    // duplicate one disappears, so there is no moment without a link.
    await xui.updateClient(host.email, {}, xuiIds, server);
  }
  const groupToken = host.sub_id || randomToken(16);
  if (!host.sub_id) {
    // A package adopted without a token of ours: mint one and give it to the
    // client's own rows first, so the merged package is one group again.
    db.prepare('UPDATE configs SET sub_id = ?, updated_at = ? WHERE email = ? AND server_id = ? AND deleted_at = 0')
      .run(groupToken, Date.now(), String(host.email || ''), Number(server.id));
    host.sub_id = groupToken;
  }
  for (const items of extra) {
    for (const item of items) {
      db.prepare('UPDATE configs SET email = ?, uuid = ?, sub_id = ?, xui_sub_id = ?, updated_at = ? WHERE id = ?')
        .run(String(host.email || ''), String(host.uuid || ''), groupToken, String(host.xui_sub_id || groupToken), Date.now(), Number(item.id));
    }
    try {
      await xui.deleteClient(String(items[0]?.email || ''), false, server);
    } catch (err) {
      console.error(`[configs] consolidate: duplicate client ${items[0]?.email} not removed:`, err.message);
      info.errors = [...(info.errors || []), `${items[0]?.email}: ${err.message}`];
    }
  }
  audit(req, 'config.consolidate', 'config', Number(row.id), info);
  return info;
}

/**
 * Consolidate every split package of one reseller (or of the whole panel when no
 * user is given). `dryRun` only counts, so the owner can see what would change
 * before anything is written to a panel.
 */
async function consolidatePackages({ userId = 0, dryRun = false } = {}, req) {
  const db = getDb();
  const rows = userId
    ? db.prepare('SELECT * FROM configs WHERE user_id = ? AND deleted_at = 0 ORDER BY id').all(Number(userId))
    : db.prepare('SELECT * FROM configs WHERE deleted_at = 0 ORDER BY id').all();
  const seen = new Set();
  const summary = { packages: 0, single: 0, split: 0, merged: 0, skipped: 0, dryRun: Boolean(dryRun), details: [], errors: [] };
  for (const row of rows) {
    const key = packageKeyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    summary.packages += 1;
    if (isOneClientPackage(row)) {
      summary.single += 1;
      continue;
    }
    summary.split += 1;
    try {
      const info = await consolidatePackage(row, { dryRun }, req);
      if (info.skipped) summary.skipped += 1;
      else if (info.changed) summary.merged += 1;
      // One entry per split package, also for a dry run: the UI has to be able to
      // say WHY a package was left alone (several adopted clients) before the
      // operator confirms anything.
      summary.details.push(info);
      (info.errors || []).forEach((message) => summary.errors.push(message));
    } catch (err) {
      summary.skipped += 1;
      summary.errors.push(`${row.email}: ${err.message}`);
    }
  }
  if (!dryRun && summary.merged) audit(req, 'config.consolidate_all', 'user', Number(userId || 0), summary);
  return summary;
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
       enabled = ?, uuid = ?, xui_sub_id = ?, sync_status = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`
  );
  let synced = 0;
  let missing = 0;
  // Traffic history is per x-ui CLIENT. Every row of one client carries the same
  // counters, so accruing the delta once per row would write the same bytes as
  // many times as the customer has inbounds and the dashboard traffic chart would
  // read several times the truth.
  const accrued = new Set();
  const groups = new Map();
  const tx = db.transaction(() => {
    for (const row of rows) {
      const sid = Number(row.server_id || 0) || (serverList[0] ? Number(serverList[0].id) : 0);
      const clientKey = `${sid}:${String(row.email || '').toLowerCase()}`;
      const firstOfClient = !accrued.has(clientKey);
      if (firstOfClient) accrued.add(clientKey);
      const client = map.get(`${sid}:${String(row.email).toLowerCase()}`);
      if (!client) {
        missing += 1;
        updateConfig.run(row.up_bytes, row.down_bytes, row.last_up, row.last_down, row.last_online_at,
          row.enabled, row.uuid, row.xui_sub_id, 'missing', Date.now(), Date.now(), row.id);
        continue;
      }
      const up = Number(client.up || 0);
      const down = Number(client.down || 0);
      let deltaUp = up - Number(row.last_up || 0);
      let deltaDown = down - Number(row.last_down || 0);
      if (deltaUp < 0) deltaUp = 0;
      if (deltaDown < 0) deltaDown = 0;
      if ((deltaUp > 0 || deltaDown > 0) && dayKey() === today && firstOfClient) {
        upsertUsage.run(row.id, row.user_id, today, deltaUp, deltaDown);
      }
      updateConfig.run(up, down, up, down, client.lastOnlineAt || 0,
        client.enabled ? 1 : 0, client.uuid || row.uuid, client.subId || row.xui_sub_id,
        '', Date.now(), Date.now(), row.id);
      synced += 1;
      const gkey = packageKeyOf(row);
      if (!groups.has(gkey)) groups.set(gkey, { quota: 0, perClient: new Map(), members: [] });
      const group = groups.get(gkey);
      group.quota = Math.max(group.quota, Number(row.total_bytes || 0));
      // The pool is per x-ui CLIENT, not per panel row. An adopted customer
      // sitting on three inbounds is ONE client whose counters repeat on every
      // row of that client, so adding up_bytes once per row would read as triple
      // usage and the shared-pool rule below would switch off a customer who has
      // used a third of his quota. Take the max per client, then sum clients —
      // the mirror of CONFIG_GROUP_USED_SQL.
      const poolKey = `${sid}|${String(row.email || '').toLowerCase()}`;
      const seenTotal = group.perClient.get(poolKey) || 0;
      if (up + down > seenTotal) group.perClient.set(poolKey, up + down);
      group.members.push({
        id: row.id,
        email: row.email,
        serverId: sid,
        enabled: Boolean(client.enabled),
      });
    }
  });
  tx();

  // One shared pool: when the package total reaches its quota, stop every
  // member (x-ui only knows each client's own quota, not the package sum).
  // Extending or raising the quota re-enables the members.
  let disabled = 0;
  const serverCache = new Map();
  for (const group of groups.values()) {
    const used = [...group.perClient.values()].reduce((sum, value) => sum + value, 0);
    if (group.quota <= 0 || used < group.quota) continue;
    // One call per x-ui client: the same email on several inbounds is one
    // customer, and switching him off twice only multiplies the panel writes.
    const done = new Set();
    for (const member of group.members) {
      if (!member.enabled) continue;
      const clientKey = `${member.serverId}|${String(member.email).toLowerCase()}`;
      if (done.has(clientKey)) continue;
      done.add(clientKey);
      try {
        if (!serverCache.has(member.serverId)) {
          serverCache.set(member.serverId, serversService.resolveServer(member.serverId));
        }
        await xui.setEnabled(member.email, false, serverCache.get(member.serverId));
        db.prepare('UPDATE configs SET enabled = 0, updated_at = ? WHERE id = ?')
          .run(Date.now(), member.id);
        disabled += 1;
      } catch (err) {
        console.error(`[configs] shared pool: could not disable ${member.email}:`, err.message);
      }
    }
  }
  if (disabled) console.log(`[configs] shared pool: disabled ${disabled} client(s) over quota`);

  if (pruneUsageDays) {
    const cutoff = new Date(Date.now() - pruneUsageDays * DAY_MS).toISOString().slice(0, 10);
    db.prepare('DELETE FROM usage_daily WHERE day < ?').run(cutoff);
  }
  return { synced, missing, disabled, total: rows.length, durationMs: Date.now() - started };
}

// Alerts are per CUSTOMER PACKAGE: a five-inbound subscription warns once, about
// the shared pool, instead of five times about independent inbounds.
function expiredNotifications() {
  const db = getDb();
  const monitor = settings.getSetting('monitor');
  if (!monitor.expiryAlerts) return { sent: 0 };
  const days = Array.isArray(monitor.expiryDays) ? monitor.expiryDays : [3, 1];
  const now = Date.now();
  const labelOf = (row) => row.customer_name || row.label || row.email;
  let sent = 0;
  for (const day of days) {
    const limit = day * DAY_MS;
    const rows = db.prepare(
      `SELECT c.* FROM configs c
       WHERE c.deleted_at = 0 AND c.enabled = 1 AND c.expiry_at > 0
         AND c.expiry_at > ? AND c.expiry_at <= ?`
    ).all(now, now + limit);
    // One representative row per package.
    const packages = new Map();
    for (const row of rows) {
      const gkey = packageKeyOf(row);
      const current = packages.get(gkey);
      if (!current || Number(row.expiry_at) > Number(current.expiry_at)) packages.set(gkey, row);
    }
    for (const row of packages.values()) {
      const key = `expiry:${packageKeyOf(row)}:${day}:${new Date(row.expiry_at).toISOString().slice(0, 10)}`;
      const inserted = notifyUser(row.user_id, {
        type: 'warning',
        title: `بسته ${labelOf(row)} به‌زودی منقضی می‌شود`,
        body: `کمتر از ${day} روز تا پایان اعتبار این بسته باقی مانده است.`,
        link: '/reseller/configs',
        dedupeKey: key,
        meta: { configId: row.id, days: day },
      });
      if (inserted) sent += 1;
    }
  }
  const percent = Number(monitor.trafficAlertPercent || 90);
  const usedRows = db.prepare(
    `SELECT c.* FROM configs c WHERE c.deleted_at = 0 AND c.enabled = 1 AND c.total_bytes > 0`
  ).all();
  const pools = new Map();
  for (const row of usedRows) {
    const gkey = packageKeyOf(row);
    if (!pools.has(gkey)) pools.set(gkey, { row, quota: 0, perClient: new Map() });
    const pool = pools.get(gkey);
    pool.quota = Math.max(pool.quota, Number(row.total_bytes || 0));
    // Same rule as the shared-pool enforcement: one x-ui client counts once,
    // however many inbounds of his the panel knows about.
    const clientKey = String(row.email || '').toLowerCase() || `id:${row.id}`;
    const total = Number(row.up_bytes || 0) + Number(row.down_bytes || 0);
    if (total > (pool.perClient.get(clientKey) || 0)) pool.perClient.set(clientKey, total);
  }
  for (const [gkey, pool] of pools) {
    const used = [...pool.perClient.values()].reduce((sum, value) => sum + value, 0);
    if (pool.quota <= 0 || used * 100 < pool.quota * percent) continue;
    const key = `traffic:${gkey}:${percent}:${dayKey()}`;
    const inserted = notifyUser(pool.row.user_id, {
      type: 'warning',
      title: `حجم بسته ${labelOf(pool.row)} در حال اتمام است`,
      body: `بیش از ${percent}٪ از حجم مشترک این بسته مصرف شده است.`,
      link: '/reseller/configs',
      dedupeKey: key,
      meta: { configId: pool.row.id, percent },
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
  detailView,
  packageView,
  hydrate,
  groupRows,
  packageRows,
  getConfigRow,
  linksFor,
  subUrlFor,
  subscriptionsOf,
  packageClientGroups,
  isOneClientPackage,
  consolidatePackage,
  consolidatePackages,
  extendConfig,
  setQuota,
  toggleConfig,
  resetUsage,
  updateMeta,
  removeConfig,
  groupFor,
  updateIdentity,
  addInbound,
  applyFixedInbound,
  syncConfigs,
  expiredNotifications,
  exportRows,
  priceFor,
  getInboundRow,
  emailFor,
  telegramIdMatches,
  importTelegramClients,
};

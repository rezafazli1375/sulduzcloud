'use strict';

const { getDb } = require('../db');
const settings = require('../settings');
const xui = require('../xui');
const serversService = require('./servers');
const inboundsService = require('./inbounds');
const configsService = require('./configs');
const { alertAdmins } = require('../notify');
const { tcpLatency, clamp, logError } = require('../utils');

const state = {
  timer: null,
  running: false,
  startedAt: 0,
  lastRunAt: 0,
  lastSuccessAt: 0,
  lastError: '',
  lastResult: null,
  nodeFailures: new Map(),
  nodeAlerts: new Map(),
  panelAlerts: new Map(),
};

function recordStatus(kind, refId, name, status, latencyMs, message = '', serverId = 0) {
  const db = getDb();
  db.prepare(
    'INSERT INTO server_status (kind, ref_id, name, status, latency_ms, message, server_id, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(kind, Number(refId || 0), String(name || ''), String(status), latencyMs === null ? null : Number(latencyMs), String(message || ''), Number(serverId || 0), Date.now());
}

function lastStatus(kind, refId) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM server_status WHERE kind = ? AND ref_id = ? ORDER BY checked_at DESC LIMIT 1'
  ).get(kind, Number(refId));
}

async function checkNodes(server) {
  const monitor = settings.getSetting('monitor');
  const threshold = Math.max(1, Number(monitor.failureThreshold || 2));
  let nodes = [];
  try {
    nodes = await xui.nodes(server);
  } catch (err) {
    logError(`[monitor] nodes/list failed for server ${server.id}:`, err.message);
    return { nodes: 0, offline: 0, error: err.message };
  }
  let offline = 0;
  for (const node of nodes) {
    const id = Number(node.id);
    const key = `${server.id}:${id}`;
    const name = node.name || node.remark || `node-${id}`;
    const latency = node.address ? await tcpLatency(node.address, Number(node.port || 443), 3000) : null;
    const apiOnline = String(node.status || '').toLowerCase() === 'online';
    const status = apiOnline ? 'online' : 'offline';
    if (status === 'offline') offline += 1;
    recordStatus('node', id, `${server.name || server.id} / ${name}`, status, latency, apiOnline ? '' : node.status || '', server.id);

    if (status === 'offline') {
      const failures = (state.nodeFailures.get(key) || 0) + 1;
      state.nodeFailures.set(key, failures);
      if (failures >= threshold && state.nodeAlerts.get(key) !== 'offline') {
        state.nodeAlerts.set(key, 'offline');
        alertAdmins({
          title: `هشدار: نود ${name} قطع شد`,
          body: `نود ${name} (${node.address || 'unknown'}) روی ${server.name || server.id} در ${failures} بررسی متوالی پاسخ نداد.`,
        }).catch((err) => logError('[monitor] alert failed:', err.message));
      }
    } else {
      state.nodeFailures.set(key, 0);
      if (state.nodeAlerts.get(key) === 'offline') {
        state.nodeAlerts.delete(key);
        alertAdmins({
          title: `نود ${name} دوباره متصل شد`,
          body: `ارتباط با نود ${name} روی ${server.name || server.id} برقرار شد.`,
        }).catch((err) => logError('[monitor] recovery alert failed:', err.message));
      }
    }
  }
  return { nodes: nodes.length, offline };
}

async function checkPanel(server) {
  const started = Date.now();
  const name = server.name || `server-${server.id}`;
  try {
    await xui.inbounds(server);
    const latency = Date.now() - started;
    recordStatus('panel', 0, name, 'online', latency, '', server.id);
    serversService.recordServerStatus(server, { ok: true, latencyMs: latency, message: '' });
    if (state.panelAlerts.get(server.id)) {
      state.panelAlerts.delete(server.id);
      alertAdmins({
        title: `پنل ${name} دوباره در دسترس است`,
        body: 'ارتباط پنل مدیریت با x-ui برقرار شد.',
      }).catch(() => {});
    }
    return { online: true, latency };
  } catch (err) {
    recordStatus('panel', 0, name, 'offline', null, err.message, server.id);
    serversService.recordServerStatus(server, { ok: false, latencyMs: null, message: err.message });
    if (!state.panelAlerts.get(server.id)) {
      state.panelAlerts.set(server.id, true);
      alertAdmins({
        title: `هشدار: ارتباط با پنل ${name} قطع شد`,
        body: err.message,
      }).catch(() => {});
    }
    return { online: false, error: err.message };
  }
}

function prune() {
  const monitor = settings.getSetting('monitor');
  const days = clamp(Number(monitor.retentionDays || 30), 3, 365);
  const cutoff = Date.now() - days * 86400000;
  const db = getDb();
  db.prepare('DELETE FROM server_status WHERE checked_at < ?').run(cutoff);
  db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(Date.now() - Math.max(days, 90) * 86400000);
  db.prepare('DELETE FROM notifications WHERE created_at < ? AND read_at > 0').run(Date.now() - days * 86400000);
}

async function runCycle(reason = 'timer') {
  if (state.running) return state.lastResult;
  state.running = true;
  const started = Date.now();
  try {
    const monitor = settings.getSetting('monitor');
    const result = { reason, at: started };
    const serverList = serversService.listServers({ includeDisabled: false });
    result.panels = [];
    for (const server of serverList) {
      result.panels.push({ server: server.id, name: server.name, ...(await checkPanel(server)) });
    }
    result.panel = result.panels[0] || { online: false, error: 'no_server' };
    // A fresh installation has no panel yet; nothing to sync and no error worth
    // logging every two minutes.
    if (monitor.enabled && serverList.length > 0) {
      try {
        result.inbounds = await inboundsService.syncInbounds();
      } catch (err) {
        result.inboundsError = err.message;
        logError('[monitor] inbound sync failed:', err.message);
      }
      try {
        result.configs = await configsService.syncConfigs();
      } catch (err) {
        result.configsError = err.message;
        logError('[monitor] config sync failed:', err.message);
      }
      result.nodes = { nodes: 0, offline: 0, servers: [] };
      for (const server of serverList) {
        const nodes = await checkNodes(server);
        result.nodes.servers.push({ server: server.id, ...nodes });
        result.nodes.nodes += Number(nodes.nodes || 0);
        result.nodes.offline += Number(nodes.offline || 0);
      }
      try {
        result.notifications = configsService.expiredNotifications();
      } catch (err) {
        result.notificationsError = err.message;
      }
    }
    prune();
    state.lastRunAt = Date.now();
    state.lastSuccessAt = state.lastRunAt;
    state.lastError = '';
    state.lastResult = { ...result, durationMs: state.lastRunAt - started };
    return state.lastResult;
  } catch (err) {
    state.lastRunAt = Date.now();
    state.lastError = err.message;
    logError('[monitor] cycle failed:', err.message);
    return { reason, error: err.message };
  } finally {
    state.running = false;
  }
}

function intervalMs() {
  const monitor = settings.getSetting('monitor');
  return clamp(Number(monitor.intervalSec || 120), 60, 3600) * 1000;
}

function reconfigure() {
  stop();
  start();
}

function start() {
  if (state.timer) return;
  state.startedAt = state.startedAt || Date.now();
  const ms = intervalMs();
  state.timer = setInterval(() => {
    runCycle('timer').catch((err) => logError('[monitor] timer error:', err.message));
  }, ms);
  if (state.timer.unref) state.timer.unref();
  setTimeout(() => {
    runCycle('startup').catch((err) => logError('[monitor] startup error:', err.message));
  }, 4000);
}

function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function status() {
  return {
    running: Boolean(state.timer),
    busy: state.running,
    intervalSec: Math.round(intervalMs() / 1000),
    startedAt: state.startedAt,
    lastRunAt: state.lastRunAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
    lastResult: state.lastResult,
  };
}

function resetAlerts() {
  state.nodeFailures.clear();
  state.nodeAlerts.clear();
  state.panelAlerts.clear();
}

module.exports = { start, stop, reconfigure, runCycle, status, resetAlerts, lastStatus };

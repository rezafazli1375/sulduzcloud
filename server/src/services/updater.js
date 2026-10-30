'use strict';

// In-panel updater.
// The panel service runs as an unprivileged user, so it never touches /opt or
// systemd itself. It asks the root helper `/usr/local/bin/sulduzcloud-update`
// (installed by install.sh with a NOPASSWD sudoers entry) to download the tag
// from GitHub, back up the code, install it, rebuild the bundle and restart the
// panel. Data (`panel.db`, `.env`, secrets, dist/node_modules caches) is never
// touched by the helper.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const { ApiError } = require('../utils');

const CHECK_TTL_MS = 5 * 60 * 1000;
const TAG_PATTERN = /^v?\d+\.\d+\.\d+$/;
const MAX_LOG_CHARS = 6000;

const cache = { at: 0, latest: '', tags: [], error: '' };
let running = false; // best-effort guard inside this process

function versionParts(value) {
  return String(value || '')
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function tagOf(value) {
  const tag = String(value || '').trim();
  if (!TAG_PATTERN.test(tag)) throw new ApiError(422, 'invalid_version', 'Invalid version tag');
  return tag.startsWith('v') ? tag : `v${tag}`;
}

function markerPath() {
  return path.join(config.dataDir, 'update-running');
}

function lastRunPath() {
  return path.join(config.dataDir, 'update-last.json');
}

function logPath() {
  return process.env.UPDATE_LOG || '/var/log/sulduzcloud-update.log';
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || null;
  } catch (_) {
    return null;
  }
}

function logTail() {
  try {
    const raw = fs.readFileSync(logPath(), 'utf8');
    return raw.length > MAX_LOG_CHARS ? raw.slice(-MAX_LOG_CHARS) : raw;
  } catch (_) {
    return '';
  }
}

async function fetchTags() {
  const repo = String(config.updateRepo || '').trim();
  if (!repo) throw new Error('Update repository is not configured');
  const res = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=50`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `sulduzcloud/${config.version}`,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub responded with ${res.status}`);
  const payload = await res.json();
  return (Array.isArray(payload) ? payload : [])
    .map((item) => String(item?.name || ''))
    .filter((name) => TAG_PATTERN.test(name))
    .sort((a, b) => compareVersions(b, a));
}

async function checkLatest({ force = false } = {}) {
  if (process.env.UPDATE_CHECK_DISABLED === '1') {
    cache.at = Date.now();
    cache.error = 'disabled';
    return { latest: '', tags: [], error: 'disabled' };
  }
  if (!force && cache.at && Date.now() - cache.at < CHECK_TTL_MS) return cache;
  try {
    const tags = await fetchTags();
    cache.tags = tags;
    cache.latest = tags[0] || '';
    cache.error = tags.length ? '' : 'No released version found';
    cache.at = Date.now();
  } catch (err) {
    cache.at = Date.now();
    cache.error = err.message;
  }
  return cache;
}

function isRunning() {
  if (running) return true;
  try {
    return fs.existsSync(markerPath());
  } catch (_) {
    return false;
  }
}

async function status({ force = false } = {}) {
  const info = await checkLatest({ force });
  const latest = info.latest || '';
  const last = readJson(lastRunPath());
  return {
    current: config.version,
    latest,
    updateAvailable: Boolean(latest) && compareVersions(latest, config.version) > 0,
    checkedAt: cache.at || 0,
    checkError: info.error || '',
    running: isRunning(),
    last: last || null,
    log: isRunning() || (last && last.ok === false) ? logTail() : '',
  };
}

function apply(value) {
  if (isRunning()) throw new ApiError(409, 'update_running', 'An update is already running');
  const tag = tagOf(value);
  const script = config.updateScript;
  try {
    if (!fs.existsSync(script)) {
      throw new ApiError(503, 'updater_missing', 'The update helper is not installed on this server');
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(503, 'updater_missing', err.message);
  }

  // Best-effort spawn log for failures that happen before the helper logs.
  let fd = 'ignore';
  try {
    const spawnLog = path.join(config.dataDir, 'update-spawn.log');
    fd = fs.openSync(spawnLog, 'a');
  } catch (_) { /* ignore */ }

  try {
    const child = spawn('sudo', ['-n', script, tag], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, SULDUZ_UPDATE_TAG: tag },
    });
    child.unref();
  } finally {
    if (typeof fd === 'number') {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
  running = true;
  setTimeout(() => { running = false; }, 10 * 60 * 1000).unref?.();
  return { started: true, tag };
}

module.exports = {
  status,
  apply,
  checkLatest,
  compareVersions,
  isRunning,
};

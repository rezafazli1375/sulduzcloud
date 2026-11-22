'use strict';

// Restores must be applied before the database is opened.
const restore = require('./restore');
restore.applyPendingRestore();

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { getDb, closeDb } = require('./db');
const settings = require('./settings');
const auth = require('./auth');
const net = require('./net');
const activation = require('./activation');
const monitor = require('./services/monitor');
const backupService = require('./services/backup');
const telegram = require('./services/telegram');
const bot = require('./services/bot');
const reports = require('./services/reports');
const usersService = require('./services/users');
const topups = require('./services/topups');
const { ApiError, dayKey, log, logError } = require('./utils');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

app.use(auth.authMiddleware);
app.use(auth.csrfProtection);

// ------------------------------------------------------- v2.1.0 activation gate
//
// An install that has never been activated answers nothing but the three calls its
// own lock screen needs: /api/meta (brand + csrf), /api/health and /api/activation.
// Everything else — including /api/setup, which is how a stranger would otherwise
// hand himself the owner account — is 423 until the FEMALE half of the male key on
// the screen is typed.
//
// activation.isRequired() is the whole safety of this: it is only true while the
// panel has NO accounts, so a panel upgraded from 2.0.0 (or any older install,
// which has accounts and no activation row) keeps working exactly as it did. The
// static SPA is deliberately not gated; the gate is on the API, so a locked
// install serves the unlock page rather than a blank screen.

const ACTIVATION_OPEN = ['/meta', '/health', '/activation'];
app.use('/api', (req, res, next) => {
  const path = req.path === '/' ? '' : req.path;
  if (ACTIVATION_OPEN.some((open) => path === open || path.startsWith(`${open}/`) || path.startsWith(`${open}?`))) return next();
  if (!activation.isRequired()) return next();
  return res.status(423).json({
    ok: false,
    error: {
      code: 'activation_required',
      message: 'این نصب هنوز فعال نشده است / this install is not activated yet',
      details: { maleKey: activation.challengeMale() },
    },
  });
});

// ------------------------------------------------------------------ routes

app.use('/api/v1', require('./routes/apiV1'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/reseller', require('./routes/reseller'));
app.use('/api', require('./routes/public'));

app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Endpoint not found' } });
});

// ------------------------------------------------------------ static files

const webDist = config.webDist;
if (fs.existsSync(path.join(webDist, 'index.html'))) {
  app.use(express.static(webDist, {
    index: false,
    maxAge: '7d',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(path.join(webDist, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.type('text/plain').send('Sulduz Cloud API is running. Build the frontend (web/dist) to serve the panel.');
  });
}

// ------------------------------------------------------------ error handling

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      ok: false,
      error: { code: err.code, message: err.message, details: err.details || undefined },
    });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: { code: 'file_too_large', message: 'File is too large' } });
  }
  if (err && String(err.message || '').includes('UNIQUE constraint failed')) {
    return res.status(409).json({ ok: false, error: { code: 'duplicate', message: 'This record already exists' } });
  }
  logError('[http] unhandled error:', err && err.stack ? err.stack : err);
  return res.status(500).json({ ok: false, error: { code: 'internal_error', message: 'Internal server error' } });
});

// ------------------------------------------------------------------ boot

function bootstrapOwner() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) AS c FROM users WHERE deleted_at = 0').get().c;
  if (count > 0) return false;
  // v2.1.0: the ADMIN_USERNAME/ADMIN_PASSWORD bootstrap is the install script's
  // door, not a way around the activation gate. An unactivated install that has
  // never had a key typed stays locked even if somebody sets the variables.
  if (activation.isRequired()) {
    log('[boot] owner bootstrap skipped: this install is not activated yet');
    return false;
  }
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return false;
  usersService.createUser(
    { username, password, name: process.env.ADMIN_NAME || 'Owner', role: 'admin', permissions: ['*'], status: 'active' },
    null
  );
  log(`[boot] owner account "${username}" created from environment`);
  return true;
}

let autoBackupDay = '';

// The backup schedule is expressed in the panel timezone (settings → general),
// not in the server's own timezone, which is usually UTC.
function zonedClock(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date());
    const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
    return {
      day: `${pick('year')}-${pick('month')}-${pick('day')}`,
      hour: pick('hour') % 24,
      minute: pick('minute'),
    };
  } catch (_) {
    const now = new Date();
    return { day: dayKey(), hour: now.getHours(), minute: now.getMinutes() };
  }
}

function startAutoBackupTimer() {
  setInterval(async () => {
    try {
      const backupCfg = settings.getSetting('backup');
      if (!backupCfg.auto) return;
      const timeZone = settings.getSetting('general').timezone || 'UTC';
      const clock = zonedClock(timeZone);
      if (clock.hour !== Number(backupCfg.hour) || clock.minute !== Number(backupCfg.minute)) return;
      const today = clock.day;
      if (autoBackupDay === today) return;
      autoBackupDay = today;
      const info = await backupService.createBackup('auto');
      log('[backup] automatic backup completed');
      if (telegram.config().sendOnAuto) {
        try {
          const sent = await telegram.sendBackup(path.join(config.backupDir, info.name), info.name, 'auto');
          if (sent?.sent) log('[backup] automatic backup sent to Telegram');
          else log(`[backup] Telegram delivery skipped: ${sent?.reason || 'unknown'}`);
        } catch (err) {
          logError('[backup] Telegram delivery failed:', err.message);
        }
      }
    } catch (err) {
      logError('[backup] automatic backup failed:', err.message);
    }
  }, 60000).unref();
}

function startDailyReportTimer() {
  // One attempt per day per process; the daily_reports table is what makes the
  // same true across a restart.
  let attemptedDay = '';
  setInterval(async () => {
    try {
      const cfg = reports.reportConfig();
      if (!cfg.enabled) return;
      // The report is about the traffic ledger, so it is triggered on the same
      // wall clock usage_daily is bucketed by (PANEL_TZ), not the server clock.
      const clock = zonedClock(config.timezone);
      if (clock.hour !== cfg.hour || clock.minute !== cfg.minute) return;
      if (attemptedDay === clock.day) return;
      attemptedDay = clock.day;
      if (!cfg.botToken) {
        log('[reports] daily report skipped: no Telegram bot token is configured');
        return;
      }
      const summary = await reports.sendDaily({ at: Date.now() });
      log(`[reports] daily report: sent ${summary.sent}/${summary.attempted}, failed ${summary.failed}, skipped ${summary.skipped}${summary.owner?.sent ? ', owner digest sent' : ''}`);
      for (const item of summary.results.filter((one) => !one.sent && one.reason && one.stats)) {
        log(`[reports] reseller ${item.username}: ${item.reason}`);
      }
    } catch (err) {
      logError('[reports] daily report failed:', err.message);
    }
  }, 60000).unref();
}

function startAutoApproveTimer() {
  // v1.5.4, item 3: «زمان‌بندی تایید خودکار برای فیش‌های واریزی و کارت به کارت».
  // v1.5.5 retired کارت به کارت, so the sweep can only ever be asked about receipts.
  //
  // The tick is cheap and reads its own settings every time, so a change the
  // owner makes in the settings form takes effect on the next minute without a
  // restart — the same rule the backup and report schedules follow, and the same
  // one the reseller bot's switch learned in 1.5.2. runAutoApprove() re-checks
  // every guard itself (switch on, ceiling set, methods chosen, age, per-reseller
  // daily limit), so this function has no opinion about money and only about time.
  let lastRun = 0;
  setInterval(() => {
    try {
      const cfg = settings.getSetting('payment');
      if (!cfg.autoApproveEnabled) return;
      const everyMs = Math.min(60, Math.max(1, Number(cfg.autoApproveIntervalMinutes) || 1)) * 60000;
      if (Date.now() - lastRun < everyMs) return;
      lastRun = Date.now();
      const summary = topups.runAutoApprove();
      if (!summary.enabled) {
        log(`[autoapprove] not running (${summary.reason}) — nothing checked`);
        return;
      }
      if (!summary.approved && !summary.skipped) return;
      log(`[autoapprove] checked ${summary.checked}, approved ${summary.approved}, skipped ${summary.skipped} (after ${summary.afterMinutes}m, ceiling ${summary.maxAmount}, methods ${summary.methods.join('+')})`);
      // Only while the poller is actually up: the Telegram buttons exist precisely
      // when it is, and a sweep must not open a socket on a panel whose bot is off.
      if (bot.status().running) {
        for (const item of summary.results || []) {
          if (!item.approved) continue;
          try {
            bot.syncAdminMessage(topups.getRequest(item.id), 'approved', 'تایید خودکار').catch(() => {});
          } catch (err) {
            logError('[autoapprove] Telegram button update failed:', err.message);
          }
        }
      }
    } catch (err) {
      logError('[autoapprove] sweep failed:', err.message);
    }
  }, 60000).unref();
}

function startCleanupTimer() {
  // v2.0.0: «زمان‌بندی حذف اشتراک‌های تمام‌شده و منقضی». Same shape as the other
  // schedules: a cheap 60s tick that re-reads its settings, so the owner's switch
  // takes effect within a minute without a restart. Unlike the auto-approve
  // sweep, lastRunAt is PERSISTED on the settings row — a restart must not let a
  // six-hour schedule fire again six seconds after boot.
  const cleanup = require('./services/cleanup');
  let running = false;
  setInterval(async () => {
    if (running) return;
    try {
      const cfg = settings.getSetting('cleanup');
      if (!cfg.enabled) return;
      const everyMs = Math.min(168, Math.max(1, Number(cfg.intervalHours) || 6)) * 3600000;
      if (Date.now() - Number(cfg.lastRunAt || 0) < everyMs) return;
      running = true;
      const summary = await cleanup.runCleanup();
      if (summary.deleted || summary.stamped || summary.failed) {
        log(`[cleanup] checked ${summary.checked}, deleted ${summary.deleted}, stamped ${summary.stamped}, grace ${summary.skippedGrace}, external ${summary.skippedExternal}, capped ${summary.capped}, failed ${summary.failed}`);
      }
    } catch (err) {
      logError('[cleanup] sweep failed:', err.message);
    } finally {
      running = false;
    }
  }, 60000).unref();
}

function start() {
  getDb();
  settings.ensureDefaults();
  bootstrapOwner();
  // v2.1.0: the port, the address and the certificate paths all come from
  // settings → general now (src/net.js), so a port move from the settings screen
  // or the SSH menu needs no restart and no .env edit. `serve()` resolves once the
  // socket is listening; a port that cannot be opened is the one failure that must
  // stop the boot, because there is then no panel at all to serve.
  net.serve(app).then((result) => {
    if (result.failed) {
      logError(`[boot] ${result.error}`);
      process.exit(1);
    }
    const seen = net.describe();
    log(`Sulduz Cloud ${config.version} listening on ${seen.scheme}://${seen.host}:${seen.port}`);
    if (seen.tlsError) logError(`[net] ${seen.tlsError}`);
    const gate = activation.status();
    if (gate.required) log(`[boot] awaiting activation — serial ${gate.maleKey}`);
    else if (gate.activated) log(`[boot] activated (serial ${gate.maleKey}, ${gate.source})`);
    monitor.start();
    startAutoBackupTimer();
    startDailyReportTimer();
    startAutoApproveTimer();
    startCleanupTimer();
    // v1.5.2: the reseller bot. It never blocks the boot — start() only checks
    // the webhook and then polls in the background, and a bot that is switched
    // off in settings stays idle without a single network call.
    bot.start().catch((err) => logError('[bot] start failed:', err.message));
  }).catch((err) => {
    logError('[boot] listener failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });

  const shutdown = (signal) => {
    log(`[boot] received ${signal}, shutting down`);
    monitor.stop();
    bot.stop();
    // net.close(), not the boot-time instance: after a port move the socket this
    // process opened first is no longer the one answering requests.
    net.close().then(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logError('[process] unhandled rejection:', reason && reason.message ? reason.message : reason);
  });
  process.on('uncaughtException', (err) => {
    logError('[process] uncaught exception:', err && err.stack ? err.stack : err);
  });
}

start();

module.exports = app;

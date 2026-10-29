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
const monitor = require('./services/monitor');
const backupService = require('./services/backup');
const telegram = require('./services/telegram');
const usersService = require('./services/users');
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

function start() {
  getDb();
  settings.ensureDefaults();
  bootstrapOwner();
  const server = app.listen(config.port, config.host, () => {
    log(`Sulduz Cloud ${config.version} listening on http://${config.host}:${config.port}`);
    monitor.start();
    startAutoBackupTimer();
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 130000;

  const shutdown = (signal) => {
    log(`[boot] received ${signal}, shutting down`);
    monitor.stop();
    server.close(() => {
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

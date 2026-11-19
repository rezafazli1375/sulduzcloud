'use strict';

// Panel v2.1.0 — the listener, driven by settings → general.
//
// Three fields the owner asked for live here as real behaviour instead of stored
// text: the panel PORT, the panel ADDRESS (the public URL every subscribe link,
// payment callback and cookie trusts) and the two certificate PATHS (public key
// + private key) that turn the listener into HTTPS.
//
// The rule that makes this safe to use on a running server: a change is applied
// by opening the new socket FIRST and closing the old one only once the new one
// answers. A port that is taken, or a certificate the panel user cannot read,
// therefore leaves the panel exactly where it was — the operator keeps the screen
// he is standing in, and gets a named error instead of a dead service.
//
// Ports below 1024 are refused: the service runs as an unprivileged user, so the
// panel could never bind them. The SSH menu (`sulduzcloud` → 2) is the place that
// also moves nginx and .env along with the port.

const fs = require('fs');
const http = require('http');
const https = require('https');
const config = require('./config');
const settings = require('./settings');
const { log, logError } = require('./utils');

const MIN_PORT = 1024;
const MAX_PORT = 65535;

let appRef = null;
let server = null;
let state = { port: 0, host: '', tls: false, tlsError: '' };
// The certificate material the LIVE listener was built with, kept so a switch
// that fails can be undone with exactly what was there before.
let tlsRef = null;

function clampPort(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  if (n < MIN_PORT || n > MAX_PORT) return 0;
  return n;
}

/** The three network fields, cleaned. Also the shape the settings route writes. */
function desired() {
  let general = {};
  try {
    general = settings.getSetting('general') || {};
  } catch (_) {
    general = {};
  }
  return {
    port: clampPort(general.panelPort) || clampPort(config.port) || 3100,
    host: String(config.host || '127.0.0.1'),
    certPath: String(general.sslCertPath || '').trim(),
    keyPath: String(general.sslKeyPath || '').trim(),
    publicUrl: String(general.publicUrl || '').trim().replace(/\/+$/, ''),
  };
}

function readKeyPair(certPath, keyPath) {
  if (!certPath || !keyPath) return { tls: null, error: '' };
  const pairs = [['sslCertPath', certPath], ['sslKeyPath', keyPath]];
  for (const [label, file] of pairs) {
    if (!fs.existsSync(file)) {
      return { tls: null, error: `${label}: فایلی در این مسیر وجود ندارد / no file at ${file}` };
    }
    try {
      fs.accessSync(file, fs.constants.R_OK);
    } catch (_) {
      return { tls: null, error: `${label}: این فایل برای کاربر سرویس قابل خواندن نیست / not readable by the service user` };
    }
  }
  try {
    return { tls: { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, error: '' };
  } catch (err) {
    return { tls: null, error: `گواهی خوانده نشد / cannot read the certificate: ${err.message}` };
  }
}

/**
 * What the address field means for the rest of the panel: subscribe links,
 * payment callbacks and the cookie's `Secure` flag all read config.publicUrl, so
 * pointing it here is what actually moves the panel to a new domain.
 */
function applyPublicUrl(publicUrl) {
  const url = publicUrl || String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  config.publicUrl = url;
  config.cookieSecure = url.startsWith('https://');
  return url;
}

function describe() {
  const want = desired();
  return {
    listening: Boolean(server),
    port: state.port,
    host: state.host,
    scheme: state.tls ? 'https' : 'http',
    tls: Boolean(state.tls),
    tlsError: state.tlsError,
    publicUrl: config.publicUrl,
    desiredPort: want.port,
    certPath: want.certPath,
    keyPath: want.keyPath,
  };
}

function build(tls) {
  const instance = tls ? https.createServer(tls, appRef) : http.createServer(appRef);
  instance.requestTimeout = 120000;
  instance.headersTimeout = 130000;
  return instance;
}

function open(port, host, tls) {
  return new Promise((resolve, reject) => {
    let instance;
    try {
      instance = build(tls);
    } catch (err) {
      reject(err);
      return;
    }
    instance.once('error', reject);
    instance.listen(port, host, () => {
      instance.removeListener('error', reject);
      resolve(instance);
    });
  });
}

function adopt(instance, want, tls, tlsError) {
  server = instance;
  tlsRef = tls || null;
  state = { port: instance.address().port, host: want.host, tls: Boolean(tls), tlsError };
  config.port = state.port;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `open()` with a short wait-and-again on EADDRINUSE.
 *
 * Releasing a port is synchronous in Node, but binding the same port seconds
 * after a socket that had it can still lose to something else on the machine, and
 * a certificate switch is exactly that case. One retry loop here keeps the panel
 * from reporting a failure it could have answered by itself.
 */
async function openRetrying(port, host, tls, attempts = 8) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await open(port, host, tls);
    } catch (err) {
      last = err;
      if (!err || err.code !== 'EADDRINUSE') break;
      await delay(50);
    }
  }
  throw last;
}

/**
 * Move the live listener to whatever the settings now ask for.
 * Never throws: the settings route reports the outcome to the operator, and a
 * failed attempt leaves the socket he is using exactly as it was.
 */
async function apply() {
  const want = desired();
  applyPublicUrl(want.publicUrl);
  const { tls, error } = readKeyPair(want.certPath, want.keyPath);
  if (error) logError('[net] certificate not usable, staying on HTTP: ' + error);

  if (!server) {
    try {
      adopt(await openRetrying(want.port, want.host, tls), want, tls, error);
    } catch (err) {
      return { changed: false, failed: true, error: `پورت ${want.port} باز نشد / could not listen on ${want.port}: ${err.code || err.message}`, ...describe() };
    }
    return { changed: true, ...describe() };
  }

  const samePort = state.port === want.port;
  if (samePort && state.tls === Boolean(tls)) {
    state.tlsError = error;
    return { changed: false, ...describe() };
  }

  // A port move opens the NEW socket first and closes the old one only once the
  // new one answers, so a taken port can never take the panel down. A certificate
  // switch on the port the panel is already sitting on cannot be done that way:
  // one process cannot hold one port twice, and the second bind answers EADDRINUSE
  // — which is how "turn HTTPS on" used to fail silently while the settings row
  // said it was on. So here the old socket is let go first and the new one takes
  // its place. Node releases the port the moment close() is called and keeps the
  // connections that are already standing, which is why the operator's own request
  // is still answered by the socket he is using.
  const previous = server;
  const had = { port: state.port, tls: state.tls, tlsError: state.tlsError, material: tlsRef };
  if (samePort) {
    server = null;
    try { previous.close(); } catch (_) { /* it is already gone */ }
  }

  let next = null;
  try {
    next = await openRetrying(want.port, want.host, tls);
  } catch (err) {
    const message = `پورت ${want.port} باز نشد / could not listen on ${want.port}: ${err.code || err.message}`;
    if (!samePort) return { changed: false, failed: true, error: message, ...describe() };
    // Nothing is listening any more: put back exactly what stood here a moment ago.
    try {
      adopt(await openRetrying(had.port, want.host, had.material), { host: want.host }, had.material, had.tlsError);
    } catch (inner) {
      server = previous;
      return {
        changed: false,
        failed: true,
        down: true,
        error: `${message} — و سوکت قبلی هم دوباره باز نشد؛ با راه‌اندازی مجدد سرویس پنل برمی‌گردد / the old socket could not be reopened either, restarting the service brings the panel back (${inner.code || inner.message})`,
        ...describe(),
      };
    }
    return { changed: false, failed: true, error: message, ...describe() };
  }
  adopt(next, want, tls, error);
  if (previous && previous !== next) {
    try { previous.close(); } catch (_) { /* already closed above */ }
  }
  log(`[net] listener moved to ${state.tls ? 'https' : 'http'}://${state.host}:${state.port}`);
  return { changed: true, ...describe() };
}

/**
 * Can this port be bound at all?
 *
 * A settings save must not store a port the panel cannot use. Without this the
 * socket would look fine right now — the OLD listener keeps answering while the
 * new one quietly failed — and the service would be dead after the next restart,
 * which is the worst possible time to discover it. So the requested port is tried
 * on a throwaway socket BEFORE anything is written, and the operator gets a named
 * refusal instead of a panel that will not come back.
 *
 * The port the panel is already sitting on is always "available": asking for it
 * back must not fail because the panel itself is holding it.
 */
async function probe(port, host) {
  const wanted = clampPort(port);
  if (!wanted) return { ok: false, error: 'پورت معتبری وارد نشده است / not a valid port' };
  if (server && wanted === state.port) return { ok: true, already: true };
  const bindHost = String(host || config.host || '127.0.0.1');
  return new Promise((resolve) => {
    const tester = http.createServer((req, res) => {
      res.statusCode = 503;
      res.end();
    });
    tester.unref();
    tester.once('error', (err) => resolve({ ok: false, error: `${err.code || 'EADDRINUSE'} on port ${wanted}`, port: wanted }));
    tester.listen(wanted, bindHost, () => {
      tester.close(() => resolve({ ok: true, port: wanted }));
    });
  });
}

/** Hand the shared express app to the listener. Called once, from index.js. */
async function serve(app) {
  appRef = app;
  return apply();
}

/**
 * Stop listening (shutdown). index.js cannot hold the instance itself: after a
 * port move the socket it booted with is no longer the live one, and closing that
 * old handle would leave the real listener running while the service exits.
 */
function close() {
  return new Promise((resolve) => {
    const instance = server;
    server = null;
    if (!instance) {
      resolve();
      return;
    }
    try {
      instance.close(() => resolve());
    } catch (_) {
      resolve();
    }
  });
}

module.exports = {
  MIN_PORT,
  MAX_PORT,
  clampPort,
  desired,
  describe,
  apply,
  applyPublicUrl,
  probe,
  serve,
  close,
  readKeyPair,
};

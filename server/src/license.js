'use strict';

/**
 * Offline licence check.
 *
 * Every installation owns a stable fingerprint derived from the machine id.
 * The holder of the private key signs a small JSON document for that
 * fingerprint; the panel verifies it locally with the embedded public key, so
 * activation never needs an internet connection.
 *
 * This is a deterrent, not DRM: the source is public, so a determined person
 * can always patch the check. It keeps casual copying honest.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

// Ed25519 public key (SPKI/DER, base64). The matching private key never
// leaves the vendor's machine.
const PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAETz8OSb6mdO9TDOH+387QpPC73GmUDIIymkZ/OkQsiY=';
const LICENSE_PATH = process.env.LICENSE_PATH || '/etc/sulduzcloud/license.json';
const GRACE_DAYS = 0;

function machineId() {
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch (_err) { /* try the next source */ }
  }
  return `${os.hostname()}`;
}

function fingerprint() {
  const hash = crypto
    .createHash('sha256')
    .update(`sulduzcloud|${machineId()}`)
    .digest('hex')
    .slice(0, 20)
    .toUpperCase();
  return hash.match(/.{1,4}/g).join('-');
}

function canonical(doc) {
  return ['SC1', doc.id, doc.fingerprint, doc.customer, doc.issued, doc.expires].join('|');
}

function publicKey() {
  return crypto.createPublicKey({
    key: Buffer.from(PUBLIC_KEY_B64, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

function readFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    return null;
  }
}

let cache = { at: 0, value: null };

function evaluate(doc) {
  const current = fingerprint();
  if (!doc || typeof doc !== 'object') {
    return { valid: false, reason: 'license_missing', fingerprint: current, license: null };
  }
  const base = {
    fingerprint: current,
    license: {
      id: String(doc.id || ''),
      customer: String(doc.customer || ''),
      issued: String(doc.issued || ''),
      expires: String(doc.expires || ''),
    },
  };
  if (String(doc.fingerprint || '').toUpperCase() !== current) {
    return { ...base, valid: false, reason: 'license_fingerprint' };
  }
  if (!doc.sig || typeof doc.sig !== 'string') {
    return { ...base, valid: false, reason: 'license_unsigned' };
  }
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(canonical(doc), 'utf8'), publicKey(), Buffer.from(doc.sig, 'base64'));
  } catch (_err) {
    ok = false;
  }
  if (!ok) return { ...base, valid: false, reason: 'license_signature' };
  if (doc.expires && doc.expires !== 'never') {
    const when = Date.parse(doc.expires);
    if (Number.isFinite(when) && when > 0 && Date.now() > when + GRACE_DAYS * 86400000) {
      return { ...base, valid: false, reason: 'license_expired' };
    }
  }
  return { ...base, valid: true, reason: '' };
}

function status({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < 10000) return cache.value;
  let doc = null;
  const file = LICENSE_PATH;
  if (fs.existsSync(file)) doc = readFile(file);
  const value = { ...evaluate(doc), path: file };
  cache = { at: Date.now(), value };
  return value;
}

function enforced() {
  if (process.env.LICENSE_DISABLED === '1') return false;
  if (config.nodeEnv === 'test') return false;
  return true;
}

/**
 * Express middleware. While the licence is missing or invalid every API call is
 * refused except the endpoints needed to log in and activate it, and the UI
 * keeps rendering so the administrator can read the installation id.
 */
function middleware(req, res, next) {
  if (!enforced()) return next();
  const allowed = ['/health', '/meta', '/license', '/license/activate', '/auth', '/setup'];
  if (allowed.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) return next();
  const state = status();
  if (state.valid) return next();
  return res.status(403).json({
    ok: false,
    error: {
      code: 'license_invalid',
      message: 'این نصب فعال نشده است / This installation is not activated',
      reason: state.reason,
      fingerprint: state.fingerprint,
    },
  });
}

function activate(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, reason: 'license_missing' };
  let doc = null;
  try {
    doc = JSON.parse(text);
  } catch (_err) {
    return { ok: false, reason: 'license_format' };
  }
  const result = evaluate(doc);
  if (!result.valid) return { ok: false, reason: result.reason, state: result };
  try {
    fs.mkdirSync(path.dirname(LICENSE_PATH), { recursive: true, mode: 0o755 });
    fs.writeFileSync(LICENSE_PATH, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o644 });
  } catch (err) {
    return { ok: false, reason: 'license_write', message: err.message };
  }
  cache = { at: 0, value: null };
  return { ok: true, state: status({ fresh: true }) };
}

module.exports = { fingerprint, status, activate, middleware, enforced, LICENSE_PATH };

'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { getDb } = require('./db');
const {
  ApiError,
  timingSafeEqual,
  sanitizeUser,
} = require('./utils');

const SESSION_COOKIE = 'sc_session';
const CSRF_COOKIE = 'sc_csrf';

function sessionDays() {
  try {
    const security = require('./settings').getSetting('security');
    return Math.max(1, Math.min(90, Number(security.sessionDays) || 7));
  } catch (_) {
    return config.sessionDaysDefault;
  }
}

function setSessionCookie(res, user, req) {
  const days = sessionDays();
  const now = Date.now();
  const sid = require('./utils').randomToken(24);
  const db = getDb();
  db.prepare(
    'INSERT INTO sessions (sid, user_id, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    sid,
    Number(user.id),
    now,
    now + days * 86400000,
    String((req && req.ip) || '').slice(0, 64),
    String((req && req.get && req.get('user-agent')) || '').slice(0, 200)
  );
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now - 7 * 86400000);
  const token = jwt.sign(
    { uid: user.id, role: user.role, tv: user.token_version || 1, sid },
    config.jwtSecret,
    { expiresIn: `${days}d` }
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: days * 86400000,
  });
  return token;
}

function revokeSession(sid) {
  if (!sid) return;
  try {
    getDb().prepare('UPDATE sessions SET revoked_at = ? WHERE sid = ?').run(Date.now(), String(sid));
  } catch (_) {
    /* never block logout on a storage hiccup */
  }
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
  });
}

function setCsrfCookie(res) {
  const token = require('./utils').randomToken(32);
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: sessionDays() * 86400000,
  });
  return token;
}

function ensureCsrfCookie(req, res) {
  if (!req.cookies || !req.cookies[CSRF_COOKIE]) return setCsrfCookie(res);
  return req.cookies[CSRF_COOKIE];
}

function hashPassword(password) {
  return bcrypt.hashSync(String(password), 12);
}

function verifyPassword(password, hash) {
  try {
    return bcrypt.compareSync(String(password), String(hash || ''));
  } catch (_) {
    return false;
  }
}

function findUserById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at = 0').get(Number(id));
}

function authMiddleware(req, res, next) {
  const token = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (!payload.sid) return next();
    const user = findUserById(payload.uid);
    if (!user) return next();
    if (Number(payload.tv || 1) !== Number(user.token_version || 1)) return next();
    const session = getDb()
      .prepare('SELECT sid FROM sessions WHERE sid = ? AND user_id = ? AND revoked_at = 0 AND expires_at > ?')
      .get(String(payload.sid), Number(user.id), Date.now());
    if (!session) return next();
    if (user.status !== 'active') {
      req.userBlocked = true;
      return next();
    }
    req.user = user;
    req.sessionSid = session.sid;
    return next();
  } catch (_) {
    return next();
  }
}

function requireAuth(req, res, next) {
  if (req.userBlocked) return next(new ApiError(403, 'account_suspended', 'Account is suspended'));
  if (!req.user) return next(new ApiError(401, 'unauthorized', 'Authentication required'));
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return next(new ApiError(401, 'unauthorized', 'Authentication required'));
  if (req.user.role !== 'admin') return next(new ApiError(403, 'forbidden', 'Admin access required'));
  return next();
}

function isOwner(user) {
  if (!user || user.role !== 'admin') return false;
  try {
    const perms = JSON.parse(user.permissions || '[]');
    return Array.isArray(perms) && perms.includes('*');
  } catch (_) {
    return false;
  }
}

function adminPermissions(user) {
  try {
    const perms = JSON.parse(user.permissions || '[]');
    return Array.isArray(perms) ? perms : [];
  } catch (_) {
    return [];
  }
}

function requirePerm(permission) {
  return (req, res, next) => {
    if (!req.user) return next(new ApiError(401, 'unauthorized', 'Authentication required'));
    if (req.user.role !== 'admin') return next(new ApiError(403, 'forbidden', 'Admin access required'));
    if (isOwner(req.user)) return next();
    if (!adminPermissions(req.user).includes(permission)) {
      return next(new ApiError(403, 'forbidden', 'Permission denied'));
    }
    return next();
  };
}

function requireOwner(req, res, next) {
  if (!req.user) return next(new ApiError(401, 'unauthorized', 'Authentication required'));
  if (!isOwner(req.user)) return next(new ApiError(403, 'owner_only', 'Only the account owner can do this'));
  return next();
}

function csrfProtection(req, res, next) {
  const method = String(req.method || '').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();
  const path = req.path || '';
  if (
    path.startsWith('/api/v1/') ||
    path === '/api/auth/login' ||
    path === '/api/setup' ||
    path === '/api/setup/status' ||
    path === '/api/health' ||
    path === '/api/meta'
  ) {
    return next();
  }
  if (!req.cookies || !req.cookies[SESSION_COOKIE]) return next();
  const cookieToken = req.cookies[CSRF_COOKIE];
  const headerToken = req.get('x-csrf-token');
  if (!cookieToken || !headerToken || !timingSafeEqual(cookieToken, headerToken)) {
    return next(new ApiError(403, 'csrf', 'Invalid CSRF token'));
  }
  return next();
}

function publicUser(row) {
  return sanitizeUser(row);
}

module.exports = {
  SESSION_COOKIE,
  CSRF_COOKIE,
  hashPassword,
  verifyPassword,
  setSessionCookie,
  clearSessionCookie,
  revokeSession,
  setCsrfCookie,
  ensureCsrfCookie,
  authMiddleware,
  requireAuth,
  requireAdmin,
  requirePerm,
  requireOwner,
  isOwner,
  adminPermissions,
  findUserById,
  csrfProtection,
  publicUser,
};

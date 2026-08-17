// Session handling for the basic RBAC feature (see src/store/users.js for
// why this is minimal). No cookie-parser dependency in package.json, so
// cookies are parsed by hand; sessions live in memory (a Map) rather than
// on disk — restarting the server logs everyone out, which is fine for a
// local dev tool and avoids yet another JSON file to manage.

const crypto = require('crypto');
const users = require('../store/users');

const SESSION_COOKIE = 'atlas_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

const sessions = new Map(); // token -> { username, role, expiresAt }

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username: user.username, role: user.role, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

// Populates req.user ({ username, role }) from the session cookie, or
// leaves it null for an unauthenticated request. Unauthenticated requests
// are treated as the lowest role ('viewer') by requireRole below, rather
// than being rejected outright — most of the app (browsing scans, wikis,
// issues) stays open; only the handful of gated write actions need a login.
function attachUser(req, res, next) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const session = getSession(token);
  req.user = session ? { username: session.username, role: session.role } : null;
  req.sessionToken = session ? token : null;
  next();
}

function requireRole(minRole) {
  return (req, res, next) => {
    const role = req.user ? req.user.role : 'viewer';
    if ((users.ROLE_RANK[role] ?? 0) < users.ROLE_RANK[minRole]) {
      return res.status(403).json({
        error: req.user
          ? `This action requires the "${minRole}" role or higher — you're signed in as "${role}".`
          : `This action requires the "${minRole}" role or higher — log in first.`,
      });
    }
    next();
  };
}

module.exports = { SESSION_COOKIE, SESSION_TTL_MS, attachUser, requireRole, createSession, destroySession, getSession, parseCookies };

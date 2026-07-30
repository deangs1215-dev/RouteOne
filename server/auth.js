import jwt from 'jsonwebtoken';
import { db, getSetting, setSetting } from './db.js';
import crypto from 'crypto';

export const SESSION_COOKIE = 'routeone_session';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

let secret = getSetting('jwt_secret');
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  setSetting('jwt_secret', secret);
}
export const JWT_SECRET = secret;

export function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role_name }, JWT_SECRET, { expiresIn: '12h' });
}

function cookieValue(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

// Secure cookies require HTTPS - a browser silently drops a Secure cookie
// received over plain HTTP, which looks like "login works for a second then
// bounces back to the login screen". Defaults to NODE_ENV=production, but
// COOKIE_SECURE=0 is available as an explicit, documented escape hatch for an
// internal HTTP-only deployment (e.g. a test server with no reverse proxy/TLS
// in front of it yet). Never set this to 0 for anything internet-facing.
const cookieSecure = process.env.COOKIE_SECURE !== undefined
  ? process.env.COOKIE_SECURE === '1'
  : process.env.NODE_ENV === 'production';

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'strict',
    path: '/'
  });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || cookieValue(req, SESSION_COOKIE);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare(`
      SELECT u.*, r.name AS role_name
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ? AND u.active = 1
    `).get(payload.id);
    if (!user) return res.status(401).json({ error: 'User not found or deactivated' });
    user.role = user.role_name; // alias: several handlers check req.user.role
    req.user = user;
    req.authSource = bearer ? 'bearer' : 'cookie';
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (roles.includes(req.user.role_name)) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

// Reps only see their own customers, visits and orders; office roles see everything.
export function scopeForUser(user) {
  return {
    isOffice: ['admin', 'manager', 'office'].includes(user.role_name),
    isRep: user.role_name === 'rep'
  };
}

export function userCanAccessCustomer(user, customerId) {
  if (!scopeForUser(user).isRep) return true;
  const customer = db.prepare('SELECT rep_id FROM customers WHERE id = ?').get(customerId);
  return !!customer && customer.rep_id === user.id;
}

export function passwordIsStrong(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) return false;
  const normalized = password.trim().toLowerCase();
  return ![
    '123', '123456', 'admin123', 'demo123', 'password', 'password1',
    'routeone', 'bakels123', 'qwerty123'
  ].includes(normalized);
}

export function passwordGuard(req, res, next) {
  if (req.user.must_change_password) {
    return res.status(403).json({
      error: 'Password change required',
      code: 'PASSWORD_CHANGE_REQUIRED'
    });
  }
  next();
}

// Portal logins may only touch /portal/* and /auth/* - nothing else.
export function customerGuard(req, res, next) {
  if (req.user.role_name === 'customer' && !req.path.startsWith('/portal')) {
    return res.status(403).json({ error: 'Customer portal access only' });
  }
  next();
}

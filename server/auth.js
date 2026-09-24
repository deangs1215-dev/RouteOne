import jwt from 'jsonwebtoken';
import { db, dbx } from './db.js';
import { getSetting, setSetting } from './dbh.js';
import crypto from 'crypto';

export const SESSION_COOKIE = 'routeone_session';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

let secret = await getSetting('jwt_secret');
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  await setSetting('jwt_secret', secret);
}
export const JWT_SECRET = secret;

// `v` is the user's token_version. Bumping that column (password reset, password
// change, admin-set password) makes every token issued before the bump fail the
// check in requireAuth - without it a stolen session stayed valid for its full
// 12 hours after the victim reset their password, which defeats the reset.
export function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role_name, v: user.token_version ?? 0 },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
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

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || cookieValue(req, SESSION_COOKIE);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // Outside the verify try/catch: a database failure is a 500 (Express 5 routes
  // a rejected async middleware to the error handler), not "invalid token".
  const user = await dbx.prepare(`
    SELECT u.*, r.name AS role_name
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.id = ? AND u.active = 1
  `).get(payload.id);
  if (!user) return res.status(401).json({ error: 'User not found or deactivated' });
  // Tokens issued before the account's password last changed are dead. A token
  // predating the column has no `v` and reads as 0, matching the default, so
  // existing sessions survive the migration until they expire on their own.
  if ((payload.v ?? 0) !== (user.token_version ?? 0)) {
    return res.status(401).json({ error: 'Session ended - please sign in again' });
  }
  // Deny-by-default on role: scopeForUser can only scope a role it recognises,
  // so an unrecognised one is refused here rather than reaching a handler.
  if (!KNOWN_ROLES.includes(user.role_name)) {
    return res.status(403).json({ error: 'Your account role is not recognised - contact an administrator' });
  }
  user.role = user.role_name; // alias: several handlers check req.user.role
  req.user = user;
  req.authSource = bearer ? 'bearer' : 'cookie';
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (roles.includes(req.user.role_name)) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

const OFFICE_ROLES = ['admin', 'manager', 'office'];
// Every role RouteOne knows how to scope. requireAuth refuses anything else.
export const KNOWN_ROLES = [...OFFICE_ROLES, 'rep', 'customer'];

// Reps only see their own customers, visits and orders; office roles see everything.
export function scopeForUser(user) {
  const isOffice = OFFICE_ROLES.includes(user.role_name);
  return {
    isOffice,
    // Deliberately "not office", not "=== 'rep'". Every caller is shaped
    // `scope.isRep ? <own records only> : <everything>`, so a role matching
    // neither test - the customer-portal login, or any role added later - fell
    // through to the office branch and was handed the whole company's data.
    // Defining it this way makes an unrecognised role scope DOWN to its own
    // records (for a non-rep, nothing at all) instead of up.
    isRep: !isOffice
  };
}

// Cost price is internal commercial data: what the company paid, and the margin
// derivable from it. Office roles only - a rep sees selling prices. Applied at
// the response, since the product queries select whole rows.
export function withoutCostFields(user, row) {
  if (scopeForUser(user).isOffice) return row;
  const { cost_price, ...rest } = row;
  return rest;
}

export function userCanAccessCustomer(user, customerId) {
  if (!scopeForUser(user).isRep) return true;
  const customer = db.prepare('SELECT rep_id FROM customers WHERE id = ?').get(customerId);
  return !!customer && customer.rep_id === user.id;
}

// Async twin for migrated callers; the synchronous version above goes once
// every caller has moved.
export async function userCanAccessCustomerAsync(user, customerId) {
  if (!scopeForUser(user).isRep) return true;
  const customer = await dbx.prepare('SELECT rep_id FROM customers WHERE id = ?').get(customerId);
  return !!customer && customer.rep_id === user.id;
}

export function passwordIsStrong(password) {
  if (typeof password !== 'string' || password.length < 9 || password.length > 128) return false;
  const hasCapital = /[A-Z]/.test(password);
  const hasNumber = /\d/.test(password);
  if (!hasCapital || !hasNumber) return false;
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

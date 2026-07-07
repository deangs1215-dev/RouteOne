import jwt from 'jsonwebtoken';
import { db, getSetting, setSetting } from './db.js';
import crypto from 'crypto';

let secret = getSetting('jwt_secret');
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  setSetting('jwt_secret', secret);
}
export const JWT_SECRET = secret;

export function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role_name }, JWT_SECRET, { expiresIn: '12h' });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare(`
      SELECT u.*, r.name AS role_name
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ? AND u.active = 1
    `).get(payload.id);
    if (!user) return res.status(401).json({ error: 'User not found or deactivated' });
    req.user = user;
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

// Portal logins may only touch /portal/* and /auth/* - nothing else.
export function customerGuard(req, res, next) {
  if (req.user.role_name === 'customer' && !req.path.startsWith('/portal')) {
    return res.status(403).json({ error: 'Customer portal access only' });
  }
  next();
}

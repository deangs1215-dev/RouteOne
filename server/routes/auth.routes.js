import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { dbx } from '../db.js';
import { logActivity } from '../dbh.js';
import {
  signToken, requireAuth, setSessionCookie, clearSessionCookie, passwordIsStrong
} from '../auth.js';
import { buildPasswordResetEmail, sendEmail } from '../integration/email.js';

const router = Router();
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone,
    role: u.role_name, sales_target: u.sales_target,
    customer_id: u.customer_id || null,
    must_change_password: !!u.must_change_password
  };
}

// Brute-force protection: after 10 failed attempts for an email+IP pair,
// block further tries for 15 minutes. In-memory - resets on restart, which
// is fine for this purpose.
const failedLogins = new Map(); // key -> { count, until }
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const DUMMY_HASH = bcrypt.hashSync('routeone-timing-check-only', 10);

function loginBlocked(key) {
  const rec = failedLogins.get(key);
  if (!rec) return false;
  if (rec.until && Date.now() < rec.until) return true;
  if (rec.until && Date.now() >= rec.until) failedLogins.delete(key);
  return false;
}

function recordFailure(key) {
  if (failedLogins.size > 10000) {
    const now = Date.now();
    for (const [storedKey, rec] of failedLogins) {
      if (!rec.until || rec.until < now) failedLogins.delete(storedKey);
    }
  }
  const rec = failedLogins.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.until = Date.now() + LOCKOUT_MS;
  failedLogins.set(key, rec);
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase().slice(0, 320);
  const keys = [`ip:${req.ip}`, `email:${normalizedEmail}`];
  if (keys.some(loginBlocked)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }
  const user = await dbx.prepare(`
    SELECT u.*, r.name AS role_name FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE lower(u.email) = lower(?) AND u.active = 1
  `).get(normalizedEmail);
  const passwordMatches = await bcrypt.compare(
    typeof password === 'string' ? password.slice(0, 128) : '',
    user?.password_hash || DUMMY_HASH
  );
  if (!user || !passwordMatches) {
    keys.forEach(recordFailure);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!passwordIsStrong(password) && !user.must_change_password) {
    await dbx.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(user.id);
    user.must_change_password = 1;
  }
  keys.forEach((key) => failedLogins.delete(key));
  await logActivity(user.id, 'login', 'user', user.id);
  const token = signToken(user);
  setSessionCookie(res, token);
  res.json({ user: publicUser(user) });
});

router.get('/me', requireAuth, async (req, res) => {
  res.json(publicUser(req.user));
});

router.post('/logout', async (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Always return the same generic response regardless of whether the email
// matches an account - do not let this endpoint be used to enumerate users.
router.post('/forgot-password', async (req, res) => {
  const normalizedEmail = String(req.body?.email || '').trim().toLowerCase().slice(0, 320);
  const genericResponse = { ok: true, message: "If that email is on file, we've sent a reset link." };
  if (!normalizedEmail) return res.json(genericResponse);

  const user = await dbx.prepare(`
    SELECT u.* FROM users u WHERE lower(u.email) = lower(?) AND u.active = 1
  `).get(normalizedEmail);
  if (!user) return res.json(genericResponse);

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await dbx.prepare('UPDATE users SET reset_token_hash = ?, reset_token_expires = ? WHERE id = ?')
    .run(hashToken(token), expires, user.id);

  // APP_ORIGIN may list several allowed origins (comma-separated) when the app
  // is reachable by both hostname and IP. Only the first is the canonical one -
  // using the whole string here would build a broken reset URL.
  const appOrigin = (process.env.APP_ORIGIN || '').split(',')[0].trim() || 'http://localhost:5190';
  const resetLink = `${appOrigin}/reset-password?token=${token}`;
  sendEmail(buildPasswordResetEmail(user, resetLink))
    .catch((e) => console.error('Password reset email failed:', e.message));

  res.json(genericResponse);
});

router.post('/reset-password', async (req, res) => {
  const { token, new_password: newPassword } = req.body || {};
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'Invalid or expired reset link' });
  }
  const user = await dbx.prepare(`
    SELECT * FROM users WHERE reset_token_hash = ? AND reset_token_expires > datetime('now') AND active = 1
  `).get(hashToken(token));
  if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });

  if (!passwordIsStrong(newPassword)) {
    return res.status(400).json({ error: 'Use at least 12 characters and avoid common passwords' });
  }
  // token_version + 1 ends every existing session for this account. A reset is
  // the one moment where that is the whole point: whoever prompted it may be
  // holding a stolen token, and it must stop working now, not in 12 hours.
  await dbx.prepare(`
    UPDATE users SET password_hash = ?, must_change_password = 0,
      reset_token_hash = NULL, reset_token_expires = NULL,
      token_version = token_version + 1
    WHERE id = ?
  `).run(await bcrypt.hash(newPassword, 12), user.id);
  await logActivity(user.id, 'password_reset', 'user', user.id);
  res.json({ ok: true });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password: currentPassword, new_password: newPassword } = req.body || {};
  if (!await bcrypt.compare(currentPassword || '', req.user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  if (!passwordIsStrong(newPassword)) {
    return res.status(400).json({ error: 'Use at least 12 characters and avoid common passwords' });
  }
  if (await bcrypt.compare(newPassword, req.user.password_hash)) {
    return res.status(400).json({ error: 'New password must be different' });
  }
  // Ends the user's other sessions, then re-issues a token at the new version
  // so the browser doing the change stays signed in.
  const nextVersion = (req.user.token_version ?? 0) + 1;
  await dbx.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = ? WHERE id = ?')
    .run(await bcrypt.hash(newPassword, 12), nextVersion, req.user.id);
  await logActivity(req.user.id, 'password_change', 'user', req.user.id);
  const user = { ...req.user, must_change_password: 0, token_version: nextVersion };
  const token = signToken(user);
  setSessionCookie(res, token);
  res.json({ user: publicUser(user) });
});

export default router;

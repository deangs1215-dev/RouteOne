import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, logActivity } from '../db.js';
import { signToken, requireAuth } from '../auth.js';

const router = Router();

function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone,
    role: u.role_name, territory_id: u.territory_id, sales_target: u.sales_target,
    customer_id: u.customer_id || null
  };
}

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare(`
    SELECT u.*, r.name AS role_name FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE lower(u.email) = lower(?) AND u.active = 1
  `).get(email || '');
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  logActivity(user.id, 'login', 'user', user.id);
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
  res.json(publicUser(req.user));
});

export default router;

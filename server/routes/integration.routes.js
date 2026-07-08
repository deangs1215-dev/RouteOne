// Phase 4: SYSPRO sync + email admin endpoints.
import { Router } from 'express';
import { db, getSetting, setSetting, logActivity } from '../db.js';
import { requireRole } from '../auth.js';
import { getProvider } from '../integration/providers.js';
import { runSync, SYNC_ENTITIES } from '../integration/sync.js';
import { buildOrderEmail, buildOrderConfirmationEmail, buildQuoteEmail, sendEmail, attemptSend } from '../integration/email.js';

const router = Router();

// Settings exposed to the Integration page. Passwords are write-only: GET
// returns whether one is set, never the value.
const SETTING_KEYS = [
  'intg_source', 'syspro_host', 'syspro_port', 'syspro_db', 'syspro_user',
  'syspro_view_customers', 'syspro_view_products', 'syspro_view_stock', 'syspro_view_prices',
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_from',
  'orders_email', 'email_auto_send', 'email_confirm_customer',
  'sync_schedule', 'sync_daily_time'
];
const SECRET_KEYS = ['syspro_password', 'smtp_password'];

router.get('/integration/settings', requireRole('admin'), (req, res) => {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = getSetting(k, '');
  for (const k of SECRET_KEYS) out[`${k}_set`] = getSetting(k, '') ? 1 : 0;
  // Read-only status of the automatic scheduler.
  out.last_auto_sync_at = getSetting('last_auto_sync_at', '');
  out.last_auto_sync_result = getSetting('last_auto_sync_result', '');
  res.json(out);
});

router.put('/integration/settings', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  for (const k of SETTING_KEYS) if (k in b) setSetting(k, b[k] ?? '');
  for (const k of SECRET_KEYS) if (b[k]) setSetting(k, b[k]); // only overwrite when a new value is typed
  logActivity(req.user.id, 'update', 'integration_settings', null);
  res.json({ ok: true });
});

router.post('/integration/test-connection', requireRole('admin'), async (req, res) => {
  try {
    await getProvider().test();
    res.json({ ok: true, source: getSetting('intg_source', 'demo') });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/integration/sync/:entity', requireRole('admin', 'manager', 'office'), async (req, res) => {
  const entity = req.params.entity;
  try {
    if (entity === 'all') {
      const results = [];
      for (const e of SYNC_ENTITIES) results.push(await runSync(e));
      return res.json({ results });
    }
    res.json(await runSync(entity));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/integration/sync-runs', requireRole('admin', 'manager', 'office'), (req, res) => {
  res.json(db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 50').all());
});

// --- Email log ---------------------------------------------------------------

router.get('/integration/emails', requireRole('admin', 'manager', 'office'), (req, res) => {
  res.json(db.prepare(`
    SELECT id, kind, ref_id, to_addr, cc_addr, subject, status, error, created_at, sent_at
    FROM email_log ORDER BY id DESC LIMIT 100
  `).all());
});

router.get('/integration/emails/:id', requireRole('admin', 'manager', 'office'), (req, res) => {
  const email = db.prepare('SELECT * FROM email_log WHERE id = ?').get(req.params.id);
  if (!email) return res.status(404).json({ error: 'Email not found' });
  res.json(email);
});

router.post('/integration/emails/:id/resend', requireRole('admin', 'manager', 'office'), async (req, res) => {
  res.json(await attemptSend(req.params.id));
});

// --- Send order / quote emails on demand --------------------------------------

router.post('/orders/:id/email', async (req, res) => {
  try {
    const result = await sendEmail(buildOrderEmail(req.params.id));
    logActivity(req.user.id, 'email', 'order', req.params.id, { status: result.status });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/orders/:id/email-customer', async (req, res) => {
  try {
    const result = await sendEmail(buildOrderConfirmationEmail(req.params.id));
    logActivity(req.user.id, 'email', 'order', req.params.id, { status: result.status, to: 'customer' });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/quotes/:id/email', async (req, res) => {
  try {
    const result = await sendEmail(buildQuoteEmail(req.params.id));
    logActivity(req.user.id, 'email', 'quote', req.params.id, { status: result.status });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;

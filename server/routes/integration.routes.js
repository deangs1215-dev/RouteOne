// Phase 4: SYSPRO sync + email admin endpoints.
import { Router } from 'express';
import { dbx } from '../db.js';
import { getSetting, setSetting, logActivity } from '../dbh.js';
import { requireRole, scopeForUser } from '../auth.js';
import { getProvider, testSyspro } from '../integration/providers.js';
import { runSync, SYNC_ENTITIES, matchRep } from '../integration/sync.js';
import { buildOrderConfirmationEmail, buildQuoteEmail, sendEmail, attemptSend, sendTestEmail } from '../integration/email.js';
import { sendAllRepDigests } from '../integration/repDigest.js';
import { sendSyncDigest } from '../integration/syncDigest.js';
import { encryptSecret } from '../crypto.js';

const router = Router();

// Settings exposed to the Integration page. Passwords are write-only: GET
// returns whether one is set, never the value.
const SETTING_KEYS = [
  'intg_source', 'syspro_host', 'syspro_port', 'syspro_db', 'syspro_user',
  'syspro_encrypt', 'syspro_trust_server_certificate',
  'syspro_view_warehouses', 'syspro_view_customers', 'syspro_view_products', 'syspro_view_stock', 'syspro_view_customer_pricing', 'syspro_view_invoices', 'syspro_view_invoice_lines', 'syspro_view_rep_sales', 'syspro_view_customer_sales',
   'email_transport', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_allow_invalid_cert', 'smtp_user', 'smtp_from',
  'graph_tenant_id', 'graph_client_id', 'graph_sender',
  'technical_email', 'email_auto_send', 'email_confirm_customer',
  'sync_schedule', 'sync_daily_time',
  'warehouses_sync_schedule', 'warehouses_sync_daily_time',
  'customers_sync_schedule', 'customers_sync_daily_time',
  'products_sync_schedule', 'products_sync_daily_time',
  'stock_sync_schedule', 'stock_sync_daily_time',
  'customer_pricing_sync_schedule', 'customer_pricing_sync_daily_time',
  'invoices_sync_schedule', 'invoices_sync_daily_time',
  'invoice_lines_sync_schedule', 'invoice_lines_sync_daily_time',
  'rep_sales_sync_schedule', 'rep_sales_sync_daily_time',
  'customer_sales_sync_schedule', 'customer_sales_sync_daily_time',
  'rep_sync_schedule', 'rep_sync_daily_time',
  'rep_digest_enabled', 'rep_digest_time',
  'sync_digest_enabled', 'sync_digest_time', 'sync_digest_emails',
  // Company letterhead (email header/footer + PDF documents)
  'company_name', 'company_reg', 'company_vat', 'company_address',
  'company_phone', 'company_email', 'company_website', 'company_logo'
];
const SECRET_KEYS = ['syspro_password', 'smtp_password', 'graph_client_secret'];

router.get('/integration/settings', requireRole('admin'), async (req, res) => {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = await getSetting(k, '');
  for (const k of SECRET_KEYS) out[`${k}_set`] = await getSetting(k, '') ? 1 : 0;
  // Read-only status of the automatic schedulers.
  out.last_auto_sync_at = await getSetting('last_auto_sync_at', '');
  out.last_auto_sync_result = await getSetting('last_auto_sync_result', '');
  out.last_rep_sync_at = await getSetting('last_rep_sync_at', '');
  out.last_rep_sync_result = await getSetting('last_rep_sync_result', '');
  out.last_rep_digest_at = await getSetting('last_rep_digest_at', '');
  out.last_rep_digest_result = await getSetting('last_rep_digest_result', '');
  out.last_sync_digest_at = await getSetting('last_sync_digest_at', '');
  out.last_sync_digest_result = await getSetting('last_sync_digest_result', '');
  res.json(out);
});

router.put('/integration/settings', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  for (const k of SETTING_KEYS) if (k in b) await setSetting(k, b[k] ?? '');
  for (const k of SECRET_KEYS) {
    if (b[k]) {
      // Encrypt before storing so passwords are never plaintext at rest
      await setSetting(k, encryptSecret(b[k]));
    }
  }
  await logActivity(req.user.id, 'update', 'integration_settings', null);
  res.json({ ok: true });
});

router.post('/integration/test-connection', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  // If the form's data source is set to SYSPRO, test against whatever is
  // currently typed (even if unsaved) - not just the last-saved settings.
  const source = b.intg_source || await getSetting('intg_source', 'demo');
  try {
    if (source === 'syspro') await testSyspro(b);
    else await getProvider().test();
    res.json({ ok: true, source });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Proves the configured outgoing-mail transport (SMTP or Microsoft 365 Graph)
// actually works, without needing a real order/quote/form first.
router.post('/integration/test-email', requireRole('admin'), async (req, res) => {
  const to = (req.body?.to || '').trim();
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });
  try {
    const result = await sendTestEmail(to);
    if (result.status !== 'sent') return res.status(400).json({ error: result.error || `Email is ${result.status}`, result });
    res.json({ ok: true, result });
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

// Bulk re-match: pulls the live SYSPRO view again and assigns a rep to any
// customer that currently has none, using branch + rep_code.
//
// Reassignment is handled by the customers sync now (SYSPRO is master for rep
// ownership), so this is only a backfill for customers the sync could not place
// - typically ones whose branch differs from their rep's home branch. It fills
// nulls only, so re-running it is always safe.
router.post('/integration/match-reps', requireRole('admin'), async (req, res) => {
  try {
    const rows = await getProvider().fetch('customers');
    let matched = 0, alreadyAssigned = 0, noMatch = 0, notFound = 0;
    for (const row of rows) {
      const customer = await dbx.prepare('SELECT id, rep_id FROM customers WHERE code = ?').get(row.code);
      if (!customer) { notFound++; continue; }
      if (customer.rep_id) { alreadyAssigned++; continue; }
      const repId = await matchRep(row.warehouse_code, row.rep_code);
      if (repId) {
        await dbx.prepare('UPDATE customers SET rep_id = ? WHERE id = ?').run(repId, customer.id);
        matched++;
      } else {
        noMatch++;
      }
    }
    await logActivity(req.user.id, 'match_reps', 'customers', null, { matched, alreadyAssigned, noMatch, notFound });
    res.json({ ok: true, matched, alreadyAssigned, noMatch, notFound, total: rows.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/integration/sync-runs', requireRole('admin', 'manager', 'office'), async (req, res) => {
  res.json(await dbx.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 50').all());
});

// Manual "send now" for the daily rep digest - lets an admin test it without
// waiting for the scheduled time.
router.post('/integration/rep-digest/run-now', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const results = await sendAllRepDigests('manual');
    res.json({ results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/integration/sync-digest/run-now', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await sendSyncDigest('manual');
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Email log ---------------------------------------------------------------

router.get('/integration/emails', requireRole('admin', 'manager', 'office'), async (req, res) => {
  res.json(await dbx.prepare(`
    SELECT id, kind, ref_id, to_addr, cc_addr, subject, status, error, created_at, sent_at
    FROM email_log ORDER BY id DESC LIMIT 100
  `).all());
});

router.get('/integration/emails/:id', requireRole('admin', 'manager', 'office'), async (req, res) => {
  const email = await dbx.prepare('SELECT * FROM email_log WHERE id = ?').get(req.params.id);
  if (!email) return res.status(404).json({ error: 'Email not found' });
  res.json(email);
});

router.post('/integration/emails/:id/resend', requireRole('admin', 'manager', 'office'), async (req, res) => {
  res.json(await attemptSend(req.params.id));
});

// --- Send order / quote emails on demand --------------------------------------
// Office roles can email any document; a rep only their own.

async function canEmailDoc(user, table, id) {
  if (!scopeForUser(user).isRep) return true;
  const doc = await dbx.prepare(`SELECT rep_id FROM ${table} WHERE id = ?`).get(id);
  return !!doc && doc.rep_id === user.id;
}

router.post('/orders/:id/email-customer', async (req, res) => {
  if (!(await canEmailDoc(req.user, 'orders', req.params.id))) return res.status(403).json({ error: 'Not your order' });
  try {
    const result = await sendEmail(buildOrderConfirmationEmail(req.params.id));
    await logActivity(req.user.id, 'email', 'order', req.params.id, { status: result.status, to: 'customer' });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/quotes/:id/email', async (req, res) => {
  if (!(await canEmailDoc(req.user, 'quotes', req.params.id))) return res.status(403).json({ error: 'Not your quote' });
  try {
    const result = await sendEmail(buildQuoteEmail(req.params.id));
    await logActivity(req.user.id, 'email', 'quote', req.params.id, { status: result.status });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;

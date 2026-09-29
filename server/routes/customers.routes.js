import { Router } from 'express';
import { dbx } from '../db.js';
import { nextNumber, logActivity } from '../dbh.js';
import { requireRole, scopeForUser } from '../auth.js';

const router = Router();

router.get('/customers', async (req, res) => {
  const { q, status, rep_id, scope: scopeParam } = req.query;
  const scope = scopeForUser(req.user);
  // scope=all lets a rep see every customer (for the greyed-out full list and
  // the map), not just their own. Each row carries is_mine so the client can
  // distinguish ownership. Office/manager already see everyone regardless.
  const seeAll = scopeParam === 'all';
  const where = [];
  const params = [];
  if (scope.isRep && !seeAll) { where.push('c.rep_id = ?'); params.push(req.user.id); }
  else if (rep_id) { where.push('c.rep_id = ?'); params.push(rep_id); }
  if (q) { where.push('(c.name LIKE ? OR c.code LIKE ? OR c.city LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { where.push('c.status = ?'); params.push(status); }
  const rows = await dbx.prepare(`
    SELECT c.*, u.name AS rep_name,
      w.code AS warehouse_code, w.name AS warehouse_name,
      CASE WHEN c.rep_id = ? THEN 1 ELSE 0 END AS is_mine,
      (SELECT MAX(order_date) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled') AS last_order_at,
      (SELECT MAX(check_in_at) FROM visits v WHERE v.customer_id = c.id) AS last_visit_at
    FROM customers c
    LEFT JOIN users u ON u.id = c.rep_id
    LEFT JOIN warehouses w ON w.id = c.warehouse_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.name
  `).all(req.user.id, ...params);
  res.json(rows);
});

router.get('/customers/:id', async (req, res) => {
  const customer = await dbx.prepare(`
    SELECT c.*, u.name AS rep_name,
      w.code AS warehouse_code, w.name AS warehouse_name
    FROM customers c
    LEFT JOIN users u ON u.id = c.rep_id
    LEFT JOIN warehouses w ON w.id = c.warehouse_id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (scopeForUser(req.user).isRep && customer.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your customer' });
  }

  customer.contacts = await dbx.prepare('SELECT * FROM customer_contacts WHERE customer_id = ?').all(customer.id);
  customer.recent_orders = await dbx.prepare(`
    SELECT o.*, u.name AS rep_name FROM orders o
    LEFT JOIN users u ON u.id = o.rep_id
    WHERE o.customer_id = ? ORDER BY o.order_date DESC LIMIT 20
  `).all(customer.id);
  customer.recent_visits = await dbx.prepare(`
    SELECT v.*, u.name AS rep_name FROM visits v
    JOIN users u ON u.id = v.rep_id
    WHERE v.customer_id = ? ORDER BY COALESCE(v.check_in_at, v.planned_date) DESC LIMIT 20
  `).all(customer.id);
  customer.recent_quotes = await dbx.prepare(`
    SELECT q.*, u.name AS rep_name FROM quotes q
    LEFT JOIN users u ON u.id = q.rep_id
    WHERE q.customer_id = ? ORDER BY q.quote_date DESC LIMIT 10
  `).all(customer.id);
  // Contact logged without a visit - calls, emails, WhatsApps, meetings.
  customer.notes = await dbx.prepare(`
    SELECT n.id, n.note_type, n.note, n.created_at, n.user_id, u.name AS rep_name
    FROM customer_notes n JOIN users u ON u.id = n.user_id
    WHERE n.customer_id = ? ORDER BY n.created_at DESC LIMIT 50
  `).all(customer.id);
  customer.recent_forms = await dbx.prepare(`
    SELECT s.id, s.created_at, t.name AS template_name, u.name AS rep_name
    FROM form_submissions s
    JOIN form_templates t ON t.id = s.template_id
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.customer_id = ? ORDER BY s.created_at DESC LIMIT 10
  `).all(customer.id);
  // Invoices from SYSPRO, rolling last 30 days (newest first). Cap at today so
  // any future-dated ERP artifacts (e.g. credit-note reversals stamped years
  // ahead) don't leak into the "last 30 days" window.
  //
  // Matches billed-to OR delivered-to, same as invoices.routes.js - a store
  // invoiced centrally under a parent/group account (e.g. BRACKENHURST under
  // its head office) never appears as invoices.customer_id, only as an
  // invoice_items.delivery_customer_id on the group's invoice. Without this,
  // a group-billed store's profile shows no invoices at all.
  //
  // UNION of two branches rather than one `customer_id = ? OR EXISTS(...)` -
  // an OR spanning invoices and invoice_items can't be satisfied by either
  // column's index (confirmed via EXPLAIN QUERY PLAN against the live
  // 271k-row invoice_items table: it fell back to a full scan every time,
  // ~750ms, regardless of how few rows actually matched). Each UNION branch
  // uses its own index instead. `i.*`/`i.id` in every branch keeps UNION's
  // dedup keyed on invoice identity, not on total/balance happening to match.
  customer.recent_invoices = await dbx.prepare(`
    SELECT i.* FROM invoices i
    WHERE i.customer_id = ?
      AND i.invoice_date >= date('now', '-30 days') AND i.invoice_date <= date('now')
    UNION
    SELECT i.* FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
    WHERE ii.delivery_customer_id = ?
      AND i.invoice_date >= date('now', '-30 days') AND i.invoice_date <= date('now')
    ORDER BY invoice_date DESC
  `).all(customer.id, customer.id);
  customer.invoice_summary = await dbx.prepare(`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(total), 0) AS total,
      COALESCE(SUM(balance), 0) AS outstanding
    FROM (
      SELECT DISTINCT i.id, i.total, i.balance FROM invoices i
      WHERE i.customer_id = ?
        AND i.invoice_date >= date('now', '-30 days') AND i.invoice_date <= date('now')
      UNION
      SELECT DISTINCT i.id, i.total, i.balance FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
      WHERE ii.delivery_customer_id = ?
        AND i.invoice_date >= date('now', '-30 days') AND i.invoice_date <= date('now')
    ) combined
  `).get(customer.id, customer.id);
  customer.prices = await dbx.prepare(`
    SELECT cp.product_id, cp.price, p.code, p.name, p.list_price
    FROM customer_prices cp JOIN products p ON p.id = cp.product_id
    WHERE cp.customer_id = ? ORDER BY p.name
  `).all(customer.id);
  // order_count / sales_total stay RouteOne-native: they measure order-capture
  // activity in the app, which is a different question from what the customer
  // has actually bought.
  customer.stats = await dbx.prepare(`
    SELECT
      COUNT(*) AS order_count,
      COALESCE(SUM(total), 0) AS sales_total
    FROM orders WHERE customer_id = ? AND status != 'cancelled'
  `).get(customer.id);

  // sales_12m is SYSPRO's actual invoiced sales, ex-VAT, over the rolling
  // previous 12 months (customer_monthly_sales, synced from
  // vw_FS_CustomerSalesByMonth) - NOT RouteOne's own orders. A customer who
  // orders by phone or direct through SYSPRO was previously showing as though
  // they had stopped buying.
  //
  // Keyed on customer CODE because that is what SYSPRO aggregates by, and it is
  // the DELIVERY customer - so a store invoiced through a group account still
  // gets credited its own sales.
  //
  // Window: the 11 completed months before this one, plus this month to date.
  // strftime gives 'YYYY-MM' keys, compared as strings, which sort correctly.
  const twelveMonthWindowStart = (await dbx.prepare(
    "SELECT strftime('%Y-%m', date('now', 'start of month', '-11 months')) AS m"
  ).get()).m;
  // sales_mtd is the same measure as sales_12m, restricted to the current
  // calendar month. It previously summed RouteOne's own orders, which reported
  // only what was captured in the app - e.g. MONDEOR HOMEBAKE SUPPLIES showed
  // R4 683,17 from 2 captured orders against 5 SYSPRO invoices for the month.
  customer.stats.sales_mtd = (await dbx.prepare(`
    SELECT COALESCE(SUM(sales_value), 0) AS total
    FROM customer_monthly_sales
    WHERE customer_code = ? AND month = strftime('%Y-%m', 'now')
  `).get(customer.code)).total;

  customer.stats.sales_12m = (await dbx.prepare(`
    SELECT COALESCE(SUM(sales_value), 0) AS total
    FROM customer_monthly_sales
    WHERE customer_code = ? AND month >= ? AND month <= strftime('%Y-%m', 'now')
  `).get(customer.code, twelveMonthWindowStart)).total;

  // Per-month figures for the same window, oldest first - lets the profile show
  // a trend rather than a single number, and makes the total auditable.
  customer.sales_by_month = await dbx.prepare(`
    SELECT month, sales_value
    FROM customer_monthly_sales
    WHERE customer_code = ? AND month >= ? AND month <= strftime('%Y-%m', 'now')
    ORDER BY month
  `).all(customer.code, twelveMonthWindowStart);
  // Rep-captured field intel (not from SYSPRO). Always present so the client
  // can render the card even before anything has been filled in.
  customer.intel_notes = await dbx.prepare(`
    SELECT ci.*, u.name AS updated_by_name
    FROM customer_intel ci LEFT JOIN users u ON u.id = ci.updated_by
    WHERE ci.customer_id = ?
  `).get(customer.id) || null;
  res.json(customer);
});

// Fields a rep may capture as field intel. Whitelisted so the PUT below can't
// be used to write arbitrary columns.
const INTEL_FIELDS = [
  'current_supplier', 'decision_maker', 'best_visit_time',
  'delivery_notes', 'products_of_interest', 'competitor_notes', 'general_notes'
];

router.get('/customers/:id/intel-notes', async (req, res) => {
  const customer = await dbx.prepare('SELECT id, rep_id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (scopeForUser(req.user).isRep && customer.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your customer' });
  }
  res.json(await dbx.prepare('SELECT * FROM customer_intel WHERE customer_id = ?').get(customer.id) || {});
});

// Upsert the rep's field intel for a customer. Any subset of INTEL_FIELDS.
router.put('/customers/:id/intel-notes', async (req, res) => {
  const b = req.body || {};
  const customer = await dbx.prepare('SELECT id, rep_id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (scopeForUser(req.user).isRep && customer.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your customer' });
  }
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 2000) : null);
  const values = INTEL_FIELDS.map((f) => clean(b[f]));
  await dbx.upsert('customer_intel', {
    keys: { customer_id: customer.id },
    set: { ...Object.fromEntries(INTEL_FIELDS.map((f, i) => [f, values[i]])), updated_by: req.user.id },
    now: ['updated_at']
  });
  await logActivity(req.user.id, 'update', 'customer_intel', customer.id);
  res.json(await dbx.prepare('SELECT * FROM customer_intel WHERE customer_id = ?').get(customer.id));
});

router.post('/customers', requireRole('admin', 'manager', 'office'), async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Customer name is required' });
  const code = b.code || await nextNumber('CUS');
  const info = await dbx.prepare(`
    INSERT INTO customers (code, name, classification, rep_id, contact_name, phone, email,
      address, city, lat, lng, credit_limit, payment_terms, visit_frequency, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    code, b.name, b.classification || 'B', b.rep_id || null,
    b.contact_name || null, b.phone || null, b.email || null, b.address || null, b.city || null,
    b.lat || null, b.lng || null, b.credit_limit || 0, b.payment_terms || '30 days',
    b.visit_frequency || 'weekly', b.status || 'active', b.notes || null
  );
  await logActivity(req.user.id, 'create', 'customer', info.lastInsertRowid, { name: b.name });
  res.json(await dbx.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
});

// A rep, in the field, logging a potential new account. Kept local to RouteOne
// only - status 'prospect' so it's never picked up by the SYSPRO code-matched
// sync, and it isn't pushed out anywhere. Just name + a GPS pin is enough;
// everything else is optional detail captured on-site.
router.post('/customers/prospect', async (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 200) : '';
  if (!name) return res.status(400).json({ error: 'Business name is required' });
  // Coordinates must be real GPS values or nothing - junk here would poison
  // the live map and the navigate links.
  const coord = (v, max) => (Number.isFinite(Number(v)) && Math.abs(Number(v)) <= max ? Number(v) : null);
  const lat = coord(b.lat, 90);
  const lng = coord(b.lng, 180);
  const text = (v, len = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, len) : null);
  const code = await nextNumber('PROSPECT');
  const info = await dbx.prepare(`
    INSERT INTO customers (code, name, classification, rep_id, contact_name, phone,
      address, city, lat, lng, visit_frequency, status, notes)
    VALUES (?, ?, 'C', ?, ?, ?, ?, ?, ?, ?, 'monthly', 'prospect', ?)
  `).run(
    code, name, req.user.id, text(b.contact_name), text(b.phone, 40),
    text(b.address), text(b.city, 100), lat, lng, text(b.notes, 1000)
  );
  await logActivity(req.user.id, 'create', 'customer', info.lastInsertRowid, { name, prospect: true });
  res.json(await dbx.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/customers/:id', requireRole('admin', 'manager', 'office'), async (req, res) => {
  const b = req.body || {};
  const existing = await dbx.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Customer not found' });
  await dbx.prepare(`
    UPDATE customers SET name = ?, classification = ?, rep_id = ?, contact_name = ?,
      phone = ?, email = ?, address = ?, city = ?, lat = ?, lng = ?, credit_limit = ?, balance = ?,
      payment_terms = ?, visit_frequency = ?, status = ?, notes = ?
    WHERE id = ?
  `).run(
    b.name ?? existing.name, b.classification ?? existing.classification,
    b.rep_id ?? existing.rep_id,
    b.contact_name ?? existing.contact_name, b.phone ?? existing.phone, b.email ?? existing.email,
    b.address ?? existing.address, b.city ?? existing.city, b.lat ?? existing.lat, b.lng ?? existing.lng,
    b.credit_limit ?? existing.credit_limit, b.balance ?? existing.balance,
    b.payment_terms ?? existing.payment_terms, b.visit_frequency ?? existing.visit_frequency,
    b.status ?? existing.status, b.notes ?? existing.notes, req.params.id
  );
  await logActivity(req.user.id, 'update', 'customer', req.params.id);
  res.json(await dbx.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
});

// RouteOne-only fields a rep can add/update on their own customer (grade,
// visit frequency, notes, GPS pin) - never touches anything SYSPRO owns, so a
// later sync can't silently overwrite what the rep just captured.
router.put('/customers/:id/details', async (req, res) => {
  const b = req.body || {};
  const existing = await dbx.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Customer not found' });
  if (scopeForUser(req.user).isRep && existing.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your customer' });
  }
  await dbx.prepare(`
    UPDATE customers SET classification = ?, visit_frequency = ?, notes = ?, lat = ?, lng = ?,
      onsite_name = ?, onsite_phone = ?, onsite_address = ?, onsite_lat = ?, onsite_lng = ?,
      onsite_contact = ?, onsite_cell = ?, onsite_pricelist = ?, onsite_vat = ?
    WHERE id = ?
  `).run(
    b.classification ?? existing.classification, b.visit_frequency ?? existing.visit_frequency,
    b.notes ?? existing.notes, b.lat ?? existing.lat, b.lng ?? existing.lng,
    b.onsite_name ?? existing.onsite_name, b.onsite_phone ?? existing.onsite_phone,
    b.onsite_address ?? existing.onsite_address, b.onsite_lat ?? existing.onsite_lat,
    b.onsite_lng ?? existing.onsite_lng,
    b.onsite_contact ?? existing.onsite_contact, b.onsite_cell ?? existing.onsite_cell,
    b.onsite_pricelist ?? existing.onsite_pricelist, b.onsite_vat ?? existing.onsite_vat,
    req.params.id
  );
  await logActivity(req.user.id, 'update', 'customer', req.params.id, { via: 'rep_details' });
  res.json(await dbx.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
});

router.post('/customers/:id/contacts', async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Contact name is required' });
  const customer = await dbx.prepare('SELECT id, rep_id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (scopeForUser(req.user).isRep && customer.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your customer' });
  }
  const info = await dbx.prepare(
    'INSERT INTO customer_contacts (customer_id, name, role, phone, email) VALUES (?, ?, ?, ?, ?)'
  ).run(customer.id, b.name, b.role || null, b.phone || null, b.email || null);
  res.json(await dbx.prepare('SELECT * FROM customer_contacts WHERE id = ?').get(info.lastInsertRowid));
});

// Log contact with a customer without checking in - a call, email, WhatsApp,
// meeting or general note. Deliberately not a visit: see the customer_notes
// comment in schema.sql for why these must stay out of the visit KPIs.
const NOTE_TYPES = ['note', 'call', 'email', 'whatsapp', 'meeting', 'sample'];

router.post('/customers/:id/notes', async (req, res) => {
  const b = req.body || {};
  const note = String(b.note ?? '').trim();
  if (!note) return res.status(400).json({ error: 'Note text is required' });
  if (note.length > 4000) return res.status(400).json({ error: 'Note is too long (max 4000 characters)' });
  const noteType = NOTE_TYPES.includes(b.note_type) ? b.note_type : 'note';
  const customer = await dbx.prepare('SELECT id, rep_id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (scopeForUser(req.user).isRep && customer.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your customer' });
  }
  const info = await dbx.prepare(
    'INSERT INTO customer_notes (customer_id, user_id, note_type, note) VALUES (?, ?, ?, ?)'
  ).run(customer.id, req.user.id, noteType, note);
  await logActivity(req.user.id, 'create', 'customer_note', info.lastInsertRowid, { customer_id: customer.id, note_type: noteType });
  res.json(await dbx.prepare(`
    SELECT n.id, n.note_type, n.note, n.created_at, n.user_id, u.name AS rep_name
    FROM customer_notes n JOIN users u ON u.id = n.user_id WHERE n.id = ?
  `).get(info.lastInsertRowid));
});

// Notes are append-only - a record of what happened doesn't get rewritten. The
// author may remove their own mistake; a manager or admin may remove any.
router.delete('/customer-notes/:id', async (req, res) => {
  const note = await dbx.prepare('SELECT id, user_id FROM customer_notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  const isOwner = note.user_id === req.user.id;
  if (!isOwner && !['admin', 'manager'].includes(req.user.role_name)) {
    return res.status(403).json({ error: 'You can only delete your own notes' });
  }
  await dbx.prepare('DELETE FROM customer_notes WHERE id = ?').run(note.id);
  await logActivity(req.user.id, 'delete', 'customer_note', note.id);
  res.json({ ok: true });
});

router.delete('/contacts/:id', async (req, res) => {
  const contact = await dbx.prepare(`
    SELECT cc.id, c.rep_id FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id
    WHERE cc.id = ?
  `).get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (scopeForUser(req.user).isRep && contact.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your customer' });
  }
  await dbx.prepare('DELETE FROM customer_contacts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Set or clear a contract price for one product.
router.put('/customers/:id/prices/:productId', requireRole('admin', 'manager', 'office'), async (req, res) => {
  const price = req.body?.price;
  if (price === null || price === '' || price === undefined) {
    await dbx.prepare('DELETE FROM customer_prices WHERE customer_id = ? AND product_id = ?').run(req.params.id, req.params.productId);
  } else {
    await dbx.upsert('customer_prices', {
      keys: { customer_id: req.params.id, product_id: req.params.productId },
      set: { price: Number(price) }
    });
  }
  await logActivity(req.user.id, 'price_change', 'customer', req.params.id, { product_id: req.params.productId, price });
  res.json({ ok: true });
});

// Timeline: all activities for a customer in chronological order (mobile view).
router.get('/customers/:id/timeline', async (req, res) => {
  const customer = await dbx.prepare('SELECT id, rep_id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (scopeForUser(req.user).isRep && customer.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your customer' });
  }

  const timeline = [];

  // Orders
  const orders = await dbx.prepare(`
    SELECT 'order' AS type, o.id, o.number, o.total, o.status, o.order_date AS date, u.name AS rep_name
    FROM orders o LEFT JOIN users u ON u.id = o.rep_id
    WHERE o.customer_id = ? AND o.status != 'cancelled'
  `).all(customer.id);
  timeline.push(...orders.map(o => ({ ...o, date_for_sort: o.date })));

  // Quotes
  const quotes = await dbx.prepare(`
    SELECT 'quote' AS type, q.id, q.number, q.total, q.status, q.quote_date AS date, u.name AS rep_name
    FROM quotes q LEFT JOIN users u ON u.id = q.rep_id
    WHERE q.customer_id = ?
  `).all(customer.id);
  timeline.push(...quotes.map(q => ({ ...q, date_for_sort: q.date })));

  // Visits
  const visits = await dbx.prepare(`
    SELECT 'visit' AS type, v.id, v.purpose, v.status, v.notes, COALESCE(v.check_in_at, v.planned_date) AS date, u.name AS rep_name
    FROM visits v JOIN users u ON u.id = v.rep_id
    WHERE v.customer_id = ?
  `).all(customer.id);
  timeline.push(...visits.map(v => ({ ...v, date_for_sort: v.date })));

  // Tasks
  const tasks = await dbx.prepare(`
    SELECT 'task' AS type, t.id, t.task_type, t.status, t.notes AS description, t.follow_up_date AS date, u.name AS rep_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.customer_id = ?
  `).all(customer.id);
  timeline.push(...tasks.map(t => ({ ...t, date_for_sort: t.date })));

  // Form submissions
  const forms = await dbx.prepare(`
    SELECT 'form' AS type, s.id, t.name AS template_name, s.created_at AS date, u.name AS rep_name
    FROM form_submissions s
    JOIN form_templates t ON t.id = s.template_id
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.customer_id = ?
  `).all(customer.id);
  timeline.push(...forms.map(f => ({ ...f, date_for_sort: f.date })));

  // Invoices (last 12 months). Matches billed-to OR delivered-to, same as
  // recent_invoices above - a group-billed store (see there) never appears
  // as invoices.customer_id, only as an invoice_items.delivery_customer_id
  // on the parent account's invoice. UNION of two branches, not one OR - see
  // recent_invoices for why (an OR spanning the join can't use either index).
  const invoices = await dbx.prepare(`
    SELECT 'invoice' AS type, i.id, i.number, i.order_number, i.total, i.balance, i.status, i.due_date, i.invoice_date AS date, NULL AS rep_name
    FROM invoices i
    WHERE i.customer_id = ? AND i.invoice_date >= date('now', '-365 days')
    UNION
    SELECT 'invoice' AS type, i.id, i.number, i.order_number, i.total, i.balance, i.status, i.due_date, i.invoice_date AS date, NULL AS rep_name
    FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
    WHERE ii.delivery_customer_id = ? AND i.invoice_date >= date('now', '-365 days')
  `).all(customer.id, customer.id);
  timeline.push(...invoices.map(i => ({ ...i, date_for_sort: i.date })));

  // Contact logged without a visit - calls, emails, WhatsApps, meetings.
  const notes = await dbx.prepare(`
    SELECT 'note' AS type, n.id, n.note_type, n.note AS description, n.created_at AS date, u.name AS rep_name
    FROM customer_notes n JOIN users u ON u.id = n.user_id
    WHERE n.customer_id = ?
  `).all(customer.id);
  timeline.push(...notes.map(n => ({ ...n, date_for_sort: n.date })));

  // Sort by date descending (newest first); rows with no date sink to the bottom.
  const ts = (s) => (s ? new Date(String(s).replace(' ', 'T')).getTime() || 0 : 0);
  timeline.sort((a, b) => ts(b.date_for_sort) - ts(a.date_for_sort));

  res.json(timeline);
});

router.get('/warehouses', async (req, res) => {
  res.json(await dbx.prepare('SELECT * FROM warehouses ORDER BY name').all());
});

export default router;

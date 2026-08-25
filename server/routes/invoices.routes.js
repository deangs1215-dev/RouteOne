import { Router } from 'express';
import { db, logActivity } from '../db.js';
import { scopeForUser } from '../auth.js';

const router = Router();

router.get('/invoices', (req, res) => {
  const { q, status, customer_id, rep_id } = req.query;
  const scope = scopeForUser(req.user);
  const where = [];
  const params = [];

  // A rep owns an invoice if they own the account it was BILLED to, or any store
  // it was DELIVERED to. Retail chains are invoiced centrally - PICK N PAY
  // RETAILERS gets the invoice, individual stores get the goods - and reps are
  // assigned to the stores. Scoping on the billed customer alone hid every
  // group-billed invoice from the rep who services the store.
  //
  // One invoice can span stores belonging to different reps, so it can now be
  // visible to more than one of them. That is deliberate and accurate: each rep
  // sees an invoice that genuinely includes their customer.
  //
  // Delivery attribution only reaches as far back as invoice_items, which the
  // lines view populates for 90 days - the same window as the invoice list.
  const repScope = `(c.rep_id = ? OR EXISTS (
      SELECT 1 FROM invoice_items ii
      JOIN customers dc ON dc.id = ii.delivery_customer_id
      WHERE ii.invoice_id = i.id AND dc.rep_id = ?
    ))`;
  if (scope.isRep) { where.push(repScope); params.push(req.user.id, req.user.id); }
  else if (rep_id) { where.push(repScope); params.push(rep_id, rep_id); }

  if (q) { where.push('(i.number LIKE ? OR c.name LIKE ? OR i.customer_code LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { where.push('i.status = ?'); params.push(status); }
  if (customer_id) { where.push('i.customer_id = ?'); params.push(customer_id); }

  // Never show invoices dated in the future (ERP credit-note artifacts get
  // stamped years ahead) - they'd otherwise dominate the newest-first list.
  where.push("i.invoice_date <= date('now')");

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT i.*, c.name AS customer_name, c.id AS cust_id, u.name AS rep_name
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    LEFT JOIN users u ON u.id = c.rep_id
    ${whereClause}
    ORDER BY i.invoice_date DESC
    LIMIT 100
  `).all(...params);

  res.json(rows);
});

router.get('/invoices/:id', (req, res) => {
  const invoice = db.prepare(`
    SELECT i.*, c.name AS customer_name, c.rep_id
    FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.id = ?
  `).get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  // Same ownership rule as the list: billed-to OR delivered-to. Without the
  // delivery check a rep could see a group-billed invoice in the list and then
  // get a 403 opening it.
  if (scopeForUser(req.user).isRep && invoice.rep_id !== req.user.id) {
    const deliveredToRep = db.prepare(`
      SELECT 1 FROM invoice_items ii
      JOIN customers dc ON dc.id = ii.delivery_customer_id
      WHERE ii.invoice_id = ? AND dc.rep_id = ?
      LIMIT 1
    `).get(invoice.id, req.user.id);
    if (!deliveredToRep) return res.status(403).json({ error: 'Not your invoice' });
  }
  delete invoice.rep_id;

  // Prefer SYSPRO's own invoice line detail (vw_FS_InvoiceLines, synced into
  // invoice_items) - authoritative, but only covers the last 30 days by
  // design (see docs/sql/vw_FS_InvoiceLines.sql). Older invoices fall back to
  // the linked RouteOne order's items as a best-effort approximation - SYSPRO
  // can still adjust qty/price at invoicing time, or split/merge orders
  // across invoices, so that fallback is never treated as authoritative.
  let items = db.prepare(`
    SELECT ii.product_code, ii.qty, ii.unit_price, ii.line_total, p.name AS product_name, p.uom,
      ii.delivery_customer_code, dc.name AS delivery_customer_name
    FROM invoice_items ii
    LEFT JOIN products p ON p.id = ii.product_id
    LEFT JOIN customers dc ON dc.id = ii.delivery_customer_id
    WHERE ii.invoice_id = ?
  `).all(invoice.id);
  // On a centrally-billed invoice the lines can span several stores, so the UI
  // needs to say which store each line went to. Only meaningful when it differs
  // from the billed customer - flagged here rather than compared in the client.
  const deliveryStores = [...new Set(items.map((i) => i.delivery_customer_name).filter(Boolean))];
  const isGroupBilled = deliveryStores.length > 0 &&
    !(deliveryStores.length === 1 && deliveryStores[0] === invoice.customer_name);
  let itemsSource = items.length ? 'syspro' : null;

  if (!items.length && invoice.order_number) {
    const order = db.prepare('SELECT id FROM orders WHERE number = ?').get(invoice.order_number);
    if (order) {
      items = db.prepare(`
        SELECT i.product_name, i.qty, i.uom, i.unit_price, i.line_total, p.code AS product_code
        FROM order_items i LEFT JOIN products p ON p.id = i.product_id
        WHERE i.order_id = ?
      `).all(order.id);
      itemsSource = 'order';
    }
  }
  res.json({ ...invoice, items, items_source: itemsSource, is_group_billed: isGroupBilled, delivery_stores: deliveryStores });
});

export default router;

import { Router } from 'express';
import { db, logActivity } from '../db.js';
import { scopeForUser } from '../auth.js';

const router = Router();

router.get('/invoices', (req, res) => {
  const { q, status, customer_id, rep_id } = req.query;
  const scope = scopeForUser(req.user);
  const where = [];
  const params = [];

  if (scope.isRep) { where.push('u.id = ?'); params.push(req.user.id); }
  else if (rep_id) { where.push('u.id = ?'); params.push(rep_id); }

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
  if (scopeForUser(req.user).isRep && invoice.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your invoice' });
  }
  delete invoice.rep_id;

  // Prefer SYSPRO's own invoice line detail (vw_FS_InvoiceLines, synced into
  // invoice_items) - authoritative, but only covers the last 30 days by
  // design (see docs/sql/vw_FS_InvoiceLines.sql). Older invoices fall back to
  // the linked RouteOne order's items as a best-effort approximation - SYSPRO
  // can still adjust qty/price at invoicing time, or split/merge orders
  // across invoices, so that fallback is never treated as authoritative.
  let items = db.prepare(`
    SELECT ii.product_code, ii.qty, ii.unit_price, ii.line_total, p.name AS product_name, p.uom
    FROM invoice_items ii LEFT JOIN products p ON p.id = ii.product_id
    WHERE ii.invoice_id = ?
  `).all(invoice.id);
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
  res.json({ ...invoice, items, items_source: itemsSource });
});

export default router;

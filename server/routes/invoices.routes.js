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
  res.json(invoice);
});

export default router;

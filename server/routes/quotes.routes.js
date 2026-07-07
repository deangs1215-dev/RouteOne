import { Router } from 'express';
import { db, nextNumber, logActivity, effectivePrice, VAT_RATE } from '../db.js';
import { scopeForUser } from '../auth.js';

const router = Router();
const round2 = (n) => Math.round(n * 100) / 100;

router.get('/quotes', (req, res) => {
  const { q, status, customer_id } = req.query;
  const scope = scopeForUser(req.user);
  const where = [];
  const params = [];
  if (scope.isRep) { where.push('qu.rep_id = ?'); params.push(req.user.id); }
  if (q) { where.push('(qu.number LIKE ? OR c.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (status) { where.push('qu.status = ?'); params.push(status); }
  if (customer_id) { where.push('qu.customer_id = ?'); params.push(customer_id); }
  const rows = db.prepare(`
    SELECT qu.*, c.name AS customer_name, u.name AS rep_name,
      (SELECT COUNT(*) FROM quote_items i WHERE i.quote_id = qu.id) AS line_count
    FROM quotes qu
    JOIN customers c ON c.id = qu.customer_id
    LEFT JOIN users u ON u.id = qu.rep_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY qu.quote_date DESC
    LIMIT 300
  `).all(...params);
  res.json(rows);
});

router.get('/quotes/:id', (req, res) => {
  const quote = db.prepare(`
    SELECT qu.*, c.name AS customer_name, c.code AS customer_code, c.payment_terms,
      u.name AS rep_name, o.number AS order_number
    FROM quotes qu
    JOIN customers c ON c.id = qu.customer_id
    LEFT JOIN users u ON u.id = qu.rep_id
    LEFT JOIN orders o ON o.id = qu.order_id
    WHERE qu.id = ?
  `).get(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  quote.items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quote.id);
  res.json(quote);
});

// Create a quote with lines - same pricing engine as orders, but no stock
// movement and no credit block (a quote commits nothing).
router.post('/quotes', (req, res) => {
  const b = req.body || {};
  if (!b.customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!Array.isArray(b.items) || b.items.length === 0) return res.status(400).json({ error: 'At least one quote line is required' });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(b.customer_id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const create = db.transaction(() => {
    const number = nextNumber('QUO');
    const validUntil = b.valid_until || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const info = db.prepare(`
      INSERT INTO quotes (number, customer_id, rep_id, visit_id, status, valid_until, notes)
      VALUES (?, ?, ?, ?, 'sent', ?, ?)
    `).run(number, b.customer_id, req.user.id, b.visit_id || null, validUntil, b.notes || null);
    const quoteId = info.lastInsertRowid;

    let subtotal = 0;
    const insertItem = db.prepare(`
      INSERT INTO quote_items (quote_id, product_id, product_name, qty, uom, unit_price, discount_pct, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of b.items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      if (!product) throw new Error(`Product ${item.product_id} not found`);
      const qty = Number(item.qty) || 0;
      if (qty <= 0) continue;
      const unitPrice = item.unit_price != null ? Number(item.unit_price) : effectivePrice(b.customer_id, product.id, qty);
      const lineTotal = round2(qty * unitPrice);
      subtotal += lineTotal;
      insertItem.run(quoteId, product.id, product.name, qty, product.uom, unitPrice, 0, lineTotal);
    }
    if (subtotal === 0) throw new Error('Quote has no valid lines');
    const vat = round2(subtotal * VAT_RATE);
    db.prepare('UPDATE quotes SET subtotal = ?, vat_amount = ?, total = ? WHERE id = ?')
      .run(round2(subtotal), vat, round2(subtotal + vat), quoteId);
    return quoteId;
  });

  try {
    const quoteId = create();
    logActivity(req.user.id, 'create', 'quote', quoteId, { customer: customer.name });
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId);
    quote.items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quoteId);
    res.json(quote);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/quotes/:id/status', (req, res) => {
  const status = req.body?.status;
  if (!['draft', 'sent', 'accepted', 'rejected', 'expired'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  if (quote.order_id) return res.status(400).json({ error: 'Quote already converted to an order' });
  db.prepare('UPDATE quotes SET status = ? WHERE id = ?').run(status, req.params.id);
  logActivity(req.user.id, 'status_change', 'quote', req.params.id, { from: quote.status, to: status });
  res.json(db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id));
});

// Convert an accepted quote into an order at the QUOTED prices (that's the
// point of a quote), moving stock like a normal order.
router.post('/quotes/:id/convert', (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  if (quote.order_id) return res.status(400).json({ error: 'Quote already converted' });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id);
  if (customer.status === 'on_hold') return res.status(400).json({ error: 'Customer account is on hold - order blocked' });
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quote.id);

  const convert = db.transaction(() => {
    const number = nextNumber('ORD');
    const info = db.prepare(`
      INSERT INTO orders (number, customer_id, rep_id, visit_id, status, subtotal, vat_amount, total, notes)
      VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, ?)
    `).run(number, quote.customer_id, req.user.id, quote.visit_id, quote.subtotal, quote.vat_amount, quote.total,
      `Converted from quote ${quote.number}`);
    const orderId = info.lastInsertRowid;
    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, qty, uom, unit_price, discount_pct, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const i of items) {
      insertItem.run(orderId, i.product_id, i.product_name, i.qty, i.uom, i.unit_price, i.discount_pct, i.line_total);
      db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?').run(i.qty, i.product_id);
    }
    db.prepare("UPDATE quotes SET status = 'accepted', order_id = ? WHERE id = ?").run(orderId, quote.id);
    return orderId;
  });

  const orderId = convert();
  logActivity(req.user.id, 'convert', 'quote', quote.id, { order_id: orderId });
  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
});

export default router;

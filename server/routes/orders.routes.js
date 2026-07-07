import { Router } from 'express';
import { db, nextNumber, logActivity, effectivePrice, VAT_RATE, getSetting } from '../db.js';
import { scopeForUser } from '../auth.js';
import { buildOrderEmail, buildOrderConfirmationEmail, sendEmail } from '../integration/email.js';

const router = Router();

const round2 = (n) => Math.round(n * 100) / 100;

router.get('/orders', (req, res) => {
  const { q, status, customer_id, rep_id } = req.query;
  const scope = scopeForUser(req.user);
  const where = [];
  const params = [];
  if (scope.isRep) { where.push('o.rep_id = ?'); params.push(req.user.id); }
  else if (rep_id) { where.push('o.rep_id = ?'); params.push(rep_id); }
  if (q) { where.push('(o.number LIKE ? OR c.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (customer_id) { where.push('o.customer_id = ?'); params.push(customer_id); }
  const rows = db.prepare(`
    SELECT o.*, c.name AS customer_name, u.name AS rep_name,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS line_count
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = o.rep_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY o.order_date DESC
    LIMIT 300
  `).all(...params);
  res.json(rows);
});

router.get('/orders/:id', (req, res) => {
  const order = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.code AS customer_code, c.address, c.city,
      c.payment_terms, u.name AS rep_name
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = o.rep_id
    WHERE o.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  // Flag lines where current stock is negative - i.e. this order over-committed.
  order.items = db.prepare(`
    SELECT i.*, p.stock_qty AS current_stock
    FROM order_items i JOIN products p ON p.id = i.product_id
    WHERE i.order_id = ?
  `).all(order.id).map((i) => ({ ...i, backorder: i.current_stock < 0 ? 1 : 0 }));
  res.json(order);
});

// Create an order with lines. Prices default to the customer's effective price
// unless explicitly overridden.
function createOrder(user, b, res) {
  if (!b.customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!Array.isArray(b.items) || b.items.length === 0) return res.status(400).json({ error: 'At least one order line is required' });

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(b.customer_id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (customer.status === 'on_hold') return res.status(400).json({ error: 'Customer account is on hold - order blocked' });

  const create = db.transaction(() => {
    const number = nextNumber('ORD');
    const info = db.prepare(`
      INSERT INTO orders (number, customer_id, rep_id, visit_id, status, notes, delivery_instructions)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(number, b.customer_id, user.id, b.visit_id || null, b.status === 'draft' ? 'draft' : 'submitted',
      b.notes || null, b.delivery_instructions || null);
    const orderId = info.lastInsertRowid;

    let subtotal = 0;
    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, qty, uom, unit_price, discount_pct, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of b.items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      if (!product) throw new Error(`Product ${item.product_id} not found`);
      const qty = Number(item.qty) || 0;
      if (qty <= 0) continue;
      // Qty-aware pricing: quantity breaks from price rules apply per line.
      const unitPrice = item.unit_price != null ? Number(item.unit_price) : effectivePrice(b.customer_id, product.id, qty);
      const discount = Number(item.discount_pct) || 0;
      const lineTotal = round2(qty * unitPrice * (1 - discount / 100));
      subtotal += lineTotal;
      insertItem.run(orderId, product.id, product.name, qty, product.uom, unitPrice, discount, lineTotal);
      db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?').run(qty, product.id);
    }
    if (subtotal === 0) throw new Error('Order has no valid lines');
    const vat = round2(subtotal * VAT_RATE);
    db.prepare('UPDATE orders SET subtotal = ?, vat_amount = ?, total = ? WHERE id = ?')
      .run(round2(subtotal), vat, round2(subtotal + vat), orderId);
    return orderId;
  });

  try {
    const orderId = create();
    logActivity(user.id, 'create', 'order', orderId, { customer: customer.name });
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    // Submitted orders are emailed to the orders department for SYSPRO capture,
    // and the customer gets a confirmation copy.
    if (order.status === 'submitted' && getSetting('email_auto_send', '1') === '1') {
      sendEmail(buildOrderEmail(orderId)).catch((e) => console.error('Order email failed:', e.message));
      if (getSetting('email_confirm_customer', '1') === '1') {
        sendEmail(buildOrderConfirmationEmail(orderId)).catch((e) => console.error('Confirmation email failed:', e.message));
      }
    }
    res.json(order);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

router.post('/orders', (req, res) => createOrder(req.user, req.body || {}, res));

const STATUS_FLOW = ['draft', 'submitted', 'processing', 'invoiced', 'cancelled'];

router.put('/orders/:id/status', (req, res) => {
  const status = req.body?.status;
  if (!STATUS_FLOW.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  logActivity(req.user.id, 'status_change', 'order', req.params.id, { from: order.status, to: status });
  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id));
});

// Repeat a previous order at today's effective prices.
router.post('/orders/:id/repeat', (req, res) => {
  const source = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Order not found' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(source.id)
    .map((i) => ({ product_id: i.product_id, qty: i.qty }));
  createOrder(req.user, { customer_id: source.customer_id, items, notes: `Repeat of ${source.number}` }, res);
});

export default router;

// Phase 5: customer self-service portal. Users with the 'customer' role are
// linked to one customer account (users.customer_id) and can browse the
// catalogue at their prices, place orders, track orders and accept quotes.
import { Router } from 'express';
import { db, nextNumber, logActivity, effectivePrice, priceBreaks, VAT_RATE, getSetting } from '../db.js';
import { buildOrderEmail, buildOrderConfirmationEmail, sendEmail } from '../integration/email.js';

const router = Router();
const round2 = (n) => Math.round(n * 100) / 100;

// Everything under /portal requires a customer login.
router.use('/portal', (req, res, next) => {
  if (req.user.role_name !== 'customer' || !req.user.customer_id) {
    return res.status(403).json({ error: 'Customer portal access only' });
  }
  req.customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.user.customer_id);
  if (!req.customer) return res.status(403).json({ error: 'Customer account not found' });
  next();
});

router.get('/portal/me', (req, res) => {
  const c = req.customer;
  const stats = db.prepare(`
    SELECT COUNT(*) AS order_count, COALESCE(SUM(total), 0) AS sales_12m
    FROM orders WHERE customer_id = ? AND status != 'cancelled' AND order_date >= date('now', '-365 days')
  `).get(c.id);
  const rep = c.rep_id ? db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(c.rep_id) : null;
  res.json({
    id: c.id, code: c.code, name: c.name, address: c.address, city: c.city,
    payment_terms: c.payment_terms, credit_limit: c.credit_limit, balance: c.balance,
    status: c.status, rep, ...stats
  });
});

router.get('/portal/products', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, cat.name AS category_name,
      cp.price AS contract_price
    FROM products p
    LEFT JOIN product_categories cat ON cat.id = p.category_id
    LEFT JOIN customer_prices cp ON cp.product_id = p.id AND cp.customer_id = ?
    WHERE p.active = 1
    ORDER BY p.name
  `).all(req.customer.id);
  // Same price the order will be charged at: contract beats rules beats list.
  res.json(rows.map((p) => ({
    id: p.id, code: p.code, name: p.name, description: p.description, uom: p.uom,
    pack_size: p.pack_size, stock_qty: p.stock_qty, category_name: p.category_name,
    price: p.contract_price != null ? p.contract_price : priceBreaks(p)[0].price,
    has_contract_price: p.contract_price != null ? 1 : 0
  })));
});

router.get('/portal/orders', (req, res) => {
  const rows = db.prepare(`
    SELECT o.id, o.number, o.status, o.order_date, o.subtotal, o.vat_amount, o.total, o.notes
    FROM orders o WHERE o.customer_id = ? ORDER BY o.order_date DESC LIMIT 100
  `).all(req.customer.id);
  res.json(rows);
});

router.get('/portal/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND customer_id = ?').get(req.params.id, req.customer.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  res.json(order);
});

// Self-service ordering - same engine as rep orders, attributed to the
// customer's assigned rep, and emailed to the orders department as usual.
router.post('/portal/orders', (req, res) => {
  const b = req.body || {};
  const c = req.customer;
  if (c.status === 'on_hold') return res.status(400).json({ error: 'Your account is on hold — please contact us before ordering' });
  if (!Array.isArray(b.items) || b.items.length === 0) return res.status(400).json({ error: 'Your basket is empty' });

  const create = db.transaction(() => {
    const number = nextNumber('ORD');
    const info = db.prepare(`
      INSERT INTO orders (number, customer_id, rep_id, status, notes, delivery_instructions)
      VALUES (?, ?, ?, 'submitted', ?, ?)
    `).run(number, c.id, c.rep_id || null,
      b.notes ? `Portal order: ${b.notes}` : 'Placed via customer portal', b.delivery_instructions || null);
    const orderId = info.lastInsertRowid;
    let subtotal = 0;
    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, qty, uom, unit_price, discount_pct, line_total)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `);
    for (const item of b.items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(item.product_id);
      const qty = Number(item.qty) || 0;
      if (!product || qty <= 0) continue;
      const unitPrice = effectivePrice(c.id, product.id, qty);
      const lineTotal = round2(qty * unitPrice);
      subtotal += lineTotal;
      insertItem.run(orderId, product.id, product.name, qty, product.uom, unitPrice, lineTotal);
      db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?').run(qty, product.id);
    }
    if (subtotal === 0) throw new Error('Your basket is empty');
    const vat = round2(subtotal * VAT_RATE);
    db.prepare('UPDATE orders SET subtotal = ?, vat_amount = ?, total = ? WHERE id = ?')
      .run(round2(subtotal), vat, round2(subtotal + vat), orderId);
    return orderId;
  });

  try {
    const orderId = create();
    logActivity(req.user.id, 'portal_order', 'order', orderId, { customer: c.name });
    if (getSetting('email_auto_send', '1') === '1') {
      sendEmail(buildOrderEmail(orderId)).catch((e) => console.error('Order email failed:', e.message));
      if (getSetting('email_confirm_customer', '1') === '1') {
        sendEmail(buildOrderConfirmationEmail(orderId)).catch((e) => console.error('Confirmation email failed:', e.message));
      }
    }
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    res.json(order);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/portal/quotes', (req, res) => {
  res.json(db.prepare(`
    SELECT q.id, q.number, q.status, q.quote_date, q.valid_until, q.total, q.order_id
    FROM quotes q WHERE q.customer_id = ? ORDER BY q.quote_date DESC LIMIT 50
  `).all(req.customer.id));
});

router.get('/portal/quotes/:id', (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ? AND customer_id = ?').get(req.params.id, req.customer.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  quote.items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quote.id);
  res.json(quote);
});

// Customer accepts a quote -> becomes an order at the quoted prices.
router.post('/portal/quotes/:id/accept', (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ? AND customer_id = ?').get(req.params.id, req.customer.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  if (quote.order_id) return res.status(400).json({ error: 'Quote already converted' });
  if (quote.status !== 'sent') return res.status(400).json({ error: `Quote is ${quote.status}` });
  if (req.customer.status === 'on_hold') return res.status(400).json({ error: 'Your account is on hold — please contact us' });

  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quote.id);
  const convert = db.transaction(() => {
    const number = nextNumber('ORD');
    const info = db.prepare(`
      INSERT INTO orders (number, customer_id, rep_id, visit_id, status, subtotal, vat_amount, total, notes)
      VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, ?)
    `).run(number, quote.customer_id, quote.rep_id, quote.visit_id, quote.subtotal, quote.vat_amount, quote.total,
      `Accepted via portal from quote ${quote.number}`);
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
  logActivity(req.user.id, 'portal_accept', 'quote', quote.id, { order_id: orderId });
  if (getSetting('email_auto_send', '1') === '1') {
    sendEmail(buildOrderEmail(orderId)).catch((e) => console.error('Order email failed:', e.message));
    if (getSetting('email_confirm_customer', '1') === '1') {
      sendEmail(buildOrderConfirmationEmail(orderId)).catch((e) => console.error('Confirmation email failed:', e.message));
    }
  }
  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
});

export default router;

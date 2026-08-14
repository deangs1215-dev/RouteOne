import { Router } from 'express';
import { db, nextNumber, logActivity, effectivePrice, adjustOrderStock, VAT_RATE, getSetting } from '../db.js';
import { scopeForUser, requireRole, userCanAccessCustomer } from '../auth.js';
import { buildOrderEmail, buildOrderConfirmationEmail, sendEmail, wrap, esc, companyDetails } from '../integration/email.js';
import { buildDocumentPdf } from '../integration/pdf.js';

const router = Router();

const round2 = (n) => Math.round(n * 100) / 100;
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

const fmtR = (n) => 'R ' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function docTable(items, doc) {
  const rows = items.map((i) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${esc(i.product_name)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:center">${i.qty} ${i.uom || ''}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${fmtR(i.unit_price)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${fmtR(i.line_total)}</td>
    </tr>`).join('');
  return `
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <tr style="background:#f1f5f9">
        <th style="padding:6px 10px;text-align:left">Product</th>
        <th style="padding:6px 10px;text-align:center">Qty</th>
        <th style="padding:6px 10px;text-align:right">Unit price</th>
        <th style="padding:6px 10px;text-align:right">Total</th>
      </tr>
      ${rows}
      <tr><td colspan="3" style="padding:6px 10px;text-align:right;color:#64748b">Subtotal</td><td style="padding:6px 10px;text-align:right">${fmtR(doc.subtotal)}</td></tr>
      <tr><td colspan="3" style="padding:6px 10px;text-align:right;color:#64748b">VAT (${VAT_RATE * 100}%)</td><td style="padding:6px 10px;text-align:right">${fmtR(doc.vat_amount)}</td></tr>
      <tr><td colspan="3" style="padding:6px 10px;text-align:right;font-weight:bold">Total</td><td style="padding:6px 10px;text-align:right;font-weight:bold">${fmtR(doc.total)}</td></tr>
    </table>`;
}

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
      w.code AS warehouse_code, w.name AS warehouse_name,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS line_count
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = o.rep_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY o.order_date DESC
    LIMIT 300
  `).all(...params);
  res.json(rows);
});

router.get('/orders/:id', (req, res) => {
  const order = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.code AS customer_code, c.address, c.city,
      c.payment_terms, u.name AS rep_name,
      w.code AS warehouse_code, w.name AS warehouse_name
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = o.rep_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    WHERE o.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (scopeForUser(req.user).isRep && order.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your order' });
  }
  // Flag lines where current stock is negative - i.e. this order over-committed.
  order.items = db.prepare(`
    SELECT i.*, p.stock_qty AS current_stock
    FROM order_items i JOIN products p ON p.id = i.product_id
    WHERE i.order_id = ?
  `).all(order.id).map((i) => ({ ...i, backorder: i.current_stock < 0 ? 1 : 0 }));
  res.json(order);
});

// Downloadable order confirmation PDF - same layout as the email attachment.
router.get('/orders/:id/pdf', async (req, res) => {
  const order = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.code AS customer_code, c.contact_name, c.address, c.city
    FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (scopeForUser(req.user).isRep && order.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your order' });
  }
  const items = db.prepare(`
    SELECT i.*, p.pack_weight_kg FROM order_items i
    LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = ?
  `).all(order.id);
  try {
    const pdf = await buildDocumentPdf({ type: 'order', doc: order, items, company: companyDetails() });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Order-${order.number}.pdf"`);
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: 'Could not generate PDF' });
  }
});

// Create an order with lines. Prices default to the customer's effective price
// unless explicitly overridden.
function createOrder(user, b, res) {
  if (!b.customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 200) {
    return res.status(400).json({ error: 'An order requires between 1 and 200 lines' });
  }

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(b.customer_id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (!userCanAccessCustomer(user, customer.id)) {
    return res.status(403).json({ error: 'Not your customer' });
  }
  if (customer.status === 'on_hold') return res.status(400).json({ error: 'Customer account is on hold - order blocked' });
  if (b.visit_id) {
    const visit = db.prepare('SELECT rep_id, customer_id FROM visits WHERE id = ?').get(b.visit_id);
    if (!visit || visit.customer_id !== customer.id || (scopeForUser(user).isRep && visit.rep_id !== user.id)) {
      return res.status(400).json({ error: 'Visit does not belong to this customer and rep' });
    }
  }

  const create = db.transaction(() => {
    const number = nextNumber('ORD');
    const info = db.prepare(`
      INSERT INTO orders (number, customer_id, rep_id, visit_id, warehouse_id, status, notes, delivery_instructions, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(number, b.customer_id, user.id, b.visit_id || null, customer.warehouse_id || null,
      b.status === 'draft' ? 'draft' : 'submitted', b.notes || null, b.delivery_instructions || null, b.signature || null);
    const orderId = info.lastInsertRowid;

    let subtotal = 0;
    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, qty, uom, unit_price, discount_pct, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of b.items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(item.product_id);
      if (!product) throw new Error(`Product ${item.product_id} not found`);
      const qty = Number(item.qty);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 1000000) throw new Error('Invalid order quantity');
      // Qty-aware pricing: quantity breaks from price rules apply per line.
      const requestedPrice = Number(item.unit_price);
      const unitPrice = !scopeForUser(user).isRep && item.unit_price != null
        ? requestedPrice
        : effectivePrice(b.customer_id, product.id, qty);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('Invalid unit price');
      const discount = scopeForUser(user).isRep
        ? 0
        : (item.discount_pct == null ? 0 : Number(item.discount_pct));
      if (!Number.isFinite(discount) || discount < 0 || discount > 100) throw new Error('Invalid discount');
      const lineTotal = round2(qty * unitPrice * (1 - discount / 100));
      subtotal += lineTotal;
      insertItem.run(orderId, product.id, product.name, qty, product.uom, unitPrice, discount, lineTotal);
    }
    if (subtotal === 0) throw new Error('Order has no valid lines');
    const vat = round2(subtotal * VAT_RATE);
    db.prepare('UPDATE orders SET subtotal = ?, vat_amount = ?, total = ? WHERE id = ?')
      .run(round2(subtotal), vat, round2(subtotal + vat), orderId);
    if (b.status !== 'draft') adjustOrderStock(orderId, -1);
    return orderId;
  });

  try {
    const orderId = create();
    logActivity(user.id, 'create', 'order', orderId, { customer: customer.name });
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    // Submitted orders can be emailed to the customer, the rep, an ad-hoc
    // address, and/or configured recipients - whichever the rep ticked on the
    // capture screen. The whole email block is best-effort: the order is
    // already committed, so an email problem must never turn the response
    // into an error.
    try {
      if (order.status === 'submitted' && getSetting('email_auto_send', '1') === '1') {
        // Customer confirmation is opt-in - nothing sends unless the rep
        // explicitly ticks the box on the capture screen.
        if (b.send_to_customer === true && getSetting('email_confirm_customer', '1') === '1') {
          const confirmDraft = buildOrderConfirmationEmail(orderId);
          if (b.send_to_rep !== true) confirmDraft.cc_addr = null;
          sendEmail(confirmDraft).catch((e) => console.error('Confirmation email failed:', e.message));
        }
        // Extra ad-hoc recipient the rep typed in on the capture screen.
        if (isEmail(b.extra_email)) {
          sendEmail({ ...buildOrderEmail(orderId), cc_addr: null, to_addr: b.extra_email.trim() })
            .catch((e) => console.error('Extra recipient email failed:', e.message));
        }
        // Configured recipients the rep ticked on the capture screen (unticked by
        // default). Integers only, capped, so a bad payload can't blow up the SQL.
        const recipientIds = (Array.isArray(b.recipient_ids) ? b.recipient_ids : [])
          .filter((n) => Number.isInteger(n)).slice(0, 50);
        if (recipientIds.length) {
          const recipients = db.prepare(
            `SELECT email FROM email_recipients WHERE id IN (${recipientIds.map(() => '?').join(',')})`
          ).all(...recipientIds);
          for (const r of recipients) {
            sendEmail({ ...buildOrderEmail(orderId), cc_addr: null, to_addr: r.email })
              .catch((e) => console.error('Recipient email failed:', e.message));
          }
        }
      }
    } catch (e) {
      console.error('Order email dispatch failed:', e.message);
    }
    res.json(order);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

router.post('/orders', (req, res) => createOrder(req.user, req.body || {}, res));

const STATUS_FLOW = ['draft', 'submitted', 'processing', 'invoiced', 'cancelled'];

router.put('/orders/:id/status', requireRole('admin', 'manager', 'office'), (req, res) => {
  const status = req.body?.status;
  if (!STATUS_FLOW.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  db.transaction(() => {
    const heldBefore = !['draft', 'cancelled'].includes(order.status);
    const heldAfter = !['draft', 'cancelled'].includes(status);
    if (heldBefore !== heldAfter) adjustOrderStock(order.id, heldAfter ? -1 : 1);
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
  })();
  logActivity(req.user.id, 'status_change', 'order', req.params.id, { from: order.status, to: status });
  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id));
});

// Repeat a previous order at today's effective prices.
router.post('/orders/:id/repeat', (req, res) => {
  const source = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Order not found' });
  if (scopeForUser(req.user).isRep && source.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your order' });
  }
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(source.id)
    .map((i) => ({ product_id: i.product_id, qty: i.qty }));
  createOrder(req.user, { customer_id: source.customer_id, items, notes: `Repeat of ${source.number}` }, res);
});

// Send an order to selected recipients (admin/manager only).
router.post('/orders/:id/send-email', requireRole('admin', 'manager'), async (req, res) => {
  const { recipients = [], send_to_rep, send_to_customer } = req.body || {};
  const order = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.email AS customer_email,
      u.name AS rep_name, u.email AS rep_email
    FROM orders o JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = o.rep_id WHERE o.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  const emailsToSend = [];

  // Send to configured recipients (empty selection = none, not a SQL error)
  const allRecipients = Array.isArray(recipients) && recipients.length
    ? db.prepare('SELECT * FROM email_recipients WHERE id IN (' + recipients.map(() => '?').join(',') + ')').all(...recipients)
    : [];

  for (const recip of allRecipients) {
    const inner = `
      <p>Please find the sales order below for your records.</p>
      <table style="font-size:14px;margin-bottom:14px">
        <tr><td style="color:#64748b;padding:2px 12px 2px 0">Order no</td><td><b>${order.number}</b></td></tr>
        <tr><td style="color:#64748b;padding:2px 12px 2px 0">Customer</td><td>${esc(order.customer_name)}</td></tr>
        <tr><td style="color:#64748b;padding:2px 12px 2px 0">Amount</td><td><b>${fmtR(order.total)}</b></td></tr>
        <tr><td style="color:#64748b;padding:2px 12px 2px 0">Date</td><td>${order.order_date}</td></tr>
      </table>
      ${docTable(items, order)}`;

    emailsToSend.push({
      kind: 'order',
      ref_id: order.id,
      to_addr: recip.email,
      cc_addr: null,
      subject: `Sales order ${order.number} — ${order.customer_name} — ${fmtR(order.total)}`,
      body_html: wrap(`Order ${order.number}`, inner)
    });
  }

  // Send to rep
  if (send_to_rep && order.rep_email) {
    emailsToSend.push({
      kind: 'order',
      ref_id: order.id,
      to_addr: order.rep_email,
      cc_addr: null,
      subject: `Order confirmation: ${order.number} — ${order.customer_name}`,
      body_html: wrap('Order confirmation', `<p>Your order <b>${order.number}</b> for <b>${esc(order.customer_name)}</b> has been confirmed.</p>${docTable(items, order)}`)
    });
  }

  // Send to customer
  if (send_to_customer && order.customer_email) {
    emailsToSend.push(buildOrderConfirmationEmail(order.id));
  }

  // Send all emails in parallel
  await Promise.allSettled(emailsToSend.map((draft) => sendEmail(draft)));
  res.json({ ok: true, sent: emailsToSend.length });
});

export default router;

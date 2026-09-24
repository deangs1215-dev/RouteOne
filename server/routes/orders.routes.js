import { Router } from 'express';
import { dbx, PRICE_SOURCES, VAT_RATE, round2 } from '../db.js';
import { nextNumber, logActivity, effectivePrice, effectivePriceSource, adjustOrderStock, getSetting } from '../dbh.js';
import { scopeForUser, requireRole, userCanAccessCustomerAsync } from '../auth.js';
import { buildOrderEmail, buildOrderConfirmationEmail, sendEmail, wrap, esc, companyDetails, docTable, customerBlockHtml, notesHtml } from '../integration/email.js';
import { loadDoc } from '../integration/docData.js';
import { buildDocumentPdf } from '../integration/pdf.js';

const router = Router();

// round2 imported from db.js - see its comment for why (R1-028 floating-point fix).
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

const fmtR = (n) => 'R ' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

router.get('/orders', async (req, res) => {
  const { q, status, customer_id, rep_id } = req.query;
  const scope = scopeForUser(req.user);
  const where = [];
  const params = [];
  if (scope.isRep) { where.push('o.rep_id = ?'); params.push(req.user.id); }
  else if (rep_id) { where.push('o.rep_id = ?'); params.push(rep_id); }
  // Customers phone in quoting their own PO number, so search matches it too.
  if (q) { where.push('(o.number LIKE ? OR c.name LIKE ? OR o.customer_order_no LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (customer_id) { where.push('o.customer_id = ?'); params.push(customer_id); }
  const rows = await dbx.prepare(`
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

router.get('/orders/:id', async (req, res) => {
  const order = await dbx.prepare(`
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
  order.items = (await dbx.prepare(`
    SELECT i.*, p.stock_qty AS current_stock
    FROM order_items i JOIN products p ON p.id = i.product_id
    WHERE i.order_id = ?
  `).all(order.id)).map((i) => ({ ...i, backorder: i.current_stock < 0 ? 1 : 0 }));
  res.json(order);
});

// Downloadable order confirmation PDF - same layout as the email attachment.
router.get('/orders/:id/pdf', async (req, res) => {
  const order = loadDoc('order', req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (scopeForUser(req.user).isRep && order.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your order' });
  }
  const items = await dbx.prepare(`
    SELECT i.*, p.pack_weight_kg, p.conv_factor_alt_uom, p.code AS product_code FROM order_items i
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
async function createOrder(user, b, res) {
  if (!b.customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 200) {
    return res.status(400).json({ error: 'An order requires between 1 and 200 lines' });
  }

  const customer = await dbx.prepare('SELECT * FROM customers WHERE id = ?').get(b.customer_id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (!await userCanAccessCustomerAsync(user, customer.id)) {
    return res.status(403).json({ error: 'Not your customer' });
  }
  if (customer.status === 'on_hold') return res.status(400).json({ error: 'Customer account is on hold - order blocked' });
  if (b.visit_id) {
    const visit = await dbx.prepare('SELECT rep_id, customer_id FROM visits WHERE id = ?').get(b.visit_id);
    if (!visit || visit.customer_id !== customer.id || (scopeForUser(user).isRep && visit.rep_id !== user.id)) {
      return res.status(400).json({ error: 'Visit does not belong to this customer and rep' });
    }
  }

  // The customer's own order number / reference. Trimmed and length-capped; it
  // is printed on the confirmation and reconciled against by the customer, so
  // it is stored in its own column rather than inside notes.
  const customerOrderNo = String(b.customer_order_no ?? '').trim().slice(0, 100) || null;

  const create = () => dbx.transaction(async (tx) => {
    const number = await nextNumber('ORD', tx);
    const info = await tx.prepare(`
      INSERT INTO orders (number, customer_id, rep_id, visit_id, warehouse_id, status, customer_order_no, notes, delivery_instructions, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(number, b.customer_id, user.id, b.visit_id || null, customer.warehouse_id || null,
      b.status === 'draft' ? 'draft' : 'submitted', customerOrderNo, b.notes || null, b.delivery_instructions || null, b.signature || null);
    const orderId = info.lastInsertRowid;

    let subtotal = 0;
    const insertItem = tx.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, qty, uom, unit_price, discount_pct, line_total, price_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of b.items) {
      // Fetched without the active filter so a blocked line can say WHY it was
      // rejected - a discontinued product may already sit in a saved draft or an
      // offline cart from before it was flagged. The guard below is exactly as
      // strict as the old "AND active = 1"; only the message improved.
      const product = await tx.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      if (!product) throw new Error(`Product ${item.product_id} not found`);
      if (!product.active) {
        throw new Error(product.discontinued
          ? `${product.name} has been discontinued and can no longer be ordered`
          : `${product.name} is not available for ordering`);
      }
      const qty = Number(item.qty);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 1000000) throw new Error('Invalid order quantity');
      // Qty-aware pricing: quantity breaks from price rules apply per line.
      const requestedPrice = Number(item.unit_price);
      const officeOverrode = !scopeForUser(user).isRep && item.unit_price != null;
      const unitPrice = officeOverrode ? requestedPrice : await effectivePrice(b.customer_id, product.id, qty, tx);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('Invalid unit price');
      // R1-016: SYSPRO has no price at all for this product (list_price and
      // every pricing tier are 0/null) - block the line the same way a
      // discontinued product is blocked, so a rep can't submit a free order.
      // Office can still override with a manually-typed price.
      if (!officeOverrode && unitPrice === 0) {
        throw new Error(`${product.name} has no price set in SYSPRO and cannot be ordered`);
      }
      const discount = scopeForUser(user).isRep
        ? 0
        : (item.discount_pct == null ? 0 : Number(item.discount_pct));
      if (!Number.isFinite(discount) || discount < 0 || discount > 100) throw new Error('Invalid discount');
      const lineTotal = round2(qty * unitPrice * (1 - discount / 100));
      subtotal += lineTotal;
      // R1-044: an explicit office-entered price is always a manual override,
      // regardless of what tier it happens to match numerically - otherwise
      // it's whichever tier await effectivePrice() actually used for this line.
      const priceSource = officeOverrode ? PRICE_SOURCES.MANUAL_OVERRIDE : await effectivePriceSource(b.customer_id, product.id, qty, tx);
      await insertItem.run(orderId, product.id, product.name, qty, product.uom, unitPrice, discount, lineTotal, priceSource);
    }
    if (subtotal === 0) throw new Error('Order has no valid lines');
    const vat = round2(subtotal * VAT_RATE);
    await tx.prepare('UPDATE orders SET subtotal = ?, vat_amount = ?, total = ? WHERE id = ?')
      .run(round2(subtotal), vat, round2(subtotal + vat), orderId);
    if (b.status !== 'draft') await adjustOrderStock(orderId, -1, tx);
    return orderId;
  });

  try {
    const orderId = await create();
    await logActivity(user.id, 'create', 'order', orderId, { customer: customer.name });
    const order = await dbx.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    order.items = await dbx.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    // Submitted orders can be emailed to the customer, the rep, an ad-hoc
    // address, and/or configured recipients - whichever the rep ticked on the
    // capture screen. The whole email block is best-effort: the order is
    // already committed, so an email problem must never turn the response
    // into an error.
    try {
      if (order.status === 'submitted' && await getSetting('email_auto_send', '1') === '1') {
        // Customer confirmation is opt-in - nothing sends unless the rep
        // explicitly ticks the box on the capture screen.
        if (b.send_to_customer === true && await getSetting('email_confirm_customer', '1') === '1') {
          const confirmDraft = buildOrderConfirmationEmail(orderId);
          if (b.send_to_rep !== true) confirmDraft.cc_addr = null;
          sendEmail(confirmDraft).catch((e) => console.error('Confirmation email failed:', e.message));
        } else if (b.send_to_rep === true) {
          // R1: "Send a copy to me" was only ever honoured as a CC on the
          // customer email above - if the rep didn't also tick "Customer" (or
          // the customer has no email, or customer confirmations are switched
          // off), ticking this box silently did nothing. Send the rep their
          // own copy directly in that case, not as a CC.
          const repDraft = buildOrderConfirmationEmail(orderId);
          if (repDraft.cc_addr) {
            sendEmail({ ...repDraft, cc_addr: null, to_addr: repDraft.cc_addr })
              .catch((e) => console.error('Rep copy email failed:', e.message));
          }
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
          // Branch-scoped: only a recipient set up for this order's own
          // warehouse (or "every branch") is honoured, even if the client
          // somehow sent an id outside that - the capture screen only ever
          // offers the right list, this is the server-side backstop.
          const recipients = await dbx.prepare(`
            SELECT email FROM email_recipients
            WHERE id IN (${recipientIds.map(() => '?').join(',')})
              AND (warehouse_id = ? OR warehouse_id IS NULL)
          `).all(...recipientIds, order.warehouse_id);
          for (const r of recipients) {
            sendEmail({ ...buildOrderEmail(orderId), cc_addr: null, to_addr: r.email })
              .catch((e) => console.error('Recipient email failed:', e.message));
          }
        }
        // The rep's own saved "add another email address" contacts. Scoped to
        // user.id in the query itself, not just the UI - a rep can never send
        // via a contact id that isn't theirs, even by hand-crafting a request.
        const personalIds = (Array.isArray(b.personal_recipient_ids) ? b.personal_recipient_ids : [])
          .filter((n) => Number.isInteger(n)).slice(0, 50);
        if (personalIds.length) {
          const contacts = await dbx.prepare(`
            SELECT email FROM rep_email_contacts
            WHERE id IN (${personalIds.map(() => '?').join(',')}) AND user_id = ?
          `).all(...personalIds, user.id);
          for (const c of contacts) {
            sendEmail({ ...buildOrderEmail(orderId), cc_addr: null, to_addr: c.email })
              .catch((e) => console.error('Personal contact email failed:', e.message));
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

router.post('/orders', async (req, res) => { await createOrder(req.user, req.body || {}, res); });

const STATUS_FLOW = ['draft', 'submitted', 'processing', 'invoiced', 'cancelled'];

router.put('/orders/:id/status', requireRole('admin', 'manager', 'office'), async (req, res) => {
  const status = req.body?.status;
  if (!STATUS_FLOW.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const order = await dbx.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  await dbx.transaction(async (tx) => {
    const heldBefore = !['draft', 'cancelled'].includes(order.status);
    const heldAfter = !['draft', 'cancelled'].includes(status);
    if (heldBefore !== heldAfter) await adjustOrderStock(order.id, heldAfter ? -1 : 1, tx);
    await tx.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
  });
  await logActivity(req.user.id, 'status_change', 'order', req.params.id, { from: order.status, to: status });
  res.json(await dbx.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id));
});

// Repeat a previous order at today's effective prices.
router.post('/orders/:id/repeat', async (req, res) => {
  const source = await dbx.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Order not found' });
  if (scopeForUser(req.user).isRep && source.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your order' });
  }
  const items = (await dbx.prepare('SELECT * FROM order_items WHERE order_id = ?').all(source.id))
    .map((i) => ({ product_id: i.product_id, qty: i.qty }));
  await createOrder(req.user, { customer_id: source.customer_id, items, notes: `Repeat of ${source.number}` }, res);
});

// Send an order to selected recipients (admin/manager only).
router.post('/orders/:id/send-email', requireRole('admin', 'manager'), async (req, res) => {
  const { recipients = [], send_to_rep, send_to_customer } = req.body || {};
  const order = loadDoc('order', req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const items = await dbx.prepare(`
    SELECT i.*, p.pack_weight_kg, p.conv_factor_alt_uom, p.code AS product_code FROM order_items i
    LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = ? ORDER BY i.id
  `).all(order.id);
  const emailsToSend = [];

  // Send to configured recipients (empty selection = none, not a SQL error).
  // Branch-scoped the same way as the auto-send path in createOrder above.
  const allRecipients = Array.isArray(recipients) && recipients.length
    ? await dbx.prepare(`
        SELECT * FROM email_recipients
        WHERE id IN (${recipients.map(() => '?').join(',')}) AND (warehouse_id = ? OR warehouse_id IS NULL)
      `).all(...recipients, order.warehouse_id)
    : [];

  for (const recip of allRecipients) {
    const inner = `
      <p>Please find the sales order below for your records.</p>
      <table style="font-size:14px;margin-bottom:14px">
        <tr><td style="color:#64748b;padding:2px 12px 2px 0">Order no</td><td><b>${order.number}</b></td></tr>
        <tr><td style="color:#64748b;padding:2px 12px 2px 0">Amount</td><td><b>${fmtR(order.total)}</b></td></tr>
        <tr><td style="color:#64748b;padding:2px 12px 2px 0">Date</td><td>${order.order_date}</td></tr>
      </table>
      ${notesHtml(order)}
      ${customerBlockHtml(order)}
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

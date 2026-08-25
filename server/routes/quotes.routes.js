import { Router } from 'express';
import { db, nextNumber, logActivity, effectivePrice, adjustOrderStock, VAT_RATE, getSetting } from '../db.js';
import { scopeForUser, requireRole, userCanAccessCustomer } from '../auth.js';
import { buildQuoteEmail, sendEmail, wrap, esc, companyDetails } from '../integration/email.js';
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
  if (scopeForUser(req.user).isRep && quote.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your quote' });
  }
  quote.items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quote.id);
  res.json(quote);
});

// Downloadable quotation PDF - same layout as the email attachment.
router.get('/quotes/:id/pdf', async (req, res) => {
  const quote = db.prepare(`
    SELECT qu.*, c.name AS customer_name, c.code AS customer_code, c.contact_name, c.address, c.city
    FROM quotes qu JOIN customers c ON c.id = qu.customer_id WHERE qu.id = ?
  `).get(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  if (scopeForUser(req.user).isRep && quote.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your quote' });
  }
  const items = db.prepare(`
    SELECT i.*, p.pack_weight_kg, p.conv_factor_alt_uom, p.code AS product_code FROM quote_items i
    LEFT JOIN products p ON p.id = i.product_id WHERE i.quote_id = ?
  `).all(quote.id);
  try {
    const pdf = await buildDocumentPdf({ type: 'quote', doc: quote, items, company: companyDetails() });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Quotation-${quote.number}.pdf"`);
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: 'Could not generate PDF' });
  }
});

// Create a quote with lines - same pricing engine as orders, but no stock
// movement and no credit block (a quote commits nothing).
router.post('/quotes', (req, res) => {
  const b = req.body || {};
  if (!b.customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 200) {
    return res.status(400).json({ error: 'A quote requires between 1 and 200 lines' });
  }
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(b.customer_id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (!userCanAccessCustomer(req.user, customer.id)) {
    return res.status(403).json({ error: 'Not your customer' });
  }
  if (b.visit_id) {
    const visit = db.prepare('SELECT rep_id, customer_id FROM visits WHERE id = ?').get(b.visit_id);
    if (!visit || visit.customer_id !== customer.id || (scopeForUser(req.user).isRep && visit.rep_id !== req.user.id)) {
      return res.status(400).json({ error: 'Visit does not belong to this customer and rep' });
    }
  }

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
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(item.product_id);
      if (!product) throw new Error(`Product ${item.product_id} not found`);
      const qty = Number(item.qty);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 1000000) throw new Error('Invalid quote quantity');
      const requestedPrice = Number(item.unit_price);
      const unitPrice = !scopeForUser(req.user).isRep && item.unit_price != null
        ? requestedPrice
        : effectivePrice(b.customer_id, product.id, qty);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('Invalid unit price');
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
    // Email the customer their quote, same on/off switch as order auto-send.
    // Best-effort: the quote is committed, so email problems never fail the response.
    try {
      if (getSetting('email_auto_send', '1') === '1') {
        // Opt-in - nothing sends to the customer unless the rep explicitly
        // ticks the box on the capture screen.
        if (customer.email && b.send_to_customer === true) {
          const draft = buildQuoteEmail(quoteId);
          if (b.send_to_rep !== true) draft.cc_addr = null;
          sendEmail(draft).catch((e) => console.error('Quote email failed:', e.message));
        }
        if (isEmail(b.extra_email)) {
          sendEmail({ ...buildQuoteEmail(quoteId), cc_addr: null, to_addr: b.extra_email.trim() })
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
            sendEmail({ ...buildQuoteEmail(quoteId), cc_addr: null, to_addr: r.email })
              .catch((e) => console.error('Recipient email failed:', e.message));
          }
        }
      }
    } catch (e) {
      console.error('Quote email dispatch failed:', e.message);
    }
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
  if (scopeForUser(req.user).isRep && quote.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your quote' });
  }
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
  if (scopeForUser(req.user).isRep && quote.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your quote' });
  }
  if (quote.order_id) return res.status(400).json({ error: 'Quote already converted' });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id);
  if (customer.status === 'on_hold') return res.status(400).json({ error: 'Customer account is on hold - order blocked' });
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quote.id);

  const convert = db.transaction(() => {
    const number = nextNumber('ORD');
    const info = db.prepare(`
      INSERT INTO orders (number, customer_id, rep_id, visit_id, warehouse_id, status, subtotal, vat_amount, total, notes)
      VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?)
    `).run(number, quote.customer_id, req.user.id, quote.visit_id, customer.warehouse_id || null, quote.subtotal, quote.vat_amount, quote.total,
      `Converted from quote ${quote.number}`);
    const orderId = info.lastInsertRowid;
    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, qty, uom, unit_price, discount_pct, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const i of items) {
      insertItem.run(orderId, i.product_id, i.product_name, i.qty, i.uom, i.unit_price, i.discount_pct, i.line_total);
    }
    adjustOrderStock(orderId, -1);
    db.prepare("UPDATE quotes SET status = 'accepted', order_id = ? WHERE id = ?").run(orderId, quote.id);
    return orderId;
  });

  const orderId = convert();
  logActivity(req.user.id, 'convert', 'quote', quote.id, { order_id: orderId });
  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
});

// Send a quote to selected recipients (admin/manager only).
router.post('/quotes/:id/send-email', requireRole('admin', 'manager'), async (req, res) => {
  const { recipients = [], send_to_rep, send_to_customer } = req.body || {};
  const quote = db.prepare(`
    SELECT q.*, c.name AS customer_name, c.email AS customer_email,
      u.name AS rep_name, u.email AS rep_email
    FROM quotes q JOIN customers c ON c.id = q.customer_id
    LEFT JOIN users u ON u.id = q.rep_id WHERE q.id = ?
  `).get(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });

  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quote.id);
  const emailsToSend = [];

  // Send to configured recipients (empty selection = none, not a SQL error)
  const allRecipients = Array.isArray(recipients) && recipients.length
    ? db.prepare('SELECT * FROM email_recipients WHERE id IN (' + recipients.map(() => '?').join(',') + ')').all(...recipients)
    : [];

  for (const recip of allRecipients) {
    const inner = `
      <p>Please find the quotation below for your records.</p>
      <table style="font-size:14px;margin-bottom:14px">
        <tr><td style="color:#64748b;padding:2px 12px 2px 0">Quote no</td><td><b>${quote.number}</b></td></tr>
        <tr><td style="color:#64748b;padding:2px 12px 2px 0">Customer</td><td>${esc(quote.customer_name)}</td></tr>
        <tr><td style="color:#64748b;padding:2px 12px 2px 0">Amount</td><td><b>${fmtR(quote.total)}</b></td></tr>
        <tr><td style="color:#64748b;padding:2px 12px 2px 0">Valid until</td><td>${quote.valid_until || ''}</td></tr>
      </table>
      ${docTable(items, quote)}`;

    emailsToSend.push({
      kind: 'quote',
      ref_id: quote.id,
      to_addr: recip.email,
      cc_addr: null,
      subject: `Quotation ${quote.number} — ${quote.customer_name} — ${fmtR(quote.total)}`,
      body_html: wrap(`Quote ${quote.number}`, inner)
    });
  }

  // Send to rep
  if (send_to_rep && quote.rep_email) {
    emailsToSend.push({
      kind: 'quote',
      ref_id: quote.id,
      to_addr: quote.rep_email,
      cc_addr: null,
      subject: `Quote confirmation: ${quote.number} — ${quote.customer_name}`,
      body_html: wrap('Quote confirmation', `<p>Your quote <b>${quote.number}</b> for <b>${esc(quote.customer_name)}</b> has been sent.</p>${docTable(items, quote)}`)
    });
  }

  // Send to customer
  if (send_to_customer && quote.customer_email) {
    emailsToSend.push(buildQuoteEmail(quote.id));
  }

  // Send all emails in parallel
  await Promise.allSettled(emailsToSend.map((draft) => sendEmail(draft)));
  res.json({ ok: true, sent: emailsToSend.length });
});

export default router;

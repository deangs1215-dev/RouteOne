import { Router } from 'express';
import { dbx, PRICE_SOURCES, VAT_RATE, round2 } from '../db.js';
import { nextNumber, logActivity, effectivePrice, effectivePriceSource, adjustOrderStock, getSetting } from '../dbh.js';
import { scopeForUser, requireRole, userCanAccessCustomerAsync } from '../auth.js';
import { buildQuoteEmail, sendEmail, wrap, esc, companyDetails, docTable, customerBlockHtml, notesHtml } from '../integration/email.js';
import { loadDoc } from '../integration/docData.js';
import { buildDocumentPdf } from '../integration/pdf.js';

const router = Router();
// round2 imported from db.js - see its comment for why (R1-028 floating-point fix).
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

const fmtR = (n) => 'R ' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

router.get('/quotes', async (req, res) => {
  const { q, status, customer_id } = req.query;
  const scope = scopeForUser(req.user);
  const where = [];
  const params = [];
  if (scope.isRep) { where.push('qu.rep_id = ?'); params.push(req.user.id); }
  if (q) { where.push('(qu.number LIKE ? OR c.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (status) { where.push('qu.status = ?'); params.push(status); }
  if (customer_id) { where.push('qu.customer_id = ?'); params.push(customer_id); }
  const rows = await dbx.prepare(`
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

router.get('/quotes/:id', async (req, res) => {
  const quote = await dbx.prepare(`
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
  quote.items = await dbx.prepare(`
    SELECT i.*, p.pack_weight_kg, p.conv_factor_alt_uom, p.code AS product_code FROM quote_items i
    LEFT JOIN products p ON p.id = i.product_id WHERE i.quote_id = ? ORDER BY i.id
  `).all(quote.id);
  res.json(quote);
});

// Downloadable quotation PDF - same layout as the email attachment.
router.get('/quotes/:id/pdf', async (req, res) => {
  const quote = loadDoc('quote', req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  if (scopeForUser(req.user).isRep && quote.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your quote' });
  }
  const items = await dbx.prepare(`
    SELECT i.*, p.pack_weight_kg, p.conv_factor_alt_uom, p.code AS product_code FROM quote_items i
    LEFT JOIN products p ON p.id = i.product_id WHERE i.quote_id = ? ORDER BY i.id
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
router.post('/quotes', async (req, res) => {
  const b = req.body || {};
  if (!b.customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 200) {
    return res.status(400).json({ error: 'A quote requires between 1 and 200 lines' });
  }
  const customer = await dbx.prepare('SELECT * FROM customers WHERE id = ?').get(b.customer_id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (!await userCanAccessCustomerAsync(req.user, customer.id)) {
    return res.status(403).json({ error: 'Not your customer' });
  }
  if (b.visit_id) {
    const visit = await dbx.prepare('SELECT rep_id, customer_id FROM visits WHERE id = ?').get(b.visit_id);
    if (!visit || visit.customer_id !== customer.id || (scopeForUser(req.user).isRep && visit.rep_id !== req.user.id)) {
      return res.status(400).json({ error: 'Visit does not belong to this customer and rep' });
    }
  }

  // R1-017: quotation lines are always produced sorted by product code, lowest
  // to highest - never by the order the rep tapped products in. Resolved and
  // sorted here, once, before anything is inserted, so quote_items rows land in
  // code order and every later read that trusts id/insertion order (the detail
  // page, PDF, and confirmation email - none of which JOIN products just to
  // re-derive an order) is correct with no further change.
  const codeById = new Map();
  for (const item of b.items || []) {
    if (!codeById.has(item.product_id)) {
      codeById.set(item.product_id, (await dbx.prepare('SELECT code FROM products WHERE id = ?').get(item.product_id))?.code || '');
    }
  }
  const sortedItems = [...(b.items || [])].sort((a, b2) =>
    codeById.get(a.product_id).localeCompare(codeById.get(b2.product_id), undefined, { numeric: true, sensitivity: 'base' }));

  const create = () => dbx.transaction(async (tx) => {
    const number = await nextNumber('QUO', tx);
    const validUntil = b.valid_until || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const info = await tx.prepare(`
      INSERT INTO quotes (number, customer_id, rep_id, visit_id, status, valid_until, notes)
      VALUES (?, ?, ?, ?, 'sent', ?, ?)
    `).run(number, b.customer_id, req.user.id, b.visit_id || null, validUntil, b.notes || null);
    const quoteId = info.lastInsertRowid;

    let subtotal = 0;
    const insertItem = tx.prepare(`
      INSERT INTO quote_items (quote_id, product_id, product_name, qty, uom, unit_price, discount_pct, line_total, price_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of sortedItems) {
      // See the matching comment in orders.routes.js - same guard, clearer message.
      const product = await tx.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      if (!product) throw new Error(`Product ${item.product_id} not found`);
      if (!product.active) {
        throw new Error(product.discontinued
          ? `${product.name} has been discontinued and can no longer be quoted`
          : `${product.name} is not available for quoting`);
      }
      const qty = Number(item.qty);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 1000000) throw new Error('Invalid quote quantity');
      const requestedPrice = Number(item.unit_price);
      const officeOverrode = !scopeForUser(req.user).isRep && item.unit_price != null;
      const unitPrice = officeOverrode ? requestedPrice : await effectivePrice(b.customer_id, product.id, qty, tx);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('Invalid unit price');
      // R1-016: see the matching guard in orders.routes.js - SYSPRO has no
      // price for this product, block it the same way a discontinued product
      // is blocked.
      if (!officeOverrode && unitPrice === 0) {
        throw new Error(`${product.name} has no price set in SYSPRO and cannot be quoted`);
      }
      const lineTotal = round2(qty * unitPrice);
      subtotal += lineTotal;
      const priceSource = officeOverrode ? PRICE_SOURCES.MANUAL_OVERRIDE : await effectivePriceSource(b.customer_id, product.id, qty, tx);
      await insertItem.run(quoteId, product.id, product.name, qty, product.uom, unitPrice, 0, lineTotal, priceSource);
    }
    if (subtotal === 0) throw new Error('Quote has no valid lines');
    const vat = round2(subtotal * VAT_RATE);
    await tx.prepare('UPDATE quotes SET subtotal = ?, vat_amount = ?, total = ? WHERE id = ?')
      .run(round2(subtotal), vat, round2(subtotal + vat), quoteId);
    return quoteId;
  });

  try {
    const quoteId = await create();
    await logActivity(req.user.id, 'create', 'quote', quoteId, { customer: customer.name });
    const quote = await dbx.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId);
    quote.items = await dbx.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id').all(quoteId);
    // Email the customer their quote, same on/off switch as order auto-send.
    // Best-effort: the quote is committed, so email problems never fail the response.
    try {
      if (await getSetting('email_auto_send', '1') === '1') {
        // Opt-in - nothing sends to the customer unless the rep explicitly
        // ticks the box on the capture screen.
        if (customer.email && b.send_to_customer === true) {
          const draft = buildQuoteEmail(quoteId);
          if (b.send_to_rep !== true) draft.cc_addr = null;
          sendEmail(draft).catch((e) => console.error('Quote email failed:', e.message));
        } else if (b.send_to_rep === true) {
          // See the matching fix in orders.routes.js - "Send a copy to me" was
          // only ever honoured as a CC on the customer email, so it silently
          // did nothing whenever the customer wasn't also being emailed.
          const repDraft = buildQuoteEmail(quoteId);
          if (repDraft.cc_addr) {
            sendEmail({ ...repDraft, cc_addr: null, to_addr: repDraft.cc_addr })
              .catch((e) => console.error('Rep copy email failed:', e.message));
          }
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
          // Branch-scoped to the customer's own warehouse (quotes have no
          // warehouse_id of their own - see the matching comment in
          // orders.routes.js for why this backstop exists at all).
          const recipients = await dbx.prepare(`
            SELECT email FROM email_recipients
            WHERE id IN (${recipientIds.map(() => '?').join(',')})
              AND (warehouse_id = ? OR warehouse_id IS NULL)
          `).all(...recipientIds, customer.warehouse_id);
          for (const r of recipients) {
            sendEmail({ ...buildQuoteEmail(quoteId), cc_addr: null, to_addr: r.email })
              .catch((e) => console.error('Recipient email failed:', e.message));
          }
        }
        // The rep's own saved contacts - see the matching block in
        // orders.routes.js for why the query itself, not just the UI, scopes
        // this to the sender's own rows.
        const personalIds = (Array.isArray(b.personal_recipient_ids) ? b.personal_recipient_ids : [])
          .filter((n) => Number.isInteger(n)).slice(0, 50);
        if (personalIds.length) {
          const contacts = await dbx.prepare(`
            SELECT email FROM rep_email_contacts
            WHERE id IN (${personalIds.map(() => '?').join(',')}) AND user_id = ?
          `).all(...personalIds, req.user.id);
          for (const c of contacts) {
            sendEmail({ ...buildQuoteEmail(quoteId), cc_addr: null, to_addr: c.email })
              .catch((e) => console.error('Personal contact email failed:', e.message));
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

router.put('/quotes/:id/status', async (req, res) => {
  const status = req.body?.status;
  if (!['draft', 'sent', 'accepted', 'rejected', 'expired'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const quote = await dbx.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  if (scopeForUser(req.user).isRep && quote.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your quote' });
  }
  if (quote.order_id) return res.status(400).json({ error: 'Quote already converted to an order' });
  await dbx.prepare('UPDATE quotes SET status = ? WHERE id = ?').run(status, req.params.id);
  await logActivity(req.user.id, 'status_change', 'quote', req.params.id, { from: quote.status, to: status });
  res.json(await dbx.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id));
});

// Convert an accepted quote into an order at the QUOTED prices (that's the
// point of a quote), moving stock like a normal order.
router.post('/quotes/:id/convert', async (req, res) => {
  const quote = await dbx.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  if (scopeForUser(req.user).isRep && quote.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your quote' });
  }
  if (quote.order_id) return res.status(400).json({ error: 'Quote already converted' });
  const customer = await dbx.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id);
  if (customer.status === 'on_hold') return res.status(400).json({ error: 'Customer account is on hold - order blocked' });
  const items = await dbx.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id').all(quote.id);

  // A quote can be converted long after it was written, so every line is
  // re-checked against the product's CURRENT state - the same guard order and
  // quote capture already apply. Copying quote_items straight across skipped
  // it entirely, which let an old quote resurrect a product SYSPRO has since
  // discontinued. Price is deliberately NOT re-derived: honouring the quoted
  // price is the whole point of converting a quote.
  for (const i of items) {
    const product = await dbx.prepare('SELECT name, active, discontinued FROM products WHERE id = ?').get(i.product_id);
    if (!product) {
      return res.status(400).json({ error: `${i.product_name} no longer exists and cannot be ordered` });
    }
    if (!product.active) {
      return res.status(400).json({
        error: product.discontinued
          ? `${product.name} has been discontinued and can no longer be ordered`
          : `${product.name} is not available for ordering`
      });
    }
  }

  const convert = () => dbx.transaction(async (tx) => {
    const number = await nextNumber('ORD', tx);
    const info = await tx.prepare(`
      INSERT INTO orders (number, customer_id, rep_id, visit_id, warehouse_id, status, subtotal, vat_amount, total, notes)
      VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?)
    `).run(number, quote.customer_id, req.user.id, quote.visit_id, customer.warehouse_id || null, quote.subtotal, quote.vat_amount, quote.total,
      `Converted from quote ${quote.number}`);
    const orderId = info.lastInsertRowid;
    const insertItem = tx.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, qty, uom, unit_price, discount_pct, line_total, price_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const i of items) {
      // Carries the quote line's own price_source across - the price itself
      // isn't recomputed here, so neither is what tier produced it.
      await insertItem.run(orderId, i.product_id, i.product_name, i.qty, i.uom, i.unit_price, i.discount_pct, i.line_total, i.price_source);
    }
    await adjustOrderStock(orderId, -1, tx);
    await tx.prepare("UPDATE quotes SET status = 'accepted', order_id = ? WHERE id = ?").run(orderId, quote.id);
    return orderId;
  });

  const orderId = await convert();
  await logActivity(req.user.id, 'convert', 'quote', quote.id, { order_id: orderId });
  res.json(await dbx.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
});

// Send a quote to selected recipients (admin/manager only).
router.post('/quotes/:id/send-email', requireRole('admin', 'manager'), async (req, res) => {
  const { recipients = [], send_to_rep, send_to_customer } = req.body || {};
  const quote = loadDoc('quote', req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });

  const items = await dbx.prepare(`
    SELECT i.*, p.pack_weight_kg, p.conv_factor_alt_uom, p.code AS product_code FROM quote_items i
    LEFT JOIN products p ON p.id = i.product_id WHERE i.quote_id = ? ORDER BY i.id
  `).all(quote.id);
  const emailsToSend = [];

  // Send to configured recipients (empty selection = none, not a SQL error).
  // Branch-scoped to the customer's own warehouse.
  const allRecipients = Array.isArray(recipients) && recipients.length
    ? await dbx.prepare(`
        SELECT * FROM email_recipients
        WHERE id IN (${recipients.map(() => '?').join(',')}) AND (warehouse_id = ? OR warehouse_id IS NULL)
      `).all(...recipients, quote.customer_warehouse_id)
    : [];

  for (const recip of allRecipients) {
    const inner = `
      <p>Please find the quotation below for your records.</p>
      <table style="font-size:14px;margin-bottom:14px">
        <tr><td style="color:#64748b;padding:2px 12px 2px 0">Quote no</td><td><b>${quote.number}</b></td></tr>
        <tr><td style="color:#64748b;padding:2px 12px 2px 0">Amount</td><td><b>${fmtR(quote.total)}</b></td></tr>
        <tr><td style="color:#64748b;padding:2px 12px 2px 0">Valid until</td><td>${quote.valid_until || ''}</td></tr>
      </table>
      ${notesHtml(quote)}
      ${customerBlockHtml(quote)}
      ${docTable(items, quote, 'quote')}`;

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
      body_html: wrap('Quote confirmation', `<p>Your quote <b>${quote.number}</b> for <b>${esc(quote.customer_name)}</b> has been sent.</p>${docTable(items, quote, 'quote')}`)
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

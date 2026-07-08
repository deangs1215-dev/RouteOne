// Outbound email: orders go to the orders department for capture into SYSPRO;
// quotes go to the customer. Every email is stored in email_log first - if
// SMTP isn't configured (or fails) it stays 'pending'/'failed' and can be
// previewed and resent from the Integration page.
import { db, getSetting, VAT_RATE } from '../db.js';
import { decryptSecret } from '../crypto.js';

function smtpConfig() {
  const host = getSetting('smtp_host', '');
  if (!host) return null;
  return {
    host,
    port: parseInt(getSetting('smtp_port', '587'), 10),
    secure: getSetting('smtp_secure', '0') === '1',
    auth: getSetting('smtp_user', '')
      ? { user: getSetting('smtp_user'), pass: decryptSecret(getSetting('smtp_password', '')) }
      : undefined
  };
}

const fmtR = (n) => 'R ' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function docTable(items, doc) {
  const rows = items.map((i) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${i.product_name}</td>
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

// Company letterhead details, entered once on the Integration page. Used by
// both the email header/footer and the attached PDF.
export function companyDetails() {
  return {
    name: getSetting('company_name', ''),
    reg: getSetting('company_reg', ''),
    vat: getSetting('company_vat', ''),
    address: getSetting('company_address', ''),
    phone: getSetting('company_phone', ''),
    email: getSetting('company_email', ''),
    website: getSetting('company_website', ''),
    logo: getSetting('company_logo', '') // data URL
  };
}

function wrap(title, inner) {
  const co = companyDetails();
  const brand = co.logo
    ? `<img src="${co.logo}" alt="${co.name || ''}" style="max-height:46px;max-width:190px;vertical-align:middle">`
    : `<span style="font-weight:bold;font-size:18px;color:#fff">${co.name || 'RouteOne'}</span>`;
  const footerBits = [
    co.reg && `Reg: ${co.reg}`,
    co.vat && `VAT: ${co.vat}`,
    co.phone,
    co.email,
    co.website
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  // Table layout for the header - flexbox is unreliable in Outlook.
  return `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1e293b">
    <table width="100%" style="border-collapse:collapse;background:#152a44;border-radius:8px 8px 0 0">
      <tr>
        <td style="padding:14px 20px">${brand}</td>
        <td style="padding:14px 20px;text-align:right;color:#cbd5e1;font-size:13px">${title}</td>
      </tr>
    </table>
    <div style="border:1px solid #e2e8f0;border-top:0;padding:20px;border-radius:0 0 8px 8px">${inner}
      ${footerBits || co.name ? `<div style="margin-top:18px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;text-align:center">${co.name || ''}${footerBits ? '<br>' + footerBits : ''}</div>` : ''}
    </div>
  </div>`;
}

// Regenerate the PDF for a customer-facing email (quote / order confirmation)
// at send time, so attachments never need to live in the email_log table.
async function pdfForEmail(kind, refId) {
  const { buildDocumentPdf } = await import('./pdf.js');
  const company = companyDetails();
  if (kind === 'quote') {
    const doc = db.prepare(`
      SELECT q.*, c.name AS customer_name, c.code AS customer_code, c.contact_name, c.address, c.city
      FROM quotes q JOIN customers c ON c.id = q.customer_id WHERE q.id = ?
    `).get(refId);
    if (!doc) return null;
    const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(refId);
    return { filename: `Quotation-${doc.number}.pdf`, content: await buildDocumentPdf({ type: 'quote', doc, items, company }) };
  }
  const doc = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.code AS customer_code, c.contact_name, c.address, c.city
    FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?
  `).get(refId);
  if (!doc) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(refId);
  return { filename: `Order-${doc.number}.pdf`, content: await buildDocumentPdf({ type: 'order', doc, items, company }) };
}

export function buildOrderEmail(orderId) {
  const order = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.code AS customer_code, c.address, c.city,
      c.payment_terms, u.name AS rep_name, u.email AS rep_email
    FROM orders o JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = o.rep_id WHERE o.id = ?
  `).get(orderId);
  if (!order) throw new Error('Order not found');
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);

  const inner = `
    <p>New sales order captured in the field — please capture in SYSPRO.</p>
    <table style="font-size:14px;margin-bottom:14px">
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Order no</td><td><b>${order.number}</b></td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">SYSPRO account</td><td><b>${order.customer_code}</b></td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Customer</td><td>${order.customer_name}</td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Delivery</td><td>${order.address || ''}${order.city ? ', ' + order.city : ''}</td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Terms</td><td>${order.payment_terms || ''}</td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Rep</td><td>${order.rep_name || '—'}</td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Captured</td><td>${order.order_date}</td></tr>
      ${order.notes ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Notes</td><td>${order.notes}</td></tr>` : ''}
      ${order.delivery_instructions ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Delivery notes</td><td>${order.delivery_instructions}</td></tr>` : ''}
    </table>
    ${docTable(items, order)}
    <p style="color:#94a3b8;font-size:12px;margin-top:16px">Product codes are SYSPRO stock codes. Prices shown are the app's contract/list prices at capture time.</p>`;

  return {
    kind: 'order',
    ref_id: order.id,
    to_addr: getSetting('orders_email', ''),
    cc_addr: order.rep_email || null,
    subject: `Sales order ${order.number} — ${order.customer_name} (${order.customer_code}) — ${fmtR(order.total)}`,
    body_html: wrap(`Sales order ${order.number}`, inner)
  };
}

// Customer-facing order confirmation - friendly wording, no internal jargon.
export function buildOrderConfirmationEmail(orderId) {
  const order = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.email AS customer_email, c.contact_name,
      u.name AS rep_name, u.email AS rep_email
    FROM orders o JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = o.rep_id WHERE o.id = ?
  `).get(orderId);
  if (!order) throw new Error('Order not found');
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);

  const inner = `
    <p>Dear ${order.contact_name || order.customer_name},</p>
    <p>Thank you for your order! Here's a summary of what we received — our team is processing it now.</p>
    <table style="font-size:14px;margin-bottom:14px">
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Order reference</td><td><b>${order.number}</b></td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Placed</td><td>${order.order_date}</td></tr>
      ${order.delivery_instructions ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Delivery notes</td><td>${order.delivery_instructions}</td></tr>` : ''}
    </table>
    ${docTable(items, order)}
    <p style="font-size:14px;margin-top:14px">Questions or changes? ${order.rep_name ? `Contact ${order.rep_name}` : 'Contact us'} or simply reply to this email.</p>`;

  return {
    kind: 'order',
    ref_id: order.id,
    to_addr: order.customer_email || '',
    cc_addr: order.rep_email || null,
    subject: `Order confirmation ${order.number} — ${fmtR(order.total)} incl. VAT`,
    body_html: wrap(`Order confirmation ${order.number}`, inner)
  };
}

export function buildQuoteEmail(quoteId) {
  const quote = db.prepare(`
    SELECT q.*, c.name AS customer_name, c.code AS customer_code, c.email AS customer_email,
      c.contact_name, u.name AS rep_name, u.email AS rep_email
    FROM quotes q JOIN customers c ON c.id = q.customer_id
    LEFT JOIN users u ON u.id = q.rep_id WHERE q.id = ?
  `).get(quoteId);
  if (!quote) throw new Error('Quote not found');
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quoteId);

  const inner = `
    <p>Dear ${quote.contact_name || quote.customer_name},</p>
    <p>Thank you for your time. Please find our quotation below — valid until <b>${quote.valid_until || ''}</b>.</p>
    ${docTable(items, quote)}
    ${quote.notes ? `<p style="font-size:14px">${quote.notes}</p>` : ''}
    <p style="font-size:14px">To place this order, simply reply to this email or contact ${quote.rep_name || 'your rep'}.</p>`;

  return {
    kind: 'quote',
    ref_id: quote.id,
    to_addr: quote.customer_email || '',
    cc_addr: quote.rep_email || null,
    subject: `Quotation ${quote.number} — valid until ${quote.valid_until || 'soon'}`,
    body_html: wrap(`Quotation ${quote.number}`, inner)
  };
}

// Log the email, then try to send it. Returns the email_log row.
export async function sendEmail(draft) {
  if (!draft.to_addr) {
    draft = { ...draft, to_addr: '(no recipient configured)' };
  }
  const id = db.prepare(`
    INSERT INTO email_log (kind, ref_id, to_addr, cc_addr, subject, body_html)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(draft.kind, draft.ref_id, draft.to_addr, draft.cc_addr, draft.subject, draft.body_html).lastInsertRowid;
  return attemptSend(id);
}

export async function attemptSend(emailId) {
  const email = db.prepare('SELECT * FROM email_log WHERE id = ?').get(emailId);
  if (!email) throw new Error('Email not found');
  const cfg = smtpConfig();
  if (!cfg || !email.to_addr || email.to_addr.startsWith('(')) {
    db.prepare("UPDATE email_log SET status = 'pending', error = ? WHERE id = ?")
      .run(!cfg ? 'SMTP not configured' : 'No recipient address', emailId);
    return db.prepare('SELECT * FROM email_log WHERE id = ?').get(emailId);
  }
  try {
    // Customer-facing documents (quote, and the order confirmation that goes to
    // the customer rather than telesales) get the PDF attached. The telesales
    // order email stays HTML-only for capture.
    let attachments;
    const ordersEmail = getSetting('orders_email', '');
    const isCustomerDoc = email.kind === 'quote' || (email.kind === 'order' && email.to_addr !== ordersEmail);
    if (isCustomerDoc) {
      try {
        const pdf = await pdfForEmail(email.kind, email.ref_id);
        if (pdf) attachments = [pdf];
      } catch (e) {
        console.error('PDF attachment failed (sending without it):', e.message);
      }
    }

    const nodemailer = (await import('nodemailer')).default;
    const transport = nodemailer.createTransport(cfg);
    await transport.sendMail({
      from: getSetting('smtp_from', cfg.auth?.user || 'fieldsales@localhost'),
      to: email.to_addr,
      cc: email.cc_addr || undefined,
      subject: email.subject,
      html: email.body_html,
      attachments
    });
    db.prepare("UPDATE email_log SET status = 'sent', error = NULL, sent_at = datetime('now') WHERE id = ?").run(emailId);
  } catch (e) {
    db.prepare("UPDATE email_log SET status = 'failed', error = ? WHERE id = ?").run(e.message, emailId);
  }
  return db.prepare('SELECT * FROM email_log WHERE id = ?').get(emailId);
}

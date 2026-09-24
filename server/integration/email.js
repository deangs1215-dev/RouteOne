// Outbound email: orders and quotes go to the customer, the rep, and/or the
// recipients configured in Email Settings, whichever the sender selects.
// Every email is stored in email_log first - if SMTP isn't configured (or
// fails) it stays 'pending'/'failed' and can be previewed and resent from the
// Integration page.
import { dbx, VAT_RATE } from '../db.js';
import { getSetting } from '../dbh.js';
import { decryptSecret } from '../crypto.js';
import { loadDoc, customerDetails } from './docData.js';

async function smtpConfig() {
  const host = await getSetting('smtp_host', '');
  if (!host) return null;
  return {
    host,
    port: parseInt(await getSetting('smtp_port', '587'), 10),
    secure: await getSetting('smtp_secure', '0') === '1',
    auth: await getSetting('smtp_user', '')
      ? { user: await getSetting('smtp_user'), pass: decryptSecret(await getSetting('smtp_password', '')) }
      : undefined,
    tls: { rejectUnauthorized: await getSetting('smtp_allow_invalid_cert', '0') !== '1' }
  };
}

// --- Microsoft 365 (Graph API) transport ------------------------------------
// Recommended path for Exchange Online: Microsoft disabled Basic Auth for SMTP
// AUTH tenant-wide by default, so plain SMTP username/password against
// smtp.office365.com will fail on most tenants. Graph's application-permission
// /sendMail avoids SMTP entirely - see docs/EMAIL-M365-SETUP.md for the Azure
// AD app registration your M365 admin needs to create (Mail.Send, app-only).
async function graphConfig() {
  const tenantId = await getSetting('graph_tenant_id', '');
  const clientId = await getSetting('graph_client_id', '');
  const clientSecret = decryptSecret(await getSetting('graph_client_secret', ''));
  const sender = await getSetting('graph_sender', '');
  if (!tenantId || !clientId || !clientSecret || !sender) return null;
  return { tenantId, clientId, clientSecret, sender };
}

// Client-credentials tokens last ~1 hour; cache in memory and refresh a minute
// before expiry rather than fetching one per send.
let graphTokenCache = null; // { token, expiresAt, tenantId, clientId }

async function getGraphAccessToken(cfg) {
  const cached = graphTokenCache;
  if (cached && cached.tenantId === cfg.tenantId && cached.clientId === cfg.clientId && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.error || `Token request failed (${res.status})`);
  graphTokenCache = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000, tenantId: cfg.tenantId, clientId: cfg.clientId };
  return body.access_token;
}

async function sendViaGraph(cfg, { to, cc, subject, html, attachments }) {
  const token = await getGraphAccessToken(cfg);
  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: [{ emailAddress: { address: to } }],
    ccRecipients: cc ? [{ emailAddress: { address: cc } }] : undefined,
    attachments: (attachments || []).map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentType: 'application/pdf',
      contentBytes: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content
    }))
  };
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.sender)}/sendMail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, saveToSentItems: true })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || `Graph sendMail failed (${res.status})`);
  }
}

const fmtR = (n) => 'R ' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Escape user-entered text before embedding it in email HTML.
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function docTable(items, doc, type = 'order') {
  const rows = items.map((i) => {
    const kgFactor = i.conv_factor_alt_uom || i.pack_weight_kg;
    const kgPrice = kgFactor > 0 ? i.unit_price / kgFactor : null;
    return `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">
        ${i.product_code ? `<div style="font-weight:bold;font-size:15px;color:#152a44">${esc(i.product_code)}</div>` : ''}
        ${i.product_code && type === 'quote' ? `<div style="font-size:11px;color:#94a3b8">${esc(i.product_code.slice(0, 5))}</div>` : ''}
        ${esc(i.product_name)}
      </td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:center">${i.qty} ${i.uom || ''}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">
        ${fmtR(i.unit_price)}
        ${kgPrice != null ? `<div style="color:#94a3b8;font-size:11px">${fmtR(kgPrice)}/kg</div>` : ''}
      </td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${fmtR(i.line_total)}</td>
    </tr>`;
  }).join('');
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
export async function companyDetails() {
  return {
    name: await getSetting('company_name', ''),
    reg: await getSetting('company_reg', ''),
    vat: await getSetting('company_vat', ''),
    address: await getSetting('company_address', ''),
    phone: await getSetting('company_phone', ''),
    email: await getSetting('company_email', ''),
    website: await getSetting('company_website', ''),
    logo: await getSetting('company_logo', '') // data URL
  };
}

export async function wrap(title, inner) {
  const co = await companyDetails();
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

// Order/quote notes and delivery instructions, shown bold in a highlighted box
// so telesales don't miss them. includeNotes=false for customer-facing emails
// where only the delivery instructions belong.
export function notesHtml(doc, { includeNotes = true } = {}) {
  const item = (label, text) => `
      <div style="font-size:11px;font-weight:bold;letter-spacing:.5px;color:#92400e;text-transform:uppercase">${label}</div>
      <div style="font-size:15px;font-weight:bold;color:#1e293b;margin:2px 0 8px">${esc(text).replace(/\r?\n/g, '<br>')}</div>`;
  const parts = [];
  if (includeNotes && doc.notes) parts.push(item('Notes', doc.notes));
  if (doc.delivery_instructions) parts.push(item('Delivery notes', doc.delivery_instructions));
  if (!parts.length) return '';
  return `
    <div style="margin:0 0 14px;padding:10px 14px 2px;background:#fff7d6;border-left:4px solid #f59e0b;border-radius:4px">${parts.join('')}
    </div>`;
}

// The customer details block shared by every order/quote email (and mirrored in
// the PDF): To / Customer Code / Contact Person / Phone / Cell / E-mail / VAT /
// Address on the left, Placed By / Warehouse on the right.
export function customerBlockHtml(doc) {
  const d = customerDetails(doc);
  const multi = (arr) => (arr.length ? arr.map(esc).join('<br>') : '-');
  const lbl = 'font-weight:bold;color:#1e293b;padding:3px 14px 3px 0;vertical-align:top;white-space:nowrap';
  const row = (label, value) => `<tr><td style="${lbl}">${label}</td><td style="padding:3px 0;vertical-align:top">${value}</td></tr>`;
  return `
    <table width="100%" style="border-collapse:collapse;font-size:13px;margin:0 0 14px">
      <tr>
        <td valign="top" style="padding:0">
          <table style="border-collapse:collapse;font-size:13px">
            ${row('To', `${esc(d.toName)}${d.toCity ? '<br>' + esc(d.toCity) : ''}`)}
            ${row('Customer Code', `<b>${esc(d.code) || '-'}</b>`)}
            ${row('Contact Person', multi(d.contacts))}
            ${row('Phone no', esc(d.phone) || '-')}
            ${row('Cell no', esc(d.cell) || '-')}
            ${row('E-mail', esc(d.email) || '-')}
            ${row('VAT no', esc(d.vat) || '-')}
            ${row('Address', multi(d.address))}
          </table>
        </td>
        <td valign="top" style="padding:0 0 0 16px">
          <table style="border-collapse:collapse;font-size:13px">
            ${row('Placed By', esc(d.placedBy) || '-')}
            ${row('Warehouse', esc(d.warehouse) || '-')}
          </table>
        </td>
      </tr>
    </table>`;
}

// Regenerate the PDF for a customer-facing email (quote / order confirmation)
// at send time, so attachments never need to live in the email_log table.
async function pdfForEmail(kind, refId) {
  const { buildDocumentPdf } = await import('./pdf.js');
  const company = await companyDetails();
  if (kind === 'quote') {
    const doc = await loadDoc('quote', refId);
    if (!doc) return null;
    const items = await dbx.prepare(`
      SELECT i.*, p.pack_weight_kg, p.conv_factor_alt_uom, p.code AS product_code FROM quote_items i
      LEFT JOIN products p ON p.id = i.product_id WHERE i.quote_id = ?
    `).all(refId);
    return { filename: `Quotation-${doc.number}.pdf`, content: await buildDocumentPdf({ type: 'quote', doc, items, company }) };
  }
  const doc = await loadDoc('order', refId);
  if (!doc) return null;
  const items = await dbx.prepare(`
    SELECT i.*, p.pack_weight_kg, p.conv_factor_alt_uom, p.code AS product_code FROM order_items i
    LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = ?
  `).all(refId);
  return { filename: `Order-${doc.number}.pdf`, content: await buildDocumentPdf({ type: 'order', doc, items, company }) };
}

export async function buildOrderEmail(orderId) {
  const order = await loadDoc('order', orderId);
  if (!order) throw new Error('Order not found');
  const items = await dbx.prepare(`
    SELECT i.*, p.pack_weight_kg, p.conv_factor_alt_uom, p.code AS product_code FROM order_items i
    LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = ?
  `).all(orderId);

  const inner = `
    <p>New sales order captured in the field — please capture in SYSPRO.</p>
    <table style="font-size:14px;margin-bottom:14px">
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Order no</td><td><b>${order.number}</b></td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Captured</td><td>${order.order_date}</td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Terms</td><td>${esc(order.payment_terms || '')}</td></tr>
      ${order.customer_order_no ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Customer order no.</td><td><b>${esc(order.customer_order_no)}</b></td></tr>` : ''}
    </table>
    ${notesHtml(order)}
    ${customerBlockHtml(order)}
    ${docTable(items, order)}
    <p style="color:#94a3b8;font-size:12px;margin-top:16px">Product codes are SYSPRO stock codes. Prices shown are the app's contract/list prices at capture time.</p>`;

  return {
    kind: 'order',
    ref_id: order.id,
    // The caller always supplies to_addr (extra email, a configured
    // recipient, etc.) - there is no longer a default internal address.
    to_addr: '',
    cc_addr: order.rep_email || null,
    subject: `Sales order ${order.number} — ${order.customer_name} (${order.customer_code}) — ${fmtR(order.total)}`,
    body_html: await wrap(`Sales order ${order.number}`, inner)
  };
}

// Customer-facing order confirmation - friendly wording, no internal jargon.
export async function buildOrderConfirmationEmail(orderId) {
  const order = await loadDoc('order', orderId);
  if (!order) throw new Error('Order not found');
  const items = await dbx.prepare(`
    SELECT i.*, p.pack_weight_kg, p.conv_factor_alt_uom, p.code AS product_code FROM order_items i
    LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = ?
  `).all(orderId);

  // R1-049: point the customer at their own rep only, never a shared/generic
  // contact - there's no Reply-To override anywhere in this file, so "reply
  // to this email" went to the fixed smtp_from address (a shared mailbox),
  // exactly the kind of generic order-processing contact this is meant to
  // avoid. Falls back to a bare "contact us" only when an order genuinely has
  // no rep assigned - there's no one to name in that case.
  const repContact = order.rep_name ? `
    <p style="font-size:14px;margin-top:14px">Questions or changes? Please contact your Sales Representative, <b>${esc(order.rep_name)}</b>.</p>
    <table style="font-size:14px;margin:4px 0 14px">
      ${order.rep_email ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Email</td><td>${esc(order.rep_email)}</td></tr>` : ''}
      ${order.rep_phone ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Phone</td><td>${esc(order.rep_phone)}</td></tr>` : ''}
    </table>` : `
    <p style="font-size:14px;margin-top:14px">Questions or changes about this order? Please contact us.</p>`;

  // R1-048: many customer email addresses are generic/bulk/shared, not
  // reliably the actual contact - a named greeting was often wrong for
  // whoever actually opened the email. Always "Dear Customer," instead.
  const inner = `
    <p>Dear Customer,</p>
    <p>Thank you for your order! Here's a summary of what we received — our team is processing it now.</p>
    <table style="font-size:14px;margin-bottom:14px">
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Order reference</td><td><b>${order.number}</b></td></tr>
      ${order.customer_order_no ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Your order no.</td><td><b>${esc(order.customer_order_no)}</b></td></tr>` : ''}
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Placed</td><td>${order.order_date}</td></tr>
    </table>
    ${notesHtml(order, { includeNotes: false })}
    ${customerBlockHtml(order)}
    ${docTable(items, order)}
    ${repContact}`;

  return {
    kind: 'order',
    ref_id: order.id,
    to_addr: order.customer_email || '',
    cc_addr: order.rep_email || null,
    subject: `Order confirmation ${order.number} — ${fmtR(order.total)} incl. VAT`,
    body_html: await wrap(`Order confirmation ${order.number}`, inner)
  };
}

export async function buildQuoteEmail(quoteId) {
  const quote = await loadDoc('quote', quoteId);
  if (!quote) throw new Error('Quote not found');
  const items = await dbx.prepare(`
    SELECT i.*, p.pack_weight_kg, p.conv_factor_alt_uom, p.code AS product_code FROM quote_items i
    LEFT JOIN products p ON p.id = i.product_id WHERE i.quote_id = ?
  `).all(quoteId);

  const inner = `
    <p>Dear ${esc(quote.contact_name || quote.customer_name)},</p>
    <p>Thank you for your time. Please find our quotation below — valid until <b>${quote.valid_until || ''}</b>.</p>
    <table style="font-size:14px;margin-bottom:14px">
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Quotation no</td><td><b>${quote.number}</b></td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Date</td><td>${(quote.quote_date || '').slice(0, 16)}</td></tr>
      ${quote.valid_until ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Valid until</td><td>${quote.valid_until}</td></tr>` : ''}
    </table>
    ${customerBlockHtml(quote)}
    ${docTable(items, quote, 'quote')}
    ${notesHtml(quote)}
    <p style="font-size:14px">To place this order, simply reply to this email or contact ${quote.rep_name ? esc(quote.rep_name) : 'your rep'}.</p>`;

  return {
    kind: 'quote',
    ref_id: quote.id,
    to_addr: quote.customer_email || '',
    cc_addr: quote.rep_email || null,
    subject: `Quotation ${quote.number} — valid until ${quote.valid_until || 'soon'}`,
    body_html: await wrap(`Quotation ${quote.number}`, inner)
  };
}

// Internal notification for a form submission — sent to the rep who submitted it.
// No PDF attachment (see attemptSend).
export async function buildFormEmail(submissionId, repEmail) {
  const submission = await dbx.prepare(`
    SELECT s.*, t.name AS template_name, t.fields AS template_fields,
      t.category AS template_category,
      c.name AS customer_name, c.code AS customer_code, u.name AS user_name
    FROM form_submissions s
    JOIN form_templates t ON t.id = s.template_id
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(submissionId);
  if (!submission) throw new Error('Form submission not found');
  const fields = JSON.parse(submission.template_fields);
  const data = JSON.parse(submission.data);

  const rows = fields.map((f) => {
    const value = data[f.key];
    const display = f.type === 'photo' && value
      ? `<a href="${esc(value)}">photo attached</a>`
      : f.type === 'checkbox'
        ? (value ? 'Yes' : 'No')
        : esc(value ?? '—');
    return `<tr><td style="color:#64748b;padding:4px 12px 4px 0;vertical-align:top">${esc(f.label)}</td><td>${display}</td></tr>`;
  }).join('');

  const inner = `
    <p>A form was completed in the field.</p>
    <table style="font-size:14px;margin-bottom:14px">
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Form</td><td><b>${esc(submission.template_name)}</b></td></tr>
      ${submission.customer_name ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Customer</td><td>${esc(submission.customer_name)}${submission.customer_code ? ` (${esc(submission.customer_code)})` : ''}</td></tr>` : ''}
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Submitted by</td><td>${esc(submission.user_name || '—')}</td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Submitted</td><td>${submission.created_at}</td></tr>
    </table>
    <table style="font-size:14px;border-collapse:collapse">${rows}</table>`;

  return {
    kind: 'form',
    ref_id: submission.id,
    to_addr: repEmail,
    cc_addr: null,
    subject: `Form: ${submission.template_name}${submission.customer_name ? ` — ${submission.customer_name}` : ''}`,
    body_html: await wrap(`Form submission — ${submission.template_name}`, inner)
  };
}

// Support ticket status notification — goes to whoever logged the ticket,
// whenever admin changes its status (see support.routes.js).
const TICKET_STATUS_LABELS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };
export async function buildSupportTicketEmail(ticketId) {
  const ticket = await dbx.prepare(`
    SELECT t.*, u.name AS created_by_name, u.email AS created_by_email,
      c.name AS customer_name, o.number AS order_number, r.name AS resolved_by_name
    FROM support_tickets t
    JOIN users u ON u.id = t.created_by
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN orders o ON o.id = t.order_id
    LEFT JOIN users r ON r.id = t.resolved_by
    WHERE t.id = ?
  `).get(ticketId);
  if (!ticket) throw new Error('Support ticket not found');

  const statusLabel = TICKET_STATUS_LABELS[ticket.status] || ticket.status;
  const inner = `
    <p>Your support ticket has been updated to <b>${esc(statusLabel)}</b>.</p>
    <table style="font-size:14px;margin-bottom:14px">
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Subject</td><td><b>${esc(ticket.subject)}</b></td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Status</td><td>${esc(statusLabel)}</td></tr>
      ${ticket.customer_name ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Customer</td><td>${esc(ticket.customer_name)}</td></tr>` : ''}
      ${ticket.order_number ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Order</td><td>${esc(ticket.order_number)}</td></tr>` : ''}
      ${ticket.resolved_by_name && ticket.status === 'resolved' ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Resolved by</td><td>${esc(ticket.resolved_by_name)}</td></tr>` : ''}
      ${ticket.admin_notes ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0;vertical-align:top">Notes</td><td>${esc(ticket.admin_notes)}</td></tr>` : ''}
    </table>
    <p style="color:#64748b;font-size:13px">Original description:</p>
    <p style="font-size:14px;white-space:pre-wrap">${esc(ticket.description)}</p>`;

  return {
    kind: 'support_ticket',
    ref_id: ticket.id,
    to_addr: ticket.created_by_email,
    cc_addr: null,
    subject: `Support ticket ${statusLabel}: ${ticket.subject}`,
    body_html: await wrap('Support ticket update', inner)
  };
}

// Daily rep digest: yesterday's orders, today's planned customers, and the
// open tasks / Sales AI alerts tied to those customers. Built from the same
// query buildDaySummary() uses for the mobile "My day" screen, so the email
// always matches what the rep sees in the app.
export async function buildRepDigestEmail(rep, { yesterdayOrders, today }) {
  const { visits, stats } = today;

  const ordersSection = yesterdayOrders.length > 0 ? `
    <h3 style="font-size:14px;margin:18px 0 8px">📦 Yesterday's orders (${yesterdayOrders.length} · ${fmtR(yesterdayOrders.reduce((s, o) => s + o.total, 0))})</h3>
    <table style="font-size:13px;border-collapse:collapse;width:100%">
      <tr style="background:#f1f5f9"><th style="padding:4px 8px;text-align:left">Order</th><th style="padding:4px 8px;text-align:left">Customer</th><th style="padding:4px 8px;text-align:right">Total</th></tr>
      ${yesterdayOrders.map((o) => `
        <tr>
          <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0">${esc(o.number)}</td>
          <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0">${esc(o.customer_name)}</td>
          <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;text-align:right">${fmtR(o.total)}</td>
        </tr>`).join('')}
    </table>` : `<p style="font-size:13px;color:#94a3b8;margin:18px 0 0">No orders captured yesterday.</p>`;

  const visitRows = visits.map((v, i) => {
    const bits = [];
    if (v.overdue_task_count > 0) bits.push(`<span style="color:#dc2626;font-weight:bold">${v.overdue_task_count} overdue task${v.overdue_task_count > 1 ? 's' : ''}</span>`);
    else if (v.open_task_count > 0) bits.push(`<span style="color:#b45309">${v.open_task_count} open task${v.open_task_count > 1 ? 's' : ''}</span>`);
    if (v.ai_alert_count > 0) bits.push(`<span style="color:#dc2626">🤖 ${v.top_ai_alert ? esc(v.top_ai_alert.action) : `${v.ai_alert_count} AI alert${v.ai_alert_count > 1 ? 's' : ''}`}</span>`);
    return `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;color:#64748b">${v.route_order || i + 1}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0"><b>${esc(v.customer_name)}</b><br><span style="color:#94a3b8;font-size:12px">${esc(v.city || '')}</span></td>
        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px">${bits.join('<br>') || '<span style="color:#cbd5e1">—</span>'}</td>
      </tr>`;
  }).join('');

  const visitsSection = visits.length > 0 ? `
    <h3 style="font-size:14px;margin:18px 0 8px">📍 Today's customers (${visits.length})</h3>
    <table style="font-size:13px;border-collapse:collapse;width:100%">
      <tr style="background:#f1f5f9"><th style="padding:4px 8px;text-align:left">#</th><th style="padding:4px 8px;text-align:left">Customer</th><th style="padding:4px 8px;text-align:left">Open items</th></tr>
      ${visitRows}
    </table>` : `<p style="font-size:13px;color:#94a3b8;margin:18px 0 0">No visits planned for today.</p>`;

  const inner = `
    <p>Good morning, ${esc(rep.name.split(' ')[0])} 👋 Here's your day at a glance.</p>
    ${ordersSection}
    ${visitsSection}
    <p style="color:#94a3b8;font-size:12px;margin-top:18px">This is an automated summary from RouteOne — open the app for full detail.</p>`;

  return {
    kind: 'rep_digest',
    ref_id: rep.id,
    to_addr: rep.email,
    cc_addr: null,
    subject: `Your RouteOne day — ${visits.length} customer${visits.length === 1 ? '' : 's'}, ${yesterdayOrders.length} order${yesterdayOrders.length === 1 ? '' : 's'} yesterday`,
    body_html: await wrap('Daily digest', inner)
  };
}

// Daily sync digest: every SYSPRO sync run (per entity) from the last 24
// hours, newest first - so an admin can see overnight/scheduled syncs
// without opening the Integration page. Failed runs are called out in red;
// a run with skipped/dropped rows is flagged amber so a silent data-loss
// bug (like the customer_pricing bind-error one) doesn't go unnoticed.
export async function buildSyncDigestEmail(runs, { toAddr } = {}) {
  const completed = runs.filter((r) => r.status === 'completed');
  const failed = runs.filter((r) => r.status === 'failed');
  const withSkips = completed.filter((r) => (r.rows_skipped || 0) > 0 || (r.error));

  const durationLabel = (r) => {
    if (!r.finished_at) return '—';
    const ms = new Date(r.finished_at.replace(' ', 'T') + 'Z') - new Date(r.started_at.replace(' ', 'T') + 'Z');
    if (!(ms > 0)) return '—';
    return ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}m`;
  };

  const rows = runs.map((r) => {
    const statusColor = r.status === 'failed' ? '#dc2626' : (r.rows_skipped > 0 || r.error) ? '#b45309' : '#16a34a';
    const statusLabel = r.status === 'failed' ? 'Failed' : (r.rows_skipped > 0 || r.error) ? 'Completed (with issues)' : 'Completed';
    return `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0">${esc(r.entity)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;color:${statusColor};font-weight:bold">${statusLabel}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right">${r.status === 'failed' ? '—' : `${r.rows_upserted ?? 0} / ${r.rows_read ?? 0}`}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right">${durationLabel(r)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:12px">${esc(r.started_at)}</td>
        ${r.error ? `<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;color:#dc2626;font-size:12px">${esc(r.error.slice(0, 200))}</td>` : '<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0"></td>'}
      </tr>`;
  }).join('');

  const inner = runs.length === 0
    ? `<p style="font-size:13px;color:#94a3b8">No SYSPRO syncs ran in the last 24 hours.</p>`
    : `
    <p>${completed.length} completed, ${failed.length} failed${withSkips.length ? `, ${withSkips.length} with skipped/dropped rows` : ''} in the last 24 hours.</p>
    <table style="font-size:13px;border-collapse:collapse;width:100%">
      <tr style="background:#f1f5f9">
        <th style="padding:4px 8px;text-align:left">Entity</th>
        <th style="padding:4px 8px;text-align:left">Status</th>
        <th style="padding:4px 8px;text-align:right">Rows (upserted/read)</th>
        <th style="padding:4px 8px;text-align:right">Duration</th>
        <th style="padding:4px 8px;text-align:left">Started</th>
        <th style="padding:4px 8px;text-align:left">Error</th>
      </tr>
      ${rows}
    </table>
    <p style="color:#94a3b8;font-size:12px;margin-top:18px">This is an automated summary from RouteOne — open the Integration page for full detail.</p>`;

  return {
    kind: 'sync_digest',
    ref_id: 0, // email_log.ref_id is NOT NULL; a digest has no single referenced row, so 0 is the "none" sentinel (ids are AUTOINCREMENT from 1)
    to_addr: toAddr,
    cc_addr: null,
    subject: `RouteOne sync summary — ${completed.length} completed${failed.length ? `, ${failed.length} failed` : ''}`,
    body_html: await wrap('Daily sync summary', inner)
  };
}

// Log the email, then try to send it. Returns the email_log row.
export async function sendEmail(draft) {
  if (!draft.to_addr) {
    draft = { ...draft, to_addr: '(no recipient configured)' };
  }
  const id = (await dbx.prepare(`
    INSERT INTO email_log (kind, ref_id, to_addr, cc_addr, subject, body_html)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(draft.kind, draft.ref_id, draft.to_addr, draft.cc_addr, draft.subject, draft.body_html)).lastInsertRowid;
  return attemptSend(id);
}

export async function attemptSend(emailId) {
  const email = await dbx.prepare('SELECT * FROM email_log WHERE id = ?').get(emailId);
  if (!email) throw new Error('Email not found');
  if (!email.to_addr || email.to_addr.startsWith('(')) {
    await dbx.prepare("UPDATE email_log SET status = 'pending', error = ? WHERE id = ?")
      .run('No recipient address', emailId);
    return await dbx.prepare('SELECT * FROM email_log WHERE id = ?').get(emailId);
  }

  const transport = await getSetting('email_transport', 'smtp') === 'graph' ? 'graph' : 'smtp';
  const smtpCfg = transport === 'smtp' ? await smtpConfig() : null;
  const graphCfg = transport === 'graph' ? await graphConfig() : null;
  if (transport === 'smtp' && !smtpCfg) {
    await dbx.prepare("UPDATE email_log SET status = 'pending', error = ? WHERE id = ?").run('SMTP not configured', emailId);
    return await dbx.prepare('SELECT * FROM email_log WHERE id = ?').get(emailId);
  }
  if (transport === 'graph' && !graphCfg) {
    await dbx.prepare("UPDATE email_log SET status = 'pending', error = ? WHERE id = ?").run('Microsoft 365 (Graph API) not configured', emailId);
    return await dbx.prepare('SELECT * FROM email_log WHERE id = ?').get(emailId);
  }

  try {
    // Every order/quote email gets its PDF attached - there is no longer an
    // internal, PDF-less recipient type.
    let attachments;
    if (email.kind === 'order' || email.kind === 'quote') {
      try {
        const pdf = await pdfForEmail(email.kind, email.ref_id);
        if (pdf) attachments = [pdf];
      } catch (e) {
        console.error('PDF attachment failed (sending without it):', e.message);
      }
    }

    if (transport === 'graph') {
      await sendViaGraph(graphCfg, { to: email.to_addr, cc: email.cc_addr, subject: email.subject, html: email.body_html, attachments });
    } else {
      const nodemailer = (await import('nodemailer')).default;
      const mailer = nodemailer.createTransport(smtpCfg);
      await mailer.sendMail({
        from: await getSetting('smtp_from', smtpCfg.auth?.user || 'fieldsales@localhost'),
        to: email.to_addr,
        cc: email.cc_addr || undefined,
        subject: email.subject,
        html: email.body_html,
        attachments
      });
    }
    await dbx.prepare("UPDATE email_log SET status = 'sent', error = NULL, sent_at = datetime('now') WHERE id = ?").run(emailId);
  } catch (e) {
    await dbx.prepare("UPDATE email_log SET status = 'failed', error = ? WHERE id = ?").run(e.message, emailId);
  }
  return await dbx.prepare('SELECT * FROM email_log WHERE id = ?').get(emailId);
}

// Forgot-password email - link expires in 1 hour (see auth.routes.js).
export async function buildPasswordResetEmail(user, resetLink) {
  const inner = `
    <p>Hi ${esc(user.name.split(' ')[0])},</p>
    <p>We received a request to reset your RouteOne password. Click below to choose a new one —
      this link expires in 1 hour and can only be used once.</p>
    <p style="margin:24px 0">
      <a href="${esc(resetLink)}" style="background:#1a7ea8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold">Reset your password</a>
    </p>
    <p style="color:#94a3b8;font-size:12px">If you didn't request this, you can safely ignore this email —
      your password won't change unless you click the link above and set a new one.</p>`;

  return {
    kind: 'password_reset',
    ref_id: user.id,
    to_addr: user.email,
    cc_addr: null,
    subject: 'Reset your RouteOne password',
    body_html: await wrap('Password reset', inner)
  };
}

// Welcome email with a temporary password, sent from Users -> Send login details.
export async function buildLoginDetailsEmail(user, tempPassword) {
  const inner = `
    <p>Hello ${esc(user.name)},</p>
    <p>Your RouteOne account has been created. You can now log in with the following credentials:</p>
    <table style="font-size:14px;margin-bottom:14px">
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Email</td><td><b>${esc(user.email)}</b></td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Temporary password</td><td><b>${esc(tempPassword)}</b></td></tr>
    </table>
    <p>On your first login, you will be required to change your password to something more secure.</p>
    <p><b>Password requirements:</b></p>
    <ul>
      <li>Minimum 9 characters</li>
      <li>At least one capital letter (A-Z)</li>
      <li>At least one number (0-9)</li>
    </ul>
    <p>Best regards,<br>RouteOne Team</p>`;

  return {
    kind: 'login_details',
    ref_id: user.id,
    to_addr: user.email,
    cc_addr: null,
    subject: 'Welcome to RouteOne - Your Login Details',
    body_html: await wrap('Your login details', inner)
  };
}

// Admin "send a test email" button - proves the configured transport actually
// works without needing to place a real order/quote first.
export async function sendTestEmail(toAddr) {
  const draft = {
    kind: 'test',
    ref_id: 0, // email_log.ref_id is NOT NULL and test emails have no order/quote/form to point at
    to_addr: toAddr,
    cc_addr: null,
    subject: 'RouteOne test email',
    body_html: await wrap('Test email', '<p>This is a test email from RouteOne to confirm outgoing mail is configured correctly.</p>')
  };
  return sendEmail(draft);
}

// Outbound email: orders and quotes go to the customer, the rep, and/or the
// recipients configured in Email Settings, whichever the sender selects.
// Every email is stored in email_log first - if SMTP isn't configured (or
// fails) it stays 'pending'/'failed' and can be previewed and resent from the
// Integration page.
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
      : undefined,
    tls: { rejectUnauthorized: getSetting('smtp_allow_invalid_cert', '0') !== '1' }
  };
}

// --- Microsoft 365 (Graph API) transport ------------------------------------
// Recommended path for Exchange Online: Microsoft disabled Basic Auth for SMTP
// AUTH tenant-wide by default, so plain SMTP username/password against
// smtp.office365.com will fail on most tenants. Graph's application-permission
// /sendMail avoids SMTP entirely - see docs/EMAIL-M365-SETUP.md for the Azure
// AD app registration your M365 admin needs to create (Mail.Send, app-only).
function graphConfig() {
  const tenantId = getSetting('graph_tenant_id', '');
  const clientId = getSetting('graph_client_id', '');
  const clientSecret = decryptSecret(getSetting('graph_client_secret', ''));
  const sender = getSetting('graph_sender', '');
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

function docTable(items, doc) {
  const rows = items.map((i) => {
    const kgPrice = i.pack_weight_kg > 0 ? i.unit_price / i.pack_weight_kg : null;
    return `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${esc(i.product_name)}</td>
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

export function wrap(title, inner) {
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
    const items = db.prepare(`
      SELECT i.*, p.pack_weight_kg FROM quote_items i
      LEFT JOIN products p ON p.id = i.product_id WHERE i.quote_id = ?
    `).all(refId);
    return { filename: `Quotation-${doc.number}.pdf`, content: await buildDocumentPdf({ type: 'quote', doc, items, company }) };
  }
  const doc = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.code AS customer_code, c.contact_name, c.address, c.city
    FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?
  `).get(refId);
  if (!doc) return null;
  const items = db.prepare(`
    SELECT i.*, p.pack_weight_kg FROM order_items i
    LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = ?
  `).all(refId);
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
  const items = db.prepare(`
    SELECT i.*, p.pack_weight_kg FROM order_items i
    LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = ?
  `).all(orderId);

  const inner = `
    <p>New sales order captured in the field — please capture in SYSPRO.</p>
    <table style="font-size:14px;margin-bottom:14px">
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Order no</td><td><b>${order.number}</b></td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">SYSPRO account</td><td><b>${order.customer_code}</b></td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Customer</td><td>${esc(order.customer_name)}</td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Delivery</td><td>${esc(order.address || '')}${order.city ? ', ' + esc(order.city) : ''}</td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Terms</td><td>${esc(order.payment_terms || '')}</td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Rep</td><td>${esc(order.rep_name || '—')}</td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Captured</td><td>${order.order_date}</td></tr>
      ${order.notes ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Notes</td><td>${esc(order.notes)}</td></tr>` : ''}
      ${order.delivery_instructions ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Delivery notes</td><td>${esc(order.delivery_instructions)}</td></tr>` : ''}
    </table>
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
  const items = db.prepare(`
    SELECT i.*, p.pack_weight_kg FROM order_items i
    LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = ?
  `).all(orderId);

  const inner = `
    <p>Dear ${esc(order.contact_name || order.customer_name)},</p>
    <p>Thank you for your order! Here's a summary of what we received — our team is processing it now.</p>
    <table style="font-size:14px;margin-bottom:14px">
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Order reference</td><td><b>${order.number}</b></td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Placed</td><td>${order.order_date}</td></tr>
      ${order.delivery_instructions ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Delivery notes</td><td>${esc(order.delivery_instructions)}</td></tr>` : ''}
    </table>
    ${docTable(items, order)}
    <p style="font-size:14px;margin-top:14px">Questions or changes? ${order.rep_name ? `Contact ${esc(order.rep_name)}` : 'Contact us'} or simply reply to this email.</p>`;

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
  const items = db.prepare(`
    SELECT i.*, p.pack_weight_kg FROM quote_items i
    LEFT JOIN products p ON p.id = i.product_id WHERE i.quote_id = ?
  `).all(quoteId);

  const inner = `
    <p>Dear ${esc(quote.contact_name || quote.customer_name)},</p>
    <p>Thank you for your time. Please find our quotation below — valid until <b>${quote.valid_until || ''}</b>.</p>
    ${docTable(items, quote)}
    ${quote.notes ? `<p style="font-size:14px">${esc(quote.notes)}</p>` : ''}
    <p style="font-size:14px">To place this order, simply reply to this email or contact ${quote.rep_name ? esc(quote.rep_name) : 'your rep'}.</p>`;

  return {
    kind: 'quote',
    ref_id: quote.id,
    to_addr: quote.customer_email || '',
    cc_addr: quote.rep_email || null,
    subject: `Quotation ${quote.number} — valid until ${quote.valid_until || 'soon'}`,
    body_html: wrap(`Quotation ${quote.number}`, inner)
  };
}

// Internal notification for a Technical-category form submission — goes to
// technical_email, not the customer. No PDF attachment (see attemptSend).
export function buildFormEmail(submissionId) {
  const submission = db.prepare(`
    SELECT s.*, t.name AS template_name, t.fields AS template_fields,
      t.notify_email AS notify_email, t.category AS template_category,
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
    <p>A technical form was completed in the field.</p>
    <table style="font-size:14px;margin-bottom:14px">
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Form</td><td><b>${esc(submission.template_name)}</b></td></tr>
      ${submission.customer_name ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0">Customer</td><td>${esc(submission.customer_name)}${submission.customer_code ? ` (${esc(submission.customer_code)})` : ''}</td></tr>` : ''}
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Submitted by</td><td>${esc(submission.user_name || '—')}</td></tr>
      <tr><td style="color:#64748b;padding:2px 12px 2px 0">Submitted</td><td>${submission.created_at}</td></tr>
    </table>
    <table style="font-size:14px;border-collapse:collapse">${rows}</table>`;

  const toAddr = submission.notify_email || (submission.template_category === 'technical' ? getSetting('technical_email', '') : '');

  return {
    kind: 'form',
    ref_id: submission.id,
    to_addr: toAddr,
    cc_addr: null,
    subject: `Form: ${submission.template_name}${submission.customer_name ? ` — ${submission.customer_name}` : ''}`,
    body_html: wrap(`Form submission — ${submission.template_name}`, inner)
  };
}

// Daily rep digest: yesterday's orders, today's planned customers, and the
// open tasks / Sales AI alerts tied to those customers. Built from the same
// query buildDaySummary() uses for the mobile "My day" screen, so the email
// always matches what the rep sees in the app.
export function buildRepDigestEmail(rep, { yesterdayOrders, today }) {
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
    body_html: wrap('Daily digest', inner)
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
  if (!email.to_addr || email.to_addr.startsWith('(')) {
    db.prepare("UPDATE email_log SET status = 'pending', error = ? WHERE id = ?")
      .run('No recipient address', emailId);
    return db.prepare('SELECT * FROM email_log WHERE id = ?').get(emailId);
  }

  const transport = getSetting('email_transport', 'smtp') === 'graph' ? 'graph' : 'smtp';
  const smtpCfg = transport === 'smtp' ? smtpConfig() : null;
  const graphCfg = transport === 'graph' ? graphConfig() : null;
  if (transport === 'smtp' && !smtpCfg) {
    db.prepare("UPDATE email_log SET status = 'pending', error = ? WHERE id = ?").run('SMTP not configured', emailId);
    return db.prepare('SELECT * FROM email_log WHERE id = ?').get(emailId);
  }
  if (transport === 'graph' && !graphCfg) {
    db.prepare("UPDATE email_log SET status = 'pending', error = ? WHERE id = ?").run('Microsoft 365 (Graph API) not configured', emailId);
    return db.prepare('SELECT * FROM email_log WHERE id = ?').get(emailId);
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
        from: getSetting('smtp_from', smtpCfg.auth?.user || 'fieldsales@localhost'),
        to: email.to_addr,
        cc: email.cc_addr || undefined,
        subject: email.subject,
        html: email.body_html,
        attachments
      });
    }
    db.prepare("UPDATE email_log SET status = 'sent', error = NULL, sent_at = datetime('now') WHERE id = ?").run(emailId);
  } catch (e) {
    db.prepare("UPDATE email_log SET status = 'failed', error = ? WHERE id = ?").run(e.message, emailId);
  }
  return db.prepare('SELECT * FROM email_log WHERE id = ?').get(emailId);
}

// Forgot-password email - link expires in 1 hour (see auth.routes.js).
export function buildPasswordResetEmail(user, resetLink) {
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
    body_html: wrap('Password reset', inner)
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
    body_html: wrap('Test email', '<p>This is a test email from RouteOne to confirm outgoing mail is configured correctly.</p>')
  };
  return sendEmail(draft);
}

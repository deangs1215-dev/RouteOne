// Generates a clean A4 PDF for a quote or order confirmation, attached to the
// customer email. Letterhead (logo + company details) comes from settings, so
// South Bakels enters their details once and both the email and PDF use them.
//
// NB: these are QUOTATION / ORDER CONFIRMATION documents, not tax invoices -
// the fiscal invoice is produced by SYSPRO when telesales capture the order.
import PDFDocument from 'pdfkit';

const NAVY = '#152a44';
const TEAL = '#1a7ea8';
const GREY = '#64748b';
const LINE = '#e2e8f0';

const fmtR = (n) => 'R ' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Decode a data-URL logo (data:image/png;base64,...) into a Buffer for pdfkit.
function logoBuffer(dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  try { return Buffer.from(m[2], 'base64'); } catch { return null; }
}

// type: 'quote' | 'order'.  doc = row with number/dates/totals + customer fields.
export function buildDocumentPdf({ type, doc, items, company }) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const left = 50;
    const right = 545;
    const title = type === 'quote' ? 'QUOTATION' : 'ORDER CONFIRMATION';

    // --- Letterhead -----------------------------------------------------------
    const logo = logoBuffer(company.logo);
    let headerBottom = 50;
    if (logo) {
      try { pdf.image(logo, left, 45, { fit: [150, 60] }); } catch { /* bad image, skip */ }
      headerBottom = 110;
    } else {
      pdf.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(company.name || 'Company name', left, 50);
      headerBottom = 78;
    }

    // Company details block, right-aligned
    pdf.fontSize(9).font('Helvetica').fillColor(GREY);
    const details = [
      company.name && logo ? company.name : null,
      company.address,
      company.phone ? `Tel: ${company.phone}` : null,
      company.email,
      company.website
    ].filter(Boolean);
    pdf.text(details.join('\n'), right - 250, 50, { width: 250, align: 'right' });

    // Document title
    pdf.fillColor(TEAL).fontSize(22).font('Helvetica-Bold').text(title, left, headerBottom + 6);
    pdf.moveTo(left, headerBottom + 38).lineTo(right, headerBottom + 38).strokeColor(TEAL).lineWidth(2).stroke();

    let y = headerBottom + 52;

    // --- Meta + bill-to (two columns) ----------------------------------------
    const metaRows = [
      [type === 'quote' ? 'Quotation no' : 'Order no', doc.number],
      [type === 'quote' ? 'Date' : 'Placed', (doc.quote_date || doc.order_date || '').slice(0, 16)]
    ];
    if (type === 'quote' && doc.valid_until) metaRows.push(['Valid until', doc.valid_until]);
    // The customer's own reference belongs on the printed confirmation - it is
    // what they file and reconcile the delivery against.
    if (doc.customer_order_no) metaRows.push(['Your order no.', doc.customer_order_no]);
    if (doc.customer_code) metaRows.push(['Account', doc.customer_code]);

    pdf.fontSize(10).font('Helvetica');
    let my = y;
    for (const [label, val] of metaRows) {
      pdf.fillColor(GREY).text(label, left, my, { width: 90 });
      pdf.fillColor(NAVY).font('Helvetica-Bold').text(String(val || ''), left + 95, my);
      pdf.font('Helvetica');
      my += 16;
    }

    // Bill-to on the right
    pdf.fillColor(GREY).fontSize(9).text('TO', right - 250, y, { width: 250, align: 'right' });
    pdf.fillColor(NAVY).font('Helvetica-Bold').fontSize(11)
      .text(doc.customer_name || '', right - 250, y + 12, { width: 250, align: 'right' });
    pdf.font('Helvetica').fontSize(9).fillColor(GREY);
    const custLines = [doc.contact_name, doc.address, doc.city].filter(Boolean).join('\n');
    if (custLines) pdf.text(custLines, right - 250, y + 28, { width: 250, align: 'right' });

    y = Math.max(my, y + 70) + 10;

    // --- Line items table -----------------------------------------------------
    const cols = { product: left, qty: 320, unit: 390, total: 470 };
    pdf.rect(left, y, right - left, 22).fill(NAVY);
    pdf.fillColor('#ffffff').fontSize(9.5).font('Helvetica-Bold');
    pdf.text('PRODUCT', cols.product + 8, y + 7, { width: 250 });
    pdf.text('QTY', cols.qty, y + 7, { width: 60, align: 'right' });
    pdf.text('UNIT PRICE', cols.unit, y + 7, { width: 70, align: 'right' });
    pdf.text('TOTAL', cols.total, y + 7, { width: 67, align: 'right' });
    y += 22;

    pdf.font('Helvetica').fontSize(9.5).fillColor(NAVY);
    for (const it of items) {
      const name = `${it.product_name}`;
      const nameHeight = pdf.heightOfString(name, { width: 250 });
      const kgFactor = it.conv_factor_alt_uom || it.pack_weight_kg;
      const kgPrice = kgFactor > 0 ? it.unit_price / kgFactor : null;
      // Order: just the product code. Quote: the full code, and the short
      // code (its first 5 characters) on the line below.
      const codeLines = it.product_code
        ? (type === 'quote' ? [it.product_code, it.product_code.slice(0, 5)] : [it.product_code])
        : [];
      const codeHeight = codeLines.length * 10;
      const rowH = Math.max(20, nameHeight + codeHeight + 8, kgPrice != null ? 30 : 20);
      pdf.fillColor(NAVY).fontSize(9.5).text(name, cols.product + 8, y + 5, { width: 250 });
      let codeY = y + 5 + nameHeight + 2;
      pdf.fillColor(GREY).fontSize(7.5);
      for (const line of codeLines) {
        pdf.text(line, cols.product + 8, codeY, { width: 250 });
        codeY += 10;
      }
      pdf.fillColor(NAVY).fontSize(9.5);
      pdf.text(`${it.qty} ${it.uom || ''}`.trim(), cols.qty, y + 5, { width: 60, align: 'right' });
      pdf.text(fmtR(it.unit_price), cols.unit, y + 5, { width: 70, align: 'right' });
      if (kgPrice != null) {
        pdf.fillColor(GREY).fontSize(7.5).text(`${fmtR(kgPrice)}/kg`, cols.unit, y + 16, { width: 70, align: 'right' });
      }
      pdf.fillColor(NAVY).fontSize(9.5).text(fmtR(it.line_total), cols.total, y + 5, { width: 67, align: 'right' });
      y += rowH;
      pdf.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(0.5).stroke();
    }

    // --- Totals ---------------------------------------------------------------
    y += 8;
    const totals = [
      ['Subtotal', doc.subtotal],
      ['VAT (15%)', doc.vat_amount]
    ];
    pdf.fontSize(10).font('Helvetica');
    for (const [label, val] of totals) {
      pdf.fillColor(GREY).text(label, cols.unit - 60, y, { width: 130, align: 'right' });
      pdf.fillColor(NAVY).text(fmtR(val), cols.total, y, { width: 67, align: 'right' });
      y += 16;
    }
    pdf.rect(cols.unit - 60, y, right - (cols.unit - 60), 24).fill(TEAL);
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11);
    pdf.text('TOTAL', cols.unit - 52, y + 7, { width: 122, align: 'right' });
    pdf.text(fmtR(doc.total), cols.total, y + 7, { width: 67, align: 'right' });
    y += 40;

    // --- Notes + footer -------------------------------------------------------
    if (doc.notes) {
      pdf.fillColor(GREY).font('Helvetica').fontSize(9).text(doc.notes, left, y, { width: right - left });
      y += pdf.heightOfString(doc.notes, { width: right - left }) + 10;
    }

    const footerParts = [];
    if (company.reg) footerParts.push(`Reg no: ${company.reg}`);
    if (company.vat) footerParts.push(`VAT no: ${company.vat}`);
    // Drop the bottom margin so pinning the footer near the page edge doesn't
    // trigger pdfkit's automatic page break.
    pdf.page.margins.bottom = 0;
    const footerY = 788;
    pdf.fontSize(8).fillColor(GREY).font('Helvetica');
    if (footerParts.length) pdf.text(footerParts.join('   ·   '), left, footerY, { width: right - left, align: 'center', lineBreak: false });
    pdf.text(
      type === 'quote'
        ? 'This quotation is not a tax invoice. Prices valid for the period stated above.'
        : 'This is an order confirmation, not a tax invoice. Your VAT invoice follows on delivery.',
      left, footerY + 12, { width: right - left, align: 'center', lineBreak: false }
    );

    pdf.end();
  });
}

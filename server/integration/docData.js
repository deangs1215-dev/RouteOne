// Shared customer/rep/warehouse data for order and quote documents, so every
// email and PDF prints the same "To / Customer Code / Contact / Phone / Cell /
// E-mail / VAT / Address / Placed By / Warehouse" block from one place.
import { dbx } from '../db.js';

const COLS = `
  c.name AS customer_name, c.code AS customer_code, c.contact_name, c.phone AS customer_phone,
  c.email AS customer_email, c.warehouse_id AS customer_warehouse_id, c.address, c.city, c.payment_terms,
  c.ship_to_name, c.ship_to_address, c.ship_to_city, c.ship_to_postcode,
  c.onsite_contact, c.onsite_phone, c.onsite_cell, c.onsite_vat, c.onsite_address,
  u.name AS rep_name, u.email AS rep_email, u.phone AS rep_phone,
  w.code AS warehouse_code, w.name AS warehouse_name`;

// One order or quote with its customer, rep and warehouse. Orders carry their
// own warehouse snapshot; quotes use the customer's warehouse.
export async function loadDoc(kind, id) {
  if (kind === 'quote') {
    return await dbx.prepare(`
      SELECT q.*, ${COLS}
      FROM quotes q JOIN customers c ON c.id = q.customer_id
      LEFT JOIN users u ON u.id = q.rep_id
      LEFT JOIN warehouses w ON w.id = c.warehouse_id
      WHERE q.id = ?
    `).get(id);
  }
  return await dbx.prepare(`
    SELECT o.*, ${COLS}
    FROM orders o JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = o.rep_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    WHERE o.id = ?
  `).get(id);
}

const lines = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

// The display values for the customer block. Reps capture the "onsite" details
// in the app, so those win for contact/phone/VAT; SYSPRO's own fields are the
// fallback. The address is the ship-to (where the goods go), then the onsite
// address, then the main address.
export function customerDetails(doc) {
  const shipTo = [doc.ship_to_address, doc.ship_to_city, doc.ship_to_postcode].filter(Boolean);
  const address = doc.ship_to_address
    ? [doc.ship_to_address, [doc.ship_to_city, doc.ship_to_postcode].filter(Boolean).join(' ')].filter(Boolean)
    : doc.onsite_address
      ? lines(doc.onsite_address)
      : [doc.address, doc.city].filter(Boolean);
  return {
    toName: doc.customer_name || '',
    toCity: doc.city || (shipTo.length ? doc.ship_to_city : '') || '',
    code: doc.customer_code || '',
    contacts: lines(doc.onsite_contact).length ? lines(doc.onsite_contact) : lines(doc.contact_name),
    phone: doc.onsite_phone || doc.customer_phone || '',
    cell: doc.onsite_cell || '',
    email: doc.customer_email || '',
    vat: doc.onsite_vat || '',
    address,
    placedBy: doc.rep_name || '',
    warehouse: [doc.warehouse_code, doc.warehouse_name].filter(Boolean).join(' ')
  };
}

// Loads demo data for a bakery-ingredient distributor. Safe to re-run: wipes and reloads.
import bcrypt from 'bcryptjs';
import { dbx, getTodayISO } from './db.js';
import { setSetting } from './dbh.js';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Demo seeding is disabled when NODE_ENV=production.');
}

const WIPE_TABLES = ['rep_locations', 'form_submissions', 'form_templates', 'visit_photos', 'quote_items', 'quotes', 'price_rules',
  'invoices', 'order_items', 'orders', 'visits', 'customer_prices', 'customer_contacts',
  'customers', 'warehouses', 'products', 'product_categories', 'users', 'territories', 'roles', 'activity_log'];

// On SQL Server the data outlives the process, unlike the throwaway SQLite file
// this was written for, so tables that reference a wiped table (tasks, tickets,
// drafts, ...) must be emptied too or their rows would dangle - and block the
// DELETE. Found from the schema's foreign keys, transitively.
if (dbx.dialect === 'mssql') {
  const fks = await dbx.prepare('SELECT OBJECT_NAME(parent_object_id) AS child, OBJECT_NAME(referenced_object_id) AS parent FROM sys.foreign_keys').all();
  const wipe = new Set(WIPE_TABLES);
  for (let grew = true; grew;) {
    grew = false;
    for (const { child, parent } of fks) {
      if (wipe.has(parent) && !wipe.has(child)) { wipe.add(child); WIPE_TABLES.push(child); grew = true; }
    }
  }
}

// Foreign keys are switched off while the tables are emptied in any order, then
// back on. PRAGMA on SQLite (outside a transaction); NOCHECK/CHECK on SQL Server.
if (dbx.dialect === 'mssql') {
  for (const t of WIPE_TABLES) await dbx.exec(`ALTER TABLE ${t} NOCHECK CONSTRAINT ALL`);
} else {
  await dbx.exec('PRAGMA foreign_keys = OFF');
}
await dbx.transaction(async (tx) => {
  for (const t of WIPE_TABLES) {
    await tx.prepare(`DELETE FROM ${t}`).run();
    // Restart ids at 1, as on a fresh database.
    if (tx.dialect === 'mssql') await tx.exec(`IF OBJECTPROPERTY(OBJECT_ID('${t}'), 'TableHasIdentity') = 1 DBCC CHECKIDENT ('${t}', RESEED, 0)`);
    else await tx.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(t);
  }
});
if (dbx.dialect === 'mssql') {
  for (const t of WIPE_TABLES) await dbx.exec(`ALTER TABLE ${t} WITH CHECK CHECK CONSTRAINT ALL`);
} else {
  await dbx.exec('PRAGMA foreign_keys = ON');
}
await setSetting('counter_ORD', '0');
await setSetting('counter_CUS', '0');

// Roles + users -------------------------------------------------------------
const roleIds = {};
for (const name of ['admin', 'manager', 'office', 'rep', 'customer']) {
  roleIds[name] = (await dbx.prepare('INSERT INTO roles (name) VALUES (?)').run(name)).lastInsertRowid;
}

const terr = {};
for (const [name, region] of [['Cape Town North', 'Western Cape'], ['Cape Town South', 'Western Cape'], ['Winelands', 'Western Cape']]) {
  terr[name] = (await dbx.prepare('INSERT INTO territories (name, region) VALUES (?, ?)').run(name, region)).lastInsertRowid;
}

const hash = bcrypt.hashSync('demo123', 10);
const addUser = async (name, email, role, territory = null, target = 0) =>
  (await dbx.prepare('INSERT INTO users (name, email, password_hash, role_id, territory_id, sales_target) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, email, hash, roleIds[role], territory, target)).lastInsertRowid;

await addUser('Sarah Admin', 'admin@demo.co.za', 'admin');
const managerId = await addUser('Pieter Manager', 'manager@demo.co.za', 'manager');
const rep1 = await addUser('Lizl Rep', 'rep@demo.co.za', 'rep', terr['Cape Town North'], 250000);
const rep2 = await addUser('Sergio Rep', 'rep2@demo.co.za', 'rep', terr['Cape Town South'], 220000);

// Products ------------------------------------------------------------------
const cats = {};
for (const name of ['Flour & Premixes', 'Bread Improvers', 'Margarines & Fats', 'Fillings & Toppings', 'Yeast & Raising Agents']) {
  cats[name] = (await dbx.prepare('INSERT INTO product_categories (name) VALUES (?)').run(name)).lastInsertRowid;
}

const PRODUCTS = [
  ['FLR-001', 'White Bread Flour 12.5kg', 'Flour & Premixes', 'bag', '12.5kg', 189.5, 142, 480],
  ['FLR-002', 'Cake Wheat Flour 12.5kg', 'Flour & Premixes', 'bag', '12.5kg', 205.0, 155, 320],
  ['FLR-003', 'Chocolate Muffin Premix 10kg', 'Flour & Premixes', 'bag', '10kg', 465.0, 348, 150],
  ['FLR-004', 'Vanilla Cake Premix 10kg', 'Flour & Premixes', 'bag', '10kg', 452.0, 339, 140],
  ['FLR-005', 'Scone Premix 10kg', 'Flour & Premixes', 'bag', '10kg', 398.0, 300, 95],
  ['IMP-001', 'Bread Improver Gold 10kg', 'Bread Improvers', 'bag', '10kg', 520.0, 390, 210],
  ['IMP-002', 'Dough Conditioner 5kg', 'Bread Improvers', 'tub', '5kg', 315.0, 236, 130],
  ['MRG-001', 'Bakers Margarine 10kg', 'Margarines & Fats', 'box', '10kg', 425.0, 318, 260],
  ['MRG-002', 'Puff Pastry Margarine 10kg', 'Margarines & Fats', 'box', '10kg', 489.0, 366, 110],
  ['MRG-003', 'Cake Margarine 10kg', 'Margarines & Fats', 'box', '10kg', 445.0, 334, 175],
  ['FIL-001', 'Chocolate Ganache Filling 5kg', 'Fillings & Toppings', 'tub', '5kg', 385.0, 289, 85],
  ['FIL-002', 'Caramel Filling 5kg', 'Fillings & Toppings', 'tub', '5kg', 349.0, 262, 90],
  ['FIL-003', 'Strawberry Glaze 5kg', 'Fillings & Toppings', 'tub', '5kg', 298.0, 224, 70],
  ['FIL-004', 'Non-Dairy Whip Topping 1L x12', 'Fillings & Toppings', 'case', '12 x 1L', 612.0, 459, 60],
  ['YST-001', 'Instant Dry Yeast 500g x20', 'Yeast & Raising Agents', 'case', '20 x 500g', 890.0, 668, 55],
  ['YST-002', 'Baking Powder 5kg', 'Yeast & Raising Agents', 'tub', '5kg', 265.0, 199, 120],
  ['YST-003', 'Compressed Fresh Yeast 10kg', 'Yeast & Raising Agents', 'box', '10kg', 340.0, 255, 40]
];
const prodIds = [];
for (const [code, name, cat, uom, pack, price, cost, stock] of PRODUCTS) {
  prodIds.push((await dbx.prepare(`
    INSERT INTO products (code, name, category_id, uom, pack_size, list_price, cost_price, stock_qty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(code, name, cats[cat], uom, pack, price, cost, stock)).lastInsertRowid);
}

// Warehouses ------------------------------------------------------------------
const wh = {};
for (const [code, name] of [['FG', 'Cape Town — Finished Goods'], ['JHB', 'Johannesburg Distribution Centre'], ['DBN', 'Durban Depot']]) {
  wh[code] = (await dbx.prepare('INSERT INTO warehouses (code, name) VALUES (?, ?)').run(code, name)).lastInsertRowid;
}

// Customers -----------------------------------------------------------------
const CUSTOMERS = [
  ['Golden Crust Bakery', 'A', 'Cape Town North', rep1, 'Maria Santos', 'Milnerton', -33.877, 18.497, 'weekly'],
  ['Ouma se Kombuis', 'B', 'Cape Town North', rep1, 'Johan Botha', 'Durbanville', -33.830, 18.649, 'weekly'],
  ['Sunrise Superette', 'C', 'Cape Town North', rep1, 'Ahmed Khan', 'Parow', -33.900, 18.590, 'biweekly'],
  ['The Daily Loaf', 'A', 'Cape Town North', rep1, 'Grace Ndlovu', 'Bellville', -33.904, 18.629, 'weekly'],
  ['Kwikspar Plattekloof', 'B', 'Cape Town North', rep1, 'Danie Vermeulen', 'Plattekloof', -33.873, 18.577, 'weekly'],
  ['Blue Ribbon Patisserie', 'A', 'Cape Town South', rep2, 'Claire Fourie', 'Claremont', -33.981, 18.465, 'weekly'],
  ['Masithandane Bakery Co-op', 'B', 'Cape Town South', rep2, 'Nomsa Dlamini', 'Khayelitsha', -34.040, 18.677, 'weekly'],
  ['Harbour View Café', 'C', 'Cape Town South', rep2, 'Luigi Rossi', 'Kalk Bay', -34.128, 18.449, 'monthly'],
  ['Simply Bread Muizenberg', 'B', 'Cape Town South', rep2, 'Peter Abrahams', 'Muizenberg', -34.105, 18.469, 'biweekly'],
  ['Vineyard Deli & Bakery', 'A', 'Winelands', rep2, 'Elsabe du Toit', 'Stellenbosch', -33.932, 18.860, 'weekly'],
  ['Paarl Padstal', 'C', 'Winelands', rep1, 'Kobus Nel', 'Paarl', -33.734, 18.962, 'monthly'],
  ['Franschhoek Artisan Breads', 'B', 'Winelands', rep2, 'Sophie Marais', 'Franschhoek', -33.911, 19.120, 'biweekly']
];
const custIds = [];
let cusN = 0;
for (const [name, cls, t, rep, contact, city, lat, lng, freq] of CUSTOMERS) {
  cusN += 1;
  const code = `CUS-${String(cusN).padStart(5, '0')}`;
  const id = (await dbx.prepare(`
    INSERT INTO customers (code, name, classification, territory_id, rep_id, contact_name, phone, email,
      address, city, lat, lng, credit_limit, payment_terms, visit_frequency, warehouse_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(code, name, cls, terr[t], rep, contact, `+27 82 ${String(1000000 + cusN * 13579).slice(0, 7)}`,
    `orders@${name.toLowerCase().replace(/[^a-z]/g, '')}.co.za`, `${cusN * 7} Main Road`, city, lat, lng,
    cls === 'A' ? 150000 : cls === 'B' ? 75000 : 25000, '30 days', freq, wh.FG)).lastInsertRowid;
  custIds.push(id);
  await dbx.prepare('INSERT INTO customer_contacts (customer_id, name, role, phone) VALUES (?, ?, ?, ?)')
    .run(id, contact, 'Owner', `+27 82 ${String(1000000 + cusN * 13579).slice(0, 7)}`);
}
await setSetting('counter_CUS', String(cusN));

// Contract prices for the A-grade accounts (about 8% below list).
for (const custId of [custIds[0], custIds[3], custIds[5], custIds[9]]) {
  for (const prodId of prodIds.slice(0, 6)) {
    const list = (await dbx.prepare('SELECT list_price FROM products WHERE id = ?').get(prodId)).list_price;
    await dbx.prepare('INSERT INTO customer_prices (customer_id, product_id, price) VALUES (?, ?, ?)')
      .run(custId, prodId, Math.round(list * 0.92 * 100) / 100);
  }
}

// Price rules (Phase 2) -------------------------------------------------------
const addRule = dbx.prepare(`
  INSERT INTO price_rules (name, product_id, category_id, rule_type, discount_pct, fixed_price, min_qty, starts_on, ends_on)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
// Volume break: 10+ bags of any flour/premix = 5% off list.
await addRule.run('Flour volume 10+ (5% off)', null, cats['Flour & Premixes'], 'discount_pct', 5, null, 10, null, null);
// Bigger break at 25 bags.
await addRule.run('Flour volume 25+ (10% off)', null, cats['Flour & Premixes'], 'discount_pct', 10, null, 25, null, null);
// Winter promo on margarines, date-bound around today.
const today = new Date();
const promoStart = new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10);
const promoEnd = new Date(today.getTime() + 21 * 86400000).toISOString().slice(0, 10);
await addRule.run('Winter margarine promo (8% off)', null, cats['Margarines & Fats'], 'discount_pct', 8, null, 0, promoStart, promoEnd);
// Fixed clearance price on strawberry glaze.
await addRule.run('Strawberry glaze clearance', prodIds[12], null, 'fixed_price', null, 249, 0, null, null);

// Form templates (Phase 2) ----------------------------------------------------
const addForm = dbx.prepare('INSERT INTO form_templates (name, description, fields) VALUES (?, ?, ?)');
await addForm.run('Shelf & stock check', 'Capture shelf presence and competitor activity at the customer.', JSON.stringify([
  { key: 'our_products_on_shelf', label: 'Our products visible on shelf?', type: 'checkbox' },
  { key: 'shelf_share_pct', label: 'Estimated shelf share (%)', type: 'number', required: true },
  { key: 'competitor_brands', label: 'Competitor brands present', type: 'text' },
  { key: 'stock_condition', label: 'Stock condition', type: 'select', options: ['Good', 'Low', 'Out of stock', 'Damaged'], required: true },
  { key: 'shelf_photo', label: 'Shelf photo', type: 'photo' }
]));
await addForm.run('Customer complaint', 'Log a product or delivery complaint raised during a visit.', JSON.stringify([
  { key: 'complaint_type', label: 'Complaint type', type: 'select', options: ['Product quality', 'Delivery', 'Pricing', 'Service', 'Other'], required: true },
  { key: 'product_code', label: 'Product code (if applicable)', type: 'text' },
  { key: 'description', label: 'Description', type: 'text', required: true },
  { key: 'photo', label: 'Photo evidence', type: 'photo' },
  { key: 'requires_credit', label: 'Credit/return requested?', type: 'checkbox' }
]));
await addForm.run('New customer survey', 'First-visit survey for onboarding a prospective customer.', JSON.stringify([
  { key: 'business_type', label: 'Business type', type: 'select', options: ['Bakery', 'Café', 'Supermarket', 'Caterer', 'Other'], required: true },
  { key: 'weekly_flour_usage', label: 'Weekly flour usage (bags)', type: 'number' },
  { key: 'current_supplier', label: 'Current supplier', type: 'text' },
  { key: 'interested_products', label: 'Products interested in', type: 'text' },
  { key: 'storefront_photo', label: 'Storefront photo', type: 'photo' }
]));

// Historic visits + orders over the last 60 days -----------------------------
const rand = (n) => Math.floor(Math.random() * n);
const custRep = (i) => CUSTOMERS[i][3];
let ordN = 0;

const insertOrder = dbx.prepare(`
  INSERT INTO orders (number, customer_id, rep_id, visit_id, warehouse_id, status, order_date, subtotal, vat_amount, total, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertItem = dbx.prepare(`
  INSERT INTO order_items (order_id, product_id, product_name, qty, uom, unit_price, discount_pct, line_total)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

for (let day = 60; day >= 0; day--) {
  const date = new Date(Date.now() - day * 86400000).toISOString().slice(0, 10);
  const dow = new Date(date).getDay();
  if (dow === 0 || dow === 6) continue; // weekends off

  // Each weekday: 3-5 visits spread across customers.
  const visitCount = 3 + rand(3);
  const visited = new Set();
  for (let i = 0; i < visitCount; i++) {
    const ci = rand(custIds.length);
    if (visited.has(ci)) continue;
    visited.add(ci);
    const custId = custIds[ci];
    const repId = custRep(ci);
    const inH = 8 + rand(8);
    const checkIn = `${date} ${String(inH).padStart(2, '0')}:${String(rand(60)).padStart(2, '0')}:00`;
    const checkOut = `${date} ${String(inH + 1).padStart(2, '0')}:${String(rand(60)).padStart(2, '0')}:00`;
    const placesOrder = Math.random() < 0.7;
    const isToday = day === 0;
    const visitId = (await dbx.prepare(`
      INSERT INTO visits (customer_id, rep_id, planned_date, purpose, status, check_in_at, check_in_lat, check_in_lng,
        check_out_at, check_out_lat, check_out_lng, outcome, notes)
      VALUES (?, ?, ?, 'sales call', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      custId, repId, date,
      isToday ? 'planned' : 'completed',
      isToday ? null : checkIn, isToday ? null : CUSTOMERS[ci][6], isToday ? null : CUSTOMERS[ci][7],
      isToday ? null : checkOut, isToday ? null : CUSTOMERS[ci][6], isToday ? null : CUSTOMERS[ci][7],
      isToday ? null : (placesOrder ? 'order' : 'no_order'),
      isToday ? null : (placesOrder ? 'Stock levels checked, order placed.' : 'No order needed this cycle.')
    )).lastInsertRowid;

    if (!placesOrder || isToday) continue;

    // Build an order of 2-5 lines.
    ordN += 1;
    const orderId = (await insertOrder.run(
      `ORD-${String(ordN).padStart(5, '0')}`, custId, repId, visitId, wh.FG,
      day < 2 ? 'submitted' : day < 7 ? 'processing' : 'invoiced',
      checkOut, 0, 0, 0, null
    )).lastInsertRowid;
    let subtotal = 0;
    const lines = 2 + rand(4);
    const used = new Set();
    for (let l = 0; l < lines; l++) {
      const pi = rand(prodIds.length);
      if (used.has(pi)) continue;
      used.add(pi);
      const prod = await dbx.prepare('SELECT * FROM products WHERE id = ?').get(prodIds[pi]);
      const contract = await dbx.prepare('SELECT price FROM customer_prices WHERE customer_id = ? AND product_id = ?').get(custId, prod.id);
      const price = contract ? contract.price : prod.list_price;
      const qty = 1 + rand(8);
      const lineTotal = Math.round(qty * price * 100) / 100;
      subtotal += lineTotal;
      await insertItem.run(orderId, prod.id, prod.name, qty, prod.uom, price, 0, lineTotal);
    }
    const vat = Math.round(subtotal * 0.15 * 100) / 100;
    await dbx.prepare('UPDATE orders SET subtotal = ?, vat_amount = ?, total = ? WHERE id = ?')
      .run(Math.round(subtotal * 100) / 100, vat, Math.round((subtotal + vat) * 100) / 100, orderId);
  }
}
await setSetting('counter_ORD', String(ordN));

// A few open quotes (Phase 2) -------------------------------------------------
let quoN = 0;
const insertQuote = dbx.prepare(`
  INSERT INTO quotes (number, customer_id, rep_id, status, quote_date, valid_until, subtotal, vat_amount, total, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertQuoteItem = dbx.prepare(`
  INSERT INTO quote_items (quote_id, product_id, product_name, qty, uom, unit_price, discount_pct, line_total)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const [ci, daysAgo, status] of [[3, 2, 'sent'], [5, 5, 'sent'], [7, 12, 'rejected'], [10, 1, 'sent']]) {
  quoN += 1;
  const qDate = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10) + ' 10:30:00';
  const validUntil = new Date(Date.now() + (14 - daysAgo) * 86400000).toISOString().slice(0, 10);
  const quoteId = (await insertQuote.run(`QUO-${String(quoN).padStart(5, '0')}`, custIds[ci], custRep(ci), status, qDate, validUntil, 0, 0, 0, null)).lastInsertRowid;
  let subtotal = 0;
  for (let l = 0; l < 2 + rand(3); l++) {
    const prod = await dbx.prepare('SELECT * FROM products WHERE id = ?').get(prodIds[rand(prodIds.length)]);
    const qty = 2 + rand(10);
    const lineTotal = Math.round(qty * prod.list_price * 100) / 100;
    subtotal += lineTotal;
    await insertQuoteItem.run(quoteId, prod.id, prod.name, qty, prod.uom, prod.list_price, 0, lineTotal);
  }
  const vat = Math.round(subtotal * 0.15 * 100) / 100;
  await dbx.prepare('UPDATE quotes SET subtotal = ?, vat_amount = ?, total = ? WHERE id = ?')
    .run(Math.round(subtotal * 100) / 100, vat, Math.round((subtotal + vat) * 100) / 100, quoteId);
}
await setSetting('counter_QUO', String(quoN));

// Customer portal login (Phase 5): Maria at Golden Crust Bakery ---------------
await dbx.prepare('INSERT INTO users (name, email, password_hash, role_id, customer_id) VALUES (?, ?, ?, ?, ?)')
  .run('Maria Santos', 'customer@demo.co.za', hash, roleIds.customer, custIds[0]);

// Route order for today's planned visits + rep positions (Phase 3) ------------
for (const repId of [rep1, rep2]) {
  const todays = await dbx.prepare(
    "SELECT id FROM visits WHERE rep_id = ? AND status = 'planned' AND date(planned_date) = date('now') ORDER BY id"
  ).all(repId);
  for (const [i, v] of todays.entries()) {
    await dbx.prepare('UPDATE visits SET route_order = ? WHERE id = ?').run(i + 1, v.id);
  }
}
// Last known positions: Lizl near Milnerton, Sergio near Claremont.
await dbx.prepare('INSERT INTO rep_locations (user_id, lat, lng) VALUES (?, ?, ?)').run(rep1, -33.885, 18.51);
await dbx.prepare('INSERT INTO rep_locations (user_id, lat, lng) VALUES (?, ?, ?)').run(rep2, -33.975, 18.47);

// Demo invoices from "SYSPRO" (Phase 5): 2-4 per customer within the last 30
// days, mixed paid/outstanding/overdue. Stands in for the invoice sync feed.
const insertInvoice = dbx.prepare(`
  INSERT INTO invoices (number, customer_id, customer_code, order_number, invoice_date, due_date,
    subtotal, vat_amount, total, amount_paid, balance, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const todayStr = getTodayISO();
let invN = 90000;
for (const custId of custIds) {
  const cust = await dbx.prepare('SELECT code FROM customers WHERE id = ?').get(custId);
  const n = 2 + rand(3);
  for (let i = 0; i < n; i++) {
    invN += 1;
    const daysAgo = 1 + rand(29);
    const termDays = [7, 14, 30][rand(3)];
    const invoiceDate = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
    const dueDate = new Date(Date.now() - (daysAgo - termDays) * 86400000).toISOString().slice(0, 10);
    const subtotal = Math.round((1500 + rand(14000)) * 100) / 100;
    const vat = Math.round(subtotal * 0.15 * 100) / 100;
    const total = Math.round((subtotal + vat) * 100) / 100;
    const roll = Math.random();
    const amountPaid = roll < 0.45 ? total : roll < 0.6 ? Math.round(total * 0.5 * 100) / 100 : 0;
    const balance = Math.round((total - amountPaid) * 100) / 100;
    const status = balance <= 0.005 ? 'paid' : dueDate < todayStr ? 'overdue' : 'outstanding';
    await insertInvoice.run(`INV-${invN}`, custId, cust.code, `SO-${44000 + rand(900)}`,
      invoiceDate, dueDate, subtotal, vat, total, amountPaid, balance, status);
  }
}

console.log('Seeded demo data:');
console.log(`  ${CUSTOMERS.length} customers, ${PRODUCTS.length} products, ${ordN} orders, ${quoN} quotes`);
console.log(`  ${invN - 90000} invoices, 4 price rules, 3 form templates`);
console.log('  Logins (password demo123):');
console.log('    admin@demo.co.za    - Admin');
console.log('    manager@demo.co.za  - Sales Manager');
console.log('    rep@demo.co.za      - Field Rep (Lizl)');
console.log('    rep2@demo.co.za     - Field Rep (Sergio)');
console.log('    customer@demo.co.za - Customer portal (Golden Crust Bakery)');

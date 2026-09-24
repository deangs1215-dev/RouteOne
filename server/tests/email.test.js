// The email builders and their PDF/doc loaders query the database, so after the
// async migration every caller has to await them. A missed await turns a draft
// into a Promise, and spreading one ({ ...draft }) silently yields {} - an email
// with no subject or body. These tests build each email from real rows.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeone-email-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
process.env.SECRET_KEY ||= 'a'.repeat(64);
const { dbx, closeDb } = await import('../db.js');
const { resetBackend } = await import('./backend.js');
await resetBackend(dbx);
const email = await import('../integration/email.js');
const { loadDoc } = await import('../integration/docData.js');

after(() => { closeDb(); fs.rmSync(tempDir, { recursive: true, force: true }); });

let ids;
const insert = async (sql, ...p) => (await dbx.prepare(sql).run(...p)).lastInsertRowid;

test('fixture', async () => {
  const wh = await insert("INSERT INTO warehouses (code, name) VALUES ('FG', 'Cape Town')");
  const role = await insert("INSERT INTO roles (name) VALUES ('rep')");
  const rep = await insert("INSERT INTO users (name, email, password_hash, role_id, warehouse_id) VALUES ('Rita Rep', 'rita@x.co', 'x', ?, ?)", role, wh);
  const cust = await insert("INSERT INTO customers (code, name, email, warehouse_id, rep_id) VALUES ('C1', 'Golden Crust', 'buyer@gc.co', ?, ?)", wh, rep);
  const prod = await insert("INSERT INTO products (code, name, list_price) VALUES ('P1', 'Flour 12.5kg', 100)");
  const order = await insert("INSERT INTO orders (number, customer_id, rep_id, warehouse_id, status, subtotal, vat_amount, total) VALUES ('ORD-00001', ?, ?, ?, 'submitted', 100, 15, 115)", cust, rep, wh);
  await insert('INSERT INTO order_items (order_id, product_id, product_name, qty, unit_price, line_total) VALUES (?, ?, ?, 2, 50, 100)', order, prod, 'Flour 12.5kg');
  const quote = await insert("INSERT INTO quotes (number, customer_id, rep_id, subtotal, vat_amount, total) VALUES ('QUO-00001', ?, ?, 100, 15, 115)", cust, rep);
  await insert('INSERT INTO quote_items (quote_id, product_id, product_name, qty, unit_price, line_total) VALUES (?, ?, ?, 2, 50, 100)', quote, prod, 'Flour 12.5kg');
  const ticket = await insert("INSERT INTO support_tickets (created_by, subject, description, category, priority, status) VALUES (?, 'App slow', 'Very', 'other', 'normal', 'open')", rep);
  ids = { order, quote, ticket, rep };
});

const complete = (draft, label) => {
  assert.ok(draft && typeof draft.then !== 'function', `${label}: still a Promise`);
  assert.ok(draft.subject && draft.subject.length > 3, `${label}: subject`);
  assert.ok(draft.body_html && draft.body_html.includes('<'), `${label}: body`);
  assert.ok('to_addr' in draft, `${label}: to_addr`);
};

test('order and quote emails build from real rows', async () => {
  const orderEmail = await email.buildOrderEmail(ids.order);
  complete(orderEmail, 'order');
  assert.match(orderEmail.body_html, /ORD-00001/);
  assert.match(orderEmail.body_html, /Golden Crust/);
  const confirmation = await email.buildOrderConfirmationEmail(ids.order);
  complete(confirmation, 'confirmation');
  assert.equal(confirmation.to_addr, 'buyer@gc.co');
  const quoteEmail = await email.buildQuoteEmail(ids.quote);
  complete(quoteEmail, 'quote');
  assert.match(quoteEmail.body_html, /QUO-00001/);
  // The spread the routes use for extra recipients must keep the content.
  const spread = { ...(await email.buildOrderEmail(ids.order)), cc_addr: null, to_addr: 'extra@x.co' };
  complete(spread, 'spread order');
  assert.equal(spread.to_addr, 'extra@x.co');
});

test('support ticket, digest, sync digest and credential emails build', async () => {
  complete(await email.buildSupportTicketEmail(ids.ticket), 'ticket');
  complete(await email.buildRepDigestEmail({ id: ids.rep, name: 'Rita Rep', email: 'rita@x.co' },
    { yesterdayOrders: [], today: { visits: [], stats: {} } }), 'rep digest');
  complete(await email.buildSyncDigestEmail([{ entity: 'customers', status: 'completed', rows_read: 1, rows_upserted: 1, rows_skipped: 0 }], { toAddr: 'a@x.co' }), 'sync digest');
  complete(await email.buildPasswordResetEmail({ name: 'Rita', email: 'rita@x.co' }, 'http://x/reset'), 'reset');
  complete(await email.buildLoginDetailsEmail({ name: 'Rita', email: 'rita@x.co' }, 'Temp-Pass-1'), 'login details');
});

test('loadDoc, company details and sendEmail (logged even with no transport)', async () => {
  const order = await loadDoc('order', ids.order);
  assert.equal(order.number, 'ORD-00001');
  assert.equal((await loadDoc('quote', ids.quote)).number, 'QUO-00001');
  assert.ok(await email.companyDetails());
  const result = await email.sendEmail(await email.buildOrderEmail(ids.order));
  assert.ok(result);
  const logged = await dbx.prepare("SELECT COUNT(*) AS n FROM email_log WHERE kind = 'order'").get();
  assert.equal(logged.n, 1);
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeone-sync-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
process.env.SECRET_KEY ||= 'a'.repeat(64);
const { dbx, closeDb } = await import('../db.js');
const { runSync, matchRep } = await import('../integration/sync.js');

after(() => { closeDb(); fs.rmSync(tempDir, { recursive: true, force: true }); });

const count = async (table) => (await dbx.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n;
const provider = (rows) => ({ fetch: async () => rows });
const DEMO = ['warehouses', 'customers', 'products', 'stock', 'customer_pricing'];

test('demo entities sync and are idempotent on a second run', async () => {
  for (const entity of DEMO) {
    const first = await runSync(entity);
    // Demo stock includes FLR-002, which only exists in a seeded database - on
    // this fresh one that row must fail with "unknown product code", once.
    const expectedErrors = entity === 'stock' ? 1 : 0;
    assert.equal(first.row_errors, expectedErrors, `${entity}: ${JSON.stringify(first)}`);
  }
  const snapshot = async () => ({
    warehouses: await count('warehouses'), customers: await count('customers'),
    products: await count('products'), stock: await count('product_stock'),
    pricing: await count('syspro_customer_pricing')
  });
  const before = await snapshot();
  assert.equal(before.customers, 3);
  assert.equal(before.pricing, 2);
  for (const entity of DEMO) await runSync(entity);
  assert.deepEqual(await snapshot(), before);

  const flour = await dbx.prepare("SELECT stock_qty FROM products WHERE code = 'FLR-001'").get();
  assert.equal(flour.stock_qty, 512);
  const price = await dbx.prepare("SELECT contract_price, synced_at FROM syspro_customer_pricing WHERE product_code = 'SYS-P001'").get();
  assert.equal(price.contract_price, 265);
  assert.ok(price.synced_at);
  const runs = await dbx.prepare("SELECT status, finished_at FROM sync_runs WHERE entity = 'customers'").all();
  assert.ok(runs.length === 2 && runs.every((r) => r.status === 'completed' && r.finished_at));
});

test('customers update in place, and on-hold follows SYSPRO', async () => {
  const c = { code: 'GOLD001', name: 'Renamed Bakery', warehouse_code: 'FG', rep_code: '140', credit_limit: 1, balance: 2, on_hold: 1 };
  await runSync('customers', { provider: provider([c]) });
  const row = await dbx.prepare("SELECT name, credit_limit, status FROM customers WHERE code = 'GOLD001'").get();
  assert.deepEqual({ ...row }, { name: 'Renamed Bakery', credit_limit: 1, status: 'on_hold' });
  assert.equal(await count('customers'), 3);
});

test('matchRep resolves on trimmed branch + rep code', async () => {
  const wh = await dbx.prepare("SELECT id FROM warehouses WHERE code = 'FG'").get();
  const role = (await dbx.prepare("INSERT INTO roles (name) VALUES ('rep')").run()).lastInsertRowid;
  const u = await dbx.prepare("INSERT INTO users (name, email, password_hash, role_id, warehouse_id, rep_code, active) VALUES ('R','r@x.co','x',?,?,'140',1)").run(role, wh.id);
  assert.equal(await matchRep('FG  ', ' 140 '), u.lastInsertRowid);
  assert.equal(await matchRep('FG', '999'), null);
  assert.equal(await matchRep('', '140'), null);
});

test('rep_sales and customer_sales sum within a run and rebuild on the next', async () => {
  const repRows = [
    { TrnYear: 2026, TrnMonth: 3, CustomerBranch: 'FG', 'Customer SalesPerson': '140', NSV: 100 },
    { TrnYear: 2026, TrnMonth: 3, CustomerBranch: 'FG', 'Customer SalesPerson': '140', NSV: 50.5 },
    { TrnYear: 2026, TrnMonth: 3, CustomerBranch: 'FG', 'Customer SalesPerson': 'nobody', NSV: 999 }
  ];
  const res = await runSync('rep_sales', { provider: provider(repRows) });
  assert.equal(res.rows_upserted, 2);
  assert.equal(res.rows_skipped, 1);
  await runSync('rep_sales', { provider: provider(repRows) });
  const sales = await dbx.prepare('SELECT month, sales_value FROM rep_monthly_sales').all();
  assert.deepEqual(sales.map((r) => ({ ...r })), [{ month: '2026-03', sales_value: 150.5 }]);

  const custRows = [
    { customer_code: 'GOLD001', trn_year: 2026, trn_month: 4, nsv: 10 },
    { customer_code: 'GOLD001', trn_year: 2026, trn_month: 4, nsv: 5 },
    { customer_code: '', trn_year: 2026, trn_month: 4, nsv: 1 }
  ];
  const cres = await runSync('customer_sales', { provider: provider(custRows) });
  assert.equal(cres.rows_skipped, 1);
  assert.equal((await dbx.prepare('SELECT sales_value FROM customer_monthly_sales').get()).sales_value, 15);
});

test('invoices upsert by number; invoice_lines rebuild and resolve products and delivery stores', async () => {
  const inv = (total) => ({ number: 'INV1', customer_code: 'GOLD001', invoice_date: '2026-03-01', due_date: '2026-03-31', subtotal: 100, vat_amount: 15, total, amount_paid: 0 });
  await runSync('invoices', { provider: provider([inv(0)]) });
  await runSync('invoices', { provider: provider([inv(115)]) });
  const invoices = await dbx.prepare('SELECT total, balance, status FROM invoices').all();
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].total, 115);

  const lines = [
    { invoice_number: 'INV1', product_code: 'FLR-001', qty: 2, unit_price: 50, line_total: 100, delivery_customer_code: 'SYS-NEW01' },
    { invoice_number: 'INV1', product_code: 'FLR-001', qty: 1, unit_price: 50, line_total: 50 },
    { invoice_number: 'MISSING', product_code: 'FLR-001', qty: 1, unit_price: 1, line_total: 1 }
  ];
  const res = await runSync('invoice_lines', { provider: provider(lines) });
  assert.equal(res.rows_upserted, 2);
  assert.equal(res.rows_skipped, 1);
  await runSync('invoice_lines', { provider: provider(lines) });
  assert.equal(await count('invoice_items'), 2);
  const delivered = await dbx.prepare("SELECT delivery_customer_id FROM invoice_items WHERE delivery_customer_code = 'SYS-NEW01'").get();
  const store = await dbx.prepare("SELECT id FROM customers WHERE code = 'SYS-NEW01'").get();
  assert.equal(delivered.delivery_customer_id, store.id);
});

test('a failing fetch marks the run failed and releases the entity', async () => {
  const bad = { fetch: async () => { throw new Error('view offline'); } };
  await assert.rejects(runSync('warehouses', { provider: bad }), /view offline/);
  const run = await dbx.prepare("SELECT status, error FROM sync_runs WHERE entity = 'warehouses' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual({ ...run }, { status: 'failed', error: 'view offline' });
  await runSync('warehouses'); // not stuck "already running"
});

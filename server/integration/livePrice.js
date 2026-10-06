// Live SYSPRO price check for order submit.
//
// RouteOne prices an order from syspro_customer_pricing, which is only as fresh
// as the last sync (contracts every 15 minutes, price codes twice a day). An
// order for ORD-00272 was priced from data that was missing a contract SYSPRO
// already had, and the rep quoted - and the customer signed - the wrong total.
// So at submit the server asks SYSPRO itself, for just this customer and just
// these products, and compares with what the rep was shown.
//
// This module only fetches and resolves; deciding whether a difference stops
// the order lives in routes/orders.routes.js.
//
// Failure policy: if SYSPRO cannot be reached or is slow, the order proceeds on
// the stored (at most 15-minute-old) prices and the lookup reports
// status 'unavailable' so it can be logged. Refusing every order whenever
// SYSPRO has a slow moment would stop the reps working, which costs more than
// the narrow window this leaves.
import fs from 'node:fs';
import sql from 'mssql';
import { getSetting, sysproTierPrice } from '../dbh.js';
import { sysproConfig } from './providers.js';

const VIEW_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Test hooks: replace the SYSPRO round trip. (customerCode, productCodes) => Map(code -> row).
//  - setLivePriceLookup(fn): in-process tests.
//  - LIVE_PRICE_TEST_FILE: for tests that run the real server as a child process.
//    Only honoured when NODE_ENV === 'test'. The file holds
//    { "<customer>": { "<product>": { ...view columns } } }, or { "__fail": "msg" }
//    to simulate SYSPRO being unreachable, and is re-read on every lookup so a
//    test can change SYSPRO's "answer" between requests.
let injectedLookup = null;
export function setLivePriceLookup(fn) { injectedLookup = fn; }

async function lookupFromTestFile(customerCode, productCodes) {
  const data = JSON.parse(await fs.promises.readFile(process.env.LIVE_PRICE_TEST_FILE, 'utf8'));
  if (data.__fail) throw new Error(data.__fail);
  const rows = new Map();
  for (const code of productCodes) if (data[customerCode]?.[code]) rows.set(code, data[customerCode][code]);
  return rows;
}
const testFileActive = () => process.env.NODE_ENV === 'test' && !!process.env.LIVE_PRICE_TEST_FILE;

async function lookupFromSyspro(customerCode, productCodes, timeoutMs) {
  const cfg = await sysproConfig();
  if (!cfg.host || !cfg.database || !cfg.user) throw new Error('SYSPRO connection is not configured');
  // The view that carries all three tiers. Defaults to the one the main sync
  // reads (so both always mean the same thing); a dedicated faster view can be
  // named in settings without touching the sync.
  const viewName = (await getSetting('syspro_view_live_pricing', '')) || cfg.views.customer_pricing;
  const parts = String(viewName).split('.');
  if (parts.length > 2 || parts.some((p) => !VIEW_NAME.test(p))) throw new Error('Invalid live pricing view name');
  const quotedView = parts.map((p) => `[${p}]`).join('.');

  // Its own pool, never the shared global one the syncs use: closing it can
  // never cut a sync off mid-read.
  const pool = new sql.ConnectionPool({
    server: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password,
    options: { encrypt: cfg.encrypt, trustServerCertificate: cfg.trustServerCertificate },
    pool: { max: 1 }, connectionTimeout: Math.min(timeoutMs, 5000), requestTimeout: timeoutMs
  });
  await pool.connect();
  try {
    const request = pool.request();
    request.input('customer', sql.NVarChar(20), String(customerCode));
    const names = productCodes.map((code, i) => {
      request.input(`p${i}`, sql.NVarChar(40), String(code));
      return `@p${i}`;
    });
    const result = await request.query(
      'SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; ' +
      'SELECT customer_code, product_code, contract_price, contract_start_date, contract_end_date, ' +
      'buying_group_price, buying_group_start_date, buying_group_end_date, price_code_price ' +
      `FROM ${quotedView} WHERE customer_code = @customer AND product_code IN (${names.join(', ')})`
    );
    const rows = new Map();
    for (const r of result.recordset) {
      const code = String(r.product_code).trim();
      // A pair should appear once; if a view ever returns two, keep the one that
      // carries a contract price rather than whichever came first.
      if (!rows.has(code) || (r.contract_price != null && rows.get(code).contract_price == null)) rows.set(code, r);
    }
    return rows;
  } finally {
    await pool.close();
  }
}

// products: [{ id, code, conv_factor_alt_uom, pack_weight_kg }]
// Returns { status, prices, error? }:
//   status 'ok'          prices: Map(productId -> { price, source }) for every product
//                        SYSPRO has a tier for (others fall back to RouteOne's own rules)
//   status 'skipped'     check is switched off, or the data source is not SYSPRO
//   status 'unavailable' SYSPRO did not answer in time; prices is empty
export async function liveOrderPrices(customerCode, products) {
  const none = (status, error) => ({ status, prices: new Map(), ...(error ? { error } : {}) });
  const override = injectedLookup || (testFileActive() ? lookupFromTestFile : null);
  if (!override) {
    if (await getSetting('live_price_check', 'on') === 'off') return none('skipped');
    if (await getSetting('intg_source', 'demo') !== 'syspro') return none('skipped');
  }
  if (!customerCode || !products.length) return none('skipped');
  const timeoutMs = Number(await getSetting('live_price_timeout_ms', '8000')) || 8000;
  const codes = [...new Set(products.map((p) => p.code))];
  try {
    const lookup = override || ((c, p) => lookupFromSyspro(c, p, timeoutMs));
    let timer;
    const rows = await Promise.race([
      lookup(customerCode, codes),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`SYSPRO did not answer within ${timeoutMs} ms`)), timeoutMs + 1000); })
    ]).finally(() => clearTimeout(timer));
    const prices = new Map();
    for (const product of products) {
      const tier = sysproTierPrice(rows.get(String(product.code).trim()) ?? null, product);
      if (tier) prices.set(product.id, tier);
    }
    return { status: 'ok', prices };
  } catch (e) {
    console.warn(`[live-price] SYSPRO check unavailable for ${customerCode}: ${e.message}`);
    return none('unavailable', e.message);
  }
}

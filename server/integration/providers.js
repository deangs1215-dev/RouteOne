// Data providers for the ERP sync. Two sources:
//  - 'syspro': reads the SQL views exposed on the SYSPRO database (created by
//    the SYSPRO consultant/DBA - see docs/SYSPRO-INTEGRATION.md). Read-only.
//  - 'demo': built-in sample rows so the whole pipeline can be exercised
//    before the SYSPRO views/login exist.
//
// Every provider returns plain row arrays in the app's canonical shape:
//  warehouses: { code, name }
//  customers: { code, name, contact_name, phone, email, address, city, credit_limit, balance, payment_terms, on_hold, warehouse_code, rep_code, rep_warehouse_code }
//  products:  { code, name, category, description, uom, pack_size, list_price, cost_price }
//  stock:     { code, warehouse_code, qty_available }  (one row per product per branch)
//  prices:    { customer_code, product_code, price }   (contract prices)
//  invoices:  { number, customer_code, order_number, invoice_date, due_date, subtotal, vat_amount, total, amount_paid, balance, status }
//  invoice_lines: { invoice_number, product_code, qty, unit_price, line_total } - one row per invoice line, last 30 days only
//  rep_sales: { TrnYear, TrnMonth, TrnBranch, CustomerBranch, 'Customer SalesPerson', 'Customer SP name', NSV } - one row per rep per month per branch
//  customer_sales: { customer_code, trn_year, trn_month, nsv } - one row per customer per month, ex-VAT, last 13 months
import { getSetting } from '../db.js';
import { decryptSecret } from '../crypto.js';

// overrides lets "Test connection" check the values currently typed in the
// form (not yet saved) instead of only ever testing the last-saved settings.
// A blank overridden password means "keep using the saved one", matching the
// "type to replace" pattern the field already shows.
export function sysproConfig(overrides = {}) {
  const port = parseInt(overrides.syspro_port ?? getSetting('syspro_port', '1433'), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SYSPRO SQL port');
  return {
    host: overrides.syspro_host ?? getSetting('syspro_host', ''),
    port,
    database: overrides.syspro_db ?? getSetting('syspro_db', ''),
    user: overrides.syspro_user ?? getSetting('syspro_user', ''),
    password: overrides.syspro_password ? overrides.syspro_password : decryptSecret(getSetting('syspro_password', '')),
    encrypt: (overrides.syspro_encrypt ?? getSetting('syspro_encrypt', '1')) !== '0',
    trustServerCertificate: (overrides.syspro_trust_server_certificate ?? getSetting('syspro_trust_server_certificate', '0')) === '1',
    // '|| default' (not just getSetting's own fallback) because saving the
    // settings form always writes an explicit '' for every view field, even
    // ones left blank - getSetting's fallback only fires when no row exists
    // at all, so a saved-but-empty value would otherwise shadow the default.
    views: {
      warehouses: getSetting('syspro_view_warehouses', '') || 'vw_FS_Warehouses',
      customers: getSetting('syspro_view_customers', '') || 'vw_FS_Customers',
      products: getSetting('syspro_view_products', '') || 'vw_FS_Products',
      stock: getSetting('syspro_view_stock', '') || 'vw_FS_Stock',
      customer_pricing: getSetting('syspro_view_customer_pricing', '') || 'vw_FS_CustomerPricing_ContractBuyingGroup',
      invoices: getSetting('syspro_view_invoices', '') || 'vw_FS_Invoices',
      invoice_lines: getSetting('syspro_view_invoice_lines', '') || 'vw_FS_InvoiceLines',
      rep_sales: getSetting('syspro_view_rep_sales', '') || 'vw_FS_RepSalesByMonth',
      customer_sales: getSetting('syspro_view_customer_sales', '') || 'vw_FS_CustomerSalesByMonth'
    }
  };
}

// requestTimeout is per-call: most views answer in seconds, but the big ones
// (customer_pricing is ~13M rows, stock/invoices are large too) can take many
// minutes on a busy SYSPRO box. A blanket-high timeout would mask a genuinely
// stuck connection on a small view, so callers pass what that entity needs.
async function sysproPool(overrides, requestTimeout = 60000) {
  const sql = (await import('mssql')).default;
  const cfg = sysproConfig(overrides);
  if (!cfg.host || !cfg.database || !cfg.user) {
    throw new Error('SYSPRO connection is not configured (host, database, user are required)');
  }
  return sql.connect({
    server: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    options: {
      encrypt: cfg.encrypt,
      trustServerCertificate: cfg.trustServerCertificate
    },
    pool: { max: 2 },
    connectionTimeout: 10000,
    requestTimeout
  });
}

// The views present app-friendly column names already (see the doc), so the
// queries stay dumb on purpose: SELECT * FROM <view>.
const sysproProvider = {
  // overrides (optional): test the values currently on the settings form,
  // even if "Save settings" hasn't been clicked yet.
  async test(overrides) {
    const pool = await sysproPool(overrides);
    const result = await pool.request().query('SELECT 1 AS ok');
    await pool.close();
    return result.recordset[0].ok === 1;
  },
  async fetch(entity) {
    const cfg = sysproConfig();
    const view = cfg.views[entity];
    const parts = String(view || '').split('.');
    if (!parts.length || parts.length > 2 ||
        parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
      throw new Error(`Invalid view name for ${entity}`);
    }
    const quotedView = parts.map((part) => `[${part}]`).join('.');
    const limits = {
      warehouses: 10000,
      customers: 500000,
      products: 500000,
      stock: 1000000,
      customer_pricing: 5000000,  // increased from 1M to handle ~13M SYSPRO view (will fetch TOP 5M)
      invoices: 1000000,
      invoice_lines: 500000,
      rep_sales: 200000,
      customer_sales: 500000
    };
    const limit = limits[entity];
    if (!limit) throw new Error(`Unknown SYSPRO entity ${entity}`);
    // Big views need far longer than the 60s default - customer_pricing alone
    // is millions of rows and has been measured at ~20 min on a good run, so
    // it gets 45 min of headroom for a busier SYSPRO box. Small reference
    // views keep the short timeout so a hung connection surfaces quickly
    // instead of blocking for the better part of an hour.
    const timeouts = {
      customer_pricing: 2700000, // 45 min (~20 min observed, generous headroom)
      stock: 900000,             // 15 min
      invoices: 900000,
      invoice_lines: 600000,     // 10 min - only a 30-day window, but ArTrnDetail itself is huge
      products: 600000,          // 10 min
      customers: 600000,
      rep_sales: 600000,
      customer_sales: 600000
    };
    const pool = await sysproPool(undefined, timeouts[entity] ?? 60000);
    try {
      const result = await pool.request().query(`SELECT TOP (${limit + 1}) * FROM ${quotedView}`);
      if (result.recordset.length > limit) {
        throw new Error(`${entity} view exceeds the ${limit.toLocaleString()} row safety limit; narrow the DBA view before syncing`);
      }
      return result.recordset;
    } finally {
      await pool.close();
    }
  }
};

const DEMO_ROWS = {
  warehouses: [
    { code: 'FG', name: 'Cape Town — Finished Goods' },
    { code: 'JHB', name: 'Johannesburg Distribution Centre' },
    { code: 'DBN', name: 'Durban Depot' }
  ],
  customers: [
    { code: 'GOLD001', name: 'Golden Crust Bakery', contact_name: 'Maria Santos', phone: '+27 82 1013579', email: 'orders@goldencrustbakery.co.za', address: '7 Main Road', city: 'Milnerton', credit_limit: 160000, balance: 42350.5, payment_terms: '30 days', on_hold: 0, warehouse_code: 'FG', rep_code: '140' },
    { code: 'SYS-NEW01', name: 'Atlantic Foods Wholesale', contact_name: 'Brian Adams', phone: '+27 21 555 0199', email: 'buying@atlanticfoods.co.za', address: '14 Marine Drive', city: 'Paarden Eiland', credit_limit: 200000, balance: 0, payment_terms: '30 days', on_hold: 0, warehouse_code: 'FG', rep_code: '120' },
    { code: 'SYS-NEW02', name: 'Boland Bake House', contact_name: 'Annelie Smit', phone: '+27 21 555 0242', email: 'info@bolandbake.co.za', address: '3 Kerk Street', city: 'Wellington', credit_limit: 50000, balance: 12800, payment_terms: '7 days', on_hold: 1, warehouse_code: 'FG', rep_code: '140' }
  ],
  products: [
    { code: 'FLR-001', name: 'White Bread Flour 12.5kg', category: 'Flour & Premixes', description: null, uom: 'bag', pack_size: '12.5kg', list_price: 192.75, cost_price: 144.5 },
    { code: 'SYS-P001', name: 'Rye Flour Dark 12.5kg', category: 'Flour & Premixes', description: 'Imported dark rye', uom: 'bag', pack_size: '12.5kg', list_price: 289.0, cost_price: 216.75 },
    { code: 'SYS-P002', name: 'Sourdough Starter Culture 1kg', category: 'Yeast & Raising Agents', description: null, uom: 'tub', pack_size: '1kg', list_price: 410.0, cost_price: 307.5 }
  ],
  stock: [
    { code: 'FLR-001', warehouse_code: 'FG', qty_available: 512 },
    { code: 'FLR-002', warehouse_code: 'FG', qty_available: 298 },
    { code: 'SYS-P001', warehouse_code: 'FG', qty_available: 64 },
    { code: 'SYS-P002', warehouse_code: 'FG', qty_available: 22 }
  ],
  customer_pricing: [
    { customer_code: 'GOLD001', product_code: 'FLR-001', contract_price: 176.5, buying_group_price: null, price_code_price: null },
    { customer_code: 'GOLD001', product_code: 'SYS-P001', contract_price: 265.0, buying_group_price: null, price_code_price: null }
  ]
};

const demoProvider = {
  async test() { return true; },
  async fetch(entity) {
    if (!DEMO_ROWS[entity]) throw new Error(`Unknown entity ${entity}`);
    return DEMO_ROWS[entity];
  }
};

export function getProvider() {
  return getSetting('intg_source', 'demo') === 'syspro' ? sysproProvider : demoProvider;
}

// Exposed so "Test connection" can test SYSPRO specifically, with overrides
// from the (possibly unsaved) settings form, regardless of the saved data
// source - lets an admin verify SQL Server credentials before switching over.
export function testSyspro(overrides) {
  return sysproProvider.test(overrides);
}

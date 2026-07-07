// Data providers for the ERP sync. Two sources:
//  - 'syspro': reads the SQL views exposed on the SYSPRO database (created by
//    the SYSPRO consultant/DBA - see docs/SYSPRO-INTEGRATION.md). Read-only.
//  - 'demo': built-in sample rows so the whole pipeline can be exercised
//    before the SYSPRO views/login exist.
//
// Every provider returns plain row arrays in the app's canonical shape:
//  customers: { code, name, contact_name, phone, email, address, city, credit_limit, balance, payment_terms, on_hold }
//  products:  { code, name, category, description, uom, pack_size, list_price, cost_price }
//  stock:     { code, qty_available }
//  prices:    { customer_code, product_code, price }   (contract prices)
import { getSetting } from '../db.js';

export function sysproConfig() {
  return {
    host: getSetting('syspro_host', ''),
    port: parseInt(getSetting('syspro_port', '1433'), 10),
    database: getSetting('syspro_db', ''),
    user: getSetting('syspro_user', ''),
    password: getSetting('syspro_password', ''),
    views: {
      customers: getSetting('syspro_view_customers', 'vw_FS_Customers'),
      products: getSetting('syspro_view_products', 'vw_FS_Products'),
      stock: getSetting('syspro_view_stock', 'vw_FS_Stock'),
      prices: getSetting('syspro_view_prices', 'vw_FS_ContractPrices')
    }
  };
}

async function sysproPool() {
  const sql = (await import('mssql')).default;
  const cfg = sysproConfig();
  if (!cfg.host || !cfg.database || !cfg.user) {
    throw new Error('SYSPRO connection is not configured (host, database, user are required)');
  }
  return sql.connect({
    server: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    options: { encrypt: false, trustServerCertificate: true },
    pool: { max: 2 },
    connectionTimeout: 10000,
    requestTimeout: 60000
  });
}

// The views present app-friendly column names already (see the doc), so the
// queries stay dumb on purpose: SELECT * FROM <view>.
const sysproProvider = {
  async test() {
    const pool = await sysproPool();
    const result = await pool.request().query('SELECT 1 AS ok');
    await pool.close();
    return result.recordset[0].ok === 1;
  },
  async fetch(entity) {
    const cfg = sysproConfig();
    const view = cfg.views[entity];
    if (!view || !/^[\w.\[\]]+$/.test(view)) throw new Error(`Invalid view name for ${entity}`);
    const pool = await sysproPool();
    try {
      const result = await pool.request().query(`SELECT * FROM ${view}`);
      return result.recordset;
    } finally {
      await pool.close();
    }
  }
};

const DEMO_ROWS = {
  customers: [
    { code: 'GOLD001', name: 'Golden Crust Bakery', contact_name: 'Maria Santos', phone: '+27 82 1013579', email: 'orders@goldencrustbakery.co.za', address: '7 Main Road', city: 'Milnerton', credit_limit: 160000, balance: 42350.5, payment_terms: '30 days', on_hold: 0 },
    { code: 'SYS-NEW01', name: 'Atlantic Foods Wholesale', contact_name: 'Brian Adams', phone: '+27 21 555 0199', email: 'buying@atlanticfoods.co.za', address: '14 Marine Drive', city: 'Paarden Eiland', credit_limit: 200000, balance: 0, payment_terms: '30 days', on_hold: 0 },
    { code: 'SYS-NEW02', name: 'Boland Bake House', contact_name: 'Annelie Smit', phone: '+27 21 555 0242', email: 'info@bolandbake.co.za', address: '3 Kerk Street', city: 'Wellington', credit_limit: 50000, balance: 12800, payment_terms: '7 days', on_hold: 1 }
  ],
  products: [
    { code: 'FLR-001', name: 'White Bread Flour 12.5kg', category: 'Flour & Premixes', description: null, uom: 'bag', pack_size: '12.5kg', list_price: 192.75, cost_price: 144.5 },
    { code: 'SYS-P001', name: 'Rye Flour Dark 12.5kg', category: 'Flour & Premixes', description: 'Imported dark rye', uom: 'bag', pack_size: '12.5kg', list_price: 289.0, cost_price: 216.75 },
    { code: 'SYS-P002', name: 'Sourdough Starter Culture 1kg', category: 'Yeast & Raising Agents', description: null, uom: 'tub', pack_size: '1kg', list_price: 410.0, cost_price: 307.5 }
  ],
  stock: [
    { code: 'FLR-001', qty_available: 512 },
    { code: 'FLR-002', qty_available: 298 },
    { code: 'SYS-P001', qty_available: 64 },
    { code: 'SYS-P002', qty_available: 22 }
  ],
  prices: [
    { customer_code: 'GOLD001', product_code: 'FLR-001', price: 176.5 },
    { customer_code: 'GOLD001', product_code: 'SYS-P001', price: 265.0 }
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

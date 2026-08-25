import { Router } from 'express';
import { db, logActivity, priceBreaks, activeRules, getTodayISO } from '../db.js';
import { requireRole, userCanAccessCustomer } from '../auth.js';

const router = Router();

// Check if a price is still valid based on start/end dates
function isPriceValid(startDate, endDate) {
  if (!startDate && !endDate) return true; // No date restrictions
  const today = getTodayISO();
  if (startDate && today < startDate) return false; // Not yet valid
  if (endDate && today > endDate) return false; // Expired
  return true;
}

router.get('/products', (req, res) => {
  const { q, category_id, active } = req.query;
  const where = [];
  const params = [];
  if (q) { where.push('(p.name LIKE ? OR p.code LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (category_id) { where.push('p.category_id = ?'); params.push(category_id); }
  if (active !== undefined) { where.push('p.active = ?'); params.push(active === 'false' ? 0 : 1); }
  const rows = db.prepare(`
    SELECT p.*, c.name AS category_name
    FROM products p LEFT JOIN product_categories c ON c.id = p.category_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.name
  `).all(...params);
  // For reps, only show their own warehouse stock. For admins/managers/office, show all warehouses.
  let stockByProduct = {};
  let stockQtyByProduct = {};
  if (req.user.role === 'rep' && req.user.warehouse_id) {
    const stockRows = db.prepare(`
      SELECT ps.product_id, w.code AS warehouse_code, w.name AS warehouse_name, ps.qty_available
      FROM product_stock ps JOIN warehouses w ON w.id = ps.warehouse_id
      WHERE ps.warehouse_id = ?
    `).all(req.user.warehouse_id);
    for (const s of stockRows) {
      (stockByProduct[s.product_id] ??= []).push({ warehouse_code: s.warehouse_code, warehouse_name: s.warehouse_name, qty_available: s.qty_available });
      stockQtyByProduct[s.product_id] = s.qty_available;
    }
  } else {
    // Per-branch stock breakdown for admin/manager/office users
    const stockRows = db.prepare(`
      SELECT ps.product_id, w.code AS warehouse_code, w.name AS warehouse_name, ps.qty_available
      FROM product_stock ps JOIN warehouses w ON w.id = ps.warehouse_id
      ORDER BY w.code
    `).all();
    for (const s of stockRows) {
      (stockByProduct[s.product_id] ??= []).push({ warehouse_code: s.warehouse_code, warehouse_name: s.warehouse_name, qty_available: s.qty_available });
    }
  }
  res.json(rows.map((p) => ({
    ...p,
    stock_qty: req.user.role === 'rep' && req.user.warehouse_id ? (stockQtyByProduct[p.id] ?? 0) : p.stock_qty,
    stock_by_warehouse: stockByProduct[p.id] || []
  })));
});

// Quick stock lookup for a rep on the road - searches by code or name and
// shows only their own depot's stock, not the company-wide total, since
// that's what actually matters when deciding whether to sell it.
router.get('/products/depot-stock', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const rows = db.prepare(`
    SELECT id, code, name, uom, pack_size
    FROM products
    WHERE active = 1 AND (name LIKE ? OR code LIKE ?)
    ORDER BY name
    LIMIT 50
  `).all(`%${q}%`, `%${q}%`);

  if (!req.user.warehouse_id) {
    return res.json(rows.map((p) => ({ ...p, stock_qty: null }))); // no depot assigned - can't scope stock
  }
  const stockRows = db.prepare('SELECT product_id, qty_available FROM product_stock WHERE warehouse_id = ?').all(req.user.warehouse_id);
  const stockByProductId = {};
  for (const s of stockRows) stockByProductId[s.product_id] = s.qty_available;
  res.json(rows.map((p) => ({ ...p, stock_qty: stockByProductId[p.id] ?? 0 })));
});

// Product list with the effective price for one customer (SYSPRO pricing > contract > qty breaks > list)
// plus price breaks so the client can price qty discounts locally.
router.get('/products/for-customer/:customerId', (req, res) => {
  const cid = req.params.customerId;
  // Get customer code for SYSPRO pricing lookup
  const customer = db.prepare('SELECT code FROM customers WHERE id = ?').get(cid);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (!userCanAccessCustomer(req.user, cid)) {
    return res.status(403).json({ error: 'Not your customer' });
  }

  const rows = db.prepare(`
    SELECT p.*, c.name AS category_name,
      COALESCE(cp.price, p.list_price) AS effective_price,
      CASE WHEN cp.price IS NOT NULL THEN 1 ELSE 0 END AS has_contract_price,
      -- "Bought" combines RouteOne-captured orders (full history) with SYSPRO
      -- invoices (invoice_items only ever holds a rolling 30-day window - see
      -- providers.js - so this is recent-purchases-only, not full history).
      -- Without the invoice side, a customer who buys via SYSPRO/phone and
      -- rarely has a RouteOne order captured would show no purchase history
      -- at all and the "Buys" filter would silently fall back to "All".
      ((SELECT COUNT(DISTINCT oi.order_id) FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.customer_id = ? AND oi.product_id = p.id AND o.status != 'cancelled') +
       (SELECT COUNT(DISTINCT ii.invoice_id) FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id
         WHERE i.customer_id = ? AND ii.product_id = p.id)) AS times_bought,
      (SELECT MAX(d) FROM (
         SELECT MAX(o.order_date) AS d FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           WHERE o.customer_id = ? AND oi.product_id = p.id AND o.status != 'cancelled'
         UNION ALL
         SELECT MAX(i.invoice_date) AS d FROM invoice_items ii
           JOIN invoices i ON i.id = ii.invoice_id
           WHERE i.customer_id = ? AND ii.product_id = p.id
       )) AS last_bought_at
    FROM products p
    LEFT JOIN product_categories c ON c.id = p.category_id
    LEFT JOIN customer_prices cp ON cp.product_id = p.id AND cp.customer_id = ?
    -- Discontinued run-out stock (active = 0) is deliberately included so the
    -- order screens can show it struck through and badged rather than having it
    -- silently disappear - a rep searching for a product they know exists needs
    -- to see WHY it can't be ordered. The client disables the add control, and
    -- the order/quote POST rejects the line anyway (both resolve items with
    -- active = 1), so including it here cannot make it orderable.
    WHERE p.active = 1 OR p.discontinued = 1
    ORDER BY p.name
  `).all(cid, cid, cid, cid, cid);

  // Reps only see stock at their own branch/warehouse - not the company-wide
  // total - since that's what's actually on hand to fulfil the order from.
  let stockByProductId = null;
  if (req.user.role === 'rep' && req.user.warehouse_id) {
    stockByProductId = {};
    const stockRows = db.prepare('SELECT product_id, qty_available FROM product_stock WHERE warehouse_id = ?').all(req.user.warehouse_id);
    for (const s of stockRows) stockByProductId[s.product_id] = s.qty_available;
  }

  // Fetch SYSPRO pricing for this customer if available (table may not exist in dev)
  let sysproPricingByProductCode = {};
  try {
    const sysproRows = db.prepare(`
      SELECT product_code, contract_price, buying_group_price, price_code_price,
             contract_start_date, contract_end_date, buying_group_start_date, buying_group_end_date
      FROM syspro_customer_pricing
      WHERE customer_code = ?
    `).all(customer.code);
    for (const sp of sysproRows) {
      sysproPricingByProductCode[sp.product_code] = sp;
    }
  } catch (e) {
    // Table may not exist yet in dev environment
  }

  const rules = activeRules();
  res.json(rows.map((p) => {
    // Check SYSPRO pricing first (contract > buying group > price code > list)
    const syspro = sysproPricingByProductCode[p.code];
    let sysproEffectivePrice = null;
    let sysproPricingTier = null;
    if (syspro) {
      // Use contract price if valid and not expired
      let contractPrice = null;
      if (syspro.contract_price && isPriceValid(syspro.contract_start_date, syspro.contract_end_date)) {
        contractPrice = syspro.contract_price;
      }
      // Use buying group price if valid and not expired, and no contract price
      let buyingGroupPrice = null;
      if (!contractPrice && syspro.buying_group_price && isPriceValid(syspro.buying_group_start_date, syspro.buying_group_end_date)) {
        buyingGroupPrice = syspro.buying_group_price;
      }
      const perKgPrice = contractPrice ?? buyingGroupPrice ?? syspro.price_code_price;
      // SYSPRO contract/buying-group/price-code prices are per-KG, same as
      // list_price (see productUnitPrice in db.js) - must scale by pack weight
      // to get the real per-unit selling price, same as list_price does.
      sysproEffectivePrice = perKgPrice != null ? perKgPrice * (p.conv_factor_alt_uom || p.pack_weight_kg || 1) : null;
      if (contractPrice) sysproPricingTier = 'syspro_contract';
      else if (buyingGroupPrice) sysproPricingTier = 'syspro_buying_group';
      else if (syspro.price_code_price) sysproPricingTier = 'syspro_price_code';
    }
    // No syspro override at all -> falls through to products.list_price below (via p.effective_price)

    // Use SYSPRO effective price if available, else fall back to existing logic
    const finalEffectivePrice = sysproEffectivePrice ?? p.effective_price;
    const hasSysproPrice = sysproEffectivePrice != null;
    const breaks = hasSysproPrice || p.has_contract_price ? [] : priceBreaks(p, rules);
    const base = breaks.length ? breaks[0].price : finalEffectivePrice;

    return {
      ...p,
      stock_qty: stockByProductId ? (stockByProductId[p.id] ?? 0) : p.stock_qty,
      effective_price: hasSysproPrice || p.has_contract_price ? finalEffectivePrice : base,
      has_contract_price: hasSysproPrice ? 1 : p.has_contract_price,
      price_breaks: breaks,
      syspro_pricing: syspro || null,
      syspro_pricing_tier: sysproPricingTier
    };
  }));
});

// --- Price rules (Phase 2 pricing beyond contract prices) ---

router.get('/price-rules', (req, res) => {
  res.json(db.prepare(`
    SELECT r.*, p.name AS product_name, c.name AS category_name
    FROM price_rules r
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN product_categories c ON c.id = r.category_id
    ORDER BY r.name
  `).all());
});

router.post('/price-rules', requireRole('admin', 'manager', 'office'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Rule name is required' });
  if (!b.product_id && !b.category_id) return res.status(400).json({ error: 'Pick a product or a category' });
  if (b.rule_type === 'fixed_price' ? b.fixed_price == null : b.discount_pct == null) {
    return res.status(400).json({ error: 'Set a discount % or a fixed price' });
  }
  const info = db.prepare(`
    INSERT INTO price_rules (name, product_id, category_id, rule_type, discount_pct, fixed_price, min_qty, starts_on, ends_on, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    b.name, b.product_id || null, b.category_id || null, b.rule_type || 'discount_pct',
    b.discount_pct ?? null, b.fixed_price ?? null, b.min_qty || 0,
    b.starts_on || null, b.ends_on || null, b.active === 0 ? 0 : 1
  );
  logActivity(req.user.id, 'create', 'price_rule', info.lastInsertRowid, { name: b.name });
  res.json({ id: info.lastInsertRowid });
});

router.put('/price-rules/:id', requireRole('admin', 'manager', 'office'), (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM price_rules WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Rule not found' });
  db.prepare(`
    UPDATE price_rules SET name = ?, product_id = ?, category_id = ?, rule_type = ?, discount_pct = ?,
      fixed_price = ?, min_qty = ?, starts_on = ?, ends_on = ?, active = ?
    WHERE id = ?
  `).run(
    b.name ?? existing.name, b.product_id ?? existing.product_id, b.category_id ?? existing.category_id,
    b.rule_type ?? existing.rule_type, b.discount_pct ?? existing.discount_pct, b.fixed_price ?? existing.fixed_price,
    b.min_qty ?? existing.min_qty, b.starts_on ?? existing.starts_on, b.ends_on ?? existing.ends_on,
    b.active ?? existing.active, req.params.id
  );
  res.json({ ok: true });
});

router.delete('/price-rules/:id', requireRole('admin', 'manager', 'office'), (req, res) => {
  db.prepare('DELETE FROM price_rules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/products', requireRole('admin', 'manager', 'office'), (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.name) return res.status(400).json({ error: 'Product code and name are required' });
  const info = db.prepare(`
    INSERT INTO products (code, name, category_id, description, uom, pack_size, list_price, cost_price, stock_qty, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    b.code, b.name, b.category_id || null, b.description || null, b.uom || 'each',
    b.pack_size || null, b.list_price || 0, b.cost_price || 0, b.stock_qty || 0, b.active === 0 ? 0 : 1
  );
  logActivity(req.user.id, 'create', 'product', info.lastInsertRowid, { name: b.name });
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/products/:id', requireRole('admin', 'manager', 'office'), (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });
  db.prepare(`
    UPDATE products SET code = ?, name = ?, category_id = ?, description = ?, uom = ?, pack_size = ?,
      list_price = ?, cost_price = ?, stock_qty = ?, active = ?
    WHERE id = ?
  `).run(
    b.code ?? existing.code, b.name ?? existing.name, b.category_id ?? existing.category_id,
    b.description ?? existing.description, b.uom ?? existing.uom, b.pack_size ?? existing.pack_size,
    b.list_price ?? existing.list_price, b.cost_price ?? existing.cost_price,
    b.stock_qty ?? existing.stock_qty, b.active ?? existing.active, req.params.id
  );
  logActivity(req.user.id, 'update', 'product', req.params.id);
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

router.get('/product-categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM product_categories ORDER BY name').all());
});

router.post('/product-categories', requireRole('admin', 'manager', 'office'), (req, res) => {
  const name = req.body?.name;
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  const info = db.prepare('INSERT INTO product_categories (name) VALUES (?)').run(name);
  res.json(db.prepare('SELECT * FROM product_categories WHERE id = ?').get(info.lastInsertRowid));
});

// SYSPRO customer pricing (contract, buying group, price code, falling back to
// the product's list price - list price isn't stored per customer, see schema.sql)
// Synced from SYSPRO's vw_FS_CustomerPricing_ContractBuyingGroup view
router.get('/customer-pricing', (req, res) => {
  const { customer_code, product_code } = req.query;
  if (!customer_code || !product_code) {
    return res.status(400).json({ error: 'customer_code and product_code are required' });
  }

  const product = db.prepare('SELECT list_price, pack_weight_kg, conv_factor_alt_uom FROM products WHERE code = ?').get(product_code);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const packWeight = product.conv_factor_alt_uom || product.pack_weight_kg || 1;

  const override = db.prepare(`
    SELECT contract_price, buying_group_price, price_code_price,
           contract_start_date, contract_end_date, buying_group_start_date, buying_group_end_date
    FROM syspro_customer_pricing
    WHERE customer_code = ? AND product_code = ?
  `).get(customer_code, product_code);

  // All SYSPRO prices (contract/buying-group/price-code/list) are per-KG,
  // same as products.list_price (see productUnitPrice in db.js) - scale by
  // pack weight to get the real per-unit selling price.
  // Check validity dates before applying each price tier
  let contract_price = null;
  if (override?.contract_price != null && isPriceValid(override.contract_start_date, override.contract_end_date)) {
    contract_price = override.contract_price * packWeight;
  }
  let buying_group_price = null;
  if (override?.buying_group_price != null && isPriceValid(override.buying_group_start_date, override.buying_group_end_date)) {
    buying_group_price = override.buying_group_price * packWeight;
  }
  const price_code_price = override?.price_code_price != null ? override.price_code_price * packWeight : null;
  const list_price = product.list_price * packWeight;

  // Apply pricing priority: contract > buying group > price code > list
  const effective_price = contract_price ?? buying_group_price ?? price_code_price ?? list_price;
  const pricing_tier = contract_price ? 'contract' : buying_group_price ? 'buying_group' : price_code_price ? 'price_code' : 'list';

  res.json({
    customer_code,
    product_code,
    contract_price,
    buying_group_price,
    price_code_price,
    list_price,
    effective_price,
    pricing_tier
  });
});

export default router;

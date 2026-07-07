// Offline snapshot: everything a rep needs cached on-device to keep working
// without signal - customers, products with price breaks, contract prices,
// today's visits and active form templates.
import { Router } from 'express';
import { db, priceBreaks, activeRules } from '../db.js';
import { scopeForUser } from '../auth.js';

const router = Router();

router.get('/sync/snapshot', (req, res) => {
  const scope = scopeForUser(req.user);
  const repFilter = scope.isRep ? 'WHERE c.rep_id = ?' : '';
  const repParams = scope.isRep ? [req.user.id] : [];

  const customers = db.prepare(`
    SELECT c.*, t.name AS territory_name,
      (SELECT MAX(order_date) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled') AS last_order_at
    FROM customers c
    LEFT JOIN territories t ON t.id = c.territory_id
    ${repFilter} ORDER BY c.name
  `).all(...repParams);

  const rules = activeRules();
  const products = db.prepare(`
    SELECT p.*, cat.name AS category_name
    FROM products p LEFT JOIN product_categories cat ON cat.id = p.category_id
    WHERE p.active = 1 ORDER BY p.name
  `).all().map((p) => ({ ...p, price_breaks: priceBreaks(p, rules) }));

  const contractPrices = db.prepare(`
    SELECT cp.customer_id, cp.product_id, cp.price FROM customer_prices cp
    ${scope.isRep ? 'JOIN customers c ON c.id = cp.customer_id WHERE c.rep_id = ?' : ''}
  `).all(...repParams);

  const visitsToday = db.prepare(`
    SELECT v.*, c.name AS customer_name, c.city FROM visits v
    JOIN customers c ON c.id = v.customer_id
    WHERE date(COALESCE(v.check_in_at, v.planned_date)) = date('now')
    ${scope.isRep ? 'AND v.rep_id = ?' : ''}
  `).all(...repParams);

  const formTemplates = db.prepare('SELECT * FROM form_templates WHERE active = 1')
    .all().map((t) => ({ ...t, fields: JSON.parse(t.fields) }));

  res.json({
    generated_at: new Date().toISOString(),
    customers, products, contract_prices: contractPrices,
    visits_today: visitsToday, form_templates: formTemplates
  });
});

export default router;

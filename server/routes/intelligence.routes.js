// Phase 5: analytics + Radar-style sales intelligence.
// Everything is computed on the fly from orders/visits/quotes - explainable
// rules, no black box: RFM segmentation, churn risk scores, next actions,
// and product suggestions per customer.
import { Router } from 'express';
import { db } from '../db.js';
import { requireRole, scopeForUser } from '../auth.js';

const router = Router();

const FREQUENCY_DAYS = { weekly: 7, biweekly: 14, monthly: 30 };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// --- Core: per-customer intelligence rows -------------------------------------

export function customerIntel(repId = null) {
  const customers = db.prepare(`
    SELECT c.id, c.name, c.city, c.classification, c.visit_frequency, c.status,
      c.rep_id, u.name AS rep_name,
      -- Last purchase: most recent of an app-captured order OR a synced SYSPRO
      -- invoice, since many customers are invoiced directly in SYSPRO without
      -- ever having an order captured through the app.
      (SELECT MAX(d) FROM (
        SELECT MAX(order_date) AS d FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled'
        UNION ALL
        SELECT MAX(invoice_date) AS d FROM invoices i WHERE i.customer_id = c.id
      )) AS last_order_at,
      (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled'
        AND o.order_date >= date('now', '-180 days')) AS freq_180,
      (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled'
        AND o.order_date >= date('now', '-180 days')) AS monetary_180,
      (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled'
        AND o.order_date >= date('now', '-90 days')) AS sales_last90,
      (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled'
        AND o.order_date >= date('now', '-180 days') AND o.order_date < date('now', '-90 days')) AS sales_prev90,
      (SELECT COUNT(*) FROM visits v WHERE v.customer_id = c.id
        AND v.status IN ('planned', 'missed') AND date(v.planned_date) < date('now')
        AND date(v.planned_date) >= date('now', '-90 days')) AS missed_visits_90
    FROM customers c
    LEFT JOIN users u ON u.id = c.rep_id
    WHERE c.status NOT IN ('closed', 'prospect') ${repId ? 'AND c.rep_id = ?' : ''}
  `).all(...(repId ? [repId] : []));

  // Monetary quintiles across the base for the M score.
  const monies = customers.map((c) => c.monetary_180).sort((a, b) => a - b);
  const quintile = (v) => {
    if (monies.length === 0 || v <= 0) return 1;
    const rank = monies.findIndex((m) => m >= v);
    return clamp(Math.ceil(((rank + 1) / monies.length) * 5), 1, 5);
  };

  const today = Date.now();
  return customers.map((c) => {
    const cycleDays = FREQUENCY_DAYS[c.visit_frequency] || 30;
    const recencyDays = c.last_order_at
      ? Math.floor((today - new Date(c.last_order_at.replace(' ', 'T')).getTime()) / 86400000)
      : 999;
    const ratio = recencyDays / cycleDays; // 1 = exactly one buying cycle since last order

    const r = ratio <= 1 ? 5 : ratio <= 1.5 ? 4 : ratio <= 2.5 ? 3 : ratio <= 4 ? 2 : 1;
    const f = c.freq_180 === 0 ? 1 : c.freq_180 <= 2 ? 2 : c.freq_180 <= 5 ? 3 : c.freq_180 <= 10 ? 4 : 5;
    const m = quintile(c.monetary_180);

    let segment;
    if (r >= 4 && f >= 4) segment = 'Champion';
    else if (r >= 4 && f >= 2) segment = 'Loyal';
    else if (r >= 4) segment = 'New / promising';
    else if (r === 3) segment = 'Needs attention';
    else if (f >= 4 || m >= 4) segment = "Can't lose";
    else if (f >= 2) segment = 'At risk';
    else segment = 'Hibernating';

    // Churn risk 0-100: overdue buying cycle + declining spend + missed visits.
    const decline = c.sales_prev90 > 0 ? clamp((c.sales_prev90 - c.sales_last90) / c.sales_prev90, 0, 1) : 0;
    const risk = c.last_order_at
      ? Math.round(clamp(45 * clamp(ratio / 4, 0, 1) + 35 * decline + 20 * (c.missed_visits_90 > 0 ? 1 : 0), 0, 100))
      : 85; // never ordered

    return {
      ...c,
      recency_days: recencyDays,
      cycle_days: cycleDays,
      r_score: r, f_score: f, m_score: m,
      segment,
      risk_score: risk,
      decline_pct: Math.round(decline * 100)
    };
  });
}

// Prioritised action list for a set of intel rows, plus stale-quote follow-ups.
// Shared by the Sales AI page (whole book) and the per-customer mobile view.
export function buildActions(intel, { repId = null, customerId = null } = {}) {
  const actions = [];

  for (const c of intel) {
    if (c.status === 'on_hold') {
      actions.push({ customer_id: c.id, customer_name: c.name, rep_name: c.rep_name, priority: 90, type: 'account', action: 'Account on hold — resolve with finance before next visit' });
    }
    if (c.risk_score >= 70) {
      actions.push({ customer_id: c.id, customer_name: c.name, rep_name: c.rep_name, priority: c.risk_score, type: 'churn', action: `High churn risk (${c.risk_score}) — ${c.last_order_at ? `no order in ${c.recency_days} days` : 'never ordered'}; call or visit this week` });
    } else if (c.decline_pct >= 30 && c.monetary_180 > 0) {
      actions.push({ customer_id: c.id, customer_name: c.name, rep_name: c.rep_name, priority: 50 + c.decline_pct / 2, type: 'declining', action: `Spend down ${c.decline_pct}% vs previous quarter — check competitor activity and pricing` });
    } else if (c.recency_days > c.cycle_days * 1.5 && c.recency_days < 900) {
      actions.push({ customer_id: c.id, customer_name: c.name, rep_name: c.rep_name, priority: 40, type: 'overdue', action: `Order overdue — last ordered ${c.recency_days} days ago (buys ~every ${c.cycle_days} days)` });
    }
  }

  // Stale quotes: sent > 5 days ago, still open.
  const where = ["q.status = 'sent'", "q.quote_date < datetime('now', '-5 days')"];
  const params = [];
  if (repId) { where.push('q.rep_id = ?'); params.push(repId); }
  if (customerId) { where.push('q.customer_id = ?'); params.push(customerId); }
  const staleQuotes = db.prepare(`
    SELECT q.id, q.number, q.total, q.customer_id, c.name AS customer_name, u.name AS rep_name,
      CAST(julianday('now') - julianday(q.quote_date) AS INTEGER) AS age_days
    FROM quotes q JOIN customers c ON c.id = q.customer_id
    LEFT JOIN users u ON u.id = q.rep_id
    WHERE ${where.join(' AND ')}
  `).all(...params);
  for (const q of staleQuotes) {
    actions.push({ customer_id: q.customer_id, customer_name: q.customer_name, rep_name: q.rep_name, priority: 60, type: 'quote', action: `Quote ${q.number} (R ${q.total.toFixed(2)}) unanswered for ${q.age_days} days — follow up`, quote_id: q.id });
  }

  return actions.sort((a, b) => b.priority - a.priority);
}

// --- Endpoints -----------------------------------------------------------------

// Segments + risk for every customer (managers see all; reps their own book).
router.get('/intel/customers', (req, res) => {
  const scope = scopeForUser(req.user);
  res.json(customerIntel(scope.isRep ? req.user.id : null).sort((a, b) => b.risk_score - a.risk_score));
});

// One customer's intel + product suggestions + its AI actions - used on customer pages.
router.get('/intel/customer/:id', (req, res) => {
  const scope = scopeForUser(req.user);
  // Reps only get intel on their own customers (quintiles also stay within their book).
  const intel = customerIntel(scope.isRep ? req.user.id : null).find((c) => c.id === Number(req.params.id));
  if (!intel) return res.status(404).json({ error: 'Customer not found' });

  // This customer's slice of the Sales AI recommended actions.
  intel.actions = buildActions([intel], { customerId: intel.id });

  // "Others buy, you don't": top sellers (180d) this customer hasn't bought.
  intel.suggested_products = db.prepare(`
    SELECT p.id, p.code, p.name, SUM(i.line_total) AS revenue
    FROM order_items i
    JOIN orders o ON o.id = i.order_id AND o.status != 'cancelled' AND o.order_date >= date('now', '-180 days')
    JOIN products p ON p.id = i.product_id AND p.active = 1
    WHERE i.product_id NOT IN (
      SELECT i2.product_id FROM order_items i2
      JOIN orders o2 ON o2.id = i2.order_id AND o2.customer_id = ? AND o2.order_date >= date('now', '-180 days')
    )
    GROUP BY p.id ORDER BY revenue DESC LIMIT 5
  `).all(intel.id);

  // Lapsed: bought before, nothing in the last 60 days.
  intel.lapsed_products = db.prepare(`
    SELECT p.id, p.code, p.name, MAX(o.order_date) AS last_bought
    FROM order_items i
    JOIN orders o ON o.id = i.order_id AND o.customer_id = ? AND o.status != 'cancelled'
    JOIN products p ON p.id = i.product_id AND p.active = 1
    GROUP BY p.id
    HAVING last_bought < date('now', '-60 days')
    ORDER BY last_bought DESC LIMIT 5
  `).all(intel.id);

  res.json(intel);
});

// Prioritised next actions for the sales team.
router.get('/intel/actions', (req, res) => {
  const scope = scopeForUser(req.user);
  const repId = scope.isRep ? req.user.id : null;
  res.json(buildActions(customerIntel(repId), { repId }).slice(0, 25));
});

// --- Analytics ------------------------------------------------------------------

router.get('/analytics', requireRole('admin', 'manager', 'office', 'rep'), (req, res) => {
  const scope = scopeForUser(req.user);
  const repFilter = scope.isRep ? 'AND o.rep_id = ?' : '';
  const repParam = scope.isRep ? [req.user.id] : [];
  const days = clamp(parseInt(req.query.days || '90', 10), 7, 365);
  const window = `-${days} days`;

  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', order_date) AS month, COALESCE(SUM(total), 0) AS sales, COUNT(*) AS orders
    FROM orders o WHERE status != 'cancelled' AND order_date >= date('now', '-365 days') ${repFilter}
    GROUP BY month ORDER BY month
  `).all(...repParam);

  const topProducts = db.prepare(`
    SELECT p.code, p.name, SUM(i.qty) AS units, SUM(i.line_total) AS revenue,
      SUM(i.line_total) - SUM(i.qty * p.cost_price) AS margin
    FROM order_items i
    JOIN orders o ON o.id = i.order_id AND o.status != 'cancelled' AND o.order_date >= date('now', ?) ${repFilter}
    JOIN products p ON p.id = i.product_id
    GROUP BY p.id ORDER BY revenue DESC LIMIT 15
  `).all(window, ...repParam);

  const quoteFunnel = db.prepare(`
    SELECT COUNT(*) AS total,
      COUNT(CASE WHEN status = 'accepted' THEN 1 END) AS accepted,
      COUNT(CASE WHEN status = 'rejected' THEN 1 END) AS rejected,
      COUNT(CASE WHEN status = 'sent' THEN 1 END) AS open,
      COALESCE(SUM(CASE WHEN status = 'accepted' THEN total END), 0) AS accepted_value
    FROM quotes WHERE quote_date >= date('now', ?) ${scope.isRep ? 'AND rep_id = ?' : ''}
  `).get(window, ...repParam);

  const totals = db.prepare(`
    SELECT COALESCE(SUM(o.total), 0) AS revenue, COUNT(o.id) AS orders,
      COUNT(DISTINCT o.customer_id) AS active_customers, COALESCE(AVG(o.total), 0) AS aov
    FROM orders o WHERE o.status != 'cancelled' AND o.order_date >= date('now', ?) ${repFilter}
  `).get(window, ...repParam);
  const margin = db.prepare(`
    SELECT COALESCE(SUM(i.line_total) - SUM(i.qty * p.cost_price), 0) AS margin
    FROM order_items i
    JOIN orders o ON o.id = i.order_id AND o.status != 'cancelled' AND o.order_date >= date('now', ?) ${repFilter}
    JOIN products p ON p.id = i.product_id
  `).get(window, ...repParam);
  totals.margin = margin.margin;
  totals.margin_pct = totals.revenue ? Math.round((margin.margin / totals.revenue) * 100) : 0;

  res.json({ days, totals, monthly, topProducts, quoteFunnel });
});

export default router;

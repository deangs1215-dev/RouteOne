CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  permissions TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS territories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  region TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  phone TEXT,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  territory_id INTEGER REFERENCES territories(id),
  customer_id INTEGER REFERENCES customers(id),   -- for customer-portal logins
  rep_code TEXT,                          -- rep's own code, e.g. matches SYSPRO/call-cycle sheets
  warehouse_id INTEGER REFERENCES warehouses(id),  -- rep's home branch/depot
  sales_target REAL DEFAULT 0,
  active INTEGER DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  reset_token_hash TEXT,
  reset_token_expires TEXT,
  home_address TEXT,                      -- where the rep starts their day (home/office)
  home_lat REAL,
  home_lng REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- SYSPRO warehouses/depots. Synced read-only; each customer is fixed to one.
CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  classification TEXT DEFAULT 'B',        -- A/B/C account grading
  territory_id INTEGER REFERENCES territories(id),
  rep_id INTEGER REFERENCES users(id),
  warehouse_id INTEGER REFERENCES warehouses(id),  -- fixed fulfilling depot, set by SYSPRO sync
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  lat REAL,
  lng REAL,
  credit_limit REAL DEFAULT 0,
  balance REAL DEFAULT 0,
  payment_terms TEXT DEFAULT '30 days',
  visit_frequency TEXT DEFAULT 'weekly',  -- weekly / biweekly / monthly
  status TEXT DEFAULT 'active',           -- active / on_hold / closed
  notes TEXT,
  onsite_name TEXT,                       -- actual location name if different from SYSPRO
  onsite_phone TEXT,                      -- onsite contact number (override SYSPRO phone)
  onsite_address TEXT,                    -- actual delivery address if different
  onsite_lat REAL,                        -- actual location pin (if different from SYSPRO)
  onsite_lng REAL,
  onsite_contact TEXT,                    -- contact person(s), free text (may list several)
  onsite_cell TEXT,                       -- onsite cell number
  onsite_pricelist TEXT,                  -- which price list they're on
  onsite_vat TEXT,                        -- VAT number
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customer_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  phone TEXT,
  email TEXT
);

CREATE TABLE IF NOT EXISTS product_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES product_categories(id),
  description TEXT,
  uom TEXT DEFAULT 'each',
  pack_size TEXT,
  pack_weight_kg REAL,             -- parsed from pack_size; list_price is per-kg, this converts to per-unit
  list_price REAL NOT NULL DEFAULT 0,
  cost_price REAL DEFAULT 0,
  stock_qty REAL DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Per-branch stock availability, synced from SYSPRO (vw_FS_Stock). products.stock_qty
-- stays as the SUM across warehouses for existing code that just needs a total.
CREATE TABLE IF NOT EXISTS product_stock (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  qty_available REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, warehouse_id)
);

-- Customer-specific contract pricing overrides the list price.
CREATE TABLE IF NOT EXISTS customer_prices (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price REAL NOT NULL,
  PRIMARY KEY (customer_id, product_id)
);

-- SYSPRO customer pricing overrides (contract, buying group, price code). List
-- price isn't stored here - it's already per-product on products.list_price
-- (synced from vw_FS_Products), so no need to duplicate it per customer.
-- Synced from vw_FS_CustomerPricing_ContractBuyingGroup - one row per
-- (customer, product) that has at least one override, never a full cross join.
CREATE TABLE IF NOT EXISTS syspro_customer_pricing (
  customer_code TEXT NOT NULL,
  product_code TEXT NOT NULL,
  contract_price REAL,
  buying_group_price REAL,
  price_code_price REAL,
  contract_start_date TEXT,
  contract_end_date TEXT,
  buying_group_start_date TEXT,
  buying_group_end_date TEXT,
  synced_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (customer_code, product_code)
);

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  rep_id INTEGER NOT NULL REFERENCES users(id),
  planned_date TEXT,
  purpose TEXT DEFAULT 'sales call',
  status TEXT DEFAULT 'planned',          -- planned / in_progress / completed / missed
  route_order INTEGER,                    -- position in the day's route plan
  check_in_at TEXT,
  check_in_lat REAL,
  check_in_lng REAL,
  check_in_distance_m REAL,               -- how far from the customer's pin at check-in
  check_in_type TEXT DEFAULT 'onsite',    -- onsite / onsite_manual / offsite
  check_in_address TEXT,                  -- rep-entered address for onsite_manual / offsite
  check_out_at TEXT,
  check_out_lat REAL,
  check_out_lng REAL,
  notes TEXT,
  outcome TEXT,                           -- order / no_order / follow_up / other
  created_at TEXT DEFAULT (datetime('now'))
);

-- Last known rep positions (pinged by the mobile app), for the live map.
CREATE TABLE IF NOT EXISTS rep_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  recorded_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rep_locations_user ON rep_locations(user_id, recorded_at);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  rep_id INTEGER REFERENCES users(id),
  visit_id INTEGER REFERENCES visits(id),
  warehouse_id INTEGER REFERENCES warehouses(id),  -- snapshot of the customer's warehouse at order time
  status TEXT DEFAULT 'submitted',        -- draft / submitted / processing / invoiced / cancelled
  order_date TEXT DEFAULT (datetime('now')),
  subtotal REAL DEFAULT 0,
  vat_amount REAL DEFAULT 0,
  total REAL DEFAULT 0,
  notes TEXT,
  delivery_instructions TEXT,
  signature TEXT,                         -- customer signature captured on-site (base64 PNG), required before submit
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  qty REAL NOT NULL,
  uom TEXT,
  unit_price REAL NOT NULL,
  discount_pct REAL DEFAULT 0,
  line_total REAL NOT NULL
);

-- Phase 2: pricing rules beyond contract prices. Category or product scope,
-- optional quantity break and promo date window. Best (lowest) applicable
-- price wins; a customer contract price still beats all rules.
CREATE TABLE IF NOT EXISTS price_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES product_categories(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL DEFAULT 'discount_pct',  -- discount_pct / fixed_price
  discount_pct REAL,
  fixed_price REAL,
  min_qty REAL DEFAULT 0,
  starts_on TEXT,
  ends_on TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  rep_id INTEGER REFERENCES users(id),
  visit_id INTEGER REFERENCES visits(id),
  status TEXT DEFAULT 'sent',              -- draft / sent / accepted / rejected / expired
  quote_date TEXT DEFAULT (datetime('now')),
  valid_until TEXT,
  subtotal REAL DEFAULT 0,
  vat_amount REAL DEFAULT 0,
  total REAL DEFAULT 0,
  notes TEXT,
  order_id INTEGER REFERENCES orders(id),  -- set when converted
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quote_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  qty REAL NOT NULL,
  uom TEXT,
  unit_price REAL NOT NULL,
  discount_pct REAL DEFAULT 0,
  line_total REAL NOT NULL
);

-- Custom field-capture forms. fields is a JSON array:
-- [{ key, label, type: heading|text|email|number|date|select|checkbox|photo|signature|product, options?, required }]
CREATE TABLE IF NOT EXISTS form_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  fields TEXT NOT NULL DEFAULT '[]',
  category TEXT DEFAULT 'general',    -- 'general' / 'technical' — technical submissions email technical_email
  notify_email TEXT,                  -- optional: email address this form's submissions are sent to
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Marketing documents (PDFs) uploaded by admin/manager for reps to browse from
-- the shared main menu. Read access is open to any logged-in non-customer
-- user; uploading/deleting is admin/manager only (see requireRole in routes).
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  file_path TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS form_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES form_templates(id),
  visit_id INTEGER REFERENCES visits(id),
  customer_id INTEGER REFERENCES customers(id),
  user_id INTEGER REFERENCES users(id),
  data TEXT NOT NULL DEFAULT '{}',         -- { fieldKey: value } (photo values are upload paths)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visit_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  path TEXT NOT NULL,        -- file path under /uploads (compressed JPEG)
  caption TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Customer invoices. Read-only mirror of SYSPRO's AR invoices (system of record
-- for billing). Synced in from the ERP; never edited in the app. Keyed on the
-- SYSPRO invoice number, linked to a customer by account code.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT UNIQUE NOT NULL,            -- SYSPRO invoice number
  customer_id INTEGER REFERENCES customers(id),
  customer_code TEXT NOT NULL,            -- kept even if the customer isn't matched yet
  order_number TEXT,                      -- SYSPRO sales order reference, if any
  invoice_date TEXT NOT NULL,             -- YYYY-MM-DD
  due_date TEXT,
  subtotal REAL DEFAULT 0,
  vat_amount REAL DEFAULT 0,
  total REAL DEFAULT 0,
  amount_paid REAL DEFAULT 0,
  balance REAL DEFAULT 0,                 -- outstanding = total - amount_paid
  status TEXT DEFAULT 'outstanding',      -- paid / outstanding / overdue
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id, invoice_date);

-- Phase 4: SYSPRO sync + email integration ------------------------------------

-- One row per sync run per entity (customers / products / stock / prices).
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,                    -- syspro / demo
  entity TEXT NOT NULL,
  status TEXT DEFAULT 'running',           -- running / completed / failed
  rows_read INTEGER DEFAULT 0,
  rows_upserted INTEGER DEFAULT 0,
  error TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);

-- Configured email recipients for order/quote distribution (admin setup).
CREATE TABLE IF NOT EXISTS email_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                      -- e.g., "Finance", "Management", "Accounts"
  email TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Outbound emails (orders to the orders department, quotes to customers).
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                      -- order / quote
  ref_id INTEGER NOT NULL,                 -- order or quote id
  to_addr TEXT NOT NULL,
  cc_addr TEXT,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  status TEXT DEFAULT 'pending',           -- pending / sent / failed
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Call-cycle route plans (Phase 5): a rep's fixed N-week visit schedule, loaded
-- from the planning sheet. Each stop is a customer planned for a (week, weekday).
CREATE TABLE IF NOT EXISTS route_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rep_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT,
  rep_code TEXT,                       -- informational, from the source sheet
  start_date TEXT NOT NULL,            -- YYYY-MM-DD; week 1 begins on/after this
  cycle_weeks INTEGER NOT NULL DEFAULT 8,
  repeat_count INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS route_cycle_stops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES route_cycles(id) ON DELETE CASCADE,
  week_no INTEGER NOT NULL,            -- 1..cycle_weeks
  weekday INTEGER NOT NULL,            -- 1=Mon .. 5=Fri
  customer_id INTEGER REFERENCES customers(id),
  customer_code TEXT,                  -- kept even if unmatched, for reference
  seq INTEGER
);

-- Rep-captured field intel on a customer — the soft knowledge SYSPRO doesn't
-- hold (who they buy from now, who signs off orders, access quirks, rapport).
-- Kept in its own table so the SYSPRO customer sync never overwrites it. 1:1
-- with a customer.
CREATE TABLE IF NOT EXISTS customer_intel (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  current_supplier TEXT,        -- who they currently buy from (competitor)
  decision_maker TEXT,          -- who signs off purchases (name / role)
  best_visit_time TEXT,         -- when to catch them
  delivery_notes TEXT,          -- access / delivery quirks (gate code, back entrance…)
  products_of_interest TEXT,    -- what they've shown interest in / to pitch
  competitor_notes TEXT,        -- rival activity seen on-site
  general_notes TEXT,           -- free-form rapport / misc
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Monthly sales budgets per rep (Jan-Dec).
CREATE TABLE IF NOT EXISTS rep_budgets (
  rep_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),  -- 1=Jan, 12=Dec
  budget REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (rep_id, month)
);

-- Tasks (Phase 5): Rep task management. Linked to customers, assigned to reps.
-- Status: open / done / cancelled. Overdue detection is client-side based on follow_up_date.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  assigned_to INTEGER NOT NULL REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  task_type TEXT NOT NULL,                -- Call Customer, Visit Customer, Follow Up Quote, Follow Up Order, Resolve Query, Collect Payment, Deliver Sample, Other
  follow_up_date TEXT NOT NULL,           -- YYYY-MM-DD
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',    -- open / done / cancelled
  branch TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_route_cycles_rep ON route_cycles(rep_id, active);
CREATE INDEX IF NOT EXISTS idx_route_cycle_stops_cycle ON route_cycle_stops(cycle_id, week_no, weekday);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to, status, follow_up_date);
CREATE INDEX IF NOT EXISTS idx_tasks_customer ON tasks(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);

CREATE INDEX IF NOT EXISTS idx_customers_rep ON customers(rep_id);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quotes(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_rep ON quotes(rep_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_form_submissions_visit ON form_submissions(visit_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_customer ON form_submissions(customer_id);
CREATE INDEX IF NOT EXISTS idx_visits_rep_date ON visits(rep_id, planned_date);
CREATE INDEX IF NOT EXISTS idx_visits_customer ON visits(customer_id);
CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_rep ON orders(rep_id);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date);
CREATE INDEX IF NOT EXISTS idx_orders_visit ON orders(visit_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_quote_items_quote ON quote_items(quote_id);
CREATE INDEX IF NOT EXISTS idx_customer_prices_product ON customer_prices(product_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_price_rules_product ON price_rules(active, product_id);
CREATE INDEX IF NOT EXISTS idx_price_rules_category ON price_rules(active, category_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_customer ON users(customer_id);
CREATE INDEX IF NOT EXISTS idx_visit_photos_visit ON visit_photos(visit_id);

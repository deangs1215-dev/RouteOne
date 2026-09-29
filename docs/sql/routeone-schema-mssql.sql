-- RouteOne Database Schema (SQL Server)
-- Translated from SQLite schema.sql for SQL Server 2019+
-- Use: sqlcmd -S [server] -d RouteOne -i routeone-schema-mssql.sql

USE [RouteOne];
GO

-- Enable foreign key constraints
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

-- ============================================================
-- SETTINGS & CONFIGURATION
-- ============================================================

CREATE TABLE settings (
  [key] NVARCHAR(255) PRIMARY KEY,
  [value] NVARCHAR(MAX)
);
GO

-- ============================================================
-- SECURITY & ROLES
-- ============================================================

CREATE TABLE roles (
  id INT IDENTITY(1,1) PRIMARY KEY,
  [name] NVARCHAR(255) UNIQUE NOT NULL,
  permissions NVARCHAR(MAX) DEFAULT '[]'
);
GO

-- ============================================================
-- TERRITORIES & LOCATIONS
-- ============================================================

CREATE TABLE territories (
  id INT IDENTITY(1,1) PRIMARY KEY,
  [name] NVARCHAR(255) NOT NULL,
  region NVARCHAR(255)
);
GO

CREATE TABLE warehouses (
  id INT IDENTITY(1,1) PRIMARY KEY,
  code NVARCHAR(20) UNIQUE NOT NULL,
  [name] NVARCHAR(255) NOT NULL,
  active INT DEFAULT 1,
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO

-- ============================================================
-- USERS & PERSONNEL
-- ============================================================

CREATE TABLE users (
  id INT IDENTITY(1,1) PRIMARY KEY,
  [name] NVARCHAR(255) NOT NULL,
  email NVARCHAR(255) UNIQUE NOT NULL,
  password_hash NVARCHAR(255) NOT NULL,
  phone NVARCHAR(20),
  role_id INT NOT NULL REFERENCES roles(id),
  territory_id INT REFERENCES territories(id),
  customer_id INT,  -- for customer-portal logins (foreign key set below after customers table created)
  rep_code NVARCHAR(20),  -- rep's own code, e.g. matches SYSPRO/call-cycle sheets
  warehouse_id INT REFERENCES warehouses(id),  -- rep's home branch/depot
  sales_target FLOAT DEFAULT 0,
  active INT DEFAULT 1,
  must_change_password INT NOT NULL DEFAULT 1,
  reset_token_hash NVARCHAR(255),
  reset_token_expires DATETIME,
  token_version INT NOT NULL DEFAULT 0,
  documents_last_viewed_at DATETIME,
  home_address NVARCHAR(MAX),
  home_lat FLOAT,
  home_lng FLOAT,
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO

-- ============================================================
-- CUSTOMERS & CONTACTS
-- ============================================================

CREATE TABLE customers (
  id INT IDENTITY(1,1) PRIMARY KEY,
  code NVARCHAR(20) UNIQUE NOT NULL,
  [name] NVARCHAR(255) NOT NULL,
  classification NVARCHAR(10) DEFAULT 'B',
  territory_id INT REFERENCES territories(id),
  rep_id INT REFERENCES users(id),
  warehouse_id INT REFERENCES warehouses(id),
  contact_name NVARCHAR(255),
  phone NVARCHAR(20),
  email NVARCHAR(255),
  address NVARCHAR(MAX),
  city NVARCHAR(100),
  lat FLOAT,
  lng FLOAT,
  credit_limit FLOAT DEFAULT 0,
  balance FLOAT DEFAULT 0,
  payment_terms NVARCHAR(50) DEFAULT '30 days',
  visit_frequency NVARCHAR(20) DEFAULT 'weekly',
  [status] NVARCHAR(20) DEFAULT 'active',
  notes NVARCHAR(MAX),
  -- On-site overrides (actual location name, contact, delivery address if different from SYSPRO)
  onsite_name NVARCHAR(255),
  onsite_phone NVARCHAR(20),
  onsite_address NVARCHAR(MAX),
  onsite_lat FLOAT,
  onsite_lng FLOAT,
  onsite_contact NVARCHAR(MAX),
  onsite_cell NVARCHAR(20),
  onsite_pricelist NVARCHAR(100),
  onsite_vat NVARCHAR(50),
  -- Ship-to address from SYSPRO ARCustomer
  ship_to_name NVARCHAR(255),
  ship_to_address NVARCHAR(MAX),
  ship_to_city NVARCHAR(100),
  ship_to_postcode NVARCHAR(20),
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO

-- Add foreign key constraint for users.customer_id now that customers table exists
ALTER TABLE users
ADD CONSTRAINT fk_users_customer
FOREIGN KEY (customer_id) REFERENCES customers(id);
GO

CREATE TABLE customer_contacts (
  id INT IDENTITY(1,1) PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  [name] NVARCHAR(255) NOT NULL,
  role NVARCHAR(100),
  phone NVARCHAR(20),
  email NVARCHAR(255)
);
GO

CREATE TABLE customer_intel (
  customer_id INT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  current_supplier NVARCHAR(255),
  decision_maker NVARCHAR(255),
  best_visit_time NVARCHAR(255),
  delivery_notes NVARCHAR(MAX),
  products_of_interest NVARCHAR(MAX),
  competitor_notes NVARCHAR(MAX),
  general_notes NVARCHAR(MAX),
  updated_by INT REFERENCES users(id),
  updated_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO

CREATE TABLE customer_notes (
  id INT IDENTITY(1,1) PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  [user_id] INT NOT NULL REFERENCES users(id),
  note_type NVARCHAR(20) NOT NULL DEFAULT 'note',
  note NVARCHAR(MAX) NOT NULL,
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_customer_notes_customer ON customer_notes(customer_id, created_at DESC);
CREATE INDEX idx_customer_notes_user ON customer_notes(user_id, created_at DESC);
GO

-- ============================================================
-- PRODUCTS & INVENTORY
-- ============================================================

CREATE TABLE product_categories (
  id INT IDENTITY(1,1) PRIMARY KEY,
  [name] NVARCHAR(255) UNIQUE NOT NULL
);
GO

CREATE TABLE products (
  id INT IDENTITY(1,1) PRIMARY KEY,
  code NVARCHAR(20) UNIQUE NOT NULL,
  [name] NVARCHAR(255) NOT NULL,
  category_id INT REFERENCES product_categories(id),
  description NVARCHAR(MAX),
  uom NVARCHAR(20) DEFAULT 'each',
  pack_size NVARCHAR(50),
  pack_weight_kg FLOAT,
  conv_factor_alt_uom FLOAT,
  list_price FLOAT NOT NULL DEFAULT 0,
  cost_price FLOAT DEFAULT 0,
  stock_qty FLOAT DEFAULT 0,
  discontinued INT DEFAULT 0,
  active INT DEFAULT 1,
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_active ON products(active);
GO

CREATE TABLE product_stock (
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  qty_available FLOAT NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, warehouse_id)
);
GO

CREATE TABLE customer_prices (
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price FLOAT NOT NULL,
  PRIMARY KEY (customer_id, product_id)
);
GO
CREATE INDEX idx_customer_prices_product ON customer_prices(product_id);
GO

-- ============================================================
-- SYSPRO PRICING (SYNCED READ-ONLY)
-- ============================================================

CREATE TABLE syspro_customer_pricing (
  customer_code NVARCHAR(20) NOT NULL,
  product_code NVARCHAR(20) NOT NULL,
  contract_price FLOAT,
  buying_group_price FLOAT,
  price_code_price FLOAT,
  contract_start_date NVARCHAR(10),
  contract_end_date NVARCHAR(10),
  buying_group_start_date NVARCHAR(10),
  buying_group_end_date NVARCHAR(10),
  synced_at DATETIME DEFAULT SYSUTCDATETIME(),
  PRIMARY KEY (customer_code, product_code)
);
GO

-- Covering index for products.routes.js hot path (all pricing for one customer)
CREATE INDEX idx_pricing_customer_covering ON syspro_customer_pricing(
  customer_code, product_code, contract_price, buying_group_price, price_code_price,
  contract_start_date, contract_end_date, buying_group_start_date, buying_group_end_date
);
GO

-- ============================================================
-- PRICING RULES (PHASE 2)
-- ============================================================

CREATE TABLE price_rules (
  id INT IDENTITY(1,1) PRIMARY KEY,
  [name] NVARCHAR(255) NOT NULL,
  product_id INT REFERENCES products(id) ON DELETE CASCADE,
  category_id INT REFERENCES product_categories(id) ON DELETE CASCADE,
  rule_type NVARCHAR(20) NOT NULL DEFAULT 'discount_pct',
  discount_pct FLOAT,
  fixed_price FLOAT,
  min_qty FLOAT DEFAULT 0,
  starts_on NVARCHAR(10),
  ends_on NVARCHAR(10),
  active INT DEFAULT 1,
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_price_rules_product ON price_rules(active, product_id);
CREATE INDEX idx_price_rules_category ON price_rules(active, category_id);
GO

-- ============================================================
-- VISITS & ROUTE PLANNING
-- ============================================================

CREATE TABLE visits (
  id INT IDENTITY(1,1) PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  rep_id INT NOT NULL REFERENCES users(id),
  planned_date NVARCHAR(10),
  purpose NVARCHAR(50) DEFAULT 'sales call',
  [status] NVARCHAR(20) DEFAULT 'planned',
  route_order INT,
  check_in_at DATETIME,
  check_in_lat FLOAT,
  check_in_lng FLOAT,
  check_in_distance_m FLOAT,
  check_in_type NVARCHAR(20) DEFAULT 'onsite',
  check_in_address NVARCHAR(MAX),
  check_out_at DATETIME,
  check_out_lat FLOAT,
  check_out_lng FLOAT,
  notes NVARCHAR(MAX),
  outcome NVARCHAR(50),
  created_at DATETIME DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME
);
GO
CREATE INDEX idx_visits_rep_date ON visits(rep_id, planned_date);
CREATE INDEX idx_visits_customer ON visits(customer_id);
CREATE INDEX idx_visits_status ON visits(status);
GO

CREATE TABLE visit_reschedules (
  id INT IDENTITY(1,1) PRIMARY KEY,
  visit_id INT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  from_date NVARCHAR(10) NOT NULL,
  to_date NVARCHAR(10) NOT NULL,
  reason NVARCHAR(255),
  rescheduled_by INT NOT NULL REFERENCES users(id),
  rescheduled_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_visit_reschedules_visit ON visit_reschedules(visit_id);
GO

CREATE TABLE visit_photos (
  id INT IDENTITY(1,1) PRIMARY KEY,
  visit_id INT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  path NVARCHAR(MAX) NOT NULL,
  caption NVARCHAR(MAX),
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_visit_photos_visit ON visit_photos(visit_id);
GO

CREATE TABLE rep_locations (
  id INT IDENTITY(1,1) PRIMARY KEY,
  [user_id] INT NOT NULL REFERENCES users(id),
  lat FLOAT NOT NULL,
  lng FLOAT NOT NULL,
  recorded_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_rep_locations_user ON rep_locations(user_id, recorded_at);
GO

-- ============================================================
-- ORDERS & ORDER ITEMS
-- ============================================================

CREATE TABLE orders (
  id INT IDENTITY(1,1) PRIMARY KEY,
  number NVARCHAR(20) UNIQUE NOT NULL,
  customer_id INT NOT NULL REFERENCES customers(id),
  rep_id INT REFERENCES users(id),
  visit_id INT REFERENCES visits(id),
  warehouse_id INT REFERENCES warehouses(id),
  [status] NVARCHAR(20) DEFAULT 'submitted',
  order_date DATETIME DEFAULT SYSUTCDATETIME(),
  subtotal FLOAT DEFAULT 0,
  vat_amount FLOAT DEFAULT 0,
  total FLOAT DEFAULT 0,
  customer_order_no NVARCHAR(100),
  notes NVARCHAR(MAX),
  delivery_instructions NVARCHAR(MAX),
  signature NVARCHAR(MAX),
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_rep ON orders(rep_id);
CREATE INDEX idx_orders_date ON orders(order_date);
CREATE INDEX idx_orders_visit ON orders(visit_id);
GO

CREATE TABLE order_items (
  id INT IDENTITY(1,1) PRIMARY KEY,
  [order_id] INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  product_name NVARCHAR(255) NOT NULL,
  qty FLOAT NOT NULL,
  uom NVARCHAR(20),
  unit_price FLOAT NOT NULL,
  discount_pct FLOAT DEFAULT 0,
  line_total FLOAT NOT NULL,
  price_source NVARCHAR(50)
);
GO
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_product ON order_items(product_id);
GO

-- ============================================================
-- QUOTES & QUOTE ITEMS
-- ============================================================

CREATE TABLE quotes (
  id INT IDENTITY(1,1) PRIMARY KEY,
  number NVARCHAR(20) UNIQUE NOT NULL,
  customer_id INT NOT NULL REFERENCES customers(id),
  rep_id INT REFERENCES users(id),
  visit_id INT REFERENCES visits(id),
  [status] NVARCHAR(20) DEFAULT 'sent',
  quote_date DATETIME DEFAULT SYSUTCDATETIME(),
  valid_until NVARCHAR(10),
  subtotal FLOAT DEFAULT 0,
  vat_amount FLOAT DEFAULT 0,
  total FLOAT DEFAULT 0,
  notes NVARCHAR(MAX),
  [order_id] INT REFERENCES orders(id),
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_quotes_customer ON quotes(customer_id);
CREATE INDEX idx_quotes_rep ON quotes(rep_id);
CREATE INDEX idx_quotes_status ON quotes(status);
GO

CREATE TABLE quote_items (
  id INT IDENTITY(1,1) PRIMARY KEY,
  quote_id INT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  product_name NVARCHAR(255) NOT NULL,
  qty FLOAT NOT NULL,
  uom NVARCHAR(20),
  unit_price FLOAT NOT NULL,
  discount_pct FLOAT DEFAULT 0,
  line_total FLOAT NOT NULL,
  price_source NVARCHAR(50)
);
GO
CREATE INDEX idx_quote_items_quote ON quote_items(quote_id);
GO

-- ============================================================
-- INVOICES (SYSPRO READ-ONLY)
-- ============================================================

CREATE TABLE invoices (
  id INT IDENTITY(1,1) PRIMARY KEY,
  number NVARCHAR(20) UNIQUE NOT NULL,
  customer_id INT REFERENCES customers(id),
  customer_code NVARCHAR(20) NOT NULL,
  order_number NVARCHAR(50),
  invoice_date NVARCHAR(10) NOT NULL,
  due_date NVARCHAR(10),
  subtotal FLOAT DEFAULT 0,
  vat_amount FLOAT DEFAULT 0,
  total FLOAT DEFAULT 0,
  amount_paid FLOAT DEFAULT 0,
  balance FLOAT DEFAULT 0,
  [status] NVARCHAR(20) DEFAULT 'outstanding',
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_invoices_customer ON invoices(customer_id, invoice_date);
GO

CREATE TABLE invoice_items (
  id INT IDENTITY(1,1) PRIMARY KEY,
  invoice_id INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id),
  product_code NVARCHAR(20) NOT NULL,
  delivery_customer_id INT REFERENCES customers(id),
  delivery_customer_code NVARCHAR(20),
  qty FLOAT NOT NULL,
  unit_price FLOAT NOT NULL,
  line_total FLOAT NOT NULL
);
GO
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX idx_invoice_items_product ON invoice_items(product_id);
CREATE INDEX idx_invoice_items_delivery_customer ON invoice_items(delivery_customer_id);
GO

-- ============================================================
-- SALES DATA (SYNCED FROM SYSPRO)
-- ============================================================

CREATE TABLE rep_monthly_sales (
  id INT IDENTITY(1,1) PRIMARY KEY,
  rep_id INT NOT NULL REFERENCES users(id),
  [month] NVARCHAR(7) NOT NULL,
  sales_value FLOAT NOT NULL DEFAULT 0,
  synced_at DATETIME DEFAULT SYSUTCDATETIME(),
  UNIQUE(rep_id, month)
);
GO
CREATE INDEX idx_rep_monthly_sales_rep_month ON rep_monthly_sales(rep_id, month);
GO

CREATE TABLE customer_monthly_sales (
  customer_code NVARCHAR(20) NOT NULL,
  [month] NVARCHAR(7) NOT NULL,
  sales_value FLOAT NOT NULL DEFAULT 0,
  synced_at DATETIME DEFAULT SYSUTCDATETIME(),
  PRIMARY KEY (customer_code, month)
);
GO
CREATE INDEX idx_customer_monthly_sales_month ON customer_monthly_sales(customer_code, month);
GO

-- ============================================================
-- FORMS & SUBMISSIONS
-- ============================================================

CREATE TABLE form_templates (
  id INT IDENTITY(1,1) PRIMARY KEY,
  [name] NVARCHAR(255) NOT NULL,
  description NVARCHAR(MAX),
  fields NVARCHAR(MAX) NOT NULL DEFAULT '[]',
  category NVARCHAR(50) DEFAULT 'general',
  notify_email NVARCHAR(255),
  active INT DEFAULT 1,
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO

CREATE TABLE form_submissions (
  id INT IDENTITY(1,1) PRIMARY KEY,
  template_id INT NOT NULL REFERENCES form_templates(id),
  visit_id INT REFERENCES visits(id),
  customer_id INT REFERENCES customers(id),
  [user_id] INT REFERENCES users(id),
  [data] NVARCHAR(MAX) NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_form_submissions_visit ON form_submissions(visit_id);
CREATE INDEX idx_form_submissions_customer ON form_submissions(customer_id);
GO

-- ============================================================
-- DRAFTS (IN-PROGRESS CAPTURES)
-- ============================================================

CREATE TABLE drafts (
  id INT IDENTITY(1,1) PRIMARY KEY,
  rep_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind NVARCHAR(20) NOT NULL,
  customer_id INT REFERENCES customers(id),
  template_id INT REFERENCES form_templates(id),
  visit_id INT REFERENCES visits(id),
  label NVARCHAR(255),
  [data] NVARCHAR(MAX) NOT NULL DEFAULT '{}',
  updated_at DATETIME DEFAULT SYSUTCDATETIME(),
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_drafts_rep ON drafts(rep_id, kind);
GO

-- ============================================================
-- EMAIL & NOTIFICATIONS
-- ============================================================

CREATE TABLE email_recipients (
  id INT IDENTITY(1,1) PRIMARY KEY,
  [name] NVARCHAR(255) NOT NULL,
  email NVARCHAR(255) NOT NULL UNIQUE,
  description NVARCHAR(MAX),
  category NVARCHAR(50) NOT NULL DEFAULT 'orders',
  warehouse_id INT REFERENCES warehouses(id),
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO

CREATE TABLE rep_email_contacts (
  id INT IDENTITY(1,1) PRIMARY KEY,
  [user_id] INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  [name] NVARCHAR(255) NOT NULL,
  email NVARCHAR(255) NOT NULL,
  created_at DATETIME DEFAULT SYSUTCDATETIME(),
  UNIQUE (user_id, email)
);
GO
CREATE INDEX idx_rep_email_contacts_user ON rep_email_contacts(user_id);
GO

CREATE TABLE email_log (
  id INT IDENTITY(1,1) PRIMARY KEY,
  kind NVARCHAR(20) NOT NULL,
  ref_id INT NOT NULL,
  to_addr NVARCHAR(255) NOT NULL,
  cc_addr NVARCHAR(255),
  subject NVARCHAR(500) NOT NULL,
  body_html NVARCHAR(MAX) NOT NULL,
  [status] NVARCHAR(20) DEFAULT 'pending',
  error NVARCHAR(MAX),
  created_at DATETIME DEFAULT SYSUTCDATETIME(),
  sent_at DATETIME
);
GO

-- ============================================================
-- ACTIVITY & AUDIT LOG
-- ============================================================

CREATE TABLE activity_log (
  id INT IDENTITY(1,1) PRIMARY KEY,
  [user_id] INT,
  action NVARCHAR(100) NOT NULL,
  entity_type NVARCHAR(50) NOT NULL,
  entity_id INT,
  detail NVARCHAR(MAX),
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO

-- ============================================================
-- SYNC TRACKING
-- ============================================================

CREATE TABLE sync_runs (
  id INT IDENTITY(1,1) PRIMARY KEY,
  source NVARCHAR(50) NOT NULL,
  entity NVARCHAR(100) NOT NULL,
  [status] NVARCHAR(20) DEFAULT 'running',
  rows_read INT DEFAULT 0,
  rows_upserted INT DEFAULT 0,
  rows_skipped INT DEFAULT 0,
  error NVARCHAR(MAX),
  started_at DATETIME DEFAULT SYSUTCDATETIME(),
  finished_at DATETIME
);
GO

-- ============================================================
-- DOCUMENTS (MARKETING/SALES)
-- ============================================================

CREATE TABLE documents (
  id INT IDENTITY(1,1) PRIMARY KEY,
  title NVARCHAR(255) NOT NULL,
  description NVARCHAR(MAX),
  file_path NVARCHAR(MAX) NOT NULL,
  uploaded_by INT REFERENCES users(id),
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO

-- ============================================================
-- ROUTE PLANNING (PHASE 5)
-- ============================================================

CREATE TABLE route_cycles (
  id INT IDENTITY(1,1) PRIMARY KEY,
  rep_id INT NOT NULL REFERENCES users(id),
  [name] NVARCHAR(255),
  rep_code NVARCHAR(20),
  start_date NVARCHAR(10) NOT NULL,
  cycle_weeks INT NOT NULL DEFAULT 8,
  repeat_count INT NOT NULL DEFAULT 1,
  active INT NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_route_cycles_rep ON route_cycles(rep_id, active);
GO

CREATE TABLE route_cycle_stops (
  id INT IDENTITY(1,1) PRIMARY KEY,
  cycle_id INT NOT NULL REFERENCES route_cycles(id) ON DELETE CASCADE,
  week_no INT NOT NULL,
  weekday INT NOT NULL,
  customer_id INT REFERENCES customers(id),
  customer_code NVARCHAR(20),
  seq INT
);
GO
CREATE INDEX idx_route_cycle_stops_cycle ON route_cycle_stops(cycle_id, week_no, weekday);
GO

-- ============================================================
-- TASKS (PHASE 5)
-- ============================================================

CREATE TABLE tasks (
  id INT IDENTITY(1,1) PRIMARY KEY,
  customer_id INT REFERENCES customers(id),
  assigned_to INT NOT NULL REFERENCES users(id),
  created_by INT NOT NULL REFERENCES users(id),
  task_type NVARCHAR(100) NOT NULL,
  follow_up_date NVARCHAR(10) NOT NULL,
  notes NVARCHAR(MAX),
  [status] NVARCHAR(20) NOT NULL DEFAULT 'open',
  branch NVARCHAR(100),
  created_at DATETIME DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_tasks_assigned_to ON tasks(assigned_to, status, follow_up_date);
CREATE INDEX idx_tasks_customer ON tasks(customer_id, status);
CREATE INDEX idx_tasks_created_by ON tasks(created_by);
GO

-- ============================================================
-- SALES MANAGEMENT
-- ============================================================

CREATE TABLE branch_clock_ins (
  id INT IDENTITY(1,1) PRIMARY KEY,
  rep_id INT NOT NULL REFERENCES users(id),
  clock_in_at DATETIME NOT NULL DEFAULT SYSUTCDATETIME(),
  clock_out_at DATETIME,
  notes NVARCHAR(MAX),
  created_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_branch_clock_ins_rep ON branch_clock_ins(rep_id, clock_in_at DESC);
GO

CREATE TABLE manager_warehouses (
  manager_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  PRIMARY KEY (manager_id, warehouse_id)
);
GO
CREATE INDEX idx_manager_warehouses_manager ON manager_warehouses(manager_id);
GO

CREATE TABLE rep_budgets (
  rep_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  [month] INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  budget FLOAT NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME DEFAULT SYSUTCDATETIME(),
  PRIMARY KEY (rep_id, month)
);
GO

CREATE TABLE sales_pushes (
  id INT IDENTITY(1,1) PRIMARY KEY,
  message NVARCHAR(MAX) NOT NULL,
  active INT NOT NULL DEFAULT 1,
  created_by INT NOT NULL REFERENCES users(id),
  created_at DATETIME DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_sales_pushes_active ON sales_pushes(active, created_at);
GO

-- ============================================================
-- SUPPORT & HELP DESK
-- ============================================================

CREATE TABLE support_tickets (
  id INT IDENTITY(1,1) PRIMARY KEY,
  created_by INT NOT NULL REFERENCES users(id),
  subject NVARCHAR(500) NOT NULL,
  description NVARCHAR(MAX) NOT NULL,
  category NVARCHAR(50) NOT NULL DEFAULT 'other',
  priority NVARCHAR(20) NOT NULL DEFAULT 'normal',
  [status] NVARCHAR(20) NOT NULL DEFAULT 'open',
  customer_id INT REFERENCES customers(id),
  [order_id] INT REFERENCES orders(id),
  admin_notes NVARCHAR(MAX),
  resolved_by INT REFERENCES users(id),
  resolved_at DATETIME,
  created_at DATETIME DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX idx_support_tickets_status ON support_tickets(status, created_at);
CREATE INDEX idx_support_tickets_created_by ON support_tickets(created_by, status);
GO

-- ============================================================
-- ENABLE FOREIGN KEY CONSTRAINTS
-- ============================================================

ALTER TABLE users ADD CONSTRAINT fk_users_role
FOREIGN KEY (role_id) REFERENCES roles(id);
GO

ALTER TABLE users ADD CONSTRAINT fk_users_territory
FOREIGN KEY (territory_id) REFERENCES territories(id);
GO

ALTER TABLE users ADD CONSTRAINT fk_users_warehouse
FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);
GO

ALTER TABLE customers ADD CONSTRAINT fk_customers_territory
FOREIGN KEY (territory_id) REFERENCES territories(id);
GO

ALTER TABLE customers ADD CONSTRAINT fk_customers_rep
FOREIGN KEY (rep_id) REFERENCES users(id);
GO

ALTER TABLE customers ADD CONSTRAINT fk_customers_warehouse
FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);
GO

-- ============================================================
-- VERIFY TABLES CREATED
-- ============================================================

SELECT
  'Tables created successfully' AS Status,
  COUNT(*) AS [Table Count]
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'dbo'
  AND TABLE_TYPE = 'BASE TABLE';
GO

PRINT 'RouteOne database schema created successfully.';
GO


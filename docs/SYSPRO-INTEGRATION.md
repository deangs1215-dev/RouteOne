# SYSPRO integration — what's needed

The app integrates with SYSPRO in **read-only** mode via SQL views, plus email
for the outbound flow. Orders are **not** posted into SYSPRO — they are captured
in the app and emailed to **telesales**, who capture them in SYSPRO.
(If direct posting is ever wanted later, that's done through SYSPRO e.net
Solutions business objects — `SORTOI` for sales orders — and needs an e.net
license; nothing in the current design blocks adding that.)

## Confirmed environment (South Bakels)

- **SYSPRO version:** 8.2 — the view templates below match this; the DBA validates exact columns.
- **Hosting:** RouteOne runs on its own server on the **same private network** as the SYSPRO SQL Server (no VPN or internet exposure needed). A Linux server is planned.
- **SQL Server:** managed by internal IT, who create the read-only login and open port 1433 between the two servers.
- **Pricing:** contract + customer pricing — the exact source table is confirmed with the SYSPRO specialist when building `vw_FS_ContractPrices`.
- **Automatic sync:** now built into the app (no external Task Scheduler/cron) — an admin sets the cadence on the Integration page (off / hourly / every 4 hours / daily at a chosen time).

## Checklist — what to request from IT / the SYSPRO consultant

1. **Read-only SQL Server login** on the SYSPRO company database
   (e.g. `fieldsales_ro`), with SELECT rights on the six views below only.
2. **Six SQL views** created on the SYSPRO database (definitions below —
   the consultant should validate table/column names against your SYSPRO
   version and pricing setup).
3. **Network access** from the app server to the SQL Server (port 1433).
4. **SMTP mailbox** for outbound mail (e.g. `fieldsales@company.co.za` via
   Office 365 or your mail server) + the **orders department address** that
   should receive order emails.
5. Set the **automatic sync schedule** on the Integration page (built into the
   app — off / hourly / every 4 hours / daily at a set time). A manual "Sync all"
   button is always available too.

## The six views

The app runs `SELECT * FROM <view>` and expects these exact column names.
Keeping the mapping inside the views means SYSPRO upgrades or company-specific
customisations never touch the app.

### 1. vw_FS_Warehouses

The depots/branches customers are fulfilled from. Each customer is fixed to
one (via `vw_FS_Customers.warehouse_code` below) — reps don't choose a
warehouse per order, it's shown read-only wherever the order is placed.

| Column | Type | SYSPRO source (typical) |
|---|---|---|
| code | varchar | InvWarehouse.Warehouse |
| name | varchar | InvWarehouse.Description |

```sql
CREATE VIEW vw_FS_Warehouses AS
SELECT DISTINCT
  RTRIM(w.Warehouse)    AS code,
  RTRIM(w.Description)  AS name
FROM InvWarehouse w
WHERE w.Warehouse NOT LIKE 'Z%';
```

### 2. vw_FS_Customers

| Column | Type | SYSPRO source (typical) |
|---|---|---|
| code | varchar | ArCustomer.Customer |
| name | varchar | ArCustomer.Name |
| contact_name | varchar | ArCustomer.Contact |
| phone | varchar | ArCustomer.Telephone |
| email | varchar | ArCustomer.Email |
| address | varchar | ArCustomer.SoldToAddr1 + 2 |
| city | varchar | ArCustomer.SoldToAddr3 |
| ship_to_name | varchar | ArCustomer.ShipToName |
| ship_to_address | varchar | ArCustomer.ShipToAddr1 + 2 |
| ship_to_city | varchar | ArCustomer.ShipToAddr3 |
| ship_to_postcode | varchar | ArCustomer.ShipToAddr4 |
| credit_limit | decimal | ArCustomer.CreditLimit |
| balance | decimal | ArCustomerBal.CurrentBalance1 |
| payment_terms | varchar | terms description |
| on_hold | int (0/1) | ArCustomer.CustomerOnHold |
| warehouse_code | varchar | ArCustomer.Warehouse (default/branch warehouse) — must match a code in vw_FS_Warehouses |

```sql
CREATE VIEW vw_FS_Customers AS
SELECT
  RTRIM(c.Customer)                    AS code,
  RTRIM(c.Name)                        AS name,
  RTRIM(c.Contact)                     AS contact_name,
  RTRIM(c.Telephone)                   AS phone,
  RTRIM(c.Email)                       AS email,
  RTRIM(c.SoldToAddr1) + ', ' + RTRIM(c.SoldToAddr2) AS address,
  RTRIM(c.SoldToAddr3)                 AS city,
  RTRIM(c.ShipToName)                  AS ship_to_name,
  RTRIM(c.ShipToAddr1) + ', ' + RTRIM(c.ShipToAddr2) AS ship_to_address,
  RTRIM(c.ShipToAddr3)                 AS ship_to_city,
  RTRIM(c.ShipToAddr4)                 AS ship_to_postcode,
  c.CreditLimit                        AS credit_limit,
  ISNULL(b.CurrentBalance1, 0)         AS balance,
  RTRIM(c.TermsCode)                   AS payment_terms,   -- or join to terms description
  CASE WHEN c.CustomerOnHold = 'Y' THEN 1 ELSE 0 END AS on_hold,
  RTRIM(c.Warehouse)                   AS warehouse_code   -- validate: the field holding the customer's default depot
FROM ArCustomer c
LEFT JOIN ArCustomerBal b ON b.Customer = c.Customer
WHERE c.Customer NOT LIKE 'Z%';   -- exclude dummy/closed accounts as applicable
```

### 3. vw_FS_Products

| Column | SYSPRO source (typical) |
|---|---|
| code | InvMaster.StockCode |
| name | InvMaster.Description |
| category | product class description |
| description | InvMaster.LongDesc |
| uom | InvMaster.StockUom |
| pack_size | free text / custom field |
| list_price | InvPrice.SellingPrice for your list price code |
| cost_price | InvWarehouse.UnitCost or costing table |

```sql
CREATE VIEW vw_FS_Products AS
SELECT
  RTRIM(m.StockCode)      AS code,
  RTRIM(m.Description)    AS name,
  RTRIM(m.ProductClass)   AS category,      -- or join SalProductClass for the description
  RTRIM(m.LongDesc)       AS description,
  RTRIM(m.StockUom)       AS uom,
  NULL                    AS pack_size,
  ISNULL(p.SellingPrice, 0) AS list_price,
  0                       AS cost_price     -- map if margin reporting is wanted
FROM InvMaster m
LEFT JOIN InvPrice p ON p.StockCode = m.StockCode AND p.PriceCode = 'A'  -- your list price code
WHERE m.StockCode NOT LIKE 'Z%';
```

### 4. vw_FS_Stock

| Column | SYSPRO source (typical) |
|---|---|
| code | InvWarehouse.StockCode |
| qty_available | QtyOnHand − QtyAllocated (chosen warehouses) |

```sql
CREATE VIEW vw_FS_Stock AS
SELECT
  RTRIM(w.StockCode)                        AS code,
  SUM(w.QtyOnHand - w.QtyAllocated)         AS qty_available
FROM InvWarehouse w
WHERE w.Warehouse IN ('FG')                 -- the warehouse(s) reps sell from
GROUP BY w.StockCode;
```

### 5. vw_FS_ContractPrices

Customer-specific pricing. Where this lives depends on how pricing is set up in
your SYSPRO (contract pricing, customer price codes, or trade promotions) —
the consultant maps whichever applies. The app just needs:

| Column | Meaning |
|---|---|
| customer_code | SYSPRO account (matches vw_FS_Customers.code) |
| product_code | stock code (matches vw_FS_Products.code) |
| price | the nett contract selling price |

```sql
CREATE VIEW vw_FS_ContractPrices AS
SELECT
  RTRIM(cp.Customer)   AS customer_code,
  RTRIM(cp.StockCode)  AS product_code,
  cp.FixedPrice        AS price
FROM SorContractPrice cp          -- validate: contract price table for your version/setup
WHERE cp.FixedPrice > 0;
```

### 6. vw_FS_Invoices

Customer AR invoices, shown read-only on each customer screen ("Invoices — last
30 days"). SYSPRO is the system of record for billing; the app only displays.
Return recent invoices (the app filters to a rolling 30-day window per customer,
so returning ~the last 60–90 days is plenty). One row per invoice:

| Column | Meaning |
|---|---|
| number | invoice number (unique — the app keys on this) |
| customer_code | SYSPRO account (matches vw_FS_Customers.code) |
| order_number | originating sales order reference (optional) |
| invoice_date | invoice date, `YYYY-MM-DD` |
| due_date | payment due date (optional; used to flag *overdue*) |
| subtotal | nett excl. VAT |
| vat_amount | VAT value |
| total | gross incl. VAT |
| amount_paid | amount settled to date (optional) |
| balance | outstanding = total − amount_paid (optional; derived if omitted) |
| status | `paid` / `outstanding` / `overdue` (optional; derived if omitted) |

If `status` is omitted the app derives it: `paid` when balance ≤ 0, `overdue`
when the due date is past, else `outstanding`. Likewise `balance` is derived
from `total − amount_paid` when not supplied.

```sql
CREATE VIEW vw_FS_Invoices AS
SELECT
  RTRIM(inv.Invoice)      AS number,
  RTRIM(inv.Customer)     AS customer_code,
  RTRIM(inv.SalesOrder)   AS order_number,
  CONVERT(char(10), inv.InvoiceDate, 23) AS invoice_date,
  CONVERT(char(10), inv.DueDate, 23)     AS due_date,
  inv.MerchandiseValue    AS subtotal,     -- validate column names for your version
  inv.TaxValue            AS vat_amount,
  inv.InvoiceValue        AS total,
  inv.PaidValue           AS amount_paid,
  inv.BalanceValue        AS balance
FROM ArInvoice inv                          -- validate: AR invoice/detail table for your setup
WHERE inv.InvoiceDate >= DATEADD(day, -90, GETDATE());
```

## Sync behaviour (app side)

- Keyed on customer **code** and stock **code**; existing rows are updated,
  new ones inserted. Runs are logged on the Integration page.
- SYSPRO is the **master** for: name, contact details, credit limit, balance,
  terms, on-hold flag, warehouse assignment, product data, list prices, stock,
  contract prices, invoices.
- Each customer is fixed to **one warehouse** (its fulfilling depot). Orders
  snapshot the customer's warehouse at the moment they're placed, so a later
  change to the customer's assigned warehouse doesn't rewrite history.
- **Rep matching:** On first sync, new customers are auto-assigned to their
  SYSPRO rep using the rep code + warehouse. Reps must exist in RouteOne with
  matching `rep_code` and `warehouse` assignment. Existing customers are never
  re-assigned by sync (rep assignment is app-managed once set) — use the
  "Match customers to reps" button for bulk backfill.
- Invoices are keyed on the invoice **number** (upserted, never edited in-app)
  and displayed read-only per customer for the last 30 days.
- The app remains the master for: rep/territory assignment (after first sync),
  A/B/C grading, GPS pins, visit frequency, notes — a sync never touches those.
- A customer on hold in SYSPRO is blocked from ordering in the app immediately
  after sync (quotes still allowed).
- "Demo data" source mode exercises the whole pipeline before SYSPRO is wired up.

## Security

**Passwords are encrypted at rest.** The SYSPRO database password and SMTP password are stored
encrypted in the app database (never plaintext), using AES-256 encryption.

- Copy `.env.example` to `.env` and set `SECRET_KEY` to a random value:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
  `.env` is gitignored — never commit it. If `SECRET_KEY` isn't set, the server
  logs a warning at startup and falls back to an insecure hardcoded key (dev only).
- Changing `SECRET_KEY` after secrets are already saved makes them
  undecryptable with the new key — re-enter the SYSPRO/SMTP passwords on the
  Integration page once after rotating it.
- The read-only SYSPRO login remains least-privilege (SELECT on the six views only, no write access).

## Outbound flow (no direct posting)

- **Order submitted in app** → HTML email to the orders department (rep in CC)
  with the SYSPRO account code, stock codes, quantities, prices, delivery
  notes — everything needed to capture the order in SYSPRO. Automatic on
  submit (toggle on the Integration page) plus a manual button on each order.
- **Quote** → emailed to the customer's email address, rep in CC.
- All emails are stored in the email log first; if SMTP is down or not yet
  configured they wait as *pending* and can be viewed/re-sent from the
  Integration page.

## Later: direct posting via e.net (optional)

When the orders team is comfortable, direct capture uses SYSPRO e.net Solutions:
- e.net license + business objects: `SORTOI` (sales order import),
  optionally `QOTTOI` (quotations).
- The app would call a small connector (WCF/REST via SYSPRO 8's e.net REST
  gateway) posting the same payload it currently emails.
- The email flow stays as fallback/audit.

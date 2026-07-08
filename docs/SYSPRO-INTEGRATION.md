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
   (e.g. `fieldsales_ro`), with SELECT rights on the four views below only.
2. **Four SQL views** created on the SYSPRO database (definitions below —
   the consultant should validate table/column names against your SYSPRO
   version and pricing setup).
3. **Network access** from the app server to the SQL Server (port 1433).
4. **SMTP mailbox** for outbound mail (e.g. `fieldsales@company.co.za` via
   Office 365 or your mail server) + the **orders department address** that
   should receive order emails.
5. Set the **automatic sync schedule** on the Integration page (built into the
   app — off / hourly / every 4 hours / daily at a set time). A manual "Sync all"
   button is always available too.

## The four views

The app runs `SELECT * FROM <view>` and expects these exact column names.
Keeping the mapping inside the views means SYSPRO upgrades or company-specific
customisations never touch the app.

### 1. vw_FS_Customers

| Column | Type | SYSPRO source (typical) |
|---|---|---|
| code | varchar | ArCustomer.Customer |
| name | varchar | ArCustomer.Name |
| contact_name | varchar | ArCustomer.Contact |
| phone | varchar | ArCustomer.Telephone |
| email | varchar | ArCustomer.Email |
| address | varchar | ArCustomer.SoldToAddr1 + 2 |
| city | varchar | ArCustomer.SoldToAddr3 |
| credit_limit | decimal | ArCustomer.CreditLimit |
| balance | decimal | ArCustomerBal.CurrentBalance1 |
| payment_terms | varchar | terms description |
| on_hold | int (0/1) | ArCustomer.CustomerOnHold |

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
  c.CreditLimit                        AS credit_limit,
  ISNULL(b.CurrentBalance1, 0)         AS balance,
  RTRIM(c.TermsCode)                   AS payment_terms,   -- or join to terms description
  CASE WHEN c.CustomerOnHold = 'Y' THEN 1 ELSE 0 END AS on_hold
FROM ArCustomer c
LEFT JOIN ArCustomerBal b ON b.Customer = c.Customer
WHERE c.Customer NOT LIKE 'Z%';   -- exclude dummy/closed accounts as applicable
```

### 2. vw_FS_Products

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

### 3. vw_FS_Stock

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

### 4. vw_FS_ContractPrices

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

## Sync behaviour (app side)

- Keyed on customer **code** and stock **code**; existing rows are updated,
  new ones inserted. Runs are logged on the Integration page.
- SYSPRO is the **master** for: name, contact details, credit limit, balance,
  terms, on-hold flag, product data, list prices, stock, contract prices.
- The app remains the master for: rep/territory assignment, A/B/C grading,
  GPS pins, visit frequency, notes — a sync never touches those.
- A customer on hold in SYSPRO is blocked from ordering in the app immediately
  after sync (quotes still allowed).
- "Demo data" source mode exercises the whole pipeline before SYSPRO is wired up.

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

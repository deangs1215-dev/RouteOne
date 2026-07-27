# RouteOne / SYSPRO SQL Views Handover

This document is for the SYSPRO DBA or SYSPRO consultant.

RouteOne connects to the SYSPRO company database in read-only mode and syncs data from SQL Server views. The app does not write orders back to SYSPRO. Orders captured in RouteOne are emailed to telesales/orders for capture in SYSPRO.

The app runs:

```sql
SELECT * FROM dbo.vw_FS_Warehouses;
SELECT * FROM dbo.vw_FS_Customers;
SELECT * FROM dbo.vw_FS_Products;
SELECT * FROM dbo.vw_FS_Stock;
SELECT * FROM dbo.vw_FS_ContractPrices;
SELECT * FROM dbo.vw_FS_Invoices;
```

The column names below are the required contract. The underlying SYSPRO table and column names must be validated against the live SYSPRO 8.2 company database before running in production.

## Step 1: Confirm The SYSPRO Company Database

Confirm the SQL Server database name for the live SYSPRO company, for example:

```sql
USE [YourSysproCompanyDatabase];
GO
```

Run all view scripts in that company database.

## Step 2: Create The Warehouse View

Customers sync with a fixed fulfilling depot/warehouse. This view must be created before the customer view is tested.

Required columns:

| Column | Meaning |
| --- | --- |
| code | Warehouse/depot code |
| name | Warehouse/depot description |

```sql
CREATE OR ALTER VIEW dbo.vw_FS_Warehouses AS
SELECT DISTINCT
    RTRIM(w.Warehouse) AS code,
    RTRIM(w.Description) AS name
FROM dbo.InvWarehouse w
WHERE w.Warehouse IS NOT NULL
  AND RTRIM(w.Warehouse) <> ''
  AND w.Warehouse NOT LIKE 'Z%';
GO
```

Validation:

```sql
SELECT TOP 50 * FROM dbo.vw_FS_Warehouses ORDER BY code;
SELECT code, COUNT(*) AS row_count
FROM dbo.vw_FS_Warehouses
GROUP BY code
HAVING COUNT(*) > 1;
```

The duplicate check must return zero rows.

## Step 3: Create The Customer View

RouteOne uses SYSPRO as the master for customer name, contact details, credit state, balance, terms, hold status, and warehouse assignment.

Required columns:

| Column | Meaning |
| --- | --- |
| code | SYSPRO customer account code |
| name | Customer name |
| contact_name | Main contact |
| phone | Telephone number |
| email | Email address |
| address | Street/address line |
| city | City/suburb |
| credit_limit | Customer credit limit |
| balance | Current customer balance |
| payment_terms | Terms code or description |
| on_hold | 1 when blocked/on hold, otherwise 0 |
| warehouse_code | Customer default fulfilling warehouse, matching `vw_FS_Warehouses.code` |
| rep_code | Sales rep/salesperson code from SYSPRO (used to match customers to reps in RouteOne) |

```sql
CREATE OR ALTER VIEW dbo.vw_FS_Customers AS
SELECT
    RTRIM(c.Customer) AS code,
    RTRIM(c.Name) AS name,
    NULLIF(RTRIM(c.Contact), '') AS contact_name,
    NULLIF(RTRIM(c.Telephone), '') AS phone,
    NULLIF(RTRIM(c.Email), '') AS email,
    NULLIF(CONCAT(
        NULLIF(RTRIM(c.SoldToAddr1), ''),
        CASE
            WHEN NULLIF(RTRIM(c.SoldToAddr1), '') IS NOT NULL
             AND NULLIF(RTRIM(c.SoldToAddr2), '') IS NOT NULL
            THEN ', '
            ELSE ''
        END,
        NULLIF(RTRIM(c.SoldToAddr2), '')
    ), '') AS address,
    NULLIF(RTRIM(c.SoldToAddr3), '') AS city,
    ISNULL(c.CreditLimit, 0) AS credit_limit,
    ISNULL(b.CurrentBalance1, 0) AS balance,
    NULLIF(RTRIM(c.TermsCode), '') AS payment_terms,
    CASE WHEN c.CustomerOnHold = 'Y' THEN 1 ELSE 0 END AS on_hold,
    NULLIF(RTRIM(c.Warehouse), '') AS warehouse_code,
    NULLIF(RTRIM(c.SalesPersonNo), '') AS rep_code
FROM dbo.ArCustomer c
LEFT JOIN dbo.ArCustomerBal b
    ON b.Customer = c.Customer
WHERE c.Customer IS NOT NULL
  AND RTRIM(c.Customer) <> ''
  AND c.Customer NOT LIKE 'Z%';
GO
```

Validation:

```sql
SELECT TOP 50 * FROM dbo.vw_FS_Customers ORDER BY code;

SELECT code, COUNT(*) AS row_count
FROM dbo.vw_FS_Customers
GROUP BY code
HAVING COUNT(*) > 1;

SELECT c.code, c.name, c.warehouse_code
FROM dbo.vw_FS_Customers c
LEFT JOIN dbo.vw_FS_Warehouses w
    ON w.code = c.warehouse_code
WHERE c.warehouse_code IS NOT NULL
  AND w.code IS NULL;
```

Both validation checks after the preview must return zero rows.

## Step 4: Create The Product View

RouteOne uses this as the product catalogue for orders and quotes.

Required columns:

| Column | Meaning |
| --- | --- |
| code | SYSPRO stock code |
| name | Product description/name |
| category | Product class or category |
| description | Long description, optional |
| uom | Unit of measure |
| pack_size | Pack size text, optional |
| list_price | Standard/list selling price |
| cost_price | Cost price, optional |

```sql
CREATE OR ALTER VIEW dbo.vw_FS_Products AS
SELECT
    RTRIM(m.StockCode) AS code,
    RTRIM(m.Description) AS name,
    NULLIF(RTRIM(m.ProductClass), '') AS category,
    NULLIF(RTRIM(m.LongDesc), '') AS description,
    NULLIF(RTRIM(m.StockUom), '') AS uom,
    CAST(NULL AS varchar(100)) AS pack_size,
    ISNULL(p.SellingPrice, 0) AS list_price,
    CAST(0 AS decimal(18, 4)) AS cost_price
FROM dbo.InvMaster m
LEFT JOIN dbo.InvPrice p
    ON p.StockCode = m.StockCode
   AND p.PriceCode = 'A' -- TODO: confirm the correct list price code
WHERE m.StockCode IS NOT NULL
  AND RTRIM(m.StockCode) <> ''
  AND m.StockCode NOT LIKE 'Z%';
GO
```

Validation:

```sql
SELECT TOP 50 * FROM dbo.vw_FS_Products ORDER BY code;

SELECT code, COUNT(*) AS row_count
FROM dbo.vw_FS_Products
GROUP BY code
HAVING COUNT(*) > 1;

SELECT TOP 50 *
FROM dbo.vw_FS_Products
WHERE list_price IS NULL OR list_price < 0;
```

The duplicate check must return zero rows. Negative/null prices must be investigated before go-live.

## Step 5: Create The Stock Availability View

RouteOne stores one available stock quantity per product code.

Required columns:

| Column | Meaning |
| --- | --- |
| code | SYSPRO stock code |
| qty_available | Available quantity |

```sql
CREATE OR ALTER VIEW dbo.vw_FS_Stock AS
SELECT
    RTRIM(w.StockCode) AS code,
    SUM(ISNULL(w.QtyOnHand, 0) - ISNULL(w.QtyAllocated, 0)) AS qty_available
FROM dbo.InvWarehouse w
WHERE w.StockCode IS NOT NULL
  AND RTRIM(w.StockCode) <> ''
  AND w.Warehouse IN ('FG') -- TODO: confirm the warehouse/depot codes to expose
GROUP BY w.StockCode;
GO
```

Validation:

```sql
SELECT TOP 50 * FROM dbo.vw_FS_Stock ORDER BY code;

SELECT s.code
FROM dbo.vw_FS_Stock s
LEFT JOIN dbo.vw_FS_Products p
    ON p.code = s.code
WHERE p.code IS NULL;
```

The unmatched product check must return zero rows.

## Step 6: Create The Contract Price View

This is customer-specific pricing. The source table varies by SYSPRO pricing setup, so the DBA or SYSPRO consultant must confirm whether pricing comes from contract pricing, customer price codes, promotions, or another configured pricing source.

Required columns:

| Column | Meaning |
| --- | --- |
| customer_code | SYSPRO customer account code |
| product_code | SYSPRO stock code |
| price | Nett selling price for that customer/product |

Template:

```sql
CREATE OR ALTER VIEW dbo.vw_FS_ContractPrices AS
SELECT
    RTRIM(cp.Customer) AS customer_code,
    RTRIM(cp.StockCode) AS product_code,
    cp.FixedPrice AS price
FROM dbo.SorContractPrice cp -- TODO: confirm correct pricing table/source
WHERE cp.Customer IS NOT NULL
  AND cp.StockCode IS NOT NULL
  AND cp.FixedPrice > 0;
GO
```

Validation:

```sql
SELECT TOP 50 * FROM dbo.vw_FS_ContractPrices ORDER BY customer_code, product_code;

SELECT customer_code, product_code, COUNT(*) AS row_count
FROM dbo.vw_FS_ContractPrices
GROUP BY customer_code, product_code
HAVING COUNT(*) > 1;

SELECT p.customer_code, p.product_code
FROM dbo.vw_FS_ContractPrices p
LEFT JOIN dbo.vw_FS_Customers c
    ON c.code = p.customer_code
LEFT JOIN dbo.vw_FS_Products pr
    ON pr.code = p.product_code
WHERE c.code IS NULL
   OR pr.code IS NULL;
```

The duplicate and unmatched checks must return zero rows.

## Step 7: Create The Invoice View

RouteOne displays recent invoices on customer screens. SYSPRO remains the billing system of record.

Return the last 60 to 90 days. RouteOne displays a rolling recent window per customer.

Required columns:

| Column | Meaning |
| --- | --- |
| number | Unique invoice number |
| customer_code | SYSPRO customer account code |
| order_number | Originating sales order/reference, optional |
| invoice_date | Invoice date as `YYYY-MM-DD` |
| due_date | Due date as `YYYY-MM-DD`, optional |
| subtotal | Nett excluding VAT |
| vat_amount | VAT amount |
| total | Gross including VAT |
| amount_paid | Amount paid/settled |
| balance | Outstanding balance |
| status | Optional: `paid`, `outstanding`, or `overdue` |

```sql
CREATE OR ALTER VIEW dbo.vw_FS_Invoices AS
SELECT
    RTRIM(inv.Invoice) AS number,
    RTRIM(inv.Customer) AS customer_code,
    NULLIF(RTRIM(inv.SalesOrder), '') AS order_number,
    CONVERT(char(10), inv.InvoiceDate, 23) AS invoice_date,
    CONVERT(char(10), inv.DueDate, 23) AS due_date,
    ISNULL(inv.MerchandiseValue, 0) AS subtotal,
    ISNULL(inv.TaxValue, 0) AS vat_amount,
    ISNULL(inv.InvoiceValue, 0) AS total,
    ISNULL(inv.PaidValue, 0) AS amount_paid,
    ISNULL(inv.BalanceValue, ISNULL(inv.InvoiceValue, 0) - ISNULL(inv.PaidValue, 0)) AS balance,
    CASE
        WHEN ISNULL(inv.BalanceValue, ISNULL(inv.InvoiceValue, 0) - ISNULL(inv.PaidValue, 0)) <= 0.005
            THEN 'paid'
        WHEN inv.DueDate < CAST(GETDATE() AS date)
            THEN 'overdue'
        ELSE 'outstanding'
    END AS status
FROM dbo.ArInvoice inv -- TODO: confirm AR invoice table and value columns
WHERE inv.InvoiceDate >= DATEADD(day, -90, CAST(GETDATE() AS date));
GO
```

Validation:

```sql
SELECT TOP 50 * FROM dbo.vw_FS_Invoices ORDER BY invoice_date DESC;

SELECT number, COUNT(*) AS row_count
FROM dbo.vw_FS_Invoices
GROUP BY number
HAVING COUNT(*) > 1;

SELECT i.number, i.customer_code
FROM dbo.vw_FS_Invoices i
LEFT JOIN dbo.vw_FS_Customers c
    ON c.code = i.customer_code
WHERE c.code IS NULL;
```

The duplicate invoice check must return zero rows. Any unmatched customers should be investigated.

## Step 8: Create A Read-Only SQL Login

Create a least-privilege SQL login for RouteOne. Replace the password before running.

```sql
USE [master];
GO

CREATE LOGIN routeone_ro
WITH PASSWORD = 'REPLACE_WITH_STRONG_PASSWORD',
     CHECK_POLICY = ON,
     CHECK_EXPIRATION = ON;
GO

USE [YourSysproCompanyDatabase];
GO

CREATE USER routeone_ro FOR LOGIN routeone_ro;
GO

GRANT SELECT ON dbo.vw_FS_Warehouses TO routeone_ro;
GRANT SELECT ON dbo.vw_FS_Customers TO routeone_ro;
GRANT SELECT ON dbo.vw_FS_Products TO routeone_ro;
GRANT SELECT ON dbo.vw_FS_Stock TO routeone_ro;
GRANT SELECT ON dbo.vw_FS_ContractPrices TO routeone_ro;
GRANT SELECT ON dbo.vw_FS_Invoices TO routeone_ro;
GO
```

Do not grant write permissions. Do not grant direct table access unless the DBA requires it internally through ownership chaining or security policy.

## Step 9: Final Connectivity Details For RouteOne Admin

Give the RouteOne admin these values:

| Setting | Value |
| --- | --- |
| SQL Server host/IP | `<server>` |
| SQL Server port | `1433` unless changed |
| Database | `<SYSPRO company database>` |
| Username | `routeone_ro` |
| Password | `<securely shared password>` |
| Warehouse view | `dbo.vw_FS_Warehouses` |
| Customer view | `dbo.vw_FS_Customers` |
| Product view | `dbo.vw_FS_Products` |
| Stock view | `dbo.vw_FS_Stock` |
| Price view | `dbo.vw_FS_ContractPrices` |
| Invoice view | `dbo.vw_FS_Invoices` |

The app server must be allowed to connect to SQL Server on port 1433 over the private network.

## Step 10: Go-Live Checklist

Before enabling scheduled sync:

```sql
SELECT COUNT(*) AS warehouses FROM dbo.vw_FS_Warehouses;
SELECT COUNT(*) AS customers FROM dbo.vw_FS_Customers;
SELECT COUNT(*) AS products FROM dbo.vw_FS_Products;
SELECT COUNT(*) AS stock_rows FROM dbo.vw_FS_Stock;
SELECT COUNT(*) AS contract_prices FROM dbo.vw_FS_ContractPrices;
SELECT COUNT(*) AS invoices FROM dbo.vw_FS_Invoices;
```

Confirm:

- No duplicate warehouse codes.
- No duplicate customer codes.
- No duplicate product codes.
- No duplicate customer/product price rows.
- No duplicate invoice numbers.
- Every customer `warehouse_code` exists in `vw_FS_Warehouses`.
- Every stock row code exists in `vw_FS_Products`.
- Every contract price references an existing customer and product.
- Invoice dates are returned as `YYYY-MM-DD`.
- The RouteOne SQL user can select from the six views and cannot update SYSPRO tables.


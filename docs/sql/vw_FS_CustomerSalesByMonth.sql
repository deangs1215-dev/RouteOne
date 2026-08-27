-- vw_FS_CustomerSalesByMonth
--
-- Actual invoiced sales per customer per month, ex-VAT, for the last 13 months.
-- Drives "Sales 12 months" on the customer profile (R1-005).
--
-- ---------------------------------------------------------------------------
-- Why this view exists (2026-08-26)
-- ---------------------------------------------------------------------------
-- "Sales 12 months" previously summed RouteOne's OWN orders table over 365
-- days, so it only ever reflected what happened to be captured in the app - a
-- customer who orders by phone or straight through SYSPRO looked like they had
-- stopped buying.
--
-- It could not simply be repointed at RouteOne's invoices table either:
--   1. vw_FS_Invoices covers 90 days. A rolling 12 months needs 365.
--   2. ArInvoice.Customer is the BILLED account. Under central billing
--      (PICK N PAY RETAILERS invoiced for a delivery to OAKDENE MINI MARKET)
--      summing by it credits the group account and shows the store R0.
--
-- Both are solved by aggregating ArTrnDetail instead: it is at transaction-line
-- grain, carries the DELIVERY customer, holds full history, and its
-- NetSalesValue is already ex-VAT.
--
-- Deliberately mirrors vw_FS_RepSalesByMonth: same source table, same
-- ProductClass filter, same monthly grain. Customer totals here and rep totals
-- there are then the same measure sliced two ways, and will reconcile.
--
-- ---------------------------------------------------------------------------
-- 13 months, not 12
-- ---------------------------------------------------------------------------
-- The 13th month lets RouteOne compute a full rolling 12 months on any day
-- without the earliest month falling out mid-month. RouteOne decides the
-- window; this view just supplies enough history to cover it.
--
-- Volume: one row per (customer, year, month). ~13,945 customers x 13 months
-- is a ceiling of ~181k rows, and the real figure is far lower since most
-- customers do not buy every month.

USE [SysproCompany001];
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.vw_FS_CustomerSalesByMonth', 'V') IS NOT NULL
    DROP VIEW dbo.vw_FS_CustomerSalesByMonth;
GO

CREATE VIEW dbo.vw_FS_CustomerSalesByMonth AS
SELECT
    RTRIM(t.Customer)            AS customer_code,   -- delivery customer, matches vw_FS_Customers.code
    t.TrnYear                    AS trn_year,
    t.TrnMonth                   AS trn_month,
    SUM(t.NetSalesValue)         AS nsv              -- ex-VAT, same measure as vw_FS_RepSalesByMonth
FROM dbo.ArTrnDetail t WITH (NOLOCK)
WHERE t.DocumentType IN ('I', 'i')     -- invoices only; credit notes ('C') and debit notes ('D') excluded
  AND t.ProductClass IN ('001', '001A', '001B', '100', '100A', '200', '300', '904', '903')
  AND t.Customer IS NOT NULL AND RTRIM(t.Customer) <> ''
  AND t.InvoiceDate >= DATEADD(MONTH, -13, CAST(GETDATE() AS date))
  AND t.InvoiceDate <= CAST(GETDATE() AS date)       -- drop future-dated ERP artifacts
GROUP BY RTRIM(t.Customer), t.TrnYear, t.TrnMonth;
GO

-- Dropping a view drops its permissions - grant them back.
--
-- GRANT SELECT ON dbo.vw_FS_CustomerSalesByMonth TO [RouteOneApp];
-- GO

-- ============================================================
-- Validation
-- ============================================================

-- 1. Row count - must stay well under the 500,000 safety limit in
--    server/integration/providers.js.
SELECT COUNT(*) AS total_rows,
       COUNT(DISTINCT customer_code) AS customers
FROM dbo.vw_FS_CustomerSalesByMonth;

-- 2. One row per customer per month - expect ZERO rows back.
SELECT customer_code, trn_year, trn_month, COUNT(*) AS n
FROM dbo.vw_FS_CustomerSalesByMonth
GROUP BY customer_code, trn_year, trn_month
HAVING COUNT(*) > 1;

-- 3. The group-billing case. OAKDENE MINI MARKET (31485) is invoiced through
--    PICK N PAY RETAILERS (993956) yet must show its OWN sales here.
SELECT customer_code, trn_year, trn_month, nsv
FROM dbo.vw_FS_CustomerSalesByMonth
WHERE customer_code = '31485'
ORDER BY trn_year DESC, trn_month DESC;

-- 4. Reconciliation: a rep's total across their customers should agree with
--    vw_FS_RepSalesByMonth for the same month (same source, same filter).
--    Small differences are expected where a customer changed rep, since the
--    rep view credits the customer's CURRENT salesperson retroactively.
SELECT c.trn_year, c.trn_month, SUM(c.nsv) AS customer_view_total
FROM dbo.vw_FS_CustomerSalesByMonth c
WHERE c.trn_year = YEAR(GETDATE())
GROUP BY c.trn_year, c.trn_month
ORDER BY c.trn_month DESC;

SELECT TrnYear, TrnMonth, SUM(NSV) AS rep_view_total
FROM dbo.vw_FS_RepSalesByMonth
WHERE TrnYear = YEAR(GETDATE())
GROUP BY TrnYear, TrnMonth
ORDER BY TrnMonth DESC;

-- 5. Biggest customers over the window, as a smell test against known accounts.
SELECT TOP 20 customer_code, SUM(nsv) AS total_nsv
FROM dbo.vw_FS_CustomerSalesByMonth
GROUP BY customer_code
ORDER BY total_nsv DESC;

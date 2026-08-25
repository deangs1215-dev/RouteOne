-- vw_FS_InvoiceLines - expose the delivery customer, widen to 90 days
--
-- ---------------------------------------------------------------------------
-- Why (2026-08-25)
-- ---------------------------------------------------------------------------
-- A rep (Lizl) reported invoices she could not find in RouteOne. Traced to
-- central/head-office billing:
--
--   invoice 0011050450, 24 Aug 2026
--     ArInvoice.Customer   = 993956  PICK N PAY RETAILERS   <- billed to, no rep
--     ArTrnDetail.Customer = 31485   OAKDENE MINI MARKET    <- delivered to, rep Lizl
--
-- RouteOne joined invoices to customers through the HEADER only, then scoped to
-- the rep via that customer's rep_id. Group accounts like PICK N PAY RETAILERS
-- carry no rep, so every group-billed invoice was invisible to the rep who
-- actually services the store. That is why 9,958 of 12,231 active customers
-- (81%) had no invoice history at all - not dormant accounts, but every
-- retail-chain store.
--
-- Exposing ArTrnDetail.Customer lets RouteOne scope invoices by the store the
-- goods went to, in addition to the account that was billed.
--
-- ---------------------------------------------------------------------------
-- Window widened 30 -> 90 days
-- ---------------------------------------------------------------------------
-- vw_FS_Invoices covers 90 days. While these lines only covered 30, a rep would
-- see group-billed invoices for the last month and then have them vanish, which
-- is more confusing than not showing them at all. Matching the windows keeps
-- the two consistent.
--
-- Volume: ~95,000 rows at 30 days, so expect ~285,000 at 90. That is inside the
-- 500,000-row safety limit in server/integration/providers.js, and the table is
-- wiped and rebuilt each run (CLEAR_BEFORE_SYNC), so it does not accumulate.
-- Last measured write time was ~16s for 95k rows; budget roughly 50s at 90 days.
--
-- ============================================================
-- Supersedes docs/sql/vw_FS_InvoiceLines.sql. Rollback block at the bottom.
-- ============================================================

USE [SysproCompany001];
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.vw_FS_InvoiceLines', 'V') IS NOT NULL
    DROP VIEW dbo.vw_FS_InvoiceLines;
GO

CREATE VIEW dbo.vw_FS_InvoiceLines AS
SELECT
    RTRIM(t.Invoice)              AS invoice_number,          -- matches vw_FS_Invoices.number
    RTRIM(t.StockCode)            AS product_code,            -- matches vw_FS_Products.code
    RTRIM(t.Customer)             AS delivery_customer_code,  -- the STORE, not the billed account
    t.QtyInvoiced                 AS qty,
    ISNULL(t.NetSalesValue, 0)    AS line_total,
    CASE WHEN t.QtyInvoiced <> 0 THEN t.NetSalesValue / t.QtyInvoiced ELSE NULL END AS unit_price
FROM dbo.ArTrnDetail t WITH (NOLOCK)
WHERE t.DocumentType IN ('I', 'i')       -- invoices only; excludes credit ('C') / debit ('D') notes
  AND t.LineType <> '7'                  -- excludes non-stock lines (freight/forex/sundry)
  AND t.StockCode IS NOT NULL AND RTRIM(t.StockCode) <> ''
  AND t.InvoiceDate >= DATEADD(day, -90, CAST(GETDATE() AS date));   -- was -30; now matches vw_FS_Invoices
GO

-- Dropping a view drops its permissions - grant them back.
--
-- GRANT SELECT ON dbo.vw_FS_InvoiceLines TO [routeone_ro];
-- GO

-- ============================================================
-- Validation
-- ============================================================

-- 1. The reported invoice: lines should carry the STORE code (31485), while
--    vw_FS_Invoices carries the billed account (993956).
SELECT TOP 30 invoice_number, delivery_customer_code, product_code, qty, line_total
FROM dbo.vw_FS_InvoiceLines
WHERE invoice_number = '0011050450';

SELECT number, customer_code, invoice_date, total
FROM dbo.vw_FS_Invoices
WHERE number = '0011050450';
-- Expect: lines -> 31485 (OAKDENE), header -> 993956 (PICK N PAY RETAILERS)

-- 2. Row count after widening to 90 days. Must stay under 500,000 or the sync
--    aborts on the safety limit in providers.js.
SELECT COUNT(*) AS total_rows FROM dbo.vw_FS_InvoiceLines;

-- 3. How much does this actually recover? Invoices whose header customer
--    differs from the delivery customer are the ones reps could not see.
SELECT COUNT(DISTINCT l.invoice_number) AS group_billed_invoices
FROM dbo.vw_FS_InvoiceLines l
JOIN dbo.vw_FS_Invoices i ON i.number = l.invoice_number
WHERE l.delivery_customer_code <> i.customer_code;

-- 4. Every delivery_customer_code should exist in vw_FS_Customers. Any that do
--    not will still be invisible to reps - RouteOne cannot resolve them to a
--    rep if the customer was never synced.
SELECT DISTINCT l.delivery_customer_code
FROM dbo.vw_FS_InvoiceLines l
LEFT JOIN dbo.vw_FS_Customers c ON c.code = l.delivery_customer_code
WHERE c.code IS NULL;

-- ============================================================
-- ROLLBACK - previous definition (30-day window, no delivery customer)
-- ============================================================
-- USE [SysproCompany001];
-- GO
-- IF OBJECT_ID('dbo.vw_FS_InvoiceLines', 'V') IS NOT NULL
--     DROP VIEW dbo.vw_FS_InvoiceLines;
-- GO
-- CREATE VIEW dbo.vw_FS_InvoiceLines AS
-- SELECT
--     RTRIM(t.Invoice)              AS invoice_number,
--     RTRIM(t.StockCode)            AS product_code,
--     t.QtyInvoiced                 AS qty,
--     ISNULL(t.NetSalesValue, 0)    AS line_total,
--     CASE WHEN t.QtyInvoiced <> 0 THEN t.NetSalesValue / t.QtyInvoiced ELSE NULL END AS unit_price
-- FROM dbo.ArTrnDetail t WITH (NOLOCK)
-- WHERE t.DocumentType IN ('I', 'i')
--   AND t.LineType <> '7'
--   AND t.StockCode IS NOT NULL AND RTRIM(t.StockCode) <> ''
--   AND t.InvoiceDate >= DATEADD(day, -30, CAST(GETDATE() AS date));
-- GO

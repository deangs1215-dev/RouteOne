-- vw_FS_Invoices - fix double-counted VAT in the invoice total
--
-- ---------------------------------------------------------------------------
-- Why (2026-08-25)
-- ---------------------------------------------------------------------------
-- Reported on invoice 0011050890 (HANGAR BAKERY, 24 Aug 2026). RouteOne showed:
--
--     subtotal R8 095,71   VAT R1 055,96   total R9 151,67
--
-- The correct figures are:
--
--     subtotal R7 039,75   VAT R1 055,96   total R8 095,71
--
-- 7 039,75 x 1,15 = 8 095,71, and the invoice's own line detail (ArTrnDetail
-- NetSalesValue, which is ex-VAT) sums to exactly 7 039,75.
--
-- Root cause: ArInvoice.OrigTaxableAmt is the VAT-INCLUSIVE invoice value, not
-- the taxable base its name suggests. The previous definition read it as the
-- ex-VAT subtotal and then ADDED TaxPortion to derive a total, counting the VAT
-- twice. Its own comment - "gross is always taxable + tax, so derive it" -
-- records the wrong assumption.
--
-- Verified against live data before changing anything: of 3,000 sampled
-- invoices carrying both line detail and non-zero VAT,
--     OrigTaxableAmt - TaxPortion == SUM(line NetSalesValue)   89%
--     OrigTaxableAmt              == SUM(line NetSalesValue)    0%
-- The ~11% that do not reconcile exactly are expected: vw_FS_InvoiceLines drops
-- non-stock lines (LineType '7' - freight, forex, sundry), so their line sums
-- are legitimately short of the invoice subtotal. None supported the old
-- reading.
--
-- Impact of the bug: every invoice total was overstated by its own VAT -
-- R42,7 million across 84,931 invoices. This fed the invoice list and detail
-- pages, and the Dashboard sales trend, which sums invoices.total.
--
-- Not affected: rep_monthly_sales / Rep KPIs. Those come from
-- vw_FS_RepSalesByMonth, which sums NetSalesValue (ex-VAT) directly and never
-- touched OrigTaxableAmt.
--
-- No RouteOne code change is needed - the app stores whatever this view
-- returns. Re-sync invoices after applying, and the stored totals correct
-- themselves (upsertInvoice overwrites these columns every run).
--
-- ============================================================
-- ROLLBACK: the previous definition is reproduced at the bottom.
-- ============================================================

USE [SysproCompany001];
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.vw_FS_Invoices', 'V') IS NOT NULL
    DROP VIEW dbo.vw_FS_Invoices;
GO

CREATE VIEW dbo.vw_FS_Invoices AS
SELECT
    Invoice                                   AS number,
    Customer                                  AS customer_code,
    CONVERT(VARCHAR(10), InvoiceDate, 120)    AS invoice_date,
    -- OrigTaxableAmt is VAT-INCLUSIVE despite the name, so the ex-VAT subtotal
    -- is it MINUS the tax, and the gross total is it unchanged.
    ROUND(OrigTaxableAmt - TaxPortion, 2)     AS subtotal,
    TaxPortion                                AS vat_amount,
    OrigTaxableAmt                            AS total
FROM dbo.ArInvoice
WHERE InvoiceDate >= DATEADD(MONTH, -3, CAST(GETDATE() AS DATE))
  AND InvoiceDate <= CAST(GETDATE() AS DATE);   -- drop future-dated credit-note junk (e.g. 2080)
GO

-- Dropping a view drops its permissions - grant them back.
--
-- GRANT SELECT ON dbo.vw_FS_Invoices TO [routeone_ro];
-- GO

-- ============================================================
-- Validation
-- ============================================================

-- 1. The reported invoice. Expect subtotal 7039.75, vat 1055.96, total 8095.71.
SELECT number, customer_code, invoice_date, subtotal, vat_amount, total
FROM dbo.vw_FS_Invoices
WHERE number = '0011050890';

-- 2. subtotal + vat must now equal total on every row. Expect ZERO rows back.
SELECT TOP 20 number, subtotal, vat_amount, total,
       ROUND(subtotal + vat_amount - total, 2) AS discrepancy
FROM dbo.vw_FS_Invoices
WHERE ROUND(subtotal + vat_amount - total, 2) <> 0;

-- 3. The subtotal should now agree with the ex-VAT line detail. A handful of
--    mismatches is expected where an invoice carries non-stock lines (freight,
--    sundry) that vw_FS_InvoiceLines filters out via LineType <> '7'.
SELECT TOP 20 i.number, i.subtotal, SUM(l.line_total) AS line_sum,
       ROUND(i.subtotal - SUM(l.line_total), 2) AS diff
FROM dbo.vw_FS_Invoices i
JOIN dbo.vw_FS_InvoiceLines l ON l.invoice_number = i.number
GROUP BY i.number, i.subtotal
HAVING ROUND(i.subtotal - SUM(l.line_total), 2) <> 0
ORDER BY ABS(i.subtotal - SUM(l.line_total)) DESC;

-- 4. Sanity on the aggregate: total invoiced value should DROP by roughly the
--    sum of VAT versus what RouteOne currently holds (~R42,7m).
SELECT COUNT(*) AS invoices, SUM(total) AS gross_total, SUM(vat_amount) AS vat_total
FROM dbo.vw_FS_Invoices;

-- ============================================================
-- ROLLBACK - previous definition (double-counts VAT; restores the bug)
-- ============================================================
-- USE [SysproCompany001];
-- GO
-- IF OBJECT_ID('dbo.vw_FS_Invoices', 'V') IS NOT NULL
--     DROP VIEW dbo.vw_FS_Invoices;
-- GO
-- CREATE VIEW dbo.vw_FS_Invoices AS
-- SELECT
--     Invoice                                  AS number,
--     Customer                                 AS customer_code,
--     CONVERT(VARCHAR(10), InvoiceDate, 120)   AS invoice_date,
--     OrigTaxableAmt                           AS subtotal,
--     TaxPortion                               AS vat_amount,
--     ROUND(OrigTaxableAmt + TaxPortion, 2)    AS total
-- FROM dbo.ArInvoice
-- WHERE InvoiceDate >= DATEADD(MONTH, -3, CAST(GETDATE() AS DATE))
--   AND InvoiceDate <= CAST(GETDATE() AS DATE);
-- GO

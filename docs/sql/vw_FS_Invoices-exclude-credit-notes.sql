-- vw_FS_Invoices - exclude credit notes
--
-- ---------------------------------------------------------------------------
-- Why (2026-08-26)
-- ---------------------------------------------------------------------------
-- This view has no document-type filter, so credit notes flow into RouteOne's
-- invoices table alongside real invoices. Two problems:
--
--   1. They collapse. SYSPRO holds 77 rows under invoice number _CR0000003,
--      75 under _CR0000004 and so on - the number is a sequence placeholder,
--      not a unique document id. RouteOne's invoices.number is UNIQUE, so all
--      77 upsert onto one row and whichever synced last wins. 2,373 rows
--      currently in RouteOne carry a _CR number, with a combined total of R0.
--
--   2. They are counted as invoices by anything reading the table - the
--      customer invoice card, and the Dashboard sales trend.
--
-- vw_FS_InvoiceLines already filters DocumentType IN ('I','i'), so lines
-- exclude credit notes while headers include them - the two views disagree
-- about what an invoice is. This aligns them.
--
-- ---------------------------------------------------------------------------
-- Why filter on the number prefix rather than a document type column
-- ---------------------------------------------------------------------------
-- ArTrnDetail has a DocumentType column; whether ArInvoice has an equivalent
-- has NOT been confirmed on this database (an earlier guess at 'InvoiceType'
-- did not exist). The '_CR' prefix is confirmed from live data. If ArInvoice
-- does carry a document-type column, prefer it - run the check below and use
-- the commented variant instead.
--
--   SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
--   WHERE TABLE_NAME = 'ArInvoice' ORDER BY ORDINAL_POSITION;
--
-- Carries forward the VAT fix from vw_FS_Invoices-vat-fix.sql, which is
-- already applied - OrigTaxableAmt is VAT-inclusive, so subtotal is it minus
-- the tax and total is it unchanged.
--
-- NOTE: this does not make credit notes visible anywhere. If reps should see
-- that a credit was raised against an account, that needs its own handling -
-- a document-type column and a key that doesn't collapse - not this view.

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
    ROUND(OrigTaxableAmt - TaxPortion, 2)     AS subtotal,   -- OrigTaxableAmt is VAT-inclusive
    TaxPortion                                AS vat_amount,
    OrigTaxableAmt                            AS total
FROM dbo.ArInvoice
WHERE InvoiceDate >= DATEADD(MONTH, -3, CAST(GETDATE() AS DATE))
  AND InvoiceDate <= CAST(GETDATE() AS DATE)      -- drop future-dated credit-note junk (e.g. 2080)
  AND LEFT(RTRIM(Invoice), 3) <> '_CR';           -- credit notes: not invoices, and their numbers repeat
GO

-- Dropping a view drops its permissions - grant them back.
--
-- GRANT SELECT ON dbo.vw_FS_Invoices TO [routeone_ro];
-- GO

-- ============================================================
-- Validation
-- ============================================================

-- 1. No credit notes left. Expect ZERO rows.
SELECT TOP 20 number, customer_code, invoice_date, total
FROM dbo.vw_FS_Invoices
WHERE LEFT(RTRIM(number), 3) = '_CR';

-- 2. Every invoice number now appears once. Expect ZERO rows.
SELECT number, COUNT(*) AS n
FROM dbo.vw_FS_Invoices
GROUP BY number HAVING COUNT(*) > 1;

-- 3. subtotal + vat = total still holds. Expect ZERO rows.
SELECT TOP 20 number, subtotal, vat_amount, total
FROM dbo.vw_FS_Invoices
WHERE ROUND(subtotal + vat_amount - total, 2) <> 0;

-- 4. Row count before/after - should drop by roughly the credit-note count.
SELECT COUNT(*) AS invoices_in_view FROM dbo.vw_FS_Invoices;

-- ============================================================
-- ROLLBACK - VAT fix retained, credit notes allowed back in
-- ============================================================
-- USE [SysproCompany001];
-- GO
-- IF OBJECT_ID('dbo.vw_FS_Invoices', 'V') IS NOT NULL
--     DROP VIEW dbo.vw_FS_Invoices;
-- GO
-- CREATE VIEW dbo.vw_FS_Invoices AS
-- SELECT
--     Invoice                                   AS number,
--     Customer                                  AS customer_code,
--     CONVERT(VARCHAR(10), InvoiceDate, 120)    AS invoice_date,
--     ROUND(OrigTaxableAmt - TaxPortion, 2)     AS subtotal,
--     TaxPortion                                AS vat_amount,
--     OrigTaxableAmt                            AS total
-- FROM dbo.ArInvoice
-- WHERE InvoiceDate >= DATEADD(MONTH, -3, CAST(GETDATE() AS DATE))
--   AND InvoiceDate <= CAST(GETDATE() AS DATE);
-- GO

-- vw_FS_InvoiceLines
-- Per-product line detail for AR invoices, so RouteOne's Invoice Detail page
-- can show what was actually invoiced (product, qty, price, line total) -
-- not just the header totals vw_FS_Invoices already provides.
--
-- ---------------------------------------------------------------------------
-- Source: dbo.ArTrnDetail
-- ---------------------------------------------------------------------------
-- vw_FS_Invoices is keyed off dbo.ArInvoice, a HEADER table (one row per
-- invoice, no product detail). This view instead reads dbo.ArTrnDetail, the
-- same table vw_FS_RepSalesByMonth.sql already reads successfully for
-- NetSalesValue by rep/month - proven live and populated at transaction-line
-- grain in this SYSPRO database.
--
-- Columns were confirmed against the real table on 2026-08-14 via
-- INFORMATION_SCHEMA.COLUMNS - several guessed names in the first draft of
-- this view did not exist and were corrected:
--   - Date column is InvoiceDate (not TrnDate)
--   - Quantity column is QtyInvoiced (not Quantity)
--   - There is no UnitPrice column at all - only aggregate line values
--     (NetSalesValue, TaxValue, CostValue, DiscValue). Unit price is derived
--     as NetSalesValue / QtyInvoiced.
--   - There is no Uom column - RouteOne resolves UOM (and product name)
--     locally via product_code against its own already-synced product
--     catalogue, the same way order/quote line items do today.
--
-- Document type filter (also confirmed against real data, 2026-08-14 - see
-- distinct DocumentType/LineType/OrderType value counts):
--   DocumentType 'I' / 'i'  = invoice            (~6.7M rows - what we want)
--   DocumentType 'C'        = credit note         (~95K rows - excluded)
--   DocumentType 'D'        = debit note          (~700 rows - excluded)
-- LineType and OrderType are noisy free-text-ish codes on this data and are
-- NOT used for filtering; StockCode being non-blank is what actually scopes
-- rows down to real merchandise lines.
--
-- ---------------------------------------------------------------------------
-- Still to validate (see validation queries below - can't be checked from
-- column names alone):
-- ---------------------------------------------------------------------------
--   1. ArTrnDetail.Invoice really does hold the SAME invoice number as
--      ArInvoice.Invoice (i.e. vw_FS_Invoices.number) - this is the join key
--      back to the header view on the RouteOne side. Validation query #2
--      below checks this directly: every invoice_number this view returns
--      should exist in vw_FS_Invoices.
--   2. NetSalesValue / QtyInvoiced actually lands on a sane per-unit price,
--      and NetSalesValue sums back to roughly the invoice's ex-VAT subtotal.
--      Validation query #5 checks one real invoice end-to-end.
--
-- ============================================================
-- This is a NEW view - nothing to roll back if it needs dropping, just:
--     DROP VIEW dbo.vw_FS_InvoiceLines;
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
    RTRIM(t.Invoice)              AS invoice_number,   -- matches vw_FS_Invoices.number
    RTRIM(t.StockCode)            AS product_code,     -- matches vw_FS_Products.code
    t.QtyInvoiced                 AS qty,
    ISNULL(t.NetSalesValue, 0)    AS line_total,
    CASE WHEN t.QtyInvoiced <> 0 THEN t.NetSalesValue / t.QtyInvoiced ELSE NULL END AS unit_price
FROM dbo.ArTrnDetail t WITH (NOLOCK)
WHERE t.DocumentType IN ('I', 'i')                             -- invoice only; excludes credit notes ('C') / debit notes ('D')
  AND t.LineType <> '7'                                        -- excludes non-stock lines (freight/forex/sundry codes like
                                                                 -- 'PRODUCT', 'BZ ORDER 7 USD') - confirmed via LineType
                                                                 -- breakdown on 2026-08-14, all 8 such rows were type 7.
                                                                 -- NOT restricted to LineType = '1' only: '5' alone had
                                                                 -- hundreds of thousands of otherwise-legitimate-looking
                                                                 -- rows in the original distinct-value count, so a narrower
                                                                 -- "only 1" filter risked dropping real merchandise lines.
  AND t.StockCode IS NOT NULL AND RTRIM(t.StockCode) <> ''
  AND t.InvoiceDate >= DATEADD(day, -30, CAST(GETDATE() AS date));  -- narrower than vw_FS_Invoices' 90-day window, by request -
                                                                     -- breakdowns older than 30 days simply won't have lines
GO

-- Grant back whatever the RouteOne read-only login needs (dropping a view
-- drops its permissions with it).
--
-- GRANT SELECT ON dbo.vw_FS_InvoiceLines TO [RouteOneApp];
-- GO

-- ============================================================
-- Validation - run these after creating the view above
-- ============================================================

-- 1. Eyeball the data.
SELECT TOP 50 * FROM dbo.vw_FS_InvoiceLines ORDER BY invoice_number DESC;

-- 2. Coverage check: every invoice_number here should exist in
--    vw_FS_Invoices. Misses would mean Invoice isn't really the same number
--    as ArInvoice.Invoice - the central assumption this view relies on.
SELECT DISTINCT l.invoice_number
FROM dbo.vw_FS_InvoiceLines l
LEFT JOIN dbo.vw_FS_Invoices i ON i.number = l.invoice_number
WHERE i.number IS NULL;

-- 3. Every product_code should exist in vw_FS_Products. Mismatches usually
--    mean an RTRIM/formatting difference, not a real missing product.
SELECT DISTINCT l.product_code
FROM dbo.vw_FS_InvoiceLines l
LEFT JOIN dbo.vw_FS_Products p ON p.code = l.product_code
WHERE p.code IS NULL;

-- 4. Sanity: lines per invoice should look like a normal order (a handful,
--    not hundreds).
SELECT invoice_number, COUNT(*) AS line_count
FROM dbo.vw_FS_InvoiceLines
GROUP BY invoice_number
ORDER BY line_count DESC;

-- 5. Pick one real invoice number from vw_FS_Invoices and confirm this
--    view's lines sum back to roughly that invoice's subtotal (ex-VAT).
--    Small rounding differences are fine; a big gap means NetSalesValue
--    isn't the ex-VAT line value this view assumes it is.
-- DECLARE @check_invoice varchar(30) = 'REPLACE_WITH_A_REAL_INVOICE_NUMBER';
-- SELECT @check_invoice AS invoice_number,
--        (SELECT subtotal FROM dbo.vw_FS_Invoices WHERE number = @check_invoice) AS header_subtotal,
--        (SELECT SUM(line_total) FROM dbo.vw_FS_InvoiceLines WHERE invoice_number = @check_invoice) AS lines_sum;

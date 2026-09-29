-- Credit notes on customer invoice history - schema discovery.
--
-- UAT feedback (2026-09-08): reps want credit notes visible in a customer's
-- invoice history (merged chronologically, badged as distinct from a real
-- invoice, reference-only - not netted against Sales MTD/12m or balance).
--
-- vw_FS_Invoices deliberately excludes credit notes (see
-- vw_FS_Invoices-exclude-credit-notes.sql) because ArInvoice gives them a
-- collapsing placeholder number (_CR0000003 etc, shared by dozens of
-- documents) instead of a real unique document number. vw_FS_InvoiceLines
-- already reads real credit-note LINES from ArTrnDetail (DocumentType = 'C',
-- ~95K rows, currently filtered out) - that table is confirmed populated and
-- reachable, but this only proves lines exist, not that there's a stable
-- per-document key to group them into "one credit note" the way an invoice
-- is one row.
--
-- Run all of this and paste back the full output - do not guess column names
-- from this file alone. The last two views in this repo both had guessed
-- column names that didn't exist on the real table (see the comments in
-- vw_FS_InvoiceLines.sql) - this finds out for real before anything gets
-- built on top of it.

USE [SysproCompany001];
GO

-- 1. Every column on ArTrnDetail, in order. Looking for anything that could
--    serve as a stable per-document key: an internal ID, a batch+sequence
--    pair, a posting reference - anything NOT the collapsing Invoice field.
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'ArTrnDetail'
ORDER BY ORDINAL_POSITION;

-- 2. Confirm the collapsing problem exists for credit notes specifically
--    (already known to exist for the header-level ArInvoice.Invoice field -
--    checking whether it's just as bad at the ArTrnDetail line level).
SELECT
    COUNT(*) AS credit_note_lines,
    COUNT(DISTINCT Invoice) AS distinct_invoice_field_values
FROM dbo.ArTrnDetail WITH (NOLOCK)
WHERE DocumentType = 'C';

-- 3. Eyeball 50 real credit note rows, every column, most recent first (adjust
--    the date column name once #1 confirms it - InvoiceDate is a guess based
--    on vw_FS_InvoiceLines using that name for regular invoice lines).
SELECT TOP 50 *
FROM dbo.ArTrnDetail WITH (NOLOCK)
WHERE DocumentType = 'C'
ORDER BY InvoiceDate DESC;

-- 4. How many lines does a typical credit note placeholder number actually
--    span, and over what date range - e.g. does _CR0000003 span one day's
--    credits or the whole history? Tells us whether Invoice + date could
--    together approximate a document grouping even without a real key.
SELECT TOP 20 Invoice, MIN(InvoiceDate) AS earliest, MAX(InvoiceDate) AS latest, COUNT(*) AS line_count
FROM dbo.ArTrnDetail WITH (NOLOCK)
WHERE DocumentType = 'C'
GROUP BY Invoice
ORDER BY line_count DESC;

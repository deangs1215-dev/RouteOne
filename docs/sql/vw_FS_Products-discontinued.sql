-- vw_FS_Products - surface recently-sold discontinued products
--
-- ---------------------------------------------------------------------------
-- Why (2026-08-25)
-- ---------------------------------------------------------------------------
-- CELLOPHANE STRIPS (StockCode 8928800010, ProductClass 100) was invisible to
-- reps. Diagnosis: it carries Discontinued = 'Y' in InvMaster+, which this
-- view filtered out entirely - yet it had 7 invoice lines in the preceding 30
-- days and 9,578 customer-pricing rows. It is being actively sold.
--
-- Rather than dropping the Discontinued filter (which would pull every dead
-- product in the item master into a catalogue currently holding ~924 items),
-- this admits a discontinued product ONLY if it has been invoiced in the last
-- 90 days, and flags it so RouteOne can show it as unavailable to order.
-- The set is self-pruning: once a run-out product stops selling, it drops out
-- of the catalogue on its own 90 days later.
--
-- RouteOne's side of the contract (see server/integration/sync.js):
--   discontinued = 1  ->  products.discontinued = 1 AND products.active = 0
-- active = 0 is what actually blocks ordering - orders.routes.js and
-- quotes.routes.js both resolve line items with "WHERE id = ? AND active = 1",
-- so the block is enforced server-side, not merely hidden in the UI.
--
-- ---------------------------------------------------------------------------
-- Performance note
-- ---------------------------------------------------------------------------
-- The EXISTS below probes ArTrnDetail (~6.7M rows) per candidate product. It
-- is evaluated only for rows already past the ProductClass filter, and only
-- for the Discontinued = 'Y' branch of the OR. If this view slows noticeably,
-- the fix is a covering index on ArTrnDetail (StockCode, InvoiceDate)
-- INCLUDE (DocumentType) - check with the DBA before adding one.
--
-- ============================================================
-- Supersedes docs/sql/vw_FS_Products-ConvFactAltUom.sql (already applied).
-- Carries forward both prior fixes: ProductClass '001A' and ConvFactAltUom.
-- The ROLLBACK block at the bottom restores that previous definition.
-- ============================================================

USE [SysproCompany001];
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.vw_FS_Products', 'V') IS NOT NULL
    DROP VIEW dbo.vw_FS_Products;
GO

CREATE VIEW dbo.vw_FS_Products AS
SELECT
    RTRIM(m.StockCode)            AS code,
    RTRIM(m.Description)          AS name,
    RTRIM(m.LongDesc)             AS description,
    RTRIM(m.OtherUom)             AS uom,
    RTRIM(m.StockUom)             AS pack_size,
    ISNULL(m.ConvFactAltUom, 1.0) AS conv_factor_alt_uom,
    CASE WHEN ISNULL(e.Discontinued, 'N') = 'Y' THEN 1 ELSE 0 END AS discontinued,
    ISNULL(pr.SellingPrice, 0)    AS list_price,
    0                             AS cost_price
FROM dbo.InvMaster m
INNER JOIN dbo.[InvMaster+] e ON m.StockCode = e.StockCode
OUTER APPLY (
    SELECT TOP 1 SellingPrice
    FROM dbo.InvPrice p
    WHERE p.StockCode = m.StockCode
    ORDER BY CASE WHEN p.PriceCode = 'G' THEN 0 ELSE 1 END, p.PriceCode
) pr
WHERE RTRIM(m.ProductClass) IN ('001', '001A', '001B', '100', '100A')
  AND (
        ISNULL(e.Discontinued, 'N') <> 'Y'          -- live products: unchanged
     OR EXISTS (                                     -- discontinued: only if still selling
            SELECT 1
            FROM dbo.ArTrnDetail t WITH (NOLOCK)
            WHERE t.StockCode = m.StockCode
              AND t.DocumentType IN ('I', 'i')
              AND t.InvoiceDate >= DATEADD(day, -90, CAST(GETDATE() AS date))
        )
  );
GO

-- Dropping a view drops its permissions - grant them back.
--
-- GRANT SELECT ON dbo.vw_FS_Products TO [RouteOneApp];
-- GO

-- ============================================================
-- Validation - run these after creating the view above
-- ============================================================

-- 1. CELLOPHANE STRIPS should now appear, flagged discontinued = 1.
SELECT code, name, discontinued, conv_factor_alt_uom, list_price
FROM dbo.vw_FS_Products
WHERE code = '8928800010';

-- 2. How much did the catalogue grow? Was ~924 before this change.
SELECT
    COUNT(*)                                            AS total_products,
    SUM(CASE WHEN discontinued = 1 THEN 1 ELSE 0 END)   AS discontinued_shown,
    SUM(CASE WHEN discontinued = 0 THEN 1 ELSE 0 END)   AS live_products
FROM dbo.vw_FS_Products;
-- discontinued_shown should be a modest number. If it is in the thousands,
-- narrow the 90-day window before syncing.

-- 3. The discontinued items now visible, most-recently-sold first.
SELECT p.code, p.name, p.list_price,
       (SELECT MAX(t.InvoiceDate) FROM dbo.ArTrnDetail t
        WHERE t.StockCode = p.code AND t.DocumentType IN ('I','i')) AS last_invoiced
FROM dbo.vw_FS_Products p
WHERE p.discontinued = 1
ORDER BY last_invoiced DESC;

-- 4. Orley Whip must be unaffected (regression check on the pricing fix).
SELECT code, name, discontinued, conv_factor_alt_uom, list_price
FROM dbo.vw_FS_Products
WHERE code = '4282900060';
-- Expect: discontinued = 0, conv_factor_alt_uom = 6

-- ============================================================
-- ROLLBACK - restores the previous definition (ConvFactAltUom + 001A,
-- with discontinued products excluded again).
-- ============================================================
-- USE [SysproCompany001];
-- GO
-- IF OBJECT_ID('dbo.vw_FS_Products', 'V') IS NOT NULL
--     DROP VIEW dbo.vw_FS_Products;
-- GO
-- CREATE VIEW dbo.vw_FS_Products AS
-- SELECT
--     RTRIM(m.StockCode)            AS code,
--     RTRIM(m.Description)          AS name,
--     RTRIM(m.LongDesc)             AS description,
--     RTRIM(m.OtherUom)             AS uom,
--     RTRIM(m.StockUom)             AS pack_size,
--     ISNULL(m.ConvFactAltUom, 1.0) AS conv_factor_alt_uom,
--     ISNULL(pr.SellingPrice, 0)    AS list_price,
--     0                             AS cost_price
-- FROM dbo.InvMaster m
-- INNER JOIN dbo.[InvMaster+] e ON m.StockCode = e.StockCode
-- OUTER APPLY (
--     SELECT TOP 1 SellingPrice FROM dbo.InvPrice p
--     WHERE p.StockCode = m.StockCode
--     ORDER BY CASE WHEN p.PriceCode = 'G' THEN 0 ELSE 1 END, p.PriceCode
-- ) pr
-- WHERE RTRIM(m.ProductClass) IN ('001', '001A', '001B', '100', '100A')
--    AND ISNULL(e.Discontinued, 'N') <> 'Y';
-- GO

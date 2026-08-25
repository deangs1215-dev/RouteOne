-- vw_FS_Products - fix: missing ProductClass '001A'
--
-- ---------------------------------------------------------------------------
-- Why this fix (2026-08-14)
-- ---------------------------------------------------------------------------
-- A rep reported "Orley Whip Dessert Topping 6x1ltr" (StockCode 4282900060)
-- was missing from RouteOne entirely - not just this invoice's breakdown, the
-- product itself was absent from the catalogue. Traced to vw_FS_Products'
-- WHERE clause:
--
--     WHERE RTRIM(m.ProductClass) IN ('001', '001B', '100', '100A')
--
-- ProductClass '001A' is simply not in that list. Confirmed via InvMaster
-- directly: 163 products carry ProductClass = '001A', and ZERO of them come
-- through vw_FS_Products - this isn't a one-off, the entire class has never
-- been orderable in RouteOne.
--
-- '001A' is not a guess at what should be included - it already appears in
-- vw_FS_RepSalesByMonth.sql's own ProductClass list (which also includes
-- '200', '300', '904', '903' - none of which are added here, since there's
-- no evidence yet those represent real orderable stock rather than non-stock
-- categories like freight/rebates/service charges that legitimately count
-- toward sales reporting but were deliberately excluded from the catalogue.
-- Ask the DBA what those four represent before adding any of them.
--
-- Only the ProductClass filter changes. Everything else (InvMaster+ join,
-- Discontinued flag, OUTER APPLY price lookup) is unchanged from the live
-- definition, captured below via OBJECT_DEFINITION on 2026-08-14.
--
-- ============================================================
-- BEFORE YOU RUN THIS: the exact live definition is reproduced in the
-- ROLLBACK section at the bottom, captured via
--     SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.vw_FS_Products'));
-- on 2026-08-14. Safe to re-run - dropping and recreating a view doesn't
-- touch any data.
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
    RTRIM(m.StockCode)         AS code,
    RTRIM(m.Description)       AS name,
    RTRIM(m.LongDesc)          AS description,
    RTRIM(m.OtherUom)          AS uom,
    RTRIM(m.StockUom)          AS pack_size,
    ISNULL(pr.SellingPrice, 0) AS list_price,
    0                          AS cost_price
FROM dbo.InvMaster m
INNER JOIN dbo.[InvMaster+] e ON m.StockCode = e.StockCode
OUTER APPLY (
    SELECT TOP 1 SellingPrice
    FROM dbo.InvPrice p
    WHERE p.StockCode = m.StockCode
    ORDER BY CASE WHEN p.PriceCode = 'G' THEN 0 ELSE 1 END, p.PriceCode
) pr
WHERE RTRIM(m.ProductClass) IN ('001', '001A', '001B', '100', '100A')   -- '001A' added
   AND ISNULL(e.Discontinued, 'N') <> 'Y';
GO

-- Grant back whatever the RouteOne read-only login needs (dropping a view
-- drops its permissions with it).
--
-- GRANT SELECT ON dbo.vw_FS_Products TO [routeone_ro];
-- GO

-- ============================================================
-- Validation - run these after creating the view above
-- ============================================================

-- 1. Orley Whip should now appear.
SELECT * FROM dbo.vw_FS_Products WHERE code = '4282900060';

-- 2. All 163 previously-missing 001A products should now come through.
SELECT COUNT(*) AS total_001A_products,
       SUM(CASE WHEN p.code IS NOT NULL THEN 1 ELSE 0 END) AS found_in_view
FROM dbo.InvMaster m
LEFT JOIN dbo.vw_FS_Products p ON p.code = m.StockCode
WHERE m.ProductClass = '001A';
-- found_in_view should now equal total_001A_products (allowing for a few
-- genuinely Discontinued='Y' or missing from InvMaster+ - not every 001A
-- product is expected to appear, just no longer ALL excluded).

-- 3. Sanity: nothing that was there before should have disappeared.
SELECT COUNT(*) AS total_products FROM dbo.vw_FS_Products;

-- ============================================================
-- ROLLBACK - the exact live definition, captured 2026-08-14 via
-- OBJECT_DEFINITION(OBJECT_ID('dbo.vw_FS_Products')). Run this block to put
-- it back exactly as it was (re-excludes all 163 '001A' products, including
-- Orley Whip).
-- ============================================================
-- USE [SysproCompany001];
-- GO
--
-- IF OBJECT_ID('dbo.vw_FS_Products', 'V') IS NOT NULL
--     DROP VIEW dbo.vw_FS_Products;
-- GO
--
-- CREATE VIEW dbo.vw_FS_Products AS
-- SELECT
--     RTRIM(m.StockCode)         AS code,
--     RTRIM(m.Description)       AS name,
--     RTRIM(m.LongDesc)          AS description,
--     RTRIM(m.OtherUom)          AS uom,
--     RTRIM(m.StockUom)          AS pack_size,
--     ISNULL(pr.SellingPrice, 0) AS list_price,
--     0                          AS cost_price
-- FROM dbo.InvMaster m
-- INNER JOIN dbo.[InvMaster+] e ON m.StockCode = e.StockCode
-- OUTER APPLY (
--     SELECT TOP 1 SellingPrice
--     FROM dbo.InvPrice p
--     WHERE p.StockCode = m.StockCode
--     ORDER BY CASE WHEN p.PriceCode = 'G' THEN 0 ELSE 1 END, p.PriceCode
-- ) pr
-- WHERE RTRIM(m.ProductClass) IN ('001', '001B', '100', '100A')
--    AND ISNULL(e.Discontinued, 'N') <> 'Y';
-- GO

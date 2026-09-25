-- vw_FS_Products - add ConvFactAltUom for accurate unit pricing
--
-- Purpose: products are priced per kg in SYSPRO, but sold in various units
-- (liters, cases, etc). ConvFactAltUom is SYSPRO's own conversion factor
-- between the stocking UOM and the alternate (selling) UOM.
--
-- Previously RouteOne derived this by string-parsing StockUom (exposed as
-- pack_size) - see packWeightKg() in server/db.js. That parse is what produced
-- the wrong unit price reported on 2026-08-25 for Orley Whip Dessert Topping
-- 6x1LTR (StockCode 4282900060): pack_size parsed to 5.76, giving
-- 50.50 x 5.76 = R 290,88, where the expected price is 50.50 x 6 = R 303,00.
--
-- The fix is to stop parsing text and read ConvFactAltUom directly. Run
-- validation query #1 below to confirm the actual value for this product
-- before re-syncing - the fix only produces R 303,00 if ConvFactAltUom is 6.

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
    RTRIM(m.StockCode)                       AS code,
    RTRIM(m.Description)                     AS name,
    RTRIM(m.LongDesc)                        AS description,
    RTRIM(m.OtherUom)                        AS uom,
    RTRIM(m.StockUom)                        AS pack_size,
    ISNULL(m.ConvFactAltUom, 1.0)            AS conv_factor_alt_uom,
    ISNULL(pr.SellingPrice, 0)               AS list_price,
    0                                        AS cost_price
FROM dbo.InvMaster m
INNER JOIN dbo.[InvMaster+] e ON m.StockCode = e.StockCode
OUTER APPLY (
    SELECT TOP 1 SellingPrice
    FROM dbo.InvPrice p
    WHERE p.StockCode = m.StockCode
    ORDER BY CASE WHEN p.PriceCode = 'G' THEN 0 ELSE 1 END, p.PriceCode
) pr
WHERE RTRIM(m.ProductClass) IN ('001', '001A', '001B', '100', '100A')
   AND ISNULL(e.Discontinued, 'N') <> 'Y';
GO

-- Grant back whatever the RouteOne read-only login needs
--
-- GRANT SELECT ON dbo.vw_FS_Products TO [RouteOneApp];
-- GO

-- ============================================================
-- Validation - run these after creating the view above
-- ============================================================

-- 1. RUN THIS FIRST. Orley Whip is the reported case - compare the two factors.
SELECT code, name, uom, pack_size, conv_factor_alt_uom, list_price,
       list_price * conv_factor_alt_uom AS unit_price_after_fix
FROM dbo.vw_FS_Products
WHERE code = '4282900060';

-- pack_size (StockUom) is known to be 5.76 here, which is what produced the
-- wrong R 290,88. If conv_factor_alt_uom comes back as 6, unit_price_after_fix
-- is R 303,00 and the fix is confirmed. If it also returns 5.76, then
-- ConvFactAltUom is NOT the field that distinguishes these two numbers and the
-- source of the expected R 303,00 needs to be identified before re-syncing.

-- 2. Sanity: ConvFactAltUom should be positive for all products
SELECT TOP 20 code, name, conv_factor_alt_uom
FROM dbo.vw_FS_Products
WHERE conv_factor_alt_uom <= 0 OR conv_factor_alt_uom IS NULL
ORDER BY code;

-- 3. Sample of products with different uoms
SELECT TOP 20 code, name, uom, pack_size, conv_factor_alt_uom, list_price
FROM dbo.vw_FS_Products
ORDER BY code;

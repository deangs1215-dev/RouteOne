-- vw_FS_CustomerPricing_ContractBuyingGroup - fix contract prices dropping out
-- on their own expiry date
--
-- ---------------------------------------------------------------------------
-- Why (2026-08-31)
-- ---------------------------------------------------------------------------
-- Reported on HANGAR BAKERY (31144), stock 1716600250 (PLATINUM BREAD MIX).
-- SYSPRO's Sales Order Contract Prices screen shows an active "SET 2" fixed
-- price of R23.43/kg for this customer/stock, running 2026-05-11 to
-- 2026-08-31. RouteOne's New Order screen instead showed the price-code
-- price, R35.51/kg - the contract price wasn't being picked up at all.
--
-- Compared the synced syspro_customer_pricing row for this pair across two
-- sync runs:
--   2026-07-23 (mid-contract window):  contract_price = 23.43   (correct)
--   2026-08-31 (contract's last day):  contract_price = NULL    (wrong)
--
-- Root cause: both the `contract` and `buying_group` CTEs filter expiry with
--   scp.ExpiryDate >= GETDATE()
-- GETDATE() returns the current date AND time. SorContractPrice.ExpiryDate is
-- stored at midnight (e.g. 2026-08-31 00:00:00.000). Any time after midnight
-- on the contract's own last day is later than that timestamp, so the
-- contract reads as already-expired for its entire final calendar day -
-- exactly the day this was reported on. Fix: compare expiry against
-- CAST(GETDATE() AS DATE) instead, so the contract stays valid through the
-- whole last day. StartDate <= GETDATE() has no equivalent problem (it fails
-- toward "not yet started", not "already expired"), but is cast the same way
-- for consistency and to rule out the mirror-image bug at the start boundary.
--
-- No RouteOne code change is needed - server/db.js's effectivePrice() already
-- prefers contract_price over price_code_price whenever the synced dates put
-- it in-window (see server/db.js:334-360). Re-sync customer_pricing after
-- applying, and affected prices correct themselves on the next sync
-- (upsertCustomerPricing overwrites these columns every run).
--
-- ============================================================
-- ROLLBACK: the previous definition is reproduced at the bottom.
-- ============================================================
--
-- NOTE: everything above "CREATE VIEW" below was reconstructed from a
-- pasted fragment of `sp_helptext` output that was missing its opening line
-- (the CREATE VIEW header and the start of the active_customers CTE).
-- Diff this against a fresh `EXEC sp_helptext
-- 'dbo.vw_FS_CustomerPricing_ContractBuyingGroup'` before running.

USE [SysproCompany001];
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.vw_FS_CustomerPricing_ContractBuyingGroup', 'V') IS NOT NULL
    DROP VIEW dbo.vw_FS_CustomerPricing_ContractBuyingGroup;
GO

CREATE VIEW dbo.vw_FS_CustomerPricing_ContractBuyingGroup AS
WITH active_customers AS
    (SELECT DISTINCT Customer
       FROM         dbo.vw_ArTrnDetail_SalesPersonCommissionCalc
       WHERE     TrnYear >= YEAR(DATEADD(YEAR, - 1, GETDATE()))),
contract AS
    (SELECT   customer_code, product_code, contract_price, start_date, expiry_date
       FROM         (SELECT   scp.CustomerBuyGrp AS customer_code, scp.StockCode AS product_code, scp.FixedPrice AS contract_price, scp.StartDate AS start_date, scp.ExpiryDate AS expiry_date,
                                                           ROW_NUMBER() OVER (PARTITION BY scp.CustomerBuyGrp, scp.StockCode
                                  ORDER BY scp.StartDate DESC) AS rn
       FROM         dbo.SorContractPrice scp WITH (NOLOCK) INNER JOIN
                                dbo.ArCustomer c WITH (NOLOCK) ON c.Customer = scp.CustomerBuyGrp AND c.ContractPrcReqd = 'Y'
       -- FIX: date-only comparison so a contract stays valid through its
       -- entire final calendar day, instead of GETDATE()'s time-of-day
       -- pushing it "expired" as soon as the clock passes midnight.
       WHERE     scp.ContractType = 'C' AND (scp.ExpiryDate IS NULL OR
                                scp.ExpiryDate >= CAST(GETDATE() AS DATE)) AND (scp.StartDate IS NULL OR
                                scp.StartDate <= CAST(GETDATE() AS DATE)) AND c.CustomerOnHold <> 'Y' AND c.Customer IN
                                    (SELECT   Customer
                                       FROM         active_customers)) x
WHERE     rn = 1), buying_group AS
    (SELECT   customer_code, product_code, buying_group_price, start_date, expiry_date
       FROM         (SELECT   c.Customer AS customer_code, scp.StockCode AS product_code, scp.FixedPrice AS buying_group_price, scp.StartDate AS start_date, scp.ExpiryDate AS expiry_date,
                                                           ROW_NUMBER() OVER (PARTITION BY c.Customer, scp.StockCode
                                  ORDER BY scp.StartDate DESC) AS rn
       FROM         dbo.SorContractPrice scp WITH (NOLOCK) INNER JOIN
                                dbo.ArCustomer c WITH (NOLOCK) ON c.BuyingGroup1 = scp.CustomerBuyGrp
       -- Same fix as the contract CTE above.
       WHERE     scp.ContractType = 'B' AND (scp.ExpiryDate IS NULL OR
                                scp.ExpiryDate >= CAST(GETDATE() AS DATE)) AND (scp.StartDate IS NULL OR
                                scp.StartDate <= CAST(GETDATE() AS DATE)) AND c.BuyingGroup1 IS NOT NULL AND c.CustomerOnHold <> 'Y' AND c.Customer IN
                                    (SELECT   Customer
                                       FROM         active_customers)) x
WHERE     rn = 1), price_code AS
    (SELECT   c.Customer AS customer_code, p.StockCode AS product_code, p.SellingPrice AS price_code_price
       FROM         dbo.ArCustomer c WITH (NOLOCK) INNER JOIN
                                dbo.InvPrice p WITH (NOLOCK) ON p.PriceCode = c.PriceCode
       WHERE     c.PriceCode IS NOT NULL AND c.PriceCode <> '' AND c.CustomerOnHold <> 'Y' AND c.Customer IN
                                    (SELECT   Customer
                                       FROM         active_customers)), keys AS
    (SELECT   customer_code, product_code
       FROM         contract
       UNION ALL
       SELECT   customer_code, product_code
       FROM         buying_group
       UNION ALL
       SELECT   customer_code, product_code
       FROM         price_code)
    SELECT DISTINCT
                              k.customer_code, k.product_code, ct.contract_price, ct.start_date AS contract_start_date, ct.expiry_date AS contract_end_date, bg.buying_group_price,
                              bg.start_date AS buying_group_start_date, bg.expiry_date AS buying_group_end_date, pc.price_code_price
     FROM         keys k WITH (NOLOCK) LEFT JOIN
                              contract ct ON ct.customer_code = k.customer_code AND ct.product_code = k.product_code LEFT JOIN
                              buying_group bg ON bg.customer_code = k.customer_code AND bg.product_code = k.product_code LEFT JOIN
                              price_code pc ON pc.customer_code = k.customer_code AND pc.product_code = k.product_code;
GO

-- Dropping a view drops its permissions - grant them back.
--
-- GRANT SELECT ON dbo.vw_FS_CustomerPricing_ContractBuyingGroup TO [RouteOneApp];
-- GO

-- ============================================================
-- Validation
-- ============================================================

-- 1. The reported customer/stock. Expect contract_price = 23.43,
--    contract_end_date = 2026-08-31 (today, and still returned).
SELECT customer_code, product_code, contract_price, contract_start_date, contract_end_date, price_code_price
FROM dbo.vw_FS_CustomerPricing_ContractBuyingGroup
WHERE customer_code = '31144' AND product_code = '1716600250';

-- 2. Any other contracts expiring today should now still show a
--    contract_price instead of falling through to price_code_price. Expect
--    zero rows where contract_price is NULL but a same-day-expiring contract
--    exists in SorContractPrice.
SELECT scp.CustomerBuyGrp, scp.StockCode, scp.FixedPrice, scp.ExpiryDate
FROM dbo.SorContractPrice scp
WHERE scp.ContractType = 'C'
  AND CAST(scp.ExpiryDate AS DATE) = CAST(GETDATE() AS DATE)
  AND NOT EXISTS (
    SELECT 1 FROM dbo.vw_FS_CustomerPricing_ContractBuyingGroup v
    WHERE v.customer_code = scp.CustomerBuyGrp AND v.product_code = scp.StockCode
      AND v.contract_price IS NOT NULL
  );

-- After applying, re-run the RouteOne sync (Settings -> Integration ->
-- customer_pricing, or a full sync) so the corrected price reaches
-- syspro_customer_pricing.contract_price.

-- ============================================================
-- ROLLBACK - previous definition (drops contracts on their own expiry day)
-- ============================================================
-- USE [SysproCompany001];
-- GO
-- IF OBJECT_ID('dbo.vw_FS_CustomerPricing_ContractBuyingGroup', 'V') IS NOT NULL
--     DROP VIEW dbo.vw_FS_CustomerPricing_ContractBuyingGroup;
-- GO
-- CREATE VIEW dbo.vw_FS_CustomerPricing_ContractBuyingGroup AS
-- WITH active_customers AS
--     (SELECT DISTINCT Customer
--        FROM         dbo.vw_ArTrnDetail_SalesPersonCommissionCalc
--        WHERE     TrnYear >= YEAR(DATEADD(YEAR, - 1, GETDATE()))),
-- contract AS
--     (SELECT   customer_code, product_code, contract_price, start_date, expiry_date
--        FROM         (SELECT   scp.CustomerBuyGrp AS customer_code, scp.StockCode AS product_code, scp.FixedPrice AS contract_price, scp.StartDate AS start_date, scp.ExpiryDate AS expiry_date,
--                                                            ROW_NUMBER() OVER (PARTITION BY scp.CustomerBuyGrp, scp.StockCode
--                                   ORDER BY scp.StartDate DESC) AS rn
--        FROM         dbo.SorContractPrice scp WITH (NOLOCK) INNER JOIN
--                                 dbo.ArCustomer c WITH (NOLOCK) ON c.Customer = scp.CustomerBuyGrp AND c.ContractPrcReqd = 'Y'
--        WHERE     scp.ContractType = 'C' AND (scp.ExpiryDate IS NULL OR
--                                 scp.ExpiryDate >= GETDATE()) AND (scp.StartDate IS NULL OR
--                                 scp.StartDate <= GETDATE()) AND c.CustomerOnHold <> 'Y' AND c.Customer IN
--                                     (SELECT   Customer
--                                        FROM         active_customers)) x
-- WHERE     rn = 1), buying_group AS
--     (SELECT   customer_code, product_code, buying_group_price, start_date, expiry_date
--        FROM         (SELECT   c.Customer AS customer_code, scp.StockCode AS product_code, scp.FixedPrice AS buying_group_price, scp.StartDate AS start_date, scp.ExpiryDate AS expiry_date,
--                                                            ROW_NUMBER() OVER (PARTITION BY c.Customer, scp.StockCode
--                                   ORDER BY scp.StartDate DESC) AS rn
--        FROM         dbo.SorContractPrice scp WITH (NOLOCK) INNER JOIN
--                                 dbo.ArCustomer c WITH (NOLOCK) ON c.BuyingGroup1 = scp.CustomerBuyGrp
--        WHERE     scp.ContractType = 'B' AND (scp.ExpiryDate IS NULL OR
--                                 scp.ExpiryDate >= GETDATE()) AND (scp.StartDate IS NULL OR
--                                 scp.StartDate <= GETDATE()) AND c.BuyingGroup1 IS NOT NULL AND c.CustomerOnHold <> 'Y' AND c.Customer IN
--                                     (SELECT   Customer
--                                        FROM         active_customers)) x
-- WHERE     rn = 1), price_code AS
--     (SELECT   c.Customer AS customer_code, p.StockCode AS product_code, p.SellingPrice AS price_code_price
--        FROM         dbo.ArCustomer c WITH (NOLOCK) INNER JOIN
--                                 dbo.InvPrice p WITH (NOLOCK) ON p.PriceCode = c.PriceCode
--        WHERE     c.PriceCode IS NOT NULL AND c.PriceCode <> '' AND c.CustomerOnHold <> 'Y' AND c.Customer IN
--                                     (SELECT   Customer
--                                        FROM         active_customers)), keys AS
--     (SELECT   customer_code, product_code
--        FROM         contract
--        UNION ALL
--        SELECT   customer_code, product_code
--        FROM         buying_group
--        UNION ALL
--        SELECT   customer_code, product_code
--        FROM         price_code)
--     SELECT DISTINCT
--                               k.customer_code, k.product_code, ct.contract_price, ct.start_date AS contract_start_date, ct.expiry_date AS contract_end_date, bg.buying_group_price,
--                               bg.start_date AS buying_group_start_date, bg.expiry_date AS buying_group_end_date, pc.price_code_price
--      FROM         keys k WITH (NOLOCK) LEFT JOIN
--                               contract ct ON ct.customer_code = k.customer_code AND ct.product_code = k.product_code LEFT JOIN
--                               buying_group bg ON bg.customer_code = k.customer_code AND bg.product_code = k.product_code LEFT JOIN
--                               price_code pc ON pc.customer_code = k.customer_code AND pc.product_code = k.product_code;
-- GO

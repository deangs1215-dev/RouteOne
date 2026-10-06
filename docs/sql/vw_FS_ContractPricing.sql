-- vw_FS_ContractPricing - contract + buying-group prices ONLY, for the
-- frequent "contract_pricing" sync
--
-- ---------------------------------------------------------------------------
-- Why (2026-10-06)
-- ---------------------------------------------------------------------------
-- RouteOne order ORD-00272 (SPAR RIDGEWAY GARDENS, 31313) was priced at the
-- price-code price for two products that SYSPRO prices from an active contract
-- ("NEW DEAL", R30.00/kg and R70.29/kg). The contract was valid and
-- vw_FS_CustomerPricing_ContractBuyingGroup returned it when queried by hand,
-- but RouteOne's copy had no contract price: that view is ~4.5M rows, takes
-- ~5 minutes to read and is synced only twice a day, so a contract that is
-- missing from (or arrives after) a sync stays wrong for hours. The same sync
-- also found ~17,000 contract prices (1,507 customers) that RouteOne had not
-- been holding at all.
--
-- Contracts and buying-group prices are only ~85k rows. This view returns just
-- those, so RouteOne can read them in seconds every 15-30 minutes. It does not
-- replace vw_FS_CustomerPricing_ContractBuyingGroup, which still supplies the
-- price-code prices.
--
-- The filters are deliberately IDENTICAL to the contract / buying_group CTEs of
-- vw_FS_CustomerPricing_ContractBuyingGroup (same customer rules, same
-- date-only expiry comparison, same tbl_ActiveCustomers_Weekly cache). RouteOne
-- compares this view with the big one after each sync and warns when they
-- disagree, which only works if they are meant to return the same contracts.
--
-- One row per (customer_code, product_code). A pair with both a contract and a
-- buying-group price appears once with both columns filled; contract_price
-- always wins in RouteOne (server/db.js effectivePriceDetail).
--
-- Column names/types match what the sync reads (server/integration/sync.js).
--
-- Rollback: DROP VIEW dbo.vw_FS_ContractPricing; RouteOne's contract_pricing
-- sync then just reports an error each run and the existing twice-daily sync
-- carries on exactly as before.

USE [SysproCompany001];
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.vw_FS_ContractPricing', 'V') IS NOT NULL
    DROP VIEW dbo.vw_FS_ContractPricing;
GO

CREATE VIEW dbo.vw_FS_ContractPricing AS
WITH contract AS
    (SELECT   customer_code, product_code, contract_price, start_date, expiry_date
       FROM         (SELECT   scp.CustomerBuyGrp AS customer_code, scp.StockCode AS product_code, scp.FixedPrice AS contract_price, scp.StartDate AS start_date, scp.ExpiryDate AS expiry_date,
                                                           ROW_NUMBER() OVER (PARTITION BY scp.CustomerBuyGrp, scp.StockCode
                                  ORDER BY scp.StartDate DESC) AS rn
       FROM         dbo.SorContractPrice scp WITH (NOLOCK) INNER JOIN
                                dbo.ArCustomer c WITH (NOLOCK) ON c.Customer = scp.CustomerBuyGrp AND c.ContractPrcReqd = 'Y' INNER JOIN
                                dbo.tbl_ActiveCustomers_Weekly ac WITH (NOLOCK) ON ac.Customer = c.Customer
       WHERE     scp.ContractType = 'C' AND (scp.ExpiryDate IS NULL OR
                                scp.ExpiryDate >= CAST(GETDATE() AS DATE)) AND (scp.StartDate IS NULL OR
                                scp.StartDate <= CAST(GETDATE() AS DATE)) AND c.CustomerOnHold <> 'Y') x
WHERE     rn = 1), buying_group AS
    (SELECT   customer_code, product_code, buying_group_price, start_date, expiry_date
       FROM         (SELECT   c.Customer AS customer_code, scp.StockCode AS product_code, scp.FixedPrice AS buying_group_price, scp.StartDate AS start_date, scp.ExpiryDate AS expiry_date,
                                                           ROW_NUMBER() OVER (PARTITION BY c.Customer, scp.StockCode
                                  ORDER BY scp.StartDate DESC) AS rn
       FROM         dbo.SorContractPrice scp WITH (NOLOCK) INNER JOIN
                                dbo.ArCustomer c WITH (NOLOCK) ON c.BuyingGroup1 = scp.CustomerBuyGrp INNER JOIN
                                dbo.tbl_ActiveCustomers_Weekly ac WITH (NOLOCK) ON ac.Customer = c.Customer
       WHERE     scp.ContractType = 'B' AND (scp.ExpiryDate IS NULL OR
                                scp.ExpiryDate >= CAST(GETDATE() AS DATE)) AND (scp.StartDate IS NULL OR
                                scp.StartDate <= CAST(GETDATE() AS DATE)) AND c.BuyingGroup1 IS NOT NULL AND c.CustomerOnHold <> 'Y') x
WHERE     rn = 1)
SELECT     COALESCE(ct.customer_code, bg.customer_code) AS customer_code,
           COALESCE(ct.product_code, bg.product_code) AS product_code,
           ct.contract_price,
           ct.start_date AS contract_start_date,
           ct.expiry_date AS contract_end_date,
           bg.buying_group_price,
           bg.start_date AS buying_group_start_date,
           bg.expiry_date AS buying_group_end_date
FROM       contract ct FULL OUTER JOIN
           buying_group bg ON bg.customer_code = ct.customer_code AND bg.product_code = ct.product_code;
GO

-- Dropping a view drops its permissions - grant them back.
-- GRANT SELECT ON dbo.vw_FS_ContractPricing TO [RouteOneApp];
-- GO

-- ============================================================
-- Validation
-- ============================================================

-- 1. The reported pair. Expect contract_price 30.00 and 70.29, end 2026-11-03.
SELECT customer_code, product_code, contract_price, contract_start_date, contract_end_date, buying_group_price
FROM dbo.vw_FS_ContractPricing
WHERE customer_code = '31313' AND product_code IN ('1762000250', '4130000050');

-- 2. Size and speed. Expect ~85k rows, returned in seconds (not minutes).
SET STATISTICS TIME ON;
SELECT COUNT(*) AS rows_total,
       SUM(CASE WHEN contract_price IS NOT NULL THEN 1 ELSE 0 END) AS contract_rows,
       SUM(CASE WHEN buying_group_price IS NOT NULL THEN 1 ELSE 0 END) AS buying_group_rows
FROM dbo.vw_FS_ContractPricing;
SET STATISTICS TIME OFF;

-- 3. Must agree with the big view: every contract/buying-group price here is
--    also there. Expect 0 rows (a handful is fine if run while a contract is
--    being edited). SLOW - this evaluates the big view (~5 minutes); skip it
--    if you only want to confirm the new view works.
SELECT TOP 20 v.customer_code, v.product_code, v.contract_price, v.buying_group_price
FROM dbo.vw_FS_ContractPricing v
WHERE NOT EXISTS (
    SELECT 1 FROM dbo.vw_FS_CustomerPricing_ContractBuyingGroup b
    WHERE b.customer_code = v.customer_code AND b.product_code = v.product_code
      AND (b.contract_price IS NOT NULL OR b.buying_group_price IS NOT NULL)
);

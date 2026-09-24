-- ============================================================
-- OPTIMIZED: vw_FS_CustomerPricing_ContractBuyingGroup
-- ============================================================
-- Instead of checking active customers on every sync run (4.47M row IN subquery),
-- pre-compute active customers ONCE PER WEEK into a cached table.
-- The view then just references that table.
--
-- Performance impact:
-- - Removes 4.47M IN subquery evaluations from the pricing view
-- - Active customer check runs once weekly (seconds) instead of millions of times
-- - Pricing sync is only limited by fetch/write speed, not customer filtering
--
-- ============================================================
-- STEP 1: Create the weekly active customer cache table
-- ============================================================

USE [SysproCompany001];
GO

IF OBJECT_ID('dbo.tbl_ActiveCustomers_Weekly', 'U') IS NOT NULL
    DROP TABLE dbo.tbl_ActiveCustomers_Weekly;
GO

CREATE TABLE dbo.tbl_ActiveCustomers_Weekly (
    Customer NVARCHAR(20) NOT NULL PRIMARY KEY,
    last_updated DATETIME DEFAULT GETDATE()
);
GO

-- ============================================================
-- STEP 2: Create stored procedure to update the cache
-- (Run this once per week via SQL Agent or external scheduler)
-- ============================================================

IF OBJECT_ID('dbo.sp_UpdateActiveCustomers_Weekly', 'P') IS NOT NULL
    DROP PROCEDURE dbo.sp_UpdateActiveCustomers_Weekly;
GO

CREATE PROCEDURE dbo.sp_UpdateActiveCustomers_Weekly
AS
BEGIN
    SET NOCOUNT ON;

    -- Clear the old cache
    TRUNCATE TABLE dbo.tbl_ActiveCustomers_Weekly;

    -- Repopulate with customers who had sales in the last 12 months
    -- This is the SAME logic as the original active_customers CTE,
    -- but run once and cached instead of re-evaluated 4.47M times per sync
    INSERT INTO dbo.tbl_ActiveCustomers_Weekly (Customer, last_updated)
    SELECT DISTINCT Customer, GETDATE()
    FROM dbo.vw_ArTrnDetail_SalesPersonCommissionCalc WITH (NOLOCK)
    WHERE TrnYear >= YEAR(DATEADD(YEAR, -1, GETDATE()));

    PRINT CONCAT('Active customers cache updated: ',
                 @@ROWCOUNT, ' customers marked as active');
END
GO

-- ============================================================
-- STEP 3: Schedule the weekly update
-- ============================================================
-- Run this in SQL Agent to execute sp_UpdateActiveCustomers_Weekly once per week
-- (e.g., Sunday at 2:00 AM, before the daily pricing sync)
--
-- SQL Agent job:
--   Name: "Update Active Customers Cache"
--   Schedule: Weekly, every Sunday 02:00
--   Command: EXEC dbo.sp_UpdateActiveCustomers_Weekly;
--
-- Or via Windows Task Scheduler:
--   sqlcmd -S [server] -d SysproCompany001 -Q "EXEC dbo.sp_UpdateActiveCustomers_Weekly"

-- ============================================================
-- STEP 4: Optimized pricing view (references the cache table)
-- ============================================================

IF OBJECT_ID('dbo.vw_FS_CustomerPricing_ContractBuyingGroup', 'V') IS NOT NULL
    DROP VIEW dbo.vw_FS_CustomerPricing_ContractBuyingGroup;
GO

CREATE VIEW dbo.vw_FS_CustomerPricing_ContractBuyingGroup AS

-- REMOVED: the active_customers CTE that was evaluated 4.47M times
-- NOW: just reference the pre-computed weekly cache table

-- Get CONTRACT PRICES (ContractType = 'C')
WITH contract AS
    (SELECT customer_code, product_code, contract_price, start_date, expiry_date
       FROM (
           SELECT scp.CustomerBuyGrp AS customer_code,
                  scp.StockCode AS product_code,
                  scp.FixedPrice AS contract_price,
                  scp.StartDate AS start_date,
                  scp.ExpiryDate AS expiry_date,
                  ROW_NUMBER() OVER (PARTITION BY scp.CustomerBuyGrp, scp.StockCode
                                     ORDER BY scp.StartDate DESC) AS rn
           FROM dbo.SorContractPrice scp WITH (NOLOCK)
           INNER JOIN dbo.ArCustomer c WITH (NOLOCK)
               ON c.Customer = scp.CustomerBuyGrp AND c.ContractPrcReqd = 'Y'
           -- CHANGED: reference the cached table instead of subquery
           INNER JOIN dbo.tbl_ActiveCustomers_Weekly ac WITH (NOLOCK)
               ON ac.Customer = c.Customer
           WHERE scp.ContractType = 'C'
             AND (scp.ExpiryDate IS NULL OR
                  scp.ExpiryDate >= CAST(GETDATE() AS DATE))
             AND (scp.StartDate IS NULL OR
                  scp.StartDate <= CAST(GETDATE() AS DATE))
             AND c.CustomerOnHold <> 'Y'
       ) x
       WHERE rn = 1
    ),

-- Get BUYING GROUP PRICES (ContractType = 'B')
buying_group AS
    (SELECT customer_code, product_code, buying_group_price, start_date, expiry_date
       FROM (
           SELECT c.Customer AS customer_code,
                  scp.StockCode AS product_code,
                  scp.FixedPrice AS buying_group_price,
                  scp.StartDate AS start_date,
                  scp.ExpiryDate AS expiry_date,
                  ROW_NUMBER() OVER (PARTITION BY c.Customer, scp.StockCode
                                     ORDER BY scp.StartDate DESC) AS rn
           FROM dbo.SorContractPrice scp WITH (NOLOCK)
           INNER JOIN dbo.ArCustomer c WITH (NOLOCK)
               ON c.BuyingGroup1 = scp.CustomerBuyGrp
           -- CHANGED: reference the cached table instead of subquery
           INNER JOIN dbo.tbl_ActiveCustomers_Weekly ac WITH (NOLOCK)
               ON ac.Customer = c.Customer
           WHERE scp.ContractType = 'B'
             AND (scp.ExpiryDate IS NULL OR
                  scp.ExpiryDate >= CAST(GETDATE() AS DATE))
             AND (scp.StartDate IS NULL OR
                  scp.StartDate <= CAST(GETDATE() AS DATE))
             AND c.BuyingGroup1 IS NOT NULL
             AND c.CustomerOnHold <> 'Y'
       ) x
       WHERE rn = 1
    ),

-- Get PRICE CODE PRICES
price_code AS
    (SELECT c.Customer AS customer_code,
            p.StockCode AS product_code,
            p.SellingPrice AS price_code_price
       FROM dbo.ArCustomer c WITH (NOLOCK)
       INNER JOIN dbo.InvPrice p WITH (NOLOCK)
           ON p.PriceCode = c.PriceCode
       -- CHANGED: reference the cached table instead of subquery
       INNER JOIN dbo.tbl_ActiveCustomers_Weekly ac WITH (NOLOCK)
           ON ac.Customer = c.Customer
       WHERE c.PriceCode IS NOT NULL
         AND c.PriceCode <> ''
         AND c.CustomerOnHold <> 'Y'
    ),

-- Build the key set - every customer/product combo that has ANY pricing tier
keys AS
    (SELECT customer_code, product_code FROM contract
       UNION ALL
     SELECT customer_code, product_code FROM buying_group
       UNION ALL
     SELECT customer_code, product_code FROM price_code
    )

-- Final result - LEFT JOIN all pricing tiers together
SELECT DISTINCT
    k.customer_code,
    k.product_code,
    ct.contract_price,
    ct.start_date AS contract_start_date,
    ct.expiry_date AS contract_end_date,
    bg.buying_group_price,
    bg.start_date AS buying_group_start_date,
    bg.expiry_date AS buying_group_end_date,
    pc.price_code_price
FROM keys k WITH (NOLOCK)
LEFT JOIN contract ct
    ON ct.customer_code = k.customer_code AND ct.product_code = k.product_code
LEFT JOIN buying_group bg
    ON bg.customer_code = k.customer_code AND bg.product_code = k.product_code
LEFT JOIN price_code pc
    ON pc.customer_code = k.customer_code AND pc.product_code = k.product_code;
GO

-- Restore permissions if needed
-- GRANT SELECT ON dbo.vw_FS_CustomerPricing_ContractBuyingGroup TO [RouteOneApp];
-- GO

-- ============================================================
-- STEP 5: Manual testing / validation
-- ============================================================

-- Check the cache table was populated
SELECT COUNT(*) AS active_customer_count, MAX(last_updated) AS last_cache_update
FROM dbo.tbl_ActiveCustomers_Weekly;

-- Compare: how many customers have pricing at all?
SELECT COUNT(DISTINCT customer_code) AS customers_with_pricing
FROM dbo.vw_FS_CustomerPricing_ContractBuyingGroup;

-- Test the view on the reported customer
SELECT customer_code, product_code, contract_price, contract_start_date, contract_end_date, price_code_price
FROM dbo.vw_FS_CustomerPricing_ContractBuyingGroup
WHERE customer_code = '31144' AND product_code = '1716600250';

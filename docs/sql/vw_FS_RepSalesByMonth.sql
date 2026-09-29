-- vw_FS_RepSalesByMonth
-- Rep sales totals by month, sourced from ArTrnDetail (actual invoiced sales
-- transactions), credited to the CUSTOMER'S CURRENTLY ASSIGNED rep
-- (ArCustomer.Salesperson) - not the rep who processed the individual
-- transaction. This means if a customer moves to a new rep, that rep's
-- monthly totals include the customer's full sales history, retroactively.
--
-- Join structure is kept identical to the original reporting query (all five
-- table references: SalBranch, SalSalesperson x2, ArCustomer, ArTrnDetail) so
-- the underlying row-matching behaviour - and therefore the totals - is
-- exactly the same as the source report. Only the customer-name and
-- product-level columns are dropped from the SELECT/GROUP BY, since this view
-- only needs one row per rep per month.
--
-- CustomerBranch (ArCustomer.Branch) is included alongside TrnBranch
-- (ArTrnDetail.Branch) because they can differ - e.g. a customer invoiced
-- from a branch other than their own. RouteOne resolves "Customer
-- SalesPerson" to a specific rep using CustomerBranch, since that's the
-- branch the salesperson code actually belongs to (same rule used to assign
-- a rep to a customer in the first place).
--
-- Used by RouteOne's Rep KPIs -> Monthly History tab.

USE [SysproCompany001]
GO

CREATE OR ALTER VIEW dbo.vw_FS_RepSalesByMonth AS
SELECT
    dbo.ArTrnDetail.TrnYear,
    dbo.ArTrnDetail.TrnMonth,
    dbo.ArTrnDetail.Branch AS TrnBranch,
    dbo.ArCustomer.Branch AS CustomerBranch,
    dbo.ArCustomer.Salesperson AS [Customer SalesPerson],
    dbo.SalSalesperson.Name AS [Customer SP name],
    SUM(dbo.ArTrnDetail.NetSalesValue) AS NSV
FROM            dbo.SalBranch WITH (nolock) FULL OUTER JOIN
                         dbo.SalSalesperson WITH (nolock) INNER JOIN
                         dbo.ArCustomer WITH (nolock) ON dbo.SalSalesperson.Salesperson = dbo.ArCustomer.Salesperson AND dbo.SalSalesperson.Branch = dbo.ArCustomer.Branch FULL OUTER JOIN
                         dbo.SalSalesperson AS SalSalesperson_1 INNER JOIN
                         dbo.ArTrnDetail WITH (nolock) ON SalSalesperson_1.Branch = dbo.ArTrnDetail.Branch AND SalSalesperson_1.Salesperson = dbo.ArTrnDetail.Salesperson ON dbo.ArCustomer.Customer = dbo.ArTrnDetail.Customer ON
                         dbo.SalBranch.Branch = dbo.ArCustomer.Branch
-- ProductClass filter moved from HAVING to WHERE: it's no longer part of the
-- GROUP BY (we don't break out by product class), so it must be applied
-- before aggregation instead of after. Same filter, same 9 codes, same result.
WHERE           dbo.ArTrnDetail.ProductClass IN ('001', '001A', '001B', '100', '100A', '200', '300', '904', '903')
GROUP BY dbo.ArTrnDetail.TrnYear, dbo.ArTrnDetail.TrnMonth, dbo.ArTrnDetail.Branch, dbo.ArCustomer.Branch, dbo.ArCustomer.Salesperson, dbo.SalSalesperson.Name;
GO

-- ============================================================
-- Validation - run these after creating the view above
-- ============================================================

-- Eyeball the data: most recent months first, biggest sales first
SELECT TOP 50 *
FROM dbo.vw_FS_RepSalesByMonth
ORDER BY TrnYear DESC, TrnMonth DESC, NSV DESC;

-- Should return ZERO rows - one row per rep per branch per month, no duplicates
SELECT TrnYear, TrnMonth, CustomerBranch, [Customer SalesPerson], COUNT(*) AS row_count
FROM dbo.vw_FS_RepSalesByMonth
GROUP BY TrnYear, TrnMonth, CustomerBranch, [Customer SalesPerson]
HAVING COUNT(*) > 1;

-- Sanity check: current-year totals per rep, highest first -
-- compare a few of these against known figures
SELECT [Customer SalesPerson], [Customer SP name], SUM(NSV) AS ytd_sales
FROM dbo.vw_FS_RepSalesByMonth
WHERE TrnYear = YEAR(GETDATE())
GROUP BY [Customer SalesPerson], [Customer SP name]
ORDER BY ytd_sales DESC;

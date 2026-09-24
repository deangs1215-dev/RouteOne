-- Diagnostic: which (branch, salesperson) codes in vw_FS_RepSalesByMonth
-- don't match any active RouteOne rep, and how much NSV they represent.
--
-- rep_sales sync runs are consistently skipping ~51% of rows read (e.g. run
-- 7233: 5922 read, 2891 upserted, 3031 skipped - 2026-09-08). A row is
-- skipped when matchRep(CustomerBranch, [Customer SalesPerson]) finds no
-- active RouteOne rep with that exact (warehouse.code, rep_code) pair - see
-- upsertRepSales in server/integration/sync.js.
--
-- RouteOne's own roster is clean (confirmed 2026-09-08): all 46 active reps
-- have both rep_code and warehouse_id set, and no rep's own customers span
-- more than one branch. So the skips are not a RouteOne-side data gap - this
-- query finds out what they actually are: house/export codes, terminated
-- reps, or a genuine code/branch mismatch worth fixing.
--
-- The VALUES list below is the exact active roster pulled from RouteOne
-- (users where role = rep and active = 1) at the time this was written -
-- re-pull it from Users if reps have been added/changed since.

USE [SysproCompany001];
GO

;WITH active_reps(warehouse_code, rep_code) AS (
    VALUES
        ('03','24'), ('03','120'), ('03','102'), ('02','59'), ('01','111'),
        ('01','94'), ('02','28'), ('01','113'), ('14','18'), ('01','133'),
        ('01','G&P'), ('14','42'), ('01','81'), ('01','131'), ('05','126'),
        ('03','26'), ('05','121'), ('12','101'), ('11','15'), ('12','09'),
        ('01','16'), ('01','104'), ('03','87'), ('05','31'), ('01','110'),
        ('12','06'), ('02','97'), ('02','36'), ('11','33'), ('01','34'),
        ('14','90'), ('01','93'), ('02','122'), ('04','32'), ('01','07'),
        ('01','101'), ('03','29'), ('14','27'), ('02','22'), ('04','114'),
        ('01','12'), ('03','21'), ('01','48'), ('01','123'), ('03','134'),
        ('04','17')
)
SELECT
    v.CustomerBranch,
    v.[Customer SalesPerson],
    v.[Customer SP name],
    COUNT(*) AS row_count,
    SUM(v.NSV) AS total_nsv
FROM dbo.vw_FS_RepSalesByMonth v
LEFT JOIN active_reps ar
    ON ar.warehouse_code = RTRIM(v.CustomerBranch) AND ar.rep_code = RTRIM(v.[Customer SalesPerson])
WHERE ar.rep_code IS NULL
GROUP BY v.CustomerBranch, v.[Customer SalesPerson], v.[Customer SP name]
ORDER BY total_nsv DESC;

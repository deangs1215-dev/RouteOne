-- vw_FS_Reps
-- The list of sales reps RouteOne creates logins from (server/import-reps.js).
--
-- ---------------------------------------------------------------------------
-- Why this view was rewritten (2026-08-13)
-- ---------------------------------------------------------------------------
-- The original version was driven FROM vw_FS_Customers and required each rep to
-- have at least one customer invoiced in the last 35 days:
--
--     FROM dbo.vw_FS_Customers cust
--     ...
--     AND EXISTS (SELECT 1 FROM dbo.vw_FS_Invoices i
--                 WHERE i.customer_code = cust.code
--                   AND i.invoice_date >= ...DATEADD(day, -35, GETDATE())...)
--
-- Two problems with that for RouteOne's purpose:
--
-- 1. A rep with no recently-invoiced customers simply does not exist as far as
--    this view is concerned - so they never get a login. That is backwards for
--    onboarding: a NEW rep has no invoiced customers yet, precisely because they
--    have no login and cannot work. Rep 81 (James) hit exactly this.
--
-- 2. The SalSalesperson join matched on Salesperson only, NOT on Branch:
--
--        LEFT JOIN dbo.SalSalesperson s ON RTRIM(s.Salesperson) = cust.rep_code
--
--    A rep code is not unique across branches - the same code is a different
--    person under a different branch. So a code spanning branches matched every
--    SalSalesperson row for that code, and MAX(RTRIM(s.Name)) then picked one
--    ALPHABETICALLY. Code 81 returned "MEL" over "James" purely because M > J.
--
-- This version drives FROM SalSalesperson (the actual master list of reps) and
-- joins customers on branch + code, so:
--   - every rep appears, including brand-new ones (active_customers = 0)
--   - rep_name is the correct name for that specific branch, not an alphabetical
--     accident
--   - active_customers keeps its original meaning (customers invoiced in the
--     last 35 days) because the EXISTS moved into the LEFT JOIN's ON clause,
--     where it filters what gets COUNTed without dropping the rep's row
--
-- RouteOne's own EXCLUDE_CODES list (server/import-reps.js) filters out house
-- accounts, export desks and similar non-people, so this view deliberately does
-- NOT try to guess which codes are real field reps.

-- ============================================================
-- BEFORE YOU RUN THIS: keep a copy of the current definition so you can roll
-- back. It is reproduced at the bottom of this file, but take a fresh copy in
-- case the live view has drifted from what is recorded here:
--
--     SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.vw_FS_Reps'));
--
-- This script is safe to re-run. Dropping and recreating a view does not touch
-- any data - it only affects anything querying the view WHILE it is dropped
-- (a few milliseconds). RouteOne only reads it when import-reps.js is run by
-- hand, so there is no scheduled job to collide with.
-- ============================================================

USE [SysproCompany001];
GO

-- These must be ON for the view to be created and behave consistently with
-- NULLs. They are captured with the view at creation time.
SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

-- OBJECT_ID form rather than DROP VIEW IF EXISTS, which needs SQL Server 2016+.
IF OBJECT_ID('dbo.vw_FS_Reps', 'V') IS NOT NULL
    DROP VIEW dbo.vw_FS_Reps;
GO

CREATE VIEW dbo.vw_FS_Reps AS
SELECT
    RTRIM(s.Salesperson) AS rep_code,
    RTRIM(s.Name)        AS rep_name,
    RTRIM(s.Branch)      AS branch,
    COUNT(cust.code)     AS active_customers
FROM dbo.SalSalesperson s WITH (NOLOCK)
LEFT JOIN dbo.vw_FS_Customers cust
       ON cust.rep_code        = RTRIM(s.Salesperson)
      AND cust.warehouse_code  = RTRIM(s.Branch)
      AND EXISTS (
            SELECT 1
            FROM dbo.vw_FS_Invoices i
            WHERE i.customer_code = cust.code
              AND i.invoice_date >= CONVERT(char(10), DATEADD(day, -35, GETDATE()), 23)
          )
WHERE RTRIM(s.Salesperson) <> ''
GROUP BY RTRIM(s.Salesperson), RTRIM(s.Name), RTRIM(s.Branch);
GO

-- Grant back whatever the RouteOne read-only login needs. Dropping a view drops
-- its permissions with it, so if the sync account was granted SELECT explicitly
-- (rather than via a role or schema-level grant) it MUST be re-granted here or
-- import-reps.js will start failing with a permissions error.
-- Replace the principal name with the account RouteOne actually connects as.
--
-- GRANT SELECT ON dbo.vw_FS_Reps TO [routeone_read];
-- GO

-- ============================================================
-- Validation - run these after creating the view above
-- ============================================================

-- 1. James should now appear. Check the branch and the name are both right.
SELECT * FROM dbo.vw_FS_Reps WHERE rep_code = '81';

-- 2. What the old view would have hidden: reps with no recent invoiced
--    customers. These are the people who could never get a RouteOne login.
SELECT * FROM dbo.vw_FS_Reps
WHERE active_customers = 0
ORDER BY rep_code;

-- 3. Codes that span multiple branches - each should now carry that branch's
--    own name rather than one name repeated across all of them.
SELECT rep_code, COUNT(*) AS branches, MIN(rep_name) AS a, MAX(rep_name) AS b
FROM dbo.vw_FS_Reps
GROUP BY rep_code
HAVING COUNT(*) > 1
ORDER BY rep_code;

-- 4a. Sanity: total rep/branch rows, and how many are genuinely active.
SELECT COUNT(*) AS rep_branch_rows,
       SUM(CASE WHEN active_customers > 0 THEN 1 ELSE 0 END) AS with_recent_customers
FROM dbo.vw_FS_Reps;

-- 4b. Nobody should have lost their name. A blank rep_name means the
--     SalSalesperson row itself has no Name - worth fixing at source.
SELECT * FROM dbo.vw_FS_Reps WHERE rep_name IS NULL OR rep_name = '';


-- ============================================================
-- ROLLBACK - the original definition, as read from the live database
-- on 2026-08-13 via OBJECT_DEFINITION(OBJECT_ID('dbo.vw_FS_Reps')).
--
-- Run this block to put the old view back exactly as it was. Note it will
-- reintroduce both known issues: reps with no customer invoiced in the last
-- 35 days disappear entirely, and a rep code spanning several branches gets
-- whichever name sorts highest (which is how James showed up as "MEL").
-- ============================================================
-- Line comments (not a /* */ block) on purpose: SSMS splits batches on GO even
-- when it appears inside a block comment, which throws "Incorrect syntax near
-- 'GO'". Uncomment the lines below to roll back.
--
-- USE [SysproCompany001];
-- GO
--
-- IF OBJECT_ID('dbo.vw_FS_Reps', 'V') IS NOT NULL
--     DROP VIEW dbo.vw_FS_Reps;
-- GO
--
-- CREATE VIEW dbo.vw_FS_Reps AS
-- SELECT
--     cust.rep_code,
--     MAX(RTRIM(s.Name))  AS rep_name,
--     cust.warehouse_code AS branch,
--     COUNT(*)            AS active_customers
-- FROM dbo.vw_FS_Customers cust
-- LEFT JOIN dbo.SalSalesperson s
--        ON RTRIM(s.Salesperson) = cust.rep_code
-- WHERE cust.rep_code IS NOT NULL
--   AND cust.rep_code <> ''
--   AND EXISTS (
--         SELECT 1
--         FROM dbo.vw_FS_Invoices i
--         WHERE i.customer_code = cust.code
--           AND i.invoice_date >= CONVERT(char(10), DATEADD(day, -35, GETDATE()), 23)
--       )
-- GROUP BY cust.rep_code, cust.warehouse_code;
-- GO

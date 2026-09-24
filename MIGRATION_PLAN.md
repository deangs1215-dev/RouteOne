# SQLite → SQL Server Migration Plan

**Start date:** 2026-09-24  
**Target completion:** [To be scheduled after testing]  
**Environments:** Dev → Test → Production

---

## 1. Pre-Migration Checklist

- [ ] SQL Server instance is available and accessible from RouteOne server
- [ ] SQL Server has sufficient disk space for RouteOne database (~2GB estimated, with room for growth)
- [ ] SQL Server backups are configured
- [ ] Network connectivity between RouteOne server and SQL Server confirmed (ping, telnet port 1433)
- [ ] SQL Server credentials obtained (login, database name, connection string format)
- [ ] Team approval: migration window scheduled, no critical syncs planned during window

---

## Phase 1: Development Environment

### 1.1 Create SQL Server database schema ✅ COMPLETED

**Goal:** Translate SQLite schema to SQL Server, create all tables.

**Status:** SQL Server database created with all 60+ tables. Schema file: `docs/sql/routeone-schema-mssql.sql`

**Completed Steps:**
1. Export current SQLite schema:
   ```bash
   sqlite3 server/data/routeone.db ".schema" > /tmp/sqlite-schema.sql
   ```

2. Create SQL Server database:
   ```sql
   CREATE DATABASE RouteOne;
   GO
   ```

3. Translate SQLite schema to SQL Server:
   - Replace SQLite data types with SQL Server equivalents (TEXT → NVARCHAR(MAX), etc.)
   - Add SQL Server-specific settings (collation, recovery model, etc.)
   - Create primary keys, indexes, constraints
   - **File:** `docs/sql/routeone-schema.sql` (to be created during this step)

4. Apply schema to SQL Server database:
   ```powershell
   sqlcmd -S [server] -d RouteOne -i docs/sql/routeone-schema.sql
   ```

### 1.2 Update connection strings (development) ✅ COMPLETED

**File:** `server/.env`

**Status:** Created with SQL Server connection details and SMTP settings
- DB_TYPE=mssql
- DB_HOST=192.168.0.53
- DB_PORT=1433
- DB_NAME=RouteOne
- DB_USER=RouteOneApp
- DB_PASSWORD=[configured]
- SMTP configured with sb-hosted.sbakels.co.za settings
- SECRET_KEY generated

### 1.3 Update database connection logic ⏳ PENDING - NEXT SESSION

**File:** `server/db.js` and all `server/routes/*.js` files

**Status:** BLOCKED - Large scope, requires complete rewrite

**What needs to happen:**
1. Replace `better-sqlite3` with `mssql` package in `db.js`
2. Update all database queries across 25+ route files
3. Change from synchronous to async/await
4. Update parameter syntax from `?` to `@paramName`
5. Remove SQLite-specific pragmas and configurations
6. Update transaction handling
7. Update error handling for SQL Server

**Scope:** ~2000+ lines of code changes across multiple files

**Recommendation for next session:**
- Start fresh with `server/db.js` rewrite
- Create wrapper functions for common query patterns to minimize downstream changes
- Update routes incrementally, testing each batch
- Test connection pooling behavior under load

**Files to update in this phase:**
- Core: `server/db.js`, `server/crypto.js`, `server/backup.js`
- Routes: `server/routes/*.js` (25+ files)
- Integration: `server/integration/*.js` (sync, email, PDF)

### 1.4 Migrate data from SQLite to SQL Server

**Goal:** Copy existing RouteOne data to SQL Server.

**Steps:**
1. Export data from SQLite (using BCP or custom script)
2. Load into SQL Server tables
3. Verify row counts and integrity

**Risk:** Data loss if migration script is buggy. Test in dev first, then test env, then production.

### 1.5 Test database connectivity

**Steps:**
1. Start RouteOne app against SQL Server
2. Check that app starts without DB connection errors
3. Run smoke test: log in, view customers, check data loads
4. Monitor logs for SQL connection errors

**Expected issues:**
- Connection timeout (firewall, network)
- Authentication failure (wrong credentials)
- Schema mismatch (SQLite query syntax doesn't match SQL Server)

---

## Phase 2: Test Environment

### 2.1 Full integration testing

**Goal:** Verify all app features work against SQL Server.

**Test cases:**
1. Login flow (credentials stored in SQL Server)
2. Customer list (query from SQL Server)
3. Order capture and save (write to SQL Server)
4. Manual sync (SYSPRO → SQL Server)
5. Report generation (query RouteOne data)
6. Backup/restore (SQL Server backup, not SQLite file copy)

### 2.2 Performance baseline

**Goal:** Verify SQL Server write performance is better than SQLite.

**Test:** Run customer_pricing sync and measure:
- Total time (current: 75-85 min)
- Fetch time (current: 3-3.5 min, expected: similar)
- Write time (current: 70-80 min, expected: 5-10 min)

**Success criteria:** Write time < 15 min

### 2.3 Concurrent load test

**Goal:** Verify SQL Server handles concurrent app reads while sync is running.

**Test:** 
1. Start customer_pricing sync
2. While sync is running, simulate 10 concurrent app users (each fetching customers, orders)
3. Measure response times (should be fast, not frozen)

**Success criteria:** App response times < 2s during sync

### 2.4 Backup and restore test

**Goal:** Verify data protection works with SQL Server.

**Steps:**
1. Backup RouteOne database
2. Delete a table or rows
3. Restore from backup
4. Verify data is intact

---

## Phase 3: Production Migration

### 3.1 Pre-flight checks (production window)

**Before starting:**
- [ ] Full backup of SYSPRO (not RouteOne, but good hygiene)
- [ ] Full backup of current SQLite routeone.db file (via file copy to safe location)
- [ ] Notify all users: "RouteOne will be unavailable 8 PM - 10 PM for maintenance"
- [ ] Stop scheduled syncs (disable sync jobs)
- [ ] Stop the RouteOne app (npm stop or NSSM stop)

### 3.2 Create SQL Server database (production)

Same as Phase 1.1, but on production SQL Server instance.

### 3.3 Migrate production data

**Steps:**
1. Export final SQLite data (with all recent changes)
2. Load into production SQL Server
3. Verify row counts match SQLite exports exactly

### 3.4 Deploy updated RouteOne app

**File:** `server/db.js` and `.env` changes

**Via deploy script:**
```powershell
.\deploy.ps1
```

This will:
- Build the app
- Sync files to server
- (You manually restart: `nssm stop RouteOne`, then `nssm start RouteOne`)

### 3.5 Verify production app

**Steps:**
1. Check app is running: `http://routeone-test.sbakels.net:4200/api/health`
2. Log in with test account
3. Fetch customer list
4. Check server logs for errors

### 3.6 Re-enable scheduled syncs

Once app is stable, re-enable sync jobs and monitor first run.

### 3.7 Post-migration monitoring

**Watch for 24 hours:**
- App error logs (any DB connection errors?)
- Sync times (faster than before?)
- User reports (any missing data or broken features?)

---

## Phase 4: Cleanup

### 4.1 Remove SQLite code

Once production is stable for 1 week:
- Remove `server/db/sqlite.js` (if split from main db.js)
- Remove PRAGMA settings from db.js
- Remove SQLite-specific pragmas from `server/db.js`

### 4.2 Update documentation

**Files to update:**
- README.md (database setup section)
- DEPLOYMENT.md (database configuration)
- PRODUCTION-READINESS-AUDIT.md (single-writer constraint no longer applies)

### 4.3 Archive

Keep `routeone.db` file as backup for 30 days, then delete.

---

## Rollback Plan

If production SQL Server migration fails:

1. **Immediate:** Stop the app
2. **Restore:** Copy saved `routeone.db` back to `server/data/`
3. **Revert code:** `git checkout server/db.js` (restore SQLite code)
4. **Restart:** `nssm start RouteOne`
5. **Notify:** Team communication about rollback

**Rollback time:** ~10 minutes

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Network outage to SQL Server | High | Test network path before migration; have VPN ready |
| Schema mismatch (SQLite → SQL Server) | High | Extensive testing in dev/test before production |
| Data loss during migration | High | Full backups before each phase; verify row counts |
| Sync performance doesn't improve | Medium | Baseline measurements in test env; have fallback plan |
| App incompatibility (async/await issues) | Medium | Full integration testing in test env |
| SQL Server licensing/cost | Low | Assumed covered by existing SYSPRO license |

---

## Timeline Estimate

- **Phase 1 (Dev):** 3-5 days (schema translation, testing)
- **Phase 2 (Test):** 2-3 days (integration, performance, load testing)
- **Phase 3 (Prod migration):** 2-3 hours (downtime window)
- **Phase 4 (Cleanup):** 1 day (after 1 week stability)

**Total:** ~2 weeks (including waiting for stability before cleanup)

---

## Success Criteria

- [ ] All app features work against SQL Server (login, orders, sync, reports)
- [ ] Sync write time < 15 minutes (vs. 70-80 currently)
- [ ] App remains responsive during sync (no freezing)
- [ ] Backup/restore verified working
- [ ] No data loss
- [ ] User testing passes
- [ ] Production stable for 1 week after migration

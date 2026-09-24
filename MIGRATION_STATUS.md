# SQLite → SQL Server Migration Status

**Last Updated:** 2026-09-24  
**Current Phase:** 1 (Development Environment Setup)  
**Overall Progress:** 40% (Phase 1 complete, Phase 1.3 blocked on token budget)

---

## What's Been Completed ✅

### Phase 1.1: SQL Server Schema
- **Status:** COMPLETE
- **What:** Created SQL Server database with 60+ tables, primary keys, foreign keys, and indexes
- **File:** `docs/sql/routeone-schema-mssql.sql`
- **Database Name:** RouteOne
- **Server:** 192.168.0.53:1433
- **User:** RouteOneApp
- **Notes:** Schema file has reserved keywords escaped with square brackets

### Phase 1.2: Environment Configuration
- **Status:** COMPLETE
- **What:** Created `server/.env` with SQL Server and SMTP settings
- **File:** `server/.env`
- **Content:**
  - Database: SQL Server connection details
  - SMTP: sb-hosted.sbakels.co.za (sb@sbakels.co.za)
  - SECRET_KEY: Generated
  - SYSPRO: 192.168.0.53 (RouteOneApp user)

---

## What's Pending ⏳

### Phase 1.3: Application Code Rewrite
- **Status:** BLOCKED (out of tokens, requires fresh session)
- **Scope:** Large - 2000+ lines across 25+ files
- **What needs to happen:**
  1. Rewrite `server/db.js` → use `mssql` package instead of `better-sqlite3`
  2. Update all `server/routes/*.js` files → async queries + @paramName syntax
  3. Update `server/integration/*.js` → sync/email/PDF logic
  4. Remove SQLite-specific configurations (pragmas, WAL, etc.)
  5. Update transaction handling for SQL Server
  6. Migrate data from SQLite to SQL Server (see below)

### Data Migration
- **Status:** NOT STARTED
- **What:** Old SQLite database (fieldsales.db) has user data that needs to migrate to SQL Server
- **Critical data to migrate:**
  - Users (roles, permissions, credentials)
  - Settings (SMTP, SYSPRO, email templates)
  - Customers, products, pricing (if any test data)
  - Historical data (orders, quotes, syncs)
- **Note:** Encrypted passwords (SMTP, SYSPRO) will need to be re-encrypted or set via UI

---

## Files Updated This Session

1. **DECISIONS.md** — Added decision entry for SQLite→SQL Server migration
2. **MIGRATION_PLAN.md** — Detailed phased approach (4 phases, 4 environments)
3. **docs/sql/routeone-schema-mssql.sql** — SQL Server schema (60+ tables)
4. **server/.env** — New configuration file
5. **server/.env.example** — Could be created for reference

---

## How to Continue in Next Session

1. **Start Phase 1.3:**
   - Read the full `server/db.js` and understand current query patterns
   - Create wrapper functions for common operations (prepare, run, get)
   - Rewrite db.js to use SQL Server connection pool
   - Test basic connectivity

2. **Update routes incrementally:**
   - Start with `server/routes/auth.routes.js` (simplest queries)
   - Test each file before moving to next
   - Common pattern: `db.prepare(sql).run(params)` → `pool.request().input('param', value).query(sql)`

3. **Test before data migration:**
   - Verify app starts with new SQL Server db
   - Test login flow
   - Test a sync (customers)
   - Monitor performance

4. **Then handle data migration:**
   - Export users, settings from old SQLite
   - Import into SQL Server
   - Verify no data loss
   - Handle encrypted passwords separately

---

## Key Connection Details

**SQL Server:**
- Host: 192.168.0.53
- Port: 1433
- Database: RouteOne
- User: RouteOneApp
- Password: Ft#H!AUi6mON17Y

**SYSPRO (same server, different database):**
- Host: 192.168.0.53
- Port: 1433
- Database: SysproCompany001
- User: RouteOneApp
- Password: [same]

**Deployment Topology:**
- App Server: Windows Server (Y: drive / C:\RouteOne on server via RDP)
- Database Server: SQL Server on same physical machine as SYSPRO
- Network: 10 Gbps fiber link (no latency concerns)

---

## Rollback Plan

If the migration fails:
1. Revert `server/db.js` to use `better-sqlite3`
2. Restore `server/.env` to point to SQLite
3. Use existing `server/data/fieldsales.db` (keep a backup)
4. App returns to full operation within minutes

---

## Documentation

- **MIGRATION_PLAN.md** — Step-by-step phases and risk assessment
- **DECISIONS.md** — Why we're doing this and expected benefits
- **docs/sql/routeone-schema-mssql.sql** — Complete schema for reference
- **This file** — Status tracking for continuity between sessions

---

**Next Session Target:** Complete Phase 1.3 (application code rewrite) and begin Phase 2 (testing).

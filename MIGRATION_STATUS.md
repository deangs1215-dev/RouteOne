# SQLite → SQL Server Migration Status

**Last updated:** 2026-09-24
**Branch:** `mssql-migration`
**Where it stands:** the application code is migrated and the full integration suite passes on SQL Server (`RouteOne_Test`). Cutover to production has not been done.

---

## How the migration was done

The app talks to the database through one async facade, `server/dbx.js`, with two backends chosen by `DB_BACKEND` (`sqlite` default, or `mssql`). Route code is written once, with SQLite-style SQL, and runs on both.

| File | Role |
|---|---|
| `server/dbx.js` | `prepare().get/all/run`, `transaction`, `upsert`, `bulkUpsert` (SQL Server bulk load). SQL Server backend translates SQL and returns datetimes as SQLite-format text. |
| `server/sqlDialect.js` | Translates the SQLite-only forms the code uses (`date('now',…)`, `datetime`, `strftime`, `julianday`, `LIMIT n`) to T-SQL. Throws on anything else. |
| `server/dbh.js` | Async helpers (`getSetting`, `nextNumber`, `logActivity`, pricing, `mapLimit`, `repTargetLookup`). |
| `server/dbxShadow.js` | Dev aid: `DBX_SHADOW_LOG=file npm test` binds every SQL statement the tests run against the real SQL Server schema (without executing) and logs errors. |
| `server/migrate-to-mssql.js` | Data migration with audit mode (below). |

`DB_BACKEND=mssql` runs with no SQLite file at all (`db` is `null`). `DB_TYPE` in `server/.env` is unrelated and unused.

## Tests

```
npm test            # SQLite (default): 68 pass, 1 skipped
npm run test:mssql  # everything that can run on SQL Server, against RouteOne_Test (~5 min): 46 pass, 1 skipped
```

`test:mssql` runs, in order: the API integration suite (incl. a crawl of every `GET` route and 40 concurrent reps), the admin/seed scripts, the sync engine (all entities, plus a 60k-row bulk `customer_pricing` load and re-sync), `dbh` helpers, email builders, and the schedulers/digests/backup. Each wipes `RouteOne_Test` first and refuses to run against any other database.

Other checks:

```
DBX_SHADOW_LOG=shadow.log npm test                       # binds every SQL statement the tests execute against the SQL Server schema; read shadow.log
node --env-file=server/.env server/check-sql-mssql.mjs   # static: binds all ~390 SQL strings in the source (incl. INSERT/UPDATE/DELETE) - read each rejection, some are placeholder artefacts
```

`server/tests/async-lint.test.js` fails on any un-awaited `dbx` query. `dbx` and `sqlDialect` unit tests are SQLite/pure and do not run on SQL Server.

## Verified on SQL Server (RouteOne_Test)

- Every suite above (46 tests), including 40 concurrent reps, the sync engine, digests, schedulers and all admin scripts.
- Static bind of all ~390 SQL statements in the source: no real T-SQL problems (the 13 rejections are placeholder artefacts or SQLite-only branches guarded by dialect checks).
- Every `GET` route as admin and as rep at real scale (13,890 customers, 95 users): 0 server errors, slowest 3s (`/kpis`).
- Data migration of a real backup: all 28 tables, every row count matches, all foreign keys validated.
- `customer_pricing` bulk load: 500k rows in 27s (initial), 17s (unchanged re-sync).

## Not yet verified / not done

- **Production-volume behaviour** and the real SYSPRO sync on SQL Server (only a 500k-row scratch test).
- **Two throwaway scripts stay SQLite-only:** `set-lizl-budgets.cjs` and `set-rep-budgets.cjs` open the SQLite file directly (their own headers say "delete when done").
- **`reset-password.js`:** the password prompt needs a real terminal, so only its lookup path is tested; it does not bump `token_version`, so an existing session survives a reset (the admin UI reset does invalidate sessions).
- **`cleanup-demo-data.js`** was already broken before this migration (it re-created roles it never deleted); it now clears `roles` and `territories` too.
- **Timers:** the schedulers' `setInterval` ticks and real SMTP/Graph delivery are not exercised (jobs are called directly; email is logged, not sent).
- **Backups:** on SQL Server the app backs up `uploads` only. The database must be backed up by SQL Server (scheduled `BACKUP DATABASE`). Restore in the app is refused on SQL Server.
- **Live `RouteOne` database** was rebuilt (empty) from the current schema script on 2026-09-24: 44 tables, no `REAL` columns, UTC defaults, `users.documents_last_viewed_at` present. It is ready for the real migration.

## Cutover runbook (do in a maintenance window; rehearse on a copy first)

1. **Back up** the production `fieldsales.db` (file copy) and note the current app version.
2. **Confirm the target** is empty and built from the current `docs/sql/routeone-schema-mssql.sql` (the live `RouteOne` database already is). `RouteOneApp` needs `db_datareader`, `db_datawriter`, `db_ddladmin`.
3. **Stop the app and schedulers** (`nssm stop RouteOne`).
4. **Audit** the production database - read-only, changes nothing:
   `node --env-file=server/.env server/migrate-to-mssql.js --source <fieldsales.db> --target RouteOne --audit`
   Fix anything it reports (column-length overflows, non-numeric text in numeric columns, bad dates) before continuing.
5. **Migrate**: same command without `--audit` (add `--wipe` only if the target already has data). It refuses to run if the audit found problems unless `--force`.
   It skips `syspro_customer_pricing` (rebuilt by the sync); use `--include-pricing` to copy it anyway.
6. **Check the output**: every table `✔`, and no "unvalidated foreign keys" line.
7. **Deploy** this branch with `DB_BACKEND=mssql` and `DB_*` set in the server's `.env` (quote any password containing `#`).
   **Keep `SECRET_KEY` unchanged.** SMTP and SYSPRO passwords in the `settings` table are encrypted with it; a different key leaves them undecryptable ("Failed to decrypt secret").
8. **Start the app**, log in, load customers/orders/quotes.
9. **Run the SYSPRO syncs** from Integration settings; confirm `customer_pricing` completes (expect minutes, not hours).
10. **Re-enable schedulers**; watch logs for 24 hours.

**Rollback:** stop the app, set `DB_BACKEND=sqlite` (or remove it), restore the saved `fieldsales.db`, start the app. The SQLite file is never written to by the migration tool.

Rehearsal: run steps 2-6 against `RouteOne_Test` using a copy of production, then the API suite above.

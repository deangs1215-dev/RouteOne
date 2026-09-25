# Deploying RouteOne on SQL Server

Use with the runbook in `MIGRATION_STATUS.md`. Files here:

| File | Purpose |
|---|---|
| `.env.sqlserver.example` | The settings the server's `server\.env` needs for SQL Server. |
| `preflight.js` | Read-only check: settings, connection, permissions, schema version, data present, an admin exists. |

## Steps on the server

1. Copy the new `server\.env` values from `.env.sqlserver.example`. `deploy.bat` never overwrites `server\.env`, so this is a manual, one-time edit. Keep `SECRET_KEY` as is.
2. Stop the service: `nssm stop RouteOne`.
3. Migrate the data (audit first): `node --env-file=server\.env server\migrate-to-mssql.js --source server\data\fieldsales.db --target RouteOne --audit`, then the same without `--audit`.
4. Run `node --env-file=server\.env server\deploy\preflight.js`. It must end with "all checks passed".
5. Start the service: `nssm start RouteOne`, then open `/api/health`.
6. In Settings > Integration run the SYSPRO syncs, then re-enable schedules.

## Rollback

Set `DB_BACKEND=sqlite` (or delete the line) in `server\.env` and restart. `server\data\fieldsales.db` is never modified by the migration; if the app ran on SQL Server for a while, data entered since is only in SQL Server.

## Operational differences on SQL Server

- The app backs up `uploads` only; schedule `BACKUP DATABASE RouteOne` on the SQL Server itself. In-app restore is disabled.
- `server\data\` (the SQLite file) is unused; keep it until you are sure you will not roll back.
- Health: `/api/health` returns 503 if the database is unreachable.

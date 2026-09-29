// Read-only pre-deployment check for a SQL Server cutover. Changes nothing.
//   node --env-file=server/.env server/deploy/preflight.js
// Exit code 0 = safe to start the app on SQL Server, 1 = fix what is listed first.
import sql from 'mssql';

const e = process.env;
const results = [];
const check = (ok, label, detail = '') => { results.push(ok); console.log(`${ok ? '  ok ' : ' FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`); };

console.log('RouteOne SQL Server preflight\n');
check((e.DB_BACKEND || '').toLowerCase() === 'mssql', 'DB_BACKEND=mssql', `is "${e.DB_BACKEND || ''}"`);
for (const k of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'SECRET_KEY']) check(Boolean(e[k]), `${k} is set`);
check(!e.DB_PASSWORD || e.DB_PASSWORD.length > 3, 'DB_PASSWORD looks complete', 'a "#" in an unquoted value truncates it');

let pool;
try {
  pool = await new sql.ConnectionPool({
    server: e.DB_HOST, port: Number(e.DB_PORT) || 1433, database: e.DB_NAME, user: e.DB_USER, password: e.DB_PASSWORD,
    options: { encrypt: e.DB_ENCRYPT === '1', trustServerCertificate: true }
  }).connect();
  check(true, `connected to ${e.DB_HOST} / ${e.DB_NAME} as ${e.DB_USER}`);
} catch (err) {
  check(false, 'connect', err.message);
  process.exit(1);
}
const q = async (text) => (await pool.request().query(text)).recordset;

const perms = (await q(`SELECT IS_MEMBER('db_datareader') AS r, IS_MEMBER('db_datawriter') AS w, IS_MEMBER('db_ddladmin') AS d`))[0];
check(perms.r === 1 && perms.w === 1, 'read/write access', 'needs db_datareader + db_datawriter');
check(perms.d === 1, 'db_ddladmin (schema changes)', 'only needed while the app still runs schema migrations');

const tables = (await q(`SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`))[0].n;
check(tables === 44, 'schema present', `${tables} tables (expected 44 - load docs/sql/routeone-schema-mssql.sql)`);
const real = (await q(`SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE DATA_TYPE = 'real'`))[0].n;
check(real === 0, 'schema is the current version', real ? `${real} REAL columns: this is the old schema, rebuild it` : '');

const rows = Number((await q(`SELECT SUM(p.rows) AS n FROM sys.tables t JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)`))[0].n) || 0;
console.log(`  info  ${rows} rows in the database ${rows ? '(data already migrated)' : '(empty - run migrate-to-mssql.js before starting the app)'}`);
if (rows) {
  const users = Number((await q('SELECT COUNT(*) AS n FROM users'))[0].n);
  const admins = Number((await q(`SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'admin' AND u.active = 1`))[0].n);
  check(users > 0 && admins > 0, 'has an active admin to log in with', `${users} users, ${admins} active admins`);
}
await pool.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${failed ? `${failed} problem(s) - do not start the app yet` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);

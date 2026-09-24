// Dev/test aid, off unless DBX_SHADOW_LOG is set. While the app or tests run on
// SQLite, every distinct SQL statement is also sent to SQL Server's
// sp_describe_first_result_set, which parses and binds it against the real
// RouteOne schema WITHOUT executing it. Statements SQL Server rejects (columns
// missing from GROUP BY, aliases in GROUP BY/HAVING, unknown columns, ...) are
// appended to the log file. That finds T-SQL incompatibilities across the whole
// test suite before the backend is switched.
//
//   DBX_SHADOW_LOG=shadow.log npm test     then read shadow.log
//
// Reads DB_* from server/.env. Read-only: nothing is executed or written.
import fs from 'fs';
import { fileURLToPath } from 'url';
import { sqliteToTsql } from './sqlDialect.js';
import { toNamedParams } from './dbx.js';

const logPath = process.env.DBX_SHADOW_LOG;
const seen = new Set();
let poolPromise = null;

async function getPool() {
  poolPromise ??= (async () => {
    const dotenv = await import('dotenv');
    const env = dotenv.parse(fs.readFileSync(fileURLToPath(new URL('./.env', import.meta.url))));
    const { default: sql } = await import('mssql');
    const pool = await new sql.ConnectionPool({
      server: env.DB_HOST, port: Number(env.DB_PORT) || 1433, database: env.DB_NAME,
      user: env.DB_USER, password: env.DB_PASSWORD,
      pool: { max: 2 }, options: { encrypt: false, trustServerCertificate: true }
    }).connect();
    return { pool, sql };
  })();
  return poolPromise;
}

// An open connection would keep a short-lived process (seed.js, a script) alive
// forever, so the pool is closed after a quiet spell and reopened on demand.
let idleTimer = null;
function scheduleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = poolPromise;
    poolPromise = null;
    try { (await p)?.pool.close(); } catch { /* nothing to close */ }
  }, 1500);
}

let queue = Promise.resolve();

export function shadowValidate(rawSql) {
  if (!logPath || seen.has(rawSql)) return;
  seen.add(rawSql);
  queue = queue.then(async () => {
    let tsql;
    try {
      const { sql: q, count } = toNamedParams(sqliteToTsql(rawSql));
      tsql = { q, count };
    } catch (e) {
      fs.appendFileSync(logPath, `TRANSLATE  ${e.message}\n  ${rawSql.replace(/\s+/g, ' ').slice(0, 300)}\n\n`);
      return;
    }
    try {
      const { pool } = await getPool();
      const params = Array.from({ length: tsql.count }, (_, i) => `@p${i} nvarchar(max)`).join(', ');
      await pool.request()
        .input('t', tsql.q).input('p', params || null)
        .query('EXEC sp_describe_first_result_set @tsql = @t, @params = @p');
    } catch (e) {
      // Type conflicts from declaring every parameter nvarchar are noise; real
      // binding errors (unknown column, GROUP BY, syntax) are what we want.
      if (/Implicit conversion|Operand type clash|conflicting|Error converting/i.test(e.message)) return;
      // The useful detail (which column, which clause) is in the preceding errors.
      const detail = (e.precedingErrors ?? []).map((x) => x.message).filter((m) => m !== e.message).join(' | ');
      fs.appendFileSync(logPath, `T-SQL      ${detail || e.message}\n  ${rawSql.replace(/\s+/g, ' ').slice(0, 300)}\n\n`);
    }
  }).then(scheduleClose, scheduleClose);
}

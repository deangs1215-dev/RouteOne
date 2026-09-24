// One-off data migration: copies a RouteOne SQLite database into a SQL Server
// database whose schema was created from docs/sql/routeone-schema-mssql.sql.
//
//   node --env-file=server/.env server/migrate-to-mssql.js \
//        --source server/data/fieldsales.db --target RouteOne_Test --audit
//
//   --audit          read-only: report problems that would break the copy, write nothing
//   --wipe           empty the target tables first (required if they hold data)
//   --skip a,b       extra tables to leave out
//   --include-pricing  also copy syspro_customer_pricing (default: skipped - it is
//                    derived data, rebuilt from SYSPRO by the bulk sync in minutes)
//
// The source file is opened read-only. Nothing is ever written to it.
import fs from 'node:fs';
import Database from 'better-sqlite3';
import sql from 'mssql';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const sourcePath = opt('source');
const targetDb = opt('target');
const AUDIT = opt('audit') === true;
const WIPE = opt('wipe') === true;
const skip = new Set(String(opt('skip') || '').split(',').filter(Boolean));
if (opt('include-pricing') !== true) skip.add('syspro_customer_pricing');
if (!sourcePath || !targetDb || targetDb === true) {
  console.error('usage: migrate-to-mssql.js --source <sqlite file> --target <database name> [--audit] [--wipe] [--skip a,b] [--include-pricing]');
  process.exit(2);
}
if (!fs.existsSync(sourcePath)) { console.error(`source not found: ${sourcePath}`); process.exit(2); }

const NUMERIC = new Set(['int', 'bigint', 'smallint', 'tinyint', 'float', 'real', 'decimal', 'numeric', 'bit']);
const DATETIME = new Set(['datetime', 'datetime2', 'smalldatetime', 'date']);
const TEXT = new Set(['nvarchar', 'varchar', 'nchar', 'char', 'ntext', 'text']);
const q = (n) => `[${n}]`;

const src = new Database(sourcePath, { readonly: true, fileMustExist: true });
const e = process.env;
const pool = await new sql.ConnectionPool({
  server: e.DB_HOST, port: Number(e.DB_PORT) || 1433, database: targetDb, user: e.DB_USER, password: e.DB_PASSWORD,
  requestTimeout: 600000, pool: { max: 4 }, options: { encrypt: false, trustServerCertificate: true }
}).connect();
const run = async (text, params = []) => {
  const r = pool.request();
  params.forEach((v, i) => r.input(`p${i}`, v));
  return r.query(text);
};

// --- introspect target ------------------------------------------------------
const cols = (await run(`
  SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS name, c.DATA_TYPE AS type, c.CHARACTER_MAXIMUM_LENGTH AS len,
         c.IS_NULLABLE AS nullable, c.COLUMN_DEFAULT AS dflt,
         COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') AS is_identity
  FROM INFORMATION_SCHEMA.COLUMNS c
  JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
  ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`)).recordset;
const targetTables = new Map();
for (const c of cols) {
  if (!targetTables.has(c.t)) targetTables.set(c.t, new Map());
  targetTables.get(c.t).set(c.name, c);
}
const sourceTables = src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

console.log(`source: ${sourcePath}\ntarget: ${targetDb} (${targetTables.size} tables)   mode: ${AUDIT ? 'AUDIT (read-only)' : WIPE ? 'MIGRATE + WIPE' : 'MIGRATE'}`);
const notInTarget = sourceTables.filter((t) => !targetTables.has(t));
const notInSource = [...targetTables.keys()].filter((t) => !sourceTables.includes(t));
if (notInTarget.length) console.log(`! in SQLite but not in target (data would be lost): ${notInTarget.join(', ')}`);
if (notInSource.length) console.log(`  in target only (left empty): ${notInSource.join(', ')}`);

// --- per-table plan + audit -------------------------------------------------
const plan = [];
let problems = 0;
const report = (msg) => { problems += 1; console.log(`  ✖ ${msg}`); };

for (const table of sourceTables) {
  if (!targetTables.has(table) || skip.has(table)) continue;
  const tcols = targetTables.get(table);
  const scols = src.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  const shared = scols.filter((c) => tcols.has(c));
  const dropped = scols.filter((c) => !tcols.has(c));
  const rows = src.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  console.log(`\n${table}: ${rows} rows`);
  if (dropped.length) report(`source columns with no target column (data dropped): ${dropped.join(', ')}`);
  for (const [name, c] of tcols) {
    if (!shared.includes(name) && c.nullable === 'NO' && c.dflt == null && !c.is_identity) report(`target column ${name} is NOT NULL with no default and no source column`);
  }
  if (rows === 0) { plan.push({ table, shared, rows, tcols }); continue; }
  for (const name of shared) {
    const c = tcols.get(name);
    const col = `"${name}"`;
    if (TEXT.has(c.type) && c.len > 0) {
      const max = src.prepare(`SELECT MAX(LENGTH(${col})) AS m FROM "${table}"`).get().m;
      if (max > c.len) {
        const n = src.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE LENGTH(${col}) > ?`).get(c.len).n;
        report(`${name}: longest value ${max} chars, column is ${c.type}(${c.len}) - ${n} row(s) would be truncated/rejected`);
      }
    }
    if (NUMERIC.has(c.type)) {
      const n = src.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${col} IS NOT NULL AND typeof(${col}) IN ('text', 'blob') AND (${col} GLOB '*[^0-9.eE+-]*' OR trim(${col}) = '')`).get().n;
      if (n) {
        const sample = src.prepare(`SELECT ${col} AS v FROM "${table}" WHERE ${col} IS NOT NULL AND typeof(${col}) IN ('text','blob') AND (${col} GLOB '*[^0-9.eE+-]*' OR trim(${col}) = '') LIMIT 3`).all().map((r) => JSON.stringify(r.v)).join(', ');
        report(`${name}: ${n} non-numeric value(s) in ${c.type} column, e.g. ${sample}`);
      }
    }
    if (DATETIME.has(c.type)) {
      const n = src.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${col} IS NOT NULL AND ${col} NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'`).get().n;
      if (n) report(`${name}: ${n} value(s) that are not ISO dates in a ${c.type} column`);
    }
    if (c.nullable === 'NO' && !c.is_identity) {
      const n = src.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${col} IS NULL`).get().n;
      if (n) report(`${name}: ${n} NULL(s) in a NOT NULL column`);
    }
  }
  plan.push({ table, shared, rows, tcols });
}
if (skip.size) console.log(`\nskipped tables: ${[...skip].join(', ')}`);
console.log(`\n${problems ? `AUDIT: ${problems} problem(s) found` : 'AUDIT: no problems found'}`);
if (AUDIT) { await pool.close(); process.exit(problems ? 1 : 0); }
if (problems && opt('force') !== true) {
  console.log('Refusing to migrate with problems (fix the data or the schema, or pass --force to load anyway - offending values are loaded as NULL/skipped by SQL Server rules).');
  await pool.close();
  process.exit(1);
}

// --- migrate ----------------------------------------------------------------
const targetCounts = async () => Object.fromEntries((await run(`
  SELECT t.name AS t, SUM(p.rows) AS n FROM sys.tables t JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1) GROUP BY t.name`)).recordset.map((r) => [r.t, Number(r.n)]));
const existing = await targetCounts();
const dirty = plan.filter((p) => existing[p.table] > 0).map((p) => `${p.table} (${existing[p.table]})`);
if (dirty.length && !WIPE) {
  console.log(`Target already has data: ${dirty.join(', ')}. Re-run with --wipe to empty it first.`);
  await pool.close();
  process.exit(1);
}

const allTables = [...targetTables.keys()];
for (const t of allTables) await run(`ALTER TABLE ${q(t)} NOCHECK CONSTRAINT ALL`);
if (WIPE) {
  // Every target table, not just the ones being copied: a row left behind in a table that
  // references a copied one would dangle.
  for (const t of allTables) await run(`DELETE FROM ${q(t)}`);
  console.log('\ntarget emptied');
}

const toDatetime = (v) => {
  if (v == null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?)?/.exec(String(v));
  if (!m) return null;
  return `${m[1]} ${m[2] || '00:00:00'}.${(m[3] || '0').padEnd(3, '0').slice(0, 3)}`;
};
const convert = (v, c) => {
  if (v == null) return null;
  if (NUMERIC.has(c.type)) {
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    const n = Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
  }
  if (DATETIME.has(c.type)) return toDatetime(v);
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return String(v);
};

const started = Date.now();
for (const { table, shared, rows, tcols } of plan) {
  if (!rows) continue;
  const identity = shared.some((n) => tcols.get(n).is_identity);
  const perBatch = Math.max(1, Math.min(500, Math.floor(2000 / shared.length)));
  const colList = shared.map(q).join(', ');
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const exec = (text, params = []) => { const r = new sql.Request(tx); params.forEach((v, i) => r.input(`p${i}`, v)); return r.query(text); };
    let batch = [];
    let done = 0;
    const flush = async () => {
      if (!batch.length) return;
      const params = [];
      const tuples = batch.map((row) => `(${shared.map((n, i) => { params.push(convert(row[n], tcols.get(n))); return `@p${params.length - 1}`; }).join(', ')})`);
      // IDENTITY_INSERT is scoped to the batch it is set in, so it must share the
      // batch with the INSERT (a separate call would run it in its own scope).
      const insert = `INSERT INTO ${q(table)} (${colList}) VALUES ${tuples.join(', ')}`;
      await exec(identity ? `SET IDENTITY_INSERT ${q(table)} ON; ${insert}; SET IDENTITY_INSERT ${q(table)} OFF;` : insert, params);
      done += batch.length;
      batch = [];
    };
    for (const row of src.prepare(`SELECT ${shared.map((n) => `"${n}"`).join(', ')} FROM "${table}"`).iterate()) {
      batch.push(row);
      if (batch.length >= perBatch) await flush();
    }
    await flush();
    await tx.commit();
    console.log(`  copied ${table}: ${done} rows`);
  } catch (err) {
    try { await tx.rollback(); } catch { /* already aborted */ }
    console.error(`\nFAILED on ${table}: ${err.message.slice(0, 400)}`);
    await pool.close();
    process.exit(1);
  }
}

// --- constraints + verification ---------------------------------------------
console.log('\nre-enabling constraints (validates every foreign key against the copied data)...');
let untrusted = 0;
for (const t of allTables) {
  try { await run(`ALTER TABLE ${q(t)} WITH CHECK CHECK CONSTRAINT ALL`); }
  catch (err) {
    untrusted += 1;
    console.log(`  ✖ ${t}: ${err.message.split('.')[0]} - orphaned rows exist in the source data; constraint left unchecked`);
    await run(`ALTER TABLE ${q(t)} WITH NOCHECK CHECK CONSTRAINT ALL`);
  }
}

console.log('\nverification (SQLite rows vs SQL Server rows):');
const after = await targetCounts();
let mismatches = 0;
for (const { table, rows } of plan) {
  const ok = after[table] === rows;
  if (!ok) mismatches += 1;
  if (!ok || rows > 0) console.log(`  ${ok ? '✔' : '✖'} ${table.padEnd(28)} ${String(rows).padStart(8)} -> ${String(after[table] ?? 0).padStart(8)}`);
}
console.log(`\n${mismatches ? `${mismatches} table(s) with mismatched counts` : 'all row counts match'}${untrusted ? `; ${untrusted} table(s) have unvalidated foreign keys` : ''}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
await pool.close();
process.exit(mismatches ? 1 : 0);

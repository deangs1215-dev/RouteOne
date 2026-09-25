// Static check for the SQLite -> SQL Server migration: pulls every SQL string passed to
// dbx/tx/conn.prepare() out of the source and binds it against the SQL Server schema in
// RouteOne_Test (sp_describe_first_result_set - nothing is executed). Unlike the shadow
// validator this also covers INSERT/UPDATE/DELETE and code paths no test reaches.
//
//   node --env-file=server/.env server/check-sql-mssql.mjs
//
// Dynamic fragments (${...}) are replaced by neutral stand-ins, so a few rejections are
// artefacts of that (e.g. `FROM ?` for a computed table name, `WHERE WHERE`, and the
// deliberately SQLite-only sqlite_sequence / instr branches). Read each rejection; only
// the ones about real columns, keywords or GROUP BY are genuine.
import fs from 'node:fs';
import path from 'node:path';
import sql from 'mssql';
import { sqliteToTsql } from './sqlDialect.js';
import { toNamedParams } from './dbx.js';

const e = process.env;
const pool = await new sql.ConnectionPool({
  server: e.DB_HOST, port: +e.DB_PORT, database: 'RouteOne_Test', user: e.DB_USER, password: e.DB_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true }
}).connect();

function matchParen(s, i) {
  let d = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') { for (i++; s[i] !== c; i += s[i] === '\\' ? 2 : 1); continue; }
    if (c === '`') {
      for (i++; s[i] !== '`';) {
        if (s[i] === '\\') i += 2;
        else if (s[i] === '$' && s[i + 1] === '{') { let n = 1; i += 2; while (n) { if (s[i] === '{') n++; else if (s[i] === '}') n--; i++; } }
        else i++;
      }
      continue;
    }
    if (c === '/' && s[i + 1] === '/') { i = s.indexOf('\n', i) - 1; continue; }
    if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i) + 1; continue; }
    if (c === '(') d++;
    else if (c === ')' && --d === 0) return i;
  }
  return -1;
}

const files = [];
for (const dir of ['routes', 'integration', '.']) {
  for (const f of fs.readdirSync(new URL(`./${dir}/`, import.meta.url))) {
    if (f.endsWith('.js') && !f.startsWith('tmp-') && !['dbx.js', 'dbxShadow.js', 'sqlDialect.js', 'migrate-to-mssql.js'].includes(f)) files.push(path.join(dir, f));
  }
}
const seen = new Set();
let checked = 0;
const failures = [];
for (const rel of files) {
  const src = fs.readFileSync(new URL(`./${rel}`, import.meta.url), 'utf8');
  for (const m of src.matchAll(/\b(?:dbx|tx|conn|c)\.prepare\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    let arg = src.slice(open + 1, close).trim();
    // first argument only, and only literal SQL (string or template)
    const q = arg[0];
    if (!'\'"`'.includes(q)) continue;
    let end = 1;
    while (end < arg.length && arg[end] !== q) { if (arg[end] === '\\') end++; if (q === '`' && arg[end] === '$' && arg[end + 1] === '{') { let n = 1; end += 2; while (n) { if (arg[end] === '{') n++; else if (arg[end] === '}') n--; end++; } end--; } end++; }
    let text = arg.slice(1, end);
    // Dynamic fragments: neutral stand-ins that keep the statement well-formed.
    text = text.replace(/\$\{[^}]*where[^}]*\}/gi, ' WHERE 1 = 1 ')
      .replace(/\$\{[^}]*\.join\([^}]*\)\}/g, '?')
      .replace(/\$\{[^}]*\?[^}]*:[^}]*\}/g, '')
      .replace(/\$\{[^}]*\}/g, '?');
    if (seen.has(text) || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(text)) continue;
    seen.add(text);
    let t;
    try { t = toNamedParams(sqliteToTsql(text)); } catch (err) { failures.push({ rel, why: `translate: ${err.message}`, text }); continue; }
    checked += 1;
    const params = Array.from({ length: t.count }, (_, i) => `@p${i} nvarchar(max)`).join(', ');
    try {
      await pool.request().input('t', t.sql).input('p', params || null).query('EXEC sp_describe_first_result_set @tsql = @t, @params = @p');
    } catch (err) {
      const why = (err.precedingErrors ?? []).map((x) => x.message).join(' | ') || err.message;
      if (/Implicit conversion|Operand type clash|conflicting|Error converting/i.test(why)) continue;
      failures.push({ rel, why, text });
    }
  }
}
console.log(`checked ${checked} distinct statements from ${files.length} files; ${failures.length} rejected`);
for (const f of failures) console.log(`\n${f.rel}\n  ${f.why.slice(0, 200)}\n  ${f.text.replace(/\s+/g, ' ').slice(0, 260)}`);
await pool.close();
process.exit(0);

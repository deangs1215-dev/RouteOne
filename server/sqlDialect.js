// Translates the small, fixed set of SQLite-only SQL forms RouteOne uses into
// T-SQL, so route code is written once and runs on both backends. Applied by the
// SQL Server backend of dbx to every statement (memoised there).
//
// Deliberately narrow: anything outside the forms below throws instead of being
// guessed at, so an unsupported query fails in testing rather than returning
// subtly different data in production.
//
//   date('now')                       CONVERT(VARCHAR(10), SYSUTCDATETIME(), 23)
//   date('now', '-30 days', ...)      ... DATEADD(day, -30, ...) ; 'start of month|year'
//   date(expr)                        CONVERT(VARCHAR(10), expr, 23)
//   datetime('now'[, modifiers])      SYSUTCDATETIME() / DATEADD(...)
//   strftime('%Y-%m', expr)           CONVERT(VARCHAR(7), expr, 23)
//   strftime('%Y-01', expr)           CONVERT(VARCHAR(4), expr, 23) + '-01'
//   julianday(x)                      (DATEDIFF_BIG(SECOND, '1970-01-01', x) / 86400.0)
//   ... LIMIT n                       SELECT TOP (n) ...   (numeric literal only)
//
// julianday() is only faithful for DIFFERENCES ('julianday(a) - julianday(b)' is
// the gap in days): the T-SQL form counts days from 1970, not from the Julian
// epoch, so never use an absolute julianday value.
//
// date()/strftime() return text on SQLite, so the T-SQL forms return VARCHAR.
// CONVERT(VARCHAR(n), x, 23) also truncates a text column ('2026-03-01 10:00')
// to its date part, matching SQLite's date(text).

// If a comment (-- to end of line, or /* ... */) starts at s[i], the index just
// past it; otherwise -1. Comments can contain apostrophes and '?' that must not
// be read as string literals or parameters.
export function skipComment(s, i) {
  if (s[i] === '-' && s[i + 1] === '-') {
    const eol = s.indexOf('\n', i);
    return eol === -1 ? s.length : eol;
  }
  if (s[i] === '/' && s[i + 1] === '*') {
    const end = s.indexOf('*/', i + 2);
    return end === -1 ? s.length : end + 2;
  }
  return -1;
}

// Index just past the string literal starting at s[i] === "'" ('' escapes a quote).
function skipLiteral(s, i) {
  i += 1;
  while (i < s.length) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") { i += 2; continue; }
      return i + 1;
    }
    i += 1;
  }
  throw new Error('sqlDialect: unterminated string literal');
}

const isWordChar = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);

// Splits the text between a call's parentheses at top-level commas.
function splitArgs(inner) {
  const args = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    const cEnd = skipComment(inner, i);
    if (cEnd !== -1) { i = cEnd - 1; continue; }
    if (c === "'") { i = skipLiteral(inner, i) - 1; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) { args.push(inner.slice(start, i)); start = i + 1; }
  }
  args.push(inner.slice(start));
  return args.map((a) => a.trim());
}

const NOW = 'SYSUTCDATETIME()';

function applyModifiers(base, modifiers, fn) {
  let expr = base;
  for (const raw of modifiers) {
    if (raw === '?') throw new Error(`sqlDialect: ${fn}() with a bound modifier is not supported - compute the date in JS`);
    const lit = /^'(.*)'$/.exec(raw);
    if (!lit) throw new Error(`sqlDialect: unsupported ${fn}() modifier ${raw}`);
    const mod = lit[1].trim().toLowerCase();
    const rel = /^([+-]?\d+)\s+(day|hour|minute|month|year)s?$/.exec(mod);
    if (rel) expr = `DATEADD(${rel[2]}, ${Number(rel[1])}, ${expr})`;
    else if (mod === 'start of month') expr = `DATEFROMPARTS(YEAR(${expr}), MONTH(${expr}), 1)`;
    else if (mod === 'start of year') expr = `DATEFROMPARTS(YEAR(${expr}), 1, 1)`;
    else throw new Error(`sqlDialect: unsupported ${fn}() modifier ${raw}`);
  }
  return expr;
}

function buildCall(name, args) {
  const isNow = (a) => a !== undefined && a.toLowerCase() === "'now'";
  if (name === 'date') {
    if (!args.length) throw new Error('sqlDialect: date() needs an argument');
    const base = isNow(args[0]) ? NOW : args[0];
    return `CONVERT(VARCHAR(10), ${applyModifiers(base, args.slice(1), 'date')}, 23)`;
  }
  if (name === 'datetime') {
    if (!isNow(args[0])) throw new Error('sqlDialect: only datetime(\'now\'[, modifiers]) is supported');
    return applyModifiers(NOW, args.slice(1), 'datetime');
  }
  if (name === 'julianday') {
    if (args.length !== 1) throw new Error('sqlDialect: julianday() modifiers are not supported');
    const src = isNow(args[0]) ? NOW : args[0];
    return `(DATEDIFF_BIG(SECOND, '1970-01-01', ${src}) / 86400.0)`;
  }
  // strftime
  const fmt = /^'(.*)'$/.exec(args[0] ?? '')?.[1];
  const src = isNow(args[1]) ? NOW : args[1];
  if (fmt === '%Y-%m' && src) return `CONVERT(VARCHAR(7), ${src}, 23)`;
  if (fmt === '%Y-01' && src) return `(CONVERT(VARCHAR(4), ${src}, 23) + '-01')`;
  throw new Error(`sqlDialect: unsupported strftime format ${args[0]}`);
}

const FUNCS = new Set(['date', 'datetime', 'strftime', 'julianday']);

function translateFunctions(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const cEnd = skipComment(sql, i);
    if (cEnd !== -1) {
      out += sql.slice(i, cEnd);
      i = cEnd;
      continue;
    }
    if (c === "'") {
      const end = skipLiteral(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (/[A-Za-z_]/.test(c) && !isWordChar(sql[i - 1]) && sql[i - 1] !== '.') {
      let j = i;
      while (isWordChar(sql[j])) j += 1;
      const word = sql.slice(i, j).toLowerCase();
      let k = j;
      while (sql[k] === ' ') k += 1;
      if (FUNCS.has(word) && sql[k] === '(') {
        // matching close paren
        let depth = 0;
        let end = k;
        for (; end < sql.length; end++) {
          const ce = skipComment(sql, end);
          if (ce !== -1) { end = ce - 1; continue; }
          if (sql[end] === "'") { end = skipLiteral(sql, end) - 1; continue; }
          if (sql[end] === '(') depth += 1;
          else if (sql[end] === ')') { depth -= 1; if (depth === 0) break; }
        }
        if (depth !== 0) throw new Error('sqlDialect: unbalanced parentheses');
        const args = splitArgs(sql.slice(k + 1, end)).map(translateFunctions);
        out += buildCall(word, args);
        i = end + 1;
        continue;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// LIMIT n -> TOP (n) on the SELECT it belongs to. Each parenthesised group is a
// scope; a LIMIT belongs to the first SELECT in its own scope.
function translateLimit(sql) {
  const selects = []; // { pos, after, scope }
  const limits = []; // { pos, end, n, scope }
  const unionScopes = new Set();
  const stack = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const cEnd = skipComment(sql, i);
    if (cEnd !== -1) { i = cEnd; continue; }
    if (c === "'") { i = skipLiteral(sql, i); continue; }
    if (c === '(') { stack.push(i); i += 1; continue; }
    if (c === ')') { stack.pop(); i += 1; continue; }
    if (/[A-Za-z_]/.test(c) && !isWordChar(sql[i - 1])) {
      let j = i;
      while (isWordChar(sql[j])) j += 1;
      const word = sql.slice(i, j).toUpperCase();
      const scope = stack.length ? stack[stack.length - 1] : -1;
      if (word === 'SELECT') {
        let after = j;
        const distinct = /^\s+DISTINCT\b/i.exec(sql.slice(j));
        if (distinct) after = j + distinct[0].length;
        const hasTop = /^\s+TOP\b/i.test(sql.slice(after));
        selects.push({ pos: i, after, scope, hasTop });
      } else if (word === 'UNION') {
        unionScopes.add(scope);
      } else if (word === 'LIMIT') {
        const m = /^\s+(\d+)\b/.exec(sql.slice(j));
        if (!m) throw new Error('sqlDialect: LIMIT needs a numeric literal (a bound LIMIT is not supported)');
        limits.push({ pos: i, end: j + m[0].length, n: Number(m[1]), scope });
      }
      i = j;
      continue;
    }
    i += 1;
  }
  if (!limits.length) return sql;
  const edits = [];
  for (const lim of limits) {
    if (unionScopes.has(lim.scope)) throw new Error('sqlDialect: LIMIT on a UNION is not supported');
    const sel = selects.find((s) => s.scope === lim.scope && s.pos < lim.pos);
    if (!sel) throw new Error('sqlDialect: LIMIT without a SELECT in scope');
    if (sel.hasTop) throw new Error('sqlDialect: LIMIT on a SELECT that already has TOP');
    edits.push({ at: sel.after, remove: 0, insert: ` TOP (${lim.n})` });
    // also swallow the whitespace before LIMIT
    let start = lim.pos;
    while (start > 0 && /\s/.test(sql[start - 1])) start -= 1;
    edits.push({ at: start, remove: lim.end - start, insert: '' });
  }
  edits.sort((a, b) => b.at - a.at);
  let out = sql;
  for (const e of edits) out = out.slice(0, e.at) + e.insert + out.slice(e.at + e.remove);
  return out;
}

export function sqliteToTsql(sql) {
  return translateLimit(translateFunctions(sql));
}

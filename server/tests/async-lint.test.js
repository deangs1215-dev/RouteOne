// Guard for the SQLite -> SQL Server migration: a dbx query whose promise is
// neither awaited nor returned silently yields a Promise where data was
// expected (res.json({}), `if (!row)` never true, a write that may not finish
// before the response). Tests only catch that where they happen to exercise the
// line, so this scans the source instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'tests', 'data', 'uploads', 'backups']);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : sourceFiles(path.join(dir, e.name));
    return /\.(js|cjs|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : [];
  });
}

// Index of the ')' matching the '(' at s[i]; skips strings, templates, comments.
function matchParen(s, i) {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') { for (i++; s[i] !== c; i += s[i] === '\\' ? 2 : 1); continue; }
    if (c === '`') {
      for (i++; s[i] !== '`';) {
        if (s[i] === '\\') i += 2;
        else if (s[i] === '$' && s[i + 1] === '{') {
          let d = 1; i += 2;
          while (d) { if (s[i] === '{') d++; else if (s[i] === '}') d--; i++; }
        } else i++;
      }
      continue;
    }
    if (c === '/' && s[i + 1] === '/') { i = s.indexOf('\n', i) - 1; continue; }
    if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i) + 1; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

const CALL = /\b(dbx|tx|conn)\.prepare\s*\(/g;
const TERMINAL = /^(?:\s|\/\/[^\n]*\n)*\.\s*(get|all|run)\s*\(/;
// What may legitimately precede the chain: await, return, an arrow (returns the promise), or `= ` of a stored statement.
const OK_BEFORE = /(await\s*\(?\s*|return\s+|=>\s*\(?\s*)$/;

test('every dbx query chain is awaited or returned', () => {
  const problems = [];
  for (const file of sourceFiles(serverDir)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(CALL)) {
      const open = m.index + m[0].length - 1;
      const close = matchParen(src, open);
      const rest = src.slice(close + 1);
      if (!TERMINAL.test(rest)) continue; // stored prepared statement: its .get/.all/.run calls are checked below
      const before = src.slice(Math.max(0, m.index - 40), m.index);
      if (!OK_BEFORE.test(before)) {
        const line = src.slice(0, m.index).split('\n').length;
        problems.push(`${path.relative(serverDir, file)}:${line}`);
      }
    }
    // Stored statements: `const s = dbx.prepare(...)` then `s.get(...)`.
    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*(?:dbx|tx|conn)\.prepare\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      if (TERMINAL.test(src.slice(matchParen(src, open) + 1))) continue; // chained: handled above
      const use = new RegExp(`(^|[^\\w.])(?<!await )${m[1]}\\.(get|all|run)\\s*\\(`, 'g');
      for (const u of src.matchAll(use)) {
        const before = src.slice(Math.max(0, u.index - 12), u.index + u[1].length);
        if (/await\s*\(?\s*$/.test(before) || /return\s+$/.test(before)) continue;
        problems.push(`${path.relative(serverDir, file)}:${src.slice(0, u.index).split('\n').length} (${m[1]}.${u[2]})`);
      }
    }
  }
  assert.deepEqual(problems, [], `un-awaited dbx queries:\n  ${problems.join('\n  ')}`);
});

// Async database facade. Routes call `dbx.prepare(sql).get/all/run(...)` with
// `await`; the backend behind it is SQLite (better-sqlite3) or SQL Server
// (mssql), chosen by DB_BACKEND in db.js. Both expose the same shape so route
// code can be migrated to await/dbx while still running on SQLite, and the
// backend flipped once every caller has moved.
//
//   prepare(sql).get(...params)  -> first row or undefined
//   prepare(sql).all(...params)  -> array of rows
//   prepare(sql).run(...params)  -> { changes, lastInsertRowid }
//   exec(sql)                    -> runs raw SQL, no parameters
//   upsert(table, spec)          -> portable insert-or-update, see buildUpsert
//   dialect, nowSql              -> 'sqlite' | 'mssql', and that dialect's
//                                   current-UTC-timestamp expression, for
//                                   interpolating into SQL text
//   transaction(async (tx) => {})-> tx has the same prepare/exec; commits on
//                                   return, rolls back on throw
//
// SQL is written with `?` placeholders. The mssql backend rewrites them to
// @p0, @p1... (skipping string literals).

// Rewrites `?` to @pN outside single-quoted string literals.
export function toNamedParams(sql) {
  let out = '';
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      // '' inside a literal is an escaped quote, so toggling twice is correct.
      inString = !inString;
      out += c;
    } else if (c === '?' && !inString) {
      out += `@p${n++}`;
    } else {
      out += c;
    }
  }
  return { sql: out, count: n };
}

// True when `err` is a duplicate-key violation on either backend. SQLite
// reports SQLITE_CONSTRAINT_UNIQUE / _PRIMARYKEY; SQL Server error numbers 2627
// (constraint) and 2601 (unique index). Route code should use this instead of
// matching 'UNIQUE' in the message, which only one backend's wording contains.
export function isUniqueViolation(err) {
  const n = err?.number ?? err?.originalError?.info?.number;
  return err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    n === 2627 || n === 2601;
}

// Portable upsert. `keys` identify the row; `set` columns are overwritten on
// conflict; `add` columns are incremented by the given amount on conflict (and
// inserted as-is when new); `now` columns are stamped with the current UTC time
// on both insert and update. Identifiers must be trusted constants - they are
// bracket-quoted, not parameterised.
//
//   SQLite:     INSERT ... ON CONFLICT(keys) DO UPDATE  (one statement)
//   SQL Server: UPDATE ... WHERE keys, then INSERT when nothing matched
//               (T-SQL has no ON CONFLICT; MERGE is not safe under concurrency)
//
// The SQL Server form can race two concurrent first-writers of the same key
// into a duplicate-key error; callers here (one sync per entity at a time)
// never do that. Bulk loads use a staging table instead - see sync.js.
export function buildUpsert(dialect, table, { keys, set = {}, add = {}, now = [] }) {
  const keyCols = Object.keys(keys);
  const setCols = Object.keys(set);
  const addCols = Object.keys(add);
  if (!keyCols.length) throw new Error('upsert: keys required');
  if (!setCols.length && !addCols.length && !now.length) throw new Error('upsert: nothing to update');
  const q = (c) => `[${c}]`;
  const nowExpr = dialect === 'sqlite' ? "datetime('now')" : 'SYSUTCDATETIME()';
  const valueCols = [...keyCols, ...setCols, ...addCols];
  const values = [...keyCols.map((c) => keys[c]), ...setCols.map((c) => set[c]), ...addCols.map((c) => add[c])];
  const insert = {
    sql: `INSERT INTO ${table} (${[...valueCols, ...now].map(q).join(', ')}) VALUES (${[...valueCols.map(() => '?'), ...now.map(() => nowExpr)].join(', ')})`,
    params: values
  };
  if (dialect === 'sqlite') {
    const updates = [
      ...setCols.map((c) => `${q(c)} = excluded.${q(c)}`),
      ...addCols.map((c) => `${q(c)} = ${q(c)} + excluded.${q(c)}`),
      ...now.map((c) => `${q(c)} = ${nowExpr}`)
    ];
    return { sql: `${insert.sql} ON CONFLICT(${keyCols.map(q).join(', ')}) DO UPDATE SET ${updates.join(', ')}`, params: values };
  }
  const updates = [
    ...setCols.map((c) => `${q(c)} = ?`),
    ...addCols.map((c) => `${q(c)} = ${q(c)} + ?`),
    ...now.map((c) => `${q(c)} = ${nowExpr}`)
  ];
  return {
    update: {
      sql: `UPDATE ${table} SET ${updates.join(', ')} WHERE ${keyCols.map((c) => `${q(c)} = ?`).join(' AND ')}`,
      params: [...setCols.map((c) => set[c]), ...addCols.map((c) => add[c]), ...keyCols.map((c) => keys[c])]
    },
    insert
  };
}

// --- SQLite backend ---------------------------------------------------------
// better-sqlite3 is synchronous and has one connection, so a transaction that
// awaits mid-way would interleave with other requests. Transactions are
// serialized through a mutex; queries made outside a transaction while one is
// open still share the connection and so join it. That is acceptable for the
// interim SQLite backend only - SQL Server transactions get their own
// connection from the pool.
export function createSqliteDbx(db) {
  let tail = Promise.resolve();
  const withLock = (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };

  // better-sqlite3 re-parses SQL on every db.prepare(). Hot loops (the sync
  // engine runs one statement millions of times) must not pay that, so
  // statements are cached by text. Bounded so dynamically built SQL cannot
  // grow it forever.
  const stmtCache = new Map();
  const stmtFor = (sql) => {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      if (stmtCache.size >= 500) stmtCache.clear();
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  };

  const handle = () => {
    const self = {
      dialect: 'sqlite',
      nowSql: "datetime('now')",
      prepare(sql) {
        const stmt = stmtFor(sql);
        return {
          get: async (...params) => stmt.get(...params),
          all: async (...params) => stmt.all(...params),
          run: async (...params) => stmt.run(...params)
        };
      },
      exec: async (sql) => { db.exec(sql); },
      async upsert(table, spec) {
        const { sql, params } = buildUpsert('sqlite', table, spec);
        await stmtFor(sql).run(...params);
      }
    };
    return self;
  };

  return {
    ...handle(),
    transaction(fn) {
      return withLock(async () => {
        db.exec('BEGIN');
        try {
          const result = await fn(handle());
          db.exec('COMMIT');
          return result;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      });
    }
  };
}

// --- SQL Server backend -----------------------------------------------------
export function createMssqlDbx(pool, sql) {
  const translations = new Map();
  // `target` is the pool, or a Transaction for tx handles.
  const handle = (target) => {
    const request = () => (target === pool ? pool.request() : new sql.Request(target));

    // ?-to-@pN translation is pure in the SQL text, so do it once per statement.
    async function execute(text, params) {
      let translated = translations.get(text);
      if (!translated) {
        translated = toNamedParams(text);
        if (translations.size >= 2000) translations.clear();
        translations.set(text, translated);
      }
      const { sql: q, count } = translated;
      if (count !== params.length) {
        throw new Error(`dbx: ${count} placeholders but ${params.length} params in: ${text}`);
      }
      const req = request();
      params.forEach((v, i) => req.input(`p${i}`, v === undefined ? null : v));
      return req.query(q);
    }

    const self = {
      dialect: 'mssql',
      nowSql: 'SYSUTCDATETIME()',
      async upsert(table, spec) {
        const built = buildUpsert('mssql', table, spec);
        const r = await execute(built.update.sql, built.update.params);
        if (!r.rowsAffected?.[0]) await execute(built.insert.sql, built.insert.params);
      },
      prepare(text) {
        const isInsert = /^\s*INSERT\b/i.test(text);
        return {
          get: async (...params) => (await execute(text, params)).recordset?.[0],
          all: async (...params) => (await execute(text, params)).recordset ?? [],
          run: async (...params) => {
            // SCOPE_IDENTITY() is scoped to this batch, so it is safe under a
            // pool. It is NULL for tables without an identity column.
            const res = await execute(
              isInsert ? `${text}; SELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS __id` : text,
              params
            );
            const id = isInsert ? res.recordset?.[0]?.__id : undefined;
            return {
              changes: res.rowsAffected?.[0] ?? 0,
              lastInsertRowid: id == null ? undefined : Number(id)
            };
          }
        };
      },
      exec: async (text) => { await request().batch(text); }
    };
    return self;
  };

  return {
    ...handle(pool),
    async transaction(fn) {
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        const result = await fn(handle(tx));
        await tx.commit();
        return result;
      } catch (err) {
        try { await tx.rollback(); } catch { /* already aborted by the server */ }
        throw err;
      }
    }
  };
}

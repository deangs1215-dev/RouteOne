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

  const handle = () => ({
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        get: async (...params) => stmt.get(...params),
        all: async (...params) => stmt.all(...params),
        run: async (...params) => stmt.run(...params)
      };
    },
    exec: async (sql) => { db.exec(sql); }
  });

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
  // `target` is the pool, or a Transaction for tx handles.
  const handle = (target) => {
    const request = () => (target === pool ? pool.request() : new sql.Request(target));

    async function execute(text, params) {
      const { sql: q, count } = toNamedParams(text);
      if (count !== params.length) {
        throw new Error(`dbx: ${count} placeholders but ${params.length} params in: ${text}`);
      }
      const req = request();
      params.forEach((v, i) => req.input(`p${i}`, v === undefined ? null : v));
      return req.query(q);
    }

    return {
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

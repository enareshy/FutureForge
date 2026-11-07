// Asynchronous PostgreSQL data layer.
//
// This is the destination of the incremental migration away from the blocking
// synchronous bridge in db.js. It talks to the same database and schema (the
// connection settings are carried on the `Database` handle) but uses the native
// asynchronous `pg` driver directly on the main thread, so a slow query no
// longer stalls the Node event loop — the whole point of Phase 2.
//
// Scope and rules of the migration:
//   * The synchronous facade stays for CLI scripts, seeders and tests. Both
//     layers may coexist; they simply use different connections.
//   * A request path must not mix the two layers inside one transaction. Async
//     routes use these helpers exclusively.
//   * Per-request work that needs atomicity is wrapped in `transactionAsync`,
//     which stores the dedicated client in AsyncLocalStorage so every helper
//     called underneath transparently joins the same transaction (nested calls
//     become savepoints).
import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { statementTimeout, poolMax } from "./db-config.js";
import { analyze, flatten, numberPlaceholders, reviveRow } from "./db.js";

// Match the worker's result shaping exactly: int8 (OID 20) and numeric (1700)
// arrive as strings by default, while the rest of the code base expects numbers.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

// Holds the current transaction client, if any, for the active async context.
const txStorage = new AsyncLocalStorage();

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// Lazily opens (and memoises) a pool per Database handle. Deriving the pool from
// the handle is what keeps per-test clone databases correct: each clone has its
// own connection settings, so async code always reaches the right database.
export function poolFor(db) {
  if (db.__asyncPool) return db.__asyncPool;
  // A test clone is materialised on first use; touch it once so the physical
  // database exists before a pool connects to it.
  if (db.__seedTemplate) db.prepare("SELECT 1 AS ok").get();

  const config = db.__config;
  if (!config) {
    throw new Error("Database handle has no connection config; open it with openDatabase/openTestDatabase");
  }
  const timeout = statementTimeout();
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl,
    max: poolMax(),
    application_name: "helix-api",
    options: `-c search_path=${quoteIdent(db.__schema || "public")}`,
    ...(timeout > 0 ? { statement_timeout: timeout } : {}),
  });
  // Never let an idle-client error take down the process; a broken connection
  // is simply discarded from the pool.
  pool.on("error", () => {});
  db.__asyncPool = pool;
  return pool;
}

// Translate driver errors into the same shape the synchronous bridge produces,
// so callers that inspect `code`/`constraint` (and the 409 mapping in services)
// behave identically on both paths.
function mapError(err) {
  if (err && err.code === "23505") {
    const mapped = new Error(
      `UNIQUE violation (${err.constraint || "duplicate key"}): ${err.message}`
    );
    mapped.code = err.code;
    mapped.constraint = err.constraint;
    mapped.detail = err.detail;
    return mapped;
  }
  return err;
}

function execute(db, sql, params) {
  const tx = txStorage.getStore();
  const runner = tx ? tx.client : poolFor(db);
  return Promise.resolve(runner.query(sql, params)).catch((err) => {
    throw mapError(err);
  });
}

export function queryAllAsync(db, sql, params = []) {
  return execute(db, numberPlaceholders(sql), flatten(params)).then((result) =>
    result.binary ? result.rows.map(reviveRow) : result.rows
  );
}

export function queryOneAsync(db, sql, params = []) {
  return queryAllAsync(db, sql, params).then((rows) => rows[0] ?? null);
}

async function tableHasIdAsync(db, table) {
  if (!db.__asyncTablesWithId) {
    const rows = await queryAllAsync(
      db,
      "SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'id'",
      []
    );
    db.__asyncTablesWithId = new Set(rows.map((r) => r.table_name));
  }
  return db.__asyncTablesWithId.has(table);
}

// Mirrors the synchronous `run`: INSERTs that do not already RETURN something
// get `RETURNING id` appended, so `lastInsertId` is available.
export async function runAsync(db, sql, params = []) {
  let pgSql = numberPlaceholders(sql).replace(/;\s*$/, "");
  const meta = analyze(sql);
  if (meta.insert && !meta.returning && meta.table && (await tableHasIdAsync(db, meta.table))) {
    pgSql += " RETURNING id";
  }
  const result = await execute(db, pgSql, flatten(params));
  const row = result.rows && result.rows[0];
  return {
    changes: result.rowCount ?? 0,
    lastInsertId: row && Object.prototype.hasOwnProperty.call(row, "id") ? row.id : null,
  };
}

// Multi-statement script (no parameters), mirroring `db.exec`.
export function execAsync(db, sql) {
  const tx = txStorage.getStore();
  const runner = tx ? tx.client : poolFor(db);
  return Promise.resolve(runner.query(sql)).then(() => undefined).catch((err) => {
    throw mapError(err);
  });
}

// True when the active async context is inside `transactionAsync`.
export function inAsyncTransaction() {
  return txStorage.getStore() != null;
}

// Runs `fn` inside a transaction on a single dedicated connection. All async
// helpers invoked under `fn` join this transaction. Nested calls use savepoints,
// matching the synchronous `transaction` semantics.
export async function transactionAsync(db, fn) {
  const current = txStorage.getStore();
  if (current) {
    current.depth += 1;
    const name = `sp_${current.depth}`;
    await current.client.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn(current);
      await current.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      try {
        await current.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await current.client.query(`RELEASE SAVEPOINT ${name}`);
      } catch {
        /* the original error is more useful */
      }
      throw mapError(err);
    } finally {
      current.depth -= 1;
    }
  }

  const client = await poolFor(db).connect();
  const context = { client, depth: 0, db };
  try {
    await client.query("BEGIN");
    const result = await txStorage.run(context, () => fn(context));
    // A statement that failed and was swallowed by a caller-level try/catch
    // leaves PostgreSQL in an aborted transaction; probe before COMMIT so the
    // failure is surfaced rather than silently discarding all work.
    await client.query("SELECT 1");
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the original error is more useful */
    }
    throw mapError(err);
  } finally {
    client.release();
  }
}

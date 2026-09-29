// PostgreSQL bridge worker.
//
// The Helix service layer is written in a fully synchronous, blocking style.
// Rather than rewrite every call site to async, the synchronous `db.js` facade
// hands statements to this worker and blocks on a SharedArrayBuffer until the
// result comes back. All real database work — pooling, transactions, bootstrap
// and parameter binding — happens here with `pg`.
import { parentPort, workerData } from "node:worker_threads";
import pg from "pg";

// bigint (identity ids, COUNT(*)) and numeric must round-trip as JS numbers to
// preserve the value semantics the application was written against.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const { port, signal, config, schema, bootstrap, maintenanceConfig } = workerData;
const sig = new Int32Array(signal);

// Interactive per-statement ceiling. 0 means "no server-side timeout": used by
// test/admin bridges whose bootstrap and bulk statements are legitimately long.
const statementTimeout =
  Number(workerData.statementTimeout) > 0 ? Number(workerData.statementTimeout) : 0;

const startupOptions = [];
if (schema && schema !== "public") {
  startupOptions.push(`-c search_path=${schema},public`);
}
if (statementTimeout > 0) {
  startupOptions.push(`-c statement_timeout=${statementTimeout}`);
}

const poolConfig = { ...config, max: Number(process.env.PG_POOL_MAX || 5) };
if (startupOptions.length) {
  poolConfig.options = startupOptions.join(" ");
}

function makePool() {
  const created = new pg.Pool(poolConfig);
  created.on("error", () => {
    /* idle client errors are surfaced per-query; keep the pool alive */
  });
  return created;
}

let pool = makePool();

let tx = null;

function reply(message) {
  port.postMessage(message);
  Atomics.store(sig, 0, 1);
  Atomics.notify(sig, 0);
}

function validDatabaseName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ""));
}

function maintenanceClient() {
  const cfg = maintenanceConfig || { ...config, database: "postgres" };
  return new pg.Client(cfg);
}

// (Re)creates `database` as a physical copy of `template`. `WITH (FORCE)`
// drops any lingering sessions, which is much faster than terminating them by
// hand and waiting for the lock.
async function refreshFromTemplate(database, template) {
  if (!validDatabaseName(database)) throw new Error(`Invalid database name: ${database}`);
  if (!validDatabaseName(template)) throw new Error(`Invalid template name: ${template}`);
  if (database === template) throw new Error("Cannot refresh a template from itself");
  if (tx) {
    try {
      await tx.query("ROLLBACK");
    } catch {
      /* the connection is about to be discarded */
    }
    tx.release();
    tx = null;
  }
  const t0 = Date.now();
  await pool.end();
  const t1 = Date.now();
  const admin = maintenanceClient();
  await admin.connect();
  const t2 = Date.now();
  try {
    // `WITH (FORCE)` normally severs lingering sessions in one shot. Very rarely
    // a session that is still shutting down can make it raise 42501 ("must be a
    // member of the role ..."); retry briefly rather than failing the whole test.
    let dropError = null;
    let dropStarted = Date.now();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        dropError = null;
        break;
      } catch (err) {
        dropError = err;
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
    if (dropError) throw dropError;
    const t3 = Date.now();
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
    const t4 = Date.now();
    if (process.env.HELIX_DB_DEBUG) {
      console.error(`[db-worker] refresh ${database} pool.end=${t1 - t0} connect=${t2 - t1} drop=${t3 - dropStarted} create=${t4 - t3}`);
    }
  } finally {
    await admin.end();
  }
  pool = makePool();
  tx = null;
}

const ADVISORY_LOCK = 771288;
// Application schema migration (single idempotent DDL pass) and the wider
// startup bootstrap (migration + seed) are serialized across every process
// pointed at the same database.
const SCHEMA_LOCK = 771289;
const BOOTSTRAP_LOCK = 771290;

async function columnExists(table, column) {
  const r = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2",
    [table, column]
  );
  return r.rowCount > 0;
}

async function ensureSchema() {
  // The advisory lock is session-scoped, so every statement involved in the
  // bootstrap must run on the same connection.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK]);
    try {
      const reg = await client.query("SELECT to_regclass($1) AS r", [bootstrap.migrationsTable]);
      let present = false;
      if (reg.rows[0].r) {
        const v = await client.query(
          `SELECT 1 FROM ${bootstrap.migrationsTable} WHERE name = $1`,
          [bootstrap.version]
        );
        present = v.rowCount > 0;
      }
      if (!present) {
        await client.query(bootstrap.schemaSql);
        await client.query(bootstrap.seedSql);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK]);
    }
  } finally {
    client.release();
  }
}

async function truncateAll() {
  const r = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = current_schema()"
  );
  const tables = r.rows
    .map((row) => row.tablename)
    .filter((name) => name !== bootstrap.migrationsTable);
  if (!tables.length) return;
  const list = tables.map((name) => `"${name}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

async function ensureDatabase() {
  if (!validDatabaseName(config.database)) {
    throw new Error(`Invalid database name: ${config.database}`);
  }
  const admin = maintenanceClient();
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [config.database]);
    if (!exists.rowCount) {
      if (bootstrap && bootstrap.cloneFrom) {
        await admin.query(`CREATE DATABASE "${config.database}" TEMPLATE "${bootstrap.cloneFrom}"`);
      } else {
        await admin.query(`CREATE DATABASE "${config.database}"`);
      }
    }
  } finally {
    await admin.end();
  }
}

async function prepare() {
  if (!bootstrap) return;
  if (bootstrap.createDatabase) await ensureDatabase();
  if (bootstrap.ensureSchema) await ensureSchema();
  if (bootstrap.truncate) await truncateAll();
}

// Test clones are created lazily: the database is only materialised when the
// caller first touches it, and a `refresh` request (used by the seed shortcut)
// can replace the pending schema clone with the seeded one before any work is
// duplicated.
let pendingRefresh = bootstrap && bootstrap.lazyRefreshFromTemplate ? bootstrap.lazyRefreshFromTemplate : null;

let bootstrapDone = false;
let bootstrapError = null;
const ready = prepare().then(
  () => {
    bootstrapDone = true;
  },
  (err) => {
    bootstrapDone = true;
    bootstrapError = err;
  }
);

// Applies the schema and seed sentinels as a single atomic, lock-guarded step.
// Concurrent starters serialize on a transaction-scoped advisory lock: the
// first applies the schema, the rest observe it already applied and only
// (re-)insert the idempotent seed rows. `SET LOCAL statement_timeout = 0`
// exempts the long DDL pass without leaking session state back to the pool.
async function runMigrations({ version, migrationsTable, schemaSql, seedSql }) {
  if (!validDatabaseName(migrationsTable)) {
    throw new Error(`Invalid migrations table: ${migrationsTable}`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 0");
    await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK]);
    const reg = await client.query("SELECT to_regclass($1) AS r", [migrationsTable]);
    let applied = false;
    if (reg.rows[0].r) {
      const v = await client.query(
        `SELECT 1 FROM ${migrationsTable} WHERE name = $1`,
        [version]
      );
      applied = v.rowCount > 0;
    }
    if (!applied) {
      await client.query(schemaSql);
    }
    await client.query(seedSql);
    await client.query("COMMIT");
  } catch (err) {
    let reusable = false;
    try {
      await client.query("ROLLBACK");
      reusable = true;
    } catch {
      /* the session is unusable; discard it below */
    }
    client.release(reusable ? undefined : err);
    throw err;
  }
  client.release();
}

// Serializes the whole startup bootstrap (migration plus the seed, which the
// synchronous facade otherwise runs as many independent pooled statements) so
// any number of processes can start against the same database without racing.
// A dedicated client carries the session-scoped lock; it is kept out of the
// pool so its lifted statement timeout cannot leak into application queries.
let bootstrapLockClient = null;

async function acquireBootstrapLock() {
  if (bootstrapLockClient) return;
  const client = new pg.Client(config);
  await client.connect();
  await client.query("SET statement_timeout = 0");
  await client.query("SELECT pg_advisory_lock($1)", [BOOTSTRAP_LOCK]);
  bootstrapLockClient = client;
}

async function releaseBootstrapLock() {
  if (!bootstrapLockClient) return;
  const client = bootstrapLockClient;
  bootstrapLockClient = null;
  try {
    await client.query("SELECT pg_advisory_unlock($1)", [BOOTSTRAP_LOCK]);
  } catch {
    /* the lock is released when the connection closes regardless */
  }
  await client.end();
}

parentPort.on("message", async (request) => {
  const { op, sql, params } = request;
  try {
    if (!bootstrapDone) await ready;
    if (bootstrapError) throw bootstrapError;

    if (op === "close") {
      if (tx) {
        try {
          await tx.query("ROLLBACK");
        } catch {
          /* closing regardless */
        }
        tx.release();
        tx = null;
      }
      await releaseBootstrapLock();
      await pool.end();
      return reply({ ok: true, rowCount: 0, rows: [] });
    }
    if (op === "acquireBootstrapLock") {
      await acquireBootstrapLock();
      return reply({ ok: true, rowCount: 0, rows: [] });
    }
    if (op === "releaseBootstrapLock") {
      await releaseBootstrapLock();
      return reply({ ok: true, rowCount: 0, rows: [] });
    }
    // An explicit refresh (the seed shortcut) supersedes any pending schema
    // clone so a seeded test only ever materialises one database.
    if (op === "refresh") {
      pendingRefresh = null;
      await refreshFromTemplate(config.database, request.template);
      return reply({ ok: true, rowCount: 0, rows: [] });
    }
    if (op === "commit" || op === "rollback") {
      if (tx) {
        try {
          await tx.query(op === "commit" ? "COMMIT" : "ROLLBACK");
        } finally {
          tx.release();
          tx = null;
        }
      }
      return reply({ ok: true, rowCount: 0, rows: [] });
    }
    // No database has been materialised for this clone yet; do it now, before
    // the first operation that actually needs it.
    if (pendingRefresh) {
      const template = pendingRefresh;
      pendingRefresh = null;
      await refreshFromTemplate(config.database, template);
    }
    if (op === "migrate") {
      await runMigrations(request);
      return reply({ ok: true, rowCount: 0, rows: [] });
    }
    if (op === "begin") {
      if (!tx) {
        tx = await pool.connect();
        await tx.query("BEGIN");
      }
      return reply({ ok: true, rowCount: 0, rows: [] });
    }
    if (op === "columnExists") {
      const exists = await columnExists(sql.table, sql.column);
      return reply({ ok: true, rows: [{ present: exists }], rowCount: exists ? 1 : 0 });
    }

    const values = params && params.length ? params : undefined;
    const result = await (tx || pool).query(sql, values);
    const fields = result.fields || [];
    return reply({
      ok: true,
      rows: result.rows,
      rowCount: result.rowCount,
      fields: fields.map((f) => f.name),
      // Buffers do not survive structured cloning; flag results that carry
      // binary columns so the main thread can revive them as Buffers.
      binary: fields.some((f) => f.dataTypeID === 17),
    });
  } catch (err) {
    if (process.env.HELIX_DB_DEBUG) {
      try { console.error("[db-worker] " + (tx ? "TX " : "") + "ERR sql=" + String(sql).slice(0, 300) + "\n  err=" + err.message); } catch {}
    }
    return reply({
      ok: false,
      error: err.message,
      code: err.code || null,
      detail: err.detail || null,
      constraint: err.constraint || null,
    });
  }
});

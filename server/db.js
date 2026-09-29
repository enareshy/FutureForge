// Synchronous PostgreSQL facade.
//
// Helix keeps a blocking data-access style. This module preserves it on top of
// the asynchronous `pg` driver by delegating every statement to a worker thread
// (see db-worker.js) and waiting on a SharedArrayBuffer. Callers keep using
// `db.prepare(sql).all/get/run`, `db.exec`, and the `queryAll/queryOne/run`
// helpers exactly as before.
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  databaseConfig,
  databaseSchema,
  testDatabaseName,
  statementTimeout,
  bridgeTimeout,
  bootstrapTimeout,
} from "./db-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL =
  readFileSync(join(__dirname, "schema.sql"), "utf8") +
  "\n" +
  readFileSync(join(__dirname, "schema-indexes.sql"), "utf8") +
  "\n" +
  readFileSync(join(__dirname, "schema-search-indexes.sql"), "utf8");

// Bumped whenever the schema changes so `migrate()` can skip a full re-apply.
const SCHEMA_VERSION = "postgres_005";

const MIGRATIONS = [
  "001_iam_core", "002_authz", "003_orgs_sites", "004_org_hierarchy",
  "005_platform_properties", "006_authentication", "007_tenants_config",
  "008_metadata", "009_objects", "010_lifecycle", "011_workflow", "012_audit",
  "013_notifications", "014_delivery", "015_jobs", "016_job_engine", "017_files",
  "018_search", "019_audit_framework", "020_integration_framework",
  "021_event_messaging_framework", "022_numbering_service",
  "023_effectivity_versioning_kernel", "024_reference_data_management",
  "025_content_management", "026_search_foundation", "027_security_model",
  "028_data_governance_quality", "029_data_catalog_glossary",
  "030_data_lifecycle_archival", "031_import_export_framework",
  "032_migration_onboarding", "033_classification_framework", "034_bom_engine",
  "035_pdm", "036_change_management", "037_deployment_editions",
  SCHEMA_VERSION,
];

const SEED_SQL = [
  ...MIGRATIONS.map((name) => `INSERT INTO schema_migrations (name) VALUES ('${name}') ON CONFLICT DO NOTHING;`),
  "INSERT INTO password_policy (id) VALUES (1) ON CONFLICT DO NOTHING;",
  "INSERT INTO audit_guard (id, allow_delete) VALUES (1, 0) ON CONFLICT DO NOTHING;",
  "INSERT INTO versioning_cache_epoch (id, epoch) VALUES (1, 0) ON CONFLICT DO NOTHING;",
  "INSERT INTO reference_cache_epoch (id, epoch) VALUES (1, 0) ON CONFLICT DO NOTHING;",
].join("\n");

// --------------------------------------------------------------------------
// Bridge: main-thread side of the worker protocol
// --------------------------------------------------------------------------
function createBridge(workerData) {
  const { port1, port2 } = new MessageChannel();
  const signal = new SharedArrayBuffer(4);
  const sig = new Int32Array(signal);
  // 0 (or a missing value) means "wait without a deadline"; bootstrap bridges
  // pass a large explicit budget instead.
  const waitTimeout = Number(workerData.bridgeTimeout) > 0 ? Number(workerData.bridgeTimeout) : 0;
  const worker = new Worker(new URL("./db-worker.js", import.meta.url), {
    workerData: { ...workerData, port: port2, signal },
    transferList: [port2],
  });
  // A long-lived bridge must not, on its own, keep a short-lived process (test
  // runner, CLI script) alive once all application work has finished. Calls
  // block the main thread, so an in-flight query is never interrupted.
  worker.unref();

  let workerError = null;
  worker.on("error", (err) => {
    workerError = err;
    Atomics.store(sig, 0, 1);
    Atomics.notify(sig, 0);
  });

  function call(request, options = {}) {
    const timeout = options.timeout !== undefined ? options.timeout : waitTimeout;
    Atomics.store(sig, 0, 0);
    worker.postMessage(request);
    for (;;) {
      const waited = Atomics.wait(sig, 0, 0, timeout > 0 ? timeout : undefined);
      const received = receiveMessageOnPort(port1);
      if (received) {
        const message = received.message;
        if (!message.ok) {
          const error = new Error(
            message.code === "23505"
              ? `UNIQUE violation (${message.constraint || "duplicate key"}): ${message.error}`
              : message.error
          );
          error.code = message.code;
          error.constraint = message.constraint;
          error.detail = message.detail;
          throw error;
        }
        return message;
      }
      if (workerError) throw workerError;
      if (waited === "timed-out") {
        // The worker is still busy, so any reply it eventually posts would be
        // read as the answer to the next request. Poison the bridge instead of
        // silently desynchronising the protocol.
        workerError = new Error(
          `PostgreSQL bridge timed out after ${timeout}ms ` +
            "(set PG_BRIDGE_TIMEOUT / PG_STATEMENT_TIMEOUT to adjust)"
        );
        throw workerError;
      }
    }
  }

  async function close() {
    try {
      call({ op: "close" });
    } catch {
      /* pool teardown is best effort */
    }
    try {
      await worker.terminate();
    } catch {
      /* already gone */
    }
  }

  return { call, close };
}

// --------------------------------------------------------------------------
// SQL analysis
// --------------------------------------------------------------------------

// Converts `?` positional placeholders to PostgreSQL `$1, $2, ...`, skipping
// string literals, quoted identifiers, comments and dollar-quoted bodies.
function numberPlaceholders(sql) {
  let out = "";
  let index = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      out += c; i++;
      while (i < n) {
        const d = sql[i];
        out += d; i++;
        if (d === "'") {
          if (sql[i] === "'") { out += sql[i]; i++; } else break;
        }
      }
      continue;
    }
    if (c === '"') {
      out += c; i++;
      while (i < n) {
        const d = sql[i];
        out += d; i++;
        if (d === '"') {
          if (sql[i] === '"') { out += sql[i]; i++; } else break;
        }
      }
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") out += sql[i++];
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      out += "/*"; i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) out += sql[i++];
      if (i < n) { out += "*/"; i += 2; }
      continue;
    }
    if (c === "$") {
      const tagMatch = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        out += tag; i += tag.length;
        const end = sql.indexOf(tag, i);
        if (end === -1) { out += sql.slice(i); i = n; }
        else { out += sql.slice(i, end + tag.length); i = end + tag.length; }
        continue;
      }
      out += c; i++;
      continue;
    }
    if (c === "?") { index += 1; out += `$${index}`; i++; continue; }
    out += c; i++;
  }
  return out;
}

function analyze(sql) {
  const trimmed = sql.replace(/^(?:\s|--[^\n]*\n)*/, "");
  const insert = /^INSERT\s/i.test(trimmed);
  const returning = /\bRETURNING\b/i.test(sql);
  let table = null;
  if (insert) {
    const match = trimmed.match(
      /^INSERT\s+INTO\s+("?[A-Za-z_][A-Za-z0-9_$]*"?(?:\s*\.\s*"?[A-Za-z_][A-Za-z0-9_$]*"?)?)/i
    );
    if (match) table = match[1].split(".").pop().replace(/"/g, "").trim();
  }
  return { insert, returning, table };
}

function normalizeValue(value) {
  if (value === undefined) return null;
  if (value === true) return 1;
  if (value === false) return 0;
  // Numeric parameters must never be NaN: they are normalised to NULL because
  // PostgreSQL rejects NaN for integer and numeric columns.
  if (typeof value === "number" && Number.isNaN(value)) return null;
  return value;
}

function flatten(params) {
  const list = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  let needsNormalization = false;
  for (const value of list) {
    if (value === undefined || typeof value === "boolean" || (typeof value === "number" && Number.isNaN(value))) {
      needsNormalization = true;
      break;
    }
  }
  return needsNormalization ? list.map(normalizeValue) : list;
}

// Worker results cross a MessageChannel, which clones Node Buffers into plain
// Uint8Arrays. Rehydrate binary columns (bytea) so callers see Buffers.
function reviveRow(row) {
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
      row[key] = Buffer.from(value);
    }
  }
  return row;
}

// --------------------------------------------------------------------------
// Database / Statement
// --------------------------------------------------------------------------
class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.pgSql = numberPlaceholders(sql);
    this.meta = analyze(sql);
  }

  all(...params) {
    return this.db.select(this.pgSql, flatten(params));
  }

  get(...params) {
    const rows = this.db.select(this.pgSql, flatten(params));
    return rows[0] ?? null;
  }

  run(...params) {
    return this.db.runStatement(this.pgSql, this.meta, flatten(params));
  }
}

class Database {
  constructor(bridge, schema) {
    this._bridge = bridge;
    this._schema = schema;
    this._statements = new Map();
    this._tablesWithId = null;
    this.__inTransaction = false;
  }

  prepare(sql) {
    let statement = this._statements.get(sql);
    if (!statement) {
      statement = new Statement(this, sql);
      this._statements.set(sql, statement);
    }
    return statement;
  }

  exec(sql) {
    this._bridge.call({ op: "query", sql, params: [] });
  }

  select(sql, params) {
    const result = this._bridge.call({ op: "query", sql, params });
    const rows = result.rows || [];
    return result.binary ? rows.map(reviveRow) : rows;
  }

  runStatement(pgSql, meta, params) {
    let sql = pgSql.replace(/;\s*$/, "");
    if (meta.insert && !meta.returning && meta.table && this.tableHasId(meta.table)) {
      sql += " RETURNING id";
    }
    const result = this._bridge.call({ op: "query", sql, params });
    const row = result.rows && result.rows[0];
    return {
      changes: result.rowCount ?? 0,
      lastInsertId:
        row && Object.prototype.hasOwnProperty.call(row, "id") ? row.id : null,
    };
  }

  tableHasId(table) {
    if (!this._tablesWithId) {
      const rows = this.select(
        "SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'id'",
        []
      );
      this._tablesWithId = new Set(rows.map((r) => r.table_name));
    }
    return this._tablesWithId.has(table);
  }

  close() {
    return this._bridge.close();
  }
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------
export function openDatabase() {
  const schema = databaseSchema();
  const bridge = createBridge({
    config: databaseConfig(),
    schema,
    bootstrap: null,
    statementTimeout: statementTimeout(),
    bridgeTimeout: bridgeTimeout(),
  });
  return new Database(bridge, schema);
}

// Test suite entry point.
//
// PostgreSQL has no cheap "reset data, keep schema" operation, and rebuilding
// the 495-table schema plus the demo estate for every test is far too slow. We
// therefore keep two physical template databases — one schema-only, one fully
// seeded — and hand each test a fresh clone of the schema template. When a test
// calls `seedDatabase`, the clone is replaced by a clone of the seeded template
// instead of running thousands of statements.
export const TEST_SEED_MARKER = "seed_v1";
let registeredSeed = null;
let templatesCache = null;
let cloneCounter = 0;
const CLONE_SLOTS = 12;

export function registerTestSeed(fn) {
  registeredSeed = fn;
}

function maintenanceConfigDefault() {
  return { ...databaseConfig(), database: process.env.PGMAINTENANCE_DB || "postgres" };
}

function sanitizeIdentifier(name) {
  return String(name).replace(/[^A-Za-z0-9_]/g, "_");
}

function templateNames(base) {
  const safe = sanitizeIdentifier(base).slice(0, 32);
  return {
    schema: `${safe}__schema_${SCHEMA_VERSION}`,
    seed: `${safe}__seed_${SCHEMA_VERSION}`,
  };
}

export function hasSeedState(db) {
  const row = db
    .prepare("SELECT 1 AS ok FROM seed_state WHERE name = ? LIMIT 1")
    .get(TEST_SEED_MARKER);
  return Boolean(row);
}

// Replaces the database behind `db` with a physical clone of `template`.
export function refreshFromTemplate(db, template) {
  db._bridge.call({ op: "refresh", template });
}

function templateProbe(name) {
  return new Database(
    createBridge({
      config: databaseConfig(name),
      schema: "public",
      maintenanceConfig: maintenanceConfigDefault(),
      bootstrap: { createDatabase: false, ensureSchema: false, truncate: false },
      statementTimeout: 0,
      bridgeTimeout: bootstrapTimeout(),
    }),
    "public"
  );
}

// Templates are physical databases that outlive a single process, so a suite
// that spawns one process per test file only pays the build cost once. A
// missing or half-built template fails the probe and is rebuilt.
function templateReady(name, check) {
  let probe;
  try {
    probe = templateProbe(name);
    const ok = check(probe);
    probe.close();
    return Boolean(ok);
  } catch {
    try {
      if (probe) probe.close();
    } catch {
      /* ignoring close failure after a failed probe */
    }
    return false;
  }
}

function ensureTemplates(base) {
  if (templatesCache && templatesCache.base === base) return templatesCache.names;
  const names = templateNames(base);

  const schemaReady = templateReady(names.schema, (db) => {
    const registry = db.prepare("SELECT to_regclass(?) AS r").get("schema_migrations");
    if (!registry || !registry.r) return false;
    return Boolean(db.prepare("SELECT 1 AS ok FROM schema_migrations WHERE name = ?").get(SCHEMA_VERSION));
  });

  if (!schemaReady) {
    // 1. Schema template: schema.sql + bootstrap sentinels, no demo data.
    const schemaDb = new Database(
      createBridge({
        config: databaseConfig(names.schema),
        schema: "public",
        maintenanceConfig: maintenanceConfigDefault(),
        bootstrap: {
          createDatabase: true,
          ensureSchema: true,
          truncate: false,
          version: SCHEMA_VERSION,
          migrationsTable: "schema_migrations",
          schemaSql: SCHEMA_SQL,
          seedSql: SEED_SQL,
        },
        statementTimeout: 0,
        bridgeTimeout: bootstrapTimeout(),
      }),
      "public"
    );
    schemaDb.prepare("SELECT 1 AS ok").get();
    schemaDb.close();
  }

  // A rebuilt schema invalidates any existing seed template, so rebuild it too.
  const seedReady = schemaReady && templateReady(names.seed, (db) => hasSeedState(db));

  if (!seedReady) {
    if (!registeredSeed) {
      throw new Error("seedDatabase must be imported before openTestDatabase to build the test seed template");
    }
    // 2. Seed template: a clone of the schema template with the demo estate.
    const seedDb = new Database(
      createBridge({
        config: databaseConfig(names.seed),
        schema: "public",
        maintenanceConfig: maintenanceConfigDefault(),
        bootstrap: { createDatabase: true, cloneFrom: names.schema, ensureSchema: false, truncate: false },
        statementTimeout: 0,
        bridgeTimeout: bootstrapTimeout(),
      }),
      "public"
    );
    seedDb.prepare("SELECT 1 AS ok").get();
    registeredSeed(seedDb);
    seedDb.close();
  }

  templatesCache = { base, names };
  return names;
}

export function openTestDatabase() {
  const base = testDatabaseName();
  const names = ensureTemplates(base);
  const safe = sanitizeIdentifier(base).slice(0, 24);
  const slot = cloneCounter++ % CLONE_SLOTS;
  const cloneName = `${safe}_c${slot}`;
  const bridge = createBridge({
    config: databaseConfig(cloneName),
    schema: "public",
    maintenanceConfig: maintenanceConfigDefault(),
    bootstrap: {
      createDatabase: false,
      lazyRefreshFromTemplate: names.schema,
      ensureSchema: false,
      truncate: false,
    },
    // Test clones run the same heavy statements (bulk scans, duplicate
    // detection) that would exceed an interactive ceiling; they stay exempt and
    // rely on the larger bootstrap budget as a backstop.
    statementTimeout: 0,
    bridgeTimeout: bootstrapTimeout(),
  });
  const db = new Database(bridge, "public");
  db.__seedTemplate = names.seed;
  return db;
}

export function migrate(db) {
  // Test clones are materialised from a template that already contains the
  // migrated schema, so re-checking and re-applying is pure overhead. The
  // first real query (or the seed shortcut) performs the clone instead.
  if (db.__seedTemplate) return;
  // The whole check-and-apply runs in one worker transaction guarded by an
  // advisory lock, so concurrent processes cannot race the DDL. Exempt from the
  // interactive statement timeout because the full schema applies in one pass.
  db._bridge.call(
    {
      op: "migrate",
      version: SCHEMA_VERSION,
      migrationsTable: "schema_migrations",
      schemaSql: SCHEMA_SQL,
      seedSql: SEED_SQL,
    },
    { timeout: bootstrapTimeout() }
  );
}

// Serializes the wider startup bootstrap (migration + seed) across processes.
// Callers acquire before seeding and release once the schema and demo estate
// are in place; a concurrent starter blocks until the first one finishes.
export function acquireBootstrapLock(db) {
  db._bridge.call({ op: "acquireBootstrapLock" }, { timeout: bootstrapTimeout() });
}

export function releaseBootstrapLock(db) {
  db._bridge.call({ op: "releaseBootstrapLock" }, { timeout: bootstrapTimeout() });
}

export function transaction(db, fn) {
  if (db.__inTransaction) {
    const name = `sp_${(db.__savepointDepth = (db.__savepointDepth || 0) + 1)}`;
    db._bridge.call({ op: "query", sql: `SAVEPOINT ${name}`, params: [] });
    try {
      const result = fn();
      db._bridge.call({ op: "query", sql: `RELEASE SAVEPOINT ${name}`, params: [] });
      return result;
    } catch (err) {
      try {
        db._bridge.call({ op: "query", sql: `ROLLBACK TO SAVEPOINT ${name}`, params: [] });
        db._bridge.call({ op: "query", sql: `RELEASE SAVEPOINT ${name}`, params: [] });
      } catch {
        /* the original error is more useful */
      }
      throw err;
    } finally {
      db.__savepointDepth = (db.__savepointDepth || 1) - 1;
    }
  }
  db._bridge.call({ op: "begin" });
  db.__inTransaction = true;
  try {
    const result = fn();
    // A statement that failed and was swallowed by caller-level try/catch leaves
    // PostgreSQL in an aborted transaction; COMMIT would silently discard all
    // work. Probe first so that state is reported instead of hidden.
    db._bridge.call({ op: "query", sql: "SELECT 1", params: [] });
    db._bridge.call({ op: "commit" });
    return result;
  } catch (err) {
    try {
      db._bridge.call({ op: "rollback" });
    } catch {
      /* original error is more useful */
    }
    throw err;
  } finally {
    db.__inTransaction = false;
    db.__savepointDepth = 0;
  }
}

export function randomUuid() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
}

export function nowIso() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function queryAll(db, sql, params = []) {
  return prepare(db, sql).all(...params);
}

export function queryOne(db, sql, params = []) {
  return prepare(db, sql).get(...params);
}

export function run(db, sql, params = []) {
  return prepare(db, sql).run(...params);
}

function prepare(db, sql) {
  return db.prepare(sql);
}

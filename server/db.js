import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDatabase(dbPath = ":memory:") {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function migrate(db) {
  const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
  db.exec(sql);
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("001_iam_core");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("002_authz");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("003_orgs_sites");
  ensureColumn(db, "organizations", "kind", "kind TEXT NOT NULL DEFAULT 'organization'");
  ensureColumn(db, "organizations", "status", "status TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, "organizations", "description", "description TEXT DEFAULT ''");
  rebuildOrganizationsKindCheck(db);
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("004_org_hierarchy");
  dropOrganizationsKindCheck(db);
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("005_platform_properties");
  ensureColumn(db, "sessions", "public_id", "public_id TEXT");
  ensureColumn(db, "sessions", "ip", "ip TEXT");
  ensureColumn(db, "sessions", "user_agent", "user_agent TEXT");
  ensureColumn(db, "sessions", "provider_code", "provider_code TEXT DEFAULT 'password'");
  ensureColumn(db, "sessions", "mfa_verified", "mfa_verified INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "sessions", "last_seen_at", "last_seen_at TEXT");
  ensureColumn(db, "sessions", "revoked_at", "revoked_at TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_public ON sessions(public_id)");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("006_authentication");
  ensureColumn(db, "organizations", "tenant_id", "tenant_id INTEGER REFERENCES organizations(id)");
  ensureColumn(db, "users", "tenant_id", "tenant_id INTEGER REFERENCES organizations(id)");
  ensureColumn(db, "groups", "tenant_id", "tenant_id INTEGER REFERENCES organizations(id)");
  ensureColumn(db, "sessions", "tenant_id", "tenant_id INTEGER REFERENCES organizations(id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_organizations_tenant ON organizations(tenant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_groups_tenant ON groups(tenant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id)");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("007_tenants_config");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("008_metadata");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("009_objects");
  db.prepare(
    `INSERT OR IGNORE INTO password_policy (id) VALUES (1)`
  ).run();
}

// Runs `fn` inside a SQLite transaction, committing on success and rolling back
// on error. Nested calls reuse the outermost transaction so domain services can
// compose freely without leaking partial writes.
export function transaction(db, fn) {
  if (db.__inTransaction) return fn();
  db.exec("BEGIN");
  db.__inTransaction = true;
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* rollback best effort; original error is more useful */
    }
    throw err;
  } finally {
    db.__inTransaction = false;
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

function ensureColumn(db, table, column, ddl) {
  const cols = queryAll(db, `PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function rebuildOrganizationsKindCheck(db) {
  const row = queryOne(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'organizations'");
  if (!row?.sql) return;
  if (!row.sql.includes("CHECK (kind IN")) return;
  rebuildOrganizationsTable(db, true);
}

function dropOrganizationsKindCheck(db) {
  const row = queryOne(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'organizations'");
  if (!row?.sql) return;
  if (!row.sql.includes("CHECK (kind IN")) return;
  rebuildOrganizationsTable(db, false);
}

function rebuildOrganizationsTable(db, withKindCheck) {
  const kindCol = withKindCheck
    ? `kind TEXT NOT NULL DEFAULT 'organization' CHECK (kind IN (
        'enterprise', 'company', 'business_unit', 'plant', 'site', 'department', 'organization'
      ))`
    : "kind TEXT NOT NULL DEFAULT 'organization'";
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE organizations_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      ${kindCol},
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      description TEXT DEFAULT '',
      parent_id INTEGER REFERENCES organizations(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`
    INSERT INTO organizations_new (id, code, name, kind, status, description, parent_id, created_at, updated_at)
    SELECT id, code, name, kind, status, COALESCE(description, ''), parent_id, created_at, updated_at
    FROM organizations
  `);
  db.exec("DROP TABLE organizations");
  db.exec("ALTER TABLE organizations_new RENAME TO organizations");
  db.exec("CREATE INDEX IF NOT EXISTS idx_organizations_parent ON organizations(parent_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_organizations_kind ON organizations(kind)");
  const maxId = queryOne(db, "SELECT MAX(id) AS m FROM organizations");
  if (maxId?.m) {
    const seq = queryOne(db, "SELECT seq FROM sqlite_sequence WHERE name = 'organizations'");
    if (seq) {
      db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'organizations'").run(maxId.m);
    } else {
      try {
        db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('organizations', ?)").run(maxId.m);
      } catch {
        /* sqlite_sequence may be absent when the table is not AUTOINCREMENT */
      }
    }
  }
  db.exec("PRAGMA foreign_keys = ON");
}

export function nowIso() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function queryAll(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function queryOne(db, sql, params = []) {
  return db.prepare(sql).get(...params) ?? null;
}

export function run(db, sql, params = []) {
  return db.prepare(sql).run(...params);
}

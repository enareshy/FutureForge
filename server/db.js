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
  db.exec("PRAGMA busy_timeout = 5000");
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
  ensureColumn(db, "objects", "lifecycle_version_id", "lifecycle_version_id INTEGER REFERENCES lifecycle_versions(id)");
  ensureColumn(db, "objects", "lifecycle_state_id", "lifecycle_state_id INTEGER REFERENCES lifecycle_states(id)");
  ensureColumn(db, "objects", "lifecycle_status_id", "lifecycle_status_id INTEGER REFERENCES lifecycle_statuses(id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_objects_lifecycle_version ON objects(lifecycle_version_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_objects_lifecycle_state ON objects(lifecycle_state_id)");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("010_lifecycle");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("011_workflow");
  ensureColumn(db, "audit_logs", "tenant_id", "tenant_id INTEGER");
  ensureColumn(db, "audit_logs", "organization_id", "organization_id INTEGER");
  ensureColumn(db, "audit_logs", "plant_id", "plant_id INTEGER");
  ensureColumn(db, "audit_logs", "site_id", "site_id INTEGER");
  ensureColumn(db, "audit_logs", "department_id", "department_id INTEGER");
  ensureColumn(db, "audit_logs", "object_name", "object_name TEXT");
  ensureColumn(db, "audit_logs", "source", "source TEXT DEFAULT 'api'");
  ensureColumn(db, "audit_logs", "user_display_name", "user_display_name TEXT");
  ensureColumn(db, "audit_logs", "request_id", "request_id TEXT");
  ensureColumn(db, "audit_logs", "correlation_id", "correlation_id TEXT");
  ensureColumn(db, "audit_logs", "status", "status TEXT DEFAULT 'success'");
  ensureColumn(db, "audit_logs", "error_message", "error_message TEXT");
  ensureColumn(db, "audit_logs", "reason", "reason TEXT");
  ensureColumn(db, "audit_logs", "parent_event_id", "parent_event_id INTEGER");
  ensureColumn(db, "audit_logs", "event_type", "event_type TEXT");
  ensureColumn(db, "audit_logs", "changed_fields", "changed_fields TEXT");
  ensureColumn(db, "audit_logs", "before_values", "before_values TEXT");
  ensureColumn(db, "audit_logs", "after_values", "after_values TEXT");
  ensureColumn(db, "audit_logs", "related_json", "related_json TEXT");
  ensureColumn(db, "audit_logs", "device", "device TEXT");
  ensureColumn(db, "audit_logs", "duration_ms", "duration_ms INTEGER");
  ensureColumn(db, "audit_logs", "actor_type", "actor_type TEXT DEFAULT 'user'");
  ensureColumn(db, "audit_logs", "actor_ref", "actor_ref TEXT");
  ensureColumn(db, "audit_logs", "category", "category TEXT DEFAULT 'administration'");
  ensureColumn(db, "audit_logs", "security_classification", "security_classification TEXT DEFAULT 'internal'");
  ensureColumn(db, "audit_logs", "retention_category", "retention_category TEXT DEFAULT 'standard'");
  ensureColumn(db, "audit_logs", "session_id", "session_id TEXT");
  ensureColumn(db, "audit_logs", "object_revision", "object_revision TEXT");
  ensureColumn(db, "audit_logs", "related_resource_type", "related_resource_type TEXT");
  ensureColumn(db, "audit_logs", "related_resource_id", "related_resource_id TEXT");
  ensureColumn(db, "audit_logs", "failure_category", "failure_category TEXT");
  ensureColumn(db, "audit_policies", "categories_json", "categories_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "audit_policies", "export_allowed", "export_allowed INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "audit_policies", "system_mandatory", "system_mandatory INTEGER NOT NULL DEFAULT 0");
  for (const column of [
    "actor_type TEXT DEFAULT 'user'",
    "actor_ref TEXT",
    "category TEXT DEFAULT 'administration'",
    "security_classification TEXT DEFAULT 'internal'",
    "retention_category TEXT DEFAULT 'standard'",
    "session_id TEXT",
    "object_revision TEXT",
    "related_resource_type TEXT",
    "related_resource_id TEXT",
    "failure_category TEXT",
  ]) {
    ensureColumn(db, "audit_logs_archive", column.split(" ")[0], column);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_tenant_created ON audit_logs(tenant_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_actor_created ON audit_logs(actor_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_action_created ON audit_logs(action, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_logs(event_type, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_status_created ON audit_logs(status, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_logs(correlation_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_object_time ON audit_logs(resource_type, resource_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_source_created ON audit_logs(source, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_category_created ON audit_logs(category, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_actor_type_created ON audit_logs(actor_type, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_classification ON audit_logs(security_classification, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_related ON audit_logs(related_resource_type, related_resource_id, created_at)");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("012_audit");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("013_notifications");
  ensureColumn(db, "notification_providers", "tenant_id", "tenant_id INTEGER REFERENCES organizations(id)");
  ensureColumn(db, "notification_providers", "organization_id", "organization_id INTEGER REFERENCES organizations(id)");
  ensureColumn(db, "notification_providers", "is_default", "is_default INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "notification_providers", "priority", "priority INTEGER NOT NULL DEFAULT 100");
  ensureColumn(db, "notification_providers", "rate_limit_per_minute", "rate_limit_per_minute INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "notification_providers", "max_attempts", "max_attempts INTEGER NOT NULL DEFAULT 5");
  ensureColumn(db, "notification_providers", "backoff_seconds", "backoff_seconds INTEGER NOT NULL DEFAULT 30");
  ensureColumn(db, "notification_providers", "timeout_ms", "timeout_ms INTEGER NOT NULL DEFAULT 10000");
  ensureColumn(db, "notification_providers", "credential_ref", "credential_ref TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "notification_providers", "status", "status TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, "notification_providers", "last_tested_at", "last_tested_at TEXT");
  ensureColumn(db, "notification_providers", "last_test_status", "last_test_status TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "notification_providers", "last_test_message", "last_test_message TEXT NOT NULL DEFAULT ''");
  rebuildNotificationProvidersTypeCheck(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_notification_providers_tenant ON notification_providers(tenant_id, channel)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_notification_providers_default ON notification_providers(channel, is_default, priority)");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("014_delivery");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("015_jobs");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("016_job_engine");
  ensureColumn(db, "jobs", "execution_group", "execution_group TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "jobs", "schedule_id", "schedule_id INTEGER");
  ensureColumn(db, "jobs", "attempts", "attempts INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "jobs", "lease_owner", "lease_owner TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "jobs", "lease_expires_at", "lease_expires_at TEXT");
  ensureColumn(db, "jobs", "heartbeat_at", "heartbeat_at TEXT");
  ensureColumn(db, "jobs", "next_retry_at", "next_retry_at TEXT");
  ensureColumn(db, "jobs", "dead_lettered_at", "dead_lettered_at TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(status, lease_expires_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_heartbeat ON jobs(status, heartbeat_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_schedule ON jobs(schedule_id, created_at)");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("017_files");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("018_search");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("019_audit_framework");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("020_integration_framework");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("021_event_messaging_framework");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("022_numbering_service");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("023_effectivity_versioning_kernel");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("024_reference_data_management");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("025_content_management");
  // Search Foundation (canonical model): explicit field definitions, provider
  // configuration and richer searchable-object metadata. Additive only.
  for (const [column, ddl] of [
    ["index_name", "index_name TEXT NOT NULL DEFAULT ''"],
    ["identifier_field", "identifier_field TEXT NOT NULL DEFAULT 'id'"],
    ["searchable_fields_json", "searchable_fields_json TEXT NOT NULL DEFAULT '[]'"],
    ["sortable_fields_json", "sortable_fields_json TEXT NOT NULL DEFAULT '[]'"],
    ["facetable_fields_json", "facetable_fields_json TEXT NOT NULL DEFAULT '[]'"],
    ["display_fields_json", "display_fields_json TEXT NOT NULL DEFAULT '[]'"],
    ["relationship_fields_json", "relationship_fields_json TEXT NOT NULL DEFAULT '[]'"],
    ["security_policy", "security_policy TEXT NOT NULL DEFAULT 'tenant'"],
    ["indexing_strategy", "indexing_strategy TEXT NOT NULL DEFAULT 'event'"],
  ]) {
    ensureColumn(db, "search_object_types", column, ddl);
  }
  ensureColumn(db, "search_index", "site_id", "site_id INTEGER REFERENCES organizations(id)");
  ensureColumn(db, "search_index", "external_reference", "external_reference TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE INDEX IF NOT EXISTS idx_search_index_site ON search_index(tenant_id, site_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_search_index_external ON search_index(tenant_id, external_reference)");
  db.exec(`CREATE TABLE IF NOT EXISTS search_extracted_text (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES organizations(id),
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    content_id TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'content',
    language TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    text_length INTEGER NOT NULL DEFAULT 0,
    checksum TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (tenant_id, object_type, object_id, content_id)
  )`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_search_extracted_object ON search_extracted_text(tenant_id, object_type, object_id)"
  );
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("026_search_foundation");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("027_security_model");
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  ).run("028_data_governance_quality");
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

// Widens the notification_providers.type (and channel) CHECK constraint for
// databases created before the Communication & Delivery Services module added
// the Teams, Slack, SMS, push and additional email provider types. SQLite
// cannot ALTER a CHECK constraint, so the table is rebuilt and its rows copied,
// following the same safe pattern used for organizations.
function rebuildNotificationProvidersTypeCheck(db) {
  const row = queryOne(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_providers'");
  if (!row?.sql) return;
  if (!row.sql.includes("CHECK (type IN")) return;
  if (row.sql.includes("'custom'")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE notification_providers_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('in_app', 'email', 'sms', 'teams', 'slack', 'push', 'webhook')),
      type TEXT NOT NULL DEFAULT 'store'
        CHECK (type IN ('store', 'smtp', 'sendgrid', 'graph', 'webhook', 'ses', 'mailgun', 'postmark', 'teams', 'slack', 'twilio', 'fcm', 'custom')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      config_json TEXT NOT NULL DEFAULT '{}',
      secrets_enc TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      tenant_id INTEGER REFERENCES organizations(id),
      organization_id INTEGER REFERENCES organizations(id),
      is_default INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 100,
      rate_limit_per_minute INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      backoff_seconds INTEGER NOT NULL DEFAULT 30,
      timeout_ms INTEGER NOT NULL DEFAULT 10000,
      credential_ref TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      last_tested_at TEXT,
      last_test_status TEXT NOT NULL DEFAULT '',
      last_test_message TEXT NOT NULL DEFAULT ''
    );
  `);
  db.exec(`
    INSERT INTO notification_providers_new
      (id, code, name, channel, type, enabled, config_json, secrets_enc, created_at, updated_at,
       tenant_id, organization_id, is_default, priority, rate_limit_per_minute, max_attempts,
       backoff_seconds, timeout_ms, credential_ref, status, last_tested_at, last_test_status, last_test_message)
    SELECT id, code, name, channel, type, enabled, config_json, secrets_enc, created_at, updated_at,
       tenant_id, organization_id, is_default, priority, rate_limit_per_minute, max_attempts,
       backoff_seconds, timeout_ms, credential_ref, status, last_tested_at, last_test_status, last_test_message
    FROM notification_providers
  `);
  db.exec("DROP TABLE notification_providers");
  db.exec("ALTER TABLE notification_providers_new RENAME TO notification_providers");
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

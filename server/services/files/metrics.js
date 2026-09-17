import { queryAll, queryOne } from "../../db.js";
import { HttpError } from "../../validation.js";
import { checkPermission } from "../authorization.js";
import { isPlatformAdmin, assertTenantScope } from "../tenants.js";
import { assertTenant } from "./repository.js";
import { fileEventSummary } from "./events.js";

// Aggregated, tenant-scoped operational metrics for the Document module console.
// Counts and byte totals only; no storage keys or per-file content is exposed.

function assertMetricsAccess(db, actor, scope) {
  if (isPlatformAdmin(db, actor?.id)) return;
  const granted = checkPermission(db, actor, "iam.files.browser", "read", {}).allowed;
  if (!granted) throw new HttpError(403, "Not authorized to view file metrics");
}

export function fileMetrics(db, actor, tenantId) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  assertMetricsAccess(db, actor, scope);
  const base = "FROM files WHERE tenant_id = ? AND deleted_at IS NULL";
  const total = queryOne(db, `SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes ${base}`, [scope]);
  const deleted = queryOne(db, "SELECT COUNT(*) AS files FROM files WHERE tenant_id = ? AND deleted_at IS NOT NULL", [scope]);
  const versions = queryOne(
    db,
    "SELECT COUNT(*) AS versions FROM file_versions v JOIN files f ON f.id = v.file_id WHERE f.tenant_id = ?",
    [scope]
  );
  const byStatus = queryAll(db, `SELECT status AS key, COUNT(*) AS count ${base} GROUP BY status ORDER BY count DESC`, [scope]);
  const byCategory = queryAll(db, `SELECT file_category AS key, COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes ${base} GROUP BY file_category ORDER BY count DESC`, [scope]);
  const byClassification = queryAll(db, `SELECT security_classification AS key, COUNT(*) AS count ${base} GROUP BY security_classification ORDER BY count DESC`, [scope]);
  const scanStates = queryAll(db, `SELECT virus_scan_status AS key, COUNT(*) AS count ${base} GROUP BY virus_scan_status`, [scope]);
  const processing = queryAll(
    db,
    `SELECT processing_type, status, COUNT(*) AS count FROM file_processing WHERE tenant_id = ? GROUP BY processing_type, status`,
    [scope]
  );
  const uploads = queryAll(
    db,
    `SELECT status AS key, COUNT(*) AS count, COALESCE(SUM(declared_size),0) AS bytes
     FROM file_uploads WHERE tenant_id = ? GROUP BY status`,
    [scope]
  );
  const locks = queryOne(
    db,
    "SELECT COUNT(*) AS active FROM file_locks WHERE tenant_id = ? AND released_at IS NULL",
    [scope]
  );
  const associations = queryOne(
    db,
    "SELECT COUNT(*) AS total FROM file_associations WHERE tenant_id = ? AND deleted_at IS NULL",
    [scope]
  );
  const folders = queryOne(db, "SELECT COUNT(*) AS total FROM folders WHERE tenant_id = ? AND deleted_at IS NULL", [scope]);
  const collections = queryOne(db, "SELECT COUNT(*) AS total FROM file_collections WHERE tenant_id = ? AND deleted_at IS NULL", [scope]);
  const recent = queryAll(
    db,
    `SELECT f.id, f.file_ref, f.name, f.status, f.size_bytes, f.mime_type, f.created_at,
            u.username AS owner_username
     FROM files f LEFT JOIN users u ON u.id = f.owner_id
     WHERE f.tenant_id = ? AND f.deleted_at IS NULL
     ORDER BY f.created_at DESC, f.id DESC LIMIT 10`,
    [scope]
  ).map((row) => ({ ...row, owner_username: row.owner_username || "" }));

  return {
    tenant_id: scope,
    totals: {
      files: total.files,
      bytes: total.bytes,
      deleted_files: deleted.files,
      versions: versions.versions,
      folders: folders.total,
      collections: collections.total,
      associations: associations.total,
      active_locks: locks.active,
    },
    by_status: byStatus,
    by_category: byCategory,
    by_classification: byClassification,
    scan_states: scanStates,
    processing,
    uploads,
    recent_files: recent,
    events: fileEventSummary(db, scope),
  };
}

export function storageBreakdown(db, actor, tenantId) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  assertMetricsAccess(db, actor, scope);
  const byProvider = queryAll(
    db,
    `SELECT storage_provider AS provider, COUNT(*) AS files, COALESCE(SUM(size_bytes),0) AS bytes
     FROM files WHERE tenant_id = ? AND deleted_at IS NULL GROUP BY storage_provider`,
    [scope]
  );
  const byExtension = queryAll(
    db,
    `SELECT extension AS key, COUNT(*) AS files, COALESCE(SUM(size_bytes),0) AS bytes
     FROM files WHERE tenant_id = ? AND deleted_at IS NULL GROUP BY extension ORDER BY bytes DESC LIMIT 25`,
    [scope]
  );
  const largest = queryAll(
    db,
    `SELECT id, file_ref, name, size_bytes FROM files WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY size_bytes DESC LIMIT 10`,
    [scope]
  );
  return { by_provider: byProvider, by_extension: byExtension, largest_files: largest };
}

export function processingSummary(db, actor, tenantId) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  assertMetricsAccess(db, actor, scope);
  const pending = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM file_processing WHERE tenant_id = ? AND status IN ('pending','in_progress')",
    [scope]
  ).c;
  const failed = queryOne(db, "SELECT COUNT(*) AS c FROM file_processing WHERE tenant_id = ? AND status = 'failed'", [scope]).c;
  const quarantined = queryOne(db, "SELECT COUNT(*) AS c FROM files WHERE tenant_id = ? AND status = 'quarantined'", [scope]).c;
  const blocked = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM files WHERE tenant_id = ? AND status IN ('pending_scan','scan_in_progress','scan_failed')",
    [scope]
  ).c;
  return { pending, failed, quarantined, blocked };
}

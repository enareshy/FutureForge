import { queryAll, queryOne } from "../../db.js";

// Observability (spec §52). Metrics are derived from the module's own tables so
// no separate metrics store is needed. Callers may combine these with request
// logs; file contents are never logged.

function tenantClause(tenantId, alias = "") {
  if (tenantId === null || tenantId === undefined) return { clause: "", params: [] };
  const prefix = alias ? `${alias}.` : "";
  return { clause: `WHERE ${prefix}tenant_id = ?`, params: [Number(tenantId)] };
}

function count(db, table, tenantId, extra = "", extraParams = []) {
  const { clause, params } = tenantClause(tenantId);
  const conditions = [];
  if (extra) conditions.push(extra);
  const where = [clause.replace(/^WHERE /, ""), ...conditions].filter(Boolean).join(" AND ");
  const sql = `SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`;
  return queryOne(db, sql, [...params, ...extraParams])?.count ?? 0;
}

function eventCount(db, tenantId, types) {
  const placeholders = types.map(() => "?").join(", ");
  const { clause, params } = tenantClause(tenantId);
  const where = clause ? `${clause} AND event_type IN (${placeholders})` : `WHERE event_type IN (${placeholders})`;
  return queryOne(db, `SELECT COUNT(*) AS count FROM content_events ${where}`, [...params, ...types])?.count ?? 0;
}

function auditCount(db, tenantId, action) {
  const where = ["action = ?"];
  const params = [String(action)];
  if (tenantId !== null && tenantId !== undefined) {
    where.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  return queryOne(db, `SELECT COUNT(*) AS count FROM audit_logs WHERE ${where.join(" AND ")}`, params)?.count ?? 0;
}

export function contentMetrics(db, { tenantId = null } = {}) {
  const byStatus = queryAll(
    db,
    `SELECT status AS value, COUNT(*) AS count FROM content ${tenantClause(tenantId).clause} GROUP BY status ORDER BY count DESC`,
    tenantClause(tenantId).params
  );
  const bySecurity = queryAll(
    db,
    `SELECT security_status AS value, COUNT(*) AS count FROM content ${tenantClause(tenantId).clause} GROUP BY security_status ORDER BY count DESC`,
    tenantClause(tenantId).params
  );
  const byProcessing = queryAll(
    db,
    `SELECT processing_status AS value, COUNT(*) AS count FROM content ${tenantClause(tenantId).clause} GROUP BY processing_status ORDER BY count DESC`,
    tenantClause(tenantId).params
  );
  return {
    content_total: count(db, "content", tenantId),
    content_active: count(db, "content", tenantId, "deleted_at IS NULL"),
    upload_sessions_total: count(db, "content_upload_sessions", tenantId),
    upload_failure_count: count(db, "content_upload_sessions", tenantId, "status = 'failed'"),
    upload_count: count(db, "content", tenantId, "deleted_at IS NULL"),
    download_count: auditCount(db, tenantId, "content.downloaded"),
    checkout_count: eventCount(db, tenantId, ["ContentCheckedOut"]),
    checkin_count: eventCount(db, tenantId, ["ContentCheckedIn"]),
    virus_scan_count: count(db, "content_security_scans", tenantId),
    virus_detection_count: count(db, "content_security_scans", tenantId, "status = 'infected'"),
    quarantine_count: count(db, "content", tenantId, "status = 'quarantined'"),
    rendition_count: count(db, "content_renditions", tenantId),
    rendition_failure_count: count(db, "content_renditions", tenantId, "status = 'failed'"),
    storage_errors: count(db, "content_events", tenantId, "event_type = 'ContentUploadFailed'"),
    orphan_content_count: count(db, "content_storage_references", tenantId, "status = 'orphaned'"),
    retention_processing_count: eventCount(db, tenantId, ["ContentRetentionExpired"]),
    legal_hold_count: count(db, "content_legal_holds", tenantId, "status = 'active'"),
    by_status: byStatus,
    by_security_status: bySecurity,
    by_processing_status: byProcessing,
  };
}

export function storageSummary(db, { tenantId = null } = {}) {
  const { clause, params } = tenantClause(tenantId);
  const totals = queryOne(
    db,
    `SELECT COALESCE(SUM(file_size), 0) AS total_bytes, COUNT(*) AS objects, COUNT(DISTINCT checksum) AS distinct_checksums
     FROM content ${clause} ${clause ? "AND" : "WHERE"} deleted_at IS NULL`,
    params
  );
  const byProvider = queryAll(
    db,
    `SELECT storage_provider AS provider, COUNT(*) AS objects, COALESCE(SUM(file_size), 0) AS bytes
     FROM content ${clause} ${clause ? "AND" : "WHERE"} deleted_at IS NULL GROUP BY storage_provider`,
    params
  );
  const dedupeSavings = queryOne(
    db,
    `SELECT COALESCE(SUM(repeated_bytes), 0) AS bytes FROM (
       SELECT (COUNT(*) - 1) * MAX(file_size) AS repeated_bytes FROM content
       ${clause} ${clause ? "AND" : "WHERE"} deleted_at IS NULL GROUP BY checksum, file_size HAVING COUNT(*) > 1
     )`,
    params
  );
  return {
    total_bytes: Number(totals?.total_bytes || 0),
    object_count: Number(totals?.objects || 0),
    distinct_checksums: Number(totals?.distinct_checksums || 0),
    dedupe_savings_bytes: Number(dedupeSavings?.bytes || 0),
    by_provider: byProvider,
  };
}

export function securitySummary(db, { tenantId = null } = {}) {
  const { clause, params } = tenantClause(tenantId);
  const latest = queryAll(
    db,
    `SELECT status, COUNT(*) AS count FROM content_security_scans ${clause} GROUP BY status ORDER BY count DESC`,
    params
  );
  const infected = queryAll(
    db,
    `SELECT s.*, c.content_key, c.file_name FROM content_security_scans s
     LEFT JOIN content c ON c.id = s.content_id
     ${clause ? "WHERE s.tenant_id = ?" : ""} ${clause ? "AND" : "WHERE"} s.status = 'infected'
     ORDER BY s.created_at DESC LIMIT 25`,
    params
  );
  return { by_status: latest, recent_infections: infected.map((row) => ({ id: row.id, content_id: row.content_id, content_key: row.content_key, file_name: row.file_name, scanner: row.scanner, signature: row.signature, created_at: row.created_at })) };
}

export function processingSummary(db, { tenantId = null } = {}) {
  const { clause, params } = tenantClause(tenantId);
  const jobs = queryAll(
    db,
    `SELECT job_type, status, COUNT(*) AS count FROM content_processing_jobs ${clause} GROUP BY job_type, status`,
    params
  );
  const renditions = queryAll(
    db,
    `SELECT rendition_type, status, COUNT(*) AS count FROM content_renditions ${clause} GROUP BY rendition_type, status`,
    params
  );
  return { jobs, renditions };
}

export function metricsSnapshot(db, { tenantId = null } = {}) {
  return {
    metrics: contentMetrics(db, { tenantId }),
    storage: storageSummary(db, { tenantId }),
    security: securitySummary(db, { tenantId }),
    processing: processingSummary(db, { tenantId }),
    generated_at: new Date().toISOString(),
  };
}

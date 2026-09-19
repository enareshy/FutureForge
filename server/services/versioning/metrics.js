// Observability for the Effectivity & Versioning Kernel: metrics, health and the
// administration dashboard summary. Pure read-only aggregation.
import { queryAll, queryOne } from "../../db.js";

function tenantFilter(tenantId, alias = "") {
  if (tenantId === null || tenantId === undefined) return { clause: "", params: [] };
  const prefix = alias ? `${alias}.` : "";
  return {
    clause: ` AND (${prefix}tenant_id IS NULL OR ${prefix}tenant_id = ?)`,
    params: [Number(tenantId)],
  };
}

export function metricsSnapshot(db, { tenantId = null, from = null, to = null } = {}) {
  const filter = tenantFilter(tenantId);
  const rangeClauses = [];
  const rangeParams = [];
  if (from) {
    rangeClauses.push("created_at >= ?");
    rangeParams.push(String(from));
  }
  if (to) {
    rangeClauses.push("created_at <= ?");
    rangeParams.push(String(to));
  }
  const range = rangeClauses.length ? ` AND ${rangeClauses.join(" AND ")}` : "";
  const resolution = queryOne(
    db,
    `SELECT
       COUNT(*) AS requests,
       SUM(CASE WHEN status = 'RESOLVED' THEN 1 ELSE 0 END) AS success,
       SUM(CASE WHEN status != 'RESOLVED' THEN 1 ELSE 0 END) AS failure,
       SUM(CASE WHEN status = 'AMBIGUOUS' THEN 1 ELSE 0 END) AS ambiguous,
       SUM(CASE WHEN status = 'CONFLICT' THEN 1 ELSE 0 END) AS conflicts,
       SUM(CASE WHEN status = 'NOT_FOUND' THEN 1 ELSE 0 END) AS not_found,
       SUM(CASE WHEN status = 'INVALID_CONTEXT' THEN 1 ELSE 0 END) AS invalid_context,
       AVG(duration_ms) AS avg_latency,
       MAX(duration_ms) AS max_latency
     FROM versioning_resolution_results
     WHERE 1 = 1${filter.clause}${range}`,
    [...filter.params, ...rangeParams]
  );
  const revisions = queryOne(
    db,
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
       SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded
     FROM versioning_revisions WHERE 1 = 1${filter.clause}`,
    filter.params
  );
  const versions = queryOne(
    db,
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM versioning_versions WHERE 1 = 1${filter.clause}`,
    filter.params
  );
  const baselines = queryOne(
    db,
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'frozen' THEN 1 ELSE 0 END) AS frozen FROM versioning_baselines WHERE 1 = 1${filter.clause}`,
    filter.params
  );
  const snapshots = queryOne(db, `SELECT COUNT(*) AS total FROM versioning_snapshots WHERE 1 = 1${filter.clause}`, filter.params);
  const effectivities = queryOne(
    db,
    `SELECT COUNT(*) AS total FROM versioning_effectivity_definitions WHERE 1 = 1${filter.clause}`,
    filter.params
  );
  const avg = resolution?.avg_latency;
  return {
    resolution_requests: Number(resolution?.requests ?? 0),
    resolution_success: Number(resolution?.success ?? 0),
    resolution_failure: Number(resolution?.failure ?? 0),
    ambiguous_resolutions: Number(resolution?.ambiguous ?? 0),
    effectivity_conflicts: Number(resolution?.conflicts ?? 0),
    resolution_not_found: Number(resolution?.not_found ?? 0),
    resolution_invalid_context: Number(resolution?.invalid_context ?? 0),
    resolution_latency: {
      average_ms: avg === null || avg === undefined ? null : Math.round(Number(avg) * 100) / 100,
      max_ms: resolution?.max_latency ?? null,
    },
    revision_creation_count: Number(revisions?.total ?? 0),
    revision_active_count: Number(revisions?.active ?? 0),
    version_creation_count: Number(versions?.total ?? 0),
    version_active_count: Number(versions?.active ?? 0),
    baseline_count: Number(baselines?.total ?? 0),
    baseline_frozen_count: Number(baselines?.frozen ?? 0),
    snapshot_count: Number(snapshots?.total ?? 0),
    effectivity_definition_count: Number(effectivities?.total ?? 0),
  };
}

export function healthCheck(db, { tenantId = null } = {}) {
  let metrics = null;
  let healthy = true;
  let error = null;
  try {
    metrics = metricsSnapshot(db, { tenantId });
  } catch (err) {
    healthy = false;
    error = err.message;
  }
  const ambiguous = metrics?.ambiguous_resolutions ?? 0;
  const conflicts = metrics?.effectivity_conflicts ?? 0;
  return {
    status: healthy ? (ambiguous + conflicts > 0 ? "degraded" : "ok") : "unhealthy",
    service: "versioning",
    ready: healthy,
    live: true,
    healthy,
    ambiguous_resolutions: ambiguous,
    effectivity_conflicts: conflicts,
    error,
    metrics,
    timestamp: new Date().toISOString(),
  };
}

export function dashboardSummary(db, { tenantId = null, from = null, to = null } = {}) {
  const metrics = metricsSnapshot(db, { tenantId, from, to });
  const filter = tenantFilter(tenantId);
  const recentResolutions = queryAll(
    db,
    `SELECT * FROM versioning_resolution_results WHERE 1 = 1${filter.clause} ORDER BY created_at DESC, id DESC LIMIT 10`,
    filter.params
  ).map((row) => ({
    id: row.id,
    object_type: row.object_type,
    object_id: row.object_id,
    status: row.status,
    revision_id: row.revision_id,
    version_id: row.version_id,
    reason: row.resolution_reason,
    at: row.created_at,
  }));
  const upcoming = queryAll(
    db,
    `SELECT revision_ref, object_type, object_id, revision_code, effective_from FROM versioning_revisions
     WHERE effective_from IS NOT NULL AND effective_from > date('now') AND status != 'archived'${filter.clause}
     ORDER BY effective_from LIMIT 10`,
    filter.params
  ).map((row) => ({
    revision_ref: row.revision_ref,
    object_type: row.object_type,
    object_id: row.object_id,
    revision_code: row.revision_code,
    effective_from: row.effective_from,
  }));
  const expired = queryAll(
    db,
    `SELECT revision_ref, object_type, object_id, revision_code, effective_to FROM versioning_revisions
     WHERE effective_to IS NOT NULL AND effective_to < date('now') AND status != 'archived'${filter.clause}
     ORDER BY effective_to DESC LIMIT 10`,
    filter.params
  ).map((row) => ({
    revision_ref: row.revision_ref,
    object_type: row.object_type,
    object_id: row.object_id,
    revision_code: row.revision_code,
    effective_to: row.effective_to,
  }));
  const openEnded = queryAll(
    db,
    `SELECT revision_ref, object_type, object_id, revision_code, effective_from FROM versioning_revisions
     WHERE (effective_to IS NULL OR effective_to = '') AND status = 'active'${filter.clause}
     ORDER BY effective_from LIMIT 10`,
    filter.params
  ).map((row) => ({
    revision_ref: row.revision_ref,
    object_type: row.object_type,
    object_id: row.object_id,
    revision_code: row.revision_code,
    effective_from: row.effective_from,
  }));
  const revisionsByStatus = queryAll(
    db,
    `SELECT status, COUNT(*) AS count FROM versioning_revisions WHERE 1 = 1${filter.clause} GROUP BY status`,
    filter.params
  );
  return {
    metrics,
    recent_resolutions: recentResolutions,
    upcoming,
    expired,
    open_ended: openEnded,
    revisions_by_status: revisionsByStatus,
  };
}

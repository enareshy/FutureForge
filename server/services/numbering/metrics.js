// Observability for the Numbering Service: health endpoints, metrics and the
// administration dashboard summary. Pure read-only aggregation.
import { queryAll, queryOne } from "../../db.js";
import { metricsSnapshot } from "./allocations.js";

export function healthCheck(db, { tenantId = null } = {}) {
  let metrics = null;
  let healthy = true;
  let error = null;
  try {
    metrics = metricsSnapshot(db, { tenantId });
  } catch (err) {
    healthy = false;
    error = err.message;
    metrics = null;
  }
  const exhausted = metrics?.sequences?.exhausted ?? 0;
  const expired = metrics?.expired_reservations ?? 0;
  return {
    status: healthy ? (exhausted > 0 ? "degraded" : "ok") : "unhealthy",
    service: "numbering",
    ready: healthy,
    live: true,
    healthy,
    exhausted_sequences: exhausted,
    expired_reservations: expired,
    error,
    metrics,
    timestamp: new Date().toISOString(),
  };
}

export function dashboardSummary(db, { tenantId = null, from = null, to = null } = {}) {
  const metrics = metricsSnapshot(db, { tenantId, from, to });
  const tenantClause = tenantId === null || tenantId === undefined ? "" : "WHERE (s.tenant_id IS NULL OR s.tenant_id = ?)";
  const params = tenantId === null || tenantId === undefined ? [] : [Number(tenantId)];
  const sequences = queryAll(
    db,
    `SELECT s.*, sc.code AS scheme_code, sc.name AS scheme_name, sc.object_type_code
     FROM numbering_sequences s
     LEFT JOIN numbering_schemes sc ON sc.id = s.scheme_id
     ${tenantClause}
     ORDER BY s.allocated_count DESC, s.updated_at DESC LIMIT 10`,
    params
  ).map((row) => {
    const next = Number(row.current_value) + Number(row.increment);
    const remaining = Number(row.max_value) - Number(row.current_value);
    return {
      id: row.id,
      scheme_code: row.scheme_code,
      object_type: row.object_type_code,
      scope_key: row.scope_key,
      period_key: row.period_key,
      status: row.status,
      current_value: row.current_value,
      next_value: next,
      padding: row.padding,
      allocated_count: row.allocated_count,
      remaining: remaining >= 0 ? Math.floor(remaining / Number(row.increment || 1)) : 0,
    };
  });
  const schemesByStatus = queryAll(
    db,
    `SELECT status, COUNT(*) AS count FROM numbering_schemes
     ${tenantId === null || tenantId === undefined ? "" : "WHERE (tenant_id IS NULL OR tenant_id = ?)"}
     GROUP BY status`,
    params
  );
  const recent = queryAll(
    db,
    `SELECT * FROM numbering_allocations
     ${tenantId === null || tenantId === undefined ? "" : "WHERE (tenant_id IS NULL OR tenant_id = ?)"}
     ORDER BY requested_at DESC, id DESC LIMIT 10`,
    params
  ).map((row) => ({
    id: row.id,
    number: row.number,
    object_type: row.object_type_code,
    object_id: row.object_id,
    status: row.status,
    requested_at: row.requested_at,
    scheme_id: row.scheme_id,
  }));
  return { metrics, sequences, schemes_by_status: schemesByStatus, recent_allocations: recent };
}

export function generationLatency(db, { tenantId = null } = {}) {
  const params = [];
  let clause = "";
  if (tenantId !== null && tenantId !== undefined) {
    clause = "AND (tenant_id IS NULL OR tenant_id = ?)";
    params.push(Number(tenantId));
  }
  const row = queryOne(
    db,
    `SELECT COUNT(*) AS samples,
            AVG(duration_ms) AS avg_ms,
            MAX(duration_ms) AS max_ms,
            MIN(duration_ms) AS min_ms
     FROM audit_logs
     WHERE action LIKE 'numbering.allocation.%' AND duration_ms IS NOT NULL ${clause}`,
    params
  );
  return {
    samples: row?.samples ?? 0,
    average_ms: row?.avg_ms !== null && row?.avg_ms !== undefined ? Math.round(Number(row.avg_ms) * 100) / 100 : null,
    max_ms: row?.max_ms ?? null,
    min_ms: row?.min_ms ?? null,
  };
}

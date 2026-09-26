// Execution and change history (§34, §28).
//
// Every report/dashboard/KPI execution and every administrative change is
// recorded so usage tracking, auditing and observability have a durable trail.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { paged, parseJson, publicExecution } from "./repository.js";

export function recordExecution(db, execution = {}) {
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reporting_executions (execution_ref, tenant_id, report_id, report_code, dashboard_id, kpi_id, mode, status, user_id, parameters_json, query_json, result_json, row_count, duration_ms, cache_hit, error_code, error_message, correlation_id, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      execution.execution_ref || null,
      Number(execution.tenantId),
      execution.report_id ?? null,
      execution.report_code || "",
      execution.dashboard_id ?? null,
      execution.kpi_id ?? null,
      execution.mode || "EXECUTE",
      execution.status || "COMPLETED",
      execution.user_id ?? null,
      JSON.stringify(execution.parameters || {}),
      JSON.stringify(execution.query || {}),
      JSON.stringify(execution.result || {}),
      execution.row_count ?? null,
      execution.duration_ms ?? null,
      execution.cache_hit ? 1 : 0,
      execution.error_code || "",
      execution.error_message || "",
      execution.correlation_id || "",
      execution.started_at || ts,
      execution.finished_at || ts,
      ts,
    ]
  );
  return Number(result.lastInsertRowid);
}

export function listExecutions(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.mode) {
    where.push("mode = ?");
    params.push(String(query.mode).toUpperCase());
  }
  if (query.report_code || query.reportCode) {
    where.push("report_code = ?");
    params.push(String(query.report_code || query.reportCode));
  }
  return paged(db, "reporting_executions", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicExecution });
}

export function getExecution(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM reporting_executions WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM reporting_executions WHERE tenant_id = ? AND execution_ref = ?", [Number(tenantId), raw]);
  return publicExecution(row);
}

export function executionSummary(db, tenantId) {
  const tenant = Number(tenantId);
  const byStatus = queryAll(db, "SELECT status, COUNT(*) AS c FROM reporting_executions WHERE tenant_id = ? GROUP BY status", [tenant]);
  const byMode = queryAll(db, "SELECT mode, COUNT(*) AS c FROM reporting_executions WHERE tenant_id = ? GROUP BY mode", [tenant]);
  const timing = queryOne(db, "SELECT AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms, SUM(cache_hit) AS cache_hits, COUNT(*) AS runs FROM reporting_executions WHERE tenant_id = ?", [tenant]);
  return {
    total: Number(timing?.runs || 0),
    by_status: Object.fromEntries(byStatus.map((row) => [row.status, Number(row.c)])),
    by_mode: Object.fromEntries(byMode.map((row) => [row.mode, Number(row.c)])),
    avg_duration_ms: timing?.avg_ms ? Math.round(Number(timing.avg_ms)) : 0,
    max_duration_ms: Number(timing?.max_ms || 0),
    cache_hits: Number(timing?.cache_hits || 0),
    source_module: "reporting",
  };
}

export function recordHistory(db, entry = {}) {
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reporting_history (tenant_id, action, entity_type, entity_id, entity_ref, actor_id, summary, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(entry.tenantId),
      entry.action,
      entry.entity_type || "report",
      entry.entity_id != null ? String(entry.entity_id) : "",
      entry.entity_ref || "",
      entry.actor_id ?? null,
      entry.summary || "",
      JSON.stringify(entry.detail || {}),
      ts,
    ]
  );
  return Number(result.lastInsertRowid);
}

export function listHistory(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.entity_type || query.entityType) {
    where.push("entity_type = ?");
    params.push(String(query.entity_type || query.entityType));
  }
  if (query.entity_ref || query.entityRef) {
    where.push("entity_ref = ?");
    params.push(String(query.entity_ref || query.entityRef));
  }
  const result = paged(db, "reporting_history", { where, params, page: query.page, pageSize: query.page_size || query.pageSize });
  result.items = result.items.map((row) => ({ ...row, detail: parseJson(row.detail_json, {}) }));
  return result;
}

export function pruneHistory(db, tenantId, retentionDays) {
  const cutoff = new Date(Date.now() - Math.max(1, Number(retentionDays) || 180) * 24 * 60 * 60 * 1000).toISOString();
  const executions = run(db, "DELETE FROM reporting_executions WHERE tenant_id = ? AND created_at < ?", [Number(tenantId), cutoff]).changes || 0;
  const history = run(db, "DELETE FROM reporting_history WHERE tenant_id = ? AND created_at < ?", [Number(tenantId), cutoff]).changes || 0;
  return { executions, history };
}

// Migration statistics & operational metrics.
//
// Every run appends an immutable statistics snapshot; the metrics endpoint
// aggregates them so operators can watch progress across a large onboarding
// (spec §23).
import { queryAll, queryOne, run } from "../../db.js";
import { SOURCE_MODULE } from "./constants.js";
import { publicStatistic } from "./repository.js";
import { paginate } from "./validation.js";

export function recordJobStatistics(db, { tenantId, jobId, packageId = null, projectId = null, snapshot = {} } = {}) {
  const result = run(
    db,
    "INSERT INTO mig_statistics (tenant_id, job_id, package_id, project_id, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [Number(tenantId), jobId != null ? Number(jobId) : null, packageId != null ? Number(packageId) : null, projectId != null ? Number(projectId) : null, JSON.stringify(snapshot || {}), new Date().toISOString()]
  );
  return Number(result.lastInsertRowid);
}

export function listStatistics(db, { tenantId, jobId, projectId, packageId, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (jobId != null) {
    clauses.push("job_id = ?");
    params.push(Number(jobId));
  }
  if (projectId != null) {
    clauses.push("project_id = ?");
    params.push(Number(projectId));
  }
  if (packageId != null) {
    clauses.push("package_id = ?");
    params.push(Number(packageId));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_statistics ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_statistics ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicStatistic), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

function count(db, sql, params = []) {
  return Number(queryOne(db, sql, params)?.c || 0);
}

export function metricsSnapshot(db, { tenantId } = {}) {
  const tenant = Number(tenantId);
  const jobStatuses = queryAll(db, "SELECT status, COUNT(*) AS c FROM mig_jobs WHERE tenant_id = ? GROUP BY status", [tenant]);
  const byMode = queryAll(db, "SELECT mode, COUNT(*) AS c FROM mig_jobs WHERE tenant_id = ? GROUP BY mode", [tenant]);
  const errorsByCategory = queryAll(db, "SELECT category, COUNT(*) AS c FROM mig_errors WHERE tenant_id = ? AND status IN ('OPEN','RETRYING') GROUP BY category", [tenant]);
  const reconciliation = queryOne(
    db,
    "SELECT COUNT(*) AS c, COALESCE(SUM(variance),0) AS variance FROM mig_reconciliations WHERE tenant_id = ? AND status = 'VARIANCE'",
    [tenant]
  );
  return {
    source_module: SOURCE_MODULE,
    generated_at: new Date().toISOString(),
    projects: count(db, "SELECT COUNT(*) AS c FROM mig_projects WHERE tenant_id = ?", [tenant]),
    packages: count(db, "SELECT COUNT(*) AS c FROM mig_packages WHERE tenant_id = ?", [tenant]),
    definitions: count(db, "SELECT COUNT(*) AS c FROM mig_definitions WHERE tenant_id = ?", [tenant]),
    source_configurations: count(db, "SELECT COUNT(*) AS c FROM mig_source_configurations WHERE tenant_id = ?", [tenant]),
    jobs_by_status: Object.fromEntries(jobStatuses.map((row) => [row.status, Number(row.c)])),
    jobs_by_mode: Object.fromEntries(byMode.map((row) => [row.mode, Number(row.c)])),
    object_results: count(db, "SELECT COUNT(*) AS c FROM mig_object_results WHERE tenant_id = ?", [tenant]),
    open_errors: count(db, "SELECT COUNT(*) AS c FROM mig_errors WHERE tenant_id = ? AND status IN ('OPEN','RETRYING')", [tenant]),
    open_errors_by_category: Object.fromEntries(errorsByCategory.map((row) => [row.category, Number(row.c)])),
    identifier_mappings: count(db, "SELECT COUNT(*) AS c FROM mig_identifier_mappings WHERE tenant_id = ?", [tenant]),
    relationship_mappings: count(db, "SELECT COUNT(*) AS c FROM mig_relationship_mappings WHERE tenant_id = ?", [tenant]),
    files: count(db, "SELECT COUNT(*) AS c FROM mig_file_migrations WHERE tenant_id = ?", [tenant]),
    reconciliations_with_variance: Number(reconciliation?.c || 0),
    total_variance: Number(reconciliation?.variance || 0),
    audit_entries: count(db, "SELECT COUNT(*) AS c FROM mig_audit WHERE tenant_id = ?", [tenant]),
  };
}

export function healthCheck(db, { tenantId } = {}) {
  const tenant = Number(tenantId);
  const tables = ["mig_projects", "mig_packages", "mig_definitions", "mig_jobs", "mig_source_configurations", "mig_audit"];
  const checks = tables.map((table) => {
    try {
      count(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [tenant]);
      return { name: table, status: "ok" };
    } catch (error) {
      return { name: table, status: "error", message: error.message };
    }
  });
  const healthy = checks.every((check) => check.status === "ok");
  return { status: healthy ? "healthy" : "degraded", source_module: SOURCE_MODULE, checks };
}

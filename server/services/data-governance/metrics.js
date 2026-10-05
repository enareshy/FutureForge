// Operational metrics for the governance and quality estate. Figures are always
// tenant scoped so dashboards cannot leak across tenants.
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { scoreSummary, domainScores, typeScores, scoreSummaryAsync, domainScoresAsync, typeScoresAsync } from "./results.js";
import { exceptionSummary, exceptionSummaryAsync } from "./exceptions.js";
import { duplicateSummary, duplicateSummaryAsync } from "./duplicates.js";
import { remediationSummary, remediationSummaryAsync } from "./remediation.js";
import { listDimensions, listDimensionsAsync } from "./dimensions.js";
import { listRules } from "./rules.js";
import { listPolicies } from "./policies.js";

export function metricsSnapshot(db, { tenantId } = {}) {
  const counters = {};
  const count = (table, where = "", params = []) =>
    Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} ${where ? `WHERE ${where}` : ""}`, params)?.c ?? 0);
  counters.domains = count("dg_domains", "tenant_id = ?", [Number(tenantId)]);
  counters.catalog_objects = count("dg_catalog_objects", "tenant_id = ?", [Number(tenantId)]);
  counters.policies = count("dg_policies", "tenant_id = ?", [Number(tenantId)]);
  counters.rules = count("dg_rules", "tenant_id = ?", [Number(tenantId)]);
  counters.active_rules = count("dg_rules", "tenant_id = ? AND status = 'active'", [Number(tenantId)]);
  counters.results = count("dg_quality_results", "tenant_id = ? AND is_current = 1", [Number(tenantId)]);
  counters.violations = count("dg_quality_violations", "tenant_id = ? AND is_current = 1", [Number(tenantId)]);
  counters.exceptions_open = count(
    "dg_quality_exceptions",
    "tenant_id = ? AND status IN ('OPEN','ASSIGNED','IN_PROGRESS')",
    [Number(tenantId)]
  );
  counters.duplicate_candidates_open = count("dg_duplicate_candidates", "tenant_id = ? AND status IN ('OPEN','REVIEWING')", [Number(tenantId)]);
  counters.remediations = count("dg_remediations", "tenant_id = ?", [Number(tenantId)]);

  return {
    counters,
    quality: scoreSummary(db, { tenantId }),
    domains: domainScores(db, { tenantId }),
    object_types: typeScores(db, { tenantId }),
    exceptions: exceptionSummary(db, { tenantId }),
    duplicates: duplicateSummary(db, { tenantId }),
    remediations: remediationSummary(db, { tenantId }),
    dimensions: listDimensions(db, tenantId),
    generated_at: new Date().toISOString(),
  };
}

export async function metricsSnapshotAsync(db, { tenantId } = {}) {
  const counters = {};
  const count = async (table, where = "", params = []) =>
    Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM ${table} ${where ? `WHERE ${where}` : ""}`, params))?.c ?? 0);
  counters.domains = await count("dg_domains", "tenant_id = ?", [Number(tenantId)]);
  counters.catalog_objects = await count("dg_catalog_objects", "tenant_id = ?", [Number(tenantId)]);
  counters.policies = await count("dg_policies", "tenant_id = ?", [Number(tenantId)]);
  counters.rules = await count("dg_rules", "tenant_id = ?", [Number(tenantId)]);
  counters.active_rules = await count("dg_rules", "tenant_id = ? AND status = 'active'", [Number(tenantId)]);
  counters.results = await count("dg_quality_results", "tenant_id = ? AND is_current = 1", [Number(tenantId)]);
  counters.violations = await count("dg_quality_violations", "tenant_id = ? AND is_current = 1", [Number(tenantId)]);
  counters.exceptions_open = await count(
    "dg_quality_exceptions",
    "tenant_id = ? AND status IN ('OPEN','ASSIGNED','IN_PROGRESS')",
    [Number(tenantId)]
  );
  counters.duplicate_candidates_open = await count("dg_duplicate_candidates", "tenant_id = ? AND status IN ('OPEN','REVIEWING')", [Number(tenantId)]);
  counters.remediations = await count("dg_remediations", "tenant_id = ?", [Number(tenantId)]);

  return {
    counters,
    quality: await scoreSummaryAsync(db, { tenantId }),
    domains: await domainScoresAsync(db, { tenantId }),
    object_types: await typeScoresAsync(db, { tenantId }),
    exceptions: await exceptionSummaryAsync(db, { tenantId }),
    duplicates: await duplicateSummaryAsync(db, { tenantId }),
    remediations: await remediationSummaryAsync(db, { tenantId }),
    dimensions: await listDimensionsAsync(db, tenantId),
    generated_at: new Date().toISOString(),
  };
}

export function healthCheck(db, { tenantId } = {}) {
  const checks = [];
  const add = (name, ok, detail = null) => checks.push({ name, status: ok ? "ok" : "degraded", detail });
  try {
    add("domains", true, { count: Number(queryOne(db, "SELECT COUNT(*) AS c FROM dg_domains WHERE tenant_id = ?", [Number(tenantId)])?.c ?? 0) });
    const catalog = Number(queryOne(db, "SELECT COUNT(*) AS c FROM dg_catalog_objects WHERE tenant_id = ?", [Number(tenantId)])?.c ?? 0);
    const rules = Number(queryOne(db, "SELECT COUNT(*) AS c FROM dg_rules WHERE tenant_id = ? AND status = 'active'", [Number(tenantId)])?.c ?? 0);
    add("rules", true, { catalog_objects: catalog, active_rules: rules });
    const orphanResults = Number(
      queryOne(
        db,
        `SELECT COUNT(*) AS c FROM dg_quality_results r LEFT JOIN dg_catalog_objects c ON c.object_type = r.object_type AND c.tenant_id = r.tenant_id WHERE r.tenant_id = ? AND c.id IS NULL`,
        [Number(tenantId)]
      )?.c ?? 0
    );
    add("unregistered_object_types_with_results", orphanResults === 0, { orphan_results: orphanResults });
    const queuedJobs = Number(queryOne(db, "SELECT COUNT(*) AS c FROM dg_quality_jobs WHERE tenant_id = ? AND status = 'running'", [Number(tenantId)])?.c ?? 0);
    add("running_quality_jobs", true, { running: queuedJobs });
    return { status: checks.every((check) => check.status === "ok") ? "healthy" : "degraded", checks };
  } catch (error) {
    checks.push({ name: "database", status: "unhealthy", detail: error.message });
    return { status: "unhealthy", checks };
  }
}

export async function healthCheckAsync(db, { tenantId } = {}) {
  const checks = [];
  const add = (name, ok, detail = null) => checks.push({ name, status: ok ? "ok" : "degraded", detail });
  try {
    add("domains", true, { count: Number((await queryOneAsync(db, "SELECT COUNT(*) AS c FROM dg_domains WHERE tenant_id = ?", [Number(tenantId)]))?.c ?? 0) });
    const catalog = Number((await queryOneAsync(db, "SELECT COUNT(*) AS c FROM dg_catalog_objects WHERE tenant_id = ?", [Number(tenantId)]))?.c ?? 0);
    const rules = Number((await queryOneAsync(db, "SELECT COUNT(*) AS c FROM dg_rules WHERE tenant_id = ? AND status = 'active'", [Number(tenantId)]))?.c ?? 0);
    add("rules", true, { catalog_objects: catalog, active_rules: rules });
    const orphanResults = Number(
      (await queryOneAsync(
        db,
        `SELECT COUNT(*) AS c FROM dg_quality_results r LEFT JOIN dg_catalog_objects c ON c.object_type = r.object_type AND c.tenant_id = r.tenant_id WHERE r.tenant_id = ? AND c.id IS NULL`,
        [Number(tenantId)]
      ))?.c ?? 0
    );
    add("unregistered_object_types_with_results", orphanResults === 0, { orphan_results: orphanResults });
    const queuedJobs = Number((await queryOneAsync(db, "SELECT COUNT(*) AS c FROM dg_quality_jobs WHERE tenant_id = ? AND status = 'running'", [Number(tenantId)]))?.c ?? 0);
    add("running_quality_jobs", true, { running: queuedJobs });
    return { status: checks.every((check) => check.status === "ok") ? "healthy" : "degraded", checks };
  } catch (error) {
    checks.push({ name: "database", status: "unhealthy", detail: error.message });
    return { status: "unhealthy", checks };
  }
}

export function listQualityJobRuns(db, { tenantId, limit = 50 } = {}) {
  return queryAll(
    db,
    "SELECT * FROM dg_quality_jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?",
    [Number(tenantId), Number(limit) || 50]
  );
}

export async function listQualityJobRunsAsync(db, { tenantId, limit = 50 } = {}) {
  return await queryAllAsync(
    db,
    "SELECT * FROM dg_quality_jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?",
    [Number(tenantId), Number(limit) || 50]
  );
}

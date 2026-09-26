// Migration planning & readiness.
//
// A plan is a deterministic, dependency-aware execution order for a project's
// packages, together with per-package readiness: definition completeness,
// dependency satisfaction, source configuration and validation status. The plan
// is stored so an operator can review and approve exactly what will run
// (spec §11, §14).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";
import { planNotFound, invalidPlan, planBlocked } from "./errors.js";
import { planRef as makePlanRef } from "./refs.js";
import { publicPlan, publicPlanStep } from "./repository.js";
import { normalizeText, parseObject, parseArray, parseJson, paginate, assertPlanStatus } from "./validation.js";
import { topologicalOrder, resolveDependencies } from "./dependencies.js";

export function getPlanRow(db, tenantId, ref) {
  return queryOne(
    db,
    "SELECT * FROM mig_plans WHERE tenant_id = ? AND (plan_ref = ? OR CAST(id AS TEXT) = ?)",
    [Number(tenantId), String(ref), String(ref)]
  );
}

// Evaluates one package's readiness without writing anything.
export function evaluatePackageReadiness(db, tenantId, packageRow) {
  const checks = [];
  const packageMappingJson = parseJson(packageRow.mapping_json, null);
  const mappingsValue = Array.isArray(packageMappingJson)
    ? packageMappingJson
    : packageMappingJson && typeof packageMappingJson === "object"
      ? parseArray(packageMappingJson.mappings, [])
      : [];
  const hasTarget = Boolean(normalizeText(packageRow.target_object_type, { max: 120 }));
  const hasSource = Boolean(Object.keys(parseObject(packageRow.source_json, {})).length);
  checks.push({ code: "target_object_type", passed: hasTarget, message: hasTarget ? "Target object type is set" : "No target object type is configured" });
  checks.push({ code: "mappings", passed: mappingsValue.length > 0, message: mappingsValue.length ? `${mappingsValue.length} mapping(s) configured` : "No field mappings are configured" });
  checks.push({ code: "source", passed: hasSource, message: hasSource ? "A source is configured" : "No source configuration is present" });

  const resolution = resolveDependencies(db, tenantId, packageRow.id);
  const requiredBlocking = resolution.blocking.filter((dependency) => dependency.dependency_type !== "EXTERNAL");
  checks.push({
    code: "dependencies",
    passed: requiredBlocking.length === 0,
    message: requiredBlocking.length ? `${requiredBlocking.length} required dependency(ies) are not satisfied` : "All required dependencies are satisfied",
    blocking: requiredBlocking.map((dependency) => dependency.target_code || dependency.target_ref || "missing"),
  });

  const failures = checks.filter((check) => !check.passed);
  let readiness = "ready";
  if (!hasTarget || !mappingsValue.length) readiness = "blocked";
  else if (requiredBlocking.length) readiness = "blocked";
  else if (!hasSource) readiness = "warning";
  else if (failures.length) readiness = "warning";
  return { package_id: packageRow.id, code: packageRow.code, readiness, checks, dependencies: resolution.dependencies };
}

// Generates a plan for a whole project, or for a single package when the
// project contains independent packages.
export function generatePlan(db, tenantId, projectRef, { actor = null, packageId = null, ip = null } = {}) {
  const tenant = Number(tenantId);
  const project = queryOne(
    db,
    "SELECT * FROM mig_projects WHERE tenant_id = ? AND (project_ref = ? OR CAST(id AS TEXT) = ? OR code = ?)",
    [tenant, String(projectRef), String(projectRef), normalizeText(projectRef, { max: 120 }).toUpperCase()]
  );
  if (!project) throw invalidPlan(`Project not found: ${projectRef}`, { ref: projectRef });

  const topology = topologicalOrder(db, tenant, project.id);
  let ordered = topology.order;
  if (packageId != null) ordered = ordered.filter((pkg) => Number(pkg.id) === Number(packageId));
  if (!ordered.length && !topology.hasCycle) throw invalidPlan("The project has no migration packages to plan");

  // topologicalOrder returns slim rows (id/code/status); readiness needs the full
  // package row (source, mappings, target object type), so re-hydrate here.
  const hydrated = ordered.map((pkg) => queryOne(db, "SELECT * FROM mig_packages WHERE id = ?", [Number(pkg.id)])).filter(Boolean);
  const readiness = hydrated.map((pkg) => evaluatePackageReadiness(db, tenant, pkg));
  const blocked = readiness.filter((entry) => entry.readiness === "blocked");
  const status = topology.hasCycle ? "BLOCKED" : blocked.length ? "BLOCKED" : "READY";

  const summary = {
    package_count: ordered.length,
    ready_count: readiness.filter((entry) => entry.readiness === "ready").length,
    blocked_count: blocked.length,
    cycle_count: topology.cycles.length,
    cycles: topology.cycles,
    warning_count: readiness.filter((entry) => entry.readiness === "warning").length,
    stages: ["PACKAGE", "EXTRACT", "MAP", "TRANSFORM", "VALIDATE", "DEPENDENCY", "EXECUTE", "RECONCILE", "AUDIT"],
  };

  const result = run(
    db,
    `INSERT INTO mig_plans (plan_ref, tenant_id, project_id, package_id, status, summary_json, generated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [makePlanRef(project.code), tenant, project.id, packageId != null ? Number(packageId) : null, status, JSON.stringify(summary), actor?.id ?? null, nowIso(), nowIso()]
  );
  const planId = Number(result.lastInsertRowid);
  let sequence = 0;
  for (const entry of readiness) {
    const pkg = hydrated.find((candidate) => Number(candidate.id) === Number(entry.package_id));
    const statistics = parseObject(pkg.statistics_json, {});
    const estimated = Number(statistics.total_records || statistics.source_count || 0);
    run(
      db,
      `INSERT INTO mig_plan_steps (plan_id, tenant_id, sequence, package_id, package_code, dependency_json, estimated_records, estimated_duration_ms, validation_status, readiness, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        planId,
        tenant,
        sequence,
        pkg.id,
        pkg.code,
        JSON.stringify(entry.dependencies.map((dependency) => dependency.target_code || dependency.target_ref || "").filter(Boolean)),
        estimated,
        estimated * 5,
        entry.checks.find((check) => check.code === "mappings")?.passed ? "valid" : "invalid",
        entry.readiness,
        entry.readiness === "ready" ? "ready" : "blocked",
        nowIso(),
      ]
    );
    sequence += 1;
  }

  writeAudit(db, { actor, action: "migration.plan.generate", resourceType: "mig_plans", resourceId: queryOne(db, "SELECT plan_ref FROM mig_plans WHERE id = ?", [planId]).plan_ref, details: summary, ip });
  return getPlan(db, tenant, planId);
}

export function getPlan(db, tenantId, ref) {
  const row = getPlanRow(db, tenantId, ref);
  if (!row) return null;
  const steps = queryAll(db, "SELECT * FROM mig_plan_steps WHERE plan_id = ? ORDER BY sequence", [row.id]).map(publicPlanStep);
  return { ...publicPlan(row), steps };
}

export function listPlans(db, tenantId, { projectId, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (projectId != null) {
    clauses.push("project_id = ?");
    params.push(Number(projectId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(assertPlanStatus(status));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_plans ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_plans ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicPlan), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function approvePlan(db, tenantId, ref, actor = null, ip = null) {
  const row = getPlanRow(db, tenantId, ref);
  if (!row) throw planNotFound(ref);
  const plan = getPlan(db, tenantId, row.id);
  if (plan.status === "BLOCKED") throw planBlocked(plan.summary);
  run(db, "UPDATE mig_plans SET status = 'APPROVED', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  writeAudit(db, { actor, action: "migration.plan.approve", resourceType: "mig_plans", resourceId: row.plan_ref, details: { status: "APPROVED" }, ip });
  return getPlan(db, tenantId, row.id);
}

// Project-level readiness report used by the UI and by the pre-flight checks.
export function readinessReport(db, tenantId, projectRef) {
  const tenant = Number(tenantId);
  const project = queryOne(
    db,
    "SELECT * FROM mig_projects WHERE tenant_id = ? AND (project_ref = ? OR CAST(id AS TEXT) = ? OR code = ?)",
    [tenant, String(projectRef), String(projectRef), normalizeText(projectRef, { max: 120 }).toUpperCase()]
  );
  if (!project) throw invalidPlan(`Project not found: ${projectRef}`, { ref: projectRef });
  const topology = topologicalOrder(db, tenant, project.id);
  const packages = queryAll(db, "SELECT * FROM mig_packages WHERE project_id = ? ORDER BY execution_order, id", [project.id]);
  const entries = packages.map((pkg) => evaluatePackageReadiness(db, tenant, pkg));
  return {
    project: project.project_ref,
    status: topology.hasCycle ? "BLOCKED" : entries.some((entry) => entry.readiness === "blocked") ? "BLOCKED" : entries.some((entry) => entry.readiness === "warning") ? "WARNING" : "READY",
    cycles: topology.cycles,
    packages: entries,
    order: topology.order.map((pkg) => pkg.code),
    summary: {
      total: entries.length,
      ready: entries.filter((entry) => entry.readiness === "ready").length,
      blocked: entries.filter((entry) => entry.readiness === "blocked").length,
      warning: entries.filter((entry) => entry.readiness === "warning").length,
    },
  };
}

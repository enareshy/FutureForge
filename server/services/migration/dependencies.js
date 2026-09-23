// Dependency resolution for migration packages.
//
// Legacy datasets are highly interdependent (a BOM references parts, a change
// notice references affected items, a document references revisions). The engine
// therefore resolves a dependency-aware execution order, detects circular
// references and refuses to run a package whose required predecessors are not
// complete (spec §11, §12, §13).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { dependencyNotFound, dependencyCircular, dependencyUnsatisfied, invalidDependency } from "./errors.js";
import { publicDependency } from "./repository.js";
import { normalizeText, parseArray } from "./validation.js";

export function getDependencyRow(db, tenantId, id) {
  return queryOne(db, "SELECT * FROM mig_dependencies WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(id)]);
}

export function listPackageDependencies(db, tenantId, packageId) {
  const rows = queryAll(db, "SELECT * FROM mig_dependencies WHERE tenant_id = ? AND package_id = ? ORDER BY id", [Number(tenantId), Number(packageId)]);
  return rows.map(publicDependency);
}

export function listProjectDependencies(db, tenantId, projectId) {
  const rows = queryAll(db, "SELECT * FROM mig_dependencies WHERE tenant_id = ? AND project_id = ? ORDER BY id", [Number(tenantId), Number(projectId)]);
  return rows.map(publicDependency);
}

// Rebuilds the dependency edges for a package from its declared
// `dependency_json`, resolving package codes to ids and computing the initial
// satisfaction status. Idempotent: it replaces the package's edges.
export function syncPackageDependencies(db, tenantId, packageId) {
  const tenant = Number(tenantId);
  const row = queryOne(db, "SELECT * FROM mig_packages WHERE id = ? AND tenant_id = ?", [Number(packageId), tenant]);
  if (!row) throw dependencyNotFound(packageId);
  const declared = parseArray(row.dependency_json, []);
  run(db, "DELETE FROM mig_dependencies WHERE package_id = ?", [row.id]);
  let created = 0;
  for (const dependency of declared) {
    if (!dependency || typeof dependency !== "object") continue;
    const packageCode = normalizeText(dependency.depends_on ?? dependency.dependsOn ?? dependency.package_code ?? dependency.packageCode, { max: 120 });
    let targetId = dependency.depends_on_package_id != null ? Number(dependency.depends_on_package_id) : null;
    if (!targetId && packageCode) {
      const target = queryOne(db, "SELECT id FROM mig_packages WHERE tenant_id = ? AND project_id = ? AND code = ?", [tenant, row.project_id, packageCode.toUpperCase()]);
      targetId = target ? target.id : null;
    }
    if (targetId === row.id) throw invalidDependency(`Package ${row.code} cannot depend on itself`);
    const required = dependency.required === undefined ? 1 : dependency.required ? 1 : 0;
    const target = targetId ? queryOne(db, "SELECT * FROM mig_packages WHERE id = ?", [targetId]) : null;
    const status = !targetId ? "missing" : target.status === "COMPLETED" ? "satisfied" : "pending";
    run(
      db,
      `INSERT INTO mig_dependencies (tenant_id, project_id, package_id, depends_on_package_id, dependency_type, source_ref, target_ref, required, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenant,
        row.project_id,
        row.id,
        targetId,
        normalizeText(dependency.dependency_type ?? dependency.dependencyType ?? "PACKAGE", { max: 40 }) || "PACKAGE",
        normalizeText(dependency.source_ref ?? dependency.sourceRef, { max: 300 }),
        normalizeText(dependency.target_ref ?? dependency.targetRef, { max: 300 }),
        required,
        status,
        nowIso(),
        nowIso(),
      ]
    );
    created += 1;
  }
  return { created };
}

export function updateDependencyStatus(db, tenantId, packageId, dependsOnPackageId, status) {
  return run(
    db,
    "UPDATE mig_dependencies SET status = ?, updated_at = ? WHERE tenant_id = ? AND package_id = ? AND depends_on_package_id = ?",
    [String(status), nowIso(), Number(tenantId), Number(packageId), Number(dependsOnPackageId)]
  ).changes;
}

// Resolves all dependencies for a package. A dependency is satisfied when its
// target package exists and is COMPLETED (or was explicitly skipped).
export function resolveDependencies(db, tenantId, packageId) {
  const tenant = Number(tenantId);
  const packageRow = queryOne(db, "SELECT * FROM mig_packages WHERE id = ? AND tenant_id = ?", [Number(packageId), tenant]);
  if (!packageRow) throw dependencyNotFound(packageId);
  const edges = queryAll(db, "SELECT * FROM mig_dependencies WHERE tenant_id = ? AND package_id = ?", [tenant, packageRow.id]);
  const dependencies = edges.map((edge) => {
    const target = edge.depends_on_package_id ? queryOne(db, "SELECT id, code, status FROM mig_packages WHERE id = ?", [edge.depends_on_package_id]) : null;
    const satisfied = Boolean(target) && target.status === "COMPLETED";
    return {
      ...publicDependency(edge),
      target_status: target ? target.status : null,
      target_code: target ? target.code : null,
      satisfied,
    };
  });
  const blocking = dependencies.filter((dependency) => dependency.required && !dependency.satisfied);
  return { package: packageRow.code, dependencies, blocking, satisfied: blocking.length === 0 };
}

// Topologically orders the packages of a project. Edges point from a dependency
// to its dependent, so a dependency always appears before its dependent.
// Returns { order, packages, cycles, edges } — cycles are reported, never
// silently dropped.
export function topologicalOrder(db, tenantId, projectId) {
  const tenant = Number(tenantId);
  const packages = queryAll(db, "SELECT id, code, status, execution_order FROM mig_packages WHERE tenant_id = ? AND project_id = ? ORDER BY execution_order, id", [tenant, Number(projectId)]);
  const byId = new Map(packages.map((pkg) => [Number(pkg.id), pkg]));
  const edges = queryAll(db, "SELECT * FROM mig_dependencies WHERE tenant_id = ? AND project_id = ?", [tenant, Number(projectId)]);
  // indegree[X] = number of dependencies X must wait for (only resolvable PACKAGE edges).
  const indegree = new Map(packages.map((pkg) => [Number(pkg.id), 0]));
  const dependents = new Map(packages.map((pkg) => [Number(pkg.id), []]));
  for (const edge of edges) {
    const from = edge.depends_on_package_id != null ? Number(edge.depends_on_package_id) : null;
    const to = Number(edge.package_id);
    if (from == null || !byId.has(from) || !byId.has(to)) continue;
    dependents.get(from).push(to);
    indegree.set(to, (indegree.get(to) || 0) + 1);
  }
  // Deterministic: among ready nodes, prefer execution_order then id.
  const ready = packages
    .filter((pkg) => (indegree.get(Number(pkg.id)) || 0) === 0)
    .sort((a, b) => a.execution_order - b.execution_order || a.id - b.id)
    .map((pkg) => Number(pkg.id));
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const dependent of dependents.get(id) || []) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) {
        ready.push(dependent);
        ready.sort((a, b) => (byId.get(a).execution_order - byId.get(b).execution_order) || a - b);
      }
    }
  }
  const cycles = packages.filter((pkg) => (indegree.get(Number(pkg.id)) || 0) > 0).map((pkg) => pkg.code);
  return {
    order: order.map((id) => byId.get(id)),
    cycles,
    hasCycle: cycles.length > 0,
    edges: edges.map(publicDependency),
  };
}

// Enforces the dependency strategy before a run. STRICT throws; WARN returns the
// blocking set; IGNORE ignores it entirely.
export function assertDependenciesSatisfied(db, tenantId, packageId, strategy = "STRICT") {
  const resolution = resolveDependencies(db, tenantId, packageId);
  if (resolution.satisfied || strategy === "IGNORE") return resolution;
  if (strategy === "WARN") return { ...resolution, warned: true };
  throw dependencyUnsatisfied({
    package: resolution.package,
    blocking: resolution.blocking.map((dependency) => ({ code: dependency.target_code, dependency_type: dependency.dependency_type, status: dependency.status })),
  });
}

export function assertNoCircularDependencies(db, tenantId, projectId) {
  const result = topologicalOrder(db, tenantId, projectId);
  if (result.hasCycle) throw dependencyCircular({ project_id: Number(projectId), cycles: result.cycles });
  return result;
}

// Called after a package completes so its dependents can become ready.
export function markDependentsSatisfied(db, tenantId, packageId) {
  return run(
    db,
    "UPDATE mig_dependencies SET status = 'satisfied', updated_at = ? WHERE tenant_id = ? AND depends_on_package_id = ?",
    [nowIso(), Number(tenantId), Number(packageId)]
  ).changes;
}

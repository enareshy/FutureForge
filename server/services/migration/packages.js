// Migration packages: dependency-aware units of migration work within a project.
//
// A package carries its own mapping, transformation, validation and dependency
// declarations (spec §5, §6). It is the unit the execution engine runs, so a
// failed or blocked package never jeopardizes the rest of the project.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";
import { packageNotFound, packageConflict, invalidPackage } from "./errors.js";
import { packageRef as makePackageRef } from "./refs.js";
import { publicPackage, publicPackageVersion } from "./repository.js";
import {
  normalizeText,
  normalizeUpper,
  parseObject,
  parseArray,
  paginate,
  requireCode,
  requireName,
  assertPackageStatus,
  assertDuplicateStrategy,
  assertMappings,
  assertTransformations,
  assertValidationRules,
  normalizeDependency,
} from "./validation.js";
import { updateRow } from "./sql.js";
import { syncPackageDependencies } from "./dependencies.js";

const MUTABLE = ["DRAFT", "READY", "BLOCKED", "FAILED"];

export function getPackageRow(db, tenantId, ref) {
  return queryOne(
    db,
    "SELECT * FROM mig_packages WHERE tenant_id = ? AND (package_ref = ? OR CAST(id AS TEXT) = ? OR code = ?)",
    [Number(tenantId), String(ref), String(ref), normalizeUpper(ref)]
  );
}

export function createPackage(db, tenantId, input = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const code = requireCode(input.code, "Package code");
  if (getPackageRow(db, tenant, code)) throw packageConflict(code);
  const projectId = Number(input.project_id ?? input.projectId);
  if (!Number.isInteger(projectId) || projectId <= 0) throw invalidPackage("A package requires a valid project_id");
  const project = queryOne(db, "SELECT * FROM mig_projects WHERE id = ? AND tenant_id = ?", [projectId, tenant]);
  if (!project) throw invalidPackage("The project for this package was not found", { project_id: projectId });

  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO mig_packages (package_ref, project_id, tenant_id, organization_id, code, name, description, object_type,
       source_object_type, target_object_type, source_json, scope_json, mapping_json, transformation_json, validation_json,
       dependency_json, duplicate_strategy, execution_order, status, statistics_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', '{}', 1, ?, ?, ?, ?)`,
    [
      makePackageRef(code),
      projectId,
      tenant,
      input.organization_id ?? input.organizationId ?? project.organization_id ?? null,
      code,
      requireName(input.name || code, "Package name"),
      normalizeText(input.description, { max: 2000 }),
      normalizeText(input.object_type ?? input.objectType, { max: 120 }),
      normalizeText(input.source_object_type ?? input.sourceObjectType, { max: 120 }),
      normalizeText(input.target_object_type ?? input.targetObjectType, { max: 120 }),
      JSON.stringify(parseObject(input.source, {})),
      JSON.stringify(parseObject(input.scope, {})),
      JSON.stringify({ ...parseObject(input.mapping, {}), mappings: assertMappings(input.mappings ?? parseObject(input.mapping, {}).mappings) }),
      JSON.stringify(assertTransformations(input.transformations ?? parseArray(parseObject(input.transformation, {}).transformations, []))),
      JSON.stringify(assertValidationRules(input.validation_rules ?? input.validationRules ?? parseArray(parseObject(input.validation, {}).rules, []))),
      JSON.stringify((input.dependencies || input.dependency || []).map(normalizeDependency)),
      assertDuplicateStrategy(input.duplicate_strategy ?? input.duplicateStrategy ?? "REJECT"),
      Number.isFinite(Number(input.execution_order ?? input.executionOrder)) ? Number(input.execution_order ?? input.executionOrder) : 0,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const packageId = Number(result.lastInsertRowid);
  syncPackageDependencies(db, tenant, packageId);
  const created = queryOne(db, "SELECT * FROM mig_packages WHERE id = ?", [packageId]);
  writePackageVersion(db, created, actor, "Initial version");
  writeAudit(db, { actor, action: "migration.package.create", resourceType: "mig_packages", resourceId: created.package_ref, details: { code, project_id: projectId }, ip });
  return publicPackage(created);
}

export function getPackage(db, tenantId, ref) {
  return publicPackage(getPackageRow(db, tenantId, ref));
}

export function listPackages(db, { tenantId, projectId, status, targetObjectType, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (projectId != null) {
    clauses.push("project_id = ?");
    params.push(Number(projectId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(assertPackageStatus(status));
  }
  if (targetObjectType) {
    clauses.push("target_object_type = ?");
    params.push(normalizeText(targetObjectType, { max: 120 }));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_packages ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_packages ${where} ORDER BY execution_order, id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicPackage), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function updatePackage(db, tenantId, ref, patch = {}, actor = null, ip = null) {
  const row = getPackageRow(db, tenantId, ref);
  if (!row) throw packageNotFound(ref);
  if (!MUTABLE.includes(row.status)) {
    throw invalidPackage(`Package ${row.package_ref} is ${row.status} and cannot be edited; clone it or create a new version`, { ref: row.package_ref, status: row.status });
  }
  const fields = {};
  const assign = (value, key, transform) => {
    if (value !== undefined) fields[key] = transform ? transform(value) : value;
  };
  assign(patch.name, "name", (v) => requireName(v, "Package name"));
  assign(patch.description, "description", (v) => normalizeText(v, { max: 2000 }));
  assign(patch.object_type ?? patch.objectType, "object_type", (v) => normalizeText(v, { max: 120 }));
  assign(patch.source_object_type ?? patch.sourceObjectType, "source_object_type", (v) => normalizeText(v, { max: 120 }));
  assign(patch.target_object_type ?? patch.targetObjectType, "target_object_type", (v) => normalizeText(v, { max: 120 }));
  assign(patch.source, "source_json", (v) => JSON.stringify(parseObject(v, {})));
  assign(patch.scope, "scope_json", (v) => JSON.stringify(parseObject(v, {})));
  assign(patch.duplicate_strategy ?? patch.duplicateStrategy, "duplicate_strategy", (v) => assertDuplicateStrategy(v));
  assign(patch.execution_order ?? patch.executionOrder, "execution_order", (v) => Number(v) || 0);
  if (Object.keys(fields).length) {
    fields.updated_by = actor?.id ?? null;
    fields.version = Number(row.version) + 1;
    updateRow(db, "mig_packages", row.id, fields);
  }
  if (patch.mappings !== undefined || patch.mapping !== undefined) {
    const mappings = assertMappings(patch.mappings ?? parseObject(patch.mapping, {}).mappings);
    run(db, "UPDATE mig_packages SET mapping_json = ? WHERE id = ?", [JSON.stringify({ mappings }), row.id]);
  }
  if (patch.transformations !== undefined || patch.transformation !== undefined) {
    const transformations = assertTransformations(patch.transformations ?? parseArray(parseObject(patch.transformation, {}).transformations, []));
    run(db, "UPDATE mig_packages SET transformation_json = ? WHERE id = ?", [JSON.stringify(transformations), row.id]);
  }
  if (patch.validation_rules !== undefined || patch.validationRules !== undefined || patch.validation !== undefined) {
    const rules = assertValidationRules(patch.validation_rules ?? patch.validationRules ?? parseArray(parseObject(patch.validation, {}).rules, []));
    run(db, "UPDATE mig_packages SET validation_json = ? WHERE id = ?", [JSON.stringify(rules), row.id]);
  }
  if (patch.dependencies !== undefined || patch.dependency !== undefined) {
    const dependencies = (patch.dependencies ?? patch.dependency ?? []).map(normalizeDependency);
    run(db, "UPDATE mig_packages SET dependency_json = ? WHERE id = ?", [JSON.stringify(dependencies), row.id]);
    syncPackageDependencies(db, Number(tenantId), row.id);
  }
  const updated = queryOne(db, "SELECT * FROM mig_packages WHERE id = ?", [row.id]);
  writePackageVersion(db, updated, actor, normalizeText(patch.change_summary ?? patch.changeSummary, { max: 500 }) || "Package updated");
  writeAudit(db, { actor, action: "migration.package.update", resourceType: "mig_packages", resourceId: updated.package_ref, details: { fields: Object.keys(fields) }, ip });
  return publicPackage(updated);
}

export function setPackageStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = getPackageRow(db, tenantId, ref);
  if (!row) throw packageNotFound(ref);
  const next = assertPackageStatus(status);
  updateRow(db, "mig_packages", row.id, { status: next, updated_by: actor?.id ?? null });
  const updated = queryOne(db, "SELECT * FROM mig_packages WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "migration.package.status", resourceType: "mig_packages", resourceId: updated.package_ref, details: { status: next }, ip });
  return publicPackage(updated);
}

export function setPackageStatistics(db, tenantId, packageId, statistics, status = null) {
  const row = queryOne(db, "SELECT * FROM mig_packages WHERE id = ? AND tenant_id = ?", [Number(packageId), Number(tenantId)]);
  if (!row) return null;
  const patch = { statistics_json: JSON.stringify(statistics || {}) };
  if (status) patch.status = assertPackageStatus(status);
  updateRow(db, "mig_packages", row.id, patch);
  return publicPackage(queryOne(db, "SELECT * FROM mig_packages WHERE id = ?", [row.id]));
}

export function listPackageVersions(db, tenantId, ref, { page, pageSize } = {}) {
  const row = getPackageRow(db, tenantId, ref);
  if (!row) throw packageNotFound(ref);
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, "SELECT COUNT(*) AS c FROM mig_package_versions WHERE package_id = ?", [row.id])?.c || 0);
  const rows = queryAll(db, "SELECT * FROM mig_package_versions WHERE package_id = ? ORDER BY version DESC LIMIT ? OFFSET ?", [row.id, limit, offset]);
  return { items: rows.map(publicPackageVersion), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

function writePackageVersion(db, packageRow, actor, changeSummary) {
  if (!packageRow) return;
  run(
    db,
    `INSERT INTO mig_package_versions (package_id, tenant_id, version, status, snapshot_json, change_summary, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [packageRow.id, packageRow.tenant_id, packageRow.version, packageRow.status, JSON.stringify(publicPackage(packageRow)), changeSummary, actor?.id ?? null, nowIso()]
  );
}

export function packageExists(db, tenantId, id) {
  return Boolean(queryOne(db, "SELECT id FROM mig_packages WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]));
}

// Migration projects: the top-level onboarding engagement. A project groups the
// dependency-aware migration packages that together move one legacy system's
// data into the platform (spec §3, §4).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";
import { projectNotFound, projectConflict, projectImmutable, invalidProject } from "./errors.js";
import { projectRef as makeProjectRef } from "./refs.js";
import { publicProject, publicProjectVersion, publicPackage } from "./repository.js";
import {
  normalizeText,
  normalizeUpper,
  parseObject,
  paginate,
  requireCode,
  requireName,
  assertProjectStatus,
} from "./validation.js";
import { updateRow } from "./sql.js";

const MUTABLE = ["DRAFT", "PLANNED", "READY", "PAUSED", "FAILED"];

export function getProjectRow(db, tenantId, ref) {
  return queryOne(
    db,
    "SELECT * FROM mig_projects WHERE tenant_id = ? AND (project_ref = ? OR CAST(id AS TEXT) = ? OR code = ?)",
    [Number(tenantId), String(ref), String(ref), normalizeUpper(ref)]
  );
}

export function createProject(db, tenantId, input = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const code = requireCode(input.code, "Project code");
  if (getProjectRow(db, tenant, code)) throw projectConflict(code);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO mig_projects (project_ref, tenant_id, organization_id, code, name, description, source_system, source_version,
       target_platform_version, scope_json, status, owner_user_id, start_date, end_date, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      makeProjectRef(code),
      tenant,
      input.organization_id ?? input.organizationId ?? null,
      code,
      requireName(input.name || code, "Project name"),
      normalizeText(input.description, { max: 2000 }),
      normalizeText(input.source_system ?? input.sourceSystem, { max: 200 }),
      normalizeText(input.source_version ?? input.sourceVersion, { max: 120 }),
      normalizeText(input.target_platform_version ?? input.targetPlatformVersion, { max: 120 }),
      JSON.stringify(parseObject(input.scope, {})),
      input.owner_user_id ?? input.ownerUserId ?? actor?.id ?? null,
      input.start_date ?? input.startDate ?? null,
      input.end_date ?? input.endDate ?? null,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const project = queryOne(db, "SELECT * FROM mig_projects WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeProjectVersion(db, project, actor, "Initial version");
  writeAudit(db, { actor, action: "migration.project.create", resourceType: "mig_projects", resourceId: project.project_ref, details: { code }, ip });
  return publicProject(project);
}

export function getProject(db, tenantId, ref) {
  return publicProject(getProjectRow(db, tenantId, ref));
}

export function listProjects(db, { tenantId, status, sourceSystem, ownerUserId, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(assertProjectStatus(status));
  }
  if (sourceSystem) {
    clauses.push("source_system = ?");
    params.push(normalizeText(sourceSystem, { max: 200 }));
  }
  if (ownerUserId != null) {
    clauses.push("owner_user_id = ?");
    params.push(Number(ownerUserId));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_projects ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_projects ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicProject), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function updateProject(db, tenantId, ref, patch = {}, actor = null, ip = null) {
  const row = getProjectRow(db, tenantId, ref);
  if (!row) throw projectNotFound(ref);
  const fields = {};
  const assign = (value, key, transform) => {
    if (value !== undefined) fields[key] = transform ? transform(value) : value;
  };
  assign(patch.name, "name", (v) => requireName(v, "Project name"));
  assign(patch.description, "description", (v) => normalizeText(v, { max: 2000 }));
  assign(patch.source_system ?? patch.sourceSystem, "source_system", (v) => normalizeText(v, { max: 200 }));
  assign(patch.source_version ?? patch.sourceVersion, "source_version", (v) => normalizeText(v, { max: 120 }));
  assign(patch.target_platform_version ?? patch.targetPlatformVersion, "target_platform_version", (v) => normalizeText(v, { max: 120 }));
  assign(patch.scope, "scope_json", (v) => JSON.stringify(parseObject(v, {})));
  assign(patch.owner_user_id ?? patch.ownerUserId, "owner_user_id", (v) => (v != null ? Number(v) : null));
  assign(patch.start_date ?? patch.startDate, "start_date", (v) => (v ? String(v) : null));
  assign(patch.end_date ?? patch.endDate, "end_date", (v) => (v ? String(v) : null));
  if (Object.keys(fields).length) {
    fields.updated_by = actor?.id ?? null;
    fields.version = Number(row.version) + 1;
    updateRow(db, "mig_projects", row.id, fields);
  }
  const updated = queryOne(db, "SELECT * FROM mig_projects WHERE id = ?", [row.id]);
  writeProjectVersion(db, updated, actor, normalizeText(patch.change_summary ?? patch.changeSummary, { max: 500 }) || "Project updated");
  writeAudit(db, { actor, action: "migration.project.update", resourceType: "mig_projects", resourceId: updated.project_ref, details: { fields: Object.keys(fields) }, ip });
  return publicProject(updated);
}

export function setProjectStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = getProjectRow(db, tenantId, ref);
  if (!row) throw projectNotFound(ref);
  const next = assertProjectStatus(status);
  if (row.status === "ARCHIVED" && next !== "ARCHIVED") {
    // Archived projects are terminal evidence; only an explicit clone should revive one.
    throw projectImmutable(row.project_ref, row.status);
  }
  updateRow(db, "mig_projects", row.id, { status: next, updated_by: actor?.id ?? null });
  const updated = queryOne(db, "SELECT * FROM mig_projects WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "migration.project.status", resourceType: "mig_projects", resourceId: updated.project_ref, details: { status: next }, ip });
  return publicProject(updated);
}

export function listProjectPackages(db, tenantId, ref) {
  const row = getProjectRow(db, tenantId, ref);
  if (!row) throw projectNotFound(ref);
  const rows = queryAll(db, "SELECT * FROM mig_packages WHERE project_id = ? ORDER BY execution_order, id", [row.id]);
  return { items: rows.map(publicPackage), project: publicProject(row), source_module: SOURCE_MODULE };
}

export function listProjectVersions(db, tenantId, ref, { page, pageSize } = {}) {
  const row = getProjectRow(db, tenantId, ref);
  if (!row) throw projectNotFound(ref);
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, "SELECT COUNT(*) AS c FROM mig_project_versions WHERE project_id = ?", [row.id])?.c || 0);
  const rows = queryAll(db, "SELECT * FROM mig_project_versions WHERE project_id = ? ORDER BY version DESC LIMIT ? OFFSET ?", [row.id, limit, offset]);
  return { items: rows.map(publicProjectVersion), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

function writeProjectVersion(db, project, actor, changeSummary) {
  if (!project) return;
  run(
    db,
    `INSERT INTO mig_project_versions (project_id, tenant_id, version, status, snapshot_json, change_summary, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [project.id, project.tenant_id, project.version, project.status, JSON.stringify(publicProject(project)), changeSummary, actor?.id ?? null, nowIso()]
  );
}

export function projectExists(db, tenantId, id) {
  return Boolean(queryOne(db, "SELECT id FROM mig_projects WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]));
}

export { invalidProject };

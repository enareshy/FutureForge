// Append-only migration audit trail.
//
// Every migration action (mapping, transformation, validation, write, skip,
// failure, per-object result) appends an immutable row to mig_audit. This is the
// authoritative migration evidence trail required by the specification (spec
// §24, §25): it records the source object, the target object, the definition
// version, the transformation version, the actor, the status and any error.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { SOURCE_MODULE } from "./constants.js";
import { publicAudit } from "./repository.js";
import { normalizeText, normalizeUpper, paginate } from "./validation.js";

export function recordMigrationAudit(db, input = {}) {
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO mig_audit (tenant_id, organization_id, project_id, package_id, definition_version, job_id, batch_id,
       source_object_type, source_object_id, target_object_type, target_object_id, action, status, error_message,
       transformation_version, correlation_id, actor_user_id, actor_username, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(input.tenantId),
      input.organizationId != null ? Number(input.organizationId) : null,
      input.projectId != null ? Number(input.projectId) : null,
      input.packageId != null ? Number(input.packageId) : null,
      Number(input.definitionVersion || 0),
      input.jobId != null ? Number(input.jobId) : null,
      input.batchId != null ? Number(input.batchId) : null,
      normalizeText(input.sourceObjectType, { max: 120 }),
      normalizeText(input.sourceObjectId, { max: 300 }),
      normalizeText(input.targetObjectType, { max: 120 }),
      normalizeText(input.targetObjectId, { max: 300 }),
      normalizeUpper(input.action || "MAPPED"),
      normalizeUpper(input.status || "SUCCESS"),
      normalizeText(input.errorMessage, { max: 1000 }),
      Number(input.transformationVersion || 0),
      normalizeText(input.correlationId, { max: 120 }),
      input.actorUserId != null ? Number(input.actorUserId) : input.actor?.id ?? null,
      normalizeText(input.actorUsername || input.actor?.username, { max: 120 }),
      JSON.stringify(input.details && typeof input.details === "object" ? input.details : {}),
      ts,
    ]
  );
  return Number(result.lastInsertRowid);
}

export function getMigrationAuditRow(db, tenantId, id) {
  return queryOne(db, "SELECT * FROM mig_audit WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(id)]);
}

export function listMigrationAudit(db, { tenantId, jobId, projectId, packageId, targetObjectId, sourceObjectId, action, status, from, to, page, pageSize } = {}) {
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
  if (targetObjectId) {
    clauses.push("target_object_id = ?");
    params.push(String(targetObjectId));
  }
  if (sourceObjectId) {
    clauses.push("source_object_id = ?");
    params.push(String(sourceObjectId));
  }
  if (action) {
    clauses.push("action = ?");
    params.push(normalizeUpper(action));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (from) {
    clauses.push("created_at >= ?");
    params.push(String(from));
  }
  if (to) {
    clauses.push("created_at <= ?");
    params.push(String(to));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_audit ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_audit ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicAudit), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

// Per-object full lineage: every audit entry for one target object across the
// whole migration, oldest first.
export function objectLineage(db, tenantId, targetObjectId) {
  const rows = queryAll(
    db,
    "SELECT * FROM mig_audit WHERE tenant_id = ? AND target_object_id = ? ORDER BY id ASC",
    [Number(tenantId), String(targetObjectId)]
  );
  return rows.map(publicAudit);
}

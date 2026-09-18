// External-to-internal object identity mapping with conflict detection and
// source-of-truth tracking. Business modules resolve identities through this
// service instead of maintaining their own cross-system lookup tables.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { publicMapping } from "./repository.js";
import { MAPPING_STATUSES, assertEnum, safeParse, toJson } from "./validation.js";
import { auditIntegration } from "./hooks.js";

function whereFrom({ tenantId, externalSystemId, externalObjectType, internalObjectType, status, q } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (externalSystemId) {
    clauses.push("external_system_id = ?");
    params.push(Number(externalSystemId));
  }
  if (externalObjectType) {
    clauses.push("external_object_type = ?");
    params.push(externalObjectType);
  }
  if (internalObjectType) {
    clauses.push("internal_object_type = ?");
    params.push(internalObjectType);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (q) {
    clauses.push("(LOWER(external_object_id) LIKE ? OR LOWER(internal_object_id) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listMappings(db, options = {}) {
  const { page = 1, pageSize = 50 } = options;
  const { where, params } = whereFrom(options);
  const total = queryOne(db, `SELECT COUNT(*) FROM external_object_mappings ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM external_object_mappings ${where} ORDER BY last_synced_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicMapping(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getMappingRow(db, ref) {
  const id = Number(ref);
  return queryOne(db, "SELECT * FROM external_object_mappings WHERE id = ?", [Number.isFinite(id) ? id : -1]);
}

export function getMapping(db, ref) {
  const row = getMappingRow(db, ref);
  if (!row) throw new HttpError(404, "Object mapping not found");
  return publicMapping(row);
}

export function findMapping(db, { externalSystemId, externalObjectType, externalObjectId }) {
  const row = queryOne(
    db,
    "SELECT * FROM external_object_mappings WHERE external_system_id = ? AND external_object_type = ? AND external_object_id = ?",
    [Number(externalSystemId), externalObjectType, String(externalObjectId)]
  );
  return row ? publicMapping(row) : null;
}

// Creates or updates a mapping and detects conflicts when the same internal
// object is already mapped to a different external identity (or vice versa).
export function upsertMapping(db, input = {}, actor = null, tenantId = null) {
  const externalSystemId = Number(input.external_system_id);
  if (!externalSystemId) throw new HttpError(400, "external_system_id is required");
  if (!input.external_object_type) throw new HttpError(400, "external_object_type is required");
  if (!input.external_object_id) throw new HttpError(400, "external_object_id is required");
  if (!input.internal_object_type) throw new HttpError(400, "internal_object_type is required");
  if (!input.internal_object_id) throw new HttpError(400, "internal_object_id is required");
  if (input.status !== undefined) assertEnum(input.status, MAPPING_STATUSES, "status");

  const system = queryOne(db, "SELECT * FROM external_systems WHERE id = ?", [externalSystemId]);
  if (!system) throw new HttpError(400, "external_system_id does not reference an existing system");

  const existing = queryOne(
    db,
    "SELECT * FROM external_object_mappings WHERE external_system_id = ? AND external_object_type = ? AND external_object_id = ?",
    [externalSystemId, input.external_object_type, input.external_object_id]
  );

  let conflictStatus = "";
  // Internal identity already claimed by a different external identity.
  const internalConflict = queryOne(
    db,
    `SELECT * FROM external_object_mappings
     WHERE internal_object_type = ? AND internal_object_id = ? AND NOT (external_system_id = ? AND external_object_type = ? AND external_object_id = ?)
     LIMIT 1`,
    [input.internal_object_type, String(input.internal_object_id), externalSystemId, input.external_object_type, String(input.external_object_id)]
  );
  if (internalConflict) conflictStatus = `internal identity already mapped from ${internalConflict.external_object_type}:${internalConflict.external_object_id}`;

  const ts = nowIso();
  const status = conflictStatus ? "conflict" : input.status || existing?.status || "active";
  if (existing) {
    run(
      db,
      `UPDATE external_object_mappings SET internal_object_type = ?, internal_object_id = ?, internal_revision = ?,
       status = ?, source_of_truth = ?, conflict_status = ?, attributes_json = ?, last_synced_at = ?,
       last_execution_id = ?, updated_at = ? WHERE id = ?`,
      [
        input.internal_object_type,
        String(input.internal_object_id),
        input.internal_revision || existing.internal_revision || "",
        status,
        input.source_of_truth || existing.source_of_truth || "external",
        conflictStatus,
        input.attributes !== undefined ? toJson(input.attributes, {}) : existing.attributes_json,
        ts,
        input.last_execution_id ?? existing.last_execution_id ?? null,
        ts,
        existing.id,
      ]
    );
    auditIntegration(db, { actor, action: "integration.mapping.update", resourceType: "external_object_mapping", resourceId: existing.id, details: { conflict: Boolean(conflictStatus) }, status: conflictStatus ? "failure" : "success" });
    return { ...publicMapping(queryOne(db, "SELECT * FROM external_object_mappings WHERE id = ?", [existing.id])), conflict: Boolean(conflictStatus) };
  }

  const result = run(
    db,
    `INSERT INTO external_object_mappings
      (external_system_id, external_object_type, external_object_id, internal_object_type, internal_object_id,
       internal_revision, status, source_of_truth, conflict_status, attributes_json, last_synced_at,
       last_execution_id, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      externalSystemId,
      input.external_object_type,
      String(input.external_object_id),
      input.internal_object_type,
      String(input.internal_object_id),
      input.internal_revision || "",
      status,
      input.source_of_truth || "external",
      conflictStatus,
      toJson(input.attributes, {}),
      ts,
      input.last_execution_id ?? null,
      tenantId ?? input.tenant_id ?? system.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM external_object_mappings WHERE id = ?", [Number(result.lastInsertRowid)]);
  auditIntegration(db, { actor, action: "integration.mapping.create", resourceType: "external_object_mapping", resourceId: row.id, details: { conflict: Boolean(conflictStatus) }, status: conflictStatus ? "failure" : "success" });
  return { ...publicMapping(row), conflict: Boolean(conflictStatus) };
}

export function updateMapping(db, ref, input = {}, actor = null) {
  const row = getMappingRow(db, ref);
  if (!row) throw new HttpError(404, "Object mapping not found");
  if (input.status !== undefined) assertEnum(input.status, MAPPING_STATUSES, "status");
  run(
    db,
    `UPDATE external_object_mappings SET internal_object_type = ?, internal_object_id = ?, internal_revision = ?,
     status = ?, source_of_truth = ?, conflict_status = ?, attributes_json = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`,
    [
      input.internal_object_type ?? row.internal_object_type,
      input.internal_object_id !== undefined ? String(input.internal_object_id) : row.internal_object_id,
      input.internal_revision ?? row.internal_revision,
      input.status ?? row.status,
      input.source_of_truth ?? row.source_of_truth,
      input.conflict_status !== undefined ? input.conflict_status : row.conflict_status,
      input.attributes !== undefined ? toJson(input.attributes, {}) : row.attributes_json,
      input.last_synced_at !== undefined ? input.last_synced_at : row.last_synced_at,
      nowIso(),
      row.id,
    ]
  );
  auditIntegration(db, { actor, action: "integration.mapping.update", resourceType: "external_object_mapping", resourceId: row.id, details: { code: row.external_object_id } });
  return publicMapping(queryOne(db, "SELECT * FROM external_object_mappings WHERE id = ?", [row.id]));
}

export function deleteMapping(db, ref, actor = null) {
  const row = getMappingRow(db, ref);
  if (!row) throw new HttpError(404, "Object mapping not found");
  run(db, "DELETE FROM external_object_mappings WHERE id = ?", [row.id]);
  auditIntegration(db, { actor, action: "integration.mapping.delete", resourceType: "external_object_mapping", resourceId: row.id, details: {} });
  return { deleted: true, id: row.id };
}

export function mappingStats(db, { tenantId } = {}) {
  const params = [];
  const clauses = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const byStatus = queryAll(db, `SELECT status, COUNT(*) AS count FROM external_object_mappings ${where} GROUP BY status`, params);
  const total = byStatus.reduce((sum, row) => sum + row.count, 0);
  const conflicts = byStatus.find((row) => row.status === "conflict")?.count || 0;
  return { total, conflicts, by_status: byStatus };
}

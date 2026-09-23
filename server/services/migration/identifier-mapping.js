// Source -> target identifier mapping.
//
// Legacy identifiers must never leak into the target platform's namespace.
// Every migrated object is recorded here so relationships, references and
// re-runs can resolve a legacy id to the platform object that represents it
// (spec §17, §18).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";
import { identifierConflict, identifierNotFound, invalidIdentifier } from "./errors.js";
import { publicIdentifierMapping } from "./repository.js";
import { normalizeText, normalizeUpper, paginate, assertIdentifierStatus } from "./validation.js";

export function getIdentifierMapping(db, tenantId, ref) {
  return publicIdentifierMapping(
    queryOne(db, "SELECT * FROM mig_identifier_mappings WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(ref)])
  );
}

export function resolveIdentifier(db, tenantId, { sourceSystem, sourceObjectType, sourceObjectId } = {}) {
  return publicIdentifierMapping(
    queryOne(
      db,
      "SELECT * FROM mig_identifier_mappings WHERE tenant_id = ? AND source_system = ? AND source_object_type = ? AND source_object_id = ?",
      [Number(tenantId), normalizeText(sourceSystem, { max: 200 }), normalizeText(sourceObjectType, { max: 120 }), normalizeText(sourceObjectId, { max: 300 })]
    )
  );
}

// Upserts an identifier mapping. Re-mapping the same source id to the same target
// is idempotent; mapping it to a different target is a conflict unless the caller
// explicitly overrides.
export function mapIdentifier(db, tenantId, input = {}, actor = null, ip = null, { override = false } = {}) {
  const tenant = Number(tenantId);
  const sourceSystem = normalizeText(input.source_system ?? input.sourceSystem, { max: 200 });
  const sourceObjectType = normalizeText(input.source_object_type ?? input.sourceObjectType, { max: 120 });
  const sourceObjectId = normalizeText(input.source_object_id ?? input.sourceObjectId, { max: 300 });
  const targetObjectId = normalizeText(input.target_object_id ?? input.targetObjectId, { max: 300 });
  if (!sourceObjectId) throw invalidIdentifier("A source_object_id is required");
  const existing = resolveIdentifier(db, tenant, { sourceSystem, sourceObjectType, sourceObjectId });
  const ts = nowIso();
  const fields = {
    project_id: input.project_id ?? input.projectId ?? null,
    package_id: input.package_id ?? input.packageId ?? null,
    target_object_type: normalizeText(input.target_object_type ?? input.targetObjectType, { max: 120 }),
    target_object_id: targetObjectId,
    target_object_ref: normalizeText(input.target_object_ref ?? input.targetObjectRef, { max: 300 }),
    status: assertIdentifierStatus(input.status || (targetObjectId ? "MAPPED" : "PENDING")),
    updated_at: ts,
  };
  if (existing) {
    if (existing.target_object_id && targetObjectId && existing.target_object_id !== targetObjectId && !override) {
      throw identifierConflict({ source_object_id: sourceObjectId, existing_target: existing.target_object_id, requested_target: targetObjectId });
    }
    run(
      db,
      `UPDATE mig_identifier_mappings SET project_id = ?, package_id = ?, target_object_type = ?, target_object_id = ?, target_object_ref = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [fields.project_id, fields.package_id, fields.target_object_type, fields.target_object_id, fields.target_object_ref, fields.status, ts, existing.id]
    );
    const updated = publicIdentifierMapping(queryOne(db, "SELECT * FROM mig_identifier_mappings WHERE id = ?", [existing.id]));
    writeAudit(db, { actor, action: "migration.identifier.update", resourceType: "mig_identifier_mappings", resourceId: String(existing.id), details: { source_object_id: sourceObjectId, target_object_id: targetObjectId }, ip });
    return { mapping: updated, created: false };
  }
  const result = run(
    db,
    `INSERT INTO mig_identifier_mappings (tenant_id, project_id, package_id, source_system, source_object_type, source_object_id, target_object_type, target_object_id, target_object_ref, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenant, fields.project_id, fields.package_id, sourceSystem, sourceObjectType, sourceObjectId, fields.target_object_type, fields.target_object_id, fields.target_object_ref, fields.status, ts, ts]
  );
  const mapping = publicIdentifierMapping(queryOne(db, "SELECT * FROM mig_identifier_mappings WHERE id = ?", [Number(result.lastInsertRowid)]));
  writeAudit(db, { actor, action: "migration.identifier.create", resourceType: "mig_identifier_mappings", resourceId: String(mapping.id), details: { source_object_id: sourceObjectId, target_object_id: targetObjectId }, ip });
  return { mapping, created: true };
}

export function bulkMapIdentifiers(db, tenantId, mappings = [], actor = null, ip = null) {
  const list = Array.isArray(mappings) ? mappings : [];
  let created = 0;
  let updated = 0;
  for (const mapping of list.slice(0, 10000)) {
    const result = mapIdentifier(db, tenantId, mapping, actor, ip);
    if (result.created) created += 1;
    else updated += 1;
  }
  return { created, updated };
}

export function updateIdentifierStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = queryOne(db, "SELECT * FROM mig_identifier_mappings WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(ref)]);
  if (!row) throw identifierNotFound(ref);
  const next = assertIdentifierStatus(status);
  run(db, "UPDATE mig_identifier_mappings SET status = ?, updated_at = ? WHERE id = ?", [next, nowIso(), row.id]);
  writeAudit(db, { actor, action: "migration.identifier.status", resourceType: "mig_identifier_mappings", resourceId: String(row.id), details: { status: next }, ip });
  return publicIdentifierMapping(queryOne(db, "SELECT * FROM mig_identifier_mappings WHERE id = ?", [row.id]));
}

export function listIdentifierMappings(db, { tenantId, projectId, packageId, sourceSystem, sourceObjectType, status, targetObjectId, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (projectId != null) {
    clauses.push("project_id = ?");
    params.push(Number(projectId));
  }
  if (packageId != null) {
    clauses.push("package_id = ?");
    params.push(Number(packageId));
  }
  if (sourceSystem) {
    clauses.push("source_system = ?");
    params.push(normalizeText(sourceSystem, { max: 200 }));
  }
  if (sourceObjectType) {
    clauses.push("source_object_type = ?");
    params.push(normalizeText(sourceObjectType, { max: 120 }));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(assertIdentifierStatus(status));
  }
  if (targetObjectId) {
    clauses.push("target_object_id = ?");
    params.push(String(targetObjectId));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 1000 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_identifier_mappings ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_identifier_mappings ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicIdentifierMapping), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

// Builds a resolution map for a set of source ids, used by relationship
// migration so a whole batch resolves references without N queries.
export function buildIdentifierMap(db, tenantId, { sourceSystem, sourceObjectType, sourceObjectIds = [] } = {}) {
  const ids = sourceObjectIds.map((id) => normalizeText(id, { max: 300 })).filter(Boolean);
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = queryAll(
    db,
    `SELECT source_object_id, target_object_id, target_object_type FROM mig_identifier_mappings
     WHERE tenant_id = ? AND source_system = ? AND source_object_type = ? AND source_object_id IN (${placeholders})`,
    [Number(tenantId), normalizeText(sourceSystem, { max: 200 }), normalizeText(sourceObjectType, { max: 120 }), ...ids]
  );
  const map = new Map();
  for (const row of rows) map.set(row.source_object_id, { target_object_id: row.target_object_id, target_object_type: row.target_object_type });
  return map;
}

export { normalizeUpper };

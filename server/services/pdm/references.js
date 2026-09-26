// PDM reference index.
//
// Every PDM edge that points at an object (dataset usage, CAD association,
// design data, relationship, baseline membership) is recorded in a single
// normalized reference table so where-referenced analysis is a batched query
// instead of a per-service scan. References complement, and never replace, the
// shared Object & Relationship Framework.
import { queryAll, queryOne, run } from "../../db.js";
import { publicReference } from "./repository.js";
import { referenceRef } from "./refs.js";
import { normalizeReferenceInput, normalizeUpper, paginate } from "./validation.js";
import { SOURCE_MODULE } from "./constants.js";

export function recordReference(db, tenantId, input = {}) {
  let normalized;
  try {
    normalized = normalizeReferenceInput(input);
  } catch {
    return null;
  }
  const ts = new Date().toISOString();
  try {
    run(
      db,
      `INSERT OR IGNORE INTO pdm_references
         (reference_ref, tenant_id, organization_id, source_type, source_id, source_ref, target_type, target_id, target_ref, category, relationship_type, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        referenceRef(),
        Number(tenantId),
        input.organization_id != null ? Number(input.organization_id) : null,
        normalized.source_type,
        normalized.source_id,
        normalized.source_ref,
        normalized.target_type,
        normalized.target_id,
        normalized.target_ref,
        normalized.category,
        normalized.relationship_type,
        JSON.stringify(normalized.metadata || {}),
        ts,
      ]
    );
  } catch {
    return null;
  }
  return queryOne(
    db,
    "SELECT * FROM pdm_references WHERE tenant_id = ? AND source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? AND category = ?",
    [Number(tenantId), normalized.source_type, normalized.source_id, normalized.target_type, normalized.target_id, normalized.category]
  );
}

export function removeReference(db, tenantId, { source_type, source_id, target_type, target_id, category }) {
  return run(
    db,
    "DELETE FROM pdm_references WHERE tenant_id = ? AND source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? AND category = ?",
    [Number(tenantId), normalizeUpper(source_type), String(source_id), normalizeUpper(target_type), String(target_id), normalizeUpper(category)]
  ).changes;
}

export function removeReferencesForSource(db, tenantId, sourceType, sourceId) {
  return run(db, "DELETE FROM pdm_references WHERE tenant_id = ? AND source_type = ? AND source_id = ?", [
    Number(tenantId),
    normalizeUpper(sourceType),
    String(sourceId),
  ]).changes;
}

export function listReferences(db, { tenantId, sourceType, sourceId, targetType, targetId, category, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (sourceType) {
    clauses.push("source_type = ?");
    params.push(normalizeUpper(sourceType));
  }
  if (sourceId != null) {
    clauses.push("source_id = ?");
    params.push(String(sourceId));
  }
  if (targetType) {
    clauses.push("target_type = ?");
    params.push(normalizeUpper(targetType));
  }
  if (targetId != null) {
    clauses.push("target_id = ?");
    params.push(String(targetId));
  }
  if (category) {
    clauses.push("category = ?");
    params.push(normalizeUpper(category));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 1000 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pdm_references ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pdm_references ${where} ORDER BY category, id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicReference), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function referenceCategoriesForTarget(db, tenantId, targetType, targetId) {
  const rows = queryAll(
    db,
    "SELECT category, COUNT(*) AS c FROM pdm_references WHERE tenant_id = ? AND target_type = ? AND target_id = ? GROUP BY category ORDER BY c DESC",
    [Number(tenantId), normalizeUpper(targetType), String(targetId)]
  );
  return rows.map((row) => ({ category: row.category, count: Number(row.c) }));
}

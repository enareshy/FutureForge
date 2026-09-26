// Dependency checks for archive and purge decisions.
//
// The lifecycle service never builds its own relationship engine: it reads the
// shared Object & Relationship Framework and records a small, indexed snapshot
// in `lc_dependencies` so eligibility checks stay fast and can include manually
// declared blockers. A dependency is "blocking" when another live object depends
// on the object being archived or purged.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";
import { publicDependency } from "./repository.js";
import { invalidDependency } from "./errors.js";
import { assertTenantId, normalizeText, normalizeUpper, paginate } from "./validation.js";
import { directDependencies } from "../objects.js";

export { publicDependency };

export function listDependencies(db, { tenantId, objectType, objectId, status, result, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(normalizeText(objectType, { max: 120 }));
  }
  if (objectId !== undefined && objectId !== null && objectId !== "") {
    clauses.push("object_id = ?");
    params.push(String(objectId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status).toLowerCase() === "resolved" ? "resolved" : "active");
  }
  if (result === "BLOCKED") clauses.push("blocking = 1 AND status = 'active'");
  if (result === "WARNING") clauses.push("blocking = 0 AND status = 'active'");
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM lc_dependencies ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM lc_dependencies ${where} ORDER BY blocking DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicDependency), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function recordDependency(db, tenantId, input = {}, actor = null, ip = null) {
  const tid = assertTenantId(tenantId);
  const objectType = normalizeText(input.object_type || input.objectType, { max: 120 });
  const objectId = input.object_id ?? input.objectId;
  const dependsOnType = normalizeText(input.depends_on_type || input.dependsOnType, { max: 120 });
  const dependsOnId = input.depends_on_id ?? input.dependsOnId;
  if (!objectType || objectId === undefined || !dependsOnType || dependsOnId === undefined) {
    throw invalidDependency("object_type, object_id, depends_on_type and depends_on_id are required");
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO lc_dependencies (tenant_id, object_type, object_id, depends_on_type, depends_on_id, relationship_type, blocking, status, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      tid,
      objectType,
      String(objectId),
      dependsOnType,
      String(dependsOnId),
      normalizeText(input.relationship_type || input.relationshipType, { max: 120 }),
      input.blocking === false ? 0 : 1,
      JSON.stringify(input.details && typeof input.details === "object" ? input.details : {}),
      ts,
    ]
  );
  writeAudit(db, { actor, action: "data_lifecycle.dependency.record", resourceType: "lc_dependencies", resourceId: `${objectType}:${objectId}`, details: { depends_on: `${dependsOnType}:${dependsOnId}` }, ip });
  return publicDependency(queryOne(db, "SELECT * FROM lc_dependencies WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function resolveDependency(db, tenantId, id, actor = null, ip = null) {
  const row = queryOne(db, "SELECT * FROM lc_dependencies WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]);
  if (!row) throw invalidDependency(`Dependency ${id} not found`);
  run(db, "UPDATE lc_dependencies SET status = 'resolved', resolved_at = ? WHERE id = ?", [nowIso(), row.id]);
  writeAudit(db, { actor, action: "data_lifecycle.dependency.resolve", resourceType: "lc_dependencies", resourceId: row.id, details: {}, ip });
  return publicDependency(queryOne(db, "SELECT * FROM lc_dependencies WHERE id = ?", [row.id]));
}

// Best-effort refresh from the shared Object & Relationship Framework. If the
// object id does not resolve to a platform object the refresh is a no-op; the
// lifecycle service still works with explicitly recorded dependencies.
export function refreshDependencies(db, { tenantId, objectType, objectId, actor = null } = {}) {
  const tid = assertTenantId(tenantId);
  let snapshot;
  try {
    snapshot = directDependencies(db, objectId, tid);
  } catch {
    return { refreshed: false, recorded: 0 };
  }
  if (!snapshot?.object) return { refreshed: false, recorded: 0 };
  run(db, "DELETE FROM lc_dependencies WHERE tenant_id = ? AND object_type = ? AND object_id = ?", [tid, normalizeText(objectType, { max: 120 }), String(objectId)]);
  let recorded = 0;
  for (const entry of snapshot.depended_on_by || []) {
    const target = entry.object || {};
    run(
      db,
      `INSERT INTO lc_dependencies (tenant_id, object_type, object_id, depends_on_type, depends_on_id, relationship_type, blocking, status, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`,
      [
        tid,
        normalizeText(objectType, { max: 120 }),
        String(objectId),
        normalizeText(target.object_type || "object", { max: 120 }),
        String(target.id ?? target.object_id ?? ""),
        normalizeText(entry.kind, { max: 120 }),
        JSON.stringify({ direction: "incoming", source: target.code || null }),
        nowIso(),
      ]
    );
    recorded += 1;
  }
  for (const entry of snapshot.depends_on || []) {
    const target = entry.object || {};
    run(
      db,
      `INSERT INTO lc_dependencies (tenant_id, object_type, object_id, depends_on_type, depends_on_id, relationship_type, blocking, status, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
      [
        tid,
        normalizeText(objectType, { max: 120 }),
        String(objectId),
        normalizeText(target.object_type || "object", { max: 120 }),
        String(target.id ?? target.object_id ?? ""),
        normalizeText(entry.kind, { max: 120 }),
        JSON.stringify({ direction: "outgoing", source: target.code || null }),
        nowIso(),
      ]
    );
    recorded += 1;
  }
  if (recorded) {
    writeAudit(db, { actor, action: "data_lifecycle.dependency.refresh", resourceType: "lc_dependencies", resourceId: `${objectType}:${objectId}`, details: { recorded }, ip: null });
  }
  return { refreshed: true, recorded };
}

// Explainable dependency verdict: blocking rows deny the action, non-blocking
// rows warn, a clean object is SAFE.
export function evaluateDependencies(db, { tenantId, objectType, objectId }) {
  const rows = queryAll(db, "SELECT * FROM lc_dependencies WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND status = 'active'", [
    Number(tenantId),
    normalizeText(objectType, { max: 120 }),
    String(objectId),
  ]);
  const blocking = rows.filter((row) => Number(row.blocking) === 1);
  const warnings = rows.filter((row) => Number(row.blocking) !== 1);
  let result = "SAFE";
  if (blocking.length) result = "BLOCKED";
  else if (warnings.length) result = "WARNING";
  return {
    result,
    blocked: blocking.length > 0,
    blocking: blocking.map(publicDependency),
    warnings: warnings.map(publicDependency),
    checked_at: nowIso(),
  };
}

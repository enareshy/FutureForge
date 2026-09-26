// Classification hierarchy: classes and their unbounded, deterministic parent /
// child structure. Depth is data (configuration), never a hard-coded level. The
// materialized `path` / `level` columns make tree queries efficient without
// loading the whole hierarchy into memory.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { publicClass, publicClassVersion } from "./repository.js";
import { classRef } from "./refs.js";
import { SOURCE_MODULE, MAX_CHILDREN } from "./constants.js";
import { getConfig } from "./configuration.js";
import {
  normalizeText,
  normalizeUpper,
  parseObject,
  paginate,
  orderClause,
  requireCode,
  requireName,
  assertClassStatus,
} from "./validation.js";
import {
  classNotFound,
  classConflict,
  invalidClass,
  classCycle,
  classDepthExceeded,
  classImmutable,
  classificationNotFound,
} from "./errors.js";
import { recordChange } from "./history.js";
import { publishClassificationEvent, classificationEventCode } from "./events.js";
import { invalidate } from "./cache.js";

export function getClassRow(db, tenantId, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM cla_classes WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM cla_classes WHERE tenant_id = ? AND class_ref = ?", [Number(tenantId), String(ref)]);
}

export function requireClassRow(db, tenantId, ref) {
  const row = getClassRow(db, tenantId, ref);
  if (!row) throw classNotFound(ref);
  return row;
}

function getClassificationRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM cla_classifications WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  }
  return queryOne(db, "SELECT * FROM cla_classifications WHERE tenant_id = ? AND code = ?", [Number(tenantId), normalizeUpper(ref)]);
}

function childPath(parentPath, code) {
  return parentPath ? `${parentPath}/${code}` : code;
}

export function createClass(db, tenantId, body = {}, actor = null, ip = null) {
  const classification = getClassificationRow(db, tenantId, body.classification_id ?? body.classificationId ?? body.classification);
  if (!classification) throw classificationNotFound(body.classification_id ?? body.classification);
  const code = normalizeUpper(requireCode(body.code));
  if (!code) throw invalidClass("Class code is required");
  const duplicate = queryOne(db, "SELECT id FROM cla_classes WHERE tenant_id = ? AND classification_id = ? AND code = ?", [Number(tenantId), classification.id, code]);
  if (duplicate) throw classConflict(code);

  let parent = null;
  const parentRef = body.parent_class_id ?? body.parentClassId ?? body.parent_id;
  if (parentRef !== undefined && parentRef !== null && parentRef !== "") {
    parent = getClassRow(db, tenantId, parentRef);
    if (!parent) throw classNotFound(parentRef);
    if (Number(parent.classification_id) !== Number(classification.id)) throw invalidClass("Parent class belongs to a different classification");
  }
  const depth = parent ? Number(parent.level) + 1 : 0;
  const maxDepth = Number(getConfig(db, tenantId, "max_hierarchy_depth") || 64);
  if (depth >= maxDepth) throw classDepthExceeded(maxDepth);

  const siblingCount = Number(queryOne(db, "SELECT COUNT(*) AS c FROM cla_classes WHERE tenant_id = ? AND classification_id = ? AND parent_class_id IS ?", [Number(tenantId), classification.id, parent ? parent.id : null])?.c || 0);
  if (siblingCount >= MAX_CHILDREN) throw invalidClass(`At most ${MAX_CHILDREN} sibling classes are allowed`);

  const status = assertClassStatus(body.status || getConfig(db, tenantId, "default_class_status") || "DRAFT");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO cla_classes
       (class_ref, tenant_id, classification_id, code, name, description, parent_class_id, path, level, sort_order,
        status, version, owner_user_id, effective_date, obsolete_date, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      classRef(code),
      Number(tenantId),
      classification.id,
      code,
      normalizeText(requireName(body.name ?? code), { max: 200 }),
      normalizeText(body.description, { max: 2000 }),
      parent ? parent.id : null,
      childPath(parent?.path, code),
      depth,
      body.sort_order != null ? Number(body.sort_order) : siblingCount,
      status,
      body.owner_user_id != null ? Number(body.owner_user_id) : actor?.id ?? null,
      normalizeText(body.effective_date, { max: 40 }) || null,
      normalizeText(body.obsolete_date, { max: 40 }) || null,
      JSON.stringify(parseObject(body.metadata, {})),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const id = Number(result.lastInsertRowid);
  invalidate(tenantId);
  const row = queryOne(db, "SELECT * FROM cla_classes WHERE id = ?", [id]);
  recordChange(db, {
    tenantId,
    entityType: "CLASS",
    entityId: id,
    entityRef: code,
    action: "CREATED",
    version: 1,
    status,
    after: publicClass(row),
    actor,
    ip,
  });
  publishClassificationEvent(
    db,
    { eventType: classificationEventCode("CLASS_CREATED"), payload: { class_id: id, classification_id: classification.id }, objectType: "classification_class", objectId: id, tenantId },
    actor
  );
  return publicClass(row);
}

export function listClasses(db, { tenantId, classificationId, classification, parentId, status, q, page, pageSize, sort } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  let resolvedClassificationId = classificationId != null ? Number(classificationId) : null;
  if (!resolvedClassificationId && classification) {
    const found = getClassificationRow(db, tenantId, classification);
    resolvedClassificationId = found ? found.id : -1;
  }
  if (resolvedClassificationId != null) {
    clauses.push("classification_id = ?");
    params.push(resolvedClassificationId);
  }
  if (parentId !== undefined && parentId !== null && parentId !== "") {
    clauses.push("parent_class_id = ?");
    params.push(Number(parentId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(description) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 1000 });
  const { clause: order, params: orderParams } = orderClause(sort, {
    allowed: ["sort_order", "code", "name", "level", "created_at", "updated_at"],
    default: "sort_order",
    direction: "ASC",
  });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM cla_classes ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM cla_classes ${where} ORDER BY ${order}, code LIMIT ? OFFSET ?`, [...params, ...orderParams, limit, offset]);
  return { items: rows.map(publicClass), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function getClass(db, tenantId, ref) {
  return publicClass(requireClassRow(db, tenantId, ref));
}

export function updateClass(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const row = requireClassRow(db, tenantId, ref);
  if (row.status === "OBSOLETE") throw classImmutable(row.code, row.status);
  const before = publicClass(row);
  const patch = {
    name: body.name === undefined ? row.name : normalizeText(requireName(body.name), { max: 200 }),
    description: body.description === undefined ? row.description : normalizeText(body.description, { max: 2000 }),
    sort_order: body.sort_order === undefined ? row.sort_order : Number(body.sort_order),
    owner_user_id: body.owner_user_id === undefined ? row.owner_user_id : body.owner_user_id != null ? Number(body.owner_user_id) : null,
    effective_date: body.effective_date === undefined ? row.effective_date : normalizeText(body.effective_date, { max: 40 }) || null,
    obsolete_date: body.obsolete_date === undefined ? row.obsolete_date : normalizeText(body.obsolete_date, { max: 40 }) || null,
    metadata_json: body.metadata === undefined ? row.metadata_json : JSON.stringify(parseObject(body.metadata, {})),
    updated_by: actor?.id ?? null,
  };
  if (body.code !== undefined && normalizeUpper(body.code) !== row.code) {
    const nextCode = normalizeUpper(requireCode(body.code));
    const dup = queryOne(db, "SELECT id FROM cla_classes WHERE tenant_id = ? AND classification_id = ? AND code = ? AND id <> ?", [Number(tenantId), row.classification_id, nextCode, row.id]);
    if (dup) throw classConflict(nextCode);
    patch.code = nextCode;
  }
  const keys = Object.keys(patch).filter((key) => patch[key] !== undefined);
  run(db, `UPDATE cla_classes SET ${keys.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [...keys.map((key) => patch[key]), nowIso(), row.id]);
  let after = queryOne(db, "SELECT * FROM cla_classes WHERE id = ?", [row.id]);
  if (patch.code && patch.code !== row.code) {
    refreshSubtreePaths(db, tenantId, after);
    after = queryOne(db, "SELECT * FROM cla_classes WHERE id = ?", [row.id]);
  }
  invalidate(tenantId);
  recordChange(db, { tenantId, entityType: "CLASS", entityId: row.id, entityRef: after.code, action: "UPDATED", version: row.version, status: row.status, before, after: publicClass(after), actor, ip });
  publishClassificationEvent(
    db,
    { eventType: classificationEventCode("CLASS_UPDATED"), payload: { class_id: row.id }, objectType: "classification_class", objectId: row.id, tenantId },
    actor
  );
  return publicClass(after);
}

export function moveClass(db, tenantId, ref, { parentClassId = null, sortOrder = null } = {}, actor = null, ip = null) {
  const row = requireClassRow(db, tenantId, ref);
  let parent = null;
  if (parentClassId !== null && parentClassId !== undefined && parentClassId !== "") {
    parent = getClassRow(db, tenantId, parentClassId);
    if (!parent) throw classNotFound(parentClassId);
    if (Number(parent.classification_id) !== Number(row.classification_id)) throw invalidClass("Target parent class belongs to a different classification");
    if (Number(parent.id) === Number(row.id)) throw classCycle({ class_id: row.id, parent_class_id: parent.id });
    if (isDescendant(db, row, parent)) throw classCycle({ class_id: row.id, parent_class_id: parent.id, reason: "target is a descendant" });
  }
  const depth = parent ? Number(parent.level) + 1 : 0;
  const maxDepth = Number(getConfig(db, tenantId, "max_hierarchy_depth") || 64);
  if (depth >= maxDepth) throw classDepthExceeded(maxDepth);
  const before = publicClass(row);
  run(db, "UPDATE cla_classes SET parent_class_id = ?, path = ?, level = ?, sort_order = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    parent ? parent.id : null,
    childPath(parent?.path, row.code),
    depth,
    sortOrder != null ? Number(sortOrder) : row.sort_order,
    actor?.id ?? null,
    nowIso(),
    row.id,
  ]);
  refreshSubtreePaths(db, tenantId, queryOne(db, "SELECT * FROM cla_classes WHERE id = ?", [row.id]));
  invalidate(tenantId);
  const after = publicClass(queryOne(db, "SELECT * FROM cla_classes WHERE id = ?", [row.id]));
  recordChange(db, { tenantId, entityType: "CLASS", entityId: row.id, entityRef: row.code, action: "MOVED", version: row.version, status: row.status, before, after, actor, ip });
  publishClassificationEvent(
    db,
    { eventType: classificationEventCode("CLASS_MOVED"), payload: { class_id: row.id, parent_class_id: parent ? parent.id : null }, objectType: "classification_class", objectId: row.id, tenantId },
    actor
  );
  return after;
}

export function reorderClasses(db, tenantId, { classificationId, parentClassId = null, orderedIds = [] } = {}, actor = null, ip = null) {
  const ids = Array.isArray(orderedIds) ? orderedIds.map((id) => Number(id)) : [];
  if (!ids.length) return { updated: 0 };
  let updated = 0;
  ids.forEach((id, index) => {
    updated += run(db, "UPDATE cla_classes SET sort_order = ?, updated_at = ? WHERE tenant_id = ? AND classification_id = ? AND parent_class_id IS ? AND id = ?", [
      index,
      nowIso(),
      Number(tenantId),
      Number(classificationId),
      parentClassId != null ? Number(parentClassId) : null,
      id,
    ]).changes || 0;
  });
  invalidate(tenantId);
  recordChange(db, { tenantId, entityType: "CLASS", entityRef: `reorder:${classificationId}`, action: "REORDERED", details: { ordered_ids: ids }, actor, ip });
  return { updated };
}

// Deep copy of a class subtree (characteristics included), placed under an
// optional new parent. Useful for building a variant classification quickly.
export function copyClass(db, tenantId, ref, { targetClassificationId = null, targetParentClassId = null, codeSuffix = "_COPY" } = {}, actor = null, ip = null) {
  const source = requireClassRow(db, tenantId, ref);
  const classificationId = targetClassificationId != null ? Number(targetClassificationId) : Number(source.classification_id);
  const target = createClass(
    db,
    tenantId,
    {
      classification_id: classificationId,
      parent_class_id: targetParentClassId,
      code: `${source.code}${normalizeUpper(codeSuffix)}`,
      name: `${source.name} (copy)`,
      description: source.description,
      metadata: JSON.parse(source.metadata_json || "{}"),
    },
    actor,
    ip
  );
  const children = queryAll(db, "SELECT * FROM cla_classes WHERE parent_class_id = ? ORDER BY sort_order", [source.id]);
  for (const child of children) {
    const childCopy = copyClass(db, tenantId, child.id, { targetClassificationId: classificationId, targetParentClassId: target.id, codeSuffix: "" }, actor, ip);
    void childCopy;
  }
  // Copy locally-defined characteristics on the source class.
  const classChars = queryAll(db, "SELECT * FROM cla_class_characteristics WHERE class_id = ? AND status = 'ACTIVE'", [source.id]);
  for (const cc of classChars) {
    run(
      db,
      `INSERT INTO cla_class_characteristics
         (tenant_id, class_id, characteristic_id, sequence, required, multi_valued, origin, override_required, override_default,
          unit_override, min_value, max_value, allowed_value_mode, allowed_value_ids_json, default_value, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(tenantId),
        target.id,
        cc.characteristic_id,
        cc.sequence,
        cc.required,
        cc.multi_valued,
        cc.origin,
        cc.override_required,
        cc.override_default,
        cc.unit_override,
        cc.min_value,
        cc.max_value,
        cc.allowed_value_mode,
        cc.allowed_value_ids_json,
        cc.default_value,
        cc.status,
        actor?.id ?? null,
        nowIso(),
        nowIso(),
      ]
    );
  }
  return target;
}

export function deleteClass(db, tenantId, ref, actor = null, ip = null) {
  const row = requireClassRow(db, tenantId, ref);
  const children = Number(queryOne(db, "SELECT COUNT(*) AS c FROM cla_classes WHERE parent_class_id = ?", [row.id])?.c || 0);
  const assignments = Number(queryOne(db, "SELECT COUNT(*) AS c FROM cla_assignments WHERE class_id = ? AND status <> 'OBSOLETE'", [row.id])?.c || 0);
  if (children > 0) throw classConflict(`Class ${row.code} has ${children} child class(es); delete or move them first`);
  if (assignments > 0) throw classConflict(`Class ${row.code} is assigned to ${assignments} object(s); obsolete it instead`);
  run(db, "DELETE FROM cla_classes WHERE id = ?", [row.id]);
  invalidate(tenantId);
  recordChange(db, { tenantId, entityType: "CLASS", entityId: row.id, entityRef: row.code, action: "DELETED", version: row.version, status: row.status, before: publicClass(row), actor, ip });
  return { deleted: true, id: row.id, code: row.code };
}

export function setClassStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = requireClassRow(db, tenantId, ref);
  const next = assertClassStatus(status);
  if (row.status === "OBSOLETE" && next !== "OBSOLETE") throw classImmutable(row.code, row.status);
  const before = publicClass(row);
  run(db, "UPDATE cla_classes SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [next, actor?.id ?? null, nowIso(), row.id]);
  invalidate(tenantId);
  const after = publicClass(queryOne(db, "SELECT * FROM cla_classes WHERE id = ?", [row.id]));
  recordChange(db, { tenantId, entityType: "CLASS", entityId: row.id, entityRef: row.code, action: next === "ACTIVE" ? "ACTIVATED" : next === "OBSOLETE" ? "DEPRECATED" : "STATUS_CHANGED", version: row.version, status: next, before, after, actor, ip });
  if (next === "ACTIVE" || next === "OBSOLETE") {
    publishClassificationEvent(
      db,
      { eventType: classificationEventCode("CLASS_UPDATED"), payload: { class_id: row.id, status: next }, objectType: "classification_class", objectId: row.id, tenantId },
      actor
    );
  }
  return after;
}

// ── Queries ──────────────────────────────────────────────────────────────────

export function classChildren(db, tenantId, ref) {
  const row = requireClassRow(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM cla_classes WHERE tenant_id = ? AND parent_class_id = ? ORDER BY sort_order, code", [Number(tenantId), row.id]);
  return { items: rows.map(publicClass), total: rows.length, parent: publicClass(row) };
}

export function classAncestors(db, tenantId, ref) {
  const row = requireClassRow(db, tenantId, ref);
  const items = [];
  let current = row;
  const guard = new Set([row.id]);
  while (current.parent_class_id) {
    const parent = queryOne(db, "SELECT * FROM cla_classes WHERE id = ?", [current.parent_class_id]);
    if (!parent || guard.has(parent.id)) break;
    guard.add(parent.id);
    items.unshift(publicClass(parent));
    current = parent;
  }
  return { items, total: items.length, class: publicClass(row) };
}

export function classDescendants(db, tenantId, ref, { includeSelf = false } = {}) {
  const row = requireClassRow(db, tenantId, ref);
  const rows = queryAll(
    db,
    "SELECT * FROM cla_classes WHERE tenant_id = ? AND (path = ? OR path LIKE ?) ORDER BY level, sort_order, code",
    [Number(tenantId), row.path, `${row.path}/%`]
  );
  const items = rows.filter((entry) => includeSelf || entry.id !== row.id).map(publicClass);
  return { items, total: items.length, class: publicClass(row) };
}

// Builds the tree for one classification lazily (single query, assembled in
// memory). Callers that need very large trees should page by parent instead.
export function classTree(db, tenantId, classificationRef, { status = null, maxNodes = 50000 } = {}) {
  const classification = getClassificationRow(db, tenantId, classificationRef);
  if (!classification) throw classNotFound(classificationRef);
  const clauses = ["tenant_id = ?", "classification_id = ?"];
  const params = [Number(tenantId), classification.id];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  const rows = queryAll(db, `SELECT * FROM cla_classes WHERE ${clauses.join(" AND ")} ORDER BY level, sort_order, code LIMIT ?`, [...params, Number(maxNodes)]);
  const byId = new Map();
  const roots = [];
  for (const row of rows) byId.set(row.id, { ...publicClass(row), children: [] });
  for (const row of rows) {
    const node = byId.get(row.id);
    if (row.parent_class_id && byId.has(row.parent_class_id)) byId.get(row.parent_class_id).children.push(node);
    else roots.push(node);
  }
  return { classification_id: classification.id, classification_code: classification.code, nodes: roots, total: rows.length };
}

export function isDescendant(db, ancestorRow, candidateRow) {
  if (!ancestorRow || !candidateRow) return false;
  return candidateRow.path === ancestorRow.path || String(candidateRow.path || "").startsWith(`${ancestorRow.path}/`);
}

function refreshSubtreePaths(db, tenantId, rootRow) {
  if (!rootRow) return;
  void tenantId;
  // Rebuild paths by walking the subtree from the root using current parent links.
  const stack = [rootRow];
  while (stack.length) {
    const node = stack.pop();
    const parent = node.parent_class_id ? queryOne(db, "SELECT * FROM cla_classes WHERE id = ?", [node.parent_class_id]) : null;
    const path = parent ? `${parent.path}/${node.code}` : node.code;
    const level = parent ? Number(parent.level) + 1 : 0;
    if (path !== node.path || level !== node.level) {
      run(db, "UPDATE cla_classes SET path = ?, level = ?, updated_at = ? WHERE id = ?", [path, level, nowIso(), node.id]);
      node.path = path;
      node.level = level;
    }
    const children = queryAll(db, "SELECT * FROM cla_classes WHERE parent_class_id = ?", [node.id]);
    for (const child of children) stack.push(child);
  }
}

export function countClassifiedObjects(db, classId) {
  return Number(queryOne(db, "SELECT COUNT(*) AS c FROM cla_assignments WHERE class_id = ? AND status = 'ACTIVE'", [Number(classId)])?.c || 0);
}

export function createClassVersion(db, tenantId, ref, { changeReason = "", actor = null } = {}) {
  const row = requireClassRow(db, tenantId, ref);
  const version = Number(row.version || 1) + 1;
  run(db, "UPDATE cla_classes SET version = ?, updated_by = ?, updated_at = ? WHERE id = ?", [version, actor?.id ?? null, nowIso(), row.id]);
  const snapshot = publicClass(queryOne(db, "SELECT * FROM cla_classes WHERE id = ?", [row.id]));
  run(
    db,
    `INSERT INTO cla_class_versions (class_id, tenant_id, version, status, snapshot_json, change_reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, Number(tenantId), version, row.status, JSON.stringify(snapshot), normalizeText(changeReason, { max: 500 }), actor?.id ?? null, nowIso()]
  );
  invalidate(tenantId);
  recordChange(db, { tenantId, entityType: "CLASS", entityId: row.id, entityRef: row.code, action: "VERSIONED", version, status: row.status, details: { change_reason: changeReason }, actor });
  return { version, snapshot };
}

export function listClassVersions(db, tenantId, ref) {
  const row = requireClassRow(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM cla_class_versions WHERE class_id = ? ORDER BY version DESC", [row.id]);
  return { items: rows.map(publicClassVersion), total: rows.length };
}

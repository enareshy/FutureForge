// Where-used and uses analysis.
//
// Where-used answers "which BOMs/revisions/lines consume this component?", and
// uses answers "what does this BOM revision consume?". Both are read models built
// from the same line/header/revision tables so they stay consistent.
import { queryAll, queryOne } from "../../db.js";
import { publicLine } from "./repository.js";
import { paginate, normalizeUpper } from "./validation.js";
import { SOURCE_MODULE } from "./constants.js";

export function whereUsed(db, { tenantId, objectId, objectType = null, bomType = null, revisionStatus = null, includeObsolete = false, page = null, pageSize = null } = {}) {
  const clauses = ["l.tenant_id = ?", "l.child_object_id = ?"];
  const params = [Number(tenantId), String(objectId)];
  if (objectType) {
    clauses.push("l.child_object_type = ?");
    params.push(String(objectType).toLowerCase());
  }
  if (bomType) {
    clauses.push("h.bom_type = ?");
    params.push(normalizeUpper(bomType));
  }
  if (revisionStatus) {
    clauses.push("r.status = ?");
    params.push(normalizeUpper(revisionStatus));
  } else if (!includeObsolete) {
    clauses.push("l.line_status != 'OBSOLETE'");
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const base = `FROM bom_lines l
    JOIN bom_revisions r ON r.id = l.bom_revision_id
    JOIN bom_headers h ON h.id = r.bom_id`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 1000 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c ${base} ${where}`, params)?.c || 0);
  const rows = queryAll(
    db,
    `SELECT l.*, r.revision_number, r.status AS revision_status, r.revision_ref, r.bom_id, h.bom_number, h.name AS bom_name, h.bom_type, h.status AS bom_status, h.bom_ref
     ${base} ${where} ORDER BY h.bom_number, r.revision_sequence, l.sequence LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const items = rows.map((row) => ({
    line: publicLine(row),
    revision: { id: row.bom_revision_id, revision_ref: row.revision_ref, revision_number: row.revision_number, status: row.revision_status, bom_id: row.bom_id },
    bom: { id: row.bom_id, bom_ref: row.bom_ref, bom_number: row.bom_number, name: row.bom_name, bom_type: row.bom_type, status: row.bom_status },
  }));
  return { items, total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function uses(db, { tenantId, bomId = null, bomRef = null, revisionId = null, parentObjectId = null, includeInactive = true, page = null, pageSize = null } = {}) {
  const clauses = ["l.tenant_id = ?"];
  const params = [Number(tenantId)];
  if (revisionId != null) {
    clauses.push("l.bom_revision_id = ?");
    params.push(Number(revisionId));
  } else if (bomId != null || bomRef) {
    clauses.push("r.bom_id = ?");
    params.push(bomId != null ? Number(bomId) : resolveBomId(db, tenantId, bomRef));
  }
  if (parentObjectId != null) {
    clauses.push("l.parent_object_id = ?");
    params.push(String(parentObjectId));
  }
  if (!includeInactive) clauses.push("l.line_status = 'ACTIVE'");
  const where = `WHERE ${clauses.join(" AND ")}`;
  const base = "FROM bom_lines l JOIN bom_revisions r ON r.id = l.bom_revision_id";
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 1000 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c ${base} ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT l.*, r.revision_number, r.status AS revision_status ${base} ${where} ORDER BY l.sequence, l.id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return {
    items: rows.map((row) => ({ line: publicLine(row), revision_number: row.revision_number, revision_status: row.revision_status })),
    total,
    page: currentPage,
    page_size: limit,
    source_module: SOURCE_MODULE,
  };
}

function resolveBomId(db, tenantId, bomRef) {
  return Number(queryOne(db, "SELECT id FROM bom_headers WHERE tenant_id = ? AND (bom_ref = ? OR bom_number = ? COLLATE NOCASE)", [Number(tenantId), String(bomRef), String(bomRef)])?.id || 0);
}

// Multi-level where-used: walks upward through consuming BOMs until no further
// parent is found or maxDepth is reached. Cycle-safe.
export function multiLevelWhereUsed(db, tenantId, objectId, { objectType = null, maxDepth = 5 } = {}) {
  const visited = new Set();
  const levels = [];
  let frontier = [{ object_id: String(objectId), parent_object_id: null, line_id: null, bom_id: null, revision_id: null }];
  for (let depth = 1; depth <= Number(maxDepth); depth += 1) {
    const next = [];
    const seen = [];
    for (const node of frontier) {
      const key = `${node.object_id}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const result = whereUsed(db, { tenantId, objectId: node.object_id, objectType, pageSize: 1000 });
      for (const entry of result.items) {
        const parentBom = entry.bom;
        const record = {
          depth,
          line: entry.line,
          bom: parentBom,
          revision: entry.revision,
          parent_object_id: entry.line.parent_object_id ?? null,
        };
        seen.push(record);
        if (entry.line.parent_object_id != null && entry.line.parent_object_id !== "") {
          next.push({ object_id: String(entry.line.parent_object_id), ...record });
        } else if (entry.bom.id) {
          next.push({ object_id: `bom:${entry.bom.id}`, ...record, terminal: true });
        }
      }
    }
    if (seen.length) levels.push({ depth, items: seen });
    frontier = next.filter((node) => !node.terminal);
    if (!frontier.length) break;
  }
  return { object_id: String(objectId), levels, total: levels.reduce((sum, level) => sum + level.items.length, 0) };
}

export function componentUsageSummary(db, tenantId, objectId, options = {}) {
  const result = whereUsed(db, { tenantId, objectId, pageSize: 1 });
  const rows = queryAll(
    db,
    `SELECT h.bom_type, COUNT(*) AS c FROM bom_lines l JOIN bom_revisions r ON r.id = l.bom_revision_id JOIN bom_headers h ON h.id = r.bom_id
     WHERE l.tenant_id = ? AND l.child_object_id = ? ${options.bomType ? "AND h.bom_type = ?" : ""} GROUP BY h.bom_type`,
    options.bomType ? [Number(tenantId), String(objectId), normalizeUpper(options.bomType)] : [Number(tenantId), String(objectId)]
  );
  return { object_id: String(objectId), total_usages: result.total, by_bom_type: Object.fromEntries(rows.map((row) => [row.bom_type, Number(row.c)])) };
}

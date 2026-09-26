// BOM comparison (revision vs revision, revision vs baseline, baseline vs
// baseline).
//
// Lines are matched by child object + find number (falling back to line ref) and
// field-level differences are recorded. Results are persisted so a comparison is
// reproducible and auditable.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { publicComparison, publicComparisonResult } from "./repository.js";
import { comparisonRef } from "./refs.js";
import { recordChange } from "./history.js";
import { publishBomEvent, bomEventCode } from "./events.js";
import { requireRevisionRow } from "./revisions.js";
import { requireBaselineRow } from "./baseline.js";
import { getConfig } from "./configuration.js";
import { paginate, normalizeUpper, toBool } from "./validation.js";
import { invalidComparison, comparisonNotFound } from "./errors.js";
import { SOURCE_MODULE } from "./constants.js";

const COMPARE_FIELDS = ["quantity", "uom", "child_revision", "find_number", "sequence", "reference_designator", "usage", "optional", "variant_code", "line_status"];

function loadRevisionLines(db, revisionId) {
  return queryAll(db, "SELECT * FROM bom_lines WHERE bom_revision_id = ? ORDER BY sequence, id", [Number(revisionId)]).map((row) => ({
    key: `${row.child_object_type}:${row.child_object_id}|${row.find_number || ""}`,
    line_ref: row.line_ref,
    child_object_id: row.child_object_id,
    child_object_type: row.child_object_type,
    child_revision: row.child_revision,
    find_number: row.find_number,
    quantity: row.quantity,
    uom: row.uom,
    sequence: row.sequence,
    reference_designator: row.reference_designator,
    usage: row.usage,
    optional: Boolean(Number(row.optional)),
    variant_code: row.variant_code,
    line_status: row.line_status,
    path: row.parent_object_id ? `${row.parent_object_id}/${row.child_object_id}` : row.child_object_id || row.line_ref,
  }));
}

function loadBaselineLines(db, baselineId) {
  return queryAll(db, "SELECT * FROM bom_baseline_lines WHERE baseline_id = ? ORDER BY sequence, id", [Number(baselineId)]).map((row) => ({
    key: `${row.child_object_type}:${row.child_object_id}|${row.find_number || ""}`,
    line_ref: row.line_ref,
    child_object_id: row.child_object_id,
    child_object_type: row.child_object_type,
    child_revision: row.child_revision,
    find_number: row.find_number,
    quantity: row.quantity,
    uom: row.uom,
    sequence: row.sequence,
    reference_designator: row.reference_designator,
    usage: row.usage,
    optional: Boolean(Number(row.optional)),
    variant_code: row.variant_code,
    line_status: "ACTIVE",
    path: row.path || row.child_object_id || row.line_ref,
  }));
}

export function loadComparableLines(db, kind, id) {
  const normalized = normalizeUpper(kind);
  if (normalized === "REVISION") return loadRevisionLines(db, id);
  if (normalized === "BASELINE") return loadBaselineLines(db, id);
  throw invalidComparison(`Unsupported comparison kind: ${kind}`);
}

function assertArtifactExists(db, tenantId, kind, id) {
  if (kind === "REVISION") requireRevisionRow(db, tenantId, id);
  else if (kind === "BASELINE") requireBaselineRow(db, tenantId, id);
  else throw invalidComparison(`Unsupported comparison kind: ${kind}`);
}

function diffLine(left, right, { caseSensitive }) {
  const changes = [];
  for (const field of COMPARE_FIELDS) {
    let a = left?.[field];
    let b = right?.[field];
    if (!caseSensitive && typeof a === "string") a = a.toUpperCase();
    if (!caseSensitive && typeof b === "string") b = b.toUpperCase();
    if (a === b) continue;
    if (field === "quantity" && Number(left?.quantity) === Number(right?.quantity)) continue;
    if (field === "optional" && Boolean(left?.optional) === Boolean(right?.optional)) continue;
    changes.push({ field, before: left?.[field] ?? null, after: right?.[field] ?? null });
  }
  return changes;
}

export function compare(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const leftKind = normalizeUpper(body.left_kind ?? body.leftKind ?? "REVISION");
  const rightKind = normalizeUpper(body.right_kind ?? body.rightKind ?? "REVISION");
  const leftId = Number(body.left_id ?? body.leftId ?? body.left_revision_id ?? body.leftRevisionId ?? 0);
  const rightId = Number(body.right_id ?? body.rightId ?? body.right_revision_id ?? body.rightRevisionId ?? 0);
  const scope = normalizeUpper(body.scope ?? "LINE");
  const caseSensitive = toBool(body.case_sensitive ?? body.caseSensitive ?? getConfig(db, tenant, "compare_case_sensitive"), false);
  if (!leftId || !rightId) throw invalidComparison("Both left_id and right_id are required");
  if (leftKind === rightKind && leftId === rightId) throw invalidComparison("Cannot compare an artifact with itself");
  assertArtifactExists(db, tenant, leftKind, leftId);
  assertArtifactExists(db, tenant, rightKind, rightId);

  const leftRows = loadComparableLines(db, leftKind, leftId);
  const rightRows = loadComparableLines(db, rightKind, rightId);
  const rightIndex = new Map(rightRows.map((row) => [row.key, row]));
  const matched = new Set();
  const results = [];

  for (const left of leftRows) {
    const right = rightIndex.get(left.key);
    if (!right) {
      results.push({ change_type: "REMOVED", left, right: null, changes: [] });
      continue;
    }
    matched.add(left.key);
    const changes = diffLine(left, right, { caseSensitive });
    results.push({ change_type: changes.length ? "MODIFIED" : "UNCHANGED", left, right, changes });
  }
  for (const right of rightRows) {
    if (matched.has(right.key)) continue;
    results.push({ change_type: "ADDED", left: null, right, changes: [] });
  }

  const summary = {
    added: results.filter((r) => r.change_type === "ADDED").length,
    removed: results.filter((r) => r.change_type === "REMOVED").length,
    modified: results.filter((r) => r.change_type === "MODIFIED").length,
    unchanged: results.filter((r) => r.change_type === "UNCHANGED").length,
    matched: matched.size,
    scope,
  };
  const ts = nowIso();
  const insert = run(
    db,
    `INSERT INTO bom_comparisons
       (comparison_ref, tenant_id, organization_id, left_kind, left_id, right_kind, right_id, scope, status, summary_json,
        added_count, removed_count, modified_count, unchanged_count, match_count, duration_ms, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [comparisonRef(), tenant, null, leftKind, leftId, rightKind, rightId, scope, JSON.stringify(summary), summary.added, summary.removed,
      summary.modified, summary.unchanged, summary.matched, 0, actor?.id ?? null, ts]
  );
  const comparisonId = Number(insert.lastInsertRowid);
  for (const result of results) {
    run(
      db,
      `INSERT INTO bom_comparison_results
         (tenant_id, comparison_id, change_type, line_ref, child_object_id, child_object_type, find_number, path, before_json, after_json, changes_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenant, comparisonId, result.change_type, result.left?.line_ref || result.right?.line_ref || "",
        result.right?.child_object_id ?? result.left?.child_object_id ?? null, result.right?.child_object_type ?? result.left?.child_object_type ?? "part",
        result.right?.find_number ?? result.left?.find_number ?? "", result.right?.path ?? result.left?.path ?? "",
        JSON.stringify(result.left || {}), JSON.stringify(result.right || {}), JSON.stringify(result.changes), ts]
    );
  }
  const row = queryOne(db, "SELECT * FROM bom_comparisons WHERE id = ?", [comparisonId]);
  recordChange(db, { tenantId: tenant, entityType: "COMPARISON", entityId: comparisonId, entityRef: row.comparison_ref, action: "COMPLETED", status: "COMPLETED", after: summary, actor, ip, details: { left_kind: leftKind, left_id: leftId, right_kind: rightKind, right_id: rightId } });
  publishBomEvent(db, { eventType: bomEventCode("COMPARED"), objectType: "bom_comparison", objectId: comparisonId, tenantId: tenant, payload: { comparison_ref: row.comparison_ref, ...summary } }, actor);
  return { comparison: publicComparison(row), results: listComparisonResults(db, tenant, comparisonId, { pageSize: 100000 }).items };
}

export function getComparison(db, tenantId, ref) {
  const row = queryOne(db, "SELECT * FROM bom_comparisons WHERE tenant_id = ? AND (id = ? OR comparison_ref = ?)", [Number(tenantId), Number(ref) || -1, String(ref)]);
  if (!row) throw comparisonNotFound(ref);
  return publicComparison(row);
}

export function listComparisons(db, { tenantId, page, pageSize } = {}) {
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, "SELECT COUNT(*) AS c FROM bom_comparisons WHERE tenant_id = ?", [Number(tenantId)])?.c || 0);
  const rows = queryAll(db, "SELECT * FROM bom_comparisons WHERE tenant_id = ? ORDER BY id DESC LIMIT ? OFFSET ?", [Number(tenantId), limit, offset]);
  return { items: rows.map(publicComparison), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function listComparisonResults(db, tenantId, comparisonId, { changeType, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?", "comparison_id = ?"];
  const params = [Number(tenantId), Number(comparisonId)];
  if (changeType) {
    clauses.push("change_type = ?");
    params.push(normalizeUpper(changeType));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 200, maxPageSize: 100000 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM bom_comparison_results ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM bom_comparison_results ${where} ORDER BY id ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicComparisonResult), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function compareRevisions(db, tenantId, leftRevisionId, rightRevisionId, body = {}, actor = null, ip = null) {
  return compare(db, tenantId, { left_kind: "REVISION", left_id: leftRevisionId, right_kind: "REVISION", right_id: rightRevisionId, ...body }, actor, ip);
}

export function compareRevisionToBaseline(db, tenantId, revisionId, baselineId, body = {}, actor = null, ip = null) {
  return compare(db, tenantId, { left_kind: "REVISION", left_id: revisionId, right_kind: "BASELINE", right_id: baselineId, ...body }, actor, ip);
}

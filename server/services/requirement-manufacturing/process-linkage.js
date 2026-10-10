// BOP -> Operation -> Work-center linkage (Boundary 4).
//
// No parallel process-planning model is introduced. The linkage reuses existing
// primitives:
//   - A BOP / process plan is an existing `bom_headers` row with
//     `bom_type = 'BOP'` (resolved as a `bom_revision`).
//   - Operations and work centers are generic `objects` rows whose metadata
//     types this layer registers (`operation`, `work_center`).
//   - BOP -> operation linkage is a BOP `bom_lines` row whose
//     `child_object_type = 'operation'`; its `sequence` is the operation order.
//   - Operation -> work center, operation -> MBOM item and operation ->
//     predecessor operation are ordinary `object_relationships`
//     (`operation.performed-at.work-center`, `operation.consumes.part`,
//     `operation.precedes.operation`).
//
// Required extension (documented): operation ordering is expressed through
// `bom_lines.sequence` on BOP lines plus `operation.precedes.operation` edges;
// there is no dedicated process-sequence table. Reads are bounded and batched
// through the existing BOM / Object facades (no N+1, no full loads). Every
// public function has a synchronous twin (CLI/seeders/tests) and an `*Async`
// twin (async request transactions); a caller uses one layer, never both.
import { queryAll } from "../../db.js";
import { queryAllAsync } from "../../db-async.js";
import { Definitions as BomDefinitions, Revisions as BomRevisions, Lines as BomLines } from "../bom/index.js";
import { getObject, getObjectAsync, listObjects, listObjectsAsync, adjacency, adjacencyAsync } from "../objects.js";
import { getConfig } from "./configuration.js";
import { linkManufacturingObjects, linkManufacturingObjectsAsync } from "./manufacturing-objects.js";
import { parseObject, paginate } from "./validation.js";
import { bopNotFound, invalidProcess, operationNotFound, workCenterNotFound, invalidTarget } from "./errors.js";
import { OPERATION_OBJECT_TYPE, WORK_CENTER_OBJECT_TYPE, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "./constants.js";

const BOP_BOM_TYPE = "BOP";
const MBOM_BOM_TYPE = "MBOM";
const MAX_ROWS = 20000;

const REL = Object.freeze({
  OP_WORK_CENTER: "operation.performed-at.work-center",
  OP_CONSUMES_PART: "operation.consumes.part",
  OP_PRECEDES: "operation.precedes.operation",
});

const VALID = "VALID";
const MISSING_LINK = "MISSING_LINK";
const INVALID_LINK = "INVALID_LINK";
const NOT_EFFECTIVE = "NOT_EFFECTIVE";

const OPERATION_EDGE_CODES = [REL.OP_WORK_CENTER, REL.OP_CONSUMES_PART, REL.OP_PRECEDES];

// ── Small helpers ───────────────────────────────────────────────────────────

function chunk(values, size = 800) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function uniqueNumbers(values) {
  const set = new Set();
  for (const value of values) {
    const num = Number(value);
    if (Number.isInteger(num) && num > 0) set.add(num);
  }
  return [...set];
}

function uniqueStrings(values) {
  const set = new Set();
  for (const value of values) {
    const text = value === undefined || value === null ? "" : String(value);
    if (text) set.add(text);
  }
  return [...set];
}

function lineIsActive(line) {
  return String(line?.line_status || "ACTIVE").toUpperCase() === "ACTIVE";
}

function operationLineOf(line) {
  return String(line.child_object_type || "").toLowerCase() === OPERATION_OBJECT_TYPE && line.child_object_id != null;
}

function paginateItems(items, opts = {}) {
  const { limit, offset, page, pageSize } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  return { items: items.slice(offset, offset + limit), total: items.length, page, page_size: pageSize };
}

function objectDescriptor(object) {
  if (!object) return null;
  return {
    object_id: String(object.id),
    code: object.code || "",
    name: object.name || "",
    status: object.status || "",
    revision: object.revision ?? null,
    object_type: object.type?.code || "",
    organization_id: object.organization_id ?? null,
  };
}

function revisionDescriptor(revision, header) {
  return {
    revision_id: revision.id,
    revision_ref: revision.revision_ref || "",
    revision_number: revision.revision_number,
    status: revision.status || "",
    lifecycle_state: revision.lifecycle_state || revision.status || "",
    bom_id: header?.id ?? revision.bom_id ?? null,
    bom_number: header?.bom_number ?? "",
    bom_type: header?.bom_type ?? "",
    name: header?.name ?? "",
    plant_id: header?.plant_id ?? null,
    site_id: header?.site_id ?? null,
    configuration_context: revision.configuration_context || "",
    valid_from: revision.valid_from ?? null,
    valid_to: revision.valid_to ?? null,
  };
}

function bomDescriptor(row) {
  return {
    bom_id: row.bom_id,
    bom_number: row.bom_number,
    name: row.name,
    bom_type: row.bom_type,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    revision_id: row.revision_id,
    revision_ref: row.revision_ref || "",
    revision_number: row.revision_number,
    status: row.status || "",
    configuration_context: row.configuration_context || "",
    valid_from: row.valid_from ?? null,
    valid_to: row.valid_to ?? null,
  };
}

// ── Sync data access ────────────────────────────────────────────────────────

const LINE_SQL = (status) => `SELECT * FROM bom_lines WHERE tenant_id = ? AND bom_revision_id = ? ${status}
               ORDER BY COALESCE(NULLIF(sequence,0), 2147483647), id LIMIT ${MAX_ROWS}`;

function getRevisionAndHeader(db, tenantId, ref) {
  const revision = BomRevisions.getRevisionRow(db, tenantId, ref);
  if (!revision) return { revision: null, header: null };
  const header = revision.bom_id ? BomDefinitions.getBomRow(db, tenantId, revision.bom_id) : null;
  return { revision, header };
}

async function getRevisionAndHeaderAsync(db, tenantId, ref) {
  const revision = await BomRevisions.getRevisionRowAsync(db, tenantId, ref);
  if (!revision) return { revision: null, header: null };
  const header = revision.bom_id ? await BomDefinitions.getBomRowAsync(db, tenantId, revision.bom_id) : null;
  return { revision, header };
}

function requireTypedRevision(db, tenantId, ref, bomType) {
  const { revision, header } = getRevisionAndHeader(db, tenantId, ref);
  if (!revision) throw bopNotFound(ref);
  if (!header || String(header.bom_type).toUpperCase() !== bomType) throw invalidProcess(`${ref} is not a ${bomType} revision`, { bom_type: header?.bom_type ?? null });
  return { revision, header };
}

async function requireTypedRevisionAsync(db, tenantId, ref, bomType) {
  const { revision, header } = await getRevisionAndHeaderAsync(db, tenantId, ref);
  if (!revision) throw bopNotFound(ref);
  if (!header || String(header.bom_type).toUpperCase() !== bomType) throw invalidProcess(`${ref} is not a ${bomType} revision`, { bom_type: header?.bom_type ?? null });
  return { revision, header };
}

function readLines(db, tenantId, revisionId, includeInactive) {
  return queryAll(db, LINE_SQL(includeInactive ? "" : "AND line_status = 'ACTIVE'"), [Number(tenantId), Number(revisionId)]);
}

function readLinesAsync(db, tenantId, revisionId, includeInactive) {
  return queryAllAsync(db, LINE_SQL(includeInactive ? "" : "AND line_status = 'ACTIVE'"), [Number(tenantId), Number(revisionId)]);
}

function objectsByIds(db, tenantId, ids) {
  const numeric = uniqueNumbers(ids);
  if (!numeric.length) return [];
  return listObjects(db, { tenantId, ids: numeric.join(","), pageSize: MAX_ROWS }, tenantId).items;
}

function objectsByIdsAsync(db, tenantId, ids) {
  const numeric = uniqueNumbers(ids);
  if (!numeric.length) return Promise.resolve([]);
  return listObjectsAsync(db, { tenantId, ids: numeric.join(","), pageSize: MAX_ROWS }, tenantId).then((result) => result.items);
}

function relationsFor(db, tenantId, ids, typeCodes, direction) {
  const numeric = uniqueNumbers(ids);
  if (!numeric.length) return [];
  return adjacency(db, numeric, { tenantId, direction, typeCodes, limit: MAX_ROWS });
}

function relationsForAsync(db, tenantId, ids, typeCodes, direction) {
  const numeric = uniqueNumbers(ids);
  if (!numeric.length) return Promise.resolve([]);
  return adjacencyAsync(db, numeric, { tenantId, direction, typeCodes, limit: MAX_ROWS });
}

function bopRowsSql(extraFilter) {
  return `SELECT h.id AS bom_id, h.bom_number, h.name, h.bom_type, h.plant_id, h.site_id,
                 r.id AS revision_id, r.revision_ref, r.revision_number, r.status, r.lifecycle_state,
                 r.configuration_context, r.valid_from, r.valid_to, l.child_object_id AS key_object_id
            FROM bom_lines l
            JOIN bom_revisions r ON r.id = l.bom_revision_id
            JOIN bom_headers h ON h.id = r.bom_id
           WHERE l.tenant_id = ? AND h.bom_type = ? ${extraFilter} AND (__CLAUSES__)
           ORDER BY l.id LIMIT ${MAX_ROWS}`;
}

function buildKeyQuery(ids) {
  const clauses = chunk(ids).map((part) => `l.child_object_id IN (${placeholders(part)})`);
  const params = [];
  for (const part of chunk(ids)) params.push(...part);
  return { clauses: clauses.join(" OR "), params };
}

function bopRowsForOperations(db, tenantId, operationIds) {
  const ids = uniqueStrings(operationIds);
  if (!ids.length) return [];
  const { clauses, params } = buildKeyQuery(ids);
  const sql = bopRowsSql("AND l.child_object_type = 'operation'").replace("(__CLAUSES__)", clauses);
  return queryAll(db, sql, [Number(tenantId), BOP_BOM_TYPE, ...params]);
}

function bopRowsForOperationsAsync(db, tenantId, operationIds) {
  const ids = uniqueStrings(operationIds);
  if (!ids.length) return Promise.resolve([]);
  const { clauses, params } = buildKeyQuery(ids);
  const sql = bopRowsSql("AND l.child_object_type = 'operation'").replace("(__CLAUSES__)", clauses);
  return queryAllAsync(db, sql, [Number(tenantId), BOP_BOM_TYPE, ...params]);
}

function mbomRowsForItems(db, tenantId, itemIds) {
  const ids = uniqueStrings(itemIds);
  if (!ids.length) return [];
  const { clauses, params } = buildKeyQuery(ids);
  const sql = bopRowsSql("").replace("(__CLAUSES__)", clauses);
  return queryAll(db, sql, [Number(tenantId), MBOM_BOM_TYPE, ...params]);
}

function mbomRowsForItemsAsync(db, tenantId, itemIds) {
  const ids = uniqueStrings(itemIds);
  if (!ids.length) return Promise.resolve([]);
  const { clauses, params } = buildKeyQuery(ids);
  const sql = bopRowsSql("").replace("(__CLAUSES__)", clauses);
  return queryAllAsync(db, sql, [Number(tenantId), MBOM_BOM_TYPE, ...params]);
}

function objectOfType(db, tenantId, ref, type) {
  let object = null;
  try {
    object = getObject(db, ref, tenantId);
  } catch {
    object = null;
  }
  return object && String(object.type?.code || "").toLowerCase() === type ? object : null;
}

async function objectOfTypeAsync(db, tenantId, ref, type) {
  let object = null;
  try {
    object = await getObjectAsync(db, ref, tenantId);
  } catch {
    object = null;
  }
  return object && String(object.type?.code || "").toLowerCase() === type ? object : null;
}

function anyObject(db, tenantId, ref) {
  try {
    return db ? getObject(db, ref, tenantId) : null;
  } catch {
    return null;
  }
}

async function anyObjectAsync(db, tenantId, ref) {
  try {
    return await getObjectAsync(db, ref, tenantId);
  } catch {
    return null;
  }
}

// ── Pure builders ───────────────────────────────────────────────────────────

function indexEdges(edges) {
  const workCenter = new Map();
  const consumes = new Map();
  const precedesOut = new Map();
  const precedesIn = new Map();
  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for (const rel of edges) {
    const code = rel.relationship_type?.code;
    const source = String(rel.source?.id);
    const target = String(rel.target?.id);
    if (code === REL.OP_WORK_CENTER) push(workCenter, source, target);
    else if (code === REL.OP_CONSUMES_PART) push(consumes, source, target);
    else if (code === REL.OP_PRECEDES) {
      push(precedesOut, source, target);
      push(precedesIn, target, source);
    }
  }
  return { workCenter, consumes, precedesOut, precedesIn };
}

function buildOperationEntries(lines, operationObjects, edges, requiredWorkCenter) {
  const opById = new Map(operationObjects.map((obj) => [String(obj.id), obj]));
  const { workCenter, consumes, precedesOut, precedesIn } = indexEdges(edges);
  return lines.filter(operationLineOf).map((line) => {
    const opId = String(line.child_object_id);
    const operation = opById.get(opId) || null;
    const workCenterIds = (workCenter.get(opId) || []).map(String);
    const consumedIds = (consumes.get(opId) || []).map(String);
    const active = lineIsActive(line);
    let status = operation ? (active ? VALID : NOT_EFFECTIVE) : INVALID_LINK;
    if (operation && active && requiredWorkCenter && workCenterIds.length === 0) status = MISSING_LINK;
    return {
      line_ref: line.line_ref || "",
      operation_object_id: opId,
      operation: operation ? objectDescriptor(operation) : { object_id: opId, code: "", name: "", status: "", object_type: OPERATION_OBJECT_TYPE, found: false },
      sequence: Number(line.sequence || 0),
      find_number: line.find_number || "",
      quantity: line.quantity,
      uom: line.uom || "",
      parent_object_id: line.parent_object_id ?? null,
      usage: line.usage || "",
      configuration_context: line.configuration_context || "",
      line_status: line.line_status,
      effectivity: parseObject(line.effectivity_json, {}),
      work_center_ids: workCenterIds,
      consumed_object_ids: consumedIds,
      predecessor_ids: (precedesIn.get(opId) || []).map(String),
      successor_ids: (precedesOut.get(opId) || []).map(String),
      status,
    };
  });
}

function operationSummary(items) {
  return {
    operations: items.length,
    valid: items.filter((item) => item.status === VALID).length,
    missing_work_center: items.filter((item) => item.status === MISSING_LINK).length,
    invalid: items.filter((item) => item.status === INVALID_LINK).length,
    not_effective: items.filter((item) => item.status === NOT_EFFECTIVE).length,
  };
}

function detectSequenceConflicts(entries, edges) {
  const seqById = new Map(entries.map((entry) => [entry.operation_object_id, entry.sequence]));
  const ids = new Set(seqById.keys());
  const conflicts = [];
  const graph = new Map();
  for (const rel of edges) {
    if (rel.relationship_type?.code !== REL.OP_PRECEDES) continue;
    const from = String(rel.source?.id);
    const to = String(rel.target?.id);
    if (!ids.has(from) || !ids.has(to)) continue;
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from).push(to);
    if (seqById.get(from) > seqById.get(to)) {
      conflicts.push({ type: "SEQUENCE_CONFLICT", predecessor_id: from, successor_id: to, predecessor_sequence: seqById.get(from), successor_sequence: seqById.get(to) });
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const hasCycle = (node) => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) || []) if (hasCycle(next)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  for (const id of ids) {
    if (hasCycle(id)) {
      conflicts.push({ type: "SEQUENCE_CYCLE", operation_id: id });
      break;
    }
  }
  return conflicts;
}

function distinctBomDescriptors(rows) {
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    const key = `${row.bom_type}:${row.revision_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(bomDescriptor(row));
  }
  return output;
}

// ── Core orchestration (sync + async) ───────────────────────────────────────

function collectBopOperations(db, tenantId, bopRef, includeInactive) {
  const { revision, header } = requireTypedRevision(db, tenantId, bopRef, BOP_BOM_TYPE);
  const lines = readLines(db, tenantId, revision.id, includeInactive);
  const operationIds = uniqueNumbers(lines.filter(operationLineOf).map((line) => line.child_object_id));
  const operationObjects = objectsByIds(db, tenantId, operationIds);
  const edges = relationsFor(db, tenantId, operationIds, OPERATION_EDGE_CODES, "both");
  return { revision, header, lines, operationIds, operationObjects, edges };
}

async function collectBopOperationsAsync(db, tenantId, bopRef, includeInactive) {
  const { revision, header } = await requireTypedRevisionAsync(db, tenantId, bopRef, BOP_BOM_TYPE);
  const lines = await readLinesAsync(db, tenantId, revision.id, includeInactive);
  const operationIds = uniqueNumbers(lines.filter(operationLineOf).map((line) => line.child_object_id));
  const [operationObjects, edges] = await Promise.all([
    objectsByIdsAsync(db, tenantId, operationIds),
    relationsForAsync(db, tenantId, operationIds, OPERATION_EDGE_CODES, "both"),
  ]);
  return { revision, header, lines, operationIds, operationObjects, edges };
}

export function bopOperations(db, tenantId, bopRef, opts = {}) {
  const { revision, header, lines, operationObjects, edges } = collectBopOperations(db, tenantId, bopRef, opts.includeInactive !== false);
  const requiredWorkCenter = Boolean(getConfig(db, tenantId, "require_operation_work_center"));
  const items = buildOperationEntries(lines, operationObjects, edges, requiredWorkCenter);
  const wcById = new Map(objectsByIds(db, tenantId, items.flatMap((item) => item.work_center_ids)).map((obj) => [String(obj.id), obj]));
  const coById = new Map(objectsByIds(db, tenantId, items.flatMap((item) => item.consumed_object_ids)).map((obj) => [String(obj.id), obj]));
  for (const item of items) {
    item.work_centers = item.work_center_ids.map((id) => objectDescriptor(wcById.get(id))).filter(Boolean);
    const mbomItems = item.consumed_object_ids.map((id) => objectDescriptor(coById.get(id))).filter(Boolean);
    delete item.consumed_object_ids;
    item.mbom_items = mbomItems;
  }
  const summary = operationSummary(items);
  const paged = paginateItems(items, opts);
  return {
    direction: "BOP_TO_OPERATION",
    bop_revision: revisionDescriptor(revision, header),
    items: paged.items,
    summary,
    total: paged.total,
    page: paged.page,
    page_size: paged.page_size,
    required_work_center: requiredWorkCenter,
    source_module: "requirement-manufacturing",
  };
}

export async function bopOperationsAsync(db, tenantId, bopRef, opts = {}) {
  const { revision, header, lines, operationObjects, edges } = await collectBopOperationsAsync(db, tenantId, bopRef, opts.includeInactive !== false);
  const requiredWorkCenter = Boolean(getConfig(db, tenantId, "require_operation_work_center"));
  const items = buildOperationEntries(lines, operationObjects, edges, requiredWorkCenter);
  const [wcObjects, coObjects] = await Promise.all([
    objectsByIdsAsync(db, tenantId, items.flatMap((item) => item.work_center_ids)),
    objectsByIdsAsync(db, tenantId, items.flatMap((item) => item.consumed_object_ids)),
  ]);
  const wcById = new Map(wcObjects.map((obj) => [String(obj.id), obj]));
  const coById = new Map(coObjects.map((obj) => [String(obj.id), obj]));
  for (const item of items) {
    item.work_centers = item.work_center_ids.map((id) => objectDescriptor(wcById.get(id))).filter(Boolean);
    const mbomItems = item.consumed_object_ids.map((id) => objectDescriptor(coById.get(id))).filter(Boolean);
    delete item.consumed_object_ids;
    item.mbom_items = mbomItems;
  }
  const summary = operationSummary(items);
  const paged = paginateItems(items, opts);
  return {
    direction: "BOP_TO_OPERATION",
    bop_revision: revisionDescriptor(revision, header),
    items: paged.items,
    summary,
    total: paged.total,
    page: paged.page,
    page_size: paged.page_size,
    required_work_center: requiredWorkCenter,
    source_module: "requirement-manufacturing",
  };
}

// ── Operation <-> work center ───────────────────────────────────────────────

export function operationWorkCenters(db, tenantId, operationRef, opts = {}) {
  const operation = objectOfType(db, tenantId, operationRef, OPERATION_OBJECT_TYPE);
  if (!operation) throw operationNotFound(operationRef);
  const rels = relationsFor(db, tenantId, [operation.id], [REL.OP_WORK_CENTER], "out");
  const workCenters = objectsByIds(db, tenantId, rels.map((rel) => rel.target?.id));
  const paged = paginateItems(workCenters.map(objectDescriptor), opts);
  return { direction: "OPERATION_TO_WORK_CENTER", operation: objectDescriptor(operation), items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

export async function operationWorkCentersAsync(db, tenantId, operationRef, opts = {}) {
  const operation = await objectOfTypeAsync(db, tenantId, operationRef, OPERATION_OBJECT_TYPE);
  if (!operation) throw operationNotFound(operationRef);
  const rels = await relationsForAsync(db, tenantId, [operation.id], [REL.OP_WORK_CENTER], "out");
  const workCenters = await objectsByIdsAsync(db, tenantId, rels.map((rel) => rel.target?.id));
  const paged = paginateItems(workCenters.map(objectDescriptor), opts);
  return { direction: "OPERATION_TO_WORK_CENTER", operation: objectDescriptor(operation), items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

function operationsWithBops(operations, bopRows, opts) {
  const bopByOperation = new Map();
  for (const row of bopRows) {
    const key = String(row.key_object_id);
    if (!bopByOperation.has(key)) bopByOperation.set(key, []);
    bopByOperation.get(key).push(bomDescriptor(row));
  }
  const items = operations.map((operation) => ({ operation: objectDescriptor(operation), bops: bopByOperation.get(String(operation.id)) || [] }));
  return paginateItems(items, opts);
}

export function workCenterOperations(db, tenantId, workCenterRef, opts = {}) {
  const workCenter = objectOfType(db, tenantId, workCenterRef, WORK_CENTER_OBJECT_TYPE);
  if (!workCenter) throw workCenterNotFound(workCenterRef);
  const rels = relationsFor(db, tenantId, [workCenter.id], [REL.OP_WORK_CENTER], "in");
  const operationIds = uniqueNumbers(rels.map((rel) => rel.source?.id));
  const operations = objectsByIds(db, tenantId, operationIds);
  const bopRows = bopRowsForOperations(db, tenantId, operationIds);
  const paged = operationsWithBops(operations, bopRows, opts);
  return { direction: "WORK_CENTER_TO_OPERATION", work_center: objectDescriptor(workCenter), items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

export async function workCenterOperationsAsync(db, tenantId, workCenterRef, opts = {}) {
  const workCenter = await objectOfTypeAsync(db, tenantId, workCenterRef, WORK_CENTER_OBJECT_TYPE);
  if (!workCenter) throw workCenterNotFound(workCenterRef);
  const rels = await relationsForAsync(db, tenantId, [workCenter.id], [REL.OP_WORK_CENTER], "in");
  const operationIds = uniqueNumbers(rels.map((rel) => rel.source?.id));
  const [operations, bopRows] = await Promise.all([objectsByIdsAsync(db, tenantId, operationIds), bopRowsForOperationsAsync(db, tenantId, operationIds)]);
  const paged = operationsWithBops(operations, bopRows, opts);
  return { direction: "WORK_CENTER_TO_OPERATION", work_center: objectDescriptor(workCenter), items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

// ── Operation <-> MBOM item ─────────────────────────────────────────────────

function itemsWithMboms(items, mbomRows, opts) {
  const mbomByItem = new Map();
  for (const row of mbomRows) {
    const key = String(row.key_object_id);
    if (!mbomByItem.has(key)) mbomByItem.set(key, []);
    mbomByItem.get(key).push(bomDescriptor(row));
  }
  const output = items.map((item) => ({ item: objectDescriptor(item), mboms: mbomByItem.get(String(item.id)) || [] }));
  return paginateItems(output, opts);
}

export function operationMbomItems(db, tenantId, operationRef, opts = {}) {
  const operation = objectOfType(db, tenantId, operationRef, OPERATION_OBJECT_TYPE);
  if (!operation) throw operationNotFound(operationRef);
  const rels = relationsFor(db, tenantId, [operation.id], [REL.OP_CONSUMES_PART], "out");
  const itemIds = uniqueNumbers(rels.map((rel) => rel.target?.id));
  const items = objectsByIds(db, tenantId, itemIds);
  const mbomRows = mbomRowsForItems(db, tenantId, itemIds);
  const paged = itemsWithMboms(items, mbomRows, opts);
  return { direction: "OPERATION_TO_MBOM_ITEM", operation: objectDescriptor(operation), items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

export async function operationMbomItemsAsync(db, tenantId, operationRef, opts = {}) {
  const operation = await objectOfTypeAsync(db, tenantId, operationRef, OPERATION_OBJECT_TYPE);
  if (!operation) throw operationNotFound(operationRef);
  const rels = await relationsForAsync(db, tenantId, [operation.id], [REL.OP_CONSUMES_PART], "out");
  const itemIds = uniqueNumbers(rels.map((rel) => rel.target?.id));
  const [items, mbomRows] = await Promise.all([objectsByIdsAsync(db, tenantId, itemIds), mbomRowsForItemsAsync(db, tenantId, itemIds)]);
  const paged = itemsWithMboms(items, mbomRows, opts);
  return { direction: "OPERATION_TO_MBOM_ITEM", operation: objectDescriptor(operation), items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

export function mbomItemOperations(db, tenantId, itemRef, opts = {}) {
  const item = anyObject(db, tenantId, itemRef);
  if (!item) throw invalidTarget(`MBOM item not found: ${itemRef}`, { ref: itemRef });
  const rels = relationsFor(db, tenantId, [item.id], [REL.OP_CONSUMES_PART], "in");
  const operationIds = uniqueNumbers(rels.map((rel) => rel.source?.id));
  const operations = objectsByIds(db, tenantId, operationIds);
  const bopRows = bopRowsForOperations(db, tenantId, operationIds);
  const paged = operationsWithBops(operations, bopRows, opts);
  return { direction: "MBOM_ITEM_TO_OPERATION", item: objectDescriptor(item), items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

export async function mbomItemOperationsAsync(db, tenantId, itemRef, opts = {}) {
  const item = await anyObjectAsync(db, tenantId, itemRef);
  if (!item) throw invalidTarget(`MBOM item not found: ${itemRef}`, { ref: itemRef });
  const rels = await relationsForAsync(db, tenantId, [item.id], [REL.OP_CONSUMES_PART], "in");
  const operationIds = uniqueNumbers(rels.map((rel) => rel.source?.id));
  const [operations, bopRows] = await Promise.all([objectsByIdsAsync(db, tenantId, operationIds), bopRowsForOperationsAsync(db, tenantId, operationIds)]);
  const paged = operationsWithBops(operations, bopRows, opts);
  return { direction: "MBOM_ITEM_TO_OPERATION", item: objectDescriptor(item), items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

// ── BOP <-> MBOM navigation (through operations) ────────────────────────────

export function listBopMboms(db, tenantId, bopRef, opts = {}) {
  const { revision, header, operationIds } = collectBopOperations(db, tenantId, bopRef, true);
  const rels = relationsFor(db, tenantId, operationIds, [REL.OP_CONSUMES_PART], "out");
  const itemIds = uniqueNumbers(rels.map((rel) => rel.target?.id));
  const rows = mbomRowsForItems(db, tenantId, itemIds);
  const paged = paginateItems(distinctBomDescriptors(rows), opts);
  return { direction: "BOP_TO_MBOM", bop_revision: revisionDescriptor(revision, header), items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

export async function listBopMbomsAsync(db, tenantId, bopRef, opts = {}) {
  const { revision, header, operationIds } = await collectBopOperationsAsync(db, tenantId, bopRef, true);
  const rels = await relationsForAsync(db, tenantId, operationIds, [REL.OP_CONSUMES_PART], "out");
  const itemIds = uniqueNumbers(rels.map((rel) => rel.target?.id));
  const rows = await mbomRowsForItemsAsync(db, tenantId, itemIds);
  const paged = paginateItems(distinctBomDescriptors(rows), opts);
  return { direction: "BOP_TO_MBOM", bop_revision: revisionDescriptor(revision, header), items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

export function listMbomBops(db, tenantId, mbomRef, opts = {}) {
  const { revision, header } = requireTypedRevision(db, tenantId, mbomRef, MBOM_BOM_TYPE);
  const lines = readLines(db, tenantId, revision.id, true);
  const itemIds = uniqueNumbers(lines.filter((line) => line.child_object_id != null && !operationLineOf(line)).map((line) => line.child_object_id));
  const rels = relationsFor(db, tenantId, itemIds, [REL.OP_CONSUMES_PART], "in");
  const operationIds = uniqueNumbers(rels.map((rel) => rel.source?.id));
  const rows = bopRowsForOperations(db, tenantId, operationIds);
  const paged = paginateItems(distinctBomDescriptors(rows), opts);
  return { direction: "MBOM_TO_BOP", mbom_revision: revisionDescriptor(revision, header), items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

export async function listMbomBopsAsync(db, tenantId, mbomRef, opts = {}) {
  const { revision, header } = await requireTypedRevisionAsync(db, tenantId, mbomRef, MBOM_BOM_TYPE);
  const lines = await readLinesAsync(db, tenantId, revision.id, true);
  const itemIds = uniqueNumbers(lines.filter((line) => line.child_object_id != null && !operationLineOf(line)).map((line) => line.child_object_id));
  const rels = await relationsForAsync(db, tenantId, itemIds, [REL.OP_CONSUMES_PART], "in");
  const operationIds = uniqueNumbers(rels.map((rel) => rel.source?.id));
  const rows = await bopRowsForOperationsAsync(db, tenantId, operationIds);
  const paged = paginateItems(distinctBomDescriptors(rows), opts);
  return { direction: "MBOM_TO_BOP", mbom_revision: revisionDescriptor(revision, header), items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

// ── Process sequence (order + validation) ───────────────────────────────────

function sequenceResult(revision, header, lines, operationObjects, edges, opts) {
  const opById = new Map(operationObjects.map((obj) => [String(obj.id), obj]));
  const entries = lines.filter(operationLineOf).map((line) => ({
    operation_object_id: String(line.child_object_id),
    sequence: Number(line.sequence || 0),
    find_number: line.find_number || "",
    operation: objectDescriptor(opById.get(String(line.child_object_id))) || { object_id: String(line.child_object_id), found: false },
  }));
  const conflicts = detectSequenceConflicts(entries, edges);
  const paged = paginateItems(entries, opts);
  return { direction: "BOP_SEQUENCE", bop_revision: revisionDescriptor(revision, header), items: paged.items, conflicts, valid: conflicts.length === 0, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

export function bopProcessSequence(db, tenantId, bopRef, opts = {}) {
  const { revision, header, lines, operationObjects, edges } = collectBopOperations(db, tenantId, bopRef, false);
  return sequenceResult(revision, header, lines, operationObjects, edges, opts);
}

export async function bopProcessSequenceAsync(db, tenantId, bopRef, opts = {}) {
  const { revision, header, lines, operationObjects, edges } = await collectBopOperationsAsync(db, tenantId, bopRef, false);
  return sequenceResult(revision, header, lines, operationObjects, edges, opts);
}

// ── Process coverage ────────────────────────────────────────────────────────

function bopCoverageResult(revision, header, lines, operationObjects, edges, requiredWorkCenter) {
  const items = buildOperationEntries(lines, operationObjects, edges, requiredWorkCenter);
  const summary = operationSummary(items);
  const missingWorkCenters = items.filter((item) => item.status === MISSING_LINK).map((item) => ({ operation_object_id: item.operation_object_id, reason: MISSING_LINK }));
  const invalid = items.filter((item) => item.status === INVALID_LINK).map((item) => ({ operation_object_id: item.operation_object_id, reason: INVALID_LINK }));
  return {
    direction: "BOP_PROCESS_COVERAGE",
    bop_revision: revisionDescriptor(revision, header),
    summary,
    missing_work_centers: missingWorkCenters,
    invalid_operations: invalid,
    required_work_center: requiredWorkCenter,
    coverage: summary.missing_work_center > 0 || summary.invalid > 0 ? "PARTIAL" : summary.operations > 0 ? "ALLOCATED" : "UNALLOCATED",
    source_module: "requirement-manufacturing",
  };
}

export function bopProcessCoverage(db, tenantId, bopRef) {
  const { revision, header, lines, operationObjects, edges } = collectBopOperations(db, tenantId, bopRef, true);
  return bopCoverageResult(revision, header, lines, operationObjects, edges, Boolean(getConfig(db, tenantId, "require_operation_work_center")));
}

export async function bopProcessCoverageAsync(db, tenantId, bopRef) {
  const { revision, header, lines, operationObjects, edges } = await collectBopOperationsAsync(db, tenantId, bopRef, true);
  return bopCoverageResult(revision, header, lines, operationObjects, edges, Boolean(getConfig(db, tenantId, "require_operation_work_center")));
}

function mbomCoverageResult(revision, header, itemLines, assigned, required, opts) {
  const unassigned = itemLines
    .filter((line) => !assigned.has(String(line.child_object_id)))
    .map((line) => ({ line_ref: line.line_ref || "", object_id: String(line.child_object_id), object_type: line.child_object_type || "", reason: MISSING_LINK }));
  const total = itemLines.length;
  const covered = total - unassigned.length;
  const paged = paginateItems(unassigned, opts);
  return {
    direction: "MBOM_PROCESS_COVERAGE",
    mbom_revision: revisionDescriptor(revision, header),
    summary: { items: total, assigned: covered, unassigned: unassigned.length },
    unassigned_items: paged.items,
    total: paged.total,
    page: paged.page,
    page_size: paged.page_size,
    required_assignment: required,
    coverage: total === 0 ? "UNALLOCATED" : unassigned.length === 0 ? "SATISFIED" : covered === 0 ? "UNALLOCATED" : "PARTIAL",
    source_module: "requirement-manufacturing",
  };
}

export function mbomProcessCoverage(db, tenantId, mbomRef, opts = {}) {
  const { revision, header } = requireTypedRevision(db, tenantId, mbomRef, MBOM_BOM_TYPE);
  const lines = readLines(db, tenantId, revision.id, true);
  const itemLines = lines.filter((line) => line.child_object_id != null && !operationLineOf(line));
  const itemIds = uniqueNumbers(itemLines.map((line) => line.child_object_id));
  const rels = relationsFor(db, tenantId, itemIds, [REL.OP_CONSUMES_PART], "in");
  const assigned = new Set(rels.map((rel) => String(rel.target?.id)));
  return mbomCoverageResult(revision, header, itemLines, assigned, Boolean(getConfig(db, tenantId, "require_mbom_bop_assignment")), opts);
}

export async function mbomProcessCoverageAsync(db, tenantId, mbomRef, opts = {}) {
  const { revision, header } = await requireTypedRevisionAsync(db, tenantId, mbomRef, MBOM_BOM_TYPE);
  const lines = await readLinesAsync(db, tenantId, revision.id, true);
  const itemLines = lines.filter((line) => line.child_object_id != null && !operationLineOf(line));
  const itemIds = uniqueNumbers(itemLines.map((line) => line.child_object_id));
  const rels = await relationsForAsync(db, tenantId, itemIds, [REL.OP_CONSUMES_PART], "in");
  const assigned = new Set(rels.map((rel) => String(rel.target?.id)));
  return mbomCoverageResult(revision, header, itemLines, assigned, Boolean(getConfig(db, tenantId, "require_mbom_bop_assignment")), opts);
}

// ── Link helpers (reuse BOM lines + object relationships) ───────────────────

function bopLineBodyFor(operation, body, revision) {
  return {
    child_object_id: String(operation.id),
    child_object_type: OPERATION_OBJECT_TYPE,
    child_revision: operation.revision ?? body.revision ?? "",
    quantity: body.quantity ?? 1,
    uom: body.uom ?? "EA",
    find_number: body.find_number ?? body.findNumber ?? "",
    sequence: body.sequence ?? 0,
    usage: body.usage ?? "MANUFACTURING",
    configuration_context: body.configuration_context ?? body.configurationContext ?? revision.configuration_context ?? "",
  };
}

export function addOperationToBop(db, tenantId, bopRef, body = {}, actor = null, ip = null) {
  const { revision } = requireTypedRevision(db, tenantId, bopRef, BOP_BOM_TYPE);
  const operationRef = body.operation_id ?? body.operationId ?? body.operation;
  if (operationRef === undefined || operationRef === null || String(operationRef).trim() === "") throw invalidProcess("operation_id is required");
  const operation = objectOfType(db, tenantId, operationRef, OPERATION_OBJECT_TYPE);
  if (!operation) throw operationNotFound(operationRef);
  const line = BomLines.addLine(db, tenantId, revision.id, bopLineBodyFor(operation, body, revision), actor, ip);
  return { bop_revision_id: revision.id, operation: objectDescriptor(operation), line };
}

export async function addOperationToBopAsync(db, tenantId, bopRef, body = {}, actor = null, ip = null) {
  const { revision } = await requireTypedRevisionAsync(db, tenantId, bopRef, BOP_BOM_TYPE);
  const operationRef = body.operation_id ?? body.operationId ?? body.operation;
  if (operationRef === undefined || operationRef === null || String(operationRef).trim() === "") throw invalidProcess("operation_id is required");
  const operation = await objectOfTypeAsync(db, tenantId, operationRef, OPERATION_OBJECT_TYPE);
  if (!operation) throw operationNotFound(operationRef);
  const line = await BomLines.addLineAsync(db, tenantId, revision.id, bopLineBodyFor(operation, body, revision), actor, ip);
  return { bop_revision_id: revision.id, operation: objectDescriptor(operation), line };
}

export function linkOperationToWorkCenter(db, tenantId, operationRef, body = {}, actor = null, ip = null) {
  const operation = objectOfType(db, tenantId, operationRef, OPERATION_OBJECT_TYPE);
  if (!operation) throw operationNotFound(operationRef);
  const workCenterRef = body.work_center_id ?? body.workCenterId ?? body.work_center ?? body.workCenter;
  if (workCenterRef === undefined || workCenterRef === null || String(workCenterRef).trim() === "") throw invalidProcess("work_center_id is required");
  const workCenter = objectOfType(db, tenantId, workCenterRef, WORK_CENTER_OBJECT_TYPE);
  if (!workCenter) throw workCenterNotFound(workCenterRef);
  const relationship = linkManufacturingObjects(db, tenantId, { relationship_type: REL.OP_WORK_CENTER, source: operation.id, target: workCenter.id, attributes: body.attributes ?? {} }, actor, ip);
  return { operation: objectDescriptor(operation), work_center: objectDescriptor(workCenter), relationship };
}

export async function linkOperationToWorkCenterAsync(db, tenantId, operationRef, body = {}, actor = null, ip = null) {
  const operation = await objectOfTypeAsync(db, tenantId, operationRef, OPERATION_OBJECT_TYPE);
  if (!operation) throw operationNotFound(operationRef);
  const workCenterRef = body.work_center_id ?? body.workCenterId ?? body.work_center ?? body.workCenter;
  if (workCenterRef === undefined || workCenterRef === null || String(workCenterRef).trim() === "") throw invalidProcess("work_center_id is required");
  const workCenter = await objectOfTypeAsync(db, tenantId, workCenterRef, WORK_CENTER_OBJECT_TYPE);
  if (!workCenter) throw workCenterNotFound(workCenterRef);
  const relationship = await linkManufacturingObjectsAsync(db, tenantId, { relationship_type: REL.OP_WORK_CENTER, source: operation.id, target: workCenter.id, attributes: body.attributes ?? {} }, actor, ip);
  return { operation: objectDescriptor(operation), work_center: objectDescriptor(workCenter), relationship };
}

export function linkOperationToMbomItem(db, tenantId, operationRef, body = {}, actor = null, ip = null) {
  const operation = objectOfType(db, tenantId, operationRef, OPERATION_OBJECT_TYPE);
  if (!operation) throw operationNotFound(operationRef);
  const itemRef = body.mbom_item_id ?? body.mbomItemId ?? body.item_id ?? body.itemId ?? body.item;
  if (itemRef === undefined || itemRef === null || String(itemRef).trim() === "") throw invalidProcess("mbom_item_id is required");
  const item = anyObject(db, tenantId, itemRef);
  if (!item) throw invalidTarget(`MBOM item not found: ${itemRef}`, { ref: itemRef });
  const relationship = linkManufacturingObjects(db, tenantId, { relationship_type: REL.OP_CONSUMES_PART, source: operation.id, target: item.id, attributes: body.attributes ?? {} }, actor, ip);
  return { operation: objectDescriptor(operation), item: objectDescriptor(item), relationship };
}

export async function linkOperationToMbomItemAsync(db, tenantId, operationRef, body = {}, actor = null, ip = null) {
  const operation = await objectOfTypeAsync(db, tenantId, operationRef, OPERATION_OBJECT_TYPE);
  if (!operation) throw operationNotFound(operationRef);
  const itemRef = body.mbom_item_id ?? body.mbomItemId ?? body.item_id ?? body.itemId ?? body.item;
  if (itemRef === undefined || itemRef === null || String(itemRef).trim() === "") throw invalidProcess("mbom_item_id is required");
  const item = await anyObjectAsync(db, tenantId, itemRef);
  if (!item) throw invalidTarget(`MBOM item not found: ${itemRef}`, { ref: itemRef });
  const relationship = await linkManufacturingObjectsAsync(db, tenantId, { relationship_type: REL.OP_CONSUMES_PART, source: operation.id, target: item.id, attributes: body.attributes ?? {} }, actor, ip);
  return { operation: objectDescriptor(operation), item: objectDescriptor(item), relationship };
}

function precedencePlan(db, tenantId, operationRef, body) {
  const successor = objectOfType(db, tenantId, operationRef, OPERATION_OBJECT_TYPE);
  if (!successor) throw operationNotFound(operationRef);
  const predecessorRef = body.predecessor_id ?? body.predecessorId ?? body.predecessor;
  if (predecessorRef === undefined || predecessorRef === null || String(predecessorRef).trim() === "") throw invalidProcess("predecessor_id is required");
  const predecessor = objectOfType(db, tenantId, predecessorRef, OPERATION_OBJECT_TYPE);
  if (!predecessor) throw operationNotFound(predecessorRef);
  if (String(predecessor.id) === String(successor.id)) throw invalidProcess("An operation cannot precede itself");
  return { predecessor, successor };
}

export function linkOperationPrecedence(db, tenantId, operationRef, body = {}, actor = null, ip = null) {
  const { predecessor, successor } = precedencePlan(db, tenantId, operationRef, body);
  const existing = relationsFor(db, tenantId, [predecessor.id], [REL.OP_PRECEDES], "out");
  if (existing.some((rel) => String(rel.target?.id) === String(successor.id))) {
    return { predecessor: objectDescriptor(predecessor), successor: objectDescriptor(successor), relationship: null, created: false };
  }
  const reverse = relationsFor(db, tenantId, [successor.id], [REL.OP_PRECEDES], "out");
  if (reverse.some((rel) => String(rel.target?.id) === String(predecessor.id))) throw invalidProcess("That precedence would create a cycle", { predecessor_id: predecessor.id, successor_id: successor.id });
  const relationship = linkManufacturingObjects(db, tenantId, { relationship_type: REL.OP_PRECEDES, source: predecessor.id, target: successor.id, attributes: body.attributes ?? {}, sequence: body.sequence }, actor, ip);
  return { predecessor: objectDescriptor(predecessor), successor: objectDescriptor(successor), relationship, created: true };
}

export async function linkOperationPrecedenceAsync(db, tenantId, operationRef, body = {}, actor = null, ip = null) {
  const successor = await objectOfTypeAsync(db, tenantId, operationRef, OPERATION_OBJECT_TYPE);
  if (!successor) throw operationNotFound(operationRef);
  const predecessorRef = body.predecessor_id ?? body.predecessorId ?? body.predecessor;
  if (predecessorRef === undefined || predecessorRef === null || String(predecessorRef).trim() === "") throw invalidProcess("predecessor_id is required");
  const predecessor = await objectOfTypeAsync(db, tenantId, predecessorRef, OPERATION_OBJECT_TYPE);
  if (!predecessor) throw operationNotFound(predecessorRef);
  if (String(predecessor.id) === String(successor.id)) throw invalidProcess("An operation cannot precede itself");
  const existing = await relationsForAsync(db, tenantId, [predecessor.id], [REL.OP_PRECEDES], "out");
  if (existing.some((rel) => String(rel.target?.id) === String(successor.id))) {
    return { predecessor: objectDescriptor(predecessor), successor: objectDescriptor(successor), relationship: null, created: false };
  }
  const reverse = await relationsForAsync(db, tenantId, [successor.id], [REL.OP_PRECEDES], "out");
  if (reverse.some((rel) => String(rel.target?.id) === String(predecessor.id))) throw invalidProcess("That precedence would create a cycle", { predecessor_id: predecessor.id, successor_id: successor.id });
  const relationship = await linkManufacturingObjectsAsync(db, tenantId, { relationship_type: REL.OP_PRECEDES, source: predecessor.id, target: successor.id, attributes: body.attributes ?? {}, sequence: body.sequence }, actor, ip);
  return { predecessor: objectDescriptor(predecessor), successor: objectDescriptor(successor), relationship, created: true };
}

export { REL as PROCESS_RELATIONSHIP_CODES };

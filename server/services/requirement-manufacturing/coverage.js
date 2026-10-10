// Manufacturing characteristics, process constraints and CTQ coverage
// (Boundary 5).
//
// No quality-management or constraint engine is introduced. A manufacturing /
// CTQ characteristic IS an existing Classification characteristic
// (`cla_characteristics`), designated CTQ through its own metadata; process
// constraints are the inclusive/exclusive numeric limits Classification already
// models. The association between a characteristic and an operation reuses the
// Classification assignment model (a class assigned to an `operation` object
// applies its characteristics), so no second association store is created.
//
// This module only projects and validates:
//   - characteristics / constraints applicable to an operation (and reverse);
//   - the requirements that govern/control a characteristic;
//   - CTQ coverage (CTQs without an upstream requirement or operation, and
//     requirements missing an expected CTQ), driven by configuration rules;
//   - machine-readable constraint compatibility (units, precision,
//     inclusive/exclusive limits, missing values).
//
// Every public function has a synchronous twin (CLI/seeders/tests) and an
// `*Async` twin (async request transactions); a caller uses one layer, never
// both. Reads are bounded and batched (no N+1, no full loads).
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { Requirements } from "../requirements/index.js";
import { Units } from "../classification/index.js";
import { getObject, getObjectAsync, listObjects, listObjectsAsync } from "../objects.js";
import { getConfig } from "./configuration.js";
import { ALLOCATION_CODES, REQUIREMENT_SOURCE_TYPE, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, VALIDATION_STATUSES } from "./constants.js";
import { parseObject, paginate } from "./validation.js";
import { characteristicNotFound, operationNotFound } from "./errors.js";

const MAX_ROWS = 20000;
const CTQ_KEY = "ctq";
const CTQ_SEVERITY_KEY = "ctq_severity";
const CTQ_TOKEN = "CTQ_COVERAGE";

const STATUS = Object.freeze({
  VALID: "VALID",
  INVALID_LINK: "INVALID_LINK",
  CONFIGURATION_MISMATCH: "CONFIGURATION_MISMATCH",
  PENDING_VALIDATION: "PENDING_VALIDATION",
  VALIDATION_ERROR: "VALIDATION_ERROR",
});

function assertStatuses() {
  for (const value of Object.values(STATUS)) {
    if (!VALIDATION_STATUSES.includes(value)) throw new Error(`Invalid validation status: ${value}`);
  }
}
assertStatuses();

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

function toBoolFlag(value) {
  return Boolean(Number(value));
}

function parseMetadata(row) {
  try {
    return JSON.parse(row?.metadata_json || "{}") || {};
  } catch {
    return {};
  }
}

function objectDescriptor(object) {
  if (!object) return null;
  return {
    object_id: String(object.id),
    code: object.code || "",
    name: object.name || "",
    status: object.status || "",
    object_type: object.type?.code || object.type || "",
    organization_id: object.organization_id ?? null,
  };
}

function requirementDescriptor(row) {
  if (!row) return null;
  return {
    requirement_id: row.id,
    id: row.id,
    requirement_ref: row.requirement_ref || "",
    requirement_number: row.requirement_number || "",
    name: row.name || row.title || "",
    title: row.title || "",
    status: row.status || "",
    lifecycle_state: row.lifecycle_state || row.status || "",
    criticality: row.criticality || "",
    category: row.category || "",
    revision: row.revision || "",
  };
}

function characteristicDescriptor(row, { limits = null } = {}) {
  if (!row) return null;
  const metadata = parseMetadata(row);
  const effective = limits || {
    min_value: row.min_value,
    max_value: row.max_value,
    min_inclusive: toBoolFlag(row.min_inclusive),
    max_inclusive: toBoolFlag(row.max_inclusive),
    unit: row.unit || "",
  };
  return {
    characteristic_id: row.id,
    id: row.id,
    characteristic_ref: row.characteristic_ref || "",
    code: row.code || "",
    name: row.name || "",
    description: row.description || "",
    data_type: row.data_type || "",
    unit: effective.unit ?? row.unit ?? "",
    revision: row.version != null ? String(row.version) : "",
    status: row.status || "",
    lifecycle_state: row.status || "",
    ctq: Boolean(metadata[CTQ_KEY]),
    ctq_severity: metadata[CTQ_SEVERITY_KEY] || "",
    min_value: effective.min_value ?? null,
    max_value: effective.max_value ?? null,
    min_inclusive: Boolean(effective.min_inclusive),
    max_inclusive: Boolean(effective.max_inclusive),
    has_limits: effective.min_value != null || effective.max_value != null,
  };
}

function resolveOperation(db, tenantId, ref, { async: isAsync = false } = {}) {
  try {
    const object = getObject(db, ref, tenantId);
    const type = String(object?.type?.code || "").toLowerCase();
    if (!object || type !== "operation") throw operationNotFound(ref);
    return object;
  } catch (error) {
    if (error?.code === "REQUIREMENT_MANUFACTURING_OPERATION_NOT_FOUND") throw error;
    throw operationNotFound(ref);
  }
}

async function resolveOperationAsync(db, tenantId, ref) {
  try {
    const object = await getObjectAsync(db, ref, tenantId);
    const type = String(object?.type?.code || "").toLowerCase();
    if (!object || type !== "operation") throw operationNotFound(ref);
    return object;
  } catch (error) {
    if (error?.code === "REQUIREMENT_MANUFACTURING_OPERATION_NOT_FOUND") throw error;
    throw operationNotFound(ref);
  }
}

function resolveCharacteristicRow(db, tenantId, ref, { async: isAsync = false } = {}) {
  const sql = "SELECT * FROM cla_characteristics WHERE tenant_id = ? AND (id = ? OR characteristic_ref = ? OR lower(code) = lower(?))";
  const params = [Number(tenantId), Number(ref) || -1, String(ref), String(ref)];
  return isAsync ? queryOneAsync(db, sql, params) : queryOne(db, sql, params);
}

function requireCharacteristic(db, tenantId, ref, { async: isAsync = false } = {}) {
  const row = resolveCharacteristicRow(db, tenantId, ref, { async: isAsync });
  if (isAsync) {
    return Promise.resolve(row).then((resolved) => {
      if (!resolved) throw characteristicNotFound(ref);
      return resolved;
    });
  }
  if (!row) throw characteristicNotFound(ref);
  return row;
}

function paginateItems(items, opts = {}) {
  const { limit, offset, page, pageSize } = paginate(
    { page: opts.page, pageSize: opts.pageSize },
    { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE }
  );
  return { items: items.slice(offset, offset + limit), total: items.length, page, page_size: pageSize };
}

// ── Characteristic <-> operation association (reuses Classification) ─────────

const OPERATION_CHARACTERISTICS_SQL = `
  SELECT c.*, a.assignment_ref, a.class_id, cc.sequence AS class_sequence,
         cc.min_value AS class_min, cc.max_value AS class_max, cc.unit_override
    FROM cla_assignments a
    JOIN cla_class_characteristics cc
      ON cc.tenant_id = a.tenant_id AND cc.class_id = a.class_id AND cc.status = 'ACTIVE'
    JOIN cla_characteristics c
      ON c.id = cc.characteristic_id AND c.tenant_id = a.tenant_id
   WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND a.object_type = 'operation' AND a.object_id = ?
   ORDER BY cc.sequence, c.id
   LIMIT ${MAX_ROWS}`;

function mergeOperationCharacteristics(rows) {
  const byId = new Map();
  for (const row of rows) {
    const limits = {
      min_value: row.class_min != null ? row.class_min : row.min_value,
      max_value: row.class_max != null ? row.class_max : row.max_value,
      min_inclusive: toBoolFlag(row.min_inclusive),
      max_inclusive: toBoolFlag(row.max_inclusive),
      unit: row.unit_override || row.unit || "",
    };
    const descriptor = characteristicDescriptor(row, { limits });
    if (!byId.has(descriptor.characteristic_id)) byId.set(descriptor.characteristic_id, descriptor);
  }
  return [...byId.values()];
}

export function operationCharacteristics(db, tenantId, operationRef, opts = {}) {
  const tenant = Number(tenantId);
  const operation = resolveOperation(db, tenant, operationRef);
  const rows = queryAll(db, OPERATION_CHARACTERISTICS_SQL, [tenant, String(operation.id)]);
  const items = mergeOperationCharacteristics(rows);
  const paged = paginateItems(items, opts);
  return {
    operation: objectDescriptor(operation),
    items: paged.items,
    total: paged.total,
    page: paged.page,
    page_size: paged.page_size,
    source_module: "requirement-manufacturing",
  };
}

export async function operationCharacteristicsAsync(db, tenantId, operationRef, opts = {}) {
  const tenant = Number(tenantId);
  const operation = await resolveOperationAsync(db, tenant, operationRef);
  const rows = await queryAllAsync(db, OPERATION_CHARACTERISTICS_SQL, [tenant, String(operation.id)]);
  const items = mergeOperationCharacteristics(rows);
  const paged = paginateItems(items, opts);
  return {
    operation: objectDescriptor(operation),
    items: paged.items,
    total: paged.total,
    page: paged.page,
    page_size: paged.page_size,
    source_module: "requirement-manufacturing",
  };
}

// Process constraints are the subset of applicable characteristics that carry
// machine-readable limits; affected operations change when the characteristic
// changes. Nothing is copied.
export function operationConstraints(db, tenantId, operationRef, opts = {}) {
  const result = operationCharacteristics(db, tenantId, operationRef, { page: 1, pageSize: MAX_PAGE_SIZE });
  const items = result.items.filter((item) => item.has_limits);
  const paged = paginateItems(items, opts);
  return { operation: result.operation, items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

export async function operationConstraintsAsync(db, tenantId, operationRef, opts = {}) {
  const result = await operationCharacteristicsAsync(db, tenantId, operationRef, { page: 1, pageSize: MAX_PAGE_SIZE });
  const items = result.items.filter((item) => item.has_limits);
  const paged = paginateItems(items, opts);
  return { operation: result.operation, items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, source_module: "requirement-manufacturing" };
}

const CHARACTERISTIC_OPERATIONS_SQL = `
  SELECT a.object_id, a.assignment_ref, a.class_id, cc.min_value, cc.max_value, cc.unit_override
    FROM cla_assignments a
    JOIN cla_class_characteristics cc
      ON cc.tenant_id = a.tenant_id AND cc.class_id = a.class_id AND cc.status = 'ACTIVE'
   WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND a.object_type = 'operation' AND cc.characteristic_id = ?
   LIMIT ${MAX_ROWS}`;

function buildCharacteristicOperations(charRow, rows, objectMap) {
  const seen = new Set();
  const items = [];
  let unresolved = 0;
  for (const row of rows) {
    const id = String(row.object_id);
    if (seen.has(id)) continue;
    seen.add(id);
    const object = objectMap.get(id);
    if (!object) {
      // Absent from the security-filtered object list may mean inaccessible,
      // not missing: never report an inaccessible object as a confirmed gap.
      unresolved += 1;
      continue;
    }
    items.push({
      ...objectDescriptor(object),
      association: { assignment_ref: row.assignment_ref || "", class_id: row.class_id, applies_to: "operation" },
    });
  }
  return { items, unresolved };
}

function loadObjectsByIds(db, tenantId, ids, { async: isAsync = false } = {}) {
  if (!ids.length) return isAsync ? Promise.resolve(new Map()) : new Map();
  const list = isAsync ? listObjectsAsync(db, { ids: ids.join(","), pageSize: ids.length }, tenantId) : listObjects(db, { ids: ids.join(","), pageSize: ids.length }, tenantId);
  if (isAsync) {
    return Promise.resolve(list).then((result) => new Map((result.items || []).map((object) => [String(object.id), object])));
  }
  return new Map((list.items || []).map((object) => [String(object.id), object]));
}

export function characteristicOperations(db, tenantId, characteristicRef, opts = {}) {
  const tenant = Number(tenantId);
  const characteristic = requireCharacteristic(db, tenant, characteristicRef);
  const rows = queryAll(db, CHARACTERISTIC_OPERATIONS_SQL, [tenant, characteristic.id]);
  const objectMap = loadObjectsByIds(db, tenant, uniqueNumbers(rows.map((row) => row.object_id)).map(String));
  const { items, unresolved } = buildCharacteristicOperations(characteristic, rows, objectMap);
  const paged = paginateItems(items, opts);
  return {
    characteristic: characteristicDescriptor(characteristic),
    items: paged.items,
    total: paged.total,
    page: paged.page,
    page_size: paged.page_size,
    unresolved_count: unresolved,
    source_module: "requirement-manufacturing",
  };
}

export async function characteristicOperationsAsync(db, tenantId, characteristicRef, opts = {}) {
  const tenant = Number(tenantId);
  const characteristic = await requireCharacteristic(db, tenant, characteristicRef, { async: true });
  const rows = await queryAllAsync(db, CHARACTERISTIC_OPERATIONS_SQL, [tenant, characteristic.id]);
  const objectMap = await loadObjectsByIds(db, tenant, uniqueNumbers(rows.map((row) => row.object_id)).map(String));
  const { items, unresolved } = buildCharacteristicOperations(characteristic, rows, objectMap);
  const paged = paginateItems(items, opts);
  return {
    characteristic: characteristicDescriptor(characteristic),
    items: paged.items,
    total: paged.total,
    page: paged.page,
    page_size: paged.page_size,
    unresolved_count: unresolved,
    source_module: "requirement-manufacturing",
  };
}

// Alias with explicit "affected operations" semantics (constraint change impact).
export const constraintOperations = characteristicOperations;
export const constraintOperationsAsync = characteristicOperationsAsync;

// ── Requirements governing a characteristic (reverse allocation) ─────────────

const CHARACTERISTIC_REQUIREMENTS_SQL = `
  SELECT rr.id, rr.relationship_ref, rr.relationship_type, rr.status, rr.source_id,
         rr.effectivity_from, rr.effectivity_to,
         r.id AS req_id, r.requirement_ref, r.requirement_number, r.name, r.title,
         r.status AS req_status, r.lifecycle_state, r.criticality, r.category, r.revision
    FROM requirement_relationships rr
    JOIN requirements r ON r.tenant_id = rr.tenant_id AND r.id::text = rr.source_id
   WHERE rr.tenant_id = ? AND rr.status = 'ACTIVE' AND rr.source_type = ?
     AND rr.target_type = 'characteristic' AND rr.target_id = ?
     AND rr.relationship_type IN (${placeholders(ALLOCATION_CODES)})
   ORDER BY rr.id DESC
   LIMIT ${MAX_ROWS}`;

function characteristicRequirementItems(rows) {
  return rows.map((row) => ({
    relationship_id: row.id,
    relationship_ref: row.relationship_ref || "",
    relationship_type: row.relationship_type,
    effectivity_from: row.effectivity_from ?? null,
    effectivity_to: row.effectivity_to ?? null,
    requirement: requirementDescriptor({
      id: row.req_id,
      requirement_ref: row.requirement_ref,
      requirement_number: row.requirement_number,
      name: row.name,
      title: row.title,
      status: row.req_status,
      lifecycle_state: row.lifecycle_state,
      criticality: row.criticality,
      category: row.category,
      revision: row.revision,
    }),
  }));
}

export function characteristicRequirements(db, tenantId, characteristicRef) {
  const tenant = Number(tenantId);
  const characteristic = requireCharacteristic(db, tenant, characteristicRef);
  const params = [tenant, REQUIREMENT_SOURCE_TYPE, String(characteristic.id), ...ALLOCATION_CODES];
  const rows = queryAll(db, CHARACTERISTIC_REQUIREMENTS_SQL, params);
  const items = characteristicRequirementItems(rows);
  return { characteristic: characteristicDescriptor(characteristic), items, total: items.length, source_module: "requirement-manufacturing" };
}

export async function characteristicRequirementsAsync(db, tenantId, characteristicRef) {
  const tenant = Number(tenantId);
  const characteristic = await requireCharacteristic(db, tenant, characteristicRef, { async: true });
  const params = [tenant, REQUIREMENT_SOURCE_TYPE, String(characteristic.id), ...ALLOCATION_CODES];
  const rows = await queryAllAsync(db, CHARACTERISTIC_REQUIREMENTS_SQL, params);
  const items = characteristicRequirementItems(rows);
  return { characteristic: characteristicDescriptor(characteristic), items, total: items.length, source_module: "requirement-manufacturing" };
}

// ── Requirement -> CTQ characteristics (forward) ─────────────────────────────

const REQUIREMENT_CHARACTERISTIC_ALLOCATIONS_SQL = `
  SELECT target_id FROM requirement_relationships
   WHERE tenant_id = ? AND status = 'ACTIVE' AND source_type = ? AND source_id = ?
     AND target_type = 'characteristic' AND relationship_type IN (${placeholders(ALLOCATION_CODES)})
   LIMIT ${MAX_ROWS}`;

const CHARACTERISTIC_OPERATION_COUNT_SQL = `
  SELECT cc.characteristic_id, COUNT(DISTINCT a.object_id) AS c
    FROM cla_assignments a
    JOIN cla_class_characteristics cc
      ON cc.tenant_id = a.tenant_id AND cc.class_id = a.class_id AND cc.status = 'ACTIVE'
   WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND a.object_type = 'operation' AND cc.characteristic_id IN (%s)
   GROUP BY cc.characteristic_id`;

function characteristicRowsByIds(db, tenantId, ids, { async: isAsync = false } = {}) {
  if (!ids.length) return isAsync ? Promise.resolve([]) : [];
  const list = chunk(ids).flatMap((batch) => {
    const sql = `SELECT * FROM cla_characteristics WHERE tenant_id = ? AND id IN (${placeholders(batch)})`;
    const params = [Number(tenantId), ...batch];
    return isAsync ? queryAllAsync(db, sql, params) : queryAll(db, sql, params);
  });
  return isAsync ? Promise.all(list).then((results) => results.flat()) : list;
}

function operationCountsByCharacteristic(db, tenantId, ids, { async: isAsync = false } = {}) {
  if (!ids.length) return isAsync ? Promise.resolve(new Map()) : new Map();
  const batches = chunk(ids).map((batch) => CHARACTERISTIC_OPERATION_COUNT_SQL.replace("%s", placeholders(batch)));
  const paramsByBatch = chunk(ids).map((batch) => [Number(tenantId), ...batch]);
  if (isAsync) {
    return Promise.all(batches.map((sql, index) => queryAllAsync(db, sql, paramsByBatch[index]))).then((results) => {
      const map = new Map();
      for (const rows of results) for (const row of rows) map.set(Number(row.characteristic_id), Number(row.c));
      return map;
    });
  }
  const map = new Map();
  batches.forEach((sql, index) => {
    for (const row of queryAll(db, sql, paramsByBatch[index])) map.set(Number(row.characteristic_id), Number(row.c));
  });
  return map;
}

function requirementCtqItems(charRows, operationCounts, { includeNonCtq = false } = {}) {
  const items = [];
  for (const row of charRows) {
    const descriptor = characteristicDescriptor(row);
    if (!descriptor.ctq && !includeNonCtq) continue;
    const operationCount = operationCounts.get(Number(row.id)) || 0;
    items.push({
      characteristic: descriptor,
      operation_count: operationCount,
      has_operation: operationCount > 0,
      status: operationCount > 0 ? STATUS.VALID : STATUS.MISSING_LINK,
    });
  }
  return items;
}

export function requirementCtqs(db, tenantId, requirementRef, opts = {}) {
  const tenant = Number(tenantId);
  const requirement = Requirements.requireRequirementRow(db, tenant, requirementRef);
  const rows = queryAll(db, REQUIREMENT_CHARACTERISTIC_ALLOCATIONS_SQL, [tenant, REQUIREMENT_SOURCE_TYPE, String(requirement.id), ...ALLOCATION_CODES]);
  const ids = uniqueNumbers(rows.map((row) => row.target_id));
  const charRows = characteristicRowsByIds(db, tenant, ids);
  const operationCounts = operationCountsByCharacteristic(db, tenant, ids);
  const items = requirementCtqItems(charRows, operationCounts, { includeNonCtq: opts.includeNonCtq === true });
  return {
    requirement: requirementDescriptor(requirement),
    items,
    total: items.length,
    missing_operation: items.filter((item) => !item.has_operation).length,
    source_module: "requirement-manufacturing",
  };
}

export async function requirementCtqsAsync(db, tenantId, requirementRef, opts = {}) {
  const tenant = Number(tenantId);
  const requirement = await Requirements.requireRequirementRowAsync(db, tenant, requirementRef);
  const rows = await queryAllAsync(db, REQUIREMENT_CHARACTERISTIC_ALLOCATIONS_SQL, [tenant, REQUIREMENT_SOURCE_TYPE, String(requirement.id), ...ALLOCATION_CODES]);
  const ids = uniqueNumbers(rows.map((row) => row.target_id));
  const charRows = await characteristicRowsByIds(db, tenant, ids, { async: true });
  const operationCounts = await operationCountsByCharacteristic(db, tenant, ids, { async: true });
  const items = requirementCtqItems(charRows, operationCounts, { includeNonCtq: opts.includeNonCtq === true });
  return {
    requirement: requirementDescriptor(requirement),
    items,
    total: items.length,
    missing_operation: items.filter((item) => !item.has_operation).length,
    source_module: "requirement-manufacturing",
  };
}

// ── CTQ coverage report ──────────────────────────────────────────────────────

function parseCoverageRule(rulesText, token) {
  const text = String(rulesText || "");
  for (const entry of text.split(",")) {
    const [category, rule] = entry.split(":").map((part) => String(part || "").trim().toUpperCase());
    if (rule === token) return category || "OPTIONAL";
  }
  return null;
}

function criticalitySet(configured) {
  return new Set(
    String(configured || "")
      .split(",")
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean)
  );
}

const CTQ_CHARACTERISTICS_SQL = `SELECT * FROM cla_characteristics WHERE tenant_id = ? AND status = 'ACTIVE' ORDER BY id DESC LIMIT ${MAX_ROWS}`;
const REQUIREMENT_CHARACTERISTIC_LINKS_SQL = `
  SELECT source_id, target_id FROM requirement_relationships
   WHERE tenant_id = ? AND status = 'ACTIVE' AND source_type = ?
     AND target_type = 'characteristic' AND relationship_type IN (${placeholders(ALLOCATION_CODES)})
   LIMIT ${MAX_ROWS}`;
const CHARACTERISTIC_OPERATION_IDS_SQL = `
  SELECT DISTINCT a.object_id FROM cla_assignments a
    JOIN cla_class_characteristics cc
      ON cc.tenant_id = a.tenant_id AND cc.class_id = a.class_id AND cc.status = 'ACTIVE'
    WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND a.object_type = 'operation' AND cc.characteristic_id = ?`;

function assembleCtqCoverage({ ctqRows, requirementLinks, operationIds, missingRows, ruleCategory, ctqEnabled, requireForCritical, opts }) {
  const coveredByCharacteristic = new Map();
  const coveredRequirementIds = new Set();
  for (const link of requirementLinks) {
    const charId = Number(link.target_id);
    if (!coveredByCharacteristic.has(charId)) coveredByCharacteristic.set(charId, new Set());
    coveredByCharacteristic.get(charId).add(Number(link.source_id));
    coveredRequirementIds.add(Number(link.source_id));
  }
  const operationsByCharacteristic = new Set(operationIds.map(Number));

  const ctqDescriptors = ctqRows.map((row) => characteristicDescriptor(row));
  const ctqWithRequirement = ctqDescriptors.filter((c) => coveredByCharacteristic.has(Number(c.characteristic_id)));
  const ctqWithoutRequirement = ctqDescriptors.filter((c) => !coveredByCharacteristic.has(Number(c.characteristic_id)));
  const ctqWithOperation = ctqDescriptors.filter((c) => operationsByCharacteristic.has(Number(c.characteristic_id)));
  const ctqWithoutOperation = ctqDescriptors.filter((c) => !operationsByCharacteristic.has(Number(c.characteristic_id)));

  const withCoverageItems = [];
  for (const c of ctqWithRequirement) {
    for (const reqId of coveredByCharacteristic.get(Number(c.characteristic_id))) {
      withCoverageItems.push({ requirement_id: reqId, characteristic_id: c.characteristic_id });
    }
  }
  const withCoverageRequirements = [...new Set(withCoverageItems.map((item) => item.requirement_id))].map((reqId) => ({
    requirement_id: reqId,
    ctq_characteristic_ids: [...new Set(withCoverageItems.filter((item) => item.requirement_id === reqId).map((item) => item.characteristic_id))],
  }));

  const missingCtq = missingRows.map((row) => requirementDescriptor(row));

  const pagedWith = paginateItems(withCoverageRequirements, opts);
  const pagedMissing = paginateItems(missingCtq, opts);

  return {
    rule: { token: CTQ_TOKEN, category: ruleCategory, enabled: Boolean(ctqEnabled) && ruleCategory !== "FORBIDDEN", require_for_critical: Boolean(requireForCritical) },
    summary: {
      ctq_total: ctqDescriptors.length,
      ctq_with_requirement: ctqWithRequirement.length,
      ctq_without_requirement: ctqWithoutRequirement.length,
      ctq_with_operation: ctqWithOperation.length,
      ctq_without_operation: ctqWithoutOperation.length,
      requirements_with_coverage: withCoverageRequirements.length,
      requirements_missing_ctq: missingCtq.length,
    },
    with_coverage: pagedWith.items,
    with_coverage_total: pagedWith.total,
    ctq_without_requirement: ctqWithoutRequirement.slice(0, MAX_PAGE_SIZE),
    ctq_without_operation: ctqWithoutOperation.slice(0, MAX_PAGE_SIZE),
    requirements_missing_ctq: pagedMissing.items,
    requirements_missing_ctq_total: pagedMissing.total,
    page: pagedWith.page,
    page_size: pagedWith.page_size,
    source_module: "requirement-manufacturing",
  };
}

function loadMissingCtqRequirements(db, tenantId, criticality, coveredRequirementIds, { async: isAsync = false } = {}) {
  if (!criticality.size) return isAsync ? Promise.resolve([]) : [];
  const values = [...criticality];
  const sql = `SELECT id, requirement_ref, requirement_number, name, title, status, lifecycle_state, criticality, category, revision
                 FROM requirements
                WHERE tenant_id = ? AND status NOT IN ('OBSOLETE','WITHDRAWN')
                  AND upper(criticality) IN (${placeholders(values)})
                LIMIT ${MAX_ROWS}`;
  const params = [Number(tenantId), ...values];
  const finish = (rows) => rows.filter((row) => !coveredRequirementIds.has(Number(row.id)));
  if (isAsync) return queryAllAsync(db, sql, params).then(finish);
  return finish(queryAll(db, sql, params));
}

export function ctqCoverage(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const ctqRows = queryAll(db, CTQ_CHARACTERISTICS_SQL, [tenant]).filter((row) => Boolean(parseMetadata(row)[CTQ_KEY]));
  const requirementLinks = queryAll(db, REQUIREMENT_CHARACTERISTIC_LINKS_SQL, [tenant, REQUIREMENT_SOURCE_TYPE, ...ALLOCATION_CODES]);
  const ctqIds = ctqRows.map((row) => Number(row.id));
  const operationIds = ctqIds.length
    ? ctqIds.flatMap((id) => queryAll(db, CHARACTERISTIC_OPERATION_IDS_SQL, [tenant, id]).map((row) => row.object_id))
    : [];
  const ruleCategory = parseCoverageRule(getConfig(db, tenant, "coverage_rules"), CTQ_TOKEN);
  const ctqEnabled = getConfig(db, tenant, "ctq_enabled");
  const requireForCritical = getConfig(db, tenant, "require_ctq_for_critical");
  const criticality = requireForCritical ? criticalitySet(getConfig(db, tenant, "ctq_criticality")) : new Set();
  const coveredRequirementIds = new Set(requirementLinks.map((link) => Number(link.source_id)));
  const missingRows = loadMissingCtqRequirements(db, tenant, criticality, coveredRequirementIds);
  return assembleCtqCoverage({ tenant, ctqRows, requirementLinks, operationIds, missingRows, ruleCategory, ctqEnabled, requireForCritical, opts });
}

export async function ctqCoverageAsync(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const ctqRows = (await queryAllAsync(db, CTQ_CHARACTERISTICS_SQL, [tenant])).filter((row) => Boolean(parseMetadata(row)[CTQ_KEY]));
  const requirementLinks = await queryAllAsync(db, REQUIREMENT_CHARACTERISTIC_LINKS_SQL, [tenant, REQUIREMENT_SOURCE_TYPE, ...ALLOCATION_CODES]);
  const ctqIds = ctqRows.map((row) => Number(row.id));
  const operationIds = [];
  for (const id of ctqIds) {
    const rows = await queryAllAsync(db, CHARACTERISTIC_OPERATION_IDS_SQL, [tenant, id]);
    for (const row of rows) operationIds.push(row.object_id);
  }
  const ruleCategory = parseCoverageRule(getConfig(db, tenant, "coverage_rules"), CTQ_TOKEN);
  const ctqEnabled = getConfig(db, tenant, "ctq_enabled");
  const requireForCritical = getConfig(db, tenant, "require_ctq_for_critical");
  const criticality = requireForCritical ? criticalitySet(getConfig(db, tenant, "ctq_criticality")) : new Set();
  const coveredRequirementIds = new Set(requirementLinks.map((link) => Number(link.source_id)));
  const missingRows = await loadMissingCtqRequirements(db, tenant, criticality, coveredRequirementIds, { async: true });
  return assembleCtqCoverage({ tenant, ctqRows, requirementLinks, operationIds, missingRows, ruleCategory, ctqEnabled, requireForCritical, opts });
}

// ── Machine-readable constraint compatibility ────────────────────────────────

function normalizeConstraintValue(db, row, body) {
  const providedUnit = String(body.unit ?? body.uom ?? "").trim();
  const targetUnit = String(row.unit || "").trim();
  const raw = body.value ?? body.actual ?? null;
  if (raw === null || raw === undefined || raw === "") {
    return { status: STATUS.PENDING_VALIDATION, valid: null, reason: "NO_VALUE", value: null, unit: providedUnit || targetUnit };
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return { status: STATUS.VALIDATION_ERROR, valid: null, reason: "INVALID_VALUE", value: raw, unit: providedUnit || targetUnit };
  }
  let converted = numeric;
  let unit = targetUnit;
  if (providedUnit && targetUnit && providedUnit.toUpperCase() !== targetUnit.toUpperCase()) {
    const units = Units.listUnits(db, { limit: 2000 });
    const result = Units.convertValue(numeric, providedUnit, targetUnit, { units, strict: false });
    if (result.compatible === false) {
      return { status: STATUS.CONFIGURATION_MISMATCH, valid: null, reason: "UNIT_MISMATCH", value: numeric, unit: providedUnit, expected_unit: targetUnit };
    }
    converted = Number(result.value);
    unit = result.unit || targetUnit;
  }
  const scale = Number(row.scale);
  if (Number.isInteger(scale) && scale > 0) converted = Number(converted.toFixed(scale));
  return { status: null, valid: null, value: converted, unit, provided_value: numeric, provided_unit: providedUnit || targetUnit };
}

function compareConstraints(row, normalized) {
  const min = row.min_value;
  const max = row.max_value;
  if (min == null && max == null) {
    return { status: STATUS.PENDING_VALIDATION, valid: null, reason: "NO_LIMITS" };
  }
  const minInclusive = toBoolFlag(row.min_inclusive);
  const maxInclusive = toBoolFlag(row.max_inclusive);
  if (min != null) {
    if (normalized.value < min || (!minInclusive && normalized.value === min)) {
      return { status: STATUS.INVALID_LINK, valid: false, reason: "BELOW_MIN" };
    }
  }
  if (max != null) {
    if (normalized.value > max || (!maxInclusive && normalized.value === max)) {
      return { status: STATUS.INVALID_LINK, valid: false, reason: "ABOVE_MAX" };
    }
  }
  return { status: STATUS.VALID, valid: true, reason: "WITHIN_LIMITS" };
}

function constraintResult(db, row, body) {
  const normalized = normalizeConstraintValue(db, row, body);
  const descriptor = characteristicDescriptor(row);
  const limits = { min_value: row.min_value, max_value: row.max_value, min_inclusive: toBoolFlag(row.min_inclusive), max_inclusive: toBoolFlag(row.max_inclusive), unit: row.unit || "" };
  if (normalized.status) {
    return {
      characteristic: descriptor,
      limits,
      value: normalized.value,
      unit: normalized.unit,
      status: normalized.status,
      valid: normalized.valid,
      reason: normalized.reason,
      expected_unit: normalized.expected_unit ?? null,
      source_module: "requirement-manufacturing",
    };
  }
  const comparison = compareConstraints(row, normalized);
  return {
    characteristic: descriptor,
    limits,
    value: normalized.value,
    unit: normalized.unit,
    provided_value: normalized.provided_value,
    provided_unit: normalized.provided_unit,
    status: comparison.status,
    valid: comparison.valid,
    reason: comparison.reason,
    source_module: "requirement-manufacturing",
  };
}

export function validateConstraintCompatibility(db, tenantId, characteristicRef, body = {}) {
  const tenant = Number(tenantId);
  const row = requireCharacteristic(db, tenant, characteristicRef);
  return constraintResult(db, row, body);
}

export async function validateConstraintCompatibilityAsync(db, tenantId, characteristicRef, body = {}) {
  const tenant = Number(tenantId);
  const row = await requireCharacteristic(db, tenant, characteristicRef, { async: true });
  return constraintResult(db, row, body);
}

export const CTQ_COVERAGE_STATUS = Object.freeze({ MISSING_LINK: STATUS.MISSING_LINK });

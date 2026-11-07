// Digital Thread provider for the Verification & Validation (V&V) Engine.
//
// V&V owns its test-case, procedure, execution, result and waiver state in its
// own `vv_*` tables, so those nodes are not stamped into the generic `objects`
// table and cannot be resolved by the Object provider. This is the Digital
// Thread engine's official provider seam (not a second graph): it resolves the
// V&V node types and projects the V&V edges so the Requirement -> Test Case ->
// Procedure -> Execution -> Result -> Evidence chain traverses forward and
// backward alongside every other domain.
//
// Requirement nodes and cross-domain context nodes (product/part items, content
// evidence) are delegated to the Object and Content providers that already own
// them; the V&V provider never copies their state.
import { queryAll } from "../../db.js";
import { queryAllAsync } from "../../db-async.js";
import { nodeRef, registerProvider } from "../thread/providers.js";
import { ensureProviders } from "../thread/traversal.js";
import { objectProvider } from "../thread/provider-object.js";
import { PROVIDERS } from "../thread/constants.js";
import { parseArray, parseObject } from "../data-lifecycle/validation.js";
import { VV_NODE_TYPES, REQUIREMENT_VNV_RELATIONSHIPS } from "./constants.js";

const TYPE = VV_NODE_TYPES;
const OWNED_TYPES = Object.freeze([TYPE.TEST_CASE, TYPE.TEST_PROCEDURE, TYPE.TEST_EXECUTION, TYPE.TEST_RESULT, TYPE.WAIVER, TYPE.REQUIREMENT]);
const OWNED_TYPE_SET = new Set(OWNED_TYPES);
const VV_TYPES = Object.freeze([TYPE.TEST_CASE, TYPE.TEST_PROCEDURE, TYPE.TEST_EXECUTION, TYPE.TEST_RESULT, TYPE.WAIVER]);
const DOMAIN = "QUALITY";

function marks(count) {
  return count.map(() => "?").join(",");
}

function isOwnedType(type) {
  return OWNED_TYPE_SET.has(String(type || "").toLowerCase());
}

function numericIds(refs, type) {
  const ids = [];
  for (const ref of refs) {
    if (String(ref.objectType || "").toLowerCase() !== type) continue;
    if (/^\d+$/.test(String(ref.objectId))) ids.push(String(ref.objectId));
  }
  return [...new Set(ids)];
}

function baseNode(type, row, extra = {}) {
  const ref = row.test_case_ref || row.procedure_ref || row.execution_ref || row.result_ref || row.waiver_ref || row.code || "";
  return {
    node_ref: nodeRef(type, row.id),
    object_type: type,
    object_id: String(row.id),
    source_object_type: type,
    source_object_id: String(row.id),
    source_object_revision_id: "",
    domain: type === TYPE.REQUIREMENT ? "REQUIREMENT" : DOMAIN,
    display_name: row.name || ref,
    number: ref,
    revision: row.revision != null ? String(row.revision) : "",
    lifecycle_state: row.status || "",
    organization_id: row.organization_id ?? null,
    site: "",
    node_type: type,
    metadata: { provider: PROVIDERS.VERIFICATION_VALIDATION, ...extra },
  };
}

// ── Node resolvers ───────────────────────────────────────────────────────────

function testCaseNode(row) {
  return baseNode(TYPE.TEST_CASE, row, { verification_kind: row.verification_kind, method_code: row.method_code, test_case_ref: row.test_case_ref });
}

function procedureNode(row) {
  return baseNode(TYPE.TEST_PROCEDURE, row, { test_case_id: row.test_case_id, procedure_ref: row.procedure_ref });
}

function executionNode(row) {
  return baseNode(TYPE.TEST_EXECUTION, row, {
    test_case_id: row.test_case_id,
    procedure_id: row.procedure_id,
    previous_execution_id: row.previous_execution_id,
    overall_outcome: row.overall_outcome,
    execution_ref: row.execution_ref,
  });
}

function resultNode(row) {
  return baseNode(TYPE.TEST_RESULT, row, {
    execution_id: row.execution_id,
    requirement_id: row.requirement_id,
    outcome: row.outcome,
    evidence_count: row.evidence_count,
    result_ref: row.result_ref,
  });
}

function waiverNode(row) {
  return baseNode(TYPE.WAIVER, row, {
    requirement_id: row.requirement_id,
    test_case_id: row.test_case_id,
    execution_id: row.execution_id,
    result_id: row.result_id,
    expires_at: row.expires_at,
    waiver_ref: row.waiver_ref,
  });
}

const RESOLVERS = Object.freeze({
  [TYPE.TEST_CASE]: { table: "vv_test_cases", build: testCaseNode, refColumn: "test_case_ref" },
  [TYPE.TEST_PROCEDURE]: { table: "vv_test_procedures", build: procedureNode, refColumn: "procedure_ref" },
  [TYPE.TEST_EXECUTION]: { table: "vv_executions", build: executionNode, refColumn: "execution_ref" },
  [TYPE.TEST_RESULT]: { table: "vv_results", build: resultNode, refColumn: "result_ref" },
  [TYPE.WAIVER]: { table: "vv_waivers", build: waiverNode, refColumn: "waiver_ref" },
});

function resolveByType(db, tenantId, refs, type) {
  const ids = numericIds(refs, type);
  if (!ids.length) return [];
  const { table, build } = RESOLVERS[type];
  return queryAll(db, `SELECT * FROM ${table} WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids]).map(build);
}

async function resolveByTypeAsync(db, tenantId, refs, type) {
  const ids = numericIds(refs, type);
  if (!ids.length) return [];
  const { table, build } = RESOLVERS[type];
  const rows = await queryAllAsync(db, `SELECT * FROM ${table} WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids]);
  return rows.map(build);
}

// ── Edge helpers ─────────────────────────────────────────────────────────────

function edge(sourceRef, targetRef, relationshipType, direction = "OUT", metadata = {}) {
  return {
    source_node_ref: sourceRef,
    target_node_ref: targetRef,
    relationship_type: relationshipType,
    relationship_id: "",
    relationship_direction: direction,
    source_revision: "",
    target_revision: "",
    effectivity: {},
    configuration: {},
    lifecycle_context: "",
    confidence: null,
    metadata: { provider: PROVIDERS.VERIFICATION_VALIDATION, ...metadata },
  };
}

function requirementObjectIds(refs) {
  const ids = [];
  for (const ref of refs) {
    if (String(ref.objectType || "").toLowerCase() !== TYPE.REQUIREMENT) continue;
    if (ref.objectId) ids.push(String(ref.objectId));
  }
  return ids;
}

// Requirement (object_id) → Test Case edges from the Requirements Manager. The
// relationship stores the requirement ROW id in `source_id`, so join back through
// `requirements.object_id` to recover the Digital Thread node identity.
function forwardRequirementEdges(db, tenantId, objectIds) {
  if (!objectIds.length) return [];
  const codes = marks(REQUIREMENT_VNV_RELATIONSHIPS);
  const rows = queryAll(
    db,
    `SELECT rr.*, r.object_id AS req_object_id, r.revision AS req_revision
       FROM requirement_relationships rr
       JOIN requirements r ON r.tenant_id = rr.tenant_id AND r.id::text = rr.source_id
      WHERE rr.tenant_id = ? AND rr.status = 'ACTIVE' AND rr.source_type = ?
        AND rr.relationship_type IN (${codes})
        AND r.object_id IN (${marks(objectIds)})
      LIMIT 20000`,
    [Number(tenantId), TYPE.REQUIREMENT, ...REQUIREMENT_VNV_RELATIONSHIPS, ...objectIds]
  );
  return rows.map((row) => {
    const e = edge(nodeRef(TYPE.REQUIREMENT, row.req_object_id), nodeRef(TYPE.TEST_CASE, row.target_id), row.relationship_type, "OUT", { definition_domain: "REQUIREMENT", source_requirement_id: row.source_id });
    e.source_revision = row.req_revision != null ? String(row.req_revision) : "";
    e.relationship_id = String(row.id);
    e.lifecycle_context = row.status || "";
    return e;
  });
}

async function forwardRequirementEdgesAsync(db, tenantId, objectIds) {
  if (!objectIds.length) return [];
  const codes = marks(REQUIREMENT_VNV_RELATIONSHIPS);
  const rows = await queryAllAsync(
    db,
    `SELECT rr.*, r.object_id AS req_object_id, r.revision AS req_revision
       FROM requirement_relationships rr
       JOIN requirements r ON r.tenant_id = rr.tenant_id AND r.id::text = rr.source_id
      WHERE rr.tenant_id = ? AND rr.status = 'ACTIVE' AND rr.source_type = ?
        AND rr.relationship_type IN (${codes})
        AND r.object_id IN (${marks(objectIds)})
      LIMIT 20000`,
    [Number(tenantId), TYPE.REQUIREMENT, ...REQUIREMENT_VNV_RELATIONSHIPS, ...objectIds]
  );
  return rows.map((row) => {
    const e = edge(nodeRef(TYPE.REQUIREMENT, row.req_object_id), nodeRef(TYPE.TEST_CASE, row.target_id), row.relationship_type, "OUT", { definition_domain: "REQUIREMENT", source_requirement_id: row.source_id });
    e.source_revision = row.req_revision != null ? String(row.req_revision) : "";
    e.relationship_id = String(row.id);
    e.lifecycle_context = row.status || "";
    return e;
  });
}

function reverseRequirementEdges(db, tenantId, refs) {
  const ids = numericIds(refs, TYPE.TEST_CASE);
  if (!ids.length) return [];
  const codes = marks(REQUIREMENT_VNV_RELATIONSHIPS);
  const rows = queryAll(
    db,
    `SELECT rr.*, r.object_id AS req_object_id, r.revision AS req_revision
       FROM requirement_relationships rr
       JOIN requirements r ON r.tenant_id = rr.tenant_id AND r.id::text = rr.source_id
      WHERE rr.tenant_id = ? AND rr.status = 'ACTIVE' AND rr.source_type = ?
        AND rr.relationship_type IN (${codes})
        AND rr.target_type = ? AND rr.target_id IN (${marks(ids)})
      LIMIT 20000`,
    [Number(tenantId), TYPE.REQUIREMENT, ...REQUIREMENT_VNV_RELATIONSHIPS, TYPE.TEST_CASE, ...ids]
  );
  return rows.map((row) => {
    const e = edge(nodeRef(TYPE.REQUIREMENT, row.req_object_id), nodeRef(TYPE.TEST_CASE, row.target_id), row.relationship_type, "IN", { definition_domain: "REQUIREMENT", source_requirement_id: row.source_id });
    e.source_revision = row.req_revision != null ? String(row.req_revision) : "";
    e.relationship_id = String(row.id);
    e.lifecycle_context = row.status || "";
    return e;
  });
}

async function reverseRequirementEdgesAsync(db, tenantId, refs) {
  const ids = numericIds(refs, TYPE.TEST_CASE);
  if (!ids.length) return [];
  const codes = marks(REQUIREMENT_VNV_RELATIONSHIPS);
  const rows = await queryAllAsync(
    db,
    `SELECT rr.*, r.object_id AS req_object_id, r.revision AS req_revision
       FROM requirement_relationships rr
       JOIN requirements r ON r.tenant_id = rr.tenant_id AND r.id::text = rr.source_id
      WHERE rr.tenant_id = ? AND rr.status = 'ACTIVE' AND rr.source_type = ?
        AND rr.relationship_type IN (${codes})
        AND rr.target_type = ? AND rr.target_id IN (${marks(ids)})
      LIMIT 20000`,
    [Number(tenantId), TYPE.REQUIREMENT, ...REQUIREMENT_VNV_RELATIONSHIPS, TYPE.TEST_CASE, ...ids]
  );
  return rows.map((row) => {
    const e = edge(nodeRef(TYPE.REQUIREMENT, row.req_object_id), nodeRef(TYPE.TEST_CASE, row.target_id), row.relationship_type, "IN", { definition_domain: "REQUIREMENT", source_requirement_id: row.source_id });
    e.source_revision = row.req_revision != null ? String(row.req_revision) : "";
    e.relationship_id = String(row.id);
    e.lifecycle_context = row.status || "";
    return e;
  });
}

function requirementObjectLookup(db, tenantId, requirementIds) {
  const lookup = new Map();
  if (!requirementIds.length) return lookup;
  const rows = queryAll(db, `SELECT id, object_id FROM requirements WHERE tenant_id = ? AND id IN (${marks(requirementIds)})`, [Number(tenantId), ...requirementIds]);
  for (const row of rows) if (row.object_id) lookup.set(String(row.id), String(row.object_id));
  return lookup;
}

async function requirementObjectLookupAsync(db, tenantId, requirementIds) {
  const lookup = new Map();
  if (!requirementIds.length) return lookup;
  const rows = await queryAllAsync(db, `SELECT id, object_id FROM requirements WHERE tenant_id = ? AND id IN (${marks(requirementIds)})`, [Number(tenantId), ...requirementIds]);
  for (const row of rows) if (row.object_id) lookup.set(String(row.id), String(row.object_id));
  return lookup;
}

// Test case → procedures / executions (owning FK relationships).
function testCaseInternalEdges(db, tenantId, refs) {
  const ids = numericIds(refs, TYPE.TEST_CASE);
  if (!ids.length) return [];
  const edges = [];
  for (const row of queryAll(db, `SELECT id, test_case_id FROM vv_test_procedures WHERE tenant_id = ? AND test_case_id IN (${marks(ids)})`, [Number(tenantId), ...ids])) {
    edges.push(edge(nodeRef(TYPE.TEST_CASE, row.test_case_id), nodeRef(TYPE.TEST_PROCEDURE, row.id), "test-case.has-procedure", "OUT", { derived_from: "vv_test_procedures" }));
  }
  for (const row of queryAll(db, `SELECT id, test_case_id FROM vv_executions WHERE tenant_id = ? AND test_case_id IN (${marks(ids)})`, [Number(tenantId), ...ids])) {
    edges.push(edge(nodeRef(TYPE.TEST_CASE, row.test_case_id), nodeRef(TYPE.TEST_EXECUTION, row.id), "test-case.executed-by", "OUT", { derived_from: "vv_executions" }));
  }
  return edges;
}

async function testCaseInternalEdgesAsync(db, tenantId, refs) {
  const ids = numericIds(refs, TYPE.TEST_CASE);
  if (!ids.length) return [];
  const edges = [];
  for (const row of await queryAllAsync(db, `SELECT id, test_case_id FROM vv_test_procedures WHERE tenant_id = ? AND test_case_id IN (${marks(ids)})`, [Number(tenantId), ...ids])) {
    edges.push(edge(nodeRef(TYPE.TEST_CASE, row.test_case_id), nodeRef(TYPE.TEST_PROCEDURE, row.id), "test-case.has-procedure", "OUT", { derived_from: "vv_test_procedures" }));
  }
  for (const row of await queryAllAsync(db, `SELECT id, test_case_id FROM vv_executions WHERE tenant_id = ? AND test_case_id IN (${marks(ids)})`, [Number(tenantId), ...ids])) {
    edges.push(edge(nodeRef(TYPE.TEST_CASE, row.test_case_id), nodeRef(TYPE.TEST_EXECUTION, row.id), "test-case.executed-by", "OUT", { derived_from: "vv_executions" }));
  }
  return edges;
}

// Procedure → owning test case / executions that ran it.
function procedureInternalEdges(db, tenantId, refs) {
  const ids = numericIds(refs, TYPE.TEST_PROCEDURE);
  if (!ids.length) return [];
  const edges = [];
  for (const row of queryAll(db, `SELECT id, test_case_id FROM vv_test_procedures WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids])) {
    if (row.test_case_id) edges.push(edge(nodeRef(TYPE.TEST_PROCEDURE, row.id), nodeRef(TYPE.TEST_CASE, row.test_case_id), "test-case.has-procedure", "IN", { derived_from: "vv_test_procedures" }));
  }
  for (const row of queryAll(db, `SELECT id, procedure_id FROM vv_executions WHERE tenant_id = ? AND procedure_id IN (${marks(ids)})`, [Number(tenantId), ...ids])) {
    edges.push(edge(nodeRef(TYPE.TEST_PROCEDURE, row.procedure_id), nodeRef(TYPE.TEST_EXECUTION, row.id), "test-procedure.executed-by", "OUT", { derived_from: "vv_executions" }));
  }
  return edges;
}

async function procedureInternalEdgesAsync(db, tenantId, refs) {
  const ids = numericIds(refs, TYPE.TEST_PROCEDURE);
  if (!ids.length) return [];
  const edges = [];
  for (const row of await queryAllAsync(db, `SELECT id, test_case_id FROM vv_test_procedures WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids])) {
    if (row.test_case_id) edges.push(edge(nodeRef(TYPE.TEST_PROCEDURE, row.id), nodeRef(TYPE.TEST_CASE, row.test_case_id), "test-case.has-procedure", "IN", { derived_from: "vv_test_procedures" }));
  }
  for (const row of await queryAllAsync(db, `SELECT id, procedure_id FROM vv_executions WHERE tenant_id = ? AND procedure_id IN (${marks(ids)})`, [Number(tenantId), ...ids])) {
    edges.push(edge(nodeRef(TYPE.TEST_PROCEDURE, row.procedure_id), nodeRef(TYPE.TEST_EXECUTION, row.id), "test-procedure.executed-by", "OUT", { derived_from: "vv_executions" }));
  }
  return edges;
}

function executionScopeEdges(db, tenantId, rows) {
  const edges = [];
  const requirementIds = [];
  for (const row of rows) {
    for (const id of parseArray(row.requirement_ids_json, [])) {
      const value = Number(id);
      if (Number.isInteger(value) && value > 0) requirementIds.push(String(value));
    }
  }
  const lookup = requirementObjectLookup(db, tenantId, [...new Set(requirementIds)]);
  for (const row of rows) {
    const execRef = nodeRef(TYPE.TEST_EXECUTION, row.id);
    if (row.test_case_id) edges.push(edge(execRef, nodeRef(TYPE.TEST_CASE, row.test_case_id), "test-case.executed-by", "IN", { derived_from: "vv_executions" }));
    if (row.procedure_id) edges.push(edge(execRef, nodeRef(TYPE.TEST_PROCEDURE, row.procedure_id), "test-procedure.executed-by", "IN", { derived_from: "vv_executions" }));
    if (row.previous_execution_id) edges.push(edge(execRef, nodeRef(TYPE.TEST_EXECUTION, row.previous_execution_id), "test-execution.retested-from", "OUT", { derived_from: "previous_execution_id" }));
    if (row.product_object_type && row.product_object_id) {
      edges.push(edge(execRef, nodeRef(String(row.product_object_type).toLowerCase(), row.product_object_id), "test-execution.applies-to.product", "OUT", { configuration_context: row.configuration_context || "" }));
    }
    for (const id of parseArray(row.requirement_ids_json, [])) {
      const objectId = lookup.get(String(Number(id)));
      if (objectId) edges.push(edge(execRef, nodeRef(TYPE.REQUIREMENT, objectId), "test-execution.scoped-to-requirement", "OUT", { definition_domain: "REQUIREMENT" }));
    }
  }
  return edges;
}

async function executionScopeEdgesAsync(db, tenantId, rows) {
  const edges = [];
  const requirementIds = [];
  for (const row of rows) {
    for (const id of parseArray(row.requirement_ids_json, [])) {
      const value = Number(id);
      if (Number.isInteger(value) && value > 0) requirementIds.push(String(value));
    }
  }
  const lookup = await requirementObjectLookupAsync(db, tenantId, [...new Set(requirementIds)]);
  for (const row of rows) {
    const execRef = nodeRef(TYPE.TEST_EXECUTION, row.id);
    if (row.test_case_id) edges.push(edge(execRef, nodeRef(TYPE.TEST_CASE, row.test_case_id), "test-case.executed-by", "IN", { derived_from: "vv_executions" }));
    if (row.procedure_id) edges.push(edge(execRef, nodeRef(TYPE.TEST_PROCEDURE, row.procedure_id), "test-procedure.executed-by", "IN", { derived_from: "vv_executions" }));
    if (row.previous_execution_id) edges.push(edge(execRef, nodeRef(TYPE.TEST_EXECUTION, row.previous_execution_id), "test-execution.retested-from", "OUT", { derived_from: "previous_execution_id" }));
    if (row.product_object_type && row.product_object_id) {
      edges.push(edge(execRef, nodeRef(String(row.product_object_type).toLowerCase(), row.product_object_id), "test-execution.applies-to.product", "OUT", { configuration_context: row.configuration_context || "" }));
    }
    for (const id of parseArray(row.requirement_ids_json, [])) {
      const objectId = lookup.get(String(Number(id)));
      if (objectId) edges.push(edge(execRef, nodeRef(TYPE.REQUIREMENT, objectId), "test-execution.scoped-to-requirement", "OUT", { definition_domain: "REQUIREMENT" }));
    }
  }
  return edges;
}

function executionInternalEdges(db, tenantId, refs) {
  const ids = numericIds(refs, TYPE.TEST_EXECUTION);
  if (!ids.length) return [];
  const edges = [];
  const rows = queryAll(db, `SELECT * FROM vv_executions WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids]);
  edges.push(...executionScopeEdges(db, tenantId, rows));
  for (const row of queryAll(db, `SELECT id, execution_id FROM vv_results WHERE tenant_id = ? AND execution_id IN (${marks(ids)})`, [Number(tenantId), ...ids])) {
    edges.push(edge(nodeRef(TYPE.TEST_EXECUTION, row.execution_id), nodeRef(TYPE.TEST_RESULT, row.id), "test-execution.produced-result", "OUT", { derived_from: "vv_results" }));
  }
  for (const row of queryAll(db, `SELECT id, previous_execution_id FROM vv_executions WHERE tenant_id = ? AND previous_execution_id IN (${marks(ids)})`, [Number(tenantId), ...ids])) {
    edges.push(edge(nodeRef(TYPE.TEST_EXECUTION, row.previous_execution_id), nodeRef(TYPE.TEST_EXECUTION, row.id), "test-execution.retested-by", "OUT", { derived_from: "previous_execution_id" }));
  }
  return edges;
}

async function executionInternalEdgesAsync(db, tenantId, refs) {
  const ids = numericIds(refs, TYPE.TEST_EXECUTION);
  if (!ids.length) return [];
  const edges = [];
  const rows = await queryAllAsync(db, `SELECT * FROM vv_executions WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids]);
  edges.push(...(await executionScopeEdgesAsync(db, tenantId, rows)));
  for (const row of await queryAllAsync(db, `SELECT id, execution_id FROM vv_results WHERE tenant_id = ? AND execution_id IN (${marks(ids)})`, [Number(tenantId), ...ids])) {
    edges.push(edge(nodeRef(TYPE.TEST_EXECUTION, row.execution_id), nodeRef(TYPE.TEST_RESULT, row.id), "test-execution.produced-result", "OUT", { derived_from: "vv_results" }));
  }
  for (const row of await queryAllAsync(db, `SELECT id, previous_execution_id FROM vv_executions WHERE tenant_id = ? AND previous_execution_id IN (${marks(ids)})`, [Number(tenantId), ...ids])) {
    edges.push(edge(nodeRef(TYPE.TEST_EXECUTION, row.previous_execution_id), nodeRef(TYPE.TEST_EXECUTION, row.id), "test-execution.retested-by", "OUT", { derived_from: "previous_execution_id" }));
  }
  return edges;
}

function resultInternalEdges(db, tenantId, refs) {
  const ids = numericIds(refs, TYPE.TEST_RESULT);
  if (!ids.length) return [];
  const edges = [];
  const rows = queryAll(db, `SELECT * FROM vv_results WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids]);
  const requirementIds = [...new Set(rows.map((row) => Number(row.requirement_id)).filter((id) => Number.isInteger(id) && id > 0))];
  const lookup = requirementObjectLookup(db, tenantId, requirementIds);
  for (const row of rows) {
    const resRef = nodeRef(TYPE.TEST_RESULT, row.id);
    if (row.execution_id) edges.push(edge(resRef, nodeRef(TYPE.TEST_EXECUTION, row.execution_id), "test-execution.produced-result", "IN", { derived_from: "vv_results" }));
    if (row.requirement_id) {
      const objectId = lookup.get(String(row.requirement_id));
      if (objectId) edges.push(edge(resRef, nodeRef(TYPE.REQUIREMENT, objectId), "test-result.evidence-for-requirement", "OUT", { definition_domain: "REQUIREMENT" }));
    }
  }
  return edges;
}

async function resultInternalEdgesAsync(db, tenantId, refs) {
  const ids = numericIds(refs, TYPE.TEST_RESULT);
  if (!ids.length) return [];
  const edges = [];
  const rows = await queryAllAsync(db, `SELECT * FROM vv_results WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids]);
  const requirementIds = [...new Set(rows.map((row) => Number(row.requirement_id)).filter((id) => Number.isInteger(id) && id > 0))];
  const lookup = await requirementObjectLookupAsync(db, tenantId, requirementIds);
  for (const row of rows) {
    const resRef = nodeRef(TYPE.TEST_RESULT, row.id);
    if (row.execution_id) edges.push(edge(resRef, nodeRef(TYPE.TEST_EXECUTION, row.execution_id), "test-execution.produced-result", "IN", { derived_from: "vv_results" }));
    if (row.requirement_id) {
      const objectId = lookup.get(String(row.requirement_id));
      if (objectId) edges.push(edge(resRef, nodeRef(TYPE.REQUIREMENT, objectId), "test-result.evidence-for-requirement", "OUT", { definition_domain: "REQUIREMENT" }));
    }
  }
  return edges;
}

function waiverInternalEdges(db, tenantId, refs) {
  const ids = numericIds(refs, TYPE.WAIVER);
  if (!ids.length) return [];
  const rows = queryAll(db, `SELECT * FROM vv_waivers WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids]);
  const requirementIds = [...new Set(rows.map((row) => Number(row.requirement_id)).filter((id) => Number.isInteger(id) && id > 0))];
  const lookup = requirementObjectLookup(db, tenantId, requirementIds);
  return buildWaiverEdges(rows, lookup);
}

async function waiverInternalEdgesAsync(db, tenantId, refs) {
  const ids = numericIds(refs, TYPE.WAIVER);
  if (!ids.length) return [];
  const rows = await queryAllAsync(db, `SELECT * FROM vv_waivers WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids]);
  const requirementIds = [...new Set(rows.map((row) => Number(row.requirement_id)).filter((id) => Number.isInteger(id) && id > 0))];
  const lookup = await requirementObjectLookupAsync(db, tenantId, requirementIds);
  return buildWaiverEdges(rows, lookup);
}

function buildWaiverEdges(rows, requirementLookup) {
  const edges = [];
  for (const row of rows) {
    const waiverRef = nodeRef(TYPE.WAIVER, row.id);
    if (row.requirement_id) {
      const objectId = requirementLookup.get(String(row.requirement_id));
      if (objectId) edges.push(edge(waiverRef, nodeRef(TYPE.REQUIREMENT, objectId), "waiver.applies-to.requirement", "OUT", { definition_domain: "REQUIREMENT" }));
    }
    if (row.test_case_id) edges.push(edge(waiverRef, nodeRef(TYPE.TEST_CASE, row.test_case_id), "waiver.applies-to.test-case", "OUT", { derived_from: "vv_waivers" }));
    if (row.execution_id) edges.push(edge(waiverRef, nodeRef(TYPE.TEST_EXECUTION, row.execution_id), "waiver.applies-to.test-execution", "OUT", { derived_from: "vv_waivers" }));
    if (row.result_id) edges.push(edge(waiverRef, nodeRef(TYPE.TEST_RESULT, row.result_id), "waiver.applies-to.test-result", "OUT", { derived_from: "vv_waivers" }));
  }
  return edges;
}

// Evidence: execution/result → controlled content document.
function evidenceEdges(db, tenantId, refs) {
  const edges = [];
  const executionIds = numericIds(refs, TYPE.TEST_EXECUTION);
  const resultIds = numericIds(refs, TYPE.TEST_RESULT);
  if (executionIds.length) {
    for (const row of queryAll(db, `SELECT content_id, object_id FROM content_associations WHERE tenant_id = ? AND status = 'active' AND object_type = ? AND object_id IN (${marks(executionIds)})`, [Number(tenantId), TYPE.TEST_EXECUTION, ...executionIds])) {
      edges.push(edge(nodeRef(TYPE.TEST_EXECUTION, row.object_id), nodeRef("content", row.content_id), "test-execution.supported-by.content", "OUT", { derived_from: "content_associations" }));
    }
  }
  if (resultIds.length) {
    for (const row of queryAll(db, `SELECT content_id, object_id FROM content_associations WHERE tenant_id = ? AND status = 'active' AND object_type = ? AND object_id IN (${marks(resultIds)})`, [Number(tenantId), TYPE.TEST_RESULT, ...resultIds])) {
      edges.push(edge(nodeRef(TYPE.TEST_RESULT, row.object_id), nodeRef("content", row.content_id), "test-result.supported-by.content", "OUT", { derived_from: "content_associations" }));
    }
  }
  return edges;
}

async function evidenceEdgesAsync(db, tenantId, refs) {
  const edges = [];
  const executionIds = numericIds(refs, TYPE.TEST_EXECUTION);
  const resultIds = numericIds(refs, TYPE.TEST_RESULT);
  if (executionIds.length) {
    for (const row of await queryAllAsync(db, `SELECT content_id, object_id FROM content_associations WHERE tenant_id = ? AND status = 'active' AND object_type = ? AND object_id IN (${marks(executionIds)})`, [Number(tenantId), TYPE.TEST_EXECUTION, ...executionIds])) {
      edges.push(edge(nodeRef(TYPE.TEST_EXECUTION, row.object_id), nodeRef("content", row.content_id), "test-execution.supported-by.content", "OUT", { derived_from: "content_associations" }));
    }
  }
  if (resultIds.length) {
    for (const row of await queryAllAsync(db, `SELECT content_id, object_id FROM content_associations WHERE tenant_id = ? AND status = 'active' AND object_type = ? AND object_id IN (${marks(resultIds)})`, [Number(tenantId), TYPE.TEST_RESULT, ...resultIds])) {
      edges.push(edge(nodeRef(TYPE.TEST_RESULT, row.object_id), nodeRef("content", row.content_id), "test-result.supported-by.content", "OUT", { derived_from: "content_associations" }));
    }
  }
  return edges;
}

function dedupe(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    const key = `${e.source_node_ref}|${e.target_node_ref}|${e.relationship_type}|${e.relationship_direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export const verificationValidationProvider = {
  code: PROVIDERS.VERIFICATION_VALIDATION,
  name: "Verification & Validation",
  builtin: false,
  object_types: [...OWNED_TYPES],
  accepts(ref) {
    return isOwnedType(ref?.objectType);
  },
  resolveMany(db, tenantId, refs, context = {}) {
    const requirementRefs = refs.filter((ref) => String(ref.objectType || "").toLowerCase() === TYPE.REQUIREMENT);
    return [
      ...(requirementRefs.length ? objectProvider.resolveMany(db, tenantId, requirementRefs, context) : []),
      ...VV_TYPES.flatMap((type) => resolveByType(db, tenantId, refs, type)),
    ];
  },
  resolve(db, tenantId, ref, context = {}) {
    return this.resolveMany(db, tenantId, [ref], context)[0] || null;
  },
  async resolveManyAsync(db, tenantId, refs, context = {}) {
    const requirementRefs = refs.filter((ref) => String(ref.objectType || "").toLowerCase() === TYPE.REQUIREMENT);
    const resolved = requirementRefs.length ? await objectProvider.resolveManyAsync(db, tenantId, requirementRefs, context) : [];
    for (const type of VV_TYPES) resolved.push(...(await resolveByTypeAsync(db, tenantId, refs, type)));
    return resolved;
  },
  async resolveAsync(db, tenantId, ref, context = {}) {
    return (await this.resolveManyAsync(db, tenantId, [ref], context))[0] || null;
  },
  neighbors(db, tenantId, refs) {
    const objectIds = requirementObjectIds(refs);
    return dedupe([
      ...(objectIds.length ? forwardRequirementEdges(db, tenantId, objectIds) : []),
      ...reverseRequirementEdges(db, tenantId, refs),
      ...testCaseInternalEdges(db, tenantId, refs),
      ...procedureInternalEdges(db, tenantId, refs),
      ...executionInternalEdges(db, tenantId, refs),
      ...resultInternalEdges(db, tenantId, refs),
      ...waiverInternalEdges(db, tenantId, refs),
      ...evidenceEdges(db, tenantId, refs),
    ]);
  },
  async neighborsAsync(db, tenantId, refs) {
    const objectIds = requirementObjectIds(refs);
    return dedupe([
      ...(objectIds.length ? await forwardRequirementEdgesAsync(db, tenantId, objectIds) : []),
      ...(await reverseRequirementEdgesAsync(db, tenantId, refs)),
      ...(await testCaseInternalEdgesAsync(db, tenantId, refs)),
      ...(await procedureInternalEdgesAsync(db, tenantId, refs)),
      ...(await executionInternalEdgesAsync(db, tenantId, refs)),
      ...(await resultInternalEdgesAsync(db, tenantId, refs)),
      ...(await waiverInternalEdgesAsync(db, tenantId, refs)),
      ...(await evidenceEdgesAsync(db, tenantId, refs)),
    ]);
  },
};

// Registers the provider with the Digital Thread engine. Idempotent.
export function registerVvProvider() {
  ensureProviders();
  registerProvider(verificationValidationProvider);
  return verificationValidationProvider.code;
}

// Digital Thread provider for the Requirement -> Manufacturing traceability
// layer.
//
// This is the sanctioned provider seam of the existing Digital Thread engine,
// not a second graph. It closes the one structural gap the generic Object
// provider cannot cover: Classification characteristics (`cla_characteristics`)
// and Content documents (`content`) live in their own tables and are never
// stamped into the generic `objects` table, so the built-in providers cannot
// resolve them as nodes. Operations and work centers ARE generic objects and are
// delegated to the Object provider.
//
// It also projects the manufacturing-only requirement edges that the
// Requirement/PDM provider deliberately ignores (GOVERNED_BY / CONTROLLED_BY),
// and projects the reverse direction of the manufacturing allocation edges so
// operation/work center/characteristic/document nodes can walk back to the
// requirements they satisfy. No table of its own is created or copied.
import { queryAll } from "../../db.js";
import { queryAllAsync } from "../../db-async.js";
import { nodeRef, registerProvider } from "../thread/providers.js";
import { ensureProviders } from "../thread/traversal.js";
import { objectProvider } from "../thread/provider-object.js";
import { PROVIDERS } from "../thread/constants.js";
import {
  REQUIREMENT_SOURCE_TYPE,
  OPERATION_OBJECT_TYPE,
  WORK_CENTER_OBJECT_TYPE,
} from "./constants.js";

const OWNED_TYPES = Object.freeze([
  REQUIREMENT_SOURCE_TYPE,
  OPERATION_OBJECT_TYPE,
  WORK_CENTER_OBJECT_TYPE,
  "characteristic",
  "content",
]);

const OWNED_TYPE_SET = new Set(OWNED_TYPES);

// Requirement relationship codes whose target side is a manufacturing-only node
// type. The Requirement/PDM provider already projects ALLOCATED_TO /
// IMPLEMENTED_BY / REALIZED_BY / SATISFIED_BY / REPRESENTED_BY, so only the
// manufacturing-exclusive codes are projected forward here to avoid duplication.
const FORWARD_REQUIREMENT_CODES = Object.freeze(["GOVERNED_BY", "CONTROLLED_BY"]);

// Reverse projection: from a manufacturing node back to the requirement(s) that
// point at it. Includes the codes the Requirement/PDM provider cannot reverse
// because these target types are not in its target set.
const REVERSE_CODES_BY_TYPE = Object.freeze({
  characteristic: ["GOVERNED_BY", "CONTROLLED_BY"],
  content: ["REPRESENTED_BY"],
  operation: ["REALIZED_BY", "SATISFIED_BY"],
  work_center: ["SATISFIED_BY"],
});

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

// ── Node resolvers (characteristic, content) ────────────────────────────────

function characteristicNode(row) {
  return {
    node_ref: nodeRef("characteristic", row.id),
    object_type: "characteristic",
    object_id: String(row.id),
    source_object_type: "characteristic",
    source_object_id: String(row.id),
    source_object_revision_id: "",
    domain: "MANUFACTURING",
    display_name: row.name || row.code,
    number: row.code,
    revision: row.version != null ? String(row.version) : "",
    lifecycle_state: row.status || "",
    organization_id: null,
    site: "",
    node_type: "characteristic",
    metadata: { data_type: row.data_type, unit: row.unit, characteristic_ref: row.characteristic_ref },
  };
}

function contentNode(row) {
  return {
    node_ref: nodeRef("content", row.id),
    object_type: "content",
    object_id: String(row.id),
    source_object_type: "content",
    source_object_id: String(row.id),
    source_object_revision_id: "",
    domain: "DESIGN",
    display_name: row.description || row.file_name || row.content_id,
    number: row.content_key || row.content_id,
    revision: row.version_id != null ? String(row.version_id) : "",
    lifecycle_state: row.status || "",
    organization_id: row.organization_id ?? null,
    site: "",
    node_type: "content",
    metadata: { content_type: row.content_type, mime_type: row.mime_type, security_status: row.security_status },
  };
}

function resolveCharacteristics(db, tenantId, refs) {
  const ids = numericIds(refs, "characteristic");
  if (!ids.length) return [];
  return queryAll(db, `SELECT * FROM cla_characteristics WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids]).map(characteristicNode);
}

async function resolveCharacteristicsAsync(db, tenantId, refs) {
  const ids = numericIds(refs, "characteristic");
  if (!ids.length) return [];
  const rows = await queryAllAsync(db, `SELECT * FROM cla_characteristics WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids]);
  return rows.map(characteristicNode);
}

function resolveContents(db, tenantId, refs) {
  const ids = numericIds(refs, "content");
  if (!ids.length) return [];
  return queryAll(db, `SELECT * FROM content WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids]).map(contentNode);
}

async function resolveContentsAsync(db, tenantId, refs) {
  const ids = numericIds(refs, "content");
  if (!ids.length) return [];
  const rows = await queryAllAsync(db, `SELECT * FROM content WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids]);
  return rows.map(contentNode);
}

// ── Requirement relationship projection ─────────────────────────────────────

const REQ_JOIN = `JOIN requirements r ON r.tenant_id = rr.tenant_id AND r.id::text = rr.source_id`;

function requirementEdge(relationship, targetDomain) {
  return {
    source_node_ref: nodeRef(REQUIREMENT_SOURCE_TYPE, relationship.req_object_id),
    target_node_ref: nodeRef(String(relationship.target_type).toLowerCase(), relationship.target_id),
    relationship_type: relationship.relationship_type,
    relationship_id: String(relationship.id),
    relationship_direction: "OUT",
    source_revision: relationship.req_revision != null ? String(relationship.req_revision) : "",
    target_revision: "",
    effectivity: {},
    configuration: {},
    lifecycle_context: relationship.status || "",
    confidence: null,
    metadata: {
      provider: PROVIDERS.REQUIREMENT_MANUFACTURING,
      definition_domain: "REQUIREMENT",
      target_domain: targetDomain || "",
      source_requirement_id: relationship.source_id,
    },
  };
}

function forwardRequirementEdges(db, tenantId, objectIds) {
  if (!objectIds.length) return [];
  const codeMarks = marks(FORWARD_REQUIREMENT_CODES);
  const rows = queryAll(
    db,
    `SELECT rr.*, r.object_id AS req_object_id, r.revision AS req_revision
       FROM requirement_relationships rr ${REQ_JOIN}
      WHERE rr.tenant_id = ? AND rr.status = 'ACTIVE' AND rr.source_type = ?
        AND rr.relationship_type IN (${codeMarks})
        AND r.object_id IN (${marks(objectIds)})
      LIMIT 20000`,
    [Number(tenantId), REQUIREMENT_SOURCE_TYPE, ...FORWARD_REQUIREMENT_CODES, ...objectIds]
  );
  return rows.map((row) => requirementEdge(row, targetDomainOf(row.target_type)));
}

async function forwardRequirementEdgesAsync(db, tenantId, objectIds) {
  if (!objectIds.length) return [];
  const codeMarks = marks(FORWARD_REQUIREMENT_CODES);
  const rows = await queryAllAsync(
    db,
    `SELECT rr.*, r.object_id AS req_object_id, r.revision AS req_revision
       FROM requirement_relationships rr ${REQ_JOIN}
      WHERE rr.tenant_id = ? AND rr.status = 'ACTIVE' AND rr.source_type = ?
        AND rr.relationship_type IN (${codeMarks})
        AND r.object_id IN (${marks(objectIds)})
      LIMIT 20000`,
    [Number(tenantId), REQUIREMENT_SOURCE_TYPE, ...FORWARD_REQUIREMENT_CODES, ...objectIds]
  );
  return rows.map((row) => requirementEdge(row, targetDomainOf(row.target_type)));
}

function reverseClause(refs) {
  const clauses = [];
  const params = [];
  for (const [type, codes] of Object.entries(REVERSE_CODES_BY_TYPE)) {
    const ids = numericIds(refs, type);
    if (!ids.length) continue;
    clauses.push(`(rr.relationship_type IN (${marks(codes)}) AND rr.target_type = ? AND rr.target_id IN (${marks(ids)}))`);
    params.push(...codes, type, ...ids);
  }
  if (!clauses.length) return null;
  return { clause: clauses.join(" OR "), params };
}

function reverseRequirementEdges(db, tenantId, refs) {
  const parts = reverseClause(refs);
  if (!parts) return [];
  const rows = queryAll(
    db,
    `SELECT rr.*, r.object_id AS req_object_id, r.revision AS req_revision
       FROM requirement_relationships rr ${REQ_JOIN}
      WHERE rr.tenant_id = ? AND rr.status = 'ACTIVE' AND rr.source_type = ?
        AND (${parts.clause})
      LIMIT 20000`,
    [Number(tenantId), REQUIREMENT_SOURCE_TYPE, ...parts.params]
  );
  return rows.map((row) => requirementEdge(row, targetDomainOf(row.target_type)));
}

async function reverseRequirementEdgesAsync(db, tenantId, refs) {
  const parts = reverseClause(refs);
  if (!parts) return [];
  const rows = await queryAllAsync(
    db,
    `SELECT rr.*, r.object_id AS req_object_id, r.revision AS req_revision
       FROM requirement_relationships rr ${REQ_JOIN}
      WHERE rr.tenant_id = ? AND rr.status = 'ACTIVE' AND rr.source_type = ?
        AND (${parts.clause})
      LIMIT 20000`,
    [Number(tenantId), REQUIREMENT_SOURCE_TYPE, ...parts.params]
  );
  return rows.map((row) => requirementEdge(row, targetDomainOf(row.target_type)));
}

function targetDomainOf(type) {
  switch (String(type || "").toLowerCase()) {
    case OPERATION_OBJECT_TYPE:
      return "MANUFACTURING";
    case WORK_CENTER_OBJECT_TYPE:
      return "MANUFACTURING";
    case "characteristic":
      return "MANUFACTURING";
    case "content":
      return "DESIGN";
    default:
      return "";
  }
}

// ── Classification / Content association edges ──────────────────────────────

// A characteristic is applied to every object its class is assigned to
// (cla_class_characteristics -> cla_assignments). Reuses the Classification
// model; no new association store.
function characteristicAssociationEdges(db, tenantId, refs) {
  const ids = numericIds(refs, "characteristic");
  if (!ids.length) return [];
  const rows = queryAll(
    db,
    `SELECT cc.characteristic_id, a.object_type, a.object_id
       FROM cla_class_characteristics cc
       JOIN cla_assignments a ON a.tenant_id = cc.tenant_id AND a.class_id = cc.class_id AND a.status = 'ACTIVE'
      WHERE cc.tenant_id = ? AND cc.status = 'ACTIVE' AND cc.characteristic_id IN (${marks(ids)})
      LIMIT 20000`,
    [Number(tenantId), ...ids]
  );
  return rows.map((row) => ({
    source_node_ref: nodeRef("characteristic", row.characteristic_id),
    target_node_ref: nodeRef(String(row.object_type).toLowerCase(), row.object_id),
    relationship_type: "characteristic.applies-to.operation",
    relationship_id: "",
    relationship_direction: "OUT",
    source_revision: "",
    target_revision: "",
    effectivity: {},
    configuration: {},
    lifecycle_context: "ACTIVE",
    confidence: null,
    metadata: { provider: PROVIDERS.REQUIREMENT_MANUFACTURING, derived_from: "cla_assignments" },
  }));
}

async function characteristicAssociationEdgesAsync(db, tenantId, refs) {
  const ids = numericIds(refs, "characteristic");
  if (!ids.length) return [];
  const rows = await queryAllAsync(
    db,
    `SELECT cc.characteristic_id, a.object_type, a.object_id
       FROM cla_class_characteristics cc
       JOIN cla_assignments a ON a.tenant_id = cc.tenant_id AND a.class_id = cc.class_id AND a.status = 'ACTIVE'
      WHERE cc.tenant_id = ? AND cc.status = 'ACTIVE' AND cc.characteristic_id IN (${marks(ids)})
      LIMIT 20000`,
    [Number(tenantId), ...ids]
  );
  return rows.map((row) => ({
    source_node_ref: nodeRef("characteristic", row.characteristic_id),
    target_node_ref: nodeRef(String(row.object_type).toLowerCase(), row.object_id),
    relationship_type: "characteristic.applies-to.operation",
    relationship_id: "",
    relationship_direction: "OUT",
    source_revision: "",
    target_revision: "",
    effectivity: {},
    configuration: {},
    lifecycle_context: "ACTIVE",
    confidence: null,
    metadata: { provider: PROVIDERS.REQUIREMENT_MANUFACTURING, derived_from: "cla_assignments" },
  }));
}

// A document is associated to an object through the Content association model.
function contentAssociationEdges(db, tenantId, refs) {
  const ids = numericIds(refs, "content");
  if (!ids.length) return [];
  const rows = queryAll(
    db,
    `SELECT content_id, object_type, object_id FROM content_associations
      WHERE tenant_id = ? AND status = 'active' AND content_id IN (${marks(ids)})
      LIMIT 20000`,
    [Number(tenantId), ...ids]
  );
  return rows.map((row) => ({
    source_node_ref: nodeRef("content", row.content_id),
    target_node_ref: nodeRef(String(row.object_type).toLowerCase(), row.object_id),
    relationship_type: "content.associated-with.object",
    relationship_id: "",
    relationship_direction: "OUT",
    source_revision: "",
    target_revision: "",
    effectivity: {},
    configuration: {},
    lifecycle_context: "active",
    confidence: null,
    metadata: { provider: PROVIDERS.REQUIREMENT_MANUFACTURING, derived_from: "content_associations" },
  }));
}

async function contentAssociationEdgesAsync(db, tenantId, refs) {
  const ids = numericIds(refs, "content");
  if (!ids.length) return [];
  const rows = await queryAllAsync(
    db,
    `SELECT content_id, object_type, object_id FROM content_associations
      WHERE tenant_id = ? AND status = 'active' AND content_id IN (${marks(ids)})
      LIMIT 20000`,
    [Number(tenantId), ...ids]
  );
  return rows.map((row) => ({
    source_node_ref: nodeRef("content", row.content_id),
    target_node_ref: nodeRef(String(row.object_type).toLowerCase(), row.object_id),
    relationship_type: "content.associated-with.object",
    relationship_id: "",
    relationship_direction: "OUT",
    source_revision: "",
    target_revision: "",
    effectivity: {},
    configuration: {},
    lifecycle_context: "active",
    confidence: null,
    metadata: { provider: PROVIDERS.REQUIREMENT_MANUFACTURING, derived_from: "content_associations" },
  }));
}

function requirementObjectIds(refs) {
  const ids = [];
  for (const ref of refs) {
    if (String(ref.objectType || "").toLowerCase() !== REQUIREMENT_SOURCE_TYPE) continue;
    if (ref.objectId) ids.push(String(ref.objectId));
  }
  return ids;
}

function resolveDelegated(db, tenantId, refs, context) {
  const delegated = refs.filter((ref) => {
    const type = String(ref.objectType || "").toLowerCase();
    return type === REQUIREMENT_SOURCE_TYPE || type === OPERATION_OBJECT_TYPE || type === WORK_CENTER_OBJECT_TYPE;
  });
  return delegated.length ? objectProvider.resolveMany(db, tenantId, delegated, context) : [];
}

export const requirementManufacturingProvider = {
  code: PROVIDERS.REQUIREMENT_MANUFACTURING,
  name: "Requirement/Manufacturing traceability",
  builtin: false,
  object_types: [...OWNED_TYPES],
  accepts(ref) {
    return isOwnedType(ref?.objectType);
  },
  resolveMany(db, tenantId, refs, context = {}) {
    return [
      ...resolveDelegated(db, tenantId, refs, context),
      ...resolveCharacteristics(db, tenantId, refs),
      ...resolveContents(db, tenantId, refs),
    ];
  },
  resolve(db, tenantId, ref, context = {}) {
    return this.resolveMany(db, tenantId, [ref], context)[0] || null;
  },
  async resolveManyAsync(db, tenantId, refs, context = {}) {
    const delegated = refs.filter((ref) => {
      const type = String(ref.objectType || "").toLowerCase();
      return type === REQUIREMENT_SOURCE_TYPE || type === OPERATION_OBJECT_TYPE || type === WORK_CENTER_OBJECT_TYPE;
    });
    return [
      ...(delegated.length ? await objectProvider.resolveManyAsync(db, tenantId, delegated, context) : []),
      ...(await resolveCharacteristicsAsync(db, tenantId, refs)),
      ...(await resolveContentsAsync(db, tenantId, refs)),
    ];
  },
  async resolveAsync(db, tenantId, ref, context = {}) {
    return (await this.resolveManyAsync(db, tenantId, [ref], context))[0] || null;
  },
  neighbors(db, tenantId, refs) {
    const objectIds = requirementObjectIds(refs);
    return [
      ...(objectIds.length ? forwardRequirementEdges(db, tenantId, objectIds) : []),
      ...reverseRequirementEdges(db, tenantId, refs),
      ...characteristicAssociationEdges(db, tenantId, refs),
      ...contentAssociationEdges(db, tenantId, refs),
    ];
  },
  async neighborsAsync(db, tenantId, refs) {
    const objectIds = requirementObjectIds(refs);
    return [
      ...(objectIds.length ? await forwardRequirementEdgesAsync(db, tenantId, objectIds) : []),
      ...(await reverseRequirementEdgesAsync(db, tenantId, refs)),
      ...(await characteristicAssociationEdgesAsync(db, tenantId, refs)),
      ...(await contentAssociationEdgesAsync(db, tenantId, refs)),
    ];
  },
};

// Registers the provider with the Digital Thread engine. Idempotent.
export function registerRequirementManufacturingProvider() {
  ensureProviders();
  registerProvider(requirementManufacturingProvider);
  return requirementManufacturingProvider.code;
}

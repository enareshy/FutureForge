// Digital Thread provider for Requirement -> PDM allocations.
//
// Allocation edges already live in the Requirements Manager
// (`requirement_relationships`). Rather than copying them into the generic
// object graph (a second model), this provider projects them into the Digital
// Thread so traversals can walk Requirement -> Item -> Item Revision ->
// CAD/Document -> BOM alongside every other domain using the engine's official
// provider seam.
import { queryAll } from "../../db.js";
import { queryAllAsync } from "../../db-async.js";
import { nodeRef, registerProvider } from "../thread/providers.js";
import { ensureProviders } from "../thread/traversal.js";
import { objectProvider } from "../thread/provider-object.js";
import { pdmProvider } from "../thread/provider-pdm.js";
import { bomProvider } from "../thread/provider-bom.js";
import { PROVIDERS } from "../thread/constants.js";
import { ALLOCATION_CODES, REQUIREMENT_SOURCE_TYPE, TARGET_NODE_TYPES, PLM_LINK_CODES } from "./constants.js";
import { isChangeType, resolveChangeNodes, resolveChangeNodesAsync, changeDomains } from "./change-nodes.js";

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const TARGET_TYPE_SET = new Set(TARGET_NODE_TYPES);
const LINK_CODES = Object.freeze([...ALLOCATION_CODES, ...PLM_LINK_CODES]);

function marks(count) {
  return count.map(() => "?").join(",");
}

function isTargetType(type) {
  const value = String(type || "").toLowerCase();
  return TARGET_TYPE_SET.has(value) || isChangeType(value);
}

function itemDomain(itemType) {
  switch (String(itemType || "").toUpperCase()) {
    case "PRODUCT":
      return "PRODUCT";
    case "PART":
    case "ASSEMBLY":
      return "PART";
    case "DOCUMENT":
      return "DESIGN";
    default:
      return "";
  }
}

function bomDomain(bomType) {
  switch (String(bomType || "").toUpperCase()) {
    case "MBOM":
      return "MBOM";
    case "BOP":
      return "BOP";
    default:
      return "EBOM";
  }
}

function targetDomainQueries(relationships) {
  const itemIds = new Set();
  const revisionIds = new Set();
  const datasetIds = new Set();
  const bomRevisionIds = new Set();
  for (const relationship of relationships) {
    const type = String(relationship.target_type || "").toLowerCase();
    const id = Number(relationship.target_id);
    if (!Number.isFinite(id)) continue;
    if (type === "pdm_item") itemIds.add(id);
    else if (type === "pdm_revision") revisionIds.add(id);
    else if (type === "pdm_dataset") datasetIds.add(id);
    else if (type === "bom_revision") bomRevisionIds.add(id);
  }
  return { itemIds: [...itemIds], revisionIds: [...revisionIds], datasetIds: [...datasetIds], bomRevisionIds: [...bomRevisionIds] };
}

function targetDomains(db, tenantId, relationships) {
  const domains = new Map();
  const { itemIds, revisionIds, datasetIds, bomRevisionIds } = targetDomainQueries(relationships);
  for (const id of datasetIds) domains.set(`pdm_dataset:${id}`, "DESIGN");
  if (itemIds.length) {
    for (const row of queryAll(db, `SELECT id, item_type FROM pdm_items WHERE tenant_id = ? AND id IN (${marks(itemIds)})`, [Number(tenantId), ...itemIds])) {
      domains.set(`pdm_item:${row.id}`, itemDomain(row.item_type));
    }
  }
  if (revisionIds.length) {
    const rows = queryAll(
      db,
      `SELECT r.id, i.item_type FROM pdm_item_revisions r JOIN pdm_items i ON i.id = r.item_id WHERE r.tenant_id = ? AND r.id IN (${marks(revisionIds)})`,
      [Number(tenantId), ...revisionIds]
    );
    for (const row of rows) domains.set(`pdm_revision:${row.id}`, itemDomain(row.item_type));
  }
  if (bomRevisionIds.length) {
    const rows = queryAll(
      db,
      `SELECT r.id, h.bom_type FROM bom_revisions r JOIN bom_headers h ON h.id = r.bom_id WHERE r.tenant_id = ? AND r.id IN (${marks(bomRevisionIds)})`,
      [Number(tenantId), ...bomRevisionIds]
    );
    for (const row of rows) domains.set(`bom_revision:${row.id}`, bomDomain(row.bom_type));
  }
  for (const [key, value] of changeDomains(db, tenantId, relationships)) domains.set(key, value);
  return domains;
}

async function targetDomainsAsync(db, tenantId, relationships) {
  const domains = new Map();
  const { itemIds, revisionIds, datasetIds, bomRevisionIds } = targetDomainQueries(relationships);
  for (const id of datasetIds) domains.set(`pdm_dataset:${id}`, "DESIGN");
  if (itemIds.length) {
    for (const row of await queryAllAsync(db, `SELECT id, item_type FROM pdm_items WHERE tenant_id = ? AND id IN (${marks(itemIds)})`, [Number(tenantId), ...itemIds])) {
      domains.set(`pdm_item:${row.id}`, itemDomain(row.item_type));
    }
  }
  if (revisionIds.length) {
    const rows = await queryAllAsync(
      db,
      `SELECT r.id, i.item_type FROM pdm_item_revisions r JOIN pdm_items i ON i.id = r.item_id WHERE r.tenant_id = ? AND r.id IN (${marks(revisionIds)})`,
      [Number(tenantId), ...revisionIds]
    );
    for (const row of rows) domains.set(`pdm_revision:${row.id}`, itemDomain(row.item_type));
  }
  if (bomRevisionIds.length) {
    const rows = await queryAllAsync(
      db,
      `SELECT r.id, h.bom_type FROM bom_revisions r JOIN bom_headers h ON h.id = r.bom_id WHERE r.tenant_id = ? AND r.id IN (${marks(bomRevisionIds)})`,
      [Number(tenantId), ...bomRevisionIds]
    );
    for (const row of rows) domains.set(`bom_revision:${row.id}`, bomDomain(row.bom_type));
  }
  for (const [key, value] of changeDomains(db, tenantId, relationships)) domains.set(key, value);
  return domains;
}

// `objectIds` are requirement OBJECT ids (the Digital Thread node identity).
// Allocation rows store the requirement ROW id in `source_id`, so the join back
// through `requirements.object_id` is required: matching `source_id` directly
// against object ids only works when the two id sequences happen to coincide.
function forwardRelationships(db, tenantId, objectIds) {
  if (!objectIds.length) return [];
  const typeMarks = LINK_CODES.map(() => "?").join(",");
  return queryAll(
    db,
    `SELECT rr.* FROM requirement_relationships rr
       JOIN requirements r ON r.tenant_id = rr.tenant_id AND r.id::text = rr.source_id
      WHERE rr.tenant_id = ? AND rr.status = 'ACTIVE' AND rr.source_type = ?
        AND rr.relationship_type IN (${typeMarks})
        AND r.object_id IN (${marks(objectIds)})
      LIMIT 20000`,
    [Number(tenantId), REQUIREMENT_SOURCE_TYPE, ...LINK_CODES, ...objectIds]
  );
}

async function forwardRelationshipsAsync(db, tenantId, objectIds) {
  if (!objectIds.length) return [];
  const typeMarks = LINK_CODES.map(() => "?").join(",");
  return queryAllAsync(
    db,
    `SELECT rr.* FROM requirement_relationships rr
       JOIN requirements r ON r.tenant_id = rr.tenant_id AND r.id::text = rr.source_id
      WHERE rr.tenant_id = ? AND rr.status = 'ACTIVE' AND rr.source_type = ?
        AND rr.relationship_type IN (${typeMarks})
        AND r.object_id IN (${marks(objectIds)})
      LIMIT 20000`,
    [Number(tenantId), REQUIREMENT_SOURCE_TYPE, ...LINK_CODES, ...objectIds]
  );
}

function reverseQueryParts(refs) {
  const byType = new Map();
  for (const ref of refs) {
    const type = String(ref.objectType || "").toLowerCase();
    if (!isTargetType(type)) continue;
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type).add(String(ref.objectId));
  }
  if (!byType.size) return null;
  const clauses = [];
  const params = [];
  for (const [type, ids] of byType) {
    const list = [...ids];
    clauses.push(`(target_type = ? AND target_id IN (${marks(list)}))`);
    params.push(type, ...list);
  }
  return { clause: clauses.join(" OR "), params };
}

function reverseRelationships(db, tenantId, refs) {
  const parts = reverseQueryParts(refs);
  if (!parts) return [];
  const typeMarks = LINK_CODES.map(() => "?").join(",");
  return queryAll(
    db,
    `SELECT * FROM requirement_relationships
       WHERE tenant_id = ? AND status = 'ACTIVE' AND relationship_type IN (${typeMarks})
         AND (${parts.clause})
       LIMIT 20000`,
    [Number(tenantId), ...LINK_CODES, ...parts.params]
  );
}

async function reverseRelationshipsAsync(db, tenantId, refs) {
  const parts = reverseQueryParts(refs);
  if (!parts) return [];
  const typeMarks = LINK_CODES.map(() => "?").join(",");
  return queryAllAsync(
    db,
    `SELECT * FROM requirement_relationships
       WHERE tenant_id = ? AND status = 'ACTIVE' AND relationship_type IN (${typeMarks})
         AND (${parts.clause})
       LIMIT 20000`,
    [Number(tenantId), ...LINK_CODES, ...parts.params]
  );
}

function requirementLookup(db, tenantId, requirementIds) {
  const lookup = new Map();
  if (!requirementIds.length) return lookup;
  const rows = queryAll(
    db,
    `SELECT id, object_id, requirement_ref, revision, status FROM requirements WHERE tenant_id = ? AND id IN (${marks(requirementIds)})`,
    [Number(tenantId), ...requirementIds]
  );
  for (const row of rows) lookup.set(String(row.id), row);
  return lookup;
}

async function requirementLookupAsync(db, tenantId, requirementIds) {
  const lookup = new Map();
  if (!requirementIds.length) return lookup;
  const rows = await queryAllAsync(
    db,
    `SELECT id, object_id, requirement_ref, revision, status FROM requirements WHERE tenant_id = ? AND id IN (${marks(requirementIds)})`,
    [Number(tenantId), ...requirementIds]
  );
  for (const row of rows) lookup.set(String(row.id), row);
  return lookup;
}

function edgeFromRelationship(relationship, requirement, targetDomain) {
  const attributes = parseJson(relationship.attributes_json, {});
  const effectivity = {};
  if (relationship.effectivity_from) effectivity.start = relationship.effectivity_from;
  if (relationship.effectivity_to) effectivity.end = relationship.effectivity_to;
  const configuration = {};
  if (attributes.configuration_context) configuration.context = attributes.configuration_context;
  if (attributes.variant) configuration.variant = attributes.variant;
  return {
    source_node_ref: nodeRef(REQUIREMENT_SOURCE_TYPE, requirement.object_id),
    target_node_ref: nodeRef(String(relationship.target_type).toLowerCase(), relationship.target_id),
    relationship_type: relationship.relationship_type,
    relationship_id: String(relationship.id),
    relationship_direction: "OUT",
    source_revision: requirement.revision != null ? String(requirement.revision) : "",
    target_revision: attributes.target_revision || "",
    effectivity,
    configuration,
    lifecycle_context: relationship.status || "",
    confidence: attributes.confidence === undefined ? null : Number(attributes.confidence),
    metadata: {
      provider: "requirement-pdm",
      definition_domain: "REQUIREMENT",
      target_domain: targetDomain || "",
      allocation_ref: relationship.relationship_ref,
      source_requirement_id: requirement.id,
    },
  };
}

function collectEdges(relationships, lookup, domains) {
  const edges = [];
  const seen = new Set();
  for (const relationship of relationships) {
    const requirement = lookup.get(String(relationship.source_id));
    if (!requirement || !requirement.object_id) continue;
    const key = `${relationship.id}|${requirement.object_id}|${relationship.target_type}:${relationship.target_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const domain = domains.get(`${String(relationship.target_type).toLowerCase()}:${relationship.target_id}`) || "";
    edges.push(edgeFromRelationship(relationship, requirement, domain));
  }
  return edges;
}

function requirementObjectIds(refs) {
  const ids = [];
  for (const ref of refs) {
    if (String(ref.objectType || "").toLowerCase() !== REQUIREMENT_SOURCE_TYPE) continue;
    const value = String(ref.objectId);
    if (value) ids.push(value);
  }
  return ids;
}

// Dataset (CAD/Document) nodes are not modelled by the built-in PDM provider,
// yet a requirement is commonly represented by one. Resolving them here keeps
// Requirement -> CAD/Document traceability inside the thread engine without
// modifying the PDM domain.
function datasetNode(row) {
  return {
    node_ref: nodeRef("pdm_dataset", row.id),
    object_type: "pdm_dataset",
    object_id: String(row.id),
    source_object_type: "pdm_dataset",
    source_object_id: String(row.id),
    source_object_revision_id: "",
    domain: "DESIGN",
    display_name: row.name || row.dataset_number,
    number: row.dataset_number,
    revision: "",
    lifecycle_state: row.status || "",
    organization_id: row.organization_id ?? null,
    site: "",
    node_type: "pdm_dataset",
    metadata: { dataset_type: row.dataset_type, revision_id: row.revision_id, object_id: row.object_id ?? null },
  };
}

function datasetRefs(refs) {
  const ids = [];
  for (const ref of refs) {
    if (String(ref.objectType || "").toLowerCase() !== "pdm_dataset") continue;
    if (/^\d+$/.test(String(ref.objectId))) ids.push(Number(ref.objectId));
  }
  return ids;
}

function resolveDatasetNodes(db, tenantId, refs) {
  const ids = datasetRefs(refs);
  if (!ids.length) return [];
  return queryAll(db, `SELECT * FROM pdm_datasets WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids]).map(datasetNode);
}

async function resolveDatasetNodesAsync(db, tenantId, refs) {
  const ids = datasetRefs(refs);
  if (!ids.length) return [];
  const rows = await queryAllAsync(db, `SELECT * FROM pdm_datasets WHERE tenant_id = ? AND id IN (${marks(ids)})`, [Number(tenantId), ...ids]);
  return rows.map(datasetNode);
}

function requirementIdsFromRelationships(relationships) {
  return [...new Set(relationships.map((relationship) => String(relationship.source_id)))];
}

function groupResolvableRefs(refs) {
  const groups = { object: [], pdm: [], bom: [], dataset: [], change: [] };
  for (const ref of refs) {
    const type = String(ref.objectType || "").toLowerCase();
    if (isChangeType(type)) groups.change.push(ref);
    else if (type === REQUIREMENT_SOURCE_TYPE) groups.object.push(ref);
    else if (type === "pdm_dataset") groups.dataset.push(ref);
    else if (type.startsWith("pdm_")) groups.pdm.push(ref);
    else if (type.startsWith("bom_")) groups.bom.push(ref);
  }
  return groups;
}

export const requirementPdmProvider = {
  code: PROVIDERS.REQUIREMENT_PDM,
  name: "Requirement/PDM allocations",
  builtin: false,
  object_types: [REQUIREMENT_SOURCE_TYPE],
  accepts(ref) {
    const type = String(ref?.objectType || "").toLowerCase();
    return type === REQUIREMENT_SOURCE_TYPE || isTargetType(type);
  },
  resolveMany(db, tenantId, refs, context = {}) {
    const groups = groupResolvableRefs(refs);
    return [
      ...(groups.object.length ? objectProvider.resolveMany(db, tenantId, groups.object, context) : []),
      ...(groups.pdm.length ? pdmProvider.resolveMany(db, tenantId, groups.pdm, context) : []),
      ...(groups.bom.length ? bomProvider.resolveMany(db, tenantId, groups.bom, context) : []),
      ...(groups.change.length ? resolveChangeNodes(db, tenantId, groups.change) : []),
      ...resolveDatasetNodes(db, tenantId, groups.dataset),
    ];
  },
  resolve(db, tenantId, ref, context = {}) {
    return this.resolveMany(db, tenantId, [ref], context)[0] || null;
  },
  async resolveManyAsync(db, tenantId, refs, context = {}) {
    const groups = groupResolvableRefs(refs);
    return [
      ...(groups.object.length ? await objectProvider.resolveManyAsync(db, tenantId, groups.object, context) : []),
      ...(groups.pdm.length ? await pdmProvider.resolveManyAsync(db, tenantId, groups.pdm, context) : []),
      ...(groups.bom.length ? await bomProvider.resolveManyAsync(db, tenantId, groups.bom, context) : []),
      ...(groups.change.length ? await resolveChangeNodesAsync(db, tenantId, groups.change) : []),
      ...(await resolveDatasetNodesAsync(db, tenantId, groups.dataset)),
    ];
  },
  async resolveAsync(db, tenantId, ref, context = {}) {
    return (await this.resolveManyAsync(db, tenantId, [ref], context))[0] || null;
  },
  neighbors(db, tenantId, refs, context = {}) {
    const objectIds = requirementObjectIds(refs);
    const relationships = [
      ...(objectIds.length ? forwardRelationships(db, tenantId, objectIds) : []),
      ...reverseRelationships(db, tenantId, refs),
    ];
    if (!relationships.length) return [];
    const domains = targetDomains(db, tenantId, relationships);
    const lookup = requirementLookup(db, tenantId, requirementIdsFromRelationships(relationships));
    return collectEdges(relationships, lookup, domains);
  },
  async neighborsAsync(db, tenantId, refs, context = {}) {
    const objectIds = requirementObjectIds(refs);
    const relationships = [
      ...(objectIds.length ? await forwardRelationshipsAsync(db, tenantId, objectIds) : []),
      ...(await reverseRelationshipsAsync(db, tenantId, refs)),
    ];
    if (!relationships.length) return [];
    const domains = await targetDomainsAsync(db, tenantId, relationships);
    const lookup = await requirementLookupAsync(db, tenantId, requirementIdsFromRelationships(relationships));
    return collectEdges(relationships, lookup, domains);
  },
};

// Registers the provider with the Digital Thread engine. Idempotent.
export function registerRequirementPdmProvider() {
  ensureProviders();
  registerProvider(requirementPdmProvider);
  return requirementPdmProvider.code;
}

// Object & Relationship provider for digital thread traversal.
//
// This is the default provider: every metadata object type (requirement,
// system, design, part, product, ebom, mbom, bop, manufacturing-order,
// quality-issue, service-item, ...) is a node and every object relationship is
// an edge. Cross-domain traceability therefore comes for free from the shared
// Object & Relationship Framework.
import { queryAll } from "../../db.js";
import { adjacency } from "../objects.js";
import { nodeRef } from "./providers.js";
import { nodeRefKey } from "./validation.js";
import { domainForType } from "./domains.js";
import { PROVIDERS } from "./constants.js";

const NON_OBJECT_PREFIXES = ["pdm_", "bom_"];

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function isObjectType(type) {
  const code = String(type || "").toLowerCase();
  return !NON_OBJECT_PREFIXES.some((prefix) => code.startsWith(prefix));
}

export function objectNodeFromRow(row, definition = null) {
  return {
    node_ref: nodeRef(row.type_code, row.id),
    object_type: row.type_code,
    object_id: String(row.id),
    source_object_type: row.type_code,
    source_object_id: String(row.id),
    source_object_revision_id: "",
    domain: domainForType(row.type_code, definition),
    display_name: row.name || row.code,
    number: row.code,
    revision: row.revision != null ? String(row.revision) : "",
    lifecycle_state: row.status || "",
    organization_id: row.organization_id ?? null,
    site: parseJson(row.data_json, {}).site || "",
    node_type: row.type_code,
    metadata: {
      uuid: row.uuid,
      module: row.type_module || "",
      owner_id: row.owner_id ?? null,
      deleted: Boolean(row.deleted_at),
    },
  };
}

const OBJECT_SELECT = `
  SELECT o.id, o.uuid, o.code, o.name, o.status, o.revision, o.organization_id,
         o.data_json, o.owner_id, o.deleted_at, t.code AS type_code, t.name AS type_name,
         t.module AS type_module
  FROM objects o
  JOIN metadata_types t ON t.id = o.object_type_id
`;

export function resolveObjectRows(db, tenantId, refs) {
  const numeric = new Map();
  const codes = [];
  for (const ref of refs) {
    const key = nodeRefKey(ref);
    if (/^\d+$/.test(String(ref.objectId))) numeric.set(Number(ref.objectId), key);
    else codes.push({ key, code: String(ref.objectId) });
  }
  const rows = [];
  if (numeric.size) {
    const ids = [...numeric.keys()];
    const marks = ids.map(() => "?").join(",");
    rows.push(...queryAll(db, `${OBJECT_SELECT} WHERE o.tenant_id = ? AND o.id IN (${marks})`, [Number(tenantId), ...ids]));
  }
  for (const entry of codes) {
    const row = queryAll(db, `${OBJECT_SELECT} WHERE o.tenant_id = ? AND o.code = ? LIMIT 1`, [Number(tenantId), entry.code])[0];
    if (row) rows.push(row);
  }
  return rows;
}

function edgeFromRelationship(rel, definition = null) {
  const sourceType = rel.source?.type?.code || "";
  const targetType = rel.target?.type?.code || "";
  if (!sourceType || !targetType) return null;
  const from = nodeRef(sourceType, rel.source.id);
  const to = nodeRef(targetType, rel.target.id);
  const attributes = rel.attributes || {};
  const effectivity = {};
  if (rel.valid_from) effectivity.start = rel.valid_from;
  if (rel.valid_to) effectivity.end = rel.valid_to;
  if (attributes.effectivity) Object.assign(effectivity, typeof attributes.effectivity === "string" ? parseJson(attributes.effectivity, {}) : attributes.effectivity);
  const configuration = {};
  if (attributes.configuration) Object.assign(configuration, attributes.configuration);
  if (attributes.variant) configuration.variant = attributes.variant;
  return {
    source_node_ref: from,
    target_node_ref: to,
    relationship_type: rel.relationship_type?.code || "",
    relationship_id: String(rel.id),
    relationship_direction: "OUT",
    source_revision: rel.source?.revision != null ? String(rel.source.revision) : "",
    target_revision: rel.target?.revision != null ? String(rel.target.revision) : "",
    effectivity,
    configuration,
    lifecycle_context: rel.source?.status || "",
    confidence: attributes.confidence === undefined ? null : Number(attributes.confidence),
    metadata: {
      semantic: rel.relationship_type?.semantic || "",
      inverse_code: rel.relationship_type?.inverse_code || "",
      definition_domain: domainForType(sourceType, definition),
      target_domain: domainForType(targetType, definition),
    },
  };
}

export const objectProvider = {
  code: PROVIDERS.OBJECT,
  name: "Object & Relationship",
  builtin: true,
  object_types: [],
  accepts(ref) {
    return isObjectType(ref?.objectType);
  },
  resolveMany(db, tenantId, refs, context = {}) {
    const rows = resolveObjectRows(db, tenantId, refs);
    const includeInactive = context.includeInactive ?? true;
    return rows
      .filter((row) => !row.deleted_at)
      .filter((row) => includeInactive || ["active", "released"].includes(String(row.status).toLowerCase()))
      .map((row) => objectNodeFromRow(row, context.definition || null));
  },
  resolve(db, tenantId, ref, context = {}) {
    return this.resolveMany(db, tenantId, [ref], context)[0] || null;
  },
  neighbors(db, tenantId, refs, context = {}) {
    const ids = [];
    for (const ref of refs) {
      if (isObjectType(ref.objectType) && /^\d+$/.test(String(ref.objectId))) ids.push(Number(ref.objectId));
    }
    if (!ids.length) return [];
    const direction = (context.direction || "BOTH") === "UPSTREAM" ? "in" : context.direction === "DOWNSTREAM" ? "out" : "both";
    const relationships = adjacency(db, ids, { tenantId, direction, status: "active", limit: context.edgeLimit || 20000 });
    return relationships.map((rel) => edgeFromRelationship(rel, context.definition || null)).filter(Boolean);
  },
};

export { edgeFromRelationship };

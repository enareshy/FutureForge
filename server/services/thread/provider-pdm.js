// PDM provider for digital thread traversal.
//
// PDM items and item revisions are first-class thread nodes, and PDM typed
// relationships are edges. Item type (PART/PRODUCT/...) is mapped into the
// thread domain catalog so a PDM part lands in the same PART stage as a plain
// object.
import { queryAll } from "../../db.js";
import { adjacency } from "../pdm/relationships.js";
import { nodeRef } from "./providers.js";
import { domainForType } from "./domains.js";
import { PROVIDERS } from "./constants.js";

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const ITEM_TYPE_DOMAIN = { PART: "part", PRODUCT: "product", ASSEMBLY: "part", DOCUMENT: "", OTHER: "" };

function domainForItemType(itemType, definition = null) {
  const type = ITEM_TYPE_DOMAIN[String(itemType || "").toUpperCase()];
  if (!type) return "";
  return domainForType(type, definition) || domainForType(String(itemType || "").toLowerCase(), definition);
}

function itemNode(row, definition = null) {
  return {
    node_ref: nodeRef("pdm_item", row.id),
    object_type: "pdm_item",
    object_id: String(row.id),
    source_object_type: "pdm_item",
    source_object_id: String(row.id),
    source_object_revision_id: "",
    domain: domainForItemType(row.item_type, definition),
    display_name: row.name || row.item_number,
    number: row.item_number,
    revision: "",
    lifecycle_state: row.status || "",
    organization_id: row.organization_id ?? null,
    site: "",
    node_type: "pdm_item",
    metadata: { item_type: row.item_type, classification_code: row.classification_code, object_id: row.object_id ?? null },
  };
}

function revisionNode(row, item, definition = null) {
  return {
    node_ref: nodeRef("pdm_revision", row.id),
    object_type: "pdm_revision",
    object_id: String(row.id),
    source_object_type: "pdm_revision",
    source_object_id: String(row.id),
    source_object_revision_id: "",
    domain: domainForItemType(item?.item_type, definition),
    display_name: `${item?.item_number || row.item_id} rev ${row.revision_number}`,
    number: item?.item_number || String(row.item_id),
    revision: row.revision_number,
    lifecycle_state: row.status || "",
    organization_id: row.organization_id ?? null,
    site: "",
    node_type: "pdm_revision",
    metadata: {
      item_id: row.item_id,
      variant_code: row.variant_code || "",
      configuration_context: row.configuration_context || "",
      effectivity: parseJson(row.effectivity_json, {}),
    },
  };
}

const PDM_TO_THREAD = { ITEM: "pdm_item", REVISION: "pdm_revision" };

function objectTypeFor(db, tenantId, type, id) {
  const code = String(type || "").toUpperCase();
  if (PDM_TO_THREAD[code]) return PDM_TO_THREAD[code];
  if (code === "OBJECT") {
    const row = queryAll(
      db,
      "SELECT t.code AS type_code FROM objects o JOIN metadata_types t ON t.id = o.object_type_id WHERE o.id = ? AND o.tenant_id = ? LIMIT 1",
      [Number(id), Number(tenantId)]
    )[0];
    return row?.type_code || null;
  }
  return null;
}

export const pdmProvider = {
  code: PROVIDERS.PDM,
  name: "PDM",
  builtin: true,
  object_types: ["pdm_item", "pdm_revision"],
  accepts(ref) {
    return String(ref?.objectType || "").toLowerCase().startsWith("pdm_");
  },
  resolveMany(db, tenantId, refs, context = {}) {
    const includeInactive = context.includeInactive ?? true;
    const itemIds = [];
    const revisionIds = [];
    const itemNumbers = [];
    for (const ref of refs) {
      const type = String(ref.objectType || "").toLowerCase();
      if (type === "pdm_item") {
        if (/^\d+$/.test(String(ref.objectId))) itemIds.push(Number(ref.objectId));
        else itemNumbers.push(String(ref.objectId));
      } else if (type === "pdm_revision") {
        if (/^\d+$/.test(String(ref.objectId))) revisionIds.push(Number(ref.objectId));
      }
    }
    const nodes = [];
    if (itemIds.length) {
      const marks = itemIds.map(() => "?").join(",");
      const rows = queryAll(db, `SELECT * FROM pdm_items WHERE tenant_id = ? AND id IN (${marks})`, [Number(tenantId), ...itemIds]);
      for (const row of rows) {
        if (!includeInactive && String(row.status).toUpperCase() === "OBSOLETE") continue;
        nodes.push(itemNode(row, context.definition));
      }
    }
    for (const number of itemNumbers) {
      const row = queryAll(db, "SELECT * FROM pdm_items WHERE tenant_id = ? AND item_number = ? LIMIT 1", [Number(tenantId), number])[0];
      if (row && (includeInactive || String(row.status).toUpperCase() !== "OBSOLETE")) nodes.push(itemNode(row, context.definition));
    }
    if (revisionIds.length) {
      const marks = revisionIds.map(() => "?").join(",");
      const rows = queryAll(db, `SELECT * FROM pdm_item_revisions WHERE tenant_id = ? AND id IN (${marks})`, [Number(tenantId), ...revisionIds]);
      for (const row of rows) {
        if (!includeInactive && String(row.status).toUpperCase() === "OBSOLETE") continue;
        const item = queryAll(db, "SELECT item_number, item_type FROM pdm_items WHERE id = ?", [row.item_id])[0];
        nodes.push(revisionNode(row, item, context.definition));
      }
    }
    return nodes;
  },
  resolve(db, tenantId, ref, context = {}) {
    return this.resolveMany(db, tenantId, [ref], context)[0] || null;
  },
  neighbors(db, tenantId, refs, context = {}) {
    const nodes = refs
      .filter((ref) => String(ref.objectType || "").toLowerCase().startsWith("pdm_"))
      .map((ref) => ({ type: String(ref.objectType).toLowerCase() === "pdm_item" ? "ITEM" : "REVISION", id: String(ref.objectId) }));
    if (!nodes.length) return [];
    const direction = (context.direction || "BOTH") === "UPSTREAM" ? "in" : context.direction === "DOWNSTREAM" ? "out" : "both";
    const relationships = adjacency(db, nodes, { tenantId, direction, status: "ACTIVE", limit: context.edgeLimit || 20000 });
    const output = [];
    for (const rel of relationships) {
      const sourceType = objectTypeFor(db, tenantId, rel.source_type, rel.source_id);
      const targetType = objectTypeFor(db, tenantId, rel.target_type, rel.target_id);
      if (!sourceType || !targetType) continue;
      const attributes = rel.attributes || {};
      const effectivity = {};
      if (rel.valid_from) effectivity.start = rel.valid_from;
      if (rel.valid_to) effectivity.end = rel.valid_to;
      output.push({
        source_node_ref: nodeRef(sourceType, rel.source_id),
        target_node_ref: nodeRef(targetType, rel.target_id),
        relationship_type: rel.relationship_type,
        relationship_id: String(rel.id),
        relationship_direction: "OUT",
        source_revision: "",
        target_revision: "",
        effectivity,
        configuration: attributes.configuration || {},
        lifecycle_context: rel.status || "",
        confidence: attributes.confidence === undefined ? null : Number(attributes.confidence),
        metadata: { provider: "pdm", cardinality: rel.cardinality },
      });
    }
    return output;
  },
};

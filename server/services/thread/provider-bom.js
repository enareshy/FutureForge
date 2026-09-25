// BOM provider for digital thread traversal.
//
// BOM headers, revisions and lines connect the engineering/manufacturing BOM
// stages to the parts they consume. Edges are normalized source -> target so
// the engine's direction filter works unchanged: a BOM revision contains its
// child parts, and the owning EBOM/MBOM object owns its revision.
import { queryAll } from "../../db.js";
import { nodeRef } from "./providers.js";
import { domainForType } from "./domains.js";
import { PROVIDERS, DOMAIN_CODES } from "./constants.js";

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const BOM_TYPE_DOMAIN = { EBOM: "EBOM", MBOM: "MBOM", BOP: "BOP", OTHER: "" };

function headerDomain(bomType, definition = null) {
  const code = BOM_TYPE_DOMAIN[String(bomType || "").toUpperCase()];
  if (code && DOMAIN_CODES.includes(code)) return code;
  return domainForType(String(bomType || "").toLowerCase(), definition);
}

function revisionNode(row, header, definition = null) {
  return {
    node_ref: nodeRef("bom_revision", row.id),
    object_type: "bom_revision",
    object_id: String(row.id),
    source_object_type: "bom_revision",
    source_object_id: String(row.id),
    source_object_revision_id: "",
    domain: headerDomain(header?.bom_type, definition),
    display_name: `${header?.bom_number || row.bom_id} rev ${row.revision_number}`,
    number: header?.bom_number || String(row.bom_id),
    revision: row.revision_number,
    lifecycle_state: row.status || "",
    organization_id: row.organization_id ?? null,
    site: "",
    node_type: "bom_revision",
    metadata: { bom_id: row.bom_id, bom_type: header?.bom_type || "", variant_code: row.variant_code || "", effectivity: parseJson(row.effectivity_json, {}) },
  };
}

function headerNode(row, definition = null) {
  return {
    node_ref: nodeRef("bom_header", row.id),
    object_type: "bom_header",
    object_id: String(row.id),
    source_object_type: "bom_header",
    source_object_id: String(row.id),
    source_object_revision_id: "",
    domain: headerDomain(row.bom_type, definition),
    display_name: row.name || row.bom_number,
    number: row.bom_number,
    revision: "",
    lifecycle_state: row.status || "",
    organization_id: row.organization_id ?? null,
    site: "",
    node_type: "bom_header",
    metadata: { bom_type: row.bom_type, owner_object_id: row.owner_object_id ?? null },
  };
}

function lineEdge(line, fromType, fromId, toType, toId, relationshipType) {
  return {
    source_node_ref: nodeRef(fromType, fromId),
    target_node_ref: nodeRef(toType, toId),
    relationship_type: relationshipType,
    relationship_id: String(line.id),
    relationship_direction: "OUT",
    source_revision: "",
    target_revision: line.child_revision || "",
    effectivity: parseJson(line.effectivity_json, {}),
    configuration: { context: line.configuration_context || "", variant: line.variant_code || "" },
    lifecycle_context: line.line_status || "",
    confidence: null,
    metadata: { provider: "bom", quantity: line.quantity, uom: line.uom, usage: line.usage },
  };
}

const BRIDGE_TYPES = ["part", "product", "ebom", "mbom", "bop", "item", "pdm_item", "manufacturing-order", "assembly"];

export const bomProvider = {
  code: PROVIDERS.BOM,
  name: "BOM",
  builtin: true,
  object_types: ["bom_header", "bom_revision"],
  accepts(ref) {
    const type = String(ref?.objectType || "").toLowerCase();
    return type === "bom_header" || type === "bom_revision" || BRIDGE_TYPES.includes(type);
  },
  resolveMany(db, tenantId, refs, context = {}) {
    const includeInactive = context.includeInactive ?? true;
    const revisionIds = [];
    const headerIds = [];
    const headerNumbers = [];
    for (const ref of refs) {
      const type = String(ref.objectType || "").toLowerCase();
      if (type === "bom_revision" && /^\d+$/.test(String(ref.objectId))) revisionIds.push(Number(ref.objectId));
      else if (type === "bom_header") {
        if (/^\d+$/.test(String(ref.objectId))) headerIds.push(Number(ref.objectId));
        else headerNumbers.push(String(ref.objectId));
      }
    }
    const nodes = [];
    if (headerIds.length) {
      const marks = headerIds.map(() => "?").join(",");
      const rows = queryAll(db, `SELECT * FROM bom_headers WHERE tenant_id = ? AND id IN (${marks})`, [Number(tenantId), ...headerIds]);
      for (const row of rows) {
        if (!includeInactive && String(row.status).toUpperCase() === "OBSOLETE") continue;
        nodes.push(headerNode(row, context.definition));
      }
    }
    for (const number of headerNumbers) {
      const row = queryAll(db, "SELECT * FROM bom_headers WHERE tenant_id = ? AND bom_number = ? LIMIT 1", [Number(tenantId), number])[0];
      if (row && (includeInactive || String(row.status).toUpperCase() !== "OBSOLETE")) nodes.push(headerNode(row, context.definition));
    }
    if (revisionIds.length) {
      const marks = revisionIds.map(() => "?").join(",");
      const rows = queryAll(
        db,
        `SELECT r.*, h.bom_number, h.bom_type FROM bom_revisions r JOIN bom_headers h ON h.id = r.bom_id WHERE r.tenant_id = ? AND r.id IN (${marks})`,
        [Number(tenantId), ...revisionIds]
      );
      for (const row of rows) {
        if (!includeInactive && String(row.status).toUpperCase() === "OBSOLETE") continue;
        nodes.push(revisionNode(row, row, context.definition));
      }
    }
    return nodes;
  },
  resolve(db, tenantId, ref, context = {}) {
    return this.resolveMany(db, tenantId, [ref], context)[0] || null;
  },
  neighbors(db, tenantId, refs, context = {}) {
    const output = [];
    const revisionIds = [];
    const headerIds = [];
    const bridge = new Map();
    for (const ref of refs) {
      const type = String(ref.objectType || "").toLowerCase();
      if (type === "bom_revision" && /^\d+$/.test(String(ref.objectId))) revisionIds.push(Number(ref.objectId));
      else if (type === "bom_header" && /^\d+$/.test(String(ref.objectId))) headerIds.push(Number(ref.objectId));
      else if (BRIDGE_TYPES.includes(type)) bridge.set(`${type}:${ref.objectId}`, ref);
    }

    if (headerIds.length) {
      const marks = headerIds.map(() => "?").join(",");
      const rows = queryAll(db, `SELECT id, bom_id, revision_number, status, lifecycle_state FROM bom_revisions WHERE tenant_id = ? AND bom_id IN (${marks})`, [Number(tenantId), ...headerIds]);
      for (const row of rows) {
        output.push({
          source_node_ref: nodeRef("bom_header", row.bom_id),
          target_node_ref: nodeRef("bom_revision", row.id),
          relationship_type: "bom.revision-of",
          relationship_id: String(row.id),
          relationship_direction: "OUT",
          source_revision: "",
          target_revision: row.revision_number || "",
          effectivity: {},
          configuration: {},
          lifecycle_context: row.status || "",
          confidence: null,
          metadata: { provider: "bom" },
        });
      }
    }

    if (revisionIds.length) {
      const marks = revisionIds.map(() => "?").join(",");
      const rows = queryAll(db, `SELECT * FROM bom_lines WHERE tenant_id = ? AND bom_revision_id IN (${marks})`, [Number(tenantId), ...revisionIds]);
      for (const line of rows) {
        if (!line.child_object_id) continue;
        output.push(lineEdge(line, "bom_revision", line.bom_revision_id, String(line.child_object_type || "part").toLowerCase(), line.child_object_id, "bom.contains"));
        if (line.parent_object_id && String(line.parent_object_id) !== String(line.child_object_id)) {
          output.push(
            lineEdge(line, String(line.parent_object_type || "part").toLowerCase(), line.parent_object_id, String(line.child_object_type || "part").toLowerCase(), line.child_object_id, "bom.contains")
          );
        }
      }
      const revisions = queryAll(db, `SELECT id, bom_id, revision_number FROM bom_revisions WHERE tenant_id = ? AND id IN (${marks})`, [Number(tenantId), ...revisionIds]);
      const bomIds = [...new Set(revisions.map((row) => row.bom_id))];
      if (bomIds.length) {
        const bomMarks = bomIds.map(() => "?").join(",");
        const headers = queryAll(db, `SELECT id, owner_object_id, bom_number, bom_type FROM bom_headers WHERE tenant_id = ? AND id IN (${bomMarks})`, [Number(tenantId), ...bomIds]);
        const headerById = new Map(headers.map((row) => [row.id, row]));
        const ownerIds = [...new Set(headers.map((row) => row.owner_object_id).filter(Boolean))];
        const ownerTypeById = new Map();
        if (ownerIds.length) {
          const ownerMarks = ownerIds.map(() => "?").join(",");
          for (const row of queryAll(
            db,
            `SELECT o.id, t.code AS type_code FROM objects o JOIN metadata_types t ON t.id = o.object_type_id WHERE o.tenant_id = ? AND o.id IN (${ownerMarks})`,
            [Number(tenantId), ...ownerIds]
          )) {
            ownerTypeById.set(row.id, row.type_code);
          }
        }
        for (const revision of revisions) {
          const header = headerById.get(revision.bom_id);
          if (!header?.owner_object_id) continue;
          const ownerType = ownerTypeById.get(header.owner_object_id) || "ebom";
          output.push({
            source_node_ref: nodeRef(ownerType, header.owner_object_id),
            target_node_ref: nodeRef("bom_revision", revision.id),
            relationship_type: "bom.owner",
            relationship_id: String(revision.id),
            relationship_direction: "OUT",
            source_revision: "",
            target_revision: revision.revision_number || "",
            effectivity: {},
            configuration: {},
            lifecycle_context: header.bom_type || "",
            confidence: null,
            metadata: { provider: "bom", bom_number: header.bom_number },
          });
        }
      }
    }

    if (bridge.size) {
      const childIds = [...bridge.values()].filter((ref) => !String(ref.objectType).toLowerCase().startsWith("bom_")).map((ref) => String(ref.objectId));
      if (childIds.length) {
        const marks = childIds.map(() => "?").join(",");
        const rows = queryAll(
          db,
          `SELECT * FROM bom_lines WHERE tenant_id = ? AND (child_object_id IN (${marks}) OR parent_object_id IN (${marks}))`,
          [Number(tenantId), ...childIds, ...childIds]
        );
        for (const line of rows) {
          if (line.child_object_id && childIds.includes(String(line.child_object_id))) {
            output.push(lineEdge(line, "bom_revision", line.bom_revision_id, String(line.child_object_type || "part").toLowerCase(), line.child_object_id, "bom.contains"));
          }
          if (line.parent_object_id && childIds.includes(String(line.parent_object_id)) && line.child_object_id) {
            output.push(
              lineEdge(line, String(line.parent_object_type || "part").toLowerCase(), line.parent_object_id, String(line.child_object_type || "part").toLowerCase(), line.child_object_id, "bom.contains")
            );
          }
        }
      }
    }
    return output;
  },
};

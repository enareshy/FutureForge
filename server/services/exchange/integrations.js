// Enterprise integrations used by the exchange processor.
//
// The processor is deliberately generic: an Exchange Definition declares an
// `integration` (object / bom / pdm) and this registry performs the actual
// create/update by delegating to the owning platform service. Standards &
// Exchange never re-implements Object, BOM or PDM semantics.
import * as objects from "../objects.js";
import { Bom } from "../bom/index.js";
import { Pdm } from "../pdm/index.js";
import { OBJECT_STATUSES } from "../objects.js";
import { bomToCanonical } from "./adapters/bom.js";

const registry = new Map();

export function registerIntegration(code, integration) {
  if (!code || !integration) throw new Error("An integration code and implementation are required");
  registry.set(code, { code, ...integration });
  return code;
}

export function getIntegration(code) {
  return registry.get(code) || registry.get("object") || null;
}

export function listIntegrations() {
  return [...registry.values()].map((entry) => ({ code: entry.code, name: entry.name, description: entry.description }));
}

function normalizeStatus(value) {
  const candidate = String(value || "draft").trim().toLowerCase();
  return OBJECT_STATUSES.includes(candidate) ? candidate : "draft";
}

function recordCode(record) {
  return (
    record.code ||
    record.external_id ||
    (Array.isArray(record.identifiers) ? record.identifiers.map((entry) => entry.value).filter(Boolean)[0] : "") ||
    (record.attributes && (record.attributes.number || record.attributes["part.number"] || record.attributes.code)) ||
    record.name ||
    ""
  );
}

function recordData(record) {
  const data = record.attributes || record.data || record.values || {};
  return data && typeof data === "object" ? data : {};
}

// Shapes an enterprise row into a canonical exchange object for export.
export function enterpriseToCanonical(item, typeCode = "") {
  const code = item.code || item.external_id || (item.id != null ? String(item.id) : "");
  return {
    external_id: code,
    object_type: item.type || item.object_type || typeCode || "part",
    subtype: item.subtype || "",
    name: item.name || "",
    description: item.description || "",
    revision: item.revision || "",
    lifecycle_state: item.lifecycle_state || "",
    status: item.status || "",
    unit_system: item.unit_system || "",
    quantity: item.quantity === undefined ? null : item.quantity,
    uom: item.uom || "",
    attributes: item.data && typeof item.data === "object" ? { ...item.data } : recordData(item),
    identifiers: code ? [{ scheme: "enterprise", value: code }] : [],
    classification: item.classification ? [{ code: String(item.classification) }] : [],
    metadata: item.metadata && typeof item.metadata === "object" ? { ...item.metadata } : {},
  };
}

function findExistingObject(db, tenantId, typeCode, code) {
  if (!code) return null;
  try {
    const result = objects.listObjects(db, { q: String(code), pageSize: 25 }, tenantId);
    return (
      (result.items || []).find((item) => String(item.code || "").toLowerCase() === String(code).toLowerCase()) ||
      (result.items || []).find((item) => String(item.name || "").toLowerCase() === String(code).toLowerCase()) ||
      null
    );
  } catch {
    return null;
  }
}

const objectIntegration = {
  code: "object",
  name: "Enterprise object",
  description: "Create or update enterprise objects and relationships through the Object & Relationship Framework.",
  preview(record, ctx) {
    const typeCode = record.object_type || ctx.definition?.target_object_type || ctx.definition?.source_object_type || "part";
    const code = recordCode(record);
    const existing = findExistingObject(ctx.db, ctx.tenantId, typeCode, code);
    return {
      action: existing ? "UPDATE" : "CREATE",
      object_type: typeCode,
      code,
      target_object: existing ? existing.id : null,
      message: existing ? `Update existing ${typeCode} ${code}` : `Create ${typeCode} ${code}`,
    };
  },
  apply(record, ctx) {
    const typeCode = record.object_type || ctx.definition?.target_object_type || ctx.definition?.source_object_type || "part";
    const code = recordCode(record);
    const strategy = String(ctx.options?.duplicate_strategy || ctx.duplicateStrategy || "REJECT").toUpperCase();
    const existing = findExistingObject(ctx.db, ctx.tenantId, typeCode, code);
    const body = {
      type: typeCode,
      code: code || undefined,
      name: record.name || code,
      description: record.description || "",
      status: normalizeStatus(record.status || record.lifecycle_state),
      data: recordData(record),
    };
    if (existing) {
      if (strategy === "SKIP" || strategy === "REJECT") {
        const skipped = { action: "SKIPPED", object_type: typeCode, object_id: existing.id, code, message: `Existing ${typeCode} ${code} skipped (${strategy})` };
        if (strategy === "REJECT") skipped.reject = true;
        ctx.resolved.set(code, existing.id);
        if (record.external_id) ctx.resolved.set(record.external_id, existing.id);
        return skipped;
      }
      const updated = objects.updateObject(ctx.db, existing.id, { name: body.name, description: body.description, data: body.data }, ctx.actor, ctx.tenantId, ctx.ip);
      ctx.resolved.set(code, updated.id);
      if (record.external_id) ctx.resolved.set(record.external_id, updated.id);
      return { action: "UPDATED", object_type: typeCode, object_id: updated.id, code, object: updated, message: `Updated ${typeCode} ${code}` };
    }
    const created = objects.createObject(ctx.db, body, ctx.actor, ctx.tenantId, ctx.ip);
    ctx.resolved.set(code, created.id);
    if (record.external_id) ctx.resolved.set(record.external_id, created.id);
    return { action: "CREATED", object_type: typeCode, object_id: created.id, code, object: created, message: `Created ${typeCode} ${code}` };
  },
  fetch(params = {}, ctx) {
    const typeCode = params.objectType || ctx.definition?.source_object_type || ctx.definition?.target_object_type || "";
    const limit = Math.min(100000, Math.max(1, Number(params.limit) || 500));
    if (Array.isArray(params.objectIds) && params.objectIds.length) {
      const records = [];
      for (const id of params.objectIds) {
        let found = null;
        try {
          found = objects.getObject(ctx.db, id, ctx.tenantId);
        } catch {
          found = null;
        }
        if (found) records.push(enterpriseToCanonical(found, typeCode));
      }
      return records;
    }
    const list = objects.listObjects(ctx.db, { q: params.q, pageSize: limit, ...(params.query || {}) }, ctx.tenantId);
    let items = list.items || [];
    if (typeCode) items = items.filter((item) => !item.type || String(item.type).toLowerCase() === String(typeCode).toLowerCase());
    return items.slice(0, limit).map((item) => enterpriseToCanonical(item, typeCode));
  },
};

const bomIntegration = {
  code: "bom",
  name: "BOM engine",
  description: "Create BOM headers, revisions and lines through the BOM Engine; child parts resolve to enterprise objects.",
  preview(record, ctx) {
    const bom = record.bom || {};
    const lines = Array.isArray(bom.lines) ? bom.lines : [];
    return {
      action: "CREATE",
      object_type: record.object_type || "bom",
      code: bom.bom_number || recordCode(record),
      message: `BOM ${bom.bom_number || recordCode(record)} with ${lines.length} line(s)`,
      lines: lines.length,
    };
  },
  apply(record, ctx) {
    const bom = record.bom || {};
    const bomNumber = bom.bom_number || recordCode(record) || record.external_id;
    const lines = Array.isArray(bom.lines) ? bom.lines : [];
    let header;
    try {
      header = Bom.getBom(ctx.db, ctx.tenantId, bomNumber);
    } catch {
      header = Bom.createBom(ctx.db, ctx.tenantId, { bom_number: bomNumber, name: bom.name || record.name || bomNumber, bom_type: bom.bom_type || "EBOM" }, ctx.actor, ctx.ip);
    }
    const revisionNumber = bom.revision_number || "A";
    let revision;
    try {
      revision = Bom.getRevision(ctx.db, ctx.tenantId, `${bomNumber}:${revisionNumber}`);
    } catch {
      revision = Bom.createRevision(ctx.db, ctx.tenantId, header.bom_ref || header.id, { revision_number: revisionNumber, status: "DRAFT" }, ctx.actor, ctx.ip);
    }
    let created = 0;
    const failures = [];
    for (const line of lines) {
      const childId = ctx.resolved.get(line.child_ref || line.child_external_id || line.child_object_id);
      if (!childId) {
        failures.push({ line, message: `Unresolved child reference ${line.child_ref || line.child_external_id}` });
        continue;
      }
      try {
        Bom.addLine(
          ctx.db,
          ctx.tenantId,
          revision.id || revision.revision_ref,
          {
            child_object_id: childId,
            parent_object_id: header.owner_object_id || header.id,
            quantity: line.quantity ?? 1,
            uom: line.uom || "EA",
            find_number: line.find_number,
            sequence: line.sequence,
            reference_designator: line.reference_designator,
            usage: line.usage,
            optional: line.optional,
            effectivity: line.effectivity,
            variant_code: line.variant_code,
          },
          ctx.actor,
          ctx.ip
        );
        created += 1;
      } catch (error) {
        failures.push({ line, message: error.message });
      }
    }
    return {
      action: "CREATED",
      object_type: "bom",
      object_id: header.id,
      code: bomNumber,
      message: `BOM ${bomNumber} revision ${revisionNumber}: ${created}/${lines.length} line(s) created`,
      relationships_created: created,
      relationships_failed: failures.length,
      failures,
    };
  },
  fetch(params = {}, ctx) {
    const bomNumber = params.bomNumber || params.bom_number || params.code;
    if (!bomNumber) return { objects: [], relationships: [] };
    let header;
    try {
      header = Bom.getBom(ctx.db, ctx.tenantId, bomNumber);
    } catch {
      return { objects: [], relationships: [] };
    }
    const revisions = Bom.listRevisions(ctx.db, ctx.tenantId, header.bom_ref || header.id)?.items || [];
    const wanted = params.revisionNumber || params.revision_number;
    const revision = wanted ? revisions.find((entry) => String(entry.revision_number) === String(wanted)) : revisions[0];
    const lines = revision ? Bom.listLines(ctx.db, ctx.tenantId, revision.id || revision.revision_ref)?.items || [] : [];
    const document = bomToCanonical(
      {
        bom_number: bomNumber,
        name: header.name,
        bom_type: header.bom_type,
        revision_number: revision?.revision_number || "A",
        lines: lines.map((line) => ({
          child_ref: line.child_object_id,
          child_object_id: line.child_object_id,
          quantity: line.quantity,
          uom: line.uom,
          find_number: line.find_number,
          sequence: line.sequence,
          reference_designator: line.reference_designator,
          usage: line.usage,
          optional: line.optional,
          effectivity: line.effectivity,
          variant_code: line.variant_code,
        })),
      },
      { objectType: "bom", meta: { format: "BOM_EXCHANGE", adapter: "bom" } }
    );
    return document;
  },
};

const pdmIntegration = {
  code: "pdm",
  name: "PDM engine",
  description: "Create PDM items through the Product Data Management service.",
  preview(record) {
    return { action: "CREATE", object_type: "pdm-item", code: record.external_id || recordCode(record), message: `PDM item ${record.external_id || recordCode(record)}` };
  },
  apply(record, ctx) {
    const itemNumber = record.attributes?.item_number || record.external_id || recordCode(record);
    const body = {
      item_number: itemNumber,
      name: record.name || itemNumber,
      description: record.description || "",
      item_type: record.attributes?.item_type || record.subtype || "PART",
      classification_code: record.classification?.[0]?.code || "",
      attributes: recordData(record),
    };
    let existing = null;
    try {
      const found = Pdm.listItems(ctx.db, { tenantId: ctx.tenantId, q: itemNumber, pageSize: 5 });
      existing = (found.items || []).find((item) => String(item.item_number || "").toLowerCase() === String(itemNumber).toLowerCase()) || null;
    } catch {
      existing = null;
    }
    if (existing && ["UPDATE", "MERGE"].includes(String(ctx.options?.duplicate_strategy || "").toUpperCase())) {
      const updated = Pdm.updateItem(ctx.db, ctx.tenantId, existing.id || existing.item_ref, { name: body.name, description: body.description, attributes: body.attributes }, ctx.actor, ctx.ip);
      return { action: "UPDATED", object_type: "pdm-item", object_id: updated.id, code: itemNumber, message: `Updated PDM item ${itemNumber}` };
    }
    if (existing) {
      return { action: "SKIPPED", object_type: "pdm-item", object_id: existing.id, code: itemNumber, message: `Existing PDM item ${itemNumber} skipped` };
    }
    const created = Pdm.createItem(ctx.db, ctx.tenantId, body, ctx.actor, ctx.ip);
    return { action: "CREATED", object_type: "pdm-item", object_id: created.id, code: itemNumber, message: `Created PDM item ${itemNumber}` };
  },
  fetch(params = {}, ctx) {
    const limit = Math.min(100000, Math.max(1, Number(params.limit) || 500));
    const found = Pdm.listItems(ctx.db, { tenantId: ctx.tenantId, q: params.q, pageSize: limit });
    let items = found.items || [];
    const wanted = params.itemIds || params.itemNumbers;
    if (Array.isArray(wanted) && wanted.length) {
      const set = new Set(wanted.map((entry) => String(entry)));
      items = items.filter((item) => set.has(String(item.id)) || set.has(String(item.item_number)));
    }
    return items.slice(0, limit).map((item) => ({
      external_id: item.item_number || String(item.id),
      object_type: "pdm-item",
      subtype: item.item_type || "",
      name: item.name || "",
      description: item.description || "",
      revision: item.revision || "",
      lifecycle_state: item.lifecycle_state || "",
      status: item.status || "",
      attributes: item.attributes && typeof item.attributes === "object" ? { ...item.attributes } : {},
      identifiers: item.item_number ? [{ scheme: "pdm", value: item.item_number }] : [],
      classification: item.classification_code ? [{ code: String(item.classification_code) }] : [],
      metadata: {},
    }));
  },
};

registerIntegration("object", objectIntegration);
registerIntegration("bom", bomIntegration);
registerIntegration("pdm", pdmIntegration);

export { objectIntegration, bomIntegration, pdmIntegration, normalizeStatus, recordCode, recordData };

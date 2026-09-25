// BOM exchange adapter (§16).
//
// Parses/serializes BOM structures (header, revision, lines with quantity, UOM,
// find number, sequence, reference designator, substitute, variant, effectivity)
// into the Canonical Exchange Model. Enterprise persistence is delegated to the
// BOM Engine through the `bom` integration: this adapter never owns BOM logic.
import { StandardsExchangeAdapter } from "./base.js";
import { parseJsonPayload, serializeJsonPayload, enforcePayloadLimit } from "../parsing.js";
import { finding, summarizeValidation } from "../validation-result.js";
import { emptyDocument, addObject, addRelationship } from "../canonical.js";

const FORMAT = {
  code: "BOM_EXCHANGE",
  name: "BOM exchange",
  standard_name: "FutureForge BOM exchange",
  standard_version: "1.0",
  category: "BOM",
  mime_types: ["application/json", "text/csv"],
  extensions: [".bom.json", ".bom.csv"],
  adapter_code: "bom",
};

function normalizeLine(line = {}) {
  return {
    child_ref: String(line.child_ref || line.childRef || line.child || line.child_external_id || line.child_object_id || ""),
    child_object_id: line.child_object_id ?? null,
    quantity: line.quantity ?? 1,
    uom: String(line.uom || "EA"),
    find_number: String(line.find_number || line.findNumber || ""),
    sequence: line.sequence ?? null,
    reference_designator: String(line.reference_designator || line.referenceDesignator || ""),
    usage: String(line.usage || "DESIGN"),
    optional: Boolean(line.optional),
    substitute: Boolean(line.substitute),
    effectivity: line.effectivity || {},
    variant_code: String(line.variant_code || line.variantCode || ""),
    configuration_context: String(line.configuration_context || ""),
    attributes: line.attributes && typeof line.attributes === "object" ? line.attributes : {},
    substitutes: Array.isArray(line.substitutes) ? line.substitutes : [],
  };
}

export function bomToCanonical(input, { objectType = "bom", meta = {} } = {}) {
  const document = emptyDocument(meta);
  const source = input && typeof input === "object" ? input : {};
  const bomNumber = source.bom_number || source.bomNumber || source.number || source.external_id;
  const parentExternalId = source.parent?.external_id || source.parent_ref || bomNumber;
  const parent = addObject(document, {
    external_id: parentExternalId,
    object_type: source.parent?.object_type || objectType,
    name: source.parent?.name || source.name || bomNumber,
    description: source.description || "",
    revision: source.revision_number || source.revisionNumber || source.revision || "",
    attributes: { ...(source.parent?.attributes || {}), "bom.number": bomNumber },
    bom: {
      bom_number: bomNumber,
      name: source.name || bomNumber,
      bom_type: source.bom_type || source.bomType || "EBOM",
      revision_number: source.revision_number || source.revisionNumber || source.revision || "A",
      valid_from: source.valid_from || null,
      valid_to: source.valid_to || null,
      effectivity: source.effectivity || {},
      variant_code: source.variant_code || "",
      configuration_context: source.configuration_context || "",
      lines: [],
    },
  });
  for (const raw of Array.isArray(source.lines) ? source.lines : []) {
    const line = normalizeLine(raw);
    if (line.child_ref && !document.objects.some((entry) => entry.external_id === line.child_ref)) {
      addObject(document, { external_id: line.child_ref, object_type: raw.child_object_type || "part", name: raw.child_name || line.child_ref });
    }
    parent.bom.lines.push(line);
    for (const substitute of line.substitutes) {
      const substituteRef = substitute.child_ref || substitute.child_external_id || substitute;
      if (substituteRef && !document.objects.some((entry) => entry.external_id === substituteRef)) {
        addObject(document, { external_id: substituteRef, object_type: "part", name: substitute.name || substituteRef });
      }
    }
    addRelationship(document, {
      relationship_type: "bom.parent-child",
      semantic: "bom",
      source_ref: parentExternalId,
      target_ref: line.child_ref,
      quantity: line.quantity,
      uom: line.uom,
      metadata: { find_number: line.find_number, sequence: line.sequence, reference_designator: line.reference_designator },
    });
  }
  return document;
}

export function canonicalToBom(document) {
  const objects = document.objects || [];
  const parent = objects.find((object) => object.bom) || objects[0];
  if (!parent) return { bom_number: "", objects: [], relationships: [] };
  const bom = parent.bom || {};
  return {
    bom_number: bom.bom_number || parent.external_id,
    name: bom.name || parent.name,
    bom_type: bom.bom_type || "EBOM",
    revision_number: bom.revision_number || parent.revision || "A",
    valid_from: bom.valid_from || undefined,
    valid_to: bom.valid_to || undefined,
    effectivity: bom.effectivity || undefined,
    variant_code: bom.variant_code || undefined,
    parent: { external_id: parent.external_id, object_type: parent.object_type, name: parent.name },
    lines: (bom.lines || []).map((line) => ({
      child_ref: line.child_ref,
      child_object_id: line.child_object_id,
      quantity: line.quantity,
      uom: line.uom,
      find_number: line.find_number || undefined,
      sequence: line.sequence ?? undefined,
      reference_designator: line.reference_designator || undefined,
      usage: line.usage,
      optional: line.optional || undefined,
      substitute: line.substitute || undefined,
      effectivity: line.effectivity && Object.keys(line.effectivity).length ? line.effectivity : undefined,
      variant_code: line.variant_code || undefined,
      substitutes: line.substitutes && line.substitutes.length ? line.substitutes : undefined,
    })),
    objects,
    relationships: document.relationships,
  };
}

export class BomAdapter extends StandardsExchangeAdapter {
  constructor() {
    super({
      code: "bom",
      name: "BOM exchange adapter",
      category: "BOM",
      provider: "platform",
      library: "builtin",
      status: "AVAILABLE",
      capabilities: { parse: true, serialize: true, validate: true, integration: "bom", variants: true, effectivity: true, substitutes: true },
      formats: [FORMAT],
    });
  }

  getSchema() {
    return {
      type: "object",
      required: ["bom_number", "lines"],
      properties: {
        bom_number: { type: "string" },
        revision_number: { type: "string" },
        lines: { type: "array", items: { type: "object", required: ["child_ref", "quantity"], properties: { child_ref: { type: "string" }, quantity: { type: "number", minimum: 0 } } } },
      },
    };
  }

  detect(payload, { fileName = "", mimeType = "" } = {}) {
    if (/\.bom\.(json|csv)$/i.test(fileName)) return { matched: true, confidence: 0.9, reason: "file extension", format_code: FORMAT.code };
    const text = typeof payload === "string" ? payload.trim() : "";
    if (text.startsWith("{")) {
      try {
        const value = parseJsonPayload(text);
        if (value && (value.bom_number || value.bomNumber) && Array.isArray(value.lines)) {
          return { matched: true, confidence: 0.85, reason: "BOM JSON structure", format_code: FORMAT.code };
        }
      } catch {
        // not JSON
      }
    }
    return { matched: false, confidence: 0, reason: "not BOM exchange" };
  }

  validate(payload, { limit } = {}) {
    const findings = [];
    try {
      enforcePayloadLimit(payload, limit);
      const value = parseJsonPayload(payload, { limit });
      if (!value.bom_number && !value.bomNumber) findings.push(finding({ level: "STANDARDS", severity: "ERROR", code: "missing_bom_number", message: "bom_number is required" }));
      if (!Array.isArray(value.lines)) findings.push(finding({ level: "STANDARDS", severity: "ERROR", code: "missing_lines", message: "lines must be an array" }));
      else {
        value.lines.forEach((line, index) => {
          if (!(line.child_ref || line.childRef || line.child_object_id)) findings.push(finding({ level: "STANDARDS", severity: "ERROR", code: "missing_child_ref", message: "Each line requires a child reference", sourcePath: `lines[${index}]` }));
          if (line.quantity !== undefined && Number(line.quantity) <= 0) findings.push(finding({ level: "STANDARDS", severity: "ERROR", code: "invalid_quantity", message: "quantity must be greater than zero", sourcePath: `lines[${index}].quantity` }));
        });
      }
    } catch (error) {
      findings.push(finding({ level: "STANDARDS", severity: "ERROR", code: "invalid_bom", message: error.message }));
    }
    return summarizeValidation(findings);
  }

  import(payload, { objectType = "bom", meta = {}, limit } = {}) {
    enforcePayloadLimit(payload, limit);
    const value = parseJsonPayload(payload, { limit });
    const source = value && value.objects ? (value.objects.find((entry) => entry.bom) || value) : value;
    const document = value && Array.isArray(value.objects)
      ? { ...emptyDocument({ ...meta, format: FORMAT.code, format_version: FORMAT.standard_version, adapter: "bom" }), ...value }
      : bomToCanonical(source, { objectType, meta: { ...meta, format: FORMAT.code, format_version: FORMAT.standard_version, adapter: "bom" } });
    return { document, errors: [], warnings: [] };
  }

  export(document) {
    const payload = serializeJsonPayload(canonicalToBom(document));
    return { payload, mime_type: "application/json", file_name: "exchange.bom.json", errors: [], warnings: document.warnings || [] };
  }
}

export const bomAdapter = new BomAdapter();

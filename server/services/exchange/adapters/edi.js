// EDI adapter (§15): a real, bounded ANSI X12 / EDIFACT segment reader.
//
// It parses envelopes (ISA/IEA, GS/GE, ST/SE or UNB/UNZ), validates control
// counts, and maps segments to the Canonical Exchange Model using a
// trading-partner configuration. Partner-specific mappings live in data, never
// in business modules.
import { StandardsExchangeAdapter } from "./base.js";
import { enforcePayloadLimit } from "../parsing.js";
import { finding, summarizeValidation } from "../validation-result.js";
import { emptyDocument, addObject, addRelationship } from "../canonical.js";

const FORMAT = {
  code: "EDI_X12",
  name: "EDI (ANSI X12)",
  standard_name: "ANSI ASC X12",
  standard_version: "005010",
  category: "EDI",
  mime_types: ["application/edi-x12", "text/plain"],
  extensions: [".edi", ".x12", ".txt"],
  adapter_code: "edi-x12",
};

export const EDI_DEFAULTS = Object.freeze({
  element_separator: "*",
  component_separator: ":",
  segment_terminator: "~",
  release_character: "",
  repetition_separator: "^",
});

function configOf(options = {}) {
  return { ...EDI_DEFAULTS, ...(options.partner_config || options.partnerConfig || {}), ...(options.config || {}) };
}

export function parseEdiSegments(text, config = {}) {
  const cfg = { ...EDI_DEFAULTS, ...config };
  const raw = String(text ?? "").replace(/\r?\n/g, "").trim();
  const segments = [];
  for (const chunk of raw.split(cfg.segment_terminator)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(cfg.element_separator);
    segments.push({ id: parts[0].trim(), elements: parts.slice(1).map((entry) => entry.trim()) });
  }
  return segments;
}

function envelopeReport(segments) {
  const errors = [];
  if (segments.length === 0) return [{ code: "empty_edi", message: "No EDI segments were found" }];
  const first = segments[0].id;
  const last = segments[segments.length - 1].id;
  const dialect = first === "ISA" ? "X12" : first === "UNB" ? "EDIFACT" : "UNKNOWN";
  if (dialect === "X12") {
    if (last !== "IEA") errors.push({ code: "missing_iea", message: "X12 interchange must end with an IEA segment" });
    const ist = segments.findIndex((s) => s.id === "ST");
    const ise = segments.findIndex((s) => s.id === "SE");
    if (ist === -1 || ise === -1) errors.push({ code: "missing_transaction_set", message: "X12 requires an ST/SE transaction set" });
    else {
      const declared = Number(segments[ise].elements[0]);
      const actual = ise - ist + 1;
      if (Number.isFinite(declared) && declared !== actual) {
        errors.push({ code: "segment_count_mismatch", message: `SE declares ${declared} segments but ${actual} were found`, source_path: "SE01" });
      }
    }
  } else if (dialect === "EDIFACT") {
    if (last !== "UNZ") errors.push({ code: "missing_unz", message: "EDIFACT interchange must end with a UNZ segment" });
  } else {
    errors.push({ code: "unknown_envelope", message: `Unrecognised EDI envelope starting with ${first}` });
  }
  return errors;
}

function componentOf(elements, element, component) {
  const raw = elements[Number(element) - 1];
  if (raw === undefined) return undefined;
  if (component === undefined || component === null) return raw;
  return String(raw).split(":")[Number(component) - 1];
}

export function ediToCanonical(segments, { objectType = "part", meta = {}, config = {} } = {}) {
  const document = emptyDocument(meta);
  const mappings = Array.isArray(config.mappings) ? config.mappings : [];
  const byObject = new Map();
  let current = null;
  for (const segment of segments) {
    if (segment.id === "ST") {
      const control = segment.elements[1] || segment.elements[0] || "";
      const mappedType = (config.transaction_set_type && config.transaction_set_type[segment.elements[0]]) || objectType;
      current = addObject(document, {
        external_id: control,
        object_type: mappedType,
        name: config.name || control,
        attributes: {},
        metadata: { transaction_set: segment.elements[0], control_number: control, segments: [] },
      });
      byObject.set(control, current);
      continue;
    }
    if (!current) continue;
    current.metadata.segments.push(segment.id);
    for (const map of mappings) {
      if (map.segment !== segment.id) continue;
      const value = componentOf(segment.elements, map.element, map.component);
      if (value === undefined) continue;
      current.attributes[map.field] = value;
    }
  }
  const relationshipMappings = Array.isArray(config.relationship_mappings) ? config.relationship_mappings : [];
  for (const segment of segments) {
    for (const map of relationshipMappings) {
      if (map.segment !== segment.id) continue;
      const source = componentOf(segment.elements, map.source_element, map.source_component);
      const target = componentOf(segment.elements, map.target_element, map.target_component);
      if (source && target) {
        addRelationship(document, {
          relationship_type: map.relationship_type || "edi.related",
          source_ref: source,
          target_ref: target,
        });
      }
    }
  }
  return document;
}

export class EdiAdapter extends StandardsExchangeAdapter {
  constructor() {
    super({
      code: "edi-x12",
      name: "EDI X12 adapter",
      category: "EDI",
      provider: "platform",
      library: "builtin-segment",
      status: "AVAILABLE",
      capabilities: { parse: true, serialize: true, schema: "SEGMENT", partner_config: true, detect: true },
      formats: [FORMAT],
    });
  }

  getSchema() {
    return {
      type: "object",
      description: "Trading-partner configuration: element/segment separators, transaction set and segment mappings.",
      properties: {
        transaction_set: { type: "string" },
        mappings: { type: "array", items: { type: "object" } },
      },
    };
  }

  detect(payload, { fileName = "", mimeType = "" } = {}) {
    if (/edi/i.test(mimeType)) return { matched: true, confidence: 0.9, reason: "mime type", format_code: FORMAT.code };
    if (/\.(edi|x12)$/i.test(fileName)) return { matched: true, confidence: 0.9, reason: "file extension", format_code: FORMAT.code };
    const text = typeof payload === "string" ? payload.trim() : "";
    if (/^ISA[*^|~]/.test(text) || /^UNA/.test(text) || /^UNB/.test(text)) return { matched: true, confidence: 0.95, reason: "envelope header", format_code: FORMAT.code };
    return { matched: false, confidence: 0, reason: "not EDI" };
  }

  validate(payload, { limit } = {}) {
    const findings = [];
    try {
      enforcePayloadLimit(payload, limit);
      const segments = parseEdiSegments(payload);
      for (const error of envelopeReport(segments)) {
        findings.push(finding({ level: "STANDARDS", severity: "ERROR", code: error.code, message: error.message, sourcePath: error.source_path || "" }));
      }
    } catch (error) {
      findings.push(finding({ level: "STANDARDS", severity: "ERROR", code: "invalid_edi", message: error.message }));
    }
    return summarizeValidation(findings);
  }

  import(payload, { objectType = "part", meta = {}, limit, config = {}, partner_config = null } = {}) {
    enforcePayloadLimit(payload, limit);
    const cfg = configOf({ config, partner_config });
    const segments = parseEdiSegments(payload, cfg);
    const envelopeErrors = envelopeReport(segments);
    if (envelopeErrors.length) {
      return { document: null, errors: envelopeErrors.map((error) => finding({ level: "STANDARDS", severity: "ERROR", code: error.code, message: error.message })), warnings: [] };
    }
    const document = ediToCanonical(segments, { objectType, meta: { ...meta, format: FORMAT.code, format_version: FORMAT.standard_version, adapter: "edi-x12" }, config: cfg });
    return { document, errors: [], warnings: [] };
  }

  export(document, { config = {} } = {}) {
    const cfg = configOf({ config });
    const st = config.transaction_set || "850";
    const segments = [`ISA*00*          *00*          *ZZ*FUTUREFORGE     *ZZ*PARTNER        *${new Date().toISOString().slice(2, 4)}${new Date().toISOString().slice(5, 7)}${new Date().toISOString().slice(8, 10)}*${new Date().toTimeString().slice(0, 5).replace(":", "")}*^*00501*000000001*0*P*${cfg.component_separator}`, `GS*PO*FUTUREFORGE*PARTNER*${new Date().toISOString().slice(0, 10).replace(/-/g, "")}*${new Date().toTimeString().slice(0, 5).replace(":", "")}*1*X*${FORMAT.standard_version}`, `ST*${st}*0001`];
    for (const object of document.objects || []) {
      const parts = [`BEG`, object.external_id || "", object.name || ""];
      segments.push(parts.join(cfg.element_separator));
    }
    segments.push(`SE*${segments.length - 1}*0001`, `GE*1*1`, `IEA*1*000000001`);
    const payload = segments.join(cfg.segment_terminator) + cfg.segment_terminator;
    return { payload, mime_type: "application/edi-x12", file_name: "exchange.edi", errors: [], warnings: [] };
  }
}

export const ediAdapter = new EdiAdapter();

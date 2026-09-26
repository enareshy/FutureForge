// XML adapter (§13): safe parsing/serialization via the hardened reader in
// ../xml.js (no DTD/entities), XSD-style declarative schema validation against
// a JSON-Schema-described shape, and namespace-preserving qualified names.
import { StandardsExchangeAdapter } from "./base.js";
import { parseXml, xmlToObject, objectToXml, serializeXml, assertSafeXml } from "../xml.js";
import { enforcePayloadLimit, validateAgainstJsonSchema } from "../parsing.js";
import { finding, summarizeValidation } from "../validation-result.js";
import { emptyDocument, addObject, addRelationship } from "../canonical.js";

const FORMAT = {
  code: "XML",
  name: "XML",
  standard_name: "W3C XML 1.0",
  standard_version: "1.0",
  category: "DATA",
  mime_types: ["application/xml", "text/xml"],
  extensions: [".xml"],
  adapter_code: "xml",
};

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (value.$text !== undefined) return String(value.$text);
    if (value["@value"] !== undefined) return String(value["@value"]);
    return "";
  }
  return String(value);
}

function attributesOf(node) {
  if (!node || typeof node !== "object") return {};
  if (node.attribute) {
    const output = {};
    for (const entry of asArray(node.attribute)) {
      const name = entry["@name"] || entry["@key"];
      if (name) output[name] = textOf(entry);
    }
    return output;
  }
  const output = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@") || key === "$text") continue;
    if (typeof value !== "object") output[key] = value;
  }
  return output;
}

function recordFromElement(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object") return { value };
  const record = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.startsWith("@")) record[key.slice(1)] = entry;
    else if (key === "$text") record.value = entry;
    else record[key] = entry;
  }
  return record;
}

export function plainToCanonical(plain, { objectType = "part", meta = {} } = {}) {
  const document = emptyDocument(meta);
  const objectsRaw = plain && plain.objects ? asArray(plain.objects.object ?? plain.objects) : null;
  if (!objectsRaw) {
    const records = [];
    for (const [key, value] of Object.entries(plain || {})) {
      if (key.startsWith("@") || key === "$text") continue;
      for (const entry of asArray(value)) records.push({ object_type: objectType, ...recordFromElement(entry), name: recordFromElement(entry).name || key });
    }
    for (const record of records) {
      addObject(document, { object_type: objectType, external_id: record.external_id || record.id || record.name, ...record });
    }
    return document;
  }
  for (const raw of objectsRaw) {
    addObject(document, {
      external_id: textOf(raw.external_id ?? raw["@external_id"] ?? raw["@id"]),
      object_type: textOf(raw.object_type ?? raw["@type"]) || objectType,
      subtype: textOf(raw.subtype),
      name: textOf(raw.name),
      description: textOf(raw.description),
      revision: textOf(raw.revision),
      lifecycle_state: textOf(raw.lifecycle_state ?? raw.lifecycleState),
      status: textOf(raw.status),
      unit_system: textOf(raw.unit_system),
      uom: textOf(raw.uom),
      attributes: attributesOf(raw.attributes),
      identifiers: asArray(raw.identifiers ? raw.identifiers.identifier ?? raw.identifiers : []).map((entry) => ({
        scheme: textOf(entry["@scheme"]) || "external",
        value: textOf(entry),
      })),
      classification: asArray(raw.classification ? raw.classification.class ?? raw.classification : []).map((entry) => ({
        scheme: textOf(entry["@scheme"]),
        code: textOf(entry),
      })),
    });
  }
  const relationshipsRaw = plain && plain.relationships ? asArray(plain.relationships.relationship ?? plain.relationships) : [];
  for (const raw of relationshipsRaw) {
    addRelationship(document, {
      external_id: textOf(raw.external_id ?? raw["@external_id"]),
      relationship_type: textOf(raw.relationship_type ?? raw["@type"]),
      semantic: textOf(raw.semantic),
      source_ref: textOf(raw.source_ref ?? raw.source),
      target_ref: textOf(raw.target_ref ?? raw.target),
      quantity: raw.quantity !== undefined ? Number(textOf(raw.quantity)) : null,
      uom: textOf(raw.uom),
    });
  }
  return document;
}

export function canonicalToPlain(document) {
  return {
    exchange: {
      "@modelVersion": document.model_version,
      objects: {
        object: (document.objects || []).map((object) => ({
          "@externalId": object.external_id,
          "@type": object.object_type,
          external_id: object.external_id,
          object_type: object.object_type,
          name: object.name,
          description: object.description || undefined,
          revision: object.revision || undefined,
          lifecycle_state: object.lifecycle_state || undefined,
          unit_system: object.unit_system || undefined,
          attributes: { attribute: Object.entries(object.attributes || {}).map(([name, value]) => ({ "@name": name, $text: value })) },
          identifiers: { identifier: (object.identifiers || []).map((entry) => ({ "@scheme": entry.scheme, $text: entry.value })) },
        })),
      },
      relationships: {
        relationship: (document.relationships || []).map((relationship) => ({
          "@externalId": relationship.external_id,
          "@type": relationship.relationship_type,
          source_ref: relationship.source_ref,
          target_ref: relationship.target_ref,
          quantity: relationship.quantity ?? undefined,
          uom: relationship.uom || undefined,
        })),
      },
    },
  };
}

export class XmlAdapter extends StandardsExchangeAdapter {
  constructor() {
    super({
      code: "xml",
      name: "XML adapter",
      category: "DATA",
      provider: "platform",
      library: "builtin-safe-xml",
      status: "AVAILABLE",
      capabilities: { parse: true, serialize: true, schema: "XSD_DECLARATIVE", namespaces: true, secure: true, detect: true },
      formats: [FORMAT],
    });
  }

  getSchema() {
    return {
      type: "object",
      description: "Canonical XML exchange shape: <exchange><objects><object>...</object></objects><relationships>...</relationships></exchange>",
      properties: {
        objects: { type: "object" },
        relationships: { type: "object" },
      },
    };
  }

  detect(payload, { fileName = "", mimeType = "" } = {}) {
    if (/xml/i.test(mimeType)) return { matched: true, confidence: 0.98, reason: "mime type", format_code: FORMAT.code };
    if (/\.xml$/i.test(fileName)) return { matched: true, confidence: 0.9, reason: "file extension", format_code: FORMAT.code };
    const text = typeof payload === "string" ? payload.trim() : "";
    if (!text) return { matched: false, confidence: 0, reason: "empty payload" };
    if (text.startsWith("<?xml") || /^<[A-Za-z_]/.test(text)) return { matched: true, confidence: 0.8, reason: "payload looks like XML", format_code: FORMAT.code };
    return { matched: false, confidence: 0, reason: "not XML" };
  }

  validate(payload, { schema = null, limit } = {}) {
    const findings = [];
    try {
      const root = parseXml(payload, { maxBytes: limit });
      const plain = xmlToObject(root);
      if (schema) {
        const check = validateAgainstJsonSchema(plain, schema);
        for (const error of check.errors) {
          findings.push(finding({ level: "STANDARDS", severity: "ERROR", code: error.code, message: error.message, sourcePath: error.path }));
        }
      }
    } catch (error) {
      findings.push(finding({ level: "STANDARDS", severity: "ERROR", code: "invalid_xml", message: error.message }));
    }
    return summarizeValidation(findings);
  }

  import(payload, { objectType = "part", meta = {}, limit, schema = null } = {}) {
    assertSafeXml(payload, limit);
    enforcePayloadLimit(payload, limit);
    if (schema) {
      const check = this.validate(payload, { schema, limit });
      if (check.errors > 0) return { document: null, errors: check.findings.filter((f) => f.severity === "ERROR"), warnings: [] };
    }
    const root = parseXml(payload, { maxBytes: limit });
    const plain = xmlToObject(root);
    const body = plain && plain.exchange ? plain.exchange : plain;
    const document = plainToCanonical(body, { objectType, meta: { ...meta, format: FORMAT.code, format_version: FORMAT.standard_version, adapter: "xml" } });
    return { document, errors: [], warnings: [] };
  }

  export(document) {
    const plain = canonicalToPlain(document);
    const payload = serializeXml(objectToXml("exchange", plain.exchange), { declaration: true });
    return { payload, mime_type: "application/xml", file_name: "exchange.xml", errors: [], warnings: document.warnings || [] };
  }
}

export const xmlAdapter = new XmlAdapter();

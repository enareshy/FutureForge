// JSON adapter (§14): real RFC 8259 parsing/serialization with JSON Schema
// validation and payload-size enforcement.
import { StandardsExchangeAdapter } from "./base.js";
import { parseJsonPayload, serializeJsonPayload, enforcePayloadLimit, validateAgainstJsonSchema } from "../parsing.js";
import { finding, summarizeValidation } from "../validation-result.js";
import { normalizeDocument, documentFromRecords } from "../canonical.js";

const FORMAT = {
  code: "JSON",
  name: "JSON",
  standard_name: "RFC 8259 JSON",
  standard_version: "RFC 8259",
  category: "DATA",
  mime_types: ["application/json"],
  extensions: [".json"],
  adapter_code: "json",
};

export class JsonAdapter extends StandardsExchangeAdapter {
  constructor() {
    super({
      code: "json",
      name: "JSON adapter",
      category: "DATA",
      provider: "platform",
      library: "builtin",
      status: "AVAILABLE",
      capabilities: { parse: true, serialize: true, schema: "JSON_SCHEMA", detect: true, payload_limit: true },
      formats: [FORMAT],
    });
  }

  getSchema() {
    return {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      description: "A canonical exchange document or a list of records.",
      anyOf: [
        { type: "object", required: ["objects"], properties: { objects: { type: "array" }, relationships: { type: "array" } } },
        { type: "array" },
      ],
    };
  }

  detect(payload, { fileName = "", mimeType = "" } = {}) {
    if (/json/i.test(mimeType)) return { matched: true, confidence: 0.98, reason: "mime type", format_code: FORMAT.code };
    if (/\.json$/i.test(fileName)) return { matched: true, confidence: 0.9, reason: "file extension", format_code: FORMAT.code };
    const text = typeof payload === "string" ? payload.trim() : "";
    if (!text) return { matched: false, confidence: 0, reason: "empty payload" };
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        parseJsonPayload(text);
        return { matched: true, confidence: 0.7, reason: "payload parses as JSON", format_code: FORMAT.code };
      } catch {
        return { matched: false, confidence: 0, reason: "invalid JSON" };
      }
    }
    return { matched: false, confidence: 0, reason: "not JSON" };
  }

  validate(payload, { schema = null, limit } = {}) {
    const findings = [];
    try {
      const value = parseJsonPayload(payload, { limit });
      if (schema) {
        const check = validateAgainstJsonSchema(value, schema);
        for (const error of check.errors) {
          findings.push(
            finding({
              level: "STANDARDS",
              severity: "ERROR",
              code: error.code,
              message: error.message,
              sourcePath: error.path,
              recommendation: "Correct the JSON value to satisfy the registered schema.",
            })
          );
        }
      }
    } catch (error) {
      findings.push(finding({ level: "STANDARDS", severity: "ERROR", code: "invalid_json", message: error.message }));
    }
    return summarizeValidation(findings);
  }

  import(payload, { objectType = "part", meta = {}, limit, schema = null } = {}) {
    enforcePayloadLimit(payload, limit);
    const findings = [];
    if (schema) {
      const check = this.validate(payload, { schema, limit });
      findings.push(...check.findings);
      if (check.errors > 0) return { document: null, errors: check.findings.filter((f) => f.severity === "ERROR"), warnings: [] };
    }
    const value = parseJsonPayload(payload, { limit });
    const metaWithFormat = { ...meta, format: FORMAT.code, format_version: FORMAT.standard_version, adapter: "json" };
    if (Array.isArray(value)) {
      return { document: documentFromRecords(value, { object_type: objectType, meta: metaWithFormat }), errors: [], warnings: [] };
    }
    if (value && typeof value === "object" && Array.isArray(value.objects)) {
      const normalized = normalizeDocument(value, metaWithFormat);
      return { document: normalized.document, errors: normalized.errors, warnings: normalized.warnings };
    }
    if (value && typeof value === "object" && value.records && Array.isArray(value.records)) {
      return { document: documentFromRecords(value.records, { object_type: objectType, meta: metaWithFormat }), errors: [], warnings: [] };
    }
    const wrapped = { objects: [value] };
    const normalized = normalizeDocument(wrapped, metaWithFormat);
    return { document: normalized.document, errors: normalized.errors, warnings: normalized.warnings };
  }

  export(document, { pretty = true } = {}) {
    const payload = serializeJsonPayload(
      {
        model_version: document.model_version,
        source: document.source,
        metadata: document.metadata,
        objects: document.objects,
        relationships: document.relationships,
        references: document.references,
      },
      { pretty }
    );
    return { payload, mime_type: "application/json", file_name: "exchange.json", errors: [], warnings: document.warnings || [] };
  }
}

export const jsonAdapter = new JsonAdapter();

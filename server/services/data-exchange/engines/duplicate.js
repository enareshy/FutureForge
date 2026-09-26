// Duplicate handling: computes idempotency/business keys and decides, from the
// configured strategy, what should happen to a mapped record that may already
// exist. Side effects (create/update through the object framework) are performed
// by the import service; this module is pure.
import { DUPLICATE_STRATEGIES } from "../constants.js";
import { invalidDuplicateStrategy, invalidMapping } from "../errors.js";
import { normalizeUpper } from "../validation.js";
import { getPath } from "./transform.js";

export function computeDuplicateKey(record, duplicateKey = {}) {
  const type = normalizeUpper(duplicateKey.type || duplicateKey.key_type || "BUSINESS_KEY");
  const fields = duplicateKey.fields || duplicateKey.key_fields || [];
  if (type === "OBJECT_ID") return record.id ?? record.object_id ?? record.objectId ?? "";
  if (type === "EXTERNAL_REFERENCE") return record.external_reference ?? record.externalReference ?? record.external_ref ?? "";
  if (type === "SOURCE_EXTERNAL_ID") return record.source_external_id ?? record.sourceExternalId ?? record.external_id ?? "";
  if (!Array.isArray(fields) || fields.length === 0) {
    if (duplicateKey.expression) return String(record[duplicateKey.expression] ?? "");
    throw invalidMapping("A duplicate key requires at least one field or an expression");
  }
  return fields.map((field) => (record[field] === null || record[field] === undefined ? "" : String(record[field]))).join("|");
}

export function decideDuplicate(strategy, { existing, changed = true } = {}) {
  const normalized = normalizeUpper(strategy || "REJECT");
  if (!DUPLICATE_STRATEGIES.includes(normalized)) throw invalidDuplicateStrategy(strategy);
  if (!existing) {
    // CREATE_NEW on a missing record still creates.
    return { action: "CREATE", strategy: normalized, reason: "no existing record" };
  }
  switch (normalized) {
    case "REJECT":
      return { action: "REJECT", strategy: normalized, reason: "duplicate rejected by strategy" };
    case "SKIP":
      return { action: "SKIP", strategy: normalized, reason: "duplicate skipped" };
    case "UPDATE":
      return changed ? { action: "UPDATE", strategy: normalized, reason: "existing record updated" } : { action: "SKIP", strategy: normalized, reason: "no change detected" };
    case "UPSERT":
      return changed ? { action: "UPDATE", strategy: normalized, reason: "upsert updated existing record" } : { action: "SKIP", strategy: normalized, reason: "upsert found no change" };
    case "CREATE_NEW":
      return { action: "CREATE", strategy: normalized, reason: "strategy forces a new record" };
    case "MERGE":
      return { action: "MERGE", strategy: normalized, reason: "existing record merged" };
    default:
      throw invalidDuplicateStrategy(strategy);
  }
}

// Shallow merge where non-empty incoming values win. Nested objects merge one
// level deep so a partial update does not erase sibling attributes.
export function mergeRecords(existing, incoming) {
  const result = { ...(existing || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === null || value === undefined || value === "") continue;
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = { ...result[key], ...value };
    } else {
      result[key] = value;
    }
  }
  return result;
}

export { getPath };

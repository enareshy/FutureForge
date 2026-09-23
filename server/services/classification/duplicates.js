// Duplicate detection for classified objects.
//
// Classification gives objects a structured characteristic signature; two objects
// with the same (or near-identical) signature in the same class are strong
// duplicate candidates. The deterministic strategy is registered into the shared
// Data Governance duplicate engine so the platform keeps a single detection
// pipeline, while `detectClassificationDuplicates` offers a classification-scoped
// scan that needs no domain catalog.
import { queryAll, queryOne } from "../../db.js";
import { registerDuplicateStrategy, similarityRatio, normalizeKeyValue } from "../data-governance/duplicates.js";
import { resolveEffectiveCharacteristics } from "./inheritance.js";
import { normalizeText } from "./validation.js";
import { getConfig } from "./configuration.js";

export const CLASSIFICATION_DUPLICATE_STRATEGY = "classification_signature";

// Builds a stable, normalized signature for an assignment's characteristic values.
export function classificationSignature(db, tenantId, assignment) {
  const resolved = resolveEffectiveCharacteristics(db, tenantId, assignment.class_id);
  const rows = queryAll(
    db,
    `SELECT v.*, c.code AS characteristic_code FROM cla_assignment_values v
       JOIN cla_characteristics c ON c.id = v.characteristic_id
      WHERE v.assignment_id = ? AND v.status = 'ACTIVE' ORDER BY c.code, v.sequence`,
    [Number(assignment.id)]
  );
  const byCode = new Map();
  for (const row of rows) {
    const value = row.value_number ?? row.value_boolean ?? row.value_date ?? row.value_reference ?? row.value_text;
    const list = byCode.get(row.characteristic_code) || [];
    list.push(normalizeKeyValue(value));
    byCode.set(row.characteristic_code, list);
  }
  const parts = [];
  for (const item of resolved.items) {
    const values = byCode.get(item.code) || [];
    if (values.length) parts.push(`${item.code}=${values.join(",")}`);
  }
  return parts.join("|");
}

export function registerClassificationDuplicateStrategies() {
  return registerDuplicateStrategy(CLASSIFICATION_DUPLICATE_STRATEGY, {
    keyFor(record, attributes = [], normalization = {}) {
      const source = record?.attributes || {};
      const signature = source.__classification_signature;
      if (typeof signature === "string" && signature) return normalizeKeyValue(signature, normalization);
      return attributes.map((attribute) => normalizeKeyValue(source[attribute])).join("|");
    },
  });
}

function signatureOf(db, tenantId, assignment) {
  return classificationSignature(db, tenantId, assignment);
}

// Scans active assignments and returns duplicate candidate pairs. Exact matches
// are grouped by signature; near matches use deterministic similarity over the
// signature string inside the same class.
export function detectClassificationDuplicates(db, { tenantId, classRef = null, objectType = null, threshold = null, limit = 2000, actor = null } = {}) {
  const tenant = Number(tenantId);
  const effectiveThreshold = threshold != null ? Number(threshold) : Number(getConfig(db, tenant, "duplicate_similarity_threshold") ?? 0.85);
  const cap = Number(limit) || 2000;
  const clauses = ["tenant_id = ?", "status = 'ACTIVE'"];
  const params = [tenant];
  if (classRef != null) {
    clauses.push("class_id = ?");
    params.push(Number(classRef));
  }
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(normalizeText(objectType, { max: 120 }));
  }
  const assignments = queryAll(db, `SELECT * FROM cla_assignments WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`, [...params, cap]);

  const signatories = assignments.map((assignment) => ({
    assignment,
    signature: signatureOf(db, tenant, assignment),
    class: queryOne(db, "SELECT code FROM cla_classes WHERE id = ?", [assignment.class_id]),
  }));

  const candidates = [];
  const buckets = new Map();
  for (const entry of signatories) {
    const key = `${entry.assignment.class_id}::${entry.signature}`;
    const bucket = buckets.get(key) || [];
    bucket.push(entry);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        candidates.push(pair(bucket[i], bucket[j], 1, "EXACT"));
      }
    }
  }

  const seen = new Set(candidates.map((candidate) => `${candidate.object_id}::${candidate.matched_object_id}::${candidate.class_id}`));
  if (effectiveThreshold < 1 && signatories.length <= 2000) {
    for (let i = 0; i < signatories.length; i += 1) {
      for (let j = i + 1; j < signatories.length; j += 1) {
        const left = signatories[i];
        const right = signatories[j];
        if (Number(left.assignment.class_id) !== Number(right.assignment.class_id)) continue;
        if (!left.signature || !right.signature) continue;
        const key = `${left.assignment.object_id}::${right.assignment.object_id}::${left.assignment.class_id}`;
        const reverse = `${right.assignment.object_id}::${left.assignment.object_id}::${left.assignment.class_id}`;
        if (seen.has(key) || seen.has(reverse)) continue;
        const score = similarityRatio(left.signature, right.signature);
        if (score >= effectiveThreshold) {
          seen.add(key);
          candidates.push(pair(left, right, score, "SIMILARITY"));
        }
      }
    }
  }

  return {
    class_ref: classRef,
    object_type: objectType,
    threshold: effectiveThreshold,
    scanned: signatories.length,
    detected: candidates.length,
    candidates,
    actor: actor?.id ?? null,
  };
}

function pair(left, right, score, matchType) {
  return {
    class_id: left.assignment.class_id,
    class_code: left.class?.code || "",
    object_type: left.assignment.object_type,
    object_id: left.assignment.object_id,
    matched_object_type: right.assignment.object_type,
    matched_object_id: right.assignment.object_id,
    score,
    match_type: matchType,
    signature: left.signature,
  };
}

export function duplicateSummary(db, { tenantId } = {}) {
  const tenant = Number(tenantId);
  const result = detectClassificationDuplicates(db, { tenantId: tenant, limit: Number(getConfig(db, tenant, "duplicate_scan_limit") ?? 500) });
  return {
    scanned: result.scanned,
    groups: result.detected,
    exact: result.candidates.filter((entry) => entry.match_type === "EXACT").length,
    similarity: result.candidates.filter((entry) => entry.match_type === "SIMILARITY").length,
    threshold: result.threshold,
  };
}

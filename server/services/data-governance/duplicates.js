// Duplicate detection.
//
// Detection is a pluggable interface: a strategy takes a governed object and
// returns a grouping key (or a pairwise similarity). P1 ships deterministic
// strategies only (exact, normalized, configured attribute match and a
// deterministic edit-distance similarity). There is deliberately no AI/ML here;
// fuzzy/semantic matching is a future strategy that plugs into the same
// interface without touching the engine.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { duplicateConflict, duplicateNotFound, invalidRule } from "./errors.js";
import { normalizeText, parseArray, parseObject, readAttribute, valuePreview } from "./validation.js";
import { candidateRef } from "./refs.js";
import { publicDuplicateRule, publicDuplicateCandidate } from "./repository.js";
import { findCatalogByType } from "./catalog.js";
import { requireAdapter } from "./adapter.js";
import { publishGovernanceEvent } from "./events.js";

export { publicDuplicateRule, publicDuplicateCandidate };

const strategies = new Map();

export function registerDuplicateStrategy(code, implementation) {
  const key = normalizeText(code).toLowerCase();
  if (!key || typeof implementation?.keyFor !== "function") throw invalidRule("A duplicate strategy needs keyFor()");
  strategies.set(key, { code: key, ...implementation });
  return key;
}

export function listDuplicateStrategies() {
  return [...strategies.keys()];
}

// Normalization used by the `normalized` strategy and by the edit distance.
export function normalizeKeyValue(value, options = {}) {
  let text = value === null || value === undefined ? "" : String(value);
  if (options.trim !== false) text = text.trim();
  if (options.lower !== false) text = text.toLowerCase();
  if (options.collapse_whitespace !== false) text = text.replace(/\s+/g, " ");
  if (options.strip_punctuation) text = text.replace(/[^a-z0-9 ]+/gi, "");
  if (options.strip_diacritics) text = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return text;
}

function attributeValues(record, attributes) {
  return attributes.map((attribute) => (attribute ? normalizeKeyValue(readAttribute(record.attributes, attribute)) : ""));
}

export function registerBuiltinStrategies() {
  registerDuplicateStrategy("exact", {
    keyFor(record, attributes) {
      return attributeValues(record, attributes).join("|");
    },
  });
  registerDuplicateStrategy("normalized", {
    keyFor(record, attributes) {
      return attributeValues(record, attributes).join("|");
    },
  });
  registerDuplicateStrategy("attribute", {
    keyFor(record, attributes) {
      return attributeValues(record, attributes).join("|");
    },
  });
  registerDuplicateStrategy("similarity", {
    keyFor(record, attributes) {
      // Coarse bucket for the deterministic similarity pass below.
      return attributeValues(record, attributes)[0] || "";
    },
  });
  return listDuplicateStrategies();
}

// Deterministic similarity between two strings (normalized edit distance).
// This is a plain string metric, not a model.
export function similarityRatio(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (!left.length && !right.length) return 1;
  const max = Math.max(left.length, right.length);
  if (max === 0) return 1;
  const distance = levenshtein(left, right);
  return Math.round((1 - distance / max) * 10000) / 10000;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

export function getMatchRuleRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM dg_duplicate_match_rules WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return null;
}

export function listMatchRules(db, { tenantId, objectType, status } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(String(objectType).toLowerCase());
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status).toLowerCase());
  }
  return queryAll(db, `SELECT * FROM dg_duplicate_match_rules WHERE ${clauses.join(" AND ")} ORDER BY code`, params).map(publicDuplicateRule);
}

export function createMatchRule(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = normalizeText(input.code).toUpperCase();
  if (!code) throw invalidRule("A duplicate match rule needs a code");
  const strategy = normalizeText(input.strategy || "normalized").toLowerCase();
  if (!strategies.has(strategy)) throw invalidRule(`Unknown duplicate strategy: ${strategy}`);
  const attributes = parseArray(input.attributes, []).filter(Boolean);
  if (strategy !== "exact" && strategy !== "similarity" && !attributes.length) {
    throw invalidRule("Attribute-based strategies require at least one attribute");
  }
  const existing = queryOne(db, "SELECT id FROM dg_duplicate_match_rules WHERE tenant_id = ? AND code = ?", [Number(tenantId), code]);
  if (existing) throw duplicateConflict({ code });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dg_duplicate_match_rules
      (tenant_id, domain_id, code, name, object_type, attributes_json, strategy, threshold, normalization_json, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(tenantId),
      input.domain_id ? Number(input.domain_id) : null,
      code,
      normalizeText(input.name, code),
      normalizeText(input.object_type).toLowerCase(),
      JSON.stringify(attributes),
      strategy,
      input.threshold !== undefined ? Number(input.threshold) : strategy === "similarity" ? 0.85 : 1,
      JSON.stringify(parseObject(input.normalization, {})),
      normalizeText(input.status, "active").toLowerCase() === "inactive" ? "inactive" : "active",
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  writeAudit(db, {
    actor,
    action: "data_quality.duplicate_rule.create",
    resourceType: "dg_duplicate_match_rule",
    resourceId: Number(result.lastInsertRowid),
    details: { code, strategy, attributes },
    ip,
  });
  return publicDuplicateRule(getMatchRuleRow(db, Number(result.lastInsertRowid)));
}

export function updateMatchRule(db, ref, patch = {}, actor = null) {
  const row = getMatchRuleRow(db, ref);
  if (!row) throw duplicateNotFound(ref);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) assign("name", normalizeText(patch.name, row.code));
  if (patch.object_type !== undefined) assign("object_type", normalizeText(patch.object_type).toLowerCase());
  if (patch.attributes !== undefined) assign("attributes_json", JSON.stringify(parseArray(patch.attributes, []).filter(Boolean)));
  if (patch.strategy !== undefined) {
    const strategy = normalizeText(patch.strategy).toLowerCase();
    if (!strategies.has(strategy)) throw invalidRule(`Unknown duplicate strategy: ${strategy}`);
    assign("strategy", strategy);
  }
  if (patch.threshold !== undefined) assign("threshold", Number(patch.threshold));
  if (patch.normalization !== undefined) assign("normalization_json", JSON.stringify(parseObject(patch.normalization, {})));
  if (patch.status !== undefined) assign("status", normalizeText(patch.status).toLowerCase() === "inactive" ? "inactive" : "active");
  if (!changes.length) return publicDuplicateRule(row);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dg_duplicate_match_rules SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  return publicDuplicateRule(getMatchRuleRow(db, row.id));
}

function upsertCandidate(db, { tenantId, domainId, objectType, objectId, matched, rule, strategy, score, matchType }, actor) {
  const existing = queryOne(
    db,
    `SELECT * FROM dg_duplicate_candidates
      WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND matched_object_id = ? AND match_rule_id = ?`,
    [Number(tenantId), objectType, String(objectId), String(matched.id), rule.id]
  );
  if (existing) return null;
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dg_duplicate_candidates
      (candidate_ref, tenant_id, domain_id, object_type, object_id, matched_object_id, matched_object_name, match_rule_id, strategy, score, match_type, status, detected_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`,
    [
      candidateRef(),
      Number(tenantId),
      domainId,
      objectType,
      String(objectId),
      String(matched.id),
      matched.object_name || matched.name || "",
      rule.id,
      strategy,
      score,
      matchType,
      ts,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM dg_duplicate_candidates WHERE id = ?", [Number(result.lastInsertRowid)]);
  publishGovernanceEvent(db, {
    eventType: "DuplicateCandidateDetected",
    tenantId: Number(tenantId),
    objectType,
    objectId: String(objectId),
    payload: { candidate_ref: row.candidate_ref, matched_object_id: String(matched.id), strategy, score },
  }, actor);
  return row;
}

// Runs every active match rule for an object type and returns the candidates
// detected in this pass. Candidate rows are deduplicated by uniqueness.
export function detectDuplicates(db, { tenantId, objectType, matchRuleId = null, limit = 2000, actor = null, ip = null } = {}) {
  const type = String(objectType).toLowerCase();
  const catalog = findCatalogByType(db, tenantId, type);
  const adapter = requireAdapter(catalog?.source_adapter || "platform.objects");
  const rules = queryAll(
    db,
    `SELECT * FROM dg_duplicate_match_rules WHERE tenant_id = ? AND object_type = ? AND status = 'active' ${matchRuleId ? "AND id = ?" : ""} ORDER BY code`,
    matchRuleId ? [Number(tenantId), type, Number(matchRuleId)] : [Number(tenantId), type]
  );
  if (!rules.length) return { object_type: type, rules: 0, candidates: [], detected: 0 };

  const records = adapter.list(db, { tenantId, objectType: type, limit, offset: 0 });
  const detected = [];
  for (const rule of rules) {
    const strategy = strategies.get(rule.strategy);
    if (!strategy) continue;
    const attributes = parseArray(rule.attributes_json, []);
    const normalization = parseObject(rule.normalization_json, {});
    const keyed = new Map();
    for (const record of records) {
      const key = strategy.keyFor(
        { attributes: { ...record.attributes, __name: record.object_name } },
        attributes.map((attribute) => attribute),
        normalization
      );
      if (key === undefined || key === null || key === "") continue;
      const bucket = keyed.get(key) || [];
      bucket.push(record);
      keyed.set(key, bucket);
    }
    for (const bucket of keyed.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          const left = bucket[i];
          const right = bucket[j];
          let score = 1;
          let matchType = "EXACT";
          if (rule.strategy === "similarity") {
            score = similarityRatio(attributeValues(left, attributes).join(" "), attributeValues(right, attributes).join(" "));
            if (score < Number(rule.threshold)) continue;
            matchType = "SIMILARITY";
          } else if (rule.strategy === "normalized") {
            matchType = "POTENTIAL";
          }
          const created = upsertCandidate(
            db,
            {
              tenantId,
              domainId: catalog?.domain_id ?? null,
              objectType: type,
              objectId: left.id,
              matched: right,
              rule,
              strategy: rule.strategy,
              score,
              matchType,
            },
            actor
          );
          if (created) detected.push(publicDuplicateCandidate(created));
        }
      }
    }
  }
  writeAudit(db, {
    actor,
    action: "data_quality.duplicates.detect",
    resourceType: "dg_duplicate_candidate",
    resourceId: type,
    details: { object_type: type, detected: detected.length, scanned: records.length },
    ip,
  });
  return { object_type: type, rules: rules.length, scanned: records.length, detected: detected.length, candidates: detected };
}

export function listCandidates(db, { tenantId, objectType, objectId, status, strategy, page, pageSize, page_size } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(String(objectType).toLowerCase());
  }
  if (objectId) {
    clauses.push("(object_id = ? OR matched_object_id = ?)");
    params.push(String(objectId), String(objectId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status).toUpperCase());
  }
  if (strategy) {
    clauses.push("strategy = ?");
    params.push(String(strategy).toLowerCase());
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const pageNumber = Math.max(1, Number(page) || 1);
  const size = Math.min(500, Math.max(1, Number(pageSize ?? page_size) || 50));
  const offset = (pageNumber - 1) * size;
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dg_duplicate_candidates ${where}`, params)?.c ?? 0);
  const rows = queryAll(db, `SELECT * FROM dg_duplicate_candidates ${where} ORDER BY detected_at DESC LIMIT ? OFFSET ?`, [...params, size, offset]);
  return { items: rows.map(publicDuplicateCandidate), total, page: pageNumber, page_size: size };
}

export function resolveCandidate(db, ref, { status, resolution = "" } = {}, actor = null, ip = null) {
  const row = queryOne(db, "SELECT * FROM dg_duplicate_candidates WHERE candidate_ref = ?", [String(ref)]) || queryOne(db, "SELECT * FROM dg_duplicate_candidates WHERE id = ?", [Number(ref)]);
  if (!row) throw duplicateNotFound(ref);
  const next = normalizeText(status, "DISMISSED").toUpperCase();
  if (!["OPEN", "REVIEWING", "CONFIRMED", "DISMISSED", "MERGED"].includes(next)) {
    throw invalidRule(`Unknown duplicate status: ${next}`);
  }
  run(db, "UPDATE dg_duplicate_candidates SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?", [
    next,
    normalizeText(resolution),
    actor?.id ?? null,
    nowIso(),
    nowIso(),
    row.id,
  ]);
  const updated = queryOne(db, "SELECT * FROM dg_duplicate_candidates WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "data_quality.duplicates.resolve",
    resourceType: "dg_duplicate_candidate",
    resourceId: row.id,
    details: { candidate_ref: row.candidate_ref, from: row.status, to: next },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DuplicateCandidateResolved",
    tenantId: row.tenant_id,
    objectType: row.object_type,
    objectId: row.object_id,
    payload: { candidate_ref: row.candidate_ref, status: next, resolution: normalizeText(resolution) },
  }, actor);
  return publicDuplicateCandidate(updated);
}

export function duplicateSummary(db, { tenantId } = {}) {
  const rows = queryAll(
    db,
    "SELECT status, COUNT(*) AS c FROM dg_duplicate_candidates WHERE tenant_id = ? GROUP BY status",
    [Number(tenantId)]
  );
  const byStatus = {};
  let total = 0;
  for (const row of rows) {
    total += Number(row.c);
    byStatus[row.status] = Number(row.c);
  }
  return { total, by_status: byStatus };
}

export { valuePreview };

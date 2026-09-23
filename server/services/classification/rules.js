// Classification rules: reusable, class-scoped validation constraints. Rules are
// data (type + config) and are evaluated by the validation service; the rule
// engine is deliberately small and deterministic (no expression sandbox is
// needed because a rule's config is a fixed schema per type).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { publicRule } from "./repository.js";
import { ruleRef } from "./refs.js";
import { normalizeText, normalizeUpper, parseObject, assertRuleType, assertSeverity } from "./validation.js";
import { ruleNotFound, invalidRule } from "./errors.js";
import { recordChange } from "./history.js";
import { invalidate } from "./cache.js";

export function getRuleRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM cla_rules WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  }
  return queryOne(db, "SELECT * FROM cla_rules WHERE tenant_id = ? AND rule_ref = ?", [Number(tenantId), String(ref)]);
}

export function requireRuleRow(db, tenantId, ref) {
  const row = getRuleRow(db, tenantId, ref);
  if (!row) throw ruleNotFound(ref);
  return row;
}

export function createRule(db, tenantId, body = {}, actor = null, ip = null) {
  const ruleType = assertRuleType(body.rule_type ?? body.ruleType);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO cla_rules (rule_ref, tenant_id, class_id, characteristic_id, rule_type, config_json, severity, message, status, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ruleRef(`${ruleType}_${body.class_id ?? "global"}`),
      Number(tenantId),
      body.class_id != null ? Number(body.class_id) : null,
      body.characteristic_id != null ? Number(body.characteristic_id) : null,
      ruleType,
      JSON.stringify(parseObject(body.config, {})),
      assertSeverity(body.severity || "ERROR"),
      normalizeText(body.message, { max: 500 }),
      normalizeUpper(body.status || "ACTIVE") === "INACTIVE" ? "INACTIVE" : "ACTIVE",
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  invalidate(tenantId);
  const row = queryOne(db, "SELECT * FROM cla_rules WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordChange(db, { tenantId, entityType: "RULE", entityId: row.id, entityRef: row.rule_ref, action: "CREATED", after: publicRule(row), actor, ip });
  return publicRule(row);
}

export function listRules(db, tenantId, { classId, characteristicId, ruleType, status } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (classId != null) {
    clauses.push("class_id = ?");
    params.push(Number(classId));
  }
  if (characteristicId != null) {
    clauses.push("characteristic_id = ?");
    params.push(Number(characteristicId));
  }
  if (ruleType) {
    clauses.push("rule_type = ?");
    params.push(assertRuleType(ruleType));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  const rows = queryAll(db, `SELECT * FROM cla_rules WHERE ${clauses.join(" AND ")} ORDER BY id`, params);
  return { items: rows.map(publicRule), total: rows.length };
}

export function updateRule(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const row = requireRuleRow(db, tenantId, ref);
  run(
    db,
    "UPDATE cla_rules SET config_json = ?, severity = ?, message = ?, status = ?, updated_by = ?, updated_at = ? WHERE id = ?",
    [
      body.config === undefined ? row.config_json : JSON.stringify(parseObject(body.config, {})),
      body.severity === undefined ? row.severity : assertSeverity(body.severity),
      body.message === undefined ? row.message : normalizeText(body.message, { max: 500 }),
      body.status === undefined ? row.status : normalizeUpper(body.status) === "INACTIVE" ? "INACTIVE" : "ACTIVE",
      actor?.id ?? null,
      nowIso(),
      row.id,
    ]
  );
  invalidate(tenantId);
  const after = publicRule(queryOne(db, "SELECT * FROM cla_rules WHERE id = ?", [row.id]));
  recordChange(db, { tenantId, entityType: "RULE", entityId: row.id, entityRef: row.rule_ref, action: "UPDATED", before: publicRule(row), after, actor, ip });
  return after;
}

export function deleteRule(db, tenantId, ref, actor = null, ip = null) {
  const row = requireRuleRow(db, tenantId, ref);
  run(db, "DELETE FROM cla_rules WHERE id = ?", [row.id]);
  invalidate(tenantId);
  return { deleted: true, id: row.id };
}

// Evaluates the active rules for a class (and its ancestors) against a value map
// keyed by characteristic id or code. Returns validation issues; never throws.
export function evaluateRules(db, tenantId, classIds, valuesByCharacteristic, effectiveByCode) {
  if (!classIds || !classIds.length) return [];
  const placeholders = classIds.map(() => "?").join(", ");
  const rules = queryAll(
    db,
    `SELECT * FROM cla_rules WHERE tenant_id = ? AND status = 'ACTIVE' AND (class_id IS NULL OR class_id IN (${placeholders})) ORDER BY id`,
    [Number(tenantId), ...classIds.map(Number)]
  );
  const issues = [];
  for (const rule of rules) {
    const config = parseObject(rule.config_json, {});
    const key = rule.characteristic_id != null ? Number(rule.characteristic_id) : null;
    const values = key != null ? valuesByCharacteristic.get(key) || [] : [];
    const first = values[0] ? values[0].value : undefined;
    const severity = rule.severity === "ERROR" ? "error" : rule.severity === "WARNING" ? "warning" : "info";
    const base = { rule_id: rule.id, rule_type: rule.rule_type, severity, message: rule.message || `${rule.rule_type} rule failed`, characteristic_id: key };
    switch (rule.rule_type) {
      case "REQUIRED":
        if (values.length === 0 || values.every((entry) => entry.value === "" || entry.value === null || entry.value === undefined)) {
          issues.push({ ...base, code: "RULE_REQUIRED" });
        }
        break;
      case "RANGE": {
        if (first === undefined || first === null || first === "") break;
        const n = Number(first);
        if (config.min !== undefined && n < Number(config.min)) issues.push({ ...base, code: "RULE_RANGE_MIN", value: n });
        if (config.max !== undefined && n > Number(config.max)) issues.push({ ...base, code: "RULE_RANGE_MAX", value: n });
        break;
      }
      case "ENUM": {
        if (first === undefined || first === null || first === "") break;
        const allowed = Array.isArray(config.values) ? config.values.map((entry) => normalizeUpper(entry)) : [];
        if (allowed.length && !allowed.includes(normalizeUpper(first))) issues.push({ ...base, code: "RULE_ENUM", value: first, allowed });
        break;
      }
      case "REGEX": {
        if (first === undefined || first === null || first === "") break;
        if (typeof config.pattern === "string") {
          try {
            if (!new RegExp(config.pattern).test(String(first))) issues.push({ ...base, code: "RULE_REGEX", value: first });
          } catch {
            issues.push({ ...base, code: "RULE_REGEX_INVALID", message: "Rule pattern is not a valid regular expression" });
          }
        }
        break;
      }
      case "MULTI_VALUE": {
        if (config.min_items !== undefined && values.length < Number(config.min_items)) issues.push({ ...base, code: "RULE_MIN_ITEMS", value: values.length });
        if (config.max_items !== undefined && values.length > Number(config.max_items)) issues.push({ ...base, code: "RULE_MAX_ITEMS", value: values.length });
        break;
      }
      case "UNIT": {
        if (!values.length) break;
        const effective = effectiveByCode.get(key);
        const expected = config.unit || effective?.base_unit || effective?.unit;
        for (const entry of values) {
          if (entry.unit && expected && normalizeUpper(entry.unit) !== normalizeUpper(expected)) {
            issues.push({ ...base, code: "RULE_UNIT", value: entry.unit, expected });
          }
        }
        break;
      }
      case "REFERENCE":
        if (values.length && config.required !== false && !first) issues.push({ ...base, code: "RULE_REFERENCE" });
        break;
      case "EXPRESSION":
        // Expression rules are intentionally not supported by the classification
        // engine; they belong to the configuration/rules framework. Surfaced as
        // info so authors know the rule was not evaluated.
        issues.push({ ...base, code: "RULE_EXPRESSION_UNSUPPORTED", severity: "info" });
        break;
      default:
        break;
    }
  }
  return issues;
}

export { invalidRule };

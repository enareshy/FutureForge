// PDM configuration rule service.
//
// A configuration rule evaluates a set of conditions (variant / feature / option
// / effectivity / expression) against a runtime configuration context and
// decides applicability. Structure resolution, baseline creation and validation
// all funnel through `evaluateConfigurationRule`, so configuration semantics live
// in exactly one place. Rule configuration is versioned and cached per tenant.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow, bumpVersion } from "./sql.js";
import { publicConfigurationRule, publicRuleVersion } from "./repository.js";
import { configurationRuleRef } from "./refs.js";
import { bumpEpoch, invalidate } from "./cache.js";
import { recordChange } from "./history.js";
import { publishPdmEvent, pdmEventCode } from "./events.js";
import { getConfig } from "./configuration.js";
import { normalizeConfigurationRuleInput, normalizeText, normalizeUpper, assertRuleStatus, assertConfigurationOperator, paginate } from "./validation.js";
import { configurationRuleNotFound, configurationRuleConflict, invalidConfigurationRule } from "./errors.js";
import { SOURCE_MODULE } from "./constants.js";

const UPDATE_COLUMNS = [
  "name",
  "description",
  "rule_type",
  "status",
  "priority",
  "sequence",
  "is_default",
  "current_version_id",
  "version_number",
  "config_json",
  "metadata_json",
  "version",
  "updated_by",
];

export function getConfigurationRuleRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM pdm_configuration_rules WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(db, "SELECT * FROM pdm_configuration_rules WHERE tenant_id = ? AND (rule_ref = ? OR code = ? COLLATE NOCASE)", [Number(tenantId), String(ref), String(ref)]);
}

export function requireConfigurationRuleRow(db, tenantId, ref) {
  const row = getConfigurationRuleRow(db, tenantId, ref);
  if (!row) throw configurationRuleNotFound(ref);
  return row;
}

export function getConfigurationRule(db, tenantId, ref) {
  return publicConfigurationRule(requireConfigurationRuleRow(db, tenantId, ref));
}

export function listConfigurationRules(db, { tenantId, status, ruleType, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(assertRuleStatus(status));
  }
  if (ruleType) {
    clauses.push("rule_type = ?");
    params.push(String(ruleType).toUpperCase());
  }
  if (q) {
    clauses.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${normalizeText(q, { max: 120 })}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pdm_configuration_rules ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pdm_configuration_rules ${where} ORDER BY priority, sequence, id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicConfigurationRule), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function createConfigurationRule(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeConfigurationRuleInput(body, {});
  if (queryOne(db, "SELECT id FROM pdm_configuration_rules WHERE tenant_id = ? AND code = ?", [tenant, normalized.code])) throw configurationRuleConflict(normalized.code);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO pdm_configuration_rules
       (rule_ref, tenant_id, organization_id, code, name, description, rule_type, status, priority, sequence, is_default,
        current_version_id, version_number, config_json, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, 1, ?, ?, ?, ?)`,
    [
      configurationRuleRef(normalized.code),
      tenant,
      normalized.organization_id,
      normalized.code,
      normalized.name,
      normalized.description,
      normalized.rule_type,
      normalized.status,
      normalized.priority,
      normalized.sequence,
      normalized.is_default ? 1 : 0,
      JSON.stringify(normalized.config || {}),
      JSON.stringify(normalized.metadata || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM pdm_configuration_rules WHERE id = ?", [Number(result.lastInsertRowid)]);
  const version = run(
    db,
    "INSERT INTO pdm_configuration_rule_versions (tenant_id, rule_id, version_number, rule_type, config_json, status, change_note, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)",
    [tenant, row.id, row.rule_type, row.config_json, row.status, "Initial version", actor?.id ?? null, ts]
  );
  updateRow(db, "pdm_configuration_rules", row.id, { current_version_id: Number(version.lastInsertRowid) }, { columns: ["current_version_id"] });
  const finalRow = queryOne(db, "SELECT * FROM pdm_configuration_rules WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "CONFIGURATION_RULE", entityId: row.id, entityRef: row.rule_ref, action: "CREATED", version: 1, status: row.status, after: publicConfigurationRule(finalRow), actor, ip });
  publishPdmEvent(db, { eventType: pdmEventCode("CONFIGURATION_RULE_CREATED"), objectType: "pdm_configuration_rule", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { rule_ref: row.rule_ref, rule_type: row.rule_type } }, actor);
  return publicConfigurationRule(finalRow);
}

export function updateConfigurationRule(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireConfigurationRuleRow(db, tenant, ref);
  const before = publicConfigurationRule(row);
  const normalized = normalizeConfigurationRuleInput(body, row);
  updateRow(
    db,
    "pdm_configuration_rules",
    row.id,
    {
      name: normalized.name,
      description: normalized.description,
      rule_type: normalized.rule_type,
      status: normalized.status,
      priority: normalized.priority,
      sequence: normalized.sequence,
      is_default: normalized.is_default ? 1 : 0,
      config_json: JSON.stringify(normalized.config || {}),
      metadata_json: JSON.stringify(normalized.metadata || {}),
      version: bumpVersion(row),
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM pdm_configuration_rules WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "CONFIGURATION_RULE", entityId: row.id, entityRef: row.rule_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicConfigurationRule(updated), actor, ip });
  return publicConfigurationRule(updated);
}

export function activateConfigurationRule(db, tenantId, ref, actor = null, ip = null) {
  return setConfigurationRuleStatus(db, tenantId, ref, "ACTIVE", actor, ip);
}

export function setConfigurationRuleStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireConfigurationRuleRow(db, tenant, ref);
  const next = assertRuleStatus(status);
  const before = publicConfigurationRule(row);
  updateRow(db, "pdm_configuration_rules", row.id, { status: next, version: bumpVersion(row), updated_by: actor?.id ?? null }, { columns: UPDATE_COLUMNS });
  const updated = queryOne(db, "SELECT * FROM pdm_configuration_rules WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "CONFIGURATION_RULE", entityId: row.id, entityRef: row.rule_ref, action: "STATUS_CHANGED", version: updated.version, status: next, before, after: publicConfigurationRule(updated), actor, ip });
  if (next === "ACTIVE") {
    publishPdmEvent(db, { eventType: pdmEventCode("CONFIGURATION_RULE_ACTIVATED"), objectType: "pdm_configuration_rule", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { rule_ref: row.rule_ref } }, actor);
  }
  return publicConfigurationRule(updated);
}

export function publishConfigurationRuleVersion(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireConfigurationRuleRow(db, tenant, ref);
  const config = body.config ? { ...body.config } : JSON.parse(row.config_json || "{}");
  const nextVersion = Number(row.version_number || 1) + 1;
  const ts = nowIso();
  const inserted = run(
    db,
    "INSERT INTO pdm_configuration_rule_versions (tenant_id, rule_id, version_number, rule_type, config_json, status, change_note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [tenant, row.id, nextVersion, body.rule_type ? String(body.rule_type).toUpperCase() : row.rule_type, JSON.stringify(config), body.status ? String(body.status).toUpperCase() : row.status, normalizeText(body.change_note ?? body.changeNote ?? "", { max: 1000 }), actor?.id ?? null, ts]
  );
  updateRow(
    db,
    "pdm_configuration_rules",
    row.id,
    { current_version_id: Number(inserted.lastInsertRowid), version_number: nextVersion, config_json: JSON.stringify(config), rule_type: body.rule_type ? String(body.rule_type).toUpperCase() : row.rule_type, version: bumpVersion(row), updated_by: actor?.id ?? null },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM pdm_configuration_rules WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "CONFIGURATION_RULE", entityId: row.id, entityRef: row.rule_ref, action: "VERSION_PUBLISHED", version: updated.version, status: updated.status, after: publicConfigurationRule(updated), actor, ip, details: { version_number: nextVersion } });
  publishPdmEvent(db, { eventType: pdmEventCode("CONFIGURATION_RULE_VERSION_PUBLISHED"), objectType: "pdm_configuration_rule", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { rule_ref: row.rule_ref, version_number: nextVersion } }, actor);
  return publicConfigurationRule(updated);
}

export function listConfigurationRuleVersions(db, tenantId, ref) {
  const row = requireConfigurationRuleRow(db, tenantId, ref);
  return queryAll(db, "SELECT * FROM pdm_configuration_rule_versions WHERE rule_id = ? ORDER BY version_number DESC", [row.id]).map(publicRuleVersion);
}

export function deleteConfigurationRule(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireConfigurationRuleRow(db, tenant, ref);
  const before = publicConfigurationRule(row);
  run(db, "DELETE FROM pdm_configuration_rule_versions WHERE rule_id = ?", [row.id]);
  run(db, "DELETE FROM pdm_configuration_rules WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "CONFIGURATION_RULE", entityId: row.id, entityRef: row.rule_ref, action: "DELETED", version: row.version, status: row.status, before, actor, ip });
  return { deleted: true, id: row.id, rule_ref: row.rule_ref };
}

// ── Evaluation ───────────────────────────────────────────────────────────────

export function defaultConfigurationRuleRow(db, tenantId) {
  const explicit = queryOne(db, "SELECT * FROM pdm_configuration_rules WHERE tenant_id = ? AND status = 'ACTIVE' AND is_default = 1 ORDER BY priority, sequence, id LIMIT 1", [Number(tenantId)]);
  if (explicit) return explicit;
  const preferred = normalizeUpper(getConfig(db, tenantId, "configuration_rule_default") || "VARIANT");
  const byType = queryOne(db, "SELECT * FROM pdm_configuration_rules WHERE tenant_id = ? AND status = 'ACTIVE' AND rule_type = ? ORDER BY priority, sequence, id LIMIT 1", [Number(tenantId), preferred]);
  if (byType) return byType;
  return queryOne(db, "SELECT * FROM pdm_configuration_rules WHERE tenant_id = ? AND status = 'ACTIVE' ORDER BY priority, sequence, id LIMIT 1", [Number(tenantId)]);
}

// Evaluates a single rule against `context`. Returns a deterministic result
// object; conditions are combined with `match` (ALL by default).
export function evaluateConfigurationRule(db, tenantId, { ruleId = null, ruleCode = null, rule = null, context = {} } = {}) {
  const tenant = Number(tenantId);
  const ruleRow = rule ? rule : ruleId != null || ruleCode ? requireConfigurationRuleRow(db, tenant, ruleId ?? ruleCode) : defaultConfigurationRuleRow(db, tenant);
  if (!ruleRow) throw configurationRuleNotFound(ruleCode || ruleId || "default");
  return evaluateRuleRow(ruleRow, context);
}

export function evaluateRuleRow(ruleRow, context = {}) {
  const config = JSON.parse(ruleRow.config_json || "{}");
  const conditions = Array.isArray(config.conditions) ? config.conditions : [];
  const match = String(config.match || "ALL").toUpperCase();
  const results = conditions.map((condition) => evaluateCondition(condition, context));
  const applicable = conditions.length === 0 ? true : match === "ANY" ? results.some((r) => r.matched) : results.every((r) => r.matched);
  return {
    source_module: SOURCE_MODULE,
    rule: { id: ruleRow.id, rule_ref: ruleRow.rule_ref, code: ruleRow.code, rule_type: ruleRow.rule_type, version_number: ruleRow.version_number },
    applicable,
    match,
    matched_conditions: results.filter((r) => r.matched).map((r) => r.field),
    failed_conditions: results.filter((r) => !r.matched).map((r) => r.field),
    results,
    context: context || {},
  };
}

// Evaluates every active configuration rule and returns the matched subset.
// Ordering is priority/sequence then id so downstream consumers are stable.
export function evaluateConfigurationRules(db, tenantId, context = {}) {
  const rows = queryAll(db, "SELECT * FROM pdm_configuration_rules WHERE tenant_id = ? AND status = 'ACTIVE' ORDER BY priority, sequence, id", [Number(tenantId)]);
  const evaluated = rows.map((row) => evaluateRuleRow(row, context));
  return {
    source_module: SOURCE_MODULE,
    matched: evaluated.filter((entry) => entry.applicable),
    evaluated,
    context: context || {},
  };
}

export function evaluateCondition(condition = {}, context = {}) {
  const operator = assertConfigurationOperator(condition.operator ?? condition.op ?? "EQUALS");
  const field = normalizeText(condition.field ?? condition.key ?? "", { max: 120 });
  const expected = condition.value ?? condition.values ?? null;
  const actual = field ? readContext(context, field) : undefined;
  const values = Array.isArray(actual) ? actual.map(String) : actual === undefined || actual === null ? [] : [String(actual)];
  let matched = false;
  switch (operator) {
    case "EQUALS":
      matched = values.some((value) => value === String(expected));
      break;
    case "NOT_EQUALS":
      matched = !values.some((value) => value === String(expected));
      break;
    case "IN": {
      const list = Array.isArray(expected) ? expected.map(String) : [String(expected)];
      matched = values.some((value) => list.includes(value));
      break;
    }
    case "NOT_IN": {
      const list = Array.isArray(expected) ? expected.map(String) : [String(expected)];
      matched = !values.some((value) => list.includes(value));
      break;
    }
    case "EXISTS":
      matched = actual !== undefined && actual !== null && String(actual) !== "";
      break;
    case "GREATER_THAN":
      matched = values.some((value) => Number(value) > Number(expected));
      break;
    case "LESS_THAN":
      matched = values.some((value) => Number(value) < Number(expected));
      break;
    default:
      matched = false;
  }
  return { field, operator, expected, actual: actual ?? null, matched };
}

function readContext(context, path) {
  const segments = String(path).split(".");
  let current = context;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

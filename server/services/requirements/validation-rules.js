// Requirement validation rules: configurable, tenant-scoped data-quality and
// traceability checks. Rules are stored as data (never hard-coded), evaluated
// against requirement rows, and surfaced as non-fatal violations with a
// severity. This is Requirements Manager's own ruleset; cross-object business
// rule engines elsewhere on the platform are untouched.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { updateRow, updateRowAsync } from "./sql.js";
import { publicValidationRule, publicRequirement } from "./repository.js";
import { normalizeText, normalizeUpper, parseObject, paginate, assertSeverity, assertRuleType } from "./validation.js";
import { invalidConfiguration } from "./errors.js";
import { SOURCE_MODULE } from "./constants.js";

const UPDATE_COLUMNS = ["name", "description", "rule_type", "target_attribute", "requirement_type", "severity", "condition_json", "parameters_json", "message", "status", "updated_by"];

function normalizeRuleInput(body = {}, current = {}) {
  return {
    code: normalizeText(body.code ?? current.code, { max: 80 }),
    name: normalizeText(body.name ?? current.name, { max: 200 }),
    description: normalizeText(body.description ?? current.description, { max: 4000 }),
    rule_type: assertRuleType(body.rule_type ?? body.ruleType ?? current.rule_type ?? "REQUIRED"),
    target_attribute: normalizeText(body.target_attribute ?? body.targetAttribute ?? current.target_attribute, { max: 80 }) || null,
    requirement_type: normalizeText(body.requirement_type ?? body.requirementType ?? current.requirement_type, { max: 80 }) || null,
    severity: assertSeverity(body.severity ?? current.severity ?? "ERROR"),
    condition: body.condition && typeof body.condition === "object" ? body.condition : parseObject(current.condition_json, {}),
    parameters: body.parameters && typeof body.parameters === "object" ? body.parameters : parseObject(current.parameters_json, {}),
    message: normalizeText(body.message ?? current.message, { max: 500 }),
    status: normalizeUpper(body.status ?? current.status ?? "ACTIVE"),
  };
}

function ruleFilters({ tenantId, status, rule_type, requirement_type, q } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (rule_type) {
    clauses.push("rule_type = ?");
    params.push(normalizeUpper(rule_type));
  }
  if (requirement_type) {
    clauses.push("(requirement_type IS NULL OR requirement_type = ?)");
    params.push(requirement_type);
  }
  if (q) {
    const like = `%${normalizeText(q, { max: 120 })}%`;
    clauses.push("(code ILIKE ? OR name ILIKE ?)");
    params.push(like, like);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listValidationRules(db, opts = {}) {
  const { where, params } = ruleFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM requirement_validation_rules ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM requirement_validation_rules ${where} ORDER BY code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicValidationRule), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listValidationRulesAsync(db, opts = {}) {
  const { where, params } = ruleFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM requirement_validation_rules ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM requirement_validation_rules ${where} ORDER BY code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicValidationRule), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export function getValidationRuleRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM requirement_validation_rules WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOne(db, "SELECT * FROM requirement_validation_rules WHERE tenant_id = ? AND lower(code) = lower(?)", [Number(tenantId), String(ref)]);
}

export async function getValidationRuleRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM requirement_validation_rules WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOneAsync(db, "SELECT * FROM requirement_validation_rules WHERE tenant_id = ? AND lower(code) = lower(?)", [Number(tenantId), String(ref)]);
}

export function getValidationRule(db, tenantId, ref) {
  return publicValidationRule(getValidationRuleRow(db, tenantId, ref));
}

export async function getValidationRuleAsync(db, tenantId, ref) {
  return publicValidationRule(await getValidationRuleRowAsync(db, tenantId, ref));
}

export function createValidationRule(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeRuleInput(body, {});
  if (!input.code) throw invalidConfiguration("code is required");
  if (!input.name) throw invalidConfiguration("name is required");
  if (queryOne(db, "SELECT id FROM requirement_validation_rules WHERE tenant_id = ? AND lower(code) = lower(?)", [tenant, input.code])) {
    throw invalidConfiguration(`Validation rule already exists: ${input.code}`);
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO requirement_validation_rules
       (tenant_id, code, name, description, rule_type, target_attribute, requirement_type, severity, condition_json, parameters_json,
        message, status, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [tenant, input.code, input.name, input.description, input.rule_type, input.target_attribute, input.requirement_type, input.severity, JSON.stringify(input.condition), JSON.stringify(input.parameters), input.message, input.status, actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const row = queryOne(db, "SELECT * FROM requirement_validation_rules WHERE id = ?", [Number(result.lastInsertId)]);
  writeAudit(db, { actor, action: "requirements.validation_rule.create", resourceType: "requirement_validation_rule", resourceId: row.code, details: { rule_type: row.rule_type }, ip });
  return publicValidationRule(row);
}

export async function createValidationRuleAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeRuleInput(body, {});
  if (!input.code) throw invalidConfiguration("code is required");
  if (!input.name) throw invalidConfiguration("name is required");
  if (await queryOneAsync(db, "SELECT id FROM requirement_validation_rules WHERE tenant_id = ? AND lower(code) = lower(?)", [tenant, input.code])) {
    throw invalidConfiguration(`Validation rule already exists: ${input.code}`);
  }
  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO requirement_validation_rules
       (tenant_id, code, name, description, rule_type, target_attribute, requirement_type, severity, condition_json, parameters_json,
        message, status, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [tenant, input.code, input.name, input.description, input.rule_type, input.target_attribute, input.requirement_type, input.severity, JSON.stringify(input.condition), JSON.stringify(input.parameters), input.message, input.status, actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const row = await queryOneAsync(db, "SELECT * FROM requirement_validation_rules WHERE id = ?", [Number(result.lastInsertId)]);
  await writeAuditAsync(db, { actor, action: "requirements.validation_rule.create", resourceType: "requirement_validation_rule", resourceId: row.code, details: { rule_type: row.rule_type }, ip });
  return publicValidationRule(row);
}

export function updateValidationRule(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = getValidationRuleRow(db, tenant, ref);
  if (!row) throw invalidConfiguration(`Validation rule not found: ${ref}`);
  const input = normalizeRuleInput(body, row);
  const patch = {
    name: input.name,
    description: input.description,
    rule_type: input.rule_type,
    target_attribute: input.target_attribute,
    requirement_type: input.requirement_type,
    severity: input.severity,
    condition_json: JSON.stringify(input.condition),
    parameters_json: JSON.stringify(input.parameters),
    message: input.message,
    status: input.status,
    updated_by: actor?.id ?? null,
  };
  updateRow(db, "requirement_validation_rules", row.id, patch, { columns: UPDATE_COLUMNS });
  writeAudit(db, { actor, action: "requirements.validation_rule.update", resourceType: "requirement_validation_rule", resourceId: row.code, details: { status: input.status }, ip });
  return publicValidationRule(queryOne(db, "SELECT * FROM requirement_validation_rules WHERE id = ?", [row.id]));
}

export async function updateValidationRuleAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await getValidationRuleRowAsync(db, tenant, ref);
  if (!row) throw invalidConfiguration(`Validation rule not found: ${ref}`);
  const input = normalizeRuleInput(body, row);
  const patch = {
    name: input.name,
    description: input.description,
    rule_type: input.rule_type,
    target_attribute: input.target_attribute,
    requirement_type: input.requirement_type,
    severity: input.severity,
    condition_json: JSON.stringify(input.condition),
    parameters_json: JSON.stringify(input.parameters),
    message: input.message,
    status: input.status,
    updated_by: actor?.id ?? null,
  };
  await updateRowAsync(db, "requirement_validation_rules", row.id, patch, { columns: UPDATE_COLUMNS });
  await writeAuditAsync(db, { actor, action: "requirements.validation_rule.update", resourceType: "requirement_validation_rule", resourceId: row.code, details: { status: input.status }, ip });
  return publicValidationRule(await queryOneAsync(db, "SELECT * FROM requirement_validation_rules WHERE id = ?", [row.id]));
}

export function deleteValidationRule(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = getValidationRuleRow(db, tenant, ref);
  if (!row) throw invalidConfiguration(`Validation rule not found: ${ref}`);
  run(db, "DELETE FROM requirement_validation_rules WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "requirements.validation_rule.delete", resourceType: "requirement_validation_rule", resourceId: row.code, details: {}, ip });
  return { deleted: true, code: row.code };
}

export async function deleteValidationRuleAsync(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await getValidationRuleRowAsync(db, tenant, ref);
  if (!row) throw invalidConfiguration(`Validation rule not found: ${ref}`);
  await runAsync(db, "DELETE FROM requirement_validation_rules WHERE id = ?", [row.id]);
  await writeAuditAsync(db, { actor, action: "requirements.validation_rule.delete", resourceType: "requirement_validation_rule", resourceId: row.code, details: {}, ip });
  return { deleted: true, code: row.code };
}

function isEmpty(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

function evaluateRule(db, tenant, rule, requirement) {
  const attribute = rule.target_attribute;
  if (!attribute) return null;
  const value = requirement[attribute];
  const params = parseObject(rule.parameters_json, {});
  const raw = requirement[attribute.replace(/_json$/, "")] ?? value;
  const violation = (detail) => ({
    rule_code: rule.code,
    rule_type: rule.rule_type,
    severity: rule.severity,
    target_attribute: attribute,
    message: rule.message || detail,
    detail,
  });
  switch (rule.rule_type) {
    case "REQUIRED":
      return isEmpty(value) ? violation(`${attribute} is required`) : null;
    case "REGEX": {
      const pattern = params.pattern;
      if (!pattern) return null;
      try {
        return !new RegExp(pattern).test(String(value ?? "")) ? violation(`${attribute} does not match ${pattern}`) : null;
      } catch {
        return null;
      }
    }
    case "LENGTH": {
      const text = String(value ?? "");
      if (params.min != null && text.length < Number(params.min)) return violation(`${attribute} is shorter than ${params.min}`);
      if (params.max != null && text.length > Number(params.max)) return violation(`${attribute} is longer than ${params.max}`);
      return null;
    }
    case "RANGE": {
      if (value == null || value === "") return null;
      const numeric = Number(value);
      if (Number.isNaN(numeric)) return violation(`${attribute} is not numeric`);
      if (params.min != null && numeric < Number(params.min)) return violation(`${attribute} is below ${params.min}`);
      if (params.max != null && numeric > Number(params.max)) return violation(`${attribute} is above ${params.max}`);
      return null;
    }
    case "UNIQUE": {
      if (isEmpty(value)) return null;
      const dup = queryOne(db, `SELECT id FROM requirements WHERE tenant_id = ? AND ${attribute} = ? AND id <> ?`, [tenant, value, requirement.id]);
      return dup ? violation(`${attribute} must be unique`) : null;
    }
    case "RELATIONSHIP": {
      const relType = params.relationship_type || rule.condition?.relationship_type;
      const min = Number(params.min ?? 1);
      if (!relType) return null;
      const count = Number(queryOne(db, "SELECT COUNT(*) AS c FROM requirement_relationships WHERE tenant_id = ? AND relationship_type = ? AND ((source_type = 'requirement' AND source_id = ?) OR (target_type = 'requirement' AND target_id = ?))", [tenant, relType, String(requirement.id), String(requirement.id)])?.c || 0);
      return count < min ? violation(`${attribute} requires at least ${min} ${relType} relationship(s)`) : null;
    }
    case "EXPRESSION": {
      const operator = params.operator || rule.condition?.operator;
      const expected = params.value ?? rule.condition?.value;
      if (!operator) return null;
      const actual = raw;
      let ok = true;
      switch (operator) {
        case "EQUALS": ok = String(actual ?? "") === String(expected ?? ""); break;
        case "NOT_EQUALS": ok = String(actual ?? "") !== String(expected ?? ""); break;
        case "IN": ok = Array.isArray(expected) ? expected.map(String).includes(String(actual ?? "")) : false; break;
        case "TRUTHY": ok = !isEmpty(actual); break;
        case "FALSY": ok = isEmpty(actual); break;
        default: ok = true;
      }
      return !ok ? violation(`${attribute} violates ${operator}`) : null;
    }
    default:
      return null;
  }
}

function loadActiveRules(db, tenant, requirementType) {
  return queryAll(
    db,
    "SELECT * FROM requirement_validation_rules WHERE tenant_id = ? AND status = 'ACTIVE' AND (requirement_type IS NULL OR requirement_type = ?) ORDER BY code",
    [tenant, requirementType || ""]
  );
}

export function validateRequirement(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const requirement = queryOne(db, "SELECT * FROM requirements WHERE tenant_id = ? AND (id = ? OR requirement_ref = ? OR lower(requirement_number) = lower(?))", [tenant, Number(ref) || -1, String(ref), String(ref)]);
  if (!requirement) return { requirement_id: null, violations: [], valid: true, source_module: SOURCE_MODULE };
  const rules = loadActiveRules(db, tenant, requirement.requirement_type);
  const violations = [];
  for (const rule of rules) {
    const v = evaluateRule(db, tenant, rule, requirement);
    if (v) violations.push(v);
  }
  const errors = violations.filter((v) => v.severity === "ERROR").length;
  return { requirement_id: requirement.id, requirement: publicRequirement(requirement), violations, error_count: errors, warning_count: violations.length - errors, valid: errors === 0, source_module: SOURCE_MODULE };
}

export async function validateRequirementAsync(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const requirement = await queryOneAsync(db, "SELECT * FROM requirements WHERE tenant_id = ? AND (id = ? OR requirement_ref = ? OR lower(requirement_number) = lower(?))", [tenant, Number(ref) || -1, String(ref), String(ref)]);
  if (!requirement) return { requirement_id: null, violations: [], valid: true, source_module: SOURCE_MODULE };
  const rules = await queryAllAsync(db, "SELECT * FROM requirement_validation_rules WHERE tenant_id = ? AND status = 'ACTIVE' AND (requirement_type IS NULL OR requirement_type = ?) ORDER BY code", [tenant, requirement.requirement_type || ""]);
  const violations = [];
  for (const rule of rules) {
    const v = evaluateRule(db, tenant, rule, requirement);
    if (v) violations.push(v);
  }
  const errors = violations.filter((v) => v.severity === "ERROR").length;
  return { requirement_id: requirement.id, requirement: publicRequirement(requirement), violations, error_count: errors, warning_count: violations.length - errors, valid: errors === 0, source_module: SOURCE_MODULE };
}

// Run the active ruleset across a set of requirements (optionally scoped by
// type/status). Bounded to keep the sweep predictable.
export function runValidation(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const clauses = ["tenant_id = ?"];
  const params = [tenant];
  const ids = opts.requirement_ids ?? opts.requirementIds;
  if (Array.isArray(ids) && ids.length) {
    clauses.push(`id IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids.map(Number));
  }
  if (opts.requirement_type || opts.requirementType) {
    clauses.push("requirement_type = ?");
    params.push(opts.requirement_type || opts.requirementType);
  }
  if (opts.status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(opts.status));
  }
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 2000);
  const rows = queryAll(db, `SELECT * FROM requirements WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`, [...params, limit]);
  const rules = loadActiveRules(db, tenant, opts.requirement_type || opts.requirementType || "");
  const results = [];
  let totalViolations = 0;
  for (const row of rows) {
    const violations = [];
    for (const rule of rules) {
      const v = evaluateRule(db, tenant, rule, row);
      if (v) violations.push(v);
    }
    totalViolations += violations.length;
    if (violations.length) results.push({ requirement_id: row.id, requirement_number: row.requirement_number, violations });
  }
  return { evaluated: rows.length, rule_count: rules.length, total_violations: totalViolations, results, source_module: SOURCE_MODULE };
}

export async function runValidationAsync(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const clauses = ["tenant_id = ?"];
  const params = [tenant];
  const ids = opts.requirement_ids ?? opts.requirementIds;
  if (Array.isArray(ids) && ids.length) {
    clauses.push(`id IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids.map(Number));
  }
  if (opts.requirement_type || opts.requirementType) {
    clauses.push("requirement_type = ?");
    params.push(opts.requirement_type || opts.requirementType);
  }
  if (opts.status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(opts.status));
  }
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 2000);
  const rows = await queryAllAsync(db, `SELECT * FROM requirements WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`, [...params, limit]);
  const rules = await queryAllAsync(db, "SELECT * FROM requirement_validation_rules WHERE tenant_id = ? AND status = 'ACTIVE' AND (requirement_type IS NULL OR requirement_type = ?) ORDER BY code", [tenant, opts.requirement_type || opts.requirementType || ""]);
  const results = [];
  let totalViolations = 0;
  for (const row of rows) {
    const violations = [];
    for (const rule of rules) {
      const v = evaluateRule(db, tenant, rule, row);
      if (v) violations.push(v);
    }
    totalViolations += violations.length;
    if (violations.length) results.push({ requirement_id: row.id, requirement_number: row.requirement_number, violations });
  }
  return { evaluated: rows.length, rule_count: rules.length, total_violations: totalViolations, results, source_module: SOURCE_MODULE };
}

const DEFAULT_RULES = [
  { code: "REQ_TITLE_REQUIRED", name: "Title is required", rule_type: "REQUIRED", target_attribute: "title", severity: "ERROR", message: "A requirement must have a title." },
  { code: "REQ_OWNER_REQUIRED", name: "Owner is required", rule_type: "REQUIRED", target_attribute: "owner_user_id", severity: "WARNING", message: "Assign an owner before release." },
  { code: "REQ_NUMBER_UNIQUE", name: "Requirement number is unique", rule_type: "UNIQUE", target_attribute: "requirement_number", severity: "ERROR", message: "Requirement numbers must be unique." },
];

export function ensureRequirementValidationRules(db, tenantId) {
  const tenant = Number(tenantId);
  let created = 0;
  for (const def of DEFAULT_RULES) {
    if (queryOne(db, "SELECT id FROM requirement_validation_rules WHERE tenant_id = ? AND code = ?", [tenant, def.code])) continue;
    createValidationRule(db, tenant, def, null, null);
    created += 1;
  }
  return { created };
}

export async function ensureRequirementValidationRulesAsync(db, tenantId) {
  const tenant = Number(tenantId);
  let created = 0;
  for (const def of DEFAULT_RULES) {
    if (await queryOneAsync(db, "SELECT id FROM requirement_validation_rules WHERE tenant_id = ? AND code = ?", [tenant, def.code])) continue;
    await createValidationRuleAsync(db, tenant, def, null, null);
    created += 1;
  }
  return { created };
}

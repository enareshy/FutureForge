import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { recordVersion } from "./versions.js";
import { assertReadable, assertMutable, tenantClause } from "./scope.js";
import { validateExpression, evaluate, evaluateValue } from "./expression.js";
import { findType } from "./types.js";
import { findForm } from "./forms.js";

export const RULE_CATEGORIES = ["validation", "visibility", "editability", "default", "dependency", "condition"];
export const RULE_STATUSES = ["draft", "active", "inactive"];

const ACTION_TYPES = new Set([
  "set_visible",
  "set_editable",
  "set_required",
  "set_default",
  "set_value",
  "clear_value",
  "require",
  "forbid",
  "error",
  "warn",
]);

function publicRule(row) {
  if (!row) return null;
  return {
    ...row,
    is_system: row.is_system === 1,
    condition: safeParse(row.condition_json, {}),
    actions: safeParse(row.actions_json, []),
  };
}

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeActions(raw, category) {
  if (raw === undefined || raw === null || raw === "") return [];
  const actions = Array.isArray(raw) ? raw : [raw];
  const normalized = [];
  for (const action of actions) {
    if (typeof action === "string") {
      normalized.push({ type: action });
      continue;
    }
    if (typeof action !== "object" || !action.type) {
      throw new HttpError(400, "Each rule action requires a type");
    }
    if (!ACTION_TYPES.has(action.type)) {
      throw new HttpError(400, `Unsupported rule action type: ${action.type}`);
    }
    if (["set_visible", "set_editable", "set_required", "set_default", "set_value", "clear_value", "require", "forbid"].includes(action.type) && !action.field) {
      throw new HttpError(400, `Rule action ${action.type} requires a field`);
    }
    normalized.push({
      type: action.type,
      field: action.field || "",
      value: action.value === undefined ? null : action.value,
      message: action.message || "",
      severity: action.severity || (action.type === "warn" ? "warning" : "error"),
    });
  }
  if (category === "validation" && !normalized.some((a) => a.type === "error" || a.type === "warn")) {
    normalized.push({ type: "error", field: "", message: "", severity: "error" });
  }
  return normalized;
}

function normalizeCondition(raw) {
  if (raw === undefined || raw === null || raw === "") return {};
  let condition = raw;
  if (typeof raw === "string") {
    try {
      condition = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "condition must be a JSON expression");
    }
  }
  if (typeof condition !== "object" || Array.isArray(condition)) {
    throw new HttpError(400, "condition must be an expression object");
  }
  if (!Object.keys(condition).length) return {};
  validateExpression(condition);
  return condition;
}

function resolveRuleScope(db, body, tenantId) {
  let typeId = body.type_id ?? body.typeId ?? null;
  let formId = body.form_id ?? body.formId ?? null;
  if (typeId) {
    const type = queryOne(db, "SELECT * FROM metadata_types WHERE id = ?", [Number(typeId)]);
    assertReadable(type, tenantId, "Type not found");
    typeId = type.id;
  }
  if (formId) {
    const form = queryOne(db, "SELECT * FROM metadata_forms WHERE id = ?", [Number(formId)]);
    assertReadable(form, tenantId, "Form not found");
    formId = form.id;
    if (!typeId) typeId = form.type_id;
  }
  return { typeId: typeId || null, formId: formId || null };
}

export function getRuleRow(db, id) {
  return queryOne(db, "SELECT * FROM metadata_rules WHERE id = ?", [Number(id)]);
}

export function getRule(db, id, tenantId) {
  const row = getRuleRow(db, id);
  assertReadable(row, tenantId, "Rule not found");
  return publicRule(row);
}

export function listRules(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("r", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.category) {
    if (!RULE_CATEGORIES.includes(query.category)) throw new HttpError(400, "Unknown rule category");
    where.push("r.category = ?");
    params.push(query.category);
  }
  if (query.status) {
    where.push("r.status = ?");
    params.push(query.status);
  }
  if (query.typeId || query.type_id) {
    where.push("r.type_id = ?");
    params.push(Number(query.typeId || query.type_id));
  }
  if (query.formId || query.form_id) {
    where.push("r.form_id = ?");
    params.push(Number(query.formId || query.form_id));
  }
  if (query.q) {
    where.push("(r.code LIKE ? OR r.name LIKE ? OR r.description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM metadata_rules r ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT r.*, t.code AS type_code, f.code AS form_code
     FROM metadata_rules r
     LEFT JOIN metadata_types t ON t.id = r.type_id
     LEFT JOIN metadata_forms f ON f.id = r.form_id
     ${clause} ORDER BY r.priority, r.code LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicRule);
  return { items, total, page, pageSize };
}

export function createRule(db, body, actor, ip, tenantId) {
  requireFields(body, ["code", "name", "category"]);
  validateCode(body.code, "Rule code");
  if (!RULE_CATEGORIES.includes(body.category)) {
    throw new HttpError(400, `category must be one of: ${RULE_CATEGORIES.join(", ")}`);
  }
  const { typeId, formId } = resolveRuleScope(db, body, tenantId);
  if (!typeId && !formId) throw new HttpError(400, "A rule must target a type or a form");
  const condition = normalizeCondition(body.condition ?? body.condition_json);
  const actions = normalizeActions(body.actions ?? body.actions_json, body.category);
  const status = body.status || "active";
  if (!RULE_STATUSES.includes(status)) throw new HttpError(400, "status must be draft, active or inactive");
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO metadata_rules
        (code, name, description, category, type_id, form_id, target_field, condition_json, actions_json,
         priority, status, version, tenant_id, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.description || "",
        body.category,
        typeId,
        formId,
        body.target_field || body.targetField || "",
        JSON.stringify(condition),
        JSON.stringify(actions),
        body.priority ?? 100,
        status,
        tenantId ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE") || String(err.message).includes("unique")) {
      throw new HttpError(409, "Rule code already exists in this scope");
    }
    throw err;
  }
  const row = getRuleRow(db, result.lastInsertRowid);
  recordVersion(db, "rule", row.id, publicRule(row), actor, "create");
  writeAudit(db, {
    actor,
    action: "metadata.rule.create",
    resourceType: "metadata_rule",
    resourceId: row.id,
    details: { code: row.code, category: row.category },
    ip,
  });
  return publicRule(row);
}

export function updateRule(db, id, body, actor, ip, tenantId) {
  const row = getRuleRow(db, id);
  assertMutable(db, row, tenantId, actor, "Rule not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "Rule code");
  const category = body.category ?? row.category;
  if (!RULE_CATEGORIES.includes(category)) {
    throw new HttpError(400, `category must be one of: ${RULE_CATEGORIES.join(", ")}`);
  }
  if (body.status && !RULE_STATUSES.includes(body.status)) {
    throw new HttpError(400, "status must be draft, active or inactive");
  }
  const { typeId, formId } = resolveRuleScope(
    db,
    {
      type_id: body.type_id ?? body.typeId ?? row.type_id,
      form_id: body.form_id ?? body.formId ?? row.form_id,
    },
    tenantId
  );
  if (!typeId && !formId) throw new HttpError(400, "A rule must target a type or a form");
  const condition =
    body.condition === undefined && body.condition_json === undefined
      ? safeParse(row.condition_json, {})
      : normalizeCondition(body.condition ?? body.condition_json);
  const actions =
    body.actions === undefined && body.actions_json === undefined
      ? safeParse(row.actions_json, [])
      : normalizeActions(body.actions ?? body.actions_json, category);
  run(
    db,
    `UPDATE metadata_rules SET code = ?, name = ?, description = ?, category = ?, type_id = ?, form_id = ?,
      target_field = ?, condition_json = ?, actions_json = ?, priority = ?, status = ?, updated_at = ?
     WHERE id = ?`,
    [
      body.code ?? row.code,
      (body.name ?? row.name).trim(),
      body.description ?? row.description,
      category,
      typeId,
      formId,
      body.target_field ?? body.targetField ?? row.target_field,
      JSON.stringify(condition),
      JSON.stringify(actions),
      body.priority ?? row.priority,
      body.status ?? row.status,
      nowIso(),
      id,
    ]
  );
  const next = getRuleRow(db, id);
  recordVersion(db, "rule", id, publicRule(next), actor, "update");
  writeAudit(db, { actor, action: "metadata.rule.update", resourceType: "metadata_rule", resourceId: id, ip });
  return publicRule(next);
}

export function setRuleStatus(db, id, status, actor, ip, tenantId) {
  if (!RULE_STATUSES.includes(status)) throw new HttpError(400, "status must be draft, active or inactive");
  const row = getRuleRow(db, id);
  assertMutable(db, row, tenantId, actor, "Rule not found");
  run(db, "UPDATE metadata_rules SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), id]);
  writeAudit(db, { actor, action: `metadata.rule.${status}`, resourceType: "metadata_rule", resourceId: id, ip });
  return publicRule(getRuleRow(db, id));
}

export function deleteRule(db, id, actor, ip, tenantId) {
  const row = getRuleRow(db, id);
  assertMutable(db, row, tenantId, actor, "Rule not found");
  run(db, "DELETE FROM metadata_rules WHERE id = ?", [id]);
  writeAudit(db, {
    actor,
    action: "metadata.rule.delete",
    resourceType: "metadata_rule",
    resourceId: id,
    details: { code: row.code },
    ip,
  });
  return { deleted: true, id: Number(id) };
}

// Collects active rules relevant to a type/form, ordered by priority. Form
// rules run before type rules of equal priority, then code for determinism.
export function rulesFor(db, { typeId, formId }, tenantId) {
  const scope = tenantClause(null, tenantId);
  const where = [scope.sql, "status = 'active'"];
  const params = [...scope.params];
  const clauses = [];
  if (typeId && !/^\d+$/.test(String(typeId))) {
    typeId = findType(db, typeId, tenantId).id;
  }
  if (formId && !/^\d+$/.test(String(formId))) {
    formId = findForm(db, formId, tenantId).id;
  }
  if (formId) {
    clauses.push("form_id = ?");
    params.push(Number(formId));
  }
  if (typeId) {
    clauses.push("type_id = ?");
    params.push(Number(typeId));
  }
  if (!clauses.length) return [];
  where.push(`(${clauses.join(" OR ")})`);
  return queryAll(
    db,
    `SELECT * FROM metadata_rules WHERE ${where.join(" AND ")}
     ORDER BY priority, CASE WHEN form_id IS NULL THEN 1 ELSE 0 END, code`,
    params
  ).map(publicRule);
}

export function testRule(db, ruleInput, context) {
  const condition = normalizeCondition(ruleInput.condition ?? ruleInput.condition_json ?? {});
  if (!Object.keys(condition).length) return { matched: true, result: true };
  const result = evaluate(condition, context || {});
  return { matched: Boolean(result), result: Boolean(result), condition };
}

// Applies non-validation rules (defaults, visibility, required, dependencies)
// to a values object, returning the mutated values plus metadata the caller/UI
// can use. Validation rules are intentionally handled by the validation engine.
export function applyRules(db, { typeId, formId, values = {}, context = {} }, tenantId) {
  const rules = rulesFor(db, { typeId, formId }, tenantId);
  const working = { ...values };
  const visibility = {};
  const editability = {};
  const requiredOverrides = {};
  const messages = [];

  for (const rule of rules) {
    if (rule.category === "validation") continue;
    if (!Object.keys(rule.condition || {}).length) {
      /* unconditional rule */
    }
    const matched = !Object.keys(rule.condition || {}).length
      ? true
      : evaluate(rule.condition, { ...context, values: working, record: working });
    if (!matched) continue;
    for (const action of rule.actions || []) {
      switch (action.type) {
        case "set_default":
          if (working[action.field] === undefined || working[action.field] === "" || working[action.field] === null) {
            working[action.field] = resolveActionValue(action, context);
          }
          break;
        case "set_value":
          working[action.field] = resolveActionValue(action, context);
          break;
        case "clear_value":
          delete working[action.field];
          break;
        case "set_visible":
          visibility[action.field] = action.value !== false;
          break;
        case "set_editable":
          editability[action.field] = action.value !== false;
          break;
        case "set_required":
          requiredOverrides[action.field] = action.value !== false;
          break;
        case "require":
          requiredOverrides[action.field] = true;
          break;
        case "forbid":
          requiredOverrides[action.field] = false;
          break;
        default:
          break;
      }
    }
  }
  return { values: working, visibility, editability, required: requiredOverrides, messages, rules };
}

function resolveActionValue(action, context) {
  if (action.valueExpression !== undefined) return evaluateValue(action.valueExpression, context);
  if (action.value !== undefined && action.value !== null) return action.value;
  if (action.expression !== undefined) return evaluateValue(action.expression, context);
  return action.value;
}

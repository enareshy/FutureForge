// Persistence for the centralized security model: object type registration,
// policies, entitlements, field / classification / organization / plant rules,
// masking rules, decision journal and cache epochs.
import { randomUUID } from "node:crypto";
import { nowIso, queryAll, queryOne, run, transaction } from "../../db.js";
import {
  FIELD_EFFECTS,
  MASKING_STRATEGIES,
  OBJECT_ENFORCEMENT_MODES,
  ORGANIZATION_SCOPE_MODES,
  POLICY_STATUSES,
  SECURITY_ACTIONS,
  SECURITY_CLASSIFICATIONS,
  SECURITY_EFFECTS,
  SECURITY_SCOPES,
  SUBJECT_TYPES,
} from "./constants.js";
import { assertionError, conflictError, notFoundError } from "./errors.js";
import { assertOperator } from "./conditions.js";

export function safeParse(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function newUuid() {
  return randomUUID();
}

function parseJsonObject(value, name) {
  if (value === undefined || value === null || value === "") return "";
  const parsed = typeof value === "object" ? value : safeParse(value, undefined);
  if (parsed === undefined) throw assertionError(`${name} must be valid JSON`);
  return JSON.stringify(parsed);
}

function assertEnum(value, allowed, name) {
  const normalized = String(value ?? "").trim();
  if (!allowed.includes(normalized)) {
    throw assertionError(`Unknown ${name} "${value}"`);
  }
  return normalized;
}

function subjectFields(input) {
  const subjectType = assertEnum(input.subject_type ?? input.subjectType ?? "everyone", SUBJECT_TYPES, "subject_type");
  const subjectId = Number(input.subject_id ?? input.subjectId ?? 0) || 0;
  if (subjectType !== "everyone" && subjectId <= 0) {
    throw assertionError("subject_id is required unless subject_type is everyone");
  }
  return { subjectType, subjectId };
}

function lastId(result) {
  return Number(result.lastInsertRowid);
}

function exists(db, table, id) {
  return Boolean(queryOne(db, `SELECT id FROM ${table} WHERE id = ?`, [Number(id)]));
}

// ---------------------------------------------------------------------------
// Object type registration
// ---------------------------------------------------------------------------

export function publicObjectType(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    object_type: row.object_type,
    enforcement: row.enforcement,
    permission_resource: row.permission_resource || "",
    description: row.description || "",
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function registerObjectType(db, input = {}, actor, tenantId) {
  const objectType = String(input.object_type ?? input.objectType ?? input.code ?? "").trim();
  if (!objectType) throw assertionError("object_type is required");
  const enforcement = assertEnum(
    input.enforcement ?? "tenant",
    OBJECT_ENFORCEMENT_MODES,
    "enforcement"
  );
  const existing = queryOne(
    db,
    "SELECT * FROM security_object_types WHERE tenant_id = ? AND object_type = ?",
    [Number(tenantId), objectType]
  );
  const code = objectType;
  if (existing) {
    run(
      db,
      `UPDATE security_object_types
         SET enforcement = ?, permission_resource = ?, description = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        enforcement,
        String(input.permission_resource ?? input.permissionResource ?? existing.permission_resource ?? ""),
        String(input.description ?? existing.description ?? ""),
        assertEnum(input.status ?? existing.status ?? "active", ["active", "inactive"], "status"),
        nowIso(),
        existing.id,
      ]
    );
    return publicObjectType(queryOne(db, "SELECT * FROM security_object_types WHERE id = ?", [existing.id]));
  }
  const result = run(
    db,
    `INSERT INTO security_object_types
       (tenant_id, object_type, enforcement, permission_resource, description, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(tenantId),
      code,
      enforcement,
      String(input.permission_resource ?? input.permissionResource ?? ""),
      String(input.description ?? ""),
      "active",
      actor?.id ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  return publicObjectType(queryOne(db, "SELECT * FROM security_object_types WHERE id = ?", [lastId(result)]));
}

export function getObjectType(db, tenantId, objectType) {
  return queryOne(
    db,
    "SELECT * FROM security_object_types WHERE tenant_id = ? AND object_type = ?",
    [Number(tenantId), String(objectType)]
  );
}

export function listObjectTypes(db, tenantId, query = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    clauses.push("status = ?");
    params.push(String(query.status));
  }
  return queryAll(
    db,
    `SELECT * FROM security_object_types WHERE ${clauses.join(" AND ")} ORDER BY object_type`,
    params
  ).map(publicObjectType);
}

export function setObjectTypeStatus(db, tenantId, objectType, status) {
  const row = getObjectType(db, tenantId, objectType);
  if (!row) throw notFoundError(`Object type "${objectType}" is not registered`);
  run(db, "UPDATE security_object_types SET status = ?, updated_at = ? WHERE id = ?", [
    assertEnum(status, ["active", "inactive"], "status"),
    nowIso(),
    row.id,
  ]);
  return publicObjectType(queryOne(db, "SELECT * FROM security_object_types WHERE id = ?", [row.id]));
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export function publicPolicyRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    policy_id: row.policy_id,
    rule_type: row.rule_type,
    field: row.field || "",
    operator: row.operator || "eq",
    value: safeParse(row.value_json, null),
    effect: row.effect,
    masking_strategy: row.masking_strategy || "",
    config: safeParse(row.config_json, null),
    sort_order: row.sort_order,
  };
}

export function publicPolicy(row, rules = []) {
  if (!row) return null;
  return {
    id: row.id,
    uuid: row.uuid,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    category: row.category || "general",
    scope: row.scope,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    resource_type: row.resource_type || "",
    action: row.action || "",
    effect: row.effect,
    priority: row.priority,
    status: row.status,
    version: row.version,
    condition: safeParse(row.condition_json, null),
    valid_from: row.valid_from || null,
    valid_to: row.valid_to || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    rules: rules.map(publicPolicyRule),
  };
}

function policyRules(db, policyId) {
  return queryAll(
    db,
    "SELECT * FROM security_policy_rules WHERE policy_id = ? ORDER BY sort_order, id",
    [policyId]
  );
}

export function getPolicy(db, id, tenantId) {
  const row = queryOne(db, "SELECT * FROM security_policies WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  return row ? publicPolicy(row, policyRules(db, row.id)) : null;
}

export function listPolicies(db, tenantId, query = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    clauses.push("status = ?");
    params.push(String(query.status));
  }
  if (query.scope) {
    clauses.push("scope = ?");
    params.push(String(query.scope));
  }
  if (query.resource_type) {
    clauses.push("resource_type = ?");
    params.push(String(query.resource_type));
  }
  return queryAll(
    db,
    `SELECT * FROM security_policies WHERE ${clauses.join(" AND ")} ORDER BY priority DESC, code`,
    params
  ).map((row) => publicPolicy(row, policyRules(db, row.id)));
}

function writeRules(db, policyId, rules = []) {
  run(db, "DELETE FROM security_policy_rules WHERE policy_id = ?", [policyId]);
  rules.forEach((rule, index) => {
    const ruleType = assertEnum(rule.rule_type ?? rule.ruleType ?? "condition", ["condition", "action", "masking"], "rule_type");
    run(
      db,
      `INSERT INTO security_policy_rules
         (policy_id, rule_type, field, operator, value_json, effect, masking_strategy, config_json, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        policyId,
        ruleType,
        String(rule.field ?? ""),
        rule.operator ? assertOperator(rule.operator) : "eq",
        rule.value === undefined ? "" : JSON.stringify(rule.value),
        assertEnum(rule.effect ?? "allow", SECURITY_EFFECTS, "effect"),
        rule.masking_strategy || rule.maskingStrategy ? assertEnum(rule.masking_strategy ?? rule.maskingStrategy, MASKING_STRATEGIES, "masking_strategy") : "",
        parseJsonObject(rule.config ?? rule.config_json, "config"),
        Number(rule.sort_order ?? index),
      ]
    );
  });
}

export function createPolicy(db, input = {}, actor, tenantId) {
  const code = String(input.code ?? "").trim();
  if (!code) throw assertionError("code is required");
  if (queryOne(db, "SELECT id FROM security_policies WHERE tenant_id = ? AND code = ?", [Number(tenantId), code])) {
    throw conflictError(`A policy with code "${code}" already exists`);
  }
  const { subjectType, subjectId } = subjectFields(input);
  const result = run(
    db,
    `INSERT INTO security_policies
       (uuid, tenant_id, code, name, description, category, scope, subject_type, subject_id,
        resource_type, action, effect, priority, status, version, condition_json, valid_from, valid_to,
        created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newUuid(),
      Number(tenantId),
      code,
      String(input.name ?? code),
      String(input.description ?? ""),
      String(input.category ?? "general"),
      assertEnum(input.scope ?? "object_type", SECURITY_SCOPES, "scope"),
      subjectType,
      subjectId,
      String(input.resource_type ?? input.resourceType ?? ""),
      input.action ? String(input.action) : "",
      assertEnum(input.effect ?? "allow", SECURITY_EFFECTS, "effect"),
      Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
      assertEnum(input.status ?? "active", POLICY_STATUSES, "status"),
      parseJsonObject(input.condition, "condition"),
      input.valid_from ?? null,
      input.valid_to ?? null,
      actor?.id ?? null,
      actor?.id ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  const id = lastId(result);
  writeRules(db, id, input.rules || []);
  return getPolicy(db, id, tenantId);
}

export function updatePolicy(db, id, input = {}, actor, tenantId) {
  const existing = queryOne(db, "SELECT * FROM security_policies WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  if (!existing) throw notFoundError("Policy not found");
  const merged = { ...existing, ...input };
  const { subjectType, subjectId } = subjectFields(merged);
  run(
    db,
    `UPDATE security_policies
       SET name = ?, description = ?, category = ?, scope = ?, subject_type = ?, subject_id = ?,
           resource_type = ?, action = ?, effect = ?, priority = ?, status = ?,
           condition_json = ?, valid_from = ?, valid_to = ?, version = version + 1, updated_by = ?, updated_at = ?
     WHERE id = ?`,
    [
      String(merged.name ?? existing.name),
      String(merged.description ?? existing.description ?? ""),
      String(merged.category ?? existing.category ?? "general"),
      assertEnum(merged.scope ?? existing.scope, SECURITY_SCOPES, "scope"),
      subjectType,
      subjectId,
      String(merged.resource_type ?? merged.resourceType ?? existing.resource_type ?? ""),
      merged.action !== undefined ? String(merged.action || "") : existing.action,
      assertEnum(merged.effect ?? existing.effect, SECURITY_EFFECTS, "effect"),
      Number.isFinite(Number(merged.priority)) ? Number(merged.priority) : existing.priority,
      assertEnum(merged.status ?? existing.status, POLICY_STATUSES, "status"),
      parseJsonObject(merged.condition ?? existing.condition_json, "condition"),
      merged.valid_from ?? existing.valid_from ?? null,
      merged.valid_to ?? existing.valid_to ?? null,
      actor?.id ?? null,
      nowIso(),
      existing.id,
    ]
  );
  if (input.rules !== undefined) writeRules(db, existing.id, input.rules || []);
  return getPolicy(db, existing.id, tenantId);
}

export function setPolicyStatus(db, id, status, actor, tenantId) {
  const existing = queryOne(db, "SELECT id FROM security_policies WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  if (!existing) throw notFoundError("Policy not found");
  run(db, "UPDATE security_policies SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    assertEnum(status, POLICY_STATUSES, "status"),
    actor?.id ?? null,
    nowIso(),
    existing.id,
  ]);
  return getPolicy(db, existing.id, tenantId);
}

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

export function publicEntitlement(row) {
  if (!row) return null;
  return {
    id: row.id,
    uuid: row.uuid,
    tenant_id: row.tenant_id,
    code: row.code || "",
    name: row.name || "",
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    resource_type: row.resource_type || "",
    resource_id: row.resource_id || "",
    action: row.action,
    effect: row.effect,
    scope: row.scope,
    classification: row.classification || "",
    priority: row.priority,
    condition: safeParse(row.condition_json, null),
    status: row.status,
    valid_from: row.valid_from || null,
    valid_to: row.valid_to || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createEntitlement(db, input = {}, actor, tenantId) {
  const action = assertEnum(input.action ?? "read", SECURITY_ACTIONS, "action");
  const effect = assertEnum(input.effect ?? "allow", SECURITY_EFFECTS, "effect");
  const scope = assertEnum(input.scope ?? "object_type", SECURITY_SCOPES, "scope");
  const classification = input.classification
    ? assertEnum(input.classification, SECURITY_CLASSIFICATIONS, "classification")
    : "";
  const { subjectType, subjectId } = subjectFields(input);
  const resourceType = String(input.resource_type ?? input.resourceType ?? "").trim();
  const resourceId = String(input.resource_id ?? input.resourceId ?? "");
  const result = run(
    db,
    `INSERT INTO security_entitlements
       (uuid, tenant_id, code, name, subject_type, subject_id, resource_type, resource_id, action,
        effect, scope, classification, priority, condition_json, status, valid_from, valid_to,
        created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newUuid(),
      Number(tenantId),
      String(input.code ?? ""),
      String(input.name ?? ""),
      subjectType,
      subjectId,
      resourceType,
      resourceId,
      action,
      effect,
      scope,
      classification,
      Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
      parseJsonObject(input.condition, "condition"),
      "active",
      input.valid_from ?? null,
      input.valid_to ?? null,
      actor?.id ?? null,
      actor?.id ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  return publicEntitlement(
    queryOne(db, "SELECT * FROM security_entitlements WHERE id = ?", [lastId(result)])
  );
}

export function listEntitlements(db, tenantId, query = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.resource_type) {
    clauses.push("resource_type = ?");
    params.push(String(query.resource_type));
  }
  if (query.status) {
    clauses.push("status = ?");
    params.push(String(query.status));
  }
  return queryAll(
    db,
    `SELECT * FROM security_entitlements WHERE ${clauses.join(" AND ")} ORDER BY priority DESC, id`,
    params
  ).map(publicEntitlement);
}

export function getEntitlement(db, id, tenantId) {
  const row = queryOne(db, "SELECT * FROM security_entitlements WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  return row ? publicEntitlement(row) : null;
}

export function updateEntitlement(db, id, input = {}, actor, tenantId) {
  const existing = queryOne(db, "SELECT * FROM security_entitlements WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  if (!existing) throw notFoundError("Entitlement not found");
  const merged = { ...existing, ...input };
  const { subjectType, subjectId } = subjectFields(merged);
  run(
    db,
    `UPDATE security_entitlements
       SET code = ?, name = ?, subject_type = ?, subject_id = ?, resource_type = ?, resource_id = ?,
           action = ?, effect = ?, scope = ?, classification = ?, priority = ?, condition_json = ?,
           status = ?, valid_from = ?, valid_to = ?, updated_by = ?, updated_at = ?
     WHERE id = ?`,
    [
      String(merged.code ?? existing.code ?? ""),
      String(merged.name ?? existing.name ?? ""),
      subjectType,
      subjectId,
      String(merged.resource_type ?? merged.resourceType ?? existing.resource_type ?? ""),
      String(merged.resource_id ?? merged.resourceId ?? existing.resource_id ?? ""),
      assertEnum(merged.action ?? existing.action, SECURITY_ACTIONS, "action"),
      assertEnum(merged.effect ?? existing.effect, SECURITY_EFFECTS, "effect"),
      assertEnum(merged.scope ?? existing.scope, SECURITY_SCOPES, "scope"),
      merged.classification ? assertEnum(merged.classification, SECURITY_CLASSIFICATIONS, "classification") : "",
      Number.isFinite(Number(merged.priority)) ? Number(merged.priority) : existing.priority,
      parseJsonObject(merged.condition ?? existing.condition_json, "condition"),
      assertEnum(merged.status ?? existing.status, ["active", "inactive"], "status"),
      merged.valid_from ?? existing.valid_from ?? null,
      merged.valid_to ?? existing.valid_to ?? null,
      actor?.id ?? null,
      nowIso(),
      existing.id,
    ]
  );
  return getEntitlement(db, existing.id, tenantId);
}

export function setEntitlementStatus(db, id, status, actor, tenantId) {
  const existing = queryOne(db, "SELECT id FROM security_entitlements WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  if (!existing) throw notFoundError("Entitlement not found");
  run(db, "UPDATE security_entitlements SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    assertEnum(status, ["active", "inactive"], "status"),
    actor?.id ?? null,
    nowIso(),
    existing.id,
  ]);
  return getEntitlement(db, existing.id, tenantId);
}

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

export function publicFieldRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    uuid: row.uuid,
    tenant_id: row.tenant_id,
    object_type: row.object_type,
    field_name: row.field_name,
    action: row.action,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    effect: row.effect,
    masking_strategy: row.masking_strategy || "",
    masking_config: safeParse(row.masking_config_json, null),
    classification: row.classification || "",
    priority: row.priority,
    condition: safeParse(row.condition_json, null),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createFieldRule(db, input = {}, actor, tenantId) {
  const objectType = String(input.object_type ?? input.objectType ?? "").trim();
  const fieldName = String(input.field_name ?? input.fieldName ?? "").trim();
  if (!objectType) throw assertionError("object_type is required");
  if (!fieldName) throw assertionError("field_name is required");
  const action = assertEnum(input.action ?? "read", SECURITY_ACTIONS, "action");
  const effect = assertEnum(input.effect ?? "mask", FIELD_EFFECTS, "effect");
  const strategy = input.masking_strategy || input.maskingStrategy
    ? assertEnum(input.masking_strategy ?? input.maskingStrategy, MASKING_STRATEGIES, "masking_strategy")
    : effect === "mask"
      ? "REDACT"
      : "";
  const { subjectType, subjectId } = subjectFields(input);
  const result = run(
    db,
    `INSERT INTO security_field_rules
       (uuid, tenant_id, object_type, field_name, action, subject_type, subject_id, effect,
        masking_strategy, masking_config_json, classification, priority, condition_json, status,
        created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    [
      newUuid(),
      Number(tenantId),
      objectType,
      fieldName,
      action,
      subjectType,
      subjectId,
      effect,
      strategy,
      parseJsonObject(input.masking_config ?? input.maskingConfig, "masking_config"),
      input.classification ? assertEnum(input.classification, SECURITY_CLASSIFICATIONS, "classification") : "",
      Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
      parseJsonObject(input.condition, "condition"),
      actor?.id ?? null,
      actor?.id ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  return publicFieldRule(queryOne(db, "SELECT * FROM security_field_rules WHERE id = ?", [lastId(result)]));
}

export function listFieldRules(db, tenantId, query = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.object_type) {
    clauses.push("object_type = ?");
    params.push(String(query.object_type));
  }
  return queryAll(
    db,
    `SELECT * FROM security_field_rules WHERE ${clauses.join(" AND ")} ORDER BY object_type, field_name, priority DESC`,
    params
  ).map(publicFieldRule);
}

export function getFieldRule(db, id, tenantId) {
  const row = queryOne(db, "SELECT * FROM security_field_rules WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  return row ? publicFieldRule(row) : null;
}

export function updateFieldRule(db, id, input = {}, actor, tenantId) {
  const existing = queryOne(db, "SELECT * FROM security_field_rules WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  if (!existing) throw notFoundError("Field rule not found");
  const merged = { ...existing, ...input };
  const { subjectType, subjectId } = subjectFields(merged);
  run(
    db,
    `UPDATE security_field_rules
       SET object_type = ?, field_name = ?, action = ?, subject_type = ?, subject_id = ?, effect = ?,
           masking_strategy = ?, masking_config_json = ?, classification = ?, priority = ?,
           condition_json = ?, status = ?, updated_by = ?, updated_at = ?
     WHERE id = ?`,
    [
      String(merged.object_type ?? existing.object_type),
      String(merged.field_name ?? existing.field_name),
      assertEnum(merged.action ?? existing.action, SECURITY_ACTIONS, "action"),
      subjectType,
      subjectId,
      assertEnum(merged.effect ?? existing.effect, FIELD_EFFECTS, "effect"),
      merged.masking_strategy || merged.maskingStrategy
        ? assertEnum(merged.masking_strategy ?? merged.maskingStrategy, MASKING_STRATEGIES, "masking_strategy")
        : existing.masking_strategy || "",
      parseJsonObject(merged.masking_config ?? existing.masking_config_json, "masking_config"),
      merged.classification ? assertEnum(merged.classification, SECURITY_CLASSIFICATIONS, "classification") : "",
      Number.isFinite(Number(merged.priority)) ? Number(merged.priority) : existing.priority,
      parseJsonObject(merged.condition ?? existing.condition_json, "condition"),
      assertEnum(merged.status ?? existing.status, ["active", "inactive"], "status"),
      actor?.id ?? null,
      nowIso(),
      existing.id,
    ]
  );
  return getFieldRule(db, existing.id, tenantId);
}

export function setFieldRuleStatus(db, id, status, actor, tenantId) {
  const existing = queryOne(db, "SELECT id FROM security_field_rules WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  if (!existing) throw notFoundError("Field rule not found");
  run(db, "UPDATE security_field_rules SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    assertEnum(status, ["active", "inactive"], "status"),
    actor?.id ?? null,
    nowIso(),
    existing.id,
  ]);
  return getFieldRule(db, existing.id, tenantId);
}

// Generic status toggles for the remaining rule families share one shape.
function statusToggle(table, label, shaper = (row) => row) {
  return (db, id, status, actor, tenantId) => {
    const existing = queryOne(db, `SELECT id FROM ${table} WHERE id = ? AND tenant_id = ?`, [
      Number(id),
      Number(tenantId),
    ]);
    if (!existing) throw notFoundError(`${label} not found`);
    run(db, `UPDATE ${table} SET status = ?, updated_at = ? WHERE id = ?`, [
      assertEnum(status, ["active", "inactive"], "status"),
      nowIso(),
      existing.id,
    ]);
    return shaper(queryOne(db, `SELECT * FROM ${table} WHERE id = ?`, [existing.id]));
  };
}

// ---------------------------------------------------------------------------
// Classification rules
// ---------------------------------------------------------------------------

export function publicClassificationRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    uuid: row.uuid,
    tenant_id: row.tenant_id,
    classification: row.classification,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    action: row.action,
    resource_type: row.resource_type || "",
    effect: row.effect,
    priority: row.priority,
    condition: safeParse(row.condition_json, null),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createClassificationRule(db, input = {}, actor, tenantId) {
  const { subjectType, subjectId } = subjectFields(input);
  const result = run(
    db,
    `INSERT INTO security_classification_rules
       (uuid, tenant_id, classification, subject_type, subject_id, action, resource_type, effect,
        priority, condition_json, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      newUuid(),
      Number(tenantId),
      assertEnum(input.classification, SECURITY_CLASSIFICATIONS, "classification"),
      subjectType,
      subjectId,
      assertEnum(input.action ?? "read", SECURITY_ACTIONS, "action"),
      String(input.resource_type ?? input.resourceType ?? ""),
      assertEnum(input.effect ?? "deny", SECURITY_EFFECTS, "effect"),
      Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
      parseJsonObject(input.condition, "condition"),
      actor?.id ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  return publicClassificationRule(
    queryOne(db, "SELECT * FROM security_classification_rules WHERE id = ?", [lastId(result)])
  );
}

export function listClassificationRules(db, tenantId, query = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.resource_type) {
    clauses.push("resource_type = ?");
    params.push(String(query.resource_type));
  }
  return queryAll(
    db,
    `SELECT * FROM security_classification_rules WHERE ${clauses.join(" AND ")} ORDER BY priority DESC, id`,
    params
  ).map(publicClassificationRule);
}

export function getClassificationRule(db, id, tenantId) {
  const row = queryOne(db, "SELECT * FROM security_classification_rules WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  return row ? publicClassificationRule(row) : null;
}

export const setClassificationRuleStatus = statusToggle(
  "security_classification_rules",
  "Classification rule",
  publicClassificationRule
);

// ---------------------------------------------------------------------------
// Organization & plant rules
// ---------------------------------------------------------------------------

export function publicOrganizationRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    uuid: row.uuid,
    tenant_id: row.tenant_id,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    resource_type: row.resource_type || "",
    action: row.action,
    organization_id: row.organization_id,
    scope_mode: row.scope_mode,
    include_descendants: Boolean(row.include_descendants),
    effect: row.effect,
    priority: row.priority,
    condition: safeParse(row.condition_json, null),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createOrganizationRule(db, input = {}, actor, tenantId) {
  const organizationId = Number(input.organization_id ?? input.organizationId ?? 0);
  if (!Number.isInteger(organizationId) || organizationId <= 0) {
    throw assertionError("organization_id is required");
  }
  const { subjectType, subjectId } = subjectFields(input);
  const result = run(
    db,
    `INSERT INTO security_organization_rules
       (uuid, tenant_id, subject_type, subject_id, resource_type, action, organization_id, scope_mode,
        include_descendants, effect, priority, condition_json, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      newUuid(),
      Number(tenantId),
      subjectType,
      subjectId,
      String(input.resource_type ?? input.resourceType ?? ""),
      assertEnum(input.action ?? "read", SECURITY_ACTIONS, "action"),
      organizationId,
      assertEnum(input.scope_mode ?? input.scopeMode ?? "self_and_descendants", ORGANIZATION_SCOPE_MODES, "scope_mode"),
      input.include_descendants === undefined ? 1 : input.include_descendants ? 1 : 0,
      assertEnum(input.effect ?? "allow", SECURITY_EFFECTS, "effect"),
      Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
      parseJsonObject(input.condition, "condition"),
      actor?.id ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  return publicOrganizationRule(
    queryOne(db, "SELECT * FROM security_organization_rules WHERE id = ?", [lastId(result)])
  );
}

export function listOrganizationRules(db, tenantId, query = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.resource_type) {
    clauses.push("resource_type = ?");
    params.push(String(query.resource_type));
  }
  return queryAll(
    db,
    `SELECT * FROM security_organization_rules WHERE ${clauses.join(" AND ")} ORDER BY priority DESC, id`,
    params
  ).map(publicOrganizationRule);
}

export function getOrganizationRule(db, id, tenantId) {
  const row = queryOne(db, "SELECT * FROM security_organization_rules WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  return row ? publicOrganizationRule(row) : null;
}

export const setOrganizationRuleStatus = statusToggle(
  "security_organization_rules",
  "Organization rule",
  publicOrganizationRule
);

export function publicPlantRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    uuid: row.uuid,
    tenant_id: row.tenant_id,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    resource_type: row.resource_type || "",
    action: row.action,
    plant_id: row.plant_id,
    include_descendants: Boolean(row.include_descendants),
    effect: row.effect,
    priority: row.priority,
    condition: safeParse(row.condition_json, null),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createPlantRule(db, input = {}, actor, tenantId) {
  const plantId = Number(input.plant_id ?? input.plantId ?? 0);
  if (!Number.isInteger(plantId) || plantId <= 0) throw assertionError("plant_id is required");
  const { subjectType, subjectId } = subjectFields(input);
  const result = run(
    db,
    `INSERT INTO security_plant_rules
       (uuid, tenant_id, subject_type, subject_id, resource_type, action, plant_id, include_descendants,
        effect, priority, condition_json, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      newUuid(),
      Number(tenantId),
      subjectType,
      subjectId,
      String(input.resource_type ?? input.resourceType ?? ""),
      assertEnum(input.action ?? "read", SECURITY_ACTIONS, "action"),
      plantId,
      input.include_descendants ? 1 : 0,
      assertEnum(input.effect ?? "allow", SECURITY_EFFECTS, "effect"),
      Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
      parseJsonObject(input.condition, "condition"),
      actor?.id ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  return publicPlantRule(queryOne(db, "SELECT * FROM security_plant_rules WHERE id = ?", [lastId(result)]));
}

export function listPlantRules(db, tenantId, query = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.resource_type) {
    clauses.push("resource_type = ?");
    params.push(String(query.resource_type));
  }
  return queryAll(
    db,
    `SELECT * FROM security_plant_rules WHERE ${clauses.join(" AND ")} ORDER BY priority DESC, id`,
    params
  ).map(publicPlantRule);
}

export function getPlantRule(db, id, tenantId) {
  const row = queryOne(db, "SELECT * FROM security_plant_rules WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  return row ? publicPlantRule(row) : null;
}

export const setPlantRuleStatus = statusToggle("security_plant_rules", "Plant rule", publicPlantRule);

// ---------------------------------------------------------------------------
// Masking rules
// ---------------------------------------------------------------------------

export function publicMaskingRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    uuid: row.uuid,
    tenant_id: row.tenant_id,
    code: row.code || "",
    name: row.name || "",
    description: row.description || "",
    object_type: row.object_type || "",
    field_name: row.field_name || "",
    classification: row.classification || "",
    strategy: row.strategy,
    config: safeParse(row.config_json, null),
    priority: row.priority,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createMaskingRule(db, input = {}, actor, tenantId) {
  const result = run(
    db,
    `INSERT INTO security_masking_rules
       (uuid, tenant_id, code, name, description, object_type, field_name, classification, strategy,
        config_json, priority, status, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    [
      newUuid(),
      Number(tenantId),
      String(input.code ?? ""),
      String(input.name ?? ""),
      String(input.description ?? ""),
      String(input.object_type ?? input.objectType ?? ""),
      String(input.field_name ?? input.fieldName ?? ""),
      input.classification ? assertEnum(input.classification, SECURITY_CLASSIFICATIONS, "classification") : "",
      assertEnum(input.strategy, MASKING_STRATEGIES, "strategy"),
      parseJsonObject(input.config, "config"),
      Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
      actor?.id ?? null,
      actor?.id ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  return publicMaskingRule(queryOne(db, "SELECT * FROM security_masking_rules WHERE id = ?", [lastId(result)]));
}

export function listMaskingRules(db, tenantId, query = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.object_type) {
    clauses.push("object_type = ?");
    params.push(String(query.object_type));
  }
  return queryAll(
    db,
    `SELECT * FROM security_masking_rules WHERE ${clauses.join(" AND ")} ORDER BY priority DESC, id`,
    params
  ).map(publicMaskingRule);
}

export function getMaskingRule(db, id, tenantId) {
  const row = queryOne(db, "SELECT * FROM security_masking_rules WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  return row ? publicMaskingRule(row) : null;
}

export const setMaskingRuleStatus = statusToggle("security_masking_rules", "Masking rule", publicMaskingRule);

// ---------------------------------------------------------------------------
// Decision journal & cache epochs
// ---------------------------------------------------------------------------

export function recordDecision(db, entry = {}) {
  const result = run(
    db,
    `INSERT INTO security_decisions
       (tenant_id, user_id, subject_type, subject_id, action, resource_type, resource_id, decision, reason,
        allowed, organization_id, plant_id, classification, duration_ms, cached, correlation_id, steps_json, context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(entry.tenantId ?? 0),
      entry.userId ?? null,
      String(entry.subjectType ?? "user"),
      Number(entry.subjectId ?? entry.userId ?? 0),
      String(entry.action ?? "read"),
      String(entry.resourceType ?? ""),
      String(entry.resourceId ?? ""),
      String(entry.decision ?? "deny"),
      String(entry.reason ?? "DEFAULT_DENY"),
      entry.allowed ? 1 : 0,
      entry.organizationId ?? null,
      entry.plantId ?? null,
      String(entry.classification ?? ""),
      Number(entry.durationMs ?? 0),
      entry.cached ? 1 : 0,
      String(entry.correlationId ?? ""),
      JSON.stringify(entry.steps ?? []),
      JSON.stringify(entry.context ?? {}),
    ]
  );
  return lastId(result);
}

export function publicDecision(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    decision: row.decision,
    reason: row.reason,
    allowed: row.allowed === 1,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    classification: row.classification || "",
    duration_ms: row.duration_ms,
    cached: row.cached === 1,
    correlation_id: row.correlation_id || "",
    steps: safeParse(row.steps_json, []),
    context: safeParse(row.context_json, {}),
    created_at: row.created_at,
  };
}

export function listDecisions(db, tenantId, query = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.user_id) {
    clauses.push("user_id = ?");
    params.push(Number(query.user_id));
  }
  if (query.decision) {
    clauses.push("decision = ?");
    params.push(String(query.decision));
  }
  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 1000);
  return queryAll(
    db,
    `SELECT * FROM security_decisions WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ${limit}`,
    params
  ).map(publicDecision);
}

export function getDecision(db, id, tenantId) {
  const row = queryOne(db, "SELECT * FROM security_decisions WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  return row ? publicDecision(row) : null;
}

export function currentEpoch(db, tenantId, scope = "all") {
  const row = queryOne(
    db,
    "SELECT epoch FROM security_cache_epoch WHERE tenant_id = ? AND scope = ?",
    [Number(tenantId), String(scope)]
  );
  return row ? Number(row.epoch) : 0;
}

export function bumpEpoch(db, tenantId, scope = "all") {
  run(
    db,
    `INSERT INTO security_cache_epoch (tenant_id, scope, epoch, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(tenant_id, scope) DO UPDATE SET epoch = epoch + 1, updated_at = excluded.updated_at`,
    [Number(tenantId), String(scope), nowIso()]
  );
  return currentEpoch(db, tenantId, scope);
}

export { transaction };

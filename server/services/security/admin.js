// Application service for the security administration API and debugger.
// Routes stay thin; all validation, persistence, invalidation and auditing live
// here so the model is enforced centrally.
import { queryAll, queryOne } from "../../db.js";
import { writeAudit } from "../audit.js";
import { securityError, assertionError } from "./errors.js";
import {
  DECISION_REASONS,
  SECURITY_ACTIONS,
  SECURITY_CLASSIFICATIONS,
  MASKING_STRATEGIES,
  ORGANIZATION_SCOPE_MODES,
  SECURITY_SCOPES,
  SUBJECT_TYPES,
  FIELD_EFFECTS,
} from "./constants.js";
import {
  createClassificationRule,
  createEntitlement,
  createFieldRule,
  createMaskingRule,
  createOrganizationRule,
  createPlantRule,
  createPolicy,
  getClassificationRule,
  getEntitlement,
  getFieldRule,
  getMaskingRule,
  getObjectType,
  getOrganizationRule,
  getPlantRule,
  getPolicy,
  listClassificationRules,
  listDecisions,
  listEntitlements,
  listFieldRules,
  listMaskingRules,
  listObjectTypes,
  listOrganizationRules,
  listPlantRules,
  listPolicies,
  registerObjectType,
  setClassificationRuleStatus,
  setEntitlementStatus,
  setFieldRuleStatus,
  setMaskingRuleStatus,
  setObjectTypeStatus,
  setOrganizationRuleStatus,
  setPlantRuleStatus,
  setPolicyStatus,
  updateEntitlement,
  updateFieldRule,
  updatePolicy,
} from "./repository.js";
import {
  authorizeRequest,
  invalidateSecurity,
  listMaskingStrategies,
  publicSecurityContext,
} from "./index.js";
import { buildSecurityContext } from "./context.js";
import { evaluateFields } from "./engine.js";
import { ensureSecurityFoundation } from "./foundation.js";

function audit(db, actor, action, resourceType, resourceId, details, ip) {
  writeAudit(db, {
    actor,
    action,
    resourceType,
    resourceId: String(resourceId ?? ""),
    details,
    ip,
  });
}

function invalidate(db, tenantId) {
  return invalidateSecurity(db, tenantId, "all");
}

export function securityVocabulary() {
  return {
    actions: SECURITY_ACTIONS,
    subjectTypes: SUBJECT_TYPES,
    scopes: SECURITY_SCOPES,
    classifications: SECURITY_CLASSIFICATIONS,
    fieldEffects: FIELD_EFFECTS,
    maskingStrategies: MASKING_STRATEGIES,
    organizationScopeModes: ORGANIZATION_SCOPE_MODES,
    decisionReasons: Object.values(DECISION_REASONS),
    masking: listMaskingStrategies(),
  };
}

export function securityOverview(db, tenantId) {
  ensureSecurityFoundation(db);
  const count = (table, where = "", params = []) =>
    Number(
      queryOne(db, `SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?${where}`, [
        Number(tenantId),
        ...params,
      ])?.n || 0
    );
  const recent = queryAll(
    db,
    `SELECT decision, reason, COUNT(*) AS n
     FROM security_decisions WHERE tenant_id = ?
     GROUP BY decision, reason ORDER BY n DESC`,
    [Number(tenantId)]
  );
  const byEnforcement = queryAll(
    db,
    `SELECT enforcement, COUNT(*) AS n FROM security_object_types
     WHERE tenant_id = ? GROUP BY enforcement ORDER BY enforcement`,
    [Number(tenantId)]
  );
  return {
    tenantId: Number(tenantId),
    objectTypes: count("security_object_types"),
    policies: count("security_policies"),
    activePolicies: count("security_policies", " AND status = 'active'"),
    entitlements: count("security_entitlements"),
    fieldRules: count("security_field_rules"),
    classificationRules: count("security_classification_rules"),
    organizationRules: count("security_organization_rules"),
    plantRules: count("security_plant_rules"),
    maskingRules: count("security_masking_rules"),
    decisions: count("security_decisions"),
    enforcement: byEnforcement.map((row) => ({ enforcement: row.enforcement, count: Number(row.n) })),
    decisionSummary: recent.map((row) => ({ decision: row.decision, reason: row.reason, count: Number(row.n) })),
  };
}

// Object types -----------------------------------------------------------------

export function listSecurityObjectTypes(db, tenantId, query) {
  ensureSecurityFoundation(db);
  return listObjectTypes(db, tenantId, query);
}

export function registerSecurityObjectType(db, input, actor, tenantId, ip) {
  const result = registerObjectType(db, input, actor, tenantId);
  audit(db, actor, "security.objecttype.register", "security", result.object_type, { enforcement: result.enforcement }, ip);
  invalidate(db, tenantId);
  return result;
}

export function updateSecurityObjectType(db, tenantId, objectType, input, actor, ip) {
  const existing = getObjectType(db, tenantId, objectType);
  if (!existing) throw securityError(404, `Object type "${objectType}" is not registered`, "NOT_FOUND");
  const result = registerObjectType(db, { ...input, object_type: objectType }, actor, tenantId);
  audit(db, actor, "security.objecttype.update", "security", objectType, { enforcement: result.enforcement }, ip);
  invalidate(db, tenantId);
  return result;
}

export function setSecurityObjectTypeStatus(db, tenantId, objectType, status, actor, ip) {
  const result = setObjectTypeStatus(db, tenantId, objectType, status);
  audit(db, actor, "security.objecttype.status", "security", objectType, { status }, ip);
  invalidate(db, tenantId);
  return result;
}

// Policies ---------------------------------------------------------------------

export function getSecurityPolicy(db, tenantId, id) {
  const policy = getPolicy(db, id, tenantId);
  if (!policy) throw securityError(404, "Policy not found", "NOT_FOUND");
  return policy;
}

export function listSecurityPolicies(db, tenantId, query) {
  return listPolicies(db, tenantId, query);
}

export function createSecurityPolicy(db, input, actor, tenantId, ip) {
  const policy = createPolicy(db, input, actor, tenantId);
  audit(db, actor, "security.policy.create", "security", policy.code, { effect: policy.effect }, ip);
  invalidate(db, tenantId);
  return policy;
}

export function updateSecurityPolicy(db, tenantId, id, input, actor, ip) {
  const policy = updatePolicy(db, id, input, actor, tenantId);
  if (!policy) throw securityError(404, "Policy not found", "NOT_FOUND");
  audit(db, actor, "security.policy.update", "security", policy.code, { version: policy.version }, ip);
  invalidate(db, tenantId);
  return policy;
}

export function setSecurityPolicyStatus(db, tenantId, id, status, actor, ip) {
  const policy = setPolicyStatus(db, id, status, actor, tenantId);
  if (!policy) throw securityError(404, "Policy not found", "NOT_FOUND");
  audit(db, actor, "security.policy.status", "security", policy.code, { status }, ip);
  invalidate(db, tenantId);
  return policy;
}

// Entitlements -----------------------------------------------------------------

export function listSecurityEntitlements(db, tenantId, query) {
  return listEntitlements(db, tenantId, query);
}

export function createSecurityEntitlement(db, input, actor, tenantId, ip) {
  const entitlement = createEntitlement(db, input, actor, tenantId);
  audit(db, actor, "security.entitlement.create", "security", entitlement.id, { effect: entitlement.effect }, ip);
  invalidate(db, tenantId);
  return entitlement;
}

export function updateSecurityEntitlement(db, tenantId, id, input, actor, ip) {
  const entitlement = updateEntitlement(db, id, input, actor, tenantId);
  if (!entitlement) throw securityError(404, "Entitlement not found", "NOT_FOUND");
  audit(db, actor, "security.entitlement.update", "security", id, {}, ip);
  invalidate(db, tenantId);
  return entitlement;
}

export function setSecurityEntitlementStatus(db, tenantId, id, status, actor, ip) {
  const entitlement = setEntitlementStatus(db, id, status, actor, tenantId);
  if (!entitlement) throw securityError(404, "Entitlement not found", "NOT_FOUND");
  audit(db, actor, "security.entitlement.status", "security", id, { status }, ip);
  invalidate(db, tenantId);
  return entitlement;
}

// Field rules ------------------------------------------------------------------

export function listSecurityFieldRules(db, tenantId, query) {
  return listFieldRules(db, tenantId, query);
}

export function createSecurityFieldRule(db, input, actor, tenantId, ip) {
  const rule = createFieldRule(db, input, actor, tenantId);
  audit(db, actor, "security.field.create", "security", `${rule.object_type}.${rule.field_name}`, { effect: rule.effect }, ip);
  invalidate(db, tenantId);
  return rule;
}

export function updateSecurityFieldRule(db, tenantId, id, input, actor, ip) {
  const rule = updateFieldRule(db, id, input, actor, tenantId);
  if (!rule) throw securityError(404, "Field rule not found", "NOT_FOUND");
  audit(db, actor, "security.field.update", "security", id, {}, ip);
  invalidate(db, tenantId);
  return rule;
}

export function setSecurityFieldRuleStatus(db, tenantId, id, status, actor, ip) {
  const rule = setFieldRuleStatus(db, id, status, actor, tenantId);
  if (!rule) throw securityError(404, "Field rule not found", "NOT_FOUND");
  audit(db, actor, "security.field.status", "security", id, { status }, ip);
  invalidate(db, tenantId);
  return rule;
}

// Classification rules ---------------------------------------------------------

export function listSecurityClassificationRules(db, tenantId, query) {
  return listClassificationRules(db, tenantId, query);
}

export function createSecurityClassificationRule(db, input, actor, tenantId, ip) {
  const rule = createClassificationRule(db, input, actor, tenantId);
  audit(db, actor, "security.classification.create", "security", rule.id, { classification: rule.classification }, ip);
  invalidate(db, tenantId);
  return rule;
}

export function setSecurityClassificationRuleStatus(db, tenantId, id, status, actor, ip) {
  const rule = setClassificationRuleStatus(db, id, status, actor, tenantId);
  if (!rule) throw securityError(404, "Classification rule not found", "NOT_FOUND");
  audit(db, actor, "security.classification.status", "security", id, { status }, ip);
  invalidate(db, tenantId);
  return rule;
}

// Organization & plant rules ---------------------------------------------------

export function listSecurityOrganizationRules(db, tenantId, query) {
  return listOrganizationRules(db, tenantId, query);
}

export function createSecurityOrganizationRule(db, input, actor, tenantId, ip) {
  const rule = createOrganizationRule(db, input, actor, tenantId);
  audit(db, actor, "security.organization.create", "security", rule.id, {}, ip);
  invalidate(db, tenantId);
  return rule;
}

export function setSecurityOrganizationRuleStatus(db, tenantId, id, status, actor, ip) {
  const rule = setOrganizationRuleStatus(db, id, status, actor, tenantId);
  if (!rule) throw securityError(404, "Organization rule not found", "NOT_FOUND");
  audit(db, actor, "security.organization.status", "security", id, { status }, ip);
  invalidate(db, tenantId);
  return rule;
}

export function listSecurityPlantRules(db, tenantId, query) {
  return listPlantRules(db, tenantId, query);
}

export function createSecurityPlantRule(db, input, actor, tenantId, ip) {
  const rule = createPlantRule(db, input, actor, tenantId);
  audit(db, actor, "security.plant.create", "security", rule.id, {}, ip);
  invalidate(db, tenantId);
  return rule;
}

export function setSecurityPlantRuleStatus(db, tenantId, id, status, actor, ip) {
  const rule = setPlantRuleStatus(db, id, status, actor, tenantId);
  if (!rule) throw securityError(404, "Plant rule not found", "NOT_FOUND");
  audit(db, actor, "security.plant.status", "security", id, { status }, ip);
  invalidate(db, tenantId);
  return rule;
}

// Masking rules ----------------------------------------------------------------

export function listSecurityMaskingRules(db, tenantId, query) {
  return listMaskingRules(db, tenantId, query);
}

export function createSecurityMaskingRule(db, input, actor, tenantId, ip) {
  const rule = createMaskingRule(db, input, actor, tenantId);
  audit(db, actor, "security.masking.create", "security", rule.id, { strategy: rule.strategy }, ip);
  invalidate(db, tenantId);
  return rule;
}

export function setSecurityMaskingRuleStatus(db, tenantId, id, status, actor, ip) {
  const rule = setMaskingRuleStatus(db, id, status, actor, tenantId);
  if (!rule) throw securityError(404, "Masking rule not found", "NOT_FOUND");
  audit(db, actor, "security.masking.status", "security", id, { status }, ip);
  invalidate(db, tenantId);
  return rule;
}

// Debugger ---------------------------------------------------------------------

export function listSecurityDecisions(db, tenantId, query) {
  return listDecisions(db, tenantId, query);
}

export function effectiveSecurityContext(db, tenantId, userId, options = {}) {
  const context = buildSecurityContext(db, { id: Number(userId) }, {
    tenantId,
    organizationId: options.organizationId,
    correlationId: options.correlationId,
  });
  return publicSecurityContext(context);
}

export function explainAuthorization(db, actor, tenantId, input = {}, options = {}) {
  return evaluateOne(db, actor, tenantId, input, options);
}

// Batch authorization is evaluated request-by-request so a decision never
// depends on the position of a request in the batch (deterministic). The
// response preserves input order, which callers rely on when zipping results
// back to rows (lists, exports, dashboards).
export function explainAuthorizationBatch(db, actor, tenantId, input = {}, options = {}) {
  const requests = Array.isArray(input.requests) ? input.requests : Array.isArray(input) ? input : [];
  const maxBatch = Number(options.maxBatch) || 500;
  if (requests.length > maxBatch) {
    throw assertionError(`Batch size ${requests.length} exceeds the maximum of ${maxBatch}`);
  }
  const decisions = requests.map((request) => evaluateOne(db, actor, tenantId, request || {}, options));
  return { count: decisions.length, decisions };
}

function evaluateOne(db, actor, tenantId, input = {}, options = {}) {
  const resource = {
    type: String(input.resource_type ?? input.resourceType ?? input.object_type ?? ""),
    id: input.resource_id ?? input.resourceId ?? null,
    organizationId: input.organization_id ?? input.organizationId ?? null,
    plantId: input.plant_id ?? input.plantId ?? null,
    classification: input.classification ?? "",
    attributes: input.attributes && typeof input.attributes === "object" ? input.attributes : {},
  };
  const action = String(input.action ?? "read");
  const subject = input.user_id ?? input.userId
    ? { id: Number(input.user_id ?? input.userId) }
    : actor;
  const decision = authorizeRequest(db, subject, {
    action,
    resource,
    options: {
      tenantId,
      organizationId: resource.organizationId,
      correlationId: options.correlationId,
      cache: false,
      journal: input.journal !== false,
      ip: options.ip,
    },
  });
  const fields = evaluateFields(db, buildSecurityContext(db, subject, { tenantId }), resource.type, action, resource, {});
  return { ...decision, fields: fields.fields.map((field) => ({ field: field.field, effect: field.effect, strategy: field.strategy })) };
}

export function effectivePermissionsFor(db, tenantId, userId) {
  const context = buildSecurityContext(db, { id: Number(userId) }, { tenantId });
  return publicSecurityContext(context);
}

// Centralized authorization decision engine. Combines RBAC (the existing
// permission model) with entitlements, policies, organization, plant,
// classification and field rules into one deterministic decision.
//
// Conflict resolution (documented, deterministic):
//   explicit DENY  > explicit ALLOW  > inherited/RBAC ALLOW  > default DENY
// An explicit ALLOW with a strictly higher priority than every matching DENY
// overrides the deny.
import { checkPermission } from "../authorization.js";
import {
  ancestorOrganizationIds,
  descendantOrganizationIds,
  getOrganization,
} from "../orgs.js";
import {
  DECISION_REASONS,
  DECISION_REASON_MESSAGES,
  DEFAULT_ENFORCEMENT,
  FIELD_EFFECTS,
  CLASSIFICATION_RANK,
} from "./constants.js";
import { evaluateCondition } from "./conditions.js";
import { subjectMatches } from "./context.js";
import { applyMasking } from "./masking.js";
import {
  getObjectType,
  listClassificationRules,
  listEntitlements,
  listFieldRules,
  listMaskingRules,
  listOrganizationRules,
  listPlantRules,
  listPolicies,
} from "./repository.js";

const IAM_ACTION_MAP = {
  create: "create",
  read: "read",
  update: "update",
  delete: "delete",
  execute: "execute",
  export: "read",
  search: "read",
  list: "read",
  manage: "update",
};

function nowIsoLike() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function withinValidity(row, at) {
  if (!row) return false;
  if (row.status && row.status !== "active") return false;
  const time = at || nowIsoLike();
  const from = row.valid_from ?? row.validFrom ?? null;
  const to = row.valid_to ?? row.validTo ?? null;
  if (from && String(from) > time) return false;
  if (to && String(to) < time) return false;
  return true;
}

function resourceTypeMatches(ruleType, resourceType) {
  if (!ruleType) return true;
  return String(ruleType) === String(resourceType || "");
}

function actionMatches(ruleAction, action) {
  if (!ruleAction) return true;
  return String(ruleAction) === String(action);
}

export function buildEvaluationContext(context, resource = {}, action, options = {}) {
  return {
    tenant: { id: context?.tenantId ?? 0 },
    subject: {
      id: context?.userId ?? null,
      username: context?.username ?? null,
      roles: (context?.roles || []).map((role) => role.code),
      role_ids: (context?.roles || []).map((role) => role.id),
      groups: (context?.groups || []).map((group) => group.id),
      organizations: context?.organizationIds || [],
      plants: context?.plantIds || [],
      permissions: (context?.permissions || []).map((permission) => permission.code),
      attributes: context?.attributes || {},
    },
    resource: {
      type: resource.type ?? resource.resource_type ?? "",
      id: resource.id ?? resource.resource_id ?? "",
      organization_id: resource.organizationId ?? resource.organization_id ?? null,
      plant_id: resource.plantId ?? resource.plant_id ?? null,
      owner_id: resource.ownerId ?? resource.owner_id ?? null,
      classification: resource.classification ?? "",
      attributes: resource.attributes || {},
    },
    action,
    request: {
      authentication_method: context?.authenticationMethod ?? null,
      client_application: context?.clientApplication ?? null,
      ip: context?.ip ?? null,
      correlation_id: context?.correlationId ?? null,
      time: options.time || nowIsoLike(),
    },
  };
}

function conditionPasses(row, evalContext) {
  const condition = row.condition ?? null;
  if (!condition) return true;
  return evaluateCondition(condition, evalContext);
}

function rulePriority(row, fallback = 100) {
  const value = Number(row?.priority);
  return Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Scope matching
// ---------------------------------------------------------------------------

function organizationCovers(db, rule, resourceOrgId) {
  if (!resourceOrgId) return false;
  const target = Number(resourceOrgId);
  const base = Number(rule.organization_id);
  if (rule.scope_mode === "cross" || rule.scope_mode === "specific") {
    return target === base;
  }
  if (rule.scope_mode === "own") {
    return target === base;
  }
  if (target === base) return true;
  if (rule.include_descendants || rule.scope_mode === "self_and_descendants" || rule.scope_mode === "include_descendants") {
    return descendantOrganizationIds(db, base).map(Number).includes(target);
  }
  return false;
}

function plantCovers(db, rule, resourcePlantId) {
  if (!resourcePlantId) return false;
  const target = Number(resourcePlantId);
  const base = Number(rule.plant_id);
  if (target === base) return true;
  if (rule.include_descendants) {
    return descendantOrganizationIds(db, base).map(Number).includes(target);
  }
  return false;
}

function classificationAllowed(rank, classification) {
  if (rank === undefined || rank === null) return true;
  return CLASSIFICATION_RANK[classification] <= rank;
}

export function effectiveEnforcement(db, tenantId, objectType) {
  const row = getObjectType(db, tenantId, objectType);
  return row?.enforcement || DEFAULT_ENFORCEMENT;
}

// ---------------------------------------------------------------------------
// Field security
// ---------------------------------------------------------------------------

export function evaluateFields(db, context, resourceType, action, resource = {}, options = {}) {
  const tenantId = Number(context?.tenantId ?? 0);
  const normalizedAction = String(action).toLowerCase();
  const evalContext = buildEvaluationContext(context, { ...resource, type: resourceType }, normalizedAction, options);
  const rules = listFieldRules(db, tenantId, { object_type: resourceType }).filter((rule) => {
    if (rule.status !== "active") return false;
    if (!actionMatches(rule.action, normalizedAction)) return false;
    if (!subjectMatches(context, rule.subject_type, rule.subject_id)) return false;
    return conditionPasses(rule, evalContext);
  });
  const maskingRules = listMaskingRules(db, tenantId).filter((rule) => {
    if (rule.status !== "active") return false;
    if (rule.object_type && rule.object_type !== resourceType) return false;
    if (rule.classification && resource.classification && rule.classification !== resource.classification) return false;
    return true;
  });

  const fieldMap = new Map();
  const rank = { deny: 3, hide: 3, mask: 2, allow: 1 };
  for (const rule of rules) {
    const current = fieldMap.get(rule.field_name);
    const candidate = {
      field: rule.field_name,
      effect: rule.effect,
      strategy: rule.masking_strategy || null,
      config: rule.masking_config || null,
      priority: rule.priority,
      ruleId: rule.id,
    };
    if (!current) {
      fieldMap.set(rule.field_name, candidate);
      continue;
    }
    const candidateRank = rank[candidate.effect] ?? 0;
    const currentRank = rank[current.effect] ?? 0;
    if (candidateRank > currentRank || (candidateRank === currentRank && candidate.priority > current.priority)) {
      fieldMap.set(rule.field_name, candidate);
    }
  }

  // Named masking configurations apply when no explicit field rule exists.
  for (const masking of maskingRules) {
    if (!masking.field_name) continue;
    if (fieldMap.has(masking.field_name)) continue;
    const referenced = rules.some((rule) => {
      const ref = rule.masking_config?.masking_rule ?? rule.masking_config?.maskingRule;
      return ref && ref === masking.code;
    });
    if (referenced) continue;
    fieldMap.set(masking.field_name, {
      field: masking.field_name,
      effect: "mask",
      strategy: masking.strategy,
      config: masking.config,
      priority: masking.priority,
      ruleId: masking.id,
    });
  }

  const fields = [...fieldMap.values()].sort((a, b) => a.field.localeCompare(b.field));
  return { fields, fieldMap };
}

export function maskDocument(document, fieldDecisions, options = {}) {
  if (!document || typeof document !== "object") return document;
  const output = { ...document };
  const applied = [];
  for (const decision of fieldDecisions) {
    const segments = String(decision.field).split(".");
    const leaf = segments.pop();
    let target = output;
    let reachable = true;
    for (const segment of segments) {
      if (!target || typeof target !== "object" || !(segment in target)) {
        reachable = false;
        break;
      }
      target[segment] = Array.isArray(target[segment]) ? [...target[segment]] : { ...target[segment] };
      target = target[segment];
    }
    if (!reachable || !target || typeof target !== "object" || !(leaf in target)) continue;
    if (decision.effect === "deny" || decision.effect === "hide") {
      delete target[leaf];
      applied.push({ field: decision.field, effect: decision.effect });
      continue;
    }
    if (decision.effect === "mask") {
      const masked = applyMasking(decision.strategy || "REDACT", target[leaf], decision.config || {}, options);
      if (masked.hidden) delete target[leaf];
      else target[leaf] = masked.value;
      applied.push({ field: decision.field, effect: "mask", strategy: masked.strategy });
    }
  }
  if (applied.length) output.__masked = applied;
  return output;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

function step(name, passed, reason, detail) {
  return { step: name, passed, reason, detail: detail ?? null };
}

function rbacDecision(db, context, resourceType, action, resource, options) {
  if (!context || context.anonymous) return { allowed: false, reason: DECISION_REASONS.RBAC_DENIED };
  const iamAction = IAM_ACTION_MAP[action] || "read";
  const registration = options.permissionResource
    ? { permission_resource: options.permissionResource }
    : getObjectType(db, Number(context.tenantId ?? 0), resourceType);
  const resourceCode = registration?.permission_resource || resourceType;
  if (!resourceCode) return { allowed: false, reason: DECISION_REASONS.RBAC_DENIED };
  try {
    const result = checkPermission(db, { id: context.userId }, resourceCode, iamAction, {
      organizationId: resource.organizationId ?? resource.organization_id ?? context.attributes?.primary_organization_id ?? 0,
    });
    return {
      allowed: Boolean(result?.allowed),
      reason: result?.allowed ? DECISION_REASONS.RBAC_ALLOWED : DECISION_REASONS.RBAC_DENIED,
      detail: result?.reason || null,
    };
  } catch {
    return { allowed: false, reason: DECISION_REASONS.RBAC_DENIED };
  }
}

export function authorize(db, context, { action = "read", resource = {}, options = {} } = {}) {
  const started = Date.now();
  const tenantId = Number(context?.tenantId ?? 0);
  const normalizedAction = String(action).toLowerCase();
  const resourceType = String(resource.type ?? resource.resource_type ?? "");
  const evalContext = buildEvaluationContext(context, resource, normalizedAction, options);
  const steps = [];

  const decision = {
    allowed: false,
    decision: "deny",
    reason: DECISION_REASONS.DEFAULT_DENY,
    message: DECISION_REASON_MESSAGES[DECISION_REASONS.DEFAULT_DENY],
    subject: { id: context?.userId ?? null, username: context?.username ?? null, anonymous: Boolean(context?.anonymous) },
    resource: { type: resourceType, id: resource.id ?? null },
    action: normalizedAction,
    fields: [],
    steps,
    cached: false,
    durationMs: 0,
  };

  // 1. Tenant isolation always wins.
  const resourceTenant = Number(resource.tenantId ?? resource.tenant_id ?? tenantId);
  if (resourceTenant && tenantId && resourceTenant !== tenantId) {
    steps.push(step("tenant", false, DECISION_REASONS.TENANT_DENIED, { resourceTenant, subjectTenant: tenantId }));
    return finish(decision, DECISION_REASONS.TENANT_DENIED, started);
  }
  steps.push(step("tenant", true, null, { tenantId }));

  const enforcement = options.enforcement || effectiveEnforcement(db, tenantId, resourceType);
  const candidatePolicies = listPolicies(db, tenantId, { status: "active" }).filter((policy) => {
    if (!withinValidity(policy)) return false;
    if (!resourceTypeMatches(policy.resource_type, resourceType)) return false;
    if (!actionMatches(policy.action, normalizedAction)) return false;
    if (!subjectMatches(context, policy.subject_type, policy.subject_id)) return false;
    return conditionPasses(policy, evalContext);
  });
  const candidateEntitlements = listEntitlements(db, tenantId, { status: "active" }).filter((entitlement) => {
    if (!resourceTypeMatches(entitlement.resource_type, resourceType)) return false;
    if (!actionMatches(entitlement.action, normalizedAction)) return false;
    if (!subjectMatches(context, entitlement.subject_type, entitlement.subject_id)) return false;
    if (entitlement.classification && entitlement.classification !== resource.classification) return false;
    if (entitlement.scope === "object" && String(entitlement.resource_id) !== String(resource.id ?? "")) return false;
    return conditionPasses(entitlement, evalContext);
  });
  const candidateClassificationRules = listClassificationRules(db, tenantId).filter((rule) => {
    if (!withinValidity(rule)) return false;
    if (rule.classification !== resource.classification) return false;
    if (!resourceTypeMatches(rule.resource_type, resourceType)) return false;
    if (!actionMatches(rule.action, normalizedAction)) return false;
    if (!subjectMatches(context, rule.subject_type, rule.subject_id)) return false;
    return conditionPasses(rule, evalContext);
  });
  const candidateOrgRules = listOrganizationRules(db, tenantId).filter((rule) => {
    if (!withinValidity(rule)) return false;
    if (!resourceTypeMatches(rule.resource_type, resourceType)) return false;
    if (!actionMatches(rule.action, normalizedAction)) return false;
    if (!subjectMatches(context, rule.subject_type, rule.subject_id)) return false;
    return conditionPasses(rule, evalContext);
  });
  const candidatePlantRules = listPlantRules(db, tenantId).filter((rule) => {
    if (!withinValidity(rule)) return false;
    if (!resourceTypeMatches(rule.resource_type, resourceType)) return false;
    if (!actionMatches(rule.action, normalizedAction)) return false;
    if (!subjectMatches(context, rule.subject_type, rule.subject_id)) return false;
    return conditionPasses(rule, evalContext);
  });

  const allows = [];
  const denies = [];
  const addMatch = (bucket, effect, source, rule) => {
    const entry = {
      source,
      effect,
      reason: effect === "deny"
        ? reasonForSourceDeny(source)
        : reasonForSourceAllow(source),
      priority: rulePriority(rule),
      ruleCode: rule.code || rule.uuid || rule.id || null,
      ruleId: rule.id ?? null,
    };
    bucket.push(entry);
    return entry;
  };

  for (const policy of candidatePolicies) {
    addMatch(policy.effect === "deny" ? denies : allows, policy.effect, "policy", policy);
  }
  for (const entitlement of candidateEntitlements) {
    addMatch(entitlement.effect === "deny" ? denies : allows, entitlement.effect, "entitlement", entitlement);
  }
  for (const rule of candidateClassificationRules) {
    addMatch(rule.effect === "deny" ? denies : allows, rule.effect, "classification", rule);
  }

  const resourceOrgId = resource.organizationId ?? resource.organization_id ?? null;
  const applicableOrgRules = candidateOrgRules.filter((rule) => rule.resource_type === resourceType || !rule.resource_type);
  const matchedOrgRules = candidateOrgRules.filter((rule) => organizationCovers(db, rule, resourceOrgId) || !resourceOrgId && rule.effect === "allow");
  for (const rule of matchedOrgRules) {
    addMatch(rule.effect === "deny" ? denies : allows, rule.effect, "organization", rule);
  }
  if (applicableOrgRules.length && !matchedOrgRules.length) {
    denies.push({ source: "organization", effect: "deny", reason: DECISION_REASONS.ORGANIZATION_DENIED, priority: 1000 });
  }

  const resourcePlantId = resource.plantId ?? resource.plant_id ?? null;
  const applicablePlantRules = candidatePlantRules.filter((rule) => rule.resource_type === resourceType || !rule.resource_type);
  const matchedPlantRules = candidatePlantRules.filter((rule) => plantCovers(db, rule, resourcePlantId));
  for (const rule of matchedPlantRules) {
    addMatch(rule.effect === "deny" ? denies : allows, rule.effect, "plant", rule);
  }
  if (applicablePlantRules.length && !matchedPlantRules.length && resourcePlantId) {
    denies.push({ source: "plant", effect: "deny", reason: DECISION_REASONS.PLANT_DENIED, priority: 1000 });
  }

  const rbac = rbacDecision(db, context, resourceType, normalizedAction, resource, options);

  // Record one step per dimension for the debugger.
  steps.push(step("rbac", rbac.allowed, rbac.reason, rbac.detail));
  steps.push(step("policy", !denies.some((d) => d.source === "policy"), denies.some((d) => d.source === "policy") ? DECISION_REASONS.POLICY_DENIED : DECISION_REASONS.POLICY_ALLOWED, {
    matched: candidatePolicies.length,
  }));
  steps.push(step("object", !denies.some((d) => d.source === "entitlement"), denies.some((d) => d.source === "entitlement") ? DECISION_REASONS.ENTITLEMENT_DENIED : DECISION_REASONS.ENTITLEMENT_ALLOWED, {
    matched: candidateEntitlements.length,
  }));
  steps.push(step("organization", !denies.some((d) => d.source === "organization"), denies.some((d) => d.source === "organization") ? DECISION_REASONS.ORGANIZATION_DENIED : null, {
    matched: matchedOrgRules.length,
    applicable: applicableOrgRules.length,
  }));
  steps.push(step("plant", !denies.some((d) => d.source === "plant"), denies.some((d) => d.source === "plant") ? DECISION_REASONS.PLANT_DENIED : null, {
    matched: matchedPlantRules.length,
    applicable: applicablePlantRules.length,
  }));
  steps.push(step("classification", !denies.some((d) => d.source === "classification"), denies.some((d) => d.source === "classification") ? DECISION_REASONS.CLASSIFICATION_DENIED : null, {
    matched: candidateClassificationRules.length,
  }));

  const fieldResult = evaluateFields(db, context, resourceType, normalizedAction, resource, options);
  const deniedFields = fieldResult.fields.filter((field) => field.effect === "deny" || field.effect === "hide");
  const maskedFields = fieldResult.fields.filter((field) => field.effect === "mask");
  decision.fields = fieldResult.fields.map((field) => ({
    field: field.field,
    effect: field.effect,
    strategy: field.strategy || null,
  }));
  steps.push(step("field", true, deniedFields.length ? DECISION_REASONS.FIELD_DENIED : null, {
    denied: deniedFields.map((field) => field.field),
    masked: maskedFields.map((field) => field.field),
  }));

  const maxDeny = denies.reduce((max, entry) => Math.max(max, entry.priority), -Infinity);
  const maxAllow = allows.reduce((max, entry) => Math.max(max, entry.priority), -Infinity);

  let outcome;
  if (denies.length && maxDeny >= maxAllow) {
    const strongest = denies.find((entry) => entry.priority === maxDeny) || denies[0];
    outcome = { allowed: false, decision: "deny", reason: strongest.reason, matched: strongest };
  } else if (allows.length) {
    const strongest = allows.find((entry) => entry.priority === maxAllow) || allows[0];
    outcome = { allowed: true, decision: "allow", reason: strongest.reason, matched: strongest };
  } else if (rbac.allowed) {
    outcome = { allowed: true, decision: "allow", reason: DECISION_REASONS.RBAC_ALLOWED, matched: { source: "rbac" } };
  } else {
    outcome = { allowed: false, decision: "deny", reason: DECISION_REASONS.DEFAULT_DENY, matched: null };
  }

  decision.allowed = outcome.allowed;
  decision.decision = outcome.decision;
  decision.reason = outcome.reason;
  decision.message = DECISION_REASON_MESSAGES[outcome.reason] || outcome.reason;
  decision.matched = outcome.matched;
  decision.enforcement = enforcement;
  decision.fieldDecisions = fieldResult.fields;
  decision.fieldMap = fieldResult.fieldMap;
  decision.durationMs = Date.now() - started;
  return decision;
}

function reasonForSourceAllow(source) {
  if (source === "policy") return DECISION_REASONS.POLICY_ALLOWED;
  if (source === "entitlement") return DECISION_REASONS.ENTITLEMENT_ALLOWED;
  return DECISION_REASONS.RBAC_ALLOWED;
}

function reasonForSourceDeny(source) {
  if (source === "classification") return DECISION_REASONS.CLASSIFICATION_DENIED;
  if (source === "organization") return DECISION_REASONS.ORGANIZATION_DENIED;
  if (source === "plant") return DECISION_REASONS.PLANT_DENIED;
  if (source === "policy") return DECISION_REASONS.POLICY_DENIED;
  if (source === "entitlement") return DECISION_REASONS.ENTITLEMENT_DENIED;
  return DECISION_REASONS.DEFAULT_DENY;
}

function finish(decision, reason, started) {
  decision.reason = reason;
  decision.message = DECISION_REASON_MESSAGES[reason] || reason;
  decision.durationMs = Date.now() - started;
  return decision;
}

export { ancestorOrganizationIds, getOrganization };

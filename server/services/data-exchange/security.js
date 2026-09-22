// Data Security integration.
//
// The framework never trusts the client to declare authorization. Import and
// export enforce the centralized Data Security model (field level, row level,
// classification and masking) at the server. On import, unauthorized records
// are rejected; on export, fields are hidden/masked and results are filtered
// before serialization, so unauthorized data never reaches the output file
// (spec §49, §50).
import { buildSecurityContext } from "../security/context.js";
import { evaluateFields, maskDocument } from "../security/engine.js";
import { authorizeRequest } from "../security/index.js";
import { getObjectType } from "../security/repository.js";
import { checkPermission } from "../authorization.js";
import { securityBlocked } from "./errors.js";

// Object instances are governed by the object & relationship framework's IAM
// resource unless a type is explicitly onboarded to the security engine with its
// own permission resource.
const DEFAULT_OBJECT_RESOURCE = "iam.objects.instances";
const IAM_ACTIONS = { create: "create", read: "read", update: "update", delete: "delete", execute: "execute" };

export function buildExchangeContext(db, actor, { tenantId, organizationId = null, ip = null, correlationId = null } = {}) {
  return buildSecurityContext(db, actor, { tenantId, organizationId, ip, correlationId });
}

// Field-level decisions for one object type + action.
export function fieldDecisionsFor(db, actor, objectType, action, options = {}) {
  const context = options.context || buildExchangeContext(db, actor, options);
  const { fields } = evaluateFields(db, context, objectType, String(action).toLowerCase(), {}, options);
  return { context, fields };
}

// Applies field-level hide/deny/mask decisions to a record. Returns the safe
// record plus the list of fields that were removed or masked.
export function enforceRecordFields(db, actor, { objectType, record, action = "read", tenantId, organizationId, ip, context }) {
  const decision = fieldDecisionsFor(db, actor, objectType, action, { tenantId, organizationId, ip, context });
  if (!decision.fields.length) return { record, masked: [], denied: [], decisions: [] };
  const safe = maskDocument({ ...record }, decision.fields, {});
  delete safe.__masked;
  const denied = decision.fields.filter((field) => field.effect === "deny" || field.effect === "hide").map((field) => field.field);
  const masked = decision.fields.filter((field) => field.effect === "mask").map((field) => field.field);
  return { record: safe, masked, denied, decisions: decision.fields };
}

// Row-level authorization for a single record, evaluated against the centralized
// security engine. Throws a security error when the actor may not proceed.
export function authorizeRecord(db, actor, { objectType, objectId = null, action, tenantId, organizationId = null, classification = "", ip = null, context = null }) {
  const decision = authorizeRequest(db, actor, {
    action,
    resource: {
      type: objectType,
      id: objectId,
      organization_id: organizationId,
      classification,
    },
    options: { tenantId, organizationId, ip, context, audit: false },
  });
  if (!decision.allowed) {
    if (fallbackAllows(db, actor, { objectType, action, tenantId, organizationId })) {
      return { ...decision, allowed: true, reason: "RBAC_ALLOWED", fallback: true };
    }
    throw securityBlocked({ action, object_type: objectType, reason: decision.reason });
  }
  return decision;
}

// Object types that are not explicitly onboarded to the security engine still
// respect platform IAM: fall back to the object framework's permission resource
// so a tenant administrator can move data without first authoring a policy.
function fallbackAllows(db, actor, { objectType, action, tenantId, organizationId }) {
  if (!actor?.id) return false;
  const registration = getObjectType(db, Number(tenantId), objectType);
  const resourceCode = registration?.permission_resource || DEFAULT_OBJECT_RESOURCE;
  const iamAction = IAM_ACTIONS[String(action).toLowerCase()] || "read";
  try {
    const result = checkPermission(db, { id: actor.id }, resourceCode, iamAction, { organizationId: organizationId || 0 });
    return Boolean(result?.allowed);
  } catch {
    return false;
  }
}

// Authorizes an exchange-level operation (e.g. executing an export definition)
// against the object type's registered permission resource.
export function authorizeExchangeAction(db, actor, { objectType, action, tenantId, organizationId = null, ip = null }) {
  return authorizeRequest(db, actor, {
    action,
    resource: { type: objectType, organization_id: organizationId },
    options: { tenantId, organizationId, ip, audit: false },
  });
}

export { maskDocument };

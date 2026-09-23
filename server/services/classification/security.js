// Data Security & Entitlement integration for classification.
//
// The classification engine never trusts the client to declare authorization.
// Definition and assignment operations are authorized against the centralized
// Data Security model and platform IAM, and assignment writes are additionally
// authorized against the owning business object type. Tenant and organization
// scope are always resolved server-side (spec §28, §54).
import { buildSecurityContext } from "../security/context.js";
import { evaluateFields, maskDocument } from "../security/engine.js";
import { authorizeRequest } from "../security/index.js";
import { getObjectType } from "../security/repository.js";
import { checkPermission } from "../authorization.js";
import { securityBlocked } from "./errors.js";

const DEFAULT_OBJECT_RESOURCE = "iam.objects.instances";
const IAM_ACTIONS = { create: "create", read: "read", update: "update", delete: "delete", execute: "execute" };

export function buildClassificationContext(db, actor, { tenantId, organizationId = null, ip = null, correlationId = null } = {}) {
  return buildSecurityContext(db, actor, { tenantId, organizationId, ip, correlationId });
}

export function fieldDecisionsFor(db, actor, objectType, action, options = {}) {
  const context = options.context || buildClassificationContext(db, actor, options);
  const { fields } = evaluateFields(db, context, objectType, String(action).toLowerCase(), {}, options);
  return { context, fields };
}

export function enforceRecordFields(db, actor, { objectType, record, action = "read", tenantId, organizationId, ip, context }) {
  const decision = fieldDecisionsFor(db, actor, objectType, action, { tenantId, organizationId, ip, context });
  if (!decision.fields.length) return { record, masked: [], denied: [], decisions: [] };
  const safe = maskDocument({ ...record }, decision.fields, {});
  delete safe.__masked;
  const denied = decision.fields.filter((field) => field.effect === "deny" || field.effect === "hide").map((field) => field.field);
  const masked = decision.fields.filter((field) => field.effect === "mask").map((field) => field.field);
  return { record: safe, masked, denied, decisions: decision.fields };
}

// Row-level authorization of a classified business object against the shared
// security engine, falling back to platform IAM for object types that are not
// yet onboarded to the Data Security model.
export function authorizeObject(db, actor, { objectType, objectId = null, action, tenantId, organizationId = null, classification = "", ip = null, context = null }) {
  const decision = authorizeRequest(db, actor, {
    action,
    resource: { type: objectType, id: objectId, organization_id: organizationId, classification },
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

function fallbackAllows(db, actor, { objectType, action, tenantId, organizationId }) {
  if (!actor?.id) return false;
  const registration = getObjectType(db, Number(tenantId), objectType);
  const resourceCode = registration?.permission_resource || DEFAULT_OBJECT_RESOURCE;
  const iamAction = IAM_ACTIONS[String(action).toLowerCase()] || "read";
  try {
    return Boolean(checkPermission(db, { id: actor.id }, resourceCode, iamAction, { organizationId: organizationId || 0 })?.allowed);
  } catch {
    return false;
  }
}

// Authorizes a classification-level operation against an IAM resource code.
export function authorizeClassificationAction(db, actor, { resource, action, tenantId, organizationId = null }) {
  if (!actor?.id) return { allowed: false, reason: "NO_ACTOR" };
  try {
    return checkPermission(db, { id: actor.id }, resource, action, { organizationId: organizationId || 0 });
  } catch (error) {
    return { allowed: false, reason: "ERROR", message: error.message };
  }
}

export { maskDocument };

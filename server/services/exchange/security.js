// Data Security & Entitlement integration for Standards & Exchange (§27).
//
// Exchange reads and writes objects across domains, so every exported record is
// authorized through the centralized Data Security engine with an IAM fallback.
// Deny-by-default: anything not explicitly allowed is excluded, and export
// refuses to proceed when authorization cannot be established.
import { buildSecurityContext } from "../security/context.js";
import { authorizeRequest } from "../security/index.js";
import { getObjectType } from "../security/repository.js";
import { checkPermission } from "../authorization.js";
import { securityBlocked, classificationBlocked } from "./errors.js";

const DEFAULT_OBJECT_RESOURCE = "iam.objects.instances";
const IAM_ACTIONS = { create: "create", read: "read", update: "update", delete: "delete", execute: "execute" };

export function assertExchangeAction(db, actor, { resource, action, tenantId, organizationId = null }) {
  if (!actor?.id) throw securityBlocked({ action, resource, reason: "NO_ACTOR" });
  let decision;
  try {
    decision = checkPermission(db, { id: actor.id }, resource, action, { organizationId: organizationId || 0 });
  } catch (error) {
    throw securityBlocked({ action, resource, reason: "ERROR", message: error.message });
  }
  if (!decision?.allowed) throw securityBlocked({ action, resource, reason: decision?.reason || "DENIED" });
  return decision;
}

export function buildExchangeContext(db, actor, { tenantId, organizationId = null, ip = null, correlationId = null } = {}) {
  return buildSecurityContext(db, actor, { tenantId, organizationId, ip, correlationId });
}

// Per-transaction memoized authorizer for a set of canonical/enterprise records.
export function createRecordAuthorizer(db, actor, { tenantId, action = "read", organizationId = null, ip = null, context = null } = {}) {
  const cache = new Map();
  const securityContext = context || buildExchangeContext(db, actor, { tenantId, organizationId, ip });
  const allows = (objectType, recordOrgId = null, classification = "") => {
    const key = `${String(objectType).toLowerCase()}|${recordOrgId ?? organizationId ?? 0}|${classification || ""}`;
    if (cache.has(key)) return cache.get(key);
    let allowed = false;
    try {
      const decision = authorizeRequest(db, actor, {
        action,
        resource: { type: objectType, id: null, organization_id: recordOrgId ?? organizationId, classification },
        options: { tenantId, organizationId: recordOrgId ?? organizationId, ip, context: securityContext, audit: false },
      });
      allowed = Boolean(decision.allowed);
      if (!allowed) allowed = fallbackAllows(db, actor, { objectType, action, tenantId, organizationId: recordOrgId ?? organizationId });
    } catch {
      allowed = fallbackAllows(db, actor, { objectType, action, tenantId, organizationId: recordOrgId ?? organizationId });
    }
    cache.set(key, allowed);
    return allowed;
  };
  return {
    allows,
    allowsRecord(record) {
      const classification = (record?.classification || []).map((entry) => entry.code || entry).filter(Boolean).join(",");
      return allows(record?.object_type || record?.type || "object", record?.organization_id ?? null, classification);
    },
    filter(records) {
      return (records || []).filter((record) => this.allowsRecord(record));
    },
    deniedCount(records) {
      return (records || []).filter((record) => !this.allowsRecord(record)).length;
    },
    decisions: cache,
  };
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

// Enforces export authorization and classification policy before any data is
// serialized (§19). Returns the records that are safe to export.
export function guardExport(db, actor, { tenantId, definition, records, organizationId = null, ip = null, correlationId = null, allowPartial = true }) {
  const action = "read";
  const authorizer = createRecordAuthorizer(db, actor, { tenantId, action, organizationId, ip, context: buildExchangeContext(db, actor, { tenantId, organizationId, ip, correlationId }) });
  const allowed = authorizer.filter(records);
  const denied = (records || []).length - allowed.length;
  if (denied > 0 && !allowPartial) {
    throw classificationBlocked({ denied, export: "refused", reason: "One or more records are not authorized for export" });
  }
  const policy = definition?.security_policy || {};
  if (policy.require_authorization === true && allowed.length === 0 && (records || []).length > 0) {
    throw securityBlocked({ reason: "NO_AUTHORIZED_RECORDS" });
  }
  return { allowed, denied, policy };
}

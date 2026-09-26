// Data Security & Entitlement integration for the Digital Thread domain.
//
// Thread traversals read across every business domain, so every node and every
// listed object is authorized through the centralized Data Security model with a
// platform-IAM fallback. Decisions are memoized per object type for the life of
// one query so a large traversal does not repeat the same check.
import { buildSecurityContext } from "../security/context.js";
import { authorizeRequest } from "../security/index.js";
import { getObjectType } from "../security/repository.js";
import { checkPermission } from "../authorization.js";
import { securityBlocked } from "./errors.js";

const DEFAULT_OBJECT_RESOURCE = "iam.objects.instances";
const IAM_ACTIONS = { create: "create", read: "read", update: "update", delete: "delete", execute: "execute" };

export function buildThreadContext(db, actor, { tenantId, organizationId = null, ip = null, correlationId = null } = {}) {
  return buildSecurityContext(db, actor, { tenantId, organizationId, ip, correlationId });
}

export function authorizeThreadAction(db, actor, { resource, action, tenantId, organizationId = null }) {
  if (!actor?.id) return { allowed: false, reason: "NO_ACTOR" };
  try {
    return checkPermission(db, { id: actor.id }, resource, action, { organizationId: organizationId || 0 });
  } catch (error) {
    return { allowed: false, reason: "ERROR", message: error.message };
  }
}

export function assertThreadAction(db, actor, options) {
  const decision = authorizeThreadAction(db, actor, options);
  if (!decision.allowed) throw securityBlocked({ action: options.action, resource: options.resource, reason: decision.reason });
  return decision;
}

// Per-query memoized node authorization. A node is allowed when the Data
// Security engine permits it, or (for object types not yet onboarded) when the
// caller holds the mapped IAM action on the type's permission resource.
export function createNodeAuthorizer(db, actor, { tenantId, organizationId = null, ip = null, action = "read", context = null } = {}) {
  const cache = new Map();
  const securityContext = context || buildThreadContext(db, actor, { tenantId, organizationId, ip });

  const allowsType = (objectType, nodeOrgId = null) => {
    const key = `${String(objectType).toLowerCase()}|${nodeOrgId ?? organizationId ?? 0}`;
    if (cache.has(key)) return cache.get(key);
    let allowed = false;
    try {
      const decision = authorizeRequest(db, actor, {
        action,
        resource: { type: objectType, id: null, organization_id: nodeOrgId ?? organizationId, classification: "" },
        options: { tenantId, organizationId: nodeOrgId ?? organizationId, ip, context: securityContext, audit: false },
      });
      allowed = Boolean(decision.allowed);
      if (!allowed) allowed = fallbackAllows(db, actor, { objectType, action, tenantId, organizationId: nodeOrgId ?? organizationId });
    } catch {
      allowed = fallbackAllows(db, actor, { objectType, action, tenantId, organizationId: nodeOrgId ?? organizationId });
    }
    cache.set(key, allowed);
    return allowed;
  };

  return {
    allowsType,
    allowsNode(node) {
      if (!node) return false;
      return allowsType(node.object_type, node.organization_id ?? null);
    },
    filter(nodes) {
      return (nodes || []).filter((node) => this.allowsNode(node));
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

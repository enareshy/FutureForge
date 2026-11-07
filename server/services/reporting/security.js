// Data Security & Entitlement integration for Reporting & Analytics (§29).
//
// Reporting reads objects across every domain, so every resolved record is
// authorized through the centralized Data Security engine with an IAM fallback.
// Deny-by-default: a report, dashboard KPI, aggregation or export must never
// reveal a record (or even the fact that a record exists) to an unauthorized
// subject. Authorization always happens server-side before any aggregation.
import { buildSecurityContext, buildSecurityContextAsync } from "../security/context.js";
import { authorizeRequest, authorizeRequestAsync } from "../security/index.js";
import { getObjectType, getObjectTypeAsync } from "../security/repository.js";
import { checkPermission, checkPermissionAsync } from "../authorization.js";
import { securityBlocked } from "./errors.js";

const DEFAULT_OBJECT_RESOURCE = "iam.objects.instances";
const IAM_ACTIONS = { create: "create", read: "read", update: "update", delete: "delete", execute: "execute" };

export function assertReportingAction(db, actor, { resource, action, tenantId, organizationId = null }) {
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

export async function assertReportingActionAsync(db, actor, { resource, action, tenantId, organizationId = null }) {
  if (!actor?.id) throw securityBlocked({ action, resource, reason: "NO_ACTOR" });
  let decision;
  try {
    decision = await checkPermissionAsync(db, { id: actor.id }, resource, action, { organizationId: organizationId || 0 });
  } catch (error) {
    throw securityBlocked({ action, resource, reason: "ERROR", message: error.message });
  }
  if (!decision?.allowed) throw securityBlocked({ action, resource, reason: decision?.reason || "DENIED" });
  return decision;
}

export function buildReportingContext(db, actor, { tenantId, organizationId = null, ip = null, correlationId = null } = {}) {
  return buildSecurityContext(db, actor, { tenantId, organizationId, ip, correlationId });
}

export async function buildReportingContextAsync(db, actor, { tenantId, organizationId = null, ip = null, correlationId = null } = {}) {
  return await buildSecurityContextAsync(db, actor, { tenantId, organizationId, ip, correlationId });
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

async function fallbackAllowsAsync(db, actor, { objectType, action, tenantId, organizationId }) {
  if (!actor?.id) return false;
  const registration = await getObjectTypeAsync(db, Number(tenantId), objectType);
  const resourceCode = registration?.permission_resource || DEFAULT_OBJECT_RESOURCE;
  const iamAction = IAM_ACTIONS[String(action).toLowerCase()] || "read";
  try {
    return Boolean((await checkPermissionAsync(db, { id: actor.id }, resourceCode, iamAction, { organizationId: organizationId || 0 }))?.allowed);
  } catch {
    return false;
  }
}

// Per-execution memoized authorizer for a set of resolved semantic records. The
// decision cache is keyed by object type, organization and classification so a
// single execution does not repeat authorization work per row.
export function createRecordAuthorizer(db, actor, { tenantId, action = "read", organizationId = null, ip = null, context = null } = {}) {
  const cache = new Map();
  const securityContext = context || buildReportingContext(db, actor, { tenantId, organizationId, ip });
  const allows = (objectType, recordOrgId = null, classification = "") => {
    const key = `${String(objectType || "object").toLowerCase()}|${recordOrgId ?? organizationId ?? 0}|${classification || ""}`;
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
      const classification = (record?.classification || []).map?.((entry) => entry.code || entry).filter(Boolean).join(",") || record?.classification || "";
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

export async function createRecordAuthorizerAsync(db, actor, { tenantId, action = "read", organizationId = null, ip = null, context = null } = {}) {
  const cache = new Map();
  const securityContext = context || (await buildReportingContextAsync(db, actor, { tenantId, organizationId, ip }));
  const allows = async (objectType, recordOrgId = null, classification = "") => {
    const key = `${String(objectType || "object").toLowerCase()}|${recordOrgId ?? organizationId ?? 0}|${classification || ""}`;
    if (cache.has(key)) return cache.get(key);
    let allowed = false;
    try {
      const decision = await authorizeRequestAsync(db, actor, {
        action,
        resource: { type: objectType, id: null, organization_id: recordOrgId ?? organizationId, classification },
        options: { tenantId, organizationId: recordOrgId ?? organizationId, ip, context: securityContext, audit: false },
      });
      allowed = Boolean(decision.allowed);
      if (!allowed) allowed = await fallbackAllowsAsync(db, actor, { objectType, action, tenantId, organizationId: recordOrgId ?? organizationId });
    } catch {
      allowed = await fallbackAllowsAsync(db, actor, { objectType, action, tenantId, organizationId: recordOrgId ?? organizationId });
    }
    cache.set(key, allowed);
    return allowed;
  };
  return {
    allows,
    async allowsRecord(record) {
      const classification = (record?.classification || []).map?.((entry) => entry.code || entry).filter(Boolean).join(",") || record?.classification || "";
      return await allows(record?.object_type || record?.type || "object", record?.organization_id ?? null, classification);
    },
    async filter(records) {
      const list = records || [];
      const decisions = await Promise.all(list.map((record) => this.allowsRecord(record)));
      return list.filter((record, index) => decisions[index]);
    },
    async deniedCount(records) {
      const list = records || [];
      const decisions = await Promise.all(list.map((record) => this.allowsRecord(record)));
      return decisions.filter((allowed) => !allowed).length;
    },
    decisions: cache,
  };
}

// Resolves the tenant/scope a subject may report on. Reporting never widens the
// caller's scope; a missing tenant scope is treated as deny-all.
export function resolveReportScope(db, actor, { tenantId, organizationId = null } = {}) {
  if (!tenantId) return { tenantId: null, organizationId, allowed: false };
  return { tenantId: Number(tenantId), organizationId: organizationId ?? null, allowed: true };
}

export async function resolveReportScopeAsync(db, actor, { tenantId, organizationId = null } = {}) {
  if (!tenantId) return { tenantId: null, organizationId, allowed: false };
  return { tenantId: Number(tenantId), organizationId: organizationId ?? null, allowed: true };
}

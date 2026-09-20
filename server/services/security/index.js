// Facade for the centralized Data Security & Entitlement Model. Business
// modules import from here and never reimplement authorization.
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { emitDomainEvent } from "../events/emit.js";
import { DECISION_REASONS } from "./constants.js";
import { buildSecurityContext, publicSecurityContext } from "./context.js";
import { authorize as evaluate, evaluateFields, maskDocument as applyMaskDocument } from "./engine.js";
import {
  bumpEpoch,
  recordDecision,
} from "./repository.js";
import {
  clearDecisionCache,
  decisionCacheKey,
  getCachedDecision,
  setCachedDecision,
} from "./cache.js";

export * from "./constants.js";
export * from "./context.js";
export * from "./conditions.js";
export * from "./masking.js";
export * from "./repository.js";
export * from "./row-security.js";
export {
  authorize,
  authorize as evaluateAuthorization,
  buildEvaluationContext,
  effectiveEnforcement,
  evaluateFields,
  maskDocument,
} from "./engine.js";
export { decisionCacheSize, clearDecisionCache } from "./cache.js";

function stripInternal(decision) {
  if (!decision) return null;
  const { fieldMap, ...rest } = decision;
  return rest;
}

export function authorizeRequest(db, actor, { action = "read", resource = {}, options = {} } = {}) {
  const context =
    options.context ||
    buildSecurityContext(db, actor, {
      tenantId: options.tenantId,
      organizationId: options.organizationId,
      authenticationMethod: options.authenticationMethod,
      sessionId: options.sessionId,
      clientApplication: options.clientApplication,
      correlationId: options.correlationId,
      ip: options.ip,
      attributes: options.attributes,
    });

  const tenantId = Number(options.tenantId ?? context.tenantId ?? 0);
  const resourceType = String(resource.type ?? resource.resource_type ?? "");
  const useCache = options.cache !== false && context.anonymous !== true;
  const cacheKey = decisionCacheKey(tenantId, context, action, resourceType, resource.id);

  if (useCache) {
    const cached = getCachedDecision(db, tenantId, context, action, resourceType, resource.id);
    if (cached) return { ...stripInternal(cached), cached: true };
  }

  const decision = evaluate(db, context, { action, resource, options });
  if (useCache) {
    setCachedDecision(db, tenantId, context, action, resourceType, resource.id, decision);
  }

  if (options.audit !== false && !decision.allowed) {
    auditDenied(db, { context, decision, resource, action, options });
  }
  if (options.journal) {
    recordDecision(db, {
      tenantId,
      userId: context.userId,
      action,
      resourceType,
      resourceId: resource.id ?? "",
      decision: decision.decision,
      reason: decision.reason,
      allowed: decision.allowed,
      organizationId: resource.organizationId ?? resource.organization_id ?? null,
      plantId: resource.plantId ?? resource.plant_id ?? null,
      classification: resource.classification ?? "",
      durationMs: decision.durationMs,
      cached: decision.cached,
      correlationId: options.correlationId,
      steps: decision.steps,
      context: publicSecurityContext(context),
    });
  }
  return stripInternal(decision);
}

export function authorizeBatch(db, actor, requests = [], options = {}) {
  const list = Array.isArray(requests) ? requests : [];
  const maxBatch = Number(options.maxBatch) || 500;
  if (list.length > maxBatch) {
    throw new HttpError(400, `Batch size ${list.length} exceeds the maximum of ${maxBatch}`);
  }
  return list.map((request = {}) =>
    authorizeRequest(db, actor, {
      action: request.action ?? "read",
      resource: request.resource || {},
      options,
    })
  );
}

export function requireAuthorized(db, actor, { action = "read", resource = {}, options = {} } = {}) {
  const decision = authorizeRequest(db, actor, { action, resource, options });
  if (!decision.allowed) {
    const error = new HttpError(403, decision.message || "Access denied");
    error.code = decision.reason;
    error.details = {
      reason: decision.reason,
      action,
      resource: decision.resource,
    };
    throw error;
  }
  return decision;
}

export function maskWithDecision(document, decision, options = {}) {
  const fieldDecisions = decision?.fieldDecisions || [];
  if (!fieldDecisions.length) return document;
  return applyMaskDocument(document, fieldDecisions, options);
}

export function maskDocuments(documents, decision, options = {}) {
  if (!Array.isArray(documents)) return documents;
  return documents.map((document) => maskWithDecision(document, decision, options));
}

export function maskDocumentsByType(db, actor, documents, { action = "read", options = {} } = {}) {
  if (!Array.isArray(documents) || !documents.length) return documents;
  const context =
    options.context ||
    buildSecurityContext(db, actor, {
      tenantId: options.tenantId,
      organizationId: options.organizationId,
      correlationId: options.correlationId,
      ip: options.ip,
    });
  const decisions = new Map();
  return documents.map((document) => {
    const objectType = document.object_type || document.objectType;
    if (!objectType) return document;
    if (!decisions.has(objectType)) {
      decisions.set(
        objectType,
        evaluateFields(db, context, objectType, action, {}, options).fields
      );
    }
    const fieldDecisions = decisions.get(objectType);
    if (!fieldDecisions.length) return document;
    return applyMaskDocument(document, fieldDecisions, options);
  });
}

function auditDenied(db, { context, decision, resource, action, options }) {
  try {
    writeAudit(db, {
      actor: { id: context?.userId, username: context?.username },
      action: "authz.deny",
      resourceType: "security",
      resourceId: String(resource.id ?? resource.type ?? "resource"),
      details: {
        action,
        reason: decision.reason,
        resourceType: resource.type ?? null,
        organizationId: resource.organizationId ?? null,
        plantId: resource.plantId ?? null,
        classification: resource.classification ?? null,
      },
      ip: options.ip,
    });
  } catch {
    /* audit must never mask the authorization outcome */
  }
  try {
    emitDomainEvent(db, {
      event_type_code: "SecurityAccessDenied",
      aggregate_type: "security",
      aggregate_id: String(resource.id ?? resource.type ?? "resource"),
      tenant_id: context?.tenantId ?? 0,
      organization_id: resource.organizationId ?? null,
      correlation_id: options.correlationId ?? null,
      payload: {
        action,
        reason: decision.reason,
        resource_type: resource.type ?? null,
        user_id: context?.userId ?? null,
      },
    });
  } catch {
    /* events are best effort */
  }
}

export function invalidateSecurity(db, tenantId, scope = "all") {
  const epoch = bumpEpoch(db, tenantId, scope);
  clearDecisionCache();
  try {
    emitDomainEvent(db, {
      event_type_code: "SecurityPolicyChanged",
      aggregate_type: "security",
      aggregate_id: `${scope}`,
      tenant_id: Number(tenantId),
      payload: { scope, epoch },
    });
  } catch {
    /* events are best effort */
  }
  return { tenantId: Number(tenantId), scope, epoch };
}

export { DECISION_REASONS };

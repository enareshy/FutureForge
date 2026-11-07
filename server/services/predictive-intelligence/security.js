// Authorization for the Predictive Intelligence layer.
//
// This layer owns no users or roles. It authorizes against the centralized
// platform IAM using its own published resource codes and builds the same
// security context as the other domain modules (mirrors
// manufacturing-quality/security.js). Deny by default.
import { buildSecurityContext, buildSecurityContextAsync } from "../security/context.js";
import { checkPermission, checkPermissionAsync } from "../authorization.js";
import { PREDICTIVE_RESOURCES } from "./constants.js";
import { forbidden } from "./errors.js";

export function buildPredictiveContext(db, actor, options = {}) {
  return buildSecurityContext(db, actor, options);
}

export function buildPredictiveContextAsync(db, actor, options = {}) {
  return buildSecurityContextAsync(db, actor, options);
}

export function authorizePredictiveAction(db, actor, { resource, action, organizationId = null }) {
  if (!actor?.id) return { allowed: false, reason: "NO_ACTOR" };
  try {
    return checkPermission(db, { id: actor.id }, resource, action, { organizationId: organizationId || 0 });
  } catch (error) {
    return { allowed: false, reason: "ERROR", message: error.message };
  }
}

export async function authorizePredictiveActionAsync(db, actor, { resource, action, organizationId = null }) {
  if (!actor?.id) return { allowed: false, reason: "NO_ACTOR" };
  try {
    return await checkPermissionAsync(db, { id: actor.id }, resource, action, { organizationId: organizationId || 0 });
  } catch (error) {
    return { allowed: false, reason: "ERROR", message: error.message };
  }
}

export function requirePredictiveAction(db, actor, { resource, action, organizationId = null }) {
  const decision = authorizePredictiveAction(db, actor, { resource, action, organizationId });
  if (!decision.allowed) throw forbidden(`Not authorized to ${action} ${resource}`, { resource, action, reason: decision.reason });
  return decision;
}

export async function requirePredictiveActionAsync(db, actor, { resource, action, organizationId = null }) {
  const decision = await authorizePredictiveActionAsync(db, actor, { resource, action, organizationId });
  if (!decision.allowed) throw forbidden(`Not authorized to ${action} ${resource}`, { resource, action, reason: decision.reason });
  return decision;
}

export const resources = PREDICTIVE_RESOURCES;

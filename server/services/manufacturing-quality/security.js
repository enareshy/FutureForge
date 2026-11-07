// Authorization for the Manufacturing & Quality Intelligence layer.
//
// This layer owns no users, roles or object registrations. It authorizes against
// the centralized Data Security engine and platform IAM using its own published
// resource codes and builds the same security context as the other domain
// modules (mirrors verification-validation/security.js). Deny by default.
import { buildSecurityContext, buildSecurityContextAsync } from "../security/context.js";
import { checkPermission, checkPermissionAsync } from "../authorization.js";
import { MANUFACTURING_QUALITY_RESOURCES } from "./constants.js";
import { forbidden } from "./errors.js";

export function buildMqContext(db, actor, options = {}) {
  return buildSecurityContext(db, actor, options);
}

export function buildMqContextAsync(db, actor, options = {}) {
  return buildSecurityContextAsync(db, actor, options);
}

export function authorizeMqAction(db, actor, { resource, action, organizationId = null }) {
  if (!actor?.id) return { allowed: false, reason: "NO_ACTOR" };
  try {
    return checkPermission(db, { id: actor.id }, resource, action, { organizationId: organizationId || 0 });
  } catch (error) {
    return { allowed: false, reason: "ERROR", message: error.message };
  }
}

export async function authorizeMqActionAsync(db, actor, { resource, action, organizationId = null }) {
  if (!actor?.id) return { allowed: false, reason: "NO_ACTOR" };
  try {
    return await checkPermissionAsync(db, { id: actor.id }, resource, action, { organizationId: organizationId || 0 });
  } catch (error) {
    return { allowed: false, reason: "ERROR", message: error.message };
  }
}

export function requireMqAction(db, actor, { resource, action, organizationId = null }) {
  const decision = authorizeMqAction(db, actor, { resource, action, organizationId });
  if (!decision.allowed) throw forbidden(`Not authorized to ${action} ${resource}`, { resource, action, reason: decision.reason });
  return decision;
}

export async function requireMqActionAsync(db, actor, { resource, action, organizationId = null }) {
  const decision = await authorizeMqActionAsync(db, actor, { resource, action, organizationId });
  if (!decision.allowed) throw forbidden(`Not authorized to ${action} ${resource}`, { resource, action, reason: decision.reason });
  return decision;
}

export const resources = MANUFACTURING_QUALITY_RESOURCES;

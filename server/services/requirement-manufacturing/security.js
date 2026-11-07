// Authorization for the Requirement -> Manufacturing integration.
//
// The integration owns no users, roles or object registrations. It authorizes
// against the centralized Data Security engine and platform IAM using its own
// published resource codes and builds the same security context as the
// Requirements Manager (mirrors requirement-pdm/security.js). Deny by default.
import { buildSecurityContext, buildSecurityContextAsync } from "../security/context.js";
import { checkPermission, checkPermissionAsync } from "../authorization.js";
import {
  buildRequirementsContext,
  buildRequirementsContextAsync,
  fieldDecisionsFor,
  authorizeObject,
  authorizeObjectAsync,
} from "../requirements/security.js";
import { REQUIREMENT_MANUFACTURING_RESOURCES } from "./constants.js";
import { forbidden } from "./errors.js";

export function buildRequirementManufacturingContext(db, actor, options = {}) {
  return buildSecurityContext(db, actor, options);
}

export function buildRequirementManufacturingContextAsync(db, actor, options = {}) {
  return buildSecurityContextAsync(db, actor, options);
}

export { buildRequirementsContext, buildRequirementsContextAsync, fieldDecisionsFor, authorizeObject, authorizeObjectAsync };

export function authorizeRequirementManufacturingAction(db, actor, { resource, action, organizationId = null }) {
  if (!actor?.id) return { allowed: false, reason: "NO_ACTOR" };
  try {
    return checkPermission(db, { id: actor.id }, resource, action, { organizationId: organizationId || 0 });
  } catch (error) {
    return { allowed: false, reason: "ERROR", message: error.message };
  }
}

export async function authorizeRequirementManufacturingActionAsync(db, actor, { resource, action, organizationId = null }) {
  if (!actor?.id) return { allowed: false, reason: "NO_ACTOR" };
  try {
    return await checkPermissionAsync(db, { id: actor.id }, resource, action, { organizationId: organizationId || 0 });
  } catch (error) {
    return { allowed: false, reason: "ERROR", message: error.message };
  }
}

export function requireRequirementManufacturingAction(db, actor, { resource, action, organizationId = null }) {
  const decision = authorizeRequirementManufacturingAction(db, actor, { resource, action, organizationId });
  if (!decision.allowed) throw forbidden(`Not authorized to ${action} ${resource}`, { resource, action, reason: decision.reason });
  return decision;
}

export async function requireRequirementManufacturingActionAsync(db, actor, { resource, action, organizationId = null }) {
  const decision = await authorizeRequirementManufacturingActionAsync(db, actor, { resource, action, organizationId });
  if (!decision.allowed) throw forbidden(`Not authorized to ${action} ${resource}`, { resource, action, reason: decision.reason });
  return decision;
}

export const resources = REQUIREMENT_MANUFACTURING_RESOURCES;

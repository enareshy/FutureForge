// Standardized Enterprise Reference Data Management error codes. The HTTP layer
// serializes `code` alongside `error` so API clients can branch on stable codes.
import { HttpError } from "../../validation.js";

export const REFERENCE_ERROR_CODES = Object.freeze({
  DOMAIN_NOT_FOUND: "REFERENCE_DOMAIN_NOT_FOUND",
  DOMAIN_CONFLICT: "REFERENCE_DOMAIN_CONFLICT",
  DOMAIN_INACTIVE: "REFERENCE_DOMAIN_INACTIVE",
  INVALID_DOMAIN: "INVALID_REFERENCE_DOMAIN",
  ITEM_NOT_FOUND: "REFERENCE_ITEM_NOT_FOUND",
  ITEM_CONFLICT: "REFERENCE_ITEM_CONFLICT",
  ITEM_INACTIVE: "REFERENCE_ITEM_INACTIVE",
  INVALID_ITEM: "INVALID_REFERENCE_ITEM",
  INVALID_STATUS_TRANSITION: "INVALID_REFERENCE_STATUS_TRANSITION",
  INVALID_EFFECTIVE_RANGE: "INVALID_REFERENCE_EFFECTIVE_RANGE",
  INVALID_SCOPE: "INVALID_REFERENCE_SCOPE",
  AMBIGUOUS_SCOPE: "AMBIGUOUS_REFERENCE_SCOPE",
  CODE_NOT_FOUND: "REFERENCE_CODE_NOT_FOUND",
  CODE_CONFLICT: "REFERENCE_CODE_CONFLICT",
  CODE_REUSE_NOT_ALLOWED: "REFERENCE_CODE_REUSE_NOT_ALLOWED",
  INVALID_CODE: "INVALID_REFERENCE_CODE",
  ALIAS_NOT_FOUND: "REFERENCE_ALIAS_NOT_FOUND",
  ALIAS_CONFLICT: "REFERENCE_ALIAS_CONFLICT",
  TRANSLATION_NOT_FOUND: "REFERENCE_TRANSLATION_NOT_FOUND",
  TRANSLATION_CONFLICT: "REFERENCE_TRANSLATION_CONFLICT",
  HIERARCHY_NOT_FOUND: "REFERENCE_HIERARCHY_NOT_FOUND",
  HIERARCHY_CYCLE: "REFERENCE_HIERARCHY_CYCLE",
  HIERARCHY_CONFLICT: "REFERENCE_HIERARCHY_CONFLICT",
  RELATIONSHIP_NOT_FOUND: "REFERENCE_RELATIONSHIP_NOT_FOUND",
  RELATIONSHIP_CONFLICT: "REFERENCE_RELATIONSHIP_CONFLICT",
  INVALID_RELATIONSHIP: "INVALID_REFERENCE_RELATIONSHIP",
  VERSION_NOT_FOUND: "REFERENCE_VERSION_NOT_FOUND",
  APPROVAL_NOT_FOUND: "REFERENCE_APPROVAL_NOT_FOUND",
  APPROVAL_REQUIRED: "REFERENCE_APPROVAL_REQUIRED",
  INVALID_APPROVAL_TRANSITION: "INVALID_REFERENCE_APPROVAL_TRANSITION",
  GOVERNANCE_NOT_FOUND: "REFERENCE_GOVERNANCE_NOT_FOUND",
  IMPORT_NOT_FOUND: "REFERENCE_IMPORT_NOT_FOUND",
  INVALID_IMPORT: "INVALID_REFERENCE_IMPORT",
  EXPORT_NOT_FOUND: "REFERENCE_EXPORT_NOT_FOUND",
  RESOLUTION_NOT_FOUND: "REFERENCE_VALUE_NOT_FOUND",
  AMBIGUOUS_RESOLUTION: "AMBIGUOUS_REFERENCE_RESOLUTION",
  CONFLICT: "REFERENCE_CONFLICT",
  CONCURRENCY_CONFLICT: "REFERENCE_CONCURRENCY_CONFLICT",
  UNAUTHORIZED_OPERATION: "UNAUTHORIZED_REFERENCE_OPERATION",
});

export class ReferenceError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export function domainNotFound(ref) {
  return new ReferenceError(404, `Reference domain not found: ${ref}`, REFERENCE_ERROR_CODES.DOMAIN_NOT_FOUND, { ref });
}

export function domainConflict(code, details = null) {
  return new ReferenceError(409, `Reference domain already exists: ${code}`, REFERENCE_ERROR_CODES.DOMAIN_CONFLICT, { code, ...(details || {}) });
}

export function invalidDomain(message, details = null) {
  return new ReferenceError(400, message, REFERENCE_ERROR_CODES.INVALID_DOMAIN, details);
}

export function itemNotFound(ref) {
  return new ReferenceError(404, `Reference item not found: ${ref}`, REFERENCE_ERROR_CODES.ITEM_NOT_FOUND, { ref });
}

export function itemConflict(domain, code, scopeKey, details = null) {
  return new ReferenceError(
    409,
    `Reference code "${code}" already exists in domain "${domain}" for scope ${scopeKey}`,
    REFERENCE_ERROR_CODES.ITEM_CONFLICT,
    { code, scope_key: scopeKey, ...(details || {}) }
  );
}

export function invalidItem(message, details = null) {
  return new ReferenceError(400, message, REFERENCE_ERROR_CODES.INVALID_ITEM, details);
}

export function invalidStatusTransition(from, to) {
  return new ReferenceError(
    409,
    `Illegal reference lifecycle transition from "${from}" to "${to}"`,
    REFERENCE_ERROR_CODES.INVALID_STATUS_TRANSITION,
    { from, to }
  );
}

export function invalidEffectiveRange(details = null) {
  return new ReferenceError(
    422,
    "Effective-from must be earlier than effective-to",
    REFERENCE_ERROR_CODES.INVALID_EFFECTIVE_RANGE,
    details
  );
}

export function invalidScope(message, details = null) {
  return new ReferenceError(422, message, REFERENCE_ERROR_CODES.INVALID_SCOPE, details);
}

export function ambiguousScope(details = null) {
  return new ReferenceError(409, "Multiple reference values match the supplied scope", REFERENCE_ERROR_CODES.AMBIGUOUS_SCOPE, details);
}

export function codeConflict(code, details = null) {
  return new ReferenceError(409, `Reference code already exists: ${code}`, REFERENCE_ERROR_CODES.CODE_CONFLICT, { code, ...(details || {}) });
}

export function codeNotFound(ref) {
  return new ReferenceError(404, `Reference code not found: ${ref}`, REFERENCE_ERROR_CODES.CODE_NOT_FOUND, { ref });
}

export function codeReuseNotAllowed(code, details = null) {
  return new ReferenceError(
    409,
    `Code "${code}" was previously retired and policy forbids reuse`,
    REFERENCE_ERROR_CODES.CODE_REUSE_NOT_ALLOWED,
    { code, ...(details || {}) }
  );
}

export function aliasConflict(alias, details = null) {
  return new ReferenceError(409, `Reference alias already exists: ${alias}`, REFERENCE_ERROR_CODES.ALIAS_CONFLICT, { alias, ...(details || {}) });
}

export function aliasNotFound(ref) {
  return new ReferenceError(404, `Reference alias not found: ${ref}`, REFERENCE_ERROR_CODES.ALIAS_NOT_FOUND, { ref });
}

export function translationNotFound(ref) {
  return new ReferenceError(404, `Reference translation not found: ${ref}`, REFERENCE_ERROR_CODES.TRANSLATION_NOT_FOUND, { ref });
}

export function translationConflict(language, details = null) {
  return new ReferenceError(409, `Reference translation already exists for language: ${language}`, REFERENCE_ERROR_CODES.TRANSLATION_CONFLICT, {
    language,
    ...(details || {}),
  });
}

export function hierarchyNotFound(ref) {
  return new ReferenceError(404, `Reference hierarchy edge not found: ${ref}`, REFERENCE_ERROR_CODES.HIERARCHY_NOT_FOUND, { ref });
}

export function hierarchyCycle(details = null) {
  return new ReferenceError(409, "Reference hierarchy would create a cycle", REFERENCE_ERROR_CODES.HIERARCHY_CYCLE, details);
}

export function hierarchyConflict(details = null) {
  return new ReferenceError(409, "Reference hierarchy edge already exists", REFERENCE_ERROR_CODES.HIERARCHY_CONFLICT, details);
}

export function relationshipNotFound(ref) {
  return new ReferenceError(404, `Reference relationship not found: ${ref}`, REFERENCE_ERROR_CODES.RELATIONSHIP_NOT_FOUND, { ref });
}

export function relationshipConflict(details = null) {
  return new ReferenceError(409, "Reference relationship already exists", REFERENCE_ERROR_CODES.RELATIONSHIP_CONFLICT, details);
}

export function invalidRelationship(message, details = null) {
  return new ReferenceError(422, message, REFERENCE_ERROR_CODES.INVALID_RELATIONSHIP, details);
}

export function versionNotFound(ref) {
  return new ReferenceError(404, `Reference version not found: ${ref}`, REFERENCE_ERROR_CODES.VERSION_NOT_FOUND, { ref });
}

export function approvalNotFound(ref) {
  return new ReferenceError(404, `Reference approval not found: ${ref}`, REFERENCE_ERROR_CODES.APPROVAL_NOT_FOUND, { ref });
}

export function approvalRequired(details = null) {
  return new ReferenceError(
    409,
    "Governance requires approval before this operation can proceed",
    REFERENCE_ERROR_CODES.APPROVAL_REQUIRED,
    details
  );
}

export function invalidApprovalTransition(from, to) {
  return new ReferenceError(
    409,
    `Illegal approval transition from "${from}" to "${to}"`,
    REFERENCE_ERROR_CODES.INVALID_APPROVAL_TRANSITION,
    { from, to }
  );
}

export function governanceNotFound(domain) {
  return new ReferenceError(404, `Reference governance policy not found for domain: ${domain}`, REFERENCE_ERROR_CODES.GOVERNANCE_NOT_FOUND, {
    domain,
  });
}

export function importNotFound(ref) {
  return new ReferenceError(404, `Reference import not found: ${ref}`, REFERENCE_ERROR_CODES.IMPORT_NOT_FOUND, { ref });
}

export function invalidImport(message, details = null) {
  return new ReferenceError(422, message, REFERENCE_ERROR_CODES.INVALID_IMPORT, details);
}

export function exportNotFound(ref) {
  return new ReferenceError(404, `Reference export not found: ${ref}`, REFERENCE_ERROR_CODES.EXPORT_NOT_FOUND, { ref });
}

export function resolutionNotFound(details = null) {
  return new ReferenceError(404, "No reference value is effective for the supplied context", REFERENCE_ERROR_CODES.RESOLUTION_NOT_FOUND, details);
}

export function ambiguousResolution(details = null) {
  return new ReferenceError(
    409,
    "Multiple reference values match the supplied context and cannot be disambiguated",
    REFERENCE_ERROR_CODES.AMBIGUOUS_RESOLUTION,
    details
  );
}

export function conflict(message, details = null) {
  return new ReferenceError(409, message, REFERENCE_ERROR_CODES.CONFLICT, details);
}

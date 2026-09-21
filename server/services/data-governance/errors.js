// Standardized Data Governance & Data Quality error codes. The HTTP layer
// serializes `code` alongside `error` and `details` so clients can branch on
// stable identifiers instead of message text.
import { HttpError } from "../../validation.js";

export const DATA_GOVERNANCE_ERROR_CODES = Object.freeze({
  DOMAIN_NOT_FOUND: "DATA_GOVERNANCE_DOMAIN_NOT_FOUND",
  DOMAIN_CONFLICT: "DATA_GOVERNANCE_DOMAIN_CONFLICT",
  INVALID_DOMAIN: "INVALID_DATA_GOVERNANCE_DOMAIN",
  DOMAIN_CYCLE: "DATA_GOVERNANCE_DOMAIN_CYCLE",
  OWNERSHIP_NOT_FOUND: "DATA_GOVERNANCE_OWNERSHIP_NOT_FOUND",
  OWNERSHIP_CONFLICT: "DATA_GOVERNANCE_OWNERSHIP_CONFLICT",
  INVALID_OWNERSHIP: "INVALID_DATA_GOVERNANCE_OWNERSHIP",
  CATALOG_NOT_FOUND: "DATA_GOVERNANCE_CATALOG_NOT_FOUND",
  CATALOG_CONFLICT: "DATA_GOVERNANCE_CATALOG_CONFLICT",
  INVALID_CATALOG: "INVALID_DATA_GOVERNANCE_CATALOG",
  POLICY_NOT_FOUND: "DATA_GOVERNANCE_POLICY_NOT_FOUND",
  POLICY_CONFLICT: "DATA_GOVERNANCE_POLICY_CONFLICT",
  INVALID_POLICY: "INVALID_DATA_GOVERNANCE_POLICY",
  INVALID_STATUS_TRANSITION: "DATA_GOVERNANCE_INVALID_STATUS_TRANSITION",
  RULE_NOT_FOUND: "DATA_QUALITY_RULE_NOT_FOUND",
  RULE_CONFLICT: "DATA_QUALITY_RULE_CONFLICT",
  INVALID_RULE: "INVALID_DATA_QUALITY_RULE",
  INVALID_EXPRESSION: "INVALID_DATA_QUALITY_EXPRESSION",
  UNKNOWN_RULE_TYPE: "UNKNOWN_DATA_QUALITY_RULE_TYPE",
  EVALUATION_FAILED: "DATA_QUALITY_EVALUATION_FAILED",
  OBJECT_NOT_FOUND: "DATA_QUALITY_OBJECT_NOT_FOUND",
  ADAPTER_NOT_FOUND: "DATA_QUALITY_ADAPTER_NOT_FOUND",
  RESULT_NOT_FOUND: "DATA_QUALITY_RESULT_NOT_FOUND",
  EXCEPTION_NOT_FOUND: "DATA_QUALITY_EXCEPTION_NOT_FOUND",
  EXCEPTION_CONFLICT: "DATA_QUALITY_EXCEPTION_CONFLICT",
  INVALID_EXCEPTION_TRANSITION: "DATA_QUALITY_INVALID_EXCEPTION_TRANSITION",
  DUPLICATE_NOT_FOUND: "DATA_QUALITY_DUPLICATE_NOT_FOUND",
  DUPLICATE_CONFLICT: "DATA_QUALITY_DUPLICATE_CONFLICT",
  REMEDIATION_NOT_ALLOWED: "DATA_QUALITY_REMEDIATION_NOT_ALLOWED",
  REMEDIATION_FAILED: "DATA_QUALITY_REMEDIATION_FAILED",
  CONFIGURATION_NOT_FOUND: "DATA_GOVERNANCE_CONFIGURATION_NOT_FOUND",
  INVALID_CONFIGURATION: "INVALID_DATA_GOVERNANCE_CONFIGURATION",
  BATCH_TOO_LARGE: "DATA_QUALITY_BATCH_TOO_LARGE",
  CONFLICT: "DATA_GOVERNANCE_CONFLICT",
});

export class DataGovernanceError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

const make = (status, code, message) => (details = null) =>
  new DataGovernanceError(status, typeof message === "function" ? message(details) : message, code, details);

export const domainNotFound = (ref) =>
  new DataGovernanceError(404, `Data domain not found: ${ref}`, DATA_GOVERNANCE_ERROR_CODES.DOMAIN_NOT_FOUND, { ref });
export const domainConflict = (code, details = null) =>
  new DataGovernanceError(409, `Data domain already exists: ${code}`, DATA_GOVERNANCE_ERROR_CODES.DOMAIN_CONFLICT, { code, ...(details || {}) });
export const invalidDomain = (message, details = null) =>
  new DataGovernanceError(400, message, DATA_GOVERNANCE_ERROR_CODES.INVALID_DOMAIN, details);
export const domainCycle = (details = null) =>
  new DataGovernanceError(409, "Data domain hierarchy would create a cycle", DATA_GOVERNANCE_ERROR_CODES.DOMAIN_CYCLE, details);

export const ownershipNotFound = (ref) =>
  new DataGovernanceError(404, `Ownership assignment not found: ${ref}`, DATA_GOVERNANCE_ERROR_CODES.OWNERSHIP_NOT_FOUND, { ref });
export const ownershipConflict = (details = null) =>
  new DataGovernanceError(409, "Ownership assignment already exists", DATA_GOVERNANCE_ERROR_CODES.OWNERSHIP_CONFLICT, details);
export const invalidOwnership = (message, details = null) =>
  new DataGovernanceError(400, message, DATA_GOVERNANCE_ERROR_CODES.INVALID_OWNERSHIP, details);

export const catalogNotFound = (ref) =>
  new DataGovernanceError(404, `Catalogue entry not found: ${ref}`, DATA_GOVERNANCE_ERROR_CODES.CATALOG_NOT_FOUND, { ref });
export const catalogConflict = (ref, details = null) =>
  new DataGovernanceError(409, `Catalogue entry already exists: ${ref}`, DATA_GOVERNANCE_ERROR_CODES.CATALOG_CONFLICT, { ref, ...(details || {}) });
export const invalidCatalog = (message, details = null) =>
  new DataGovernanceError(400, message, DATA_GOVERNANCE_ERROR_CODES.INVALID_CATALOG, details);

export const policyNotFound = (ref) =>
  new DataGovernanceError(404, `Data policy not found: ${ref}`, DATA_GOVERNANCE_ERROR_CODES.POLICY_NOT_FOUND, { ref });
export const policyConflict = (code, details = null) =>
  new DataGovernanceError(409, `Data policy already exists: ${code}`, DATA_GOVERNANCE_ERROR_CODES.POLICY_CONFLICT, { code, ...(details || {}) });
export const invalidPolicy = (message, details = null) =>
  new DataGovernanceError(400, message, DATA_GOVERNANCE_ERROR_CODES.INVALID_POLICY, details);

export const ruleNotFound = (ref) =>
  new DataGovernanceError(404, `Data quality rule not found: ${ref}`, DATA_GOVERNANCE_ERROR_CODES.RULE_NOT_FOUND, { ref });
export const ruleConflict = (code, details = null) =>
  new DataGovernanceError(409, `Data quality rule already exists: ${code}`, DATA_GOVERNANCE_ERROR_CODES.RULE_CONFLICT, { code, ...(details || {}) });
export const invalidRule = (message, details = null) =>
  new DataGovernanceError(400, message, DATA_GOVERNANCE_ERROR_CODES.INVALID_RULE, details);
export const invalidExpression = (message, details = null) =>
  new DataGovernanceError(400, message, DATA_GOVERNANCE_ERROR_CODES.INVALID_EXPRESSION, details);
export const unknownRuleType = (type) =>
  new DataGovernanceError(400, `Unknown rule type: ${type}`, DATA_GOVERNANCE_ERROR_CODES.UNKNOWN_RULE_TYPE, { rule_type: type });

export const invalidStatusTransition = (from, to) =>
  new DataGovernanceError(
    409,
    `Illegal status transition from "${from}" to "${to}"`,
    DATA_GOVERNANCE_ERROR_CODES.INVALID_STATUS_TRANSITION,
    { from, to }
  );

export const objectNotFound = (objectType, objectId) =>
  new DataGovernanceError(
    404,
    `Object ${objectType}/${objectId} not found or not readable`,
    DATA_GOVERNANCE_ERROR_CODES.OBJECT_NOT_FOUND,
    { object_type: objectType, object_id: objectId }
  );
export const adapterNotFound = (code) =>
  new DataGovernanceError(400, `Data source adapter not registered: ${code}`, DATA_GOVERNANCE_ERROR_CODES.ADAPTER_NOT_FOUND, { adapter: code });
export const evaluationFailed = (message, details = null) =>
  new DataGovernanceError(422, message, DATA_GOVERNANCE_ERROR_CODES.EVALUATION_FAILED, details);

export const resultNotFound = (objectType, objectId) =>
  new DataGovernanceError(404, `Quality result not found: ${objectType}/${objectId}`, DATA_GOVERNANCE_ERROR_CODES.RESULT_NOT_FOUND, {
    object_type: objectType,
    object_id: objectId,
  });

export const exceptionNotFound = (ref) =>
  new DataGovernanceError(404, `Quality exception not found: ${ref}`, DATA_GOVERNANCE_ERROR_CODES.EXCEPTION_NOT_FOUND, { ref });
export const exceptionConflict = (ref, details = null) =>
  new DataGovernanceError(409, `Quality exception already exists: ${ref}`, DATA_GOVERNANCE_ERROR_CODES.EXCEPTION_CONFLICT, { ref, ...(details || {}) });
export const invalidExceptionTransition = (from, to) =>
  new DataGovernanceError(
    409,
    `Illegal exception transition from "${from}" to "${to}"`,
    DATA_GOVERNANCE_ERROR_CODES.INVALID_EXCEPTION_TRANSITION,
    { from, to }
  );

export const duplicateNotFound = (ref) =>
  new DataGovernanceError(404, `Duplicate candidate not found: ${ref}`, DATA_GOVERNANCE_ERROR_CODES.DUPLICATE_NOT_FOUND, { ref });
export const duplicateConflict = (details = null) =>
  new DataGovernanceError(409, "Duplicate candidate already exists", DATA_GOVERNANCE_ERROR_CODES.DUPLICATE_CONFLICT, details);

export const remediationNotAllowed = (message, details = null) =>
  new DataGovernanceError(403, message, DATA_GOVERNANCE_ERROR_CODES.REMEDIATION_NOT_ALLOWED, details);
export const remediationFailed = (message, details = null) =>
  new DataGovernanceError(422, message, DATA_GOVERNANCE_ERROR_CODES.REMEDIATION_FAILED, details);

export const configurationNotFound = (key) =>
  new DataGovernanceError(404, `Configuration value not found: ${key}`, DATA_GOVERNANCE_ERROR_CODES.CONFIGURATION_NOT_FOUND, { key });
export const invalidConfiguration = (message, details = null) =>
  new DataGovernanceError(400, message, DATA_GOVERNANCE_ERROR_CODES.INVALID_CONFIGURATION, details);

export const batchTooLarge = (size, max) =>
  new DataGovernanceError(400, `Batch size ${size} exceeds the maximum of ${max}`, DATA_GOVERNANCE_ERROR_CODES.BATCH_TOO_LARGE, {
    size,
    max,
  });

export const conflict = (message, details = null) =>
  new DataGovernanceError(409, message, DATA_GOVERNANCE_ERROR_CODES.CONFLICT, details);

export { make };

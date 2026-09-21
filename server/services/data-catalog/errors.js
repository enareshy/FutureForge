// Standardized Data Catalog & Business Glossary error codes. The HTTP layer
// serializes `code` alongside `error` and `details` so clients can branch on
// stable identifiers rather than message text.
import { HttpError } from "../../validation.js";

export const CATALOG_ERROR_CODES = Object.freeze({
  ENTRY_NOT_FOUND: "DATA_CATALOG_ENTRY_NOT_FOUND",
  ENTRY_CONFLICT: "DATA_CATALOG_ENTRY_CONFLICT",
  INVALID_ENTRY: "INVALID_DATA_CATALOG_ENTRY",
  OBJECT_NOT_FOUND: "DATA_CATALOG_OBJECT_NOT_FOUND",
  OBJECT_CONFLICT: "DATA_CATALOG_OBJECT_CONFLICT",
  INVALID_OBJECT: "INVALID_DATA_CATALOG_OBJECT",
  ATTRIBUTE_NOT_FOUND: "DATA_CATALOG_ATTRIBUTE_NOT_FOUND",
  ATTRIBUTE_CONFLICT: "DATA_CATALOG_ATTRIBUTE_CONFLICT",
  INVALID_ATTRIBUTE: "INVALID_DATA_CATALOG_ATTRIBUTE",
  DOMAIN_NOT_FOUND: "DATA_CATALOG_DOMAIN_NOT_FOUND",
  INVALID_DOMAIN: "INVALID_DATA_CATALOG_DOMAIN",
  TERM_NOT_FOUND: "DATA_CATALOG_TERM_NOT_FOUND",
  TERM_CONFLICT: "DATA_CATALOG_TERM_CONFLICT",
  INVALID_TERM: "INVALID_DATA_CATALOG_TERM",
  INVALID_TERM_TRANSITION: "DATA_CATALOG_INVALID_TERM_TRANSITION",
  TERM_APPROVAL_REQUIRED: "DATA_CATALOG_TERM_APPROVAL_REQUIRED",
  DEFINITION_NOT_FOUND: "DATA_CATALOG_DEFINITION_NOT_FOUND",
  INVALID_DEFINITION: "INVALID_DATA_CATALOG_DEFINITION",
  SOURCE_NOT_FOUND: "DATA_CATALOG_SOURCE_NOT_FOUND",
  SOURCE_CONFLICT: "DATA_CATALOG_SOURCE_CONFLICT",
  INVALID_SOURCE: "INVALID_DATA_CATALOG_SOURCE",
  CONSUMER_NOT_FOUND: "DATA_CATALOG_CONSUMER_NOT_FOUND",
  CONSUMER_CONFLICT: "DATA_CATALOG_CONSUMER_CONFLICT",
  INVALID_CONSUMER: "INVALID_DATA_CATALOG_CONSUMER",
  MAPPING_NOT_FOUND: "DATA_CATALOG_MAPPING_NOT_FOUND",
  MAPPING_CONFLICT: "DATA_CATALOG_MAPPING_CONFLICT",
  INVALID_MAPPING: "INVALID_DATA_CATALOG_MAPPING",
  RELATIONSHIP_NOT_FOUND: "DATA_CATALOG_RELATIONSHIP_NOT_FOUND",
  RELATIONSHIP_CONFLICT: "DATA_CATALOG_RELATIONSHIP_CONFLICT",
  INVALID_RELATIONSHIP: "INVALID_DATA_CATALOG_RELATIONSHIP",
  LINEAGE_NOT_FOUND: "DATA_CATALOG_LINEAGE_NOT_FOUND",
  LINEAGE_CONFLICT: "DATA_CATALOG_LINEAGE_CONFLICT",
  INVALID_LINEAGE: "INVALID_DATA_CATALOG_LINEAGE",
  LINEAGE_TOO_LARGE: "DATA_CATALOG_LINEAGE_TOO_LARGE",
  CLASSIFICATION_NOT_FOUND: "DATA_CATALOG_CLASSIFICATION_NOT_FOUND",
  CLASSIFICATION_CONFLICT: "DATA_CATALOG_CLASSIFICATION_CONFLICT",
  INVALID_CLASSIFICATION: "INVALID_DATA_CATALOG_CLASSIFICATION",
  OWNERSHIP_NOT_FOUND: "DATA_CATALOG_OWNERSHIP_NOT_FOUND",
  INVALID_OWNERSHIP: "INVALID_DATA_CATALOG_OWNERSHIP",
  INVALID_STATUS_TRANSITION: "DATA_CATALOG_INVALID_STATUS_TRANSITION",
  INVALID_CONFIGURATION: "INVALID_DATA_CATALOG_CONFIGURATION",
  IMPORT_FAILED: "DATA_CATALOG_IMPORT_FAILED",
  EXPORT_FAILED: "DATA_CATALOG_EXPORT_FAILED",
  UNSUPPORTED_TARGET: "DATA_CATALOG_UNSUPPORTED_TARGET",
  CONFLICT: "DATA_CATALOG_CONFLICT",
});

export class DataCatalogError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

function factory(status, code, message) {
  return (details = null) =>
    new DataCatalogError(status, typeof message === "function" ? message(details) : message, code, details);
}

export const entryNotFound = (ref) =>
  new DataCatalogError(404, `Catalog entry not found: ${ref}`, CATALOG_ERROR_CODES.ENTRY_NOT_FOUND, { ref });
export const entryConflict = (code, details = null) =>
  new DataCatalogError(409, `Catalog entry already exists: ${code}`, CATALOG_ERROR_CODES.ENTRY_CONFLICT, { code, ...(details || {}) });
export const invalidEntry = (message, details = null) =>
  new DataCatalogError(400, message, CATALOG_ERROR_CODES.INVALID_ENTRY, details);

export const objectNotFound = (ref) =>
  new DataCatalogError(404, `Catalog object not found: ${ref}`, CATALOG_ERROR_CODES.OBJECT_NOT_FOUND, { ref });
export const objectConflict = (code, details = null) =>
  new DataCatalogError(409, `Catalog object already exists: ${code}`, CATALOG_ERROR_CODES.OBJECT_CONFLICT, { code, ...(details || {}) });
export const invalidObject = (message, details = null) =>
  new DataCatalogError(400, message, CATALOG_ERROR_CODES.INVALID_OBJECT, details);

export const attributeNotFound = (ref) =>
  new DataCatalogError(404, `Catalog attribute not found: ${ref}`, CATALOG_ERROR_CODES.ATTRIBUTE_NOT_FOUND, { ref });
export const attributeConflict = (name, details = null) =>
  new DataCatalogError(409, `Catalog attribute already exists: ${name}`, CATALOG_ERROR_CODES.ATTRIBUTE_CONFLICT, { name, ...(details || {}) });
export const invalidAttribute = (message, details = null) =>
  new DataCatalogError(400, message, CATALOG_ERROR_CODES.INVALID_ATTRIBUTE, details);

export const domainNotFound = (ref) =>
  new DataCatalogError(404, `Data domain not found: ${ref}`, CATALOG_ERROR_CODES.DOMAIN_NOT_FOUND, { ref });
export const invalidDomain = (message, details = null) =>
  new DataCatalogError(400, message, CATALOG_ERROR_CODES.INVALID_DOMAIN, details);

export const termNotFound = (ref) =>
  new DataCatalogError(404, `Business term not found: ${ref}`, CATALOG_ERROR_CODES.TERM_NOT_FOUND, { ref });
export const termConflict = (code, details = null) =>
  new DataCatalogError(409, `Business term already exists: ${code}`, CATALOG_ERROR_CODES.TERM_CONFLICT, { code, ...(details || {}) });
export const invalidTerm = (message, details = null) =>
  new DataCatalogError(400, message, CATALOG_ERROR_CODES.INVALID_TERM, details);
export const invalidTermTransition = (from, to) =>
  new DataCatalogError(
    409,
    `Illegal business term transition from "${from}" to "${to}"`,
    CATALOG_ERROR_CODES.INVALID_TERM_TRANSITION,
    { from, to }
  );
export const termApprovalRequired = (details = null) =>
  new DataCatalogError(422, "A business term must have a definition before approval", CATALOG_ERROR_CODES.TERM_APPROVAL_REQUIRED, details);

export const definitionNotFound = (ref) =>
  new DataCatalogError(404, `Term definition not found: ${ref}`, CATALOG_ERROR_CODES.DEFINITION_NOT_FOUND, { ref });
export const invalidDefinition = (message, details = null) =>
  new DataCatalogError(400, message, CATALOG_ERROR_CODES.INVALID_DEFINITION, details);

export const sourceNotFound = (ref) =>
  new DataCatalogError(404, `Data source not found: ${ref}`, CATALOG_ERROR_CODES.SOURCE_NOT_FOUND, { ref });
export const sourceConflict = (code, details = null) =>
  new DataCatalogError(409, `Data source already exists: ${code}`, CATALOG_ERROR_CODES.SOURCE_CONFLICT, { code, ...(details || {}) });
export const invalidSource = (message, details = null) =>
  new DataCatalogError(400, message, CATALOG_ERROR_CODES.INVALID_SOURCE, details);

export const consumerNotFound = (ref) =>
  new DataCatalogError(404, `Data consumer not found: ${ref}`, CATALOG_ERROR_CODES.CONSUMER_NOT_FOUND, { ref });
export const consumerConflict = (code, details = null) =>
  new DataCatalogError(409, `Data consumer already exists: ${code}`, CATALOG_ERROR_CODES.CONSUMER_CONFLICT, { code, ...(details || {}) });
export const invalidConsumer = (message, details = null) =>
  new DataCatalogError(400, message, CATALOG_ERROR_CODES.INVALID_CONSUMER, details);

export const mappingNotFound = (ref) =>
  new DataCatalogError(404, `Catalog mapping not found: ${ref}`, CATALOG_ERROR_CODES.MAPPING_NOT_FOUND, { ref });
export const mappingConflict = (details = null) =>
  new DataCatalogError(409, "Catalog mapping already exists", CATALOG_ERROR_CODES.MAPPING_CONFLICT, details);
export const invalidMapping = (message, details = null) =>
  new DataCatalogError(400, message, CATALOG_ERROR_CODES.INVALID_MAPPING, details);

export const relationshipNotFound = (ref) =>
  new DataCatalogError(404, `Catalog relationship not found: ${ref}`, CATALOG_ERROR_CODES.RELATIONSHIP_NOT_FOUND, { ref });
export const relationshipConflict = (details = null) =>
  new DataCatalogError(409, "Catalog relationship already exists", CATALOG_ERROR_CODES.RELATIONSHIP_CONFLICT, details);
export const invalidRelationship = (message, details = null) =>
  new DataCatalogError(400, message, CATALOG_ERROR_CODES.INVALID_RELATIONSHIP, details);

export const lineageNotFound = (ref) =>
  new DataCatalogError(404, `Lineage relationship not found: ${ref}`, CATALOG_ERROR_CODES.LINEAGE_NOT_FOUND, { ref });
export const lineageConflict = (details = null) =>
  new DataCatalogError(409, "Lineage relationship already exists", CATALOG_ERROR_CODES.LINEAGE_CONFLICT, details);
export const invalidLineage = (message, details = null) =>
  new DataCatalogError(400, message, CATALOG_ERROR_CODES.INVALID_LINEAGE, details);
export const lineageTooLarge = (details = null) =>
  new DataCatalogError(413, "Lineage traversal exceeds the configured limit", CATALOG_ERROR_CODES.LINEAGE_TOO_LARGE, details);

export const classificationNotFound = (ref) =>
  new DataCatalogError(404, `Catalog classification not found: ${ref}`, CATALOG_ERROR_CODES.CLASSIFICATION_NOT_FOUND, { ref });
export const classificationConflict = (code, details = null) =>
  new DataCatalogError(409, `Catalog classification already exists: ${code}`, CATALOG_ERROR_CODES.CLASSIFICATION_CONFLICT, { code, ...(details || {}) });
export const invalidClassification = (message, details = null) =>
  new DataCatalogError(400, message, CATALOG_ERROR_CODES.INVALID_CLASSIFICATION, details);

export const ownershipNotFound = (ref) =>
  new DataCatalogError(404, `Ownership assignment not found: ${ref}`, CATALOG_ERROR_CODES.OWNERSHIP_NOT_FOUND, { ref });
export const invalidOwnership = (message, details = null) =>
  new DataCatalogError(400, message, CATALOG_ERROR_CODES.INVALID_OWNERSHIP, details);

export const invalidStatusTransition = (from, to) =>
  new DataCatalogError(
    409,
    `Illegal status transition from "${from}" to "${to}"`,
    CATALOG_ERROR_CODES.INVALID_STATUS_TRANSITION,
    { from, to }
  );

export const invalidConfiguration = (message, details = null) =>
  new DataCatalogError(400, message, CATALOG_ERROR_CODES.INVALID_CONFIGURATION, details);

export const importFailed = (message, details = null) =>
  new DataCatalogError(422, message, CATALOG_ERROR_CODES.IMPORT_FAILED, details);
export const exportFailed = (message, details = null) =>
  new DataCatalogError(422, message, CATALOG_ERROR_CODES.EXPORT_FAILED, details);

export const unsupportedTarget = (target) =>
  new DataCatalogError(400, `Unsupported target type: ${target}`, CATALOG_ERROR_CODES.UNSUPPORTED_TARGET, { target });

export const conflict = (message, details = null) =>
  new DataCatalogError(409, message, CATALOG_ERROR_CODES.CONFLICT, details);

export { factory };

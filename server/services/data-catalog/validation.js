// Shared normalization, parsing and assertion helpers for the Data Catalog &
// Business Glossary service. Pure functions only: no database access, so they
// can be unit tested in isolation and reused by the REST layer and importers.
import { HttpError } from "../../validation.js";
import {
  CATALOG_STATUSES,
  ENTRY_TYPES,
  TERM_STATUSES,
  TERM_APPROVAL_STATUSES,
  TERM_STATUS_TRANSITIONS,
  DEFINITION_TYPES,
  SYNONYM_TYPES,
  TERM_RELATIONSHIP_TYPES,
  LINEAGE_RELATIONSHIP_TYPES,
  SOURCE_TYPES,
  CONSUMER_TYPES,
  MAPPING_TYPES,
  OWNERSHIP_RELATIONSHIPS,
  OWNERSHIP_KINDS,
  SUBJECT_TYPES,
  SECURITY_CLASSIFICATIONS,
  CLASSIFICATION_CATEGORIES,
  TERM_TARGET_TYPES,
} from "./constants.js";
import {
  invalidEntry,
  invalidObject,
  invalidAttribute,
  invalidTerm,
  invalidDefinition,
  invalidSource,
  invalidConsumer,
  invalidMapping,
  invalidLineage,
  invalidRelationship,
  invalidClassification,
  invalidOwnership,
  invalidConfiguration,
  invalidTermTransition,
} from "./errors.js";

const SAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function normalizeText(value, { max = 2000 } = {}) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, max);
}

export function normalizeUpper(value, { max = 64 } = {}) {
  return normalizeText(value, { max }).toUpperCase();
}

export function normalizeLower(value, { max = 64 } = {}) {
  return normalizeText(value, { max }).toLowerCase();
}

export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

export function parseObject(value, fallback = {}) {
  const parsed = parseJson(value, fallback);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
}

export function parseArray(value, fallback = []) {
  const parsed = parseJson(value, fallback);
  return Array.isArray(parsed) ? parsed : fallback;
}

export function toBool(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function toInt(value, fallback = null) {
  const n = toNumber(value, null);
  return n === null ? fallback : Math.trunc(n);
}

export function toIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

export function paginate(query = {}, { defaultPageSize = 100, maxPageSize = 500 } = {}) {
  const page = Math.max(1, toInt(query.page, 1) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, toInt(query.pageSize ?? query.page_size, defaultPageSize) || defaultPageSize));
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

export function assertSafeIdentifier(value, label = "Identifier") {
  const text = normalizeText(value, { max: 200 });
  const segments = text.split(".");
  if (!text || segments.some((segment) => SAFE_SEGMENTS.has(segment))) {
    throw new HttpError(400, `${label} contains a reserved path segment`);
  }
  return text;
}

export function requireCode(value, label = "Code") {
  const code = normalizeUpper(value);
  if (!/^[A-Z][A-Z0-9_.-]{1,63}$/.test(code)) {
    throw new HttpError(400, `${label} must be 2-64 uppercase letters, digits, . _ - and start with a letter`);
  }
  return code;
}

export function requireName(value, label = "Name") {
  const name = normalizeText(value, { max: 200 });
  if (!name) throw new HttpError(400, `${label} is required`);
  return name;
}

export function assertEnum(value, allowed, label, errorFactory) {
  if (!allowed.includes(value)) {
    const message = `${label} must be one of: ${allowed.join(", ")}`;
    if (errorFactory) throw errorFactory(message);
    throw new HttpError(400, message);
  }
  return value;
}

export const assertCatalogStatus = (value) => assertEnum(value, CATALOG_STATUSES, "Catalog status", invalidEntry);
export const assertEntryType = (value) => assertEnum(value, ENTRY_TYPES, "Entry type", invalidEntry);
export const assertTermStatus = (value) => assertEnum(value, TERM_STATUSES, "Term status", invalidTerm);
export const assertTermApprovalStatus = (value) => assertEnum(value, TERM_APPROVAL_STATUSES, "Approval status", invalidTerm);
export const assertDefinitionType = (value) => assertEnum(value, DEFINITION_TYPES, "Definition type", invalidDefinition);
export const assertSynonymType = (value) => assertEnum(value, SYNONYM_TYPES, "Synonym type", invalidTerm);
export const assertTermRelationship = (value) => assertEnum(value, TERM_RELATIONSHIP_TYPES, "Term relationship", invalidTerm);
export const assertLineageRelationship = (value) => assertEnum(value, LINEAGE_RELATIONSHIP_TYPES, "Lineage relationship", invalidLineage);
export const assertSourceType = (value) => assertEnum(value, SOURCE_TYPES, "Source type", invalidSource);
export const assertConsumerType = (value) => assertEnum(value, CONSUMER_TYPES, "Consumer type", invalidConsumer);
export const assertMappingType = (value) => assertEnum(value, MAPPING_TYPES, "Mapping type", invalidMapping);
export const assertOwnershipRelationship = (value) => assertEnum(value, OWNERSHIP_RELATIONSHIPS, "Relationship", invalidOwnership);
export const assertOwnershipKind = (value) => assertEnum(value, OWNERSHIP_KINDS, "Ownership kind", invalidOwnership);
export const assertSubjectType = (value) => assertEnum(value, SUBJECT_TYPES, "Subject type", invalidOwnership);
export const assertSecurityClassification = (value) => assertEnum(value, SECURITY_CLASSIFICATIONS, "Security classification", invalidClassification);
export const assertClassificationCategory = (value) => assertEnum(value, CLASSIFICATION_CATEGORIES, "Classification category", invalidClassification);
export const assertTermTargetType = (value) => assertEnum(value, TERM_TARGET_TYPES, "Term target type", invalidTerm);
export const assertObjectStatus = (value) => assertEnum(value, CATALOG_STATUSES, "Object status", invalidObject);
export const assertAttributeStatus = (value) => assertEnum(value, CATALOG_STATUSES, "Attribute status", invalidAttribute);

export function assertTermTransition(from, to) {
  const allowed = TERM_STATUS_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) throw invalidTermTransition(from, to);
  return to;
}

export function assertConfigurationValue(key, value) {
  if (key === "lineage_max_depth" || key === "lineage_max_nodes" || key === "import_batch_size") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw invalidConfiguration(`${key} must be a positive integer`);
  }
  return value;
}

export function assertTenantId(tenantId) {
  const n = Number(tenantId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, "A valid tenant is required for this operation");
  }
  return n;
}

export function valuePreview(value, max = 500) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value).slice(0, max);
    } catch {
      return String(value).slice(0, max);
    }
  }
  return String(value).slice(0, max);
}

// Vocabulary surfaced by the REST /meta endpoint and the SDK so a UI can build
// pickers without hardcoding values (spec §26: configuration is data-driven).
export function vocabulary() {
  return {
    catalog_statuses: CATALOG_STATUSES,
    entry_types: ENTRY_TYPES,
    term_statuses: TERM_STATUSES,
    term_approval_statuses: TERM_APPROVAL_STATUSES,
    definition_types: DEFINITION_TYPES,
    synonym_types: SYNONYM_TYPES,
    term_relationship_types: TERM_RELATIONSHIP_TYPES,
    lineage_relationship_types: LINEAGE_RELATIONSHIP_TYPES,
    source_types: SOURCE_TYPES,
    consumer_types: CONSUMER_TYPES,
    mapping_types: MAPPING_TYPES,
    ownership_relationships: OWNERSHIP_RELATIONSHIPS,
    ownership_kinds: OWNERSHIP_KINDS,
    subject_types: SUBJECT_TYPES,
    security_classifications: SECURITY_CLASSIFICATIONS,
    classification_categories: CLASSIFICATION_CATEGORIES,
    term_target_types: TERM_TARGET_TYPES,
  };
}

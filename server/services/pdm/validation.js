// Normalization, assertion and vocabulary helpers for the PDM domain.
//
// Pure helpers are reused from the Import & Export Framework so there is exactly
// one implementation of text/number/bool normalization, pagination and safe
// ORDER BY construction on the platform. This module adds PDM-specific
// vocabulary assertions and DTO normalization only.
import { HttpError } from "../../validation.js";
import {
  normalizeText,
  normalizeUpper,
  normalizeLower,
  parseJson,
  parseObject,
  parseArray,
  toBool,
  toNumber,
  toInt,
  paginate,
  sortParams,
  requireCode,
  requireName,
  assertEnum,
  assertTenantId,
} from "../data-exchange/validation.js";
import {
  ITEM_TYPES,
  ITEM_STATUSES,
  REVISION_STATUSES,
  DATASET_TYPES,
  DATASET_STATUSES,
  REPRESENTATION_TYPES,
  DESIGN_DATA_TYPES,
  CAD_ASSOCIATION_TYPES,
  CAD_TYPES,
  CAD_ASSOCIATION_STATUSES,
  REVISION_RULE_TYPES,
  CONFIGURATION_RULE_TYPES,
  RULE_STATUSES,
  CONFIGURATION_OPERATORS,
  BASELINE_STATUSES,
  RELATIONSHIP_TYPES,
  RELATIONSHIP_STATUSES,
  RELATIONSHIP_DIRECTIONS,
  REFERENCE_CATEGORIES,
  RULE_TYPES,
  RULE_SEVERITIES,
  VALIDATION_SCOPES,
  VALIDATION_STATUSES,
  DEFAULT_ITEM_TRANSITIONS,
  DEFAULT_REVISION_TRANSITIONS,
  CONFIG_DEFAULTS,
  CONFIG_BOUNDS,
} from "./constants.js";
import {
  invalidItem,
  invalidRevision,
  invalidDataset,
  invalidRepresentation,
  invalidDesignData,
  invalidCadAssociation,
  invalidRevisionRule,
  invalidConfigurationRule,
  invalidBaseline,
  invalidRelationship,
  invalidConfiguration,
  invalidEffectivity,
  invalidRule,
  revisionStatusInvalid,
} from "./errors.js";

export {
  normalizeText,
  normalizeUpper,
  normalizeLower,
  parseJson,
  parseObject,
  parseArray,
  toBool,
  toNumber,
  toInt,
  paginate,
  sortParams,
  requireCode,
  requireName,
  assertEnum,
  assertTenantId,
  HttpError,
};

export const assertItemType = (value) =>
  assertEnum(normalizeUpper(value), ITEM_TYPES, "Item type", invalidItem);
export const assertItemStatus = (value) =>
  assertEnum(normalizeUpper(value), ITEM_STATUSES, "Item status", invalidItem);
export const assertRevisionStatus = (value) =>
  assertEnum(normalizeUpper(value), REVISION_STATUSES, "Revision status", invalidRevision);
export const assertDatasetType = (value) =>
  assertEnum(normalizeUpper(value), DATASET_TYPES, "Dataset type", invalidDataset);
export const assertDatasetStatus = (value) =>
  assertEnum(normalizeUpper(value), DATASET_STATUSES, "Dataset status", invalidDataset);
export const assertRepresentationType = (value) =>
  assertEnum(normalizeUpper(value), REPRESENTATION_TYPES, "Representation type", invalidRepresentation);
export const assertDesignDataType = (value) =>
  assertEnum(normalizeUpper(value), DESIGN_DATA_TYPES, "Design data type", invalidDesignData);
export const assertCadAssociationType = (value) =>
  assertEnum(normalizeUpper(value), CAD_ASSOCIATION_TYPES, "CAD association type", invalidCadAssociation);
export const assertCadType = (value) =>
  assertEnum(normalizeUpper(value), CAD_TYPES, "CAD type", invalidCadAssociation);
export const assertCadAssociationStatus = (value) =>
  assertEnum(normalizeUpper(value), CAD_ASSOCIATION_STATUSES, "CAD association status", invalidCadAssociation);
export const assertRevisionRuleType = (value) =>
  assertEnum(normalizeUpper(value), REVISION_RULE_TYPES, "Revision rule type", invalidRevisionRule);
export const assertConfigurationRuleType = (value) =>
  assertEnum(normalizeUpper(value), CONFIGURATION_RULE_TYPES, "Configuration rule type", invalidConfigurationRule);
export const assertRuleStatus = (value) =>
  assertEnum(normalizeUpper(value), RULE_STATUSES, "Rule status", invalidRevisionRule);
export const assertConfigurationOperator = (value) =>
  assertEnum(normalizeUpper(value), CONFIGURATION_OPERATORS, "Configuration operator", invalidConfigurationRule);
export const assertBaselineStatus = (value) =>
  assertEnum(normalizeUpper(value), BASELINE_STATUSES, "Baseline status", invalidBaseline);
export const assertRelationshipTypeCode = (value) =>
  assertEnum(normalizeUpper(value), RELATIONSHIP_TYPES.map((entry) => entry.code), "Relationship type", invalidRelationship);
export const assertRelationshipStatus = (value) =>
  assertEnum(normalizeUpper(value), RELATIONSHIP_STATUSES, "Relationship status", invalidRelationship);
export const assertRelationshipDirection = (value) =>
  assertEnum(normalizeUpper(value), RELATIONSHIP_DIRECTIONS, "Relationship direction", invalidRelationship);
export const assertReferenceCategory = (value) =>
  assertEnum(normalizeUpper(value), REFERENCE_CATEGORIES, "Reference category", invalidRelationship);
export const assertRuleType = (value) =>
  assertEnum(normalizeUpper(value), RULE_TYPES, "Validation rule type", invalidRule);
export const assertRuleSeverity = (value) =>
  assertEnum(normalizeUpper(value), RULE_SEVERITIES, "Validation rule severity", invalidRule);
export const assertValidationScope = (value) =>
  assertEnum(normalizeUpper(value), VALIDATION_SCOPES, "Validation scope", invalidRule);
export const assertValidationStatus = (value) =>
  assertEnum(normalizeUpper(value), VALIDATION_STATUSES, "Validation status", invalidRule);

// ── State transitions (centralized, data-driven) ─────────────────────────────

export function allowedItemTransitions(from, transitions = null) {
  const map = transitions || DEFAULT_ITEM_TRANSITIONS;
  return map[normalizeUpper(from)] || [];
}

export function assertItemTransition(from, to, transitions = null) {
  const target = normalizeUpper(to);
  const allowed = allowedItemTransitions(from, transitions);
  if (!allowed.includes(target)) throw revisionStatusInvalid(target, normalizeUpper(from), allowed);
  return target;
}

export function allowedRevisionTransitions(from, transitions = null) {
  const map = transitions || DEFAULT_REVISION_TRANSITIONS;
  return map[normalizeUpper(from)] || [];
}

export function assertRevisionTransition(from, to, transitions = null) {
  const target = normalizeUpper(to);
  const allowed = allowedRevisionTransitions(from, transitions);
  if (!allowed.includes(target)) throw revisionStatusInvalid(target, normalizeUpper(from), allowed);
  return target;
}

// ── DTO normalization ────────────────────────────────────────────────────────

function optionalInt(value, name, errorFactory) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw errorFactory(`${name} must be an integer`);
  return n;
}

// Wraps the shared code assertion so a PDM client always receives a PDM error
// code rather than a generic platform validation error.
function domainCode(value, label, errorFactory) {
  try {
    return requireCode(value, label);
  } catch (err) {
    throw errorFactory(err?.message || `${label} is invalid`);
  }
}

function nullableText(value, max) {
  const text = normalizeText(value, { max });
  return text || null;
}

export function normalizeItemInput(body = {}, current = {}) {
  const itemNumber = body.item_number ?? body.itemNumber ?? body.number ?? current.item_number;
  const validFrom = body.valid_from ?? body.validFrom ?? current.valid_from ?? null;
  const validTo = body.valid_to ?? body.validTo ?? current.valid_to ?? null;
  if (validFrom && validTo && String(validFrom) > String(validTo)) throw invalidEffectivity("valid_from must not be after valid_to");
  return {
    item_number: domainCode(itemNumber, "Item number", invalidItem),
    name: normalizeText(body.name ?? current.name ?? "", { max: 300 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 4000 }),
    item_type: assertItemType(body.item_type ?? body.itemType ?? current.item_type ?? "PART"),
    owner_user_id:
      body.owner_user_id === undefined && body.ownerUserId === undefined
        ? current.owner_user_id ?? null
        : optionalInt(body.owner_user_id ?? body.ownerUserId, "owner_user_id", invalidItem),
    owner_object_id:
      body.owner_object_id === undefined && body.ownerObjectId === undefined
        ? current.owner_object_id ?? null
        : optionalInt(body.owner_object_id ?? body.ownerObjectId, "owner_object_id", invalidItem),
    organization_id:
      body.organization_id === undefined && body.organizationId === undefined
        ? current.organization_id ?? null
        : optionalInt(body.organization_id ?? body.organizationId, "organization_id", invalidItem),
    plant_id:
      body.plant_id === undefined && body.plantId === undefined
        ? current.plant_id ?? null
        : optionalInt(body.plant_id ?? body.plantId, "plant_id", invalidItem),
    site_id:
      body.site_id === undefined && body.siteId === undefined
        ? current.site_id ?? null
        : optionalInt(body.site_id ?? body.siteId, "site_id", invalidItem),
    classification_code: normalizeText(body.classification_code ?? body.classificationCode ?? current.classification_code ?? "", { max: 200 }),
    status:
      body.status === undefined && current.status
        ? assertItemStatus(current.status)
        : assertItemStatus(body.status ?? current.status ?? "DRAFT"),
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
    attributes: parseObject(body.attributes ?? current.attributes_json, {}),
    valid_from: validFrom ? normalizeText(validFrom, { max: 40 }) : null,
    valid_to: validTo ? normalizeText(validTo, { max: 40 }) : null,
  };
}

export function normalizeRevisionInput(body = {}, current = {}) {
  const revisionNumber = body.revision_number ?? body.revisionNumber ?? body.revision ?? current.revision_number;
  const validFrom = body.valid_from ?? body.validFrom ?? current.valid_from ?? null;
  const validTo = body.valid_to ?? body.validTo ?? current.valid_to ?? null;
  if (validFrom && validTo && String(validFrom) > String(validTo)) throw invalidEffectivity("valid_from must not be after valid_to");
  return {
    revision_number: domainCode(revisionNumber, "Revision number", invalidRevision),
    description: normalizeText(body.description ?? current.description ?? "", { max: 4000 }),
    status:
      body.status === undefined && current.status
        ? assertRevisionStatus(current.status)
        : assertRevisionStatus(body.status ?? current.status ?? "DRAFT"),
    valid_from: validFrom ? normalizeText(validFrom, { max: 40 }) : null,
    valid_to: validTo ? normalizeText(validTo, { max: 40 }) : null,
    effectivity: parseObject(body.effectivity ?? current.effectivity_json, {}),
    configuration_context: normalizeText(body.configuration_context ?? body.configurationContext ?? current.configuration_context ?? "", { max: 200 }),
    variant_id:
      body.variant_id === undefined && body.variantId === undefined
        ? current.variant_id ?? null
        : optionalInt(body.variant_id ?? body.variantId, "variant_id", invalidRevision),
    variant_code: normalizeUpper(body.variant_code ?? body.variantCode ?? current.variant_code ?? "", { max: 120 }),
    baseline_id:
      body.baseline_id === undefined && body.baselineId === undefined
        ? current.baseline_id ?? null
        : optionalInt(body.baseline_id ?? body.baselineId, "baseline_id", invalidRevision),
    owner_user_id:
      body.owner_user_id === undefined && body.ownerUserId === undefined
        ? current.owner_user_id ?? null
        : optionalInt(body.owner_user_id ?? body.ownerUserId, "owner_user_id", invalidRevision),
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
    attributes: parseObject(body.attributes ?? current.attributes_json, {}),
  };
}

export function normalizeDatasetInput(body = {}, current = {}) {
  const number = body.dataset_number ?? body.datasetNumber ?? body.number ?? current.dataset_number;
  return {
    dataset_number: domainCode(number, "Dataset number", invalidDataset),
    name: normalizeText(body.name ?? current.name ?? "", { max: 300 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 4000 }),
    dataset_type: assertDatasetType(body.dataset_type ?? body.datasetType ?? body.type ?? current.dataset_type ?? "OTHER"),
    status:
      body.status === undefined && current.status
        ? assertDatasetStatus(current.status)
        : assertDatasetStatus(body.status ?? current.status ?? "DRAFT"),
    owner_user_id:
      body.owner_user_id === undefined && body.ownerUserId === undefined
        ? current.owner_user_id ?? null
        : optionalInt(body.owner_user_id ?? body.ownerUserId, "owner_user_id", invalidDataset),
    item_id:
      body.item_id === undefined && body.itemId === undefined
        ? current.item_id ?? null
        : optionalInt(body.item_id ?? body.itemId, "item_id", invalidDataset),
    revision_id:
      body.revision_id === undefined && body.revisionId === undefined
        ? current.revision_id ?? null
        : optionalInt(body.revision_id ?? body.revisionId, "revision_id", invalidDataset),
    object_id:
      body.object_id === undefined && body.objectId === undefined
        ? current.object_id ?? null
        : optionalInt(body.object_id ?? body.objectId, "object_id", invalidDataset),
    content_id: normalizeText(body.content_id ?? body.contentId ?? current.content_id ?? "", { max: 200 }),
    content_type: normalizeText(body.content_type ?? body.contentType ?? current.content_type ?? "", { max: 200 }),
    content_reference: normalizeText(body.content_reference ?? body.contentReference ?? current.content_reference ?? "", { max: 1000 }),
    checksum: normalizeText(body.checksum ?? current.checksum ?? "", { max: 200 }),
    size_bytes:
      body.size_bytes === undefined && body.sizeBytes === undefined
        ? current.size_bytes ?? null
        : optionalInt(body.size_bytes ?? body.sizeBytes, "size_bytes", invalidDataset),
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
  };
}

export function normalizeRepresentationInput(body = {}, current = {}) {
  return {
    name: normalizeText(body.name ?? current.name ?? "", { max: 300 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 4000 }),
    representation_type: assertRepresentationType(body.representation_type ?? body.representationType ?? body.type ?? current.representation_type ?? "3D"),
    status: assertEnum(normalizeUpper(body.status ?? current.status ?? "ACTIVE"), ["DRAFT", "ACTIVE", "INACTIVE", "OBSOLETE"], "Representation status", invalidRepresentation),
    item_id:
      body.item_id === undefined && body.itemId === undefined
        ? current.item_id ?? null
        : optionalInt(body.item_id ?? body.itemId, "item_id", invalidRepresentation),
    revision_id:
      body.revision_id === undefined && body.revisionId === undefined
        ? current.revision_id ?? null
        : optionalInt(body.revision_id ?? body.revisionId, "revision_id", invalidRepresentation),
    source_object_id: nullableText(body.source_object_id ?? body.sourceObjectId ?? current.source_object_id ?? "", 300),
    dataset_id:
      body.dataset_id === undefined && body.datasetId === undefined
        ? current.dataset_id ?? null
        : optionalInt(body.dataset_id ?? body.datasetId, "dataset_id", invalidRepresentation),
    generated: toBool(body.generated ?? current.generated, false),
    derived_from_id:
      body.derived_from_id === undefined && body.derivedFromId === undefined
        ? current.derived_from_id ?? null
        : optionalInt(body.derived_from_id ?? body.derivedFromId, "derived_from_id", invalidRepresentation),
    content_id: normalizeText(body.content_id ?? body.contentId ?? current.content_id ?? "", { max: 200 }),
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
  };
}

export function normalizeDesignDataInput(body = {}, current = {}) {
  return {
    code: normalizeText(body.code ?? current.code ?? "", { max: 120 }),
    name: normalizeText(body.name ?? current.name ?? "", { max: 300 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 4000 }),
    data_type: assertDesignDataType(body.data_type ?? body.dataType ?? body.type ?? current.data_type ?? "OTHER"),
    status: assertEnum(normalizeUpper(body.status ?? current.status ?? "ACTIVE"), ["DRAFT", "ACTIVE", "INACTIVE", "OBSOLETE"], "Design data status", invalidDesignData),
    category: normalizeText(body.category ?? current.category ?? "", { max: 120 }),
    external_reference: normalizeText(body.external_reference ?? body.externalReference ?? current.external_reference ?? "", { max: 1000 }),
    item_id:
      body.item_id === undefined && body.itemId === undefined
        ? current.item_id ?? null
        : optionalInt(body.item_id ?? body.itemId, "item_id", invalidDesignData),
    revision_id:
      body.revision_id === undefined && body.revisionId === undefined
        ? current.revision_id ?? null
        : optionalInt(body.revision_id ?? body.revisionId, "revision_id", invalidDesignData),
    dataset_id:
      body.dataset_id === undefined && body.datasetId === undefined
        ? current.dataset_id ?? null
        : optionalInt(body.dataset_id ?? body.datasetId, "dataset_id", invalidDesignData),
    representation_id:
      body.representation_id === undefined && body.representationId === undefined
        ? current.representation_id ?? null
        : optionalInt(body.representation_id ?? body.representationId, "representation_id", invalidDesignData),
    object_id:
      body.object_id === undefined && body.objectId === undefined
        ? current.object_id ?? null
        : optionalInt(body.object_id ?? body.objectId, "object_id", invalidDesignData),
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
  };
}

export function normalizeCadAssociationInput(body = {}, current = {}) {
  return {
    item_id:
      body.item_id === undefined && body.itemId === undefined
        ? current.item_id ?? null
        : optionalInt(body.item_id ?? body.itemId, "item_id", invalidCadAssociation),
    source_revision_id:
      body.source_revision_id === undefined && body.sourceRevisionId === undefined
        ? current.source_revision_id ?? null
        : optionalInt(body.source_revision_id ?? body.sourceRevisionId, "source_revision_id", invalidCadAssociation),
    source_object_id: nullableText(body.source_object_id ?? body.sourceObjectId ?? current.source_object_id ?? "", 300),
    dataset_id:
      body.dataset_id === undefined && body.datasetId === undefined
        ? current.dataset_id ?? null
        : optionalInt(body.dataset_id ?? body.datasetId, "dataset_id", invalidCadAssociation),
    cad_type: assertCadType(body.cad_type ?? body.cadType ?? current.cad_type ?? "NATIVE"),
    association_type: assertCadAssociationType(body.association_type ?? body.associationType ?? body.type ?? current.association_type ?? "MASTER"),
    is_primary: toBool(body.is_primary ?? body.isPrimary ?? current.is_primary, false),
    status:
      body.status === undefined && current.status
        ? assertCadAssociationStatus(current.status)
        : assertCadAssociationStatus(body.status ?? current.status ?? "ACTIVE"),
    application: normalizeText(body.application ?? current.application ?? "", { max: 200 }),
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
  };
}

export function normalizeRevisionRuleInput(body = {}, current = {}) {
  const code = body.code ?? current.code;
  return {
    code: domainCode(code, "Rule code", invalidRevisionRule),
    name: normalizeText(body.name ?? current.name ?? "", { max: 300 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 4000 }),
    rule_type: assertRevisionRuleType(body.rule_type ?? body.ruleType ?? current.rule_type ?? "LATEST_RELEASED"),
    status:
      body.status === undefined && current.status
        ? assertRuleStatus(current.status)
        : assertRuleStatus(body.status ?? current.status ?? "DRAFT"),
    priority: toInt(body.priority ?? current.priority ?? 100, 100),
    sequence: toInt(body.sequence ?? current.sequence ?? 0, 0),
    is_default: toBool(body.is_default ?? body.isDefault ?? current.is_default, false),
    organization_id:
      body.organization_id === undefined && body.organizationId === undefined
        ? current.organization_id ?? null
        : optionalInt(body.organization_id ?? body.organizationId, "organization_id", invalidRevisionRule),
    config: parseObject(body.config ?? current.config_json, {}),
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
  };
}

export function normalizeConfigurationRuleInput(body = {}, current = {}) {
  const code = body.code ?? current.code;
  return {
    code: domainCode(code, "Rule code", invalidConfigurationRule),
    name: normalizeText(body.name ?? current.name ?? "", { max: 300 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 4000 }),
    rule_type: assertConfigurationRuleType(body.rule_type ?? body.ruleType ?? current.rule_type ?? "VARIANT"),
    status:
      body.status === undefined && current.status
        ? assertRuleStatus(current.status)
        : assertRuleStatus(body.status ?? current.status ?? "DRAFT"),
    priority: toInt(body.priority ?? current.priority ?? 100, 100),
    sequence: toInt(body.sequence ?? current.sequence ?? 0, 0),
    is_default: toBool(body.is_default ?? body.isDefault ?? current.is_default, false),
    organization_id:
      body.organization_id === undefined && body.organizationId === undefined
        ? current.organization_id ?? null
        : optionalInt(body.organization_id ?? body.organizationId, "organization_id", invalidConfigurationRule),
    config: parseObject(body.config ?? current.config_json, {}),
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
  };
}

export function normalizeBaselineInput(body = {}, current = {}) {
  const number = body.baseline_number ?? body.baselineNumber ?? body.number ?? current.baseline_number;
  return {
    baseline_number: domainCode(number, "Baseline number", invalidBaseline),
    name: normalizeText(body.name ?? current.name ?? "", { max: 300 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 4000 }),
    status:
      body.status === undefined && current.status
        ? assertBaselineStatus(current.status)
        : assertBaselineStatus(body.status ?? current.status ?? "DRAFT"),
    source_object_id: nullableText(body.source_object_id ?? body.sourceObjectId ?? current.source_object_id ?? "", 300),
    source_revision_id:
      body.source_revision_id === undefined && body.sourceRevisionId === undefined
        ? current.source_revision_id ?? null
        : optionalInt(body.source_revision_id ?? body.sourceRevisionId, "source_revision_id", invalidBaseline),
    item_id:
      body.item_id === undefined && body.itemId === undefined
        ? current.item_id ?? null
        : optionalInt(body.item_id ?? body.itemId, "item_id", invalidBaseline),
    revision_rule_id:
      body.revision_rule_id === undefined && body.revisionRuleId === undefined
        ? current.revision_rule_id ?? null
        : optionalInt(body.revision_rule_id ?? body.revisionRuleId, "revision_rule_id", invalidBaseline),
    configuration_rule_id:
      body.configuration_rule_id === undefined && body.configurationRuleId === undefined
        ? current.configuration_rule_id ?? null
        : optionalInt(body.configuration_rule_id ?? body.configurationRuleId, "configuration_rule_id", invalidBaseline),
    baseline_date: body.baseline_date ?? body.baselineDate ?? current.baseline_date ?? null,
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
  };
}

// ── Relationship & reference input ───────────────────────────────────────────

export function normalizeRelationshipInput(body = {}) {
  const relationshipType = body.relationship_type ?? body.relationshipType ?? body.type;
  if (!relationshipType) throw invalidRelationship("relationship_type is required");
  const sourceId = body.source_id ?? body.sourceId;
  const targetId = body.target_id ?? body.targetId;
  if (sourceId === null || sourceId === undefined || String(sourceId).trim() === "") throw invalidRelationship("source_id is required");
  if (targetId === null || targetId === undefined || String(targetId).trim() === "") throw invalidRelationship("target_id is required");
  const def = RELATIONSHIP_TYPES.find((entry) => entry.code === normalizeUpper(relationshipType));
  return {
    relationship_type: assertRelationshipTypeCode(relationshipType),
    source_type: normalizeUpper(body.source_type ?? body.sourceType ?? def?.source ?? "ITEM", { max: 60 }),
    source_id: normalizeText(sourceId, { max: 300 }),
    target_type: normalizeUpper(body.target_type ?? body.targetType ?? def?.target ?? "ITEM", { max: 60 }),
    target_id: normalizeText(targetId, { max: 300 }),
    direction: assertRelationshipDirection(body.direction ?? def?.direction ?? "FORWARD"),
    cardinality: normalizeText(body.cardinality ?? def?.cardinality ?? "1:N", { max: 20 }),
    status: assertRelationshipStatus(body.status ?? "ACTIVE"),
    valid_from: body.valid_from ? normalizeText(body.valid_from, { max: 40 }) : null,
    valid_to: body.valid_to ? normalizeText(body.valid_to, { max: 40 }) : null,
    attributes: parseObject(body.attributes ?? {}, {}),
    organization_id:
      body.organization_id === undefined && body.organizationId === undefined
        ? null
        : optionalInt(body.organization_id ?? body.organizationId, "organization_id", invalidRelationship),
  };
}

export function normalizeReferenceInput(body = {}) {
  const sourceId = body.source_id ?? body.sourceId;
  const targetId = body.target_id ?? body.targetId;
  if (sourceId === null || sourceId === undefined || String(sourceId).trim() === "") throw invalidRelationship("source_id is required");
  if (targetId === null || targetId === undefined || String(targetId).trim() === "") throw invalidRelationship("target_id is required");
  return {
    source_type: normalizeUpper(body.source_type ?? body.sourceType ?? "REVISION", { max: 60 }),
    source_id: normalizeText(sourceId, { max: 300 }),
    source_ref: normalizeText(body.source_ref ?? body.sourceRef ?? "", { max: 300 }),
    target_type: normalizeUpper(body.target_type ?? body.targetType ?? "DATASET", { max: 60 }),
    target_id: normalizeText(targetId, { max: 300 }),
    target_ref: normalizeText(body.target_ref ?? body.targetRef ?? "", { max: 300 }),
    category: assertReferenceCategory(body.category ?? "OTHER"),
    relationship_type: normalizeText(body.relationship_type ?? body.relationshipType ?? "", { max: 120 }),
    metadata: parseObject(body.metadata ?? {}, {}),
    organization_id:
      body.organization_id === undefined && body.organizationId === undefined
        ? null
        : optionalInt(body.organization_id ?? body.organizationId, "organization_id", invalidRelationship),
  };
}

// ── Configuration ────────────────────────────────────────────────────────────

export function assertConfigurationValue(key, value) {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)) {
    throw invalidConfiguration(`Unknown configuration key: ${key}`, { key, allowed: Object.keys(CONFIG_DEFAULTS) });
  }
  const fallback = CONFIG_DEFAULTS[key];
  if (typeof fallback === "boolean") return toBool(value, fallback);
  if (typeof fallback === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw invalidConfiguration(`${key} must be a number`, { key });
    const bounds = CONFIG_BOUNDS[key];
    if (bounds && (n < bounds.min || n > bounds.max)) {
      throw invalidConfiguration(`${key} must be between ${bounds.min} and ${bounds.max}`, { key, min: bounds.min, max: bounds.max, value: n });
    }
    return n;
  }
  if (typeof fallback === "string") {
    const text = normalizeText(value, { max: 200 });
    if (!text) throw invalidConfiguration(`${key} must be a non-empty string`, { key });
    return text;
  }
  return value;
}

export function vocabulary() {
  return {
    item_types: ITEM_TYPES,
    item_statuses: ITEM_STATUSES,
    revision_statuses: REVISION_STATUSES,
    dataset_types: DATASET_TYPES,
    dataset_statuses: DATASET_STATUSES,
    representation_types: REPRESENTATION_TYPES,
    design_data_types: DESIGN_DATA_TYPES,
    cad_association_types: CAD_ASSOCIATION_TYPES,
    cad_types: CAD_TYPES,
    cad_association_statuses: CAD_ASSOCIATION_STATUSES,
    revision_rule_types: REVISION_RULE_TYPES,
    configuration_rule_types: CONFIGURATION_RULE_TYPES,
    rule_statuses: RULE_STATUSES,
    configuration_operators: CONFIGURATION_OPERATORS,
    baseline_statuses: BASELINE_STATUSES,
    relationship_types: RELATIONSHIP_TYPES,
    relationship_statuses: RELATIONSHIP_STATUSES,
    relationship_directions: RELATIONSHIP_DIRECTIONS,
    reference_categories: REFERENCE_CATEGORIES,
    rule_types: RULE_TYPES,
    rule_severities: RULE_SEVERITIES,
    validation_scopes: VALIDATION_SCOPES,
    validation_statuses: VALIDATION_STATUSES,
    item_transitions: DEFAULT_ITEM_TRANSITIONS,
    revision_transitions: DEFAULT_REVISION_TRANSITIONS,
  };
}

export function publicError(error) {
  if (!error) return null;
  return { error: error.message, code: error.code || null, details: error.details || null };
}

// Builds a safe ORDER BY fragment. The column is restricted to an allow-list so
// a client can never inject SQL through the sort parameter.
export function orderClause(sort, { allowed = [], default: fallback = "id", direction = "DESC" } = {}) {
  const column = allowed.includes(String(sort)) ? String(sort) : fallback;
  const dir = String(direction).toUpperCase() === "ASC" ? "ASC" : "DESC";
  return { clause: `${column} ${dir}`, params: [] };
}

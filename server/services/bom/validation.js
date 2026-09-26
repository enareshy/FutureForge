// Normalization, assertion and vocabulary helpers for the P1 BOM Engine.
//
// Pure helpers are reused from the Import & Export Framework so there is exactly
// one implementation of text/number/bool normalization, pagination and safe
// ORDER BY construction on the platform. This module adds BOM-specific
// vocabulary assertions and DTO normalization.
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
  BOM_TYPES,
  BOM_STATUSES,
  REVISION_STATUSES,
  LINE_STATUSES,
  USAGES,
  BASELINE_STATUSES,
  MAPPING_TYPES,
  TRANSFORMATION_MODES,
  TRANSFORMATION_STATUSES,
  TRANSFORMATION_DEFINITION_STATUSES,
  CHANGE_TYPES,
  COMPARISON_SCOPES,
  COMPARISON_KINDS,
  RULE_TYPES,
  RULE_SEVERITIES,
  VALIDATION_SCOPES,
  VALIDATION_STATUSES,
  DEFAULT_REVISION_TRANSITIONS,
  DEFAULT_UOM,
  CONFIG_DEFAULTS,
  CONFIG_BOUNDS,
  MAX_STRUCTURE_DEPTH,
} from "./constants.js";
import {
  invalidBom,
  invalidRevision,
  invalidLine,
  invalidBaseline,
  invalidTransformation,
  invalidRule,
  invalidComparison,
  invalidConfiguration,
  quantityInvalid,
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

export const assertBomType = (value) =>
  assertEnum(normalizeUpper(value), BOM_TYPES, "BOM type", invalidBom);
export const assertBomStatus = (value) =>
  assertEnum(normalizeUpper(value), BOM_STATUSES, "BOM status", invalidBom);
export const assertRevisionStatus = (value) =>
  assertEnum(normalizeUpper(value), REVISION_STATUSES, "Revision status", invalidRevision);
export const assertLineStatus = (value) =>
  assertEnum(normalizeUpper(value), LINE_STATUSES, "Line status", invalidLine);
export const assertUsage = (value) =>
  assertEnum(normalizeUpper(value), USAGES, "Line usage", invalidLine);
export const assertBaselineStatus = (value) =>
  assertEnum(normalizeUpper(value), BASELINE_STATUSES, "Baseline status", invalidBaseline);
export const assertMappingType = (value) =>
  assertEnum(normalizeUpper(value), MAPPING_TYPES, "Transformation mapping type", invalidTransformation);
export const assertTransformationMode = (value) =>
  assertEnum(normalizeUpper(value), TRANSFORMATION_MODES, "Transformation mode", invalidTransformation);
export const assertTransformationStatus = (value) =>
  assertEnum(normalizeUpper(value), TRANSFORMATION_STATUSES, "Transformation status", invalidTransformation);
export const assertTransformationDefinitionStatus = (value) =>
  assertEnum(normalizeUpper(value), TRANSFORMATION_DEFINITION_STATUSES, "Transformation definition status", invalidTransformation);
export const assertRuleType = (value) =>
  assertEnum(normalizeUpper(value), RULE_TYPES, "Validation rule type", invalidRule);
export const assertRuleSeverity = (value) =>
  assertEnum(normalizeUpper(value), RULE_SEVERITIES, "Validation rule severity", invalidRule);
export const assertChangeType = (value) =>
  assertEnum(normalizeUpper(value), CHANGE_TYPES, "Comparison change type", invalidComparison);
export const assertComparisonScope = (value) =>
  assertEnum(normalizeUpper(value), COMPARISON_SCOPES, "Comparison scope", invalidComparison);
export const assertComparisonKind = (value) =>
  assertEnum(normalizeUpper(value), COMPARISON_KINDS, "Comparison kind", invalidComparison);
export const assertValidationScope = (value) =>
  assertEnum(normalizeUpper(value), VALIDATION_SCOPES, "Validation scope", invalidComparison);
export const assertValidationStatus = (value) =>
  assertEnum(normalizeUpper(value), VALIDATION_STATUSES, "Validation status", invalidComparison);

// ── Revision status transitions (centralized, data-driven) ───────────────────

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

// ── Quantities & units ───────────────────────────────────────────────────────

export function normalizeQuantity(value, { fallback = null } = {}) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw quantityInvalid(`Quantity must be a number, received "${value}"`, { value });
  return n;
}

export function assertPositiveQuantity(value, { allowZero = false } = {}) {
  const n = normalizeQuantity(value, { fallback: null });
  if (n === null) throw quantityInvalid("Quantity is required");
  if (allowZero ? n < 0 : n <= 0) throw quantityInvalid(`Quantity must be ${allowZero ? ">= 0" : "> 0"}`, { value: n });
  return n;
}

export function assertUom(value, { required = true, fallback = DEFAULT_UOM } = {}) {
  const uom = normalizeUpper(value, { max: 40 });
  if (!uom) {
    if (required) throw invalidLine("A unit of measure (UOM) is required for every BOM line");
    return normalizeUpper(fallback, { max: 40 });
  }
  return uom;
}

// ── Reference designators ────────────────────────────────────────────────────

// Accepts a string or array and returns a canonical comma-separated, uppercase,
// de-duplicated designator list (e.g. "R1,R2,C1").
export function normalizeReferenceDesignators(value, { separator = "," } = {}) {
  if (value === null || value === undefined) return "";
  const parts = Array.isArray(value) ? value : String(value).split(separator);
  const seen = new Set();
  const output = [];
  for (const part of parts) {
    const code = normalizeUpper(part, { max: 60 });
    if (!code || seen.has(code)) continue;
    seen.add(code);
    output.push(code);
  }
  return output.join(separator);
}

export function parseReferenceDesignators(value, { separator = "," } = {}) {
  const canonical = normalizeReferenceDesignators(value, { separator });
  return canonical ? canonical.split(separator) : [];
}

// ── DTO normalization ────────────────────────────────────────────────────────

export function normalizeBomInput(body = {}, current = {}) {
  const bomNumber = body.bom_number ?? body.bomNumber ?? body.number ?? current.bom_number;
  if (!requireCode(bomNumber, "BOM number")) throw invalidBom("BOM number is required");
  return {
    bom_number: requireCode(bomNumber, "BOM number"),
    name: normalizeText(body.name ?? current.name ?? "", { max: 300 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 4000 }),
    bom_type: body.bom_type === undefined && body.bomType === undefined && current.bom_type
      ? assertBomType(current.bom_type)
      : assertBomType(body.bom_type ?? body.bomType ?? current.bom_type ?? "EBOM"),
    owner_user_id: body.owner_user_id === undefined && body.ownerUserId === undefined ? current.owner_user_id ?? null : optionalInt(body.owner_user_id ?? body.ownerUserId, "owner_user_id"),
    owner_object_id: body.owner_object_id === undefined && body.ownerObjectId === undefined ? current.owner_object_id ?? null : optionalInt(body.owner_object_id ?? body.ownerObjectId, "owner_object_id"),
    organization_id: body.organization_id === undefined && body.organizationId === undefined ? current.organization_id ?? null : optionalInt(body.organization_id ?? body.organizationId, "organization_id"),
    plant_id: body.plant_id === undefined && body.plantId === undefined ? current.plant_id ?? null : optionalInt(body.plant_id ?? body.plantId, "plant_id"),
    site_id: body.site_id === undefined && body.siteId === undefined ? current.site_id ?? null : optionalInt(body.site_id ?? body.siteId, "site_id"),
    status: body.status === undefined && current.status ? assertBomStatus(current.status) : assertBomStatus(body.status ?? current.status ?? "DRAFT"),
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
  };
}

export function normalizeRevisionInput(body = {}, current = {}) {
  const revisionNumber = body.revision_number ?? body.revisionNumber ?? body.revision ?? current.revision_number;
  if (!requireCode(revisionNumber, "Revision number")) throw invalidRevision("Revision number is required");
  const validFrom = body.valid_from ?? body.validFrom ?? current.valid_from ?? null;
  const validTo = body.valid_to ?? body.validTo ?? current.valid_to ?? null;
  if (validFrom && validTo && String(validFrom) > String(validTo)) throw invalidRevision("valid_from must not be after valid_to");
  return {
    revision_number: requireCode(revisionNumber, "Revision number"),
    status: body.status === undefined && current.status ? assertRevisionStatus(current.status) : assertRevisionStatus(body.status ?? current.status ?? "DRAFT"),
    valid_from: validFrom ? normalizeText(validFrom, { max: 40 }) : null,
    valid_to: validTo ? normalizeText(validTo, { max: 40 }) : null,
    effectivity: parseObject(body.effectivity ?? current.effectivity_json, {}),
    configuration_context: normalizeText(body.configuration_context ?? body.configurationContext ?? current.configuration_context ?? "", { max: 200 }),
    variant_id: body.variant_id === undefined && body.variantId === undefined ? current.variant_id ?? null : optionalInt(body.variant_id ?? body.variantId, "variant_id"),
    variant_code: normalizeUpper(body.variant_code ?? body.variantCode ?? current.variant_code ?? "", { max: 120 }),
    baseline_id: body.baseline_id === undefined && body.baselineId === undefined ? current.baseline_id ?? null : optionalInt(body.baseline_id ?? body.baselineId, "baseline_id"),
    owner_user_id: body.owner_user_id === undefined && body.ownerUserId === undefined ? current.owner_user_id ?? null : optionalInt(body.owner_user_id ?? body.ownerUserId, "owner_user_id"),
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
  };
}

export function normalizeLineInput(body = {}, current = {}, { enforceChild = true, enforceUom = true } = {}) {
  const childObjectId = body.child_object_id ?? body.childObjectId ?? current.child_object_id;
  if (enforceChild && (childObjectId === null || childObjectId === undefined || String(childObjectId).trim() === "")) {
    throw invalidLine("child_object_id is required");
  }
  const quantity = normalizeQuantity(body.quantity ?? current.quantity ?? 1, { fallback: 1 });
  if (quantity <= 0) throw quantityInvalid("Quantity must be greater than zero", { value: quantity });
  const uom = enforceUom
    ? assertUom(body.uom ?? current.uom ?? DEFAULT_UOM, { required: true })
    : normalizeUpper(body.uom ?? current.uom ?? DEFAULT_UOM, { max: 40 });
  return {
    parent_object_id: nullableText(body.parent_object_id ?? body.parentObjectId ?? current.parent_object_id ?? "", 300),
    parent_object_type: normalizeLower(body.parent_object_type ?? body.parentObjectType ?? current.parent_object_type ?? "part", { max: 120 }) || "part",
    child_object_id: nullableText(childObjectId, 300),
    child_object_type: normalizeLower(body.child_object_type ?? body.childObjectType ?? current.child_object_type ?? "part", { max: 120 }) || "part",
    child_revision: normalizeText(body.child_revision ?? body.childRevision ?? current.child_revision ?? "", { max: 60 }),
    quantity,
    uom,
    find_number: normalizeUpper(body.find_number ?? body.findNumber ?? current.find_number ?? "", { max: 60 }),
    sequence: toInt(body.sequence ?? current.sequence ?? 0, 0),
    reference_designator: normalizeReferenceDesignators(body.reference_designator ?? body.referenceDesignator ?? current.reference_designator ?? ""),
    usage: assertUsage(body.usage ?? current.usage ?? "DESIGN"),
    optional: toBool(body.optional ?? current.optional, false),
    substitute: toBool(body.substitute ?? current.substitute, false),
    substitute_group_id: normalizeText(body.substitute_group_id ?? body.substituteGroupId ?? current.substitute_group_id ?? "", { max: 120 }),
    effectivity: parseObject(body.effectivity ?? current.effectivity_json, {}),
    variant_id: body.variant_id === undefined && body.variantId === undefined ? current.variant_id ?? null : optionalInt(body.variant_id ?? body.variantId, "variant_id"),
    variant_code: normalizeUpper(body.variant_code ?? body.variantCode ?? current.variant_code ?? "", { max: 120 }),
    configuration_context: normalizeText(body.configuration_context ?? body.configurationContext ?? current.configuration_context ?? "", { max: 200 }),
    attributes: parseObject(body.attributes ?? current.attributes_json, {}),
    notes: normalizeText(body.notes ?? current.notes ?? "", { max: 2000 }),
    line_status: assertLineStatus(body.line_status ?? body.lineStatus ?? current.line_status ?? "ACTIVE"),
  };
}

function nullableText(value, max) {
  const text = normalizeText(value, { max });
  return text || null;
}

function optionalInt(value, name) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw invalidBom(`${name} must be an integer`);
  return n;
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
    bom_types: BOM_TYPES,
    bom_statuses: BOM_STATUSES,
    revision_statuses: REVISION_STATUSES,
    line_statuses: LINE_STATUSES,
    usages: USAGES,
    baseline_statuses: BASELINE_STATUSES,
    mapping_types: MAPPING_TYPES,
    transformation_modes: TRANSFORMATION_MODES,
    transformation_statuses: TRANSFORMATION_STATUSES,
    transformation_definition_statuses: TRANSFORMATION_DEFINITION_STATUSES,
    change_types: CHANGE_TYPES,
    comparison_scopes: COMPARISON_SCOPES,
    comparison_kinds: COMPARISON_KINDS,
    rule_types: RULE_TYPES,
    rule_severities: RULE_SEVERITIES,
    validation_statuses: VALIDATION_STATUSES,
    revision_transitions: DEFAULT_REVISION_TRANSITIONS,
    default_uom: DEFAULT_UOM,
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

export { MAX_STRUCTURE_DEPTH };

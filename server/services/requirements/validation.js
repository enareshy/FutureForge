// Normalization, assertion and vocabulary helpers for the Requirements
// Manager domain. Pure helpers are reused from the Import & Export Framework
// so there is exactly one implementation of text/number/pagination
// normalization on the platform (mirrors server/services/change/validation.js).
import { HttpError } from "../../validation.js";
import {
  normalizeText,
  normalizeUpper,
  parseObject,
  toBool,
  toInt,
  paginate,
  requireCode,
  assertEnum,
  assertTenantId,
} from "../data-exchange/validation.js";
import {
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_CRITICALITIES,
  REQUIREMENT_DOMAINS,
  REQUIREMENT_DISCIPLINES,
  REQUIREMENT_SOURCES,
  REQUIREMENT_CLASSIFICATIONS,
  REQUIREMENT_STATUSES,
  QUALITY_STATUSES,
  VERIFICATION_STATUSES,
  VALIDATION_STATUSES,
  TRACEABILITY_STATUSES,
  REVISION_STATUSES,
  RELATIONSHIP_TYPES,
  BASELINE_STATUSES,
  BASELINE_MEMBER_TYPES,
  VALIDATION_SEVERITIES,
  VALIDATION_RULE_TYPES,
  REQUIREMENT_TYPE_CATEGORIES,
  DEFAULT_REQUIREMENT_TRANSITIONS,
  REVISION_SEQUENCE,
  DEFAULT_REVISION,
  CONFIG_DEFAULTS,
  CONFIG_BOUNDS,
  DEFAULT_TYPE_PARENTS,
} from "./constants.js";
import {
  invalidRequirement,
  invalidType,
  invalidRevision,
  invalidRelationship,
  invalidBaseline,
  invalidConfiguration,
  statusInvalid,
} from "./errors.js";

export { normalizeText, normalizeUpper, parseObject, toBool, toInt, paginate, requireCode, assertEnum, assertTenantId, HttpError };

export const assertPriority = (value) => assertEnum(normalizeUpper(value), REQUIREMENT_PRIORITIES, "Priority", invalidRequirement);
export const assertCriticality = (value) => assertEnum(normalizeUpper(value), REQUIREMENT_CRITICALITIES, "Criticality", invalidRequirement);
export const assertDomain = (value) => assertEnum(normalizeUpper(value), REQUIREMENT_DOMAINS, "Domain", invalidRequirement);
export const assertDiscipline = (value) => assertEnum(normalizeUpper(value), REQUIREMENT_DISCIPLINES, "Discipline", invalidRequirement);
export const assertSource = (value) => assertEnum(normalizeUpper(value), REQUIREMENT_SOURCES, "Source", invalidRequirement);
export const assertClassification = (value) => assertEnum(normalizeUpper(value), REQUIREMENT_CLASSIFICATIONS, "Classification", invalidRequirement);
export const assertStatus = (value) => assertEnum(normalizeUpper(value), REQUIREMENT_STATUSES, "Status", invalidRequirement);
export const assertQualityStatus = (value) => assertEnum(normalizeUpper(value), QUALITY_STATUSES, "Quality status", invalidRequirement);
export const assertVerificationStatus = (value) => assertEnum(normalizeUpper(value), VERIFICATION_STATUSES, "Verification status", invalidRequirement);
export const assertValidationStatus = (value) => assertEnum(normalizeUpper(value), VALIDATION_STATUSES, "Validation status", invalidRequirement);
export const assertTraceabilityStatus = (value) => assertEnum(normalizeUpper(value), TRACEABILITY_STATUSES, "Traceability status", invalidRequirement);
export const assertRevisionStatus = (value) => assertEnum(normalizeUpper(value), REVISION_STATUSES, "Revision status", invalidRevision);
export const assertRelationshipType = (value) => assertEnum(normalizeUpper(value), RELATIONSHIP_TYPES, "Relationship type", invalidRelationship);
export const assertBaselineStatus = (value) => assertEnum(normalizeUpper(value), BASELINE_STATUSES, "Baseline status", invalidBaseline);
export const assertBaselineMemberType = (value) => assertEnum(normalizeUpper(value), BASELINE_MEMBER_TYPES, "Baseline member type", invalidBaseline);
export const assertSeverity = (value) => assertEnum(normalizeUpper(value), VALIDATION_SEVERITIES, "Validation severity", invalidConfiguration);
export const assertRuleType = (value) => assertEnum(normalizeUpper(value), VALIDATION_RULE_TYPES, "Validation rule type", invalidConfiguration);
export const assertTypeCategory = (value) => assertEnum(normalizeUpper(value), REQUIREMENT_TYPE_CATEGORIES, "Type category", invalidType);

// ── State transitions (centralized, data-driven) ─────────────────────────────

export function assertRequirementTransition(from, to) {
  const target = normalizeUpper(to);
  const allowed = DEFAULT_REQUIREMENT_TRANSITIONS[normalizeUpper(from)] || [];
  if (!allowed.includes(target)) throw statusInvalid(target, normalizeUpper(from), allowed);
  return target;
}

// ── Revisions ────────────────────────────────────────────────────────────────

// Excel-style base-26 revision increment: A..Z, AA, AB, ...
export function nextRevision(current) {
  const value = normalizeUpper(current || "");
  if (!value) return DEFAULT_REVISION;
  let index = 0;
  for (const ch of value) {
    const pos = REVISION_SEQUENCE.indexOf(ch);
    if (pos < 0) return DEFAULT_REVISION;
    index = index * 26 + (pos + 1);
  }
  index += 1;
  let out = "";
  while (index > 0) {
    const rem = (index - 1) % 26;
    out = REVISION_SEQUENCE[rem] + out;
    index = Math.floor((index - 1) / 26);
  }
  return out;
}

export function assertRevisionCode(value) {
  const code = normalizeUpper(value);
  if (!code || !/^[A-Z]{1,4}$/.test(code)) throw invalidRevision("Revision must be 1-4 uppercase letters", { revision: value });
  return code;
}

// ── DTO normalization ────────────────────────────────────────────────────────

function optionalInt(value, name, errorFactory) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw errorFactory(`${name} must be an integer`);
  return n;
}

function optionalText(value, max = 300) {
  if (value === null || value === undefined) return "";
  return normalizeText(value, { max });
}

export function normalizeRequirementInput(body = {}, current = {}) {
  const rawTags = body.tags ?? parseObject(current.tags_json, []);
  const tags = Array.isArray(rawTags)
    ? rawTags.map((t) => normalizeText(t, { max: 60 })).filter(Boolean).slice(0, 50)
    : [];
  return {
    title: normalizeText(body.title ?? current.title ?? "", { max: 300 }),
    name: normalizeText(body.name ?? current.name ?? "", { max: 120 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 8000 }),
    requirement_type: normalizeText(body.requirement_type ?? body.requirementType ?? current.requirement_type ?? "", { max: 64 }).toLowerCase(),
    category: normalizeText(body.category ?? current.category ?? "", { max: 60 }),
    source: assertSource(body.source ?? current.source ?? "INTERNAL"),
    external_reference: optionalText(body.external_reference ?? body.externalReference ?? current.external_reference, 300),
    domain: assertDomain(body.domain ?? current.domain ?? "SYSTEM"),
    discipline: assertDiscipline(body.discipline ?? current.discipline ?? "DESIGN"),
    priority: assertPriority(body.priority ?? current.priority ?? "NORMAL"),
    criticality: assertCriticality(body.criticality ?? current.criticality ?? "MEDIUM"),
    classification: assertClassification(body.classification ?? current.classification ?? "INTERNAL"),
    tags,
    owner_user_id:
      body.owner_user_id === undefined && body.ownerUserId === undefined
        ? current.owner_user_id ?? null
        : optionalInt(body.owner_user_id ?? body.ownerUserId, "owner_user_id", invalidRequirement),
    responsible_user_id:
      body.responsible_user_id === undefined && body.responsibleUserId === undefined
        ? current.responsible_user_id ?? null
        : optionalInt(body.responsible_user_id ?? body.responsibleUserId, "responsible_user_id", invalidRequirement),
    responsible_group_id:
      body.responsible_group_id === undefined && body.responsibleGroupId === undefined
        ? current.responsible_group_id ?? null
        : optionalInt(body.responsible_group_id ?? body.responsibleGroupId, "responsible_group_id", invalidRequirement),
    organization_id:
      body.organization_id === undefined && body.organizationId === undefined
        ? current.organization_id ?? null
        : optionalInt(body.organization_id ?? body.organizationId, "organization_id", invalidRequirement),
    business_unit_id:
      body.business_unit_id === undefined && body.businessUnitId === undefined
        ? current.business_unit_id ?? null
        : optionalInt(body.business_unit_id ?? body.businessUnitId, "business_unit_id", invalidRequirement),
    site_id:
      body.site_id === undefined && body.siteId === undefined
        ? current.site_id ?? null
        : optionalInt(body.site_id ?? body.siteId, "site_id", invalidRequirement),
    parent_id:
      body.parent_id === undefined && body.parentId === undefined
        ? current.parent_id ?? null
        : optionalInt(body.parent_id ?? body.parentId, "parent_id", invalidRequirement),
    effective_from: optionalText(body.effective_from ?? body.effectiveFrom ?? current.effective_from, 40) || null,
    effective_to: optionalText(body.effective_to ?? body.effectiveTo ?? current.effective_to, 40) || null,
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
  };
}

export function normalizeTypeInput(body = {}, current = {}) {
  const code = normalizeText(body.code ?? current.code ?? "", { max: 64 }).toLowerCase();
  if (!code) throw invalidType("code is required");
  requireCode(code, "Requirement type code");
  return {
    code,
    name: normalizeText(body.name ?? current.name ?? code, { max: 160 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 2000 }),
    category: assertTypeCategory(body.category ?? current.category ?? "OTHER"),
    parent_code: normalizeText(body.parent_code ?? body.parentCode ?? current.parent_code ?? "", { max: 64 }).toLowerCase() || null,
    numbering_scheme: normalizeText(body.numbering_scheme ?? body.numberingScheme ?? current.numbering_scheme ?? "", { max: 64 }) || null,
    lifecycle_code: normalizeText(body.lifecycle_code ?? body.lifecycleCode ?? current.lifecycle_code ?? "", { max: 120 }) || null,
    workflow_code: normalizeText(body.workflow_code ?? body.workflowCode ?? current.workflow_code ?? "", { max: 120 }) || null,
    required_fields: Array.isArray(body.required_fields ?? body.requiredFields)
      ? (body.required_fields ?? body.requiredFields).map((f) => normalizeText(f, { max: 64 })).filter(Boolean)
      : parseObject(current.required_fields_json, []),
    allowed_relationships: Array.isArray(body.allowed_relationships ?? body.allowedRelationships)
      ? (body.allowed_relationships ?? body.allowedRelationships).map((r) => assertRelationshipType(r))
      : parseObject(current.allowed_relationships_json, []),
    layout: parseObject(body.layout ?? current.layout_json, {}),
    sequence: body.sequence === undefined ? Number(current.sequence || 100) : toInt(body.sequence, 100),
    status: normalizeUpper(body.status ?? current.status ?? "ACTIVE"),
  };
}

export function normalizeRelationshipInput(body = {}) {
  const relationshipType = body.relationship_type ?? body.relationshipType;
  const sourceId = body.source_id ?? body.sourceId;
  const targetId = body.target_id ?? body.targetId;
  if (!relationshipType) throw invalidRelationship("relationship_type is required");
  if (sourceId === undefined || sourceId === null || String(sourceId).trim() === "") throw invalidRelationship("source_id is required");
  if (targetId === undefined || targetId === null || String(targetId).trim() === "") throw invalidRelationship("target_id is required");
  return {
    relationship_type: assertRelationshipType(relationshipType),
    source_type: normalizeText(body.source_type ?? body.sourceType ?? "requirement", { max: 60 }),
    source_id: normalizeText(sourceId, { max: 300 }),
    target_type: normalizeText(body.target_type ?? body.targetType ?? "requirement", { max: 60 }),
    target_id: normalizeText(targetId, { max: 300 }),
    status: normalizeUpper(body.status ?? "ACTIVE"),
    effectivity_from: normalizeText(body.effectivity_from ?? body.effectivityFrom ?? "", { max: 40 }) || null,
    effectivity_to: normalizeText(body.effectivity_to ?? body.effectivityTo ?? "", { max: 40 }) || null,
    attributes: parseObject(body.attributes ?? {}, {}),
  };
}

export function normalizeBaselineInput(body = {}, current = {}) {
  return {
    name: normalizeText(body.name ?? current.name ?? "", { max: 200 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 4000 }),
    baseline_version: normalizeText(body.baseline_version ?? body.baselineVersion ?? current.baseline_version ?? "1.0", { max: 40 }),
    owner_user_id:
      body.owner_user_id === undefined && body.ownerUserId === undefined
        ? current.owner_user_id ?? null
        : optionalInt(body.owner_user_id ?? body.ownerUserId, "owner_user_id", invalidBaseline),
    organization_id:
      body.organization_id === undefined && body.organizationId === undefined
        ? current.organization_id ?? null
        : optionalInt(body.organization_id ?? body.organizationId, "organization_id", invalidBaseline),
    baseline_date: normalizeText(body.baseline_date ?? body.baselineDate ?? current.baseline_date ?? "", { max: 40 }) || null,
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
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
  return value;
}

export function vocabulary() {
  return {
    requirement_statuses: REQUIREMENT_STATUSES,
    requirement_priorities: REQUIREMENT_PRIORITIES,
    requirement_criticalities: REQUIREMENT_CRITICALITIES,
    requirement_domains: REQUIREMENT_DOMAINS,
    requirement_disciplines: REQUIREMENT_DISCIPLINES,
    requirement_sources: REQUIREMENT_SOURCES,
    requirement_classifications: REQUIREMENT_CLASSIFICATIONS,
    requirement_type_categories: REQUIREMENT_TYPE_CATEGORIES,
    quality_statuses: QUALITY_STATUSES,
    verification_statuses: VERIFICATION_STATUSES,
    validation_statuses: VALIDATION_STATUSES,
    traceability_statuses: TRACEABILITY_STATUSES,
    revision_statuses: REVISION_STATUSES,
    relationship_types: RELATIONSHIP_TYPES,
    baseline_statuses: BASELINE_STATUSES,
    baseline_member_types: BASELINE_MEMBER_TYPES,
    validation_severities: VALIDATION_SEVERITIES,
    validation_rule_types: VALIDATION_RULE_TYPES,
    status_transitions: DEFAULT_REQUIREMENT_TRANSITIONS,
    default_type_parents: DEFAULT_TYPE_PARENTS,
  };
}

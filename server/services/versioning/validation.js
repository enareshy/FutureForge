// Centralized validation, normalization and public-projection helpers for the
// Effectivity & Versioning Kernel. Kept free of persistence concerns so both the
// services and the resolution engine share exactly one definition of truth.
import { HttpError } from "../../validation.js";
import {
  invalidEffectivity,
  invalidSerialRange,
  invalidContext,
  invalidResolutionPolicy,
} from "./errors.js";

export const REVISION_STATUSES = Object.freeze(["draft", "active", "superseded", "retired", "archived"]);
export const VERSION_STATUSES = Object.freeze(["draft", "active", "superseded", "retired", "archived"]);

// Canonical effectivity dimensions. New dimensions can be registered through the
// effectivity-type catalogue without changing this list for the core six.
export const DIMENSIONS = Object.freeze([
  "date",
  "serial",
  "unit",
  "plant",
  "model",
  "revision",
  "variant",
  "configuration",
]);

export const CORE_PRECEDENCE = Object.freeze([
  "configuration",
  "revision",
  "serial",
  "model",
  "plant",
  "unit",
  "date",
  "default",
]);

export const AMBIGUITY_STRATEGIES = Object.freeze(["error", "priority", "latest_revision"]);
export const BOUNDARIES = Object.freeze(["inclusive", "exclusive"]);
export const RELATIONSHIP_TYPES = Object.freeze([
  "supersedes",
  "effective_after",
  "effective_before",
  "applicable_with",
  "derived_from",
]);
export const RESOLUTION_STATUSES = Object.freeze([
  "RESOLVED",
  "AMBIGUOUS",
  "NOT_FOUND",
  "INVALID_CONTEXT",
  "CONFLICT",
]);
export const SERIAL_MODES = Object.freeze(["numeric", "alphanumeric"]);
export const ASSIGNMENT_ROLES = Object.freeze(["primary", "override", "exclusion"]);
export const VARIANT_RULE_TYPES = Object.freeze(["inclusion", "exclusion", "constraint", "applicability"]);

export function safeParse(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toJson(value, fallback = {}) {
  if (value === undefined || value === null) return JSON.stringify(fallback);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function normalizeText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

export function normalizeCode(value, { upper = false } = {}) {
  const text = normalizeText(value);
  return upper ? text.toUpperCase() : text;
}

export function assertEnum(value, allowed, field, errors) {
  if (value === undefined || value === null || value === "") return;
  if (!allowed.includes(value)) errors.push(`${field} must be one of: ${allowed.join(", ")}`);
}

export function assertDate(value, field, errors) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(text)) {
    errors.push(`${field} must be an ISO date (YYYY-MM-DD) or timestamp`);
    return null;
  }
  const parsed = Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(parsed)) {
    errors.push(`${field} is not a valid date`);
    return null;
  }
  return text.length === 10 ? text : new Date(parsed).toISOString();
}

export function dateMs(value) {
  if (!value) return null;
  const text = String(value);
  const parsed = Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text);
  return Number.isNaN(parsed) ? null : parsed;
}

// Inclusive range check honouring boundary configuration.
export function withinDateRange(asOf, from, to, boundary = "inclusive") {
  const point = dateMs(asOf);
  if (point === null) return { valid: false, reason: "INVALID_DATE" };
  const start = dateMs(from);
  const end = dateMs(to);
  if (start !== null) {
    if (boundary === "exclusive" ? point <= start : point < start) return { valid: false, reason: "BEFORE_RANGE" };
  }
  if (end !== null) {
    if (boundary === "exclusive" ? point >= end : point > end) return { valid: false, reason: "AFTER_RANGE" };
  }
  return { valid: true };
}

export function rangesOverlap(fromA, toA, fromB, toB) {
  const aStart = dateMs(fromA);
  const aEnd = dateMs(toA);
  const bStart = dateMs(fromB);
  const bEnd = dateMs(toB);
  const aBeforeB = aEnd !== null && bStart !== null && aEnd < bStart;
  const bBeforeA = bEnd !== null && aStart !== null && bEnd < aStart;
  return !aBeforeB && !bBeforeA;
}

// Serial comparison. Numeric mode coerces to numbers; alphanumeric compares
// lexicographically with a natural-order fallback so 100 > 20.
export function normalizeSerial(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value).trim();
}

export function compareSerials(a, b, mode = "numeric") {
  const left = normalizeSerial(a);
  const right = normalizeSerial(b);
  if (left === null || right === null) return null;
  if (mode === "numeric") {
    const ln = Number(left);
    const rn = Number(right);
    if (Number.isNaN(ln) || Number.isNaN(rn)) {
      return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
    }
    return ln === rn ? 0 : ln < rn ? -1 : 1;
  }
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

export function withinSerialRange(serial, from, to, mode = "numeric") {
  const value = normalizeSerial(serial);
  if (value === null) return { valid: false, reason: "MISSING_SERIAL" };
  if (from !== null && from !== undefined && from !== "") {
    const cmp = compareSerials(value, from, mode);
    if (cmp === null || cmp < 0) return { valid: false, reason: "BELOW_RANGE" };
  }
  if (to !== null && to !== undefined && to !== "") {
    const cmp = compareSerials(value, to, mode);
    if (cmp === null || cmp > 0) return { valid: false, reason: "ABOVE_RANGE" };
  }
  return { valid: true };
}

export function serialRangesOverlap(fromA, toA, fromB, toB, mode = "numeric") {
  const aStart = normalizeSerial(fromA);
  const aEnd = normalizeSerial(toA);
  const bStart = normalizeSerial(fromB);
  const bEnd = normalizeSerial(toB);
  const aBeforeB = aEnd !== null && bStart !== null && compareSerials(aEnd, bStart, mode) < 0;
  const bBeforeA = bEnd !== null && aStart !== null && compareSerials(bEnd, aStart, mode) < 0;
  return !aBeforeB && !bBeforeA;
}

export function validateRange({ from, to, field, errors, useSerial = false, mode = "numeric" }) {
  if (from === undefined || from === null || from === "") return;
  if (to === undefined || to === null || to === "") return;
  if (useSerial) {
    const cmp = compareSerials(from, to, mode);
    if (cmp !== null && cmp > 0) errors.push(`${field}From must be <= ${field}To`);
  } else {
    const start = dateMs(from);
    const end = dateMs(to);
    if (start !== null && end !== null && start > end) errors.push(`${field}From must be <= ${field}To`);
  }
}

export function requireObjectRef({ objectType, objectId }) {
  const errors = [];
  if (!normalizeText(objectType)) errors.push("objectType is required");
  if (!normalizeText(objectId)) errors.push("objectId is required");
  if (errors.length) throw invalidEffectivity(errors.join("; "), { errors });
  return { objectType: normalizeText(objectType), objectId: normalizeText(objectId) };
}

export function validatePolicyInput(input = {}, { partial = false } = {}) {
  const errors = [];
  const precedence = input.precedence ?? input.precedence_json;
  if (precedence !== undefined) {
    const list = Array.isArray(precedence) ? precedence : safeParse(precedence, null);
    if (!Array.isArray(list) || !list.length) {
      errors.push("precedence must be a non-empty array of dimensions");
    } else {
      for (const dim of list) {
        if (!DIMENSIONS.includes(dim) && dim !== "default") errors.push(`Unknown precedence dimension: ${dim}`);
      }
    }
  } else if (!partial) {
    errors.push("precedence is required");
  }
  assertEnum(input.ambiguityStrategy ?? input.ambiguity_strategy, AMBIGUITY_STRATEGIES, "ambiguityStrategy", errors);
  assertEnum(input.boundary, BOUNDARIES, "boundary", errors);
  if (errors.length) throw invalidResolutionPolicy(errors.join("; "), { errors });
  return true;
}

export function validateContextInput(context = {}) {
  const errors = [];
  const normalized = {
    asOfDate: assertDate(context.asOfDate ?? context.as_of_date ?? context.asOf, "asOfDate", errors),
    serialNumber: normalizeSerial(context.serialNumber ?? context.serial_number ?? context.serial),
    tenantId: context.tenantId ?? context.tenant_id ?? null,
    organizationId: context.organizationId ?? context.organization_id ?? null,
    companyId: context.companyId ?? context.company_id ?? null,
    businessUnitId: context.businessUnitId ?? context.business_unit_id ?? null,
    plantId: context.plantId ?? context.plant_id ?? null,
    siteId: context.siteId ?? context.site_id ?? null,
    unitId: context.unitId ?? context.unit_id ?? null,
    productionLineId: context.productionLineId ?? context.production_line_id ?? null,
    modelId: context.modelId ?? context.model_id ?? null,
    modelFamily: context.modelFamily ?? context.model_family ?? null,
    revisionId: context.revisionId ?? context.revision_id ?? null,
    revisionRef: context.revisionRef ?? context.revision_ref ?? null,
    variantId: context.variantId ?? context.variant_id ?? null,
    variantCode: context.variantCode ?? context.variant_code ?? null,
    configurationId: context.configurationId ?? context.configuration_id ?? context.configuration_id ?? null,
    configurationRef: context.configurationRef ?? context.configuration_ref ?? null,
    versionId: context.versionId ?? context.version_id ?? null,
  };
  if (errors.length) throw invalidContext(errors.join("; "), { errors });
  return normalized;
}

export function contextCacheKey(objectType, objectId, context, policyCode) {
  const relevant = {
    o: `${objectType}:${objectId}`,
    d: context.asOfDate ?? null,
    s: context.serialNumber ?? null,
    t: context.tenantId ?? null,
    org: context.organizationId ?? null,
    p: context.plantId ?? null,
    site: context.siteId ?? null,
    u: context.unitId ?? null,
    m: context.modelId ?? null,
    r: context.revisionId ?? context.revisionRef ?? null,
    v: context.variantId ?? context.variantCode ?? null,
    c: context.configurationId ?? context.configurationRef ?? null,
    pol: policyCode ?? null,
  };
  return JSON.stringify(relevant);
}

// ── Public projections ──────────────────────────────────────────────────────

export function publicRevision(row) {
  if (!row) return null;
  const metadata = safeParse(row.revision_metadata_json, {});
  return {
    id: row.id,
    revision_ref: row.revision_ref,
    object_type: row.object_type,
    object_id: row.object_id,
    revision_code: row.revision_code,
    revision_sequence: row.revision_sequence,
    name: row.name,
    description: row.description,
    status: row.status,
    lifecycle_state: row.lifecycle_state,
    is_default: Boolean(row.is_default),
    released_at: row.released_at,
    superseded_at: row.superseded_at,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    metadata,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    plant_id: row.plant_id,
    site_id: row.site_id,
    version: row.version,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicVersion(row) {
  if (!row) return null;
  const metadata = safeParse(row.version_metadata_json, {});
  return {
    id: row.id,
    version_ref: row.version_ref,
    revision_id: row.revision_id,
    object_type: row.object_type,
    object_id: row.object_id,
    version_number: row.version_number,
    version_sequence: row.version_sequence,
    name: row.name,
    description: row.description,
    status: row.status,
    lifecycle_state: row.lifecycle_state,
    is_default: Boolean(row.is_default),
    released_at: row.released_at,
    superseded_at: row.superseded_at,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    metadata,
    tenant_id: row.tenant_id,
    version: row.version,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicEffectivityType(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    dimension: row.dimension,
    value_mode: row.value_mode,
    description: row.description,
    config: safeParse(row.config_json, {}),
    system: Boolean(row.system),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicDefinition(row, values = []) {
  if (!row) return null;
  return {
    id: row.id,
    definition_ref: row.definition_ref,
    code: row.code,
    name: row.name,
    description: row.description,
    type_code: row.type_code,
    dimension: row.dimension,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    boundary: row.boundary,
    serial_from: row.serial_from,
    serial_to: row.serial_to,
    serial_mode: row.serial_mode,
    revision_id: row.revision_id,
    configuration_context_id: row.configuration_context_id,
    include: safeParse(row.include_json, []),
    exclude: safeParse(row.exclude_json, []),
    priority: row.priority,
    overlap_allowed: Boolean(row.overlap_allowed),
    status: row.status,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    version: row.version,
    values: values.map(publicValue),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicValue(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_id: row.definition_id,
    dimension: row.dimension,
    value: row.value,
    operator: row.operator,
    value_type: row.value_type,
  };
}

export function publicAssignment(row) {
  if (!row) return null;
  return {
    id: row.id,
    assignment_ref: row.assignment_ref,
    definition_id: row.definition_id,
    object_type: row.object_type,
    object_id: row.object_id,
    revision_id: row.revision_id,
    version_id: row.version_id,
    role: row.role,
    precedence: row.precedence,
    status: row.status,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRelationship(row) {
  if (!row) return null;
  return {
    id: row.id,
    from_revision_id: row.from_revision_id,
    to_revision_id: row.to_revision_id,
    relationship_type: row.relationship_type,
    description: row.description,
    created_at: row.created_at,
  };
}

export function publicVariant(row, { options = [], rules = [] } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    variant_ref: row.variant_ref,
    code: row.code,
    name: row.name,
    description: row.description,
    parent_id: row.parent_id,
    object_type: row.object_type,
    status: row.status,
    is_default: Boolean(row.is_default),
    attributes: safeParse(row.attributes_json, {}),
    tenant_id: row.tenant_id,
    version: row.version,
    options: options.map(publicVariantOption),
    rules: rules.map(publicVariantRule),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicVariantOption(row) {
  if (!row) return null;
  return {
    id: row.id,
    variant_id: row.variant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    sequence: row.sequence,
    attributes: safeParse(row.attributes_json, {}),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicVariantRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    variant_id: row.variant_id,
    code: row.code,
    name: row.name,
    rule_type: row.rule_type,
    expression: safeParse(row.expression_json, {}),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicConfigurationContext(row) {
  if (!row) return null;
  return {
    id: row.id,
    context_ref: row.context_ref,
    code: row.code,
    name: row.name,
    description: row.description,
    configuration_version: row.configuration_version,
    variant_id: row.variant_id,
    model_id: row.model_id,
    plant_id: row.plant_id,
    site_id: row.site_id,
    organization_id: row.organization_id,
    revision_id: row.revision_id,
    as_of_date: row.as_of_date,
    serial_number: row.serial_number,
    attributes: safeParse(row.attributes_json, {}),
    status: row.status,
    tenant_id: row.tenant_id,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicPolicy(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    precedence: safeParse(row.precedence_json, CORE_PRECEDENCE),
    boundary: row.boundary,
    ambiguity_strategy: row.ambiguity_strategy,
    allow_overlap: Boolean(row.allow_overlap),
    fallback_to_default: Boolean(row.fallback_to_default),
    status: row.status,
    is_default: Boolean(row.is_default),
    tenant_id: row.tenant_id,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicBaseline(row, objects = []) {
  if (!row) return null;
  return {
    id: row.id,
    baseline_ref: row.baseline_ref,
    code: row.code,
    name: row.name,
    description: row.description,
    owner_id: row.owner_id,
    owner_name: row.owner_name,
    status: row.status,
    context: safeParse(row.context_json, {}),
    object_count: row.object_count,
    locked: Boolean(row.locked),
    frozen_at: row.frozen_at,
    frozen_by: row.frozen_by,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    version: row.version,
    objects: objects.map(publicBaselineObject),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicBaselineObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    baseline_id: row.baseline_id,
    object_type: row.object_type,
    object_id: row.object_id,
    revision_id: row.revision_id,
    version_id: row.version_id,
    revision_code: row.revision_code,
    version_number: row.version_number,
    resolution_status: row.resolution_status,
    resolution_reason: row.resolution_reason,
    metadata: safeParse(row.metadata_json, {}),
    created_at: row.created_at,
  };
}

export function publicSnapshot(row, objects = []) {
  if (!row) return null;
  return {
    id: row.id,
    snapshot_ref: row.snapshot_ref,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    context: safeParse(row.context_json, {}),
    object_count: row.object_count,
    content_hash: row.content_hash,
    parent_snapshot_id: row.parent_snapshot_id,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    version: row.version,
    objects: objects.map(publicSnapshotObject),
    created_at: row.created_at,
  };
}

export function publicSnapshotObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    snapshot_id: row.snapshot_id,
    object_type: row.object_type,
    object_id: row.object_id,
    revision_id: row.revision_id,
    version_id: row.version_id,
    revision_code: row.revision_code,
    version_number: row.version_number,
    resolution_status: row.resolution_status,
    resolution_reason: row.resolution_reason,
    metadata: safeParse(row.metadata_json, {}),
    created_at: row.created_at,
  };
}

export function publicResolutionResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    result_ref: row.result_ref,
    object_type: row.object_type,
    object_id: row.object_id,
    policy_code: row.policy_code,
    context: safeParse(row.context_json, {}),
    status: row.status,
    revision_id: row.revision_id,
    version_id: row.version_id,
    resolution_reason: row.resolution_reason,
    candidates: safeParse(row.candidate_scores_json, []),
    message: row.message,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
  };
}

export function badRequest(message, details = null) {
  return new HttpError(400, message, details);
}

export function invalidRange(message, details = null) {
  return invalidEffectivity(message, details);
}

export function invalidSerial(message, details = null) {
  return invalidSerialRange(message, details);
}

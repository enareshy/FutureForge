// Numbering Service vocabulary and input validation. Kept free of database
// access so it can be imported by the pattern engine, the HTTP layer and tests.
import { HttpError } from "../../validation.js";
import { NumberingError, NUMBERING_ERROR_CODES } from "./errors.js";
import { parsePattern } from "./tokens.js";

export const SCHEME_STATUSES = ["draft", "active", "inactive", "retired"];
export const NUMBERING_MODES = ["automatic", "manual", "automatic_with_manual_override", "manual_required"];
export const MANUAL_POLICIES = ["disabled", "allowed", "approval_required", "mandatory"];
export const REUSE_POLICIES = ["never_reuse", "reuse_after_release", "reuse_after_expiration", "custom"];
export const RESET_POLICIES = ["never", "daily", "monthly", "yearly", "fiscal_year"];
export const SEQUENCE_SCOPES = [
  "global",
  "tenant",
  "organization",
  "company",
  "plant",
  "site",
  "object_type",
  "classification",
  "scheme",
  "custom",
];
export const SCOPE_TYPES = [
  "global",
  "tenant",
  "organization",
  "company",
  "plant",
  "site",
  "classification",
  "object_type",
  "custom",
];
export const ALLOCATION_STATUSES = ["allocated", "reserved", "consumed", "released", "expired", "cancelled"];
export const OBJECT_TYPE_STATUSES = ["active", "inactive"];
export const ACTIVE_ALLOCATION_STATUSES = ["allocated", "reserved"];
export const TERMINAL_ALLOCATION_STATUSES = ["consumed", "released", "expired", "cancelled"];
export const FISCAL_YEAR_START_MONTH = 4;

const CODE_RE = /^[A-Za-z][A-Za-z0-9._-]{1,63}$/;
const TOKEN_RE = /^[A-Z][A-Z0-9_]{0,31}$/;

export function pick(input, ...names) {
  for (const name of names) {
    if (input && input[name] !== undefined) return input[name];
  }
  return undefined;
}

export function bool(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function intOr(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new HttpError(400, `${label} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

export function normalizedObjectTypeCode(input) {
  return String(pick(input, "objectType", "objectTypeCode", "object_type_code", "object_type") || "").trim().toUpperCase();
}

export function assertSchemeCode(code) {
  if (!CODE_RE.test(String(code || ""))) {
    throw new HttpError(400, "Scheme code must start with a letter and be 2-64 characters (letters, digits, . _ -)");
  }
  return String(code);
}

// Normalises a scheme create/update payload. `partial` keeps only supplied
// fields so PATCH semantics are safe.
export function normalizeSchemeInput(body = {}, { partial = false } = {}) {
  const out = {};
  const set = (key, value) => {
    if (value !== undefined) out[key] = value;
  };

  set("code", pick(body, "code"));
  set("name", pick(body, "name"));
  set("description", pick(body, "description"));
  const objectType = pick(body, "objectType", "objectTypeCode", "object_type_code", "object_type");
  if (objectType !== undefined) out.object_type_code = String(objectType).trim().toUpperCase();
  set("pattern", pick(body, "pattern"));
  set("prefix", pick(body, "prefix"));
  set("suffix", pick(body, "suffix"));
  set("scope_type", pick(body, "scopeType", "scope_type"));
  set("number_reuse_policy", pick(body, "numberReusePolicy", "reusePolicy", "number_reuse_policy", "reuse_policy"));
  set("numbering_mode", pick(body, "numberingMode", "numbering_mode"));
  set("manual_policy", pick(body, "manualPolicy", "manual_policy"));
  set("manual_pattern", pick(body, "manualPattern", "manual_pattern"));
  set("manual_allowed_chars", pick(body, "manualAllowedChars", "manual_allowed_chars"));
  set("manual_min_length", intOr(pick(body, "manualMinLength", "manual_min_length"), undefined));
  set("manual_max_length", intOr(pick(body, "manualMaxLength", "manual_max_length"), undefined));
  set("min_length", intOr(pick(body, "minLength", "min_length"), undefined));
  set("max_length", intOr(pick(body, "maxLength", "max_length"), undefined));
  set("start_value", intOr(pick(body, "startValue", "start_value"), undefined));
  set("min_value", intOr(pick(body, "minValue", "min_value"), undefined));
  set("max_value", intOr(pick(body, "maxValue", "max_value"), undefined));
  set("increment", intOr(pick(body, "increment", "step"), undefined));
  set("padding", intOr(pick(body, "padding", "padLength", "padding_length"), undefined));
  set("reset_policy", pick(body, "resetPolicy", "reset_policy"));
  set("sequence_scope", pick(body, "sequenceScope", "sequence_scope", "scope"));
  set("reservation_timeout_seconds", intOr(pick(body, "reservationTimeoutSeconds", "reservation_timeout_seconds"), undefined));
  set("priority", intOr(pick(body, "priority"), undefined));
  set("is_default", bool(pick(body, "isDefault", "is_default")));
  set("effective_from", pick(body, "effectiveFrom", "effective_from"));
  set("effective_to", pick(body, "effectiveTo", "effective_to"));
  set("organization_id", pick(body, "organizationId", "organization_id"));
  set("plant_id", pick(body, "plantId", "plant_id"));
  set("site_id", pick(body, "siteId", "site_id"));
  set("classification", pick(body, "classification", "classificationCode"));
  set("status", pick(body, "status"));
  set("change_summary", pick(body, "changeSummary", "change_summary"));

  if (out.manual_min_length === undefined) delete out.manual_min_length;
  if (out.manual_max_length === undefined) delete out.manual_max_length;
  if (out.min_length === undefined) delete out.min_length;
  if (out.max_length === undefined) delete out.max_length;
  if (out.start_value === undefined) delete out.start_value;
  if (out.min_value === undefined) delete out.min_value;
  if (out.max_value === undefined) delete out.max_value;
  if (out.increment === undefined) delete out.increment;
  if (out.padding === undefined) delete out.padding;
  if (out.reservation_timeout_seconds === undefined) delete out.reservation_timeout_seconds;
  if (out.priority === undefined) delete out.priority;

  if (!partial) {
    if (!out.code) throw new HttpError(400, "Scheme code is required");
    if (!out.name) throw new HttpError(400, "Scheme name is required");
    if (!out.object_type_code) throw new HttpError(400, "Object type is required");
  }
  if (out.code !== undefined) assertSchemeCode(out.code);
  if (out.status !== undefined) requireEnum(out.status, SCHEME_STATUSES, "status");
  if (out.scope_type !== undefined) requireEnum(out.scope_type, SCOPE_TYPES, "scopeType");
  if (out.number_reuse_policy !== undefined) requireEnum(out.number_reuse_policy, REUSE_POLICIES, "numberReusePolicy");
  if (out.numbering_mode !== undefined) requireEnum(out.numbering_mode, NUMBERING_MODES, "numberingMode");
  if (out.manual_policy !== undefined) requireEnum(out.manual_policy, MANUAL_POLICIES, "manualPolicy");
  if (out.reset_policy !== undefined) requireEnum(out.reset_policy, RESET_POLICIES, "resetPolicy");
  if (out.sequence_scope !== undefined) requireEnum(out.sequence_scope, SEQUENCE_SCOPES, "sequenceScope");
  if (out.pattern !== undefined) {
    const parsed = parsePattern(out.pattern);
    if (!parsed.valid) {
      throw new NumberingError(400, `Invalid pattern: ${parsed.errors.join("; ")}`, NUMBERING_ERROR_CODES.INVALID_PATTERN);
    }
  }
  if (out.increment !== undefined && out.increment <= 0) {
    throw new HttpError(400, "increment must be a positive integer");
  }
  if (out.padding !== undefined && out.padding < 1 && out.padding !== 0) {
    throw new HttpError(400, "padding must be zero or a positive integer");
  }
  if (out.max_length !== undefined && out.max_length > 512) {
    throw new HttpError(400, "maxLength cannot exceed 512 characters");
  }
  return out;
}

export function normalizeGenerateInput(body = {}) {
  const objectType = normalizedObjectTypeCode(body);
  if (!objectType) throw new HttpError(400, "objectType is required");
  return {
    object_type_code: objectType,
    organization_id: pick(body, "organizationId", "organization_id") ?? null,
    plant_id: pick(body, "plantId", "plant_id") ?? null,
    site_id: pick(body, "siteId", "site_id") ?? null,
    classification: pick(body, "classification", "classificationCode") ?? "",
    scheme_code: pick(body, "schemeCode", "scheme_code", "scheme") ?? null,
    object_id: pick(body, "objectId", "object_id") ?? null,
    object_ref: pick(body, "objectRef", "object_ref") ?? "",
    reason: pick(body, "reason") ?? "",
    source_application: pick(body, "sourceApplication", "source_application", "source") ?? "",
    correlation_id: pick(body, "correlationId", "correlation_id") ?? null,
    request_id: pick(body, "requestId", "request_id") ?? null,
    idempotency_key: pick(body, "idempotencyKey", "idempotency_key") ?? null,
    reserve: bool(pick(body, "reserve")) ?? false,
    reservation_timeout_seconds: intOr(pick(body, "reservationTimeoutSeconds", "reservation_timeout_seconds"), null),
    manual_number: pick(body, "manualNumber", "number") ?? null,
    preferred_number: pick(body, "preferredNumber", "preferred_number") ?? null,
    metadata: pick(body, "metadata") ?? null,
  };
}

export function normalizeAllocationQuery(query = {}) {
  return {
    objectType: query.objectType ?? query.object_type ?? null,
    objectId: query.objectId ?? query.object_id ?? null,
    schemeId: intOr(query.schemeId ?? query.scheme_id, null),
    schemeCode: query.schemeCode ?? query.scheme_code ?? null,
    status: query.status ?? null,
    organizationId: intOr(query.organizationId ?? query.organization_id, null),
    plantId: intOr(query.plantId ?? query.plant_id, null),
    classification: query.classification ?? null,
    q: query.q ?? query.search ?? null,
    from: query.from ?? query.dateFrom ?? null,
    to: query.to ?? query.dateTo ?? null,
    correlationId: query.correlationId ?? query.correlation_id ?? null,
    reusable: query.reusable === undefined ? null : bool(query.reusable),
    page: intOr(query.page, 1),
    pageSize: intOr(query.pageSize ?? query.page_size, 25),
  };
}

export function validateTokenCode(code) {
  if (!TOKEN_RE.test(String(code || ""))) {
    throw new HttpError(400, "Token code must be uppercase letters, digits or underscore");
  }
  return String(code);
}

export function vocabulary() {
  return {
    scheme_statuses: SCHEME_STATUSES,
    numbering_modes: NUMBERING_MODES,
    manual_policies: MANUAL_POLICIES,
    reuse_policies: REUSE_POLICIES,
    reset_policies: RESET_POLICIES,
    sequence_scopes: SEQUENCE_SCOPES,
    scope_types: SCOPE_TYPES,
    allocation_statuses: ALLOCATION_STATUSES,
    object_type_statuses: OBJECT_TYPE_STATUSES,
    error_codes: NUMBERING_ERROR_CODES,
  };
}

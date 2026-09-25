// Input normalization and validation for the Digital Thread domain.
//
// The API layer passes raw bodies straight to services; services normalize and
// assert here so every write shares one vocabulary and one set of limits.
import { HttpError } from "../../validation.js";
import { invalidDefinition, invalidQuery } from "./errors.js";
import {
  CONFIG_BOUNDS,
  CONFIG_DEFAULTS,
  DIRECTIONS,
  LINK_DIRECTIONS,
  MAX_DEPTH,
  MAX_NODES,
  MAX_PAGE_SIZE,
  MAX_PATH_DEPTH,
  MAX_PATHS,
  THREAD_STATUSES,
  THREAD_TYPES,
} from "./constants.js";

const IDENTIFIER_RE = /^[a-z][a-z0-9._-]{1,63}$/;

export function normalizeText(value, { max = 1000, fallback = "" } = {}) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  return text.slice(0, max);
}

export function normalizeUpper(value, { max = 100, fallback = "" } = {}) {
  const text = normalizeText(value, { max, fallback });
  return text ? text.toUpperCase() : fallback;
}

export function normalizeList(value, fallback = []) {
  if (value === undefined || value === null) return fallback;
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
}

export function normalizeBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function isValidCode(code) {
  return IDENTIFIER_RE.test(String(code || ""));
}

export function assertCode(code, label = "code") {
  if (!isValidCode(code)) {
    throw invalidDefinition(`${label} must be lowercase, start with a letter and be 2-64 characters (letters, digits, . _ -)`);
  }
  return code;
}

export function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new HttpError(400, `${label} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

export function assertInteger(value, { min = null, max = null, label = "value", fallback = null } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    throw new HttpError(400, `${label} must be an integer`);
  }
  if (min !== null && number < min) throw new HttpError(400, `${label} must be >= ${min}`);
  if (max !== null && number > max) throw new HttpError(400, `${label} must be <= ${max}`);
  return number;
}

export function clampDepth(value, fallback = 25, max = MAX_DEPTH) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(number)));
}

export function clampLimit(value, fallback = 50, max = MAX_PAGE_SIZE) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(number)));
}

export function paginate(query = {}, { defaultPageSize = 50, maxPageSize = MAX_PAGE_SIZE } = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = clampLimit(query.pageSize ?? query.page_size, defaultPageSize, maxPageSize);
  return { page, limit, offset: (page - 1) * limit };
}

export function normalizeDirection(value, fallback = "DOWNSTREAM") {
  const direction = normalizeUpper(value, { max: 20, fallback });
  return DIRECTIONS.includes(direction) ? direction : fallback;
}

export function normalizeLinkDirection(value, fallback = "OUT") {
  const direction = normalizeUpper(value, { max: 20, fallback });
  return LINK_DIRECTIONS.includes(direction) ? direction : fallback;
}

export function normalizeThreadType(value, fallback = "PRODUCT_DEVELOPMENT") {
  const type = normalizeUpper(value, { max: 40, fallback });
  return THREAD_TYPES.includes(type) ? type : fallback;
}

export function normalizeStatus(value, fallback = "ACTIVE") {
  const status = normalizeUpper(value, { max: 20, fallback });
  return THREAD_STATUSES.includes(status) ? status : fallback;
}

// A node reference is the identity of one business object in the thread:
// { objectType, objectId } with an optional revision. Providers are chosen by
// object type, so the reference is provider-neutral.
export function normalizeNodeRef(input) {
  const objectType = normalizeText(input?.objectType ?? input?.object_type ?? input?.type, { max: 100 });
  const objectId = normalizeText(input?.objectId ?? input?.object_id ?? input?.id, { max: 200 });
  const revision = normalizeText(input?.revision ?? input?.revisionId ?? input?.revision_id, { max: 100 });
  if (!objectType || !objectId) throw invalidQuery("A node reference needs objectType and objectId");
  return { objectType, objectId, revision };
}

export function nodeRefKey(reference) {
  return `${reference.objectType}:${reference.objectId}${reference.revision ? `@${reference.revision}` : ""}`;
}

export function assertConfigurationValue(key, value) {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)) {
    throw new HttpError(400, `Unknown configuration key: ${key}`);
  }
  const fallback = CONFIG_DEFAULTS[key];
  if (typeof fallback === "boolean") {
    if (typeof value !== "boolean") throw new HttpError(400, `${key} must be a boolean`);
    return value;
  }
  if (key === "default_definition_code") {
    if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} must be a non-empty string`);
    return value.trim();
  }
  const bounds = CONFIG_BOUNDS[key] || {};
  const number = Number(value);
  if (!Number.isFinite(number)) throw new HttpError(400, `${key} must be numeric`);
  if (bounds.min !== undefined && number < bounds.min) throw new HttpError(400, `${key} must be >= ${bounds.min}`);
  if (bounds.max !== undefined && number > bounds.max) throw new HttpError(400, `${key} must be <= ${bounds.max}`);
  return number;
}

export function normalizeQueryContext(input = {}) {
  return {
    revision: normalizeText(input.revision ?? input.revisionRule ?? input.revision_rule, { max: 100 }),
    revisionRule: normalizeUpper(input.revisionRule ?? input.revision_rule, { max: 60 }),
    asOf: normalizeText(input.asOf ?? input.as_of ?? input.effectivityContext?.asOf, { max: 40 }),
    serialNumber: normalizeText(input.serialNumber ?? input.serial_number, { max: 100 }),
    unit: normalizeText(input.unit, { max: 100 }),
    variant: normalizeText(input.variant ?? input.variantCode ?? input.variant_code, { max: 100 }),
    configuration: normalizeText(input.configuration ?? input.configurationId ?? input.configuration_id, { max: 100 }),
    organizationId: input.organizationId ?? input.organization_id ?? null,
    site: normalizeText(input.site ?? input.plant, { max: 100 }),
  };
}

export function normalizePathOptions(input = {}) {
  return {
    maxDepth: clampDepth(input.maxDepth ?? input.max_depth, MAX_PATH_DEPTH, MAX_PATH_DEPTH),
    maxPaths: Math.min(MAX_PATHS, Math.max(1, Number(input.maxPaths ?? input.max_paths) || 50)),
    shortestOnly: normalizeBool(input.shortestOnly ?? input.shortest_only, false),
  };
}

export function assertNodeLimit(limit) {
  if (Number(limit) > MAX_NODES) throw invalidQuery(`Node limit cannot exceed ${MAX_NODES}`);
  return limit;
}

export { MAX_DEPTH, MAX_NODES, MAX_PATHS, MAX_PATH_DEPTH };

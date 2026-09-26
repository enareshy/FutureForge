// Normalization, assertion and vocabulary helpers for the Change Management
// domain. Pure helpers are reused from the Import & Export Framework so there
// is exactly one implementation of text/number/pagination normalization on
// the platform (mirrors server/services/pdm/validation.js).
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
  REQUEST_CATEGORIES,
  REQUEST_PRIORITIES,
  REQUEST_STATUSES,
  ORDER_STATUSES,
  EFFECTIVE_STRATEGIES,
  AFFECTED_ITEM_DISPOSITIONS,
  NOTICE_STATUSES,
  RELATIONSHIP_TYPES,
  DEFAULT_REQUEST_TRANSITIONS,
  DEFAULT_ORDER_TRANSITIONS,
  DEFAULT_NOTICE_TRANSITIONS,
  CONFIG_DEFAULTS,
  CONFIG_BOUNDS,
} from "./constants.js";
import {
  invalidRequest,
  invalidOrder,
  invalidNotice,
  invalidAffectedItem,
  invalidRelationship,
  invalidConfiguration,
  requestStatusInvalid,
  orderStatusInvalid,
  noticeStatusInvalid,
} from "./errors.js";

export { normalizeText, normalizeUpper, parseObject, toBool, toInt, paginate, requireCode, assertEnum, assertTenantId, HttpError };

export const assertRequestCategory = (value) => assertEnum(normalizeUpper(value), REQUEST_CATEGORIES, "Request category", invalidRequest);
export const assertRequestPriority = (value) => assertEnum(normalizeUpper(value), REQUEST_PRIORITIES, "Request priority", invalidRequest);
export const assertRequestStatus = (value) => assertEnum(normalizeUpper(value), REQUEST_STATUSES, "Request status", invalidRequest);
export const assertOrderStatus = (value) => assertEnum(normalizeUpper(value), ORDER_STATUSES, "Order status", invalidOrder);
export const assertEffectiveStrategy = (value) => assertEnum(normalizeUpper(value), EFFECTIVE_STRATEGIES, "Effective strategy", invalidOrder);
export const assertDisposition = (value) => assertEnum(normalizeUpper(value), AFFECTED_ITEM_DISPOSITIONS, "Disposition", invalidAffectedItem);
export const assertNoticeStatus = (value) => assertEnum(normalizeUpper(value), NOTICE_STATUSES, "Notice status", invalidNotice);
export const assertRelationshipType = (value) => assertEnum(normalizeUpper(value), RELATIONSHIP_TYPES, "Relationship type", invalidRelationship);

// ── State transitions (centralized, data-driven) ─────────────────────────────

export function assertRequestTransition(from, to) {
  const target = normalizeUpper(to);
  const allowed = DEFAULT_REQUEST_TRANSITIONS[normalizeUpper(from)] || [];
  if (!allowed.includes(target)) throw requestStatusInvalid(target, normalizeUpper(from), allowed);
  return target;
}

export function assertOrderTransition(from, to) {
  const target = normalizeUpper(to);
  const allowed = DEFAULT_ORDER_TRANSITIONS[normalizeUpper(from)] || [];
  if (!allowed.includes(target)) throw orderStatusInvalid(target, normalizeUpper(from), allowed);
  return target;
}

export function assertNoticeTransition(from, to) {
  const target = normalizeUpper(to);
  const allowed = DEFAULT_NOTICE_TRANSITIONS[normalizeUpper(from)] || [];
  if (!allowed.includes(target)) throw noticeStatusInvalid(target, normalizeUpper(from), allowed);
  return target;
}

// ── DTO normalization ────────────────────────────────────────────────────────

function optionalInt(value, name, errorFactory) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw errorFactory(`${name} must be an integer`);
  return n;
}

export function normalizeRequestInput(body = {}, current = {}) {
  return {
    title: normalizeText(body.title ?? current.title ?? "", { max: 300 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 4000 }),
    category: assertRequestCategory(body.category ?? current.category ?? "OTHER"),
    priority: assertRequestPriority(body.priority ?? current.priority ?? "NORMAL"),
    reason: normalizeText(body.reason ?? current.reason ?? "", { max: 4000 }),
    organization_id:
      body.organization_id === undefined && body.organizationId === undefined
        ? current.organization_id ?? null
        : optionalInt(body.organization_id ?? body.organizationId, "organization_id", invalidRequest),
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
  };
}

export function normalizeOrderInput(body = {}, current = {}) {
  return {
    title: normalizeText(body.title ?? current.title ?? "", { max: 300 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 4000 }),
    change_request_id:
      body.change_request_id === undefined && body.changeRequestId === undefined
        ? current.change_request_id ?? null
        : optionalInt(body.change_request_id ?? body.changeRequestId, "change_request_id", invalidOrder),
    effective_strategy: assertEffectiveStrategy(body.effective_strategy ?? body.effectiveStrategy ?? current.effective_strategy ?? "DATE"),
    effective_context: parseObject(body.effective_context ?? body.effectiveContext ?? current.effective_context_json, {}),
    organization_id:
      body.organization_id === undefined && body.organizationId === undefined
        ? current.organization_id ?? null
        : optionalInt(body.organization_id ?? body.organizationId, "organization_id", invalidOrder),
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
  };
}

export function normalizeNoticeInput(body = {}, current = {}) {
  const changeOrderId = body.change_order_id ?? body.changeOrderId ?? current.change_order_id;
  if (!changeOrderId) throw invalidNotice("change_order_id is required");
  return {
    title: normalizeText(body.title ?? current.title ?? "", { max: 300 }),
    description: normalizeText(body.description ?? current.description ?? "", { max: 4000 }),
    change_order_id: Number(changeOrderId),
    distribution: Array.isArray(body.distribution ?? current.distribution_json)
      ? body.distribution ?? parseObject(current.distribution_json, [])
      : [],
    organization_id:
      body.organization_id === undefined && body.organizationId === undefined
        ? current.organization_id ?? null
        : optionalInt(body.organization_id ?? body.organizationId, "organization_id", invalidNotice),
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
  };
}

export function normalizeAffectedItemInput(body = {}) {
  const objectType = body.object_type ?? body.objectType;
  const objectId = body.object_id ?? body.objectId;
  if (!objectType) throw invalidAffectedItem("object_type is required");
  if (objectId === undefined || objectId === null || String(objectId).trim() === "") throw invalidAffectedItem("object_id is required");
  return {
    object_type: normalizeText(objectType, { max: 120 }),
    object_id: normalizeText(objectId, { max: 300 }),
    object_label: normalizeText(body.object_label ?? body.objectLabel ?? "", { max: 300 }),
    disposition: assertDisposition(body.disposition ?? "NEW_REVISION"),
    notes: normalizeText(body.notes ?? "", { max: 2000 }),
    metadata: parseObject(body.metadata ?? {}, {}),
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
    source_type: normalizeText(body.source_type ?? body.sourceType ?? "change_order", { max: 60 }),
    source_id: normalizeText(sourceId, { max: 300 }),
    target_type: normalizeText(body.target_type ?? body.targetType ?? "change_order", { max: 60 }),
    target_id: normalizeText(targetId, { max: 300 }),
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
    request_categories: REQUEST_CATEGORIES,
    request_priorities: REQUEST_PRIORITIES,
    request_statuses: REQUEST_STATUSES,
    order_statuses: ORDER_STATUSES,
    effective_strategies: EFFECTIVE_STRATEGIES,
    affected_item_dispositions: AFFECTED_ITEM_DISPOSITIONS,
    notice_statuses: NOTICE_STATUSES,
    relationship_types: RELATIONSHIP_TYPES,
    request_transitions: DEFAULT_REQUEST_TRANSITIONS,
    order_transitions: DEFAULT_ORDER_TRANSITIONS,
    notice_transitions: DEFAULT_NOTICE_TRANSITIONS,
  };
}

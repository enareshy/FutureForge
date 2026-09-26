import { HttpError } from "../../validation.js";

// Canonical audit action types. Individual modules keep emitting their own
// dotted action strings (for example `object.update`); the framework derives
// one of these high level types so events stay filterable and comparable
// across modules.
export const AUDIT_ACTIONS = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "RESTORE",
  "ARCHIVE",
  "VIEW",
  "READ",
  "DOWNLOAD",
  "UPLOAD",
  "CHECK_IN",
  "CHECK_OUT",
  "LOCK",
  "UNLOCK",
  "STATE_CHANGE",
  "LIFECYCLE_TRANSITION",
  "WORKFLOW_ACTION",
  "WORKFLOW_STARTED",
  "WORKFLOW_COMPLETED",
  "WORKFLOW_REJECTED",
  "WORKFLOW_CANCELLED",
  "TASK_ASSIGNED",
  "TASK_COMPLETED",
  "APPROVED",
  "REJECTED",
  "RELATIONSHIP_CHANGE",
  "RELATIONSHIP_CREATED",
  "RELATIONSHIP_REMOVED",
  "PERMISSION_CHANGE",
  "ROLE_CHANGED",
  "ASSIGN",
  "LOGIN",
  "LOGIN_FAILED",
  "LOGOUT",
  "PASSWORD_CHANGED",
  "MFA_CHANGED",
  "EXPORT",
  "IMPORT",
  "CONFIGURATION_CHANGED",
  "INTEGRATION_EXECUTED",
  "JOB_STARTED",
  "JOB_COMPLETED",
  "JOB_FAILED",
  "VERSION_CREATED",
  "ADMIN_ACTION",
  "ACCESS_DENIED",
  "ACCESS",
];

// Who or what produced the event. USER is reserved for human actors; the
// remaining values distinguish non-human automation from people.
export const AUDIT_ACTOR_TYPES = ["user", "system", "integration", "job", "workflow", "service_account"];

// Cross-cutting business categories. Every event resolves to exactly one,
// which powers compliance filtering and category-based retention.
export const AUDIT_CATEGORIES = [
  "object_data",
  "attribute_change",
  "relationship",
  "lifecycle",
  "workflow",
  "approval",
  "document",
  "security",
  "authentication",
  "authorization",
  "configuration",
  "integration",
  "background_job",
  "administration",
  "compliance",
];

// Security classification of the recorded event, used to restrict visibility
// and to satisfy audit/compliance separation requirements.
export const AUDIT_SECURITY_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"];

// Retention category lets compliance teams apply different retention windows
// (for example 7 years for financial, 90 days for operational telemetry).
export const AUDIT_RETENTION_CATEGORIES = ["standard", "short", "extended", "permanent"];

export const AUDIT_SOURCES = ["ui", "api", "workflow", "integration", "scheduler", "system", "import", "seed"];

export const AUDIT_STATUSES = ["success", "failure", "denied"];

export const AUDIT_VISIBILITIES = ["user", "manager", "admin"];

export const AUDIT_VALUE_TYPES = ["string", "number", "boolean", "date", "datetime", "json", "null"];

export const AUDIT_EXPORT_FORMATS = ["csv", "json", "excel"];

export const AUDIT_EXPORT_STATUSES = ["pending", "processing", "completed", "failed", "expired"];

export const AUDIT_FILTER_SCOPES = ["events", "security", "workflow", "lifecycle", "configuration", "object"];

const ACTION_SET = new Set(AUDIT_ACTIONS);
const SOURCE_SET = new Set(AUDIT_SOURCES);
const STATUS_SET = new Set(AUDIT_STATUSES);
const VISIBILITY_SET = new Set(AUDIT_VISIBILITIES);
const ACTOR_TYPE_SET = new Set(AUDIT_ACTOR_TYPES);
const CATEGORY_SET = new Set(AUDIT_CATEGORIES);
const CLASSIFICATION_SET = new Set(AUDIT_SECURITY_CLASSIFICATIONS);
const RETENTION_CATEGORY_SET = new Set(AUDIT_RETENTION_CATEGORIES);
const EXPORT_FORMAT_SET = new Set(AUDIT_EXPORT_FORMATS);

// Actions that must always be captured, even when a tenant administrator has
// disabled success/failure recording or narrowed the action allow-list. These
// cover the security, authentication and configuration control plane that
// compliance frameworks require to be tamper-evident.
export const MANDATORY_ACTIONS = new Set([
  "LOGIN",
  "LOGIN_FAILED",
  "LOGOUT",
  "PASSWORD_CHANGED",
  "MFA_CHANGED",
  "PERMISSION_CHANGE",
  "ROLE_CHANGED",
  "ACCESS_DENIED",
  "CONFIGURATION_CHANGED",
  "ADMIN_ACTION",
  "EXPORT",
]);

// Categories whose events are mandatory regardless of the governing policy.
export const MANDATORY_CATEGORIES = new Set([
  "security",
  "authentication",
  "authorization",
  "configuration",
  "administration",
  "compliance",
]);

// Maps a canonical action to its business category.
const ACTION_CATEGORY = {
  CREATE: "object_data",
  UPDATE: "attribute_change",
  DELETE: "object_data",
  RESTORE: "object_data",
  ARCHIVE: "object_data",
  VIEW: "object_data",
  READ: "object_data",
  DOWNLOAD: "document",
  UPLOAD: "document",
  CHECK_IN: "lifecycle",
  CHECK_OUT: "lifecycle",
  LOCK: "lifecycle",
  UNLOCK: "lifecycle",
  STATE_CHANGE: "lifecycle",
  LIFECYCLE_TRANSITION: "lifecycle",
  WORKFLOW_ACTION: "workflow",
  WORKFLOW_STARTED: "workflow",
  WORKFLOW_COMPLETED: "workflow",
  WORKFLOW_REJECTED: "workflow",
  WORKFLOW_CANCELLED: "workflow",
  TASK_ASSIGNED: "workflow",
  TASK_COMPLETED: "workflow",
  APPROVED: "approval",
  REJECTED: "approval",
  RELATIONSHIP_CHANGE: "relationship",
  RELATIONSHIP_CREATED: "relationship",
  RELATIONSHIP_REMOVED: "relationship",
  PERMISSION_CHANGE: "authorization",
  ROLE_CHANGED: "authorization",
  ASSIGN: "authorization",
  LOGIN: "authentication",
  LOGIN_FAILED: "authentication",
  LOGOUT: "authentication",
  PASSWORD_CHANGED: "security",
  MFA_CHANGED: "security",
  EXPORT: "compliance",
  IMPORT: "compliance",
  CONFIGURATION_CHANGED: "configuration",
  INTEGRATION_EXECUTED: "integration",
  JOB_STARTED: "background_job",
  JOB_COMPLETED: "background_job",
  JOB_FAILED: "background_job",
  VERSION_CREATED: "object_data",
  ADMIN_ACTION: "administration",
  ACCESS_DENIED: "security",
  ACCESS: "security",
};

export function categoryOfAction(action, eventType) {
  const type = ACTION_SET.has(String(eventType || "").toUpperCase())
    ? String(eventType).toUpperCase()
    : eventTypeOf(action);
  return ACTION_CATEGORY[type] || "administration";
}

export function isMandatoryEvent(action, category) {
  const type = eventTypeOf(action);
  if (MANDATORY_ACTIONS.has(type)) return true;
  if (category && MANDATORY_CATEGORIES.has(String(category).toLowerCase())) return true;
  return false;
}

export function normalizeActorType(value) {
  const actorType = String(value || "user").toLowerCase();
  return ACTOR_TYPE_SET.has(actorType) ? actorType : "user";
}

export function normalizeCategory(value, fallback = "administration") {
  const category = String(value || fallback).toLowerCase();
  return CATEGORY_SET.has(category) ? category : fallback;
}

export function normalizeClassification(value) {
  const classification = String(value || "internal").toLowerCase();
  return CLASSIFICATION_SET.has(classification) ? classification : "internal";
}

export function normalizeRetentionCategory(value) {
  const category = String(value || "standard").toLowerCase();
  return RETENTION_CATEGORY_SET.has(category) ? category : "standard";
}

export function normalizeExportFormat(value) {
  const format = String(value || "csv").toLowerCase();
  if (!EXPORT_FORMAT_SET.has(format)) {
    throw new HttpError(400, `format must be one of ${AUDIT_EXPORT_FORMATS.join(", ")}`);
  }
  return format;
}

export function assertExportStatus(value) {
  const status = String(value || "").toLowerCase();
  if (!AUDIT_EXPORT_STATUSES.includes(status)) {
    throw new HttpError(400, `status must be one of ${AUDIT_EXPORT_STATUSES.join(", ")}`);
  }
  return status;
}


// Attribute names that must never be stored in clear text, regardless of the
// audit policy. Matching is case-insensitive and substring based.
const SENSITIVE_KEY_RE = new RegExp(
  [
    "pass",
    "secret",
    "token",
    "api[-_.]?key",
    "credential",
    "private[-_.]?key",
    "client[-_.]?secret",
    "authorization",
    "cookie",
    "otp",
    "mfa",
    "recovery",
    "secret",
    "hash",
    "salt",
    "cvv",
    "ssn",
    "credit",
    "card[-_.]?number",
  ].join("|"),
  "i"
);

const MASK = "***";

export function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(String(key || ""));
}

export function maskValue() {
  return MASK;
}

// Encrypts the action detail into a canonical event type. The raw action is
// always preserved; this only powers the cross-module `event_type` filter.
export function eventTypeOf(action) {
  const a = String(action || "").toLowerCase();
  if (!a) return "ADMIN_ACTION";
  if (a.includes("login_failed") || a.includes("login.failed") || a.includes("signin_failed")) return "LOGIN_FAILED";
  if (a.includes("checkout") || a.includes("check_out")) return "CHECK_OUT";
  if (a.includes("checkin") || a.includes("check_in")) return "CHECK_IN";
  if (a.includes("logout")) return "LOGOUT";
  if (a.includes("password") && (a.includes("change") || a.includes("reset") || a.includes("update"))) return "PASSWORD_CHANGED";
  if (a.includes("mfa") || a.includes("two_factor") || a.includes("2fa") || a.includes("otp")) return "MFA_CHANGED";
  if (a.includes("login") || a.includes("session.create") || a.includes("signin")) return "LOGIN";
  if (a.includes("upload") || a.includes("attach") || a.includes("file.create")) return "UPLOAD";
  if (a.includes("download") || a.includes("attachment.get")) return "DOWNLOAD";
  if (a.includes("export")) return "EXPORT";
  if (a.includes("import")) return "IMPORT";
  if (a.includes("deny") || a.includes("denied") || a.includes("forbidden") || a.includes("unauthor")) return "ACCESS_DENIED";
  if (a.includes("role") && (a.includes("change") || a.includes("assign") || a.includes("update"))) return "ROLE_CHANGED";
  if (a.includes("permission") || a.includes("grant") || a.includes("authz")) return "PERMISSION_CHANGE";
  if (a.includes("configuration") || a.includes("config")) return "CONFIGURATION_CHANGED";
  if (a.includes("integration") && (a.includes("execut") || a.includes("run") || a.includes("sync"))) return "INTEGRATION_EXECUTED";
  if (a.includes("job") && (a.includes("start") || a.includes("submit") || a.includes("run"))) return "JOB_STARTED";
  if (a.includes("job") && (a.includes("fail") || a.includes("error") || a.includes("dead"))) return "JOB_FAILED";
  if (a.includes("job") && (a.includes("complet") || a.includes("success") || a.includes("finish"))) return "JOB_COMPLETED";
  if (a.includes("workflow") && (a.includes("start") || a.includes("begin"))) return "WORKFLOW_STARTED";
  if (a.includes("workflow") && (a.includes("cancel"))) return "WORKFLOW_CANCELLED";
  if (a.includes("workflow") && (a.includes("reject"))) return "WORKFLOW_REJECTED";
  if (a.includes("workflow") && (a.includes("complet") || a.includes("approve") || a.includes("finish"))) return "WORKFLOW_COMPLETED";
  if (a.includes("task") && (a.includes("assign"))) return "TASK_ASSIGNED";
  if (a.includes("task") && (a.includes("complet"))) return "TASK_COMPLETED";
  if (a.includes("approv")) return "APPROVED";
  if (a.includes("reject")) return "REJECTED";
  if (a.includes("relationship") || a.includes("reference") || a.includes("dependency")) {
    if (a.includes("remov") || a.includes("delete") || a.includes("delet")) return "RELATIONSHIP_REMOVED";
    if (a.includes("creat") || a.includes("add") || a.includes("link")) return "RELATIONSHIP_CREATED";
    return "RELATIONSHIP_CHANGE";
  }
  if (a.includes("workflow")) return "WORKFLOW_ACTION";
  if (a.includes("lock") && !a.includes("unlock")) return "LOCK";
  if (a.includes("unlock")) return "UNLOCK";
  if (a.includes("version") && (a.includes("creat") || a.includes("new"))) return "VERSION_CREATED";
  if (a.includes("transition") || a.includes("release") || a.includes("status") || a.includes("state") || a.includes("lifecycle")) {
    return "LIFECYCLE_TRANSITION";
  }
  if (a.includes("assign") || a.includes("delegate") || a.includes("owner")) return "ASSIGN";
  if (a.includes("restore")) return "RESTORE";
  if (a.includes("archive")) return "ARCHIVE";
  if (a.includes("create") || a.includes(".add") || a.includes("enroll")) return "CREATE";
  if (a.includes("delete") || a.includes("remove") || a.includes("revoke") || a.includes("unassign")) {
    return "DELETE";
  }
  if (a.includes("update") || a.includes("set") || a.includes("move") || a.includes("edit") || a.includes("change")) return "UPDATE";
  if (a.includes("view") || a.includes("read") || a.includes("open") || a.includes("list")) return "VIEW";
  return "ADMIN_ACTION";
}

export function normalizeAction(action) {
  const raw = String(action || "").trim();
  if (!raw) throw new HttpError(400, "Audit action is required");
  if (raw.length > 128) throw new HttpError(400, "Audit action is too long");
  return raw;
}

export function assertCanonicalAction(action) {
  if (!ACTION_SET.has(action)) {
    throw new HttpError(400, `Invalid audit action: ${action}`);
  }
  return action;
}

export function normalizeEventType(value, action) {
  if (value) {
    const upper = String(value).toUpperCase();
    if (ACTION_SET.has(upper)) return upper;
  }
  return eventTypeOf(action);
}

export function normalizeSource(source) {
  const value = String(source || "api").toLowerCase();
  return SOURCE_SET.has(value) ? value : "api";
}

export function normalizeStatus(status) {
  const value = String(status || "success").toLowerCase();
  if (STATUS_SET.has(value)) return value;
  return value === "error" || value === "failed" ? "failure" : "success";
}

export function normalizeVisibility(value) {
  const v = String(value || "admin").toLowerCase();
  if (!VISIBILITY_SET.has(v)) {
    throw new HttpError(400, "Visibility must be user, manager or admin");
  }
  return v;
}

export function normalizeNameList(value, label = "attributes") {
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const items = [];
  const seen = new Set();
  for (const entry of raw) {
    const name = String(entry).trim();
    if (!name) continue;
    if (name.length > 128) throw new HttpError(400, `Invalid ${label} entry`);
    if (seen.has(name)) continue;
    seen.add(name);
    items.push(name);
  }
  return items;
}

export function valueTypeOf(value) {
  if (value === null || value === undefined) return "null";
  const type = typeof value;
  if (type === "number") return Number.isInteger(value) ? "number" : "number";
  if (type === "boolean") return "boolean";
  if (Array.isArray(value) || type === "object") return "json";
  return "string";
}

function normalizeRetentionDays(value) {
  if (value === undefined || value === null || value === "") return 2555;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 36500) {
    throw new HttpError(400, "Retention days must be an integer between 1 and 36500");
  }
  return days;
}

function normalizeBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return fallback;
}

// Validates and normalizes an audit policy payload. In partial mode only the
// provided fields are returned so PUT updates can merge safely.
export function validatePolicyInput(body = {}, { partial = false } = {}) {
  const input = {};
  const has = (key) => body[key] !== undefined;

  if (!partial || has("name")) {
    const name = String(body.name || "").trim();
    if (!name || name.length > 160) {
      if (!partial) throw new HttpError(400, "Policy name is required");
      input.name = name;
    } else {
      input.name = name;
    }
  }

  if (!partial || has("object_type") || has("objectType")) {
    const objectType = String(body.object_type ?? body.objectType ?? "*").trim();
    if (objectType.length > 128) throw new HttpError(400, "object_type is too long");
    input.object_type = objectType || "*";
  }

  if (!partial || has("description")) input.description = String(body.description || "");
  if (!partial || has("status")) {
    const status = String(body.status || "active");
    if (!["active", "inactive"].includes(status)) {
      throw new HttpError(400, "Policy status must be active or inactive");
    }
    input.status = status;
  }
  if (!partial || has("visibility")) input.visibility = normalizeVisibility(body.visibility);
  if (!partial || has("retention_days") || has("retentionDays")) {
    input.retention_days = normalizeRetentionDays(body.retention_days ?? body.retentionDays);
  }
  if (!partial || has("record_success")) input.record_success = normalizeBool(body.record_success, true);
  if (!partial || has("record_failure")) input.record_failure = normalizeBool(body.record_failure, true);
  if (!partial || has("capture_reads")) input.capture_reads = normalizeBool(body.capture_reads, false);
  if (!partial || has("capture_views")) input.capture_views = normalizeBool(body.capture_views, false);
  if (!partial || has("capture_downloads")) input.capture_downloads = normalizeBool(body.capture_downloads, true);

  if (!partial || has("actions")) {
    const actions = normalizeNameList(body.actions, "actions").map((a) =>
      ACTION_SET.has(String(a).toUpperCase()) ? String(a).toUpperCase() : a
    );
    input.actions = actions;
  }
  if (!partial || has("categories")) {
    input.categories = normalizeNameList(body.categories, "categories")
      .map((category) => String(category).toLowerCase())
      .filter((category) => CATEGORY_SET.has(category));
  }
  if (!partial || has("export_allowed") || has("exportAllowed")) {
    input.export_allowed = normalizeBool(body.export_allowed ?? body.exportAllowed, true);
  }
  if (!partial || has("track_attributes")) {
    input.track_attributes = normalizeNameList(body.track_attributes, "attributes");
  }
  if (!partial || has("masked_attributes")) {
    input.masked_attributes = normalizeNameList(body.masked_attributes, "attributes");
  }
  if (!partial || has("ignored_attributes")) {
    input.ignored_attributes = normalizeNameList(body.ignored_attributes, "attributes");
  }
  return input;
}

const CODE_RE = /^[a-z][a-z0-9_.-]{1,127}$/;

function normalizeCategoryScope(value, fallback = "*") {
  const category = String(value ?? fallback).trim().toLowerCase();
  if (category === "*" || category === "") return "*";
  if (!CATEGORY_SET.has(category)) {
    throw new HttpError(400, `category must be '*' or one of ${AUDIT_CATEGORIES.join(", ")}`);
  }
  return category;
}

// Validates and normalizes a dedicated retention policy payload.
export function validateRetentionPolicyInput(body = {}, { partial = false } = {}) {
  const input = {};
  const has = (key) => body[key] !== undefined;

  if (!partial || has("name")) {
    const name = String(body.name || "").trim();
    if (!name) {
      if (!partial) input.name = "Retention policy";
      else input.name = name;
    } else {
      input.name = name.slice(0, 160);
    }
  }
  if (!partial || has("description")) input.description = String(body.description || "");
  if (!partial || has("category")) input.category = normalizeCategoryScope(body.category, "*");
  if (!partial || has("object_type") || has("objectType")) {
    const objectType = String(body.object_type ?? body.objectType ?? "*").trim();
    if (objectType.length > 128) throw new HttpError(400, "object_type is too long");
    input.object_type = objectType || "*";
  }
  if (!partial || has("retention_days") || has("retentionDays")) {
    input.retention_days = normalizeRetentionDays(body.retention_days ?? body.retentionDays);
  }
  if (!partial || has("action")) {
    const action = String(body.action || "archive").toLowerCase();
    if (!["archive", "purge"].includes(action)) {
      throw new HttpError(400, "Retention action must be archive or purge");
    }
    input.action = action;
  }
  if (!partial || has("legal_hold") || has("legalHold")) {
    input.legal_hold = normalizeBool(body.legal_hold ?? body.legalHold, false);
  }
  if (!partial || has("status")) {
    const status = String(body.status || "active").toLowerCase();
    if (!["active", "inactive"].includes(status)) {
      throw new HttpError(400, "Retention policy status must be active or inactive");
    }
    input.status = status;
  }
  if (!partial || has("priority")) {
    const priority = Number(body.priority ?? 100);
    if (!Number.isFinite(priority) || priority < 0 || priority > 1000) {
      throw new HttpError(400, "priority must be between 0 and 1000");
    }
    input.priority = Math.trunc(priority);
  }
  return input;
}

// Validates and normalizes an audit action type registration.
export function validateActionTypeInput(body = {}, { partial = false } = {}) {
  const input = {};
  const has = (key) => body[key] !== undefined;

  if (!partial || has("code")) {
    const code = String(body.code || "").trim().toLowerCase();
    if (!CODE_RE.test(code)) {
      throw new HttpError(400, "code must match ^[a-z][a-z0-9_.-]{1,127}$");
    }
    input.code = code;
  }
  if (!partial || has("label")) input.label = String(body.label || "").slice(0, 160);
  if (!partial || has("category")) input.category = normalizeCategory(body.category);
  if (!partial || has("event_type") || has("eventType")) {
    const eventType = String(body.event_type ?? body.eventType ?? "").toUpperCase();
    if (eventType && !ACTION_SET.has(eventType)) {
      throw new HttpError(400, `event_type must be one of ${AUDIT_ACTIONS.join(", ")}`);
    }
    input.event_type = eventType || eventTypeOf(input.code);
  }
  if (!partial || has("description")) input.description = String(body.description || "");
  if (!partial || has("mandatory")) input.mandatory = normalizeBool(body.mandatory, false);
  if (!partial || has("active")) input.active = normalizeBool(body.active, true);
  return input;
}

function normalizeFilters(value) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "filters must be an object");
  }
  return value;
}

// Validates an asynchronous export request.
export function validateExportRequestInput(body = {}) {
  const filters = normalizeFilters(body.filters);
  const format = normalizeExportFormat(body.format);
  const columns = normalizeNameList(body.columns, "columns");
  const name = String(body.name || "").trim().slice(0, 255);
  const reason = body.reason ? String(body.reason).slice(0, 1000) : null;
  return { name, format, filters, columns, reason };
}

// Validates a reusable saved filter definition.
export function validateSavedFilterInput(body = {}, { partial = false } = {}) {
  const input = {};
  const has = (key) => body[key] !== undefined;

  if (!partial || has("name")) {
    const name = String(body.name || "").trim();
    if (!name) throw new HttpError(400, "Filter name is required");
    input.name = name.slice(0, 160);
  }
  if (!partial || has("description")) input.description = String(body.description || "");
  if (!partial || has("scope")) {
    const scope = String(body.scope || "events").toLowerCase();
    if (!AUDIT_FILTER_SCOPES.includes(scope)) {
      throw new HttpError(400, `scope must be one of ${AUDIT_FILTER_SCOPES.join(", ")}`);
    }
    input.scope = scope;
  }
  if (!partial || has("filters")) input.filters = normalizeFilters(body.filters);
  if (!partial || has("shared")) input.shared = normalizeBool(body.shared, false);
  return input;
}

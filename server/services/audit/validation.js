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
  "VIEW",
  "DOWNLOAD",
  "CHECK_IN",
  "CHECK_OUT",
  "STATE_CHANGE",
  "WORKFLOW_ACTION",
  "RELATIONSHIP_CHANGE",
  "PERMISSION_CHANGE",
  "ASSIGN",
  "LOGIN",
  "LOGOUT",
  "EXPORT",
  "IMPORT",
  "ADMIN_ACTION",
  "ACCESS_DENIED",
  "ACCESS",
];

export const AUDIT_SOURCES = ["ui", "api", "workflow", "integration", "scheduler", "system", "import", "seed"];

export const AUDIT_STATUSES = ["success", "failure", "denied"];

export const AUDIT_VISIBILITIES = ["user", "manager", "admin"];

export const AUDIT_VALUE_TYPES = ["string", "number", "boolean", "date", "datetime", "json", "null"];

const ACTION_SET = new Set(AUDIT_ACTIONS);
const SOURCE_SET = new Set(AUDIT_SOURCES);
const STATUS_SET = new Set(AUDIT_STATUSES);
const VISIBILITY_SET = new Set(AUDIT_VISIBILITIES);

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
  if (a.includes("checkout") || a.includes("check_out")) return "CHECK_OUT";
  if (a.includes("checkin") || a.includes("check_in")) return "CHECK_IN";
  if (a.includes("logout")) return "LOGOUT";
  if (a.includes("login") || a.includes("session.create") || a.includes("signin")) return "LOGIN";
  if (a.includes("download") || a.includes("attachment")) return "DOWNLOAD";
  if (a.includes("export")) return "EXPORT";
  if (a.includes("import")) return "IMPORT";
  if (a.includes("deny") || a.includes("denied") || a.includes("forbidden") || a.includes("unauthor")) return "ACCESS_DENIED";
  if (a.includes("permission") || a.includes("role") || a.includes("grant") || a.includes("authz")) {
    return "PERMISSION_CHANGE";
  }
  if (a.includes("relationship") || a.includes("reference") || a.includes("dependency")) {
    return "RELATIONSHIP_CHANGE";
  }
  if (a.includes("workflow") || a.includes("task") || a.includes("approval")) return "WORKFLOW_ACTION";
  if (a.includes("transition") || a.includes("release") || a.includes("status") || a.includes("state")) {
    return "STATE_CHANGE";
  }
  if (a.includes("assign") || a.includes("delegate") || a.includes("owner")) return "ASSIGN";
  if (a.includes("restore")) return "RESTORE";
  if (a.includes("create") || a.includes(".add") || a.includes("enroll")) return "CREATE";
  if (a.includes("delete") || a.includes("remove") || a.includes("revoke") || a.includes("unassign")) {
    return "DELETE";
  }
  if (a.includes("update") || a.includes("set") || a.includes("move") || a.includes("edit")) return "UPDATE";
  if (a.includes("view") || a.includes("read") || a.includes("open")) return "VIEW";
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

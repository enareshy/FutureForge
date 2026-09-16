import { HttpError } from "../../validation.js";

// Vocabulary and safe template utilities for the Notification & Communication
// Framework. Kept declarative so templates, rules, providers, APIs and the UI
// all agree on the same contract.

export const CHANNELS = ["in_app", "email", "sms", "teams", "slack", "push", "webhook"];
export const CHANNEL_LABELS = {
  in_app: "In-app",
  email: "Email",
  sms: "SMS",
  teams: "Microsoft Teams",
  slack: "Slack",
  push: "Mobile push",
  webhook: "Webhook",
};
export const NOTIFICATION_STATUSES = [
  "created",
  "queued",
  "processing",
  "sent",
  "delivered",
  "read",
  "failed",
  "cancelled",
  "retrying",
];
export const OPEN_STATUSES = ["created", "queued", "processing", "retrying"];
export const PRIORITIES = ["low", "normal", "high", "urgent"];
export const DELIVERY_MODES = ["immediate", "delayed", "digest"];
export const FREQUENCIES = ["immediate", "daily", "weekly", "off"];
export const PROVIDER_TYPES = ["store", "smtp", "sendgrid", "graph", "webhook"];
export const EVENT_STATUSES = ["received", "processed", "skipped", "failed"];
export const REMINDER_STATUSES = ["pending", "fired", "cancelled", "skipped"];

// Recipient selector types. Resolution is implemented in recipients.js.
export const RECIPIENT_TYPES = [
  "user",
  "role",
  "group",
  "organization",
  "business_unit",
  "plant",
  "site",
  "department",
  "object_owner",
  "object_creator",
  "workflow_assignee",
  "task_assignee",
  "manager",
  "supervisor",
  "initiator",
  "responsible_organization",
  "event_payload",
];

// Allowed top-level namespaces for {{ placeholders }}. Nested paths under an
// allowed root are permitted, but expressions, calls and unknown roots are
// rejected to prevent template injection or unsafe evaluation.
export const TEMPLATE_ROOTS = [
  "recipient",
  "initiator",
  "actor",
  "object",
  "workflow",
  "task",
  "approval",
  "event",
  "tenant",
  "organization",
  "dueDate",
  "due_date",
  "reason",
  "applicationUrl",
  "priority",
  "link",
  "status",
  "data",
  "payload",
  "context",
];

const CHANNEL_SET = new Set(CHANNELS);
const STATUS_SET = new Set(NOTIFICATION_STATUSES);
const PRIORITY_SET = new Set(PRIORITIES);
const DELIVERY_SET = new Set(DELIVERY_MODES);
const FREQUENCY_SET = new Set(FREQUENCIES);
const PROVIDER_TYPE_SET = new Set(PROVIDER_TYPES);
const RECIPIENT_SET = new Set(RECIPIENT_TYPES);

const PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\??\.[A-Za-z0-9_]+)*$/;

export function safeParse(raw, fallback = {}) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    const value = JSON.parse(raw);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function assertChannel(channel, label = "channel") {
  if (!CHANNEL_SET.has(channel)) {
    throw new HttpError(400, `${label} must be one of: ${CHANNELS.join(", ")}`);
  }
}

export function assertStatus(status, label = "status") {
  if (!STATUS_SET.has(status)) {
    throw new HttpError(400, `${label} must be one of: ${NOTIFICATION_STATUSES.join(", ")}`);
  }
}

export function assertPriority(priority) {
  if (!PRIORITY_SET.has(priority)) {
    throw new HttpError(400, `priority must be one of: ${PRIORITIES.join(", ")}`);
  }
}

export function assertDeliveryMode(mode) {
  if (!DELIVERY_SET.has(mode)) {
    throw new HttpError(400, `delivery_mode must be one of: ${DELIVERY_MODES.join(", ")}`);
  }
}

export function assertFrequency(frequency) {
  if (!FREQUENCY_SET.has(frequency)) {
    throw new HttpError(400, `frequency must be one of: ${FREQUENCIES.join(", ")}`);
  }
}

export function assertProviderType(type) {
  if (!PROVIDER_TYPE_SET.has(type)) {
    throw new HttpError(400, `provider type must be one of: ${PROVIDER_TYPES.join(", ")}`);
  }
}

export function normalizeChannels(input, fallback = ["in_app"]) {
  const list = Array.isArray(input) ? input : input ? [input] : fallback;
  const seen = [];
  for (const channel of list) {
    const value = String(channel);
    assertChannel(value);
    if (!seen.includes(value)) seen.push(value);
  }
  return seen.length ? seen : [...fallback];
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

export function extractVariables(...texts) {
  const found = new Set();
  for (const text of texts) {
    if (!text) continue;
    let match;
    const re = new RegExp(PLACEHOLDER_RE.source, "g");
    while ((match = re.exec(String(text))) !== null) {
      found.add(match[1].trim());
    }
  }
  return [...found];
}

// Validates every placeholder: dotted path only, and the root must be known.
export function validateTemplateVariables(...texts) {
  const variables = extractVariables(...texts);
  const invalid = [];
  for (const variable of variables) {
    const path = variable.replace(/^\?/, "");
    if (!PATH_RE.test(path.replace(/\?\./g, "."))) {
      invalid.push(variable);
      continue;
    }
    const root = path.split(".")[0];
    if (!TEMPLATE_ROOTS.includes(root)) invalid.push(variable);
  }
  if (invalid.length) {
    throw new HttpError(
      400,
      `Unknown or unsafe template variables: ${invalid.join(", ")}`,
      { allowed_roots: TEMPLATE_ROOTS }
    );
  }
  return variables;
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolvePath(context, path) {
  const clean = path.replace(/\?/g, "");
  const parts = clean.split(".");
  let current = context;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

export function resolvePathSafe(context, path) {
  try {
    return resolvePath(context, String(path));
  } catch {
    return undefined;
  }
}

// Substitutes {{ path }} placeholders. Unknown paths render as an empty string.
// HTML output is escaped to prevent injection; plain text is left untouched.
export function renderTemplate(text, context = {}, { html = false } = {}) {
  if (text === null || text === undefined) return "";
  return String(text).replace(PLACEHOLDER_RE, (_match, path) => {
    const value = resolvePath(context, path.trim());
    if (value === undefined || value === null) return "";
    const str = typeof value === "object" ? JSON.stringify(value) : String(value);
    return html ? escapeHtml(str) : str;
  });
}

// Defense-in-depth sanitizer for admin-authored HTML. Templates never execute
// scripts, but stripping active content keeps stored emails/inbox HTML inert.
export function sanitizeHtml(html) {
  if (!html) return "";
  let out = String(html);
  out = out.replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  out = out.replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)[^>]*>/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(/(href|src|xlink:href)\s*=\s*("|')?\s*javascript:[^"'>\s]*/gi, "$1=$2#");
  out = out.replace(/(href|src)\s*=\s*("|')?\s*data:text\/html[^"'>\s]*/gi, "$1=$2#");
  out = out.replace(/srcdoc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return out.trim();
}

export function templateHasScript(html) {
  return /<\s*(script|iframe|object|embed)[\s>]/i.test(String(html || ""));
}

export function assertTemplateInput({ subject, html_body, text_body } = {}) {
  if (subject && templateHasScript(subject)) throw new HttpError(400, "Subject must not contain active content");
  if (html_body && templateHasScript(html_body)) {
    // Allowed: we sanitize rather than reject, but reject explicit script tags to
    // make the intent clear to authors.
    throw new HttpError(400, "HTML body must not contain script/iframe/object tags");
  }
  validateTemplateVariables(subject || "", html_body || "", text_body || "");
}

// ---------------------------------------------------------------------------
// Rule condition evaluation
// ---------------------------------------------------------------------------

const OPS = {
  eq: (a, b) => String(a) === String(b),
  ne: (a, b) => String(a) !== String(b),
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  in: (a, b) => Array.isArray(b) && b.map(String).includes(String(a)),
  not_in: (a, b) => Array.isArray(b) && !b.map(String).includes(String(a)),
  contains: (a, b) => String(a ?? "").includes(String(b)),
  exists: (a) => a !== undefined && a !== null && a !== "",
  not_exists: (a) => a === undefined || a === null || a === "",
};

function evaluateLeaf(leaf, context) {
  if (!leaf || typeof leaf !== "object") return true;
  const field = leaf.field || leaf.attribute || leaf.name;
  if (!field) return true;
  const op = leaf.op || leaf.operator || "eq";
  const fn = OPS[op];
  if (!fn) return false;
  return Boolean(fn(resolvePath(context, field), leaf.value));
}

// Supports { all: [...] }, { any: [...] }, a bare array (implicit all) or a
// single { field, op, value } leaf. An empty condition always matches.
export function evaluateCondition(condition, context = {}) {
  if (!condition || typeof condition !== "object") return true;
  if (Array.isArray(condition)) return condition.every((leaf) => evaluateLeaf(leaf, context));
  if (Array.isArray(condition.all) && !condition.all.every((leaf) => evaluateCondition(leaf, context))) return false;
  if (Array.isArray(condition.any) && condition.any.length && !condition.any.some((leaf) => evaluateCondition(leaf, context))) {
    return false;
  }
  if (condition.not !== undefined) return !evaluateCondition(condition.not, context);
  const hasLeaves = condition.field || condition.attribute || condition.name;
  return hasLeaves ? evaluateLeaf(condition, context) : true;
}

// ---------------------------------------------------------------------------
// Recipient definition
// ---------------------------------------------------------------------------

// A recipient definition is { items: [{ type, id, ref, exclude_initiator }],
// include_initiator, fallback: [{...}] }. A bare string/array is also accepted.
// By default the initiating user is included unless exclude_initiator is set.
export function normalizeRecipientDefinition(input) {
  if (!input) return { items: [], include_initiator: true, exclude_initiator: false, fallback: [] };
  if (typeof input === "string") return { items: [normalizeRecipientItem(input)], include_initiator: true, exclude_initiator: false, fallback: [] };
  if (Array.isArray(input)) return { items: input.map(normalizeRecipientItem), include_initiator: true, exclude_initiator: false, fallback: [] };
  const items = Array.isArray(input.items) ? input.items.map(normalizeRecipientItem) : [];
  const fallback = Array.isArray(input.fallback) ? input.fallback.map(normalizeRecipientItem) : [];
  const excludeInitiator = input.exclude_initiator === true || input.include_initiator === false;
  return {
    items,
    include_initiator: !excludeInitiator,
    exclude_initiator: excludeInitiator,
    fallback,
  };
}

export function normalizeRecipientItem(item) {
  if (typeof item === "string") return { type: "user", ref: item };
  if (!item || typeof item !== "object") return { type: "user", ref: "" };
  const type = item.type || item.recipient_type || "user";
  if (type && !RECIPIENT_SET.has(type) && !["user", "role", "group"].includes(type)) {
    // Unknown types are tolerated at read time but never resolve.
  }
  return {
    type,
    id: item.id ?? item.recipient_id ?? null,
    ref: item.ref ?? item.recipient_ref ?? item.value ?? item.key ?? item.path ?? item.code ?? "",
    exclude_initiator: item.exclude_initiator,
    label: item.label || "",
  };
}

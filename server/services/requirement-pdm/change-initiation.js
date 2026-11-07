// Automatic change-request initiation (Prompt 4, sections 15-17).
//
// A requirement change that reaches released product data must be routed through
// the platform's existing Change Management, never through a parallel change
// object. This module therefore:
//   1. evaluates tenant-configured business rules (severity threshold and
//      released-impact requirement) against a requirement and its classified
//      PLM impact (see impact.js),
//   2. creates a real ECR with the Change Management service
//      (change/requests.js) when the rules pass,
//   3. records the requirement -> change edge with the existing relationship
//      framework (changes.js), and
//   4. exposes the resulting CR -> ECO -> ECN chain for traceability.
//
// Duplicate change requests from repeated events are prevented with a
// deterministic idempotency key persisted on the requirement/change link, so no
// RequirementChangeMapping table and no second change model is introduced.
import { queryAll } from "../../db.js";
import { queryAllAsync } from "../../db-async.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { Requirements } from "../requirements/index.js";
import { createRequest, createRequestAsync, getRequest, getRequestAsync } from "../change/requests.js";
import { publicOrder, publicNotice } from "../change/repository.js";
import {
  REQUIREMENT_SOURCE_TYPE,
  CHANGE_SEVERITIES,
  PRIORITY_TO_SEVERITY,
  CRITICALITY_TO_SEVERITY,
  REQUIREMENT_PDM_EVENT_MAP,
} from "./constants.js";
import { getConfig } from "./configuration.js";
import { publishRequirementPdmEvent, publishRequirementPdmEventAsync } from "./events.js";
import { analyzeRequirementImpact, analyzeRequirementImpactAsync } from "./impact.js";
import { linkChange, linkChangeAsync } from "./changes.js";
import { normalizeText, parseObject } from "./validation.js";

const SEVERITY_INDEX = Object.fromEntries(CHANGE_SEVERITIES.map((code, index) => [code, index]));
const CHANGE_REQUEST_TYPE = "change_request";

function upper(value) {
  return String(value || "").toUpperCase();
}

// Project the requirement's priority and criticality onto the single severity
// scale and take the higher of the two. An explicit override wins unchanged.
export function severityFor(requirement, override = null) {
  if (override) {
    const value = upper(override);
    if (SEVERITY_INDEX[value] !== undefined) return value;
  }
  const fromPriority = PRIORITY_TO_SEVERITY[upper(requirement?.priority)] || "LOW";
  const fromCriticality = CRITICALITY_TO_SEVERITY[upper(requirement?.criticality)] || "LOW";
  return SEVERITY_INDEX[fromPriority] >= SEVERITY_INDEX[fromCriticality] ? fromPriority : fromCriticality;
}

export function changeInitiationConfig(db, tenantId) {
  const tenant = Number(tenantId);
  const severities = String(getConfig(db, tenant, "auto_change_request_severities") || "")
    .split(",")
    .map((value) => upper(value).trim())
    .filter(Boolean);
  return {
    enabled: Boolean(getConfig(db, tenant, "auto_change_request")),
    severities,
    requireReleased: Boolean(getConfig(db, tenant, "auto_change_request_require_released")),
    category: upper(getConfig(db, tenant, "change_request_category") || "DESIGN"),
    priority: upper(getConfig(db, tenant, "change_request_priority") || "NORMAL"),
    autoLink: Boolean(getConfig(db, tenant, "change_link_auto")),
    workflow: String(getConfig(db, tenant, "change_initiation_workflow") || ""),
  };
}

function impactSummary(impact) {
  if (!impact) return null;
  return {
    impacted_count: impact.impacted_count ?? 0,
    released_count: impact.released_count ?? 0,
    released_impacted: Boolean(impact.released_impacted),
    category_totals: impact.category_totals || {},
    recommendation: impact.recommendation || null,
  };
}

// Pure rule evaluation. `impact` is the classified report from impact.js; a
// caller may inject one (tests, previews) instead of recomputing the traversal.
export function evaluateChangeInitiation(db, tenantId, requirement, impact, options = {}) {
  const config = changeInitiationConfig(db, tenantId);
  const severity = severityFor(requirement, options.severity ?? options.severityOverride);
  const releasedImpacted = Boolean(impact?.released_impacted);
  const requireReleased = options.require_released ?? options.requireReleased ?? config.requireReleased;
  const matched = [];
  let blockedBy = null;

  if (config.enabled) matched.push("AUTO_CHANGE_REQUEST");
  else blockedBy = "auto_change_request_disabled";

  if (!blockedBy) {
    if (config.severities.includes(severity)) matched.push("SEVERITY_THRESHOLD");
    else blockedBy = "severity_below_threshold";
  }

  if (!blockedBy) {
    if (!requireReleased || releasedImpacted) matched.push("RELEASED_IMPACT");
    else blockedBy = "released_impact_required";
  }

  let initiate = !blockedBy;
  if (options.force) {
    initiate = true;
    blockedBy = null;
    if (!matched.includes("FORCED")) matched.push("FORCED");
  }

  return {
    status: initiate ? "PENDING" : "NOT_REQUIRED",
    initiate,
    severity,
    require_released: requireReleased,
    released_impacted: releasedImpacted,
    change_candidate: Boolean(impact?.recommendation?.change_candidate),
    matched_rules: matched,
    blocked_by: blockedBy,
    reasons: impact?.recommendation?.reasons || [],
    config: { enabled: config.enabled, severities: config.severities, require_released: config.requireReleased, category: config.category, priority: config.priority },
    impact_summary: impactSummary(impact),
  };
}

function requirementView(requirement) {
  return {
    id: requirement.id,
    requirement_ref: requirement.requirement_ref || "",
    requirement_number: requirement.requirement_number || "",
    object_id: requirement.object_id ?? null,
    title: requirement.title || requirement.name || "",
    priority: requirement.priority || "",
    criticality: requirement.criticality || "",
    status: requirement.status || "",
    version: requirement.version ?? 1,
  };
}

function resolveImpact(db, tenant, requirement, options, actor, ip) {
  if (options.impact) return options.impact;
  return analyzeRequirementImpact(db, tenant, requirement.id, { maxDepth: options.max_depth ?? options.maxDepth, asOf: options.as_of ?? options.asOf, variant: options.variant, configuration: options.configuration }, actor, ip);
}

async function resolveImpactAsync(db, tenant, requirement, options, actor, ip) {
  if (options.impact) return options.impact;
  return analyzeRequirementImpactAsync(db, tenant, requirement.id, { maxDepth: options.max_depth ?? options.maxDepth, asOf: options.as_of ?? options.asOf, variant: options.variant, configuration: options.configuration }, actor, ip);
}

// Preview the decision without writing anything.
export function evaluateRequirementChangeInitiation(db, tenantId, requirementRef, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const requirement = options.requirement || Requirements.requireRequirementRow(db, tenant, requirementRef);
  const impact = resolveImpact(db, tenant, requirement, options, actor, ip);
  return { source_module: "requirement-pdm", requirement: requirementView(requirement), decision: evaluateChangeInitiation(db, tenant, requirement, impact, options) };
}

export async function evaluateRequirementChangeInitiationAsync(db, tenantId, requirementRef, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const requirement = options.requirement || (await Requirements.requireRequirementRowAsync(db, tenant, requirementRef));
  const impact = await resolveImpactAsync(db, tenant, requirement, options, actor, ip);
  return { source_module: "requirement-pdm", requirement: requirementView(requirement), decision: evaluateChangeInitiation(db, tenant, requirement, impact, options) };
}

function idempotencyKey(tenant, requirement, options) {
  const explicit = options.idempotency_key ?? options.idempotencyKey;
  if (explicit) return normalizeText(explicit, { max: 200 });
  return normalizeText(`requirement-change:${tenant}:${requirement.id}:v${requirement.version ?? 1}`, { max: 200 });
}

function initiationLinkRows(db, tenant, requirement) {
  return queryAll(
    db,
    `SELECT * FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type = 'CHANGED_BY' AND source_type = ? AND source_id = ? AND target_type = ?
      ORDER BY id DESC LIMIT 200`,
    [tenant, REQUIREMENT_SOURCE_TYPE, String(requirement.id), CHANGE_REQUEST_TYPE]
  );
}

async function initiationLinkRowsAsync(db, tenant, requirement) {
  return queryAllAsync(
    db,
    `SELECT * FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type = 'CHANGED_BY' AND source_type = ? AND source_id = ? AND target_type = ?
      ORDER BY id DESC LIMIT 200`,
    [tenant, REQUIREMENT_SOURCE_TYPE, String(requirement.id), CHANGE_REQUEST_TYPE]
  );
}

function findIdempotentLink(rows, key) {
  return rows.find((row) => parseObject(row.attributes_json, {}).idempotency_key === key) || null;
}

function buildChangeBody(requirement, decision, key, options) {
  const title = options.title || `[${requirement.requirement_number}] ${requirement.title || requirement.name || "Requirement change"}`;
  const description = options.description || [
    `Automatically raised from requirement ${requirement.requirement_number} (${requirement.requirement_ref || requirement.id}).`,
    `Severity ${decision.severity}; ${decision.impact_summary?.impacted_count ?? 0} downstream object(s) impacted, ${decision.impact_summary?.released_count ?? 0} released.`,
  ].join(" ");
  return {
    request_number: options.request_number ?? options.requestNumber ?? null,
    title: normalizeText(title, { max: 300 }),
    description: normalizeText(description, { max: 4000 }),
    category: upper(options.category || decision.config.category),
    priority: upper(options.priority || decision.config.priority),
    reason: normalizeText(options.reason || (decision.reasons || []).join(", "), { max: 4000 }),
    organization_id: requirement.organization_id ?? null,
    metadata: {
      integration: "requirement-pdm",
      source: "requirement-change-initiation",
      requirement_id: requirement.id,
      requirement_ref: requirement.requirement_ref || "",
      requirement_number: requirement.requirement_number || "",
      severity: decision.severity,
      idempotency_key: key,
      matched_rules: decision.matched_rules,
      impact_summary: decision.impact_summary,
    },
  };
}

function existingResult(db, tenant, requirement, decision, key, linkRow) {
  const change = getRequest(db, tenant, linkRow.target_id);
  return {
    source_module: "requirement-pdm",
    status: "EXISTING",
    decision,
    requirement: requirementView(requirement),
    idempotency_key: key,
    existing: { link_ref: linkRow.relationship_ref, change_type: CHANGE_REQUEST_TYPE, change_id: String(linkRow.target_id) },
    change,
    link: null,
    created: false,
  };
}

async function existingResultAsync(db, tenant, requirement, decision, key, linkRow) {
  const change = await getRequestAsync(db, tenant, linkRow.target_id);
  return {
    source_module: "requirement-pdm",
    status: "EXISTING",
    decision,
    requirement: requirementView(requirement),
    idempotency_key: key,
    existing: { link_ref: linkRow.relationship_ref, change_type: CHANGE_REQUEST_TYPE, change_id: String(linkRow.target_id) },
    change,
    link: null,
    created: false,
  };
}

export function initiateChangeRequest(db, tenantId, requirementRef, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const requirement = options.requirement || Requirements.requireRequirementRow(db, tenant, requirementRef);
  const impact = resolveImpact(db, tenant, requirement, options, actor, ip);
  const decision = evaluateChangeInitiation(db, tenant, requirement, impact, options);

  if (!decision.initiate) {
    writeAudit(db, { actor, action: "requirement-pdm.change-initiation.skipped", resourceType: "requirement", resourceId: String(requirement.id), details: { blocked_by: decision.blocked_by, severity: decision.severity }, ip });
    return { source_module: "requirement-pdm", status: "NOT_REQUIRED", decision, requirement: requirementView(requirement), change: null, link: null, created: false };
  }

  const key = idempotencyKey(tenant, requirement, options);
  const linkRows = initiationLinkRows(db, tenant, requirement);
  const existing = findIdempotentLink(linkRows, key);
  if (existing) {
    writeAudit(db, { actor, action: "requirement-pdm.change-initiation.existing", resourceType: "requirement", resourceId: String(requirement.id), details: { idempotency_key: key, change_id: String(existing.target_id) }, ip });
    return existingResult(db, tenant, requirement, decision, key, existing);
  }

  const change = createRequest(db, tenant, buildChangeBody(requirement, decision, key, options), actor, ip);
  const linked = linkChange(db, tenant, {
    requirement_id: requirement.id,
    change_type: CHANGE_REQUEST_TYPE,
    change_id: change.id,
    reason: "Auto-initiated from requirement change",
    attributes: { idempotency_key: key, auto: true, source: "requirement-change-initiation", severity: decision.severity },
  }, actor, ip);

  publishRequirementPdmEvent(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.CHANGE_INITIATED, objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, organizationId: requirement.organization_id ?? null, payload: { change_request_id: change.id, request_number: change.request_number, severity: decision.severity, idempotency_key: key } }, actor);
  publishRequirementPdmEvent(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.CHANGE_REQUEST_CREATED, objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, organizationId: requirement.organization_id ?? null, payload: { change_request_id: change.id, request_number: change.request_number } }, actor);
  writeAudit(db, { actor, action: "requirement-pdm.change-initiation.create", resourceType: "requirement", resourceId: String(requirement.id), details: { idempotency_key: key, change_request_id: change.id, request_number: change.request_number }, ip });

  decision.status = "CREATED";
  return {
    source_module: "requirement-pdm",
    status: "CREATED",
    decision,
    requirement: requirementView(requirement),
    idempotency_key: key,
    change,
    link: linked.link,
    created: true,
  };
}

export async function initiateChangeRequestAsync(db, tenantId, requirementRef, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const requirement = options.requirement || (await Requirements.requireRequirementRowAsync(db, tenant, requirementRef));
  const impact = await resolveImpactAsync(db, tenant, requirement, options, actor, ip);
  const decision = evaluateChangeInitiation(db, tenant, requirement, impact, options);

  if (!decision.initiate) {
    await writeAuditAsync(db, { actor, action: "requirement-pdm.change-initiation.skipped", resourceType: "requirement", resourceId: String(requirement.id), details: { blocked_by: decision.blocked_by, severity: decision.severity }, ip });
    return { source_module: "requirement-pdm", status: "NOT_REQUIRED", decision, requirement: requirementView(requirement), change: null, link: null, created: false };
  }

  const key = idempotencyKey(tenant, requirement, options);
  const linkRows = await initiationLinkRowsAsync(db, tenant, requirement);
  const existing = findIdempotentLink(linkRows, key);
  if (existing) {
    await writeAuditAsync(db, { actor, action: "requirement-pdm.change-initiation.existing", resourceType: "requirement", resourceId: String(requirement.id), details: { idempotency_key: key, change_id: String(existing.target_id) }, ip });
    return existingResultAsync(db, tenant, requirement, decision, key, existing);
  }

  const change = await createRequestAsync(db, tenant, buildChangeBody(requirement, decision, key, options), actor, ip);
  const linked = await linkChangeAsync(db, tenant, {
    requirement_id: requirement.id,
    change_type: CHANGE_REQUEST_TYPE,
    change_id: change.id,
    reason: "Auto-initiated from requirement change",
    attributes: { idempotency_key: key, auto: true, source: "requirement-change-initiation", severity: decision.severity },
  }, actor, ip);

  await publishRequirementPdmEventAsync(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.CHANGE_INITIATED, objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, organizationId: requirement.organization_id ?? null, payload: { change_request_id: change.id, request_number: change.request_number, severity: decision.severity, idempotency_key: key } }, actor);
  await publishRequirementPdmEventAsync(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.CHANGE_REQUEST_CREATED, objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, organizationId: requirement.organization_id ?? null, payload: { change_request_id: change.id, request_number: change.request_number } }, actor);
  await writeAuditAsync(db, { actor, action: "requirement-pdm.change-initiation.create", resourceType: "requirement", resourceId: String(requirement.id), details: { idempotency_key: key, change_request_id: change.id, request_number: change.request_number }, ip });

  decision.status = "CREATED";
  return {
    source_module: "requirement-pdm",
    status: "CREATED",
    decision,
    requirement: requirementView(requirement),
    idempotency_key: key,
    change,
    link: linked.link,
    created: true,
  };
}

// ── CR -> ECO -> ECN chain ───────────────────────────────────────────────────
//
// Batched (no N+1): all change requests for the requirement, then every order
// for those requests, then every notice for those orders, then the affected
// item counts — four queries regardless of chain size.

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const value = String(row[key]);
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(row);
  }
  return map;
}

function assembleChain(requirement, links, orders, notices, affectedCounts) {
  const ordersByRequest = groupBy(orders, "change_request_id");
  const noticesByOrder = groupBy(notices, "change_order_id");

  const items = links.map((link) => {
    const attrs = parseObject(link.attributes_json, {});
    const request = resolveChangePlaceholder(link, attrs);
    const requestOrders = (ordersByRequest.get(String(link.target_id)) || []).map((order) => {
      const orderNotices = (noticesByOrder.get(String(order.id)) || []).map(publicNotice);
      return { ...publicOrder(order), notices: orderNotices, affected_item_count: Number(affectedCounts.get(String(order.id)) || 0) };
    });
    return { link_ref: link.relationship_ref, change_request: request, orders: requestOrders, order_count: requestOrders.length };
  });

  return {
    source_module: "requirement-pdm",
    requirement: requirementView(requirement),
    items,
    change_request_count: items.length,
    order_count: items.reduce((sum, item) => sum + item.order_count, 0),
  };
}

function resolveChangePlaceholder(link, attrs) {
  return {
    change_type: CHANGE_REQUEST_TYPE,
    change_id: String(link.target_id),
    ref: attrs.change_ref || "",
    number: attrs.change_number || "",
    status: attrs.change_status || "",
    idempotency_key: attrs.idempotency_key || "",
    auto: Boolean(attrs.auto),
    severity: attrs.severity || "",
    created_at: link.created_at || "",
  };
}

export function requirementChangeChain(db, tenantId, requirementRef) {
  const tenant = Number(tenantId);
  const requirement = Requirements.requireRequirementRow(db, tenant, requirementRef);
  const links = initiationLinkRows(db, tenant, requirement);
  if (!links.length) return { source_module: "requirement-pdm", requirement: requirementView(requirement), items: [], change_request_count: 0, order_count: 0 };
  const requestIds = links.map((link) => Number(link.target_id)).filter((id) => Number.isInteger(id));
  const orders = requestIds.length
    ? queryAll(db, `SELECT * FROM change_orders WHERE tenant_id = ? AND change_request_id IN (${placeholders(requestIds)}) ORDER BY id`, [tenant, ...requestIds])
    : [];
  const orderIds = orders.map((order) => Number(order.id));
  const notices = orderIds.length
    ? queryAll(db, `SELECT * FROM change_notices WHERE tenant_id = ? AND change_order_id IN (${placeholders(orderIds)}) ORDER BY id`, [tenant, ...orderIds])
    : [];
  const counts = orderIds.length
    ? queryAll(db, `SELECT change_order_id, COUNT(*) AS c FROM change_affected_items WHERE change_order_id IN (${placeholders(orderIds)}) GROUP BY change_order_id`, orderIds)
    : [];
  const affectedCounts = new Map(counts.map((row) => [String(row.change_order_id), Number(row.c || 0)]));
  return assembleChain(requirement, links, orders, notices, affectedCounts);
}

export async function requirementChangeChainAsync(db, tenantId, requirementRef) {
  const tenant = Number(tenantId);
  const requirement = await Requirements.requireRequirementRowAsync(db, tenant, requirementRef);
  const links = await initiationLinkRowsAsync(db, tenant, requirement);
  if (!links.length) return { source_module: "requirement-pdm", requirement: requirementView(requirement), items: [], change_request_count: 0, order_count: 0 };
  const requestIds = links.map((link) => Number(link.target_id)).filter((id) => Number.isInteger(id));
  const orders = requestIds.length
    ? await queryAllAsync(db, `SELECT * FROM change_orders WHERE tenant_id = ? AND change_request_id IN (${placeholders(requestIds)}) ORDER BY id`, [tenant, ...requestIds])
    : [];
  const orderIds = orders.map((order) => Number(order.id));
  const notices = orderIds.length
    ? await queryAllAsync(db, `SELECT * FROM change_notices WHERE tenant_id = ? AND change_order_id IN (${placeholders(orderIds)}) ORDER BY id`, [tenant, ...orderIds])
    : [];
  const counts = orderIds.length
    ? await queryAllAsync(db, `SELECT change_order_id, COUNT(*) AS c FROM change_affected_items WHERE change_order_id IN (${placeholders(orderIds)}) GROUP BY change_order_id`, orderIds)
    : [];
  const affectedCounts = new Map(counts.map((row) => [String(row.change_order_id), Number(row.c || 0)]));
  return assembleChain(requirement, links, orders, notices, affectedCounts);
}

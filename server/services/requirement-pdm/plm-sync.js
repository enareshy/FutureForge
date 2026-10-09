// PLM -> Requirement change synchronization.
//
// When a Product, EBOM, MBOM, BOP, Document or Change object changes, the
// integration walks the existing requirement relationships to find the
// requirements allocated to (or changed by) that object, classifies the impact
// with the same Digital Thread impact engine used in the Requirement -> PLM
// direction, and notifies the requirement owners through the Notification
// framework (Prompt 4 section 21-23 and 28).
//
// No PLM object is copied here: the changed node is resolved from the domain
// that owns it and only the traversable relationship edge is read.
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import {
  ALLOCATION_CODES,
  TARGET_NODE_TYPES,
  CHANGE_NODE_TYPES,
  REQUIREMENT_SOURCE_TYPE,
  REQUIREMENT_PDM_EVENT_MAP,
  PLM_SYNC_DIRECTIONS,
  SOURCE_MODULE,
} from "./constants.js";
import { getConfig } from "./configuration.js";
import { invalidPlmNode } from "./errors.js";
import { publishRequirementPdmEvent, publishRequirementPdmEventAsync } from "./events.js";
import { analyzeRequirementImpact, analyzeRequirementImpactAsync } from "./impact.js";
import { notifyRequirementOwners, notifyRequirementOwnersAsync } from "./plm-notifications.js";

const ALLOCATION_NODE_SET = new Set(TARGET_NODE_TYPES);
const CHANGE_NODE_VALUES = Object.values(CHANGE_NODE_TYPES);
const CHANGE_NODE_SET = new Set(CHANGE_NODE_VALUES);
const ALLOCATION_PLACEHOLDERS = ALLOCATION_CODES.map(() => "?").join(", ");
const CHANGE_SCOPE = "CHANGE";
const ALLOCATION_SCOPE = "ALLOCATION";

function normalizedNode(nodeType, nodeId) {
  const type = String(nodeType || "").toLowerCase();
  const id = Number(nodeId);
  if (!Number.isInteger(id) || id <= 0) throw invalidPlmNode(nodeType, { node_id: nodeId });
  return { type, id };
}

// Resolves a changed PLM node to the relationship targets that link it to
// requirements. Change orders/notices resolve up to their owning change request,
// because a requirement is linked to the change request (system of record).
export function resolvePlmNodeTargets(db, tenantId, nodeType, nodeId) {
  const tenant = Number(tenantId);
  const { type, id } = normalizedNode(nodeType, nodeId);
  if (ALLOCATION_NODE_SET.has(type)) {
    return { node_type: type, node_id: id, change_request_id: null, targets: [{ scope: ALLOCATION_SCOPE, target_type: type, target_id: id }] };
  }
  if (!CHANGE_NODE_SET.has(type)) throw invalidPlmNode(nodeType);
  if (type === CHANGE_NODE_TYPES.REQUEST) {
    return { node_type: type, node_id: id, change_request_id: id, targets: [{ scope: CHANGE_SCOPE, target_type: "change_request", target_id: id }] };
  }
  if (type === CHANGE_NODE_TYPES.ORDER) {
    const row = queryOne(db, "SELECT * FROM change_orders WHERE tenant_id = ? AND id = ?", [tenant, id]);
    if (!row) return { node_type: type, node_id: id, change_request_id: null, targets: [] };
    return { node_type: type, node_id: id, change_request_id: row.change_request_id ?? null, targets: row.change_request_id ? [{ scope: CHANGE_SCOPE, target_type: "change_request", target_id: row.change_request_id }] : [] };
  }
  const notice = queryOne(db, "SELECT * FROM change_notices WHERE tenant_id = ? AND id = ?", [tenant, id]);
  if (!notice) return { node_type: type, node_id: id, change_request_id: null, targets: [] };
  const order = notice.change_order_id ? queryOne(db, "SELECT * FROM change_orders WHERE tenant_id = ? AND id = ?", [tenant, notice.change_order_id]) : null;
  return { node_type: type, node_id: id, change_request_id: order?.change_request_id ?? null, targets: order?.change_request_id ? [{ scope: CHANGE_SCOPE, target_type: "change_request", target_id: order.change_request_id }] : [] };
}

export async function resolvePlmNodeTargetsAsync(db, tenantId, nodeType, nodeId) {
  const tenant = Number(tenantId);
  const { type, id } = normalizedNode(nodeType, nodeId);
  if (ALLOCATION_NODE_SET.has(type)) {
    return { node_type: type, node_id: id, change_request_id: null, targets: [{ scope: ALLOCATION_SCOPE, target_type: type, target_id: id }] };
  }
  if (!CHANGE_NODE_SET.has(type)) throw invalidPlmNode(nodeType);
  if (type === CHANGE_NODE_TYPES.REQUEST) {
    return { node_type: type, node_id: id, change_request_id: id, targets: [{ scope: CHANGE_SCOPE, target_type: "change_request", target_id: id }] };
  }
  if (type === CHANGE_NODE_TYPES.ORDER) {
    const row = await queryOneAsync(db, "SELECT * FROM change_orders WHERE tenant_id = ? AND id = ?", [tenant, id]);
    if (!row) return { node_type: type, node_id: id, change_request_id: null, targets: [] };
    return { node_type: type, node_id: id, change_request_id: row.change_request_id ?? null, targets: row.change_request_id ? [{ scope: CHANGE_SCOPE, target_type: "change_request", target_id: row.change_request_id }] : [] };
  }
  const notice = await queryOneAsync(db, "SELECT * FROM change_notices WHERE tenant_id = ? AND id = ?", [tenant, id]);
  if (!notice) return { node_type: type, node_id: id, change_request_id: null, targets: [] };
  const order = notice.change_order_id ? await queryOneAsync(db, "SELECT * FROM change_orders WHERE tenant_id = ? AND id = ?", [tenant, notice.change_order_id]) : null;
  return { node_type: type, node_id: id, change_request_id: order?.change_request_id ?? null, targets: order?.change_request_id ? [{ scope: CHANGE_SCOPE, target_type: "change_request", target_id: order.change_request_id }] : [] };
}

function reverseQuery(targets) {
  const clauses = [];
  const params = [];
  for (const target of targets) {
    if (target.scope === CHANGE_SCOPE) {
      clauses.push("(rel.relationship_type = 'CHANGED_BY' AND rel.target_type = 'change_request' AND rel.target_id = ?)");
      params.push(String(target.target_id));
    } else {
      clauses.push(`(rel.relationship_type IN (${ALLOCATION_PLACEHOLDERS}) AND rel.target_type = ? AND rel.target_id = ?)`);
      params.push(...ALLOCATION_CODES, target.target_type, String(target.target_id));
    }
  }
  return { clause: `(${clauses.join(" OR ")})`, params };
}

function groupRequirements(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    if (!map.has(id)) {
      const { link_type, link_target_type, link_target_id, link_ref, link_attributes, ...requirement } = row;
      map.set(id, { ...requirement, links: [] });
    }
    map.get(id).links.push({ relationship_type: row.link_type, target_type: row.link_target_type, target_id: row.link_target_id, link_ref: row.link_ref, attributes: row.link_attributes });
  }
  return [...map.values()];
}

// Finds the requirements linked to a changed PLM node (reverse navigation).
export function requirementsForPlmNode(db, tenantId, nodeType, nodeId) {
  const tenant = Number(tenantId);
  const resolved = resolvePlmNodeTargets(db, tenant, nodeType, nodeId);
  if (!resolved.targets.length) return { ...resolved, requirements: [], total: 0 };
  const { clause, params } = reverseQuery(resolved.targets);
  const rows = queryAll(
    db,
    `SELECT r.*, rel.relationship_type AS link_type, rel.target_type AS link_target_type,
            rel.target_id AS link_target_id, rel.relationship_ref AS link_ref, rel.attributes_json AS link_attributes
       FROM requirement_relationships rel
       JOIN requirements r ON r.tenant_id = rel.tenant_id AND r.id::text = rel.source_id
      WHERE rel.tenant_id = ? AND rel.source_type = ? AND rel.status = 'ACTIVE' AND ${clause}
      ORDER BY r.id`,
    [tenant, REQUIREMENT_SOURCE_TYPE, ...params]
  );
  const requirements = groupRequirements(rows);
  return { ...resolved, requirements, total: requirements.length };
}

export async function requirementsForPlmNodeAsync(db, tenantId, nodeType, nodeId) {
  const tenant = Number(tenantId);
  const resolved = await resolvePlmNodeTargetsAsync(db, tenant, nodeType, nodeId);
  if (!resolved.targets.length) return { ...resolved, requirements: [], total: 0 };
  const { clause, params } = reverseQuery(resolved.targets);
  const rows = await queryAllAsync(
    db,
    `SELECT r.*, rel.relationship_type AS link_type, rel.target_type AS link_target_type,
            rel.target_id AS link_target_id, rel.relationship_ref AS link_ref, rel.attributes_json AS link_attributes
       FROM requirement_relationships rel
       JOIN requirements r ON r.tenant_id = rel.tenant_id AND r.id::text = rel.source_id
      WHERE rel.tenant_id = ? AND rel.source_type = ? AND rel.status = 'ACTIVE' AND ${clause}
      ORDER BY r.id`,
    [tenant, REQUIREMENT_SOURCE_TYPE, ...params]
  );
  const requirements = groupRequirements(rows);
  return { ...resolved, requirements, total: requirements.length };
}

function requirementView(requirement) {
  return {
    id: requirement.id,
    requirement_ref: requirement.requirement_ref || "",
    requirement_number: requirement.requirement_number || "",
    title: requirement.title || requirement.name || "",
    status: requirement.status || "",
    priority: requirement.priority || "",
    owner_user_id: requirement.owner_user_id ?? null,
    responsible_user_id: requirement.responsible_user_id ?? null,
    links: requirement.links,
  };
}

function impactFor(db, tenant, requirement, options, actor, ip) {
  if (typeof options.impact === "function") return options.impact(requirement);
  if (options.impact && typeof options.impact === "object") return options.impact;
  return analyzeRequirementImpact(db, tenant, requirement.id, { maxDepth: options.maxDepth ?? options.max_depth, asOf: options.asOf }, actor, ip);
}

async function impactForAsync(db, tenant, requirement, options, actor, ip) {
  if (typeof options.impact === "function") return await options.impact(requirement);
  if (options.impact && typeof options.impact === "object") return options.impact;
  return analyzeRequirementImpactAsync(db, tenant, requirement.id, { maxDepth: options.maxDepth ?? options.max_depth, asOf: options.asOf }, actor, ip);
}

function syncConfig(db, tenant, options) {
  const analyze = options.analyze ?? options.plmSyncAnalyze ?? Boolean(getConfig(db, tenant, "plm_sync_analyze"));
  const notify = options.notify ?? options.plmSyncNotify ?? Boolean(getConfig(db, tenant, "plm_sync_notify"));
  return { analyze, notify };
}

function summarizeResult(direction, resolved, { eventType, correlationId }, entries) {
  const analyzed = entries.filter((entry) => entry.analysis_status === "ANALYZED").length;
  const failed = entries.filter((entry) => entry.analysis_status === "FAILED").length;
  const impacted = entries.reduce((sum, entry) => sum + (entry.impacted_count || 0), 0);
  const notified = entries.filter((entry) => entry.notified).length;
  let status = "COMPLETED";
  if (entries.length && failed === entries.length) status = "FAILED";
  else if (failed > 0) status = "PARTIAL";
  return {
    source_module: SOURCE_MODULE,
    direction,
    node_type: resolved.node_type,
    node_id: resolved.node_id,
    change_request_id: resolved.change_request_id ?? null,
    event_type: eventType || "",
    correlation_id: correlationId || "",
    requirement_count: entries.length,
    analyzed_count: analyzed,
    impacted_count: impacted,
    notified_count: notified,
    failed_count: failed,
    status,
    requirements: entries,
  };
}

// Propagates a PLM change to the requirements linked to it.
export function synchronizeFromPlm(db, tenantId, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const resolved = requirementsForPlmNode(db, tenant, options.nodeType ?? options.node_type, options.nodeId ?? options.node_id ?? options.id);
  const { analyze, notify } = syncConfig(db, tenant, options);
  const eventType = options.eventType ?? options.event_type ?? "";
  const correlationId = options.correlationId ?? options.correlation_id ?? "";
  const entries = [];

  for (const requirement of resolved.requirements) {
    let report = null;
    let error = null;
    if (analyze) {
      try {
        report = impactFor(db, tenant, requirement, options, actor, ip);
      } catch (err) {
        error = err?.message || String(err);
      }
    }
    const impactedCount = report?.impacted_count ?? 0;
    publishRequirementPdmEvent(
      db,
      {
        eventType: REQUIREMENT_PDM_EVENT_MAP.IMPACT_DETECTED,
        objectType: "requirement",
        objectId: String(requirement.id),
        tenantId: tenant,
        payload: { direction: PLM_SYNC_DIRECTIONS.PLM_TO_REQUIREMENT, node_type: resolved.node_type, node_id: resolved.node_id, change_event: eventType, impacted_count: impactedCount, released_impacted: Boolean(report?.released_impacted), error: error || null },
      },
      actor
    );
    let notified = false;
    if (notify && !error) {
      const summary = notifyRequirementOwners(db, tenant, { requirement, eventType: REQUIREMENT_PDM_EVENT_MAP.IMPACT_DETECTED, payload: { direction: PLM_SYNC_DIRECTIONS.PLM_TO_REQUIREMENT, node_type: resolved.node_type, node_id: resolved.node_id, change_event: eventType }, correlationId, actor });
      notified = Boolean(summary && summary.published !== false && summary.reason !== "no_recipient");
    }
    entries.push({ requirement: requirementView(requirement), analysis_status: error ? "FAILED" : analyze ? "ANALYZED" : "SKIPPED", impacted_count: impactedCount, released_impacted: Boolean(report?.released_impacted), error, notified });
  }

  const result = summarizeResult(PLM_SYNC_DIRECTIONS.PLM_TO_REQUIREMENT, resolved, { eventType, correlationId }, entries);
  publishRequirementPdmEvent(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.PLM_CHANGE_SYNCHRONIZED, objectType: "requirement", objectId: null, tenantId: tenant, payload: { direction: result.direction, node_type: result.node_type, node_id: result.node_id, requirement_count: result.requirement_count, impacted_count: result.impacted_count, status: result.status } }, actor);
  if (result.failed_count) {
    publishRequirementPdmEvent(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.PLM_SYNCHRONIZATION_FAILED, objectType: "requirement", objectId: null, tenantId: tenant, payload: { direction: result.direction, node_type: result.node_type, node_id: result.node_id, failed_count: result.failed_count } }, actor);
  }
  writeAudit(db, { actor, action: "requirement-pdm.plm-sync", resourceType: "requirement_plm_node", resourceId: `${result.node_type}:${result.node_id}`, details: { requirement_count: result.requirement_count, impacted_count: result.impacted_count, status: result.status }, ip });
  return result;
}

export async function synchronizeFromPlmAsync(db, tenantId, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const resolved = await requirementsForPlmNodeAsync(db, tenant, options.nodeType ?? options.node_type, options.nodeId ?? options.node_id ?? options.id);
  const { analyze, notify } = syncConfig(db, tenant, options);
  const eventType = options.eventType ?? options.event_type ?? "";
  const correlationId = options.correlationId ?? options.correlation_id ?? "";
  const entries = [];

  for (const requirement of resolved.requirements) {
    let report = null;
    let error = null;
    if (analyze) {
      try {
        report = await impactForAsync(db, tenant, requirement, options, actor, ip);
      } catch (err) {
        error = err?.message || String(err);
      }
    }
    const impactedCount = report?.impacted_count ?? 0;
    await publishRequirementPdmEventAsync(
      db,
      {
        eventType: REQUIREMENT_PDM_EVENT_MAP.IMPACT_DETECTED,
        objectType: "requirement",
        objectId: String(requirement.id),
        tenantId: tenant,
        payload: { direction: PLM_SYNC_DIRECTIONS.PLM_TO_REQUIREMENT, node_type: resolved.node_type, node_id: resolved.node_id, change_event: eventType, impacted_count: impactedCount, released_impacted: Boolean(report?.released_impacted), error: error || null },
      },
      actor
    );
    let notified = false;
    if (notify && !error) {
      const summary = await notifyRequirementOwnersAsync(db, tenant, { requirement, eventType: REQUIREMENT_PDM_EVENT_MAP.IMPACT_DETECTED, payload: { direction: PLM_SYNC_DIRECTIONS.PLM_TO_REQUIREMENT, node_type: resolved.node_type, node_id: resolved.node_id, change_event: eventType }, correlationId, actor });
      notified = Boolean(summary && summary.published !== false && summary.reason !== "no_recipient");
    }
    entries.push({ requirement: requirementView(requirement), analysis_status: error ? "FAILED" : analyze ? "ANALYZED" : "SKIPPED", impacted_count: impactedCount, released_impacted: Boolean(report?.released_impacted), error, notified });
  }

  const result = summarizeResult(PLM_SYNC_DIRECTIONS.PLM_TO_REQUIREMENT, resolved, { eventType, correlationId }, entries);
  await publishRequirementPdmEventAsync(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.PLM_CHANGE_SYNCHRONIZED, objectType: "requirement", objectId: null, tenantId: tenant, payload: { direction: result.direction, node_type: result.node_type, node_id: result.node_id, requirement_count: result.requirement_count, impacted_count: result.impacted_count, status: result.status } }, actor);
  if (result.failed_count) {
    await publishRequirementPdmEventAsync(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.PLM_SYNCHRONIZATION_FAILED, objectType: "requirement", objectId: null, tenantId: tenant, payload: { direction: result.direction, node_type: result.node_type, node_id: result.node_id, failed_count: result.failed_count } }, actor);
  }
  await writeAuditAsync(db, { actor, action: "requirement-pdm.plm-sync", resourceType: "requirement_plm_node", resourceId: `${result.node_type}:${result.node_id}`, details: { requirement_count: result.requirement_count, impacted_count: result.impacted_count, status: result.status }, ip });
  return result;
}

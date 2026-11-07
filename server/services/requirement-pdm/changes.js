// Requirement <-> Change Management linkage.
//
// A requirement is linked to an existing Change Management request/order/notice
// through the Requirements Manager relationship store (relationship type
// CHANGED_BY). No RequirementChangeMapping table and no parallel change object
// is created: Change Management remains the system of record, and this module
// only adds the traversable requirement -> change edge plus reverse navigation.
import { queryAll, queryOne, run } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { Relationships, Requirements } from "../requirements/index.js";
import { recordRequirementHistory, recordRequirementHistoryAsync } from "../requirements/history.js";
import { CHANGE_TARGET_SOURCES, REQUIREMENT_SOURCE_TYPE, REQUIREMENT_PDM_EVENT_MAP, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./constants.js";
import { normalizeChangeLinkInput, parseObject, paginate } from "./validation.js";
import { changeNotFound, invalidChange } from "./errors.js";
import { publishRequirementPdmEvent, publishRequirementPdmEventAsync } from "./events.js";
import { isChangeType } from "./change-nodes.js";

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function assertChangeType(type) {
  const value = String(type || "").toLowerCase();
  if (!isChangeType(value)) throw invalidChange(`Unsupported change type: ${type}`, { change_type: type });
  return value;
}

function changeRow(db, tenant, type, id) {
  const source = CHANGE_TARGET_SOURCES[type];
  const numeric = Number(id);
  if (!source || !Number.isInteger(numeric)) return null;
  return queryOne(db, `SELECT * FROM ${source.table} WHERE id = ? AND tenant_id = ?`, [numeric, Number(tenant)]);
}

async function changeRowAsync(db, tenant, type, id) {
  const source = CHANGE_TARGET_SOURCES[type];
  const numeric = Number(id);
  if (!source || !Number.isInteger(numeric)) return null;
  return queryOneAsync(db, `SELECT * FROM ${source.table} WHERE id = ? AND tenant_id = ?`, [numeric, Number(tenant)]);
}

export function publicChange(type, row) {
  if (!row) return null;
  const source = CHANGE_TARGET_SOURCES[type];
  return {
    change_type: type,
    change_id: String(row.id),
    ref: row[source.ref_column] || "",
    number: row[source.number_column] || "",
    title: row.title || "",
    status: row[source.status_column] || "",
    lifecycle_state: row.lifecycle_state || row[source.status_column] || "",
    organization_id: row.organization_id ?? null,
    parent_id: source.parent_column ? row[source.parent_column] ?? null : null,
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
  };
}

export function resolveChange(db, tenantId, type, id) {
  const changeType = assertChangeType(type);
  const row = changeRow(db, Number(tenantId), changeType, id);
  return publicChange(changeType, row);
}

export async function resolveChangeAsync(db, tenantId, type, id) {
  const changeType = assertChangeType(type);
  const row = await changeRowAsync(db, Number(tenantId), changeType, id);
  return publicChange(changeType, row);
}

export function requireChange(db, tenantId, type, id) {
  const change = resolveChange(db, tenantId, type, id);
  if (!change) throw changeNotFound(type, id);
  return change;
}

export async function requireChangeAsync(db, tenantId, type, id) {
  const change = await resolveChangeAsync(db, tenantId, type, id);
  if (!change) throw changeNotFound(type, id);
  return change;
}

function publicChangeLink(row, { requirement = null, change = null } = {}) {
  if (!row) return null;
  const attrs = parseObject(row.attributes_json, {});
  return {
    id: row.id,
    link_ref: row.relationship_ref || "",
    tenant_id: row.tenant_id,
    requirement_id: row.source_id,
    requirement_ref: requirement?.requirement_ref ?? attrs.requirement_ref ?? "",
    requirement_number: requirement?.requirement_number ?? attrs.requirement_number ?? "",
    requirement_object_id: requirement?.object_id ?? attrs.requirement_object_id ?? null,
    requirement_status: requirement?.status ?? "",
    change_type: row.target_type,
    change_id: row.target_id,
    change: change || null,
    relationship_type: row.relationship_type,
    status: row.status,
    reason: attrs.reason ?? "",
    effectivity_from: row.effectivity_from ?? null,
    effectivity_to: row.effectivity_to ?? null,
    attributes: attrs,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

function requirementMap(db, tenant, ids) {
  if (!ids.length) return new Map();
  const rows = queryAll(db, `SELECT id, requirement_ref, requirement_number, object_id, status FROM requirements WHERE tenant_id = ? AND id IN (${placeholders(ids)})`, [Number(tenant), ...ids]);
  return new Map(rows.map((row) => [Number(row.id), row]));
}

async function requirementMapAsync(db, tenant, ids) {
  if (!ids.length) return new Map();
  const rows = await queryAllAsync(db, `SELECT id, requirement_ref, requirement_number, object_id, status FROM requirements WHERE tenant_id = ? AND id IN (${placeholders(ids)})`, [Number(tenant), ...ids]);
  return new Map(rows.map((row) => [Number(row.id), row]));
}

function enrich(db, tenant, rows) {
  const ids = [...new Set(rows.map((row) => Number(row.source_id)).filter((id) => Number.isInteger(id)))];
  const reqs = requirementMap(db, tenant, ids);
  return rows.map((row) => {
    const requirement = reqs.get(Number(row.source_id)) || null;
    const change = resolveChange(db, tenant, row.target_type, row.target_id);
    return publicChangeLink(row, { requirement, change });
  });
}

async function enrichAsync(db, tenant, rows) {
  const ids = [...new Set(rows.map((row) => Number(row.source_id)).filter((id) => Number.isInteger(id)))];
  const reqs = await requirementMapAsync(db, tenant, ids);
  const output = [];
  for (const row of rows) {
    const requirement = reqs.get(Number(row.source_id)) || null;
    const change = await resolveChangeAsync(db, tenant, row.target_type, row.target_id);
    output.push(publicChangeLink(row, { requirement, change }));
  }
  return output;
}

function existingLinkRow(db, tenant, input, requirement) {
  return queryOne(
    db,
    `SELECT * FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type = ? AND source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?`,
    [Number(tenant), input.relationship_type, REQUIREMENT_SOURCE_TYPE, String(requirement.id), input.change_type, String(input.change_id)]
  );
}

async function existingLinkRowAsync(db, tenant, input, requirement) {
  return queryOneAsync(
    db,
    `SELECT * FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type = ? AND source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?`,
    [Number(tenant), input.relationship_type, REQUIREMENT_SOURCE_TYPE, String(requirement.id), input.change_type, String(input.change_id)]
  );
}

function buildAttributes(input, requirement, change) {
  return {
    ...input.attributes,
    integration: "requirement-pdm",
    link: "requirement-change",
    requirement_ref: requirement.requirement_ref,
    requirement_number: requirement.requirement_number,
    requirement_object_id: requirement.object_id ?? null,
    change_number: change.number,
    change_ref: change.ref,
    change_status: change.status,
    reason: input.reason || "",
  };
}

export function linkChange(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeChangeLinkInput(body);
  const requirement = Requirements.requireRequirementRow(db, tenant, input.requirement_id);
  const change = requireChange(db, tenant, input.change_type, input.change_id);

  const attributes = buildAttributes(input, requirement, change);
  const existing = existingLinkRow(db, tenant, input, requirement);
  if (existing) {
    if (existing.status === "ACTIVE") {
      return { created: false, reactivated: false, link: publicChangeLink(existing, { requirement, change }) };
    }
    run(db, "UPDATE requirement_relationships SET status = 'ACTIVE', effectivity_from = ?, effectivity_to = ?, attributes_json = ? WHERE id = ?", [
      input.effectivity_from ?? existing.effectivity_from ?? null,
      input.effectivity_to ?? existing.effectivity_to ?? null,
      JSON.stringify(attributes),
      existing.id,
    ]);
    const updated = queryOne(db, "SELECT * FROM requirement_relationships WHERE id = ?", [existing.id]);
    recordRequirementHistory(db, { tenantId: tenant, entityType: "RELATIONSHIP", entityId: existing.id, entityRef: existing.relationship_ref, action: "RELATIONSHIP_UPDATED", status: "ACTIVE", before: publicChangeLink(existing), after: publicChangeLink(updated), details: { relationship_type: input.relationship_type }, actor, ip });
    writeAudit(db, { actor, action: "requirement-pdm.change-link.reactivate", resourceType: "requirement_pdm_change_link", resourceId: existing.relationship_ref, details: { change_type: input.change_type, change_id: input.change_id }, ip });
    publishRequirementPdmEvent(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.CHANGE_INITIATED, objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, payload: { link_ref: existing.relationship_ref, change_type: input.change_type, change_id: String(input.change_id) } }, actor);
    return { created: false, reactivated: true, link: publicChangeLink(updated, { requirement, change }) };
  }

  const created = Relationships.createRelationship(
    db,
    tenant,
    {
      relationship_type: input.relationship_type,
      source_type: REQUIREMENT_SOURCE_TYPE,
      source_id: String(requirement.id),
      target_type: input.change_type,
      target_id: String(input.change_id),
      status: input.status || "ACTIVE",
      effectivity_from: input.effectivity_from,
      effectivity_to: input.effectivity_to,
      attributes,
    },
    actor,
    ip
  );

  writeAudit(db, { actor, action: "requirement-pdm.change-link.create", resourceType: "requirement_pdm_change_link", resourceId: created.relationship_ref, details: { change_type: input.change_type, change_id: input.change_id }, ip });
  publishRequirementPdmEvent(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.TRACE_CREATED, objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, payload: { link_ref: created.relationship_ref, change_type: input.change_type, change_id: String(input.change_id) } }, actor);

  return { created: true, reactivated: false, link: publicChangeLink(queryOne(db, "SELECT * FROM requirement_relationships WHERE id = ?", [created.id]), { requirement, change }) };
}

export async function linkChangeAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeChangeLinkInput(body);
  const requirement = await Requirements.requireRequirementRowAsync(db, tenant, input.requirement_id);
  const change = await requireChangeAsync(db, tenant, input.change_type, input.change_id);

  const attributes = buildAttributes(input, requirement, change);
  const existing = await existingLinkRowAsync(db, tenant, input, requirement);
  if (existing) {
    if (existing.status === "ACTIVE") {
      return { created: false, reactivated: false, link: publicChangeLink(existing, { requirement, change }) };
    }
    await runAsync(db, "UPDATE requirement_relationships SET status = 'ACTIVE', effectivity_from = ?, effectivity_to = ?, attributes_json = ? WHERE id = ?", [
      input.effectivity_from ?? existing.effectivity_from ?? null,
      input.effectivity_to ?? existing.effectivity_to ?? null,
      JSON.stringify(attributes),
      existing.id,
    ]);
    const updated = await queryOneAsync(db, "SELECT * FROM requirement_relationships WHERE id = ?", [existing.id]);
    await recordRequirementHistoryAsync(db, { tenantId: tenant, entityType: "RELATIONSHIP", entityId: existing.id, entityRef: existing.relationship_ref, action: "RELATIONSHIP_UPDATED", status: "ACTIVE", before: publicChangeLink(existing), after: publicChangeLink(updated), details: { relationship_type: input.relationship_type }, actor, ip });
    await writeAuditAsync(db, { actor, action: "requirement-pdm.change-link.reactivate", resourceType: "requirement_pdm_change_link", resourceId: existing.relationship_ref, details: { change_type: input.change_type, change_id: input.change_id }, ip });
    await publishRequirementPdmEventAsync(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.CHANGE_INITIATED, objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, payload: { link_ref: existing.relationship_ref, change_type: input.change_type, change_id: String(input.change_id) } }, actor);
    return { created: false, reactivated: true, link: publicChangeLink(updated, { requirement, change }) };
  }

  const created = await Relationships.createRelationshipAsync(
    db,
    tenant,
    {
      relationship_type: input.relationship_type,
      source_type: REQUIREMENT_SOURCE_TYPE,
      source_id: String(requirement.id),
      target_type: input.change_type,
      target_id: String(input.change_id),
      status: input.status || "ACTIVE",
      effectivity_from: input.effectivity_from,
      effectivity_to: input.effectivity_to,
      attributes,
    },
    actor,
    ip
  );

  await writeAuditAsync(db, { actor, action: "requirement-pdm.change-link.create", resourceType: "requirement_pdm_change_link", resourceId: created.relationship_ref, details: { change_type: input.change_type, change_id: input.change_id }, ip });
  await publishRequirementPdmEventAsync(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.TRACE_CREATED, objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, payload: { link_ref: created.relationship_ref, change_type: input.change_type, change_id: String(input.change_id) } }, actor);

  const row = await queryOneAsync(db, "SELECT * FROM requirement_relationships WHERE id = ?", [created.id]);
  return { created: true, reactivated: false, link: publicChangeLink(row, { requirement, change }) };
}

function linkRowByRef(db, tenant, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM requirement_relationships WHERE id = ? AND tenant_id = ? AND relationship_type = 'CHANGED_BY'", [id, Number(tenant)]);
  }
  return queryOne(db, "SELECT * FROM requirement_relationships WHERE tenant_id = ? AND relationship_ref = ? AND relationship_type = 'CHANGED_BY'", [Number(tenant), String(ref)]);
}

async function linkRowByRefAsync(db, tenant, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM requirement_relationships WHERE id = ? AND tenant_id = ? AND relationship_type = 'CHANGED_BY'", [id, Number(tenant)]);
  }
  return queryOneAsync(db, "SELECT * FROM requirement_relationships WHERE tenant_id = ? AND relationship_ref = ? AND relationship_type = 'CHANGED_BY'", [Number(tenant), String(ref)]);
}

export function unlinkChange(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = linkRowByRef(db, tenant, ref);
  if (!row) throw changeNotFound("CHANGED_BY", ref);
  const requirement = Requirements.getRequirementRow(db, tenant, row.source_id);
  const change = resolveChange(db, tenant, row.target_type, row.target_id);
  Relationships.deleteRelationship(db, tenant, row.relationship_ref, actor, ip);
  writeAudit(db, { actor, action: "requirement-pdm.change-link.remove", resourceType: "requirement_pdm_change_link", resourceId: row.relationship_ref, details: { change_type: row.target_type, change_id: row.target_id }, ip });
  publishRequirementPdmEvent(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.TRACE_REMOVED, objectType: "requirement", objectId: String(row.source_id), tenantId: tenant, payload: { link_ref: row.relationship_ref, change_type: row.target_type, change_id: row.target_id } }, actor);
  return { removed: true, link: publicChangeLink(row, { requirement, change }) };
}

export async function unlinkChangeAsync(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await linkRowByRefAsync(db, tenant, ref);
  if (!row) throw changeNotFound("CHANGED_BY", ref);
  const requirement = await Requirements.getRequirementRowAsync(db, tenant, row.source_id);
  const change = await resolveChangeAsync(db, tenant, row.target_type, row.target_id);
  await Relationships.deleteRelationshipAsync(db, tenant, row.relationship_ref, actor, ip);
  await writeAuditAsync(db, { actor, action: "requirement-pdm.change-link.remove", resourceType: "requirement_pdm_change_link", resourceId: row.relationship_ref, details: { change_type: row.target_type, change_id: row.target_id }, ip });
  await publishRequirementPdmEventAsync(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.TRACE_REMOVED, objectType: "requirement", objectId: String(row.source_id), tenantId: tenant, payload: { link_ref: row.relationship_ref, change_type: row.target_type, change_id: row.target_id } }, actor);
  return { removed: true, link: publicChangeLink(row, { requirement, change }) };
}

function paginateLinks(opts = {}) {
  return paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
}

export function listRequirementChanges(db, tenantId, requirementId, opts = {}) {
  const tenant = Number(tenantId);
  const requirement = Requirements.requireRequirementRow(db, tenant, requirementId);
  const { limit, offset, page: currentPage } = paginateLinks(opts);
  const filters = ["tenant_id = ?", "relationship_type = 'CHANGED_BY'", "source_id = ?"];
  const params = [tenant, String(requirement.id)];
  if (opts.change_type) {
    filters.push("target_type = ?");
    params.push(assertChangeType(opts.change_type));
  }
  const where = `WHERE ${filters.join(" AND ")}`;
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM requirement_relationships ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM requirement_relationships ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: enrich(db, tenant, rows), total, page: currentPage, page_size: limit, requirement_id: requirement.id, requirement_ref: requirement.requirement_ref, source_module: "requirement-pdm" };
}

export async function listRequirementChangesAsync(db, tenantId, requirementId, opts = {}) {
  const tenant = Number(tenantId);
  const requirement = await Requirements.requireRequirementRowAsync(db, tenant, requirementId);
  const { limit, offset, page: currentPage } = paginateLinks(opts);
  const filters = ["tenant_id = ?", "relationship_type = 'CHANGED_BY'", "source_id = ?"];
  const params = [tenant, String(requirement.id)];
  if (opts.change_type) {
    filters.push("target_type = ?");
    params.push(assertChangeType(opts.change_type));
  }
  const where = `WHERE ${filters.join(" AND ")}`;
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM requirement_relationships ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM requirement_relationships ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: await enrichAsync(db, tenant, rows), total, page: currentPage, page_size: limit, requirement_id: requirement.id, requirement_ref: requirement.requirement_ref, source_module: "requirement-pdm" };
}

export function listChangeRequirements(db, tenantId, changeType, changeId, opts = {}) {
  const tenant = Number(tenantId);
  const type = assertChangeType(changeType);
  const change = requireChange(db, tenant, type, changeId);
  const { limit, offset, page: currentPage } = paginateLinks(opts);
  const where = "WHERE tenant_id = ? AND relationship_type = 'CHANGED_BY' AND target_type = ? AND target_id = ?";
  const params = [tenant, type, String(change.change_id)];
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM requirement_relationships ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM requirement_relationships ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: enrich(db, tenant, rows), total, page: currentPage, page_size: limit, change, source_module: "requirement-pdm" };
}

export async function listChangeRequirementsAsync(db, tenantId, changeType, changeId, opts = {}) {
  const tenant = Number(tenantId);
  const type = assertChangeType(changeType);
  const change = await requireChangeAsync(db, tenant, type, changeId);
  const { limit, offset, page: currentPage } = paginateLinks(opts);
  const where = "WHERE tenant_id = ? AND relationship_type = 'CHANGED_BY' AND target_type = ? AND target_id = ?";
  const params = [tenant, type, String(change.change_id)];
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM requirement_relationships ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM requirement_relationships ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: await enrichAsync(db, tenant, rows), total, page: currentPage, page_size: limit, change, source_module: "requirement-pdm" };
}

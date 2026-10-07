// Requirement Baselines service.
//
// A baseline is a controlled snapshot of requirements at a point in time. It
// stores references to the exact requirement revisions (member rows), never a
// copy of the requirement objects, so a baseline stays small and always
// resolves to the authoritative revision history.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { nextNumber, nextNumberAsync } from "../numbering.js";
import { updateRow, updateRowAsync, bumpVersion } from "./sql.js";
import { publicBaseline, publicBaselineMember, publicRevision } from "./repository.js";
import { baselineRef, revisionRef } from "./refs.js";
import { normalizeBaselineInput, normalizeText, paginate, assertBaselineStatus } from "./validation.js";
import { baselineNotFound, baselineConflict, invalidBaseline, baselineMemberNotFound } from "./errors.js";
import { SOURCE_MODULE, NUMBERING_OBJECT_TYPES } from "./constants.js";
import { requireRequirementRow, requireRequirementRowAsync, getRevisionRow, getRevisionRowAsync } from "./requirements.js";
import { recordRequirementHistory, recordRequirementHistoryAsync } from "./history.js";
import { publishRequirementEvent, publishRequirementEventAsync } from "./events.js";
import { emitObjectIndexChange, emitObjectIndexChangeAsync } from "../search/hooks.js";

function baselineFilters({ tenantId, status, q } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(String(status).toUpperCase());
  }
  if (q) {
    const like = `%${normalizeText(q, { max: 120 })}%`;
    clauses.push("(baseline_number ILIKE ? OR name ILIKE ?)");
    params.push(like, like);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listBaselines(db, opts = {}) {
  const { where, params } = baselineFilters(opts);
  const { limit, offset, page: currentPage } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM requirement_baselines ${where}`, params)?.c || 0);
  const rows = queryAll(
    db,
    `SELECT b.*, (SELECT COUNT(*) FROM requirement_baseline_members m WHERE m.baseline_id = b.id) AS member_count
       FROM requirement_baselines b ${where} ORDER BY b.updated_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { items: rows.map(publicBaseline), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listBaselinesAsync(db, opts = {}) {
  const { where, params } = baselineFilters(opts);
  const { limit, offset, page: currentPage } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM requirement_baselines ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(
    db,
    `SELECT b.*, (SELECT COUNT(*) FROM requirement_baseline_members m WHERE m.baseline_id = b.id) AS member_count
       FROM requirement_baselines b ${where} ORDER BY b.updated_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { items: rows.map(publicBaseline), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function getBaselineRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM requirement_baselines WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOne(db, "SELECT * FROM requirement_baselines WHERE tenant_id = ? AND (baseline_ref = ? OR lower(baseline_number) = lower(?))", [Number(tenantId), String(ref), String(ref)]);
}

export async function getBaselineRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM requirement_baselines WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOneAsync(db, "SELECT * FROM requirement_baselines WHERE tenant_id = ? AND (baseline_ref = ? OR lower(baseline_number) = lower(?))", [Number(tenantId), String(ref), String(ref)]);
}

export function requireBaselineRow(db, tenantId, ref) {
  const row = getBaselineRow(db, tenantId, ref);
  if (!row) throw baselineNotFound(ref);
  return row;
}

export async function requireBaselineRowAsync(db, tenantId, ref) {
  const row = await getBaselineRowAsync(db, tenantId, ref);
  if (!row) throw baselineNotFound(ref);
  return row;
}

export function getBaseline(db, tenantId, ref) {
  const row = requireBaselineRow(db, tenantId, ref);
  const members = queryAll(db, "SELECT * FROM requirement_baseline_members WHERE baseline_id = ? ORDER BY requirement_number", [row.id]);
  return { ...publicBaseline(row), member_count: members.length, members: members.map(publicBaselineMember) };
}

export async function getBaselineAsync(db, tenantId, ref) {
  const row = await requireBaselineRowAsync(db, tenantId, ref);
  const members = await queryAllAsync(db, "SELECT * FROM requirement_baseline_members WHERE baseline_id = ? ORDER BY requirement_number", [row.id]);
  return { ...publicBaseline(row), member_count: members.length, members: members.map(publicBaselineMember) };
}

function insertMember(db, tenant, baseline, requirement, revisionRow, actor) {
  const ts = nowIso();
  run(
    db,
    `INSERT INTO requirement_baseline_members
       (tenant_id, baseline_id, member_type, requirement_id, requirement_number, revision_id, revision, requirement_ref, title, metadata_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenant,
      baseline.id,
      revisionRow ? "REVISION" : "REQUIREMENT",
      requirement.id,
      requirement.requirement_number,
      revisionRow?.id ?? null,
      revisionRow?.revision ?? requirement.revision,
      requirement.requirement_ref,
      requirement.title || requirement.name || "",
      JSON.stringify({ revision_status: revisionRow?.revision_status ?? null }),
      actor?.id ?? null,
      ts,
    ]
  );
}

async function insertMemberAsync(db, tenant, baseline, requirement, revisionRow, actor) {
  const ts = nowIso();
  await runAsync(
    db,
    `INSERT INTO requirement_baseline_members
       (tenant_id, baseline_id, member_type, requirement_id, requirement_number, revision_id, revision, requirement_ref, title, metadata_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenant,
      baseline.id,
      revisionRow ? "REVISION" : "REQUIREMENT",
      requirement.id,
      requirement.requirement_number,
      revisionRow?.id ?? null,
      revisionRow?.revision ?? requirement.revision,
      requirement.requirement_ref,
      requirement.title || requirement.name || "",
      JSON.stringify({ revision_status: revisionRow?.revision_status ?? null }),
      actor?.id ?? null,
      ts,
    ]
  );
}

function resolveMembers(db, tenant, body) {
  if (Array.isArray(body.requirement_ids ?? body.requirementIds) && (body.requirement_ids ?? body.requirementIds).length) {
    const ids = body.requirement_ids ?? body.requirementIds;
    return ids.map((id) => { const row = requireRequirementRow(db, tenant, id); return { requirement: row, revisionRow: getRevisionRow(db, tenant, row.id, row.revision) }; });
  }
  if (body.include_all_released ?? body.includeAllReleased) {
    const rows = queryAll(db, "SELECT * FROM requirements WHERE tenant_id = ? AND status IN ('RELEASED','IMPLEMENTED','VERIFIED','VALIDATED') ORDER BY requirement_number", [tenant]);
    return rows.map((row) => ({ requirement: row, revisionRow: getRevisionRow(db, tenant, row.id, row.revision) }));
  }
  return [];
}

async function resolveMembersAsync(db, tenant, body) {
  if (Array.isArray(body.requirement_ids ?? body.requirementIds) && (body.requirement_ids ?? body.requirementIds).length) {
    const ids = body.requirement_ids ?? body.requirementIds;
    const out = [];
    for (const id of ids) {
      const row = await requireRequirementRowAsync(db, tenant, id);
      out.push({ requirement: row, revisionRow: await getRevisionRowAsync(db, tenant, row.id, row.revision) });
    }
    return out;
  }
  if (body.include_all_released ?? body.includeAllReleased) {
    const rows = await queryAllAsync(db, "SELECT * FROM requirements WHERE tenant_id = ? AND status IN ('RELEASED','IMPLEMENTED','VERIFIED','VALIDATED') ORDER BY requirement_number", [tenant]);
    const out = [];
    for (const row of rows) out.push({ requirement: row, revisionRow: await getRevisionRowAsync(db, tenant, row.id, row.revision) });
    return out;
  }
  return [];
}

export function createBaseline(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeBaselineInput(body, {});
  if (!normalized.name) throw invalidBaseline("name is required");
  const baselineNumber =
    normalizeText(body.baseline_number ?? body.baselineNumber, { max: 60 }) ||
    nextNumber(db, { objectType: NUMBERING_OBJECT_TYPES.BASELINE }, actor, { tenantId: tenant });
  if (!baselineNumber) throw invalidBaseline("Unable to generate a baseline number; register an active REQUIREMENT_BASELINE numbering scheme");
  if (queryOne(db, "SELECT id FROM requirement_baselines WHERE tenant_id = ? AND baseline_number = ?", [tenant, baselineNumber])) {
    throw baselineConflict(baselineNumber);
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO requirement_baselines
       (tenant_id, baseline_ref, organization_id, baseline_number, name, description, baseline_version, owner_user_id, status, baseline_date, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, 1, ?, ?, ?, ?)`,
    [tenant, baselineRef(baselineNumber), normalized.organization_id, baselineNumber, normalized.name, normalized.description, normalized.baseline_version, normalized.owner_user_id, normalized.baseline_date, JSON.stringify(normalized.metadata || {}), actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const baseline = queryOne(db, "SELECT * FROM requirement_baselines WHERE id = ?", [Number(result.lastInsertId)]);
  for (const member of resolveMembers(db, tenant, body)) insertMember(db, tenant, baseline, member.requirement, member.revisionRow, actor);
  recordRequirementHistory(db, { tenantId: tenant, entityType: "BASELINE", entityId: baseline.id, entityRef: baseline.baseline_ref, action: "BASELINE_CREATED", status: "DRAFT", after: publicBaseline(baseline), actor, ip });
  publishRequirementEvent(db, { eventType: "RequirementBaselineCreated", objectId: baseline.id, tenantId: tenant, payload: { baseline_ref: baseline.baseline_ref } }, actor);
  try {
    emitObjectIndexChange(db, { objectType: "requirement_baseline", objectId: baseline.id, operation: "upsert", tenantId: tenant });
  } catch {
    // best effort
  }
  return getBaseline(db, tenant, baseline.id);
}

export async function createBaselineAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeBaselineInput(body, {});
  if (!normalized.name) throw invalidBaseline("name is required");
  const baselineNumber =
    normalizeText(body.baseline_number ?? body.baselineNumber, { max: 60 }) ||
    (await nextNumberAsync(db, { objectType: NUMBERING_OBJECT_TYPES.BASELINE }, actor, { tenantId: tenant }));
  if (!baselineNumber) throw invalidBaseline("Unable to generate a baseline number; register an active REQUIREMENT_BASELINE numbering scheme");
  if (await queryOneAsync(db, "SELECT id FROM requirement_baselines WHERE tenant_id = ? AND baseline_number = ?", [tenant, baselineNumber])) {
    throw baselineConflict(baselineNumber);
  }
  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO requirement_baselines
       (tenant_id, baseline_ref, organization_id, baseline_number, name, description, baseline_version, owner_user_id, status, baseline_date, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, 1, ?, ?, ?, ?)`,
    [tenant, baselineRef(baselineNumber), normalized.organization_id, baselineNumber, normalized.name, normalized.description, normalized.baseline_version, normalized.owner_user_id, normalized.baseline_date, JSON.stringify(normalized.metadata || {}), actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const baseline = await queryOneAsync(db, "SELECT * FROM requirement_baselines WHERE id = ?", [Number(result.lastInsertId)]);
  for (const member of await resolveMembersAsync(db, tenant, body)) await insertMemberAsync(db, tenant, baseline, member.requirement, member.revisionRow, actor);
  await recordRequirementHistoryAsync(db, { tenantId: tenant, entityType: "BASELINE", entityId: baseline.id, entityRef: baseline.baseline_ref, action: "BASELINE_CREATED", status: "DRAFT", after: publicBaseline(baseline), actor, ip });
  await publishRequirementEventAsync(db, { eventType: "RequirementBaselineCreated", objectId: baseline.id, tenantId: tenant, payload: { baseline_ref: baseline.baseline_ref } }, actor);
  try {
    await emitObjectIndexChangeAsync(db, { objectType: "requirement_baseline", objectId: baseline.id, operation: "upsert", tenantId: tenant });
  } catch {
    // best effort
  }
  return getBaselineAsync(db, tenant, baseline.id);
}

export function addBaselineMember(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const baseline = requireBaselineRow(db, tenant, ref);
  if (baseline.status !== "DRAFT") throw invalidBaseline("Members can only be added to a DRAFT baseline", { status: baseline.status });
  const requirement = requireRequirementRow(db, tenant, body.requirement_id ?? body.requirementId);
  const revisionCode = normalizeText(body.revision ?? requirement.revision, { max: 8 }).toUpperCase();
  const revisionRow = getRevisionRow(db, tenant, requirement.id, revisionCode);
  if (!revisionRow) throw invalidBaseline(`Revision ${revisionCode} not found for ${requirement.requirement_ref}`);
  const dup = queryOne(db, "SELECT id FROM requirement_baseline_members WHERE baseline_id = ? AND requirement_id = ? AND revision = ?", [baseline.id, requirement.id, revisionCode]);
  if (dup) throw baselineConflict(`${requirement.requirement_ref} ${revisionCode}`);
  insertMember(db, tenant, baseline, requirement, revisionRow, actor);
  const member = queryOne(db, "SELECT * FROM requirement_baseline_members WHERE baseline_id = ? AND requirement_id = ? AND revision = ?", [baseline.id, requirement.id, revisionCode]);
  return publicBaselineMember(member);
}

export async function addBaselineMemberAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const baseline = await requireBaselineRowAsync(db, tenant, ref);
  if (baseline.status !== "DRAFT") throw invalidBaseline("Members can only be added to a DRAFT baseline", { status: baseline.status });
  const requirement = await requireRequirementRowAsync(db, tenant, body.requirement_id ?? body.requirementId);
  const revisionCode = normalizeText(body.revision ?? requirement.revision, { max: 8 }).toUpperCase();
  const revisionRow = await getRevisionRowAsync(db, tenant, requirement.id, revisionCode);
  if (!revisionRow) throw invalidBaseline(`Revision ${revisionCode} not found for ${requirement.requirement_ref}`);
  const dup = await queryOneAsync(db, "SELECT id FROM requirement_baseline_members WHERE baseline_id = ? AND requirement_id = ? AND revision = ?", [baseline.id, requirement.id, revisionCode]);
  if (dup) throw baselineConflict(`${requirement.requirement_ref} ${revisionCode}`);
  await insertMemberAsync(db, tenant, baseline, requirement, revisionRow, actor);
  const member = await queryOneAsync(db, "SELECT * FROM requirement_baseline_members WHERE baseline_id = ? AND requirement_id = ? AND revision = ?", [baseline.id, requirement.id, revisionCode]);
  return publicBaselineMember(member);
}

export function removeBaselineMember(db, tenantId, ref, memberRef, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const baseline = requireBaselineRow(db, tenant, ref);
  if (baseline.status !== "DRAFT") throw invalidBaseline("Members can only be removed from a DRAFT baseline", { status: baseline.status });
  const member = queryOne(db, "SELECT * FROM requirement_baseline_members WHERE id = ? AND baseline_id = ?", [Number(memberRef), baseline.id]);
  if (!member) throw baselineMemberNotFound(memberRef);
  run(db, "DELETE FROM requirement_baseline_members WHERE id = ?", [member.id]);
  return { deleted: true, member_id: member.id };
}

export async function removeBaselineMemberAsync(db, tenantId, ref, memberRef, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const baseline = await requireBaselineRowAsync(db, tenant, ref);
  if (baseline.status !== "DRAFT") throw invalidBaseline("Members can only be removed from a DRAFT baseline", { status: baseline.status });
  const member = await queryOneAsync(db, "SELECT * FROM requirement_baseline_members WHERE id = ? AND baseline_id = ?", [Number(memberRef), baseline.id]);
  if (!member) throw baselineMemberNotFound(memberRef);
  await runAsync(db, "DELETE FROM requirement_baseline_members WHERE id = ?", [member.id]);
  return { deleted: true, member_id: member.id };
}

export function releaseBaseline(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const baseline = requireBaselineRow(db, tenant, ref);
  if (baseline.status !== "DRAFT") throw invalidBaseline(`Baseline ${baseline.baseline_ref} is already ${baseline.status}`, { status: baseline.status });
  const members = queryOne(db, "SELECT COUNT(*) AS c FROM requirement_baseline_members WHERE baseline_id = ?", [baseline.id]);
  if (Number(members?.c || 0) === 0) throw invalidBaseline("A baseline must have at least one member before it can be released");
  const ts = nowIso();
  updateRow(db, "requirement_baselines", baseline.id, { status: "RELEASED", released_at: ts, released_by: actor?.id ?? null, version: bumpVersion(baseline), updated_by: actor?.id ?? null }, { columns: ["status", "released_at", "released_by", "version", "updated_by"] });
  const updated = queryOne(db, "SELECT * FROM requirement_baselines WHERE id = ?", [baseline.id]);
  recordRequirementHistory(db, { tenantId: tenant, entityType: "BASELINE", entityId: baseline.id, entityRef: baseline.baseline_ref, action: "BASELINE_RELEASED", status: "RELEASED", before: { status: baseline.status }, after: { status: "RELEASED" }, actor, ip });
  publishRequirementEvent(db, { eventType: "RequirementBaselineReleased", objectId: baseline.id, tenantId: tenant, payload: { baseline_ref: baseline.baseline_ref } }, actor);
  return publicBaseline(updated);
}

export async function releaseBaselineAsync(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const baseline = await requireBaselineRowAsync(db, tenant, ref);
  if (baseline.status !== "DRAFT") throw invalidBaseline(`Baseline ${baseline.baseline_ref} is already ${baseline.status}`, { status: baseline.status });
  const members = await queryOneAsync(db, "SELECT COUNT(*) AS c FROM requirement_baseline_members WHERE baseline_id = ?", [baseline.id]);
  if (Number(members?.c || 0) === 0) throw invalidBaseline("A baseline must have at least one member before it can be released");
  const ts = nowIso();
  await updateRowAsync(db, "requirement_baselines", baseline.id, { status: "RELEASED", released_at: ts, released_by: actor?.id ?? null, version: bumpVersion(baseline), updated_by: actor?.id ?? null }, { columns: ["status", "released_at", "released_by", "version", "updated_by"] });
  const updated = await queryOneAsync(db, "SELECT * FROM requirement_baselines WHERE id = ?", [baseline.id]);
  await recordRequirementHistoryAsync(db, { tenantId: tenant, entityType: "BASELINE", entityId: baseline.id, entityRef: baseline.baseline_ref, action: "BASELINE_RELEASED", status: "RELEASED", before: { status: baseline.status }, after: { status: "RELEASED" }, actor, ip });
  await publishRequirementEventAsync(db, { eventType: "RequirementBaselineReleased", objectId: baseline.id, tenantId: tenant, payload: { baseline_ref: baseline.baseline_ref } }, actor);
  return publicBaseline(updated);
}

// Compare each member's pinned revision against the requirement's current revision.
export function compareBaseline(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const baseline = requireBaselineRow(db, tenant, ref);
  const members = queryAll(db, "SELECT * FROM requirement_baseline_members WHERE baseline_id = ? ORDER BY requirement_number", [baseline.id]);
  const changes = [];
  for (const member of members) {
    const current = queryOne(db, "SELECT revision, status, title, updated_at FROM requirements WHERE id = ? AND tenant_id = ?", [member.requirement_id, tenant]);
    if (!current) {
      changes.push({ requirement_id: member.requirement_id, requirement_ref: member.requirement_ref, change: "REMOVED", baseline_revision: member.revision, current_revision: null });
      continue;
    }
    if (String(current.revision) !== String(member.revision)) {
      changes.push({ requirement_id: member.requirement_id, requirement_ref: member.requirement_ref, change: "REVISED", baseline_revision: member.revision, current_revision: current.revision, current_status: current.status });
    } else if (String(current.title || "") !== String(member.title || "")) {
      changes.push({ requirement_id: member.requirement_id, requirement_ref: member.requirement_ref, change: "MODIFIED", baseline_revision: member.revision, current_revision: current.revision, current_status: current.status });
    }
  }
  return { baseline: publicBaseline(baseline), member_count: members.length, differences: changes, in_sync: changes.length === 0, source_module: SOURCE_MODULE };
}

export async function compareBaselineAsync(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const baseline = await requireBaselineRowAsync(db, tenant, ref);
  const members = await queryAllAsync(db, "SELECT * FROM requirement_baseline_members WHERE baseline_id = ? ORDER BY requirement_number", [baseline.id]);
  const changes = [];
  for (const member of members) {
    const current = await queryOneAsync(db, "SELECT revision, status, title, updated_at FROM requirements WHERE id = ? AND tenant_id = ?", [member.requirement_id, tenant]);
    if (!current) {
      changes.push({ requirement_id: member.requirement_id, requirement_ref: member.requirement_ref, change: "REMOVED", baseline_revision: member.revision, current_revision: null });
      continue;
    }
    if (String(current.revision) !== String(member.revision)) {
      changes.push({ requirement_id: member.requirement_id, requirement_ref: member.requirement_ref, change: "REVISED", baseline_revision: member.revision, current_revision: current.revision, current_status: current.status });
    } else if (String(current.title || "") !== String(member.title || "")) {
      changes.push({ requirement_id: member.requirement_id, requirement_ref: member.requirement_ref, change: "MODIFIED", baseline_revision: member.revision, current_revision: current.revision, current_status: current.status });
    }
  }
  return { baseline: publicBaseline(baseline), member_count: members.length, differences: changes, in_sync: changes.length === 0, source_module: SOURCE_MODULE };
}

export function listBaselineMembers(db, tenantId, ref) {
  const baseline = requireBaselineRow(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM requirement_baseline_members WHERE baseline_id = ? ORDER BY requirement_number", [baseline.id]);
  return { items: rows.map(publicBaselineMember), total: rows.length, requirement_id: baseline.id, source_module: SOURCE_MODULE };
}

export async function listBaselineMembersAsync(db, tenantId, ref) {
  const baseline = await requireBaselineRowAsync(db, tenantId, ref);
  const rows = await queryAllAsync(db, "SELECT * FROM requirement_baseline_members WHERE baseline_id = ? ORDER BY requirement_number", [baseline.id]);
  return { items: rows.map(publicBaselineMember), total: rows.length, requirement_id: baseline.id, source_module: SOURCE_MODULE };
}

export { publicRevision };

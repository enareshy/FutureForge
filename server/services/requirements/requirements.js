// Requirement service: the core Requirements Manager business object.
//
// A Requirement is a separately revision-controlled, hierarchical business
// object. Numbers come from the shared Numbering & Identifier Service (never
// hard-coded); status transitions are data-driven and validated; every write
// is recorded in the domain history and the centralized Audit framework, and
// emits a domain event plus a best-effort search index change (mirrors
// server/services/change/orders.js).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { nextNumber, nextNumberAsync } from "../numbering.js";
import { updateRow, updateRowAsync, assertVersion, bumpVersion } from "./sql.js";
import { publicRequirement, publicRevision } from "./repository.js";
import { requirementRef, revisionRef } from "./refs.js";
import { recordRequirementHistory, recordRequirementHistoryAsync, listHistory, listHistoryAsync } from "./history.js";
import { publishRequirementEvent, publishRequirementEventAsync } from "./events.js";
import {
  normalizeRequirementInput,
  normalizeText,
  paginate,
  assertRequirementTransition,
  nextRevision,
  assertRevisionCode,
  parseObject,
} from "./validation.js";
import {
  requirementNotFound,
  requirementConflict,
  invalidRequirement,
  requirementImmutable,
  validationFailed,
  requirementsConflict,
  revisionNotFound,
  revisionConflict,
  hierarchyCycle,
} from "./errors.js";
import { SOURCE_MODULE, NUMBERING_OBJECT_TYPES, IMMUTABLE_STATUSES } from "./constants.js";
import { requireTypeRow, requireTypeRowAsync } from "./types.js";
import { getConfig, getConfigAsync } from "./configuration.js";
import { emitObjectIndexChange, emitObjectIndexChangeAsync } from "../search/hooks.js";

const UPDATE_COLUMNS = [
  "title",
  "name",
  "description",
  "requirement_type",
  "category",
  "source",
  "external_reference",
  "domain",
  "discipline",
  "priority",
  "criticality",
  "classification",
  "tags_json",
  "owner_user_id",
  "responsible_user_id",
  "responsible_group_id",
  "organization_id",
  "business_unit_id",
  "site_id",
  "parent_id",
  "effective_from",
  "effective_to",
  "metadata_json",
  "updated_by",
];

async function indexChange(db, operation, row, tenantId) {
  try {
    await emitObjectIndexChangeAsync(db, {
      objectType: "requirement",
      objectId: row.id,
      operation,
      tenantId: Number(tenantId),
      correlationId: row.requirement_ref || "",
    });
  } catch {
    // Search indexing must never fail the business write.
  }
}

function indexChangeSync(db, operation, row, tenantId) {
  try {
    emitObjectIndexChange(db, {
      objectType: "requirement",
      objectId: row.id,
      operation,
      tenantId: Number(tenantId),
      correlationId: row.requirement_ref || "",
    });
  } catch {
    // Search indexing must never fail the business write.
  }
}

function requirementFilters({ tenantId, status, requirement_type, owner_user_id, organization_id, site_id, priority, criticality, q, tag, parent_id } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status, { max: 20 }).toUpperCase());
  }
  if (requirement_type) {
    clauses.push("requirement_type = ?");
    params.push(normalizeText(requirement_type, { max: 64 }).toLowerCase());
  }
  if (owner_user_id) {
    clauses.push("owner_user_id = ?");
    params.push(Number(owner_user_id));
  }
  if (organization_id) {
    clauses.push("organization_id = ?");
    params.push(Number(organization_id));
  }
  if (site_id) {
    clauses.push("site_id = ?");
    params.push(Number(site_id));
  }
  if (priority) {
    clauses.push("priority = ?");
    params.push(normalizeText(priority, { max: 20 }).toUpperCase());
  }
  if (criticality) {
    clauses.push("criticality = ?");
    params.push(normalizeText(criticality, { max: 20 }).toUpperCase());
  }
  if (parent_id !== undefined && parent_id !== null && parent_id !== "") {
    clauses.push("parent_id = ?");
    params.push(Number(parent_id));
  }
  if (tag) {
    clauses.push("tags_json ILIKE ?");
    params.push(`%${normalizeText(tag, { max: 60 })}%`);
  }
  if (q) {
    const like = `%${normalizeText(q, { max: 120 })}%`;
    clauses.push("(requirement_number ILIKE ? OR title ILIKE ? OR name ILIKE ? OR description ILIKE ?)");
    params.push(like, like, like, like);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function getRequirementRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM requirements WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(
    db,
    "SELECT * FROM requirements WHERE tenant_id = ? AND (requirement_ref = ? OR lower(requirement_number) = lower(?))",
    [Number(tenantId), String(ref), String(ref)]
  );
}

export async function getRequirementRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = await queryOneAsync(db, "SELECT * FROM requirements WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOneAsync(
    db,
    "SELECT * FROM requirements WHERE tenant_id = ? AND (requirement_ref = ? OR lower(requirement_number) = lower(?))",
    [Number(tenantId), String(ref), String(ref)]
  );
}

export function requireRequirementRow(db, tenantId, ref) {
  const row = getRequirementRow(db, tenantId, ref);
  if (!row) throw requirementNotFound(ref);
  return row;
}

export async function requireRequirementRowAsync(db, tenantId, ref) {
  const row = await getRequirementRowAsync(db, tenantId, ref);
  if (!row) throw requirementNotFound(ref);
  return row;
}

export function getRequirement(db, tenantId, ref) {
  return publicRequirement(requireRequirementRow(db, tenantId, ref));
}

export async function getRequirementAsync(db, tenantId, ref) {
  return publicRequirement(await requireRequirementRowAsync(db, tenantId, ref));
}

export function listRequirements(db, opts = {}) {
  const { where, params } = requirementFilters(opts);
  const { limit, offset, page: currentPage } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM requirements ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM requirements ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRequirement), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listRequirementsAsync(db, opts = {}) {
  const { where, params } = requirementFilters(opts);
  const { limit, offset, page: currentPage } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM requirements ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM requirements ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRequirement), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

// ── Hierarchy helpers ────────────────────────────────────────────────────────

function wouldCreateCycle(db, tenantId, requirementId, parentId) {
  let cursor = parentId;
  const seen = new Set();
  while (cursor) {
    if (Number(cursor) === Number(requirementId)) return true;
    if (seen.has(Number(cursor))) return true;
    seen.add(Number(cursor));
    const parent = queryOne(db, "SELECT parent_id FROM requirements WHERE id = ? AND tenant_id = ?", [Number(cursor), Number(tenantId)]);
    cursor = parent?.parent_id ?? null;
  }
  return false;
}

async function wouldCreateCycleAsync(db, tenantId, requirementId, parentId) {
  let cursor = parentId;
  const seen = new Set();
  while (cursor) {
    if (Number(cursor) === Number(requirementId)) return true;
    if (seen.has(Number(cursor))) return true;
    seen.add(Number(cursor));
    const parent = await queryOneAsync(db, "SELECT parent_id FROM requirements WHERE id = ? AND tenant_id = ?", [Number(cursor), Number(tenantId)]);
    cursor = parent?.parent_id ?? null;
  }
  return false;
}

export function listChildren(db, tenantId, requirementId) {
  const tenant = Number(tenantId);
  const parent = requireRequirementRow(db, tenant, requirementId);
  const rows = queryAll(db, "SELECT * FROM requirements WHERE tenant_id = ? AND parent_id = ? ORDER BY requirement_number", [tenant, parent.id]);
  return rows.map(publicRequirement);
}

export async function listChildrenAsync(db, tenantId, requirementId) {
  const tenant = Number(tenantId);
  const parent = await requireRequirementRowAsync(db, tenant, requirementId);
  const rows = await queryAllAsync(db, "SELECT * FROM requirements WHERE tenant_id = ? AND parent_id = ? ORDER BY requirement_number", [tenant, parent.id]);
  return rows.map(publicRequirement);
}

// ── Create / update / delete ─────────────────────────────────────────────────

export function createRequirement(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeRequirementInput(body, {});
  if (!normalized.title && !normalized.name) throw invalidRequirement("title is required");
  const typeCode = normalized.requirement_type;
  if (!typeCode) throw invalidRequirement("requirement_type is required");
  requireTypeRow(db, tenant, typeCode);

  const requirementNumber =
    normalizeText(body.requirement_number ?? body.requirementNumber, { max: 60 }) ||
    nextNumber(db, { objectType: NUMBERING_OBJECT_TYPES.REQUIREMENT }, actor, { tenantId: tenant });
  if (!requirementNumber) throw invalidRequirement("Unable to generate a requirement number; register an active REQUIREMENT numbering scheme");
  if (queryOne(db, "SELECT id FROM requirements WHERE tenant_id = ? AND requirement_number = ?", [tenant, requirementNumber])) {
    throw requirementConflict(requirementNumber);
  }

  const parentId = normalized.parent_id;
  if (parentId) requireRequirementRow(db, tenant, parentId);

  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO requirements
       (requirement_ref, tenant_id, organization_id, business_unit_id, site_id, requirement_number, external_reference,
        name, title, description, requirement_type, category, source, domain, discipline, priority, criticality, classification, tags_json,
        owner_user_id, responsible_user_id, responsible_group_id, parent_id, revision, version, status, lifecycle_state,
        quality_status, completeness_status, verification_status, validation_status, traceability_status,
        effective_from, effective_to, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'DRAFT', 'DRAFT',
             'INCOMPLETE', 'INCOMPLETE', 'NOT_VERIFIED', 'NOT_VALIDATED', 'UNTRACED', ?, ?, ?, ?, ?, ?, ?)`,
    [
      requirementRef(requirementNumber),
      tenant,
      normalized.organization_id,
      normalized.business_unit_id,
      normalized.site_id,
      requirementNumber,
      normalized.external_reference,
      normalized.name,
      normalized.title,
      normalized.description,
      typeCode,
      normalized.category,
      normalized.source,
      normalized.domain,
      normalized.discipline,
      normalized.priority,
      normalized.criticality,
      normalized.classification,
      JSON.stringify(normalized.tags || []),
      normalized.owner_user_id,
      normalized.responsible_user_id,
      normalized.responsible_group_id,
      parentId,
      getConfig(db, tenant, "default_revision") || "A",
      normalized.effective_from,
      normalized.effective_to,
      JSON.stringify(normalized.metadata || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [Number(result.lastInsertId)]);
  createRevisionRow(db, tenant, row, { revisionStatus: "WORKING", changeReason: "Initial revision", actor });
  recordRequirementHistory(db, {
    tenantId: tenant,
    organizationId: row.organization_id,
    entityType: "REQUIREMENT",
    entityId: row.id,
    entityRef: row.requirement_ref,
    action: "CREATED",
    version: row.version,
    status: row.status,
    after: publicRequirement(row),
    actor,
    ip,
  });
  publishRequirementEvent(db, { eventType: "RequirementCreated", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { requirement_ref: row.requirement_ref, requirement_number: row.requirement_number } }, actor);
  indexChangeSync(db, "upsert", row, tenant);
  return publicRequirement(row);
}

export async function createRequirementAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeRequirementInput(body, {});
  if (!normalized.title && !normalized.name) throw invalidRequirement("title is required");
  const typeCode = normalized.requirement_type;
  if (!typeCode) throw invalidRequirement("requirement_type is required");
  await requireTypeRowAsync(db, tenant, typeCode);

  const requirementNumber =
    normalizeText(body.requirement_number ?? body.requirementNumber, { max: 60 }) ||
    (await nextNumberAsync(db, { objectType: NUMBERING_OBJECT_TYPES.REQUIREMENT }, actor, { tenantId: tenant }));
  if (!requirementNumber) throw invalidRequirement("Unable to generate a requirement number; register an active REQUIREMENT numbering scheme");
  if (await queryOneAsync(db, "SELECT id FROM requirements WHERE tenant_id = ? AND requirement_number = ?", [tenant, requirementNumber])) {
    throw requirementConflict(requirementNumber);
  }

  const parentId = normalized.parent_id;
  if (parentId) await requireRequirementRowAsync(db, tenant, parentId);

  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO requirements
       (requirement_ref, tenant_id, organization_id, business_unit_id, site_id, requirement_number, external_reference,
        name, title, description, requirement_type, category, source, domain, discipline, priority, criticality, classification, tags_json,
        owner_user_id, responsible_user_id, responsible_group_id, parent_id, revision, version, status, lifecycle_state,
        quality_status, completeness_status, verification_status, validation_status, traceability_status,
        effective_from, effective_to, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'DRAFT', 'DRAFT',
             'INCOMPLETE', 'INCOMPLETE', 'NOT_VERIFIED', 'NOT_VALIDATED', 'UNTRACED', ?, ?, ?, ?, ?, ?, ?)`,
    [
      requirementRef(requirementNumber),
      tenant,
      normalized.organization_id,
      normalized.business_unit_id,
      normalized.site_id,
      requirementNumber,
      normalized.external_reference,
      normalized.name,
      normalized.title,
      normalized.description,
      typeCode,
      normalized.category,
      normalized.source,
      normalized.domain,
      normalized.discipline,
      normalized.priority,
      normalized.criticality,
      normalized.classification,
      JSON.stringify(normalized.tags || []),
      normalized.owner_user_id,
      normalized.responsible_user_id,
      normalized.responsible_group_id,
      parentId,
      (await getConfigAsync(db, tenant, "default_revision")) || "A",
      normalized.effective_from,
      normalized.effective_to,
      JSON.stringify(normalized.metadata || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = await queryOneAsync(db, "SELECT * FROM requirements WHERE id = ?", [Number(result.lastInsertId)]);
  await createRevisionRowAsync(db, tenant, row, { revisionStatus: "WORKING", changeReason: "Initial revision", actor });
  await recordRequirementHistoryAsync(db, {
    tenantId: tenant,
    organizationId: row.organization_id,
    entityType: "REQUIREMENT",
    entityId: row.id,
    entityRef: row.requirement_ref,
    action: "CREATED",
    version: row.version,
    status: row.status,
    after: publicRequirement(row),
    actor,
    ip,
  });
  await publishRequirementEventAsync(db, { eventType: "RequirementCreated", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { requirement_ref: row.requirement_ref, requirement_number: row.requirement_number } }, actor);
  await indexChange(db, "upsert", row, tenant);
  return publicRequirement(row);
}

function applyUpdate(db, tenant, row, body, actor, ip, { async: isAsync = false } = {}) {
  if (IMMUTABLE_STATUSES.includes(row.status)) throw requirementImmutable(row.requirement_ref, row.status);
  assertVersion(row, body.version ?? body.expected_version, (details) => requirementsConflict(`Requirement ${row.requirement_number} was modified by another user`, details));
  const normalized = normalizeRequirementInput(body, row);
  if (normalized.requirement_type !== row.requirement_type) {
    if (isAsync) {
      // validated by caller
    } else {
      requireTypeRow(db, tenant, normalized.requirement_type);
    }
  }
  const parentId = normalized.parent_id;
  if (parentId && Number(parentId) !== Number(row.parent_id ?? 0)) {
    if (Number(parentId) === Number(row.id)) throw hierarchyCycle({ reason: "self_parent" });
  }
  const before = publicRequirement(row);
  const patch = {
    title: normalized.title,
    name: normalized.name,
    description: normalized.description,
    requirement_type: normalized.requirement_type,
    category: normalized.category,
    source: normalized.source,
    external_reference: normalized.external_reference,
    domain: normalized.domain,
    discipline: normalized.discipline,
    priority: normalized.priority,
    criticality: normalized.criticality,
    classification: normalized.classification,
    tags_json: JSON.stringify(normalized.tags || []),
    owner_user_id: normalized.owner_user_id,
    responsible_user_id: normalized.responsible_user_id,
    responsible_group_id: normalized.responsible_group_id,
    organization_id: normalized.organization_id,
    business_unit_id: normalized.business_unit_id,
    site_id: normalized.site_id,
    parent_id: normalized.parent_id,
    effective_from: normalized.effective_from,
    effective_to: normalized.effective_to,
    metadata_json: JSON.stringify(normalized.metadata || {}),
    version: bumpVersion(row),
    updated_by: actor?.id ?? null,
  };
  return { before, patch, normalized };
}

export function updateRequirement(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRequirementRow(db, tenant, ref);
  if (IMMUTABLE_STATUSES.includes(row.status)) throw requirementImmutable(row.requirement_ref, row.status);
  const normalizedType = normalizeText(body.requirement_type ?? body.requirementType ?? row.requirement_type, { max: 64 }).toLowerCase();
  if (normalizedType !== row.requirement_type) requireTypeRow(db, tenant, normalizedType);
  const parentId = body.parent_id ?? body.parentId;
  if (parentId !== undefined && parentId !== null && Number(parentId) !== Number(row.parent_id ?? 0)) {
    if (Number(parentId) === Number(row.id)) throw hierarchyCycle({ reason: "self_parent" });
    if (wouldCreateCycle(db, tenant, row.id, parentId)) throw hierarchyCycle({ requirement_id: row.id, parent_id: parentId });
    if (parentId) requireRequirementRow(db, tenant, parentId);
  }
  const { before, patch } = applyUpdate(db, tenant, row, body, actor, ip);
  updateRow(db, "requirements", row.id, patch, { columns: UPDATE_COLUMNS });
  const updated = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [row.id]);
  recordRequirementHistory(db, { tenantId: tenant, organizationId: updated.organization_id, entityType: "REQUIREMENT", entityId: row.id, entityRef: row.requirement_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicRequirement(updated), actor, ip });
  publishRequirementEvent(db, { eventType: "RequirementUpdated", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { requirement_ref: row.requirement_ref } }, actor);
  indexChangeSync(db, "upsert", updated, tenant);
  return publicRequirement(updated);
}

export async function updateRequirementAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireRequirementRowAsync(db, tenant, ref);
  if (IMMUTABLE_STATUSES.includes(row.status)) throw requirementImmutable(row.requirement_ref, row.status);
  const normalizedType = normalizeText(body.requirement_type ?? body.requirementType ?? row.requirement_type, { max: 64 }).toLowerCase();
  if (normalizedType !== row.requirement_type) await requireTypeRowAsync(db, tenant, normalizedType);
  const parentId = body.parent_id ?? body.parentId;
  if (parentId !== undefined && parentId !== null && Number(parentId) !== Number(row.parent_id ?? 0)) {
    if (Number(parentId) === Number(row.id)) throw hierarchyCycle({ reason: "self_parent" });
    if (await wouldCreateCycleAsync(db, tenant, row.id, parentId)) throw hierarchyCycle({ requirement_id: row.id, parent_id: parentId });
    if (parentId) await requireRequirementRowAsync(db, tenant, parentId);
  }
  const { before, patch } = applyUpdate(db, tenant, row, body, actor, ip, { async: true });
  await updateRowAsync(db, "requirements", row.id, patch, { columns: UPDATE_COLUMNS });
  const updated = await queryOneAsync(db, "SELECT * FROM requirements WHERE id = ?", [row.id]);
  await recordRequirementHistoryAsync(db, { tenantId: tenant, organizationId: updated.organization_id, entityType: "REQUIREMENT", entityId: row.id, entityRef: row.requirement_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicRequirement(updated), actor, ip });
  await publishRequirementEventAsync(db, { eventType: "RequirementUpdated", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { requirement_ref: row.requirement_ref } }, actor);
  await indexChange(db, "upsert", updated, tenant);
  return publicRequirement(updated);
}

const DELETABLE_STATUSES = ["DRAFT", "REJECTED", "WITHDRAWN"];

export function deleteRequirement(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRequirementRow(db, tenant, ref);
  if (!DELETABLE_STATUSES.includes(row.status)) throw requirementImmutable(row.requirement_ref, row.status);
  const hasChildren = queryOne(db, "SELECT id FROM requirements WHERE tenant_id = ? AND parent_id = ? LIMIT 1", [tenant, row.id]);
  if (hasChildren) throw requirementsConflict("Remove or re-parent child requirements before deleting this requirement", { requirement_id: row.id });
  const before = publicRequirement(row);
  run(db, "DELETE FROM requirement_relationships WHERE tenant_id = ? AND (source_id = ? OR target_id = ?)", [tenant, String(row.id), String(row.id)]);
  run(db, "DELETE FROM requirement_revisions WHERE requirement_id = ?", [row.id]);
  run(db, "DELETE FROM requirements WHERE id = ?", [row.id]);
  recordRequirementHistory(db, { tenantId: tenant, entityType: "REQUIREMENT", entityId: row.id, entityRef: row.requirement_ref, action: "DELETED", version: row.version, status: row.status, before, actor, ip });
  publishRequirementEvent(db, { eventType: "RequirementUpdated", objectId: row.id, tenantId: tenant, payload: { requirement_ref: row.requirement_ref, deleted: true } }, actor);
  indexChangeSync(db, "delete", row, tenant);
  return { deleted: true, requirement_ref: row.requirement_ref };
}

export async function deleteRequirementAsync(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireRequirementRowAsync(db, tenant, ref);
  if (!DELETABLE_STATUSES.includes(row.status)) throw requirementImmutable(row.requirement_ref, row.status);
  const hasChildren = await queryOneAsync(db, "SELECT id FROM requirements WHERE tenant_id = ? AND parent_id = ? LIMIT 1", [tenant, row.id]);
  if (hasChildren) throw requirementsConflict("Remove or re-parent child requirements before deleting this requirement", { requirement_id: row.id });
  const before = publicRequirement(row);
  await runAsync(db, "DELETE FROM requirement_relationships WHERE tenant_id = ? AND (source_id = ? OR target_id = ?)", [tenant, String(row.id), String(row.id)]);
  await runAsync(db, "DELETE FROM requirement_revisions WHERE requirement_id = ?", [row.id]);
  await runAsync(db, "DELETE FROM requirements WHERE id = ?", [row.id]);
  await recordRequirementHistoryAsync(db, { tenantId: tenant, entityType: "REQUIREMENT", entityId: row.id, entityRef: row.requirement_ref, action: "DELETED", version: row.version, status: row.status, before, actor, ip });
  await publishRequirementEventAsync(db, { eventType: "RequirementUpdated", objectId: row.id, tenantId: tenant, payload: { requirement_ref: row.requirement_ref, deleted: true } }, actor);
  await indexChange(db, "delete", row, tenant);
  return { deleted: true, requirement_ref: row.requirement_ref };
}

// ── Revisions ────────────────────────────────────────────────────────────────

function snapshotOf(row) {
  return {
    title: row.title,
    name: row.name,
    description: row.description,
    requirement_type: row.requirement_type,
    category: row.category,
    source: row.source,
    domain: row.domain,
    discipline: row.discipline,
    priority: row.priority,
    criticality: row.criticality,
    classification: row.classification,
    tags: parseObject(row.tags_json, []),
    owner_user_id: row.owner_user_id ?? null,
    metadata: parseObject(row.metadata_json, {}),
  };
}

function createRevisionRow(db, tenant, row, { revisionStatus = "WORKING", changeReason = "", changeRef = null, revision = null, actor = null } = {}) {
  const rev = revision || row.revision || "A";
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO requirement_revisions
       (tenant_id, organization_id, requirement_id, requirement_number, revision, revision_status, title, description,
        change_reason, change_ref, snapshot_json, effective_from, effective_to, version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [
      tenant,
      row.organization_id,
      row.id,
      row.requirement_number,
      rev,
      revisionStatus,
      row.title,
      row.description,
      changeReason,
      changeRef,
      JSON.stringify(snapshotOf(row)),
      row.effective_from,
      row.effective_to,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  return Number(result.lastInsertId);
}

async function createRevisionRowAsync(db, tenant, row, { revisionStatus = "WORKING", changeReason = "", changeRef = null, revision = null, actor = null } = {}) {
  const rev = revision || row.revision || "A";
  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO requirement_revisions
       (tenant_id, organization_id, requirement_id, requirement_number, revision, revision_status, title, description,
        change_reason, change_ref, snapshot_json, effective_from, effective_to, version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [
      tenant,
      row.organization_id,
      row.id,
      row.requirement_number,
      rev,
      revisionStatus,
      row.title,
      row.description,
      changeReason,
      changeRef,
      JSON.stringify(snapshotOf(row)),
      row.effective_from,
      row.effective_to,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  return Number(result.lastInsertId);
}

export function listRevisions(db, tenantId, ref) {
  const requirement = requireRequirementRow(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM requirement_revisions WHERE requirement_id = ? ORDER BY id", [requirement.id]);
  return { items: rows.map(publicRevision), total: rows.length, requirement_id: requirement.id, source_module: SOURCE_MODULE };
}

export async function listRevisionsAsync(db, tenantId, ref) {
  const requirement = await requireRequirementRowAsync(db, tenantId, ref);
  const rows = await queryAllAsync(db, "SELECT * FROM requirement_revisions WHERE requirement_id = ? ORDER BY id", [requirement.id]);
  return { items: rows.map(publicRevision), total: rows.length, requirement_id: requirement.id, source_module: SOURCE_MODULE };
}

export function getRevisionRow(db, tenantId, ref, revision) {
  const requirement = getRequirementRow(db, tenantId, ref);
  if (!requirement) return null;
  const rev = assertRevisionCode(revision);
  return queryOne(db, "SELECT * FROM requirement_revisions WHERE requirement_id = ? AND revision = ?", [requirement.id, rev]);
}

export async function getRevisionRowAsync(db, tenantId, ref, revision) {
  const requirement = await getRequirementRowAsync(db, tenantId, ref);
  if (!requirement) return null;
  const rev = assertRevisionCode(revision);
  return queryOneAsync(db, "SELECT * FROM requirement_revisions WHERE requirement_id = ? AND revision = ?", [requirement.id, rev]);
}

export function compareRevisions(db, tenantId, ref, fromRev, toRev) {
  const from = getRevisionRow(db, tenantId, ref, fromRev);
  const to = getRevisionRow(db, tenantId, ref, toRev);
  if (!from || !to) throw revisionNotFound(!from ? fromRev : toRev);
  const before = parseObject(from.snapshot_json, {});
  const after = parseObject(to.snapshot_json, {});
  const changed = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const a = JSON.stringify(before[key] ?? null);
    const b = JSON.stringify(after[key] ?? null);
    if (a !== b) changed.push({ attribute: key, before: before[key] ?? null, after: after[key] ?? null });
  }
  return { requirement_id: from.requirement_id, from: publicRevision(from), to: publicRevision(to), changes: changed, source_module: SOURCE_MODULE };
}

export async function compareRevisionsAsync(db, tenantId, ref, fromRev, toRev) {
  const from = await getRevisionRowAsync(db, tenantId, ref, fromRev);
  const to = await getRevisionRowAsync(db, tenantId, ref, toRev);
  if (!from || !to) throw revisionNotFound(!from ? fromRev : toRev);
  const before = parseObject(from.snapshot_json, {});
  const after = parseObject(to.snapshot_json, {});
  const changed = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const a = JSON.stringify(before[key] ?? null);
    const b = JSON.stringify(after[key] ?? null);
    if (a !== b) changed.push({ attribute: key, before: before[key] ?? null, after: after[key] ?? null });
  }
  return { requirement_id: from.requirement_id, from: publicRevision(from), to: publicRevision(to), changes: changed, source_module: SOURCE_MODULE };
}

export function reviseRequirement(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRequirementRow(db, tenant, ref);
  if (row.status === "OBSOLETE" || row.status === "WITHDRAWN") {
    throw requirementImmutable(row.requirement_ref, row.status);
  }
  const newRevisionCode = assertRevisionCode(body.revision || nextRevision(row.revision));
  if (queryOne(db, "SELECT id FROM requirement_revisions WHERE requirement_id = ? AND revision = ?", [row.id, newRevisionCode])) {
    throw revisionConflict({ revision: newRevisionCode });
  }
  // Supersede the current working/released revision.
  run(db, "UPDATE requirement_revisions SET revision_status = 'SUPERSEDED', updated_at = ? WHERE requirement_id = ? AND revision = ?", [nowIso(), row.id, row.revision]);
  run(
    db,
    `INSERT INTO requirement_revisions
       (tenant_id, organization_id, requirement_id, requirement_number, revision, revision_status, title, description,
        change_reason, change_ref, snapshot_json, effective_from, effective_to, version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'WORKING', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [
      tenant,
      row.organization_id,
      row.id,
      row.requirement_number,
      newRevisionCode,
      row.title,
      row.description,
      normalizeText(body.change_reason ?? body.changeReason ?? "", { max: 4000 }),
      normalizeText(body.change_ref ?? body.changeRef ?? "", { max: 120 }) || null,
      JSON.stringify(snapshotOf(row)),
      row.effective_from,
      row.effective_to,
      actor?.id ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  const patch = { revision: newRevisionCode, status: "DRAFT", lifecycle_state: "DRAFT", version: bumpVersion(row), updated_by: actor?.id ?? null };
  if (body.title !== undefined || body.description !== undefined) {
    const normalized = normalizeRequirementInput(body, row);
    patch.title = normalized.title;
    patch.description = normalized.description;
  }
  updateRow(db, "requirements", row.id, patch, { columns: ["revision", "status", "lifecycle_state", "version", "updated_by", "title", "description"] });
  const updated = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [row.id]);
  recordRequirementHistory(db, { tenantId: tenant, organizationId: row.organization_id, entityType: "REVISION", entityId: row.id, entityRef: revisionRef(row.requirement_number, newRevisionCode), action: "REVISED", version: updated.version, status: updated.status, before: { revision: row.revision }, after: { revision: newRevisionCode }, details: { change_reason: body.change_reason ?? body.changeReason ?? "" }, actor, ip });
  publishRequirementEvent(db, { eventType: "RequirementRevised", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { requirement_ref: row.requirement_ref, revision: newRevisionCode } }, actor);
  indexChangeSync(db, "upsert", updated, tenant);
  return { requirement: publicRequirement(updated), revision: publicRevision(getRevisionRow(db, tenant, ref, newRevisionCode)) };
}

export async function reviseRequirementAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireRequirementRowAsync(db, tenant, ref);
  if (row.status === "OBSOLETE" || row.status === "WITHDRAWN") {
    throw requirementImmutable(row.requirement_ref, row.status);
  }
  const newRevisionCode = assertRevisionCode(body.revision || nextRevision(row.revision));
  if (await queryOneAsync(db, "SELECT id FROM requirement_revisions WHERE requirement_id = ? AND revision = ?", [row.id, newRevisionCode])) {
    throw revisionConflict({ revision: newRevisionCode });
  }
  await runAsync(db, "UPDATE requirement_revisions SET revision_status = 'SUPERSEDED', updated_at = ? WHERE requirement_id = ? AND revision = ?", [nowIso(), row.id, row.revision]);
  await runAsync(
    db,
    `INSERT INTO requirement_revisions
       (tenant_id, organization_id, requirement_id, requirement_number, revision, revision_status, title, description,
        change_reason, change_ref, snapshot_json, effective_from, effective_to, version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'WORKING', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [
      tenant,
      row.organization_id,
      row.id,
      row.requirement_number,
      newRevisionCode,
      row.title,
      row.description,
      normalizeText(body.change_reason ?? body.changeReason ?? "", { max: 4000 }),
      normalizeText(body.change_ref ?? body.changeRef ?? "", { max: 120 }) || null,
      JSON.stringify(snapshotOf(row)),
      row.effective_from,
      row.effective_to,
      actor?.id ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  const patch = { revision: newRevisionCode, status: "DRAFT", lifecycle_state: "DRAFT", version: bumpVersion(row), updated_by: actor?.id ?? null };
  if (body.title !== undefined || body.description !== undefined) {
    const normalized = normalizeRequirementInput(body, row);
    patch.title = normalized.title;
    patch.description = normalized.description;
  }
  await updateRowAsync(db, "requirements", row.id, patch, { columns: ["revision", "status", "lifecycle_state", "version", "updated_by", "title", "description"] });
  const updated = await queryOneAsync(db, "SELECT * FROM requirements WHERE id = ?", [row.id]);
  await recordRequirementHistoryAsync(db, { tenantId: tenant, organizationId: row.organization_id, entityType: "REVISION", entityId: row.id, entityRef: revisionRef(row.requirement_number, newRevisionCode), action: "REVISED", version: updated.version, status: updated.status, before: { revision: row.revision }, after: { revision: newRevisionCode }, details: { change_reason: body.change_reason ?? body.changeReason ?? "" }, actor, ip });
  await publishRequirementEventAsync(db, { eventType: "RequirementRevised", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { requirement_ref: row.requirement_ref, revision: newRevisionCode } }, actor);
  await indexChange(db, "upsert", updated, tenant);
  return { requirement: publicRequirement(updated), revision: publicRevision(await getRevisionRowAsync(db, tenant, ref, newRevisionCode)) };
}

// ── Status transitions (lifecycle) ───────────────────────────────────────────

const TRANSITION_EVENTS = {
  IN_REVIEW: "RequirementSubmitted",
  APPROVED: "RequirementApproved",
  REJECTED: "RequirementRejected",
  RELEASED: "RequirementReleased",
  IMPLEMENTED: "RequirementImplemented",
  VERIFIED: "RequirementVerified",
  VALIDATED: "RequirementValidated",
  OBSOLETE: "RequirementObsoleted",
  WITHDRAWN: "RequirementWithdrawn",
};

function assertMandatoryFor(db, tenant, row, target) {
  if (["IN_REVIEW", "APPROVED", "RELEASED"].includes(target)) {
    if (!row.title && !row.name) throw invalidRequirement("title is required before submission");
    if (!row.requirement_type) throw invalidRequirement("requirement_type is required");
    if (getConfig(db, tenant, "require_owner") && !row.owner_user_id) throw invalidRequirement("owner_user_id is required");
    if (getConfig(db, tenant, "require_description") && !row.description) throw invalidRequirement("description is required");
  }
  if (target === "VALIDATED" && getConfig(db, tenant, "require_verification_to_validate") && row.verification_status !== "VERIFIED" && row.verification_status !== "WAIVED") {
    throw invalidRequirement("Requirement must be verified (or waived) before it can be validated");
  }
}

function applyTransitionFields(patch, row, target, actor) {
  const ts = nowIso();
  patch.status = target;
  patch.lifecycle_state = target;
  if (target === "APPROVED") {
    patch.approved_by = actor?.id ?? null;
    patch.approved_at = ts;
  }
  if (target === "RELEASED") {
    patch.released_by = actor?.id ?? null;
    patch.released_at = ts;
  }
  if (target === "OBSOLETE") {
    patch.obsolete_at = ts;
  }
}

export function transitionRequirement(db, tenantId, ref, targetStatus, { reason = "", actor = null, ip = null } = {}) {
  const tenant = Number(tenantId);
  const row = requireRequirementRow(db, tenant, ref);
  const target = assertRequirementTransition(row.status, targetStatus);
  assertMandatoryFor(db, tenant, row, target);
  const patch = { version: bumpVersion(row), updated_by: actor?.id ?? null };
  applyTransitionFields(patch, row, target, actor);
  updateRow(db, "requirements", row.id, patch, { columns: ["status", "lifecycle_state", "approved_by", "approved_at", "released_by", "released_at", "obsolete_at", "version", "updated_by"] });
  if (target === "RELEASED") {
    run(db, "UPDATE requirement_revisions SET revision_status = 'RELEASED', released_at = ?, released_by = ?, updated_at = ? WHERE requirement_id = ? AND revision = ?", [nowIso(), actor?.id ?? null, nowIso(), row.id, row.revision]);
  }
  const updated = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [row.id]);
  recordRequirementHistory(db, { tenantId: tenant, organizationId: row.organization_id, entityType: "REQUIREMENT", entityId: row.id, entityRef: row.requirement_ref, action: target, version: updated.version, status: target, before: { status: row.status }, after: { status: target }, details: { reason: normalizeText(reason, { max: 2000 }) }, actor, ip });
  publishRequirementEvent(db, { eventType: TRANSITION_EVENTS[target] || "RequirementUpdated", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { requirement_ref: row.requirement_ref, status: target, reason } }, actor);
  indexChangeSync(db, "upsert", updated, tenant);
  return publicRequirement(updated);
}

export async function transitionRequirementAsync(db, tenantId, ref, targetStatus, { reason = "", actor = null, ip = null } = {}) {
  const tenant = Number(tenantId);
  const row = await requireRequirementRowAsync(db, tenant, ref);
  const target = assertRequirementTransition(row.status, targetStatus);
  if (["IN_REVIEW", "APPROVED", "RELEASED"].includes(target)) {
    if (!row.title && !row.name) throw invalidRequirement("title is required before submission");
    if (!row.requirement_type) throw invalidRequirement("requirement_type is required");
    if ((await getConfigAsync(db, tenant, "require_owner")) && !row.owner_user_id) throw invalidRequirement("owner_user_id is required");
    if ((await getConfigAsync(db, tenant, "require_description")) && !row.description) throw invalidRequirement("description is required");
  }
  if (target === "VALIDATED" && (await getConfigAsync(db, tenant, "require_verification_to_validate")) && row.verification_status !== "VERIFIED" && row.verification_status !== "WAIVED") {
    throw invalidRequirement("Requirement must be verified (or waived) before it can be validated");
  }
  const patch = { version: bumpVersion(row), updated_by: actor?.id ?? null };
  applyTransitionFields(patch, row, target, actor);
  await updateRowAsync(db, "requirements", row.id, patch, { columns: ["status", "lifecycle_state", "approved_by", "approved_at", "released_by", "released_at", "obsolete_at", "version", "updated_by"] });
  if (target === "RELEASED") {
    await runAsync(db, "UPDATE requirement_revisions SET revision_status = 'RELEASED', released_at = ?, released_by = ?, updated_at = ? WHERE requirement_id = ? AND revision = ?", [nowIso(), actor?.id ?? null, nowIso(), row.id, row.revision]);
  }
  const updated = await queryOneAsync(db, "SELECT * FROM requirements WHERE id = ?", [row.id]);
  await recordRequirementHistoryAsync(db, { tenantId: tenant, organizationId: row.organization_id, entityType: "REQUIREMENT", entityId: row.id, entityRef: row.requirement_ref, action: target, version: updated.version, status: target, before: { status: row.status }, after: { status: target }, details: { reason: normalizeText(reason, { max: 2000 }) }, actor, ip });
  await publishRequirementEventAsync(db, { eventType: TRANSITION_EVENTS[target] || "RequirementUpdated", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { requirement_ref: row.requirement_ref, status: target, reason } }, actor);
  await indexChange(db, "upsert", updated, tenant);
  return publicRequirement(updated);
}

export const submitRequirement = (db, tenantId, ref, actor, ip, reason) => transitionRequirement(db, tenantId, ref, "IN_REVIEW", { actor, ip, reason });
export const approveRequirement = (db, tenantId, ref, actor, ip, reason) => transitionRequirement(db, tenantId, ref, "APPROVED", { actor, ip, reason });
export const rejectRequirement = (db, tenantId, ref, actor, ip, reason) => transitionRequirement(db, tenantId, ref, "REJECTED", { actor, ip, reason });
export const releaseRequirement = (db, tenantId, ref, actor, ip, reason) => transitionRequirement(db, tenantId, ref, "RELEASED", { actor, ip, reason });
export const obsoleteRequirement = (db, tenantId, ref, actor, ip, reason) => transitionRequirement(db, tenantId, ref, "OBSOLETE", { actor, ip, reason });
export const submitRequirementAsync = (db, tenantId, ref, actor, ip, reason) => transitionRequirementAsync(db, tenantId, ref, "IN_REVIEW", { actor, ip, reason });
export const approveRequirementAsync = (db, tenantId, ref, actor, ip, reason) => transitionRequirementAsync(db, tenantId, ref, "APPROVED", { actor, ip, reason });
export const rejectRequirementAsync = (db, tenantId, ref, actor, ip, reason) => transitionRequirementAsync(db, tenantId, ref, "REJECTED", { actor, ip, reason });
export const releaseRequirementAsync = (db, tenantId, ref, actor, ip, reason) => transitionRequirementAsync(db, tenantId, ref, "RELEASED", { actor, ip, reason });
export const obsoleteRequirementAsync = (db, tenantId, ref, actor, ip, reason) => transitionRequirementAsync(db, tenantId, ref, "OBSOLETE", { actor, ip, reason });

// ── Verification / validation status updates ─────────────────────────────────

export function setVerificationStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRequirementRow(db, tenant, ref);
  const target = normalizeText(status, { max: 30 }).toUpperCase();
  const patch = { verification_status: target, version: bumpVersion(row), updated_by: actor?.id ?? null };
  updateRow(db, "requirements", row.id, patch, { columns: ["verification_status", "version", "updated_by"] });
  const updated = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [row.id]);
  recordRequirementHistory(db, { tenantId: tenant, organizationId: row.organization_id, entityType: "REQUIREMENT", entityId: row.id, entityRef: row.requirement_ref, action: "VERIFICATION_UPDATED", version: updated.version, status: updated.status, before: { verification_status: row.verification_status }, after: { verification_status: target }, actor, ip });
  if (target === "VERIFIED") publishRequirementEvent(db, { eventType: "RequirementVerified", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { requirement_ref: row.requirement_ref } }, actor);
  return publicRequirement(updated);
}

export async function setVerificationStatusAsync(db, tenantId, ref, status, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireRequirementRowAsync(db, tenant, ref);
  const target = normalizeText(status, { max: 30 }).toUpperCase();
  const patch = { verification_status: target, version: bumpVersion(row), updated_by: actor?.id ?? null };
  await updateRowAsync(db, "requirements", row.id, patch, { columns: ["verification_status", "version", "updated_by"] });
  const updated = await queryOneAsync(db, "SELECT * FROM requirements WHERE id = ?", [row.id]);
  await recordRequirementHistoryAsync(db, { tenantId: tenant, organizationId: row.organization_id, entityType: "REQUIREMENT", entityId: row.id, entityRef: row.requirement_ref, action: "VERIFICATION_UPDATED", version: updated.version, status: updated.status, before: { verification_status: row.verification_status }, after: { verification_status: target }, actor, ip });
  if (target === "VERIFIED") await publishRequirementEventAsync(db, { eventType: "RequirementVerified", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { requirement_ref: row.requirement_ref } }, actor);
  return publicRequirement(updated);
}

export function listRequirementHistory(db, tenantId, ref) {
  const requirement = requireRequirementRow(db, tenantId, ref);
  return listHistory(db, { tenantId, entityId: requirement.id });
}

export async function listRequirementHistoryAsync(db, tenantId, ref) {
  const requirement = await requireRequirementRowAsync(db, tenantId, ref);
  return listHistoryAsync(db, { tenantId, entityId: requirement.id });
}

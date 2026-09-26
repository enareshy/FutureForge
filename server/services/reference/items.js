// Reference data items: the governed, versioned, scope-aware, effective-dated
// values themselves. This service owns the item lifecycle and composes codes,
// aliases, translations, hierarchy, relationships and version snapshots.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  approvalRequired,
  invalidEffectiveRange,
  invalidItem,
  invalidScope,
  invalidStatusTransition,
  itemConflict,
  itemNotFound,
  conflict,
} from "./errors.js";
import {
  buildScopeKey,
  canTransition,
  ITEM_STATUSES,
  isEffectiveAt,
  json,
  nextStatuses,
  normalizeScopeType,
  normalizeStatus,
  normalizeText,
  normalizeUpper,
  parseObject,
  scopeValueFor,
  toBool,
  validateEffectiveRange,
} from "./validation.js";
import { itemRef } from "./refs.js";
import { bumpCacheEpoch } from "./cache.js";
import { emitItemEvent } from "./events.js";
import { getActiveGovernancePolicy } from "./governance.js";
import { getDomainRow, writeOwnershipChange } from "./domains.js";
import { assertCodeReusable, validateCodeValue } from "./codes.js";
import { recordVersion } from "./versions.js";
import { createEdge } from "./hierarchy.js";

export function publicItem(row, { includeChildren = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    item_ref: row.item_ref,
    domain_id: row.domain_id,
    domain_code: row.domain_code ?? null,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    lifecycle_state: row.lifecycle_state,
    scope_type: row.scope_type,
    scope_key: row.scope_key,
    is_global: Boolean(row.is_global),
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    version: row.version,
    current_version_number: row.current_version_number,
    parent_id: row.parent_id,
    hierarchy_path: row.hierarchy_path,
    hierarchy_level: row.hierarchy_level,
    sequence: row.sequence,
    owner_user_id: row.owner_user_id,
    steward_user_id: row.steward_user_id,
    owner_label: row.owner_label,
    steward_label: row.steward_label,
    is_default: Boolean(row.is_default),
    is_system: Boolean(row.is_system),
    versioning_revision_id: row.versioning_revision_id,
    attributes: parseObject(row.attributes_json, {}),
    metadata: parseObject(row.metadata_json, {}),
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    company_id: row.company_id,
    business_unit_id: row.business_unit_id,
    plant_id: row.plant_id,
    site_id: row.site_id,
    submitted_at: row.submitted_at,
    approved_at: row.approved_at,
    activated_at: row.activated_at,
    inactivated_at: row.inactivated_at,
    retired_at: row.retired_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    next_statuses: nextStatuses(row.status),
    ...(includeChildren ? {} : {}),
  };
}

export function getItemRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM reference_data_items WHERE item_ref = ?", [String(ref)]) || null;
}

export function requireItem(db, ref) {
  const row = getItemRow(db, ref);
  if (!row) throw itemNotFound(ref);
  return row;
}

function withDomain(db, row) {
  if (!row) return null;
  const domain = queryOne(db, "SELECT code FROM reference_domains WHERE id = ?", [row.domain_id]);
  return { ...row, domain_code: domain?.code ?? null };
}

export function getItem(db, ref, { includeChildren = true } = {}) {
  const row = requireItem(db, ref);
  const item = publicItem(withDomain(db, row), { includeChildren });
  if (!includeChildren) return item;
  return {
    ...item,
    children: queryAll(
      db,
      `SELECT i.*, d.code AS domain_code FROM reference_hierarchy h
       JOIN reference_data_items i ON i.id = h.child_id
       LEFT JOIN reference_domains d ON d.id = i.domain_id
       WHERE h.parent_id = ? AND h.status = 'active' ORDER BY h.sequence, i.code`,
      [row.id]
    ).map((child) => publicItem(child)),
  };
}

export function listItems(db, { domainId, domainCode, status, scopeKey, scopeType, code, q, parentId, effectiveAt, page, pageSize, tenantId, isDefault, limit } = {}) {
  const clauses = [];
  const params = [];
  let domain = null;
  if (domainCode) {
    domain = getDomainRow(db, domainCode);
    if (!domain) throw invalidItem(`Unknown domain: ${domainCode}`);
    clauses.push("i.domain_id = ?");
    params.push(Number(domain.id));
  } else if (domainId !== undefined && domainId !== null) {
    clauses.push("i.domain_id = ?");
    params.push(Number(domainId));
  }
  if (status) {
    const statuses = Array.isArray(status) ? status : String(status).split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length) {
      clauses.push(`i.status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
  }
  if (scopeKey) {
    clauses.push("i.scope_key = ?");
    params.push(String(scopeKey));
  }
  if (scopeType) {
    clauses.push("i.scope_type = ?");
    params.push(normalizeScopeType(scopeType));
  }
  if (code) {
    clauses.push("(i.code = ? OR UPPER(i.code) = ?)");
    params.push(normalizeText(code), normalizeUpper(code));
  }
  if (q) {
    clauses.push("(LOWER(i.code) LIKE ? OR LOWER(i.name) LIKE ? OR LOWER(i.description) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  if (parentId !== undefined && parentId !== null) {
    clauses.push("i.parent_id = ?");
    params.push(Number(parentId));
  }
  if (isDefault !== undefined) {
    clauses.push("i.is_default = ?");
    params.push(toBool(isDefault, false) ? 1 : 0);
  }
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(i.tenant_id IS NULL OR i.tenant_id = ?)");
    params.push(Number(tenantId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const pageSizeNum = Math.min(500, Math.max(1, Number(pageSize || limit) || 100));
  const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * pageSizeNum);
  let rows = queryAll(
    db,
    `SELECT i.*, d.code AS domain_code FROM reference_data_items i
     LEFT JOIN reference_domains d ON d.id = i.domain_id
     ${where} ORDER BY i.sequence, i.code LIMIT ? OFFSET ?`,
    [...params, effectiveAt ? 5000 : pageSizeNum, effectiveAt ? 0 : offset]
  );
  if (effectiveAt) {
    rows = rows.filter((row) => isEffectiveAt(row.effective_from, row.effective_to, effectiveAt)).slice(offset, offset + pageSizeNum);
  }
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM reference_data_items i ${where}`, params)?.c ?? rows.length);
  return { items: rows.map((row) => publicItem(row)), total, page: Math.floor(offset / pageSizeNum) + 1, page_size: pageSizeNum };
}

function resolveScope(input, domain, tenantId) {
  const scopeType = normalizeScopeType(input.scope_type ?? input.scopeType ?? domain?.scope_type ?? "GLOBAL", "GLOBAL");
  const context = {
    tenantId: input.tenant_id ?? input.tenantId ?? tenantId ?? null,
    organizationId: input.organization_id ?? input.organizationId ?? null,
    companyId: input.company_id ?? input.companyId ?? null,
    businessUnitId: input.business_unit_id ?? input.businessUnitId ?? null,
    plantId: input.plant_id ?? input.plantId ?? null,
    siteId: input.site_id ?? input.siteId ?? null,
  };
  return { scopeType, scopeKey: buildScopeKey(scopeType, context), context };
}

function scopeColumns(input, context) {
  return {
    tenant_id: input.tenant_id ?? input.tenantId ?? context.tenantId ?? null,
    organization_id: input.organization_id ?? input.organizationId ?? context.organizationId ?? null,
    company_id: input.company_id ?? input.companyId ?? context.companyId ?? null,
    business_unit_id: input.business_unit_id ?? input.businessUnitId ?? context.businessUnitId ?? null,
    plant_id: input.plant_id ?? input.plantId ?? context.plantId ?? null,
    site_id: input.site_id ?? input.siteId ?? context.siteId ?? null,
  };
}

function assertUniqueCode(db, domainId, scopeKey, code, governance, exceptItemId = null) {
  const caseSensitive = governance.code_case_sensitive !== false;
  const clause = caseSensitive ? "code = ?" : "UPPER(code) = ?";
  const param = caseSensitive ? code : String(code).toUpperCase();
  const existing = queryOne(
    db,
    `SELECT id, item_ref, status FROM reference_data_items WHERE domain_id = ? AND scope_key = ? AND ${clause} AND id <> ?`,
    [Number(domainId), scopeKey, param, Number(exceptItemId ?? 0)]
  );
  if (existing) throw itemConflict(domainId, code, scopeKey, { item_ref: existing.item_ref, status: existing.status });
}

export function createItem(db, input = {}, actor = null, tenantId = null, ip = null) {
  const domain = getDomainRow(db, input.domain_id ?? input.domainId ?? input.domain_code ?? input.domainCode);
  if (!domain) throw invalidItem("A valid domain_id or domain_code is required");
  if (domain.status !== "active") throw conflict(`Reference domain ${domain.code} is not active`);
  const governance = getActiveGovernancePolicy(db, domain.id);
  const code = validateCodeValue(normalizeText(input.code), governance);
  if (!code) throw invalidItem("code is required");
  const { scopeType, scopeKey, context } = resolveScope({ ...input, tenant_id: input.tenant_id ?? tenantId }, domain, tenantId);
  const effectiveFrom = input.effective_from ?? input.effectiveFrom ?? null;
  const effectiveTo = input.effective_to ?? input.effectiveTo ?? null;
  if (!validateEffectiveRange(effectiveFrom, effectiveTo)) throw invalidEffectiveRange({ effective_from: effectiveFrom, effective_to: effectiveTo });
  assertUniqueCode(db, domain.id, scopeKey, code, governance);
  assertCodeReusable(db, domain.id, code, { caseSensitive: governance.code_case_sensitive !== false });
  const cols = scopeColumns(input, context);
  const isGlobal = scopeType === "GLOBAL";
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reference_data_items
      (item_ref, domain_id, code, name, description, status, lifecycle_state, scope_type, scope_key, is_global,
       effective_from, effective_to, version, current_version_number, sequence, owner_user_id, steward_user_id, owner_label, steward_label,
       is_default, is_system, versioning_revision_id, attributes_json, metadata_json,
       tenant_id, organization_id, company_id, business_unit_id, plant_id, site_id,
       created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      itemRef(domain.code, code, scopeKey),
      Number(domain.id),
      code,
      normalizeText(input.name, code),
      normalizeText(input.description),
      ITEM_STATUSES.includes(String(input.status || "").toLowerCase()) ? String(input.status).toLowerCase() : "draft",
      normalizeStatus(input.status, "draft"),
      scopeType,
      scopeKey,
      isGlobal ? 1 : 0,
      effectiveFrom,
      effectiveTo,
      Number(input.sequence) || 0,
      input.owner_user_id ?? input.ownerUserId ?? null,
      input.steward_user_id ?? input.stewardUserId ?? null,
      normalizeText(input.owner_label),
      normalizeText(input.steward_label),
      toBool(input.is_default, false) ? 1 : 0,
      input.versioning_revision_id ?? input.versioningRevisionId ?? null,
      json(input.attributes),
      json(input.metadata),
      cols.tenant_id,
      cols.organization_id,
      cols.company_id,
      cols.business_unit_id,
      cols.plant_id,
      cols.site_id,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [Number(result.lastInsertRowid)]);
  if (input.parent_id ?? input.parentId) {
    if (!governance.hierarchy_enabled) throw invalidItem("Hierarchy is disabled for this domain by governance");
    createEdge(db, { parentId: input.parent_id ?? input.parentId, childId: row.id, relationship_type: input.relationship_type || "parent_child" }, actor, tenantId, ip);
  }
  recordVersion(db, row, { changeSummary: "Initial version", versionNumber: 1, actor });
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.item.create",
    resourceType: "reference_item",
    resourceId: row.id,
    details: { domain: domain.code, code, scope_key: scopeKey },
    ip,
  });
  emitItemEvent(db, "ReferenceItemCreated", row, { domain_code: domain.code }, actor);
  return publicItem(withDomain(db, queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [row.id])));
}

export function updateItem(db, ref, patch = {}, actor = null, ip = null) {
  const row = requireItem(db, ref);
  if (row.status === "retired") throw conflict("A retired reference item cannot be modified");
  const domain = queryOne(db, "SELECT * FROM reference_domains WHERE id = ?", [row.domain_id]);
  const governance = getActiveGovernancePolicy(db, row.domain_id);
  const clauses = [];
  const params = [];
  const set = (column, value) => {
    clauses.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.code !== undefined) {
    const code = validateCodeValue(normalizeText(patch.code), governance);
    assertUniqueCode(db, row.domain_id, row.scope_key, code, governance, row.id);
    set("code", code);
  }
  if (patch.name !== undefined) set("name", normalizeText(patch.name, row.code));
  if (patch.description !== undefined) set("description", normalizeText(patch.description));
  if (patch.sequence !== undefined) set("sequence", Number(patch.sequence) || 0);
  if (patch.is_default !== undefined) set("is_default", toBool(patch.is_default, false) ? 1 : 0);
  if (patch.attributes !== undefined) set("attributes_json", JSON.stringify(patch.attributes ?? {}));
  if (patch.metadata !== undefined) set("metadata_json", JSON.stringify(patch.metadata ?? {}));
  if (patch.versioning_revision_id !== undefined) set("versioning_revision_id", patch.versioning_revision_id ?? null);
  const effectiveFrom = patch.effective_from !== undefined ? patch.effective_from : row.effective_from;
  const effectiveTo = patch.effective_to !== undefined ? patch.effective_to : row.effective_to;
  if (!validateEffectiveRange(effectiveFrom, effectiveTo)) throw invalidEffectiveRange({ effective_from: effectiveFrom, effective_to: effectiveTo });
  if (patch.effective_from !== undefined) set("effective_from", effectiveFrom ?? null);
  if (patch.effective_to !== undefined) set("effective_to", effectiveTo ?? null);
  const ownershipChanges = [];
  for (const field of ["owner_label", "steward_label"]) {
    if (patch[field] === undefined) continue;
    const next = normalizeText(patch[field]);
    if (String(row[field] ?? "") !== next) ownershipChanges.push({ field, oldValue: row[field], newValue: next });
    set(field, next);
  }
  if (patch.owner_user_id !== undefined) set("owner_user_id", patch.owner_user_id ?? null);
  if (patch.steward_user_id !== undefined) set("steward_user_id", patch.steward_user_id ?? null);
  const newVersion = Number(row.current_version_number ?? 1) + 1;
  set("current_version_number", newVersion);
  set("version", newVersion);
  set("updated_by", actor?.id ?? null);
  set("updated_at", nowIso());
  params.push(row.id);
  run(db, `UPDATE reference_data_items SET ${clauses.join(", ")} WHERE id = ?`, params);
  if (patch.parent_id !== undefined || patch.parentId !== undefined) {
    const parentId = patch.parent_id ?? patch.parentId;
    if (!governance.hierarchy_enabled && parentId) throw invalidItem("Hierarchy is disabled for this domain by governance");
    const existingEdge = queryOne(db, "SELECT id FROM reference_hierarchy WHERE child_id = ?", [row.id]);
    if (existingEdge) run(db, "DELETE FROM reference_hierarchy WHERE id = ?", [existingEdge.id]);
    if (parentId) createEdge(db, { parentId, childId: row.id, relationship_type: patch.relationship_type || "parent_child" }, actor, null, ip);
    else run(db, "UPDATE reference_data_items SET parent_id = NULL, hierarchy_path = ?, hierarchy_level = 0 WHERE id = ?", [`/${row.id}`, row.id]);
  }
  const updated = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [row.id]);
  for (const change of ownershipChanges) {
    writeOwnershipChange(db, {
      domainId: row.domain_id,
      itemId: row.id,
      field: change.field,
      oldValue: change.oldValue,
      newValue: change.newValue,
      actor,
      reason: normalizeText(patch.reason),
    });
  }
  recordVersion(db, updated, { changeSummary: normalizeText(patch.change_summary, "Item updated"), versionNumber: newVersion, actor });
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.item.update",
    resourceType: "reference_item",
    resourceId: row.id,
    details: { code: updated.code, version: newVersion, fields: clauses.map((c) => c.split(" =")[0]) },
    ip,
  });
  emitItemEvent(db, "ReferenceItemChanged", updated, { domain_code: domain?.code ?? null, version: newVersion }, actor);
  return publicItem(withDomain(db, updated));
}

const STATUS_TIMESTAMP = {
  submitted: "submitted_at",
  approved: "approved_at",
  active: "activated_at",
  inactive: "inactivated_at",
  retired: "retired_at",
};

function hasApprovedApproval(db, itemId) {
  return Boolean(
    queryOne(db, "SELECT id FROM reference_approvals WHERE item_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1", [Number(itemId)])
  );
}

export function setItemStatus(db, ref, status, actor = null, ip = null, { reason = "", changeSummary = "" } = {}) {
  const row = requireItem(db, ref);
  const next = normalizeStatus(status, null);
  if (!next || !ITEM_STATUSES.includes(next)) throw invalidItem(`Unknown reference status: ${status}`);
  if (row.status === next) return publicItem(withDomain(db, row));
  if (!canTransition(row.status, next)) throw invalidStatusTransition(row.status, next);
  const governance = getActiveGovernancePolicy(db, row.domain_id);
  const lifecycle = Array.isArray(governance.lifecycle) && governance.lifecycle.length ? governance.lifecycle : ITEM_STATUSES;
  if (lifecycle.length && !lifecycle.includes(next) && next !== "rejected" && next !== "returned") {
    throw invalidStatusTransition(row.status, next);
  }
  if (governance.approval_required && next === "active" && row.status !== "approved" && !hasApprovedApproval(db, row.id)) {
    throw approvalRequired({ item_ref: row.item_ref, status: next });
  }
  const newVersion = Number(row.current_version_number ?? 1) + 1;
  const ts = nowIso();
  const timestampColumn = STATUS_TIMESTAMP[next];
  const timestampClause = timestampColumn ? `, ${timestampColumn} = ?` : "";
  const params = [next, next, newVersion, newVersion, actor?.id ?? null, ts];
  if (timestampColumn) params.push(ts);
  params.push(row.id);
  run(
    db,
    `UPDATE reference_data_items
     SET status = ?, lifecycle_state = ?, current_version_number = ?, version = ?, updated_by = ?, updated_at = ?${timestampClause}
     WHERE id = ?`,
    params
  );
  const updated = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [row.id]);
  recordVersion(db, updated, { changeSummary: changeSummary || `Status ${row.status} -> ${next}`, versionNumber: newVersion, actor });
  bumpCacheEpoch(db);
  const eventMap = {
    submitted: "ReferenceItemSubmitted",
    approved: "ReferenceItemApproved",
    active: "ReferenceItemActivated",
    inactive: "ReferenceItemInactivated",
    retired: "ReferenceItemRetired",
    rejected: "ReferenceItemRejected",
    returned: "ReferenceItemRejected",
  };
  writeAudit(db, {
    actor,
    action: "reference.item.status",
    resourceType: "reference_item",
    resourceId: row.id,
    details: { code: row.code, from: row.status, to: next, reason: normalizeText(reason) },
    ip,
  });
  emitItemEvent(db, eventMap[next] || "ReferenceItemChanged", updated, { from: row.status, to: next, reason: normalizeText(reason) }, actor);
  return publicItem(withDomain(db, updated));
}

export function deleteItem(db, ref, actor = null, ip = null) {
  const row = requireItem(db, ref);
  if (!["draft", "rejected", "returned"].includes(row.status)) {
    throw conflict("Only draft, rejected or returned reference items can be deleted; retire active values instead", {
      status: row.status,
    });
  }
  run(db, "DELETE FROM reference_data_items WHERE id = ?", [row.id]);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.item.delete",
    resourceType: "reference_item",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return { deleted: true, id: row.id };
}

export function listEffectiveItems(db, { domainId, domainCode, asOf, scopeContext = {}, tenantId = null } = {}) {
  const domain = domainCode ? getDomainRow(db, domainCode) : queryOne(db, "SELECT * FROM reference_domains WHERE id = ?", [Number(domainId)]);
  if (!domain) throw invalidItem("A valid domain is required");
  const rows = queryAll(
    db,
    `SELECT * FROM reference_data_items WHERE domain_id = ? AND status = 'active' ORDER BY sequence, code`,
    [Number(domain.id)]
  );
  return rows
    .filter((row) => isEffectiveAt(row.effective_from, row.effective_to, asOf))
    .map((row) => publicItem(withDomain(db, row)));
}

export { scopeValueFor };

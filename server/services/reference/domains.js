// Reference data domains: the top-level governed container for a class of
// enterprise values (Unit of Measure, Currency, Country, ...). New domains are
// created through configuration; the core framework never changes for a new
// domain.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  domainConflict,
  domainNotFound,
  invalidDomain,
  invalidScope,
} from "./errors.js";
import {
  DOMAIN_STATUSES,
  isScopeType,
  normalizeLanguage,
  normalizeScopeType,
  normalizeText,
  normalizeUpper,
  pagination,
  parseObject,
  toBool,
} from "./validation.js";
import { domainRef } from "./refs.js";
import { bumpCacheEpoch } from "./cache.js";
import { emitReferenceEvent } from "./events.js";
import { ensureDefaultGovernance, getActiveGovernancePolicy, listGovernanceVersions, publicGovernance } from "./governance.js";

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

export function publicDomain(row, { governance = null, includeGovernance = true, db = null } = {}) {
  if (!row) return null;
  let activeGovernance = governance;
  if (includeGovernance && !activeGovernance && db) activeGovernance = getActiveGovernancePolicy(db, row.id);
  return {
    id: row.id,
    domain_ref: row.domain_ref,
    code: row.code,
    name: row.name,
    description: row.description,
    category: row.category,
    status: row.status,
    scope_type: row.scope_type,
    owner_user_id: row.owner_user_id,
    owner_group_id: row.owner_group_id,
    owner_label: row.owner_label,
    business_owner: row.business_owner,
    technical_owner: row.technical_owner,
    steward_user_id: row.steward_user_id,
    steward_group_id: row.steward_group_id,
    steward_label: row.steward_label,
    default_language: row.default_language,
    is_system: Boolean(row.is_system),
    current_governance_version: row.current_governance_version,
    metadata: parseObject(row.metadata_json, {}),
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(includeGovernance ? { governance: activeGovernance } : {}),
  };
}

export function getDomainRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM reference_domains WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return (
    queryOne(db, "SELECT * FROM reference_domains WHERE domain_ref = ?", [String(ref)]) ||
    queryOne(db, "SELECT * FROM reference_domains WHERE code = ?", [normalizeUpper(ref)]) ||
    null
  );
}

export function requireDomain(db, ref) {
  const row = getDomainRow(db, ref);
  if (!row) throw domainNotFound(ref);
  return row;
}

export function getDomain(db, ref, { includeGovernance = true } = {}) {
  const row = requireDomain(db, ref);
  return publicDomain(row, { includeGovernance, governance: includeGovernance ? getActiveGovernancePolicy(db, row.id) : null });
}

export function listDomains(db, { tenantId, status, category, q, page, pageSize } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status).toLowerCase());
  }
  if (category) {
    clauses.push("category = ?");
    params.push(String(category));
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(description) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { limit, offset } = pagination({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM reference_domains ${where}`, params)?.c ?? 0);
  const rows = queryAll(
    db,
    `SELECT * FROM reference_domains ${where} ORDER BY is_system DESC, code LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { items: rows.map((row) => publicDomain(row, { db })), total, page: Math.floor(offset / limit) + 1, page_size: limit };
}

export function createDomain(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = normalizeUpper(input.code);
  if (!CODE_PATTERN.test(code)) {
    throw invalidDomain("Domain code must be 2-64 uppercase letters, digits or underscore and start with a letter");
  }
  const existing = queryOne(
    db,
    "SELECT id FROM reference_domains WHERE code = ? AND COALESCE(tenant_id, 0) = COALESCE(?, 0)",
    [code, tenantId]
  );
  if (existing) throw domainConflict(code);
  const scopeType = isScopeType(input.scope_type) ? normalizeScopeType(input.scope_type) : tenantId ? "TENANT" : "GLOBAL";
  const defaultLanguage = normalizeLanguage(input.default_language || "en");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reference_domains
      (domain_ref, code, name, description, category, status, scope_type, owner_user_id, owner_group_id, owner_label,
       business_owner, technical_owner, steward_user_id, steward_group_id, steward_label, default_language, is_system,
       metadata_json, tenant_id, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    [
      domainRef(code),
      code,
      normalizeText(input.name, code),
      normalizeText(input.description),
      normalizeText(input.category, "general"),
      DOMAIN_STATUSES.includes(String(input.status || "").toLowerCase()) ? String(input.status).toLowerCase() : "active",
      scopeType,
      input.owner_user_id ?? null,
      input.owner_group_id ?? null,
      normalizeText(input.owner_label),
      normalizeText(input.business_owner),
      normalizeText(input.technical_owner),
      input.steward_user_id ?? null,
      input.steward_group_id ?? null,
      normalizeText(input.steward_label),
      defaultLanguage,
      JSON.stringify(input.metadata ?? {}),
      tenantId,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM reference_domains WHERE id = ?", [Number(result.lastInsertRowid)]);
  ensureDefaultGovernance(db, row);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.domain.create",
    resourceType: "reference_domain",
    resourceId: row.id,
    details: { code, name: row.name, scope_type: scopeType },
    ip,
  });
  emitReferenceEvent(
    db,
    { eventType: "ReferenceDomainCreated", domainId: row.id, tenantId, payload: { code, name: row.name, scope_type: scopeType } },
    actor
  );
  return publicDomain(row, { db });
}

export function updateDomain(db, ref, patch = {}, actor = null, ip = null) {
  const row = requireDomain(db, ref);
  if (patch.scope_type && !isScopeType(patch.scope_type)) throw invalidScope(`Unknown scope type: ${patch.scope_type}`);
  const changes = [];
  const params = [];
  const assign = (column, value, previous) => {
    changes.push(`${column} = ?`);
    params.push(value);
    if (String(previous ?? "") !== String(value ?? "")) return true;
    return false;
  };
  const ownershipFields = [
    ["business_owner", "business_owner"],
    ["technical_owner", "technical_owner"],
    ["owner_label", "owner_label"],
    ["steward_label", "steward_label"],
  ];
  const ownershipChanges = [];
  for (const [field, column] of ownershipFields) {
    if (patch[field] === undefined) continue;
    const next = normalizeText(patch[field]);
    if (assign(column, next, row[column])) ownershipChanges.push({ field, oldValue: row[column], newValue: next });
  }
  if (patch.owner_user_id !== undefined) assign("owner_user_id", patch.owner_user_id ?? null, row.owner_user_id);
  if (patch.owner_group_id !== undefined) assign("owner_group_id", patch.owner_group_id ?? null, row.owner_group_id);
  if (patch.steward_user_id !== undefined) assign("steward_user_id", patch.steward_user_id ?? null, row.steward_user_id);
  if (patch.steward_group_id !== undefined) assign("steward_group_id", patch.steward_group_id ?? null, row.steward_group_id);
  if (patch.name !== undefined) assign("name", normalizeText(patch.name, row.code), row.name);
  if (patch.description !== undefined) assign("description", normalizeText(patch.description), row.description);
  if (patch.category !== undefined) assign("category", normalizeText(patch.category, "general"), row.category);
  if (patch.scope_type !== undefined) assign("scope_type", normalizeScopeType(patch.scope_type), row.scope_type);
  if (patch.default_language !== undefined) assign("default_language", normalizeLanguage(patch.default_language), row.default_language);
  if (patch.metadata !== undefined) assign("metadata_json", JSON.stringify(patch.metadata ?? {}), row.metadata_json);
  if (!changes.length) return publicDomain(row, { db });
  changes.push("updated_by = ?");
  params.push(actor?.id ?? null);
  changes.push("updated_at = ?");
  params.push(nowIso());
  params.push(row.id);
  run(db, `UPDATE reference_domains SET ${changes.join(", ")} WHERE id = ?`, params);
  for (const change of ownershipChanges) {
    writeOwnershipChange(db, {
      domainId: row.id,
      itemId: null,
      field: change.field,
      oldValue: change.oldValue,
      newValue: change.newValue,
      actor,
      reason: normalizeText(patch.reason),
    });
  }
  const updated = queryOne(db, "SELECT * FROM reference_domains WHERE id = ?", [row.id]);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.domain.update",
    resourceType: "reference_domain",
    resourceId: row.id,
    details: { code: row.code, fields: changes.filter((c) => !c.startsWith("updated_")).map((c) => c.split(" =")[0]) },
    ip,
  });
  emitReferenceEvent(
    db,
    { eventType: "ReferenceDomainChanged", domainId: row.id, tenantId: row.tenant_id, payload: { code: row.code } },
    actor
  );
  return publicDomain(updated, { db });
}

export function setDomainStatus(db, ref, status, actor = null, ip = null) {
  const next = String(status || "").toLowerCase();
  if (!DOMAIN_STATUSES.includes(next)) throw invalidDomain(`status must be one of: ${DOMAIN_STATUSES.join(", ")}`);
  const row = requireDomain(db, ref);
  run(db, "UPDATE reference_domains SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    next,
    actor?.id ?? null,
    nowIso(),
    row.id,
  ]);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.domain.status",
    resourceType: "reference_domain",
    resourceId: row.id,
    details: { code: row.code, from: row.status, to: next },
    ip,
  });
  emitReferenceEvent(
    db,
    { eventType: "ReferenceDomainChanged", domainId: row.id, tenantId: row.tenant_id, payload: { code: row.code, status: next } },
    actor
  );
  return publicDomain(queryOne(db, "SELECT * FROM reference_domains WHERE id = ?", [row.id]), { db });
}

export function writeOwnershipChange(db, { domainId, itemId = null, field, oldValue, newValue, actor = null, reason = "" }) {
  run(
    db,
    `INSERT INTO reference_ownership_history (domain_id, item_id, field, old_value, new_value, changed_by, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [Number(domainId), itemId ?? null, field, normalizeText(oldValue), normalizeText(newValue), actor?.id ?? null, reason, nowIso()]
  );
}

export function listOwnershipHistory(db, { domainId, itemId, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (domainId !== undefined && domainId !== null) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  if (itemId !== undefined && itemId !== null) {
    clauses.push("item_id = ?");
    params.push(Number(itemId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return queryAll(
    db,
    `SELECT oh.*, u.username AS changed_by_username
     FROM reference_ownership_history oh
     LEFT JOIN users u ON u.id = oh.changed_by
     ${where} ORDER BY oh.created_at DESC, oh.id DESC LIMIT ?`,
    [...params, Number(limit)]
  ).map((row) => ({
    id: row.id,
    domain_id: row.domain_id,
    item_id: row.item_id,
    field: row.field,
    old_value: row.old_value,
    new_value: row.new_value,
    changed_by: row.changed_by,
    changed_by_username: row.changed_by_username,
    reason: row.reason,
    created_at: row.created_at,
  }));
}

export { listGovernanceVersions, publicGovernance };

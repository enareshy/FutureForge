// Data governance domains: hierarchical containers that group governed object
// types, ownership and quality policy. Domains are configuration data: adding a
// new governed area never changes the engine.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { domainConflict, domainNotFound, invalidDomain, domainCycle } from "./errors.js";
import {
  assertDomainStatus,
  normalizeLower,
  normalizeText,
  normalizeUpper,
  paginate,
  parseObject,
  requireCode,
} from "./validation.js";
import { domainRef, slug } from "./refs.js";
import { publicDomain } from "./repository.js";
import { publishGovernanceEvent } from "./events.js";

export { publicDomain };

export function getDomainRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM dg_domains WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return (
    queryOne(db, "SELECT * FROM dg_domains WHERE domain_ref = ?", [String(ref)]) ||
    queryOne(db, "SELECT * FROM dg_domains WHERE code = ?", [normalizeUpper(ref)]) ||
    null
  );
}

export function requireDomain(db, ref) {
  const row = getDomainRow(db, ref);
  if (!row) throw domainNotFound(ref);
  return row;
}

export function getDomain(db, ref, options = {}) {
  const row = requireDomain(db, ref);
  return publicDomain(row, options);
}

function ancestors(db, id) {
  const chain = [];
  let current = id;
  const guard = new Set();
  while (current) {
    if (guard.has(current)) break;
    guard.add(current);
    const row = queryOne(db, "SELECT id, parent_id FROM dg_domains WHERE id = ?", [current]);
    if (!row) break;
    chain.push(row.id);
    current = row.parent_id;
  }
  return chain;
}

export function breadcrumb(db, row) {
  if (!row) return [];
  const ids = ancestors(db, row.id).reverse();
  return ids
    .map((id) => queryOne(db, "SELECT id, code, name FROM dg_domains WHERE id = ?", [id]))
    .filter(Boolean)
    .map((entry) => ({ id: entry.id, code: entry.code, name: entry.name }));
}

function assertNoCycle(db, id, parentId) {
  if (!parentId) return;
  if (id && Number(parentId) === Number(id)) throw domainCycle({ reason: "self_reference" });
  if (id && ancestors(db, parentId).includes(Number(id))) {
    throw domainCycle({ reason: "descendant_parent", parent_id: parentId });
  }
}

export function listDomains(db, { tenantId, status, category, parentId, q, page, pageSize } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeLower(status));
  }
  if (category) {
    clauses.push("category = ?");
    params.push(String(category));
  }
  if (parentId !== undefined) {
    if (parentId === null || parentId === "" || parentId === "root") {
      clauses.push("parent_id IS NULL");
    } else {
      clauses.push("parent_id = ?");
      params.push(Number(parentId));
    }
  }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(description) LIKE ?)");
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dg_domains ${where}`, params)?.c ?? 0);
  const rows = queryAll(db, `SELECT * FROM dg_domains ${where} ORDER BY code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map((row) => publicDomain(row)), total, page: currentPage, page_size: limit };
}

export function domainTree(db, { tenantId, rootId = null } = {}) {
  const rows = queryAll(
    db,
    `SELECT * FROM dg_domains WHERE tenant_id = ? ORDER BY code`,
    [Number(tenantId)]
  );
  const byId = new Map(rows.map((row) => [Number(row.id), { ...publicDomain(row), children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(Number(node.parent_id)) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  if (rootId) {
    const root = byId.get(Number(rootId));
    return root ? [root] : [];
  }
  return roots;
}

export function createDomain(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = requireCode(input.code, "Domain code");
  const existing = queryOne(db, "SELECT id FROM dg_domains WHERE code = ? AND tenant_id = ?", [code, Number(tenantId)]);
  if (existing) throw domainConflict(code);

  let parentId = input.parent_id ?? null;
  if (parentId !== null && parentId !== undefined && parentId !== "") {
    const parent = requireDomain(db, parentId);
    assertNoCycle(db, null, parent.id);
    parentId = parent.id;
  } else {
    parentId = null;
  }

  const status = assertDomainStatus(normalizeLower(input.status || "active"));
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dg_domains
      (domain_ref, tenant_id, organization_id, parent_id, code, name, description, category, status,
       owner_user_id, owner_group_id, owner_organization_id, owner_role_id, secondary_owner_user_id,
       steward_user_id, steward_group_id, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      domainRef(code),
      Number(tenantId),
      input.organization_id ?? null,
      parentId,
      code,
      normalizeText(input.name, code),
      normalizeText(input.description),
      normalizeText(input.category, "general"),
      status,
      input.owner_user_id ?? null,
      input.owner_group_id ?? null,
      input.owner_organization_id ?? null,
      input.owner_role_id ?? null,
      input.secondary_owner_user_id ?? null,
      input.steward_user_id ?? null,
      input.steward_group_id ?? null,
      JSON.stringify(input.metadata ?? {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM dg_domains WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, {
    actor,
    action: "data_governance.domain.create",
    resourceType: "dg_domain",
    resourceId: row.id,
    details: { code, parent_id: parentId, status },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DataDomainCreated",
    tenantId: Number(tenantId),
    objectType: "data_domain",
    objectId: row.id,
    payload: { id: row.id, code, name: row.name, parent_id: parentId },
  }, actor);
  return publicDomain(row);
}

export function updateDomain(db, ref, patch = {}, actor = null, ip = null) {
  const row = requireDomain(db, ref);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.code !== undefined) {
    const code = requireCode(patch.code, "Domain code");
    const clash = queryOne(db, "SELECT id FROM dg_domains WHERE code = ? AND tenant_id = ? AND id <> ?", [code, row.tenant_id, row.id]);
    if (clash) throw domainConflict(code);
    assign("code", code);
  }
  if (patch.name !== undefined) assign("name", normalizeText(patch.name, row.code));
  if (patch.description !== undefined) assign("description", normalizeText(patch.description));
  if (patch.category !== undefined) assign("category", normalizeText(patch.category, "general"));
  if (patch.organization_id !== undefined) assign("organization_id", patch.organization_id ?? null);
  if (patch.metadata !== undefined) assign("metadata_json", JSON.stringify(patch.metadata ?? {}));
  const ownerFields = [
    "owner_user_id",
    "owner_group_id",
    "owner_organization_id",
    "owner_role_id",
    "secondary_owner_user_id",
    "steward_user_id",
    "steward_group_id",
  ];
  for (const field of ownerFields) {
    if (patch[field] !== undefined) assign(field, patch[field] ?? null);
  }
  if (patch.parent_id !== undefined) {
    let parentId = patch.parent_id;
    if (parentId === null || parentId === "" || parentId === "root") {
      parentId = null;
    } else {
      const parent = requireDomain(db, parentId);
      assertNoCycle(db, row.id, parent.id);
      parentId = parent.id;
    }
    assign("parent_id", parentId);
  }
  if (!changes.length) return publicDomain(row);

  assign("updated_by", actor?.id ?? null);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dg_domains SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = queryOne(db, "SELECT * FROM dg_domains WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "data_governance.domain.update",
    resourceType: "dg_domain",
    resourceId: row.id,
    details: { code: updated.code, fields: Object.keys(patch) },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DataDomainChanged",
    tenantId: row.tenant_id,
    objectType: "data_domain",
    objectId: row.id,
    payload: { id: row.id, code: updated.code, fields: Object.keys(patch) },
  }, actor);
  return publicDomain(updated);
}

export function setDomainStatus(db, ref, status, actor = null, ip = null) {
  const row = requireDomain(db, ref);
  const next = assertDomainStatus(normalizeLower(status));
  run(db, "UPDATE dg_domains SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [next, actor?.id ?? null, nowIso(), row.id]);
  const updated = queryOne(db, "SELECT * FROM dg_domains WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "data_governance.domain.status",
    resourceType: "dg_domain",
    resourceId: row.id,
    details: { from: row.status, to: next },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DataDomainChanged",
    tenantId: row.tenant_id,
    objectType: "data_domain",
    objectId: row.id,
    payload: { id: row.id, code: row.code, status: next },
  }, actor);
  return publicDomain(updated);
}

export function deleteDomain(db, ref, actor = null, ip = null) {
  const row = requireDomain(db, ref);
  run(db, "UPDATE dg_domains SET status = 'retired', updated_by = ?, updated_at = ? WHERE id = ?", [actor?.id ?? null, nowIso(), row.id]);
  writeAudit(db, {
    actor,
    action: "data_governance.domain.retire",
    resourceType: "dg_domain",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return publicDomain(queryOne(db, "SELECT * FROM dg_domains WHERE id = ?", [row.id]));
}

export { parseObject, slug };

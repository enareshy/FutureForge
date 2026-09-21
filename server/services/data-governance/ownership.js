// Ownership and stewardship assignments. A subject (user, group, organization
// or role) is accountable for a scope: a whole domain, an object type or a
// single attribute. The core does not decide who *may* be accountable; it
// records accountability so exceptions, reminders and escalation can find the
// right person.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { invalidOwnership, ownershipConflict, ownershipNotFound } from "./errors.js";
import {
  assertRelationship,
  assertScopeType,
  assertSubjectType,
  normalizeText,
  paginate,
} from "./validation.js";
import { publicOwnership } from "./repository.js";
import { publishGovernanceEvent } from "./events.js";

export { publicOwnership };

export function getOwnershipRow(db, id) {
  return queryOne(db, "SELECT * FROM dg_ownership WHERE id = ?", [Number(id)]);
}

export function requireOwnership(db, id) {
  const row = getOwnershipRow(db, id);
  if (!row) throw ownershipNotFound(id);
  return row;
}

function assertSubjectExists(db, subjectType, subjectId) {
  if (subjectId === null || subjectId === undefined || subjectId === "") {
    throw invalidOwnership("A subject id is required for the assignment");
  }
  const table = { user: "users", group: "groups", organization: "organizations", role: "roles" }[subjectType];
  if (!table) return;
  const row = queryOne(db, `SELECT id FROM ${table} WHERE id = ?`, [Number(subjectId)]);
  if (!row) throw invalidOwnership(`No ${subjectType} exists with id ${subjectId}`, { subject_type: subjectType, subject_id: subjectId });
}

export function listOwnership(db, { tenantId, domainId, scopeType, objectType, attributeName, relationship, subjectType, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (domainId) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  if (scopeType) {
    clauses.push("scope_type = ?");
    params.push(assertScopeType(scopeType));
  }
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(String(objectType));
  }
  if (attributeName) {
    clauses.push("attribute_name = ?");
    params.push(String(attributeName));
  }
  if (relationship) {
    clauses.push("relationship = ?");
    params.push(assertRelationship(relationship));
  }
  if (subjectType) {
    clauses.push("subject_type = ?");
    params.push(assertSubjectType(subjectType));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status).toLowerCase());
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dg_ownership ${where}`, params)?.c ?? 0);
  const rows = queryAll(db, `SELECT * FROM dg_ownership ${where} ORDER BY relationship, scope_type LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicOwnership), total, page: currentPage, page_size: limit };
}

export function createOwnership(db, input = {}, actor = null, tenantId = null, ip = null) {
  const scopeType = assertScopeType(normalizeText(input.scope_type || "domain").toLowerCase());
  const relationship = assertRelationship(normalizeText(input.relationship || "owner").toLowerCase());
  const subjectType = assertSubjectType(normalizeText(input.subject_type).toLowerCase());
  const subjectId = input.subject_id ?? null;
  assertSubjectExists(db, subjectType, subjectId);

  const domainId = input.domain_id ? Number(input.domain_id) : null;
  const objectType = normalizeText(input.object_type);
  const attributeName = normalizeText(input.attribute_name);
  if (scopeType === "domain" && !domainId) throw invalidOwnership("A domain-scoped assignment requires domain_id");
  if (scopeType === "object" && !objectType) throw invalidOwnership("An object-scoped assignment requires object_type");
  if (scopeType === "attribute" && (!objectType || !attributeName)) {
    throw invalidOwnership("An attribute-scoped assignment requires object_type and attribute_name");
  }

  const duplicate = queryOne(
    db,
    `SELECT id FROM dg_ownership
      WHERE tenant_id = ? AND scope_type = ? AND COALESCE(domain_id, 0) = COALESCE(?, 0)
        AND object_type = ? AND attribute_name = ? AND relationship = ? AND subject_type = ? AND subject_id = ?`,
    [Number(tenantId), scopeType, domainId, objectType, attributeName, relationship, subjectType, Number(subjectId)]
  );
  if (duplicate) throw ownershipConflict({ scope_type: scopeType, relationship, subject_type: subjectType });

  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dg_ownership
      (tenant_id, domain_id, scope_type, scope_ref, object_type, attribute_name, relationship, subject_type, subject_id, is_primary, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      Number(tenantId),
      domainId,
      scopeType,
      normalizeText(input.scope_ref) || (objectType && attributeName ? `${objectType}.${attributeName}` : objectType || String(domainId || "")),
      objectType,
      attributeName,
      relationship,
      subjectType,
      Number(subjectId),
      input.is_primary ? 1 : 0,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = getOwnershipRow(db, Number(result.lastInsertRowid));
  writeAudit(db, {
    actor,
    action: "data_governance.ownership.create",
    resourceType: "dg_ownership",
    resourceId: row.id,
    details: { scope_type: scopeType, relationship, subject_type: subjectType, subject_id: subjectId },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DataOwnershipChanged",
    tenantId: Number(tenantId),
    objectType: objectType || "data_domain",
    objectId: domainId || subjectId,
    payload: { ownership_id: row.id, scope_type: scopeType, relationship, subject_type: subjectType, subject_id: subjectId },
  }, actor);
  return publicOwnership(row);
}

export function updateOwnership(db, id, patch = {}, actor = null) {
  const row = requireOwnership(db, id);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.subject_type !== undefined) assign("subject_type", assertSubjectType(normalizeText(patch.subject_type).toLowerCase()));
  if (patch.subject_id !== undefined) assign("subject_id", patch.subject_id === null ? null : Number(patch.subject_id));
  if (patch.is_primary !== undefined) assign("is_primary", patch.is_primary ? 1 : 0);
  if (patch.status !== undefined) assign("status", normalizeText(patch.status).toLowerCase() === "inactive" ? "inactive" : "active");
  if (patch.object_type !== undefined) assign("object_type", normalizeText(patch.object_type));
  if (patch.attribute_name !== undefined) assign("attribute_name", normalizeText(patch.attribute_name));
  if (!changes.length) return publicOwnership(row);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dg_ownership SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  return publicOwnership(getOwnershipRow(db, row.id));
}

export function deleteOwnership(db, id, actor = null, ip = null) {
  const row = requireOwnership(db, id);
  run(db, "UPDATE dg_ownership SET status = 'inactive', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  writeAudit(db, {
    actor,
    action: "data_governance.ownership.retire",
    resourceType: "dg_ownership",
    resourceId: row.id,
    details: { scope_type: row.scope_type, relationship: row.relationship },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DataOwnershipChanged",
    tenantId: row.tenant_id,
    objectType: row.object_type || "data_domain",
    objectId: row.domain_id || row.subject_id,
    payload: { ownership_id: row.id, status: "inactive" },
  }, actor);
  return publicOwnership(getOwnershipRow(db, row.id));
}

// Resolves the accountable subjects for a scope, most specific first: an
// attribute assignment outranks an object assignment which outranks the domain.
export function resolveOwnership(db, { tenantId, domainId = null, objectType = null, attributeName = null, relationship = "owner" } = {}) {
  const rows = queryAll(
    db,
    `SELECT * FROM dg_ownership
      WHERE tenant_id = ? AND status = 'active' AND relationship = ?
        AND (
          (scope_type = 'attribute' AND object_type = ? AND attribute_name = ?) OR
          (scope_type = 'object' AND object_type = ? AND attribute_name = '') OR
          (scope_type = 'domain' AND domain_id = ?)
        )`,
    [Number(tenantId), assertRelationship(relationship), objectType || "", attributeName || "", objectType || "", domainId ? Number(domainId) : -1]
  );
  const rank = { attribute: 3, object: 2, domain: 1 };
  rows.sort((a, b) => rank[b.scope_type] - rank[a.scope_type] || Number(b.is_primary) - Number(a.is_primary));
  return rows.map(publicOwnership);
}

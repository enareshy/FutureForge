// Ownership and stewardship for catalog entries.
//
// Four accountability kinds are supported per the spec: Data Owner, Data
// Steward, Technical Owner and Business Owner. A subject (user, group, role or
// organization) is accountable for a catalog entry. The catalog records
// accountability so exceptions, reminders and escalation can find the right
// person; it does not decide who may hold a role (IAM does).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  assertOwnershipKind,
  assertOwnershipRelationship,
  assertSubjectType,
  normalizeLower,
  normalizeUpper,
  normalizeText,
  paginate,
} from "./validation.js";
import { publicOwnership } from "./repository.js";
import { invalidOwnership, ownershipNotFound } from "./errors.js";
import { requireEntry, syncEntry } from "./entries.js";
import { publishCatalogEvent } from "./events.js";

export { publicOwnership };

const SUBJECT_TABLES = Object.freeze({ user: "users", group: "groups", organization: "organizations", role: "roles" });

export function getOwnershipRow(db, id, tenantId = null) {
  return tenantId
    ? queryOne(db, "SELECT * FROM dc_ownership WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)])
    : queryOne(db, "SELECT * FROM dc_ownership WHERE id = ?", [Number(id)]);
}

export function requireOwnership(db, id, tenantId = null) {
  const row = getOwnershipRow(db, id, tenantId);
  if (!row) throw ownershipNotFound(id);
  return row;
}

function assertSubjectExists(db, subjectType, subjectId) {
  if (subjectId === null || subjectId === undefined || subjectId === "") {
    throw invalidOwnership("A subject id is required for an ownership assignment");
  }
  const table = SUBJECT_TABLES[subjectType];
  if (!table) return;
  const row = queryOne(db, `SELECT id FROM ${table} WHERE id = ?`, [Number(subjectId)]);
  if (!row) throw invalidOwnership(`No ${subjectType} exists with id ${subjectId}`, { subject_type: subjectType, subject_id: subjectId });
}

export function listOwnership(db, { tenantId, entryId, relationship, ownershipKind, subjectType, subjectId, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (entryId !== undefined && entryId !== null && entryId !== "") {
    clauses.push("entry_id = ?");
    params.push(Number(entryId));
  }
  if (relationship) {
    clauses.push("relationship = ?");
    params.push(assertOwnershipRelationship(normalizeLower(relationship)));
  }
  if (ownershipKind) {
    clauses.push("ownership_kind = ?");
    params.push(assertOwnershipKind(normalizeUpper(ownershipKind)));
  }
  if (subjectType) {
    clauses.push("subject_type = ?");
    params.push(assertSubjectType(normalizeLower(subjectType)));
  }
  if (subjectId !== undefined && subjectId !== null && subjectId !== "") {
    clauses.push("subject_id = ?");
    params.push(Number(subjectId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeLower(status) === "inactive" ? "inactive" : "active");
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dc_ownership ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM dc_ownership ${where} ORDER BY relationship, ownership_kind, id LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  return { items: rows.map(publicOwnership), total, page: currentPage, page_size: limit };
}

export function assignOwnership(db, entryRefValue, input = {}, actor = null, tenantId = null, ip = null) {
  const entry = requireEntry(db, entryRefValue, { tenantId });
  const ownershipKind = assertOwnershipKind(normalizeUpper(input.ownership_kind || input.kind || "DATA_OWNER"));
  const relationship = assertOwnershipRelationship(
    normalizeLower(input.relationship || (ownershipKind === "DATA_STEWARD" ? "steward" : "owner"))
  );
  const subjectType = assertSubjectType(normalizeLower(input.subject_type || "user"));
  const subjectId = input.subject_id ?? input.subjectId ?? null;
  assertSubjectExists(db, subjectType, subjectId);

  const existing = queryOne(
    db,
    "SELECT * FROM dc_ownership WHERE tenant_id = ? AND entry_id = ? AND relationship = ? AND ownership_kind = ? AND subject_type = ? AND subject_id = ?",
    [entry.tenant_id, entry.id, relationship, ownershipKind, subjectType, Number(subjectId)]
  );
  if (existing) {
    run(db, "UPDATE dc_ownership SET status = 'active', is_primary = ?, updated_at = ? WHERE id = ?", [
      input.is_primary ? 1 : existing.is_primary,
      nowIso(),
      existing.id,
    ]);
    return publicOwnership(queryOne(db, "SELECT * FROM dc_ownership WHERE id = ?", [existing.id]));
  }

  if (input.is_primary) {
    run(db, "UPDATE dc_ownership SET is_primary = 0 WHERE tenant_id = ? AND entry_id = ? AND relationship = ? AND ownership_kind = ?", [
      entry.tenant_id,
      entry.id,
      relationship,
      ownershipKind,
    ]);
  }
  const ts = nowIso();
  const result = run(
    db,
    "INSERT INTO dc_ownership (tenant_id, entry_id, relationship, ownership_kind, subject_type, subject_id, is_primary, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
    [entry.tenant_id, entry.id, relationship, ownershipKind, subjectType, Number(subjectId), input.is_primary ? 1 : 0, actor?.id ?? null, ts, ts]
  );
  const row = queryOne(db, "SELECT * FROM dc_ownership WHERE id = ?", [Number(result.lastInsertRowid)]);

  // Mirror primary owner/steward onto the entry and its registry row so the
  // unified catalog list can show accountability without a join.
  if (relationship === "owner" && ownershipKind === "DATA_OWNER") {
    run(db, "UPDATE dc_entries SET owner_user_id = ?, owner_group_id = ?, updated_at = ? WHERE id = ?", [
      subjectType === "user" ? Number(subjectId) : null,
      subjectType === "group" ? Number(subjectId) : null,
      ts,
      entry.id,
    ]);
  }
  if (relationship === "steward") {
    run(db, "UPDATE dc_entries SET steward_user_id = ?, steward_group_id = ?, updated_at = ? WHERE id = ?", [
      subjectType === "user" ? Number(subjectId) : null,
      subjectType === "group" ? Number(subjectId) : null,
      ts,
      entry.id,
    ]);
  }
  syncEntry(db, entry.id, {}, actor);

  writeAudit(db, {
    actor,
    action: relationship === "steward" ? "data_catalog.stewardship.assign" : "data_catalog.ownership.assign",
    resourceType: "dc_ownership",
    resourceId: row.id,
    details: { entry_id: entry.id, ownership_kind: ownershipKind, subject_type: subjectType, subject_id: subjectId },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: relationship === "steward" ? "CatalogStewardChanged" : "CatalogOwnerChanged",
    tenantId: entry.tenant_id,
    objectType: "data_catalog_entry",
    objectId: entry.id,
    payload: { entry_id: entry.id, ownership_kind: ownershipKind, subject_type: subjectType, subject_id: subjectId, action: "assigned" },
  }, actor);
  return publicOwnership(row);
}

export function updateOwnership(db, id, patch = {}, actor = null, tenantId = null, ip = null) {
  const row = requireOwnership(db, id, tenantId);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.is_primary !== undefined) assign("is_primary", patch.is_primary ? 1 : 0);
  if (patch.status !== undefined) assign("status", normalizeLower(patch.status) === "inactive" ? "inactive" : "active");
  if (patch.ownership_kind !== undefined) assign("ownership_kind", assertOwnershipKind(normalizeUpper(patch.ownership_kind)));
  if (patch.subject_type !== undefined) assign("subject_type", assertSubjectType(normalizeLower(patch.subject_type)));
  if (!changes.length) return publicOwnership(row);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dc_ownership SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  return publicOwnership(queryOne(db, "SELECT * FROM dc_ownership WHERE id = ?", [row.id]));
}

export function removeOwnership(db, id, actor = null, tenantId = null, ip = null) {
  const row = requireOwnership(db, id, tenantId);
  run(db, "DELETE FROM dc_ownership WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: row.relationship === "steward" ? "data_catalog.stewardship.remove" : "data_catalog.ownership.remove",
    resourceType: "dc_ownership",
    resourceId: row.id,
    details: { entry_id: row.entry_id, ownership_kind: row.ownership_kind },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: row.relationship === "steward" ? "CatalogStewardChanged" : "CatalogOwnerChanged",
    tenantId: row.tenant_id,
    objectType: "data_catalog_entry",
    objectId: row.entry_id,
    payload: { entry_id: row.entry_id, ownership_kind: row.ownership_kind, action: "removed" },
    actor,
  });
  return { deleted: true, id: row.id };
}

// Resolves accountability for an entry, primary assignments first.
export function resolveOwnership(db, { entryId, relationship = null, tenantId = null } = {}) {
  const clauses = ["entry_id = ?", "status = 'active'"];
  const params = [Number(entryId)];
  if (tenantId) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (relationship) {
    clauses.push("relationship = ?");
    params.push(assertOwnershipRelationship(normalizeLower(relationship)));
  }
  return queryAll(db, `SELECT * FROM dc_ownership WHERE ${clauses.join(" AND ")} ORDER BY is_primary DESC, relationship, id`, params).map(
    publicOwnership
  );
}

export function ownersOf(db, entryId, tenantId = null) {
  return resolveOwnership(db, { entryId, relationship: "owner", tenantId });
}

export function stewardsOf(db, entryId, tenantId = null) {
  return resolveOwnership(db, { entryId, relationship: "steward", tenantId });
}

// Accountability summary for dashboards: entries with no primary owner/steward.
export function ownershipGaps(db, tenantId, { limit = 100 } = {}) {
  const rows = queryAll(
    db,
    `SELECT e.id, e.entry_ref, e.entry_type, e.code, e.name
       FROM dc_entries e
       WHERE e.tenant_id = ?
         AND e.status IN ('active', 'draft')
         AND NOT EXISTS (
           SELECT 1 FROM dc_ownership o
            WHERE o.tenant_id = e.tenant_id AND o.entry_id = e.id AND o.relationship = 'owner' AND o.status = 'active'
         )
       ORDER BY e.entry_type, e.code
       LIMIT ?`,
    [Number(tenantId), Number(limit)]
  );
  return rows.map((row) => ({ ...row, name: normalizeText(row.name) }));
}

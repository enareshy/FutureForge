import { queryAll, queryOne, run, nowIso, randomUuid, transaction } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import * as metadata from "../metadata.js";
import * as tenants from "../tenants.js";
import { OBJECT_STATUSES, normalizeTags, assertStatus } from "./validation.js";
import {
  getObjectRow,
  findObjectRow,
  listObjectRows,
  publicObject,
  activeCheckoutRow,
  listCheckoutRows,
} from "./repository.js";
import { safeDeleteReport } from "./references.js";

// Object domain service: metadata-typed business instances with lifecycle,
// revisioning, check-out locking, soft deletion, bulk operations and search.
// Attribute payloads are validated by the metadata engine before persistence.

const OBJECT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function validateObjectCode(code) {
  if (!OBJECT_CODE_RE.test(code)) {
    throw new HttpError(400, "Object code must start alphanumeric and use letters, digits, . _ / -");
  }
}

function assertTenant(tenantId) {
  if (!tenantId) throw new HttpError(400, "Tenant context is required for object operations");
  return Number(tenantId);
}

function publicCheckout(row) {
  if (!row) return null;
  return {
    id: row.id,
    object_id: row.object_id,
    locked_by: row.locked_by,
    locked_by_username: row.locked_by_username ?? null,
    scope: row.scope,
    reason: row.reason || "",
    expires_at: row.expires_at || null,
    released_at: row.released_at || null,
    released_by: row.released_by ?? null,
    created_at: row.created_at,
  };
}

function snapshot(row) {
  return {
    id: row.id,
    uuid: row.uuid,
    code: row.code,
    object_type_id: row.object_type_id,
    name: row.name,
    description: row.description,
    status: row.status,
    revision: row.revision,
    data: safeParse(row.data_json, {}),
    owner_id: row.owner_id,
    owner_object_id: row.owner_object_id,
    organization_id: row.organization_id,
    tenant_id: row.tenant_id,
    external_ref: row.external_ref,
    external_system: row.external_system,
    tags: safeParse(row.tags_json, []),
    deleted_at: row.deleted_at,
  };
}

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function recordObjectVersion(db, row, changeType, summary, actorId) {
  run(
    db,
    `INSERT INTO object_versions (object_id, revision, change_type, snapshot, change_summary, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.revision, changeType, JSON.stringify(snapshot(row)), summary || "", actorId ?? null]
  );
}

function assertWritable(db, row, actor) {
  const lock = activeCheckoutRow(db, row.id);
  if (!lock) return;
  if (actor?.id && Number(lock.locked_by) === Number(actor.id)) return;
  if (tenants.isPlatformAdmin(db, actor?.id)) return;
  throw new HttpError(409, "Object is checked out by another user", {
    locked_by: lock.locked_by,
    object_id: row.id,
  });
}

function resolveType(db, body, tenantId) {
  const typeRef =
    body.type ?? body.typeId ?? body.type_id ?? body.objectTypeId ?? body.object_type_id;
  if (typeRef === undefined || typeRef === null || typeRef === "") {
    throw new HttpError(400, "Object type is required");
  }
  const typeRow = metadata.findType(db, typeRef, tenantId);
  if (!typeRow) throw new HttpError(404, "Type not found");
  if (typeRow.status !== "active") {
    throw new HttpError(409, `Type ${typeRow.code} is not active and cannot hold objects`);
  }
  return typeRow;
}

function resolveOrganization(db, body, actor, tenantId) {
  const raw = body.organization_id ?? body.organizationId;
  if (raw === undefined && body.organization !== undefined) {
    return body.organization;
  }
  if (raw === undefined || raw === null || raw === "" || raw === "global") {
    const fallback = actor?.organization_id ?? null;
    if (!fallback) return null;
    return tenants.assertOrgInTenant(db, fallback, tenantId) ? Number(fallback) : null;
  }
  const org = tenants.assertOrgInTenant(db, Number(raw), tenantId);
  return org ? Number(org.id) : null;
}

function generateObjectCode(db, typeCode, tenantId) {
  const prefix = String(typeCode).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "OBJ";
  let seq = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM objects o JOIN metadata_types t ON t.id = o.object_type_id
     WHERE o.tenant_id = ? AND t.code = ?`,
    [Number(tenantId), typeCode]
  ).c + 1;
  for (let i = 0; i < 100000; i += 1) {
    const code = `${prefix}-${String(seq).padStart(6, "0")}`;
    const exists = queryOne(db, "SELECT 1 AS x FROM objects WHERE tenant_id = ? AND code = ?", [
      Number(tenantId),
      code,
    ]);
    if (!exists) return code;
    seq += 1;
  }
  throw new HttpError(500, "Unable to allocate an object code");
}

function resolveOwner(db, body, actor, tenantId) {
  const raw = body.owner_id ?? body.ownerId;
  if (raw === undefined || raw === null || raw === "") return actor?.id ?? null;
  const ownerId = Number(raw);
  const user = queryOne(db, "SELECT id, tenant_id FROM users WHERE id = ?", [ownerId]);
  if (!user) throw new HttpError(400, "Owner not found");
  if (user.tenant_id && Number(user.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Owner not found");
  }
  return ownerId;
}

function resolveOwnerObject(db, body, tenantId) {
  const raw = body.owner_object_id ?? body.ownerObjectId;
  if (raw === undefined || raw === null || raw === "") return null;
  const ownerRow = findObjectRow(db, raw, tenantId);
  return ownerRow.id;
}

export function createObject(db, body, actor, tenantId, ip) {
  assertTenant(tenantId);
  tenants.assertTenantScope(db, actor, tenantId);
  const typeRow = resolveType(db, body, tenantId);
  metadata.assertEnabled(db, "type", typeRow.id, {
    tenantId,
    organizationId: body.organization_id ?? body.organizationId,
  });

  const organizationId = resolveOrganization(db, body, actor, tenantId);
  const values = body.data ?? body.values ?? body.attributes ?? {};
  const validation = metadata.assertValidRecord(
    db,
    { typeId: typeRow.id, values, user: actor, organization: organizationId },
    tenantId
  );

  const code = body.code ? String(body.code).trim() : generateObjectCode(db, typeRow.code, tenantId);
  validateObjectCode(code);
  const status = assertStatus(body.status || "draft", OBJECT_STATUSES, "status must be one of");
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO objects
        (uuid, code, object_type_id, name, description, status, revision, data_json,
         owner_id, owner_object_id, organization_id, tenant_id, external_ref, external_system,
         tags_json, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUuid(),
        code,
        typeRow.id,
        String(body.name || code).trim(),
        body.description || "",
        status,
        JSON.stringify(validation.values),
        resolveOwner(db, body, actor, tenantId),
        resolveOwnerObject(db, body, tenantId),
        organizationId,
        Number(tenantId),
        body.external_ref || body.externalRef || "",
        body.external_system || body.externalSystem || "",
        JSON.stringify(normalizeTags(body.tags)),
        actor?.id ?? null,
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Object code already exists in this tenant");
    }
    throw err;
  }
  const row = getObjectRow(db, result.lastInsertRowid);
  recordObjectVersion(db, row, "create", body.change_summary || "Object created", actor?.id);
  writeAudit(db, {
    actor,
    action: "object.create",
    resourceType: "object",
    resourceId: row.id,
    details: { code: row.code, type: typeRow.code, tenant_id: Number(tenantId) },
    ip,
  });
  return publicObject(row);
}

export function getObject(db, reference, tenantId) {
  assertTenant(tenantId);
  return publicObject(findObjectRow(db, reference, tenantId));
}

export function listObjects(db, query = {}, tenantId) {
  assertTenant(tenantId);
  const { rows, total, page, pageSize } = listObjectRows(db, query, tenantId);
  return { items: rows.map(publicObject), total, page, pageSize };
}

export function updateObject(db, reference, body, actor, tenantId, ip) {
  assertTenant(tenantId);
  tenants.assertTenantScope(db, actor, tenantId);
  const row = findObjectRow(db, reference, tenantId);
  if (row.deleted_at) throw new HttpError(409, "Cannot update a deleted object");
  assertWritable(db, row, actor);
  if (body.revision !== undefined && Number(body.revision) !== Number(row.revision)) {
    throw new HttpError(409, "Revision conflict", { expected: row.revision, received: Number(body.revision) });
  }

  const current = snapshot(row);
  const providedValues = body.data ?? body.values ?? body.attributes;
  let dataJson = row.data_json;
  if (providedValues !== undefined) {
    const merged = { ...current.data, ...providedValues };
    const validation = metadata.assertValidRecord(
      db,
      {
        typeId: row.object_type_id,
        values: merged,
        user: actor,
        organization: body.organization_id ?? row.organization_id,
      },
      tenantId
    );
    dataJson = JSON.stringify(validation.values);
  }

  const organizationId =
    body.organization_id === undefined && body.organizationId === undefined
      ? row.organization_id
      : resolveOrganization(db, body, actor, tenantId);
  const ownerId =
    body.owner_id === undefined && body.ownerId === undefined
      ? row.owner_id
      : resolveOwner(db, body, actor, tenantId);
  const ownerObjectId =
    body.owner_object_id === undefined && body.ownerObjectId === undefined
      ? row.owner_object_id
      : resolveOwnerObject(db, body, tenantId);
  const status = body.status
    ? assertStatus(body.status, OBJECT_STATUSES, "status must be one of")
    : row.status;
  const code = body.code !== undefined ? String(body.code).trim() : row.code;
  validateObjectCode(code);

  const nextRevision = Number(row.revision) + 1;
  try {
    run(
      db,
      `UPDATE objects SET
        code = ?, name = ?, description = ?, status = ?, revision = ?, data_json = ?,
        owner_id = ?, owner_object_id = ?, organization_id = ?, external_ref = ?, external_system = ?,
        tags_json = ?, updated_by = ?, updated_at = ?
       WHERE id = ?`,
      [
        code,
        String(body.name ?? row.name).trim(),
        body.description ?? row.description,
        status,
        nextRevision,
        dataJson,
        ownerId,
        ownerObjectId,
        organizationId,
        body.external_ref ?? body.externalRef ?? row.external_ref,
        body.external_system ?? body.externalSystem ?? row.external_system,
        body.tags === undefined ? row.tags_json : JSON.stringify(normalizeTags(body.tags)),
        actor?.id ?? null,
        nowIso(),
        row.id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Object code already exists in this tenant");
    }
    throw err;
  }
  const next = getObjectRow(db, row.id);
  recordObjectVersion(db, next, "update", body.change_summary || "Object updated", actor?.id);
  writeAudit(db, {
    actor,
    action: "object.update",
    resourceType: "object",
    resourceId: row.id,
    details: { code: next.code, revision: next.revision },
    ip,
  });
  return publicObject(next);
}

export function setObjectStatus(db, reference, status, actor, tenantId, ip) {
  assertTenant(tenantId);
  tenants.assertTenantScope(db, actor, tenantId);
  assertStatus(status, OBJECT_STATUSES, "status must be one of");
  const row = findObjectRow(db, reference, tenantId);
  if (row.deleted_at) throw new HttpError(409, "Cannot change the status of a deleted object");
  assertWritable(db, row, actor);
  const nextRevision = Number(row.revision) + 1;
  run(db, "UPDATE objects SET status = ?, revision = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    status,
    nextRevision,
    actor?.id ?? null,
    nowIso(),
    row.id,
  ]);
  const next = getObjectRow(db, row.id);
  recordObjectVersion(db, next, "status", `Status set to ${status}`, actor?.id);
  writeAudit(db, {
    actor,
    action: `object.status.${status}`,
    resourceType: "object",
    resourceId: row.id,
    details: { code: next.code, status },
    ip,
  });
  return publicObject(next);
}

export function listObjectVersions(db, reference, tenantId, { page, pageSize } = {}) {
  const row = findObjectRow(db, reference, tenantId);
  const limit = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * limit);
  const items = queryAll(
    db,
    `SELECT v.*, u.username AS created_username
     FROM object_versions v LEFT JOIN users u ON u.id = v.created_by
     WHERE v.object_id = ? ORDER BY v.revision DESC LIMIT ? OFFSET ?`,
    [row.id, limit, offset]
  ).map((v) => ({ ...v, snapshot: safeParse(v.snapshot, {}) }));
  const total = queryOne(db, "SELECT COUNT(*) AS c FROM object_versions WHERE object_id = ?", [row.id]).c;
  return { items, total };
}

export function getObjectVersion(db, reference, revision, tenantId) {
  const row = findObjectRow(db, reference, tenantId);
  const version = queryOne(
    db,
    "SELECT * FROM object_versions WHERE object_id = ? AND revision = ?",
    [row.id, Number(revision)]
  );
  if (!version) throw new HttpError(404, "Object revision not found");
  return { ...version, snapshot: safeParse(version.snapshot, {}) };
}

export function checkoutObject(db, reference, body, actor, tenantId, ip) {
  assertTenant(tenantId);
  tenants.assertTenantScope(db, actor, tenantId);
  const row = findObjectRow(db, reference, tenantId);
  if (row.deleted_at) throw new HttpError(409, "Cannot check out a deleted object");
  const existing = activeCheckoutRow(db, row.id);
  if (existing) {
    if (actor?.id && Number(existing.locked_by) === Number(actor.id)) {
      return { object: publicObject(row), checkout: publicCheckout(existing) };
    }
    throw new HttpError(409, "Object is already checked out", { locked_by: existing.locked_by });
  }
  const scope = ["exclusive", "shared"].includes(body?.scope) ? body.scope : "exclusive";
  const ttlMinutes = Number(body?.ttlMinutes ?? body?.ttl_minutes);
  const expiresAt = Number.isFinite(ttlMinutes) && ttlMinutes > 0
    ? new Date(Date.now() + ttlMinutes * 60000).toISOString().replace("T", " ").slice(0, 19)
    : null;
  const result = run(
    db,
    `INSERT INTO object_checkouts (object_id, locked_by, scope, reason, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, actor?.id ?? null, scope, body?.reason || "", expiresAt, nowIso()]
  );
  writeAudit(db, {
    actor,
    action: "object.checkout",
    resourceType: "object",
    resourceId: row.id,
    details: { code: row.code, scope, expires_at: expiresAt },
    ip,
  });
  const checkout = queryOne(
    db,
    `SELECT ck.*, u.username AS locked_by_username FROM object_checkouts ck
     LEFT JOIN users u ON u.id = ck.locked_by WHERE ck.id = ?`,
    [result.lastInsertRowid]
  );
  return { object: publicObject(getObjectRow(db, row.id)), checkout: publicCheckout(checkout) };
}

export function checkinObject(db, reference, body, actor, tenantId, ip) {
  assertTenant(tenantId);
  tenants.assertTenantScope(db, actor, tenantId);
  const row = findObjectRow(db, reference, tenantId);
  const lock = activeCheckoutRow(db, row.id);
  if (!lock) throw new HttpError(409, "Object is not checked out");
  const force = body?.force === true;
  if (!force && actor?.id && Number(lock.locked_by) !== Number(actor.id) && !tenants.isPlatformAdmin(db, actor?.id)) {
    throw new HttpError(403, "Object is checked out by another user");
  }
  run(db, "UPDATE object_checkouts SET released_at = ?, released_by = ? WHERE id = ?", [
    nowIso(),
    actor?.id ?? null,
    lock.id,
  ]);
  writeAudit(db, {
    actor,
    action: "object.checkin",
    resourceType: "object",
    resourceId: row.id,
    details: { code: row.code, forced: force },
    ip,
  });
  return { object: publicObject(getObjectRow(db, row.id)), released: publicCheckout(lock) };
}

export function objectLocks(db, reference, tenantId) {
  const row = findObjectRow(db, reference, tenantId);
  return { items: listCheckoutRows(db, row.id).map(publicCheckout) };
}

export function objectTypes(db, tenantId) {
  assertTenant(tenantId);
  const items = queryAll(
    db,
    `SELECT t.id, t.code, t.name, t.module, t.status, t.parent_type_id,
       (SELECT COUNT(*) FROM objects o WHERE o.object_type_id = t.id AND o.deleted_at IS NULL) AS object_count,
       (SELECT COUNT(*) FROM relationship_types rt
          WHERE rt.status = 'active' AND (rt.source_type_id = t.id OR rt.target_type_id = t.id)) AS relationship_type_count
     FROM metadata_types t
     WHERE (t.tenant_id IS NULL OR t.tenant_id = ?) AND t.status = 'active'
     ORDER BY t.code`,
    [Number(tenantId)]
  );
  return { items };
}

export function bulkCreateObjects(db, items, actor, tenantId, ip) {
  assertTenant(tenantId);
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, "items must be a non-empty array");
  if (items.length > 500) throw new HttpError(400, "At most 500 items per bulk request");
  return transaction(db, () => {
    const created = [];
    const failed = [];
    items.forEach((item, index) => {
      try {
        created.push(createObject(db, item, actor, tenantId, ip));
      } catch (err) {
        failed.push({ index, error: err.message, status: err.status || 500, details: err.details || null });
      }
    });
    return { created, failed, created_count: created.length, failed_count: failed.length };
  });
}

export function bulkMutateObjects(db, input, actor, tenantId, ip) {
  assertTenant(tenantId);
  const ids = Array.isArray(input?.ids) ? input.ids : [];
  if (!ids.length) throw new HttpError(400, "ids must be a non-empty array");
  if (ids.length > 500) throw new HttpError(400, "At most 500 ids per bulk request");
  const operation = input?.operation || "update";
  if (!["update", "delete", "restore", "status"].includes(operation)) {
    throw new HttpError(400, "operation must be update, delete, restore or status");
  }
  const patch = input?.patch || {};
  return transaction(db, () => {
    const updated = [];
    const failed = [];
    for (const id of ids) {
      try {
        if (operation === "delete") {
          updated.push(softDeleteObject(db, id, { force: input.force === true }, actor, tenantId, ip));
        } else if (operation === "restore") {
          updated.push(restoreObject(db, id, actor, tenantId, ip));
        } else if (operation === "status") {
          updated.push(setObjectStatus(db, id, patch.status, actor, tenantId, ip));
        } else {
          updated.push(updateObject(db, id, patch, actor, tenantId, ip));
        }
      } catch (err) {
        failed.push({ id, error: err.message, status: err.status || 500, details: err.details || null });
      }
    }
    return { items: updated, failed, updated_count: updated.length, failed_count: failed.length };
  });
}

// Soft delete with referential-integrity checks. Composition children cascade;
// active relationships are retired so the record can be restored coherently.
export function softDeleteObject(db, reference, { force = false, summary } = {}, actor, tenantId, ip) {
  assertTenant(tenantId);
  tenants.assertTenantScope(db, actor, tenantId);
  const row = findObjectRow(db, reference, tenantId);
  if (row.deleted_at) throw new HttpError(409, "Object is already deleted");
  const report = safeDeleteReport(db, row.id, tenantId);
  if (report.blockers.length && !force) {
    throw new HttpError(409, "Object has references or relationships that block deletion", report);
  }
  return transaction(db, () => {
    for (const child of report.cascade) {
      const childRow = queryOne(db, "SELECT * FROM objects WHERE id = ?", [child.id]);
      if (childRow && !childRow.deleted_at) {
        softDeleteObject(db, childRow.id, { force: true, summary: "Cascade from " + row.code }, actor, tenantId, ip);
      }
    }
    run(
      db,
      "UPDATE object_relationships SET status = 'inactive', deleted_at = ?, updated_at = ? WHERE (source_object_id = ? OR target_object_id = ?) AND deleted_at IS NULL",
      [nowIso(), nowIso(), row.id, row.id]
    );
    run(db, "UPDATE objects SET deleted_at = ?, deleted_by = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ?", [
      nowIso(),
      actor?.id ?? null,
      actor?.id ?? null,
      nowIso(),
      row.id,
    ]);
    const next = getObjectRow(db, row.id);
    recordObjectVersion(db, next, force ? "force_delete" : "delete", summary || "Object deleted", actor?.id);
    writeAudit(db, {
      actor,
      action: force ? "object.force_delete" : "object.delete",
      resourceType: "object",
      resourceId: row.id,
      details: { code: row.code, cascade: report.cascade.length, forced: force },
      ip,
    });
    return publicObject(next);
  });
}

export function restoreObject(db, reference, actor, tenantId, ip) {
  assertTenant(tenantId);
  tenants.assertTenantScope(db, actor, tenantId);
  const row = findObjectRow(db, reference, tenantId);
  if (!row.deleted_at) throw new HttpError(409, "Object is not deleted");
  const nextRevision = Number(row.revision) + 1;
  run(
    db,
    "UPDATE objects SET deleted_at = NULL, deleted_by = NULL, revision = ?, updated_by = ?, updated_at = ? WHERE id = ?",
    [nextRevision, actor?.id ?? null, nowIso(), row.id]
  );
  const next = getObjectRow(db, row.id);
  recordObjectVersion(db, next, "restore", "Object restored", actor?.id);
  writeAudit(db, {
    actor,
    action: "object.restore",
    resourceType: "object",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return publicObject(next);
}

export function objectSummary(db, tenantId) {
  assertTenant(tenantId);
  const total = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM objects WHERE tenant_id = ? AND deleted_at IS NULL",
    [Number(tenantId)]
  ).c;
  const deleted = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM objects WHERE tenant_id = ? AND deleted_at IS NOT NULL",
    [Number(tenantId)]
  ).c;
  const byStatus = queryAll(
    db,
    "SELECT status, COUNT(*) AS count FROM objects WHERE tenant_id = ? AND deleted_at IS NULL GROUP BY status ORDER BY status",
    [Number(tenantId)]
  );
  const byType = queryAll(
    db,
    `SELECT t.code AS type_code, t.name AS type_name, COUNT(o.id) AS count
     FROM objects o JOIN metadata_types t ON t.id = o.object_type_id
     WHERE o.tenant_id = ? AND o.deleted_at IS NULL GROUP BY t.id ORDER BY count DESC LIMIT 20`,
    [Number(tenantId)]
  );
  return { total, deleted, by_status: byStatus, by_type: byType };
}

import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { readTenant, writeTenant, tenantClause, assertReadable, assertMutable } from "../metadata/scope.js";
import * as metadata from "../metadata.js";
import {
  STATUS_CATEGORIES,
  LEGACY_OBJECT_STATUSES,
  assertOneOf,
  assertCategory,
} from "./validation.js";

// Configurable status definitions. Statuses are platform configuration metadata
// scoped exactly like metadata artifacts: tenant_id NULL is global (readable by
// every tenant, writable only by platform admins), otherwise tenant-local.
// Business objects resolve statuses through here; nothing downstream hard-codes
// status codes.

export function publicStatus(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    label: row.label || row.name,
    description: row.description || "",
    category: row.category,
    module: row.module,
    owner: row.owner || "",
    legacy_status: row.legacy_status,
    display_order: row.display_order,
    color: row.color || "",
    is_default: row.is_default === 1,
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    is_system: row.is_system === 1,
    available_types: (row.available_type_codes || "").split(",").filter(Boolean).map((pair) => {
      const [id, code] = pair.split(":");
      return { id: Number(id), code };
    }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const STATUS_SELECT = `
  SELECT s.*,
    (SELECT group_concat(a.type_id || ':' || t.code, ',')
       FROM status_type_availability a
       JOIN metadata_types t ON t.id = a.type_id
      WHERE a.status_id = s.id) AS available_type_codes
  FROM lifecycle_statuses s
`;

export function getStatusRow(db, id) {
  return queryOne(db, `${STATUS_SELECT} WHERE s.id = ?`, [Number(id)]);
}

export function findStatus(db, idOrCode, tenantId) {
  if (idOrCode === undefined || idOrCode === null || idOrCode === "") return null;
  const text = String(idOrCode);
  if (/^\d+$/.test(text)) {
    const byId = getStatusRow(db, Number(text));
    if (byId) {
      assertReadable(byId, tenantId, "Status not found");
      return byId;
    }
  }
  const scope = tenantClause("s", tenantId);
  const byCode = queryOne(
    db,
    `${STATUS_SELECT} WHERE s.code = ? AND ${scope.sql} ORDER BY s.tenant_id IS NULL LIMIT 1`,
    [text, ...scope.params]
  );
  if (!byCode) throw new HttpError(404, "Status not found");
  return byCode;
}

export function getStatus(db, idOrCode, tenantId) {
  return publicStatus(findStatus(db, idOrCode, tenantId));
}

export function listStatuses(db, query = {}, tenantId) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("s", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.category) {
    assertCategory(query.category);
    where.push("s.category = ?");
    params.push(query.category);
  }
  if (query.module) {
    where.push("s.module = ?");
    params.push(query.module);
  }
  if (query.status) {
    where.push("s.status = ?");
    params.push(query.status);
  }
  if (query.legacy_status) {
    where.push("s.legacy_status = ?");
    params.push(query.legacy_status);
  }
  if (query.typeId || query.type_id) {
    const typeId = Number(query.typeId || query.type_id);
    where.push(
      `(NOT EXISTS (SELECT 1 FROM status_type_availability a WHERE a.status_id = s.id)
        OR EXISTS (SELECT 1 FROM status_type_availability a WHERE a.status_id = s.id AND a.type_id = ?))`
    );
    params.push(typeId);
  }
  if (query.q) {
    where.push("(s.code LIKE ? OR s.name LIKE ? OR s.label LIKE ? OR s.description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM lifecycle_statuses s ${clause}`, params).c;
  const items = queryAll(
    db,
    `${STATUS_SELECT} ${clause} ORDER BY s.display_order, s.code LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicStatus);
  return { items, total, page, pageSize };
}

function normalizeAvailability(db, body, tenantId, actor) {
  const raw = body.available_types ?? body.availableTypes ?? body.type_ids ?? body.typeIds;
  if (raw === undefined) return null;
  if (raw === null || raw === "any" || raw === "all") return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "available_types must be an array of type ids or codes");
  const ids = [];
  for (const ref of raw) {
    const type = metadata.findType(db, ref, tenantId);
    if (!type) throw new HttpError(400, `Object type ${ref} not found`);
    ids.push(type.id);
  }
  return [...new Set(ids)];
}

function replaceAvailability(db, statusId, typeIds) {
  run(db, "DELETE FROM status_type_availability WHERE status_id = ?", [statusId]);
  for (const typeId of typeIds) {
    run(db, "INSERT OR IGNORE INTO status_type_availability (status_id, type_id, created_at) VALUES (?, ?, ?)", [
      statusId,
      typeId,
      nowIso(),
    ]);
  }
}

export function createStatus(db, body, actor, ip, reqTenantId, query = {}) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "Status code");
  const tenantId = writeTenant(db, actor, body, reqTenantId);
  const category = assertCategory(body.category || "draft");
  const legacy = assertOneOf(body.legacy_status || legacyForCategory(category), LEGACY_OBJECT_STATUSES, "legacy_status");
  const status = assertOneOf(body.status || "active", ["active", "inactive"], "status");
  const availability = normalizeAvailability(db, body, tenantId, actor);
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO lifecycle_statuses
        (code, name, label, description, category, module, owner, legacy_status, display_order,
         color, is_default, status, tenant_id, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.label || String(body.name).trim(),
        body.description || "",
        category,
        body.module || "platform",
        body.owner || "",
        legacy,
        Number(body.display_order ?? body.displayOrder ?? 0) || 0,
        body.color || "",
        body.is_default || body.isDefault ? 1 : 0,
        status,
        tenantId ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Status code already exists in this scope");
    }
    throw err;
  }
  if (availability) replaceAvailability(db, result.lastInsertRowid, availability);
  if ((body.is_default || body.isDefault) && tenantId) {
    run(db, "UPDATE lifecycle_statuses SET is_default = 0 WHERE tenant_id = ? AND id != ?", [tenantId, result.lastInsertRowid]);
  }
  const row = getStatusRow(db, result.lastInsertRowid);
  writeAudit(db, {
    actor,
    action: "lifecycle.status.create",
    resourceType: "lifecycle_status",
    resourceId: row.id,
    details: { code: row.code, category, tenant_id: tenantId ?? null },
    ip,
  });
  return publicStatus(row);
}

export function updateStatus(db, id, body, actor, ip, tenantId) {
  const row = getStatusRow(db, id);
  assertMutable(db, row, tenantId, actor, "Status not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "Status code");
  const category = body.category === undefined ? row.category : assertCategory(body.category);
  const legacy =
    body.legacy_status === undefined
      ? row.legacy_status
      : assertOneOf(body.legacy_status, LEGACY_OBJECT_STATUSES, "legacy_status");
  const status = body.status === undefined ? row.status : assertOneOf(body.status, ["active", "inactive"], "status");
  const availability = normalizeAvailability(db, body, row.tenant_id ?? tenantId, actor);
  try {
    run(
      db,
      `UPDATE lifecycle_statuses SET
        code = ?, name = ?, label = ?, description = ?, category = ?, module = ?, owner = ?,
        legacy_status = ?, display_order = ?, color = ?, is_default = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? row.code,
        String(body.name ?? row.name).trim(),
        body.label ?? row.label,
        body.description ?? row.description,
        category,
        body.module ?? row.module,
        body.owner ?? row.owner,
        legacy,
        body.display_order === undefined && body.displayOrder === undefined
          ? row.display_order
          : Number(body.display_order ?? body.displayOrder) || 0,
        body.color ?? row.color,
        body.is_default === undefined && body.isDefault === undefined
          ? row.is_default
          : body.is_default || body.isDefault
            ? 1
            : 0,
        status,
        nowIso(),
        row.id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Status code already exists in this scope");
    }
    throw err;
  }
  if (availability) replaceAvailability(db, row.id, availability);
  const next = getStatusRow(db, row.id);
  if (next.is_default && next.tenant_id) {
    run(db, "UPDATE lifecycle_statuses SET is_default = 0 WHERE tenant_id = ? AND id != ?", [next.tenant_id, row.id]);
  }
  writeAudit(db, {
    actor,
    action: "lifecycle.status.update",
    resourceType: "lifecycle_status",
    resourceId: row.id,
    details: { code: next.code },
    ip,
  });
  return publicStatus(next);
}

export function setStatusStatus(db, id, status, actor, ip, tenantId) {
  assertOneOf(status, ["active", "inactive"], "status");
  const row = getStatusRow(db, id);
  assertMutable(db, row, tenantId, actor, "Status not found");
  run(db, "UPDATE lifecycle_statuses SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), row.id]);
  writeAudit(db, {
    actor,
    action: `lifecycle.status.${status}`,
    resourceType: "lifecycle_status",
    resourceId: row.id,
    ip,
  });
  return publicStatus(getStatusRow(db, row.id));
}

export function deleteStatus(db, id, actor, ip, tenantId) {
  const row = getStatusRow(db, id);
  assertMutable(db, row, tenantId, actor, "Status not found");
  const usedByObjects = queryOne(db, "SELECT COUNT(*) AS c FROM objects WHERE lifecycle_status_id = ?", [row.id]).c;
  if (usedByObjects) {
    throw new HttpError(409, "Cannot delete a status assigned to existing objects");
  }
  const usedByStates = queryOne(db, "SELECT COUNT(*) AS c FROM lifecycle_states WHERE status_id = ?", [row.id]).c;
  if (usedByStates) {
    throw new HttpError(409, "Cannot delete a status referenced by lifecycle states");
  }
  run(db, "DELETE FROM lifecycle_statuses WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "lifecycle.status.delete",
    resourceType: "lifecycle_status",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return { deleted: true, id: row.id };
}

export function defaultStatusRow(db, tenantId) {
  const scope = tenantClause("s", tenantId);
  return queryOne(
    db,
    `${STATUS_SELECT} WHERE ${scope.sql} AND s.status = 'active' AND s.is_default = 1
     ORDER BY s.tenant_id IS NULL LIMIT 1`,
    scope.params
  );
}

export function legacyForCategory(category) {
  switch (category) {
    case "draft":
      return "draft";
    case "released":
      return "released";
    case "obsolete":
    case "cancelled":
      return "obsolete";
    default:
      return "active";
  }
}

export function readStatusTenant(db, actor, query, reqTenantId) {
  return readTenant(db, actor, query, reqTenantId);
}

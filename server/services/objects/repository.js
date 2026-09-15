import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";

// Object persistence layer. All SQL for the objects table (plus the type/owner
// projections it needs) lives here so the domain service stays free of queries.
// Every read is tenant-filtered; cross-tenant lookups return 404.

const SORTABLE = {
  id: "o.id",
  code: "o.code",
  name: "o.name",
  status: "o.status",
  revision: "o.revision",
  created_at: "o.created_at",
  updated_at: "o.updated_at",
};

const OBJECT_SELECT = `
  SELECT o.*,
    t.code AS type_code, t.name AS type_name, t.module AS type_module,
    u.username AS owner_username, u.display_name AS owner_display_name,
    cb.username AS created_username,
    (SELECT COUNT(*) FROM object_checkouts ck
       WHERE ck.object_id = o.id AND ck.released_at IS NULL
         AND (ck.expires_at IS NULL OR ck.expires_at > datetime('now'))) AS active_lock_count,
    (SELECT ck.locked_by FROM object_checkouts ck
       WHERE ck.object_id = o.id AND ck.released_at IS NULL
         AND (ck.expires_at IS NULL OR ck.expires_at > datetime('now'))
       ORDER BY ck.id DESC LIMIT 1) AS lock_owner_id
  FROM objects o
  JOIN metadata_types t ON t.id = o.object_type_id
  LEFT JOIN users u ON u.id = o.owner_id
  LEFT JOIN users cb ON cb.id = o.created_by
`;

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function getObjectRow(db, id) {
  return queryOne(db, `${OBJECT_SELECT} WHERE o.id = ?`, [Number(id)]);
}

export function getObjectRowByUuid(db, uuid) {
  if (!uuid) return null;
  return queryOne(db, `${OBJECT_SELECT} WHERE o.uuid = ?`, [String(uuid)]);
}

// Accepts a numeric id, uuid, or tenant-unique code. Codes are only unique per
// tenant, so the tenant must always be supplied.
export function findObjectRow(db, reference, tenantId) {
  if (reference === undefined || reference === null || reference === "") return null;
  const text = String(reference);
  if (/^\d+$/.test(text)) {
    const byId = getObjectRow(db, Number(text));
    if (byId) {
      assertRowTenant(byId, tenantId);
      return byId;
    }
  }
  const byUuid = getObjectRowByUuid(db, text);
  if (byUuid) {
    assertRowTenant(byUuid, tenantId);
    return byUuid;
  }
  if (!tenantId) throw new HttpError(404, "Object not found");
  const byCode = queryOne(db, `${OBJECT_SELECT} WHERE o.tenant_id = ? AND o.code = ?`, [
    Number(tenantId),
    text,
  ]);
  if (!byCode) throw new HttpError(404, "Object not found");
  return byCode;
}

export function assertRowTenant(row, tenantId) {
  if (!row) throw new HttpError(404, "Object not found");
  if (!tenantId || Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Object not found");
  }
  return row;
}

export function publicObject(row) {
  if (!row) return null;
  const locked = Number(row.active_lock_count || 0) > 0;
  return {
    id: row.id,
    uuid: row.uuid,
    code: row.code,
    name: row.name,
    description: row.description || "",
    status: row.status,
    revision: row.revision,
    object_type_id: row.object_type_id,
    type: { id: row.object_type_id, code: row.type_code, name: row.type_name, module: row.type_module },
    data: safeParse(row.data_json, {}),
    owner_id: row.owner_id ?? null,
    owner: row.owner_id
      ? { id: row.owner_id, username: row.owner_username, display_name: row.owner_display_name }
      : null,
    owner_object_id: row.owner_object_id ?? null,
    organization_id: row.organization_id ?? null,
    tenant_id: row.tenant_id,
    external_ref: row.external_ref || "",
    external_system: row.external_system || "",
    tags: safeParse(row.tags_json, []),
    locked,
    lock: locked
      ? { locked_by: row.lock_owner_id ?? null, exclusive: true }
      : null,
    created_by: row.created_by ?? null,
    created_username: row.created_username || null,
    updated_by: row.updated_by ?? null,
    deleted: Boolean(row.deleted_at),
    deleted_at: row.deleted_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Lightweight projection used by traversal and graph exports.
export function briefObject(db, id, tenantId) {
  const row = getObjectRow(db, id);
  if (!row) return null;
  if (!tenantId || Number(row.tenant_id) !== Number(tenantId)) return null;
  return {
    id: row.id,
    uuid: row.uuid,
    code: row.code,
    name: row.name,
    status: row.status,
    revision: row.revision,
    type: { id: row.object_type_id, code: row.type_code, name: row.type_name },
    deleted: Boolean(row.deleted_at),
  };
}

export function listObjectRows(db, query = {}, tenantId) {
  const { page, pageSize, offset } = pagination(query);
  const where = ["o.tenant_id = ?"];
  const params = [Number(tenantId)];
  const includeDeleted = query.includeDeleted === true || query.include_deleted === true || query.includeDeleted === "true";
  const deletedOnly = query.deletedOnly === true || query.deleted_only === true || query.deletedOnly === "true";
  if (deletedOnly) {
    where.push("o.deleted_at IS NOT NULL");
  } else if (!includeDeleted) {
    where.push("o.deleted_at IS NULL");
  }
  if (query.type) {
    if (/^\d+$/.test(String(query.type))) {
      where.push("o.object_type_id = ?");
      params.push(Number(query.type));
    } else {
      where.push("t.code = ?");
      params.push(String(query.type));
    }
  }
  if (query.status) {
    where.push("o.status = ?");
    params.push(String(query.status));
  }
  if (query.ownerId || query.owner_id) {
    where.push("o.owner_id = ?");
    params.push(Number(query.ownerId || query.owner_id));
  }
  if (query.organizationId || query.organization_id) {
    where.push("o.organization_id = ?");
    params.push(Number(query.organizationId || query.organization_id));
  }
  if (query.externalRef || query.external_ref) {
    where.push("o.external_ref = ?");
    params.push(String(query.externalRef || query.external_ref));
  }
  if (query.ids) {
    const ids = String(query.ids).split(",").map((v) => Number(v)).filter((n) => Number.isInteger(n));
    if (ids.length) {
      where.push(`o.id IN (${ids.map(() => "?").join(",")})`);
      params.push(...ids);
    }
  }
  if (query.tag) {
    where.push("o.tags_json LIKE ?");
    params.push(`%${String(query.tag)}%`);
  }
  if (query.code) {
    where.push("o.code = ?");
    params.push(String(query.code));
  }
  if (query.q) {
    where.push("(o.code LIKE ? OR o.name LIKE ? OR o.description LIKE ? OR o.external_ref LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  const sortKey = SORTABLE[query.sort] || SORTABLE.created_at;
  const direction = String(query.order || query.direction || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM objects o JOIN metadata_types t ON t.id = o.object_type_id ${clause}`, params).c;
  const rows = queryAll(
    db,
    `${OBJECT_SELECT} ${clause} ORDER BY ${sortKey} ${direction} LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return { rows, total, page, pageSize };
}

export function activeCheckoutRow(db, objectId) {
  return queryOne(
    db,
    `SELECT * FROM object_checkouts
     WHERE object_id = ? AND released_at IS NULL
       AND (expires_at IS NULL OR expires_at > datetime('now'))
     ORDER BY id DESC LIMIT 1`,
    [Number(objectId)]
  );
}

export function listCheckoutRows(db, objectId) {
  return queryAll(
    db,
    `SELECT ck.*, u.username AS locked_by_username
     FROM object_checkouts ck JOIN users u ON u.id = ck.locked_by
     WHERE ck.object_id = ? AND ck.released_at IS NULL
     ORDER BY ck.id DESC`,
    [Number(objectId)]
  );
}

export function touchObject(db, objectId, actorId) {
  run(db, "UPDATE objects SET updated_at = ?, updated_by = ? WHERE id = ?", [nowIso(), actorId ?? null, Number(objectId)]);
}

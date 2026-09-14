import { queryAll, queryOne, run, nowIso } from "../db.js";
import {
  HttpError,
  requireFields,
  validateCode,
  assertAction,
  pagination,
} from "../validation.js";
import { writeAudit } from "./audit.js";

export function listApplications(db) {
  return queryAll(db, "SELECT * FROM applications ORDER BY name");
}

export function getApplication(db, id) {
  const app = queryOne(db, "SELECT * FROM applications WHERE id = ?", [id]);
  if (!app) throw new HttpError(404, "Application not found");
  return app;
}

export function createApplication(db, body, actor, ip) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "Application code");
  let result;
  try {
    result = run(
      db,
      `INSERT INTO applications (code, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [body.code, body.name.trim(), body.description || "", nowIso(), nowIso()]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Application code already exists");
    }
    throw err;
  }
  const app = getApplication(db, result.lastInsertRowid);
  writeAudit(db, {
    actor,
    action: "application.create",
    resourceType: "application",
    resourceId: app.id,
    details: { code: app.code },
    ip,
  });
  return app;
}

export function listResources(db, query = {}) {
  const where = [];
  const params = [];
  if (query.applicationId) {
    where.push("application_id = ?");
    params.push(Number(query.applicationId));
  }
  if (query.q) {
    where.push("(code LIKE ? OR name LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return queryAll(db, `SELECT * FROM resources ${clause} ORDER BY code`, params);
}

export function getResource(db, id) {
  const resource = queryOne(db, "SELECT * FROM resources WHERE id = ?", [id]);
  if (!resource) throw new HttpError(404, "Resource not found");
  return resource;
}

export function findResource(db, idOrCode) {
  if (idOrCode === undefined || idOrCode === null || idOrCode === "") return null;
  if (typeof idOrCode === "number" || /^[0-9]+$/.test(String(idOrCode))) {
    const byId = queryOne(db, "SELECT * FROM resources WHERE id = ?", [Number(idOrCode)]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM resources WHERE code = ?", [String(idOrCode)]);
}

function assertNoResourceCycle(db, id, parentId) {
  if (!parentId) return;
  if (Number(id) === Number(parentId)) {
    throw new HttpError(400, "A resource cannot be its own parent");
  }
  let current = parentId;
  const seen = new Set();
  while (current) {
    if (seen.has(current) || Number(current) === Number(id)) {
      throw new HttpError(400, "Resource hierarchy cycle detected");
    }
    seen.add(current);
    const row = queryOne(db, "SELECT parent_id FROM resources WHERE id = ?", [current]);
    if (!row) throw new HttpError(400, "Parent resource not found");
    current = row.parent_id;
  }
}

export function createResource(db, body, actor, ip) {
  requireFields(body, ["application_id", "code", "name"]);
  validateCode(body.code, "Resource code");
  getApplication(db, body.application_id);
  const kind = body.kind || "object";
  if (!["module", "object"].includes(kind)) {
    throw new HttpError(400, "Resource kind must be module or object");
  }
  if (body.parent_id) getResource(db, body.parent_id);
  let result;
  try {
    result = run(
      db,
      `INSERT INTO resources (application_id, code, name, kind, parent_id, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.application_id,
        body.code,
        body.name.trim(),
        kind,
        body.parent_id || null,
        body.description || "",
        nowIso(),
        nowIso(),
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Resource code already exists");
    }
    throw err;
  }
  const resource = getResource(db, result.lastInsertRowid);
  writeAudit(db, {
    actor,
    action: "resource.create",
    resourceType: "resource",
    resourceId: resource.id,
    details: { code: resource.code },
    ip,
  });
  return resource;
}

export function updateResource(db, id, body, actor, ip) {
  const current = getResource(db, id);
  const parentId = body.parent_id === undefined ? current.parent_id : body.parent_id || null;
  assertNoResourceCycle(db, id, parentId);
  if (body.code && body.code !== current.code) validateCode(body.code, "Resource code");
  const kind = body.kind ?? current.kind;
  if (!["module", "object"].includes(kind)) {
    throw new HttpError(400, "Resource kind must be module or object");
  }
  try {
    run(
      db,
      `UPDATE resources SET code = ?, name = ?, kind = ?, parent_id = ?, description = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? current.code,
        (body.name ?? current.name).trim(),
        kind,
        parentId,
        body.description ?? current.description,
        nowIso(),
        id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Resource code already exists");
    }
    throw err;
  }
  const resource = getResource(db, id);
  writeAudit(db, {
    actor,
    action: "resource.update",
    resourceType: "resource",
    resourceId: id,
    details: { before: current, after: resource },
    ip,
  });
  return resource;
}

export function ancestorResources(db, resourceId) {
  const result = [];
  let current = resourceId;
  const seen = new Set();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const row = queryOne(db, "SELECT * FROM resources WHERE id = ?", [current]);
    if (!row) break;
    result.push(row);
    current = row.parent_id;
  }
  return result;
}

export function permissionCode(resourceCode, action) {
  return `${resourceCode}:${action}`;
}

export function listPermissions(db, query = {}) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  if (query.resourceId) {
    where.push("p.resource_id = ?");
    params.push(Number(query.resourceId));
  }
  if (query.applicationId) {
    where.push("r.application_id = ?");
    params.push(Number(query.applicationId));
  }
  if (query.action) {
    assertAction(query.action);
    where.push("p.action = ?");
    params.push(query.action);
  }
  if (query.q) {
    where.push("(p.code LIKE ? OR p.name LIKE ? OR r.code LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM permissions p JOIN resources r ON r.id = p.resource_id ${clause}`,
    params
  ).c;
  const items = queryAll(
    db,
    `SELECT p.*, r.code AS resource_code, r.name AS resource_name, r.kind AS resource_kind,
            r.application_id, a.code AS application_code, a.name AS application_name
     FROM permissions p
     JOIN resources r ON r.id = p.resource_id
     JOIN applications a ON a.id = r.application_id
     ${clause}
     ORDER BY r.code, p.action
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return { items, total, page, pageSize };
}

export function getPermission(db, id) {
  const permission = queryOne(
    db,
    `SELECT p.*, r.code AS resource_code, r.name AS resource_name
     FROM permissions p JOIN resources r ON r.id = p.resource_id WHERE p.id = ?`,
    [id]
  );
  if (!permission) throw new HttpError(404, "Permission not found");
  return permission;
}

export function createPermission(db, body, actor, ip) {
  requireFields(body, ["resource_id", "action"]);
  assertAction(body.action);
  const resource = getResource(db, body.resource_id);
  const code = body.code || permissionCode(resource.code, body.action);
  if (!/^[a-z][a-z0-9._:-]{1,127}$/.test(code)) {
    throw new HttpError(400, "Permission code must be lowercase with dots, colons, dashes");
  }
  const name = body.name || `${resource.name} ${body.action}`;
  let result;
  try {
    result = run(
      db,
      `INSERT INTO permissions (resource_id, action, code, name, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [resource.id, body.action, code, name, body.description || "", nowIso()]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Permission already exists for this resource and action");
    }
    throw err;
  }
  const permission = getPermission(db, result.lastInsertRowid);
  writeAudit(db, {
    actor,
    action: "permission.create",
    resourceType: "permission",
    resourceId: permission.id,
    details: { code: permission.code },
    ip,
  });
  return permission;
}

export function ensurePermission(db, resourceId, action) {
  const existing = queryOne(
    db,
    "SELECT * FROM permissions WHERE resource_id = ? AND action = ?",
    [resourceId, action]
  );
  if (existing) return existing;
  return createPermission(db, { resource_id: resourceId, action });
}

export function deletePermission(db, id, actor, ip) {
  const permission = getPermission(db, id);
  run(db, "DELETE FROM permissions WHERE id = ?", [id]);
  writeAudit(db, {
    actor,
    action: "permission.delete",
    resourceType: "permission",
    resourceId: id,
    details: { code: permission.code },
    ip,
  });
  return { deleted: true, id: Number(id) };
}

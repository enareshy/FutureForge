// Reusable saved audit filters. Filters are private to their owner by default
// and can be shared with the tenant or published as system filters.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { validateSavedFilterInput } from "./validation.js";
import { capture } from "./events.js";

export function publicSavedFilter(row) {
  if (!row) return null;
  let filters = {};
  try {
    filters = row.filters_json ? JSON.parse(row.filters_json) : {};
  } catch {
    filters = {};
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id ?? null,
    owner_id: row.owner_id ?? null,
    name: row.name,
    description: row.description || "",
    scope: row.scope || "events",
    filters,
    shared: row.shared === 1,
    system: row.system === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getSavedFilterRow(db, id) {
  return queryOne(db, "SELECT * FROM audit_saved_filters WHERE id = ?", [Number(id)]);
}

export function listSavedFilters(db, { tenantId, ownerId, scope } = {}) {
  const where = ["(system = 1 OR shared = 1 OR owner_id = ?)"];
  const params = [ownerId == null ? -1 : Number(ownerId)];
  if (tenantId != null) {
    where.push("(tenant_id = ? OR tenant_id IS NULL)");
    params.push(Number(tenantId));
  }
  if (scope) {
    where.push("scope = ?");
    params.push(String(scope));
  }
  const items = queryAll(
    db,
    `SELECT * FROM audit_saved_filters WHERE ${where.join(" AND ")}
      ORDER BY system DESC, shared DESC, name ASC`,
    params
  ).map(publicSavedFilter);
  return { items, total: items.length };
}

export function getSavedFilter(db, id, { tenantId = null, ownerId = null } = {}) {
  const row = getSavedFilterRow(db, id);
  if (!row) throw new HttpError(404, "Saved filter not found");
  if (row.system !== 1 && row.shared !== 1 && Number(row.owner_id) !== Number(ownerId)) {
    throw new HttpError(404, "Saved filter not found");
  }
  if (tenantId != null && row.tenant_id != null && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Saved filter not found");
  }
  return publicSavedFilter(row);
}

export function createSavedFilter(db, body = {}, actor = null, tenantId = null) {
  const input = validateSavedFilterInput(body, { partial: false });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO audit_saved_filters
       (tenant_id, owner_id, name, description, scope, filters_json, shared, system, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      tenantId == null ? null : Number(tenantId),
      actor?.id ?? null,
      input.name,
      input.description || "",
      input.scope,
      JSON.stringify(input.filters || {}),
      input.shared ? 1 : 0,
      ts,
      ts,
    ]
  );
  capture(db, {
    actor,
    tenant_id: tenantId,
    action: "audit.filter.create",
    event_type: "CREATE",
    category: "administration",
    object_type: "audit_saved_filter",
    object_id: result.lastInsertRowid,
    object_name: input.name,
    details: { scope: input.scope, shared: !!input.shared },
  });
  return publicSavedFilter(getSavedFilterRow(db, result.lastInsertRowid));
}

export function updateSavedFilter(db, id, body = {}, actor = null, tenantId = null) {
  const row = getSavedFilterRow(db, id);
  if (!row) throw new HttpError(404, "Saved filter not found");
  if (row.system === 1) throw new HttpError(409, "System saved filters cannot be modified");
  if (Number(row.owner_id) !== Number(actor?.id)) {
    throw new HttpError(403, "Only the owner may modify this saved filter");
  }
  if (tenantId != null && row.tenant_id != null && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Saved filter not found");
  }
  const input = validateSavedFilterInput(body, { partial: true });
  const next = {
    name: input.name ?? row.name,
    description: input.description ?? row.description,
    scope: input.scope ?? row.scope,
    filters_json: input.filters === undefined ? row.filters_json : JSON.stringify(input.filters),
    shared: input.shared === undefined ? row.shared : input.shared ? 1 : 0,
  };
  run(
    db,
    `UPDATE audit_saved_filters
       SET name = ?, description = ?, scope = ?, filters_json = ?, shared = ?, updated_at = ?
     WHERE id = ?`,
    [next.name, next.description, next.scope, next.filters_json, next.shared, nowIso(), id]
  );
  capture(db, {
    actor,
    tenant_id: row.tenant_id,
    action: "audit.filter.update",
    event_type: "UPDATE",
    category: "administration",
    object_type: "audit_saved_filter",
    object_id: id,
    object_name: next.name,
  });
  return publicSavedFilter(getSavedFilterRow(db, id));
}

export function deleteSavedFilter(db, id, actor = null, tenantId = null) {
  const row = getSavedFilterRow(db, id);
  if (!row) throw new HttpError(404, "Saved filter not found");
  if (row.system === 1) throw new HttpError(409, "System saved filters cannot be deleted");
  if (Number(row.owner_id) !== Number(actor?.id)) {
    throw new HttpError(403, "Only the owner may delete this saved filter");
  }
  if (tenantId != null && row.tenant_id != null && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Saved filter not found");
  }
  run(db, "DELETE FROM audit_saved_filters WHERE id = ?", [id]);
  capture(db, {
    actor,
    tenant_id: row.tenant_id,
    action: "audit.filter.delete",
    event_type: "DELETE",
    category: "administration",
    object_type: "audit_saved_filter",
    object_id: id,
    object_name: row.name,
  });
  return { ok: true, id: Number(id) };
}

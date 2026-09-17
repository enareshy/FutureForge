// Saved searches. Users can persist query definitions privately or share them
// with their organization / tenant.
import { queryAll, queryOne, run, nowIso, randomUuid } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { publicSavedSearch, savedSearchRow, safeParse } from "./repository.js";
import { SHARING_SCOPES } from "./validation.js";
import { runSearch } from "./query.js";

function canAccess(row, actor, tenantId) {
  if (!row) return false;
  if (row.owner_id === null || row.owner_id === actor?.id) return true;
  if (row.is_shared !== 1) return false;
  if (row.sharing_scope === "tenant" && Number(row.tenant_id) === Number(tenantId)) return true;
  return false;
}

export function listSavedSearches(db, { tenantId, actorId, includeShared = true } = {}) {
  const rows = queryAll(
    db,
    `SELECT * FROM search_saved_searches
     WHERE tenant_id = ?
       AND (owner_id = ? ${includeShared ? "OR is_shared = 1" : ""})
     ORDER BY updated_at DESC, id DESC`,
    [Number(tenantId), actorId ?? null]
  );
  return rows.filter((row) => canAccess(row, { id: actorId }, tenantId)).map(publicSavedSearch);
}

export function getSavedSearch(db, reference, actor, tenantId) {
  const row = savedSearchRow(db, reference, tenantId);
  if (!row) throw new HttpError(404, "Saved search not found");
  if (!canAccess(row, actor, tenantId)) throw new HttpError(403, "Saved search is not shared with you");
  return publicSavedSearch(row);
}

export function createSavedSearch(db, input = {}, actor, tenantId, ip) {
  const name = String(input.name || "").trim();
  if (!name) throw new HttpError(400, "A saved search name is required");
  const sharingScope = SHARING_SCOPES.includes(input.sharing_scope)
    ? input.sharing_scope
    : input.is_shared
      ? "tenant"
      : "private";
  const query = input.query && typeof input.query === "object" ? input.query : {};
  const ts = nowIso();
  const uuid = randomUuid();
  run(
    db,
    `INSERT INTO search_saved_searches
       (uuid, tenant_id, owner_id, name, description, query_json, strategy, is_shared, sharing_scope, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid,
      Number(tenantId),
      actor?.id ?? null,
      name,
      String(input.description || ""),
      JSON.stringify(query),
      String(input.strategy || query.strategy || "standard"),
      sharingScope === "private" ? 0 : 1,
      sharingScope,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM search_saved_searches WHERE uuid = ?", [uuid]);
  writeAudit(db, {
    actor,
    action: "search.saved.create",
    resourceType: "search_saved_search",
    resourceId: row.uuid,
    details: { name, sharing_scope: sharingScope },
    ip,
  });
  return publicSavedSearch(row);
}

export function updateSavedSearch(db, reference, patch = {}, actor, tenantId, ip) {
  const row = savedSearchRow(db, reference, tenantId);
  if (!row) throw new HttpError(404, "Saved search not found");
  if (row.owner_id !== null && row.owner_id !== actor?.id) {
    throw new HttpError(403, "Only the owner can modify this saved search");
  }
  const fields = [];
  const params = [];
  const set = (column, value) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw new HttpError(400, "A saved search name is required");
    set("name", name);
  }
  if (patch.description !== undefined) set("description", String(patch.description));
  if (patch.query !== undefined) set("query_json", JSON.stringify(patch.query || {}));
  if (patch.strategy !== undefined) set("strategy", String(patch.strategy));
  if (patch.sharing_scope !== undefined) {
    if (!SHARING_SCOPES.includes(patch.sharing_scope)) {
      throw new HttpError(400, `sharing_scope must be one of ${SHARING_SCOPES.join(", ")}`);
    }
    set("sharing_scope", patch.sharing_scope);
    set("is_shared", patch.sharing_scope === "private" ? 0 : 1);
  } else if (patch.is_shared !== undefined) {
    set("is_shared", patch.is_shared ? 1 : 0);
  }
  if (!fields.length) return publicSavedSearch(row);
  set("updated_at", nowIso());
  params.push(row.id);
  run(db, `UPDATE search_saved_searches SET ${fields.join(", ")} WHERE id = ?`, params);
  const updated = queryOne(db, "SELECT * FROM search_saved_searches WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "search.saved.update",
    resourceType: "search_saved_search",
    resourceId: row.uuid,
    details: { fields: Object.keys(patch) },
    ip,
  });
  return publicSavedSearch(updated);
}

export function deleteSavedSearch(db, reference, actor, tenantId, ip) {
  const row = savedSearchRow(db, reference, tenantId);
  if (!row) throw new HttpError(404, "Saved search not found");
  if (row.owner_id !== null && row.owner_id !== actor?.id) {
    throw new HttpError(403, "Only the owner can delete this saved search");
  }
  run(db, "DELETE FROM search_saved_searches WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "search.saved.delete",
    resourceType: "search_saved_search",
    resourceId: row.uuid,
    details: { name: row.name },
    ip,
  });
  return { deleted: true, uuid: row.uuid };
}

export function runSavedSearch(db, reference, input = {}, actor, tenantId, ip) {
  const row = savedSearchRow(db, reference, tenantId);
  if (!row) throw new HttpError(404, "Saved search not found");
  if (!canAccess(row, actor, tenantId)) throw new HttpError(403, "Saved search is not shared with you");
  const savedQuery = safeParse(row.query_json, {});
  const merged = {
    ...savedQuery,
    ...input,
    page: input.page ?? 1,
    page_size: input.page_size ?? input.pageSize ?? savedQuery.page_size,
    saved_search_id: row.id,
  };
  const result = runSearch(db, merged, actor, { tenantId, strategy: row.strategy, recordHistory: true });
  run(db, "UPDATE search_saved_searches SET use_count = use_count + 1, last_used_at = ? WHERE id = ?", [
    nowIso(),
    row.id,
  ]);
  return { saved_search: publicSavedSearch(row), ...result };
}

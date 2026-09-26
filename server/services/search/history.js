// Search history. Records what users search for so the UI can offer recent
// queries and autocomplete, with tenant-scoped retention.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { publicHistoryEntry } from "./repository.js";
import { toSqlDateTime } from "./validation.js";

export function recordSearchHistory(db, input = {}, actor, tenantId) {
  const tenant = Number(tenantId ?? actor?.tenant_id ?? 0);
  const query = String(input.query || "").slice(0, 400);
  if (!query) return null;
  run(
    db,
    `INSERT INTO search_history
       (tenant_id, user_id, query_text, strategy, scope, filters_json, result_count, duration_ms, saved_search_id, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenant,
      actor?.id ?? null,
      query,
      String(input.strategy || "standard"),
      String(input.scope || "tenant"),
      JSON.stringify(input.filters || {}),
      Number(input.resultCount ?? input.result_count ?? 0),
      Number(input.durationMs ?? input.duration_ms ?? 0),
      input.savedSearchId ?? input.saved_search_id ?? null,
      nowIso(),
    ]
  );
  const row = queryOne(db, "SELECT * FROM search_history WHERE id = last_insert_rowid()");
  return publicHistoryEntry(row);
}

export function listSearchHistory(db, { tenantId, actorId, limit = 20, q = "" } = {}) {
  const params = [Number(tenantId)];
  let where = "tenant_id = ?";
  if (actorId !== undefined && actorId !== null) {
    where += " AND user_id = ?";
    params.push(Number(actorId));
  }
  if (q) {
    where += " AND lower(query_text) LIKE ?";
    params.push(`%${String(q).toLowerCase()}%`);
  }
  const rows = queryAll(
    db,
    `SELECT * FROM search_history WHERE ${where} ORDER BY executed_at DESC, id DESC LIMIT ?`,
    [...params, Math.max(1, Math.min(Number(limit) || 20, 200))]
  );
  return rows.map(publicHistoryEntry);
}

export function deleteSearchHistoryEntry(db, id, actor, tenantId) {
  const row = queryOne(db, "SELECT * FROM search_history WHERE id = ? AND tenant_id = ?", [
    Number(id),
    Number(tenantId),
  ]);
  if (!row) throw new HttpError(404, "Search history entry not found");
  if (row.user_id !== null && row.user_id !== actor?.id) {
    throw new HttpError(403, "Cannot delete another user's search history");
  }
  run(db, "DELETE FROM search_history WHERE id = ?", [Number(id)]);
  return { deleted: true, id: Number(id) };
}

export function clearSearchHistory(db, actor, tenantId, { all = false } = {}) {
  if (all) {
    const result = run(db, "DELETE FROM search_history WHERE tenant_id = ?", [Number(tenantId)]);
    return { cleared: result.changes, scope: "tenant" };
  }
  const result = run(db, "DELETE FROM search_history WHERE tenant_id = ? AND user_id = ?", [
    Number(tenantId),
    actor?.id ?? null,
  ]);
  return { cleared: result.changes, scope: "user" };
}

export function pruneSearchHistory(db, { tenantId, retentionDays = 90 } = {}, actor, ip) {
  const days = Math.max(1, Number(retentionDays) || 90);
  const cutoff = toSqlDateTime(new Date(Date.now() - days * 86400000));
  const result = run(db, "DELETE FROM search_history WHERE tenant_id = ? AND executed_at < ?", [
    Number(tenantId),
    cutoff,
  ]);
  return { pruned: result.changes, cutoff };
}

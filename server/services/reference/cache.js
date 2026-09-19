// Cache-epoch management for Enterprise Reference Data Management.
//
// Reference data is read on hot paths (every screen that renders a status code,
// unit of measure or country). Resolution results are cached in-process; every
// governed mutation bumps a single monotonic epoch so readers invalidate without
// a network round trip and never serve stale values.
import { queryOne, run, nowIso } from "../../db.js";

export function getCacheEpoch(db) {
  const row = queryOne(db, "SELECT epoch FROM reference_cache_epoch WHERE id = 1");
  return Number(row?.epoch ?? 0);
}

export function bumpCacheEpoch(db) {
  run(db, "UPDATE reference_cache_epoch SET epoch = epoch + 1, updated_at = ? WHERE id = 1", [nowIso()]);
  return getCacheEpoch(db);
}

export function ensureCacheEpoch(db) {
  run(db, "INSERT OR IGNORE INTO reference_cache_epoch (id, epoch) VALUES (1, 0)", []);
  return getCacheEpoch(db);
}

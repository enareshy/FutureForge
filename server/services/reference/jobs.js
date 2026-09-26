// Background job handlers for Enterprise Reference Data Management. Registered
// by the worker process; `runReferenceMaintenance` keeps the reference estate
// healthy without an operator submitting jobs manually.
import { queryAll, run, nowIso } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { reindexReferenceItem } from "./search.js";
import { bumpCacheEpoch } from "./cache.js";

const EXPORT_RETENTION_DAYS = 30;

export function pruneExports(db, { retentionDays = EXPORT_RETENTION_DAYS } = {}) {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const result = run(db, "DELETE FROM reference_exports WHERE created_at < ?", [cutoff]);
  return { pruned: Number(result.changes ?? 0), cutoff };
}

// Indexes any reference item that has never been indexed, or whose item row was
// updated after the search document. Best-effort.
export function reindexStaleItems(db, { limit = 500 } = {}) {
  const items = queryAll(
    db,
    `SELECT i.id, i.tenant_id FROM reference_data_items i
     LEFT JOIN search_index si
       ON si.object_type = 'reference_item' AND si.object_id = CAST(i.id AS TEXT)
       AND COALESCE(si.tenant_id, 0) = COALESCE(i.tenant_id, 0)
     WHERE si.id IS NULL OR si.updated_at < i.updated_at
     ORDER BY i.id LIMIT ?`,
    [Number(limit) || 500]
  );
  let indexed = 0;
  for (const item of items) {
    if (reindexReferenceItem(db, item)) indexed += 1;
  }
  return { candidates: items.length, indexed };
}

export function runReferenceMaintenance(db, { limit = 500, retentionDays = EXPORT_RETENTION_DAYS } = {}) {
  const exports = pruneExports(db, { retentionDays });
  const reindex = reindexStaleItems(db, { limit });
  bumpCacheEpoch(db);
  return { exports_pruned: exports.pruned, reindex_candidates: reindex.candidates, reindexed: reindex.indexed, ran_at: nowIso() };
}

export function registerReferenceHandlers() {
  registerHandler(
    "REFERENCE_MAINTENANCE",
    async (context) => {
      context.step("maintenance", { progress: 5, message: "Converging reference data estate" });
      const summary = runReferenceMaintenance(context.db, {
        limit: Number(context.input.limit) || 500,
        retentionDays: Number(context.input.retention_days) || EXPORT_RETENTION_DAYS,
      });
      context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
      return { message: "Reference data maintenance complete", result: summary, last_step: "maintenance" };
    },
    { description: "Prune exports and reindex stale reference items" }
  );
  return ["REFERENCE_MAINTENANCE"];
}

// Background job handlers for the Search & Discovery Framework. Registered by
// the worker process; the exported maintenance helper is also called by the
// worker's periodic sweep so event-driven indexing converges without operator
// intervention.
import { registerHandler } from "../job-execution/handlers.js";
import { drainIndexQueue, reindexType, reindexTenant } from "./indexing.js";
import { initializeSearch } from "./registry.js";
import { runExport } from "./exports.js";
import { pruneSearchHistory } from "./history.js";
import { expireExports } from "./exports.js";
import { getConfiguration } from "./config.js";

export function registerSearchHandlers() {
  registerHandler(
    "SEARCH_INDEX",
    async (context) => {
      context.step("drain", { progress: 5, message: "Draining search index queue" });
      const tenantId = context.input.tenant_id ?? context.tenant_id ?? null;
      const limit = Number(context.input.limit) || 200;
      context.checkCancelled();
      const summary = drainIndexQueue(context.db, { limit, tenantId });
      context.reportProgress({ progress: 100, message: `Indexed ${summary.succeeded}` }, { force: true });
      return {
        message: `Indexed ${summary.succeeded} document(s)`,
        result: summary,
        last_step: "drain",
      };
    },
    { description: "Drain queued search index changes" }
  );

  registerHandler(
    "SEARCH_REINDEX",
    async (context) => {
      initializeSearch(context.db);
      const tenantId = context.input.tenant_id ?? context.tenant_id;
      const objectType = context.input.object_type ?? context.input.objectType ?? null;
      const limit = Number(context.input.limit) || 10000;
      context.step("reindex", { progress: 10, message: "Rebuilding search index" });
      context.checkCancelled();
      const summary = objectType
        ? reindexType(context.db, { tenantId, objectType, limit }, null, null)
        : reindexTenant(context.db, { tenantId, limit }, null, null);
      context.reportProgress({ progress: 100, message: `Indexed ${summary.indexed}` }, { force: true });
      return { message: `Reindexed ${summary.indexed} document(s)`, result: summary, last_step: "reindex" };
    },
    { description: "Rebuild the search index for a tenant or object type" }
  );

  registerHandler(
    "SEARCH_EXPORT",
    async (context) => {
      const exportId = context.input.export_id ?? context.input.exportId;
      context.step("export", { progress: 10, message: "Materialising search export" });
      context.checkCancelled();
      const dto = runExport(context.db, exportId);
      context.reportProgress({ progress: 100, message: `Exported ${dto.row_count} row(s)` }, { force: true });
      return { message: `Exported ${dto.row_count} row(s)`, result: dto, last_step: "export" };
    },
    { description: "Materialise a search result export" }
  );

  return ["SEARCH_INDEX", "SEARCH_REINDEX", "SEARCH_EXPORT"];
}

// Periodic housekeeping: drain due index changes, prune expired history and
// expire stale exports. Returns a summary for logging.
export function runSearchMaintenance(db, { drainLimit = 100 } = {}) {
  const drained = drainIndexQueue(db, { limit: drainLimit });
  const tenants = new Set();
  const rows = db.prepare("SELECT DISTINCT tenant_id FROM search_configuration").all();
  for (const row of rows) tenants.add(Number(row.tenant_id));
  let pruned = 0;
  for (const tenantId of tenants) {
    try {
      const config = getConfiguration(db, tenantId);
      const result = pruneSearchHistory(db, { tenantId, retentionDays: config.history_retention_days });
      pruned += result.pruned;
    } catch {
      /* history pruning must never break the sweep */
    }
  }
  const expired = expireExports(db);
  return { drained, history_pruned: pruned, exports_expired: expired.expired };
}

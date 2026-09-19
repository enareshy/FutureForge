// Background job handlers for File & Content Management. Registered by the
// worker process; `runContentMaintenance` keeps the content estate healthy
// without an operator submitting jobs manually.
import { queryAll, nowIso } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { expireUploads } from "./sessions.js";
import { releaseExpiredLocks } from "./locks.js";
import { evaluateRetention } from "./retention.js";
import { reindexContent } from "./search.js";
import { CONTENT_HANDLER_CODES } from "./processing.js";

export function reindexStaleContent(db, { limit = 500 } = {}) {
  const rows = queryAll(
    db,
    `SELECT c.* FROM content c
     LEFT JOIN search_index si
       ON si.object_type = 'content' AND si.object_id = CAST(c.id AS TEXT)
       AND COALESCE(si.tenant_id, 0) = COALESCE(c.tenant_id, 0)
     WHERE c.deleted_at IS NULL AND (si.id IS NULL OR si.updated_at < c.updated_at)
     ORDER BY c.id LIMIT ?`,
    [Number(limit) || 500]
  );
  let indexed = 0;
  for (const row of rows) {
    if (reindexContent(db, row)) indexed += 1;
  }
  return { candidates: rows.length, indexed };
}

export function runContentMaintenance(db, { limit = 500, now = nowIso() } = {}) {
  const uploads = expireUploads(db, { now });
  const locks = releaseExpiredLocks(db, { now });
  const retention = evaluateRetention(db, { now, limit });
  const reindex = reindexStaleContent(db, { limit });
  return {
    uploads_expired: uploads?.expired ?? 0,
    locks_released: locks?.released ?? 0,
    retention_evaluated: retention.evaluated,
    retention_processed: retention.processed,
    reindex_candidates: reindex.candidates,
    reindexed: reindex.indexed,
    ran_at: now,
  };
}

export function registerContentHandlers() {
  registerHandler(
    "CONTENT_MAINTENANCE",
    async (context) => {
      context.step("maintenance", { progress: 5, message: "Converging content estate" });
      const summary = runContentMaintenance(context.db, { limit: Number(context.input?.limit) || 500 });
      context.reportProgress({ progress: 100, message: "Content maintenance complete" }, { force: true });
      return { message: "Content maintenance complete", result: summary, last_step: "maintenance" };
    },
    { description: "Expire uploads, release locks, evaluate retention and reindex content" }
  );

  registerHandler(
    CONTENT_HANDLER_CODES.retention,
    async (context) => {
      context.step("retention", { progress: 10, message: "Evaluating content retention" });
      const summary = evaluateRetention(context.db, {
        tenantId: context.input?.tenant_id ?? context.tenant_id ?? null,
        limit: Number(context.input?.limit) || 500,
      });
      context.reportProgress({ progress: 100, message: "Retention evaluation complete" }, { force: true });
      return { message: "Retention evaluation complete", result: summary, last_step: "retention" };
    },
    { description: "Mark expired content retention records eligible" }
  );

  return ["CONTENT_MAINTENANCE", CONTENT_HANDLER_CODES.retention];
}

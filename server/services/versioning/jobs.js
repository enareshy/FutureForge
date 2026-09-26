// Background job handlers for the Effectivity & Versioning Kernel. Registered by
// the worker; maintenance converges expired effectivity, emits expiry events and
// prunes resolution bookkeeping.
import { queryAll, queryOne, run } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { emitDomainEvent } from "../events/emit.js";
import { writeAudit } from "../audit.js";

const RESOLUTION_RETENTION_DAYS = 30;

export function expireEffectivities(db, { limit = 500, asOf = null } = {}) {
  const today = asOf || new Date().toISOString().slice(0, 10);
  const rows = queryAll(
    db,
    `SELECT * FROM versioning_effectivity_definitions
     WHERE status = 'active' AND effective_to IS NOT NULL AND effective_to != '' AND effective_to < ?
     LIMIT ?`,
    [today, Number(limit)]
  );
  const emitted = [];
  for (const row of rows) {
    const already = queryOne(
      db,
      `SELECT id FROM audit_logs WHERE action = 'versioning.effectivity.expired' AND resource_id = ? LIMIT 1`,
      [String(row.id)]
    );
    if (already) continue;
    writeAudit(db, {
      action: "versioning.effectivity.expired",
      resourceType: "versioning_effectivity_definition",
      resourceId: row.id,
      details: { effective_to: row.effective_to, dimension: row.dimension },
    });
    emitDomainEvent(
      db,
      {
        event_type_code: "EffectivityExpired",
        source_module: "versioning",
        source_object_type: "versioning_effectivity_definition",
        source_object_id: row.id,
        tenant_id: row.tenant_id,
        payload: { definition_id: row.id, code: row.code, effective_to: row.effective_to, dimension: row.dimension },
      },
      null
    );
    emitted.push({ id: row.id, code: row.code, effective_to: row.effective_to });
  }
  return { expired_count: emitted.length, as_of: today, items: emitted };
}

export function pruneResolutionResults(db, { retentionDays = RESOLUTION_RETENTION_DAYS } = {}) {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const result = run(db, "DELETE FROM versioning_resolution_results WHERE created_at < ?", [cutoff]);
  return { pruned: Number(result.changes ?? 0), cutoff };
}

export function runVersioningMaintenance(db, { limit = 500 } = {}) {
  const expired = expireEffectivities(db, { limit });
  const pruned = pruneResolutionResults(db);
  return { expired_effectivities: expired.expired_count, resolution_results_pruned: pruned.pruned, items: expired.items };
}

export function registerVersioningHandlers() {
  registerHandler(
    "VERSIONING_EXPIRE_EFFECTIVITY",
    async (context) => {
      context.step("expire", { progress: 5, message: "Expiring effectivity ranges" });
      const summary = expireEffectivities(context.db, { limit: Number(context.input.limit) || 500 });
      context.reportProgress({ progress: 100, message: `Expired ${summary.expired_count}` }, { force: true });
      return { message: `Expired ${summary.expired_count} effectivity range(s)`, result: summary, last_step: "expire" };
    },
    { description: "Emit EffectivityExpired for ranges that ended" }
  );

  registerHandler(
    "VERSIONING_MAINTENANCE",
    async (context) => {
      context.step("maintenance", { progress: 5, message: "Converging versioning bookkeeping" });
      const summary = runVersioningMaintenance(context.db, { limit: Number(context.input.limit) || 500 });
      context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
      return { message: "Versioning maintenance complete", result: summary, last_step: "maintenance" };
    },
    { description: "Expire effectivity and prune resolution bookkeeping" }
  );

  return ["VERSIONING_EXPIRE_EFFECTIVITY", "VERSIONING_MAINTENANCE"];
}

// Background job handlers for the Audit & History Framework. Registered by the
// worker process; `runAuditMaintenance` is called by the worker's periodic
// sweep to expire stale exports and apply retention policies for every tenant
// that has configured one.
import { registerHandler } from "../job-execution/handlers.js";
import { runAuditExport, expireAuditExports } from "./exports.js";
import { executeRetentionPolicies } from "./retention.js";

export function registerAuditHandlers() {
  registerHandler(
    "AUDIT_EXPORT",
    async (context) => {
      const exportId = context.input.export_id ?? context.input.exportId;
      context.step("export", { progress: 10, message: "Materialising audit export" });
      context.checkCancelled();
      const dto = runAuditExport(context.db, exportId);
      context.reportProgress({ progress: 100, message: `Exported ${dto.row_count} event(s)` }, { force: true });
      return { message: `Exported ${dto.row_count} event(s)`, result: dto, last_step: "export" };
    },
    { description: "Materialise an audit event export" }
  );

  registerHandler(
    "AUDIT_RETENTION",
    async (context) => {
      const tenantId = context.input.tenant_id ?? context.tenant_id ?? null;
      const policyId = context.input.policy_id ?? context.input.policyId ?? null;
      const dryRun = context.input.dry_run === true || context.input.dryRun === true;
      context.step("retention", { progress: 10, message: "Applying audit retention policies" });
      context.checkCancelled();
      const summary = executeRetentionPolicies(context.db, { tenantId, policyId, dryRun });
      context.reportProgress(
        { progress: 100, message: `Archived ${summary.archived}, purged ${summary.purged}` },
        { force: true }
      );
      return { message: `Retention complete (${summary.purged} purged)`, result: summary, last_step: "retention" };
    },
    { description: "Apply audit retention policies for a tenant" }
  );

  return ["AUDIT_EXPORT", "AUDIT_RETENTION"];
}

// Periodic housekeeping: expire stale exports and run retention for every
// tenant with an active retention policy. Failures never break the sweep.
export function runAuditMaintenance(db, { retention = true } = {}) {
  const expired = expireAuditExports(db);
  let tenants = 0;
  let archived = 0;
  let purged = 0;
  if (retention) {
    try {
      const rows = db
        .prepare("SELECT DISTINCT tenant_id FROM audit_retention_policies WHERE status = 'active' AND tenant_id IS NOT NULL")
        .all();
      for (const row of rows) {
        try {
          const summary = executeRetentionPolicies(db, { tenantId: Number(row.tenant_id) });
          archived += summary.archived;
          purged += summary.purged;
          tenants += 1;
        } catch {
          /* a single tenant failure must not stop retention for others */
        }
      }
    } catch {
      /* table may not exist on very old databases */
    }
  }
  return { exports_expired: expired.expired, tenants, archived, purged };
}

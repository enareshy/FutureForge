// Background job handlers for the Numbering Service. Registered by the worker
// process; `runNumberingMaintenance` converges reservations and bookkeeping so
// the service stays healthy without an operator submitting jobs manually.
import { run } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { expireReservations } from "./allocations.js";

const IDEMPOTENCY_RETENTION_DAYS = 14;

export function pruneIdempotency(db, { retentionDays = IDEMPOTENCY_RETENTION_DAYS } = {}) {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const result = run(
    db,
    `DELETE FROM numbering_idempotency
     WHERE created_at < ?
       AND (allocation_id IS NULL OR allocation_id IN (SELECT id FROM numbering_allocations WHERE status IN ('consumed','cancelled','expired','released')))`,
    [cutoff]
  );
  return { pruned: Number(result.changes ?? 0), cutoff };
}

export function runNumberingMaintenance(db, { limit = 200 } = {}) {
  const expired = expireReservations(db, { limit });
  const idempotency = pruneIdempotency(db);
  return {
    expired_reservations: expired.expired_count,
    idempotency_pruned: idempotency.pruned,
    items: expired.items,
  };
}

export function registerNumberingHandlers() {
  registerHandler(
    "NUMBERING_EXPIRE_RESERVATIONS",
    async (context) => {
      const limit = Number(context.input.limit) || 200;
      context.step("expire", { progress: 5, message: "Expiring overdue reservations" });
      const summary = expireReservations(context.db, { limit });
      context.reportProgress({ progress: 100, message: `Expired ${summary.expired_count}` }, { force: true });
      return { message: `Expired ${summary.expired_count} reservation(s)`, result: summary, last_step: "expire" };
    },
    { description: "Expire overdue number reservations" }
  );

  registerHandler(
    "NUMBERING_MAINTENANCE",
    async (context) => {
      context.step("maintenance", { progress: 5, message: "Converging numbering bookkeeping" });
      const summary = runNumberingMaintenance(context.db, { limit: Number(context.input.limit) || 200 });
      context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
      return { message: "Numbering maintenance complete", result: summary, last_step: "maintenance" };
    },
    { description: "Expire reservations and prune idempotency records" }
  );

  return ["NUMBERING_EXPIRE_RESERVATIONS", "NUMBERING_MAINTENANCE"];
}

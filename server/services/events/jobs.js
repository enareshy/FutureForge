// Background job handlers for the Event & Messaging Framework. Registered by
// the worker process; `runEventMaintenance` converges the outbox and consumer
// queues during the worker's periodic sweep so events flow without an operator
// submitting jobs manually.
import { registerHandler } from "../job-execution/handlers.js";
import { processOutbox, reclaimStaleOutbox, pruneOutbox } from "./outbox.js";
import { processDeliveries, releaseStaleDeliveries } from "./consumer.js";
import { runReplay } from "./replay.js";
import { applyRetention } from "./retention.js";
import { purgeDeadLetters } from "./deadletter.js";
import { log } from "./hooks.js";

export function registerEventHandlers() {
  registerHandler(
    "EVENT_OUTBOX_PUBLISH",
    async (context) => {
      const limit = Number(context.input.limit) || 50;
      context.step("publish", { progress: 5, message: "Publishing transactional outbox" });
      const summary = await processOutbox(context.db, { limit });
      context.reportProgress({ progress: 100, message: `Published ${summary.published}` }, { force: true });
      return { message: `Published ${summary.published} event(s)`, result: summary, last_step: "publish" };
    },
    { description: "Publish pending outbox events" }
  );

  registerHandler(
    "EVENT_CONSUME",
    async (context) => {
      const limit = Number(context.input.limit) || 25;
      context.step("consume", { progress: 5, message: "Processing event deliveries" });
      const summary = await processDeliveries(context.db, {
        limit,
        queueCode: context.input.queue_code || null,
        consumerGroup: context.input.consumer_group || null,
        tenantId: context.input.tenant_id ?? context.tenant_id ?? null,
      });
      context.reportProgress({ progress: 100, message: `Delivered ${summary.delivered}` }, { force: true });
      return { message: `Processed ${summary.claimed} delivery(ies)`, result: summary, last_step: "consume" };
    },
    { description: "Consume due event deliveries" }
  );

  registerHandler(
    "EVENT_REPLAY",
    async (context) => {
      const ref = context.input.replay_id || context.input.replay_ref;
      if (!ref) throw new Error("replay_id or replay_ref is required");
      context.step("replay", { progress: 5, message: `Replaying ${ref}` });
      context.checkCancelled();
      const result = await runReplay(context.db, ref, null);
      context.reportProgress({ progress: 100, message: `Replay ${result.status}` }, { force: true });
      return { message: `Replay ${result.status}`, result, last_step: "replay" };
    },
    { description: "Execute a controlled event replay" }
  );

  registerHandler(
    "EVENT_RETENTION",
    async (context) => {
      context.step("retention", { progress: 5, message: "Applying event retention policies" });
      const summary = applyRetention(context.db, { tenantId: context.input.tenant_id ?? context.tenant_id ?? null });
      context.reportProgress({ progress: 100, message: `Archived ${summary.archived}, deleted ${summary.deleted}` }, { force: true });
      return { message: `Retention applied to ${summary.policies} policy(ies)`, result: summary, last_step: "retention" };
    },
    { description: "Apply event retention policies" }
  );

  registerHandler(
    "EVENT_MAINTENANCE",
    async (context) => {
      context.step("maintenance", { progress: 5, message: "Reclaiming leases and pruning" });
      const summary = await runEventMaintenance(context.db);
      context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
      return { message: "Event maintenance complete", result: summary, last_step: "maintenance" };
    },
    { description: "Reclaim leases and prune event bookkeeping" }
  );

  return ["EVENT_OUTBOX_PUBLISH", "EVENT_CONSUME", "EVENT_REPLAY", "EVENT_RETENTION", "EVENT_MAINTENANCE"];
}

// Periodic housekeeping: converge the outbox + consumer queues, reclaim crashed
// leases and prune resolved bookkeeping. Returns a summary for logging.
export async function runEventMaintenance(db, { limit = 50 } = {}) {
  const reclaimedOutbox = reclaimStaleOutbox(db);
  const releasedDeliveries = releaseStaleDeliveries(db);
  const outbox = await processOutbox(db, { limit });
  const deliveries = await processDeliveries(db, { limit });
  const prunedOutbox = pruneOutbox(db);
  const purged = purgeDeadLetters(db);
  const summary = { outbox, deliveries, reclaimedOutbox, releasedDeliveries, prunedOutbox, purged };
  if (outbox.published || deliveries.delivered || deliveries.dead_lettered || releasedDeliveries.reclaimed) {
    log("info", "events.maintenance", {
      outbox_published: outbox.published,
      delivered: deliveries.delivered,
      dead_lettered: deliveries.dead_lettered,
      reclaimed_outbox: reclaimedOutbox.reclaimed,
      released_deliveries: releasedDeliveries.reclaimed,
    });
  }
  return summary;
}

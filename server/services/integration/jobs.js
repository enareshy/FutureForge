// Background job handlers for the Integration & API Framework. Registered by
// the worker process; `runIntegrationMaintenance` converges event/message/
// webhook queues during the worker's periodic sweep.
import { registerHandler } from "../job-execution/handlers.js";
import { queryOne } from "../../db.js";
import { executeIntegration, getDefinitionRow } from "./definitions.js";
import { enqueueMessage, processDueMessages } from "./messages.js";
import { processDueDeliveries } from "./events.js";
import { processDueWebhookDeliveries } from "./webhooks.js";
import { runImportTransfer, runExportTransfer, getTransferRow } from "./transfers.js";
import { runHealthChecks } from "./monitoring.js";
import { bulkRetryDeadLetters } from "./deadletter.js";
import { resolveCredentialSecret } from "./systems.js";
import { createAdapter, invokeAdapterRequest } from "./adapters.js";
import { getIntegrationHandler } from "./definitions.js";
import { safeParse } from "./validation.js";
import { log } from "./hooks.js";

// Delivers a single queued integration message by resolving its integration
// definition and adapter, or a named handler. Unknown handlers are marked as
// ignored rather than retried forever.
async function deliverMessage(context, message) {
  const payload = message.payload_json ? safeParse(message.payload_json, {}) : {};
  const definition = message.integration_id ? getDefinitionRow(context.db, message.integration_id) : null;
  const handler = getIntegrationHandler(message.message_type);
  if (handler) {
    return handler(context.db, { message, payload, context });
  }
  if (!definition) {
    return { delivered: true, reason: "No integration definition bound; payload retained" };
  }
  const adapterType = definition.adapter_type || "rest";
  if (adapterType === "event_bus") {
    const { publishEvent } = await import("./events.js");
    return publishEvent(context.db, { event_type_code: definition.config?.event_type || definition.code, payload, source_module: "integration" }, null);
  }
  const config = { ...safeParse(definition.config_json, {}) };
  if (definition.credential_id) {
    const resolved = resolveCredentialSecret(context.db, definition.credential_id);
    if (resolved?.secret) config.token = config.token || resolved.secret;
  }
  const adapter = createAdapter(adapterType, config);
  if (typeof adapter.publishMessage === "function" && !["rest", "webhook", "soap"].includes(adapterType)) {
    return adapter.publishMessage({ payload, message_ref: message.message_ref });
  }
  const result = await invokeAdapterRequest(adapter, { method: config.method || "POST", body: payload, url: config.url });
  return result.body;
}

export function registerIntegrationHandlers() {
  registerHandler(
    "INTEGRATION_SYNC",
    async (context) => {
      const ref = context.input.integration_code || context.input.integration_id;
      if (!ref) throw new Error("integration_code or integration_id is required");
      context.step("execute", { progress: 10, message: `Running integration ${ref}` });
      context.checkCancelled();
      const { execution } = await executeIntegration(context.db, ref, {
        triggerType: context.input.trigger_type || "schedule",
        actor: null,
        input: { correlation_id: context.correlation_id, payload: context.input.payload || {} },
      });
      context.reportProgress({ progress: 100, message: `Integration ${execution.status}` }, { force: true });
      if (execution.status === "failed") {
        const { JobError } = await import("../job-execution/errors.js");
        throw new JobError(execution.error_message || "Integration execution failed", { category: execution.error_category || "technical", code: execution.error_code || "integration_failed" });
      }
      return { message: `Integration ${execution.status}`, result: execution, last_step: "execute" };
    },
    { description: "Run a configured integration definition" }
  );

  registerHandler(
    "INTEGRATION_MESSAGE",
    async (context) => {
      const limit = Number(context.input.limit) || 20;
      context.step("drain", { progress: 5, message: "Draining integration message queue" });
      const summary = await processDueMessages(context.db, (db, message) => deliverMessage(context, message), { limit });
      context.reportProgress({ progress: 100, message: `Delivered ${summary.succeeded}` }, { force: true });
      return { message: `Processed ${summary.claimed} message(s)`, result: summary, last_step: "drain" };
    },
    { description: "Deliver queued integration messages" }
  );

  registerHandler(
    "INTEGRATION_EVENT_DISPATCH",
    async (context) => {
      const limit = Number(context.input.limit) || 50;
      context.step("fanout", { progress: 5, message: "Dispatching published events" });
      const internal = await processDueDeliveries(context.db, async (delivery) => {
        const payload = safeParse(delivery.payload_json, {});
        if (delivery.subscriber_type === "queue") {
          enqueueMessage(context.db, { message_type: delivery.event_type_code, integration_id: delivery.target_ref || null, payload, correlation_id: delivery.correlation_id, tenant_id: delivery.tenant_id });
          return;
        }
        if (delivery.subscriber_type === "integration" && delivery.target_ref) {
          await executeIntegration(context.db, delivery.target_ref, { triggerType: "event", input: { correlation_id: delivery.correlation_id, payload } });
          return;
        }
        const handler = getIntegrationHandler(delivery.target_ref) || getIntegrationHandler(delivery.event_type_code);
        if (handler) await handler(context.db, { delivery, payload });
      }, { limit });
      const webhooks = await processDueWebhookDeliveries(context.db, { limit });
      context.reportProgress({ progress: 100, message: `Delivered ${internal.delivered} event(s)` }, { force: true });
      return { message: "Event dispatch complete", result: { internal, webhooks }, last_step: "fanout" };
    },
    { description: "Fan out domain events to internal and webhook subscribers" }
  );

  registerHandler(
    "INTEGRATION_TRANSFER",
    async (context) => {
      const transferRef = context.input.transfer_ref || context.input.transfer_id;
      const direction = context.input.direction || (transferRef ? getTransferRow(context.db, transferRef)?.direction : null);
      context.step("transfer", { progress: 10, message: `Running ${direction || "import"} transfer` });
      context.checkCancelled();
      const transfer = direction === "export"
        ? await runExportTransfer(context.db, { transfer_ref: transferRef, ...context.input }, null, context.tenant_id)
        : await runImportTransfer(context.db, { transfer_ref: transferRef, ...context.input }, null, context.tenant_id);
      context.reportProgress({ progress: 100, message: `Transfer ${transfer.status}` }, { force: true });
      return { message: `Transfer ${transfer.status}`, result: transfer, last_step: "transfer" };
    },
    { description: "Execute a bulk import or export transfer" }
  );

  registerHandler(
    "INTEGRATION_HEALTH_CHECK",
    async (context) => {
      context.step("probe", { progress: 10, message: "Probing external systems" });
      const result = runHealthChecks(context.db, { tenantId: context.input.tenant_id ?? context.tenant_id, systemType: context.input.system_type || null });
      context.reportProgress({ progress: 100, message: `Checked ${result.summary.checked}` }, { force: true });
      return { message: `Checked ${result.summary.checked} system(s)`, result: result.summary, last_step: "probe" };
    },
    { description: "Probe external systems and record health" }
  );

  registerHandler(
    "INTEGRATION_DEAD_LETTER_RETRY",
    async (context) => {
      const ids = Array.isArray(context.input.ids) ? context.input.ids : context.input.id ? [context.input.id] : [];
      context.step("retry", { progress: 10, message: `Retrying ${ids.length} dead letter(s)` });
      const result = bulkRetryDeadLetters(context.db, ids, null);
      context.reportProgress({ progress: 100, message: `Retried ${result.retried ?? ids.length}` }, { force: true });
      return { message: `Retried ${result.retried ?? ids.length} dead letter(s)`, result, last_step: "retry" };
    },
    { description: "Reprocess selected integration dead letters" }
  );

  return ["INTEGRATION_SYNC", "INTEGRATION_MESSAGE", "INTEGRATION_EVENT_DISPATCH", "INTEGRATION_TRANSFER", "INTEGRATION_HEALTH_CHECK", "INTEGRATION_DEAD_LETTER_RETRY"];
}

// Periodic housekeeping invoked by the worker: converge event deliveries,
// outbound webhooks and queued messages. Returns a summary for logging.
export async function runIntegrationMaintenance(db, { limit = 50 } = {}) {
  const internal = await processDueDeliveries(db, async (delivery) => {
    const payload = safeParse(delivery.payload_json, {});
    if (delivery.subscriber_type === "queue") {
      enqueueMessage(db, { message_type: delivery.event_type_code, integration_id: delivery.target_ref || null, payload, correlation_id: delivery.correlation_id, tenant_id: delivery.tenant_id });
      return;
    }
    if (delivery.subscriber_type === "integration" && delivery.target_ref) {
      await executeIntegration(db, delivery.target_ref, { triggerType: "event", input: { correlation_id: delivery.correlation_id, payload } });
    }
  }, { limit });
  const webhooks = await processDueWebhookDeliveries(db, { limit });
  const messages = await processDueMessages(db, (ctxDb, message) => deliverMessage({ db: ctxDb }, message), { limit });
  if (internal.delivered || webhooks.delivered || messages.succeeded) {
    log("info", "integration.maintenance", { events: internal.delivered, webhooks: webhooks.delivered, messages: messages.succeeded });
  }
  return { events: internal, webhooks, messages };
}

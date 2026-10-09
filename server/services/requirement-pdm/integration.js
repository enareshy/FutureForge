// Integration & API Framework wiring for the Requirement -> PDM integration.
//
// External requirement/PDM synchronization is delivered through the shared
// Integration Hub: the platform enqueues a message, the worker resolves the
// handler registered here, and failures are retried and dead-lettered by the
// framework. Nothing custom is built for retry/monitoring (mirrors
// data-exchange/jobs.js and integration/jobs.js).
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { registerIntegrationHandler, getIntegrationHandler } from "../integration/definitions.js";
import { enqueueMessage, enqueueMessageAsync, markFailed, markFailedAsync } from "../integration/messages.js";
import { createDeadLetter, createDeadLetterAsync } from "../integration/deadletter.js";
import { synchronize, synchronizeAsync } from "./synchronization.js";
import { initiateChangeRequestAsync } from "./change-initiation.js";
import { synchronizeFromPlmAsync } from "./plm-sync.js";
import { REQUIREMENT_PDM_INTEGRATION } from "./constants.js";

function messageTenant(message, payload) {
  return Number(payload?.tenant_id ?? message?.tenant_id ?? 0);
}

function syncOptions(payload = {}) {
  return {
    targetType: payload.target_type ?? payload.targetType ?? null,
    targetId: payload.target_id ?? payload.targetId ?? null,
    requirementId: payload.requirement_id ?? payload.requirementId ?? null,
    limit: payload.limit ?? null,
    asOf: payload.as_of ?? null,
  };
}

// Registers the integration handler. Idempotent; returns the handler code.
export function registerRequirementPdmIntegrationHandlers() {
  registerIntegrationHandler(
    REQUIREMENT_PDM_INTEGRATION.handler,
    async (db, { message, payload }) => {
      const tenantId = messageTenant(message, payload);
      if (!tenantId) throw new Error("A tenant is required to synchronize requirements with PDM");
      const summary = await synchronizeAsync(db, tenantId, syncOptions(payload), null, null);
      if (summary.status === "FAILED") {
        const error = new Error(`Requirement/PDM synchronization failed for ${summary.failed} allocation(s)`);
        error.category = "technical";
        error.code = "requirement_pdm_sync_failed";
        throw error;
      }
      return { delivered: true, status: summary.status, evaluated: summary.evaluated, changed: summary.changed, failed: summary.failed };
    },
    { description: "Synchronize requirement allocations with PDM changes", module: "requirement-pdm" }
  );
  registerIntegrationHandler(
    REQUIREMENT_PDM_INTEGRATION.changeHandler,
    async (db, { message, payload }) => {
      const tenantId = messageTenant(message, payload);
      if (!tenantId) throw new Error("A tenant is required to initiate a change from a requirement change");
      const requirementRef = payload.requirement_id ?? payload.requirementId ?? payload.requirement_ref ?? payload.requirementRef;
      if (requirementRef === undefined || requirementRef === null || String(requirementRef).trim() === "") {
        return { skipped: true, reason: "missing_requirement" };
      }
      const result = await initiateChangeRequestAsync(
        db,
        tenantId,
        requirementRef,
        {
          force: payload.force,
          severity: payload.severity,
          idempotency_key: payload.idempotency_key ?? payload.idempotencyKey,
          max_depth: payload.max_depth ?? payload.maxDepth,
        },
        null,
        null
      );
      return { delivered: true, status: result.status, change_request_id: result.change?.id ?? null, existing: result.existing || null };
    },
    { description: "Initiate an existing Change Management request from a requirement change", module: "requirement-pdm" }
  );
  registerIntegrationHandler(
    REQUIREMENT_PDM_INTEGRATION.plmSyncHandler,
    async (db, { message, payload }) => {
      const tenantId = messageTenant(message, payload);
      if (!tenantId) throw new Error("A tenant is required to propagate a PLM change to requirements");
      const nodeType = payload.node_type ?? payload.nodeType;
      const nodeId = payload.node_id ?? payload.nodeId;
      if (!nodeType || nodeId === undefined || nodeId === null) return { skipped: true, reason: "missing_node" };
      const result = await synchronizeFromPlmAsync(
        db,
        tenantId,
        {
          nodeType,
          nodeId,
          eventType: payload.event_type ?? payload.eventType,
          correlationId: payload.correlation_id ?? payload.correlationId,
          analyze: payload.analyze,
          notify: payload.notify,
          maxDepth: payload.max_depth ?? payload.maxDepth,
        },
        null,
        null
      );
      return { delivered: true, status: result.status, requirement_count: result.requirement_count, impacted_count: result.impacted_count };
    },
    { description: "Propagate a Product/EBOM/MBOM/BOP/Document/Change change to the linked requirements", module: "requirement-pdm" }
  );
  return REQUIREMENT_PDM_INTEGRATION.handler;
}

// Enqueues a synchronization message. The deterministic idempotency key keeps a
// PDM change from producing duplicate work for the same target.
export function enqueueSynchronization(db, tenantId, payload = {}, actor = null) {
  const keyParts = [REQUIREMENT_PDM_INTEGRATION.messageType, Number(tenantId), payload.target_type || "", payload.target_id ?? "", payload.requirement_id ?? "", payload.as_of ?? ""];
  return enqueueMessage(
    db,
    {
      message_type: REQUIREMENT_PDM_INTEGRATION.handler,
      direction: "inbound",
      queue: REQUIREMENT_PDM_INTEGRATION.queue,
      tenant_id: Number(tenantId),
      idempotency_key: keyParts.join(":"),
      payload: { tenant_id: Number(tenantId), ...payload },
      correlation_id: payload.correlation_id || null,
    },
    actor
  );
}

export async function enqueueSynchronizationAsync(db, tenantId, payload = {}, actor = null) {
  const keyParts = [REQUIREMENT_PDM_INTEGRATION.messageType, Number(tenantId), payload.target_type || "", payload.target_id ?? "", payload.requirement_id ?? "", payload.as_of ?? ""];
  return enqueueMessageAsync(
    db,
    {
      message_type: REQUIREMENT_PDM_INTEGRATION.handler,
      direction: "inbound",
      queue: REQUIREMENT_PDM_INTEGRATION.queue,
      tenant_id: Number(tenantId),
      idempotency_key: keyParts.join(":"),
      payload: { tenant_id: Number(tenantId), ...payload },
      correlation_id: payload.correlation_id || null,
    },
    actor
  );
}

// Enqueues a change-initiation message. The deterministic idempotency key (per
// tenant + requirement + explicit key) keeps a repeated event from producing a
// duplicate change request.
export function enqueueChangeInitiation(db, tenantId, payload = {}, actor = null) {
  const normalized = { tenant_id: Number(tenantId), ...payload };
  const keyParts = [REQUIREMENT_PDM_INTEGRATION.changeMessageType, Number(tenantId), payload.requirement_id ?? payload.requirement_ref ?? "", payload.idempotency_key ?? ""];
  return enqueueMessage(
    db,
    {
      message_type: REQUIREMENT_PDM_INTEGRATION.changeHandler,
      direction: "inbound",
      queue: REQUIREMENT_PDM_INTEGRATION.queue,
      tenant_id: Number(tenantId),
      idempotency_key: keyParts.join(":"),
      payload: normalized,
      correlation_id: payload.correlation_id || null,
    },
    actor
  );
}

export async function enqueueChangeInitiationAsync(db, tenantId, payload = {}, actor = null) {
  const normalized = { tenant_id: Number(tenantId), ...payload };
  const keyParts = [REQUIREMENT_PDM_INTEGRATION.changeMessageType, Number(tenantId), payload.requirement_id ?? payload.requirement_ref ?? "", payload.idempotency_key ?? ""];
  return enqueueMessageAsync(
    db,
    {
      message_type: REQUIREMENT_PDM_INTEGRATION.changeHandler,
      direction: "inbound",
      queue: REQUIREMENT_PDM_INTEGRATION.queue,
      tenant_id: Number(tenantId),
      idempotency_key: keyParts.join(":"),
      payload: normalized,
      correlation_id: payload.correlation_id || null,
    },
    actor
  );
}

// Enqueues a PLM -> Requirement synchronization message. The deterministic
// idempotency key keeps a repeated PLM event from producing duplicate work for
// the same node.
export function enqueuePlmSynchronization(db, tenantId, payload = {}, actor = null) {
  const normalized = { tenant_id: Number(tenantId), ...payload };
  const keyParts = [REQUIREMENT_PDM_INTEGRATION.plmMessageType, Number(tenantId), payload.node_type ?? payload.nodeType ?? "", payload.node_id ?? payload.nodeId ?? ""];
  return enqueueMessage(
    db,
    {
      message_type: REQUIREMENT_PDM_INTEGRATION.plmSyncHandler,
      direction: "inbound",
      queue: REQUIREMENT_PDM_INTEGRATION.queue,
      tenant_id: Number(tenantId),
      idempotency_key: keyParts.join(":"),
      payload: normalized,
      correlation_id: payload.correlation_id || null,
    },
    actor
  );
}

export async function enqueuePlmSynchronizationAsync(db, tenantId, payload = {}, actor = null) {
  const normalized = { tenant_id: Number(tenantId), ...payload };
  const keyParts = [REQUIREMENT_PDM_INTEGRATION.plmMessageType, Number(tenantId), payload.node_type ?? payload.nodeType ?? "", payload.node_id ?? payload.nodeId ?? ""];
  return enqueueMessageAsync(
    db,
    {
      message_type: REQUIREMENT_PDM_INTEGRATION.plmSyncHandler,
      direction: "inbound",
      queue: REQUIREMENT_PDM_INTEGRATION.queue,
      tenant_id: Number(tenantId),
      idempotency_key: keyParts.join(":"),
      payload: normalized,
      correlation_id: payload.correlation_id || null,
    },
    actor
  );
}

// Records a failed synchronization as a retryable integration failure and, when
// retries are exhausted, a dead letter. Best-effort: monitoring must never fail
// the caller.
export function recordSynchronizationFailure(db, messageRef, error, actor = null) {  try {
    const message = markFailed(db, messageRef, error, { actor });
    if (!message.retry) {
      createDeadLetter(db, {
        message: message.message,
        error: { message: error?.message || "Synchronization failed", category: error?.category || "technical", code: error?.code || "requirement_pdm_sync_failed" },
      });
    }
    return message;
  } catch (err) {
    return { retry: false, error: err?.message || String(err) };
  }
}

export async function recordSynchronizationFailureAsync(db, messageRef, error, actor = null) {
  try {
    const message = await markFailedAsync(db, messageRef, error, { actor });
    if (!message.retry) {
      await createDeadLetterAsync(db, {
        message: message.message,
        error: { message: error?.message || "Synchronization failed", category: error?.category || "technical", code: error?.code || "requirement_pdm_sync_failed" },
      });
    }
    return message;
  } catch (err) {
    return { retry: false, error: err?.message || String(err) };
  }
}

export function integrationSummary(db, tenantId = null) {
  const params = [REQUIREMENT_PDM_INTEGRATION.handler];
  const clause = tenantId ? "AND tenant_id = ?" : "";
  if (tenantId) params.push(Number(tenantId));
  const rows = queryAll(db, `SELECT status, COUNT(*) AS c FROM integration_messages WHERE message_type = ? ${clause} GROUP BY status`, params);
  const messages = Object.fromEntries(rows.map((row) => [row.status, Number(row.c || 0)]));
  const dead = queryOne(db, "SELECT COUNT(*) AS c FROM integration_dead_letters WHERE status IN ('open', 'retrying')");
  return {
    handler: REQUIREMENT_PDM_INTEGRATION.handler,
    handler_registered: Boolean(getIntegrationHandler(REQUIREMENT_PDM_INTEGRATION.handler)),
    messages,
    message_total: Object.values(messages).reduce((sum, value) => sum + value, 0),
    open_dead_letters: Number(dead?.c || 0),
  };
}

export async function integrationSummaryAsync(db, tenantId = null) {
  const params = [REQUIREMENT_PDM_INTEGRATION.handler];
  const clause = tenantId ? "AND tenant_id = ?" : "";
  if (tenantId) params.push(Number(tenantId));
  const rows = await queryAllAsync(db, `SELECT status, COUNT(*) AS c FROM integration_messages WHERE message_type = ? ${clause} GROUP BY status`, params);
  const messages = Object.fromEntries(rows.map((row) => [row.status, Number(row.c || 0)]));
  const dead = await queryOneAsync(db, "SELECT COUNT(*) AS c FROM integration_dead_letters WHERE status IN ('open', 'retrying')");
  return {
    handler: REQUIREMENT_PDM_INTEGRATION.handler,
    handler_registered: Boolean(getIntegrationHandler(REQUIREMENT_PDM_INTEGRATION.handler)),
    messages,
    message_total: Object.values(messages).reduce((sum, value) => sum + value, 0),
    open_dead_letters: Number(dead?.c || 0),
  };
}

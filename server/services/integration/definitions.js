// Integration definitions (the hub's routing configuration), immutable version
// snapshots and execution orchestration. An execution resolves the configured
// adapter + optional transformation, invokes the external system, records a
// step timeline, publishes a completion event and updates health/run state.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import {
  publicDefinition,
  publicDefinitionVersion,
  publicExecution,
  publicStep,
  ref,
} from "./repository.js";
import {
  DEFINITION_STATUSES,
  EXECUTION_RETRYABLE,
  assertEnum,
  normalizeAdapterType,
  normalizeDirection,
  normalizeIntegrationType,
  normalizeRetryPolicy,
  safeParse,
  toJson,
} from "./validation.js";
import { auditIntegration, classifyError, log } from "./hooks.js";
import { adapterConfigFromDefinition, createAdapter, invokeAdapterRequest } from "./adapters.js";
import { applyTransformation, getTransformationRow } from "./transform.js";
import { publishEvent } from "./events.js";
import { enqueueMessage } from "./messages.js";
import { resolveCredentialSecret } from "./systems.js";

// In-process handlers referenced by name for `internal` / `custom` adapters.
const HANDLERS = new Map();

export function registerIntegrationHandler(code, handler, metadata = {}) {
  if (!code || typeof handler !== "function") throw new HttpError(400, "Handler code and function are required");
  HANDLERS.set(String(code), handler);
  HANDLERS.set(`${String(code)}::meta`, metadata);
  return String(code);
}

export function getIntegrationHandler(code) {
  return HANDLERS.get(String(code)) || null;
}

export function listIntegrationHandlers() {
  return [...HANDLERS.entries()].filter(([key]) => !key.endsWith("::meta")).map(([code, handler]) => ({ code, name: handler.name || code }));
}

// ── Definitions ─────────────────────────────────────────────────────────────
function scopeClauses({ tenantId, integrationType, direction, adapterType, status, q }) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (integrationType) {
    clauses.push("integration_type = ?");
    params.push(integrationType);
  }
  if (direction) {
    clauses.push("direction = ?");
    params.push(direction);
  }
  if (adapterType) {
    clauses.push("adapter_type = ?");
    params.push(adapterType);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function expandDefinition(db, row, scope = {}) {
  if (!row) return null;
  const systems = {};
  if (row.source_system_id) {
    const sourceRow = queryOne(db, "SELECT * FROM external_systems WHERE id = ?", [row.source_system_id]);
    systems.sourceRow = sourceRow;
  }
  if (row.target_system_id) {
    const targetRow = queryOne(db, "SELECT * FROM external_systems WHERE id = ?", [row.target_system_id]);
    systems.targetRow = targetRow;
  }
  const transformation = row.transformation_id ? publicTransformationSafe(db, row.transformation_id) : null;
  const schedule = row.schedule_id ? publicScheduleSafe(db, row.schedule_id) : null;
  return publicDefinition(row, { systems, transformation, schedule });
}

function publicTransformationSafe(db, id) {
  const row = queryOne(db, "SELECT * FROM transformation_definitions WHERE id = ?", [id]);
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    version: row.version,
    status: row.status,
    source_format: row.source_format,
    target_format: row.target_format,
  };
}

function publicScheduleSafe(db, id) {
  const row = queryOne(db, "SELECT * FROM integration_schedules WHERE id = ?", [id]);
  if (!row) return null;
  return { id: row.id, code: row.code, name: row.name, status: row.status, schedule_type: row.schedule_type, next_run_at: row.next_run_at || null };
}

export function listDefinitions(db, options = {}) {
  const { page = 1, pageSize = 50 } = options;
  const { where, params } = scopeClauses(options);
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_definitions ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_definitions ${where} ORDER BY code LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => expandDefinition(db, r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getDefinitionRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM integration_definitions WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getDefinition(db, refValue, scope = {}) {
  const row = getDefinitionRow(db, refValue);
  if (!row) throw new HttpError(404, "Integration definition not found");
  if (scope.tenantId !== undefined && scope.tenantId !== null && row.tenant_id && Number(row.tenant_id) !== Number(scope.tenantId)) {
    throw new HttpError(404, "Integration definition not found");
  }
  return expandDefinition(db, row, scope);
}

export function createDefinition(db, input = {}, actor = null, tenantId = null) {
  if (!input.code) throw new HttpError(400, "code is required");
  normalizeIntegrationType(input.integration_type);
  normalizeDirection(input.direction);
  normalizeAdapterType(input.adapter_type);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO integration_definitions
      (code, name, description, integration_type, direction, adapter_type, protocol, version, status,
       source_system_id, target_system_id, credential_id, transformation_id, schedule_id, endpoint_id,
       retry_policy_json, config_json, auth_json, timeout_seconds, owner_id, tenant_id, organization_id,
       plant_id, site_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.description || "",
      input.integration_type || "api",
      input.direction || "inbound",
      input.adapter_type || "rest",
      input.protocol || "https",
      Number(input.version) || 1,
      input.status || "draft",
      input.source_system_id ?? null,
      input.target_system_id ?? null,
      input.credential_id ?? null,
      input.transformation_id ?? null,
      input.schedule_id ?? null,
      input.endpoint_id ?? null,
      toJson(input.retry_policy, {}),
      toJson(input.config, {}),
      toJson(input.auth, {}),
      Number(input.timeout_seconds) || 30,
      input.owner_id ?? actor?.id ?? null,
      tenantId ?? input.tenant_id ?? null,
      input.organization_id ?? null,
      input.plant_id ?? null,
      input.site_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM integration_definitions WHERE id = ?", [Number(result.lastInsertRowid)]);
  snapshotDefinition(db, row, actor, "Initial version");
  auditIntegration(db, { actor, action: "integration.definition.create", resourceType: "integration_definition", resourceId: row.id, details: { code: row.code, integration_type: row.integration_type } });
  return expandDefinition(db, row);
}

export function updateDefinition(db, refValue, input = {}, actor = null) {
  const row = getDefinitionRow(db, refValue);
  if (!row) throw new HttpError(404, "Integration definition not found");
  if (input.integration_type !== undefined) normalizeIntegrationType(input.integration_type);
  if (input.direction !== undefined) normalizeDirection(input.direction);
  if (input.adapter_type !== undefined) normalizeAdapterType(input.adapter_type);
  if (input.status !== undefined) assertEnum(input.status, DEFINITION_STATUSES, "status");
  run(
    db,
    `UPDATE integration_definitions SET name=?, description=?, integration_type=?, direction=?, adapter_type=?, protocol=?,
       status=?, source_system_id=?, target_system_id=?, credential_id=?, transformation_id=?, schedule_id=?, endpoint_id=?,
       retry_policy_json=?, config_json=?, auth_json=?, timeout_seconds=?, owner_id=?, organization_id=?, plant_id=?, site_id=?,
       updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.description ?? row.description,
      input.integration_type ?? row.integration_type,
      input.direction ?? row.direction,
      input.adapter_type ?? row.adapter_type,
      input.protocol ?? row.protocol,
      input.status ?? row.status,
      input.source_system_id !== undefined ? input.source_system_id : row.source_system_id,
      input.target_system_id !== undefined ? input.target_system_id : row.target_system_id,
      input.credential_id !== undefined ? input.credential_id : row.credential_id,
      input.transformation_id !== undefined ? input.transformation_id : row.transformation_id,
      input.schedule_id !== undefined ? input.schedule_id : row.schedule_id,
      input.endpoint_id !== undefined ? input.endpoint_id : row.endpoint_id,
      input.retry_policy !== undefined ? toJson(input.retry_policy, {}) : row.retry_policy_json,
      input.config !== undefined ? toJson(input.config, {}) : row.config_json,
      input.auth !== undefined ? toJson(input.auth, {}) : row.auth_json,
      input.timeout_seconds !== undefined ? Number(input.timeout_seconds) : row.timeout_seconds,
      input.owner_id !== undefined ? input.owner_id : row.owner_id,
      input.organization_id !== undefined ? input.organization_id : row.organization_id,
      input.plant_id !== undefined ? input.plant_id : row.plant_id,
      input.site_id !== undefined ? input.site_id : row.site_id,
      nowIso(),
      row.id,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM integration_definitions WHERE id = ?", [row.id]);
  if (input.snapshot !== false) snapshotDefinition(db, updated, actor, input.version_notes || "Updated configuration");
  auditIntegration(db, { actor, action: "integration.definition.update", resourceType: "integration_definition", resourceId: row.id, details: { code: row.code } });
  return expandDefinition(db, updated);
}

export function setDefinitionStatus(db, refValue, status, actor = null, reason = "") {
  assertEnum(status, DEFINITION_STATUSES, "status");
  const row = getDefinitionRow(db, refValue);
  if (!row) throw new HttpError(404, "Integration definition not found");
  run(db, "UPDATE integration_definitions SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), row.id]);
  auditIntegration(db, { actor, action: "integration.definition.status", resourceType: "integration_definition", resourceId: row.id, details: { status, reason } });
  return expandDefinition(db, queryOne(db, "SELECT * FROM integration_definitions WHERE id = ?", [row.id]));
}

export function deleteDefinition(db, refValue, actor = null) {
  const row = getDefinitionRow(db, refValue);
  if (!row) throw new HttpError(404, "Integration definition not found");
  run(db, "DELETE FROM integration_definitions WHERE id = ?", [row.id]);
  auditIntegration(db, { actor, action: "integration.definition.delete", resourceType: "integration_definition", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}

// ── Version snapshots ───────────────────────────────────────────────────────
export function snapshotDefinition(db, row, actor = null, notes = "") {
  const existing = queryOne(db, "SELECT MAX(version) AS v FROM integration_definition_versions WHERE definition_id = ?", [row.id]);
  const version = Math.max(Number(row.version) || 1, (existing?.v || 0) + 1);
  run(
    db,
    `INSERT INTO integration_definition_versions (definition_id, version, status, notes, snapshot_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, version, row.status, notes, toJson({ ...row }), actor?.id ?? null, nowIso()]
  );
  run(db, "UPDATE integration_definitions SET version = ? WHERE id = ?", [version, row.id]);
  return { definition_id: row.id, version };
}

export function listDefinitionVersions(db, refValue) {
  const row = getDefinitionRow(db, refValue);
  if (!row) throw new HttpError(404, "Integration definition not found");
  const rows = queryAll(db, "SELECT * FROM integration_definition_versions WHERE definition_id = ? ORDER BY version DESC", [row.id]);
  return { items: rows.map((r) => publicDefinitionVersion(r)), total: rows.length };
}

export function restoreDefinitionVersion(db, refValue, version, actor = null) {
  const row = getDefinitionRow(db, refValue);
  if (!row) throw new HttpError(404, "Integration definition not found");
  const snapshot = queryOne(db, "SELECT * FROM integration_definition_versions WHERE definition_id = ? AND version = ?", [row.id, Number(version)]);
  if (!snapshot) throw new HttpError(404, "Definition version not found");
  const data = safeParse(snapshot.snapshot_json, {});
  const input = {
    name: data.name,
    description: data.description,
    integration_type: data.integration_type,
    direction: data.direction,
    adapter_type: data.adapter_type,
    protocol: data.protocol,
    status: "draft",
    source_system_id: data.source_system_id,
    target_system_id: data.target_system_id,
    credential_id: data.credential_id,
    transformation_id: data.transformation_id,
    schedule_id: data.schedule_id,
    endpoint_id: data.endpoint_id,
    retry_policy: safeParse(data.retry_policy_json, {}),
    config: safeParse(data.config_json, {}),
    auth: safeParse(data.auth_json, {}),
    timeout_seconds: data.timeout_seconds,
    version_notes: `Restored from version ${version}`,
  };
  const restored = updateDefinition(db, row.id, input, actor);
  auditIntegration(db, { actor, action: "integration.definition.restore", resourceType: "integration_definition", resourceId: row.id, details: { version: Number(version) } });
  return restored;
}

// ── Executions ──────────────────────────────────────────────────────────────
export function listExecutions(db, options = {}) {
  const { tenantId, definitionId, status, triggerType, q } = options;
  const { page = 1, pageSize = 50 } = options;
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (definitionId) {
    clauses.push("definition_id = ?");
    params.push(Number(definitionId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (triggerType) {
    clauses.push("trigger_type = ?");
    params.push(triggerType);
  }
  if (q) {
    clauses.push("(LOWER(execution_ref) LIKE ? OR LOWER(integration_code) LIKE ? OR LOWER(correlation_id) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_executions ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_executions ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicExecution(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getExecutionRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM integration_executions WHERE id = ? OR execution_ref = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getExecution(db, refValue, { includeSteps = true } = {}) {
  const row = getExecutionRow(db, refValue);
  if (!row) throw new HttpError(404, "Integration execution not found");
  const steps = includeSteps ? listSteps(db, row.id) : null;
  const definition = row.definition_id ? queryOne(db, "SELECT * FROM integration_definitions WHERE id = ?", [row.definition_id]) : null;
  return publicExecution(row, { steps, definition });
}

export function listSteps(db, executionId) {
  return queryAll(db, "SELECT * FROM integration_execution_steps WHERE execution_id = ? ORDER BY seq", [Number(executionId)]).map((r) => publicStep(r));
}

function addStep(db, executionId, name, status, { message = "", detail = {} } = {}) {
  const seq = (queryOne(db, "SELECT MAX(seq) AS s FROM integration_execution_steps WHERE execution_id = ?", [executionId])?.s || 0) + 1;
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO integration_execution_steps (execution_id, seq, name, status, message, detail_json, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [executionId, seq, name, status, message, toJson(detail, {}), ts, status === "running" ? null : ts]
  );
  return Number(result.lastInsertRowid);
}

function finishStep(db, stepId, status, { message = "", detail = {} } = {}) {
  const started = queryOne(db, "SELECT started_at FROM integration_execution_steps WHERE id = ?", [stepId])?.started_at;
  const duration = started ? Date.now() - new Date(started).getTime() : null;
  run(db, "UPDATE integration_execution_steps SET status = ?, message = ?, detail_json = ?, finished_at = ?, duration_ms = ? WHERE id = ?", [
    status,
    message,
    toJson(detail, {}),
    nowIso(),
    duration,
    stepId,
  ]);
}

export function markExecutionCancelled(db, refValue, actor = null) {
  const row = getExecutionRow(db, refValue);
  if (!row) throw new HttpError(404, "Integration execution not found");
  if (!["pending", "running"].includes(row.status)) return publicExecution(row);
  run(db, "UPDATE integration_executions SET status = 'cancelled', finished_at = ?, error_message = ?, updated_at = ? WHERE id = ?", [nowIso(), "Cancelled by operator", nowIso(), row.id]);
  auditIntegration(db, { actor, action: "integration.execution.cancel", resourceType: "integration_execution", resourceId: row.id, details: {} });
  return getExecution(db, row.id);
}

function resolveAdapter(db, definition, { handler = null } = {}) {
  const config = adapterConfigFromDefinition(definition, { handler });
  if (definition.credential_id) {
    const secret = resolveCredentialSecret(db, definition.credential_id)?.secret || "";
    if (secret) {
      if (["oauth2", "jwt", "api_key", "signature"].includes(definition.auth?.method)) config.token = config.token || secret;
      else config.secret = config.secret || secret;
    }
  }
  const adapterType = definition.adapter_type || "rest";
  const resolvedHandler = handler || (config.handler_code ? getIntegrationHandler(config.handler_code) : null) || getIntegrationHandler(definition.code);
  if (resolvedHandler) config.handler = resolvedHandler;
  return createAdapter(adapterType, config);
}

// Orchestrates one integration run. The whole method is defensive: any failure
// is captured on the execution row (with error classification) rather than
// thrown, so callers (schedules / API / worker) get a durable audit record.
export async function executeIntegration(db, definitionRef, options = {}) {
  const definitionRow = typeof definitionRef === "object" && definitionRef ? definitionRef : getDefinitionRow(db, definitionRef);
  if (!definitionRow) throw new HttpError(404, "Integration definition not found");
  const { triggerType = "manual", actor = null, input = {}, handler = null, fetchImpl = null } = options;
  const started = nowIso();
  const correlation = input.correlation_id || ref("COR");
  const insert = run(
    db,
    `INSERT INTO integration_executions
      (execution_ref, definition_id, integration_code, correlation_id, trigger_type, source_system_id, target_system_id,
       status, request_ref, max_retries, initiated_by, initiated_as, tenant_id, organization_id, plant_id, site_id, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ref("EXE"),
      definitionRow.id,
      definitionRow.code,
      correlation,
      triggerType,
      definitionRow.source_system_id ?? null,
      definitionRow.target_system_id ?? null,
      input.request_ref || "",
      normalizeRetryPolicy(safeParse(definitionRow.retry_policy_json, {})).max_attempts,
      actor?.id ?? null,
      actor?.id ? "user" : "system",
      definitionRow.tenant_id ?? null,
      definitionRow.organization_id ?? null,
      definitionRow.plant_id ?? null,
      definitionRow.site_id ?? null,
      started,
      started,
      started,
    ]
  );
  const executionId = Number(insert.lastInsertRowid);
  const definition = expandDefinition(db, definitionRow);
  let recordCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let status = "succeeded";
  let errorMessage = "";
  let errorCategory = "";
  let errorCode = "";
  let responseBody = null;

  const resolveStep = addStep(db, executionId, "resolve", "succeeded", { detail: { adapter_type: definition.adapter_type } });

  // 1. Transformation
  let payload = input.payload ?? {};
  if (definition.transformation_id) {
    const stepId = addStep(db, executionId, "transform", "running");
    try {
      const transformationRow = getTransformationRow(db, definition.transformation_id);
      if (!transformationRow) throw new Error("Transformation definition not found");
      const normalized = { ...transformationRow, mappings: safeParse(transformationRow.mappings_json, []), constants: safeParse(transformationRow.constants_json, {}), conditionals: safeParse(transformationRow.conditionals_json, []), conversions: safeParse(transformationRow.conversions_json, []), lookups: safeParse(transformationRow.lookups_json, []), validation: safeParse(transformationRow.validation_json, []), error_handling: transformationRow.error_handling };
      payload = applyTransformation(normalized, payload).output;
      recordCount = Array.isArray(payload) ? payload.length : 1;
      finishStep(db, stepId, "succeeded", { detail: { transformation_code: transformationRow.code } });
    } catch (error) {
      const norm = classifyError(error);
      failureCount += 1;
      finishStep(db, stepId, "failed", { message: error.message });
      status = "failed";
      errorMessage = error.message;
      errorCategory = norm.category;
      errorCode = norm.code;
    }
  }

  // 2. Transport dispatch
  if (status !== "failed") {
    const stepId = addStep(db, executionId, "invoke", "running");
    try {
      const adapterType = definition.adapter_type || "rest";
      if (adapterType === "event_bus") {
        const eventType = definition.config?.event_type || definition.code;
        responseBody = publishEvent(db, { event_type_code: eventType, payload, correlation_id: correlation, source_module: "integration", tenant_id: definition.tenant_id }, actor);
      } else if (adapterType === "message_queue") {
        responseBody = enqueueMessage(db, { message_type: definition.config?.message_type || definition.code, direction: definition.direction === "inbound" ? "inbound" : "outbound", integration_id: definition.id, payload, correlation_id: correlation, tenant_id: definition.tenant_id }, actor);
      } else if (adapterType === "file" && definition.direction === "outbound") {
        const adapter = resolveAdapter(db, definition, { handler });
        responseBody = await adapter.uploadFile({ path: definition.config?.path || `${definition.code}.json`, content: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) });
      } else if (adapterType === "file") {
        const adapter = resolveAdapter(db, definition, { handler });
        responseBody = await adapter.downloadFile({ path: definition.config?.path || `${definition.code}.json` });
      } else {
        const adapter = resolveAdapter(db, definition, { handler });
        if (fetchImpl && adapter.type === "rest") adapter.sendRequest = (request) => fetchImpl({ ...request, url: adapter.endpoint()?.toString() });
        responseBody = await invokeAdapterRequest(adapter, { method: definition.config?.method || (definition.direction === "outbound" ? "POST" : "GET"), body: payload, url: definition.config?.url }, { retryPolicy: safeParse(definitionRow.retry_policy_json, {}) });
      }
      successCount = recordCount || 1;
      finishStep(db, stepId, "succeeded", { detail: { adapter_type: adapterType } });
    } catch (error) {
      const norm = classifyError(error);
      failureCount += 1;
      status = "failed";
      errorMessage = error.message;
      errorCategory = norm.category;
      errorCode = norm.code;
      finishStep(db, stepId, "failed", { message: error.message, detail: { category: norm.category, code: norm.code } });
    }
  }

  const finished = nowIso();
  const duration = Date.now() - new Date(started).getTime();
  run(
    db,
    `UPDATE integration_executions SET status = ?, current_step = '', response_ref = ?, record_count = ?, success_count = ?, failure_count = ?,
       error_code = ?, error_message = ?, error_category = ?, finished_at = ?, duration_ms = ?, updated_at = ? WHERE id = ?`,
    [status, responseBody ? String(responseBody.id || responseBody.message_ref || responseBody.execution_ref || "") : "", recordCount, successCount, failureCount, errorCode, errorMessage, errorCategory, finished, duration, finished, executionId]
  );
  run(db, "UPDATE integration_definitions SET last_run_at = ?, last_status = ?, updated_at = ? WHERE id = ?", [finished, status, finished, definitionRow.id]);

  try {
    publishEvent(
      db,
      {
        event_type_code: "IntegrationExecutionCompleted",
        payload: { execution_id: executionId, integration_code: definition.code, status, success_count: successCount, failure_count: failureCount, error_message: errorMessage },
        source_module: "integration",
        correlation_id: correlation,
        tenant_id: definition.tenant_id,
      },
      actor
    );
  } catch (error) {
    log("warn", "integration.execution.event_failed", { execution_id: executionId, error: error.message });
  }

  auditIntegration(db, { actor, action: "integration.execution.complete", resourceType: "integration_execution", resourceId: executionId, details: { integration: definition.code, status }, status: status === "succeeded" ? "success" : "failure" });
  return { execution: getExecution(db, executionId), response: responseBody };
}

// Retries a previously failed execution by starting a new child execution.
export async function retryExecution(db, refValue, actor = null, options = {}) {
  const row = getExecutionRow(db, refValue);
  if (!row) throw new HttpError(404, "Integration execution not found");
  if (!EXECUTION_RETRYABLE.includes(row.status)) throw new HttpError(409, `Execution in status ${row.status} cannot be retried`);
  const definition = getDefinitionRow(db, row.definition_id);
  if (!definition) throw new HttpError(404, "Integration definition not found");
  run(db, "UPDATE integration_executions SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  const result = await executeIntegration(db, definition, {
    triggerType: "retry",
    actor,
    input: { correlation_id: row.correlation_id, parent_execution_id: row.id },
    ...options,
  });
  run(db, "UPDATE integration_executions SET parent_execution_id = ? WHERE id = ?", [row.id, result.execution.id]);
  return result;
}

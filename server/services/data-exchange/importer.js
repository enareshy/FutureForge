// Import execution engine.
//
// This is the orchestration core: resolve the source connector, parse records,
// map them, transform them, validate them, enforce security, resolve duplicates
// and write through the object framework — batch by batch, with checkpoints,
// per-record results, structured errors and reconciliation.
//
// It never stores a copy of the business data: records flow straight through to
// the owning module through the object framework.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { createObject, updateObject } from "../objects.js";
import { CONFIG_DEFAULTS } from "./constants.js";
import { importJobRef as makeJobRef } from "./refs.js";
import { publicImportJob, publicImportRecordResult, publicImportError } from "./repository.js";
import { requireConnector } from "./connectors/registry.js";
import { invalidDefinition, jobConflict, recordFailed } from "./errors.js";
import {
  normalizeText,
  normalizeUpper,
  paginate,
  parseObject,
  assertExecutionMode,
} from "./validation.js";
import { Engines } from "./engines/index.js";
import { authorizeRecord, enforceRecordFields } from "./security.js";
import { listConfig } from "./configuration.js";
import { publishExchangeEvent } from "./events.js";
import { recordHistory } from "./history.js";
import { getImportDefinitionRow, withImportChildren } from "./import-definitions.js";
import { createLookupResolver } from "./engines/lookup.js";
import * as Lifecycle from "./lifecycle.js";
import * as Quality from "./quality.js";

const BUILTIN_FIELDS = new Set(["code", "name", "description", "external_ref", "external_system", "status", "owner_id", "organization_id", "tags"]);

function configFor(db, tenantId) {
  return listConfig(db, tenantId);
}

// ── Job ledger ───────────────────────────────────────────────────────────────

export function getImportJobRow(db, tenantId, ref) {
  return queryOne(
    db,
    "SELECT * FROM ie_import_jobs WHERE tenant_id = ? AND (job_ref = ? OR CAST(id AS TEXT) = ?)",
    [Number(tenantId), String(ref), String(ref)]
  );
}

export function createImportJob(db, { tenantId, definition, mode, params = {}, actor = null, ip = null, idempotencyKey = "" }) {
  const tenant = Number(tenantId);
  if (idempotencyKey) {
    const existing = queryOne(db, "SELECT * FROM ie_import_jobs WHERE tenant_id = ? AND idempotency_key = ?", [tenant, idempotencyKey]);
    if (existing) return { job: existing, existing: true };
  }
  const ts = nowIso();
  const definitionId = definition?.id ?? null;
  const jobRef = makeJobRef(definition?.code || "JOB");
  const result = run(
    db,
    `INSERT INTO ie_import_jobs (job_ref, tenant_id, organization_id, definition_id, definition_version, source_type, target_object_type, mode, duplicate_strategy, status, batch_size,
       source_json, mapping_json, transformation_json, validation_json, options_json, idempotency_key, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobRef,
      tenant,
      params.organization_id ?? params.organizationId ?? definition?.organization_id ?? null,
      definitionId,
      definition?.version ?? 1,
      definition?.source_type || "CSV",
      definition?.target_object_type || "",
      assertExecutionMode(mode || definition?.mode || "IMPORT"),
      definition?.duplicate_strategy || "REJECT",
      Number(definition?.batch_size || configFor(db, tenant).default_batch_size || CONFIG_DEFAULTS.default_batch_size),
      JSON.stringify({ ...(definition?.source_config || {}), ...parseObject(params.source, {}) }),
      JSON.stringify({ ...(definition?.mapping || {}), mappings: definition?.mappings || [] }),
      JSON.stringify({ ...(definition?.transformation || {}), transformations: definition?.transformations || [] }),
      JSON.stringify({ ...(definition?.validation || {}), rules: definition?.validation_rules || [] }),
      JSON.stringify(parseObject(params.options, {})),
      normalizeText(idempotencyKey, { max: 200 }),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const job = queryOne(db, "SELECT * FROM ie_import_jobs WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, { actor, action: "data_exchange.import_job.create", resourceType: "ie_import_jobs", resourceId: jobRef, details: { definition: definition?.code || null, mode: job.mode }, ip });
  recordHistory(db, { direction: "IMPORT", tenantId: tenant, jobId: job.id, definitionId, definitionVersion: job.definition_version, action: "JOB_CREATED", status: job.status, sourceType: job.source_type, targetObjectType: job.target_object_type, actor });
  return { job, existing: false };
}

// Clear the execution ledger for a job so an explicit re-run starts clean.
// Idempotent replays are handled upstream and never reach this path.
function resetJobExecution(db, jobId) {
  const id = Number(jobId);
  run(db, "DELETE FROM ie_import_record_results WHERE job_id = ?", [id]);
  run(db, "DELETE FROM ie_import_batches WHERE job_id = ?", [id]);
  run(db, "DELETE FROM ie_import_checkpoints WHERE job_id = ?", [id]);
  run(db, "DELETE FROM ie_import_errors WHERE job_id = ?", [id]);
}

function updateJob(db, jobId, patch) {
  const columns = Object.keys(patch);
  if (!columns.length) return;
  const assignments = columns.map((column) => `${column} = ?`).join(", ");
  run(db, `UPDATE ie_import_jobs SET ${assignments}, updated_at = ? WHERE id = ?`, [...columns.map((column) => patch[column]), nowIso(), Number(jobId)]);
}

// ── Source resolution ────────────────────────────────────────────────────────

function resolveConnectorContext(db, tenantId, definition, params = {}) {
  const connectorType = definition.source_type || "CSV";
  const connector = requireConnector(connectorType);
  let settings = { ...parseObject(definition.source_config, {}) };
  let credentials = null;
  if (definition.connector_config_id) {
    const config = queryOne(db, "SELECT * FROM ie_connector_configurations WHERE id = ? AND tenant_id = ?", [
      Number(definition.connector_config_id),
      Number(tenantId),
    ]);
    if (!config) throw invalidDefinition("The connector configuration referenced by this definition was not found");
    if (config.status !== "active") throw invalidDefinition("The connector configuration referenced by this definition is not active");
    settings = { ...parseObject(config.settings_json, {}), ...settings };
    if (config.credential_ref_id) {
      const ref = queryOne(db, "SELECT * FROM ie_connector_credential_references WHERE id = ? AND tenant_id = ?", [Number(config.credential_ref_id), Number(tenantId)]);
      credentials = ref ? { secret_ref: ref.secret_ref, credential_type: ref.credential_type, metadata: parseObject(ref.metadata_json, {}) } : null;
    }
  }
  const buffer = params.buffer ?? null;
  const content = params.content ?? null;
  if (buffer || content) settings = { ...settings, ...(params.settings ? parseObject(params.settings, {}) : {}) };
  else if (params.settings) settings = { ...settings, ...parseObject(params.settings, {}) };
  return { connector, ctx: { db, settings, credentials, buffer, content, tenant_id: Number(tenantId), definition } };
}

export async function parseImportSource(db, tenantId, definition, params = {}) {
  const { connector, ctx } = resolveConnectorContext(db, tenantId, definition, params);
  const result = await connector.read(ctx);
  const records = Array.isArray(result.records) ? result.records : [];
  const fields = Array.isArray(result.fields) ? result.fields : [];
  return { connector: connector.code, fields, records };
}

// ── Record processing ────────────────────────────────────────────────────────

function schemaFor(db, tenantId, objectType) {
  try {
    return Engines.targetSchema(db, tenantId, objectType);
  } catch {
    return { object_type: objectType, fields: [], field_names: [], required_fields: [] };
  }
}

function buildObjectBody(objectType, mapped, organizationId) {
  const data = {};
  const body = { type: objectType };
  const assign = (key, value) => {
    if (BUILTIN_FIELDS.has(key)) body[key] = value;
    else data[key] = value;
  };
  const flatten = (prefix, value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      for (const [child, childValue] of Object.entries(value)) flatten(prefix ? `${prefix}.${child}` : child, childValue);
      return;
    }
    assign(prefix, value);
  };
  for (const [key, value] of Object.entries(mapped || {})) flatten(key, value);
  body.data = data;
  if (organizationId) body.organization_id = organizationId;
  return body;
}

function findExistingObject(db, tenantId, objectType, key, duplicateKey = {}) {
  const type = queryOne(db, "SELECT id FROM metadata_types WHERE code = ? AND (tenant_id IS NULL OR tenant_id = ?) AND status = 'active'", [
    objectType,
    Number(tenantId),
  ]);
  if (!type) return null;
  if (key === null || key === undefined || key === "") return null;
  const keyType = normalizeUpper(duplicateKey.type || "BUSINESS_KEY");
  const base = "SELECT * FROM objects WHERE tenant_id = ? AND object_type_id = ? AND deleted_at IS NULL";
  if (keyType === "OBJECT_ID") {
    return queryOne(db, `${base} AND (code = ? OR uuid = ?)`, [Number(tenantId), type.id, String(key), String(key)]);
  }
  if (keyType === "EXTERNAL_REFERENCE" || keyType === "SOURCE_EXTERNAL_ID") {
    return queryOne(db, `${base} AND external_ref = ?`, [Number(tenantId), type.id, String(key)]);
  }
  return queryOne(db, `${base} AND (code = ? OR external_ref = ?)`, [Number(tenantId), type.id, String(key), String(key)]);
}

function recordImportError(db, { tenantId, jobId, batchNumber, recordNumber, errorCode, errorType = "RECORD", message, field = "", retryable = false, details = {} }) {
  run(
    db,
    `INSERT INTO ie_import_errors (job_id, tenant_id, batch_number, record_number, error_code, error_type, message, field, retryable, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [Number(jobId), Number(tenantId), Number(batchNumber || 0), Number(recordNumber || 0), String(errorCode), errorType, normalizeText(message, { max: 1000 }), field, retryable ? 1 : 0, JSON.stringify(details || {}), nowIso()]
  );
}

function saveRecordResult(db, { tenantId, jobId, batchNumber, recordNumber, businessKey, action, status, targetObjectType, targetObjectId, message, source, mapped, transformed, validation, durationMs }) {
  run(
    db,
    `INSERT INTO ie_import_record_results (job_id, tenant_id, batch_number, record_number, business_key, action, status, target_object_type, target_object_id, message, source_json, mapped_json, transformed_json, validation_json, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(jobId),
      Number(tenantId),
      Number(batchNumber || 0),
      Number(recordNumber || 0),
      normalizeText(businessKey, { max: 300 }),
      action,
      status,
      targetObjectType || "",
      targetObjectId != null ? String(targetObjectId) : "",
      normalizeText(message, { max: 1000 }),
      JSON.stringify(source || {}),
      JSON.stringify(mapped || {}),
      JSON.stringify(transformed || {}),
      JSON.stringify(validation || {}),
      Number(durationMs || 0),
      nowIso(),
    ]
  );
}

// Processes one source record. Returns a result descriptor; never throws for
// expected per-record failures (callers decide based on error_strategy).
function processRecord(db, { tenantId, definition, job, schema, record, index, batchNumber, actor, ip, config, lookupResolver, writeEnabled = true, lifecycleOverride = false }) {
  const started = Date.now();
  const out = { action: "CREATE", status: "SUCCESS", mapped: {}, transformed: {}, validation: {}, targetObjectId: null, businessKey: "", message: "" };
  const mappings = definition.mappings || [];
  const { target: mapped, errors: mappingErrors } = Engines.applyMappings(mappings, record, { lookupResolver });
  out.mapped = mapped;
  if (mappingErrors.length) {
    return { ...out, action: "FAIL", status: "FAILED", message: mappingErrors[0].message, error: { code: "MAPPING", message: mappingErrors[0].message, field: mappingErrors[0].field, details: { errors: mappingErrors } }, durationMs: Date.now() - started };
  }

  const transformed = Engines.applyDefinitionTransformations(definition.transformations || [], mapped, { lookup: lookupResolver });
  out.transformed = transformed;

  const ruleResult = Engines.evaluateRules(definition.validation_rules || [], transformed, { lookupResolver });
  out.validation = { errors: ruleResult.errors, warnings: ruleResult.warnings };
  const errors = [...(ruleResult.errors || [])];
  if (definition?.validation?.strict_schema && schema?.fields?.length) {
    const schemaCheck = Engines.validateTargetRecord(schema, transformed, { strict: false });
    errors.push(...schemaCheck.errors);
    out.validation.warnings = [...(out.validation.warnings || []), ...schemaCheck.warnings];
  }
  if (errors.length) {
    return {
      ...out,
      action: "REJECT",
      status: "ERROR",
      message: errors[0].message || "Validation failed",
      error: { code: "VALIDATION", message: errors[0].message || "Validation failed", field: errors[0].field || "", details: { errors } },
      durationMs: Date.now() - started,
    };
  }

  const duplicateKeyConfig = definition.duplicate_key || {};
  const key = (() => {
    try {
      return Engines.computeDuplicateKey(transformed, duplicateKeyConfig);
    } catch {
      return transformed.code ?? "";
    }
  })();
  out.businessKey = key;
  const existing = findExistingObject(db, tenantId, definition.target_object_type, key, duplicateKeyConfig);
  const decision = Engines.decideDuplicate(definition.duplicate_strategy, { existing });
  out.action = decision.action;

  if (decision.action === "REJECT") {
    return { ...out, status: "FAILED", message: `Duplicate record rejected: ${key}`, error: { code: "DUPLICATE", message: `Duplicate record rejected: ${key}`, details: { key } }, durationMs: Date.now() - started };
  }
  if (decision.action === "SKIP") {
    return { ...out, status: "SKIPPED", action: "SKIP", targetObjectId: existing?.id ?? null, message: "Existing record skipped", durationMs: Date.now() - started };
  }

  const organizationId = transformed.organization_id ?? definition.organization_id ?? null;
  const securityAction = decision.action === "UPDATE" || decision.action === "MERGE" ? "update" : "create";
  try {
    authorizeRecord(db, actor, {
      objectType: definition.target_object_type,
      objectId: existing?.id ?? null,
      action: securityAction,
      tenantId,
      organizationId,
      classification: transformed.classification || "",
      ip,
    });
  } catch (error) {
    return { ...out, action: "REJECT", status: "FAILED", message: error.message, error: { code: "SECURITY", message: error.message, details: error.details || {} }, durationMs: Date.now() - started };
  }

  const body = buildObjectBody(definition.target_object_type, transformed, organizationId);
  if (!writeEnabled) {
    return { ...out, action: decision.action === "SKIP" ? "SKIP" : decision.action, status: "SUCCESS", targetObjectId: existing?.id ?? null, message: "Validated (no write performed)", durationMs: Date.now() - started };
  }
  if ((decision.action === "UPDATE" || decision.action === "MERGE") && existing) {
    // Lifecycle & Archival (spec §56): never write into a state whose update
    // capability is off unless an explicit administrative recovery permits it.
    try {
      Lifecycle.assertImportStateAllowed(db, tenantId, {
        objectType: definition.target_object_type,
        objectId: existing.id,
        permit: lifecycleOverride,
      });
    } catch (error) {
      return { ...out, action: "REJECT", status: "FAILED", message: error.message, error: { code: "LIFECYCLE", message: error.message, details: error.details || {} }, durationMs: Date.now() - started };
    }
  }
  try {
    if ((decision.action === "UPDATE" || decision.action === "MERGE") && existing) {
      const patch = decision.action === "MERGE" ? { ...body, data: Engines.mergeRecords(parseObject(existing.data_json, {}), body.data) } : body;
      const updated = updateObject(db, existing.id, patch, actor, tenantId, ip);
      out.targetObjectId = updated.id;
      out.status = "SUCCESS";
      return { ...out, action: "UPDATE", message: "Record updated", durationMs: Date.now() - started };
    }
    const created = createObject(db, body, actor, tenantId, ip);
    out.targetObjectId = created.id;
    out.status = "SUCCESS";
    return { ...out, action: "CREATE", message: "Record created", durationMs: Date.now() - started };
  } catch (error) {
    return {
      ...out,
      action: "FAIL",
      status: "FAILED",
      message: error.message,
      error: { code: error.code || "BUSINESS", message: error.message, field: error.details?.field || "", retryable: Number(error.status) >= 500, details: error.details || {} },
      durationMs: Date.now() - started,
    };
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

export async function runImportJob(db, { jobId, params = {}, actor = null, ip = null } = {}) {
  const job = queryOne(db, "SELECT * FROM ie_import_jobs WHERE id = ?", [Number(jobId)]);
  if (!job) throw jobConflict(`Import job not found: ${jobId}`);
  const tenantId = Number(job.tenant_id);
  const config = configFor(db, tenantId);
  const definitionRow = job.definition_id ? queryOne(db, "SELECT * FROM ie_import_definitions WHERE id = ?", [job.definition_id]) : null;
  const definition = definitionRow ? withImportChildren(db, definitionRow) : null;
  if (!definition) throw invalidDefinition("The definition for this import job no longer exists");

  resetJobExecution(db, job.id);
  const startedAt = nowIso();
  updateJob(db, job.id, { status: "RUNNING", started_at: job.started_at || startedAt });
  publishExchangeEvent(db, { eventType: "ImportStarted", tenantId, objectId: job.job_ref, payload: { job_ref: job.job_ref, mode: job.mode } }, actor);
  const durationGuard = { started: Date.now() };

  let records = [];
  try {
    const parsed = await parseImportSource(db, tenantId, definition, params);
    records = parsed.records;
    if (Array.isArray(params.record_numbers) && params.record_numbers.length) {
      const wanted = new Set(params.record_numbers.map((n) => Number(n)));
      records = records.filter((_record, index) => wanted.has(index + 1));
    }
  } catch (error) {
    updateJob(db, job.id, { status: "FAILED", error_message: normalizeText(error.message, { max: 1000 }), completed_at: nowIso() });
    recordImportError(db, { tenantId, jobId: job.id, errorCode: "CONNECTOR", errorType: "CONNECTOR", message: error.message, retryable: true, details: error.details || {} });
    publishExchangeEvent(db, { eventType: "ImportFailed", tenantId, objectId: job.job_ref, payload: { error: error.message } }, actor);
    recordHistory(db, { direction: "IMPORT", tenantId, jobId: job.id, definitionId: job.definition_id, definitionVersion: job.definition_version, action: "JOB_FAILED", status: "FAILED", sourceType: job.source_type, targetObjectType: job.target_object_type, actor, details: { error: error.message } });
    return publicImportJob(queryOne(db, "SELECT * FROM ie_import_jobs WHERE id = ?", [job.id]));
  }

  const total = Number.isFinite(Number(params.limit)) && params.limit !== undefined && params.limit !== null ? Math.min(Number(params.limit), records.length) : records.length;
  const batchSize = Number(job.batch_size) || config.default_batch_size || 500;
  const mode = assertExecutionMode(job.mode);
  const schema = schemaFor(db, tenantId, definition.target_object_type);
  const lookupResolver = createLookupResolver({ staticMaps: parseObject(definition.source_config?.lookups, {}), cacheSize: config.lookup_cache_size });
  const writeEnabled = mode === "IMPORT" && !params.dry_run;
  const lifecycleOverride = Boolean(params.allow_lifecycle_write || params.lifecycle_override);
  const counters = { processed: 0, success: 0, created: 0, updated: 0, skipped: 0, rejected: 0, failed: 0, warning: 0 };
  updateJob(db, job.id, { status: mode === "PREVIEW" ? "PREVIEW" : "RUNNING", total_records: total });
  let checkpointSequence = 0;
  let stop = false;

  for (let offset = 0; offset < total && !stop; offset += batchSize) {
    const slice = records.slice(offset, Math.min(offset + batchSize, total));
    const batchNumber = Math.floor(offset / batchSize) + 1;
    const batchStart = Date.now();
    const batchCounters = { success: 0, created: 0, updated: 0, skipped: 0, rejected: 0, failed: 0 };
    run(
      db,
      `INSERT INTO ie_import_batches (job_id, tenant_id, batch_number, start_record, end_record, total, status, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?)`,
      [job.id, tenantId, batchNumber, offset + 1, offset + slice.length, slice.length, nowIso(), nowIso()]
    );
    for (let i = 0; i < slice.length; i += 1) {
      const recordNumber = offset + i + 1;
      const result = processRecord(db, {
        tenantId,
        definition,
        job,
        schema,
        record: slice[i],
        index: recordNumber,
        batchNumber,
        actor,
        ip,
        config,
        lookupResolver,
        writeEnabled,
        lifecycleOverride,
      });
      counters.processed += 1;
      if (result.status === "SUCCESS") {
        counters.success += 1;
        batchCounters.success += 1;
        if (writeEnabled) {
          if (result.action === "UPDATE") {
            counters.updated += 1;
            batchCounters.updated += 1;
          } else if (result.action === "CREATE") {
            counters.created += 1;
            batchCounters.created += 1;
          }
        }
      } else if (result.status === "SKIPPED") {
        counters.skipped += 1;
        batchCounters.skipped += 1;
      } else if (result.status === "ERROR" || result.error?.code === "DUPLICATE") {
        counters.rejected += 1;
        batchCounters.rejected += 1;
      } else {
        counters.failed += 1;
        batchCounters.failed += 1;
      }
      const ledgerStatus = result.status === "SUCCESS" ? "SUCCESS" : result.status === "SKIPPED" ? "SKIPPED" : result.status === "ERROR" ? "ERROR" : "FAILED";
      saveRecordResult(db, {
        tenantId,
        jobId: job.id,
        batchNumber,
        recordNumber,
        businessKey: result.businessKey,
        action: result.action,
        status: ledgerStatus,
        targetObjectType: definition.target_object_type,
        targetObjectId: result.targetObjectId,
        message: result.message,
        source: mode === "IMPORT" || mode === "PREVIEW" ? slice[i] : {},
        mapped: result.mapped,
        transformed: result.transformed,
        validation: result.validation,
        durationMs: result.durationMs,
      });
      if (result.error) {
        recordImportError(db, {
          tenantId,
          jobId: job.id,
          batchNumber,
          recordNumber,
          errorCode: result.error.code || "RECORD",
          errorType: result.error.code === "CONNECTOR" ? "CONNECTOR" : result.error.code === "MAPPING" ? "MAPPING" : result.error.code === "SECURITY" ? "VALIDATION" : "RECORD",
          message: result.error.message,
          field: result.error.field || "",
          retryable: Boolean(result.error.retryable),
          details: result.error.details || {},
        });
      }
      if (definition.error_strategy === "STOP_ON_ERROR" && (result.status === "ERROR" || result.status === "FAILED")) {
        stop = true;
        break;
      }
    }
    run(
      db,
      `UPDATE ie_import_batches SET status = ?, success = ?, created = ?, updated = ?, skipped = ?, rejected = ?, failed = ?, duration_ms = ?, completed_at = ? WHERE job_id = ? AND batch_number = ?`,
      [stop ? "FAILED" : "COMPLETED", batchCounters.success, batchCounters.created, batchCounters.updated, batchCounters.skipped, batchCounters.rejected, batchCounters.failed, Date.now() - batchStart, nowIso(), job.id, batchNumber]
    );
    updateJob(db, job.id, {
      processed_records: counters.processed,
      success_count: counters.success,
      created_count: counters.created,
      updated_count: counters.updated,
      skipped_count: counters.skipped,
      rejected_count: counters.rejected,
      failed_count: counters.failed,
    });
    if (counters.processed % (Number(config.checkpoint_interval) || 1000) < batchSize) {
      checkpointSequence += 1;
      run(
        db,
        `INSERT INTO ie_import_checkpoints (job_id, tenant_id, checkpoint_number, last_record, processed, success, failed, state_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [job.id, tenantId, checkpointSequence, offset + slice.length, counters.processed, counters.success, counters.failed, JSON.stringify({ batch: batchNumber }), nowIso()]
      );
    }
  }

  const sourceCount = total;
  const reconciliation = reconcileImport(db, {
    tenantId,
    jobId: job.id,
    strategy: definition.reconciliation_strategy,
    counters,
    sourceCount,
  });

  // Data Quality integration (spec §54): hand the resulting objects to the shared
  // quality service and record the aggregate score. The gate blocks a run whose
  // score falls below the configured minimum.
  let quality = null;
  let qualityGateBlocked = false;
  if (writeEnabled && (counters.created || counters.updated)) {
    const objectIds = queryAll(
      db,
      "SELECT DISTINCT target_object_id AS id FROM ie_import_record_results WHERE job_id = ? AND status = 'SUCCESS' AND target_object_id IS NOT NULL",
      [job.id]
    ).map((row) => row.id);
    quality = Quality.evaluateImportedObjects(db, tenantId, { objectType: definition.target_object_type, objectIds, actor, ip });
    try {
      Quality.assertQualityGate(quality, config);
    } catch (error) {
      qualityGateBlocked = true;
      quality = { ...quality, blocked: true, message: error.message };
    }
  }

  const finalStatus = qualityGateBlocked
    ? "FAILED"
    : counters.failed && counters.success
      ? "PARTIAL"
      : counters.failed && !counters.success
        ? "FAILED"
        : counters.rejected && !counters.success
          ? "FAILED"
          : "COMPLETED";
  const summary = {
    source_count: sourceCount,
    processed: counters.processed,
    created: counters.created,
    updated: counters.updated,
    skipped: counters.skipped,
    rejected: counters.rejected,
    failed: counters.failed,
    reconciliation_status: reconciliation.status,
    duration_ms: Date.now() - durationGuard.started,
    ...(quality ? { quality } : {}),
  };
  updateJob(db, job.id, {
    status: finalStatus,
    success_count: counters.success,
    created_count: counters.created,
    updated_count: counters.updated,
    skipped_count: counters.skipped,
    rejected_count: counters.rejected,
    failed_count: counters.failed,
    summary_json: JSON.stringify(summary),
    error_message: qualityGateBlocked ? quality?.message || "Blocked by the data quality gate" : "",
    completed_at: nowIso(),
  });
  const finalJob = queryOne(db, "SELECT * FROM ie_import_jobs WHERE id = ?", [job.id]);
  writeAudit(db, { actor, action: "data_exchange.import_job.complete", resourceType: "ie_import_jobs", resourceId: job.job_ref, details: summary, ip });
  recordHistory(db, {
    direction: "IMPORT",
    tenantId,
    jobId: job.id,
    definitionId: job.definition_id,
    definitionVersion: job.definition_version,
    action: "JOB_COMPLETED",
    status: finalStatus,
    sourceType: job.source_type,
    targetObjectType: job.target_object_type,
    totalRecords: sourceCount,
    successCount: counters.success,
    failedCount: counters.failed,
    actor,
    details: summary,
  });
  const eventType = finalStatus === "COMPLETED" ? "ImportCompleted" : finalStatus === "PARTIAL" ? "ImportPartiallyCompleted" : "ImportFailed";
  publishExchangeEvent(db, { eventType, tenantId, objectId: job.job_ref, payload: { job_ref: job.job_ref, ...summary } }, actor);
  return publicImportJob(finalJob);
}

// ── Preview & validate ───────────────────────────────────────────────────────

export async function previewImport(db, tenantId, definition, params = {}, actor = null, ip = null) {
  const config = configFor(db, tenantId);
  const limit = Math.min(Number(params.limit) || config.preview_limit || 50, 200);
  const { fields, records } = await parseImportSource(db, tenantId, definition, params);
  const schema = schemaFor(db, tenantId, definition.target_object_type);
  const lookupResolver = createLookupResolver({ staticMaps: parseObject(definition.source_config?.lookups, {}), cacheSize: config.lookup_cache_size });
  const rows = [];
  let valid = 0;
  let invalid = 0;
  for (const record of records.slice(0, limit)) {
    const { target: mapped, errors: mappingErrors } = Engines.applyMappings(definition.mappings || [], record, { lookupResolver });
    const transformed = mappingErrors.length ? {} : Engines.applyDefinitionTransformations(definition.transformations || [], mapped, { lookup: lookupResolver });
    const ruleResult = Engines.evaluateRules(definition.validation_rules || [], transformed, { lookupResolver });
    let safe = transformed;
    const denied = [];
    try {
      const enforced = enforceRecordFields(db, actor, { objectType: definition.target_object_type, record: transformed, action: "read", tenantId, organizationId: definition.organization_id, ip });
      safe = enforced.record;
      denied.push(...enforced.denied);
    } catch {
      /* masking is best effort for preview display */
    }
    const rowErrors = [...mappingErrors, ...ruleResult.errors];
    if (rowErrors.length) invalid += 1;
    else valid += 1;
    rows.push({ source: record, mapped, transformed: safe, masked_fields: denied, errors: rowErrors, warnings: ruleResult.warnings });
  }
  return {
    source_type: definition.source_type,
    target_object_type: definition.target_object_type,
    source_fields: fields,
    target_fields: schema.fields.map((field) => field.name),
    sample_size: rows.length,
    source_count: records.length,
    valid,
    invalid,
    rows,
  };
}

export async function validateImport(db, tenantId, definition, params = {}, actor = null, ip = null) {
  const config = configFor(db, tenantId);
  const lookupResolver = createLookupResolver({ staticMaps: parseObject(definition.source_config?.lookups, {}), cacheSize: config.lookup_cache_size });
  const { fields, records } = await parseImportSource(db, tenantId, definition, params);
  const schema = schemaFor(db, tenantId, definition.target_object_type);
  const summary = { source_count: records.length, valid: 0, invalid: 0, errors: 0, warnings: 0, mapping_errors: 0, sample_errors: [] };
  for (const record of records) {
    const { target: mapped, errors: mappingErrors } = Engines.applyMappings(definition.mappings || [], record, { lookupResolver });
    if (mappingErrors.length) {
      summary.mapping_errors += 1;
      summary.invalid += 1;
      if (summary.sample_errors.length < 20) summary.sample_errors.push({ record, errors: mappingErrors });
      continue;
    }
    const transformed = Engines.applyDefinitionTransformations(definition.transformations || [], mapped, { lookup: lookupResolver });
    const ruleResult = Engines.evaluateRules(definition.validation_rules || [], transformed, { lookupResolver });
    if (definition.validation?.strict_schema && schema.fields.length) {
      const schemaCheck = Engines.validateTargetRecord(schema, transformed, { strict: false });
      ruleResult.errors.push(...schemaCheck.errors);
      ruleResult.warnings.push(...schemaCheck.warnings);
    }
    summary.errors += ruleResult.errors.length;
    summary.warnings += ruleResult.warnings.length;
    if (ruleResult.errors.length) {
      summary.invalid += 1;
      if (summary.sample_errors.length < 20) summary.sample_errors.push({ record, errors: ruleResult.errors });
    } else {
      summary.valid += 1;
    }
  }
  return { ...summary, source_fields: fields, target_fields: schema.fields.map((field) => field.name) };
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export function reconcileImport(db, { tenantId, jobId, strategy = "COUNT", counters, sourceCount }) {
  const targetCount = Number(counters.success || 0);
  const variance = Number(sourceCount) - Number(targetCount) - Number(counters.skipped || 0);
  const percent = sourceCount > 0 ? Math.round(((Number(counters.processed) || 0) / sourceCount) * 10000) / 100 : 100;
  const status = variance === 0 ? "COMPLETED" : "VARIANCE";
  const report = {
    strategy,
    source_count: sourceCount,
    processed: counters.processed,
    created: counters.created,
    updated: counters.updated,
    skipped: counters.skipped,
    rejected: counters.rejected,
    failed: counters.failed,
    variance,
  };
  run(
    db,
    `INSERT INTO ie_import_reconciliations (job_id, tenant_id, strategy, source_count, valid_count, target_count, created_count, updated_count, skipped_count, failed_count, rejected_count, variance, reconciliation_percent, report_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET strategy = excluded.strategy, source_count = excluded.source_count, valid_count = excluded.valid_count, target_count = excluded.target_count,
       created_count = excluded.created_count, updated_count = excluded.updated_count, skipped_count = excluded.skipped_count, failed_count = excluded.failed_count,
       rejected_count = excluded.rejected_count, variance = excluded.variance, reconciliation_percent = excluded.reconciliation_percent, report_json = excluded.report_json,
       status = excluded.status, updated_at = excluded.updated_at`,
    [
      Number(jobId),
      Number(tenantId),
      strategy,
      Number(sourceCount),
      Number(counters.success || 0),
      targetCount,
      Number(counters.created || 0),
      Number(counters.updated || 0),
      Number(counters.skipped || 0),
      Number(counters.failed || 0),
      Number(counters.rejected || 0),
      variance,
      percent,
      JSON.stringify(report),
      status,
      nowIso(),
      nowIso(),
    ]
  );
  return { ...report, status, reconciliation_percent: percent };
}

// ── Query helpers ────────────────────────────────────────────────────────────

export function listImportJobs(db, { tenantId, status, definitionId, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (definitionId != null) {
    clauses.push("definition_id = ?");
    params.push(Number(definitionId));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM ie_import_jobs ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM ie_import_jobs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicImportJob), total, page: currentPage, page_size: limit };
}

export function listImportRecordResults(db, { tenantId, jobId, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?", "job_id = ?"];
  const params = [Number(tenantId), Number(jobId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM ie_import_record_results ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM ie_import_record_results ${where} ORDER BY record_number LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicImportRecordResult), total, page: currentPage, page_size: limit };
}

export function listImportErrors(db, { tenantId, jobId, retryable, resolved, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (jobId != null) {
    clauses.push("job_id = ?");
    params.push(Number(jobId));
  }
  if (retryable !== undefined) {
    clauses.push("retryable = ?");
    params.push(retryable ? 1 : 0);
  }
  if (resolved !== undefined) {
    clauses.push("resolved = ?");
    params.push(resolved ? 1 : 0);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM ie_import_errors ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM ie_import_errors ${where} ORDER BY job_id DESC, record_number LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicImportError), total, page: currentPage, page_size: limit };
}

export function getImportJob(db, tenantId, ref) {
  const row = getImportJobRow(db, tenantId, ref);
  return row ? publicImportJob(row) : null;
}

export function cancelImportJob(db, tenantId, ref, actor = null, ip = null) {
  const row = getImportJobRow(db, tenantId, ref);
  if (!row) throw jobConflict(`Import job not found: ${ref}`);
  if (!["QUEUED", "RUNNING", "PAUSED", "PREVIEW", "VALIDATING"].includes(row.status)) {
    throw jobConflict(`Import job is not cancellable in status ${row.status}`);
  }
  updateJob(db, row.id, { status: "CANCELLED", completed_at: nowIso() });
  writeAudit(db, { actor, action: "data_exchange.import_job.cancel", resourceType: "ie_import_jobs", resourceId: row.job_ref, details: {}, ip });
  publishExchangeEvent(db, { eventType: "ImportCancelled", tenantId: Number(tenantId), objectId: row.job_ref, payload: { job_ref: row.job_ref } }, actor);
  return publicImportJob(queryOne(db, "SELECT * FROM ie_import_jobs WHERE id = ?", [row.id]));
}

export { getImportDefinitionRow, recordFailed };

// Migration execution engine.
//
// This is the orchestration core: it resolves the source adapter, extracts
// records, maps them, transforms them, validates them, resolves duplicates and
// dependencies, enforces security and lifecycle policy, writes through the
// object & relationship framework, records identifiers, migrates relationships
// and files — batch by batch, with migration checkpoints, per-object results,
// a structured error queue, retry and reconciliation.
//
// It never stores a copy of the business data: records flow straight through to
// the owning module. Every step is data-driven from the migration definition or
// package (spec §14–§23).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { createObject, updateObject } from "../objects.js";
import { CONFIG_DEFAULTS, SOURCE_MODULE } from "./constants.js";
import { jobRef as makeJobRef } from "./refs.js";
import { publicJob, publicObjectResult, publicErrorEntry } from "./repository.js";
import { requireSourceAdapter } from "./source-adapters/registry.js";
import { jobConflict, jobNotFound, jobNotCancellable, jobNotPausable, invalidDefinition, recordFailed, invalidMode } from "./errors.js";
import {
  normalizeText,
  normalizeUpper,
  parseObject,
  parseArray,
  parseJson,
  paginate,
  assertExecutionMode,
  assertDuplicateStrategy,
  assertErrorStrategy,
  assertReconciliationStrategy,
  assertDependencyStrategy,
  assertBatchSize,
} from "./validation.js";
import { Engines } from "../data-exchange/engines/index.js";
import { createLookupResolver } from "../data-exchange/engines/lookup.js";
import { authorizeRecord, enforceRecordFields } from "../data-exchange/security.js";
import * as Lifecycle from "../data-exchange/lifecycle.js";
import * as Quality from "../data-exchange/quality.js";
import { listConfig } from "./configuration.js";
import { publishMigrationEvent } from "./events.js";
import { recordMigrationAudit } from "./audit.js";
import { getPackageRow } from "./packages.js";
import { getDefinitionRow, withDefinitionChildren } from "./definitions.js";
import { resolveDependencies } from "./dependencies.js";
import { mapIdentifier } from "./identifier-mapping.js";
import { bulkMigrateRelationships } from "./relationships.js";
import { migrateRecordFiles } from "./files.js";
import { reconcileJob } from "./reconciliation.js";
import { recordJobStatistics } from "./statistics.js";
import { setPackageStatistics } from "./packages.js";
import { markDependentsSatisfied } from "./dependencies.js";

const BUILTIN_FIELDS = new Set(["code", "name", "description", "external_ref", "external_system", "status", "owner_id", "organization_id", "tags"]);

function configFor(db, tenantId) {
  return listConfig(db, tenantId);
}

// ── Job ledger ───────────────────────────────────────────────────────────────

export function getJobRow(db, tenantId, ref) {
  return queryOne(
    db,
    "SELECT * FROM mig_jobs WHERE tenant_id = ? AND (job_ref = ? OR CAST(id AS TEXT) = ?)",
    [Number(tenantId), String(ref), String(ref)]
  );
}

// Resolves the effective execution contract for a package or a definition. A
// package always wins because it is the unit of work; a definition supplies the
// reusable mapping/validation policy.
export function resolveExecutionContract(db, tenantId, { packageRow = null, definitionRow = null } = {}) {
  const definition = definitionRow ? withDefinitionChildren(db, definitionRow) : null;
  const mappingJson = parseJson(packageRow?.mapping_json, null);
  const packageMappings = Array.isArray(mappingJson) ? mappingJson : mappingJson && typeof mappingJson === "object" ? mappingJson.mappings : null;
  const mappings = Array.isArray(packageMappings) ? packageMappings : [];
  const definitionMappings = definition?.mappings || [];
  const transformations = packageRow ? parseArray(packageRow.transformation_json, []) : definition?.transformations || [];
  const validationRules = packageRow ? parseArray(packageRow.validation_json, []) : definition?.validation_rules || [];
  const duplicateStrategy = assertDuplicateStrategy(packageRow?.duplicate_strategy || definition?.duplicate_strategy || "REJECT");
  return {
    package_id: packageRow?.id ?? null,
    definition_id: definition?.id ?? null,
    target_object_type: packageRow?.target_object_type || definition?.target_object_type || "",
    source_object_type: packageRow?.source_object_type || definition?.source_object_type || "",
    organization_id: packageRow?.organization_id ?? definition?.organization_id ?? null,
    mappings: mappings.length ? mappings : definitionMappings,
    transformations,
    validation_rules: validationRules,
    duplicate_strategy: duplicateStrategy,
    duplicate_key: definition?.duplicate_key || {},
    batch_size: Number(packageRow ? undefined : definition?.batch_size) || undefined,
    error_strategy: assertErrorStrategy(definition?.error_policy || "CONTINUE"),
    dependency_strategy: assertDependencyStrategy(definition?.dependency_strategy || "STRICT"),
    reconciliation_policy: assertReconciliationStrategy(definition?.reconciliation_policy || "COUNT"),
    source: parseObject(packageRow?.source_json ?? definition?.source, {}),
    scope: parseObject(packageRow?.scope_json, {}),
  };
}

export function createMigrationJob(db, { tenantId, project = null, package: packageRow = null, definition: definitionRow = null, mode, params = {}, actor = null, ip = null, idempotencyKey = "" }) {
  const tenant = Number(tenantId);
  if (idempotencyKey) {
    const existing = queryOne(db, "SELECT * FROM mig_jobs WHERE tenant_id = ? AND idempotency_key = ?", [tenant, idempotencyKey]);
    if (existing) return { job: existing, existing: true };
  }
  const contract = resolveExecutionContract(db, tenant, { packageRow, definitionRow });
  const source = contract.source || {};
  const adapterType = normalizeUpper(source.adapter_type ?? source.adapterType ?? source.type ?? "DATABASE");
  const config = configFor(db, tenant);
  const ts = nowIso();
  const jobReference = makeJobRef(packageRow?.code || definitionRow?.code || "RUN");
  const result = run(
    db,
    `INSERT INTO mig_jobs (job_ref, tenant_id, organization_id, project_id, package_id, definition_id, definition_version, source_adapter, mode, status, batch_size,
       worker_count, total_records, params_json, source_json, idempotency_key, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, 1, 0, ?, ?, ?, ?, ?, ?)`,
    [
      jobReference,
      tenant,
      contract.organization_id ?? null,
      project?.id ?? packageRow?.project_id ?? null,
      packageRow?.id ?? null,
      contract.definition_id,
      definitionRow?.version ?? 1,
      adapterType,
      assertExecutionMode(mode || source.mode || config.default_mode || "EXECUTE"),
      assertBatchSize(params.batch_size ?? params.batchSize ?? contract.batch_size ?? config.default_batch_size ?? CONFIG_DEFAULTS.default_batch_size, { max: config.max_batch_size || 10000, fallback: CONFIG_DEFAULTS.default_batch_size }),
      JSON.stringify(parseObject(params.options, {})),
      JSON.stringify(source),
      normalizeText(idempotencyKey, { max: 200 }),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const job = queryOne(db, "SELECT * FROM mig_jobs WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, { actor, action: "migration.job.create", resourceType: "mig_jobs", resourceId: jobReference, details: { package: packageRow?.code || null, mode: job.mode, adapter: adapterType }, ip });
  return { job, existing: false };
}

function resetJobExecution(db, jobId) {
  const id = Number(jobId);
  run(db, "DELETE FROM mig_object_results WHERE job_id = ?", [id]);
  run(db, "DELETE FROM mig_batches WHERE job_id = ?", [id]);
  run(db, "DELETE FROM mig_checkpoints WHERE job_id = ?", [id]);
  run(db, "DELETE FROM mig_errors WHERE job_id = ?", [id]);
}

function updateJob(db, jobId, patch) {
  const columns = Object.keys(patch).filter((key) => patch[key] !== undefined);
  if (!columns.length) return;
  const assignments = columns.map((column) => `${column} = ?`).join(", ");
  run(db, `UPDATE mig_jobs SET ${assignments}, updated_at = ? WHERE id = ?`, [...columns.map((column) => patch[column]), nowIso(), Number(jobId)]);
}

// ── Source resolution ────────────────────────────────────────────────────────

export async function extractRecords(db, tenantId, { packageRow, definitionRow, contract, params = {} } = {}) {
  const source = { ...(contract.source || {}), ...parseObject(params.source, {}) };
  const adapterType = normalizeUpper(source.adapter_type ?? source.adapterType ?? source.type ?? "DATABASE");
  const adapter = requireSourceAdapter(adapterType);
  const settings = { ...parseObject(source.settings, {}), ...source };
  delete settings.settings;
  const result = await adapter.extract({
    db,
    tenantId: Number(tenantId),
    adapterType,
    settings,
    package: packageRow || null,
    definition: definitionRow || null,
    limit: params.limit,
    cursor: params.cursor || null,
    pageSize: params.page_size || params.pageSize || listConfig(db, tenantId).adapter_page_size,
  });
  const records = Array.isArray(result?.records) ? result.records : [];
  const fields = Array.isArray(result?.fields) ? result.fields : [];
  return { adapter: adapterType, fields, records, source };
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

function recordError(db, entry) {
  const result = run(
    db,
    `INSERT INTO mig_errors (job_id, batch_id, tenant_id, package_id, record_number, source_object_type, source_object_id, target_object_id, field,
       error_code, error_type, category, message, retryable, attempt_count, status, details_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, ?, ?)`,
    [
      Number(entry.jobId),
      entry.batchId != null ? Number(entry.batchId) : null,
      Number(entry.tenantId),
      entry.packageId != null ? Number(entry.packageId) : null,
      Number(entry.recordNumber || 0),
      normalizeText(entry.sourceObjectType, { max: 120 }),
      normalizeText(entry.sourceObjectId, { max: 300 }),
      normalizeText(entry.targetObjectId, { max: 300 }),
      normalizeText(entry.field, { max: 200 }),
      normalizeText(entry.errorCode, { max: 120 }),
      normalizeUpper(entry.errorType || "RECORD"),
      normalizeUpper(entry.category || "SYSTEM_ERROR"),
      normalizeText(entry.message, { max: 1000 }),
      entry.retryable ? 1 : 0,
      JSON.stringify(entry.details || {}),
      nowIso(),
      nowIso(),
    ]
  );
  return Number(result.lastInsertRowid);
}

function saveResult(db, entry) {
  const result = run(
    db,
    `INSERT INTO mig_object_results (job_id, batch_id, tenant_id, record_number, source_object_type, source_object_id, target_object_type, target_object_id,
       business_key, action, status, mapped_json, transformed_json, validation_json, message, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(entry.jobId),
      entry.batchId != null ? Number(entry.batchId) : null,
      Number(entry.tenantId),
      Number(entry.recordNumber || 0),
      normalizeText(entry.sourceObjectType, { max: 120 }),
      normalizeText(entry.sourceObjectId, { max: 300 }),
      normalizeText(entry.targetObjectType, { max: 120 }),
      normalizeText(entry.targetObjectId, { max: 300 }),
      normalizeText(entry.businessKey, { max: 300 }),
      normalizeUpper(entry.action || "CREATE"),
      normalizeUpper(entry.status || "SUCCESS"),
      JSON.stringify(entry.mapped || {}),
      JSON.stringify(entry.transformed || {}),
      JSON.stringify(entry.validation || {}),
      normalizeText(entry.message, { max: 1000 }),
      Number(entry.durationMs || 0),
      nowIso(),
    ]
  );
  return Number(result.lastInsertRowid);
}

function sourceIdentity(record, source) {
  const sourceIdField = normalizeText(source.source_id_field ?? source.sourceIdField, { max: 120 });
  const id = sourceIdField ? record?.[sourceIdField] : record?.source_id ?? record?.sourceId ?? record?.id ?? record?.code;
  return id === null || id === undefined ? "" : String(id);
}

// Processes one source record. Never throws for expected per-record failures.
export function processRecord(db, context) {
  const {
    tenantId,
    contract,
    job,
    schema,
    record,
    recordNumber,
    batchId,
    actor,
    ip,
    config,
    lookupResolver,
    source,
    writeEnabled,
    lifecycleOverride = false,
    dryRun = false,
  } = context;
  const started = Date.now();
  const out = {
    action: "CREATE",
    status: "SUCCESS",
    mapped: {},
    transformed: {},
    validation: {},
    targetObjectId: null,
    businessKey: "",
    sourceId: "",
    message: "",
    sourceObjectType: contract.source_object_type,
  };
  const mappings = contract.mappings || [];
  out.sourceId = sourceIdentity(record, source);
  out.businessKey = out.sourceId;

  const { target: mapped, errors: mappingErrors } = Engines.applyMappings(mappings, record, { lookupResolver });
  out.mapped = mapped;
  if (mappingErrors.length) {
    return {
      ...out,
      action: "FAIL",
      status: "FAILED",
      message: mappingErrors[0].message,
      error: { code: "MAPPING_ERROR", category: "MAPPING_ERROR", message: mappingErrors[0].message, field: mappingErrors[0].field, retryable: false, details: { errors: mappingErrors } },
      durationMs: Date.now() - started,
    };
  }

  const transformed = Engines.applyDefinitionTransformations(contract.transformations || [], mapped, { lookup: lookupResolver });
  out.transformed = transformed;

  const ruleResult = Engines.evaluateRules(contract.validation_rules || [], transformed, { lookupResolver });
  out.validation = { errors: ruleResult.errors, warnings: ruleResult.warnings };
  const errors = [...(ruleResult.errors || [])];
  if (schema?.fields?.length) {
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
      error: { code: "VALIDATION_ERROR", category: "VALIDATION_ERROR", message: errors[0].message || "Validation failed", field: errors[0].field || "", retryable: false, details: { errors } },
      durationMs: Date.now() - started,
    };
  }

  const duplicateKeyConfig = contract.duplicate_key || {};
  let key = out.sourceId;
  try {
    key = Engines.computeDuplicateKey(transformed, duplicateKeyConfig) || out.sourceId;
  } catch {
    key = transformed.code ?? transformed.external_ref ?? out.sourceId;
  }
  out.businessKey = key;
  const existing = findExistingObject(db, tenantId, contract.target_object_type, key, duplicateKeyConfig);
  const decision = Engines.decideDuplicate(contract.duplicate_strategy, { existing });
  out.action = decision.action;

  if (decision.action === "REJECT") {
    return {
      ...out,
      status: "FAILED",
      message: `Duplicate record rejected: ${key}`,
      error: { code: "DUPLICATE_ERROR", category: "DUPLICATE_ERROR", message: `Duplicate record rejected: ${key}`, retryable: false, details: { key } },
      durationMs: Date.now() - started,
    };
  }
  if (decision.action === "SKIP") {
    return { ...out, status: "SKIPPED", action: "SKIP", targetObjectId: existing?.id ?? null, message: "Existing record skipped", durationMs: Date.now() - started };
  }
  if (dryRun || !writeEnabled) {
    return {
      ...out,
      status: "SUCCESS",
      action: decision.action === "SKIP" ? "VALIDATE" : decision.action,
      targetObjectId: existing?.id ?? null,
      message: "Validated (no write performed)",
      durationMs: Date.now() - started,
    };
  }

  const organizationId = transformed.organization_id ?? contract.organization_id ?? null;
  const securityAction = decision.action === "UPDATE" || decision.action === "MERGE" ? "update" : "create";
  try {
    authorizeRecord(db, actor, {
      objectType: contract.target_object_type,
      objectId: existing?.id ?? null,
      action: securityAction,
      tenantId,
      organizationId,
      classification: transformed.classification || "",
      ip,
    });
  } catch (error) {
    return {
      ...out,
      action: "REJECT",
      status: "FAILED",
      message: error.message,
      error: { code: "SECURITY_ERROR", category: "SECURITY_ERROR", message: error.message, retryable: false, details: error.details || {} },
      durationMs: Date.now() - started,
    };
  }

  const body = buildObjectBody(contract.target_object_type, transformed, organizationId);
  if ((decision.action === "UPDATE" || decision.action === "MERGE") && existing) {
    try {
      Lifecycle.assertImportStateAllowed(db, tenantId, { objectType: contract.target_object_type, objectId: existing.id, permit: lifecycleOverride });
    } catch (error) {
      return {
        ...out,
        action: "REJECT",
        status: "FAILED",
        message: error.message,
        error: { code: "LIFECYCLE_BLOCKED", category: "TARGET_ERROR", message: error.message, retryable: false, details: error.details || {} },
        durationMs: Date.now() - started,
      };
    }
  }

  try {
    if ((decision.action === "UPDATE" || decision.action === "MERGE") && existing) {
      const patch = decision.action === "MERGE" ? { ...body, data: Engines.mergeRecords(parseObject(existing.data_json, {}), body.data) } : body;
      const updated = updateObject(db, existing.id, patch, actor, tenantId, ip);
      out.targetObjectId = updated.id;
      return { ...out, action: "UPDATE", status: "SUCCESS", message: "Record updated", durationMs: Date.now() - started };
    }
    const created = createObject(db, body, actor, tenantId, ip);
    out.targetObjectId = created.id;
    return { ...out, action: "CREATE", status: "SUCCESS", message: "Record created", durationMs: Date.now() - started };
  } catch (error) {
    return {
      ...out,
      action: "FAIL",
      status: "FAILED",
      message: error.message,
      error: { code: error.code || "TARGET_ERROR", category: "TARGET_ERROR", message: error.message, field: error.details?.field || "", retryable: Number(error.status) >= 500, details: error.details || {} },
      durationMs: Date.now() - started,
    };
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

export async function runMigrationJob(db, { jobId, params = {}, actor = null, ip = null } = {}) {
  const job = queryOne(db, "SELECT * FROM mig_jobs WHERE id = ?", [Number(jobId)]);
  if (!job) throw jobNotFound(jobId);
  const tenantId = Number(job.tenant_id);
  const config = configFor(db, tenantId);
  const packageRow = job.package_id ? queryOne(db, "SELECT * FROM mig_packages WHERE id = ?", [job.package_id]) : null;
  const definitionRow = job.definition_id ? queryOne(db, "SELECT * FROM mig_definitions WHERE id = ?", [job.definition_id]) : null;
  const contract = resolveExecutionContract(db, tenantId, { packageRow, definitionRow });
  if (!contract.target_object_type) throw invalidDefinition("The migration package/definition has no target object type");

  // Dependency gate (spec §12). Dry runs are allowed so readiness can be checked.
  const dependencyStrategy = contract.dependency_strategy || "STRICT";
  const mode = assertExecutionMode(job.mode);
  if (packageRow && mode !== "VALIDATE" && !params.skip_dependencies) {
    try {
      const resolution = resolveDependencies(db, tenantId, packageRow.id);
      if (!resolution.satisfied && dependencyStrategy === "STRICT") {
        updateJob(db, job.id, { status: "FAILED", error_message: "Required migration dependencies are not satisfied", completed_at: nowIso() });
        for (const dependency of resolution.blocking) {
          recordError(db, {
            tenantId,
            jobId: job.id,
            packageId: packageRow.id,
            errorCode: "DEPENDENCY",
            errorType: "DEPENDENCY",
            category: "DEPENDENCY_ERROR",
            message: `Dependency not satisfied: ${dependency.target_code || dependency.target_ref || dependency.depends_on_package_id}`,
            retryable: true,
            details: dependency,
          });
        }
        publishMigrationEvent(db, { eventType: "MigrationFailed", tenantId, objectId: job.job_ref, payload: { error: "dependency_unsatisfied", package: packageRow.code } }, actor);
        return publicJob(queryOne(db, "SELECT * FROM mig_jobs WHERE id = ?", [job.id]));
      }
    } catch (error) {
      if (error.code && String(error.code).includes("DEPENDENCY")) throw error;
    }
  }

  resetJobExecution(db, job.id);
  const startedAt = nowIso();
  updateJob(db, job.id, { status: mode === "VALIDATE" ? "VALIDATING" : "RUNNING", started_at: job.started_at || startedAt });
  publishMigrationEvent(db, { eventType: "MigrationStarted", tenantId, objectId: job.job_ref, payload: { job_ref: job.job_ref, mode, package: packageRow?.code || null } }, actor);

  let records = [];
  let fields = [];
  let source = contract.source;
  try {
    const extracted = await extractRecords(db, tenantId, { packageRow, definitionRow, contract, params });
    records = extracted.records;
    fields = extracted.fields;
    source = extracted.source;
  } catch (error) {
    updateJob(db, job.id, { status: "FAILED", error_message: normalizeText(error.message, { max: 1000 }), completed_at: nowIso() });
    recordError(db, { tenantId, jobId: job.id, packageId: packageRow?.id ?? null, errorCode: "SOURCE_ERROR", errorType: "CONNECTOR", category: "SOURCE_ERROR", message: error.message, retryable: true, details: error.details || {} });
    publishMigrationEvent(db, { eventType: "MigrationFailed", tenantId, objectId: job.job_ref, payload: { error: error.message } }, actor);
    recordMigrationAudit(db, { tenantId, jobId: job.id, packageId: packageRow?.id ?? null, action: "EXTRACT_FAILED", status: "FAILED", errorMessage: error.message, actor, details: { adapter: job.source_adapter } });
    return publicJob(queryOne(db, "SELECT * FROM mig_jobs WHERE id = ?", [job.id]));
  }

  if (Array.isArray(params.record_numbers) && params.record_numbers.length) {
    const wanted = new Set(params.record_numbers.map((n) => Number(n)));
    records = records.filter((_record, index) => wanted.has(index + 1));
  }
  const total = Number.isFinite(Number(params.limit)) && params.limit !== undefined && params.limit !== null ? Math.min(Number(params.limit), records.length) : records.length;
  const batchSize = Number(job.batch_size) || config.default_batch_size || CONFIG_DEFAULTS.default_batch_size;
  const schema = schemaFor(db, tenantId, contract.target_object_type);
  const lookupResolver = createLookupResolver({ staticMaps: parseObject(source.lookups, {}), cacheSize: config.lookup_cache_size });
  const dryRun = mode === "DRY_RUN" || mode === "VALIDATE" || Boolean(params.dry_run);
  const writeEnabled = mode === "EXECUTE" && !params.dry_run;
  const lifecycleOverride = Boolean(params.allow_lifecycle_write || params.lifecycle_override);
  const counters = { processed: 0, success: 0, created: 0, updated: 0, skipped: 0, rejected: 0, duplicates: 0, failed: 0, files: 0, relationships: 0 };
  updateJob(db, job.id, { status: mode === "VALIDATE" ? "VALIDATING" : "RUNNING", total_records: total });
  let checkpointSequence = 0;
  let stop = false;
  let batchNumber = 0;

  for (let offset = 0; offset < total && !stop; offset += batchSize) {
    // Cooperative pause/cancel: re-read the ledger between batches.
    const live = queryOne(db, "SELECT status FROM mig_jobs WHERE id = ?", [job.id]);
    if (live && (live.status === "CANCELLED" || live.status === "PAUSED")) {
      stop = true;
      break;
    }
    const slice = records.slice(offset, Math.min(offset + batchSize, total));
    batchNumber = Math.floor(offset / batchSize) + 1;
    const batchStart = Date.now();
    const batchCounters = { success: 0, duplicates: 0, rejected: 0, failed: 0, skipped: 0 };
    const batchRow = run(
      db,
      `INSERT INTO mig_batches (job_id, tenant_id, batch_number, status, records, started_at, created_at) VALUES (?, ?, ?, 'RUNNING', ?, ?, ?)`,
      [job.id, tenantId, batchNumber, slice.length, nowIso(), nowIso()]
    );
    const batchId = Number(batchRow.lastInsertRowid);
    for (let i = 0; i < slice.length; i += 1) {
      const recordNumber = offset + i + 1;
      const result = processRecord(db, {
        tenantId,
        contract,
        job,
        schema,
        record: slice[i],
        recordNumber,
        batchId,
        actor,
        ip,
        config,
        lookupResolver,
        source,
        writeEnabled,
        lifecycleOverride,
        dryRun,
      });
      counters.processed += 1;
      const ledgerStatus = result.status === "SUCCESS" ? "SUCCESS" : result.status === "SKIPPED" ? "SKIPPED" : result.status === "ERROR" ? "ERROR" : "FAILED";
      saveResult(db, {
        tenantId,
        jobId: job.id,
        batchId,
        recordNumber,
        sourceObjectType: contract.source_object_type,
        sourceObjectId: result.sourceId,
        targetObjectType: contract.target_object_type,
        targetObjectId: result.targetObjectId,
        businessKey: result.businessKey,
        action: result.action,
        status: ledgerStatus,
        mapped: result.mapped,
        transformed: result.transformed,
        validation: result.validation,
        message: result.message,
        durationMs: result.durationMs,
      });

      if (result.status === "SUCCESS") {
        counters.success += 1;
        batchCounters.success += 1;
        if (!dryRun) {
          if (result.action === "UPDATE") {
            counters.updated += 1;
          } else if (result.action === "CREATE") {
            counters.created += 1;
          }
          // Identifier mapping + migration audit for the written object.
          if (result.targetObjectId != null) {
            if (config.identifier_mapping_enabled !== false && result.sourceId) {
              try {
                mapIdentifier(db, tenantId, {
                  project_id: job.project_id,
                  package_id: job.package_id,
                  source_system: source.source_system || job.source_adapter,
                  source_object_type: contract.source_object_type,
                  source_object_id: result.sourceId,
                  target_object_type: contract.target_object_type,
                  target_object_id: result.targetObjectId,
                  status: "MAPPED",
                }, actor, ip);
              } catch {
                // Identifier mapping is best-effort; a conflict is surfaced by re-runs.
              }
            }
            const files = await migrateRecordFiles(db, tenantId, {
              job,
              packageRow,
              record: slice[i],
              source,
              targetObjectType: contract.target_object_type,
              targetObjectId: result.targetObjectId,
              actor,
              ip,
            });
            counters.files += files.migrated;
          }
        }
      } else if (result.status === "SKIPPED") {
        counters.skipped += 1;
        batchCounters.skipped += 1;
      } else if (result.error?.code === "DUPLICATE_ERROR") {
        counters.duplicates += 1;
        counters.rejected += 1;
        batchCounters.duplicates += 1;
        batchCounters.rejected += 1;
      } else if (result.status === "ERROR") {
        counters.rejected += 1;
        batchCounters.rejected += 1;
      } else {
        counters.failed += 1;
        batchCounters.failed += 1;
      }

      if (result.error) {
        recordError(db, {
          tenantId,
          jobId: job.id,
          batchId,
          packageId: job.package_id,
          recordNumber,
          sourceObjectType: contract.source_object_type,
          sourceObjectId: result.sourceId,
          targetObjectId: result.targetObjectId,
          errorCode: result.error.code || "RECORD",
          errorType: result.error.category === "SOURCE_ERROR" ? "CONNECTOR" : "RECORD",
          category: result.error.category || "SYSTEM_ERROR",
          message: result.error.message,
          field: result.error.field || "",
          retryable: Boolean(result.error.retryable),
          details: result.error.details || {},
        });
      }

      recordMigrationAudit(db, {
        tenantId,
        organizationId: contract.organization_id,
        projectId: job.project_id,
        packageId: job.package_id,
        definitionVersion: job.definition_version,
        jobId: job.id,
        batchId,
        sourceObjectType: contract.source_object_type,
        sourceObjectId: result.sourceId,
        targetObjectType: contract.target_object_type,
        targetObjectId: result.targetObjectId,
        action: result.action,
        status: result.status === "SUCCESS" ? "SUCCESS" : result.status === "ERROR" ? "REJECTED" : result.status,
        errorMessage: result.error?.message || "",
        actor,
        details: { record_number: recordNumber },
      });

      if (contract.error_strategy === "STOP_ON_ERROR" && (result.status === "ERROR" || result.status === "FAILED")) {
        stop = true;
        break;
      }
      if (contract.error_strategy === "ROLLBACK_BATCH" && (result.status === "ERROR" || result.status === "FAILED")) {
        stop = true;
        break;
      }
    }
    run(
      db,
      `UPDATE mig_batches SET status = ?, success = ?, duplicates = ?, rejected = ?, failed = ?, skipped = ?, completed_at = ? WHERE id = ?`,
      [stop ? "PARTIAL" : "COMPLETED", batchCounters.success, batchCounters.duplicates, batchCounters.rejected, batchCounters.failed, batchCounters.skipped, nowIso(), batchId]
    );
    updateJob(db, job.id, {
      processed_records: counters.processed,
      success_count: counters.success,
      failed_count: counters.failed,
      duplicate_count: counters.duplicates,
      rejected_count: counters.rejected,
      skipped_count: counters.skipped,
      updated_count: counters.updated,
    });
    if (counters.processed % (Number(config.checkpoint_interval) || 1000) < batchSize || stop) {
      checkpointSequence += 1;
      run(
        db,
        `INSERT INTO mig_checkpoints (job_id, tenant_id, checkpoint_number, last_record, processed, success, failed, state_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [job.id, tenantId, checkpointSequence, offset + slice.length, counters.processed, counters.success, counters.failed, JSON.stringify({ batch: batchNumber }), nowIso()]
      );
      updateJob(db, job.id, { checkpoint_json: JSON.stringify({ last_record: offset + slice.length, batch: batchNumber, checkpoint: checkpointSequence }) });
      publishMigrationEvent(db, { eventType: "MigrationCheckpointReached", tenantId, objectId: job.job_ref, payload: { checkpoint: checkpointSequence, processed: counters.processed } }, actor);
    }
  }

  // Relationships (spec §19): migrated after the objects they connect.
  if (!dryRun && !stop) {
    const relationships = parseArray(params.relationships, []);
    if (relationships.length) {
      const result = bulkMigrateRelationships(db, tenantId, relationships, actor, ip, { dryRun: false });
      counters.relationships = result.counters.mapped;
      updateJob(db, job.id, { statistics_json: JSON.stringify({ relationships: result.counters }) });
    }
  }

  const sourceCount = total;
  let reconciliation = null;
  try {
    reconciliation = reconcileJob(db, { tenantId, jobId: job.id, strategy: contract.reconciliation_policy || "COUNT", counters, sourceCount });
  } catch (error) {
    reconciliation = { status: "FAILED", message: error.message };
  }

  let quality = null;
  let qualityGateBlocked = false;
  if (writeEnabled && (counters.created || counters.updated)) {
    const objectIds = queryAll(
      db,
      "SELECT DISTINCT target_object_id AS id FROM mig_object_results WHERE job_id = ? AND status = 'SUCCESS' AND target_object_id IS NOT NULL",
      [job.id]
    ).map((row) => row.id);
    quality = Quality.evaluateImportedObjects(db, tenantId, { objectType: contract.target_object_type, objectIds, actor, ip });
    try {
      Quality.assertQualityGate(quality, config);
    } catch (error) {
      qualityGateBlocked = true;
      quality = { ...quality, blocked: true, message: error.message };
    }
  }

  const cancelled = Boolean(queryOne(db, "SELECT id FROM mig_jobs WHERE id = ? AND status = 'CANCELLED'", [job.id]));
  const paused = Boolean(queryOne(db, "SELECT id FROM mig_jobs WHERE id = ? AND status = 'PAUSED'", [job.id]));
  const finalStatus = cancelled
    ? "CANCELLED"
    : paused
      ? "PAUSED"
      : qualityGateBlocked
        ? "FAILED"
        : counters.failed && counters.success
          ? "PARTIALLY_COMPLETED"
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
    duplicates: counters.duplicates,
    failed: counters.failed,
    files: counters.files,
    relationships: counters.relationships,
    dry_run: dryRun,
    reconciliation_status: reconciliation?.status || null,
    duration_ms: Date.now() - Date.parse(job.created_at || nowIso()) || null,
    ...(quality ? { quality } : {}),
  };
  updateJob(db, job.id, {
    status: finalStatus,
    success_count: counters.success,
    failed_count: counters.failed,
    duplicate_count: counters.duplicates,
    rejected_count: counters.rejected,
    skipped_count: counters.skipped,
    updated_count: counters.updated,
    statistics_json: JSON.stringify(summary),
    error_message: qualityGateBlocked ? quality?.message || "Blocked by the data quality gate" : "",
    completed_at: nowIso(),
  });
  const finalJob = queryOne(db, "SELECT * FROM mig_jobs WHERE id = ?", [job.id]);

  recordJobStatistics(db, { tenantId, jobId: job.id, packageId: job.package_id, projectId: job.project_id, snapshot: summary });
  if (packageRow && finalStatus === "COMPLETED") {
    setPackageStatistics(db, tenantId, packageRow.id, summary, "COMPLETED");
    markDependentsSatisfied(db, tenantId, packageRow.id);
    publishMigrationEvent(db, { eventType: "MigrationPackageCompleted", tenantId, objectId: packageRow.package_ref, payload: { package: packageRow.code, ...summary } }, actor);
  } else if (packageRow && finalStatus === "PARTIALLY_COMPLETED") {
    setPackageStatistics(db, tenantId, packageRow.id, summary, "PARTIALLY_COMPLETED");
  } else if (packageRow && finalStatus === "FAILED") {
    setPackageStatistics(db, tenantId, packageRow.id, summary, "FAILED");
  }

  writeAudit(db, { actor, action: "migration.job.complete", resourceType: "mig_jobs", resourceId: job.job_ref, details: summary, ip });
  const eventType =
    finalStatus === "COMPLETED"
      ? "MigrationCompleted"
      : finalStatus === "PARTIALLY_COMPLETED"
        ? "MigrationPartiallyCompleted"
        : finalStatus === "CANCELLED"
          ? "MigrationCancelled"
          : finalStatus === "PAUSED"
            ? "MigrationPaused"
            : "MigrationFailed";
  publishMigrationEvent(db, { eventType, tenantId, objectId: job.job_ref, payload: { job_ref: job.job_ref, ...summary } }, actor);
  return publicJob(finalJob);
}

// ── Preview & validate ───────────────────────────────────────────────────────

export async function previewMigration(db, tenantId, { packageRow, definitionRow }, params = {}, actor = null, ip = null) {
  const config = configFor(db, tenantId);
  const contract = resolveExecutionContract(db, tenantId, { packageRow, definitionRow });
  const limit = Math.min(Number(params.limit) || config.preview_limit || 50, 200);
  const { records, fields } = await extractRecords(db, tenantId, { packageRow, definitionRow, contract, params: { ...params, limit } });
  const schema = schemaFor(db, tenantId, contract.target_object_type);
  const lookupResolver = createLookupResolver({ staticMaps: parseObject(contract.source.lookups, {}), cacheSize: config.lookup_cache_size });
  const rows = [];
  let valid = 0;
  let invalid = 0;
  for (const record of records.slice(0, limit)) {
    const { target: mapped, errors: mappingErrors } = Engines.applyMappings(contract.mappings || [], record, { lookupResolver });
    const transformed = mappingErrors.length ? {} : Engines.applyDefinitionTransformations(contract.transformations || [], mapped, { lookup: lookupResolver });
    const ruleResult = Engines.evaluateRules(contract.validation_rules || [], transformed, { lookupResolver });
    let safe = transformed;
    const denied = [];
    try {
      const enforced = enforceRecordFields(db, actor, { objectType: contract.target_object_type, record: transformed, action: "read", tenantId, organizationId: contract.organization_id, ip });
      safe = enforced.record;
      denied.push(...enforced.denied);
    } catch {
      // Field-level policy is advisory in preview; the write path enforces it.
    }
    const errors = [...mappingErrors.map((error) => ({ ...error, source: "mapping" })), ...ruleResult.errors];
    if (errors.length) invalid += 1;
    else valid += 1;
    rows.push({ record_number: rows.length + 1, source: record, mapped, transformed: safe, errors, warnings: ruleResult.warnings, denied_fields: denied });
  }
  return { package: packageRow?.code || definitionRow?.code || null, target_object_type: contract.target_object_type, source_fields: fields, record_count: records.length, previewed: rows.length, valid, invalid, records: rows };
}

export async function validateMigration(db, tenantId, { packageRow, definitionRow }, params = {}, actor = null, ip = null) {
  const config = configFor(db, tenantId);
  const contract = resolveExecutionContract(db, tenantId, { packageRow, definitionRow });
  const errors = [];
  const warnings = [];
  if (!contract.target_object_type) errors.push({ code: "missing_target_type", message: "No target object type is set" });
  if (!contract.mappings.length) errors.push({ code: "no_mappings", message: "No field mappings are configured" });
  const mappingCheck = Engines.validateMappings(contract.mappings, {});
  errors.push(...mappingCheck.errors);
  warnings.push(...mappingCheck.warnings);
  const knownTransformations = new Set(Engines.transformationTypes());
  for (const transformation of contract.transformations) {
    if (!knownTransformations.has(normalizeUpper(transformation.transformation_type))) errors.push({ code: "unknown_transformation", message: `Unknown transformation: ${transformation.transformation_type}` });
  }
  let sample = { fields: [], record_count: 0, previewed: 0 };
  try {
    const preview = await previewMigration(db, tenantId, { packageRow, definitionRow }, { ...params, limit: Number(params.limit) || config.preview_limit || 20 }, actor, ip);
    sample = { fields: preview.source_fields, record_count: preview.record_count, previewed: preview.previewed, valid: preview.valid, invalid: preview.invalid };
  } catch (error) {
    errors.push({ code: "source_error", message: error.message });
  }
  return { valid: errors.length === 0, errors, warnings, target_object_type: contract.target_object_type, sample, source_module: SOURCE_MODULE };
}

// ── Ledger queries & lifecycle ───────────────────────────────────────────────

export function listMigrationJobs(db, { tenantId, status, projectId, packageId, mode, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (projectId != null) {
    clauses.push("project_id = ?");
    params.push(Number(projectId));
  }
  if (packageId != null) {
    clauses.push("package_id = ?");
    params.push(Number(packageId));
  }
  if (mode) {
    clauses.push("mode = ?");
    params.push(assertExecutionMode(mode));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_jobs ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_jobs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicJob), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function getMigrationJob(db, tenantId, ref) {
  return publicJob(getJobRow(db, tenantId, ref));
}

export function listBatches(db, { tenantId, jobId, page, pageSize } = {}) {
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, "SELECT COUNT(*) AS c FROM mig_batches WHERE tenant_id = ? AND job_id = ?", [Number(tenantId), Number(jobId)])?.c || 0);
  const rows = queryAll(db, "SELECT * FROM mig_batches WHERE tenant_id = ? AND job_id = ? ORDER BY batch_number LIMIT ? OFFSET ?", [Number(tenantId), Number(jobId), limit, offset]);
  return { items: rows.map(publicJobBatch), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

function publicJobBatch(row) {
  return {
    id: row.id,
    job_id: row.job_id,
    tenant_id: row.tenant_id,
    batch_number: row.batch_number,
    status: row.status,
    records: row.records,
    success: row.success,
    failed: row.failed,
    duplicates: row.duplicates,
    rejected: row.rejected,
    skipped: row.skipped,
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
  };
}

export function listObjectResults(db, { tenantId, jobId, status, action, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (jobId != null) {
    clauses.push("job_id = ?");
    params.push(Number(jobId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (action) {
    clauses.push("action = ?");
    params.push(normalizeUpper(action));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_object_results ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_object_results ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicObjectResult), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function listErrors(db, { tenantId, jobId, category, status, retryable, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (jobId != null) {
    clauses.push("job_id = ?");
    params.push(Number(jobId));
  }
  if (category) {
    clauses.push("category = ?");
    params.push(normalizeUpper(category));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (retryable !== undefined && retryable !== null && retryable !== "") {
    clauses.push("retryable = ?");
    params.push(retryable ? 1 : 0);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_errors ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_errors ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicErrorEntry), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function listCheckpoints(db, { tenantId, jobId, page, pageSize } = {}) {
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, "SELECT COUNT(*) AS c FROM mig_checkpoints WHERE tenant_id = ? AND job_id = ?", [Number(tenantId), Number(jobId)])?.c || 0);
  const rows = queryAll(db, "SELECT * FROM mig_checkpoints WHERE tenant_id = ? AND job_id = ? ORDER BY checkpoint_number DESC LIMIT ? OFFSET ?", [Number(tenantId), Number(jobId), limit, offset]);
  return {
    items: rows.map((row) => ({ id: row.id, job_id: row.job_id, checkpoint_number: row.checkpoint_number, last_record: row.last_record, processed: row.processed, success: row.success, failed: row.failed, state: parseObject(row.state_json, {}), created_at: row.created_at })),
    total,
    page: currentPage,
    page_size: limit,
    source_module: SOURCE_MODULE,
  };
}

export function cancelMigrationJob(db, tenantId, ref, actor = null, ip = null) {
  const row = getJobRow(db, tenantId, ref);
  if (!row) throw jobNotFound(ref);
  if (["COMPLETED", "FAILED", "CANCELLED", "PARTIALLY_COMPLETED"].includes(row.status)) {
    throw jobNotCancellable(row.job_ref, row.status);
  }
  updateJob(db, row.id, { status: "CANCELLED", completed_at: nowIso() });
  writeAudit(db, { actor, action: "migration.job.cancel", resourceType: "mig_jobs", resourceId: row.job_ref, details: {}, ip });
  publishMigrationEvent(db, { eventType: "MigrationCancelled", tenantId, objectId: row.job_ref, payload: { job_ref: row.job_ref } }, actor);
  return publicJob(queryOne(db, "SELECT * FROM mig_jobs WHERE id = ?", [row.id]));
}

export function pauseMigrationJob(db, tenantId, ref, actor = null, ip = null) {
  const row = getJobRow(db, tenantId, ref);
  if (!row) throw jobNotFound(ref);
  if (!["QUEUED", "PREPARING", "VALIDATING", "RUNNING", "RETRYING"].includes(row.status)) throw jobNotPausable(row.job_ref, row.status);
  updateJob(db, row.id, { status: "PAUSED" });
  writeAudit(db, { actor, action: "migration.job.pause", resourceType: "mig_jobs", resourceId: row.job_ref, details: {}, ip });
  publishMigrationEvent(db, { eventType: "MigrationPaused", tenantId, objectId: row.job_ref, payload: { job_ref: row.job_ref } }, actor);
  return publicJob(queryOne(db, "SELECT * FROM mig_jobs WHERE id = ?", [row.id]));
}

export function resumeMigrationJob(db, tenantId, ref, actor = null, ip = null) {
  const row = getJobRow(db, tenantId, ref);
  if (!row) throw jobNotFound(ref);
  if (row.status !== "PAUSED") throw jobConflict(`Migration job ${row.job_ref} is ${row.status} and cannot be resumed`, { ref: row.job_ref, status: row.status });
  updateJob(db, row.id, { status: "QUEUED" });
  writeAudit(db, { actor, action: "migration.job.resume", resourceType: "mig_jobs", resourceId: row.job_ref, details: {}, ip });
  publishMigrationEvent(db, { eventType: "MigrationResumed", tenantId, objectId: row.job_ref, payload: { job_ref: row.job_ref } }, actor);
  return publicJob(queryOne(db, "SELECT * FROM mig_jobs WHERE id = ?", [row.id]));
}

// Collects the retryable failed record numbers for a job, then re-runs them on a
// fresh job so the original ledger remains an immutable record of the first run.
export function failedRecordNumbers(db, tenantId, jobId, { retryableOnly = true } = {}) {
  const clauses = ["tenant_id = ?", "job_id = ?", "status IN ('ERROR','FAILED')"];
  const params = [Number(tenantId), Number(jobId)];
  if (retryableOnly) clauses.push("retryable = 1");
  const rows = queryAll(db, `SELECT DISTINCT record_number FROM mig_object_results WHERE ${clauses.join(" AND ")} ORDER BY record_number`, params);
  return rows.map((row) => Number(row.record_number)).filter((n) => n > 0);
}

export async function retryMigrationJob(db, { tenantId, jobId, actor = null, ip = null } = {}) {
  const original = queryOne(db, "SELECT * FROM mig_jobs WHERE id = ? AND tenant_id = ?", [Number(jobId), Number(tenantId)]);
  if (!original) throw jobNotFound(jobId);
  const numbers = failedRecordNumbers(db, tenantId, jobId);
  if (!numbers.length) return { retried: 0, message: "No failed records to retry" };
  const packageRow = original.package_id ? queryOne(db, "SELECT * FROM mig_packages WHERE id = ?", [original.package_id]) : null;
  const definitionRow = original.definition_id ? queryOne(db, "SELECT * FROM mig_definitions WHERE id = ?", [original.definition_id]) : null;
  const project = original.project_id ? queryOne(db, "SELECT * FROM mig_projects WHERE id = ?", [original.project_id]) : null;
  const { job } = createMigrationJob(db, { tenantId, project, package: packageRow, definition: definitionRow, mode: original.mode, params: { options: { retry_of: original.job_ref } }, actor, ip });
  run(db, "UPDATE mig_errors SET attempt_count = attempt_count + 1, status = 'RETRYING', updated_at = ? WHERE job_id = ? AND status = 'OPEN' AND retryable = 1", [nowIso(), Number(jobId)]);
  const result = await runMigrationJob(db, { jobId: job.id, params: { record_numbers: numbers }, actor, ip });
  return { retried: numbers.length, job: result };
}

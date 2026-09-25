// Standards & Exchange processor (§10, §11).
//
// The single orchestration path behind every exchange operation:
//
//   detect -> adapter -> canonical -> map -> transform -> validate -> apply
//
// PREVIEW / DRY_RUN / VALIDATE_ONLY are non-mutating; only EXECUTE and EXPORT
// write enterprise data (through the integration registry, which delegates to
// the owning platform service). Every run is recorded as an exchange
// transaction plus history, error, reconciliation and domain-event rows.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import {
  OPERATIONS,
  MUTATING_OPERATIONS,
  TRANSACTION_STATUSES,
  TERMINAL_TRANSACTION_STATUSES,
  DIRECTIONS,
  MAX_RECORDS,
  ASYNC_RECORD_THRESHOLD,
  DEFAULT_BATCH_SIZE,
  SEVERITIES,
} from "./constants.js";
import { transactionRef as makeTransactionRef } from "./identifiers.js";
import { publicTransaction, publicFormat, parseJson, toJson } from "./repository.js";
import * as objects from "../objects.js";
import { listUnits } from "../bom/units.js";
import {
  invalidTransaction,
  transactionNotFound,
  transactionImmutable,
  unsupportedOperation,
  formatNotFound,
  adapterNotFound,
  idempotencyConflict,
  invalidQuery,
} from "./errors.js";
import { getFormatRow, getFormat } from "./formats.js";
import { resolveDefinition } from "./definitions.js";
import { applyMappingToDocument } from "./mappings.js";
import { applyTransformationProfile } from "./transformations.js";
import { runValidation, resolveValidationProfile } from "./validation.js";
import { detectFormat } from "./detection.js";
import { getAdapter } from "./adapters/index.js";
import { normalizeDocument, createCanonicalObject, emptyDocument, documentStats } from "./canonical.js";
import { getIntegration } from "./integrations.js";
import { publishExchangeEvent, exchangeEventCode } from "./events.js";
import { guardExport } from "./security.js";
import { recordHistory, recordErrors } from "./history.js";
import { recordReconciliation, normalizeCounts } from "./reconciliation.js";
import { listConfig } from "./configuration.js";
import { emptyCounts } from "./processor-runtime.js";

const TERMINAL = new Set(TERMINAL_TRANSACTION_STATUSES);

// ── Option normalization ─────────────────────────────────────────────────────
function normalizeOptions(input = {}) {
  const direction = String(input.direction || "IMPORT").toUpperCase();
  if (!DIRECTIONS.includes(direction)) throw invalidTransaction(`Unsupported direction: ${input.direction}`);
  const rawOperation = String(input.operation || "").toUpperCase();
  const operation = OPERATIONS.includes(rawOperation) ? rawOperation : direction === "EXPORT" ? "EXPORT" : "EXECUTE";
  return {
    definitionCode: input.definition_code || input.definitionCode || null,
    formatCode: input.format_code || input.formatCode || null,
    formatVersion: input.format_version || input.formatVersion || "",
    direction,
    operation,
    payload: input.payload ?? input.content ?? input.source ?? null,
    records: Array.isArray(input.records) ? input.records : null,
    objectIds: input.object_ids || input.objectIds || null,
    q: input.q || input.query_text || null,
    integration: input.integration || input.options?.integration || null,
    objectType: input.object_type || input.objectType || "",
    fileName: input.file_name || input.fileName || "",
    mimeType: input.mime_type || input.mimeType || "",
    organizationId: input.organization_id ?? input.organizationId ?? null,
    site: String(input.site || ""),
    correlationId: input.correlation_id || input.correlationId || "",
    idempotencyKey: input.idempotency_key || input.idempotencyKey || "",
    force: Boolean(input.force),
    dryRun: Boolean(input.dry_run ?? input.dryRun),
    options: input.options && typeof input.options === "object" ? input.options : {},
    levels: Array.isArray(input.levels) ? input.levels : null,
    fileIds: Array.isArray(input.file_ids || input.fileIds) ? input.file_ids || input.fileIds : [],
  };
}

function resolveLimits(db, tenantId) {
  const config = listConfig(db, tenantId);
  return { config, maxPayloadBytes: Number(config.max_payload_bytes) || undefined, batchSize: Number(config.batch_size) || DEFAULT_BATCH_SIZE };
}

function safeResolveDefinition(db, tenantId, opts, direction) {
  try {
    return resolveDefinition(db, tenantId, {
      code: opts.definitionCode,
      formatCode: opts.formatCode,
      direction,
      targetObjectType: opts.objectType || undefined,
    });
  } catch {
    return null;
  }
}

function resolveFormatAdapter(db, tenantId, opts, definition, payload) {
  let formatRow = null;
  const explicit = opts.formatCode || definition?.format_code;
  if (explicit) {
    formatRow = getFormatRow(db, tenantId, explicit);
    if (!formatRow) throw formatNotFound(explicit);
  } else {
    const detected = detectFormat(db, tenantId, { payload, fileName: opts.fileName, mimeType: opts.mimeType });
    if (!detected.detected || !detected.format) {
      throw invalidTransaction("Unable to determine the exchange format; provide format_code or a recognizable payload");
    }
    formatRow = getFormatRow(db, tenantId, detected.format.code);
  }
  const format = publicFormat(formatRow);
  const adapter = getAdapter(formatRow.adapter_code);
  if (!adapter) throw adapterNotFound(formatRow.adapter_code);
  return { format, formatRow, adapter };
}

function selectIntegration(definition, opts) {
  const code = opts.integration || definition?.metadata?.integration || (definition?.format_code === "BOM_EXCHANGE" ? "bom" : "object");
  return getIntegration(code);
}

function enterpriseCheckers(db, tenantId) {
  return {
    typeChecker: (value) => {
      if (!value) return true;
      let known = [];
      try {
        known = objects.objectTypes(db, tenantId) || [];
      } catch {
        known = [];
      }
      if (!known.length) return true;
      return known.some((entry) => String(entry.code || entry).toLowerCase() === String(value).toLowerCase());
    },
    uomChecker: (value) => {
      if (!value) return true;
      try {
        const units = listUnits(db, { tenantId, limit: 5000 }).items || [];
        if (!units.length) return true;
        return units.some((entry) => String(entry.code || entry.uom || entry).toLowerCase() === String(value).toLowerCase());
      } catch {
        return true;
      }
    },
    classificationChecker: () => true,
    relationshipTypeChecker: () => true,
  };
}

// ── Transaction persistence ──────────────────────────────────────────────────
function insertTransaction(db, tenantId, opts, actor) {
  const ts = nowIso();
  const ref = makeTransactionRef();
  const result = run(
    db,
    `INSERT INTO exchange_transactions
       (transaction_ref, tenant_id, organization_id, site, definition_code, definition_version, format_code, format_version,
        direction, operation, status, source_kind, source_name, input_json, idempotency_key, correlation_id, file_ids_json, started_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ref,
      Number(tenantId),
      opts.organizationId ?? null,
      opts.site || "",
      opts.definitionCode || "",
      0,
      opts.formatCode || "",
      opts.formatVersion || "",
      opts.direction,
      opts.operation,
      opts.records ? "RECORDS" : opts.payload !== null && opts.payload !== undefined ? "PAYLOAD" : "QUERY",
      opts.fileName || "",
      JSON.stringify({ options: opts.options, object_type: opts.objectType, q: opts.q, record_count: opts.records ? opts.records.length : null }),
      opts.idempotencyKey || "",
      opts.correlationId || "",
      JSON.stringify(opts.fileIds || []),
      ts,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  return queryOne(db, "SELECT * FROM exchange_transactions WHERE id = ?", [Number(result.lastInsertRowid)]);
}

function updateTransaction(db, id, patch = {}) {
  const columns = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) {
    columns.push(`${key} = ?`);
    values.push(value);
  }
  if (!columns.length) return;
  columns.push("updated_at = ?");
  values.push(nowIso());
  values.push(id);
  run(db, `UPDATE exchange_transactions SET ${columns.join(", ")} WHERE id = ?`, values);
}

function finalizeTransaction(db, tenantId, txnId, { status, counts, validation, reconciliation, output, error, actor }) {
  const ts = nowIso();
  updateTransaction(db, txnId, {
    status,
    counts_json: toJson(counts || {}, {}),
    validation_summary_json: toJson(validation || {}, {}),
    reconciliation_json: toJson(reconciliation || {}, {}),
    output_json: output ? toJson(output, {}) : JSON.stringify({}),
    output_ref: output?.output_ref || "",
    error_json: toJson(error || {}, {}),
    finished_at: ts,
  });
  return publicTransaction(queryOne(db, "SELECT * FROM exchange_transactions WHERE id = ?", [txnId]));
}

function failTransaction(db, tenantId, txn, error, actor) {
  const row = typeof txn === "object" ? txn : queryOne(db, "SELECT * FROM exchange_transactions WHERE id = ?", [txn]);
  recordErrors(db, tenantId, row?.transaction_ref || "", [
    {
      severity: "ERROR",
      code: error.code || "exchange_error",
      message: error.message || "Exchange failed",
      details: error.details || {},
    },
  ], { definitionCode: row?.definition_code || "" });
  publishExchangeEvent(db, {
    eventType: exchangeEventCode("FAILED"),
    payload: { transaction_ref: row?.transaction_ref, operation: row?.operation, direction: row?.direction, error: error.message, code: error.code || null },
    objectType: "exchange_transaction",
    objectId: row?.id,
    tenantId,
    organizationId: row?.organization_id ?? null,
    correlationId: row?.correlation_id || null,
  }, actor);
  const finished = finalizeTransaction(db, tenantId, row.id, {
    status: "FAILED",
    counts: {},
    validation: {},
    reconciliation: {},
    output: null,
    error: { code: error.code || "exchange_error", message: error.message, details: error.details || null },
    actor,
  });
  recordHistory(db, {
    tenantId,
    transactionRef: row.transaction_ref,
    definitionCode: row.definition_code,
    formatCode: row.format_code,
    direction: row.direction,
    action: row.operation,
    status: "FAILED",
    summary: error.message || "Exchange failed",
    correlationId: row.correlation_id,
    actor,
    details: { error: error.code || null },
  });
  return finished;
}

// ── Main entry point ─────────────────────────────────────────────────────────
export function execute(db, tenantId, input = {}, actor = null, { ip = null } = {}) {
  const opts = normalizeOptions(input);
  const tenant = Number(tenantId);

  if (opts.idempotencyKey) {
    const existing = queryOne(db, "SELECT * FROM exchange_transactions WHERE tenant_id = ? AND idempotency_key = ? ORDER BY id DESC LIMIT 1", [tenant, opts.idempotencyKey]);
    if (existing && !TERMINAL.has(existing.status)) {
      return { ...publicTransaction(existing), idempotent_replay: true };
    }
    if (existing) return { ...publicTransaction(existing), idempotent_replay: true };
  }

  const task = () => {
    const txn = insertTransaction(db, tenant, opts, actor);
    updateTransaction(db, txn.id, { status: "RUNNING" });
    publishExchangeEvent(db, {
      eventType: exchangeEventCode("STARTED"),
      payload: { transaction_ref: txn.transaction_ref, operation: opts.operation, direction: opts.direction, definition_code: opts.definitionCode, format_code: opts.formatCode },
      objectType: "exchange_transaction",
      objectId: txn.id,
      tenantId: tenant,
      organizationId: opts.organizationId,
      correlationId: opts.correlationId || null,
    }, actor);
    try {
      return opts.direction === "EXPORT" ? runExport(db, tenant, txn, opts, actor, ip) : runImport(db, tenant, txn, opts, actor, ip);
    } catch (error) {
      return failTransaction(db, tenant, queryOne(db, "SELECT * FROM exchange_transactions WHERE id = ?", [txn.id]), error, actor);
    }
  };

  void task;
  return task();
}

// ── Import / preview / validate pipeline ─────────────────────────────────────
function runImport(db, tenant, txn, opts, actor, ip) {
  const { config, maxPayloadBytes } = resolveLimits(db, tenant);
  const definition = safeResolveDefinition(db, tenant, opts, "IMPORT");
  const { format, adapter } = resolveFormatAdapter(db, tenant, opts, definition, opts.payload);
  const formatVersion = opts.formatVersion || definition?.format_version || format.standard_version || "";

  const parsed = adapter.import(opts.payload, {
    objectType: opts.objectType || definition?.target_object_type || definition?.source_object_type || "part",
    meta: { file_name: opts.fileName, mime_type: opts.mimeType, format: format.code, format_version: formatVersion, adapter: adapter.code },
    limit: maxPayloadBytes,
    schema: format.schema || null,
  });
  const normalized = normalizeDocument(parsed.document || emptyDocument(), {
    file_name: opts.fileName,
    mime_type: opts.mimeType,
    format: format.code,
    format_version: formatVersion,
    adapter: adapter.code,
    detected: Boolean(definition),
  });
  const document = normalized.document;
  if (document.objects.length > MAX_RECORDS) throw invalidTransaction(`Payload exceeds the ${MAX_RECORDS} record limit`);

  const parseFindings = [...(parsed.errors || []), ...(normalized.errors || [])].map((entry) => ({
    level: entry.level || "FILE",
    severity: entry.severity || "ERROR",
    code: entry.code || "parse_error",
    message: entry.message || "Parse error",
    source_path: entry.source_path || entry.sourcePath || "",
  }));
  if (parseFindings.length) {
    recordErrors(db, tenant, txn.transaction_ref, parseFindings, { definitionCode: definition?.code });
  }

  const profile = definition?.validation_profile_code ? resolveValidationProfile(db, tenant, definition.validation_profile_code) : null;
  const validation = runValidation(db, tenant, {
    definition,
    profile,
    format,
    adapter,
    payload: opts.payload,
    fileName: opts.fileName,
    mimeType: opts.mimeType,
    records: document.objects,
    levels: opts.levels,
    maxBytes: maxPayloadBytes,
    context: { ...enterpriseCheckers(db, tenant), max_payload_bytes: maxPayloadBytes, config },
  });
  if (validation.findings?.length) {
    recordErrors(db, tenant, txn.transaction_ref, validation.findings, { definitionCode: definition?.code });
  }

  const stats = documentStats(document);
  const counts = emptyCounts();
  counts.records_read = stats.objects;
  counts.records_validated = stats.objects;
  counts.warnings = validation.warnings;
  counts.errors = validation.errors;
  counts.files_processed = opts.fileIds?.length || (opts.payload ? 1 : 0);

  const base = {
    definition_code: definition?.code || "",
    definition_version: definition?.version || 0,
    format_code: format.code,
    format_version: formatVersion,
  };
  updateTransaction(db, txn.id, { ...base, status: "VALIDATING" });

  if (opts.operation === "VALIDATE_ONLY") {
    const status = validation.errors > 0 ? "FAILED" : "COMPLETED";
    const finished = finalizeTransaction(db, tenant, txn.id, {
      status,
      counts,
      validation: { ...validation, document: stats },
      reconciliation: null,
      output: { valid: validation.errors === 0, document: stats, findings: validation.findings },
      error: null,
      actor,
    });
    afterImport(db, tenant, finished, opts, actor, { validation });
    return finished;
  }

  const mappingResult = applyMappingToDocument(db, tenant, definition?.mapping_code || null, document, { options: { ...config, ...opts.options }, definition });
  const previewRecords = [];
  const integration = selectIntegration(definition, opts);
  const ctx = {
    db,
    tenantId: tenant,
    actor,
    ip,
    definition,
    format,
    options: { ...config, ...opts.options },
    duplicateStrategy: String(opts.options.duplicate_strategy || config.duplicate_strategy || "REJECT").toUpperCase(),
    resolved: new Map(),
  };

  for (const record of mappingResult.records) {
    const transformed = applyTransformationProfile(db, tenant, definition?.transformation_code || null, record, { context: { definition, format } });
    const merged = { ...record, ...(transformed.target || {}) };
    let preview;
    try {
      preview = integration.preview(merged, ctx);
    } catch (error) {
      preview = { action: "ERROR", message: error.message };
    }
    if (definition?.target_object_type && !merged.object_type) merged.object_type = definition.target_object_type;
    previewRecords.push({ external_id: merged.external_id || merged.code || "", object_type: merged.object_type || "", preview });
    if (transformed.errors?.length) {
      recordErrors(db, tenant, txn.transaction_ref, transformed.errors.map((entry) => ({ severity: "ERROR", ...entry })), { definitionCode: definition?.code });
    }
  }

  const isMutating = MUTATING_OPERATIONS.includes(opts.operation) && !opts.dryRun;

  if (!isMutating) {
    const status = opts.operation === "PREVIEW" ? "PREVIEW" : "COMPLETED";
    const finished = finalizeTransaction(db, tenant, txn.id, {
      status,
      counts,
      validation: { ...validation, document: stats },
      reconciliation: null,
      output: {
        preview: true,
        dry_run: opts.operation === "DRY_RUN",
        document: stats,
        records: previewRecords,
        validation: { status: validation.status, errors: validation.errors, warnings: validation.warnings },
      },
      error: null,
      actor,
    });
    afterImport(db, tenant, finished, opts, actor, { validation });
    return finished;
  }

  if (validation.errors > 0 && !opts.force && !definition?.metadata?.allow_validation_errors) {
    const status = "FAILED";
    const finished = finalizeTransaction(db, tenant, txn.id, {
      status,
      counts,
      validation: { ...validation, document: stats },
      reconciliation: null,
      output: { preview: false, document: stats, records: previewRecords },
      error: { code: "VALIDATION_FAILED", message: `${validation.errors} validation error(s) block execution` },
      actor,
    });
    afterImport(db, tenant, finished, opts, actor, { validation });
    return finished;
  }

  // Apply enterprise writes.
  const applied = [];
  let aborted = false;
  for (const record of mappingResult.records) {
    const transformed = applyTransformationProfile(db, tenant, definition?.transformation_code || null, record, { context: { definition, format } });
    const merged = { ...record, ...(transformed.target || {}) };
    if (definition?.target_object_type && !merged.object_type) merged.object_type = definition.target_object_type;
    try {
      const result = integration.apply(merged, ctx);
      if (result.action === "CREATED") counts.records_created += 1;
      else if (result.action === "UPDATED") counts.records_updated += 1;
      else if (result.action === "SKIPPED") counts.records_skipped += 1;
      else counts.records_updated += 1;
      applied.push({ external_id: merged.external_id || merged.code || "", ...result });
      if (result.reject && String(config.error_strategy).toUpperCase() !== "CONTINUE") {
        aborted = true;
        break;
      }
    } catch (error) {
      counts.records_failed += 1;
      counts.errors += 1;
      recordErrors(db, tenant, txn.transaction_ref, [{ severity: "ERROR", code: error.code || "apply_error", message: error.message, target_object: merged.external_id || merged.code || "" }], { definitionCode: definition?.code });
      applied.push({ external_id: merged.external_id || merged.code || "", action: "FAILED", message: error.message });
      if (String(config.error_strategy).toUpperCase() !== "CONTINUE") {
        aborted = true;
        break;
      }
    }
  }

  if (!aborted) {
    for (const relationship of document.relationships) {
      const source = ctx.resolved.get(relationship.source_ref);
      const target = ctx.resolved.get(relationship.target_ref);
      if (!source || !target) {
        counts.relationships_failed += 1;
        recordErrors(db, tenant, txn.transaction_ref, [{ severity: "WARNING", code: "unresolved_relationship", message: `Unresolved relationship ${relationship.source_ref} -> ${relationship.target_ref}` }], { definitionCode: definition?.code });
        continue;
      }
      try {
        objects.createRelationship(db, {
          source_object_id: source,
          target_object_id: target,
          relationship_type: relationship.relationship_type || "related",
          semantic: relationship.semantic || "related",
          quantity: relationship.quantity,
          uom: relationship.uom,
        }, actor, tenant, ip);
        counts.relationships_created += 1;
      } catch (error) {
        counts.relationships_failed += 1;
        recordErrors(db, tenant, txn.transaction_ref, [{ severity: "WARNING", code: "relationship_failed", message: error.message }], { definitionCode: definition?.code });
      }
    }
  }

  const status = counts.records_failed > 0 ? "PARTIAL" : "COMPLETED";
  const reconciliation = recordReconciliation(db, tenant, {
    transactionRef: txn.transaction_ref,
    counts,
    details: { operation: opts.operation, direction: opts.direction, applied: applied.length },
  });
  const finished = finalizeTransaction(db, tenant, txn.id, {
    status,
    counts,
    validation: { ...validation, document: stats },
    reconciliation: { reconciliation_ref: reconciliation.reconciliation_ref, counts },
    output: { applied, document: stats, preview: false },
    error: null,
    actor,
  });
  afterImport(db, tenant, finished, opts, actor, { validation, reconciliation });
  return finished;
}

function afterImport(db, tenant, finished, opts, actor, { validation }) {
  const success = finished.status === "COMPLETED" || finished.status === "PARTIAL" || finished.status === "PREVIEW";
  publishExchangeEvent(db, {
    eventType: exchangeEventCode(validation?.errors > 0 ? "VALIDATION_FAILED" : success ? "COMPLETED" : "FAILED"),
    payload: {
      transaction_ref: finished.transaction_ref,
      operation: finished.operation,
      direction: finished.direction,
      status: finished.status,
      counts: finished.counts,
      validation_status: validation?.status || null,
    },
    objectType: "exchange_transaction",
    objectId: finished.id,
    tenantId: tenant,
    organizationId: finished.organization_id ?? null,
    correlationId: finished.correlation_id || null,
  }, actor);
  recordHistory(db, {
    tenantId: tenant,
    transactionRef: finished.transaction_ref,
    definitionCode: finished.definition_code,
    definitionVersion: finished.definition_version,
    formatCode: finished.format_code,
    direction: finished.direction,
    action: finished.operation,
    status: finished.status,
    counts: finished.counts,
    summary: `${finished.operation} ${finished.direction} ${finished.status} (${finished.counts?.records_created || 0} created, ${finished.counts?.records_failed || 0} failed)`,
    correlationId: finished.correlation_id,
    actor,
    details: { validation: validation?.status || null },
  });
}

// ── Export pipeline ──────────────────────────────────────────────────────────
function runExport(db, tenant, txn, opts, actor, ip) {
  const { config, maxPayloadBytes } = resolveLimits(db, tenant);
  const definition = safeResolveDefinition(db, tenant, opts, "EXPORT");
  const { format, adapter } = resolveFormatAdapter(db, tenant, opts, definition, opts.payload);
  const formatVersion = opts.formatVersion || definition?.format_version || format.standard_version || "";
  const integration = selectIntegration(definition, opts);
  const ctx = {
    db,
    tenantId: tenant,
    actor,
    ip,
    definition,
    format,
    options: { ...config, ...opts.options },
    resolved: new Map(),
  };

  let records = [];
  if (opts.records) {
    records = opts.records;
  } else if (typeof integration.fetch === "function") {
    const fetched = integration.fetch(
      {
        objectType: opts.objectType || definition?.source_object_type || definition?.target_object_type || "",
        objectIds: opts.objectIds,
        q: opts.q,
        limit: Math.min(MAX_RECORDS, Number(opts.options.limit) || 1000),
        bomNumber: opts.options.bom_number || opts.options.bomNumber,
        revisionNumber: opts.options.revision_number || opts.options.revisionNumber,
      },
      ctx
    );
    records = Array.isArray(fetched) ? fetched : fetched.objects || [];
    if (!Array.isArray(fetched) && Array.isArray(fetched.relationships) && fetched.relationships.length) {
      ctx.relationships = fetched.relationships;
    }
  } else {
    throw unsupportedOperation("This exchange definition does not support export");
  }

  const authorizer = guardExport(db, actor, {
    tenantId: tenant,
    definition,
    records,
    organizationId: opts.organizationId,
    ip,
    correlationId: opts.correlationId,
    allowPartial: opts.options.allow_partial !== false && config.allow_partial_execution !== false,
  });
  records = authorizer.allowed;

  const document = emptyDocument({
    file_name: opts.fileName,
    mime_type: opts.mimeType,
    format: format.code,
    format_version: formatVersion,
    adapter: adapter.code,
  });
  for (const record of records) {
    const canonical = createCanonicalObject(record);
    if (opts.objectType && !canonical.object_type) canonical.object_type = opts.objectType;
    document.objects.push(canonical);
  }
  for (const relationship of ctx.relationships || []) {
    document.relationships.push(relationship);
  }
  const stats = documentStats(document);

  const counts = emptyCounts();
  counts.records_read = records.length;
  counts.records_validated = records.length;
  counts.records_skipped = authorizer.denied;
  counts.files_processed = 1;

  const profile = definition?.validation_profile_code ? resolveValidationProfile(db, tenant, definition.validation_profile_code) : null;
  const validation = runValidation(db, tenant, {
    definition,
    profile,
    format,
    adapter,
    payload: opts.payload,
    fileName: opts.fileName,
    mimeType: opts.mimeType,
    records: document.objects,
    levels: profile?.levels?.includes("ENTERPRISE") ? profile.levels : ["FILE", "STANDARDS"],
    maxBytes: maxPayloadBytes,
    context: { ...enterpriseCheckers(db, tenant), max_payload_bytes: maxPayloadBytes, config },
  });

  const serialized = adapter.export(document, { pretty: true, config: config || {} });
  const payload = serialized.payload ?? "";
  const output = {
    payload,
    mime_type: serialized.mime_type || "",
    file_name: serialized.file_name || "",
    size: Buffer.byteLength(String(payload), "utf8"),
    document: stats,
    records_skipped: authorizer.denied,
  };

  const isMutating = MUTATING_OPERATIONS.includes(opts.operation) && !opts.dryRun;
  const status = opts.operation === "PREVIEW" || opts.operation === "DRY_RUN" || opts.operation === "VALIDATE_ONLY" ? (opts.operation === "PREVIEW" ? "PREVIEW" : "COMPLETED") : "COMPLETED";

  updateTransaction(db, txn.id, { status: "VALIDATING" });
  const finalized = finalizeTransaction(db, tenant, txn.id, {
    status,
    counts,
    validation,
    reconciliation: null,
    output: { ...output, dry_run: !isMutating },
    error: null,
    actor,
  });
  publishExchangeEvent(db, {
    eventType: exchangeEventCode("COMPLETED"),
    payload: { transaction_ref: finalized.transaction_ref, operation: finalized.operation, direction: "EXPORT", status: finalized.status, counts },
    objectType: "exchange_transaction",
    objectId: finalized.id,
    tenantId: tenant,
    organizationId: finalized.organization_id ?? null,
    correlationId: finalized.correlation_id || null,
  }, actor);
  recordHistory(db, {
    tenantId: tenant,
    transactionRef: finalized.transaction_ref,
    definitionCode: finalized.definition_code,
    definitionVersion: finalized.definition_version,
    formatCode: finalized.format_code,
    direction: "EXPORT",
    action: finalized.operation,
    status: finalized.status,
    counts,
    summary: `EXPORT ${finalized.status} (${counts.records_read} record(s), ${authorizer.denied} skipped by policy)`,
    correlationId: finalized.correlation_id,
    actor,
    details: { format: format.code },
  });
  return finalized;
}

// ── Read APIs ────────────────────────────────────────────────────────────────
export function getTransaction(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM exchange_transactions WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM exchange_transactions WHERE tenant_id = ? AND transaction_ref = ?", [Number(tenantId), raw]);
  if (!row) throw transactionNotFound(ref);
  return publicTransaction(row);
}

export function listTransactions(db, tenantId, query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(200, Math.max(1, Number(query.page_size || query.pageSize || 50)));
  const offset = (page - 1) * pageSize;
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  const filter = (column, value) => {
    if (value === undefined || value === null || value === "") return;
    clauses.push(`${column} = ?`);
    params.push(String(value).toUpperCase());
  };
  filter("status", query.status);
  filter("direction", query.direction);
  filter("operation", query.operation);
  filter("definition_code", query.definition_code || query.definitionCode);
  if (query.from) {
    clauses.push("created_at >= ?");
    params.push(String(query.from));
  }
  if (query.to) {
    clauses.push("created_at <= ?");
    params.push(String(query.to));
  }
  const where = clauses.join(" AND ");
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM exchange_transactions WHERE ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM exchange_transactions WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  return { items: rows.map(publicTransaction), total, page, pageSize };
}

export function cancelTransaction(db, tenantId, ref, actor = null) {
  const row = /^\d+$/.test(String(ref))
    ? queryOne(db, "SELECT * FROM exchange_transactions WHERE id = ? AND tenant_id = ?", [Number(ref), Number(tenantId)])
    : queryOne(db, "SELECT * FROM exchange_transactions WHERE tenant_id = ? AND transaction_ref = ?", [Number(tenantId), String(ref)]);
  if (!row) throw transactionNotFound(ref);
  if (TERMINAL.has(row.status)) throw transactionImmutable(row.transaction_ref);
  updateTransaction(db, row.id, { status: "CANCELLED", finished_at: nowIso() });
  publishExchangeEvent(db, {
    eventType: exchangeEventCode("CANCELLED"),
    payload: { transaction_ref: row.transaction_ref, operation: row.operation, direction: row.direction },
    objectType: "exchange_transaction",
    objectId: row.id,
    tenantId,
    correlationId: row.correlation_id || null,
  }, actor);
  return publicTransaction(queryOne(db, "SELECT * FROM exchange_transactions WHERE id = ?", [row.id]));
}

export function transactionSummary(db, tenantId) {
  const rows = queryAll(db, "SELECT direction, operation, status, COUNT(*) AS c FROM exchange_transactions WHERE tenant_id = ? GROUP BY direction, operation, status", [Number(tenantId)]);
  const summary = { total: 0, by_direction: {}, by_operation: {}, by_status: {} };
  for (const row of rows) {
    summary.by_direction[row.direction] = (summary.by_direction[row.direction] || 0) + Number(row.c);
    summary.by_operation[row.operation] = (summary.by_operation[row.operation] || 0) + Number(row.c);
    summary.by_status[row.status] = (summary.by_status[row.status] || 0) + Number(row.c);
    summary.total += Number(row.c);
  }
  return summary;
}

export { normalizeOptions, insertTransaction, updateTransaction, runImport, runExport, resolveFormatAdapter };

import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { HttpError } from "../../validation.js";
import {
  getStorageProvider,
  runVirusScan,
  runPreview,
  checksumObject,
} from "../file-storage.js";
import { registerHandler } from "../job-execution/handlers.js";
import { findFileRow, publicProcessing, assertTenant } from "./repository.js";
import { assertAccess } from "./permissions.js";
import { recordFileEvent, auditFile } from "./events.js";

// File processing status service. The heavy lifting (checksum, malware scanning,
// preview/rendition generation) belongs to the File Storage & Processing
// Services module. This service orchestrates that work and records the outcome
// against the file and version, driving the file lifecycle status.
//
// The storage pipeline is asynchronous, so callers await `processVersion`, which
// runs the I/O outside the transaction and then persists all derived state in a
// single synchronous transaction.

export function upsertProcessing(db, {
  fileId, versionId = null, type, status, provider = "", result = {}, errorMessage = "", tenantId = null, attempt = null,
}) {
  const ts = nowIso();
  const existing = queryOne(
    db,
    "SELECT * FROM file_processing WHERE version_id IS ? AND processing_type = ?",
    [versionId ?? null, type]
  );
  const attempts = attempt ?? ((existing?.attempts || 0) + 1);
  const completedAt = ["in_progress", "pending"].includes(status) ? null : ts;
  if (existing) {
    run(
      db,
      `UPDATE file_processing SET status = ?, provider = ?, attempts = ?, result_json = ?, error_message = ?,
         started_at = COALESCE(started_at, ?), completed_at = ?, updated_at = ? WHERE id = ?`,
      [status, provider, attempts, JSON.stringify(result || {}), errorMessage || "", ts, completedAt, ts, existing.id]
    );
    return publicProcessing(queryOne(db, "SELECT * FROM file_processing WHERE id = ?", [existing.id]));
  }
  const insert = run(
    db,
    `INSERT INTO file_processing
      (file_id, version_id, processing_type, status, provider, attempts, result_json, error_message,
       started_at, completed_at, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fileId, versionId ?? null, type, status, provider, attempts, JSON.stringify(result || {}),
      errorMessage || "", ts, completedAt, tenantId ?? null, ts, ts,
    ]
  );
  return publicProcessing(queryOne(db, "SELECT * FROM file_processing WHERE id = ?", [insert.lastInsertRowid]));
}

// Runs the storage-side pipeline for a version. Performs no database writes and
// never throws for scan/preview failures; failures are reflected in the result
// so the caller can persist a status and let operators react.
export async function runProcessingPipeline(store, {
  key, size = 0, mimeType = "", extension = "", name = "", checksum = "",
} = {}) {
  const outcome = {
    scan_status: "skipped",
    preview_status: "unsupported",
    rendition_status: "pending",
    checksum: checksum || "",
    scan: null,
    preview: null,
    rendition: null,
  };
  if (!key) return outcome;

  if (!outcome.checksum) {
    try {
      const sum = await checksumObject(store, key);
      outcome.checksum = sum?.checksum || "";
    } catch {
      /* checksum backfill is best effort */
    }
  }

  try {
    const scan = await runVirusScan(store, { key, size, mimeType, extension });
    outcome.scan = scan;
    outcome.scan_status = scan.status;
  } catch (err) {
    outcome.scan = { status: "failed", engine: "scan", detail: err.message };
    outcome.scan_status = "failed";
  }
  if (outcome.scan_status !== "clean") return outcome;

  try {
    const generated = await runPreview(store, { mimeType, extension, name });
    outcome.preview = generated.preview;
    outcome.rendition = generated.rendition;
    outcome.preview_status = generated.preview.status;
    outcome.rendition_status = generated.rendition.status;
  } catch (err) {
    outcome.preview = { status: "failed", provider: "preview", detail: err.message };
    outcome.rendition = { status: "failed", provider: "preview", detail: err.message };
    outcome.preview_status = "failed";
    outcome.rendition_status = "failed";
  }
  return outcome;
}

function processingRowStatus(type, outcome) {
  if (type === "virus_scan") {
    if (outcome.scan_status === "clean") return "completed";
    if (outcome.scan_status === "skipped") return "skipped";
    return "failed";
  }
  if (type === "preview") {
    if (outcome.preview_status === "ready") return "completed";
    if (outcome.preview_status === "unsupported") return "skipped";
    return "failed";
  }
  if (outcome.rendition_status === "ready") return "completed";
  if (outcome.rendition_status === "pending") return "pending";
  return "failed";
}

// Persists the pipeline outcome. Must be called inside a transaction so the file,
// version and processing rows stay consistent.
export function persistProcessingResult(db, fileRow, versionId, outcome, { actor = null, tenantId = null } = {}) {
  const scope = tenantId ?? fileRow.tenant_id;
  const ts = nowIso();

  if (outcome.checksum && outcome.checksum !== fileRow.checksum) {
    run(db, "UPDATE file_versions SET checksum = ? WHERE id = ?", [outcome.checksum, versionId]);
    run(db, "UPDATE files SET checksum = ?, updated_at = ? WHERE id = ?", [outcome.checksum, ts, fileRow.id]);
  }

  upsertProcessing(db, {
    fileId: fileRow.id, versionId, type: "virus_scan", status: processingRowStatus("virus_scan", outcome),
    provider: outcome.scan?.engine || "scan", result: outcome.scan || {}, errorMessage: outcome.scan_status === "clean" ? "" : (outcome.scan?.detail || ""),
    tenantId: scope,
  });
  if (outcome.scan_status === "clean") {
    upsertProcessing(db, {
      fileId: fileRow.id, versionId, type: "preview", status: processingRowStatus("preview", outcome),
      provider: outcome.preview?.provider || "preview", result: outcome.preview || {}, tenantId: scope,
    });
    upsertProcessing(db, {
      fileId: fileRow.id, versionId, type: "rendition", status: processingRowStatus("rendition", outcome),
      provider: outcome.rendition?.provider || "preview", result: outcome.rendition || {}, tenantId: scope,
    });
  }

  let status;
  if (outcome.scan_status === "infected") status = "quarantined";
  else if (outcome.scan_status === "failed") status = "scan_failed";
  else if (outcome.scan_status === "clean") status = "available";
  else status = "pending_scan";

  const versionStatus = status === "available" ? "available" : (status === "quarantined" ? "quarantined" : "processing");
  run(db, "UPDATE file_versions SET status = ?, virus_scan_status = ?, updated_at = ? WHERE id = ?", [versionStatus, outcome.scan_status, ts, versionId]);
  run(
    db,
    `UPDATE files SET status = ?, virus_scan_status = ?, preview_status = ?, rendition_status = ?, updated_at = ? WHERE id = ?`,
    [status, outcome.scan_status, outcome.preview_status, outcome.rendition_status, ts, fileRow.id]
  );

  recordFileEvent(db, {
    eventType: "FileScanCompleted",
    file: { ...fileRow, status },
    versionId,
    actor,
    tenantId: scope,
    payload: {
      result: outcome.scan_status,
      detail: outcome.scan?.detail || "",
      preview: outcome.preview_status,
      rendition: outcome.rendition_status,
    },
  });
  return { ...outcome, status };
}

// Convenience wrapper: run the pipeline (async I/O) then persist synchronously.
export async function processVersion(db, fileRow, versionRow, { provider, actor = null, tenantId = null } = {}) {
  const store = provider || getStorageProvider();
  const scope = tenantId ?? fileRow.tenant_id;
  const outcome = await runProcessingPipeline(store, {
    key: versionRow.storage_key,
    size: versionRow.size_bytes,
    mimeType: versionRow.mime_type,
    extension: versionRow.extension,
    name: versionRow.name,
    checksum: versionRow.checksum,
  });
  return transaction(db, () => persistProcessingResult(db, fileRow, versionRow.id, outcome, { actor, tenantId: scope }));
}

export function getProcessingStatus(db, fileReference, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const file = findFileRow(db, fileReference, scope);
  assertAccess(db, file, actor, "view_metadata", { tenantId: scope });
  const items = queryAll(db, "SELECT * FROM file_processing WHERE file_id = ? ORDER BY processing_type", [file.id])
    .map(publicProcessing);
  const current = file.current_version_id
    ? items.filter((item) => !item.version_id || Number(item.version_id) === Number(file.current_version_id))
    : items;
  const overall = file.status === "quarantined"
    ? "quarantined"
    : (["scan_failed", "upload_failed"].includes(file.status) ? "failed" : (file.status === "available" ? "available" : "processing"));
  return {
    file_id: file.id,
    file_ref: file.file_ref,
    status: file.status,
    virus_scan_status: file.virus_scan_status,
    preview_status: file.preview_status,
    rendition_status: file.rendition_status,
    overall_status: overall,
    is_downloadable: file.status === "available",
    items: current,
  };
}

export async function requeueProcessing(db, fileReference, type, actor, tenantId, ip) {
  const scope = assertTenant(tenantId);
  const file = findFileRow(db, fileReference, scope);
  assertAccess(db, file, actor, "edit_metadata", { tenantId: scope });
  const version = file.current_version_id
    ? queryOne(db, "SELECT * FROM file_versions WHERE id = ?", [file.current_version_id])
    : null;
  if (!version) throw new HttpError(409, "File has no current version to process");
  const result = await processVersion(db, file, version, { actor, tenantId: scope });
  auditFile(db, {
    actor, tenantId: scope, organizationId: file.organization_id, action: "files.processing.requeue",
    file, details: { type, result: { scan_status: result.scan_status } }, ip,
  });
  return { scan_status: result.scan_status, preview_status: result.preview_status, file: findFileRow(db, file.id, scope) };
}

// ── Job integration ─────────────────────────────────────────────────────────
// Async processing handlers registered with the execution engine. They are
// idempotent (persistProcessingResult overwrites the per-version status rows) so
// at-least-once delivery is safe.

function structuredJobLog(level, context, message, detail) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(), level, component: "files-processing",
      job_id: context.job_id, job_ref: context.job_ref, message, ...(detail ? { detail } : {}),
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    /* logging must never throw */
  }
}

function resolveVersion(db, input = {}) {
  const fileId = input.file_id ?? input.fileId;
  const versionId = input.version_id ?? input.versionId;
  const file = fileId ? findFileRow(db, fileId, null) : null;
  if (!file) throw new HttpError(404, "File not found for processing job");
  const version = versionId
    ? queryOne(db, "SELECT * FROM file_versions WHERE id = ? AND file_id = ?", [Number(versionId), file.id])
    : queryOne(db, "SELECT * FROM file_versions WHERE file_id = ? AND is_current = 1", [file.id]);
  if (!version) throw new HttpError(404, "File version not found for processing job");
  return { file, version };
}

export async function processFileJob(db, input = {}) {
  const { file, version } = resolveVersion(db, input);
  return processVersion(db, file, version, { actor: null, tenantId: file.tenant_id });
}

export function registerFileProcessingHandlers() {
  registerHandler("files.virusScan", async (context) => {
    context.step("virus_scan", { progress: 10, message: "Scanning for malware" });
    const { file, version } = resolveVersion(context.db, context.input);
    context.checkCancelled();
    const result = await processVersion(context.db, file, version, { actor: null, tenantId: file.tenant_id });
    context.reportProgress({ progress: 100, message: `Scan ${result.scan_status}` }, { force: true });
    structuredJobLog("info", context, "virus scan completed", { scan_status: result.scan_status });
    if (result.scan_status === "infected") throw new Error("File failed virus scanning and was quarantined");
    return { message: `Virus scan ${result.scan_status}`, result: { scan_status: result.scan_status }, last_step: "virus_scan" };
  }, { description: "Virus scan for a stored file version" });

  registerHandler("files.previewGeneration", async (context) => {
    context.step("preview", { progress: 10, message: "Generating preview" });
    const { file, version } = resolveVersion(context.db, context.input);
    context.checkCancelled();
    const result = await processVersion(context.db, file, version, { actor: null, tenantId: file.tenant_id });
    context.reportProgress({ progress: 100, message: `Preview ${result.preview_status}` }, { force: true });
    return { message: `Preview ${result.preview_status}`, result: { preview_status: result.preview_status }, last_step: "preview" };
  }, { description: "Preview/rendition generation for a stored file version" });

  return ["files.virusScan", "files.previewGeneration"];
}

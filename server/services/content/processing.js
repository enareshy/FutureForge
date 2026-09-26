import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { resolveContentStorage } from "./storage.js";
import { runContentScan, applyScanOutcome } from "./security.js";
import { generateRendition, requestRendition, defaultRenditionTypes, resolveRenditionProcessor, markRenditionsOutdated } from "./renditions.js";
import { publicProcessingJob, currentVersionRow } from "./repository.js";
import { recordContentEvent } from "./events.js";

// Content processing orchestration (spec §16/§50). Security scanning and
// rendition generation run through pluggable providers; deferred processors are
// executed by the shared Background Jobs & Scheduler service, never in the API
// process. This module never spawns its own scheduler.

export function recordProcessingJob(db, {
  tenantId = null,
  contentId = null,
  versionId = null,
  renditionId = null,
  jobType,
  status = "pending",
  priority = "normal",
  payload = {},
  result = {},
  errorMessage = "",
  scheduledAt = null,
} = {}) {
  const insert = run(
    db,
    `INSERT INTO content_processing_jobs
      (tenant_id, content_id, version_id, rendition_id, job_type, status, priority, payload_json, result_json,
       error_message, scheduled_at, started_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      contentId,
      versionId,
      renditionId,
      jobType,
      status,
      priority,
      JSON.stringify(payload || {}),
      JSON.stringify(result || {}),
      errorMessage || "",
      scheduledAt,
      status === "running" ? nowIso() : null,
      ["completed", "failed", "cancelled"].includes(status) ? nowIso() : null,
      nowIso(),
      nowIso(),
    ]
  );
  return publicProcessingJob(queryOne(db, "SELECT * FROM content_processing_jobs WHERE id = ?", [Number(insert.lastInsertRowid)]));
}

export function completeProcessingJob(db, job, { status, result = {}, errorMessage = "" } = {}) {
  run(
    db,
    "UPDATE content_processing_jobs SET status = ?, result_json = ?, error_message = ?, attempts = attempts + 1, completed_at = ?, updated_at = ? WHERE id = ?",
    [status, JSON.stringify(result || {}), errorMessage || "", nowIso(), nowIso(), Number(job.id)]
  );
  return publicProcessingJob(queryOne(db, "SELECT * FROM content_processing_jobs WHERE id = ?", [Number(job.id)]));
}

// Runs the full security + rendition pipeline for the content's current version.
// Callers pass no store for the default provider. Returns the refreshed content.
export async function processContentVersion(db, contentRow, { store = null, actor = null, renditionTypes = null } = {}) {
  const storage = store || resolveContentStorage();
  const versionRow = currentVersionRow(db, contentRow.id);
  if (!versionRow) return { content: contentRow, scan: null, renditions: [] };

  run(db, "UPDATE content SET status = 'scanning', security_status = 'scanning', updated_at = ? WHERE id = ?", [
    nowIso(),
    Number(contentRow.id),
  ]);
  run(db, "UPDATE content_versions SET status = 'scanning', security_status = 'scanning', updated_at = ? WHERE id = ?", [
    nowIso(),
    Number(versionRow.id),
  ]);

  const outcome = await runContentScan(storage, {
    key: versionRow.storage_key,
    size: versionRow.file_size,
    mimeType: versionRow.mime_type,
    extension: versionRow.file_extension,
  });

  const applied = transaction(db, () => applyScanOutcome(db, { content: contentRow, versionId: versionRow.id, outcome, actor }));
  if (applied.quarantined || applied.failed) {
    return { content: applied.content, scan: applied.scan, renditions: [] };
  }

  const types = renditionTypes || defaultRenditionTypes();
  const renditions = [];
  let deferred = 0;
  for (const type of types) {
    const processor = resolveRenditionProcessor(type);
    if (!processor) continue;
    const requested = requestRendition(db, applied.content, { renditionType: type, sourceVersionId: versionRow.id, actor, tenantId: applied.content.tenant_id });
    if (processor.deferred) {
      recordProcessingJob(db, {
        tenantId: applied.content.tenant_id,
        contentId: applied.content.id,
        versionId: versionRow.id,
        renditionId: requested.id,
        jobType: "rendition",
        priority: "normal",
        payload: { rendition_type: type },
      });
      deferred += 1;
      continue;
    }
    const row = queryOne(db, "SELECT * FROM content_renditions WHERE id = ?", [Number(requested.id)]);
    const created = await generateRendition(db, applied.content, row, { store: storage, actor });
    renditions.push(created);
  }

  const readyCount = renditions.filter((r) => r.status === "available").length;
  const failedCount = renditions.filter((r) => r.status === "failed").length;
  const skippedCount = renditions.filter((r) => r.status === "skipped").length;
  const processingStatus = deferred > 0 ? "processing" : failedCount > 0 ? "partial" : "ready";
  run(
    db,
    "UPDATE content SET status = ?, processing_status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
    ["available", processingStatus, nowIso(), Number(applied.content.id)]
  );
  run(db, "UPDATE content_versions SET status = 'available', security_status = 'clean', updated_at = ? WHERE id = ?", [
    nowIso(),
    Number(versionRow.id),
  ]);
  const refreshed = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(applied.content.id)]);
  recordContentEvent(db, {
    eventType: "ContentUploadCompleted",
    content: refreshed,
    versionId: versionRow.id,
    actor,
    payload: { renditions: renditions.length, renditions_ready: readyCount, renditions_skipped: skippedCount, deferred, processing_status: processingStatus },
  });
  return { content: refreshed, scan: applied.scan, renditions, deferred };
}

export function getProcessingStatus(db, contentRow) {
  const jobs = queryAll(
    db,
    "SELECT * FROM content_processing_jobs WHERE content_id = ? ORDER BY created_at DESC LIMIT 100",
    [Number(contentRow.id)]
  ).map(publicProcessingJob);
  return {
    content_id: contentRow.content_id,
    status: contentRow.status,
    processing_status: contentRow.processing_status,
    security_status: contentRow.security_status,
    jobs,
  };
}

export function listProcessingJobs(db, { contentId = null, tenantId = null, status = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (contentId) {
    where.push("content_id = ?");
    params.push(Number(contentId));
  }
  if (tenantId !== null && tenantId !== undefined) {
    where.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (status) {
    where.push("status = ?");
    params.push(String(status));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = queryAll(
    db,
    `SELECT * FROM content_processing_jobs ${clause} ORDER BY created_at DESC LIMIT ?`,
    [...params, Math.min(500, Math.max(1, Number(limit) || 100))]
  );
  return { items: rows.map(publicProcessingJob), total: rows.length };
}

// ── Background job handlers ──────────────────────────────────────────────────

export const CONTENT_HANDLER_CODES = {
  scan: "content.scan",
  rendition: "content.rendition",
  retention: "content.retention",
  checksum: "content.checksum",
};

function jobActor(db, input) {
  if (input?.actor_id) {
    const user = queryOne(db, "SELECT * FROM users WHERE id = ?", [Number(input.actor_id)]);
    if (user) return { id: user.id, username: user.username, display_name: user.display_name };
  }
  return null;
}

export function registerContentProcessingHandlers() {
  registerHandler(CONTENT_HANDLER_CODES.scan, async (context) => {
    const db = context.db;
    const contentId = Number(context.input?.content_id);
    if (!contentId) throw new Error("content.scan requires content_id");
    const content = queryOne(db, "SELECT * FROM content WHERE id = ?", [contentId]);
    if (!content) throw new Error("Content not found");
    context.step("security_scan", { progress: 10, message: "Scanning content" });
    const result = await processContentVersion(db, content, { actor: jobActor(db, context.input) });
    context.reportProgress({ progress: 100, message: `Content ${result.content?.status || "processed"}` }, { force: true });
    return result;
  });

  registerHandler(CONTENT_HANDLER_CODES.rendition, async (context) => {
    const db = context.db;
    const payload = context.input || {};
    const content = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(payload.content_id)]);
    if (!content) throw new Error("Content not found");
    const rendition = payload.rendition_id
      ? queryOne(db, "SELECT * FROM content_renditions WHERE id = ?", [Number(payload.rendition_id)])
      : queryOne(db, "SELECT * FROM content_renditions WHERE content_id = ? AND rendition_type = ? ORDER BY id DESC", [
          content.id,
          String(payload.rendition_type || "").toUpperCase(),
        ]);
    if (!rendition) throw new Error("Rendition request not found");
    context.step("rendition", { progress: 25, message: `Generating ${rendition.rendition_type}` });
    const result = await generateRendition(db, content, rendition, { actor: jobActor(db, context.input) });
    context.reportProgress({ progress: 100, message: `Rendition ${result.status}` }, { force: true });
    return result;
  });
  return Object.values(CONTENT_HANDLER_CODES);
}

export async function requeueContentProcessing(db, contentRow, { actor = null, renditionTypes = null } = {}) {
  markRenditionsOutdated(db, contentRow);
  return processContentVersion(db, contentRow, { actor, renditionTypes });
}

// File & binary migration.
//
// Legacy systems store drawings, CAD models, documents and scanned records as
// files attached to objects. The migration framework reuses the platform File
// Storage & Processing Services: it uploads bytes through the normal upload
// session, creates an immutable file version, associates the file with the
// migrated target object and records the migration outcome (spec §15, §16).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { initiateUpload, completeUpload, createAssociation } from "../files.js";
import { SOURCE_MODULE } from "./constants.js";
import { publicFileMigration } from "./repository.js";
import { normalizeText, parseArray, paginate, assertFileMigrationStatus } from "./validation.js";
import { adapterFailed } from "./errors.js";

function publicEntry(row) {
  return publicFileMigration(row);
}

function recordFile(db, entry) {
  const result = run(
    db,
    `INSERT INTO mig_file_migrations (tenant_id, project_id, package_id, job_id, source_object_type, source_object_id, target_object_id,
       original_filename, mime_type, file_size, checksum, storage_ref, file_version, upload_status, virus_scan_status, status, error_message, details_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(entry.tenantId),
      entry.projectId != null ? Number(entry.projectId) : null,
      entry.packageId != null ? Number(entry.packageId) : null,
      entry.jobId != null ? Number(entry.jobId) : null,
      normalizeText(entry.sourceObjectType, { max: 120 }),
      normalizeText(entry.sourceObjectId, { max: 300 }),
      normalizeText(entry.targetObjectId, { max: 300 }),
      normalizeText(entry.originalFilename, { max: 300 }),
      normalizeText(entry.mimeType || "application/octet-stream", { max: 200 }),
      Number(entry.fileSize || 0),
      normalizeText(entry.checksum, { max: 200 }),
      normalizeText(entry.storageRef, { max: 500 }),
      normalizeText(entry.fileVersion, { max: 120 }),
      normalizeUpperToken(entry.uploadStatus || "PENDING"),
      normalizeText(entry.virusScanStatus || "UNKNOWN", { max: 60 }),
      normalizeUpperToken(entry.status || "PENDING"),
      normalizeText(entry.errorMessage, { max: 1000 }),
      JSON.stringify(entry.details || {}),
      nowIso(),
      nowIso(),
    ]
  );
  return Number(result.lastInsertRowid);
}

function normalizeUpperToken(value) {
  return String(value || "").trim().toUpperCase();
}

// Migrates the files attached to one source record. Returns counters and never
// throws for a single file failure; each failure becomes a tracked row and an
// error the retry engine can pick up.
export async function migrateRecordFiles(db, tenantId, { job, packageRow, record, source, targetObjectType, targetObjectId, actor = null, ip = null } = {}) {
  const settings = source || {};
  const filesField = normalizeText(settings.files_field ?? settings.filesField, { max: 120 });
  if (!filesField) return { migrated: 0, failed: 0, skipped: 0 };
  const files = parseArray(record?.[filesField], []);
  const counters = { migrated: 0, failed: 0, skipped: 0 };
  for (const file of files.slice(0, 500)) {
    const filename = normalizeText(file.filename ?? file.name, { max: 300 });
    if (!filename) {
      counters.skipped += 1;
      continue;
    }
    const mimeType = normalizeText(file.mime_type ?? file.mimeType ?? "application/octet-stream", { max: 200 });
    const buffer = file.buffer ?? (typeof file.data === "string" ? Buffer.from(file.data, "base64") : null);
    const base = {
      tenantId,
      projectId: job.project_id,
      packageId: job.package_id,
      jobId: job.id,
      sourceObjectType: packageRow?.source_object_type || job.source_adapter,
      sourceObjectId: file.source_file_id ?? file.sourceId ?? record?.source_id ?? record?.id ?? "",
      targetObjectId,
      originalFilename: filename,
      mimeType,
      fileSize: Number(file.size ?? file.file_size ?? buffer?.length ?? 0),
      checksum: normalizeText(file.checksum, { max: 200 }),
    };
    if (!buffer || !buffer.length) {
      // No bytes available: record the intent so an operator can supply them.
      counters.skipped += 1;
      recordFile(db, { ...base, status: "SKIPPED", uploadStatus: "SKIPPED", details: { reason: "no_bytes_supplied" } });
      continue;
    }
    try {
      const session = initiateUpload(db, { name: filename, mime_type: mimeType, size: buffer.length, declared_checksum: base.checksum }, actor, tenantId, ip);
      const uploadId = session.upload.upload_id ?? session.upload.uploadId ?? session.upload.id;
      const completed = await completeUpload(db, uploadId, { buffer }, actor, tenantId, ip);
      const fileRow = completed.file;
      const fileId = fileRow?.id ?? fileRow?.file_id;
      if (targetObjectId && fileId) {
        createAssociation(db, fileId, { business_object_type: targetObjectType, business_object_id: targetObjectId, relationship_type: "attachment" }, actor, tenantId, ip);
      }
      counters.migrated += 1;
      recordFile(db, {
        ...base,
        storageRef: fileRow?.file_ref || "",
        fileVersion: String(fileRow?.version_count ?? 1),
        status: "MIGRATED",
        uploadStatus: "UPLOADED",
        virusScanStatus: fileRow?.virus_scan_status || "pending",
        details: { file_ref: fileRow?.file_ref || null },
      });
    } catch (error) {
      counters.failed += 1;
      recordFile(db, { ...base, status: "FAILED", uploadStatus: "FAILED", errorMessage: error.message, details: { code: error.code || null } });
      writeAudit(db, { actor, action: "migration.file.fail", resourceType: "mig_file_migrations", resourceId: filename, status: "FAILED", errorMessage: error.message, ip });
    }
  }
  return counters;
}

// Migrates a standalone file manifest (when a definition emits file descriptors
// rather than embedding them in records).
export async function migrateFileManifest(db, tenantId, { job, packageRow, files = [], actor = null, ip = null } = {}) {
  const counters = { migrated: 0, failed: 0, skipped: 0 };
  for (const file of files.slice(0, 5000)) {
    const result = await migrateRecordFiles(db, tenantId, {
      job,
      packageRow,
      record: { [normalizeText(file.files_field || "files", { max: 120 })]: [file] },
      source: { files_field: normalizeText(file.files_field || "files", { max: 120 }) },
      targetObjectType: file.target_object_type,
      targetObjectId: file.target_object_id,
      actor,
      ip,
    });
    counters.migrated += result.migrated;
    counters.failed += result.failed;
    counters.skipped += result.skipped;
  }
  return counters;
}

export function listFileMigrations(db, { tenantId, jobId, packageId, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (jobId != null) {
    clauses.push("job_id = ?");
    params.push(Number(jobId));
  }
  if (packageId != null) {
    clauses.push("package_id = ?");
    params.push(Number(packageId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(assertFileMigrationStatus(status));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_file_migrations ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_file_migrations ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicEntry), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function retryFailedFiles(db, tenantId, { jobId, actor = null, ip = null } = {}) {
  const rows = queryAll(
    db,
    "SELECT * FROM mig_file_migrations WHERE tenant_id = ? AND job_id = ? AND status = 'FAILED' LIMIT 2000",
    [Number(tenantId), Number(jobId)]
  );
  if (!rows.length) throw adapterFailed("No failed file migrations to retry");
  return { queued: rows.length };
}

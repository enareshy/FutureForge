import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { assertArtifactKind, safeParse, truncate } from "./validation.js";
import { recordHistory } from "./history.js";

// Job results and artifacts. A job result is the structured outcome the
// execution engine reports back (`result_json` + a secure `result_ref`). Large
// or binary outputs are registered as artifacts that point at the Document &
// File Management storage abstraction; this module stores references only and
// never persists file bytes.

export function publicArtifact(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    kind: row.kind || "output",
    name: row.name || "",
    filename: row.filename || "",
    content_type: row.content_type || "",
    size: row.size,
    url: row.url || "",
    storage_ref: row.storage_ref || "",
    checksum: row.checksum || "",
    secure: row.secure === 1,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

export function addArtifact(db, jobId, input = {}, actor = null, ip = null) {
  const kind = input.kind || "output";
  assertArtifactKind(kind);
  const name = truncate(input.name || input.filename || "Result", 200);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO job_artifacts
       (job_id, kind, name, filename, content_type, size, url, storage_ref, checksum, secure, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(jobId),
      kind,
      name,
      truncate(input.filename || "", 255),
      truncate(input.content_type || input.contentType || "application/octet-stream", 128),
      Math.max(0, Number(input.size) || 0),
      truncate(input.url || "", 1000),
      truncate(input.storage_ref || input.storageRef || "", 500),
      truncate(input.checksum || "", 128),
      input.secure ? 1 : 0,
      actor?.id ?? null,
      ts,
    ]
  );
  recordHistory(db, jobId, {
    event_type: "result",
    message: `Artifact registered: ${name}`,
    detail: { artifact_id: Number(result.lastInsertRowid), kind },
    actor_id: actor?.id ?? null,
    actor_type: actor ? "user" : "engine",
    source: "engine",
  });
  return publicArtifact(queryOne(db, "SELECT * FROM job_artifacts WHERE id = ?", [result.lastInsertRowid]));
}

export function listArtifacts(db, jobId) {
  return queryAll(db, "SELECT * FROM job_artifacts WHERE job_id = ? ORDER BY id ASC", [Number(jobId)]).map(publicArtifact);
}

export function getArtifact(db, id) {
  const row = queryOne(db, "SELECT * FROM job_artifacts WHERE id = ?", [Number(id) || -1]);
  if (!row) throw new HttpError(404, "Job artifact not found");
  return publicArtifact(row);
}

export function resultPayload(db, jobRow) {
  return {
    job_id: jobRow.id,
    job_ref: jobRow.job_ref,
    status: jobRow.status,
    result_ref: jobRow.result_ref || "",
    result: safeParse(jobRow.result_json, {}),
    error_code: jobRow.error_code || "",
    error_message: jobRow.error_message || "",
    error: safeParse(jobRow.error_json, {}),
    artifacts: listArtifacts(db, jobRow.id),
  };
}

// Records the structured result reported by the execution engine. Idempotent:
// re-reporting the same result simply overwrites the stored summary.
export function setJobResult(db, jobRow, payload = {}, { actor = null, ip = null } = {}) {
  const ts = nowIso();
  run(
    db,
    "UPDATE jobs SET result_ref = ?, result_json = ?, updated_at = ? WHERE id = ?",
    [
      truncate(payload.result_ref ?? payload.resultRef ?? jobRow.result_ref ?? "", 500),
      JSON.stringify(payload.result ?? payload.result_json ?? safeParse(jobRow.result_json, {})),
      ts,
      jobRow.id,
    ]
  );
  recordHistory(db, jobRow.id, {
    event_type: "result",
    message: "Result recorded",
    detail: { result_ref: payload.result_ref ?? payload.resultRef ?? "" },
    actor_id: actor?.id ?? null,
    actor_type: actor ? "user" : "engine",
    source: "engine",
  });
  writeAudit(db, {
    actor,
    action: "jobs.result.record",
    resourceType: "job",
    resourceId: jobRow.id,
    details: { job_ref: jobRow.job_ref },
    ip,
  });
  return resultPayload(db, queryOne(db, "SELECT * FROM jobs WHERE id = ?", [jobRow.id]));
}

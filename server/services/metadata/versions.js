import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";

const ARTIFACT_TYPES = ["type", "attribute", "lov", "form", "rule"];

export function assertArtifactType(artifactType) {
  if (!ARTIFACT_TYPES.includes(artifactType)) {
    throw new HttpError(400, `artifact_type must be one of: ${ARTIFACT_TYPES.join(", ")}`);
  }
  return artifactType;
}

// Persists a full snapshot for an artifact. Version numbers are monotonic per
// artifact and snapshots are immutable, so history can never be silently
// rewritten. Publishing marks the newest snapshot active and archives the rest.
export function recordVersion(db, artifactType, artifactId, snapshot, actor, notes = "", status = "active") {
  assertArtifactType(artifactType);
  const latest = queryOne(
    db,
    `SELECT MAX(version) AS v FROM metadata_versions WHERE artifact_type = ? AND artifact_id = ?`,
    [artifactType, Number(artifactId)]
  );
  const version = (latest?.v || 0) + 1;
  if (status === "active") {
    run(
      db,
      `UPDATE metadata_versions SET status = 'archived'
       WHERE artifact_type = ? AND artifact_id = ? AND status = 'active'`,
      [artifactType, Number(artifactId)]
    );
  }
  run(
    db,
    `INSERT INTO metadata_versions (artifact_type, artifact_id, version, status, snapshot, notes, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      artifactType,
      Number(artifactId),
      version,
      status,
      JSON.stringify(snapshot ?? {}),
      notes || "",
      actor?.username || "system",
      nowIso(),
    ]
  );
  return version;
}

export function listVersions(db, artifactType, artifactId) {
  assertArtifactType(artifactType);
  return queryAll(
    db,
    `SELECT id, artifact_type, artifact_id, version, status, notes, created_by, created_at
     FROM metadata_versions WHERE artifact_type = ? AND artifact_id = ?
     ORDER BY version DESC`,
    [artifactType, Number(artifactId)]
  );
}

export function getVersion(db, artifactType, artifactId, version) {
  assertArtifactType(artifactType);
  const row = queryOne(
    db,
    `SELECT * FROM metadata_versions WHERE artifact_type = ? AND artifact_id = ? AND version = ?`,
    [artifactType, Number(artifactId), Number(version)]
  );
  if (!row) throw new HttpError(404, "Version not found");
  return { ...row, snapshot: safeParse(row.snapshot) };
}

export function latestVersion(db, artifactType, artifactId) {
  assertArtifactType(artifactType);
  return queryOne(
    db,
    `SELECT * FROM metadata_versions WHERE artifact_type = ? AND artifact_id = ?
     ORDER BY version DESC LIMIT 1`,
    [artifactType, Number(artifactId)]
  );
}

function safeParse(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

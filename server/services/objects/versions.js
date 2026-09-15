import { run } from "../../db.js";

// Immutable object revision snapshots. Kept in a dedicated module so the
// Lifecycle engine can record versions without importing the object domain
// service (avoiding a circular dependency).

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function snapshot(row) {
  return {
    id: row.id,
    uuid: row.uuid,
    code: row.code,
    object_type_id: row.object_type_id,
    name: row.name,
    description: row.description,
    status: row.status,
    revision: row.revision,
    data: safeParse(row.data_json, {}),
    owner_id: row.owner_id,
    owner_object_id: row.owner_object_id,
    organization_id: row.organization_id,
    tenant_id: row.tenant_id,
    lifecycle_version_id: row.lifecycle_version_id ?? null,
    lifecycle_state_id: row.lifecycle_state_id ?? null,
    lifecycle_status_id: row.lifecycle_status_id ?? null,
    external_ref: row.external_ref,
    external_system: row.external_system,
    tags: safeParse(row.tags_json, []),
    deleted_at: row.deleted_at,
  };
}

export function recordObjectVersion(db, row, changeType, summary, actorId) {
  run(
    db,
    `INSERT INTO object_versions (object_id, revision, change_type, snapshot, change_summary, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.revision, changeType, JSON.stringify(snapshot(row)), summary || "", actorId ?? null]
  );
}

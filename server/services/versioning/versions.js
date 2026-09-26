// VersionService — independent evolution inside a revision where required.
// A version always belongs to a revision and inherits its object identity.
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit, recordStateChange } from "../audit.js";
import { emitDomainEvent } from "../events/emit.js";
import { publicVersion, normalizeText, assertEnum, VERSION_STATUSES, safeParse } from "./validation.js";
import { versionRef } from "./refs.js";
import { versionNotFound, invalidVersion } from "./errors.js";
import { requireRevisionRow } from "./revisions.js";

function serialize(row) {
  return publicVersion(row);
}

export function listVersions(db, revisionRefValue, { status, page = 1, pageSize = 100 } = {}) {
  const revision = requireRevisionRow(db, revisionRefValue);
  const params = [revision.id];
  let clause = "revision_id = ?";
  if (status) {
    clause += " AND status = ?";
    params.push(String(status));
  }
  const total = queryOne(db, `SELECT COUNT(*) AS count FROM versioning_versions WHERE ${clause}`, params)?.count ?? 0;
  const limit = Math.min(Math.max(Number(pageSize) || 100, 1), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const rows = queryAll(
    db,
    `SELECT * FROM versioning_versions WHERE ${clause} ORDER BY version_sequence DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { items: rows.map(serialize), total, page: Number(page) || 1, page_size: limit, revision: revision.revision_ref };
}

export function getVersionRow(db, ref) {
  if (ref === undefined || ref === null || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref)) {
    return queryOne(db, "SELECT * FROM versioning_versions WHERE id = ?", [numeric]);
  }
  return queryOne(db, "SELECT * FROM versioning_versions WHERE version_ref = ?", [String(ref)]);
}

export function getVersion(db, ref) {
  const row = getVersionRow(db, ref);
  if (!row) throw versionNotFound(ref);
  return serialize(row);
}

export function requireVersionRow(db, ref) {
  const row = getVersionRow(db, ref);
  if (!row) throw versionNotFound(ref);
  return row;
}

export function createVersion(db, revisionRefValue, input = {}, actor = null, ip = null) {
  const revision = requireRevisionRow(db, revisionRefValue, { objectType: input.objectType ?? input.object_type });
  const versionNumber = normalizeText(input.versionNumber ?? input.version_number);
  if (!versionNumber) throw invalidVersion("versionNumber is required");
  assertEnum(input.status, VERSION_STATUSES, "status", []);
  return transaction(db, () => {
    const existing = queryOne(db, "SELECT id FROM versioning_versions WHERE revision_id = ? AND version_number = ?", [
      revision.id,
      versionNumber,
    ]);
    if (existing) throw invalidVersion(`Version ${versionNumber} already exists for revision ${revision.revision_code}`);
    const max = queryOne(db, "SELECT MAX(version_sequence) AS max_seq FROM versioning_versions WHERE revision_id = ?", [revision.id]);
    const sequence = Number(max?.max_seq ?? 0) + 1;
    const isDefault = input.isDefault === true || input.is_default === true || sequence === 1;
    const ts = nowIso();
    if (isDefault) {
      run(db, "UPDATE versioning_versions SET is_default = 0, updated_at = ? WHERE revision_id = ?", [ts, revision.id]);
    }
    const status = input.status && VERSION_STATUSES.includes(input.status) ? input.status : "draft";
    const result = run(
      db,
      `INSERT INTO versioning_versions
        (version_ref, revision_id, object_type, object_id, version_number, version_sequence, name, description, status,
         lifecycle_state, is_default, effective_from, effective_to, version_metadata_json, tenant_id, version,
         created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        versionRef(revision.id, versionNumber),
        revision.id,
        revision.object_type,
        revision.object_id,
        versionNumber,
        sequence,
        normalizeText(input.name),
        normalizeText(input.description),
        status,
        normalizeText(input.lifecycleState ?? input.lifecycle_state, status),
        isDefault ? 1 : 0,
        normalizeText(input.effectiveFrom ?? input.effective_from) || null,
        normalizeText(input.effectiveTo ?? input.effective_to) || null,
        JSON.stringify(input.metadata ?? input.version_metadata ?? safeParse(input.version_metadata_json, {})),
        input.tenantId ?? input.tenant_id ?? revision.tenant_id,
        actor?.id ?? null,
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
    const row = queryOne(db, "SELECT * FROM versioning_versions WHERE id = ?", [Number(result.lastInsertRowid)]);
    writeAudit(db, {
      actor,
      action: "versioning.version.create",
      resourceType: "versioning_version",
      resourceId: row.id,
      details: { revision_id: revision.id, version_number: versionNumber, sequence },
      ip,
    });
    emitDomainEvent(
      db,
      {
        event_type_code: "VersionCreated",
        source_module: "versioning",
        source_object_type: "versioning_version",
        source_object_id: row.id,
        tenant_id: row.tenant_id,
        payload: {
          version_id: row.id,
          revision_id: revision.id,
          object_type: revision.object_type,
          object_id: revision.object_id,
          version_number: versionNumber,
          sequence,
        },
      },
      actor
    );
    return serialize(row);
  });
}

export function updateVersion(db, ref, patch = {}, actor = null, ip = null) {
  const row = requireVersionRow(db, ref);
  const before = serialize(row);
  const fields = [];
  const params = [];
  const set = (column, value) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) set("name", normalizeText(patch.name));
  if (patch.description !== undefined) set("description", normalizeText(patch.description));
  if (patch.status !== undefined) {
    assertEnum(patch.status, VERSION_STATUSES, "status", []);
    set("status", patch.status);
  }
  if (patch.lifecycleState !== undefined || patch.lifecycle_state !== undefined) {
    set("lifecycle_state", normalizeText(patch.lifecycleState ?? patch.lifecycle_state));
  }
  if (patch.effectiveFrom !== undefined || patch.effective_from !== undefined) {
    set("effective_from", normalizeText(patch.effectiveFrom ?? patch.effective_from) || null);
  }
  if (patch.effectiveTo !== undefined || patch.effective_to !== undefined) {
    set("effective_to", normalizeText(patch.effectiveTo ?? patch.effective_to) || null);
  }
  if (patch.metadata !== undefined || patch.version_metadata !== undefined) {
    set("version_metadata_json", JSON.stringify(patch.metadata ?? patch.version_metadata ?? {}));
  }
  if (patch.isDefault === true || patch.is_default === true) {
    run(db, "UPDATE versioning_versions SET is_default = 0, updated_at = ? WHERE revision_id = ?", [nowIso(), row.revision_id]);
    set("is_default", 1);
  } else if (patch.isDefault === false || patch.is_default === false) {
    set("is_default", 0);
  }
  const expectedVersion = patch.version !== undefined ? Number(patch.version) : Number(row.version);
  if (fields.length) {
    set("updated_by", actor?.id ?? null);
    set("version", Number(row.version) + 1);
    set("updated_at", nowIso());
    const result = run(db, `UPDATE versioning_versions SET ${fields.join(", ")} WHERE id = ? AND version = ?`, [
      ...params,
      row.id,
      expectedVersion,
    ]);
    if (!Number(result.changes)) {
      throw new HttpError(409, "Version was modified concurrently; reload and retry", { code: "VERSIONING_CONCURRENCY_CONFLICT" });
    }
  }
  const updated = queryOne(db, "SELECT * FROM versioning_versions WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.version.update",
    resourceType: "versioning_version",
    resourceId: row.id,
    details: { before, after: serialize(updated) },
    ip,
  });
  return serialize(updated);
}

export function transitionVersion(db, ref, nextStatus, actor = null, ip = null, { emit } = {}) {
  const row = requireVersionRow(db, ref);
  if (!VERSION_STATUSES.includes(nextStatus)) throw invalidVersion(`Unknown version status: ${nextStatus}`);
  const ts = nowIso();
  const fields = ["status = ?", "lifecycle_state = ?", "updated_at = ?", "updated_by = ?"];
  const params = [nextStatus, nextStatus, ts, actor?.id ?? null];
  if (nextStatus === "active" && !row.released_at) {
    fields.push("released_at = ?");
    params.push(ts);
  }
  if (nextStatus === "superseded") {
    fields.push("superseded_at = ?");
    params.push(ts);
  }
  run(db, `UPDATE versioning_versions SET ${fields.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = queryOne(db, "SELECT * FROM versioning_versions WHERE id = ?", [row.id]);
  recordStateChange(db, {
    actor,
    tenantId: updated.tenant_id,
    action: `versioning.version.${nextStatus}`,
    objectType: "versioning_version",
    objectId: updated.id,
    objectName: updated.version_number,
    before: { status: row.status },
    after: { status: nextStatus },
    ip,
  });
  if (emit) {
    emitDomainEvent(
      db,
      {
        event_type_code: emit,
        source_module: "versioning",
        source_object_type: "versioning_version",
        source_object_id: updated.id,
        tenant_id: updated.tenant_id,
        payload: { version_id: updated.id, revision_id: updated.revision_id, version_number: updated.version_number, status: nextStatus },
      },
      actor
    );
  }
  return serialize(updated);
}

export function activateVersion(db, ref, actor = null, ip = null) {
  return transitionVersion(db, ref, "active", actor, ip, { emit: "VersionActivated" });
}

export function supersedeVersion(db, ref, actor = null, ip = null) {
  return transitionVersion(db, ref, "superseded", actor, ip, { emit: "VersionSuperseded" });
}

export function setDefaultVersion(db, ref, actor = null, ip = null) {
  const row = requireVersionRow(db, ref);
  const ts = nowIso();
  run(db, "UPDATE versioning_versions SET is_default = 0, updated_at = ? WHERE revision_id = ?", [ts, row.revision_id]);
  run(db, "UPDATE versioning_versions SET is_default = 1, updated_at = ? WHERE id = ?", [ts, row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.version.set_default",
    resourceType: "versioning_version",
    resourceId: row.id,
    details: { revision_id: row.revision_id },
    ip,
  });
  return serialize(queryOne(db, "SELECT * FROM versioning_versions WHERE id = ?", [row.id]));
}

export function deleteVersion(db, ref, actor = null, ip = null) {
  const row = requireVersionRow(db, ref);
  if (row.status === "active") throw invalidVersion("Active versions cannot be deleted; retire or supersede first");
  run(db, "DELETE FROM versioning_versions WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.version.delete",
    resourceType: "versioning_version",
    resourceId: row.id,
    details: { version_number: row.version_number },
    ip,
  });
  return { deleted: true, id: row.id };
}

export function compareVersions(db, leftRef, rightRef) {
  const left = requireVersionRow(db, leftRef);
  const right = requireVersionRow(db, rightRef);
  const keys = ["name", "description", "status", "lifecycle_state", "effective_from", "effective_to", "version_sequence", "is_default"];
  const changes = [];
  for (const key of keys) {
    if (String(left[key] ?? "") !== String(right[key] ?? "")) {
      changes.push({ field: key, left: left[key], right: right[key] });
    }
  }
  return {
    left: serialize(left),
    right: serialize(right),
    same_revision: left.revision_id === right.revision_id,
    changes,
    identical: changes.length === 0,
  };
}

// Resolve the version that should be used for a revision in a given context.
// Preference: explicit context version -> matching version-level effectivity ->
// default active version -> latest active version.
export function defaultVersionForRevision(db, revisionId, { isDefaultActive = true } = {}) {
  if (isDefaultActive) {
    const preferred = queryOne(
      db,
      `SELECT * FROM versioning_versions WHERE revision_id = ? AND status = 'active' AND is_default = 1 ORDER BY version_sequence DESC LIMIT 1`,
      [revisionId]
    );
    if (preferred) return preferred;
  }
  return queryOne(
    db,
    `SELECT * FROM versioning_versions WHERE revision_id = ? AND status = 'active' ORDER BY version_sequence DESC LIMIT 1`,
    [revisionId]
  );
}

export function versionHistory(db, ref, { limit = 100 } = {}) {
  const row = requireVersionRow(db, ref);
  const rows = queryAll(
    db,
    `SELECT id, action, actor_id, actor_username AS actor_name, created_at, details FROM audit_logs
     WHERE resource_type = 'versioning_version' AND resource_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    [String(row.id), Number(limit)]
  ).map((entry) => ({
    id: entry.id,
    action: entry.action,
    actor_id: entry.actor_id,
    actor_name: entry.actor_name,
    at: entry.created_at,
    details: safeParse(entry.details, {}),
  }));
  return { version: serialize(row), entries: rows };
}

// SnapshotService — immutable resolved state of enterprise objects at a point in
// time / effectivity context. A snapshot can never be modified after creation;
// it provides historical reconstruction and comparison.
import { createHash } from "node:crypto";
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { writeAudit } from "../audit.js";
import { emitDomainEvent } from "../events/emit.js";
import { publicSnapshot, publicSnapshotObject, normalizeText, safeParse } from "./validation.js";
import { snapshotRef } from "./refs.js";
import { snapshotNotFound, invalidEffectivity } from "./errors.js";
import { resolveOne } from "./engine.js";
import { resolvePolicy } from "./policies.js";
import { getRevisionRow } from "./revisions.js";
import { getVersionRow } from "./versions.js";

function objectsFor(db, snapshotId) {
  return queryAll(db, "SELECT * FROM versioning_snapshot_objects WHERE snapshot_id = ? ORDER BY object_type, object_id", [snapshotId]);
}

export function getSnapshotRow(db, ref) {
  if (ref === undefined || ref === null || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref)) {
    return queryOne(db, "SELECT * FROM versioning_snapshots WHERE id = ?", [numeric]);
  }
  return queryOne(db, "SELECT * FROM versioning_snapshots WHERE snapshot_ref = ? OR code = ?", [String(ref), String(ref)]);
}

export function getSnapshot(db, ref) {
  const row = getSnapshotRow(db, ref);
  if (!row) throw snapshotNotFound(ref);
  return publicSnapshot(row, objectsFor(db, row.id));
}

export function listSnapshots(db, { status, tenantId, q, page = 1, pageSize = 50 } = {}) {
  const clauses = ["1 = 1"];
  const params = [];
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (q) {
    clauses.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${String(q)}%`;
    params.push(like, like, like);
  }
  const where = clauses.join(" AND ");
  const total = queryOne(db, `SELECT COUNT(*) AS count FROM versioning_snapshots WHERE ${where}`, params)?.count ?? 0;
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const rows = queryAll(db, `SELECT * FROM versioning_snapshots WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  return { items: rows.map((row) => publicSnapshot(row, objectsFor(db, row.id))), total, page: Number(page) || 1, page_size: limit };
}

function contentHash(entries) {
  const canonical = entries
    .map((e) => `${e.object_type}:${e.object_id}:${e.revision_id ?? ""}:${e.version_id ?? ""}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

export function createSnapshot(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = normalizeText(input.code);
  if (!code) throw invalidEffectivity("Snapshot code is required");
  const objects = Array.isArray(input.objects) ? input.objects : [];
  const context = input.context ?? {};
  return transaction(db, () => {
    const existing = queryOne(
      db,
      "SELECT id FROM versioning_snapshots WHERE code = ? AND (tenant_id IS NULL OR ? IS NULL OR tenant_id = ?)",
      [code, tenantId, tenantId]
    );
    if (existing) throw invalidEffectivity(`Snapshot ${code} already exists`);
    const policyRow = resolvePolicy(db, input.policy ?? input.policyCode);
    const parent = input.parentSnapshotId ?? input.parent_snapshot_id ?? null;
    if (parent && !getSnapshotRow(db, parent)) throw snapshotNotFound(parent);
    const ts = nowIso();
    const result = run(
      db,
      `INSERT INTO versioning_snapshots
        (snapshot_ref, code, name, description, status, context_json, object_count, content_hash, parent_snapshot_id,
         tenant_id, organization_id, version, created_by, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, 0, '', ?, ?, ?, 1, ?, ?)`,
      [
        snapshotRef(code),
        code,
        normalizeText(input.name, code),
        normalizeText(input.description),
        JSON.stringify(context),
        parent ? Number(parent) : null,
        input.tenantId ?? input.tenant_id ?? tenantId,
        input.organizationId ?? input.organization_id ?? null,
        actor?.id ?? null,
        ts,
      ]
    );
    const id = Number(result.lastInsertRowid);
    const entries = [];
    for (const entry of objects) {
      const objectType = normalizeText(entry.objectType ?? entry.object_type);
      const objectId = normalizeText(entry.objectId ?? entry.object_id ?? entry.id);
      if (!objectType || !objectId) throw invalidEffectivity("Each snapshot object requires objectType and objectId");
      let revision = entry.revisionId || entry.revision_id ? getRevisionRow(db, entry.revisionId ?? entry.revision_id, { objectType }) : null;
      let version = entry.versionId || entry.version_id ? getVersionRow(db, entry.versionId ?? entry.version_id) : null;
      let status = "RESOLVED";
      let reason = "EXPLICIT";
      if (!revision) {
        const resolved = resolveOne(db, { objectType, objectId, rawContext: context, policyRow, actor, tenantId, record: false });
        status = resolved.resolutionStatus;
        reason = resolved.resolutionReason;
        revision = resolved.revision ? getRevisionRow(db, resolved.revision.id) : null;
        version = resolved.version ? getVersionRow(db, resolved.version.id) : null;
      }
      const rowId = run(
        db,
        `INSERT INTO versioning_snapshot_objects
          (snapshot_id, object_type, object_id, revision_id, version_id, revision_code, version_number, resolution_status, resolution_reason, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          objectType,
          objectId,
          revision?.id ?? null,
          version?.id ?? null,
          revision?.revision_code ?? "",
          version?.version_number ?? "",
          revision && status === "RESOLVED" ? status : status === "RESOLVED" ? "NOT_FOUND" : status,
          reason,
          JSON.stringify(entry.metadata ?? {}),
          ts,
        ]
      ).lastInsertRowid;
      entries.push({ object_type: objectType, object_id: objectId, revision_id: revision?.id ?? null, version_id: version?.id ?? null, rowId });
    }
    const hash = contentHash(entries);
    run(db, "UPDATE versioning_snapshots SET object_count = ?, content_hash = ? WHERE id = ?", [entries.length, hash, id]);
    const row = queryOne(db, "SELECT * FROM versioning_snapshots WHERE id = ?", [id]);
    writeAudit(db, {
      actor,
      action: "versioning.snapshot.create",
      resourceType: "versioning_snapshot",
      resourceId: id,
      details: { code, object_count: entries.length, content_hash: hash, context },
      ip,
    });
    emitDomainEvent(
      db,
      {
        event_type_code: "SnapshotCreated",
        source_module: "versioning",
        source_object_type: "versioning_snapshot",
        source_object_id: id,
        tenant_id: row.tenant_id,
        organization_id: row.organization_id,
        payload: { snapshot_id: id, code, object_count: entries.length, content_hash: hash },
      },
      actor
    );
    return publicSnapshot(row, objectsFor(db, id));
  });
}

// Snapshots are immutable by default. Archiving is the only permitted mutation.
export function archiveSnapshot(db, ref, actor = null, ip = null) {
  const row = getSnapshotRow(db, ref);
  if (!row) throw snapshotNotFound(ref);
  run(db, "UPDATE versioning_snapshots SET status = 'archived' WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.snapshot.archive",
    resourceType: "versioning_snapshot",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return publicSnapshot(queryOne(db, "SELECT * FROM versioning_snapshots WHERE id = ?", [row.id]), objectsFor(db, row.id));
}

export function deleteSnapshot(db, ref, actor = null, ip = null) {
  const row = getSnapshotRow(db, ref);
  if (!row) throw snapshotNotFound(ref);
  run(db, "DELETE FROM versioning_snapshot_objects WHERE snapshot_id = ?", [row.id]);
  run(db, "DELETE FROM versioning_snapshots WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.snapshot.delete",
    resourceType: "versioning_snapshot",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return { deleted: true, id: row.id };
}

export function compareSnapshots(db, leftRef, rightRef) {
  const left = getSnapshotRow(db, leftRef);
  const right = getSnapshotRow(db, rightRef);
  if (!left) throw snapshotNotFound(leftRef);
  if (!right) throw snapshotNotFound(rightRef);
  const leftObjects = objectsFor(db, left.id);
  const rightObjects = objectsFor(db, right.id);
  const key = (o) => `${o.object_type}:${o.object_id}`;
  const leftMap = new Map(leftObjects.map((o) => [key(o), o]));
  const rightMap = new Map(rightObjects.map((o) => [key(o), o]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, r] of rightMap.entries()) {
    if (!leftMap.has(k)) added.push(publicSnapshotObject(r));
    else {
      const l = leftMap.get(k);
      if (String(l.revision_id ?? "") !== String(r.revision_id ?? "") || String(l.version_id ?? "") !== String(r.version_id ?? "")) {
        changed.push({ object: k, left: publicSnapshotObject(l), right: publicSnapshotObject(r) });
      }
    }
  }
  for (const [k, l] of leftMap.entries()) {
    if (!rightMap.has(k)) removed.push(publicSnapshotObject(l));
  }
  return {
    left: publicSnapshot(left),
    right: publicSnapshot(right),
    added,
    removed,
    changed,
    identical: !added.length && !removed.length && !changed.length,
  };
}

// Historical reconstruction — the resolved object set recorded at snapshot time.
export function reconstructSnapshot(db, ref) {
  const snapshot = getSnapshot(db, ref);
  return {
    snapshot: snapshot.snapshot_ref,
    created_at: snapshot.created_at,
    context: snapshot.context,
    content_hash: snapshot.content_hash,
    immutable: true,
    objects: snapshot.objects,
  };
}

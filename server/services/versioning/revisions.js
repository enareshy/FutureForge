// RevisionService — controlled evolution of an enterprise object.
//
// Owns revision lifecycle (draft -> active -> superseded/retired/archived),
// default revision selection, revision relationships (supersedes,
// effective_after, effective_before, applicable_with, derived_from) and
// comparison. All mutations are transactional and audited through the shared
// Audit & History framework.
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit, recordStateChange } from "../audit.js";
import { emitDomainEvent } from "../events/emit.js";
import {
  publicRevision,
  publicRelationship,
  normalizeText,
  safeParse,
  assertEnum,
  REVISION_STATUSES,
  RELATIONSHIP_TYPES,
} from "./validation.js";
import { revisionRef } from "./refs.js";
import { revisionNotFound, invalidRevision, invalidRelationship } from "./errors.js";

function serialize(row) {
  return publicRevision(row);
}

function tenantClause(tenantId, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  if (tenantId === undefined || tenantId === null) return { clause: "", params: [] };
  return { clause: ` AND (${prefix}tenant_id IS NULL OR ${prefix}tenant_id = ?)`, params: [Number(tenantId)] };
}

export function listRevisions(db, { objectType, objectId, status, tenantId, q, page = 1, pageSize = 50 } = {}) {
  const clauses = ["1 = 1"];
  const params = [];
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(String(objectType));
  }
  if (objectId) {
    clauses.push("object_id = ?");
    params.push(String(objectId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (q) {
    clauses.push("(revision_code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${String(q)}%`;
    params.push(like, like, like);
  }
  const where = clauses.join(" AND ");
  const total = queryOne(db, `SELECT COUNT(*) AS count FROM versioning_revisions WHERE ${where}`, params)?.count ?? 0;
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const rows = queryAll(
    db,
    `SELECT * FROM versioning_revisions WHERE ${where}
     ORDER BY object_type, object_id, revision_sequence DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { items: rows.map(serialize), total, page: Number(page) || 1, page_size: limit };
}

export function getRevisionRow(db, ref, { objectType } = {}) {
  if (ref === undefined || ref === null || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref)) {
    return queryOne(db, "SELECT * FROM versioning_revisions WHERE id = ?", [numeric]);
  }
  const byRef = queryOne(db, "SELECT * FROM versioning_revisions WHERE revision_ref = ?", [String(ref)]);
  if (byRef) return byRef;
  if (objectType) {
    return queryOne(db, "SELECT * FROM versioning_revisions WHERE object_type = ? AND revision_code = ?", [
      String(objectType),
      String(ref),
    ]);
  }
  return null;
}

export function getRevision(db, ref, { objectType } = {}) {
  const row = getRevisionRow(db, ref, { objectType });
  if (!row) throw revisionNotFound(ref);
  return serialize(row);
}

export function requireRevisionRow(db, ref, opts) {
  const row = getRevisionRow(db, ref, opts);
  if (!row) throw revisionNotFound(ref);
  return row;
}

function validateRevisionInput(input, { partial = false } = {}) {
  const errors = [];
  const objectType = normalizeText(input.objectType ?? input.object_type);
  const objectId = normalizeText(input.objectId ?? input.object_id);
  const revisionCode = normalizeText(input.revisionCode ?? input.revision_code);
  if (!partial) {
    if (!objectType) errors.push("objectType is required");
    if (!objectId) errors.push("objectId is required");
    if (!revisionCode) errors.push("revisionCode is required");
  }
  if (revisionCode && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(revisionCode)) {
    errors.push("revisionCode must be 1-32 characters (letters, digits, dot, underscore, hyphen)");
  }
  assertEnum(input.status, REVISION_STATUSES, "status", errors);
  if (errors.length) throw invalidRevision(errors.join("; "), { errors });
  return { objectType, objectId, revisionCode };
}

export function createRevision(db, input = {}, actor = null, tenantId = null, ip = null) {
  const { objectType, objectId, revisionCode } = validateRevisionInput(input);
  return transaction(db, () => {
    const existing = queryOne(
      db,
      "SELECT id FROM versioning_revisions WHERE object_type = ? AND object_id = ? AND revision_code = ?",
      [objectType, objectId, revisionCode]
    );
    if (existing) throw invalidRevision(`Revision ${revisionCode} already exists for ${objectType} ${objectId}`, { duplicate: true });
    const max = queryOne(
      db,
      "SELECT MAX(revision_sequence) AS max_seq FROM versioning_revisions WHERE object_type = ? AND object_id = ?",
      [objectType, objectId]
    );
    const sequence = Number(max?.max_seq ?? 0) + 1;
    const isDefault = input.isDefault === true || input.is_default === true || sequence === 1;
    const ts = nowIso();
    const status = input.status && REVISION_STATUSES.includes(input.status) ? input.status : "draft";
    if (isDefault) {
      run(
        db,
        "UPDATE versioning_revisions SET is_default = 0, updated_at = ? WHERE object_type = ? AND object_id = ?",
        [ts, objectType, objectId]
      );
    }
    const result = run(
      db,
      `INSERT INTO versioning_revisions
        (revision_ref, object_type, object_id, revision_code, revision_sequence, name, description, status, lifecycle_state,
         is_default, effective_from, effective_to, revision_metadata_json, tenant_id, organization_id, plant_id, site_id,
         version, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        revisionRef(objectType, objectId, revisionCode),
        objectType,
        objectId,
        revisionCode,
        sequence,
        normalizeText(input.name),
        normalizeText(input.description),
        status,
        normalizeText(input.lifecycleState ?? input.lifecycle_state, status),
        isDefault ? 1 : 0,
        normalizeText(input.effectiveFrom ?? input.effective_from) || null,
        normalizeText(input.effectiveTo ?? input.effective_to) || null,
        JSON.stringify(input.metadata ?? input.revision_metadata ?? safeParse(input.revision_metadata_json, {})),
        input.tenantId ?? input.tenant_id ?? tenantId,
        input.organizationId ?? input.organization_id ?? null,
        input.plantId ?? input.plant_id ?? null,
        input.siteId ?? input.site_id ?? null,
        actor?.id ?? null,
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
    const row = queryOne(db, "SELECT * FROM versioning_revisions WHERE id = ?", [Number(result.lastInsertRowid)]);
    writeAudit(db, {
      actor,
      action: "versioning.revision.create",
      resourceType: "versioning_revision",
      resourceId: row.id,
      details: { object_type: objectType, object_id: objectId, revision_code: revisionCode, sequence },
      ip,
    });
    emitDomainEvent(
      db,
      {
        event_type_code: "RevisionCreated",
        source_module: "versioning",
        source_object_type: "versioning_revision",
        source_object_id: row.id,
        tenant_id: row.tenant_id,
        organization_id: row.organization_id,
        payload: { revision_id: row.id, object_type: objectType, object_id: objectId, revision_code: revisionCode, sequence },
      },
      actor
    );
    return serialize(row);
  });
}

export function updateRevision(db, ref, patch = {}, actor = null, ip = null) {
  const row = requireRevisionRow(db, ref, { objectType: patch.objectType ?? patch.object_type });
  validateRevisionInput(patch, { partial: true });
  const before = serialize(row);
  const fields = [];
  const params = [];
  const set = (column, value) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) set("name", normalizeText(patch.name));
  if (patch.description !== undefined) set("description", normalizeText(patch.description));
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.lifecycleState !== undefined || patch.lifecycle_state !== undefined) {
    set("lifecycle_state", normalizeText(patch.lifecycleState ?? patch.lifecycle_state));
  }
  if (patch.effectiveFrom !== undefined || patch.effective_from !== undefined) {
    set("effective_from", normalizeText(patch.effectiveFrom ?? patch.effective_from) || null);
  }
  if (patch.effectiveTo !== undefined || patch.effective_to !== undefined) {
    set("effective_to", normalizeText(patch.effectiveTo ?? patch.effective_to) || null);
  }
  if (patch.metadata !== undefined || patch.revision_metadata !== undefined) {
    set("revision_metadata_json", JSON.stringify(patch.metadata ?? patch.revision_metadata ?? {}));
  }
  if (patch.organizationId !== undefined || patch.organization_id !== undefined) {
    set("organization_id", patch.organizationId ?? patch.organization_id ?? null);
  }
  if (patch.plantId !== undefined || patch.plant_id !== undefined) {
    set("plant_id", patch.plantId ?? patch.plant_id ?? null);
  }
  if (patch.siteId !== undefined || patch.site_id !== undefined) {
    set("site_id", patch.siteId ?? patch.site_id ?? null);
  }
  if (patch.isDefault === true || patch.is_default === true) {
    run(
      db,
      "UPDATE versioning_revisions SET is_default = 0, updated_at = ? WHERE object_type = ? AND object_id = ?",
      [nowIso(), row.object_type, row.object_id]
    );
    set("is_default", 1);
  } else if (patch.isDefault === false || patch.is_default === false) {
    set("is_default", 0);
  }
  const expectedVersion = patch.version !== undefined ? Number(patch.version) : Number(row.version);
  if (fields.length) {
    set("updated_by", actor?.id ?? null);
    set("version", Number(row.version) + 1);
    set("updated_at", nowIso());
    const result = run(db, `UPDATE versioning_revisions SET ${fields.join(", ")} WHERE id = ? AND version = ?`, [
      ...params,
      row.id,
      expectedVersion,
    ]);
    if (!Number(result.changes)) throw new HttpError(409, "Revision was modified concurrently; reload and retry", {
      code: "VERSIONING_CONCURRENCY_CONFLICT",
    });
  }
  const updated = queryOne(db, "SELECT * FROM versioning_revisions WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.revision.update",
    resourceType: "versioning_revision",
    resourceId: row.id,
    details: { before, after: serialize(updated) },
    ip,
  });
  emitDomainEvent(
    db,
    {
      event_type_code: "RevisionChanged",
      source_module: "versioning",
      source_object_type: "versioning_revision",
      source_object_id: row.id,
      tenant_id: updated.tenant_id,
      payload: { revision_id: row.id, revision_code: updated.revision_code },
    },
    actor
  );
  return serialize(updated);
}

function transitionRevision(db, ref, nextStatus, actor, ip, { emit } = {}) {
  const row = requireRevisionRow(db, ref);
  if (!REVISION_STATUSES.includes(nextStatus)) throw invalidRevision(`Unknown revision status: ${nextStatus}`);
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
  run(db, `UPDATE versioning_revisions SET ${fields.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = queryOne(db, "SELECT * FROM versioning_revisions WHERE id = ?", [row.id]);
  recordStateChange(db, {
    actor,
    tenantId: updated.tenant_id,
    organizationId: updated.organization_id,
    action: `versioning.revision.${nextStatus}`,
    objectType: "versioning_revision",
    objectId: updated.id,
    objectName: updated.revision_code,
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
        source_object_type: "versioning_revision",
        source_object_id: updated.id,
        tenant_id: updated.tenant_id,
        payload: { revision_id: updated.id, revision_code: updated.revision_code, status: nextStatus },
      },
      actor
    );
  }
  return serialize(updated);
}

export function activateRevision(db, ref, actor = null, ip = null) {
  return transitionRevision(db, ref, "active", actor, ip, { emit: "RevisionActivated" });
}

export function supersedeRevision(db, ref, actor = null, ip = null) {
  return transitionRevision(db, ref, "superseded", actor, ip, { emit: "RevisionSuperseded" });
}

export function retireRevision(db, ref, actor = null, ip = null) {
  return transitionRevision(db, ref, "retired", actor, ip, {});
}

export function setDefaultRevision(db, ref, actor = null, ip = null) {
  const row = requireRevisionRow(db, ref);
  const ts = nowIso();
  run(
    db,
    "UPDATE versioning_revisions SET is_default = 0, updated_at = ? WHERE object_type = ? AND object_id = ?",
    [ts, row.object_type, row.object_id]
  );
  run(db, "UPDATE versioning_revisions SET is_default = 1, updated_at = ? WHERE id = ?", [ts, row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.revision.set_default",
    resourceType: "versioning_revision",
    resourceId: row.id,
    details: { object_type: row.object_type, object_id: row.object_id },
    ip,
  });
  return serialize(queryOne(db, "SELECT * FROM versioning_revisions WHERE id = ?", [row.id]));
}

export function deleteRevision(db, ref, actor = null, ip = null) {
  const row = requireRevisionRow(db, ref);
  if (row.status === "active") throw invalidRevision("Active revisions cannot be deleted; retire or supersede first");
  const counts = queryOne(db, "SELECT COUNT(*) AS c FROM versioning_versions WHERE revision_id = ?", [row.id]);
  if (Number(counts?.c ?? 0) > 0) throw invalidRevision("Revision has versions and cannot be deleted");
  run(db, "DELETE FROM versioning_revisions WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.revision.delete",
    resourceType: "versioning_revision",
    resourceId: row.id,
    details: { revision_code: row.revision_code },
    ip,
  });
  return { deleted: true, id: row.id };
}

// ── Relationships ───────────────────────────────────────────────────────────

export function listRelationships(db, revisionRefValue, { direction = "both", type } = {}) {
  const row = requireRevisionRow(db, revisionRefValue);
  const params = [];
  const clauses = [];
  if (direction === "from" || direction === "both") {
    clauses.push("from_revision_id = ?");
    params.push(row.id);
    if (direction === "both") {
      clauses.push("to_revision_id = ?");
      params.push(row.id);
    }
  } else {
    clauses.push("to_revision_id = ?");
    params.push(row.id);
  }
  let where = `(${clauses.join(" OR ")})`;
  const typeParams = [];
  if (type) {
    where += " AND relationship_type = ?";
    typeParams.push(String(type));
  }
  return queryAll(db, `SELECT * FROM versioning_revision_relationships WHERE ${where} ORDER BY created_at DESC`, [
    ...params,
    ...typeParams,
  ]).map(publicRelationship);
}

function wouldCreateCycle(db, fromId, toId) {
  const adjacency = new Map();
  for (const edge of queryAll(db, "SELECT from_revision_id AS f, to_revision_id AS t FROM versioning_revision_relationships")) {
    if (!adjacency.has(edge.f)) adjacency.set(edge.f, []);
    adjacency.get(edge.f).push(edge.t);
  }
  const stack = [toId];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (current === fromId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) || []) stack.push(next);
  }
  return false;
}

export function createRelationship(db, revisionRefValue, input = {}, actor = null, ip = null) {
  const from = requireRevisionRow(db, revisionRefValue);
  const toRef = input.toRevisionId ?? input.to_revision_id ?? input.toRevision ?? input.to;
  const relationshipType = normalizeText(input.relationshipType ?? input.relationship_type ?? input.type);
  if (!toRef) throw invalidRelationship("toRevisionId is required");
  if (!relationshipType || !RELATIONSHIP_TYPES.includes(relationshipType)) {
    throw invalidRelationship(`relationshipType must be one of: ${RELATIONSHIP_TYPES.join(", ")}`);
  }
  if (String(toRef) === String(from.revision_ref) || String(toRef) === String(from.id)) {
    throw invalidRelationship("A revision cannot relate to itself");
  }
  const to = requireRevisionRow(db, toRef);
  if (wouldCreateCycle(db, from.id, to.id)) {
    throw invalidRelationship("Relationship would create a circular revision graph", { from: from.revision_ref, to: to.revision_ref });
  }
  const existing = queryOne(
    db,
    "SELECT id FROM versioning_revision_relationships WHERE from_revision_id = ? AND to_revision_id = ? AND relationship_type = ?",
    [from.id, to.id, relationshipType]
  );
  if (existing) throw invalidRelationship("Relationship already exists", { id: existing.id });
  const result = run(
    db,
    `INSERT INTO versioning_revision_relationships (from_revision_id, to_revision_id, relationship_type, description, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [from.id, to.id, relationshipType, normalizeText(input.description), actor?.id ?? null, nowIso()]
  );
  const row = queryOne(db, "SELECT * FROM versioning_revision_relationships WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, {
    actor,
    action: "versioning.revision.relationship.create",
    resourceType: "versioning_revision_relationship",
    resourceId: row.id,
    details: { from: from.revision_ref, to: to.revision_ref, type: relationshipType },
    ip,
  });
  return publicRelationship(row);
}

export function deleteRelationship(db, revisionRefValue, relationshipId, actor = null, ip = null) {
  const from = requireRevisionRow(db, revisionRefValue);
  const row = queryOne(db, "SELECT * FROM versioning_revision_relationships WHERE id = ? AND from_revision_id = ?", [
    Number(relationshipId),
    from.id,
  ]);
  if (!row) throw invalidRelationship("Relationship not found", { id: relationshipId });
  run(db, "DELETE FROM versioning_revision_relationships WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.revision.relationship.delete",
    resourceType: "versioning_revision_relationship",
    resourceId: row.id,
    details: { from: row.from_revision_id, to: row.to_revision_id, type: row.relationship_type },
    ip,
  });
  return { deleted: true, id: row.id };
}

export function compareRevisions(db, leftRef, rightRef) {
  const left = requireRevisionRow(db, leftRef);
  const right = requireRevisionRow(db, rightRef);
  const keys = [
    "name",
    "description",
    "status",
    "lifecycle_state",
    "effective_from",
    "effective_to",
    "revision_sequence",
    "is_default",
  ];
  const changes = [];
  for (const key of keys) {
    const a = left[key];
    const b = right[key];
    if (String(a ?? "") !== String(b ?? "")) {
      changes.push({ field: key, left: a, right: b });
    }
  }
  return {
    left: serialize(left),
    right: serialize(right),
    same_object: left.object_type === right.object_type && left.object_id === right.object_id,
    changes,
    identical: changes.length === 0,
  };
}

export function revisionHistory(db, ref, { limit = 100 } = {}) {
  const row = requireRevisionRow(db, ref);
  const rows = queryAll(
    db,
    `SELECT id, action, actor_id, actor_username AS actor_name, created_at, details
     FROM audit_logs
     WHERE resource_type = 'versioning_revision' AND resource_id = ?
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
  return { revision: serialize(row), entries: rows };
}

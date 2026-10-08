// Requirement object mirror for the Requirement -> PDM integration.
//
// Requirements Manager owns requirement state, but the Digital Thread resolves
// a requirement node through the Object & Relationship Framework using the
// registered `requirement` metadata type. This module ensures every requirement
// has a generic object id (creating the object through the existing Object
// framework the first time) without introducing a second identity model.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { createObject, createObjectAsync } from "../objects/objects.js";
import { REQUIREMENT_OBJECT_TYPE } from "../requirements/constants.js";

const OBJECT_STATUS_BY_REQUIREMENT = Object.freeze({
  DRAFT: "draft",
  IN_REVIEW: "draft",
  REJECTED: "draft",
  APPROVED: "active",
  RELEASED: "released",
  IMPLEMENTED: "released",
  VERIFIED: "released",
  VALIDATED: "released",
  OBSOLETE: "obsolete",
  WITHDRAWN: "obsolete",
});

function objectStatus(status) {
  return OBJECT_STATUS_BY_REQUIREMENT[String(status || "DRAFT").toUpperCase()] || "draft";
}

function linkObject(db, requirementId, objectId, actor) {
  run(db, "UPDATE requirements SET object_id = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    Number(objectId),
    actor?.id ?? null,
    nowIso(),
    Number(requirementId),
  ]);
}

async function linkObjectAsync(db, requirementId, objectId, actor) {
  await runAsync(db, "UPDATE requirements SET object_id = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    Number(objectId),
    actor?.id ?? null,
    nowIso(),
    Number(requirementId),
  ]);
}

export function ensureRequirementObject(db, tenantId, requirement, actor = null, ip = null) {
  if (!requirement) return { object_id: null, created: false, reason: "requirement_missing" };
  if (requirement.object_id) return { object_id: requirement.object_id, created: false };
  try {
    const created = createObject(
      db,
      {
        type: REQUIREMENT_OBJECT_TYPE,
        code: requirement.requirement_number || requirement.requirement_ref,
        name: requirement.title || requirement.name || requirement.requirement_ref || requirement.requirement_number,
        description: requirement.description || "",
        status: objectStatus(requirement.status),
      },
      actor,
      Number(tenantId),
      ip
    );
    const objectId = created?.id ?? null;
    if (objectId) linkObject(db, requirement.id, objectId, actor);
    return { object_id: objectId, created: Boolean(objectId) };
  } catch (error) {
    return { object_id: requirement.object_id ?? null, created: false, error: error?.message || String(error) };
  }
}

export async function ensureRequirementObjectAsync(db, tenantId, requirement, actor = null, ip = null) {
  if (!requirement) return { object_id: null, created: false, reason: "requirement_missing" };
  if (requirement.object_id) return { object_id: requirement.object_id, created: false };
  try {
    const created = await createObjectAsync(
      db,
      {
        type: REQUIREMENT_OBJECT_TYPE,
        code: requirement.requirement_number || requirement.requirement_ref,
        name: requirement.title || requirement.name || requirement.requirement_ref || requirement.requirement_number,
        description: requirement.description || "",
        status: objectStatus(requirement.status),
      },
      actor,
      Number(tenantId),
      ip
    );
    const objectId = created?.id ?? null;
    if (objectId) await linkObjectAsync(db, requirement.id, objectId, actor);
    return { object_id: objectId, created: Boolean(objectId) };
  } catch (error) {
    return { object_id: requirement.object_id ?? null, created: false, error: error?.message || String(error) };
  }
}

// Backfills requirement object ids for a tenant (or a bounded batch). Idempotent
// and safe on every boot; used to onboard requirements created before the
// integration existed.
export function backfillRequirementObjects(db, tenantId, { limit = 500, actor = null, ip = null } = {}) {
  const rows = queryAll(
    db,
    "SELECT id, requirement_ref, requirement_number, title, name, description, requirement_type, status, object_id FROM requirements WHERE tenant_id = ? AND (object_id IS NULL OR object_id = 0) ORDER BY id LIMIT ?",
    [Number(tenantId), Number(limit)]
  );
  let created = 0;
  const failures = [];
  for (const row of rows) {
    const result = ensureRequirementObject(db, tenantId, row, actor, ip);
    if (result.created) created += 1;
    else if (result.error) failures.push({ requirement_id: row.id, error: result.error });
  }
  return { scanned: rows.length, created, failures };
}

export async function backfillRequirementObjectsAsync(db, tenantId, { limit = 500, actor = null, ip = null } = {}) {
  const rows = await queryAllAsync(
    db,
    "SELECT id, requirement_ref, requirement_number, title, name, description, requirement_type, status, object_id FROM requirements WHERE tenant_id = ? AND (object_id IS NULL OR object_id = 0) ORDER BY id LIMIT ?",
    [Number(tenantId), Number(limit)]
  );
  let created = 0;
  const failures = [];
  for (const row of rows) {
    const result = await ensureRequirementObjectAsync(db, tenantId, row, actor, ip);
    if (result.created) created += 1;
    else if (result.error) failures.push({ requirement_id: row.id, error: result.error });
  }
  return { scanned: rows.length, created, failures };
}

export function requirementObjectId(db, tenantId, requirementId) {
  const row = queryOne(db, "SELECT object_id FROM requirements WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(requirementId)]);
  return row?.object_id ?? null;
}

export async function requirementObjectIdAsync(db, tenantId, requirementId) {
  const row = await queryOneAsync(db, "SELECT object_id FROM requirements WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(requirementId)]);
  return row?.object_id ?? null;
}

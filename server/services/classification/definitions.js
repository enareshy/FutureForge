// Classification definitions: the semantic domains that own a class hierarchy
// (for example "Mechanical" or "Regulated Equipment"). Anything an
// administrator can change — code, status, ownership, effective dating — is
// data. Definitions are versioned; historical assignments keep pointing at the
// version they were made against.
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { publicClassification, publicClassificationVersion } from "./repository.js";
import { classificationRef } from "./refs.js";
import { SOURCE_MODULE } from "./constants.js";
import {
  normalizeText,
  normalizeUpper,
  parseObject,
  paginate,
  orderClause,
  requireCode,
  requireName,
  assertClassificationStatus,
  assertApprovalStatus,
} from "./validation.js";
import {
  classificationNotFound,
  classificationConflict,
  invalidClassification,
  classificationImmutable,
  classificationObsolete,
} from "./errors.js";
import { recordChange, listHistory } from "./history.js";
import { publishClassificationEvent, classificationEventCode } from "./events.js";
import { bumpEpoch, invalidate } from "./cache.js";

const COLUMNS = [
  "organization_id",
  "code",
  "name",
  "description",
  "status",
  "version",
  "owner_user_id",
  "steward_user_id",
  "approval_status",
  "effective_date",
  "obsolete_date",
  "metadata_json",
  "updated_by",
];

export function getClassificationRow(db, tenantId, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM cla_classifications WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM cla_classifications WHERE tenant_id = ? AND code = ?", [Number(tenantId), normalizeUpper(ref)]);
}

export function requireClassificationRow(db, tenantId, ref) {
  const row = getClassificationRow(db, tenantId, ref);
  if (!row) throw classificationNotFound(ref);
  return row;
}

export function publicClassificationSafe(row) {
  return publicClassification(row);
}

export function createClassification(db, tenantId, body = {}, actor = null, ip = null) {
  const code = normalizeUpper(requireCode(body.code));
  if (!code) throw invalidClassification("Classification code is required");
  if (getClassificationRow(db, tenantId, code)) throw classificationConflict(code);
  const ts = nowIso();
  const status = assertClassificationStatus(body.status || "DRAFT");
  const result = run(
    db,
    `INSERT INTO cla_classifications
       (classification_ref, tenant_id, organization_id, code, name, description, status, version,
        owner_user_id, steward_user_id, approval_status, effective_date, obsolete_date, metadata_json,
        created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      classificationRef(code),
      Number(tenantId),
      body.organization_id != null ? Number(body.organization_id) : null,
      code,
      normalizeText(requireName(body.name ?? code), { max: 200 }),
      normalizeText(body.description, { max: 2000 }),
      status,
      body.owner_user_id != null ? Number(body.owner_user_id) : actor?.id ?? null,
      body.steward_user_id != null ? Number(body.steward_user_id) : null,
      assertApprovalStatus(body.approval_status || "PENDING"),
      normalizeText(body.effective_date, { max: 40 }) || null,
      normalizeText(body.obsolete_date, { max: 40 }) || null,
      JSON.stringify(parseObject(body.metadata, {})),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const id = Number(result.lastInsertRowid);
  invalidate(tenantId);
  recordChange(db, {
    tenantId,
    organizationId: body.organization_id ?? null,
    entityType: "CLASSIFICATION",
    entityId: id,
    entityRef: code,
    action: "CREATED",
    version: 1,
    status,
    after: publicClassification(queryOne(db, "SELECT * FROM cla_classifications WHERE id = ?", [id])),
    actor,
    ip,
  });
  publishCreateEvent(db, id, tenantId, actor);
  return publicClassification(queryOne(db, "SELECT * FROM cla_classifications WHERE id = ?", [id]));
}

function publishCreateEvent(db, id, tenantId, actor) {
  publishClassificationEvent(
    db,
    { eventType: classificationEventCode("CLASSIFICATION_CREATED"), payload: { classification_id: id }, objectType: "classification", objectId: id, tenantId },
    actor
  );
}

export function listClassifications(db, { tenantId, status, ownerId, q, approvalStatus, page, pageSize, sort } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (approvalStatus) {
    clauses.push("approval_status = ?");
    params.push(normalizeUpper(approvalStatus));
  }
  if (ownerId) {
    clauses.push("owner_user_id = ?");
    params.push(Number(ownerId));
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(description) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 200 });
  const { clause: order, params: orderParams } = orderClause(sort, {
    allowed: ["code", "name", "status", "created_at", "updated_at", "version"],
    default: "code",
    direction: "ASC",
  });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM cla_classifications ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM cla_classifications ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, ...orderParams, limit, offset]);
  return { items: rows.map(publicClassification), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function getClassification(db, tenantId, ref) {
  return publicClassification(requireClassificationRow(db, tenantId, ref));
}

export function updateClassification(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const row = requireClassificationRow(db, tenantId, ref);
  if (row.status === "OBSOLETE") throw classificationImmutable(row.code, row.status);
  const before = publicClassification(row);
  const patch = {
    name: body.name === undefined ? row.name : normalizeText(requireName(body.name), { max: 200 }),
    description: body.description === undefined ? row.description : normalizeText(body.description, { max: 2000 }),
    owner_user_id: body.owner_user_id === undefined ? row.owner_user_id : body.owner_user_id != null ? Number(body.owner_user_id) : null,
    steward_user_id: body.steward_user_id === undefined ? row.steward_user_id : body.steward_user_id != null ? Number(body.steward_user_id) : null,
    approval_status: body.approval_status === undefined ? row.approval_status : assertApprovalStatus(body.approval_status),
    effective_date: body.effective_date === undefined ? row.effective_date : normalizeText(body.effective_date, { max: 40 }) || null,
    obsolete_date: body.obsolete_date === undefined ? row.obsolete_date : normalizeText(body.obsolete_date, { max: 40 }) || null,
    organization_id: body.organization_id === undefined ? row.organization_id : body.organization_id != null ? Number(body.organization_id) : null,
    metadata_json: body.metadata === undefined ? row.metadata_json : JSON.stringify(parseObject(body.metadata, {})),
    updated_by: actor?.id ?? null,
  };
  const keys = Object.keys(patch).filter((key) => patch[key] !== undefined);
  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  run(db, `UPDATE cla_classifications SET ${assignments}, updated_at = ? WHERE id = ?`, [...keys.map((key) => patch[key]), nowIso(), row.id]);
  const after = publicClassification(queryOne(db, "SELECT * FROM cla_classifications WHERE id = ?", [row.id]));
  invalidate(tenantId);
  recordChange(db, {
    tenantId,
    organizationId: row.organization_id,
    entityType: "CLASSIFICATION",
    entityId: row.id,
    entityRef: row.code,
    action: "UPDATED",
    version: row.version,
    status: row.status,
    before,
    after,
    actor,
    ip,
  });
  publishClassificationEvent(
    db,
    { eventType: classificationEventCode("CLASSIFICATION_UPDATED"), payload: { classification_id: row.id }, objectType: "classification", objectId: row.id, tenantId },
    actor
  );
  return after;
}

export function setClassificationStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = requireClassificationRow(db, tenantId, ref);
  const next = assertClassificationStatus(status);
  if (row.status === "OBSOLETE" && next !== "OBSOLETE") throw classificationImmutable(row.code, row.status);
  const before = publicClassification(row);
  run(db, "UPDATE cla_classifications SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [next, actor?.id ?? null, nowIso(), row.id]);
  const after = publicClassification(queryOne(db, "SELECT * FROM cla_classifications WHERE id = ?", [row.id]));
  invalidate(tenantId);
  recordChange(db, {
    tenantId,
    organizationId: row.organization_id,
    entityType: "CLASSIFICATION",
    entityId: row.id,
    entityRef: row.code,
    action: next === "ACTIVE" ? "ACTIVATED" : next === "OBSOLETE" ? "DEPRECATED" : "STATUS_CHANGED",
    version: row.version,
    status: next,
    before,
    after,
    actor,
    ip,
  });
  const eventKey = next === "ACTIVE" ? "CLASSIFICATION_ACTIVATED" : next === "OBSOLETE" ? "CLASSIFICATION_DEPRECATED" : "CLASSIFICATION_UPDATED";
  publishClassificationEvent(
    db,
    { eventType: classificationEventCode(eventKey), payload: { classification_id: row.id, status: next }, objectType: "classification", objectId: row.id, tenantId },
    actor
  );
  return after;
}

export function approveClassification(db, tenantId, ref, actor = null, ip = null) {
  const row = requireClassificationRow(db, tenantId, ref);
  const before = publicClassification(row);
  run(db, "UPDATE cla_classifications SET approval_status = 'APPROVED', updated_by = ?, updated_at = ? WHERE id = ?", [actor?.id ?? null, nowIso(), row.id]);
  const after = publicClassification(queryOne(db, "SELECT * FROM cla_classifications WHERE id = ?", [row.id]));
  recordChange(db, { tenantId, entityType: "CLASSIFICATION", entityId: row.id, entityRef: row.code, action: "APPROVED", version: row.version, status: row.status, before, after, actor, ip });
  return after;
}

export function deleteClassification(db, tenantId, ref, actor = null, ip = null) {
  const row = requireClassificationRow(db, tenantId, ref);
  const classes = Number(queryOne(db, "SELECT COUNT(*) AS c FROM cla_classes WHERE classification_id = ?", [row.id])?.c || 0);
  const assignments = Number(queryOne(db, "SELECT COUNT(*) AS c FROM cla_assignments WHERE classification_id = ?", [row.id])?.c || 0);
  if (classes > 0 || assignments > 0) {
    throw classificationConflict(`Classification ${row.code} has ${classes} class(es) and ${assignments} assignment(s); obsolete it instead`);
  }
  run(db, "DELETE FROM cla_classifications WHERE id = ?", [row.id]);
  invalidate(tenantId);
  recordChange(db, {
    tenantId,
    entityType: "CLASSIFICATION",
    entityId: row.id,
    entityRef: row.code,
    action: "DELETED",
    version: row.version,
    status: row.status,
    before: publicClassification(row),
    actor,
    ip,
  });
  return { deleted: true, id: row.id, code: row.code };
}

// ── Versioning ───────────────────────────────────────────────────────────────

export function createClassificationVersion(db, tenantId, ref, { changeReason = "", actor = null } = {}) {
  const row = requireClassificationRow(db, tenantId, ref);
  return transaction(db, () => {
    const version = Number(row.version || 1) + 1;
    run(db, "UPDATE cla_classifications SET version = ?, updated_by = ?, updated_at = ? WHERE id = ?", [version, actor?.id ?? null, nowIso(), row.id]);
    const snapshot = publicClassification(queryOne(db, "SELECT * FROM cla_classifications WHERE id = ?", [row.id]));
    run(
      db,
      `INSERT INTO cla_classification_versions (classification_id, tenant_id, version, status, snapshot_json, change_reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, Number(tenantId), version, row.status, JSON.stringify(snapshot), normalizeText(changeReason, { max: 500 }), actor?.id ?? null, nowIso()]
    );
    invalidate(tenantId);
    recordChange(db, {
      tenantId,
      entityType: "CLASSIFICATION",
      entityId: row.id,
      entityRef: row.code,
      action: "VERSIONED",
      version,
      status: row.status,
      details: { change_reason: changeReason },
      actor,
    });
    return { version, snapshot };
  });
}

export function listClassificationVersions(db, tenantId, ref) {
  const row = requireClassificationRow(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM cla_classification_versions WHERE classification_id = ? ORDER BY version DESC", [row.id]);
  return { items: rows.map(publicClassificationVersion), total: rows.length };
}

export function listClassificationAudit(db, options = {}) {
  return listHistory(db, { ...options, entityType: "CLASSIFICATION" });
}

export { classificationObsolete };

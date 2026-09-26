// Archiving and cold storage.
//
// Archiving packages an object's metadata into a durable archive manifest
// (metadata, identifier, version, relationships, business metadata,
// classification, lifecycle + retention info, checksum, timestamp, original
// storage reference, schema version), stores it through a provider and records
// the evidence. Physical file storage is delegated to the File Storage service
// via the provider abstraction; this module never stores files itself.
import { createHash } from "node:crypto";
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";
import { archiveRef } from "./refs.js";
import { publicArchiveRecord } from "./repository.js";
import { archiveFailed, archiveNotFound, invalidArchive } from "./errors.js";
import { assertTenantId, normalizeText, paginate } from "./validation.js";
import { requireObjectLifecycle, changeState } from "./objects.js";
import { relationshipsForObject } from "../objects.js";
import { resolvePolicy } from "./policies.js";
import { evaluateEligibility } from "./eligibility.js";
import { getArchiveProvider, resolveProviderCode } from "./providers.js";
import { recordHistory } from "./history.js";
import { publishLifecycleEvent } from "./events.js";
import { notifyLifecycleEvent } from "./notifications.js";

export { publicArchiveRecord };

const SCHEMA_VERSION = 1;

export function getLatestArchiveRow(db, { tenantId, objectType, objectId }) {
  return queryOne(
    db,
    "SELECT * FROM lc_archive_records WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND status IN ('stored', 'restored') ORDER BY id DESC LIMIT 1",
    [Number(tenantId), normalizeText(objectType, { max: 120 }), String(objectId)]
  );
}

export function getArchiveRow(db, tenantId, ref) {
  return queryOne(db, "SELECT * FROM lc_archive_records WHERE tenant_id = ? AND (archive_ref = ? OR CAST(id AS TEXT) = ?)", [
    Number(tenantId),
    String(ref),
    String(ref),
  ]);
}

export function requireArchive(db, tenantId, ref) {
  const row = getArchiveRow(db, tenantId, ref);
  if (!row) throw archiveNotFound(ref);
  return row;
}

export function getArchiveRecord(db, tenantId, ref) {
  return publicArchiveRecord(requireArchive(db, tenantId, ref));
}

export function listArchiveRecords(db, { tenantId, objectType, objectId, status, providerCode, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(normalizeText(objectType, { max: 120 }));
  }
  if (objectId !== undefined && objectId !== null && objectId !== "") {
    clauses.push("object_id = ?");
    params.push(String(objectId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status).toLowerCase());
  }
  if (providerCode) {
    clauses.push("provider_code = ?");
    params.push(normalizeText(providerCode).toLowerCase());
  }
  const term = normalizeText(q, { max: 200 });
  if (term) {
    clauses.push("(object_id LIKE ? OR object_ref LIKE ? OR archive_ref LIKE ?)");
    const like = `%${term}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM lc_archive_records ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM lc_archive_records ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicArchiveRecord), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

function relationshipsSnapshot(db, row, tenantId) {
  const capturedAt = nowIso();
  try {
    const result = relationshipsForObject(db, String(row.object_id), tenantId);
    const map = (rel, direction) => ({
      relationship_id: rel.id,
      type: rel.relationship_type_code || rel.type_code || rel.relationship_type_id || null,
      semantic: rel.semantic || null,
      direction,
      other_object_id: String(direction === "outgoing" ? rel.target_object_id : rel.source_object_id),
      status: rel.status || "active",
    });
    return {
      resolved: true,
      outgoing: (result.outgoing || []).map((r) => map(r, "outgoing")),
      incoming: (result.incoming || []).map((r) => map(r, "incoming")),
      captured_at: capturedAt,
    };
  } catch {
    return { resolved: false, outgoing: [], incoming: [], captured_at: capturedAt };
  }
}

export function buildArchivePayload(db, { tenantId, row, reason = "", businessMetadata = {} }) {
  const policyResolution = resolvePolicy(db, {
    tenantId,
    objectType: row.object_type,
    objectId: row.object_id,
    organizationId: row.organization_id,
    plantId: row.plant_id,
    classification: row.classification,
    lifecycleState: row.current_state,
  });
  const relationships = relationshipsSnapshot(db, row, tenantId);
  return {
    schema_version: SCHEMA_VERSION,
    manifest_type: "DATA_LIFECYCLE_ARCHIVE",
    tenant_id: Number(tenantId),
    object: {
      object_type: row.object_type,
      object_id: String(row.object_id),
      object_ref: row.object_ref || "",
      object_version: row.version,
    },
    identifier: {
      lifecycle_id: row.id,
      archive_ref: null,
    },
    lifecycle: {
      state_at_archive: row.current_state,
      data_tier: row.data_tier,
      retention_policy_ref: policyResolution.policy?.policy_ref ?? null,
      retention_basis: row.retention_basis,
      retention_anchor: row.retention_anchor,
      archive_eligible_at: row.archive_eligible_at,
      cold_storage_at: row.cold_storage_at,
      purge_eligible_at: row.purge_eligible_at,
    },
    classification: row.classification || "internal",
    relationships,
    business_metadata: businessMetadata && typeof businessMetadata === "object" ? businessMetadata : {},
    original_storage_reference: { object_type: row.object_type, object_id: String(row.object_id), object_ref: row.object_ref || "" },
    reason: normalizeText(reason),
    archived_at: nowIso(),
  };
}

function checksumPayload(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// Archive one object. Returns the archive record. When the object is not
// eligible the call fails unless `force` is set by an authorized caller.
export async function archiveObject(db, { tenantId, objectType, objectId, reason = "", actor = null, ip = null, idempotencyKey = "", force = false, providerCode = null, businessMetadata = {} } = {}) {
  const tid = assertTenantId(tenantId);
  const row = requireObjectLifecycle(db, tid, objectType, objectId);

  if (idempotencyKey) {
    const existing = queryOne(db, "SELECT * FROM lc_archive_records WHERE tenant_id = ? AND idempotency_key = ?", [tid, String(idempotencyKey)]);
    if (existing) return publicArchiveRecord(existing);
  }

  const evaluation = evaluateEligibility(db, { tenantId: tid, objectType, objectId, action: "ARCHIVE", force });
  if (evaluation.blocked && !force) {
    throw invalidArchive("Object is not eligible for archiving", { reasons: evaluation.reasons.filter((r) => r.severity === "BLOCKED") });
  }

  const providerName = normalizeText(providerCode) || resolveProviderCode(db, tid);
  const provider = getArchiveProvider(providerName);

  publishLifecycleEvent(
    db,
    { eventType: "ObjectArchiveStarted", tenantId: tid, objectType, objectId, payload: { provider: provider.code } },
    actor
  );

  const payload = buildArchivePayload(db, { tenantId: tid, row, reason, businessMetadata });
  const archiveRefValue = archiveRef(objectType, objectId);
  payload.identifier.archive_ref = archiveRefValue;
  const manifestChecksum = checksumPayload(payload);
  const ts = nowIso();

  let stored;
  try {
    stored = await provider.store(db, { tenantId: tid, key: archiveRefValue, payload });
  } catch (error) {
    writeAudit(db, { actor, action: "data_lifecycle.archive.failed", resourceType: "lc_archive_records", resourceId: archiveRefValue, details: { error: error.message }, ip });
    publishLifecycleEvent(db, { eventType: "LifecycleOperationFailed", tenantId: tid, objectType, objectId, payload: { operation: "ARCHIVE", error: error.message } }, actor);
    throw archiveFailed(`Archive storage failed: ${error.message}`, { provider: provider.code });
  }

  payload.archive_checksum = manifestChecksum;
  const manifestJson = JSON.stringify(payload);
  const result = run(
    db,
    `INSERT INTO lc_archive_records (archive_ref, tenant_id, object_type, object_id, object_ref, object_version, policy_id, state_at_archive, data_tier, provider_code, provider_type, storage_uri, checksum, size_bytes, schema_version, manifest_json, status, idempotency_key, archived_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored', ?, ?, ?, ?, ?)`,
    [
      archiveRefValue,
      tid,
      row.object_type,
      String(row.object_id),
      row.object_ref || "",
      row.version,
      evaluation.policy_ref ? queryOne(db, "SELECT id FROM lc_policies WHERE tenant_id = ? AND policy_ref = ?", [tid, evaluation.policy_ref])?.id ?? null : null,
      row.current_state,
      row.data_tier,
      provider.code,
      provider.type,
      stored.storage_uri,
      stored.checksum || manifestChecksum,
      stored.size_bytes ?? Buffer.byteLength(manifestJson),
      SCHEMA_VERSION,
      manifestJson,
      String(idempotencyKey || ""),
      ts,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const archiveId = Number(result.lastInsertRowid);

  // Move the ledger to ARCHIVED, honouring the transition graph where possible.
  try {
    changeState(db, tid, objectType, objectId, "ARCHIVED", { reason: reason || "archived", actor, ip, force });
  } catch (error) {
    if (!force) throw error;
    run(db, "UPDATE lc_object_lifecycle SET current_state = 'ARCHIVED', data_tier = 'ARCHIVE', archived_at = ?, updated_at = ? WHERE id = ?", [ts, ts, row.id]);
  }

  writeAudit(db, {
    actor,
    action: "data_lifecycle.archive.create",
    resourceType: "lc_archive_records",
    resourceId: archiveRefValue,
    details: { object_type: row.object_type, object_id: String(row.object_id), provider: provider.code, checksum: stored.checksum || manifestChecksum },
    ip,
  });
  recordHistory(db, {
    tenantId: tid,
    objectType,
    objectId,
    objectRef: row.object_ref,
    action: "ARCHIVE",
    fromState: row.current_state,
    toState: "ARCHIVED",
    dataTier: "ARCHIVE",
    reason,
    details: { archive_ref: archiveRefValue, provider: provider.code, checksum: stored.checksum || manifestChecksum },
    actor,
  });
  publishLifecycleEvent(
    db,
    { eventType: "ObjectArchived", tenantId: tid, objectType, objectId, payload: { archive_ref: archiveRefValue, provider: provider.code, checksum: stored.checksum || manifestChecksum } },
    actor
  );
  notifyLifecycleEvent(db, { eventType: "ObjectArchived", tenantId: tid, objectType, objectId, objectName: row.object_ref, payload: { archive_ref: archiveRefValue }, actor });

  return publicArchiveRecord(queryOne(db, "SELECT * FROM lc_archive_records WHERE id = ?", [archiveId]));
}

// Verify the stored payload still matches its recorded checksum.
export async function verifyArchiveIntegrity(db, tenantId, ref) {
  const row = requireArchive(db, tenantId, ref);
  const provider = getArchiveProvider(row.provider_code);
  let content = null;
  try {
    content = await provider.retrieve(db, { storageUri: row.storage_uri });
  } catch (error) {
    return { ok: false, archive_ref: row.archive_ref, error: error.message };
  }
  if (content === null || content === undefined) return { ok: false, archive_ref: row.archive_ref, error: "archive payload not found" };
  const actual = createHash("sha256").update(content).digest("hex");
  const expected = row.checksum;
  return { ok: actual === expected, archive_ref: row.archive_ref, expected, actual, verified_at: nowIso() };
}

// Move an archived object to cold storage per policy.
export function moveToColdStorage(db, { tenantId, objectType, objectId, reason = "", actor = null, ip = null, force = false } = {}) {
  const tid = assertTenantId(tenantId);
  const evaluation = evaluateEligibility(db, { tenantId: tid, objectType, objectId, action: "COLD_STORAGE", force });
  if (evaluation.blocked && !force) {
    throw invalidArchive("Object is not eligible for cold storage", { reasons: evaluation.reasons.filter((r) => r.severity === "BLOCKED") });
  }
  const updated = changeState(db, tid, objectType, objectId, "COLD_STORAGE", { reason: reason || "moved to cold storage", actor, ip, force });
  publishLifecycleEvent(
    db,
    { eventType: "ObjectMovedToColdStorage", tenantId: tid, objectType, objectId, payload: { data_tier: "COLD" } },
    actor
  );
  notifyLifecycleEvent(db, { eventType: "ObjectMovedToColdStorage", tenantId: tid, objectType, objectId, objectName: updated.object_ref, payload: {}, actor });
  return updated;
}

export function archiveSummary(db, { tenantId } = {}) {
  const count = (where, params = []) => Number(queryOne(db, `SELECT COUNT(*) AS c FROM lc_archive_records WHERE tenant_id = ? ${where}`, [Number(tenantId), ...params])?.c || 0);
  return {
    total: count(""),
    stored: count("AND status = 'stored'"),
    restored: count("AND status = 'restored'"),
    failed: count("AND status = 'failed'"),
    bytes: Number(queryOne(db, "SELECT COALESCE(SUM(size_bytes), 0) AS c FROM lc_archive_records WHERE tenant_id = ?", [Number(tenantId)])?.c || 0),
  };
}

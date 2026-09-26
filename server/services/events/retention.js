// Retention Manager.
//
// Retention is policy-driven and archive-first. A policy targets one event type
// (or all types) and defines how long events are kept, whether they are archived
// or deleted, and how consumers are protected: an event is never removed while a
// non-terminal delivery still references it. Every run is audited and recorded on
// the policy so operators can see what happened.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { assertCode, assertEnum, RETENTION_ACTIONS, normalizeEnum, clampInt, DELIVERY_TERMINAL } from "./validation.js";
import { publicRetentionPolicy } from "./repository.js";
import { getEventTypeRow } from "./registry.js";
import { auditEvent } from "./hooks.js";

const EVENT_RECORD_COLUMNS = [
  "event_id",
  "event_ref",
  "event_type_code",
  "event_version",
  "source_module",
  "source_system",
  "source_object_type",
  "source_object_id",
  "source_object_revision",
  "actor_id",
  "actor_type",
  "correlation_id",
  "causation_id",
  "trace_id",
  "parent_event_id",
  "sequence_number",
  "partition_key",
  "priority",
  "payload_json",
  "payload_schema_version",
  "metadata_json",
  "security_classification",
  "status",
  "subscriber_count",
  "delivered_count",
  "failed_count",
  "tenant_id",
  "organization_id",
  "plant_id",
  "site_id",
  "idempotency_key",
  "occurred_at",
  "created_at",
  "updated_at",
];

export function listRetentionPolicies(db, { tenantId, status, eventTypeCode, page = 1, pageSize = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (eventTypeCode) {
    clauses.push("(event_type_code = ? OR event_type_code IS NULL)");
    params.push(eventTypeCode);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM event_retention_policies ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM event_retention_policies ${where} ORDER BY retention_days, code LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicRetentionPolicy(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getRetentionPolicyRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM event_retention_policies WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getRetentionPolicy(db, refValue) {
  const row = getRetentionPolicyRow(db, refValue);
  if (!row) throw new HttpError(404, "Retention policy not found");
  return publicRetentionPolicy(row, { stats: retentionPolicyPreview(db, row) });
}

export function createRetentionPolicy(db, input = {}, actor = null, tenantId = null) {
  assertCode(input.code, "Retention policy code");
  if (input.action !== undefined) assertEnum(input.action, RETENTION_ACTIONS, "action");
  const existing = getRetentionPolicyRow(db, input.code);
  if (existing) return publicRetentionPolicy(existing);
  if (input.event_type_code && !getEventTypeRow(db, input.event_type_code)) {
    throw new HttpError(400, `Unknown event type ${input.event_type_code}`);
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO event_retention_policies
      (code, name, event_type_code, retention_days, action, archive_target, status, last_run_at, last_run_deleted, last_run_archived, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.event_type_code || null,
      clampInt(input.retention_days, 1, 3650, 90),
      normalizeEnum(input.action, RETENTION_ACTIONS, "archive"),
      input.archive_target || "",
      input.status || "active",
      tenantId ?? input.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM event_retention_policies WHERE id = ?", [Number(result.lastInsertRowid)]);
  auditEvent(db, { actor, action: "event.retention.create", resourceType: "event_retention_policy", resourceId: row.id, details: { code: row.code, action: row.action } });
  return publicRetentionPolicy(row);
}

export function updateRetentionPolicy(db, refValue, input = {}, actor = null) {
  const row = getRetentionPolicyRow(db, refValue);
  if (!row) throw new HttpError(404, "Retention policy not found");
  if (input.action !== undefined) assertEnum(input.action, RETENTION_ACTIONS, "action");
  run(
    db,
    `UPDATE event_retention_policies SET name=?, event_type_code=?, retention_days=?, action=?, archive_target=?, status=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.event_type_code !== undefined ? input.event_type_code : row.event_type_code,
      input.retention_days !== undefined ? clampInt(input.retention_days, 1, 3650, row.retention_days) : row.retention_days,
      input.action !== undefined ? normalizeEnum(input.action, RETENTION_ACTIONS, row.action) : row.action,
      input.archive_target !== undefined ? input.archive_target : row.archive_target,
      input.status ?? row.status,
      nowIso(),
      row.id,
    ]
  );
  auditEvent(db, { actor, action: "event.retention.update", resourceType: "event_retention_policy", resourceId: row.id, details: { code: row.code } });
  return publicRetentionPolicy(queryOne(db, "SELECT * FROM event_retention_policies WHERE id = ?", [row.id]));
}

export function deleteRetentionPolicy(db, refValue, actor = null) {
  const row = getRetentionPolicyRow(db, refValue);
  if (!row) throw new HttpError(404, "Retention policy not found");
  run(db, "DELETE FROM event_retention_policies WHERE id = ?", [row.id]);
  auditEvent(db, { actor, action: "event.retention.delete", resourceType: "event_retention_policy", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}

function cutoffFor(days) {
  return new Date(Date.now() - clampInt(days, 1, 3650, 90) * 86400000).toISOString().replace("T", " ").slice(0, 19);
}

// Candidates are old events whose deliveries are all terminal. Keeping the
// "no active delivery" guard means an in-flight or retrying consumer can never
// have the event it is processing deleted from under it.
function candidateClause(policy) {
  const clauses = ["r.created_at <= ?"];
  const params = [cutoffFor(policy.retention_days)];
  if (policy.event_type_code) {
    clauses.push("r.event_type_code = ?");
    params.push(policy.event_type_code);
  }
  if (policy.tenant_id !== undefined && policy.tenant_id !== null) {
    clauses.push("r.tenant_id = ?");
    params.push(Number(policy.tenant_id));
  }
  const terminal = DELIVERY_TERMINAL.map(() => "?").join(",");
  clauses.push(
    `NOT EXISTS (SELECT 1 FROM event_deliveries d WHERE d.event_id = r.id AND d.status NOT IN (${terminal}))`
  );
  params.push(...DELIVERY_TERMINAL);
  return { where: clauses.join(" AND "), params };
}

export function retentionPolicyPreview(db, policy) {
  const { where, params } = candidateClause(policy);
  const candidates = queryOne(db, `SELECT COUNT(*) AS c FROM event_records r WHERE ${where}`, params).c;
  return { candidates, retention_days: policy.retention_days, action: policy.action, event_type_code: policy.event_type_code || null };
}

function archiveEvents(db, policy) {
  const { where, params } = candidateClause(policy);
  const columns = EVENT_RECORD_COLUMNS.join(", ");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO event_records_archive (${columns}, archived_at, retention_policy_code)
     SELECT ${EVENT_RECORD_COLUMNS.map((c) => `r.${c}`).join(", ")}, ?, ?
     FROM event_records r WHERE ${where}`,
    [ts, policy.code, ...params]
  );
  return Number(result.changes || 0);
}

function deleteEvents(db, policy) {
  const { where, params } = candidateClause(policy);
  const result = run(db, `DELETE FROM event_records WHERE id IN (SELECT r.id FROM event_records r WHERE ${where})`, params);
  return Number(result.changes || 0);
}

// Applies one policy. `dryRun` reports what would happen without mutating data.
export function applyRetentionPolicy(db, refValue, { dryRun = false, actor = null } = {}) {
  const policy = getRetentionPolicyRow(db, refValue);
  if (!policy) throw new HttpError(404, "Retention policy not found");
  const preview = retentionPolicyPreview(db, policy);
  if (dryRun) return { policy: publicRetentionPolicy(policy), dry_run: true, ...preview };
  let archived = 0;
  let deleted = 0;
  if (policy.action === "archive" || policy.action === "delete_after_archive") {
    archived = archiveEvents(db, policy);
  }
  if (policy.action === "delete" || policy.action === "delete_after_archive") {
    deleted = deleteEvents(db, policy);
  }
  const ts = nowIso();
  run(db, "UPDATE event_retention_policies SET last_run_at = ?, last_run_deleted = ?, last_run_archived = ?, updated_at = ? WHERE id = ?", [
    ts,
    deleted,
    archived,
    ts,
    policy.id,
  ]);
  auditEvent(db, {
    actor,
    action: "event.retention.apply",
    resourceType: "event_retention_policy",
    resourceId: policy.id,
    details: { code: policy.code, action: policy.action, archived, deleted, candidates: preview.candidates },
  });
  return { policy: publicRetentionPolicy(queryOne(db, "SELECT * FROM event_retention_policies WHERE id = ?", [policy.id])), dry_run: false, ...preview, archived, deleted };
}

// Runs every active policy. Invoked by the maintenance worker; safe to call
// repeatedly because candidates are recomputed each time.
export function applyRetention(db, { dryRun = false, actor = null, tenantId = null } = {}) {
  const policies = queryAll(
    db,
    `SELECT * FROM event_retention_policies WHERE status = 'active' ${tenantId !== undefined && tenantId !== null ? "AND (tenant_id IS NULL OR tenant_id = ?)" : ""} ORDER BY retention_days`,
    tenantId !== undefined && tenantId !== null ? [Number(tenantId)] : []
  );
  const results = [];
  let archived = 0;
  let deleted = 0;
  for (const policy of policies) {
    try {
      const result = applyRetentionPolicy(db, policy.id, { dryRun, actor });
      archived += result.archived || 0;
      deleted += result.deleted || 0;
      results.push({ code: policy.code, action: policy.action, archived: result.archived || 0, deleted: result.deleted || 0, candidates: result.candidates });
    } catch (error) {
      results.push({ code: policy.code, error: error.message });
    }
  }
  return { policies: policies.length, archived, deleted, results, dry_run: dryRun };
}

export function retentionStats(db, { tenantId = null } = {}) {
  const clause = tenantId !== undefined && tenantId !== null ? "WHERE tenant_id = ?" : "";
  const params = tenantId !== undefined && tenantId !== null ? [Number(tenantId)] : [];
  const policies = queryAll(db, `SELECT * FROM event_retention_policies ${clause} ORDER BY retention_days`, params);
  const archived = queryOne(db, "SELECT COUNT(*) AS c FROM event_records_archive").c;
  const byAction = queryAll(db, `SELECT action, COUNT(*) AS count FROM event_retention_policies ${clause} GROUP BY action`, params);
  return {
    policies: policies.length,
    active: policies.filter((p) => p.status === "active").length,
    by_action: byAction,
    archived_records: archived,
    policies_detail: policies.map((p) => publicRetentionPolicy(p, { stats: retentionPolicyPreview(db, p) })),
  };
}

// Seeds the default retention policies derived from the event registry's
// retention_days so a fresh install starts with sensible history limits.
export function ensureDefaultRetentionPolicies(db) {
  const types = queryAll(db, "SELECT code, retention_days FROM event_registry WHERE system = 1 ORDER BY code");
  let created = 0;
  const seen = new Set();
  for (const type of types) {
    const code = `retention-${type.code.toLowerCase()}`;
    if (seen.has(code)) continue;
    seen.add(code);
    if (getRetentionPolicyRow(db, code)) continue;
    createRetentionPolicy(db, {
      code,
      name: `${type.code} retention`,
      event_type_code: type.code,
      retention_days: type.retention_days || 90,
      action: "archive",
    });
    created += 1;
  }
  return { created, total: types.length };
}

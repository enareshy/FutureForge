import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { publicPolicy } from "./policies.js";
import { structuredLog } from "./events.js";

// Retention and archival. Events older than a policy's retention window are
// moved to audit_logs_archive and removed from the live table. Removal is only
// possible while the immutability guard flag is set, and the whole operation
// runs in a single transaction.

const ARCHIVE_COLUMNS = [
  "id",
  "tenant_id",
  "organization_id",
  "plant_id",
  "site_id",
  "department_id",
  "actor_id",
  "actor_username",
  "user_display_name",
  "action",
  "event_type",
  "source",
  "resource_type",
  "resource_id",
  "object_name",
  "details",
  "changed_fields",
  "before_values",
  "after_values",
  "related_json",
  "status",
  "error_message",
  "reason",
  "correlation_id",
  "request_id",
  "parent_event_id",
  "ip",
  "device",
  "duration_ms",
  "created_at",
];

function cutoffFor(days, now) {
  const ms = Number(days) * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms).toISOString().replace("T", " ").slice(0, 19);
}

function policySelection(policy, cutoff) {
  const where = ["created_at < ?"];
  const params = [cutoff];
  if (policy.tenant_id != null) {
    where.push("tenant_id = ?");
    params.push(Number(policy.tenant_id));
  }
  if (policy.object_type && policy.object_type !== "*") {
    where.push("resource_type = ?");
    params.push(policy.object_type);
  }
  return { where, params };
}

function archiveAndPurge(db, where, params) {
  const clause = where.join(" AND ");
  const ids = queryAll(db, `SELECT id FROM audit_logs WHERE ${clause}`, params).map((r) => r.id);
  if (!ids.length) return { archived: 0, purged: 0 };
  for (const id of ids) {
    run(
      db,
      `INSERT OR IGNORE INTO audit_logs_archive (${ARCHIVE_COLUMNS.join(", ")})
       SELECT ${ARCHIVE_COLUMNS.join(", ")} FROM audit_logs WHERE id = ?`,
      [id]
    );
  }
  run(db, "UPDATE audit_guard SET allow_delete = 1 WHERE id = 1");
  try {
    run(db, `DELETE FROM audit_logs WHERE ${clause}`, params);
  } finally {
    run(db, "UPDATE audit_guard SET allow_delete = 0 WHERE id = 1");
  }
  return { archived: ids.length, purged: ids.length };
}

export function listRetentionRuns(db, { tenantId, page = 1, pageSize = 25 } = {}) {
  const where = [];
  const params = [];
  if (tenantId) {
    where.push("(tenant_id = ? OR tenant_id IS NULL)");
    params.push(Number(tenantId));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(200, Math.max(1, Number(pageSize) || 25));
  const offset = (Math.max(1, Number(page) || 1) - 1) * limit;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM audit_retention_runs ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT * FROM audit_retention_runs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  ).map((row) => {
    let details = {};
    try {
      details = row.details_json ? JSON.parse(row.details_json) : {};
    } catch {
      details = {};
    }
    return { ...row, dry_run: !!row.dry_run, details };
  });
  return { items, total, page: Number(page) || 1, pageSize: limit };
}

export function runRetention(db, { tenantId, policyId, actor, dryRun = false, now = new Date() } = {}) {
  const where = ["status = 'active'"];
  const params = [];
  if (policyId) {
    where.push("id = ?");
    params.push(Number(policyId));
  }
  if (tenantId) {
    where.push("(tenant_id = ? OR tenant_id IS NULL)");
    params.push(Number(tenantId));
  }
  const policies = queryAll(db, `SELECT * FROM audit_policies WHERE ${where.join(" AND ")}`, params);
  const runs = [];
  let archivedTotal = 0;
  let purgedTotal = 0;

  for (const row of policies) {
    const policy = publicPolicy(row);
    if (!policy.retention_days || policy.retention_days < 1) continue;
    const cutoff = cutoffFor(policy.retention_days, now);
    const selection = policySelection(policy, cutoff);
    const clause = selection.where.join(" AND ");
    const count = queryOne(db, `SELECT COUNT(*) AS c FROM audit_logs WHERE ${clause}`, selection.params).c;
    let archived = 0;
    let purged = 0;
    let status = "success";
    if (!dryRun && count > 0) {
      try {
        const outcome = transaction(db, () => archiveAndPurge(db, selection.where, selection.params));
        archived = outcome.archived;
        purged = outcome.purged;
      } catch (err) {
        status = "failed";
        structuredLog("audit.retention.failed", { policy_id: policy.id, message: err?.message });
      }
    }
    archivedTotal += archived;
    purgedTotal += purged;
    const runResult = run(
      db,
      `INSERT INTO audit_retention_runs
        (tenant_id, policy_id, cutoff, archived, purged, status, dry_run, actor_id, details_json, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        policy.tenant_id,
        policy.id,
        cutoff,
        archived,
        purged,
        status,
        dryRun ? 1 : 0,
        actor?.id ?? null,
        JSON.stringify({ object_type: policy.object_type, candidates: count, retention_days: policy.retention_days }),
        nowIso(),
        nowIso(),
      ]
    );
    runs.push({
      id: Number(runResult.lastInsertRowid),
      policy_id: policy.id,
      object_type: policy.object_type,
      cutoff,
      candidates: count,
      archived,
      purged,
      status,
      dry_run: !!dryRun,
    });
  }
  return { archived: archivedTotal, purged: purgedTotal, dry_run: !!dryRun, runs };
}

export function archiveStats(db, { tenantId } = {}) {
  const where = [];
  const params = [];
  if (tenantId) {
    where.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const live = queryOne(db, `SELECT COUNT(*) AS c FROM audit_logs ${clause}`, params).c;
  const archiveClause = clause ? `${clause} AND 1=1` : "";
  const archived = queryOne(db, `SELECT COUNT(*) AS c FROM audit_logs_archive ${archiveClause}`, params).c;
  return { live, archived };
}

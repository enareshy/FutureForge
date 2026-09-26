// Operational metrics and health for the lifecycle estate. Every figure is
// tenant scoped so dashboards can never leak across tenants.
import { queryAll, queryOne, nowIso } from "../../db.js";
import { LIFECYCLE_STATES, DATA_TIERS } from "./constants.js";

function count(db, table, tenantId, extraWhere = "", params = []) {
  const where = ["tenant_id = ?", ...(extraWhere ? [extraWhere] : [])].join(" AND ");
  return Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`, [Number(tenantId), ...params])?.c || 0);
}

function groupCount(db, table, tenantId, column) {
  return queryAll(db, `SELECT ${column} AS k, COUNT(*) AS c FROM ${table} WHERE tenant_id = ? GROUP BY ${column} ORDER BY c DESC`, [Number(tenantId)]).map((row) => ({
    key: row.k,
    count: Number(row.c),
  }));
}

export function metricsSnapshot(db, { tenantId } = {}) {
  const tid = Number(tenantId);
  const due = (column, states) => {
    const marks = states.map(() => "?").join(", ");
    return Number(
      queryOne(
        db,
        `SELECT COUNT(*) AS c FROM lc_object_lifecycle WHERE tenant_id = ? AND current_state IN (${marks}) AND legal_hold_status <> 'ACTIVE' AND ${column} IS NOT NULL AND ${column} <= ?`,
        [tid, ...states, nowIso()]
      )?.c || 0
    );
  };

  const counters = {
    objects_tracked: count(db, "lc_object_lifecycle", tid),
    objects_active: count(db, "lc_object_lifecycle", tid, "current_state = 'ACTIVE'"),
    objects_inactive: count(db, "lc_object_lifecycle", tid, "current_state = 'INACTIVE'"),
    objects_archived: count(db, "lc_object_lifecycle", tid, "current_state = 'ARCHIVED'"),
    objects_cold: count(db, "lc_object_lifecycle", tid, "current_state = 'COLD_STORAGE'"),
    objects_purged: count(db, "lc_object_lifecycle", tid, "current_state = 'PURGED'"),
    objects_under_legal_hold: count(db, "lc_object_lifecycle", tid, "legal_hold_status = 'ACTIVE'"),
    policies_total: count(db, "lc_policies", tid),
    policies_active: count(db, "lc_policies", tid, "status = 'active'"),
    legal_holds_total: count(db, "lc_legal_holds", tid),
    legal_holds_active: count(db, "lc_legal_holds", tid, "status = 'ACTIVE'"),
    archives_total: count(db, "lc_archive_records", tid),
    archives_stored: count(db, "lc_archive_records", tid, "status = 'stored'"),
    archives_restored: count(db, "lc_archive_records", tid, "status = 'restored'"),
    archives_purged: count(db, "lc_archive_records", tid, "status = 'purged'"),
    restores_total: count(db, "lc_restore_records", tid),
    restores_completed: count(db, "lc_restore_records", tid, "status = 'completed'"),
    recoveries_total: count(db, "lc_recovery_records", tid),
    purges_executed: count(db, "lc_purge_records", tid, "status = 'executed'"),
    purges_denied: count(db, "lc_purge_records", tid, "status = 'denied'"),
    jobs_total: count(db, "lc_lifecycle_jobs", tid),
    history_entries: count(db, "lc_history", tid),
    due_for_archive: due("archive_eligible_at", ["INACTIVE"]),
    due_for_cold_storage: due("cold_storage_at", ["ARCHIVED"]),
    due_for_purge: due("purge_eligible_at", ["ARCHIVED", "COLD_STORAGE"]),
    archive_bytes: Number(queryOne(db, "SELECT COALESCE(SUM(size_bytes), 0) AS c FROM lc_archive_records WHERE tenant_id = ?", [tid])?.c || 0),
  };

  return {
    counters,
    by_state: groupCount(db, "lc_object_lifecycle", tid, "current_state"),
    by_tier: groupCount(db, "lc_object_lifecycle", tid, "data_tier"),
    by_object_type: queryAll(
      db,
      "SELECT object_type, COUNT(*) AS c FROM lc_object_lifecycle WHERE tenant_id = ? GROUP BY object_type ORDER BY c DESC LIMIT 50",
      [tid]
    ).map((row) => ({ object_type: row.object_type, count: Number(row.c) })),
    states: LIFECYCLE_STATES,
    tiers: DATA_TIERS,
    generated_at: nowIso(),
  };
}

export function healthCheck(db, { tenantId } = {}) {
  const tid = Number(tenantId);
  const checks = [];
  const add = (name, ok, detail = null) => checks.push({ name, status: ok ? "ok" : "degraded", detail });
  try {
    const tracked = count(db, "lc_object_lifecycle", tid);
    const withPolicy = Number(
      queryOne(
        db,
        `SELECT COUNT(*) AS c FROM lc_object_lifecycle o
          WHERE o.tenant_id = ? AND o.current_state NOT IN ('PURGED')
            AND (o.retention_policy_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM lc_policies p WHERE p.id = o.retention_policy_id AND p.status = 'active'
            ))`,
        [tid]
      )?.c || 0
    );
    add("retention_coverage", tracked === 0 || withPolicy < tracked, { tracked, without_active_policy: withPolicy });

    const activeHolds = count(db, "lc_legal_holds", tid, "status = 'ACTIVE'");
    const heldObjects = count(db, "lc_object_lifecycle", tid, "legal_hold_status = 'ACTIVE'");
    add("legal_holds", activeHolds >= 0, { active_holds: activeHolds, held_objects: heldObjects });

    const failedArchives = count(db, "lc_archive_records", tid, "status = 'failed'");
    add("archive_integrity", failedArchives === 0, { failed_archives: failedArchives });

    const purgedWithoutRecord = Number(
      queryOne(
        db,
        `SELECT COUNT(*) AS c FROM lc_object_lifecycle o
          WHERE o.tenant_id = ? AND o.current_state = 'PURGED'
            AND NOT EXISTS (SELECT 1 FROM lc_purge_records p WHERE p.tenant_id = o.tenant_id AND p.object_type = o.object_type AND p.object_id = o.object_id AND p.status = 'executed')`,
        [tid]
      )?.c || 0
    );
    add("purge_records", purgedWithoutRecord === 0, { purged_without_record: purgedWithoutRecord });

    return { status: checks.every((check) => check.status === "ok") ? "healthy" : "degraded", checks };
  } catch (error) {
    checks.push({ name: "database", status: "unhealthy", detail: error.message });
    return { status: "unhealthy", checks };
  }
}

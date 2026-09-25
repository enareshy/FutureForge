// Metrics and health for the Digital Thread domain.
//
// Read-only operational summaries built from the thread tables so the console
// and monitoring can display adoption, activity, projection lag and cache
// behaviour without scanning audit logs.
import { queryAll, queryOne } from "../../db.js";
import { cacheStats } from "./cache.js";
import { projectionHealth } from "./projection.js";
import { SOURCE_MODULE } from "./constants.js";

function count(db, table, tenantId, where = "", params = []) {
  const clause = tenantId ? "WHERE tenant_id = ?" : "";
  const values = tenantId ? [Number(tenantId), ...params] : params;
  return Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} ${clause} ${where ? (clause ? `AND ${where}` : `WHERE ${where}`) : ""}`, values)?.c || 0);
}

export function metricsSnapshot(db, tenantId = null) {
  const definitions = count(db, "thread_definitions", tenantId);
  const rules = count(db, "thread_traceability_rules", tenantId);
  const snapshots = count(db, "thread_snapshots", tenantId);
  const baselines = count(db, "thread_baselines", tenantId);
  const queries = count(db, "thread_query_history", tenantId);
  const changes = count(db, "thread_change_history", tenantId);
  const projections = count(db, "thread_projections", tenantId);
  const recent = tenantId
    ? queryAll(db, "SELECT action, COUNT(*) AS c FROM thread_query_history WHERE tenant_id = ? GROUP BY action", [Number(tenantId)])
    : queryAll(db, "SELECT action, COUNT(*) AS c FROM thread_query_history GROUP BY action");
  const lastQuery = tenantId
    ? queryOne(db, "SELECT action, node_count, edge_count, truncated, duration_ms, created_at FROM thread_query_history WHERE tenant_id = ? ORDER BY id DESC LIMIT 1", [Number(tenantId)])
    : queryOne(db, "SELECT action, node_count, edge_count, truncated, duration_ms, created_at FROM thread_query_history ORDER BY id DESC LIMIT 1");
  return {
    source_module: SOURCE_MODULE,
    counts: { definitions, rules, snapshots, baselines, queries, changes, projections },
    queries_by_action: Object.fromEntries(recent.map((row) => [row.action, Number(row.c)])),
    last_query: lastQuery || null,
    cache: cacheStats(),
  };
}

export function healthCheck(db, tenantId = null) {
  const metrics = metricsSnapshot(db, tenantId);
  let projection = null;
  if (tenantId) {
    try {
      projection = projectionHealth(db, tenantId);
    } catch {
      projection = null;
    }
  }
  const orphanSnapshotNodes = Number(queryOne(db, "SELECT COUNT(*) AS c FROM thread_snapshot_nodes WHERE snapshot_id NOT IN (SELECT id FROM thread_snapshots)")?.c || 0);
  const orphanBaselineMembers = Number(queryOne(db, "SELECT COUNT(*) AS c FROM thread_baseline_members WHERE baseline_id NOT IN (SELECT id FROM thread_baselines)")?.c || 0);
  return {
    status: orphanSnapshotNodes || orphanBaselineMembers ? "DEGRADED" : "OK",
    source_module: SOURCE_MODULE,
    metrics,
    projection,
    integrity: { orphan_snapshot_nodes: orphanSnapshotNodes, orphan_baseline_members: orphanBaselineMembers },
  };
}

export function activitySummary(db, tenantId, { limit = 10 } = {}) {
  const rows = queryAll(
    db,
    "SELECT action, node_count, edge_count, truncated, duration_ms, actor_username, created_at FROM thread_query_history WHERE tenant_id = ? ORDER BY id DESC LIMIT ?",
    [Number(tenantId), Math.min(100, Math.max(1, Number(limit) || 10))]
  );
  return { items: rows, total: count(db, "thread_query_history", tenantId), source_module: SOURCE_MODULE };
}

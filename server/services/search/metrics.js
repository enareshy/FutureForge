// Search metrics and health for the operations console.
import { queryAll, queryOne } from "../../db.js";
import { indexingStatus } from "./indexing.js";
import { listSourceResolvers } from "./sources.js";
import { toSqlDateTime } from "./validation.js";

function scalar(db, sql, params = []) {
  const row = queryOne(db, sql, params);
  return row ? Number(Object.values(row)[0] || 0) : 0;
}

export function searchMetrics(db, { tenantId, sinceDays = 30 } = {}) {
  const tenant = Number(tenantId);
  const since = toSqlDateTime(new Date(Date.now() - sinceDays * 86400000));
  const totals = queryOne(
    db,
    `SELECT COUNT(*) AS total,
            COALESCE(AVG(duration_ms), 0) AS avg_duration,
            COALESCE(SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END), 0) AS zero_results,
            COUNT(DISTINCT user_id) AS users
     FROM search_history WHERE tenant_id = ?`,
    [tenant]
  );
  const recent = queryOne(
    db,
    `SELECT COUNT(*) AS total,
            COALESCE(AVG(duration_ms), 0) AS avg_duration,
            COALESCE(SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END), 0) AS zero_results
     FROM search_history WHERE tenant_id = ? AND executed_at >= ?`,
    [tenant, since]
  );
  const topQueries = queryAll(
    db,
    `SELECT lower(query_text) AS query, COUNT(*) AS count, MAX(executed_at) AS last_seen
     FROM search_history WHERE tenant_id = ? AND query_text != ''
     GROUP BY lower(query_text) ORDER BY count DESC, last_seen DESC LIMIT 10`,
    [tenant]
  );
  const byStrategy = queryAll(
    db,
    `SELECT strategy, COUNT(*) AS count FROM search_history WHERE tenant_id = ? GROUP BY strategy ORDER BY count DESC`,
    [tenant]
  );
  const savedCount = scalar(db, "SELECT COUNT(*) FROM search_saved_searches WHERE tenant_id = ?", [tenant]);
  const sharedCount = scalar(db, "SELECT COUNT(*) FROM search_saved_searches WHERE tenant_id = ? AND is_shared = 1", [tenant]);
  const exportCounts = queryAll(
    db,
    `SELECT status, COUNT(*) AS count FROM search_exports WHERE tenant_id = ? GROUP BY status`,
    [tenant]
  );
  const index = indexingStatus(db, { tenantId: tenant });
  const total = Number(totals?.total || 0);
  const zeroResults = Number(totals?.zero_results || 0);
  return {
    tenant_id: tenant,
    window_days: sinceDays,
    searches: {
      total,
      users: Number(totals?.users || 0),
      avg_duration_ms: Math.round(Number(totals?.avg_duration || 0)),
      zero_result_rate: total ? Number((zeroResults / total).toFixed(3)) : 0,
      recent_total: Number(recent?.total || 0),
      recent_avg_duration_ms: Math.round(Number(recent?.avg_duration || 0)),
    },
    top_queries: topQueries,
    by_strategy: byStrategy,
    saved_searches: { total: savedCount, shared: sharedCount },
    exports: Object.fromEntries(exportCounts.map((row) => [row.status, row.count])),
    index,
  };
}

export function searchHealth(db) {
  const enabledConfigs = scalar(db, "SELECT COUNT(*) FROM search_configuration WHERE enabled = 1");
  const registeredTypes = scalar(db, "SELECT COUNT(*) FROM search_object_types WHERE status = 'active'");
  const indexed = scalar(db, "SELECT COUNT(*) FROM search_index");
  const queue = queryAll(db, "SELECT status, COUNT(*) AS count FROM search_index_status GROUP BY status");
  const queueMap = Object.fromEntries(queue.map((row) => [row.status, row.count]));
  const lastIndexed = queryOne(db, "SELECT MAX(indexed_at) AS last_indexed_at FROM search_index");
  const resolvers = listSourceResolvers();
  const stalePending = lastIndexed?.last_indexed_at
    ? scalar(
        db,
        "SELECT COUNT(*) FROM search_index_status WHERE status = 'pending' AND created_at < ?",
        [toSqlDateTime(new Date(Date.now() - 3600000))]
      )
    : 0;
  return {
    enabled_tenants: enabledConfigs,
    registered_object_types: registeredTypes,
    source_resolvers: resolvers,
    documents_indexed: indexed,
    queue: {
      pending: queueMap.pending || 0,
      processing: queueMap.processing || 0,
      failed: queueMap.failed || 0,
      dead_letter: queueMap.dead_letter || 0,
      stale_pending: stalePending,
    },
    last_indexed_at: lastIndexed?.last_indexed_at || null,
  };
}

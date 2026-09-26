// Telemetry provider layer for Data Observability.
//
// Observability owns no business data. Each provider is a read-only adapter
// over an existing platform service's operational tables. Providers compute
// raw measurements and freshness ages; the collection engine then applies
// thresholds, SLOs, health rules and alerting.
//
// Safety: every query is parameter-bound, tenant columns are only referenced
// when they actually exist, and user-defined ("generic") metrics may only
// reference columns validated via PRAGMA table_info against a whitelist of
// platform tables. No value is ever interpolated into SQL.
import { queryAll, queryOne } from "../../db.js";
import { columnExists, tableExists } from "./repository.js";
import { PROVIDER_CATALOG, providerByCode } from "./constants.js";

const WINDOW_24H = "'-24 hours'";

function tenantClause(db, table, tenantId, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  if (tenantId != null && tableExists(db, table) && columnExists(db, table, "tenant_id")) {
    return { sql: `${prefix}tenant_id = ?`, params: [Number(tenantId)] };
  }
  return { sql: "", params: [] };
}

function combine(clauses) {
  const active = clauses.filter((c) => c && c.sql);
  if (!active.length) return { sql: "", params: [] };
  return {
    sql: active.map((c) => c.sql).join(" AND "),
    params: active.flatMap((c) => c.params),
  };
}

function whereSql(parts) {
  return parts.sql ? `WHERE ${parts.sql}` : "";
}

function scalar(db, sql, params = []) {
  const row = queryOne(db, sql, params);
  if (!row) return null;
  const value = row.value !== undefined ? row.value : Object.values(row)[0];
  return value === null || value === undefined ? null : Number(value);
}

function count(db, table, tenantId, extra = null) {
  if (!tableExists(db, table)) return 0;
  const parts = combine([tenantClause(db, table, tenantId), extra]);
  return Number(scalar(db, `SELECT COUNT(*) AS value FROM ${table} ${whereSql(parts)}`, parts.params) || 0);
}

function countSince(db, table, tenantId, { sinceColumn = "created_at", extra = null } = {}) {
  if (!tableExists(db, table)) return 0;
  const parts = combine([tenantClause(db, table, tenantId), { sql: `${sinceColumn} >= datetime('now', ${WINDOW_24H})`, params: [] }, extra]);
  return Number(scalar(db, `SELECT COUNT(*) AS value FROM ${table} ${whereSql(parts)}`, parts.params) || 0);
}

function countStatuses(db, table, tenantId, column, values, { sinceColumn = null, extra = null } = {}) {
  if (!tableExists(db, table) || !columnExists(db, table, column)) return 0;
  const placeholders = values.map(() => "?").join(", ");
  const statusClause = { sql: `${column} IN (${placeholders})`, params: values };
  const sinceClause = sinceColumn && columnExists(db, table, sinceColumn) ? { sql: `${sinceColumn} >= datetime('now', ${WINDOW_24H})`, params: [] } : null;
  const parts = combine([tenantClause(db, table, tenantId), statusClause, sinceClause, extra]);
  return Number(scalar(db, `SELECT COUNT(*) AS value FROM ${table} ${whereSql(parts)}`, parts.params) || 0);
}

function percent(numerator, denominator) {
  if (!denominator) return denominator === 0 && numerator > 0 ? 100 : 0;
  return Number(((numerator / denominator) * 100).toFixed(4));
}

function ageSeconds(db, table, tenantId, column = "updated_at") {
  if (!tableExists(db, table) || !columnExists(db, table, column)) return null;
  const parts = combine([tenantClause(db, table, tenantId)]);
  const value = scalar(db, `SELECT (julianday('now') - julianday(MAX(${column}))) * 86400 AS value FROM ${table} ${whereSql(parts)}`, parts.params);
  return value === null || value === undefined || Number.isNaN(value) ? null : Math.max(0, Number(value));
}

function mappedFilters(db, table, filters) {
  if (!Array.isArray(filters) || !filters.length) return { sql: "", params: [] };
  const ops = { EQ: "=", NEQ: "!=", GT: ">", GTE: ">=", LT: "<", LTE: "<=", LIKE: "LIKE", IN: "IN", NOT_IN: "NOT IN", IS_NULL: "IS NULL", IS_NOT_NULL: "IS NOT NULL" };
  const clauses = [];
  const params = [];
  for (const filter of filters) {
    const column = String(filter?.column || "");
    const op = String(filter?.operator || "EQ").toUpperCase();
    if (!columnExists(db, table, column) || !ops[op]) continue;
    if (op === "IS_NULL" || op === "IS_NOT_NULL") {
      clauses.push(`${column} ${ops[op]}`);
      continue;
    }
    if (op === "IN" || op === "NOT_IN") {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      if (!values.length) continue;
      clauses.push(`${column} ${ops[op]} (${values.map(() => "?").join(", ")})`);
      params.push(...values);
      continue;
    }
    clauses.push(`${column} ${ops[op]} ?`);
    params.push(filter.value);
  }
  return { sql: clauses.join(" AND "), params };
}

// ── Provider implementations ────────────────────────────────────────────────
// Each provider exposes `measure(db, tenantId, metric)` returning a numeric
// value, and (optionally) `freshness(db, tenantId, definition)` returning age
// in seconds. Unknown metrics fall back to the generic evaluator.
const IMPLEMENTATIONS = {
  OBJECT_MODEL: {
    measure(db, tenantId, metric) {
      switch (metric.code) {
        case "OBJECT_VOLUME_TOTAL":
          return count(db, "objects", tenantId, { sql: "deleted_at IS NULL", params: [] });
        case "OBJECT_VOLUME_CREATED_24H":
          return countSince(db, "objects", tenantId);
        case "OBJECT_FRESHNESS_AGE":
          return ageSeconds(db, "objects", tenantId, "updated_at");
        default:
          return null;
      }
    },
    freshness: (db, tenantId) => ageSeconds(db, "objects", tenantId, "updated_at"),
  },
  PDM: {
    measure(db, tenantId, metric) {
      switch (metric.code) {
        case "PDM_VOLUME_TOTAL":
          return count(db, "pdm_items", tenantId);
        case "BOM_LINE_VOLUME":
          return count(db, "bom_lines", tenantId);
        default:
          return null;
      }
    },
    freshness: (db, tenantId) => ageSeconds(db, "pdm_items", tenantId, "updated_at"),
  },
  FILE_STORAGE: {
    measure(db, tenantId, metric) {
      if (metric.code === "FILE_STORAGE_VOLUME") return count(db, "files", tenantId, { sql: "deleted_at IS NULL", params: [] });
      return null;
    },
    freshness: (db, tenantId) => ageSeconds(db, "files", tenantId, "updated_at"),
  },
  DATA_QUALITY: {
    measure(db, tenantId, metric) {
      switch (metric.code) {
        case "DATA_QUALITY_SCORE": {
          const parts = combine([tenantClause(db, "dg_quality_results", tenantId), { sql: "is_current = 1", params: [] }]);
          const value = tableExists(db, "dg_quality_results")
            ? scalar(db, `SELECT AVG(overall_score) AS value FROM dg_quality_results ${whereSql(parts)}`, parts.params)
            : null;
          return value === null ? null : Number(Number(value).toFixed(4));
        }
        case "DATA_QUALITY_VIOLATIONS":
          return count(db, "dg_quality_violations", tenantId, { sql: "is_current = 1", params: [] });
        default:
          return null;
      }
    },
    freshness: (db, tenantId) => ageSeconds(db, "dg_quality_results", tenantId, "evaluated_at"),
  },
  SEARCH: {
    measure(db, tenantId, metric) {
      switch (metric.code) {
        case "SEARCH_INDEX_COVERAGE": {
          if (!tableExists(db, "objects") || !tableExists(db, "search_index")) return null;
          const objectClause = combine([tenantClause(db, "objects", tenantId)]);
          const total = Number(scalar(db, `SELECT COUNT(*) AS value FROM objects ${whereSql(objectClause)}`, objectClause.params) || 0);
          if (!total) return 100;
          const indexedClause = combine([tenantClause(db, "search_index", tenantId)]);
          const indexed = Number(scalar(db, `SELECT COUNT(DISTINCT object_id) AS value FROM search_index ${whereSql(indexedClause)}`, indexedClause.params) || 0);
          return percent(Math.min(indexed, total), total);
        }
        case "SEARCH_ERROR_RATE": {
          const failed = countStatuses(db, "search_index_status", tenantId, "status", ["failed", "dead_letter"], { sinceColumn: "created_at" });
          const total = countSince(db, "search_index_status", tenantId, { sinceColumn: "created_at" });
          return percent(failed, total);
        }
        default:
          return null;
      }
    },
    freshness: (db, tenantId) => ageSeconds(db, "search_index", tenantId, "indexed_at"),
  },
  EVENTS: {
    measure(db, tenantId, metric) {
      switch (metric.code) {
        case "EVENT_THROUGHPUT":
          return countSince(db, "event_records", tenantId, { sinceColumn: "created_at" });
        case "EVENT_DELIVERY_FAILURES":
          return countStatuses(db, "event_deliveries", tenantId, "status", ["failed", "dead_letter"], { sinceColumn: "created_at" });
        case "EVENT_DEAD_LETTERS":
          return count(db, "event_dead_letters", tenantId, { sql: "status IS NULL OR status NOT IN ('resolved', 'RESOLVED')", params: [] });
        default:
          return null;
      }
    },
    freshness: (db, tenantId) => ageSeconds(db, "event_records", tenantId, "created_at"),
  },
  WORKFLOW: {
    measure(db, tenantId, metric) {
      switch (metric.code) {
        case "WORKFLOW_THROUGHPUT":
          return countSince(db, "workflow_instances", tenantId, { sinceColumn: "started_at" });
        case "WORKFLOW_FAILURE_RATE": {
          const failed = countStatuses(db, "workflow_instances", tenantId, "status", ["failed"], { sinceColumn: "started_at" });
          const terminal = countStatuses(db, "workflow_instances", tenantId, "status", ["completed", "cancelled", "failed"], { sinceColumn: "started_at" });
          return percent(failed, terminal);
        }
        case "WORKFLOW_OVERDUE_TASKS": {
          if (!tableExists(db, "workflow_tasks")) return 0;
          const parts = combine([
            tenantClause(db, "workflow_tasks", tenantId),
            { sql: "status IN ('unassigned', 'assigned', 'in_progress', 'blocked', 'awaiting_approval')", params: [] },
            { sql: "due_at IS NOT NULL AND due_at < datetime('now')", params: [] },
          ]);
          return Number(scalar(db, `SELECT COUNT(*) AS value FROM workflow_tasks ${whereSql(parts)}`, parts.params) || 0);
        }
        default:
          return null;
      }
    },
    freshness: (db, tenantId) => ageSeconds(db, "workflow_instances", tenantId, "updated_at"),
  },
  JOBS: {
    measure(db, tenantId, metric) {
      switch (metric.code) {
        case "JOB_FAILURE_RATE": {
          const failed = countStatuses(db, "jobs", tenantId, "status", ["failed", "timed_out"], {});
          const done = countStatuses(db, "jobs", tenantId, "status", ["completed", "failed", "timed_out", "cancelled"], {});
          return percent(failed, done);
        }
        case "JOB_THROUGHPUT":
          return countStatuses(db, "jobs", tenantId, "status", ["completed"], { sinceColumn: "completed_at" });
        case "JOB_DEAD_LETTERS":
          return count(db, "job_dead_letters", tenantId, { sql: "status IS NULL OR status NOT IN ('resolved', 'RESOLVED')", params: [] });
        case "JOB_LATENCY_P95": {
          if (!tableExists(db, "jobs")) return null;
          const parts = combine([
            tenantClause(db, "jobs", tenantId),
            { sql: "completed_at IS NOT NULL AND started_at IS NOT NULL", params: [] },
            { sql: "completed_at >= datetime('now', '-24 hours')", params: [] },
          ]);
          const value = scalar(db, `SELECT AVG((julianday(completed_at) - julianday(started_at)) * 86400) AS value FROM jobs ${whereSql(parts)}`, parts.params);
          return value === null ? null : Math.max(0, Number(value.toFixed(2)));
        }
        default:
          return null;
      }
    },
    freshness: (db, tenantId) => ageSeconds(db, "jobs", tenantId, "updated_at"),
  },
  INTEGRATION: {
    measure(db, tenantId, metric) {
      switch (metric.code) {
        case "INTEGRATION_FAILURE_RATE": {
          const failed = countStatuses(db, "integration_executions", tenantId, "status", ["failed", "timed_out"], { sinceColumn: "started_at" });
          const total = countSince(db, "integration_executions", tenantId, { sinceColumn: "started_at" });
          return percent(failed, total);
        }
        case "INTEGRATION_THROUGHPUT":
          return countSince(db, "integration_executions", tenantId, { sinceColumn: "started_at" });
        case "INTEGRATION_DEAD_LETTERS":
          return count(db, "integration_dead_letters", tenantId, { sql: "status IS NULL OR status NOT IN ('resolved', 'RESOLVED')", params: [] });
        default:
          return null;
      }
    },
    freshness: (db, tenantId) => ageSeconds(db, "integration_executions", tenantId, "updated_at"),
  },
  IMPORT_EXPORT: {
    measure(db, tenantId, metric) {
      switch (metric.code) {
        case "IMPORT_FAILURE_RATE": {
          const failed = countStatuses(db, "ie_import_jobs", tenantId, "status", ["FAILED"], {});
          const total = countStatuses(db, "ie_import_jobs", tenantId, "status", ["COMPLETED", "PARTIAL", "FAILED"], {});
          return percent(failed, total);
        }
        case "IMPORT_THROUGHPUT": {
          if (!tableExists(db, "ie_import_jobs")) return 0;
          const parts = combine([tenantClause(db, "ie_import_jobs", tenantId), { sql: "created_at >= datetime('now', '-24 hours')", params: [] }]);
          return Number(scalar(db, `SELECT COALESCE(SUM(success_count), 0) AS value FROM ie_import_jobs ${whereSql(parts)}`, parts.params) || 0);
        }
        case "EXPORT_THROUGHPUT":
          return countSince(db, "ie_export_jobs", tenantId, { sinceColumn: "created_at" });
        case "EXCHANGE_FAILURE_RATE": {
          const failed = countStatuses(db, "exchange_transactions", tenantId, "status", ["FAILED"], { sinceColumn: "created_at" });
          const total = countStatuses(db, "exchange_transactions", tenantId, "status", ["COMPLETED", "PARTIAL", "FAILED"], { sinceColumn: "created_at" });
          return percent(failed, total);
        }
        default:
          return null;
      }
    },
    freshness: (db, tenantId) => ageSeconds(db, "exchange_transactions", tenantId, "updated_at"),
  },
  AUDIT: {
    // API telemetry is read from the integration API-usage meter, the platform
    // record of request status codes and durations. The audit trail itself
    // records business actions, not HTTP response codes.
    measure(db, tenantId, metric) {
      switch (metric.code) {
        case "API_ERROR_RATE":
          return percent(apiFailures(db, tenantId), apiTotal(db, tenantId));
        case "API_AVAILABILITY": {
          const total = apiTotal(db, tenantId);
          if (!total) return 100;
          return Number((100 - percent(apiFailures(db, tenantId), total)).toFixed(4));
        }
        case "API_LATENCY_P95": {
          if (!tableExists(db, "integration_api_usage")) return null;
          const parts = combine([
            tenantClause(db, "integration_api_usage", tenantId),
            { sql: "created_at >= datetime('now', '-24 hours')", params: [] },
            { sql: "duration_ms IS NOT NULL", params: [] },
          ]);
          const value = scalar(db, `SELECT AVG(duration_ms) AS value FROM integration_api_usage ${whereSql(parts)}`, parts.params);
          return value === null ? null : Math.max(0, Number(Number(value).toFixed(2)));
        }
        default:
          return null;
      }
    },
    freshness: (db, tenantId) => ageSeconds(db, "audit_logs", tenantId, "created_at"),
  },
  DATA_LIFECYCLE: {
    measure(db, tenantId, metric) {
      switch (metric.code) {
        case "ARCHIVE_THROUGHPUT":
          return countSince(db, "lc_archive_records", tenantId, { sinceColumn: "archived_at" });
        case "PURGE_THROUGHPUT":
          return countSince(db, "lc_purge_records", tenantId, { sinceColumn: "executed_at" });
        default:
          return null;
      }
    },
    freshness: (db, tenantId) => ageSeconds(db, "lc_archive_records", tenantId, "archived_at"),
  },
  PLATFORM: {
    measure(db, tenantId, metric) {
      if (metric.code !== "SERVICE_AVAILABILITY") return null;
      if (!tableExists(db, "observability_observation_runs")) return 100;
      const parts = combine([tenantClause(db, "observability_observation_runs", tenantId), { sql: "started_at >= datetime('now', '-24 hours')", params: [] }]);
      const row = queryOne(db, `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN error_count > 0 THEN 1 ELSE 0 END), 0) AS errored FROM observability_observation_runs ${whereSql(parts)}`, parts.params);
      const total = Number(row?.total || 0);
      if (!total) return 100;
      return Number((100 - percent(Number(row.errored || 0), total)).toFixed(4));
    },
    freshness: () => 0,
  },
};

function apiTotal(db, tenantId) {
  if (!tableExists(db, "integration_api_usage")) return 0;
  const parts = combine([tenantClause(db, "integration_api_usage", tenantId), { sql: "created_at >= datetime('now', '-24 hours')", params: [] }]);
  return Number(scalar(db, `SELECT COUNT(*) AS value FROM integration_api_usage ${whereSql(parts)}`, parts.params) || 0);
}

function apiFailures(db, tenantId) {
  if (!tableExists(db, "integration_api_usage") || !columnExists(db, "integration_api_usage", "status_code")) return 0;
  const parts = combine([tenantClause(db, "integration_api_usage", tenantId), { sql: "status_code >= 500", params: [] }, { sql: "created_at >= datetime('now', '-24 hours')", params: [] }]);
  return Number(scalar(db, `SELECT COUNT(*) AS value FROM integration_api_usage ${whereSql(parts)}`, parts.params) || 0);
}

// Generic evaluator for user-defined metrics. Only platform tables that a
// provider already owns are addressable, and only for aggregations over real
// columns. This is what lets teams add a metric without shipping code while
// keeping observability a pure consumer.
export function measureGeneric(db, tenantId, metric) {
  const metadata = metric.metadata && typeof metric.metadata === "object" ? metric.metadata : {};
  const provider = providerByCode(metric.provider_code);
  const allowed = new Set((provider?.tables || []).concat(["objects", "files", "pdm_items", "bom_lines"]));
  const table = String(metadata.table || "");
  if (!allowed.has(table) || !tableExists(db, table)) return null;
  const aggregation = String(metadata.aggregation || metric.calculation || "COUNT").toUpperCase();
  const column = metadata.column && columnExists(db, table, metadata.column) ? String(metadata.column) : null;
  const filters = mappedFilters(db, table, metadata.filters);
  const parts = combine([tenantClause(db, table, tenantId), filters]);
  let expr;
  if (aggregation === "COUNT") expr = "COUNT(*)";
  else if (aggregation === "COUNT_DISTINCT" && column) expr = `COUNT(DISTINCT ${column})`;
  else if (["SUM", "AVG", "MIN", "MAX"].includes(aggregation) && column) expr = `${aggregation}(${column})`;
  else expr = "COUNT(*)";
  const value = scalar(db, `SELECT ${expr} AS value FROM ${table} ${whereSql(parts)}`, parts.params);
  return value === null ? null : Number(value);
}

export function listProviders() {
  return PROVIDER_CATALOG.map((provider) => ({ ...provider }));
}

export function getProvider(code) {
  return providerByCode(code);
}

// Collects a single measurement for a metric definition.
export function measureMetric(db, tenantId, metric) {
  const provider = providerByCode(metric.provider_code);
  if (!provider) return { value: null, error: `Unknown provider: ${metric.provider_code}` };
  if (provider.status !== "AVAILABLE") return { value: null, error: `Provider unavailable: ${provider.code}` };
  try {
    const impl = IMPLEMENTATIONS[provider.code];
    let value = impl ? impl.measure(db, tenantId, metric) : null;
    if (value === null || value === undefined || Number.isNaN(value)) {
      value = measureGeneric(db, tenantId, metric);
    }
    if (value === null || value === undefined || Number.isNaN(value)) {
      return { value: null, error: `No measurement available for ${metric.code}` };
    }
    return { value: Number(value), error: null };
  } catch (err) {
    return { value: null, error: err.message };
  }
}

// Computes the age (seconds) of the freshest record for a freshness definition.
export function measureFreshness(db, tenantId, definition) {
  const provider = providerByCode(definition.provider_code);
  if (!provider) return { age_seconds: null, error: `Unknown provider: ${definition.provider_code}` };
  try {
    let age = null;
    const impl = IMPLEMENTATIONS[provider.code];
    const table = definition.source_table || provider.tables[0] || null;
    if (table && tableExists(db, table)) {
      const column = columnExists(db, table, "updated_at")
        ? "updated_at"
        : columnExists(db, table, "created_at")
          ? "created_at"
          : columnExists(db, table, "indexed_at")
            ? "indexed_at"
            : columnExists(db, table, "evaluated_at")
              ? "evaluated_at"
              : null;
      if (column) age = ageSeconds(db, table, tenantId, column);
    }
    if ((age === null || age === undefined) && impl?.freshness) age = impl.freshness(db, tenantId, definition);
    return { age_seconds: age, error: age === null ? `No freshness signal for ${definition.code}` : null };
  } catch (err) {
    return { age_seconds: null, error: err.message };
  }
}

// A synthetic availability/latency probe used by health checks. Real probing
// is delegated to the platform; here we simply verify the provider's tables
// are readable so a broken schema degrades health rather than crashing.
export function probeProvider(db, code) {
  const provider = providerByCode(code);
  if (!provider) return { available: false, latency_ms: null, error: "unknown provider" };
  const started = Date.now();
  try {
    for (const table of provider.tables.slice(0, 1)) {
      if (tableExists(db, table)) queryOne(db, `SELECT 1 AS ok FROM ${table} LIMIT 1`);
    }
    return { available: true, latency_ms: Math.max(0, Date.now() - started), error: null };
  } catch (err) {
    return { available: false, latency_ms: null, error: err.message };
  }
}

export { WINDOW_24H };

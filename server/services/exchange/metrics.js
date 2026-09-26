// Metrics and health for the Standards & Exchange domain.
//
// Read-only operational summaries built from the exchange tables so the console
// and monitoring can display adoption, throughput, validation quality and
// adapter readiness without scanning audit logs.
import { queryAll, queryOne } from "../../db.js";
import { SOURCE_MODULE, OPERATIONS, FORMAT_STATUSES, ADAPTER_STATUSES } from "./constants.js";
import { adapterCatalog } from "./adapters/index.js";

function count(db, table, tenantId, where = "", params = []) {
  const clause = "WHERE tenant_id = ?";
  const values = [Number(tenantId), ...params];
  const suffix = where ? ` AND ${where}` : "";
  return Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} ${clause}${suffix}`, values)?.c || 0);
}

export function metricsSnapshot(db, tenantId) {
  const tenant = Number(tenantId);
  const byStatus = queryAll(db, "SELECT status, COUNT(*) AS c FROM exchange_transactions WHERE tenant_id = ? GROUP BY status", [tenant]);
  const byDirection = queryAll(db, "SELECT direction, COUNT(*) AS c FROM exchange_transactions WHERE tenant_id = ? GROUP BY direction", [tenant]);
  const byOperation = queryAll(db, "SELECT operation, COUNT(*) AS c FROM exchange_transactions WHERE tenant_id = ? GROUP BY operation", [tenant]);
  const last = queryOne(
    db,
    "SELECT transaction_ref, direction, operation, status, counts_json, created_at FROM exchange_transactions WHERE tenant_id = ? ORDER BY id DESC LIMIT 1",
    [tenant]
  );
  const errorRows = queryAll(db, "SELECT severity, COUNT(*) AS c FROM exchange_errors WHERE tenant_id = ? GROUP BY severity", [tenant]);
  const errors = { ERROR: 0, WARNING: 0, INFO: 0 };
  for (const row of errorRows) errors[row.severity] = Number(row.c);
  return {
    source_module: SOURCE_MODULE,
    counts: {
      adapters: count(db, "exchange_adapters", tenant),
      formats: count(db, "exchange_formats", tenant),
      definitions: count(db, "exchange_definitions", tenant),
      mappings: count(db, "exchange_mappings", tenant),
      transformations: count(db, "exchange_transformations", tenant),
      validation_profiles: count(db, "exchange_validation_profiles", tenant),
      transactions: count(db, "exchange_transactions", tenant),
      jobs: count(db, "exchange_jobs", tenant),
      reconciliations: count(db, "exchange_reconciliations", tenant),
      errors: count(db, "exchange_errors", tenant),
    },
    transactions_by_status: Object.fromEntries(byStatus.map((row) => [row.status, Number(row.c)])),
    transactions_by_direction: Object.fromEntries(byDirection.map((row) => [row.direction, Number(row.c)])),
    transactions_by_operation: Object.fromEntries(byOperation.map((row) => [row.operation, Number(row.c)])),
    findings_by_severity: errors,
    last_transaction: last || null,
  };
}

export function healthCheck(db, tenantId) {
  const tenant = Number(tenantId);
  const metrics = metricsSnapshot(db, tenant);
  const adapterRows = queryAll(db, "SELECT code, status FROM exchange_adapters WHERE tenant_id = ?", [tenant]);
  const available = adapterRows.filter((row) => row.status === "AVAILABLE").length;
  const planned = adapterRows.filter((row) => row.status === "PLANNED").length;
  const orphanErrors = Number(queryOne(db, "SELECT COUNT(*) AS c FROM exchange_errors WHERE tenant_id = ? AND transaction_ref != '' AND transaction_ref NOT IN (SELECT transaction_ref FROM exchange_transactions WHERE tenant_id = ?)", [tenant, tenant])?.c || 0);
  const running = Number(queryOne(db, "SELECT COUNT(*) AS c FROM exchange_transactions WHERE tenant_id = ? AND status IN ('QUEUED','RUNNING','VALIDATING','VALIDATING')", [tenant])?.c || 0);
  return {
    status: orphanErrors ? "DEGRADED" : "OK",
    source_module: SOURCE_MODULE,
    metrics,
    adapters: {
      total: adapterRows.length,
      available,
      planned,
      unsupported: adapterRows.filter((row) => row.status === "UNSUPPORTED").length,
      catalog: adapterCatalog().map((adapter) => ({ code: adapter.code, status: adapter.status, category: adapter.category })),
    },
    active_transactions: running,
    integrity: { orphan_errors: orphanErrors, registered_statuses: FORMAT_STATUSES, adapter_statuses: ADAPTER_STATUSES, operations: OPERATIONS },
  };
}

export function throughput(db, tenantId, { limit = 20 } = {}) {
  const rows = queryAll(
    db,
    "SELECT transaction_ref, direction, operation, status, counts_json, created_at FROM exchange_transactions WHERE tenant_id = ? ORDER BY id DESC LIMIT ?",
    [Number(tenantId), Math.min(200, Math.max(1, Number(limit) || 20))]
  );
  return { items: rows, total: count(db, "exchange_transactions", tenantId), source_module: SOURCE_MODULE };
}

// Operational metrics and health checks for the Import & Export Framework.
import { queryAll, queryOne } from "../../db.js";
import { connectorTypes } from "./connectors/registry.js";
import { EXCHANGE_RESOURCES, SOURCE_MODULE } from "./constants.js";

function count(db, sql, params = []) {
  return Number(queryOne(db, sql, params)?.c || 0);
}

export function metricsSnapshot(db, { tenantId } = {}) {
  const tenant = Number(tenantId);
  const importJobs = queryAll(db, "SELECT status, COUNT(*) AS c FROM ie_import_jobs WHERE tenant_id = ? GROUP BY status", [tenant]);
  const exportJobs = queryAll(db, "SELECT status, COUNT(*) AS c FROM ie_export_jobs WHERE tenant_id = ? GROUP BY status", [tenant]);
  return {
    source_module: SOURCE_MODULE,
    generated_at: new Date().toISOString(),
    import_definitions: count(db, "SELECT COUNT(*) AS c FROM ie_import_definitions WHERE tenant_id = ?", [tenant]),
    export_definitions: count(db, "SELECT COUNT(*) AS c FROM ie_export_definitions WHERE tenant_id = ?", [tenant]),
    connector_configurations: count(db, "SELECT COUNT(*) AS c FROM ie_connector_configurations WHERE tenant_id = ?", [tenant]),
    templates: count(db, "SELECT COUNT(*) AS c FROM ie_templates WHERE tenant_id = ?", [tenant]),
    import_jobs_by_status: Object.fromEntries(importJobs.map((row) => [row.status, Number(row.c)])),
    export_jobs_by_status: Object.fromEntries(exportJobs.map((row) => [row.status, Number(row.c)])),
    import_records: count(db, "SELECT COUNT(*) AS c FROM ie_import_record_results WHERE tenant_id = ?", [tenant]),
    import_errors: count(db, "SELECT COUNT(*) AS c FROM ie_import_errors WHERE tenant_id = ? AND resolved = 0", [tenant]),
    export_results: count(db, "SELECT COUNT(*) AS c FROM ie_export_results WHERE tenant_id = ? AND status = 'AVAILABLE'", [tenant]),
    reconciliation_variance: count(db, "SELECT COUNT(*) AS c FROM ie_import_reconciliations WHERE tenant_id = ? AND status = 'VARIANCE'", [tenant]),
    registered_connectors: connectorTypes().length,
  };
}

export function healthCheck(db, { tenantId } = {}) {
  const tenant = Number(tenantId);
  const tables = ["ie_import_definitions", "ie_import_jobs", "ie_export_definitions", "ie_export_jobs", "ie_connector_configurations"];
  const checks = tables.map((table) => {
    try {
      count(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [tenant]);
      return { name: table, status: "ok" };
    } catch (error) {
      return { name: table, status: "error", message: error.message };
    }
  });
  const connectors = connectorTypes();
  checks.push({ name: "connectors", status: connectors.length ? "ok" : "error", detail: connectors.length });
  const healthy = checks.every((check) => check.status === "ok");
  return { status: healthy ? "healthy" : "degraded", source_module: SOURCE_MODULE, resources: EXCHANGE_RESOURCES, checks };
}

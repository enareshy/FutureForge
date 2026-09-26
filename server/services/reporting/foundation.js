// Idempotent bootstrap for the Reporting & Analytics capability.
//
// Called on every application boot: registers event types, job types and
// handlers, search sources, security object types and per-tenant configuration.
// It registers into platform seams (events, jobs, search, security, audit) and
// never duplicates them.
import { queryAll, queryOne } from "../../db.js";
import { tenantIds } from "../search/registry.js";
import { SOURCE_MODULE } from "./constants.js";
import { ensureReportingEventTypes } from "./events.js";
import { ensureReportingJobTypes, registerReportingHandlers } from "./jobs.js";
import { ensureReportingSearch, registerReportingSources } from "./search.js";
import { ensureReportingConfig } from "./configuration.js";
import { dataSourceCatalog } from "./datasources.js";
import { listEntities } from "./semantic.js";

export function ensureReportingFoundation(db) {
  const eventTypes = ensureReportingEventTypes(db);
  const jobTypes = ensureReportingJobTypes(db);
  const handlers = registerReportingHandlers();
  registerReportingSources();

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }

  let configuration = 0;
  for (const tenantId of tenants) {
    configuration += ensureReportingConfig(db, tenantId).created || 0;
  }
  const search = ensureReportingSearch(db).created || 0;

  return {
    source_module: SOURCE_MODULE,
    data_sources: dataSourceCatalog().map((entry) => ({ code: entry.code, status: entry.status })),
    semantic_entities: listEntities().length,
    event_types: eventTypes,
    job_types: jobTypes.created,
    handlers,
    configuration,
    search,
    tenants: tenants.length,
  };
}

export function reportingHealth(db, tenantId = null) {
  const scope = tenantId ? Number(tenantId) : null;
  const scoped = (table) =>
    Number((scope ? queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [scope]) : queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`))?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    sources: dataSourceCatalog().map((entry) => ({ code: entry.code, status: entry.status })),
    entities: listEntities().map((entry) => entry.code),
    counts: {
      reports: scoped("reporting_reports"),
      dashboards: scoped("reporting_dashboards"),
      widgets: scoped("reporting_dashboard_widgets"),
      metrics: scoped("reporting_metrics"),
      kpis: scoped("reporting_kpis"),
      executions: scoped("reporting_executions"),
      exports: scoped("reporting_exports"),
      schedules: scoped("reporting_schedules"),
      jobs: scoped("reporting_jobs"),
      bi_connections: scoped("reporting_bi_connections"),
      bi_datasets: scoped("reporting_bi_datasets"),
      read_model: scoped("reporting_read_model"),
      history: scoped("reporting_history"),
    },
    tenant_count: queryAll(db, "SELECT DISTINCT tenant_id FROM reporting_reports").length,
  };
}

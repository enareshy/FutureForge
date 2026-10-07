// Idempotent bootstrap for the Data Observability capability.
//
// Called on every application boot: registers event types, job types and
// handlers, search sources, security object types and per-tenant configuration.
// It registers into platform seams (events, jobs, search, security) and never
// duplicates them. No business data is created here; the seeder materialises
// curated definitions.
import { queryOne } from "../../db.js";
import { queryOneAsync } from "../../db-async.js";
import { tenantIds, tenantIdsAsync } from "../search/registry.js";
import { SOURCE_MODULE } from "./constants.js";
import { ensureObservabilityEventTypes, ensureObservabilityEventTypesAsync } from "./events.js";
import { ensureObservabilityJobTypes, ensureObservabilityJobTypesAsync, registerObservabilityHandlers } from "./jobs.js";
import { ensureObservabilitySearch, ensureObservabilitySearchAsync, registerObservabilitySources } from "./search.js";
import { ensureObservabilityConfig, ensureObservabilityConfigAsync } from "./configuration.js";
import { listProviders } from "./providers.js";

export function ensureObservabilityFoundation(db) {
  const eventTypes = ensureObservabilityEventTypes(db);
  const jobTypes = ensureObservabilityJobTypes(db);
  const handlers = registerObservabilityHandlers();
  registerObservabilitySources();

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }

  let configuration = 0;
  for (const tenantId of tenants) {
    configuration += ensureObservabilityConfig(db, tenantId).created || 0;
  }
  const search = ensureObservabilitySearch(db).created || 0;

  return {
    source_module: SOURCE_MODULE,
    providers: listProviders().map((provider) => ({ code: provider.code, status: provider.status })),
    event_types: eventTypes,
    job_types: jobTypes.created,
    handlers,
    configuration,
    search,
    tenants: tenants.length,
  };
}

export async function ensureObservabilityFoundationAsync(db) {
  const eventTypes = await ensureObservabilityEventTypesAsync(db);
  const jobTypes = await ensureObservabilityJobTypesAsync(db);
  const handlers = registerObservabilityHandlers();
  registerObservabilitySources();

  let tenants = [];
  try {
    tenants = await tenantIdsAsync(db);
  } catch {
    tenants = [];
  }

  let configuration = 0;
  for (const tenantId of tenants) {
    configuration += (await ensureObservabilityConfigAsync(db, tenantId)).created || 0;
  }
  const search = (await ensureObservabilitySearchAsync(db)).created || 0;

  return {
    source_module: SOURCE_MODULE,
    providers: listProviders().map((provider) => ({ code: provider.code, status: provider.status })),
    event_types: eventTypes,
    job_types: jobTypes.created,
    handlers,
    configuration,
    search,
    tenants: tenants.length,
  };
}

export function observabilityHealth(db, tenantId = null) {
  const scope = tenantId ? Number(tenantId) : null;
  const scoped = (table) =>
    Number((scope ? queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [scope]) : queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`))?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    providers: listProviders().map((provider) => ({ code: provider.code, status: provider.status })),
    counts: {
      metrics: scoped("observability_metric_definitions"),
      observations: scoped("observability_metric_observations"),
      thresholds: scoped("observability_thresholds"),
      assets: scoped("observability_data_assets"),
      freshness: scoped("observability_freshness_definitions"),
      health_checks: scoped("observability_health_checks"),
      health_snapshots: scoped("observability_health_snapshots"),
      alert_rules: scoped("observability_alert_rules"),
      alerts: scoped("observability_alerts"),
      incidents: scoped("observability_incidents"),
      slos: scoped("observability_slo_definitions"),
      dashboards: scoped("observability_dashboards"),
      widgets: scoped("observability_dashboard_widgets"),
      runs: scoped("observability_observation_runs"),
      jobs: scoped("observability_jobs"),
      history: scoped("observability_history"),
    },
    tenant_count: queryOne(db, "SELECT COUNT(DISTINCT tenant_id) AS c FROM observability_metric_definitions")?.c || 0,
  };
}

// Async twin of `observabilityHealth` for the migrated read route.
export async function observabilityHealthAsync(db, tenantId = null) {
  const scope = tenantId ? Number(tenantId) : null;
  const scoped = async (table) =>
    Number((scope ? await queryOneAsync(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [scope]) : await queryOneAsync(db, `SELECT COUNT(*) AS c FROM ${table}`))?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    providers: listProviders().map((provider) => ({ code: provider.code, status: provider.status })),
    counts: {
      metrics: await scoped("observability_metric_definitions"),
      observations: await scoped("observability_metric_observations"),
      thresholds: await scoped("observability_thresholds"),
      assets: await scoped("observability_data_assets"),
      freshness: await scoped("observability_freshness_definitions"),
      health_checks: await scoped("observability_health_checks"),
      health_snapshots: await scoped("observability_health_snapshots"),
      alert_rules: await scoped("observability_alert_rules"),
      alerts: await scoped("observability_alerts"),
      incidents: await scoped("observability_incidents"),
      slos: await scoped("observability_slo_definitions"),
      dashboards: await scoped("observability_dashboards"),
      widgets: await scoped("observability_dashboard_widgets"),
      runs: await scoped("observability_observation_runs"),
      jobs: await scoped("observability_jobs"),
      history: await scoped("observability_history"),
    },
    tenant_count: (await queryOneAsync(db, "SELECT COUNT(DISTINCT tenant_id) AS c FROM observability_metric_definitions"))?.c || 0,
  };
}

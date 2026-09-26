// Idempotent bootstrap for the Standards & Exchange capability.
//
// Called on every application boot: registers adapters, formats, event types,
// job types and handlers, search sources and security object types, per-tenant
// configuration and enterprise validation handlers. It registers into platform
// seams (events, jobs, search, security) and never duplicates them.
import { queryAll, queryOne } from "../../db.js";
import { tenantIds } from "../search/registry.js";
import { SOURCE_MODULE } from "./constants.js";
import { ensureExchangeEventTypes } from "./events.js";
import { ensureExchangeJobTypes, registerExchangeHandlers } from "./jobs.js";
import { ensureExchangeSearch, registerExchangeSources } from "./search.js";
import { ensureExchangeConfig } from "./configuration.js";
import { ensureAdapters, ensureFormats } from "./formats.js";
import { registerEnterpriseValidationHandlers } from "./validation.js";
import { adapterCatalog, ensureBuiltinAdapters } from "./adapters/index.js";
import { listIntegrations } from "./integrations.js";

export function ensureExchangeFoundation(db) {
  const adapters = adapterCatalog();
  const integrationCodes = listIntegrations().map((entry) => entry.code);
  const eventTypes = ensureExchangeEventTypes(db);
  const jobTypes = ensureExchangeJobTypes(db);
  const handlers = registerExchangeHandlers();
  const validationHandlers = registerEnterpriseValidationHandlers();
  registerExchangeSources();
  ensureBuiltinAdapters();

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }

  let formats = 0;
  let adapterRows = 0;
  let configuration = 0;
  for (const tenantId of tenants) {
    adapterRows += ensureAdapters(db, tenantId);
    formats += ensureFormats(db, tenantId);
    configuration += ensureExchangeConfig(db, tenantId).created || 0;
  }
  const search = ensureExchangeSearch(db).created || 0;

  return {
    source_module: SOURCE_MODULE,
    adapters: adapters.length,
    adapter_rows: adapterRows,
    formats,
    integrations: integrationCodes,
    validation_handlers: validationHandlers.length,
    event_types: eventTypes,
    job_types: jobTypes.created,
    handlers,
    configuration,
    search,
    tenants: tenants.length,
  };
}

export function exchangeHealth(db, tenantId = null) {
  const scope = tenantId ? Number(tenantId) : null;
  const scoped = (table) =>
    Number(
      (scope
        ? queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [scope])
        : queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`))?.c || 0
    );
  return {
    source_module: SOURCE_MODULE,
    adapters: adapterCatalog().map((adapter) => ({ code: adapter.code, status: adapter.status, category: adapter.category })),
    integrations: listIntegrations(),
    counts: {
      adapters: scoped("exchange_adapters"),
      formats: scoped("exchange_formats"),
      definitions: scoped("exchange_definitions"),
      mappings: scoped("exchange_mappings"),
      transformations: scoped("exchange_transformations"),
      validation_profiles: scoped("exchange_validation_profiles"),
      transactions: scoped("exchange_transactions"),
      jobs: scoped("exchange_jobs"),
      errors: scoped("exchange_errors"),
      reconciliations: scoped("exchange_reconciliations"),
      history: scoped("exchange_history"),
    },
    tenant_count: queryAll(db, "SELECT DISTINCT tenant_id FROM exchange_definitions").length,
  };
}

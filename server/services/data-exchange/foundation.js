// Idempotent bootstrap for the Import & Export Framework.
//
// Called on every application boot and by the seed. It registers the built-in
// connectors and background handlers, installs event types and per-tenant
// configuration, and exposes a health summary. It never duplicates platform
// seams (IAM, events, jobs, storage) — it registers into them.
import { queryAll, queryOne } from "../../db.js";
import { tenantIds } from "../search/registry.js";
import { ensureConnectors } from "./connectors/index.js";
import { registerExchangeHandlers } from "./jobs.js";
import { ensureExchangeEventTypes } from "./events.js";
import { ensureExchangeConfig } from "./configuration.js";
import { ensureDataExchangeSearch, registerDataExchangeSources } from "./search.js";
import { SOURCE_MODULE } from "./constants.js";

export function ensureExchangeFoundation(db) {
  const connectors = ensureConnectors();
  const handlers = registerExchangeHandlers();
  const eventTypes = ensureExchangeEventTypes(db);
  registerDataExchangeSources();

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }
  let configuration = 0;
  const search = ensureDataExchangeSearch(db).created || 0;
  for (const tenantId of tenants) {
    configuration += ensureExchangeConfig(db, tenantId).created || 0;
  }

  return {
    source_module: SOURCE_MODULE,
    connectors,
    handlers,
    event_types: eventTypes,
    configuration,
    search,
    tenants: tenants.length,
  };
}

export function exchangeHealth(db, tenantId = null) {
  const scoped = (table, column = "tenant_id") =>
    tenantId
      ? Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`, [Number(tenantId)])?.c || 0)
      : Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`)?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    counts: {
      import_definitions: scoped("ie_import_definitions"),
      export_definitions: scoped("ie_export_definitions"),
      import_jobs: scoped("ie_import_jobs"),
      export_jobs: scoped("ie_export_jobs"),
      connector_configurations: scoped("ie_connector_configurations"),
      templates: scoped("ie_templates"),
      history: scoped("ie_import_history") + scoped("ie_export_history"),
    },
    tenant_count: queryAll(db, "SELECT DISTINCT tenant_id FROM ie_connector_configurations").length,
  };
}

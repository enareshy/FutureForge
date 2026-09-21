// Idempotent bootstrap for the Data Catalog & Business Glossary. Called on every
// application boot and by the seed. It wires the service into the shared
// platform seams (events, jobs, search, security, domains, configuration)
// without duplicating them.
import { queryAll, queryOne } from "../../db.js";
import { tenantIds } from "../search/registry.js";
import { ensureCatalogEventTypes } from "./events.js";
import { registerCatalogSources, ensureCatalogSearch } from "./search.js";
import { registerCatalogHandlers } from "./jobs.js";
import { ensureDefaultRelationshipTypes } from "./relationships.js";
import { setConfig, getConfigRow } from "./configuration.js";
import { CONFIG_DEFAULTS } from "./constants.js";

export function ensureCatalogConfig(db, tenantId) {
  let created = 0;
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
    if (getConfigRow(db, tenantId, key)) continue;
    setConfig(db, tenantId, key, value, null, null);
    created += 1;
  }
  return { created };
}

export function ensureCatalogFoundation(db) {
  const eventTypes = ensureCatalogEventTypes(db);
  registerCatalogSources();
  registerCatalogHandlers();

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }
  const search = ensureCatalogSearch(db);

  let relationshipTypes = 0;
  let configuration = 0;
  for (const tenantId of tenants) {
    relationshipTypes += ensureDefaultRelationshipTypes(db, tenantId).created;
    configuration += ensureCatalogConfig(db, tenantId).created;
  }

  return {
    event_types: eventTypes,
    search_registrations: search.created,
    relationship_types: relationshipTypes,
    configuration,
    tenants: tenants.length,
  };
}

export function catalogHealth(db, tenantId = null) {
  const scoped = (table) =>
    tenantId
      ? Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [Number(tenantId)])?.c || 0)
      : Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`)?.c || 0);
  return {
    counts: {
      entries: scoped("dc_entries"),
      terms: scoped("dc_business_terms"),
      objects: scoped("dc_catalog_objects"),
      attributes: scoped("dc_catalog_attributes"),
      sources: scoped("dc_sources"),
      consumers: scoped("dc_consumers"),
      lineage: scoped("dc_lineage"),
      classifications: scoped("dc_classifications"),
    },
    tenant_count: queryAll(db, "SELECT DISTINCT tenant_id FROM dc_entries").length,
  };
}

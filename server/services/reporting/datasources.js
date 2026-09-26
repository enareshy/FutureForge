// Controlled data-source abstraction (§8).
//
// The reporting engine is not coupled to a specific database technology. It
// asks a `ReportingDataSource` provider for authorized flat records; today the
// object model, the search index and the reporting read model are available,
// while a data mart, external BI source and API source are honest extension
// points. Adding a warehouse later means registering a provider here, not
// rewriting the query engine.
import { queryAll } from "../../db.js";
import { DATA_SOURCE_CODES } from "./constants.js";
import { dataSourceNotFound, dataSourceUnavailable } from "./errors.js";
import { resolveEntityRows, getEntity } from "./semantic.js";
import { createRecordAuthorizer } from "./security.js";
import { parseJson } from "./repository.js";
import { searchObjects } from "../search.js";

const CATALOG = [
  {
    code: "OBJECT_MODEL",
    name: "Object model",
    description: "Live enterprise objects read through the semantic layer and centralized security.",
    status: "AVAILABLE",
    provider: "platform",
    capabilities: { live: true, aggregation: true, filtering: true, security: "centralized" },
  },
  {
    code: "SEARCH_INDEX",
    name: "Search index",
    description: "Enterprise Search index for discovery-oriented reports.",
    status: "AVAILABLE",
    provider: "platform",
    capabilities: { live: true, aggregation: false, filtering: true, security: "centralized" },
  },
  {
    code: "REPORTING_READ_MODEL",
    name: "Reporting read model",
    description: "Denormalized analytical read model refreshed from the operational model by a background job.",
    status: "AVAILABLE",
    provider: "platform",
    capabilities: { live: false, aggregation: true, filtering: true, security: "centralized" },
  },
  {
    code: "DATA_MART",
    name: "Data mart",
    description: "Dedicated analytical data mart for enterprise-scale aggregations. Extension point.",
    status: "PLANNED",
    provider: "external",
    capabilities: { live: false, aggregation: true, extension_point: true },
  },
  {
    code: "EXTERNAL_BI",
    name: "External BI source",
    description: "External BI platform dataset published through the BI integration layer. Extension point.",
    status: "PLANNED",
    provider: "external",
    capabilities: { live: false, extension_point: true, bi: true },
  },
  {
    code: "API",
    name: "Remote API",
    description: "Registered Integration & API endpoint used as a reporting source. Extension point.",
    status: "PLANNED",
    provider: "external",
    capabilities: { live: true, extension_point: true },
  },
];

export function dataSourceCatalog() {
  return CATALOG.map((entry) => ({ ...entry, capabilities: { ...entry.capabilities } }));
}

export function listDataSources() {
  return { items: dataSourceCatalog(), source_module: "reporting" };
}

export function getDataSource(code) {
  const entry = CATALOG.find((item) => item.code === String(code || "").toUpperCase());
  if (!entry) throw dataSourceNotFound(code);
  return entry;
}

function assertAvailable(entry, options = {}) {
  if (entry.code === "DATA_MART" && options.dataMartEnabled) return;
  if (entry.code === "EXTERNAL_BI" && options.externalBiEnabled) return;
  if (entry.code === "API" && options.apiEnabled) return;
  if (entry.status !== "AVAILABLE") throw dataSourceUnavailable(entry.code, entry.status);
}

// ── Providers ────────────────────────────────────────────────────────────────

const objectModelProvider = {
  code: "OBJECT_MODEL",
  resolve(db, { entity, tenantId, actor, organizationId, ip, context, limit, options }) {
    return resolveEntityRows(db, entity, { tenantId, actor, organizationId, ip, context, limit });
  },
};

const readModelProvider = {
  code: "REPORTING_READ_MODEL",
  resolve(db, { entity, tenantId, actor, organizationId, ip, context, limit }) {
    getEntity(entity);
    const rows = queryAll(
      db,
      "SELECT * FROM reporting_read_model WHERE tenant_id = ? AND entity = ? ORDER BY id LIMIT ?",
      [Number(tenantId), entity, Math.min(100000, Math.max(1, Number(limit) || 50000))]
    );
    const records = rows.map((row) => ({
      object_type: row.object_type || entity,
      object_id: String(row.object_id ?? row.id),
      organization_id: row.organization_id ?? null,
      classification: row.classification || "",
      attributes: parseJson(row.attributes_json, {}),
    }));
    const authorizer = createRecordAuthorizer(db, actor, { tenantId: Number(tenantId), action: "read", organizationId, ip, context });
    return { records: authorizer.filter(records), denied: authorizer.deniedCount(records), total_before_security: records.length };
  },
};

const searchIndexProvider = {
  code: "SEARCH_INDEX",
  resolve(db, { entity, tenantId, actor, organizationId, ip, context, limit }) {
    const definition = getEntity(entity);
    const objectType = definition.object_type || (definition.source === "object" ? "object" : definition.source);
    const result = searchObjects(
      db,
      { object_types: [objectType], page_size: Math.min(500, Number(limit) || 200) },
      actor,
      { tenantId: Number(tenantId), ip }
    );
    const records = (result.results || result.items || []).map((item) => ({
      object_type: item.object_type || objectType,
      object_id: String(item.object_id ?? item.id),
      organization_id: item.organization_id ?? null,
      classification: "",
      attributes: { number: item.code || item.title, name: item.title, status: item.status, object_type: item.object_type },
    }));
    const authorizer = createRecordAuthorizer(db, actor, { tenantId: Number(tenantId), action: "read", organizationId, ip, context });
    return { records: authorizer.filter(records), denied: authorizer.deniedCount(records), total_before_security: records.length };
  },
};

const PROVIDERS = new Map([
  ["OBJECT_MODEL", objectModelProvider],
  ["REPORTING_READ_MODEL", readModelProvider],
  ["SEARCH_INDEX", searchIndexProvider],
]);

export function getProvider(code, options = {}) {
  const entry = getDataSource(code);
  assertAvailable(entry, options);
  const provider = PROVIDERS.get(entry.code);
  if (!provider) throw dataSourceUnavailable(entry.code, entry.status);
  return provider;
}

// Resolve authorized records for an entity from a named data source.
export function resolveDataSourceRows(db, code, options = {}) {
  const provider = getProvider(code, options);
  return provider.resolve(db, options);
}

export function availableDataSourceCodes() {
  return DATA_SOURCE_CODES.filter((code) => CATALOG.find((entry) => entry.code === code)?.status === "AVAILABLE");
}

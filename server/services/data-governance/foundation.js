// Idempotent bootstrap for Data Governance & Data Quality. Called on every
// application boot and by the seed. It wires the service into the shared
// platform seams (events, jobs, search, security, dimensions, configuration)
// without duplicating them.
import { queryAll, queryOne } from "../../db.js";
import { tenantIds } from "../search/registry.js";
import { registerHandler as registerEventConsumer } from "../events/handlers.js";
import { createSubscription } from "../events/subscriptions.js";
import { getEventTypeRow } from "../events/registry.js";
import { getObject } from "../objects.js";
import { ensureGovernanceEventTypes } from "./events.js";
import { ensureDefaultAdapters } from "./adapter.js";
import { registerBuiltinStrategies } from "./duplicates.js";
import { ensureDataGovernanceSearch, registerDataGovernanceSources } from "./search.js";
import { ensureDefaultDimensions } from "./dimensions.js";
import { setConfig, getConfigRow } from "./configuration.js";
import { registerDataGovernanceHandlers, evaluateOnEvent } from "./jobs.js";
import { findCatalogByType } from "./catalog.js";
import { CONFIG_DEFAULTS } from "./constants.js";

export const EVENT_EVALUATION_TYPES = ["ObjectCreated", "ObjectUpdated"];

// Registers the event consumer that re-evaluates a governed object when it
// changes. Only objects whose type is registered in the catalogue are
// evaluated, so unrelated modules do not create work.
export function registerEventEvaluationHandler() {
  registerEventConsumer(
    "dataquality.evaluateevent",
    async ({ db, event }) => {
      const tenantId = Number(event.tenant_id);
      if (!tenantId) return { skipped: true, reason: "no_tenant" };
      if (String(event.source_object_type || "").toLowerCase() !== "object") {
        return { skipped: true, reason: "unsupported_source" };
      }
      let objectType = null;
      try {
        const row = getObject(db, event.source_object_id, tenantId);
        objectType = row?.type?.code || null;
      } catch {
        objectType = null;
      }
      if (!objectType) return { skipped: true, reason: "object_not_found" };
      if (!findCatalogByType(db, tenantId, objectType)) return { skipped: true, reason: "ungoverned_type" };
      return evaluateOnEvent(db, { tenantId, objectType, objectId: event.source_object_id });
    },
    { description: "Re-evaluate a governed object when it changes", module: "data-governance" }
  );
  return ["dataquality.evaluateevent"];
}

function ensureEventEvaluationSubscriptions(db, tenantId) {
  let created = 0;
  for (const eventTypeCode of EVENT_EVALUATION_TYPES) {
    if (!getEventTypeRow(db, eventTypeCode)) continue;
    const code = `dataquality.eval.${eventTypeCode.toLowerCase()}`;
    const existing = queryOne(db, "SELECT id FROM event_subscriptions WHERE code = ? AND COALESCE(tenant_id, 0) = COALESCE(?, 0)", [code, tenantId]);
    if (existing) continue;
    createSubscription(
      db,
      {
        code,
        name: `Data quality evaluation on ${eventTypeCode}`,
        description: "Re-evaluate a governed object after it changes",
        subscriber: "data-governance",
        event_type_code: eventTypeCode,
        handler: "dataquality.evaluateevent",
        status: "active",
      },
      null,
      tenantId
    );
    created += 1;
  }
  return { created };
}

function ensureTenantConfig(db, tenantId) {
  let created = 0;
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
    if (getConfigRow(db, tenantId, key)) continue;
    setConfig(db, tenantId, key, value, null, null);
    created += 1;
  }
  return { created };
}

export function ensureDataGovernanceFoundation(db) {
  const eventTypes = ensureGovernanceEventTypes(db);
  const adapters = ensureDefaultAdapters();
  const strategies = registerBuiltinStrategies();
  registerDataGovernanceSources();
  registerDataGovernanceHandlers();
  registerEventEvaluationHandler();

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }
  const search = ensureDataGovernanceSearch(db);

  let dimensions = 0;
  let configuration = 0;
  let subscriptions = 0;
  for (const tenantId of tenants) {
    dimensions += ensureDefaultDimensions(db, tenantId).created;
    configuration += ensureTenantConfig(db, tenantId).created;
    subscriptions += ensureEventEvaluationSubscriptions(db, tenantId).created;
  }

  return {
    event_types: eventTypes,
    adapters: adapters.adapters,
    duplicate_strategies: strategies.length,
    search_registrations: search.created,
    dimensions,
    configuration,
    subscriptions,
    tenants: tenants.length,
  };
}

export function dataGovernanceHealth(db) {
  const counts = {
    domains: Number(queryOne(db, "SELECT COUNT(*) AS c FROM dg_domains")?.c ?? 0),
    policies: Number(queryOne(db, "SELECT COUNT(*) AS c FROM dg_policies")?.c ?? 0),
    rules: Number(queryOne(db, "SELECT COUNT(*) AS c FROM dg_rules")?.c ?? 0),
    results: Number(queryOne(db, "SELECT COUNT(*) AS c FROM dg_quality_results")?.c ?? 0),
    exceptions: Number(queryOne(db, "SELECT COUNT(*) AS c FROM dg_quality_exceptions")?.c ?? 0),
  };
  return { counts, tenant_count: queryAll(db, "SELECT DISTINCT tenant_id FROM dg_domains").length };
}

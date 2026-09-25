// Idempotent bootstrap for the Digital Thread capability.
//
// Called on every application boot: registers providers, event types, job types
// and handlers, search sources and security object types, per-tenant
// configuration, the default definition and default traceability rules. It
// registers into platform seams (IAM, events, jobs, search) and never
// duplicates them.
import { queryAll, queryOne } from "../../db.js";
import { tenantIds } from "../search/registry.js";
import { registerHandler as registerEventHandler } from "../events/handlers.js";
import { SOURCE_MODULE } from "./constants.js";
import { ensureThreadEventTypes } from "./events.js";
import { ensureThreadJobTypes, registerThreadHandlers, PROJECT_HANDLER } from "./jobs.js";
import { ensureThreadSearch, registerThreadSources } from "./search.js";
import { ensureThreadConfig } from "./configuration.js";
import { ensureDefaultDefinitions } from "./definitions.js";
import { ensureDefaultRules } from "./rules.js";
import { registerBuiltinProviders } from "./provider-builtins.js";
import { ensureProviders } from "./traversal.js";
import { listProviders } from "./providers.js";
import { handleSourceEvent } from "./projection.js";

// Registers the event-subscription bridge that keeps the derived projection
// fresh. Operators bind a subscription to this handler; the handler is
// idempotent and best-effort, so a projection failure never fails the event.
function ensureThreadEventBridge() {
  registerEventHandler(
    PROJECT_HANDLER,
    async ({ db, event }) => handleSourceEvent(db, event || {}),
    { description: "Update the derived digital thread projection from a source domain event", module: SOURCE_MODULE, builtin: true }
  );
  return PROJECT_HANDLER;
}

export function ensureThreadFoundation(db) {
  const providers = registerBuiltinProviders();
  ensureProviders();
  const eventTypes = ensureThreadEventTypes(db);
  const jobTypes = ensureThreadJobTypes(db);
  const handlers = registerThreadHandlers();
  const eventBridge = ensureThreadEventBridge();
  registerThreadSources();

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }

  let configuration = 0;
  let definitions = 0;
  let rules = 0;
  for (const tenantId of tenants) {
    configuration += ensureThreadConfig(db, tenantId).created || 0;
    definitions += ensureDefaultDefinitions(db, tenantId).created || 0;
    rules += ensureDefaultRules(db, tenantId).created || 0;
  }
  const search = ensureThreadSearch(db).created || 0;

  return {
    source_module: SOURCE_MODULE,
    providers,
    event_types: eventTypes,
    event_bridge: eventBridge,
    job_types: jobTypes.created,
    handlers,
    configuration,
    definitions,
    rules,
    search,
    tenants: tenants.length,
  };
}

export function threadHealth(db, tenantId = null) {
  const scope = tenantId ? Number(tenantId) : null;
  const scoped = (table) =>
    Number(
      (scope
        ? queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [scope])
        : queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`))?.c || 0
    );
  // Child tables inherit tenancy through their parent snapshot/baseline.
  const childScoped = (table, parent, foreignKey) =>
    Number(
      (scope
        ? queryOne(
            db,
            `SELECT COUNT(*) AS c FROM ${table} child JOIN ${parent} parent_row ON parent_row.id = child.${foreignKey} WHERE parent_row.tenant_id = ?`,
            [scope]
          )
        : queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`))?.c || 0
    );
  return {
    source_module: SOURCE_MODULE,
    providers: listProviders(),
    counts: {
      definitions: scoped("thread_definitions"),
      definition_domains: scoped("thread_definition_domains"),
      definition_relationships: scoped("thread_definition_relationships"),
      rules: scoped("thread_traceability_rules"),
      snapshots: scoped("thread_snapshots"),
      snapshot_nodes: childScoped("thread_snapshot_nodes", "thread_snapshots", "snapshot_id"),
      snapshot_edges: childScoped("thread_snapshot_edges", "thread_snapshots", "snapshot_id"),
      baselines: scoped("thread_baselines"),
      baseline_members: childScoped("thread_baseline_members", "thread_baselines", "baseline_id"),
      query_history: scoped("thread_query_history"),
      change_history: scoped("thread_change_history"),
      projections: scoped("thread_projections"),
    },
    tenant_count: queryAll(db, "SELECT DISTINCT tenant_id FROM thread_definitions").length,
  };
}

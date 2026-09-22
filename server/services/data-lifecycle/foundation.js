// Idempotent bootstrap for the Data Lifecycle & Archival service.
//
// Called on every application boot and by the seed. It wires the service into
// the shared platform seams (events, jobs, search, security, configuration)
// without duplicating them, and installs the default per-tenant state model,
// transition graph and tier mapping.
import { queryAll, queryOne } from "../../db.js";
import { tenantIds } from "../search/registry.js";
import { ensureLifecycleEventTypes } from "./events.js";
import { registerLifecycleSources, ensureLifecycleSearch } from "./search.js";
import { registerLifecycleHandlers } from "./jobs.js";
import { ensureDefaultStates } from "./states.js";
import { ensureLifecycleConfig } from "./configuration.js";

export function ensureLifecycleFoundation(db) {
  const eventTypes = ensureLifecycleEventTypes(db);
  registerLifecycleSources();
  registerLifecycleHandlers();

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }
  const search = ensureLifecycleSearch(db);

  let states = 0;
  let transitions = 0;
  let tiers = 0;
  let configuration = 0;
  for (const tenantId of tenants) {
    const installed = ensureDefaultStates(db, tenantId);
    states += installed.states;
    transitions += installed.transitions;
    tiers += installed.tiers;
    configuration += ensureLifecycleConfig(db, tenantId).created;
  }

  return {
    event_types: eventTypes,
    search_registrations: search.created,
    states,
    transitions,
    tiers,
    configuration,
    tenants: tenants.length,
  };
}

export function lifecycleHealth(db, tenantId = null) {
  const scoped = (table, column = "tenant_id") =>
    tenantId ? Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`, [Number(tenantId)])?.c || 0) : Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`)?.c || 0);
  return {
    counts: {
      objects: scoped("lc_object_lifecycle"),
      policies: scoped("lc_policies"),
      legal_holds: scoped("lc_legal_holds"),
      archives: scoped("lc_archive_records"),
      restores: scoped("lc_restore_records"),
      recoveries: scoped("lc_recovery_records"),
      purges: scoped("lc_purge_records"),
      jobs: scoped("lc_lifecycle_jobs"),
      history: scoped("lc_history"),
    },
    tenant_count: queryAll(db, "SELECT DISTINCT tenant_id FROM lc_object_lifecycle").length,
  };
}

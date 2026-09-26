// Idempotent bootstrap for the Enterprise Classification Framework.
//
// Called on every application boot: registers units into the shared UOM domain,
// event types, job types and handlers, search sources, duplicate strategies and
// per-tenant configuration. It registers into platform seams (IAM, events, jobs,
// search, reference data) and never duplicates them.
import { queryAll, queryOne } from "../../db.js";
import { tenantIds } from "../search/registry.js";
import { SOURCE_MODULE } from "./constants.js";
import { ensureClassificationUnits } from "./units.js";
import { ensureClassificationEventTypes } from "./events.js";
import { ensureClassificationJobTypes, registerClassificationHandlers } from "./jobs.js";
import { ensureClassificationSearch, registerClassificationSources } from "./search.js";
import { registerClassificationDuplicateStrategies } from "./duplicates.js";
import { ensureClassificationConfig } from "./configuration.js";

export function ensureClassificationFoundation(db) {
  const units = ensureClassificationUnits(db);
  const eventTypes = ensureClassificationEventTypes(db);
  const jobTypes = ensureClassificationJobTypes(db);
  const handlers = registerClassificationHandlers();
  registerClassificationSources();
  const duplicateStrategies = registerClassificationDuplicateStrategies();

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }

  let configuration = 0;
  for (const tenantId of tenants) configuration += ensureClassificationConfig(db, tenantId).created || 0;
  const search = ensureClassificationSearch(db).created || 0;

  return {
    source_module: SOURCE_MODULE,
    units,
    event_types: eventTypes,
    job_types: jobTypes.created,
    handlers,
    duplicate_strategies: duplicateStrategies,
    configuration,
    search,
    tenants: tenants.length,
  };
}

export function classificationHealth(db, tenantId = null) {
  const scoped = (table) =>
    tenantId
      ? Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [Number(tenantId)])?.c || 0)
      : Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`)?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    counts: {
      classifications: scoped("cla_classifications"),
      classes: scoped("cla_classes"),
      characteristics: scoped("cla_characteristics"),
      allowed_values: scoped("cla_allowed_values"),
      assignments: scoped("cla_assignments"),
      assignment_values: scoped("cla_assignment_values"),
      rules: scoped("cla_rules"),
      history: scoped("cla_change_history"),
    },
    tenant_count: queryAll(db, "SELECT DISTINCT tenant_id FROM cla_assignments").length,
  };
}

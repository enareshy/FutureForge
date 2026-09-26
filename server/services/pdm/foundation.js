// Idempotent bootstrap for the P1 PDM domain.
//
// Called on every application boot: registers event types, job types and
// handlers, search sources and security object types, per-tenant configuration
// and default validation rules. It registers into platform seams (IAM, events,
// jobs, search, reference data) and never duplicates them.
import { queryAll, queryOne } from "../../db.js";
import { tenantIds } from "../search/registry.js";
import { SOURCE_MODULE } from "./constants.js";
import { ensurePdmEventTypes } from "./events.js";
import { ensurePdmJobTypes, registerPdmHandlers } from "./jobs.js";
import { ensurePdmSearch, registerPdmSources } from "./search.js";
import { ensurePdmConfig } from "./configuration.js";
import { ensureDefaultValidationRules } from "./validator.js";

export function ensurePdmFoundation(db) {
  const eventTypes = ensurePdmEventTypes(db);
  const jobTypes = ensurePdmJobTypes(db);
  const handlers = registerPdmHandlers();
  registerPdmSources();

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }

  let configuration = 0;
  let validationRules = 0;
  for (const tenantId of tenants) {
    configuration += ensurePdmConfig(db, tenantId).created || 0;
    validationRules += ensureDefaultValidationRules(db, tenantId);
  }
  const search = ensurePdmSearch(db).created || 0;

  return {
    source_module: SOURCE_MODULE,
    event_types: eventTypes,
    job_types: jobTypes.created,
    handlers,
    configuration,
    validation_rules: validationRules,
    search,
    tenants: tenants.length,
  };
}

export function pdmHealth(db, tenantId = null) {
  const scoped = (table) =>
    tenantId
      ? Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [Number(tenantId)])?.c || 0)
      : Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`)?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    counts: {
      items: scoped("pdm_items"),
      revisions: scoped("pdm_item_revisions"),
      datasets: scoped("pdm_datasets"),
      representations: scoped("pdm_representations"),
      design_data: scoped("pdm_design_data"),
      cad_associations: scoped("pdm_cad_associations"),
      revision_rules: scoped("pdm_revision_rules"),
      configuration_rules: scoped("pdm_configuration_rules"),
      baselines: scoped("pdm_baselines"),
      relationships: scoped("pdm_relationships"),
      references: scoped("pdm_references"),
      validation_rules: scoped("pdm_validation_rules"),
      validation_results: scoped("pdm_validation_results"),
      history: scoped("pdm_change_history"),
    },
    tenant_count: queryAll(db, "SELECT DISTINCT tenant_id FROM pdm_items").length,
  };
}

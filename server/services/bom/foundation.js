// Idempotent bootstrap for the P1 BOM Engine.
//
// Called on every application boot: registers units into the shared UOM domain,
// event types, job types and handlers, search sources and security object types,
// per-tenant configuration and default validation rules. It registers into
// platform seams (IAM, events, jobs, search, reference data) and never duplicates
// them.
import { queryAll, queryOne } from "../../db.js";
import { tenantIds } from "../search/registry.js";
import { SOURCE_MODULE } from "./constants.js";
import { ensureBomUnits } from "./units.js";
import { ensureBomEventTypes } from "./events.js";
import { ensureBomJobTypes, registerBomHandlers } from "./jobs.js";
import { ensureBomSearch, registerBomSources } from "./search.js";
import { ensureBomConfig } from "./configuration.js";
import { ensureDefaultValidationRules } from "./validator.js";

export function ensureBomFoundation(db) {
  const units = ensureBomUnits(db);
  const eventTypes = ensureBomEventTypes(db);
  const jobTypes = ensureBomJobTypes(db);
  const handlers = registerBomHandlers();
  registerBomSources();

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }

  let configuration = 0;
  let validationRules = 0;
  for (const tenantId of tenants) {
    configuration += ensureBomConfig(db, tenantId).created || 0;
    validationRules += ensureDefaultValidationRules(db, tenantId);
  }
  const search = ensureBomSearch(db).created || 0;

  return {
    source_module: SOURCE_MODULE,
    units,
    event_types: eventTypes,
    job_types: jobTypes.created,
    handlers,
    configuration,
    validation_rules: validationRules,
    search,
    tenants: tenants.length,
  };
}

export function bomHealth(db, tenantId = null) {
  const scoped = (table) =>
    tenantId
      ? Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [Number(tenantId)])?.c || 0)
      : Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`)?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    counts: {
      boms: scoped("bom_headers"),
      revisions: scoped("bom_revisions"),
      lines: scoped("bom_lines"),
      substitutes: scoped("bom_substitutes"),
      baselines: scoped("bom_baselines"),
      transformation_definitions: scoped("bom_transformation_definitions"),
      validation_rules: scoped("bom_validation_rules"),
      comparisons: scoped("bom_comparisons"),
      history: scoped("bom_change_history"),
    },
    tenant_count: queryAll(db, "SELECT DISTINCT tenant_id FROM bom_headers").length,
  };
}

// Foundation bootstrap for the Effectivity & Versioning Kernel. Idempotent on
// every boot: effectivity-type catalogue, the default resolution policy, event
// types and search registrations.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { CORE_PRECEDENCE } from "./validation.js";
import { ensureVersioningEventTypes } from "./events.js";
import { ensureVersioningSearchRegistration } from "./search.js";

export const DEFAULT_EFFECTIVITY_TYPES = [
  { code: "DATE_EFFECTIVITY", name: "Date effectivity", dimension: "date", value_mode: "date_range", description: "Effective from / to dates, inclusive or exclusive." },
  { code: "SERIAL_EFFECTIVITY", name: "Serial effectivity", dimension: "serial", value_mode: "serial_range", description: "Serial number ranges, numeric or alphanumeric." },
  { code: "PLANT_EFFECTIVITY", name: "Plant effectivity", dimension: "plant", value_mode: "list", description: "Applicable manufacturing plants." },
  { code: "UNIT_EFFECTIVITY", name: "Unit effectivity", dimension: "unit", value_mode: "list", description: "Applicable manufacturing / production units." },
  { code: "SITE_EFFECTIVITY", name: "Site effectivity", dimension: "site", value_mode: "list", description: "Applicable sites." },
  { code: "ORGANIZATION_EFFECTIVITY", name: "Organization effectivity", dimension: "organization", value_mode: "list", description: "Applicable organizations / companies / business units." },
  { code: "MODEL_EFFECTIVITY", name: "Model effectivity", dimension: "model", value_mode: "list", description: "Applicable models, families and ranges." },
  { code: "REVISION_EFFECTIVITY", name: "Revision effectivity", dimension: "revision", value_mode: "reference", description: "Effectiveness relative to another controlled revision." },
  { code: "VARIANT_EFFECTIVITY", name: "Variant effectivity", dimension: "variant", value_mode: "list", description: "Applicable product variants." },
  { code: "CONFIGURATION_EFFECTIVITY", name: "Configuration effectivity", dimension: "configuration", value_mode: "reference", description: "Applicable configuration contexts." },
];

export function ensureEffectivityTypes(db) {
  let created = 0;
  const ts = nowIso();
  for (const type of DEFAULT_EFFECTIVITY_TYPES) {
    const existing = queryOne(db, "SELECT id FROM versioning_effectivity_types WHERE code = ?", [type.code]);
    if (existing) continue;
    run(
      db,
      `INSERT INTO versioning_effectivity_types (code, name, dimension, value_mode, description, config_json, system, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', 1, 'active', ?, ?)`,
      [type.code, type.name, type.dimension, type.value_mode, type.description, ts, ts]
    );
    created += 1;
  }
  return created;
}

export function ensureDefaultResolutionPolicy(db, { tenantId = null } = {}) {
  const existing = queryOne(db, "SELECT id FROM versioning_resolution_policies WHERE code = 'default'");
  if (existing) return 0;
  run(
    db,
    `INSERT INTO versioning_resolution_policies
      (code, name, description, precedence_json, boundary, ambiguity_strategy, allow_overlap, fallback_to_default,
       status, is_default, tenant_id, version, created_at, updated_at)
     VALUES ('default', 'Default resolution policy', 'Configuration -> revision -> serial -> model -> plant -> unit -> date -> default',
             ?, 'inclusive', 'error', 0, 1, 'active', 1, ?, 1, ?, ?)`,
    [JSON.stringify(CORE_PRECEDENCE), tenantId, nowIso(), nowIso()]
  );
  return 1;
}

export function ensureVersioningFoundation(db) {
  const types = ensureEffectivityTypes(db);
  const policies = ensureDefaultResolutionPolicy(db);
  let events = 0;
  let search = null;
  try {
    events = ensureVersioningEventTypes(db);
  } catch {
    events = 0;
  }
  try {
    search = ensureVersioningSearchRegistration(db);
  } catch {
    search = null;
  }
  return { effectivity_types: types, resolution_policies: policies, event_types: events, search };
}

export function vocabulary() {
  return {
    revision_statuses: ["draft", "active", "superseded", "retired", "archived"],
    version_statuses: ["draft", "active", "superseded", "retired", "archived"],
    dimensions: ["date", "serial", "unit", "plant", "model", "revision", "variant", "configuration"],
    resolution_statuses: ["RESOLVED", "AMBIGUOUS", "NOT_FOUND", "INVALID_CONTEXT", "CONFLICT"],
    relationship_types: ["supersedes", "effective_after", "effective_before", "applicable_with", "derived_from"],
    ambiguity_strategies: ["error", "priority", "latest_revision"],
    assignment_roles: ["primary", "override", "exclusion"],
    boundaries: ["inclusive", "exclusive"],
    serial_modes: ["numeric", "alphanumeric"],
    core_precedence: CORE_PRECEDENCE,
  };
}

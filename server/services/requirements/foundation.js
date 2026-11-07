// Idempotent bootstrap for the Requirements Manager domain.
//
// Called on every application boot: registers domain event types, numbering
// object types + live schemes for REQUIREMENT and REQUIREMENT_BASELINE,
// per-tenant configuration, the configurable requirement types, the default
// validation rules and the search/security object types. It also best-effort
// registers the generic metadata `requirement` business object type so the
// Object framework knows it. Nothing here duplicates a platform engine:
// numbering, search, security, events, metadata, audit, lifecycle and workflow
// all keep owning their own state (mirrors server/services/change/foundation.js).
import { queryOne } from "../../db.js";
import { queryOneAsync } from "../../db-async.js";
import { tenantIds, tenantIdsAsync } from "../search/registry.js";
import { createObjectType, createObjectTypeAsync } from "../numbering/foundation.js";
import { createScheme, setSchemeStatus, createSchemeAsync, setSchemeStatusAsync } from "../numbering/schemes.js";
import { getSchemeRow as getNumberingSchemeRow, getSchemeRowAsync as getNumberingSchemeRowAsync } from "../numbering/scopes.js";
import { createType as createMetadataType, findType as findMetadataType, createTypeAsync as createMetadataTypeAsync, findTypeAsync as findMetadataTypeAsync } from "../metadata/types.js";
import { ensureRequirementEventTypes, ensureRequirementEventTypesAsync } from "./events.js";
import { ensureRequirementsConfig, ensureRequirementsConfigAsync } from "./configuration.js";
import { ensureRequirementTypes, ensureRequirementTypesAsync } from "./types.js";
import { ensureRequirementValidationRules, ensureRequirementValidationRulesAsync } from "./validation-rules.js";
import { ensureRequirementsSearch, ensureRequirementsSearchAsync, registerRequirementSources } from "./search.js";
import { SOURCE_MODULE, NUMBERING_OBJECT_TYPES, REQUIREMENT_OBJECT_TYPE } from "./constants.js";

const NUMBERING_SCHEME_DEFAULTS = {
  [NUMBERING_OBJECT_TYPES.REQUIREMENT]: { code: "REQUIREMENT_DEFAULT", pattern: "REQ-{SEQ}", padding: 6 },
  [NUMBERING_OBJECT_TYPES.BASELINE]: { code: "REQUIREMENT_BASELINE_DEFAULT", pattern: "REQBASE-{SEQ}", padding: 5 },
};

function ensureNumberingObjectType(db, code) {
  const existing = queryOne(db, "SELECT id FROM numbering_object_types WHERE code = ? AND tenant_id IS NULL", [code]);
  if (existing) return false;
  try {
    createObjectType(db, { code, name: code, module: "requirements", status: "active" }, null, null, null);
    return true;
  } catch {
    return false;
  }
}

function ensureNumberingSchemes(db) {
  let created = 0;
  for (const [objectTypeCode, config] of Object.entries(NUMBERING_SCHEME_DEFAULTS)) {
    if (getNumberingSchemeRow(db, config.code)) continue;
    try {
      const scheme = createScheme(
        db,
        { code: config.code, name: `${objectTypeCode} default numbering`, object_type_code: objectTypeCode, pattern: config.pattern, padding: config.padding, scope_type: "global" },
        null,
        null,
        null
      );
      setSchemeStatus(db, scheme.code, "active", null, null);
      created += 1;
    } catch {
      // Idempotent by design; a concurrent boot may have already created it.
    }
  }
  return created;
}

function ensureNumberingFoundation(db) {
  let objectTypes = 0;
  for (const code of Object.values(NUMBERING_OBJECT_TYPES)) {
    if (ensureNumberingObjectType(db, code)) objectTypes += 1;
  }
  return { object_types: objectTypes, schemes: ensureNumberingSchemes(db) };
}

function registerRequirementMetadataType(db) {
  try {
    if (findMetadataType(db, REQUIREMENT_OBJECT_TYPE, null)) return { registered: false, reason: "already registered" };
  } catch {
    // Not found is expected on first boot; continue registering.
  }
  try {
    const type = createMetadataType(db, { code: REQUIREMENT_OBJECT_TYPE, name: "Requirement", status: "active" }, null, null, null);
    return { registered: true, type_id: type.id };
  } catch (err) {
    console.warn(`[requirements] Metadata type registration skipped: ${err?.message || err}`);
    return { registered: false, error: err?.message || String(err) };
  }
}

export function ensureRequirementsFoundation(db) {
  const eventTypes = ensureRequirementEventTypes(db);
  const numbering = ensureNumberingFoundation(db);
  registerRequirementMetadataType(db);
  registerRequirementSources();
  const search = ensureRequirementsSearch(db);

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }

  let configuration = 0;
  let types = 0;
  let validationRules = 0;
  for (const tenantId of tenants) {
    configuration += ensureRequirementsConfig(db, tenantId).created || 0;
    types += ensureRequirementTypes(db, tenantId).created || 0;
    validationRules += ensureRequirementValidationRules(db, tenantId).created || 0;
  }

  return { source_module: SOURCE_MODULE, event_types: eventTypes, numbering, search, tenants: tenants.length, configuration, types, validation_rules: validationRules };
}

async function ensureNumberingObjectTypeAsync(db, code) {
  const existing = await queryOneAsync(db, "SELECT id FROM numbering_object_types WHERE code = ? AND tenant_id IS NULL", [code]);
  if (existing) return false;
  try {
    await createObjectTypeAsync(db, { code, name: code, module: "requirements", status: "active" }, null, null, null);
    return true;
  } catch {
    return false;
  }
}

async function ensureNumberingSchemesAsync(db) {
  let created = 0;
  for (const [objectTypeCode, config] of Object.entries(NUMBERING_SCHEME_DEFAULTS)) {
    if (await getNumberingSchemeRowAsync(db, config.code)) continue;
    try {
      const scheme = await createSchemeAsync(
        db,
        { code: config.code, name: `${objectTypeCode} default numbering`, object_type_code: objectTypeCode, pattern: config.pattern, padding: config.padding, scope_type: "global" },
        null,
        null,
        null
      );
      await setSchemeStatusAsync(db, scheme.code, "active", null, null);
      created += 1;
    } catch {
      // Idempotent by design; a concurrent boot may have already created it.
    }
  }
  return created;
}

async function ensureNumberingFoundationAsync(db) {
  let objectTypes = 0;
  for (const code of Object.values(NUMBERING_OBJECT_TYPES)) {
    if (await ensureNumberingObjectTypeAsync(db, code)) objectTypes += 1;
  }
  return { object_types: objectTypes, schemes: await ensureNumberingSchemesAsync(db) };
}

async function registerRequirementMetadataTypeAsync(db) {
  try {
    if (await findMetadataTypeAsync(db, REQUIREMENT_OBJECT_TYPE, null)) return { registered: false, reason: "already registered" };
  } catch {
    // Not found is expected on first boot; continue registering.
  }
  try {
    const type = await createMetadataTypeAsync(db, { code: REQUIREMENT_OBJECT_TYPE, name: "Requirement", status: "active" }, null, null, null);
    return { registered: true, type_id: type.id };
  } catch (err) {
    console.warn(`[requirements] Metadata type registration skipped: ${err?.message || err}`);
    return { registered: false, error: err?.message || String(err) };
  }
}

export async function ensureRequirementsFoundationAsync(db) {
  const eventTypes = await ensureRequirementEventTypesAsync(db);
  const numbering = await ensureNumberingFoundationAsync(db);
  await registerRequirementMetadataTypeAsync(db);
  registerRequirementSources();
  const search = await ensureRequirementsSearchAsync(db);

  let tenants = [];
  try {
    tenants = await tenantIdsAsync(db);
  } catch {
    tenants = [];
  }

  let configuration = 0;
  let types = 0;
  let validationRules = 0;
  for (const tenantId of tenants) {
    configuration += (await ensureRequirementsConfigAsync(db, tenantId)).created || 0;
    types += (await ensureRequirementTypesAsync(db, tenantId)).created || 0;
    validationRules += (await ensureRequirementValidationRulesAsync(db, tenantId)).created || 0;
  }

  return { source_module: SOURCE_MODULE, event_types: eventTypes, numbering, search, tenants: tenants.length, configuration, types, validation_rules: validationRules };
}

export function requirementsHealth(db, tenantId = null) {
  const scoped = (table) =>
    tenantId
      ? Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [Number(tenantId)])?.c || 0)
      : Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`)?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    counts: {
      requirements: scoped("requirements"),
      revisions: scoped("requirement_revisions"),
      types: scoped("requirement_types"),
      relationships: scoped("requirement_relationships"),
      baselines: scoped("requirement_baselines"),
      validation_rules: scoped("requirement_validation_rules"),
      history: scoped("requirement_history"),
    },
  };
}

export async function requirementsHealthAsync(db, tenantId = null) {
  const scoped = async (table) =>
    tenantId
      ? Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [Number(tenantId)]))?.c || 0)
      : Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM ${table}`))?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    counts: {
      requirements: await scoped("requirements"),
      revisions: await scoped("requirement_revisions"),
      types: await scoped("requirement_types"),
      relationships: await scoped("requirement_relationships"),
      baselines: await scoped("requirement_baselines"),
      validation_rules: await scoped("requirement_validation_rules"),
      history: await scoped("requirement_history"),
    },
  };
}

// Idempotent bootstrap for the Verification & Validation (V&V) Engine.
//
// Called on every application boot: registers domain event types, numbering
// object types + live schemes for test cases / procedures / executions / waivers,
// per-tenant configuration, the default V&V methods, the generic metadata
// business-object types, and the search/security object types. Nothing here
// duplicates a platform engine: numbering, search, security, events, metadata,
// audit, lifecycle and workflow all keep owning their own state (mirrors
// requirements/foundation.js and requirement-manufacturing/foundation.js).
import { queryOne } from "../../db.js";
import { queryOneAsync } from "../../db-async.js";
import { tenantIds, tenantIdsAsync } from "../search/registry.js";
import { createObjectType, createObjectTypeAsync } from "../numbering/foundation.js";
import { createScheme, setSchemeStatus, createSchemeAsync, setSchemeStatusAsync } from "../numbering/schemes.js";
import { getSchemeRow as getNumberingSchemeRow, getSchemeRowAsync as getNumberingSchemeRowAsync } from "../numbering/scopes.js";
import {
  createType as createMetadataType,
  findType as findMetadataType,
  createTypeAsync as createMetadataTypeAsync,
  findTypeAsync as findMetadataTypeAsync,
} from "../metadata/types.js";
import { ensureVvEventTypes, ensureVvEventTypesAsync } from "./events.js";
import { ensureVvConfig, ensureVvConfigAsync } from "./configuration.js";
import { ensureVvMethods, ensureVvMethodsAsync } from "./methods.js";
import { ensureVvSearch, ensureVvSearchAsync, registerVvSources } from "./search.js";
import { registerVvProvider } from "./provider.js";
import { ensureVvJobTypes, ensureVvJobTypesAsync, registerVvHandlers } from "./jobs.js";
import {
  registerVvCoverageEventHandler,
  registerVvRequirementEventHandler,
  ensureVvEventSubscriptions,
  ensureVvEventSubscriptionsAsync,
  ensureVvRequirementSubscriptions,
  ensureVvRequirementSubscriptionsAsync,
} from "./subscriptions.js";
import { SOURCE_MODULE, NUMBERING_OBJECT_TYPES, NUMBERING_SCHEMES, VV_NODE_TYPES } from "./constants.js";

// Generic metadata business-object types owned by the V&V engine. These let the
// Object & Relationship framework, comments, attachments and audit treat V&V
// records as first-class business objects without a parallel registry.
const VV_METADATA_TYPES = [
  { code: VV_NODE_TYPES.TEST_CASE, name: "V&V Test Case" },
  { code: VV_NODE_TYPES.TEST_PROCEDURE, name: "V&V Test Procedure" },
  { code: "test_case_step", name: "V&V Test Procedure Step" },
  { code: VV_NODE_TYPES.TEST_EXECUTION, name: "V&V Test Execution" },
  { code: VV_NODE_TYPES.TEST_RESULT, name: "V&V Test Result" },
  { code: VV_NODE_TYPES.WAIVER, name: "V&V Waiver" },
];

function ensureNumberingObjectType(db, code) {
  const existing = queryOne(db, "SELECT id FROM numbering_object_types WHERE code = ? AND tenant_id IS NULL", [code]);
  if (existing) return false;
  try {
    createObjectType(db, { code, name: code, module: SOURCE_MODULE, status: "active" }, null, null, null);
    return true;
  } catch {
    return false;
  }
}

function ensureNumberingSchemes(db) {
  let created = 0;
  for (const [objectTypeCode, config] of Object.entries(NUMBERING_SCHEMES)) {
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

function registerVvMetadataTypes(db) {
  let registered = 0;
  for (const type of VV_METADATA_TYPES) {
    try {
      if (findMetadataType(db, type.code, null)) continue;
    } catch {
      // Not found is expected on first boot; continue registering.
    }
    try {
      createMetadataType(db, { code: type.code, name: type.name, module: SOURCE_MODULE, status: "active" }, null, null, null);
      registered += 1;
    } catch (err) {
      console.warn(`[verification-validation] Metadata type registration skipped: ${err?.message || err}`);
    }
  }
  return { registered };
}

export function ensureVvFoundation(db) {
  const eventTypes = ensureVvEventTypes(db);
  const numbering = ensureNumberingFoundation(db);
  const metadataTypes = registerVvMetadataTypes(db);
  const methods = ensureVvMethods(db);
  registerVvSources();
  const search = ensureVvSearch(db);
  const configuration = ensureVvConfig(db);
  const threadProvider = registerVvProvider();

  const jobTypes = ensureVvJobTypes(db);
  registerVvHandlers();
  registerVvCoverageEventHandler();
  registerVvRequirementEventHandler();
  const eventSubscriptions = ensureVvEventSubscriptions(db);
  const requirementSubscriptions = ensureVvRequirementSubscriptions(db);

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }

  return {
    source_module: SOURCE_MODULE,
    event_types: eventTypes,
    numbering,
    metadata_types: metadataTypes,
    methods,
    search,
    tenants: tenants.length,
    configuration,
    thread_provider: threadProvider,
    job_types: jobTypes,
    event_subscriptions: eventSubscriptions,
    requirement_subscriptions: requirementSubscriptions,
  };
}

async function ensureNumberingObjectTypeAsync(db, code) {
  const existing = await queryOneAsync(db, "SELECT id FROM numbering_object_types WHERE code = ? AND tenant_id IS NULL", [code]);
  if (existing) return false;
  try {
    await createObjectTypeAsync(db, { code, name: code, module: SOURCE_MODULE, status: "active" }, null, null, null);
    return true;
  } catch {
    return false;
  }
}

async function ensureNumberingSchemesAsync(db) {
  let created = 0;
  for (const [objectTypeCode, config] of Object.entries(NUMBERING_SCHEMES)) {
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

async function registerVvMetadataTypesAsync(db) {
  let registered = 0;
  for (const type of VV_METADATA_TYPES) {
    try {
      if (await findMetadataTypeAsync(db, type.code, null)) continue;
    } catch {
      // Not found is expected on first boot; continue registering.
    }
    try {
      await createMetadataTypeAsync(db, { code: type.code, name: type.name, module: SOURCE_MODULE, status: "active" }, null, null, null);
      registered += 1;
    } catch (err) {
      console.warn(`[verification-validation] Metadata type registration skipped: ${err?.message || err}`);
    }
  }
  return { registered };
}

export async function ensureVvFoundationAsync(db) {
  const eventTypes = await ensureVvEventTypesAsync(db);
  const numbering = await ensureNumberingFoundationAsync(db);
  const metadataTypes = await registerVvMetadataTypesAsync(db);
  const methods = await ensureVvMethodsAsync(db);
  registerVvSources();
  const search = await ensureVvSearchAsync(db);
  const configuration = await ensureVvConfigAsync(db);
  const threadProvider = registerVvProvider();

  const jobTypes = await ensureVvJobTypesAsync(db);
  registerVvHandlers();
  registerVvCoverageEventHandler();
  registerVvRequirementEventHandler();
  const eventSubscriptions = await ensureVvEventSubscriptionsAsync(db);
  const requirementSubscriptions = await ensureVvRequirementSubscriptionsAsync(db);

  let tenants = [];
  try {
    tenants = await tenantIdsAsync(db);
  } catch {
    tenants = [];
  }

  return {
    source_module: SOURCE_MODULE,
    event_types: eventTypes,
    numbering,
    metadata_types: metadataTypes,
    methods,
    search,
    tenants: tenants.length,
    configuration,
    thread_provider: threadProvider,
    job_types: jobTypes,
    event_subscriptions: eventSubscriptions,
    requirement_subscriptions: requirementSubscriptions,
  };
}

export function vvHealth(db, tenantId = null) {
  const scoped = (table, column = "tenant_id") =>
    tenantId
      ? Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`, [Number(tenantId)])?.c || 0)
      : Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`)?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    counts: {
      methods: tenantId
        ? Number(queryOne(db, "SELECT COUNT(*) AS c FROM vv_methods WHERE tenant_id IS NULL OR tenant_id = ?", [Number(tenantId)])?.c || 0)
        : Number(queryOne(db, "SELECT COUNT(*) AS c FROM vv_methods")?.c || 0),
      test_cases: scoped("vv_test_cases"),
      procedures: scoped("vv_test_procedures"),
      executions: scoped("vv_executions"),
      results: scoped("vv_results"),
      waivers: scoped("vv_waivers"),
    },
  };
}

export async function vvHealthAsync(db, tenantId = null) {
  const scoped = async (table) =>
    tenantId
      ? Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [Number(tenantId)]))?.c || 0)
      : Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM ${table}`))?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    counts: {
      methods: tenantId
        ? Number((await queryOneAsync(db, "SELECT COUNT(*) AS c FROM vv_methods WHERE tenant_id IS NULL OR tenant_id = ?", [Number(tenantId)]))?.c || 0)
        : Number((await queryOneAsync(db, "SELECT COUNT(*) AS c FROM vv_methods"))?.c || 0),
      test_cases: await scoped("vv_test_cases"),
      procedures: await scoped("vv_test_procedures"),
      executions: await scoped("vv_executions"),
      results: await scoped("vv_results"),
      waivers: await scoped("vv_waivers"),
    },
  };
}

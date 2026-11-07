// Idempotent bootstrap for the Requirement -> Manufacturing traceability layer.
//
// Called on every application boot: registers the manufacturing metadata object
// types (operation, work center), the Object & Relationship edge types of the
// manufacturing thread, the integration event types and the platform
// configuration definitions. It does not create any schema and does not
// duplicate a platform engine: operations/work centers use the Object framework,
// structures use the BOM engine, characteristics use Classification, and the
// graph uses the Digital Thread / Generic Traceability Engine.
import { queryOne, queryAll } from "../../db.js";
import { queryOneAsync, queryAllAsync } from "../../db-async.js";
import { createType as createMetadataType, findType as findMetadataType, createTypeAsync as createMetadataTypeAsync, findTypeAsync as findMetadataTypeAsync } from "../metadata/types.js";
import { createRelationshipType, createRelationshipTypeAsync } from "../objects/relationship-types.js";
import { registerRequirementManufacturingProvider } from "./provider.js";
import { ensureRequirementManufacturingEventTypes, ensureRequirementManufacturingEventTypesAsync } from "./events.js";
import { ensureRequirementManufacturingConfig, ensureRequirementManufacturingConfigAsync } from "./configuration.js";
import { ensureRequirementManufacturingJobTypes, ensureRequirementManufacturingJobTypesAsync, registerRequirementManufacturingHandlers } from "./jobs.js";
import {
  registerRequirementManufacturingNodeEventHandler,
  registerRequirementManufacturingTraceEventHandler,
  ensureRequirementManufacturingNodeSubscriptions,
  ensureRequirementManufacturingNodeSubscriptionsAsync,
  ensureRequirementManufacturingTraceSubscriptions,
  ensureRequirementManufacturingTraceSubscriptionsAsync,
} from "./subscriptions.js";
import {
  SOURCE_MODULE,
  REQUIREMENT_SOURCE_TYPE,
  ALLOCATION_TYPES,
  ALLOCATION_CODES,
  MANUFACTURING_OBJECT_TYPES,
  MANUFACTURING_OBJECT_TYPE_CODES,
  MANUFACTURING_RELATIONSHIP_TYPES,
  MANUFACTURING_RELATIONSHIP_CODES,
  MANUFACTURING_NODE_TYPES,
  TARGET_NODE_TYPES,
  REQUIREMENT_MANUFACTURING_RESOURCES,
  MANUFACTURING_STAGES,
  MANUFACTURING_IMPACT_CATEGORIES,
  MANUFACTURING_IMPACT_PRECEDENCE,
  VALIDATION_STATUSES,
  RULE_CATEGORIES,
  CONFIG_DEFAULTS,
  CONFIG_BOUNDS,
} from "./constants.js";

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function metadataTypeExists(db, code) {
  try {
    return Boolean(findMetadataType(db, code, null));
  } catch {
    return false;
  }
}

async function metadataTypeExistsAsync(db, code) {
  try {
    return Boolean(await findMetadataTypeAsync(db, code, null));
  } catch {
    return false;
  }
}

function relationshipTypeExists(db, code) {
  return Boolean(queryOne(db, "SELECT id FROM relationship_types WHERE code = ? AND tenant_id IS NULL", [code]));
}

async function relationshipTypeExistsAsync(db, code) {
  return Boolean(await queryOneAsync(db, "SELECT id FROM relationship_types WHERE code = ? AND tenant_id IS NULL", [code]));
}

export function registerRequirementManufacturingObjectTypes(db) {
  let created = 0;
  for (const type of MANUFACTURING_OBJECT_TYPES) {
    if (metadataTypeExists(db, type.code)) continue;
    try {
      createMetadataType(db, { code: type.code, name: type.name, description: type.description, module: SOURCE_MODULE, status: "active" }, null, null, null);
      created += 1;
    } catch (error) {
      if (!metadataTypeExists(db, type.code)) throw error;
    }
  }
  return { created };
}

export async function registerRequirementManufacturingObjectTypesAsync(db) {
  let created = 0;
  for (const type of MANUFACTURING_OBJECT_TYPES) {
    if (await metadataTypeExistsAsync(db, type.code)) continue;
    try {
      await createMetadataTypeAsync(db, { code: type.code, name: type.name, description: type.description, module: SOURCE_MODULE, status: "active" }, null, null, null);
      created += 1;
    } catch (error) {
      if (!(await metadataTypeExistsAsync(db, type.code))) throw error;
    }
  }
  return { created };
}

function relationshipTypeBody(entry) {
  const objectTypes = new Set(MANUFACTURING_OBJECT_TYPE_CODES);
  const body = {
    code: entry.code,
    name: entry.name,
    description: entry.description,
    module: SOURCE_MODULE,
    semantic: entry.semantic || "association",
    cardinality: "N:N",
    bidirectional: entry.bidirectional ? 1 : 0,
    status: "active",
  };
  if (entry.source_type && objectTypes.has(entry.source_type)) body.source_type_id = entry.source_type;
  if (entry.target_type && objectTypes.has(entry.target_type)) body.target_type_id = entry.target_type;
  return body;
}

export function registerRequirementManufacturingRelationshipTypes(db) {
  let created = 0;
  for (const entry of MANUFACTURING_RELATIONSHIP_TYPES) {
    if (relationshipTypeExists(db, entry.code)) continue;
    try {
      createRelationshipType(db, relationshipTypeBody(entry), null, null, null);
      created += 1;
    } catch (error) {
      if (!relationshipTypeExists(db, entry.code)) throw error;
    }
  }
  return { created };
}

export async function registerRequirementManufacturingRelationshipTypesAsync(db) {
  let created = 0;
  for (const entry of MANUFACTURING_RELATIONSHIP_TYPES) {
    if (await relationshipTypeExistsAsync(db, entry.code)) continue;
    try {
      await createRelationshipTypeAsync(db, relationshipTypeBody(entry), null, null, null);
      created += 1;
    } catch (error) {
      if (!(await relationshipTypeExistsAsync(db, entry.code))) throw error;
    }
  }
  return { created };
}

export function ensureRequirementManufacturingFoundation(db) {
  const threadProvider = registerRequirementManufacturingProvider();
  const eventTypes = ensureRequirementManufacturingEventTypes(db);
  const objectTypes = registerRequirementManufacturingObjectTypes(db);
  const relationshipTypes = registerRequirementManufacturingRelationshipTypes(db);
  const configuration = ensureRequirementManufacturingConfig(db);
  const jobTypes = ensureRequirementManufacturingJobTypes(db);
  registerRequirementManufacturingHandlers();
  registerRequirementManufacturingNodeEventHandler();
  registerRequirementManufacturingTraceEventHandler();
  const nodeSubscriptions = ensureRequirementManufacturingNodeSubscriptions(db);
  const traceSubscriptions = ensureRequirementManufacturingTraceSubscriptions(db);
  return {
    source_module: SOURCE_MODULE,
    thread_provider: threadProvider,
    event_types: eventTypes,
    object_types: objectTypes,
    relationship_types: relationshipTypes,
    configuration,
    job_types: jobTypes,
    node_subscriptions: nodeSubscriptions,
    trace_subscriptions: traceSubscriptions,
  };
}

export async function ensureRequirementManufacturingFoundationAsync(db) {
  const threadProvider = registerRequirementManufacturingProvider();
  const eventTypes = await ensureRequirementManufacturingEventTypesAsync(db);
  const objectTypes = await registerRequirementManufacturingObjectTypesAsync(db);
  const relationshipTypes = await registerRequirementManufacturingRelationshipTypesAsync(db);
  const configuration = await ensureRequirementManufacturingConfigAsync(db);
  const jobTypes = await ensureRequirementManufacturingJobTypesAsync(db);
  registerRequirementManufacturingHandlers();
  registerRequirementManufacturingNodeEventHandler();
  registerRequirementManufacturingTraceEventHandler();
  const nodeSubscriptions = await ensureRequirementManufacturingNodeSubscriptionsAsync(db);
  const traceSubscriptions = await ensureRequirementManufacturingTraceSubscriptionsAsync(db);
  return {
    source_module: SOURCE_MODULE,
    thread_provider: threadProvider,
    event_types: eventTypes,
    object_types: objectTypes,
    relationship_types: relationshipTypes,
    configuration,
    job_types: jobTypes,
    node_subscriptions: nodeSubscriptions,
    trace_subscriptions: traceSubscriptions,
  };
}

function allocationCounts(db, tenantId) {
  const rows = queryAll(
    db,
    `SELECT relationship_type, COUNT(*) AS c FROM requirement_relationships
      WHERE tenant_id = ? AND source_type = ? AND relationship_type IN (${placeholders(ALLOCATION_CODES)})
      GROUP BY relationship_type`,
    [Number(tenantId), REQUIREMENT_SOURCE_TYPE, ...ALLOCATION_CODES]
  );
  const counts = Object.fromEntries(ALLOCATION_CODES.map((code) => [code, 0]));
  for (const row of rows) counts[row.relationship_type] = Number(row.c || 0);
  return counts;
}

async function allocationCountsAsync(db, tenantId) {
  const rows = await queryAllAsync(
    db,
    `SELECT relationship_type, COUNT(*) AS c FROM requirement_relationships
      WHERE tenant_id = ? AND source_type = ? AND relationship_type IN (${placeholders(ALLOCATION_CODES)})
      GROUP BY relationship_type`,
    [Number(tenantId), REQUIREMENT_SOURCE_TYPE, ...ALLOCATION_CODES]
  );
  const counts = Object.fromEntries(ALLOCATION_CODES.map((code) => [code, 0]));
  for (const row of rows) counts[row.relationship_type] = Number(row.c || 0);
  return counts;
}

export function requirementManufacturingHealth(db, tenantId = null) {
  if (!tenantId) {
    const total = Number(
      queryOne(
        db,
        `SELECT COUNT(*) AS c FROM requirement_relationships WHERE source_type = ? AND relationship_type IN (${placeholders(ALLOCATION_CODES)})`,
        [REQUIREMENT_SOURCE_TYPE, ...ALLOCATION_CODES]
      )?.c || 0
    );
    return { source_module: SOURCE_MODULE, counts: { allocations: total }, by_relationship: null };
  }
  const byRelationship = allocationCounts(db, tenantId);
  const total = Object.values(byRelationship).reduce((sum, value) => sum + value, 0);
  return { source_module: SOURCE_MODULE, counts: { allocations: total }, by_relationship: byRelationship };
}

export async function requirementManufacturingHealthAsync(db, tenantId = null) {
  if (!tenantId) {
    const row = await queryOneAsync(
      db,
      `SELECT COUNT(*) AS c FROM requirement_relationships WHERE source_type = ? AND relationship_type IN (${placeholders(ALLOCATION_CODES)})`,
      [REQUIREMENT_SOURCE_TYPE, ...ALLOCATION_CODES]
    );
    return { source_module: SOURCE_MODULE, counts: { allocations: Number(row?.c || 0) }, by_relationship: null };
  }
  const byRelationship = await allocationCountsAsync(db, tenantId);
  const total = Object.values(byRelationship).reduce((sum, value) => sum + value, 0);
  return { source_module: SOURCE_MODULE, counts: { allocations: total }, by_relationship: byRelationship };
}

export function requirementManufacturingMeta() {
  return {
    source_module: SOURCE_MODULE,
    requirement_source_type: REQUIREMENT_SOURCE_TYPE,
    object_types: MANUFACTURING_OBJECT_TYPES.map((entry) => ({ code: entry.code, name: entry.name })),
    allocation_types: ALLOCATION_TYPES.map((entry) => ({
      code: entry.code,
      name: entry.name,
      description: entry.description,
      target_types: entry.target_types,
      direction: entry.direction,
    })),
    node_types: { ...MANUFACTURING_NODE_TYPES },
    target_types: TARGET_NODE_TYPES.map((code) => ({ code, node_type: code })),
    relationship_types: MANUFACTURING_RELATIONSHIP_TYPES.map((entry) => ({
      code: entry.code,
      name: entry.name,
      description: entry.description,
      source_type: entry.source_type,
      target_type: entry.target_type,
    })),
    relationship_codes: [...MANUFACTURING_RELATIONSHIP_CODES],
    stages: [...MANUFACTURING_STAGES],
    impact_categories: [...MANUFACTURING_IMPACT_CATEGORIES],
    impact_precedence: [...MANUFACTURING_IMPACT_PRECEDENCE],
    validation_statuses: [...VALIDATION_STATUSES],
    rule_categories: [...RULE_CATEGORIES],
    resources: { ...REQUIREMENT_MANUFACTURING_RESOURCES },
    config_defaults: { ...CONFIG_DEFAULTS },
    config_bounds: { ...CONFIG_BOUNDS },
    thread_provider: "requirement-manufacturing",
  };
}

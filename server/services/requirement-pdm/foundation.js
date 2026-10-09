// Idempotent bootstrap for the Requirement -> PDM integration.
//
// Called on every application boot: registers integration event types and
// ensures the configuration definitions exist. It does not create any schema or
// duplicate a platform engine; allocations live in the Requirements Manager and
// the PDM/BOM artifacts keep their own foundations (mirrors
// requirements/foundation.js).
import { queryOne, queryAll } from "../../db.js";
import { queryOneAsync, queryAllAsync } from "../../db-async.js";
import { ensureRequirementPdmEventTypes, ensureRequirementPdmEventTypesAsync } from "./events.js";
import { ensureRequirementPdmConfig, ensureRequirementPdmConfigAsync } from "./configuration.js";
import { registerRequirementPdmProvider } from "./provider.js";
import { ensureRequirementPdmJobTypes, ensureRequirementPdmJobTypesAsync, registerRequirementPdmHandlers } from "./jobs.js";
import { registerRequirementPdmIntegrationHandlers } from "./integration.js";
import { registerRequirementPdmEventHandler, ensureRequirementPdmSubscriptions, ensureRequirementPdmSubscriptionsAsync, registerRequirementPdmChangeEventHandler, ensureRequirementPdmChangeSubscriptions, ensureRequirementPdmChangeSubscriptionsAsync } from "./subscriptions.js";
import { registerRequirementPdmPlmSyncHandler, ensureRequirementPdmPlmSubscriptions, ensureRequirementPdmPlmSubscriptionsAsync } from "./subscriptions.js";
import { ensurePlmNotificationRules, ensurePlmNotificationRulesAsync } from "./plm-notifications.js";
import {
  SOURCE_MODULE,
  ALLOCATION_TYPES,
  ALLOCATION_CODES,
  PDM_NODE_TYPES,
  TARGET_NODE_TYPES,
  REQUIREMENT_PDM_RESOURCES,
  CONFIG_DEFAULTS,
  CONFIG_BOUNDS,
  COVERAGE_STATUSES,
  COMPATIBILITY_STATUSES,
  REQUIREMENT_SOURCE_TYPE,
  PLM_NODE_TYPES,
  CHANGE_NODE_TYPES,
  CHANGE_NODE_CODES,
  CHANGE_TARGET_SOURCES,
  PLM_LINK_TYPES,
  PLM_LINK_CODES,
  IMPACT_CATEGORIES,
  CHANGE_INITIATION_STATUSES,
  CHANGE_SEVERITIES,
  CHANGE_INITIATION_RULES,
  PLM_SYNC_DIRECTIONS,
  PLM_DOCUMENT_CATEGORIES,
  INTEGRATION_STATUSES,
  PLM_NOTIFICATION_RULES,
} from "./constants.js";

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function allocationCounts(db, tenantId) {
  const params = [Number(tenantId), REQUIREMENT_SOURCE_TYPE, ...ALLOCATION_CODES];
  const rows = queryAll(
    db,
    `SELECT relationship_type, COUNT(*) AS c FROM requirement_relationships
      WHERE tenant_id = ? AND source_type = ? AND relationship_type IN (${placeholders(ALLOCATION_CODES)})
      GROUP BY relationship_type`,
    params
  );
  const counts = Object.fromEntries(ALLOCATION_CODES.map((code) => [code, 0]));
  for (const row of rows) counts[row.relationship_type] = Number(row.c || 0);
  return counts;
}

async function allocationCountsAsync(db, tenantId) {
  const params = [Number(tenantId), REQUIREMENT_SOURCE_TYPE, ...ALLOCATION_CODES];
  const rows = await queryAllAsync(
    db,
    `SELECT relationship_type, COUNT(*) AS c FROM requirement_relationships
      WHERE tenant_id = ? AND source_type = ? AND relationship_type IN (${placeholders(ALLOCATION_CODES)})
      GROUP BY relationship_type`,
    params
  );
  const counts = Object.fromEntries(ALLOCATION_CODES.map((code) => [code, 0]));
  for (const row of rows) counts[row.relationship_type] = Number(row.c || 0);
  return counts;
}

export function ensureRequirementPdmFoundation(db) {
  const eventTypes = ensureRequirementPdmEventTypes(db);
  const configuration = ensureRequirementPdmConfig(db);
  const jobTypes = ensureRequirementPdmJobTypes(db);
  registerRequirementPdmHandlers();
  registerRequirementPdmIntegrationHandlers();
  registerRequirementPdmEventHandler();
  registerRequirementPdmChangeEventHandler();
  registerRequirementPdmPlmSyncHandler();
  const subscriptions = ensureRequirementPdmSubscriptions(db);
  const changeSubscriptions = ensureRequirementPdmChangeSubscriptions(db);
  const plmSubscriptions = ensureRequirementPdmPlmSubscriptions(db);
  const notificationRules = ensurePlmNotificationRules(db);
  const threadProvider = registerRequirementPdmProvider();
  return { source_module: SOURCE_MODULE, event_types: eventTypes, configuration, job_types: jobTypes, subscriptions, change_subscriptions: changeSubscriptions, plm_subscriptions: plmSubscriptions, notification_rules: notificationRules, thread_provider: threadProvider };
}

export async function ensureRequirementPdmFoundationAsync(db) {
  const eventTypes = await ensureRequirementPdmEventTypesAsync(db);
  const configuration = await ensureRequirementPdmConfigAsync(db);
  const jobTypes = await ensureRequirementPdmJobTypesAsync(db);
  registerRequirementPdmHandlers();
  registerRequirementPdmIntegrationHandlers();
  registerRequirementPdmEventHandler();
  registerRequirementPdmChangeEventHandler();
  registerRequirementPdmPlmSyncHandler();
  const subscriptions = await ensureRequirementPdmSubscriptionsAsync(db);
  const changeSubscriptions = await ensureRequirementPdmChangeSubscriptionsAsync(db);
  const plmSubscriptions = await ensureRequirementPdmPlmSubscriptionsAsync(db);
  const notificationRules = await ensurePlmNotificationRulesAsync(db);
  const threadProvider = registerRequirementPdmProvider();
  return { source_module: SOURCE_MODULE, event_types: eventTypes, configuration, job_types: jobTypes, subscriptions, change_subscriptions: changeSubscriptions, plm_subscriptions: plmSubscriptions, notification_rules: notificationRules, thread_provider: threadProvider };
}

export function requirementPdmHealth(db, tenantId = null) {
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

export async function requirementPdmHealthAsync(db, tenantId = null) {
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

export function requirementPdmMeta() {
  return {
    source_module: SOURCE_MODULE,
    requirement_source_type: REQUIREMENT_SOURCE_TYPE,
    allocation_types: ALLOCATION_TYPES.map((entry) => ({
      code: entry.code,
      name: entry.name,
      description: entry.description,
      target_types: entry.target_types,
      direction: entry.direction,
    })),
    target_types: TARGET_NODE_TYPES.map((code) => ({ code, node_type: code })),
    node_types: { ...PDM_NODE_TYPES },
    resources: { ...REQUIREMENT_PDM_RESOURCES },
    coverage_statuses: [...COVERAGE_STATUSES],
    compatibility_statuses: [...COMPATIBILITY_STATUSES],
    config_defaults: { ...CONFIG_DEFAULTS },
    config_bounds: { ...CONFIG_BOUNDS },
    thread_provider: "requirement-pdm",
    plm: {
      node_types: { ...PLM_NODE_TYPES },
      change_node_types: { ...CHANGE_NODE_TYPES },
      change_node_codes: [...CHANGE_NODE_CODES],
      change_sources: Object.fromEntries(
        Object.entries(CHANGE_TARGET_SOURCES).map(([code, source]) => [
          code,
          { table: source.table, label: source.label, status_column: source.status_column, parent_column: source.parent_column },
        ])
      ),
      link_types: PLM_LINK_TYPES.map((entry) => ({
        code: entry.code,
        name: entry.name,
        description: entry.description,
        target_types: entry.target_types,
        direction: entry.direction,
      })),
      link_codes: [...PLM_LINK_CODES],
      impact_categories: [...IMPACT_CATEGORIES],
      change_initiation_statuses: [...CHANGE_INITIATION_STATUSES],
      change_severities: [...CHANGE_SEVERITIES],
      change_initiation_rules: [...CHANGE_INITIATION_RULES],
      sync_directions: Object.values(PLM_SYNC_DIRECTIONS),
      document_categories: [...PLM_DOCUMENT_CATEGORIES],
      integration_statuses: [...INTEGRATION_STATUSES],
      notification_rules: PLM_NOTIFICATION_RULES.map((rule) => ({ code: rule.code, event_type: rule.event_type, name: rule.name })),
    },
  };
}

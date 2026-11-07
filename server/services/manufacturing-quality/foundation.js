// Idempotent bootstrap for the Manufacturing & Quality Intelligence layer.
//
// Called on every application boot: registers the module's domain event types
// and its tenant configuration definitions. Nothing here duplicates a platform
// engine: product structures stay in the BOM engine, operations/work centres in
// the Object framework, the graph in the Digital Thread and verification in the
// V&V engine (mirrors verification-validation/foundation.js).
import { queryOne } from "../../db.js";
import { queryOneAsync } from "../../db-async.js";
import { ensureManufacturingQualityEventTypes, ensureManufacturingQualityEventTypesAsync } from "./events.js";
import { ensureManufacturingQualityConfig, ensureManufacturingQualityConfigAsync } from "./configuration.js";
import { SOURCE_MODULE } from "./constants.js";

export function ensureManufacturingQualityFoundation(db) {
  const eventTypes = ensureManufacturingQualityEventTypes(db);
  const configuration = ensureManufacturingQualityConfig(db);
  return {
    source_module: SOURCE_MODULE,
    event_types: eventTypes,
    configuration,
  };
}

export async function ensureManufacturingQualityFoundationAsync(db) {
  const eventTypes = await ensureManufacturingQualityEventTypesAsync(db);
  const configuration = await ensureManufacturingQualityConfigAsync(db);
  return {
    source_module: SOURCE_MODULE,
    event_types: eventTypes,
    configuration,
  };
}

const HEALTH_TABLES = Object.freeze({
  issues: "quality_issues",
  inspections: "quality_inspections",
  corrective_actions: "quality_corrective_actions",
  readiness_evaluations: "quality_readiness_evaluations",
});

export function manufacturingQualityHealth(db, tenantId = null) {
  const counts = {};
  for (const [key, table] of Object.entries(HEALTH_TABLES)) {
    counts[key] = tenantId
      ? Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [Number(tenantId)])?.c || 0)
      : Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`)?.c || 0);
  }
  return { source_module: SOURCE_MODULE, counts };
}

export async function manufacturingQualityHealthAsync(db, tenantId = null) {
  const counts = {};
  for (const [key, table] of Object.entries(HEALTH_TABLES)) {
    counts[key] = tenantId
      ? Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [Number(tenantId)]))?.c || 0)
      : Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM ${table}`))?.c || 0);
  }
  return { source_module: SOURCE_MODULE, counts };
}

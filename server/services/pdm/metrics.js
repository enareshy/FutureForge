// PDM operational metrics and health.
//
// Aggregates live tables so operators can see adoption (items, revisions,
// datasets, CAD coverage), data quality (items without revisions, orphan
// datasets, malformed CAD) and cache behaviour at a glance.
import { queryAll, queryOne } from "../../db.js";
import { SOURCE_MODULE } from "./constants.js";
import { cacheStats } from "./cache.js";

function count(db, sql, params = []) {
  return Number(queryOne(db, sql, params)?.c || 0);
}

export function metricsSnapshot(db, { tenantId } = {}) {
  const tenant = Number(tenantId);
  const itemStatuses = queryAll(db, "SELECT status, COUNT(*) AS c FROM pdm_items WHERE tenant_id = ? GROUP BY status", [tenant]);
  const itemTypes = queryAll(db, "SELECT item_type, COUNT(*) AS c FROM pdm_items WHERE tenant_id = ? GROUP BY item_type", [tenant]);
  const revisionStatuses = queryAll(db, "SELECT status, COUNT(*) AS c FROM pdm_item_revisions WHERE tenant_id = ? GROUP BY status", [tenant]);
  const datasetTypes = queryAll(db, "SELECT dataset_type, COUNT(*) AS c FROM pdm_datasets WHERE tenant_id = ? GROUP BY dataset_type", [tenant]);

  const totals = {
    items: count(db, "SELECT COUNT(*) AS c FROM pdm_items WHERE tenant_id = ?", [tenant]),
    parts: count(db, "SELECT COUNT(*) AS c FROM pdm_items WHERE tenant_id = ? AND item_type = 'PART'", [tenant]),
    products: count(db, "SELECT COUNT(*) AS c FROM pdm_items WHERE tenant_id = ? AND item_type = 'PRODUCT'", [tenant]),
    revisions: count(db, "SELECT COUNT(*) AS c FROM pdm_item_revisions WHERE tenant_id = ?", [tenant]),
    released_revisions: count(db, "SELECT COUNT(*) AS c FROM pdm_item_revisions WHERE tenant_id = ? AND status = 'RELEASED'", [tenant]),
    datasets: count(db, "SELECT COUNT(*) AS c FROM pdm_datasets WHERE tenant_id = ?", [tenant]),
    representations: count(db, "SELECT COUNT(*) AS c FROM pdm_representations WHERE tenant_id = ?", [tenant]),
    design_data: count(db, "SELECT COUNT(*) AS c FROM pdm_design_data WHERE tenant_id = ?", [tenant]),
    cad_associations: count(db, "SELECT COUNT(*) AS c FROM pdm_cad_associations WHERE tenant_id = ?", [tenant]),
    revision_rules: count(db, "SELECT COUNT(*) AS c FROM pdm_revision_rules WHERE tenant_id = ?", [tenant]),
    configuration_rules: count(db, "SELECT COUNT(*) AS c FROM pdm_configuration_rules WHERE tenant_id = ?", [tenant]),
    baselines: count(db, "SELECT COUNT(*) AS c FROM pdm_baselines WHERE tenant_id = ?", [tenant]),
    relationships: count(db, "SELECT COUNT(*) AS c FROM pdm_relationships WHERE tenant_id = ?", [tenant]),
    references: count(db, "SELECT COUNT(*) AS c FROM pdm_references WHERE tenant_id = ?", [tenant]),
    validation_rules: count(db, "SELECT COUNT(*) AS c FROM pdm_validation_rules WHERE tenant_id = ?", [tenant]),
    validation_results: count(db, "SELECT COUNT(*) AS c FROM pdm_validation_results WHERE tenant_id = ?", [tenant]),
    change_history: count(db, "SELECT COUNT(*) AS c FROM pdm_change_history WHERE tenant_id = ?", [tenant]),
  };

  const quality = {
    items_without_revisions: count(
      db,
      "SELECT COUNT(*) AS c FROM pdm_items i WHERE i.tenant_id = ? AND NOT EXISTS (SELECT 1 FROM pdm_item_revisions r WHERE r.item_id = i.id)",
      [tenant]
    ),
    items_without_owner: count(db, "SELECT COUNT(*) AS c FROM pdm_items WHERE tenant_id = ? AND owner_user_id IS NULL AND owner_object_id IS NULL", [tenant]),
    orphan_datasets: count(db, "SELECT COUNT(*) AS c FROM pdm_datasets WHERE tenant_id = ? AND revision_id IS NULL AND item_id IS NULL AND object_id IS NULL", [tenant]),
    revisions_without_datasets: count(
      db,
      "SELECT COUNT(*) AS c FROM pdm_item_revisions r WHERE r.tenant_id = ? AND NOT EXISTS (SELECT 1 FROM pdm_datasets d WHERE d.revision_id = r.id)",
      [tenant]
    ),
    cad_missing_dataset: count(db, "SELECT COUNT(*) AS c FROM pdm_cad_associations WHERE tenant_id = ? AND dataset_id IS NULL", [tenant]),
    open_validation_errors: count(db, "SELECT COUNT(*) AS c FROM pdm_validation_results WHERE tenant_id = ? AND status = 'ERROR'", [tenant]),
  };

  const payload = {
    source_module: SOURCE_MODULE,
    generated_at: new Date().toISOString(),
    totals,
    quality,
    cache: cacheStats(),
    items_by_status: Object.fromEntries(itemStatuses.map((row) => [row.status, Number(row.c)])),
    items_by_type: Object.fromEntries(itemTypes.map((row) => [row.item_type, Number(row.c)])),
    revisions_by_status: Object.fromEntries(revisionStatuses.map((row) => [row.status, Number(row.c)])),
    datasets_by_type: Object.fromEntries(datasetTypes.map((row) => [row.dataset_type, Number(row.c)])),
  };

  payload.coverage = {
    revision_rate: totals.items ? round(totals.revisions / totals.items) : 0,
    release_rate: totals.revisions ? round(totals.released_revisions / totals.revisions) : 0,
    dataset_rate: totals.revisions ? round(totals.datasets / totals.revisions) : 0,
    cad_rate: totals.revisions ? round(totals.cad_associations / totals.revisions) : 0,
  };
  return payload;
}

export function healthCheck(db, { tenantId } = {}) {
  const tenant = Number(tenantId);
  const tables = [
    "pdm_items",
    "pdm_item_revisions",
    "pdm_datasets",
    "pdm_representations",
    "pdm_design_data",
    "pdm_cad_associations",
    "pdm_revision_rules",
    "pdm_revision_rule_versions",
    "pdm_configuration_rules",
    "pdm_configuration_rule_versions",
    "pdm_baselines",
    "pdm_baseline_members",
    "pdm_relationships",
    "pdm_references",
    "pdm_validation_rules",
    "pdm_validation_results",
    "pdm_validation_issues",
    "pdm_change_history",
    "pdm_configuration",
  ];
  const checks = tables.map((table) => {
    try {
      count(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [tenant]);
      return { name: table, status: "ok" };
    } catch (error) {
      return { name: table, status: "error", message: error.message };
    }
  });
  const healthy = checks.every((check) => check.status === "ok");
  return { status: healthy ? "healthy" : "degraded", source_module: SOURCE_MODULE, checks };
}

export function ruleUsageStats(db, { tenantId } = {}) {
  const tenant = Number(tenantId);
  const revisionRules = queryAll(db, "SELECT rule_type, COUNT(*) AS c FROM pdm_revision_rules WHERE tenant_id = ? GROUP BY rule_type", [tenant]);
  const configurationRules = queryAll(db, "SELECT rule_type, COUNT(*) AS c FROM pdm_configuration_rules WHERE tenant_id = ? GROUP BY rule_type", [tenant]);
  return {
    source_module: SOURCE_MODULE,
    revision_rules_by_type: Object.fromEntries(revisionRules.map((row) => [row.rule_type, Number(row.c)])),
    configuration_rules_by_type: Object.fromEntries(configurationRules.map((row) => [row.rule_type, Number(row.c)])),
  };
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

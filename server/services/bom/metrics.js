// BOM operational metrics and health.
//
// Aggregates live tables so operators can see adoption (BOM/revision coverage),
// data quality (missing UOM, duplicate find numbers, empty revisions) and cache
// behaviour at a glance.
import { queryAll, queryOne } from "../../db.js";
import { SOURCE_MODULE } from "./constants.js";
import { cacheStats } from "./cache.js";

function count(db, sql, params = []) {
  return Number(queryOne(db, sql, params)?.c || 0);
}

export function metricsSnapshot(db, { tenantId, bomType = null } = {}) {
  const tenant = Number(tenantId);
  const bomStatuses = queryAll(db, "SELECT status, COUNT(*) AS c FROM bom_headers WHERE tenant_id = ? GROUP BY status", [tenant]);
  const bomTypes = queryAll(db, "SELECT bom_type, COUNT(*) AS c FROM bom_headers WHERE tenant_id = ? GROUP BY bom_type", [tenant]);
  const revisionStatuses = queryAll(db, "SELECT status, COUNT(*) AS c FROM bom_revisions WHERE tenant_id = ? GROUP BY status", [tenant]);
  const lineUsages = queryAll(db, "SELECT usage, COUNT(*) AS c FROM bom_lines WHERE tenant_id = ? GROUP BY usage ORDER BY c DESC LIMIT 25", [tenant]);

  const totals = {
    boms: count(db, "SELECT COUNT(*) AS c FROM bom_headers WHERE tenant_id = ?", [tenant]),
    revisions: count(db, "SELECT COUNT(*) AS c FROM bom_revisions WHERE tenant_id = ?", [tenant]),
    lines: count(db, "SELECT COUNT(*) AS c FROM bom_lines WHERE tenant_id = ?", [tenant]),
    active_lines: count(db, "SELECT COUNT(*) AS c FROM bom_lines WHERE tenant_id = ? AND line_status = 'ACTIVE'", [tenant]),
    optional_lines: count(db, "SELECT COUNT(*) AS c FROM bom_lines WHERE tenant_id = ? AND optional = 1", [tenant]),
    substitutes: count(db, "SELECT COUNT(*) AS c FROM bom_substitutes WHERE tenant_id = ?", [tenant]),
    baselines: count(db, "SELECT COUNT(*) AS c FROM bom_baselines WHERE tenant_id = ?", [tenant]),
    transformation_definitions: count(db, "SELECT COUNT(*) AS c FROM bom_transformation_definitions WHERE tenant_id = ?", [tenant]),
    transformation_runs: count(db, "SELECT COUNT(*) AS c FROM bom_transformation_runs WHERE tenant_id = ?", [tenant]),
    validation_rules: count(db, "SELECT COUNT(*) AS c FROM bom_validation_rules WHERE tenant_id = ?", [tenant]),
    validation_results: count(db, "SELECT COUNT(*) AS c FROM bom_validation_results WHERE tenant_id = ?", [tenant]),
    comparisons: count(db, "SELECT COUNT(*) AS c FROM bom_comparisons WHERE tenant_id = ?", [tenant]),
    change_history: count(db, "SELECT COUNT(*) AS c FROM bom_change_history WHERE tenant_id = ?", [tenant]),
  };

  const quality = {
    lines_missing_uom: count(db, "SELECT COUNT(*) AS c FROM bom_lines WHERE tenant_id = ? AND (uom IS NULL OR uom = '')", [tenant]),
    lines_missing_child: count(db, "SELECT COUNT(*) AS c FROM bom_lines WHERE tenant_id = ? AND (child_object_id IS NULL OR child_object_id = '')", [tenant]),
    revisions_without_lines: count(
      db,
      "SELECT COUNT(*) AS c FROM bom_revisions r WHERE r.tenant_id = ? AND NOT EXISTS (SELECT 1 FROM bom_lines l WHERE l.bom_revision_id = r.id)",
      [tenant]
    ),
    duplicate_find_numbers: count(
      db,
      `SELECT COUNT(*) AS c FROM (
         SELECT bom_revision_id, parent_object_id, find_number FROM bom_lines
          WHERE tenant_id = ? AND find_number <> ''
          GROUP BY bom_revision_id, parent_object_id, find_number HAVING COUNT(*) > 1)`,
      [tenant]
    ),
    obsolete_revisions_with_active_lines: count(
      db,
      `SELECT COUNT(*) AS c FROM bom_lines l JOIN bom_revisions r ON r.id = l.bom_revision_id
        WHERE l.tenant_id = ? AND r.status IN ('SUPERSEDED','OBSOLETE') AND l.line_status = 'ACTIVE'`,
      [tenant]
    ),
  };

  return {
    source_module: SOURCE_MODULE,
    generated_at: new Date().toISOString(),
    bom_type: bomType || null,
    totals,
    quality,
    cache: cacheStats(),
    boms_by_status: Object.fromEntries(bomStatuses.map((row) => [row.status, Number(row.c)])),
    boms_by_type: Object.fromEntries(bomTypes.map((row) => [row.bom_type, Number(row.c)])),
    revisions_by_status: Object.fromEntries(revisionStatuses.map((row) => [row.status, Number(row.c)])),
    lines_by_usage: Object.fromEntries(lineUsages.map((row) => [row.usage, Number(row.c)])),
  };
}

export function healthCheck(db, { tenantId } = {}) {
  const tenant = Number(tenantId);
  const tables = [
    "bom_headers",
    "bom_revisions",
    "bom_lines",
    "bom_line_attributes",
    "bom_substitutes",
    "bom_baselines",
    "bom_baseline_lines",
    "bom_transformation_definitions",
    "bom_validation_rules",
    "bom_validation_results",
    "bom_comparisons",
    "bom_change_history",
    "bom_configuration",
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

export function compareSummary(db, { tenantId } = {}) {
  const tenant = Number(tenantId);
  const rows = queryAll(
    db,
    "SELECT change_type, COUNT(*) AS c FROM bom_comparison_results WHERE tenant_id = ? GROUP BY change_type",
    [tenant]
  );
  return {
    source_module: SOURCE_MODULE,
    total_comparisons: count(db, "SELECT COUNT(*) AS c FROM bom_comparisons WHERE tenant_id = ?", [tenant]),
    by_change_type: Object.fromEntries(rows.map((row) => [row.change_type, Number(row.c)])),
  };
}

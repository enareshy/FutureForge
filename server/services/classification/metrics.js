// Classification operational metrics and health.
//
// Aggregates live tables so operators can see adoption (classification coverage),
// data-quality (invalid assignments, duplicates) and governance at a glance.
import { queryAll, queryOne } from "../../db.js";
import { SOURCE_MODULE } from "./constants.js";

function count(db, sql, params = []) {
  return Number(queryOne(db, sql, params)?.c || 0);
}

export function metricsSnapshot(db, { tenantId, objectType = null } = {}) {
  const tenant = Number(tenantId);
  const classStatuses = queryAll(db, "SELECT status, COUNT(*) AS c FROM cla_classifications WHERE tenant_id = ? GROUP BY status", [tenant]);
  const assignmentStatuses = queryAll(db, "SELECT status, COUNT(*) AS c FROM cla_assignments WHERE tenant_id = ? GROUP BY status", [tenant]);
  const byObjectType = queryAll(db, "SELECT object_type, COUNT(*) AS c FROM cla_assignments WHERE tenant_id = ? AND status = 'ACTIVE' GROUP BY object_type ORDER BY c DESC LIMIT 25", [tenant]);

  const totals = {
    classifications: count(db, "SELECT COUNT(*) AS c FROM cla_classifications WHERE tenant_id = ?", [tenant]),
    classes: count(db, "SELECT COUNT(*) AS c FROM cla_classes WHERE tenant_id = ?", [tenant]),
    characteristics: count(db, "SELECT COUNT(*) AS c FROM cla_characteristics WHERE tenant_id = ?", [tenant]),
    characteristic_groups: count(db, "SELECT COUNT(*) AS c FROM cla_characteristic_groups WHERE tenant_id = ?", [tenant]),
    allowed_values: count(db, "SELECT COUNT(*) AS c FROM cla_allowed_values WHERE tenant_id = ?", [tenant]),
    class_characteristics: count(db, "SELECT COUNT(*) AS c FROM cla_class_characteristics WHERE tenant_id = ?", [tenant]),
    assignments: count(db, "SELECT COUNT(*) AS c FROM cla_assignments WHERE tenant_id = ?", [tenant]),
    active_assignments: count(db, "SELECT COUNT(*) AS c FROM cla_assignments WHERE tenant_id = ? AND status = 'ACTIVE'", [tenant]),
    assignment_values: count(db, "SELECT COUNT(*) AS c FROM cla_assignment_values WHERE tenant_id = ? AND status = 'ACTIVE'", [tenant]),
    rules: count(db, "SELECT COUNT(*) AS c FROM cla_rules WHERE tenant_id = ?", [tenant]),
    change_history: count(db, "SELECT COUNT(*) AS c FROM cla_change_history WHERE tenant_id = ?", [tenant]),
  };

  return {
    source_module: SOURCE_MODULE,
    generated_at: new Date().toISOString(),
    object_type: objectType || null,
    totals,
    classifications_by_status: Object.fromEntries(classStatuses.map((row) => [row.status, Number(row.c)])),
    assignments_by_status: Object.fromEntries(assignmentStatuses.map((row) => [row.status, Number(row.c)])),
    assignments_by_object_type: Object.fromEntries(byObjectType.map((row) => [row.object_type, Number(row.c)])),
    classified_objects: count(db, "SELECT COUNT(DISTINCT object_type || ':' || object_id) AS c FROM cla_assignments WHERE tenant_id = ? AND status = 'ACTIVE'", [tenant]),
    classes_without_characteristics: count(
      db,
      `SELECT COUNT(*) AS c FROM cla_classes c
        WHERE c.tenant_id = ? AND c.status = 'ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM cla_class_characteristics cc WHERE cc.class_id = c.id)`,
      [tenant]
    ),
    assignments_missing_required: count(
      db,
      `SELECT COUNT(*) AS c FROM cla_assignments a
        WHERE a.tenant_id = ? AND a.status = 'ACTIVE'
          AND EXISTS (
            SELECT 1 FROM cla_class_characteristics cc
             JOIN cla_characteristics ch ON ch.id = cc.characteristic_id
            WHERE cc.class_id = a.class_id AND cc.required = 1
              AND NOT EXISTS (SELECT 1 FROM cla_assignment_values v WHERE v.assignment_id = a.id AND v.characteristic_id = cc.characteristic_id AND v.status = 'ACTIVE')
          )`,
      [tenant]
    ),
  };
}

export function healthCheck(db, { tenantId } = {}) {
  const tenant = Number(tenantId);
  const tables = [
    "cla_classifications",
    "cla_classes",
    "cla_characteristics",
    "cla_allowed_values",
    "cla_assignments",
    "cla_assignment_values",
    "cla_rules",
    "cla_change_history",
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

export function coverageReport(db, { tenantId, objectType, totalObjects = null } = {}) {
  const tenant = Number(tenantId);
  const classified = count(
    db,
    "SELECT COUNT(DISTINCT object_id) AS c FROM cla_assignments WHERE tenant_id = ? AND object_type = ? AND status = 'ACTIVE'",
    [tenant, String(objectType)]
  );
  const total = totalObjects != null ? Number(totalObjects) : null;
  return {
    source_module: SOURCE_MODULE,
    object_type: objectType,
    classified_objects: classified,
    total_objects: total,
    coverage: total && total > 0 ? Math.round((classified / total) * 10000) / 100 : null,
  };
}

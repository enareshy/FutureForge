// Threshold definitions and evaluation.
//
// A threshold is the declarative rule that turns a raw measurement into a
// signal band (OK / WARNING / CRITICAL). Thresholds are separate from alert
// rules so a single metric can be watched by several rules over different
// scopes without duplicating the numeric configuration.
import { queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { THRESHOLD_OPERATORS, THRESHOLD_DIRECTIONS } from "./constants.js";
import { thresholdRef } from "./identifiers.js";
import { parseJson, stringifyJson, paged, toNumber } from "./repository.js";
import { thresholdNotFound, thresholdConflict, invalidThreshold } from "./errors.js";
import { recordHistory } from "./history.js";

export const THRESHOLD_BANDS = Object.freeze(["OK", "WARNING", "CRITICAL", "UNKNOWN"]);

export function publicThreshold(row) {
  if (!row) return null;
  return {
    id: row.id,
    threshold_ref: row.threshold_ref,
    tenant_id: row.tenant_id,
    metric_code: row.metric_code,
    scope: parseJson(row.scope_json, {}),
    operator: row.operator,
    warning_value: row.warning_value,
    critical_value: row.critical_value,
    direction: row.direction,
    version: row.version,
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getThresholdRow(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) return queryOne(db, "SELECT * FROM observability_thresholds WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  return queryOne(db, "SELECT * FROM observability_thresholds WHERE tenant_id = ? AND threshold_ref = ?", [Number(tenantId), raw]);
}

export function getThreshold(db, tenantId, ref) {
  const row = getThresholdRow(db, tenantId, ref);
  if (!row) throw thresholdNotFound(ref);
  return publicThreshold(row);
}

function compare(value, operator, threshold) {
  switch (operator) {
    case "GT":
      return value > threshold;
    case "GTE":
      return value >= threshold;
    case "LT":
      return value < threshold;
    case "LTE":
      return value <= threshold;
    case "EQ":
      return value === threshold;
    case "NEQ":
      return value !== threshold;
    default:
      return false;
  }
}

export function createThreshold(db, tenantId, input = {}, actor = null) {
  if (!input.metric_code) throw invalidThreshold("metric_code is required");
  const operator = String(input.operator || "GT").toUpperCase();
  if (!THRESHOLD_OPERATORS.includes(operator)) throw invalidThreshold(`Unsupported operator: ${input.operator}`);
  const direction = String(input.direction || "INCREASING").toUpperCase();
  if (!THRESHOLD_DIRECTIONS.includes(direction)) throw invalidThreshold(`Unsupported direction: ${input.direction}`);
  const code = `${String(input.metric_code).toUpperCase()}-${operator}`;
  if (queryOne(db, "SELECT id FROM observability_thresholds WHERE tenant_id = ? AND metric_code = ? AND operator = ?", [Number(tenantId), String(input.metric_code).toUpperCase(), operator])) {
    throw thresholdConflict(code);
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO observability_thresholds (threshold_ref, tenant_id, metric_code, scope_json, operator, warning_value, critical_value, direction, version, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      input.threshold_ref || thresholdRef(code),
      Number(tenantId),
      String(input.metric_code).toUpperCase(),
      stringifyJson(input.scope || {}),
      operator,
      toNumber(input.warning_value),
      toNumber(input.critical_value),
      direction,
      String(input.status || "ACTIVE").toUpperCase(),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM observability_thresholds WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordHistory(db, { tenantId, action: "THRESHOLD_CREATED", entityType: "threshold", entityId: row.id, entityRef: row.threshold_ref, actor, summary: `Threshold ${code} created` });
  writeAudit(db, { actor_id: actor?.id ?? null, actor_username: actor?.username ?? null, action: "observability.threshold.create", resource_type: "observability_threshold", resource_id: row.threshold_ref, details: { metric_code: row.metric_code } });
  return publicThreshold(row);
}

export function updateThreshold(db, tenantId, ref, input = {}, actor = null) {
  const row = getThresholdRow(db, tenantId, ref);
  if (!row) throw thresholdNotFound(ref);
  const operator = input.operator ? String(input.operator).toUpperCase() : row.operator;
  if (!THRESHOLD_OPERATORS.includes(operator)) throw invalidThreshold(`Unsupported operator: ${input.operator}`);
  run(
    db,
    `UPDATE observability_thresholds SET scope_json = ?, operator = ?, warning_value = ?, critical_value = ?, direction = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    [
      input.scope !== undefined ? stringifyJson(input.scope) : row.scope_json,
      operator,
      input.warning_value !== undefined ? toNumber(input.warning_value) : row.warning_value,
      input.critical_value !== undefined ? toNumber(input.critical_value) : row.critical_value,
      input.direction ? String(input.direction).toUpperCase() : row.direction,
      input.status ? String(input.status).toUpperCase() : row.status,
      nowIso(),
      row.id,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM observability_thresholds WHERE id = ?", [row.id]);
  recordHistory(db, { tenantId, action: "THRESHOLD_UPDATED", entityType: "threshold", entityId: row.id, entityRef: row.threshold_ref, actor, summary: `Threshold ${row.threshold_ref} updated` });
  return publicThreshold(updated);
}

export function deleteThreshold(db, tenantId, ref, actor = null) {
  const row = getThresholdRow(db, tenantId, ref);
  if (!row) throw thresholdNotFound(ref);
  run(db, "UPDATE observability_thresholds SET status = 'ARCHIVED', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  recordHistory(db, { tenantId, action: "THRESHOLD_ARCHIVED", entityType: "threshold", entityId: row.id, entityRef: row.threshold_ref, actor, summary: `Threshold ${row.threshold_ref} archived` });
  return { archived: true, threshold_ref: row.threshold_ref };
}

export function listThresholds(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.metric_code || query.metricCode) {
    where.push("metric_code = ?");
    params.push(String(query.metric_code || query.metricCode).toUpperCase());
  }
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  return paged(db, "observability_thresholds", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicThreshold });
}

// Resolves a metric's effective thresholds: explicit threshold definitions win,
// otherwise the metric definition's own warning/critical values are used.
export function effectiveThresholds(db, tenantId, metric) {
  const explicit = listThresholds(db, tenantId, { metric_code: metric.code, status: "ACTIVE", page_size: 20 }).items;
  if (explicit.length) return explicit;
  if (metric.warning_threshold === null && metric.critical_threshold === null) return [];
  return [
    {
      threshold_ref: `${metric.metric_ref}:default`,
      metric_code: metric.code,
      operator: metric.direction === "LOWER_IS_WORSE" ? "LT" : "GT",
      warning_value: metric.warning_threshold,
      critical_value: metric.critical_threshold,
      direction: metric.direction === "LOWER_IS_WORSE" ? "DECREASING" : "INCREASING",
      status: "ACTIVE",
      scope: {},
      implicit: true,
    },
  ];
}

// Classifies a value against a single threshold definition.
export function classify(value, threshold) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return { band: "UNKNOWN", threshold: null };
  const numeric = Number(value);
  const { operator, warning_value: warn, critical_value: critical } = threshold;
  if (critical !== null && critical !== undefined && compare(numeric, operator, Number(critical))) return { band: "CRITICAL", threshold: Number(critical), operator };
  if (warn !== null && warn !== undefined && compare(numeric, operator, Number(warn))) return { band: "WARNING", threshold: Number(warn), operator };
  return { band: "OK", threshold: warn !== null && warn !== undefined ? Number(warn) : null, operator };
}

// Classifies a measurement against all effective thresholds for a metric and
// returns the highest band, matching the alert rule comparison used to breach.
export function classifyMetric(db, tenantId, metric, value) {
  const thresholds = effectiveThresholds(db, tenantId, metric);
  if (!thresholds.length) return { band: "UNKNOWN", threshold: null, operator: null };
  let worst = { band: "OK", threshold: null, operator: null };
  const rank = { UNKNOWN: 0, OK: 1, WARNING: 2, CRITICAL: 3 };
  for (const threshold of thresholds) {
    const result = classify(value, threshold);
    if (rank[result.band] > rank[worst.band]) worst = { ...result, threshold_ref: threshold.threshold_ref };
  }
  return worst;
}

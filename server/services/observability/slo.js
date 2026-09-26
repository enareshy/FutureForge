// SLO / SLA definitions and compliance evaluation.
//
// An SLO is an internal objective; an SLA is a contractual commitment. Both are
// described with the same primitives: a metric, a target, a comparison and a
// rolling window. Evaluation reads the observation stream, so it works with any
// provider without provider-specific code.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SLO_KINDS, SLO_COMPARISONS, METRIC_UNITS } from "./constants.js";
import { sloRef } from "./identifiers.js";
import { parseJson, stringifyJson, paged, toNumber, tableExists } from "./repository.js";
import { sloNotFound, sloConflict, invalidSlo } from "./errors.js";
import { recordHistory } from "./history.js";
import { observabilityEventCode, publishObservabilityEvent } from "./events.js";

export function publicSlo(row) {
  if (!row) return null;
  return {
    id: row.id,
    slo_ref: row.slo_ref,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    kind: row.kind,
    metric_code: row.metric_code,
    entity_code: row.entity_code,
    target: row.target,
    comparison: row.comparison,
    window_seconds: row.window_seconds,
    unit: row.unit,
    owner_user_id: row.owner_user_id,
    status: row.status,
    metadata: parseJson(row.metadata_json, {}),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getSloRow(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) return queryOne(db, "SELECT * FROM observability_slo_definitions WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  return queryOne(db, "SELECT * FROM observability_slo_definitions WHERE tenant_id = ? AND (slo_ref = ? OR code = ?)", [Number(tenantId), raw, raw]);
}

export function getSlo(db, tenantId, ref) {
  const row = getSloRow(db, tenantId, ref);
  if (!row) throw sloNotFound(ref);
  return publicSlo(row);
}

export function createSlo(db, tenantId, input = {}, actor = null) {
  const code = String(input.code || "").trim().toUpperCase();
  if (!code) throw invalidSlo("SLO/SLA code is required");
  if (!input.metric_code) throw invalidSlo("metric_code is required");
  const kind = String(input.kind || "SLO").toUpperCase();
  if (!SLO_KINDS.includes(kind)) throw invalidSlo(`Unsupported kind: ${input.kind}`);
  const comparison = String(input.comparison || "LTE").toUpperCase();
  if (!SLO_COMPARISONS.includes(comparison)) throw invalidSlo(`Unsupported comparison: ${input.comparison}`);
  const target = Number(input.target);
  if (!Number.isFinite(target)) throw invalidSlo("target must be numeric");
  const unit = String(input.unit || "PERCENT").toUpperCase();
  if (!METRIC_UNITS.includes(unit)) throw invalidSlo(`Unsupported unit: ${input.unit}`);
  if (queryOne(db, "SELECT id FROM observability_slo_definitions WHERE tenant_id = ? AND code = ? AND kind = ?", [Number(tenantId), code, kind])) throw sloConflict(code, kind);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO observability_slo_definitions (slo_ref, tenant_id, code, name, description, kind, metric_code, entity_code, target, comparison, window_seconds, unit, owner_user_id, status, metadata_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.slo_ref || sloRef(code, kind),
      Number(tenantId),
      code,
      String(input.name || code),
      String(input.description || ""),
      kind,
      String(input.metric_code).toUpperCase(),
      input.entity_code ?? null,
      target,
      comparison,
      Math.max(60, Number(input.window_seconds) || 86400),
      unit,
      input.owner_user_id ?? actor?.id ?? null,
      String(input.status || "ACTIVE").toUpperCase(),
      stringifyJson(input.metadata || {}),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM observability_slo_definitions WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordHistory(db, { tenantId, action: `${kind}_CREATED`, entityType: "slo", entityId: row.id, entityRef: row.slo_ref, actor, summary: `${kind} ${code} created` });
  writeAudit(db, { actor_id: actor?.id ?? null, actor_username: actor?.username ?? null, action: "observability.slo.create", resource_type: "observability_slo", resource_id: row.slo_ref, details: { code, kind } });
  return publicSlo(row);
}

export function updateSlo(db, tenantId, ref, input = {}, actor = null) {
  const row = getSloRow(db, tenantId, ref);
  if (!row) throw sloNotFound(ref);
  run(
    db,
    `UPDATE observability_slo_definitions SET name = ?, description = ?, metric_code = ?, entity_code = ?, target = ?, comparison = ?, window_seconds = ?, unit = ?, owner_user_id = ?, status = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
    [
      input.name ?? row.name,
      input.description ?? row.description,
      input.metric_code ? String(input.metric_code).toUpperCase() : row.metric_code,
      input.entity_code !== undefined ? input.entity_code : row.entity_code,
      input.target !== undefined ? Number(input.target) : row.target,
      input.comparison ? String(input.comparison).toUpperCase() : row.comparison,
      input.window_seconds !== undefined ? Math.max(60, Number(input.window_seconds)) : row.window_seconds,
      input.unit ? String(input.unit).toUpperCase() : row.unit,
      input.owner_user_id !== undefined ? input.owner_user_id : row.owner_user_id,
      input.status ? String(input.status).toUpperCase() : row.status,
      input.metadata !== undefined ? stringifyJson(input.metadata) : row.metadata_json,
      nowIso(),
      row.id,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM observability_slo_definitions WHERE id = ?", [row.id]);
  recordHistory(db, { tenantId, action: `${row.kind}_UPDATED`, entityType: "slo", entityId: row.id, entityRef: row.slo_ref, actor, summary: `${row.kind} ${row.code} updated` });
  return publicSlo(updated);
}

export function deleteSlo(db, tenantId, ref, actor = null) {
  const row = getSloRow(db, tenantId, ref);
  if (!row) throw sloNotFound(ref);
  run(db, "UPDATE observability_slo_definitions SET status = 'ARCHIVED', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  recordHistory(db, { tenantId, action: `${row.kind}_ARCHIVED`, entityType: "slo", entityId: row.id, entityRef: row.slo_ref, actor, summary: `${row.kind} ${row.code} archived` });
  return { archived: true, slo_ref: row.slo_ref };
}

export function listSlos(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.kind) {
    where.push("kind = ?");
    params.push(String(query.kind).toUpperCase());
  }
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  return paged(db, "observability_slo_definitions", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicSlo });
}

function compare(actual, comparison, target) {
  switch (comparison) {
    case "GTE":
      return actual >= target;
    case "GT":
      return actual > target;
    case "LTE":
      return actual <= target;
    case "LT":
      return actual < target;
    default:
      return false;
  }
}

function windowValues(db, tenantId, metricCode, windowSeconds) {
  if (!tableExists(db, "observability_metric_observations")) return [];
  return queryAll(
    db,
    "SELECT value FROM observability_metric_observations WHERE tenant_id = ? AND metric_code = ? AND observed_at >= datetime('now', ?) ORDER BY observed_at ASC",
    [Number(tenantId), String(metricCode), `-${Math.max(60, Number(windowSeconds))} seconds`]
  ).map((row) => Number(row.value));
}

function recentBreachRecorded(db, tenantId, sloRefValue) {
  return Boolean(
    queryOne(
      db,
      "SELECT id FROM observability_history WHERE tenant_id = ? AND entity_ref = ? AND action IN ('SLO_BREACHED', 'SLA_BREACHED') AND created_at >= datetime('now', '-1 day') LIMIT 1",
      [Number(tenantId), String(sloRefValue)]
    )
  );
}

export function evaluateSlo(db, tenantId, definition, actor = null) {
  const publicDef = publicSlo(definition);
  const values = windowValues(db, tenantId, definition.metric_code, definition.window_seconds);
  if (!values.length) {
    return { slo_ref: definition.slo_ref, code: definition.code, kind: definition.kind, metric_code: definition.metric_code, target: definition.target, comparison: definition.comparison, actual: null, meets: null, attainment_percent: null, samples: 0, status: "NO_DATA", error_budget_remaining: null };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  const actual = Number((sum / values.length).toFixed(4));
  const meets = compare(actual, definition.comparison, definition.target);
  const satisfying = values.filter((value) => compare(value, definition.comparison, definition.target)).length;
  const attainment = Number(((satisfying / values.length) * 100).toFixed(4));
  let errorBudget = null;
  if (definition.unit === "PERCENT") {
    const budget = Math.abs(100 - Number(definition.target));
    const consumed = definition.comparison === "GTE" ? Math.max(0, Number(definition.target) - actual) : Math.max(0, actual - Number(definition.target));
    errorBudget = budget > 0 ? Number(Math.max(0, 100 - (consumed / budget) * 100).toFixed(4)) : null;
  }
  const status = meets ? (attainment < 99 && attainment >= 95 ? "AT_RISK" : "COMPLIANT") : "BREACHED";
  return {
    slo_ref: definition.slo_ref,
    code: definition.code,
    kind: definition.kind,
    name: definition.name,
    metric_code: definition.metric_code,
    target: definition.target,
    comparison: definition.comparison,
    unit: definition.unit,
    window_seconds: definition.window_seconds,
    actual,
    meets,
    attainment_percent: attainment,
    samples: values.length,
    status,
    error_budget_remaining: errorBudget,
  };
}

export function evaluateAllSlos(db, tenantId, { actor = null, notify = true } = {}) {
  const definitions = queryAll(db, "SELECT * FROM observability_slo_definitions WHERE tenant_id = ? AND status = 'ACTIVE' ORDER BY kind, code", [Number(tenantId)]);
  const results = definitions.map((definition) => {
    const evaluation = evaluateSlo(db, tenantId, definition, actor);
    if (evaluation.status === "BREACHED" && notify && !recentBreachRecorded(db, tenantId, definition.slo_ref)) {
      recordHistory(db, {
        tenantId,
        action: definition.kind === "SLA" ? "SLA_BREACHED" : "SLO_BREACHED",
        entityType: "slo",
        entityId: definition.id,
        entityRef: definition.slo_ref,
        actor,
        summary: `${definition.kind} ${definition.code} breached (actual ${evaluation.actual} vs target ${definition.target})`,
        detail: evaluation,
      });
      publishObservabilityEvent(
        db,
        {
          eventType: observabilityEventCode(definition.kind === "SLA" ? "SLA_BREACHED" : "SLO_BREACHED"),
          payload: { slo_ref: definition.slo_ref, code: definition.code, kind: definition.kind, metric_code: definition.metric_code, target: definition.target, actual: evaluation.actual },
          objectType: "observability_slo",
          objectId: definition.id,
          tenantId,
        },
        actor
      );
    }
    return evaluation;
  });
  const breached = results.filter((entry) => entry.status === "BREACHED");
  return {
    evaluations: results,
    total: results.length,
    compliant: results.filter((entry) => entry.status === "COMPLIANT").length,
    at_risk: results.filter((entry) => entry.status === "AT_RISK").length,
    breached: breached.length,
    no_data: results.filter((entry) => entry.status === "NO_DATA").length,
  };
}

export function sloSummary(db, tenantId) {
  return evaluateAllSlos(db, tenantId, { notify: false });
}

export { SLO_KINDS, SLO_COMPARISONS };

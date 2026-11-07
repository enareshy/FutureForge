// Model evaluation, monitoring, drift and freshness (Stage 10).
//
// This module records MEASURED evaluation evidence. A model (or rule set) may
// only be marked validated when a real evaluation with measured metrics, a
// baseline comparison, a holdout and a leakage/time-awareness check has been
// recorded (prompt §7.3, acceptance §3/§4). It also reports prediction freshness,
// staleness, and drift between an early window and a recent window so degraded
// behaviour is observable (acceptance §11).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { normalizeText, normalizeUpper, paginate, parseObject, parseArray } from "../data-lifecycle/validation.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { publishPredictiveEvent, publishPredictiveEventAsync } from "./events.js";
import { getConfig, getConfigAsync } from "./configuration.js";
import { requireUseCaseRow, requireUseCaseRowAsync, getUseCaseRow, getUseCaseRowAsync } from "./use-cases.js";
import {
  SOURCE_MODULE,
  METHODS,
  RISK_CATEGORIES,
  RISK_ORDER,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./constants.js";
import { invalidPredictive, unsupportedMethod } from "./errors.js";

export function publicEvaluation(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    use_case_id: row.use_case_id,
    model_version: row.model_version || "",
    dataset_version: row.dataset_version || "",
    sample_size: Number(row.sample_size || 0),
    holdout_size: Number(row.holdout_size || 0),
    metrics: parseObject(row.metrics_json, {}),
    baseline_metrics: parseObject(row.baseline_metrics_json, {}),
    leakage_checked: Boolean(Number(row.leakage_checked)),
    time_aware: Boolean(Number(row.time_aware)),
    meets_min_volume: Boolean(Number(row.meets_min_volume)),
    validated: Boolean(Number(row.validated)),
    notes: row.notes || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

function evaluationFilters({ tenantId, use_case_id } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (use_case_id) {
    clauses.push("use_case_id = ?");
    params.push(Number(use_case_id));
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listEvaluations(db, opts = {}) {
  const { where, params } = evaluationFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pred_evaluations ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pred_evaluations ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicEvaluation), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listEvaluationsAsync(db, opts = {}) {
  const { where, params } = evaluationFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM pred_evaluations ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM pred_evaluations ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicEvaluation), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

// The measured-metric requirement is enforced here, not in the client: a model
// cannot be flagged validated merely by asking. This implements acceptance §4.
function normaliseEvaluationBody(useCase, body, tenant, minVolume) {
  const metrics = parseObject(body.metrics ?? body.metrics_json, {});
  const baseline = parseObject(body.baseline_metrics ?? body.baseline_metrics_json, {});
  const sampleSize = Number(body.sample_size || 0);
  const holdoutSize = Number(body.holdout_size || 0);
  const leakageChecked = body.leakage_checked === true || body.leakage_checked === 1 || body.leakage_checked === "1";
  const timeAware = body.time_aware === true || body.time_aware === 1 || body.time_aware === "1";
  const requestedValidated = body.validated === true || body.validated === 1 || body.validated === "1";
  const meetsMinVolume = sampleSize >= Math.max(Number(useCase.min_data_volume || 0), Number(minVolume || 0)) && sampleSize > 0;
  const measured = Object.keys(metrics).length > 0;
  const hasBaseline = Object.keys(baseline).length > 0;
  const reasons = [];
  if (!measured) reasons.push("No measured metrics were supplied.");
  if (!hasBaseline) reasons.push("No baseline comparison was supplied.");
  if (!leakageChecked) reasons.push("Leakage protection was not checked.");
  if (!timeAware) reasons.push("Time-aware validation was not performed.");
  if (!meetsMinVolume) reasons.push("Sample size does not meet the minimum data volume.");
  if (holdoutSize <= 0) reasons.push("No holdout set was evaluated.");
  const validated = requestedValidated && reasons.length === 0;
  return { metrics, baseline, sampleSize, holdoutSize, leakageChecked, timeAware, meetsMinVolume, requestedValidated, validated, reasons };
}

export function createEvaluation(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const useCase = requireUseCaseRow(db, tenant, ref);
  const minVolume = Number(getConfig(db, tenant, "min_data_volume")) || 0;
  const norm = normaliseEvaluationBody(useCase, body, tenant, minVolume);
  if (norm.requestedValidated && !norm.validated) {
    throw invalidPredictive("A model cannot be marked validated without a complete measured evaluation", { reasons: norm.reasons });
  }
  const result = run(
    db,
    `INSERT INTO pred_evaluations
       (tenant_id, use_case_id, model_version, dataset_version, sample_size, holdout_size, metrics_json, baseline_metrics_json,
        leakage_checked, time_aware, meets_min_volume, validated, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenant,
      useCase.id,
      normalizeText(body.model_version, { max: 120 }),
      normalizeText(body.dataset_version, { max: 120 }),
      norm.sampleSize,
      norm.holdoutSize,
      JSON.stringify(norm.metrics),
      JSON.stringify(norm.baseline),
      norm.leakageChecked ? 1 : 0,
      norm.timeAware ? 1 : 0,
      norm.meetsMinVolume ? 1 : 0,
      norm.validated ? 1 : 0,
      normalizeText(body.notes, { max: 2000 }),
      actor?.id ?? null,
    ]
  );
  const row = queryOne(db, "SELECT * FROM pred_evaluations WHERE id = ?", [Number(result.lastInsertId)]);
  writeAudit(db, {
    actor,
    action: "predictive.evaluation.create",
    resourceType: "pred_evaluation",
    resourceId: String(row.id),
    details: { use_case: useCase.code, validated: Boolean(Number(row.validated)), reasons: norm.reasons },
    ip,
  });
  publishPredictiveEvent(
    db,
    { eventType: "PredictionModelEvaluated", objectType: "pred_evaluation", objectId: String(row.id), tenantId: tenant, payload: { use_case: useCase.code, validated: Boolean(Number(row.validated)) } },
    actor
  );
  return { evaluation: publicEvaluation(row), validation_reasons: norm.reasons };
}

export async function createEvaluationAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const useCase = await requireUseCaseRowAsync(db, tenant, ref);
  const minVolume = Number(await getConfigAsync(db, tenant, "min_data_volume")) || 0;
  const norm = normaliseEvaluationBody(useCase, body, tenant, minVolume);
  if (norm.requestedValidated && !norm.validated) {
    throw invalidPredictive("A model cannot be marked validated without a complete measured evaluation", { reasons: norm.reasons });
  }
  const result = await runAsync(
    db,
    `INSERT INTO pred_evaluations
       (tenant_id, use_case_id, model_version, dataset_version, sample_size, holdout_size, metrics_json, baseline_metrics_json,
        leakage_checked, time_aware, meets_min_volume, validated, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenant,
      useCase.id,
      normalizeText(body.model_version, { max: 120 }),
      normalizeText(body.dataset_version, { max: 120 }),
      norm.sampleSize,
      norm.holdoutSize,
      JSON.stringify(norm.metrics),
      JSON.stringify(norm.baseline),
      norm.leakageChecked ? 1 : 0,
      norm.timeAware ? 1 : 0,
      norm.meetsMinVolume ? 1 : 0,
      norm.validated ? 1 : 0,
      normalizeText(body.notes, { max: 2000 }),
      actor?.id ?? null,
    ]
  );
  const row = await queryOneAsync(db, "SELECT * FROM pred_evaluations WHERE id = ?", [Number(result.lastInsertId)]);
  await writeAuditAsync(db, {
    actor,
    action: "predictive.evaluation.create",
    resourceType: "pred_evaluation",
    resourceId: String(row.id),
    details: { use_case: useCase.code, validated: Boolean(Number(row.validated)), reasons: norm.reasons },
    ip,
  });
  await publishPredictiveEventAsync(
    db,
    { eventType: "PredictionModelEvaluated", objectType: "pred_evaluation", objectId: String(row.id), tenantId: tenant, payload: { use_case: useCase.code, validated: Boolean(Number(row.validated)) } },
    actor
  );
  return { evaluation: publicEvaluation(row), validation_reasons: norm.reasons };
}

// Whether a use case currently has a validated ML model. Rule-based use cases
// always report ML disabled with the exact dataset requirements still needed.
function modelAvailability(db, tenant, useCase) {
  if (useCase.method !== METHODS.ML) {
    return {
      use_case: useCase.code,
      method: useCase.method,
      ml_enabled: false,
      validated: false,
      reason: useCase.method === METHODS.RULE_BASED
        ? "This use case currently produces deterministic rule assessments. No validated ML model is registered."
        : `This use case uses the ${useCase.method} method.`,
    };
  }
  const latest = queryOne(db, "SELECT * FROM pred_evaluations WHERE tenant_id = ? AND use_case_id = ? ORDER BY id DESC LIMIT 1", [tenant, useCase.id]);
  if (!latest || !Number(latest.validated)) {
    return { use_case: useCase.code, method: useCase.method, ml_enabled: false, validated: false, reason: "No validated evaluation has been recorded for this ML model." };
  }
  return { use_case: useCase.code, method: useCase.method, ml_enabled: true, validated: true, reason: "Validated evaluation recorded.", model_version: latest.model_version, evaluation_id: latest.id };
}

async function modelAvailabilityAsync(db, tenant, useCase) {
  if (useCase.method !== METHODS.ML) {
    return {
      use_case: useCase.code,
      method: useCase.method,
      ml_enabled: false,
      validated: false,
      reason: useCase.method === METHODS.RULE_BASED
        ? "This use case currently produces deterministic rule assessments. No validated ML model is registered."
        : `This use case uses the ${useCase.method} method.`,
    };
  }
  const latest = await queryOneAsync(db, "SELECT * FROM pred_evaluations WHERE tenant_id = ? AND use_case_id = ? ORDER BY id DESC LIMIT 1", [tenant, useCase.id]);
  if (!latest || !Number(latest.validated)) {
    return { use_case: useCase.code, method: useCase.method, ml_enabled: false, validated: false, reason: "No validated evaluation has been recorded for this ML model." };
  }
  return { use_case: useCase.code, method: useCase.method, ml_enabled: true, validated: true, reason: "Validated evaluation recorded.", model_version: latest.model_version, evaluation_id: latest.id };
}

export function modelStatus(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const useCase = requireUseCaseRow(db, tenant, ref);
  return { ...modelAvailability(db, tenant, useCase), dataset_requirements: parseObject(useCase.feature_schema_json, {}) };
}

export async function modelStatusAsync(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const useCase = await requireUseCaseRowAsync(db, tenant, ref);
  return { ...(await modelAvailabilityAsync(db, tenant, useCase)), dataset_requirements: parseObject(useCase.feature_schema_json, {}) };
}

// Freshness + life-cycle monitoring. A prediction is reported stale when it has
// explicitly been marked stale or its freshness window has elapsed (acceptance §6).
function freshnessOf(db, tenant) {
  const now = nowIso();
  const rows = queryAll(db, "SELECT status, freshness_expires_at, risk_category, created_at FROM pred_predictions WHERE tenant_id = ?", [tenant]);
  let expired = 0;
  let explicitlyStale = 0;
  let active = 0;
  let superseded = 0;
  const byCategory = Object.fromEntries(RISK_CATEGORIES.map((category) => [category, 0]));
  for (const row of rows) {
    if (row.risk_category && byCategory[row.risk_category] !== undefined) byCategory[row.risk_category] += 1;
    if (row.status === "STALE") explicitlyStale += 1;
    else if (row.status === "SUPERSEDED") superseded += 1;
    else if (row.freshness_expires_at && String(row.freshness_expires_at) < now) expired += 1;
    else active += 1;
  }
  return { total: rows.length, active, expired, explicitly_stale: explicitlyStale, superseded, stale_total: expired + explicitlyStale, by_risk_category: byCategory, as_of: now };
}

async function freshnessOfAsync(db, tenant) {
  const now = nowIso();
  const rows = await queryAllAsync(db, "SELECT status, freshness_expires_at, risk_category, created_at FROM pred_predictions WHERE tenant_id = ?", [tenant]);
  let expired = 0;
  let explicitlyStale = 0;
  let active = 0;
  let superseded = 0;
  const byCategory = Object.fromEntries(RISK_CATEGORIES.map((category) => [category, 0]));
  for (const row of rows) {
    if (row.risk_category && byCategory[row.risk_category] !== undefined) byCategory[row.risk_category] += 1;
    if (row.status === "STALE") explicitlyStale += 1;
    else if (row.status === "SUPERSEDED") superseded += 1;
    else if (row.freshness_expires_at && String(row.freshness_expires_at) < now) expired += 1;
    else active += 1;
  }
  return { total: rows.length, active, expired, explicitly_stale: explicitlyStale, superseded, stale_total: expired + explicitlyStale, by_risk_category: byCategory, as_of: now };
}

// Drift compares feedback-recorded observed risk categories against predicted
// categories. Only observed feedback is used; without it drift is UNKNOWN rather
// than fabricated (acceptance §11, prompt §7.3).
function driftFor(db, tenant) {
  const rows = queryAll(db, "SELECT output_json, risk_category FROM pred_predictions WHERE tenant_id = ? ORDER BY id DESC LIMIT 500", [tenant]);
  const observed = [];
  let withFeedback = 0;
  for (const row of rows) {
    const output = parseObject(row.output_json, {});
    const feedback = Array.isArray(output.feedback) ? output.feedback : [];
    for (const item of feedback) {
      if (!item.observed_risk_category) continue;
      withFeedback += 1;
      observed.push({ predicted: row.risk_category, observed: item.observed_risk_category });
    }
  }
  if (!observed.length) {
    return { status: "UNKNOWN", reason: "No feedback with an observed risk category has been recorded.", sampled_predictions: rows.length, feedback_samples: 0 };
  }
  let mismatches = 0;
  for (const item of observed) {
    const predicted = RISK_ORDER[item.predicted] ?? 0;
    const actual = RISK_ORDER[item.observed] ?? 0;
    if (Math.abs(predicted - actual) >= 1) mismatches += 1;
  }
  const ratio = mismatches / observed.length;
  const threshold = Number(getConfig(db, tenant, "drift_alert_ratio")) || 0.1;
  return {
    status: ratio > threshold ? "ALERT" : "OK",
    sampled_predictions: rows.length,
    feedback_samples: withFeedback,
    mismatch_ratio: Math.round(ratio * 10000) / 10000,
    threshold,
  };
}

async function driftForAsync(db, tenant) {
  const rows = await queryAllAsync(db, "SELECT output_json, risk_category FROM pred_predictions WHERE tenant_id = ? ORDER BY id DESC LIMIT 500", [tenant]);
  const observed = [];
  let withFeedback = 0;
  for (const row of rows) {
    const output = parseObject(row.output_json, {});
    const feedback = Array.isArray(output.feedback) ? output.feedback : [];
    for (const item of feedback) {
      if (!item.observed_risk_category) continue;
      withFeedback += 1;
      observed.push({ predicted: row.risk_category, observed: item.observed_risk_category });
    }
  }
  if (!observed.length) {
    return { status: "UNKNOWN", reason: "No feedback with an observed risk category has been recorded.", sampled_predictions: rows.length, feedback_samples: 0 };
  }
  let mismatches = 0;
  for (const item of observed) {
    const predicted = RISK_ORDER[item.predicted] ?? 0;
    const actual = RISK_ORDER[item.observed] ?? 0;
    if (Math.abs(predicted - actual) >= 1) mismatches += 1;
  }
  const ratio = mismatches / observed.length;
  const threshold = Number(await getConfigAsync(db, tenant, "drift_alert_ratio")) || 0.1;
  return {
    status: ratio > threshold ? "ALERT" : "OK",
    sampled_predictions: rows.length,
    feedback_samples: withFeedback,
    mismatch_ratio: Math.round(ratio * 10000) / 10000,
    threshold,
  };
}

export function monitoringSummary(db, tenantId) {
  const tenant = Number(tenantId);
  const useCases = queryAll(db, "SELECT * FROM pred_use_cases WHERE tenant_id = ? ORDER BY code", [tenant]);
  const models = useCases.map((useCase) => ({
    code: useCase.code,
    method: useCase.method,
    status: useCase.status,
    ruleset_version: useCase.ruleset_version,
    ...(() => {
      const availability = modelAvailability(db, tenant, useCase);
      return { ml_enabled: availability.ml_enabled, validated: availability.validated, reason: availability.reason };
    })(),
  }));
  const lastEvaluation = queryOne(db, "SELECT * FROM pred_evaluations WHERE tenant_id = ? ORDER BY id DESC LIMIT 1", [tenant]);
  return {
    source_module: SOURCE_MODULE,
    models,
    freshness: freshnessOf(db, tenant),
    drift: driftFor(db, tenant),
    last_evaluation: lastEvaluation ? publicEvaluation(lastEvaluation) : null,
    as_of: nowIso(),
  };
}

export async function monitoringSummaryAsync(db, tenantId) {
  const tenant = Number(tenantId);
  const useCases = await queryAllAsync(db, "SELECT * FROM pred_use_cases WHERE tenant_id = ? ORDER BY code", [tenant]);
  const models = [];
  for (const useCase of useCases) {
    const availability = await modelAvailabilityAsync(db, tenant, useCase);
    models.push({
      code: useCase.code,
      method: useCase.method,
      status: useCase.status,
      ruleset_version: useCase.ruleset_version,
      ml_enabled: availability.ml_enabled,
      validated: availability.validated,
      reason: availability.reason,
    });
  }
  const lastEvaluation = await queryOneAsync(db, "SELECT * FROM pred_evaluations WHERE tenant_id = ? ORDER BY id DESC LIMIT 1", [tenant]);
  return {
    source_module: SOURCE_MODULE,
    models,
    freshness: await freshnessOfAsync(db, tenant),
    drift: await driftForAsync(db, tenant),
    last_evaluation: lastEvaluation ? publicEvaluation(lastEvaluation) : null,
    as_of: nowIso(),
  };
}

export function predictionsHealth(db, tenantId = null) {
  const tenant = tenantId ? Number(tenantId) : null;
  const count = (table) =>
    tenant ? Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [tenant])?.c || 0) : Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`)?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    counts: {
      use_cases: count("pred_use_cases"),
      predictions: count("pred_predictions"),
      recommendations: count("pred_recommendations"),
      evaluations: count("pred_evaluations"),
    },
  };
}

export async function predictionsHealthAsync(db, tenantId = null) {
  const tenant = tenantId ? Number(tenantId) : null;
  const counts = {};
  const tables = { use_cases: "pred_use_cases", predictions: "pred_predictions", recommendations: "pred_recommendations", evaluations: "pred_evaluations" };
  for (const [key, table] of Object.entries(tables)) {
    counts[key] = tenant
      ? Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [tenant]))?.c || 0)
      : Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM ${table}`))?.c || 0);
  }
  return { source_module: SOURCE_MODULE, counts };
}

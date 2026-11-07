// Prediction execution, persistence, freshness and feedback (Stage 10).
//
// Predictions are stored with an explicit method, method version and the
// dataset/ruleset version that produced them, so a deterministic rule result can
// never be relabelled as a validated ML prediction. Every write is tenant-scoped,
// authorised upstream, audited and emits a domain event. Predictions are
// read-only projections: executing one never mutates the assessed subject
// (prompt §7.1, §7.3, §7.4).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { updateRow, updateRowAsync, assertVersion } from "../requirements/sql.js";
import { normalizeText, normalizeUpper, paginate, parseObject, parseArray, toNumber } from "../data-lifecycle/validation.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { publishPredictiveEvent, publishPredictiveEventAsync } from "./events.js";
import { getConfig, getConfigAsync } from "./configuration.js";
import { resolveSubject, resolveSubjectAsync } from "./subjects.js";
import { assessUseCase, assessUseCaseAsync } from "./assessment.js";
import { getUseCaseRow, getUseCaseRowAsync, requireUseCaseRow, requireUseCaseRowAsync } from "./use-cases.js";
import {
  SOURCE_MODULE,
  METHODS,
  PREDICTION_STATUSES,
  METHOD_LABELS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./constants.js";
import { predictionNotFound, predictionConflict, invalidPredictive } from "./errors.js";
import { predictionRef, shortId, stableKey } from "./refs.js";

const PREDICTION_COLUMNS = [
  "method",
  "model_version",
  "ruleset_version",
  "output_json",
  "risk_category",
  "confidence",
  "uncertainty_json",
  "explanation",
  "evidence_json",
  "limitations_json",
  "freshness_expires_at",
  "status",
  "idempotency_key",
];

// A prediction is only usable while it is ACTIVE and inside its freshness
// window. Expiry is derived at read time from the stored `freshness_expires_at`
// so the projection never presents an out-of-date result as current, without
// mutating the authoritative stored row (monitoring counts expiry separately).
function isExpired(row, now = nowIso()) {
  return Boolean(row && row.freshness_expires_at && String(row.freshness_expires_at) < now);
}

export function predictionAvailable(row, now = nowIso()) {
  if (!row) return false;
  return row.status === "ACTIVE" && !isExpired(row, now);
}

export function publicPrediction(row) {
  if (!row) return null;
  const uncertainty = parseObject(row.uncertainty_json, {});
  const expired = isExpired(row);
  return {
    id: row.id,
    prediction_ref: row.prediction_ref,
    tenant_id: row.tenant_id,
    use_case_id: row.use_case_id,
    use_case_code: row.use_case_code ?? null,
    subject_type: row.subject_type,
    subject_ref: row.subject_ref,
    method: row.method,
    method_label: METHOD_LABELS[row.method] || row.method,
    model_version: row.model_version || "",
    ruleset_version: row.ruleset_version || "",
    output: parseObject(row.output_json, {}),
    risk_category: row.risk_category || "UNKNOWN",
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    uncertainty,
    calibrated_probability: uncertainty?.kind === "CALIBRATED_PROBABILITY",
    explanation: row.explanation || "",
    evidence: parseArray(row.evidence_json, []),
    limitations: parseArray(row.limitations_json, []),
    freshness_expires_at: row.freshness_expires_at || null,
    // `stale` reflects an explicit life-cycle mark; `expired` reflects the
    // freshness window elapsing. Both make the result unusable (`available`).
    stale: row.status === "STALE",
    expired,
    available: predictionAvailable(row),
    status: row.status,
    idempotency_key: row.idempotency_key || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

function hoursFromNow(hours) {
  const ms = Date.now() + Math.max(1, Number(hours) || 168) * 3600 * 1000;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function predictionFilters({ tenantId, use_case_id, use_case_code, subject_type, subject_ref, status, risk_category, q } = {}) {
  const clauses = ["p.tenant_id = ?"];
  const params = [Number(tenantId)];
  if (use_case_id) {
    clauses.push("p.use_case_id = ?");
    params.push(Number(use_case_id));
  }
  if (use_case_code) {
    clauses.push("upper(u.code) = upper(?)");
    params.push(String(use_case_code));
  }
  if (subject_type) {
    clauses.push("p.subject_type = ?");
    params.push(normalizeUpper(subject_type));
  }
  if (subject_ref) {
    clauses.push("p.subject_ref = ?");
    params.push(String(subject_ref));
  }
  if (status) {
    clauses.push("p.status = ?");
    params.push(normalizeUpper(status));
  }
  if (risk_category) {
    clauses.push("p.risk_category = ?");
    params.push(normalizeUpper(risk_category));
  }
  if (q) {
    const like = `%${normalizeText(q, { max: 120 })}%`;
    clauses.push("(p.prediction_ref ILIKE ? OR p.explanation ILIKE ?)");
    params.push(like, like);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

const LIST_SELECT = `SELECT p.*, u.code AS use_case_code
  FROM pred_predictions p LEFT JOIN pred_use_cases u ON u.id = p.use_case_id`;

export function listPredictions(db, opts = {}) {
  const { where, params } = predictionFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pred_predictions p LEFT JOIN pred_use_cases u ON u.id = p.use_case_id ${where}`, params)?.c || 0);
  const rows = queryAll(db, `${LIST_SELECT} ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicPrediction), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listPredictionsAsync(db, opts = {}) {
  const { where, params } = predictionFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM pred_predictions p LEFT JOIN pred_use_cases u ON u.id = p.use_case_id ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `${LIST_SELECT} ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicPrediction), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export function getPredictionRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, `${LIST_SELECT} WHERE p.id = ? AND p.tenant_id = ?`, [id, Number(tenantId)]);
  }
  return queryOne(db, `${LIST_SELECT} WHERE p.tenant_id = ? AND p.prediction_ref = ?`, [Number(tenantId), String(ref)]);
}

export async function getPredictionRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, `${LIST_SELECT} WHERE p.id = ? AND p.tenant_id = ?`, [id, Number(tenantId)]);
  }
  return queryOneAsync(db, `${LIST_SELECT} WHERE p.tenant_id = ? AND p.prediction_ref = ?`, [Number(tenantId), String(ref)]);
}

export function requirePredictionRow(db, tenantId, ref) {
  const row = getPredictionRow(db, tenantId, ref);
  if (!row) throw predictionNotFound(ref);
  return row;
}

export async function requirePredictionRowAsync(db, tenantId, ref) {
  const row = await getPredictionRowAsync(db, tenantId, ref);
  if (!row) throw predictionNotFound(ref);
  return row;
}

export function getPrediction(db, tenantId, ref) {
  return publicPrediction(getPredictionRow(db, tenantId, ref));
}

export async function getPredictionAsync(db, tenantId, ref) {
  return publicPrediction(await getPredictionRowAsync(db, tenantId, ref));
}

// A prediction request validates and versions its inputs (acceptance §1): the
// use case must exist and be active, the subject must resolve through its
// owning module, and the method must equal the use case's registered method.
function prepare(db, tenant, body, useCase) {
  const subjectType = normalizeUpper(body.subject_type ?? body.subjectType, { max: 40 });
  const subjectRef = body.subject_ref ?? body.subjectRef;
  if (!subjectType) throw invalidPredictive("subject_type is required");
  if (subjectRef === undefined || subjectRef === null || subjectRef === "") throw invalidPredictive("subject_ref is required");
  if (useCase.status !== "ACTIVE") throw invalidPredictive(`Use case ${useCase.code} is not active`, { status: useCase.status });
  const requestedMethod = normalizeUpper(body.method ?? body.requested_method, { max: 40 });
  if (requestedMethod && requestedMethod !== useCase.method) {
    throw invalidPredictive(
      `Use case ${useCase.code} produces ${useCase.method} results; ${requestedMethod} is not available`,
      { use_case_method: useCase.method, requested_method: requestedMethod }
    );
  }
  return { subjectType, subjectRef: String(subjectRef), method: useCase.method };
}

function thresholdsFrom(db, tenant) {
  return {
    high: Number(getConfig(db, tenant, "risk_high_threshold")) || 60,
    critical: Number(getConfig(db, tenant, "risk_critical_threshold")) || 80,
  };
}

async function thresholdsFromAsync(db, tenant) {
  return {
    high: Number(await getConfigAsync(db, tenant, "risk_high_threshold")) || 60,
    critical: Number(await getConfigAsync(db, tenant, "risk_critical_threshold")) || 80,
  };
}

function idempotencyFor(tenant, useCase, subjectType, subjectRef, requestedKey) {
  return normalizeText(requestedKey, { max: 200 }) || stableKey(tenant, useCase.code, subjectType, subjectRef);
}

export function executePrediction(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const useCase = requireUseCaseRow(db, tenant, body.use_case ?? body.use_case_code ?? body.useCaseCode ?? body.use_case_id);
  const prepared = prepare(db, tenant, body, useCase);
  const subject = resolveSubject(db, tenant, prepared.subjectType, prepared.subjectRef);
  const thresholds = thresholdsFrom(db, tenant);
  const assessment = assessUseCase(db, tenant, useCase.code, subject, thresholds);

  const idempotencyKey = idempotencyFor(tenant, useCase, prepared.subjectType, prepared.subjectRef, body.idempotency_key ?? body.idempotencyKey);
  const existing = queryOne(db, "SELECT * FROM pred_predictions WHERE tenant_id = ? AND idempotency_key = ? AND use_case_id = ?", [tenant, idempotencyKey, useCase.id]);
  if (existing) {
    return { prediction: publicPrediction(existing), idempotent: true, available: predictionAvailable(existing) };
  }

  const ttl = Number(getConfig(db, tenant, "prediction_ttl_hours")) || 168;
  const ref = predictionRef(`${useCase.code}-${shortId()}`);
  const expires = hoursFromNow(ttl);
  const output = {
    use_case_code: useCase.code,
    method: useCase.method,
    available: assessment.available,
    score: assessment.score,
    risk_category: assessment.risk_category,
    features: assessment.features,
    dataset_requirements: assessment.dataset_requirements,
  };
  const confidence = assessment.available && assessment.score !== null ? Math.round(Number(assessment.score)) / 100 : null;
  const result = run(
    db,
    `INSERT INTO pred_predictions
       (prediction_ref, tenant_id, use_case_id, subject_type, subject_ref, method, model_version, ruleset_version,
        output_json, risk_category, confidence, uncertainty_json, explanation, evidence_json, limitations_json,
        freshness_expires_at, status, idempotency_key, created_by)
     VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    [
      ref,
      tenant,
      useCase.id,
      prepared.subjectType,
      prepared.subjectRef,
      useCase.method,
      useCase.ruleset_version,
      JSON.stringify(output),
      assessment.risk_category,
      confidence,
      JSON.stringify(assessment.uncertainty ?? {}),
      assessment.explanation,
      JSON.stringify(assessment.evidence ?? []),
      JSON.stringify([...(assessment.limitations ?? []), ...(assessment.dataset_requirements ?? [])]),
      expires,
      idempotencyKey,
      actor?.id ?? null,
    ]
  );
  const row = queryOne(db, `${LIST_SELECT} WHERE p.id = ?`, [Number(result.lastInsertId)]);
  writeAudit(db, {
    actor,
    action: "predictive.prediction.execute",
    resourceType: "prediction",
    resourceId: row.prediction_ref,
    details: { use_case: useCase.code, method: useCase.method, risk_category: row.risk_category, available: assessment.available },
    ip,
  });
  publishPredictiveEvent(
    db,
    {
      eventType: "PredictionExecuted",
      objectType: "prediction",
      objectId: String(row.id),
      tenantId: tenant,
      payload: { prediction_ref: row.prediction_ref, use_case: useCase.code, method: useCase.method, risk_category: row.risk_category, available: assessment.available },
    },
    actor
  );
  return { prediction: publicPrediction(row), idempotent: false, available: assessment.available };
}

export async function executePredictionAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const useCase = await requireUseCaseRowAsync(db, tenant, body.use_case ?? body.use_case_code ?? body.useCaseCode ?? body.use_case_id);
  const prepared = prepare(db, tenant, body, useCase);
  const subject = await resolveSubjectAsync(db, tenant, prepared.subjectType, prepared.subjectRef);
  const thresholds = await thresholdsFromAsync(db, tenant);
  const assessment = await assessUseCaseAsync(db, tenant, useCase.code, subject, thresholds);
  const idempotencyKey = idempotencyFor(tenant, useCase, prepared.subjectType, prepared.subjectRef, body.idempotency_key ?? body.idempotencyKey);
  const existing = await queryOneAsync(db, "SELECT * FROM pred_predictions WHERE tenant_id = ? AND idempotency_key = ? AND use_case_id = ?", [tenant, idempotencyKey, useCase.id]);
  if (existing) {
    return { prediction: publicPrediction(existing), idempotent: true, available: predictionAvailable(existing) };
  }
  const ttl = Number(await getConfigAsync(db, tenant, "prediction_ttl_hours")) || 168;
  const ref = predictionRef(`${useCase.code}-${shortId()}`);
  const expires = hoursFromNow(ttl);
  const output = {
    use_case_code: useCase.code,
    method: useCase.method,
    available: assessment.available,
    score: assessment.score,
    risk_category: assessment.risk_category,
    features: assessment.features,
    dataset_requirements: assessment.dataset_requirements,
  };
  const confidence = assessment.available && assessment.score !== null ? Math.round(Number(assessment.score)) / 100 : null;
  const result = await runAsync(
    db,
    `INSERT INTO pred_predictions
       (prediction_ref, tenant_id, use_case_id, subject_type, subject_ref, method, model_version, ruleset_version,
        output_json, risk_category, confidence, uncertainty_json, explanation, evidence_json, limitations_json,
        freshness_expires_at, status, idempotency_key, created_by)
     VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    [
      ref,
      tenant,
      useCase.id,
      prepared.subjectType,
      prepared.subjectRef,
      useCase.method,
      useCase.ruleset_version,
      JSON.stringify(output),
      assessment.risk_category,
      confidence,
      JSON.stringify(assessment.uncertainty ?? {}),
      assessment.explanation,
      JSON.stringify(assessment.evidence ?? []),
      JSON.stringify([...(assessment.limitations ?? []), ...(assessment.dataset_requirements ?? [])]),
      expires,
      idempotencyKey,
      actor?.id ?? null,
    ]
  );
  const row = await queryOneAsync(db, `${LIST_SELECT} WHERE p.id = ?`, [Number(result.lastInsertId)]);
  await writeAuditAsync(db, {
    actor,
    action: "predictive.prediction.execute",
    resourceType: "prediction",
    resourceId: row.prediction_ref,
    details: { use_case: useCase.code, method: useCase.method, risk_category: row.risk_category, available: assessment.available },
    ip,
  });
  await publishPredictiveEventAsync(
    db,
    {
      eventType: "PredictionExecuted",
      objectType: "prediction",
      objectId: String(row.id),
      tenantId: tenant,
      payload: { prediction_ref: row.prediction_ref, use_case: useCase.code, method: useCase.method, risk_category: row.risk_category, available: assessment.available },
    },
    actor
  );
  return { prediction: publicPrediction(row), idempotent: false, available: assessment.available };
}

// Explicit staleness marking (acceptance §6): preserves the recorded result and
// only adds an explicit marker plus an audit trail entry.
export function markPredictionStale(db, tenantId, ref, { reason = "Source changed" } = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requirePredictionRow(db, tenant, ref);
  if (row.status === "STALE") return { prediction: publicPrediction(row), changed: false };
  updateRow(db, "pred_predictions", row.id, { status: "STALE" }, { columns: ["status"], touch: false });
  const updated = queryOne(db, `${LIST_SELECT} WHERE p.id = ?`, [row.id]);
  writeAudit(db, { actor, action: "predictive.prediction.stale", resourceType: "prediction", resourceId: updated.prediction_ref, details: { reason }, ip });
  publishPredictiveEvent(
    db,
    { eventType: "PredictionStale", objectType: "prediction", objectId: String(updated.id), tenantId: tenant, payload: { prediction_ref: updated.prediction_ref, reason } },
    actor
  );
  return { prediction: publicPrediction(updated), changed: true };
}

export async function markPredictionStaleAsync(db, tenantId, ref, { reason = "Source changed" } = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requirePredictionRowAsync(db, tenant, ref);
  if (row.status === "STALE") return { prediction: publicPrediction(row), changed: false };
  await updateRowAsync(db, "pred_predictions", row.id, { status: "STALE" }, { columns: ["status"], touch: false });
  const updated = await queryOneAsync(db, `${LIST_SELECT} WHERE p.id = ?`, [row.id]);
  await writeAuditAsync(db, { actor, action: "predictive.prediction.stale", resourceType: "prediction", resourceId: updated.prediction_ref, details: { reason }, ip });
  await publishPredictiveEventAsync(
    db,
    { eventType: "PredictionStale", objectType: "prediction", objectId: String(updated.id), tenantId: tenant, payload: { prediction_ref: updated.prediction_ref, reason } },
    actor
  );
  return { prediction: publicPrediction(updated), changed: true };
}

// Records human feedback / measured outcome against a prediction. Kept on the
// prediction itself (idempotent by prediction) so model monitoring can compare
// the recorded assessment with what actually happened.
export function recordPredictionFeedback(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requirePredictionRow(db, tenant, ref);
  const output = parseObject(row.output_json, {});
  const existingFeedback = Array.isArray(output.feedback) ? output.feedback : [];
  const entry = {
    at: nowIso(),
    by: actor?.id ?? null,
    outcome: normalizeText(body.outcome, { max: 60 }).toUpperCase() || "UNKNOWN",
    notes: normalizeText(body.notes ?? body.note, { max: 2000 }),
    observed_risk_category: normalizeUpper(body.observed_risk_category ?? body.observedRiskCategory, { max: 40 }),
  };
  const feedbackKey = String(body.idempotency_key ?? body.idempotencyKey ?? "").trim();
  if (feedbackKey && existingFeedback.some((item) => item.idempotency_key === feedbackKey)) {
    return { prediction: publicPrediction(row), feedback: existingFeedback.find((item) => item.idempotency_key === feedbackKey), idempotent: true };
  }
  entry.idempotency_key = feedbackKey;
  const nextOutput = { ...output, feedback: [...existingFeedback, entry] };
  updateRow(db, "pred_predictions", row.id, { output_json: JSON.stringify(nextOutput) }, { touch: false });
  const updated = queryOne(db, `${LIST_SELECT} WHERE p.id = ?`, [row.id]);
  writeAudit(db, { actor, action: "predictive.prediction.feedback", resourceType: "prediction", resourceId: updated.prediction_ref, details: { outcome: entry.outcome }, ip });
  return { prediction: publicPrediction(updated), feedback: entry, idempotent: false };
}

export async function recordPredictionFeedbackAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requirePredictionRowAsync(db, tenant, ref);
  const output = parseObject(row.output_json, {});
  const existingFeedback = Array.isArray(output.feedback) ? output.feedback : [];
  const entry = {
    at: nowIso(),
    by: actor?.id ?? null,
    outcome: normalizeText(body.outcome, { max: 60 }).toUpperCase() || "UNKNOWN",
    notes: normalizeText(body.notes ?? body.note, { max: 2000 }),
    observed_risk_category: normalizeUpper(body.observed_risk_category ?? body.observedRiskCategory, { max: 40 }),
  };
  const feedbackKey = String(body.idempotency_key ?? body.idempotencyKey ?? "").trim();
  if (feedbackKey && existingFeedback.some((item) => item.idempotency_key === feedbackKey)) {
    return { prediction: publicPrediction(row), feedback: existingFeedback.find((item) => item.idempotency_key === feedbackKey), idempotent: true };
  }
  entry.idempotency_key = feedbackKey;
  const nextOutput = { ...output, feedback: [...existingFeedback, entry] };
  await updateRowAsync(db, "pred_predictions", row.id, { output_json: JSON.stringify(nextOutput) }, { touch: false });
  const updated = await queryOneAsync(db, `${LIST_SELECT} WHERE p.id = ?`, [row.id]);
  await writeAuditAsync(db, { actor, action: "predictive.prediction.feedback", resourceType: "prediction", resourceId: updated.prediction_ref, details: { outcome: entry.outcome }, ip });
  return { prediction: publicPrediction(updated), feedback: entry, idempotent: false };
}

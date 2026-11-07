// Recommendation lifecycle and governance (Stage 10).
//
// Recommendations are advisory. This module NEVER mutates an authoritative
// enterprise object and never executes a workflow on the user's behalf: the
// EXECUTED state records that a human carried out the recommended action through
// the owning module's authorised path, and OUTCOME_RECORDED captures the measured
// result (prompt §7.4). Every transition is authorised upstream, audited, and
// recorded in an append-only event trail. Stable keys make generation idempotent.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { updateRow, updateRowAsync } from "../requirements/sql.js";
import { normalizeText, normalizeUpper, paginate, parseObject, parseArray, toNumber } from "../data-lifecycle/validation.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { publishPredictiveEvent, publishPredictiveEventAsync } from "./events.js";
import { getConfig, getConfigAsync } from "./configuration.js";
import { requirePredictionRow, requirePredictionRowAsync } from "./predictions.js";
import {
  SOURCE_MODULE,
  RECOMMENDATION_STATUSES,
  RECOMMENDATION_TRANSITIONS,
  TERMINAL_RECOMMENDATION_STATUSES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./constants.js";
import { recommendationNotFound, recommendationConflict, invalidTransition, invalidPredictive } from "./errors.js";
import { recommendationRef, shortId, stableKey } from "./refs.js";

const RECOMMENDATION_COLUMNS = ["title", "reason", "evidence_json", "expected_benefit", "uncertainty", "priority", "status", "outcome_json"];

export function publicRecommendation(row, events = []) {
  if (!row) return null;
  return {
    id: row.id,
    recommendation_ref: row.recommendation_ref,
    tenant_id: row.tenant_id,
    use_case_id: row.use_case_id ?? null,
    prediction_id: row.prediction_id ?? null,
    title: row.title,
    reason: row.reason,
    evidence: parseArray(row.evidence_json, []),
    expected_benefit: row.expected_benefit || "",
    uncertainty: row.uncertainty || "",
    priority: Number(row.priority || 0),
    status: row.status,
    allowed_transitions: [...(RECOMMENDATION_TRANSITIONS[row.status] || [])],
    subject_type: row.subject_type || "",
    subject_ref: row.subject_ref || "",
    stable_key: row.stable_key || "",
    outcome: parseObject(row.outcome_json, {}),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    events,
  };
}

function recommendationFilters({ tenantId, status, use_case_id, subject_type, subject_ref, prediction_id, q } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (use_case_id) {
    clauses.push("use_case_id = ?");
    params.push(Number(use_case_id));
  }
  if (prediction_id) {
    clauses.push("prediction_id = ?");
    params.push(Number(prediction_id));
  }
  if (subject_type) {
    clauses.push("subject_type = ?");
    params.push(normalizeUpper(subject_type));
  }
  if (subject_ref) {
    clauses.push("subject_ref = ?");
    params.push(String(subject_ref));
  }
  if (q) {
    const like = `%${normalizeText(q, { max: 120 })}%`;
    clauses.push("(recommendation_ref ILIKE ? OR title ILIKE ? OR reason ILIKE ?)");
    params.push(like, like, like);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

function eventsFor(db, recommendationId) {
  return queryAll(db, "SELECT from_status, to_status, actor_user_id, note, created_at FROM pred_recommendation_events WHERE recommendation_id = ? ORDER BY id ASC", [Number(recommendationId)]).map(
    (row) => ({ from: row.from_status, to: row.to_status, actor_user_id: row.actor_user_id ?? null, note: row.note || "", at: row.created_at })
  );
}

function eventsForAsync(db, recommendationId) {
  return queryAllAsync(db, "SELECT from_status, to_status, actor_user_id, note, created_at FROM pred_recommendation_events WHERE recommendation_id = ? ORDER BY id ASC", [Number(recommendationId)]).then((rows) =>
    rows.map((row) => ({ from: row.from_status, to: row.to_status, actor_user_id: row.actor_user_id ?? null, note: row.note || "", at: row.created_at }))
  );
}

export function listRecommendations(db, opts = {}) {
  const { where, params } = recommendationFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pred_recommendations ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pred_recommendations ${where} ORDER BY priority DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map((row) => publicRecommendation(row)), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listRecommendationsAsync(db, opts = {}) {
  const { where, params } = recommendationFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM pred_recommendations ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM pred_recommendations ${where} ORDER BY priority DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map((row) => publicRecommendation(row)), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export function getRecommendationRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM pred_recommendations WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOne(db, "SELECT * FROM pred_recommendations WHERE tenant_id = ? AND recommendation_ref = ?", [Number(tenantId), String(ref)]);
}

export async function getRecommendationRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM pred_recommendations WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOneAsync(db, "SELECT * FROM pred_recommendations WHERE tenant_id = ? AND recommendation_ref = ?", [Number(tenantId), String(ref)]);
}

export function requireRecommendationRow(db, tenantId, ref) {
  const row = getRecommendationRow(db, tenantId, ref);
  if (!row) throw recommendationNotFound(ref);
  return row;
}

export async function requireRecommendationRowAsync(db, tenantId, ref) {
  const row = await getRecommendationRowAsync(db, tenantId, ref);
  if (!row) throw recommendationNotFound(ref);
  return row;
}

export function getRecommendation(db, tenantId, ref) {
  const row = getRecommendationRow(db, tenantId, ref);
  return row ? publicRecommendation(row, eventsFor(db, row.id)) : null;
}

export async function getRecommendationAsync(db, tenantId, ref) {
  const row = await getRecommendationRowAsync(db, tenantId, ref);
  return row ? publicRecommendation(row, await eventsForAsync(db, row.id)) : null;
}

function insertRecommendationEvent(db, tenant, recommendationId, fromStatus, toStatus, actor, note) {
  run(
    db,
    "INSERT INTO pred_recommendation_events (tenant_id, recommendation_id, from_status, to_status, actor_user_id, note) VALUES (?, ?, ?, ?, ?, ?)",
    [tenant, Number(recommendationId), fromStatus || "", toStatus || "", actor?.id ?? null, normalizeText(note, { max: 1000 })]
  );
}

async function insertRecommendationEventAsync(db, tenant, recommendationId, fromStatus, toStatus, actor, note) {
  await runAsync(
    db,
    "INSERT INTO pred_recommendation_events (tenant_id, recommendation_id, from_status, to_status, actor_user_id, note) VALUES (?, ?, ?, ?, ?, ?)",
    [tenant, Number(recommendationId), fromStatus || "", toStatus || "", actor?.id ?? null, normalizeText(note, { max: 1000 })]
  );
}

// Generation is idempotent through a stable key. A generated recommendation is
// never inserted twice; the existing row is returned instead (acceptance §8).
export function createRecommendation(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const title = normalizeText(body.title, { max: 300 });
  if (!title) throw invalidPredictive("title is required");
  const subjectType = normalizeUpper(body.subject_type ?? body.subjectType, { max: 40 });
  const subjectRef = String(body.subject_ref ?? body.subjectRef ?? "");
  const stable = normalizeText(body.stable_key ?? body.stableKey, { max: 240 }) || stableKey(tenant, subjectType, subjectRef, title);
  const existing = queryOne(db, "SELECT * FROM pred_recommendations WHERE tenant_id = ? AND stable_key = ?", [tenant, stable]);
  if (existing) return { recommendation: publicRecommendation(existing, eventsFor(db, existing.id)), idempotent: true };
  const status = normalizeUpper(body.status ?? "GENERATED", { max: 40 }) || "GENERATED";
  if (!RECOMMENDATION_STATUSES.includes(status)) throw invalidPredictive(`Invalid recommendation status: ${status}`, { allowed: [...RECOMMENDATION_STATUSES] });
  const ref = recommendationRef(`${shortId()}`);
  const result = run(
    db,
    `INSERT INTO pred_recommendations
       (recommendation_ref, tenant_id, use_case_id, prediction_id, title, reason, evidence_json, expected_benefit, uncertainty,
        priority, status, subject_type, subject_ref, stable_key, outcome_json, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
    [
      ref,
      tenant,
      body.use_case_id != null ? Number(body.use_case_id) : null,
      body.prediction_id != null ? Number(body.prediction_id) : null,
      title,
      normalizeText(body.reason, { max: 4000 }),
      JSON.stringify(parseArray(body.evidence, [])),
      normalizeText(body.expected_benefit ?? body.expectedBenefit, { max: 1000 }),
      normalizeText(body.uncertainty, { max: 2000 }),
      Number.isFinite(Number(body.priority)) ? Number(body.priority) : 0,
      status,
      subjectType,
      subjectRef,
      stable,
      actor?.id ?? null,
      actor?.id ?? null,
    ]
  );
  const row = queryOne(db, "SELECT * FROM pred_recommendations WHERE id = ?", [Number(result.lastInsertId)]);
  insertRecommendationEvent(db, tenant, row.id, "", status, actor, "generated");
  writeAudit(db, { actor, action: "predictive.recommendation.create", resourceType: "recommendation", resourceId: row.recommendation_ref, details: { title: row.title }, ip });
  publishPredictiveEvent(
    db,
    { eventType: "RecommendationGenerated", objectType: "recommendation", objectId: String(row.id), tenantId: tenant, payload: { recommendation_ref: row.recommendation_ref, title: row.title, subject_type: subjectType, subject_ref: subjectRef } },
    actor
  );
  return { recommendation: publicRecommendation(row, eventsFor(db, row.id)), idempotent: false };
}

export async function createRecommendationAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const title = normalizeText(body.title, { max: 300 });
  if (!title) throw invalidPredictive("title is required");
  const subjectType = normalizeUpper(body.subject_type ?? body.subjectType, { max: 40 });
  const subjectRef = String(body.subject_ref ?? body.subjectRef ?? "");
  const stable = normalizeText(body.stable_key ?? body.stableKey, { max: 240 }) || stableKey(tenant, subjectType, subjectRef, title);
  const existing = await queryOneAsync(db, "SELECT * FROM pred_recommendations WHERE tenant_id = ? AND stable_key = ?", [tenant, stable]);
  if (existing) return { recommendation: publicRecommendation(existing, await eventsForAsync(db, existing.id)), idempotent: true };
  const status = normalizeUpper(body.status ?? "GENERATED", { max: 40 }) || "GENERATED";
  if (!RECOMMENDATION_STATUSES.includes(status)) throw invalidPredictive(`Invalid recommendation status: ${status}`, { allowed: [...RECOMMENDATION_STATUSES] });
  const ref = recommendationRef(`${shortId()}`);
  const result = await runAsync(
    db,
    `INSERT INTO pred_recommendations
       (recommendation_ref, tenant_id, use_case_id, prediction_id, title, reason, evidence_json, expected_benefit, uncertainty,
        priority, status, subject_type, subject_ref, stable_key, outcome_json, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
    [
      ref,
      tenant,
      body.use_case_id != null ? Number(body.use_case_id) : null,
      body.prediction_id != null ? Number(body.prediction_id) : null,
      title,
      normalizeText(body.reason, { max: 4000 }),
      JSON.stringify(parseArray(body.evidence, [])),
      normalizeText(body.expected_benefit ?? body.expectedBenefit, { max: 1000 }),
      normalizeText(body.uncertainty, { max: 2000 }),
      Number.isFinite(Number(body.priority)) ? Number(body.priority) : 0,
      status,
      subjectType,
      subjectRef,
      stable,
      actor?.id ?? null,
      actor?.id ?? null,
    ]
  );
  const row = await queryOneAsync(db, "SELECT * FROM pred_recommendations WHERE id = ?", [Number(result.lastInsertId)]);
  await insertRecommendationEventAsync(db, tenant, row.id, "", status, actor, "generated");
  await writeAuditAsync(db, { actor, action: "predictive.recommendation.create", resourceType: "recommendation", resourceId: row.recommendation_ref, details: { title: row.title }, ip });
  await publishPredictiveEventAsync(
    db,
    { eventType: "RecommendationGenerated", objectType: "recommendation", objectId: String(row.id), tenantId: tenant, payload: { recommendation_ref: row.recommendation_ref, title: row.title, subject_type: subjectType, subject_ref: subjectRef } },
    actor
  );
  return { recommendation: publicRecommendation(row, await eventsForAsync(db, row.id)), idempotent: false };
}

// Transitions are validated against the governance graph so a recommendation can
// never jump straight from GENERATED to EXECUTED, and a terminal state cannot be
// reopened (prompt §7.4).
export function transitionRecommendation(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRecommendationRow(db, tenant, ref);
  const to = normalizeUpper(body.status ?? body.to_status ?? body.toStatus, { max: 40 });
  if (!to) throw invalidPredictive("status is required");
  if (!RECOMMENDATION_STATUSES.includes(to)) throw invalidPredictive(`Invalid recommendation status: ${to}`, { allowed: [...RECOMMENDATION_STATUSES] });
  const allowed = RECOMMENDATION_TRANSITIONS[row.status] || [];
  if (!allowed.includes(to)) throw invalidTransition(`Recommendation cannot move from ${row.status} to ${to}`, { from: row.status, to, allowed: [...allowed] });
  const patch = { status: to, updated_by: actor?.id ?? null };
  if (to === "OUTCOME_RECORDED") {
    const outcome = parseObject(body.outcome, body.outcome_json !== undefined ? parseObject(body.outcome_json, {}) : {});
    if (!Object.keys(outcome).length) throw invalidPredictive("outcome is required when recording an outcome");
    patch.outcome_json = JSON.stringify(outcome);
  }
  updateRow(db, "pred_recommendations", row.id, patch, { columns: ["status", "updated_by", "outcome_json"] });
  const updated = queryOne(db, "SELECT * FROM pred_recommendations WHERE id = ?", [row.id]);
  insertRecommendationEvent(db, tenant, row.id, row.status, to, actor, body.note);
  writeAudit(db, { actor, action: "predictive.recommendation.transition", resourceType: "recommendation", resourceId: updated.recommendation_ref, details: { from: row.status, to }, ip });
  const eventType = to === "OUTCOME_RECORDED" ? "RecommendationOutcomeRecorded" : "RecommendationStatusChanged";
  publishPredictiveEvent(
    db,
    { eventType, objectType: "recommendation", objectId: String(updated.id), tenantId: tenant, payload: { recommendation_ref: updated.recommendation_ref, from: row.status, to } },
    actor
  );
  return publicRecommendation(updated, eventsFor(db, updated.id));
}

export async function transitionRecommendationAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireRecommendationRowAsync(db, tenant, ref);
  const to = normalizeUpper(body.status ?? body.to_status ?? body.toStatus, { max: 40 });
  if (!to) throw invalidPredictive("status is required");
  if (!RECOMMENDATION_STATUSES.includes(to)) throw invalidPredictive(`Invalid recommendation status: ${to}`, { allowed: [...RECOMMENDATION_STATUSES] });
  const allowed = RECOMMENDATION_TRANSITIONS[row.status] || [];
  if (!allowed.includes(to)) throw invalidTransition(`Recommendation cannot move from ${row.status} to ${to}`, { from: row.status, to, allowed: [...allowed] });
  const patch = { status: to, updated_by: actor?.id ?? null };
  if (to === "OUTCOME_RECORDED") {
    const outcome = parseObject(body.outcome, body.outcome_json !== undefined ? parseObject(body.outcome_json, {}) : {});
    if (!Object.keys(outcome).length) throw invalidPredictive("outcome is required when recording an outcome");
    patch.outcome_json = JSON.stringify(outcome);
  }
  await updateRowAsync(db, "pred_recommendations", row.id, patch, { columns: ["status", "updated_by", "outcome_json"] });
  const updated = await queryOneAsync(db, "SELECT * FROM pred_recommendations WHERE id = ?", [row.id]);
  await insertRecommendationEventAsync(db, tenant, row.id, row.status, to, actor, body.note);
  await writeAuditAsync(db, { actor, action: "predictive.recommendation.transition", resourceType: "recommendation", resourceId: updated.recommendation_ref, details: { from: row.status, to }, ip });
  const eventType = to === "OUTCOME_RECORDED" ? "RecommendationOutcomeRecorded" : "RecommendationStatusChanged";
  await publishPredictiveEventAsync(
    db,
    { eventType, objectType: "recommendation", objectId: String(updated.id), tenantId: tenant, payload: { recommendation_ref: updated.recommendation_ref, from: row.status, to } },
    actor
  );
  return publicRecommendation(updated, await eventsForAsync(db, updated.id));
}

// ── Rule-based recommendation generation ─────────────────────────────────────
//
// Recommendations are derived ONLY from observed, authoritative evidence. Each
// carries a reason, evidence, expected benefit and uncertainty, and a stable key
// so repeated generation is idempotent (prompt §7.2E, §7.4).
function recommendationSeed({ title, reason, evidence, expectedBenefit, uncertainty, priority, subjectType, subjectRef }) {
  return { title, reason, evidence, expected_benefit: expectedBenefit, uncertainty, priority, subject_type: subjectType, subject_ref: subjectRef };
}

export function generateRecommendations(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const prediction = body.prediction_ref || body.predictionRef || body.prediction_id || body.predictionId
    ? requirePredictionRow(db, tenant, body.prediction_ref ?? body.predictionRef ?? body.prediction_id ?? body.predictionId)
    : null;
  if (!prediction) throw invalidPredictive("prediction_ref is required to generate recommendations");
  const output = parseObject(prediction.output_json, {});
  const features = output.features || {};
  const max = Math.max(1, Number(getConfig(db, tenant, "max_recommendations")) || 10);
  const seeds = [];
  const subjectType = prediction.subject_type;
  const subjectRef = prediction.subject_ref;

  if (!output.available) {
    seeds.push(
      recommendationSeed({
        title: "Collect the data required before predicting",
        reason: `No ${prediction.method} assessment could be produced: ${prediction.explanation}`,
        evidence: [{ source: "prediction", ref: prediction.prediction_ref, detail: prediction.explanation }],
        expectedBenefit: "Enables a measurable assessment instead of an unverified guess.",
        uncertainty: "The required inputs are currently missing.",
        priority: 40,
        subjectType,
        subjectRef,
      })
    );
  } else {
    if (Number(features.open_critical_issues || 0) > 0) {
      seeds.push(
        recommendationSeed({
          title: "Resolve and contain open critical quality issues",
          reason: `${features.open_critical_issues} critical/high quality issue(s) are open for this subject or its impacted objects.`,
          evidence: [{ source: "quality_issues", detail: `${features.open_critical_issues} open critical/high issue(s)` }],
          expectedBenefit: "Removes the dominant driver of the current risk score.",
          uncertainty: "Rule-based; verify each issue is genuinely applicable before closing.",
          priority: 90,
          subjectType,
          subjectRef,
        })
      );
    }
    if (Number(features.failed_inspections || 0) > 0) {
      seeds.push(
        recommendationSeed({
          title: "Investigate failed inspections",
          reason: `${features.failed_inspections} inspection(s) failed and may indicate a systemic defect.`,
          evidence: [{ source: "quality_inspections", detail: `${features.failed_inspections} failed inspection(s)` }],
          expectedBenefit: "Prevents repeat non-conformance reaching downstream stages.",
          uncertainty: "Inspection failure may be sample-specific.",
          priority: 75,
          subjectType,
          subjectRef,
        })
      );
    }
    if (Number(features.open_corrective_actions || 0) > 0) {
      seeds.push(
        recommendationSeed({
          title: "Close open corrective actions",
          reason: `${features.open_corrective_actions} corrective action(s) remain open.`,
          evidence: [{ source: "quality_corrective_actions", detail: `${features.open_corrective_actions} open action(s)` }],
          expectedBenefit: "Reduces residual quality risk and demonstrates closure evidence.",
          uncertainty: "Effectiveness still requires verification.",
          priority: 60,
          subjectType,
          subjectRef,
        })
      );
    }
    if (features.mbom_present === false) {
      seeds.push(
        recommendationSeed({
          title: "Create the manufacturing BOM",
          reason: "No MBOM is linked to the product, so manufacturing readiness cannot be established.",
          evidence: [{ source: "bom_headers", detail: "no manufacturing BOM" }],
          expectedBenefit: "Unblocks manufacturing readiness evaluation.",
          uncertainty: "None: this is a deterministic missing-input check.",
          priority: 85,
          subjectType,
          subjectRef,
        })
      );
    }
    if (features.bop_present === false) {
      seeds.push(
        recommendationSeed({
          title: "Create the bill of process",
          reason: "No BOP is linked to the product, so operations cannot be inspected.",
          evidence: [{ source: "bom_headers", detail: "no bill of process" }],
          expectedBenefit: "Enables operations and work-instruction readiness checks.",
          uncertainty: "None: this is a deterministic missing-input check.",
          priority: 80,
          subjectType,
          subjectRef,
        })
      );
    }
    if (Number(features.operations || 0) > 0 && Number(features.operations_with_work_instructions || 0) < Number(features.operations || 0)) {
      const missing = Number(features.operations) - Number(features.operations_with_work_instructions);
      seeds.push(
        recommendationSeed({
          title: "Publish work instructions for every operation",
          reason: `${missing} operation(s) have no active work instruction.`,
          evidence: [{ source: "content_associations", detail: `${missing} operation(s) undocumented` }],
          expectedBenefit: "Satisfies work-instruction readiness before release.",
          uncertainty: "None: count is derived from active content associations.",
          priority: 70,
          subjectType,
          subjectRef,
        })
      );
    }
    if (Number(features.failed_readiness || 0) > 0) {
      seeds.push(
        recommendationSeed({
          title: "Re-evaluate failed release readiness",
          reason: `${features.failed_readiness} readiness evaluation(s) failed or warned for impacted objects.`,
          evidence: [{ source: "quality_readiness_evaluations", detail: `${features.failed_readiness} non-passing evaluation(s)` }],
          expectedBenefit: "Confirms whether release blockers have genuinely cleared.",
          uncertainty: "Readiness results may be stale.",
          priority: 55,
          subjectType,
          subjectRef,
        })
      );
    }
    if (!seeds.length) {
      seeds.push(
        recommendationSeed({
          title: "Continue monitoring; no corrective action indicated",
          reason: `The ${prediction.method} assessment found no actionable risk driver above threshold.`,
          evidence: [{ source: "prediction", ref: prediction.prediction_ref, detail: `risk ${prediction.risk_category}` }],
          expectedBenefit: "Avoids unnecessary remediation work.",
          uncertainty: "Absence of a rule trigger is not proof of the absence of risk.",
          priority: 10,
          subjectType,
          subjectRef,
        })
      );
    }
  }

  const generated = [];
  for (const seed of seeds.slice(0, max)) {
    const created = createRecommendation(
      db,
      tenant,
      { ...seed, prediction_id: prediction.id, use_case_id: prediction.use_case_id, stable_key: stableKey(tenant, prediction.use_case_id, subjectType, subjectRef, seed.title) },
      actor,
      ip
    );
    generated.push({ ...created.recommendation, idempotent: created.idempotent });
  }
  return { recommendations: generated, prediction_ref: prediction.prediction_ref, count: generated.length, max };
}

export async function generateRecommendationsAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const prediction = body.prediction_ref || body.predictionRef || body.prediction_id || body.predictionId
    ? await requirePredictionRowAsync(db, tenant, body.prediction_ref ?? body.predictionRef ?? body.prediction_id ?? body.predictionId)
    : null;
  if (!prediction) throw invalidPredictive("prediction_ref is required to generate recommendations");
  const output = parseObject(prediction.output_json, {});
  const features = output.features || {};
  const max = Math.max(1, Number(await getConfigAsync(db, tenant, "max_recommendations")) || 10);
  const seeds = [];
  const subjectType = prediction.subject_type;
  const subjectRef = prediction.subject_ref;

  if (!output.available) {
    seeds.push(
      recommendationSeed({
        title: "Collect the data required before predicting",
        reason: `No ${prediction.method} assessment could be produced: ${prediction.explanation}`,
        evidence: [{ source: "prediction", ref: prediction.prediction_ref, detail: prediction.explanation }],
        expectedBenefit: "Enables a measurable assessment instead of an unverified guess.",
        uncertainty: "The required inputs are currently missing.",
        priority: 40,
        subjectType,
        subjectRef,
      })
    );
  } else {
    if (Number(features.open_critical_issues || 0) > 0) {
      seeds.push(
        recommendationSeed({
          title: "Resolve and contain open critical quality issues",
          reason: `${features.open_critical_issues} critical/high quality issue(s) are open for this subject or its impacted objects.`,
          evidence: [{ source: "quality_issues", detail: `${features.open_critical_issues} open critical/high issue(s)` }],
          expectedBenefit: "Removes the dominant driver of the current risk score.",
          uncertainty: "Rule-based; verify each issue is genuinely applicable before closing.",
          priority: 90,
          subjectType,
          subjectRef,
        })
      );
    }
    if (Number(features.failed_inspections || 0) > 0) {
      seeds.push(
        recommendationSeed({
          title: "Investigate failed inspections",
          reason: `${features.failed_inspections} inspection(s) failed and may indicate a systemic defect.`,
          evidence: [{ source: "quality_inspections", detail: `${features.failed_inspections} failed inspection(s)` }],
          expectedBenefit: "Prevents repeat non-conformance reaching downstream stages.",
          uncertainty: "Inspection failure may be sample-specific.",
          priority: 75,
          subjectType,
          subjectRef,
        })
      );
    }
    if (Number(features.open_corrective_actions || 0) > 0) {
      seeds.push(
        recommendationSeed({
          title: "Close open corrective actions",
          reason: `${features.open_corrective_actions} corrective action(s) remain open.`,
          evidence: [{ source: "quality_corrective_actions", detail: `${features.open_corrective_actions} open action(s)` }],
          expectedBenefit: "Reduces residual quality risk and demonstrates closure evidence.",
          uncertainty: "Effectiveness still requires verification.",
          priority: 60,
          subjectType,
          subjectRef,
        })
      );
    }
    if (features.mbom_present === false) {
      seeds.push(
        recommendationSeed({
          title: "Create the manufacturing BOM",
          reason: "No MBOM is linked to the product, so manufacturing readiness cannot be established.",
          evidence: [{ source: "bom_headers", detail: "no manufacturing BOM" }],
          expectedBenefit: "Unblocks manufacturing readiness evaluation.",
          uncertainty: "None: this is a deterministic missing-input check.",
          priority: 85,
          subjectType,
          subjectRef,
        })
      );
    }
    if (features.bop_present === false) {
      seeds.push(
        recommendationSeed({
          title: "Create the bill of process",
          reason: "No BOP is linked to the product, so operations cannot be inspected.",
          evidence: [{ source: "bom_headers", detail: "no bill of process" }],
          expectedBenefit: "Enables operations and work-instruction readiness checks.",
          uncertainty: "None: this is a deterministic missing-input check.",
          priority: 80,
          subjectType,
          subjectRef,
        })
      );
    }
    if (Number(features.operations || 0) > 0 && Number(features.operations_with_work_instructions || 0) < Number(features.operations || 0)) {
      const missing = Number(features.operations) - Number(features.operations_with_work_instructions);
      seeds.push(
        recommendationSeed({
          title: "Publish work instructions for every operation",
          reason: `${missing} operation(s) have no active work instruction.`,
          evidence: [{ source: "content_associations", detail: `${missing} operation(s) undocumented` }],
          expectedBenefit: "Satisfies work-instruction readiness before release.",
          uncertainty: "None: count is derived from active content associations.",
          priority: 70,
          subjectType,
          subjectRef,
        })
      );
    }
    if (Number(features.failed_readiness || 0) > 0) {
      seeds.push(
        recommendationSeed({
          title: "Re-evaluate failed release readiness",
          reason: `${features.failed_readiness} readiness evaluation(s) failed or warned for impacted objects.`,
          evidence: [{ source: "quality_readiness_evaluations", detail: `${features.failed_readiness} non-passing evaluation(s)` }],
          expectedBenefit: "Confirms whether release blockers have genuinely cleared.",
          uncertainty: "Readiness results may be stale.",
          priority: 55,
          subjectType,
          subjectRef,
        })
      );
    }
    if (!seeds.length) {
      seeds.push(
        recommendationSeed({
          title: "Continue monitoring; no corrective action indicated",
          reason: `The ${prediction.method} assessment found no actionable risk driver above threshold.`,
          evidence: [{ source: "prediction", ref: prediction.prediction_ref, detail: `risk ${prediction.risk_category}` }],
          expectedBenefit: "Avoids unnecessary remediation work.",
          uncertainty: "Absence of a rule trigger is not proof of the absence of risk.",
          priority: 10,
          subjectType,
          subjectRef,
        })
      );
    }
  }

  const generated = [];
  for (const seed of seeds.slice(0, max)) {
    const created = await createRecommendationAsync(
      db,
      tenant,
      { ...seed, prediction_id: prediction.id, use_case_id: prediction.use_case_id, stable_key: stableKey(tenant, prediction.use_case_id, subjectType, subjectRef, seed.title) },
      actor,
      ip
    );
    generated.push({ ...created.recommendation, idempotent: created.idempotent });
  }
  return { recommendations: generated, prediction_ref: prediction.prediction_ref, count: generated.length, max };
}

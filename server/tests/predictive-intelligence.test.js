process.env.FILE_STORAGE_PROVIDER = "memory";

// Stage 10 — Predictive Intelligence & Recommendations service tests.
//
// Exercises the prediction framework, deterministic rule-based assessments, the
// recommendation lifecycle and governance, model evaluation gating, freshness,
// drift and tenant isolation directly against a migrated + seeded database. The
// rule-based assessments read real Object/BOM/Quality rows so their behaviour is
// proven, not mocked.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, run, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createObject, createReference } from "../services/objects.js";
import { Foundation, UseCases, Predictions, Recommendations, Monitoring, SOURCE_MODULE, METHODS } from "../services/predictive-intelligence/index.js";
import { Quality } from "../services/manufacturing-quality/index.js";

const IP = "127.0.0.1";

function ensureOrganization(db, code) {
  let row = queryOne(db, "SELECT id FROM organizations WHERE code = ?", [code]);
  if (!row) {
    run(db, "INSERT INTO organizations (code, name, kind) VALUES (?, ?, 'organization')", [code, code]);
    row = queryOne(db, "SELECT id FROM organizations WHERE code = ?", [code]);
    run(db, "UPDATE organizations SET tenant_id = id WHERE id = ?", [row.id]);
  }
  return row.id;
}

function ensureType(db, code, name, module) {
  const existing = queryOne(db, "SELECT id FROM metadata_types WHERE code = ? ORDER BY tenant_id NULLS LAST LIMIT 1", [code]);
  if (existing) return existing.id;
  const inserted = run(db, "INSERT INTO metadata_types (code, name, module, status, tenant_id) VALUES (?, ?, ?, 'active', NULL)", [code, name, module]);
  return inserted.lastInsertId;
}

function ensurePart(db, tenant, code) {
  ensureType(db, "part", "Part", "plm");
  return createObject(
    db,
    { type: "part", code, name: code, status: "released", data: { "part.number": code, "part.name": code, "part.category": "mechanical", "part.status": "released" } },
    { id: 1 },
    tenant,
    IP
  );
}

function insertForeignObject(db, tenant, code) {
  const typeId = ensureType(db, "part", "Part", "plm");
  const inserted = run(
    db,
    `INSERT INTO objects (uuid, code, object_type_id, name, status, tenant_id, data_json)
     VALUES (?, ?, ?, ?, 'released', ?, '{}')`,
    [`uuid-${code}-${Date.now()}`, code, typeId, code, Number(tenant)]
  );
  return { id: inserted.lastInsertId, code };
}

function requestChange(db, tenant, actor, objectId, priority = "NORMAL") {
  const inserted = run(
    db,
    `INSERT INTO change_requests
       (request_ref, tenant_id, request_number, title, category, priority, status, object_id, version, created_by, updated_by)
     VALUES (?, ?, ?, ?, 'DESIGN', ?, 'APPROVED', ?, 1, ?, ?)`,
    [`ECR-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, tenant, `ECR-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, "Change", priority, objectId, actor.id, actor.id]
  );
  return queryOne(db, "SELECT * FROM change_requests WHERE id = ?", [inserted.lastInsertId]);
}

describe("Predictive Intelligence & Recommendations (Stage 10)", () => {
  let db;
  let tenant;
  let actor;
  let product;
  let qualityProduct;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    Foundation.ensurePredictiveFoundation(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    UseCases.ensureBuiltInUseCases(db, tenant, actor);
    product = ensurePart(db, tenant, "PI-PROD-1");
    qualityProduct = ensurePart(db, tenant, "PI-PROD-2");
  });

  after(() => {
    db?.close();
  });

  test("foundation is idempotent and exposes the module vocabulary", () => {
    const second = Foundation.ensurePredictiveFoundation(db);
    assert.equal(second.source_module, SOURCE_MODULE);
    assert.equal(second.event_types, 0);
    const seeded = UseCases.ensureBuiltInUseCases(db, tenant, actor);
    assert.equal(seeded.created, 0);
    const meta = UseCases.builtInCatalog();
    assert.ok(meta.some((entry) => entry.code === "ENGINEERING_CHANGE_RISK"));
    assert.ok(meta.some((entry) => entry.code === "QUALITY_RISK"));
  });

  test("exposes health counts scoped to the tenant", async () => {
    const health = await Monitoring.predictionsHealthAsync(db, tenant);
    assert.equal(health.source_module, SOURCE_MODULE);
    for (const key of ["use_cases", "predictions", "recommendations", "evaluations"]) {
      assert.equal(typeof health.counts[key], "number");
    }
  });

  test("lists the built-in use cases scoped to the tenant", () => {
    const result = UseCases.listUseCases(db, { tenantId: tenant });
    assert.ok(result.total >= 4);
    const codes = result.items.map((entry) => entry.code);
    assert.ok(codes.includes("ENGINEERING_CHANGE_RISK"));
    for (const entry of result.items) assert.equal(entry.method, METHODS.RULE_BASED);
  });

  test("change request without evidence reports insufficient data with requirements", () => {
    const change = requestChange(db, tenant, actor, product.id);
    const result = Predictions.executePrediction(db, tenant, { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: "ECR-1" }, actor, IP);
    assert.equal(result.prediction.method, "RULE_BASED");
    assert.equal(result.prediction.calibrated_probability, false);
    assert.equal(result.available, true);
    assert.ok(result.prediction.explanation.length > 0);
    assert.ok(Array.isArray(result.prediction.evidence));
  });

  test("engineering change risk is a rule-based assessment that cites evidence", () => {
    const change = requestChange(db, tenant, actor, product.id, "URGENT");
    const result = Predictions.executePrediction(db, tenant, { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: `ECR-URGENT-${change.id}` }, actor, IP);
    const prediction = result.prediction;
    assert.equal(prediction.method, "RULE_BASED");
    assert.equal(prediction.method_label, "Deterministic rule assessment");
    assert.equal(prediction.calibrated_probability, false);
    assert.ok(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(prediction.risk_category));
    assert.ok(prediction.evidence.length >= 3);
    assert.equal(prediction.uncertainty.kind, "RULE_BASED_SCORE");
    assert.ok(prediction.freshness_expires_at);
    assert.equal(prediction.status, "ACTIVE");
  });

  test("prediction execution is idempotent for the same key", () => {
    const first = Predictions.executePrediction(db, tenant, { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: requestChange(db, tenant, actor, product.id).id, idempotency_key: "DUP-KEY" }, actor, IP);
    const second = Predictions.executePrediction(db, tenant, { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: requestChange(db, tenant, actor, product.id).id, idempotency_key: "DUP-KEY" }, actor, IP);
    assert.equal(second.idempotent, true);
    assert.equal(second.prediction.prediction_ref, first.prediction.prediction_ref);
  });

  test("quality risk reports insufficient data when no quality records exist", () => {
    const result = Predictions.executePrediction(db, tenant, { use_case: "QUALITY_RISK", subject_type: "PRODUCT_REVISION", subject_ref: product.id, idempotency_key: `QR-NONE-${product.id}` }, actor, IP);
    assert.equal(result.available, false);
    assert.equal(result.prediction.risk_category, "UNKNOWN");
    assert.ok(result.prediction.limitations.some((line) => /labeled|labelled|holdout/i.test(line)));
  });

  test("quality risk becomes a rule-based assessment once quality records exist", () => {
    Quality.createQualityIssue(db, tenant, { title: "Critical defect", code: "PI-QI-1", severity: "CRITICAL", product_object_id: qualityProduct.id }, actor, IP);
    Quality.createQualityIssue(db, tenant, { title: "High defect", code: "PI-QI-2", severity: "HIGH", product_object_id: qualityProduct.id }, actor, IP);
    const result = Predictions.executePrediction(db, tenant, { use_case: "QUALITY_RISK", subject_type: "PRODUCT_REVISION", subject_ref: qualityProduct.id, idempotency_key: `QR-${qualityProduct.id}` }, actor, IP);
    assert.equal(result.available, true);
    assert.equal(result.prediction.method, "RULE_BASED");
    assert.notEqual(result.prediction.risk_category, "UNKNOWN");
    assert.ok(result.prediction.output.score > 0);
    assert.equal(result.prediction.output.features.open_issues, 2);
    assert.equal(result.prediction.output.features.critical_issues, 1);
  });

  test("manufacturing readiness risk is deterministic from readiness inputs", () => {
    const result = Predictions.executePrediction(db, tenant, { use_case: "MANUFACTURING_READINESS_RISK", subject_type: "PRODUCT_REVISION", subject_ref: product.id, idempotency_key: `MRR-${product.id}` }, actor, IP);
    assert.equal(result.available, true);
    assert.equal(result.prediction.method, "RULE_BASED");
    assert.equal(result.prediction.output.features.mbom_present, false);
    assert.equal(result.prediction.output.features.bop_present, false);
    assert.ok(result.prediction.evidence.some((item) => item.source === "bom_headers"));
  });

  test("schedule risk is never fabricated without schedule data", () => {
    const result = Predictions.executePrediction(db, tenant, { use_case: "DELIVERY_SCHEDULE_RISK", subject_type: "PRODUCT_REVISION", subject_ref: product.id, idempotency_key: `DSR-${product.id}` }, actor, IP);
    assert.equal(result.available, false);
    assert.equal(result.prediction.risk_category, "UNKNOWN");
    assert.ok(result.prediction.limitations.some((line) => /schedule/i.test(line)));
  });

  test("rejects requesting an ML result from a rule-based use case", () => {
    assert.throws(
      () => Predictions.executePrediction(db, tenant, { use_case: "QUALITY_RISK", subject_type: "PRODUCT_REVISION", subject_ref: product.id, method: "ML" }, actor, IP),
      /not available/i
    );
  });

  test("rejects an unknown or cross-tenant subject", () => {
    assert.throws(
      () => Predictions.executePrediction(db, tenant, { use_case: "QUALITY_RISK", subject_type: "PRODUCT_REVISION", subject_ref: 999999 }, actor, IP),
      /not found/i
    );
    const other = ensureOrganization(db, "pi-isolated");
    const foreign = insertForeignObject(db, other, "PI-FOREIGN");
    assert.throws(
      () => Predictions.executePrediction(db, tenant, { use_case: "QUALITY_RISK", subject_type: "PRODUCT_REVISION", subject_ref: foreign.id }, actor, IP),
      /not found/i
    );
  });

  test("getPrediction marks a prediction unavailable once its freshness window has elapsed", () => {
    const change = requestChange(db, tenant, actor, product.id);
    const { prediction } = Predictions.executePrediction(db, tenant, { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: `FRESH-${change.id}` }, actor, IP);
    assert.equal(prediction.available, true);
    assert.equal(prediction.expired, false);

    const read = Predictions.getPrediction(db, tenant, prediction.prediction_ref);
    assert.equal(read.available, true);
    assert.equal(read.expired, false);

    // Age the stored row rather than waiting for the TTL: expiry is derived at
    // read time from freshness_expires_at and must not require a status change.
    run(db, "UPDATE pred_predictions SET freshness_expires_at = ? WHERE id = ?", ["2000-01-01 00:00:00", prediction.id]);
    const expired = Predictions.getPrediction(db, tenant, prediction.prediction_ref);
    assert.equal(expired.status, "ACTIVE");
    assert.equal(expired.expired, true);
    assert.equal(expired.available, false);
    // The recorded result is preserved; expiry only affects usability.
    assert.deepEqual(expired.evidence, prediction.evidence);
    assert.equal(expired.output.score, prediction.output.score);
  });

  test("an explicitly stale prediction is unavailable even before its window elapses", () => {
    const change = requestChange(db, tenant, actor, product.id);
    const { prediction } = Predictions.executePrediction(db, tenant, { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: `STALE-READ-${change.id}` }, actor, IP);
    Predictions.markPredictionStale(db, tenant, prediction.prediction_ref, { reason: "source changed" }, actor, IP);
    const read = Predictions.getPrediction(db, tenant, prediction.prediction_ref);
    assert.equal(read.status, "STALE");
    assert.equal(read.stale, true);
    assert.equal(read.expired, false);
    assert.equal(read.available, false);
  });

  test("re-executing an expired idempotent prediction reports it as unavailable", () => {
    const change = requestChange(db, tenant, actor, product.id);
    const body = { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: `EXPIRED-EXEC-${change.id}` };
    const first = Predictions.executePrediction(db, tenant, body, actor, IP);
    assert.equal(first.available, true);
    run(db, "UPDATE pred_predictions SET freshness_expires_at = ? WHERE id = ?", ["2000-01-01 00:00:00", first.prediction.id]);

    const second = Predictions.executePrediction(db, tenant, body, actor, IP);
    assert.equal(second.idempotent, true);
    assert.equal(second.prediction.prediction_ref, first.prediction.prediction_ref);
    assert.equal(second.prediction.expired, true);
    assert.equal(second.available, false);
  });

  test("async read and execute mirror freshness enforcement", async () => {
    const change = requestChange(db, tenant, actor, product.id);
    const body = { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: `ASYNC-FRESH-${change.id}` };
    const first = await Predictions.executePredictionAsync(db, tenant, body, actor, IP);
    assert.equal(first.available, true);
    assert.equal((await Predictions.getPredictionAsync(db, tenant, first.prediction.prediction_ref)).available, true);

    run(db, "UPDATE pred_predictions SET freshness_expires_at = ? WHERE id = ?", ["2000-01-01 00:00:00", first.prediction.id]);
    const expired = await Predictions.getPredictionAsync(db, tenant, first.prediction.prediction_ref);
    assert.equal(expired.expired, true);
    assert.equal(expired.available, false);

    const second = await Predictions.executePredictionAsync(db, tenant, body, actor, IP);
    assert.equal(second.idempotent, true);
    assert.equal(second.available, false);
    assert.equal(second.prediction.expired, true);
  });

  test("predictions can be marked stale without losing their recorded result", () => {
    const change = requestChange(db, tenant, actor, product.id);
    const { prediction } = Predictions.executePrediction(db, tenant, { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: `STALE-${change.id}` }, actor, IP);
    const stale = Predictions.markPredictionStale(db, tenant, prediction.prediction_ref, { reason: "source changed" }, actor, IP);
    assert.equal(stale.changed, true);
    assert.equal(stale.prediction.status, "STALE");
    assert.deepEqual(stale.prediction.evidence, prediction.evidence);
  });

  test("feedback is recorded and idempotent by key", () => {
    const change = requestChange(db, tenant, actor, product.id);
    const { prediction } = Predictions.executePrediction(db, tenant, { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: `FB-${change.id}` }, actor, IP);
    const first = Predictions.recordPredictionFeedback(db, tenant, prediction.prediction_ref, { outcome: "CONFIRMED", observed_risk_category: "HIGH", idempotency_key: "fbk-1" }, actor, IP);
    assert.equal(first.idempotent, false);
    const second = Predictions.recordPredictionFeedback(db, tenant, prediction.prediction_ref, { outcome: "CONFIRMED", observed_risk_category: "HIGH", idempotency_key: "fbk-1" }, actor, IP);
    assert.equal(second.idempotent, true);
    assert.equal(second.feedback.outcome, "CONFIRMED");
  });

  test("generates ranked recommendations that cite the prediction evidence", () => {
    Quality.createQualityIssue(db, tenant, { title: "Rec critical", code: "PI-QI-REC", severity: "CRITICAL", product_object_id: qualityProduct.id }, actor, IP);
    const { prediction } = Predictions.executePrediction(db, tenant, { use_case: "QUALITY_RISK", subject_type: "PRODUCT_REVISION", subject_ref: qualityProduct.id, idempotency_key: `REC-${qualityProduct.id}` }, actor, IP);
    const generated = Recommendations.generateRecommendations(db, tenant, { prediction_ref: prediction.prediction_ref }, actor, IP);
    assert.ok(generated.count >= 1);
    const first = generated.recommendations[0];
    assert.equal(first.status, "GENERATED");
    assert.ok(first.reason.length > 0);
    assert.ok(first.evidence.length >= 1);
    assert.ok(Array.isArray(first.allowed_transitions));
    assert.ok(first.priority >= 0);
    const again = Recommendations.generateRecommendations(db, tenant, { prediction_ref: prediction.prediction_ref }, actor, IP);
    assert.ok(again.recommendations.every((item) => item.idempotent === true));
  });

  test("recommendation lifecycle enforces allowed transitions", () => {
    const change = requestChange(db, tenant, actor, product.id);
    const { prediction } = Predictions.executePrediction(db, tenant, { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: `LC-${change.id}` }, actor, IP);
    const rec = Recommendations.createRecommendation(db, tenant, { title: "Lifecycle rec", reason: "test", prediction_id: prediction.id, subject_type: "CHANGE", subject_ref: String(change.id), stable_key: `LC-${change.id}` }, actor, IP).recommendation;
    assert.throws(() => Recommendations.transitionRecommendation(db, tenant, rec.recommendation_ref, { status: "EXECUTED" }, actor, IP), /cannot move/i);
    const presented = Recommendations.transitionRecommendation(db, tenant, rec.recommendation_ref, { status: "PRESENTED" }, actor, IP);
    assert.equal(presented.status, "PRESENTED");
    const accepted = Recommendations.transitionRecommendation(db, tenant, rec.recommendation_ref, { status: "ACCEPTED" }, actor, IP);
    assert.equal(accepted.status, "ACCEPTED");
    const executed = Recommendations.transitionRecommendation(db, tenant, rec.recommendation_ref, { status: "EXECUTED" }, actor, IP);
    assert.equal(executed.status, "EXECUTED");
    assert.throws(() => Recommendations.transitionRecommendation(db, tenant, rec.recommendation_ref, { status: "OUTCOME_RECORDED" }, actor, IP), /outcome is required/i);
    const outcome = Recommendations.transitionRecommendation(db, tenant, rec.recommendation_ref, { status: "OUTCOME_RECORDED", outcome: { result: "resolved" } }, actor, IP);
    assert.equal(outcome.status, "OUTCOME_RECORDED");
    assert.deepEqual(outcome.outcome, { result: "resolved" });
    assert.ok(outcome.events.length >= 5);
  });

  test("recommendation generation is idempotent by stable key", () => {
    const change = requestChange(db, tenant, actor, product.id);
    const { prediction } = Predictions.executePrediction(db, tenant, { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: `IDEM-${change.id}` }, actor, IP);
    const body = { title: "Idem rec", reason: "test", prediction_id: prediction.id, subject_type: "CHANGE", subject_ref: String(change.id), stable_key: `IDEM-${change.id}` };
    const first = Recommendations.createRecommendation(db, tenant, body, actor, IP);
    const second = Recommendations.createRecommendation(db, tenant, body, actor, IP);
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(second.recommendation.recommendation_ref, first.recommendation.recommendation_ref);
  });

  test("a model cannot be marked validated without a measured evaluation", () => {
    const useCase = UseCases.getUseCaseRow(db, tenant, "QUALITY_RISK");
    assert.throws(
      () => Monitoring.createEvaluation(db, tenant, "QUALITY_RISK", { validated: true, metrics: { accuracy: 0.9 } }, actor, IP),
      /cannot be marked validated/i
    );
    const evaluation = Monitoring.createEvaluation(
      db,
      tenant,
      "QUALITY_RISK",
      { validated: true, metrics: { accuracy: 0.9, precision: 0.85 }, baseline_metrics: { accuracy: 0.7 }, sample_size: 200, holdout_size: 40, leakage_checked: true, time_aware: true, model_version: "qr-1", dataset_version: "ds-1" },
      actor,
      IP
    );
    assert.equal(evaluation.evaluation.validated, true);
    assert.equal(evaluation.validation_reasons.length, 0);
    const record = queryOne(db, "SELECT * FROM pred_evaluations WHERE use_case_id = ? AND validated = 1", [useCase.id]);
    assert.ok(record);
  });

  test("rule-based use cases never report a validated ML model", () => {
    const status = Monitoring.modelStatus(db, tenant, "QUALITY_RISK");
    assert.equal(status.ml_enabled, false);
    assert.equal(status.validated, false);
    assert.match(status.reason, /rule/i);
  });

  test("monitoring reports freshness, drift and model health", () => {
    const summary = Monitoring.monitoringSummary(db, tenant);
    assert.equal(summary.source_module, SOURCE_MODULE);
    assert.ok(summary.freshness.total >= 1);
    assert.ok(typeof summary.freshness.stale_total === "number");
    assert.ok(["OK", "ALERT", "UNKNOWN"].includes(summary.drift.status));
    assert.ok(Array.isArray(summary.models));
    assert.ok(summary.models.every((model) => model.ml_enabled === false));
  });

  test("change risk only counts the latest readiness evaluation per impacted object", () => {
    ensureType(db, "part", "Part", "plm");
    const asset = ensurePart(db, tenant, "PI-SUPERSEDE-1");
    const downstream = ensurePart(db, tenant, "PI-SUPERSEDE-2");
    createReference(
      db,
      { source_object_id: downstream.id, target_object_id: asset.id, reference_type: "strong", dependency: 1, context: "assembly" },
      actor,
      tenant,
      IP
    );
    const change = requestChange(db, tenant, actor, asset.id);
    const order = queryOne(
      db,
      `INSERT INTO change_orders (tenant_id, order_number, change_request_id, status, created_by, updated_by)
       VALUES (?, ?, ?, 'RELEASED', ?, ?) RETURNING id`,
      [tenant, `ECO-SUPERSEDE-${Date.now()}`, change.id, actor.id, actor.id]
    );
    run(
      db,
      `INSERT INTO change_affected_items (tenant_id, change_order_id, object_type, object_id, object_label, disposition)
       VALUES (?, ?, 'object', ?, ?, 'NEW_REVISION')`,
      [tenant, order.id, String(asset.id), asset.code]
    );

    const insertEval = (overall) =>
      run(
        db,
        `INSERT INTO quality_readiness_evaluations
           (evaluation_ref, tenant_id, subject_type, subject_object_id, subject_ref, overall_result, stale, ruleset_version)
         VALUES (?, ?, 'PRODUCT_REVISION', ?, ?, ?, 0, 'readiness-v1')`,
        [`QE-SUP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, tenant, Number(downstream.id), String(downstream.id), overall]
      );

    insertEval("FAIL");
    const result = Predictions.executePrediction(
      db,
      tenant,
      { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: `SUP-1-${change.id}` },
      actor,
      IP
    );
    assert.equal(result.prediction.output.features.failed_readiness, 1);

    // A later PASS for the same subject supersedes the earlier failure.
    insertEval("PASS");
    const after = Predictions.executePrediction(
      db,
      tenant,
      { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: `SUP-2-${change.id}` },
      actor,
      IP
    );
    assert.equal(after.prediction.output.features.failed_readiness, 0);
    assert.ok(Number(after.prediction.output.score) < Number(result.prediction.output.score));
  });

  test("async change risk only counts the latest readiness evaluation per impacted object", async () => {
    ensureType(db, "part", "Part", "plm");
    const asset = ensurePart(db, tenant, "PI-SUPERSEDE-ASYNC-1");
    const downstream = ensurePart(db, tenant, "PI-SUPERSEDE-ASYNC-2");
    createReference(
      db,
      { source_object_id: downstream.id, target_object_id: asset.id, reference_type: "strong", dependency: 1, context: "assembly" },
      actor,
      tenant,
      IP
    );
    const change = requestChange(db, tenant, actor, asset.id);
    const order = queryOne(
      db,
      `INSERT INTO change_orders (tenant_id, order_number, change_request_id, status, created_by, updated_by)
       VALUES (?, ?, ?, 'RELEASED', ?, ?) RETURNING id`,
      [tenant, `ECO-SUPERSEDE-ASYNC-${Date.now()}`, change.id, actor.id, actor.id]
    );
    run(
      db,
      `INSERT INTO change_affected_items (tenant_id, change_order_id, object_type, object_id, object_label, disposition)
       VALUES (?, ?, 'object', ?, ?, 'NEW_REVISION')`,
      [tenant, order.id, String(asset.id), asset.code]
    );

    const insertEval = (overall) =>
      run(
        db,
        `INSERT INTO quality_readiness_evaluations
           (evaluation_ref, tenant_id, subject_type, subject_object_id, subject_ref, overall_result, stale, ruleset_version)
         VALUES (?, ?, 'PRODUCT_REVISION', ?, ?, ?, 0, 'readiness-v1')`,
        [`QE-SUP-ASYNC-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, tenant, Number(downstream.id), String(downstream.id), overall]
      );

    insertEval("FAIL");
    const failed = await Predictions.executePredictionAsync(
      db,
      tenant,
      { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: `SUP-ASYNC-1-${change.id}` },
      actor,
      IP
    );
    assert.equal(failed.prediction.output.features.failed_readiness, 1);

    insertEval("PASS");
    const passed = await Predictions.executePredictionAsync(
      db,
      tenant,
      { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: `SUP-ASYNC-2-${change.id}` },
      actor,
      IP
    );
    assert.equal(passed.prediction.output.features.failed_readiness, 0);
    assert.ok(Number(passed.prediction.output.score) < Number(failed.prediction.output.score));
  });

  test("does not leak another tenant's records", () => {
    const other = ensureOrganization(db, "pi-isolated-2");
    const otherUseCases = UseCases.listUseCases(db, { tenantId: other });
    assert.equal(otherUseCases.total, 0);
    const otherPredictions = Predictions.listPredictions(db, { tenantId: other });
    assert.equal(otherPredictions.total, 0);
    const mine = Predictions.listPredictions(db, { tenantId: tenant, q: "PRD-" });
    assert.ok(mine.total >= 1);
  });
});

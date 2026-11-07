process.env.FILE_STORAGE_PROVIDER = "memory";

// Cross-stage end-to-end acceptance: Digital Thread impact (Stage 7) ->
// BOM structure (Stage 8) -> Change lifecycle -> Manufacturing & Quality
// readiness (Stage 9) -> Predictive Intelligence & Recommendations (Stage 10).
//
// Every assertion reads real rows written by an earlier stage; nothing is
// mocked. The scenario proves the stages compose: a dependency graph drives the
// change-risk assessment, a failed readiness evaluation surfaces as a
// recommendation, and no Stage-10 write mutates an authoritative Stage 7-9
// record.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryAll, queryOne, run, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createObject, createReference, impactOf } from "../services/objects.js";
import { Change, ensureChangeFoundation } from "../services/change/index.js";
import {
  Definitions as BomDefinitions,
  Revisions as BomRevisions,
  Lines as BomLines,
  Validator as BomValidator,
  ensureBomFoundation,
} from "../services/bom/index.js";
import {
  Quality,
  Readiness,
  Foundation as MqFoundation,
} from "../services/manufacturing-quality/index.js";
import {
  Predictions,
  Recommendations,
  Monitoring,
  UseCases,
  Foundation as PiFoundation,
} from "../services/predictive-intelligence/index.js";

const IP = "127.0.0.1";

function ensureType(db, code, name, module) {
  const existing = queryOne(db, "SELECT id FROM metadata_types WHERE code = ? ORDER BY tenant_id NULLS LAST LIMIT 1", [code]);
  if (existing) return existing.id;
  return run(db, "INSERT INTO metadata_types (code, name, module, status, tenant_id) VALUES (?, ?, ?, 'active', NULL)", [code, name, module]).lastInsertId;
}

function makeObject(db, tenant, actor, type, code) {
  const data = type === "part"
    ? { "part.number": code, "part.name": code, "part.category": "mechanical", "part.status": "released" }
    : {};
  return createObject(db, { type, code, name: code, status: "released", data }, actor, tenant, IP);
}

function bomFor(db, tenant, actor, productObjectId, bomType, revisionNumber = "A1") {
  const bom = BomDefinitions.createBom(
    db,
    tenant,
    { bom_number: `XS-${bomType}-${productObjectId}-${revisionNumber}`, name: `${bomType} for ${productObjectId}`, bom_type: bomType, owner_object_id: productObjectId },
    actor,
    IP
  );
  return BomRevisions.createRevision(db, tenant, bom.id, { revision_number: revisionNumber }, actor, IP);
}

function attachWorkInstruction(db, tenant, operationId, fileName) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const contentId = `XS-CNT-${stamp}`;
  const inserted = run(
    db,
    "INSERT INTO content (content_id, content_key, tenant_id, file_name, object_type, object_id, status, security_status, content_type) VALUES (?, ?, ?, ?, 'operation', ?, 'available', 'clean', 'document')",
    [contentId, `key-${stamp}`, tenant, fileName, String(operationId)]
  );
  run(
    db,
    "INSERT INTO content_associations (association_ref, tenant_id, object_type, object_id, object_name, content_id, content_role, status) VALUES (?, ?, 'operation', ?, ?, ?, 'WORK_INSTRUCTION', 'active')",
    [`XS-ASN-${stamp}`, tenant, String(operationId), fileName, inserted.lastInsertId]
  );
}

describe("Cross-stage E2E: Thread -> BOM -> Change -> Quality -> Prediction", () => {
  let db;
  let tenant;
  let actor;
  let product;
  let component;
  let subcomponent;
  let operation;
  let ebomRevision;
  let mbomRevision;
  let bopRevision;
  let changeRequest;
  let changeOrder;
  let criticalIssue;
  let failingEvaluation;
  let readyEvaluation;
  let changePrediction;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureChangeFoundation(db);
    ensureBomFoundation(db);
    MqFoundation.ensureManufacturingQualityFoundation(db);
    PiFoundation.ensurePredictiveFoundation(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    UseCases.ensureBuiltInUseCases(db, tenant, actor);

    ensureType(db, "part", "Part", "plm");
    ensureType(db, "operation", "Operation", "requirement-manufacturing");
    product = makeObject(db, tenant, actor, "part", "XS-PROD-1");
    component = makeObject(db, tenant, actor, "part", "XS-COMP-1");
    subcomponent = makeObject(db, tenant, actor, "part", "XS-SUB-1");
    operation = makeObject(db, tenant, actor, "operation", "XS-OP-1");

    // Stage 7: the dependency graph. component depends on product, sub on component.
    createReference(db, { source_object_id: component.id, target_object_id: product.id, reference_type: "strong", dependency: 1, context: "subsystem" }, actor, tenant, IP);
    createReference(db, { source_object_id: subcomponent.id, target_object_id: component.id, reference_type: "strong", dependency: 1, context: "fastener" }, actor, tenant, IP);

    // Stage 8: EBOM (validated), MBOM, BOP with a documented operation.
    ebomRevision = bomFor(db, tenant, actor, product.id, "EBOM");
    BomLines.addLine(db, tenant, ebomRevision.id, { child_object_id: String(component.id), child_object_type: "part", quantity: 2, uom: "EA", find_number: "10" }, actor, IP);
    BomValidator.validateRevision(db, tenant, ebomRevision.id, { actor, ip: IP });

    mbomRevision = bomFor(db, tenant, actor, product.id, "MBOM");
    BomLines.addLine(db, tenant, mbomRevision.id, { child_object_id: String(component.id), child_object_type: "part", quantity: 2, uom: "EA", find_number: "10" }, actor, IP);

    bopRevision = bomFor(db, tenant, actor, product.id, "BOP");
    BomLines.addLine(db, tenant, bopRevision.id, { child_object_id: String(operation.id), child_object_type: "operation", quantity: 1, uom: "EA", find_number: "20" }, actor, IP);
    attachWorkInstruction(db, tenant, operation.id, "xs-work-instruction.pdf");

    // Change lifecycle: ECR -> CCB approval -> ECO -> affected item -> release.
    changeRequest = Change.createRequest(db, tenant, { title: "XS engineering change", category: "DESIGN", priority: "URGENT", reason: "stack-up revision" }, actor, IP);
    Change.submitRequest(db, tenant, changeRequest.id, actor, IP);
    Change.screenRequest(db, tenant, changeRequest.id, "APPROVED", "CCB approved", actor, IP);
    changeOrder = Change.promoteRequest(db, tenant, changeRequest.id, {}, actor, IP).order;
    Change.addAffectedItem(db, tenant, changeOrder.id, { object_type: "object", object_id: String(product.id), object_label: "XS-PROD-1", disposition: "NEW_REVISION" }, actor, IP);
    Change.addAffectedItem(db, tenant, changeOrder.id, { object_type: "object", object_id: String(component.id), object_label: "XS-COMP-1", disposition: "NEW_REVISION" }, actor, IP);
    Change.submitOrder(db, tenant, changeOrder.id, actor, IP);
    Change.decideOrder(db, tenant, changeOrder.id, "APPROVED", actor, IP);
    changeOrder = Change.releaseOrder(db, tenant, changeOrder.id, actor, IP).order;

    // Stage 9: an open critical issue plus a completed inspection.
    criticalIssue = Quality.createQualityIssue(
      db,
      tenant,
      { title: "Critical crack", code: "XS-QI-1", severity: "CRITICAL", product_object_id: product.id, operation_object_id: operation.id },
      actor,
      IP
    );
    Quality.createInspection(
      db,
      tenant,
      { title: "Final inspection", code: "XS-IN-1", inspection_type: "FINAL", status: "PASSED", product_object_id: product.id, sample_size: 10, passed_count: 10, failed_count: 0 },
      actor,
      IP
    );

    const first = Readiness.evaluateReadiness(db, tenant, { subject_type: "PRODUCT_REVISION", subject_ref: product.id }, actor, IP);
    failingEvaluation = first.evaluation;
    // The impacted component has no structure of its own, so its readiness
    // genuinely fails; that failure must be visible to the change-risk
    // assessment through the Stage 7 dependency graph.
    const componentEvaluation = Readiness.evaluateReadiness(db, tenant, { subject_type: "PRODUCT_REVISION", subject_ref: component.id }, actor, IP);
    assert.equal(componentEvaluation.evaluation.overall_result, "FAIL");
  });

  after(() => {
    db?.close();
  });

  test("stage 7 — thread dependency graph reaches transitive components", () => {
    const impact = impactOf(db, product.id, tenant, { depth: 5 });
    const impactedIds = impact.impacted.map((node) => node.id);
    assert.ok(impactedIds.includes(component.id));
    assert.ok(impactedIds.includes(subcomponent.id));
    assert.ok(impact.impacted_count >= 2);
    assert.equal(impact.object.id, product.id);
  });

  test("stage 8 — EBOM validates and MBOM/BOP revisions resolve to the product", () => {
    const headers = queryAll(
      db,
      `SELECT h.bom_type, r.id, r.revision_number
         FROM bom_headers h JOIN bom_revisions r ON r.bom_id = h.id
        WHERE h.tenant_id = ? AND h.owner_object_id = ?`,
      [tenant, Number(product.id)]
    );
    assert.deepEqual(headers.map((row) => row.bom_type).sort(), ["BOP", "EBOM", "MBOM"]);

    const validations = queryAll(db, "SELECT status FROM bom_validation_results WHERE tenant_id = ? AND revision_id = ?", [tenant, ebomRevision.id]);
    assert.ok(validations.length >= 1);
    assert.equal(validations[0].status, "PASS");
  });

  test("change order is released with the affected item recorded", () => {
    assert.equal(changeOrder.status, "RELEASED");
    const items = Change.listAffectedItems(db, tenant, changeOrder.id);
    assert.equal(items.total, 2);
    assert.equal(items.items[0].object_id, String(product.id));
  });

  test("stage 9 — readiness fails while a critical issue is open", () => {
    assert.equal(failingEvaluation.overall_result, "FAIL");
    const checks = Object.fromEntries(failingEvaluation.checks.map((check) => [check.code, check.result]));
    assert.equal(checks.OPEN_QUALITY_ISSUES, "FAIL");
    assert.equal(checks.BOM_STRUCTURE_PRESENT, "PASS");
    assert.equal(checks.MBOM_PRESENT, "PASS");
    assert.equal(checks.BOP_PRESENT, "PASS");
    assert.equal(checks.OPERATIONS_PRESENT, "PASS");
    assert.equal(checks.OPERATIONS_HAVE_WORK_INSTRUCTIONS, "PASS");
  });

  test("stage 9 — resolving the issue clears the blocker and raises the score", () => {
    Quality.updateQualityIssue(db, tenant, criticalIssue.issue_ref, { status: "RESOLVED", disposition: "REWORK", version: 1 }, actor, IP);
    const second = Readiness.evaluateReadiness(db, tenant, { subject_type: "PRODUCT_REVISION", subject_ref: product.id }, actor, IP);
    readyEvaluation = second.evaluation;
    const checks = Object.fromEntries(readyEvaluation.checks.map((check) => [check.code, check.result]));
    assert.equal(checks.OPEN_QUALITY_ISSUES, "PASS");
    assert.equal(checks.INSPECTIONS_COMPLETE, "PASS");
    assert.notEqual(readyEvaluation.overall_result, "FAIL");
    assert.ok(Number(readyEvaluation.score) > Number(failingEvaluation.score));

    const summary = Quality.productQualitySummary(db, tenant, product.id);
    assert.equal(summary.issue_summary.total, 1);
    assert.equal(summary.inspection_summary.passed, 1);
  });

  test("stage 10 — change risk cites stage 7 impact, stage 8 change items and stage 9 readiness", () => {
    const result = Predictions.executePrediction(
      db,
      tenant,
      { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: changeRequest.id, idempotency_key: `XS-CR-${changeRequest.id}` },
      actor,
      IP
    );
    const prediction = result.prediction;
    assert.equal(result.available, true);
    assert.equal(prediction.method, "RULE_BASED");
    assert.equal(prediction.calibrated_probability, false);
    assert.equal(prediction.output.features.affected_items, 2);
    assert.ok(prediction.output.features.impacted_objects >= 2);
    assert.ok(prediction.output.features.failed_readiness >= 1);
    assert.ok(prediction.output.features.dependency_depth >= 2);
    const sources = prediction.evidence.map((item) => item.source);
    assert.ok(sources.includes("change_affected_items"));
    assert.ok(sources.includes("objects.impact"));
    assert.ok(sources.includes("quality_readiness_evaluations"));
    assert.equal(prediction.uncertainty.kind, "RULE_BASED_SCORE");

    changePrediction = prediction;
  });

  test("stage 10 — quality risk reads the resolved stage 9 records", () => {
    const result = Predictions.executePrediction(
      db,
      tenant,
      { use_case: "QUALITY_RISK", subject_type: "PRODUCT_REVISION", subject_ref: product.id, idempotency_key: `XS-QR-${product.id}` },
      actor,
      IP
    );
    assert.equal(result.available, true);
    assert.equal(result.prediction.output.features.historical_issues, 1);
    assert.equal(result.prediction.output.features.open_issues, 0);
    assert.equal(result.prediction.output.features.critical_issues, 0);
  });

  test("stage 10 — recommendations surface the stage 9 readiness failure and stay advisory", () => {
    const prediction = changePrediction;
    const issuesBefore = Number(queryOne(db, "SELECT COUNT(*) AS c FROM quality_issues WHERE tenant_id = ?", [tenant]).c);
    const generated = Recommendations.generateRecommendations(db, tenant, { prediction_ref: prediction.prediction_ref }, actor, IP);
    assert.ok(generated.count >= 1);
    assert.equal(generated.prediction_ref, prediction.prediction_ref);
    const readinessRec = generated.recommendations.find((rec) => rec.evidence.some((item) => item.source === "quality_readiness_evaluations"));
    assert.ok(readinessRec, "expected a recommendation sourced from the failing readiness evaluation");
    assert.equal(readinessRec.status, "GENERATED");

    const presented = Recommendations.transitionRecommendation(db, tenant, readinessRec.recommendation_ref, { status: "PRESENTED" }, actor, IP);
    assert.equal(presented.status, "PRESENTED");
    const accepted = Recommendations.transitionRecommendation(db, tenant, readinessRec.recommendation_ref, { status: "ACCEPTED" }, actor, IP);
    assert.equal(accepted.status, "ACCEPTED");
    assert.throws(
      () => Recommendations.transitionRecommendation(db, tenant, readinessRec.recommendation_ref, { status: "GENERATED" }, actor, IP),
      /cannot move/i
    );

    const issuesAfter = Number(queryOne(db, "SELECT COUNT(*) AS c FROM quality_issues WHERE tenant_id = ?", [tenant]).c);
    assert.equal(issuesAfter, issuesBefore);
    assert.equal(Change.getRequest(db, tenant, changeRequest.id).status, "PROMOTED");
    assert.equal(Quality.getQualityIssue(db, tenant, criticalIssue.issue_ref).status, "RESOLVED");
  });

  test("stage 10 — stale propagation and monitoring reflect cross-stage freshness", () => {
    const prediction = changePrediction;
    const stale = Predictions.markPredictionStale(db, tenant, prediction.prediction_ref, { reason: "BOM revision changed" }, actor, IP);
    assert.equal(stale.prediction.status, "STALE");
    const summary = Monitoring.monitoringSummary(db, tenant);
    assert.ok(summary.freshness.stale_total >= 1);
    assert.ok(summary.models.every((model) => model.ml_enabled === false));
  });
});

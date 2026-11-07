process.env.FILE_STORAGE_PROVIDER = "memory";

// Stage 9 — Manufacturing & Quality Intelligence service tests.
//
// Exercises the quality issue / inspection / corrective-action lifecycle, the
// deterministic quality intelligence projections and the release-readiness
// engine directly against a migrated + seeded database. Readiness is verified
// against real BOM/Object/V&V rows so the checks are proven, not mocked.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, run, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createObject } from "../services/objects.js";
import {
  Quality,
  Readiness,
  Subjects,
  Foundation,
  SOURCE_MODULE,
  READINESS_CHECKS,
} from "../services/manufacturing-quality/index.js";
import {
  Definitions as BomDefinitions,
  Revisions as BomRevisions,
  Lines as BomLines,
  Validator as BomValidator,
  ensureBomFoundation,
} from "../services/bom/index.js";

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
  const inserted = run(
    db,
    "INSERT INTO metadata_types (code, name, module, status, tenant_id) VALUES (?, ?, ?, 'active', NULL)",
    [code, name, module]
  );
  return inserted.lastInsertId;
}

function ensurePart(db, tenant, code) {
  ensureType(db, "part", "Part", "plm");
  return createObject(
    db,
    {
      type: "part",
      code,
      name: code,
      status: "released",
      data: { "part.number": code, "part.name": code, "part.category": "mechanical", "part.status": "released" },
    },
    { id: 1 },
    tenant,
    IP
  );
}

function ensureOperation(db, tenant, code) {
  ensureType(db, "operation", "Operation", "requirement-manufacturing");
  return createObject(db, { type: "operation", code, name: code }, { id: 1 }, tenant, IP);
}

// Inserts an object row for a foreign tenant directly. Used only to prove tenant
// isolation: a subject owned by another tenant must never be resolvable, so the
// fixture cannot rely on the caller's tenant-scoped metadata type.
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

function attachDocument(db, tenant, objectType, objectId, fileName) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const contentId = `CNT-${stamp}`;
  const inserted = run(
    db,
    "INSERT INTO content (content_id, content_key, tenant_id, file_name, object_type, object_id, status, security_status, content_type) VALUES (?, ?, ?, ?, ?, ?, 'available', 'clean', 'document')",
    [contentId, `key-${stamp}`, tenant, fileName, objectType, String(objectId)]
  );
  run(
    db,
    "INSERT INTO content_associations (association_ref, tenant_id, object_type, object_id, object_name, content_id, content_role, status) VALUES (?, ?, ?, ?, ?, ?, 'WORK_INSTRUCTION', 'active')",
    [`ASN-${stamp}`, tenant, objectType, String(objectId), fileName, inserted.lastInsertId]
  );
}

function bomFor(db, tenant, productObjectId, bomType, revisionNumber = "A1") {
  const bom = BomDefinitions.createBom(
    db,
    tenant,
    { bom_number: `MQ-${bomType}-${productObjectId}-${revisionNumber}`, name: `${bomType} for ${productObjectId}`, bom_type: bomType, owner_object_id: productObjectId },
    null,
    IP
  );
  return BomRevisions.createRevision(db, tenant, bom.id, { revision_number: revisionNumber }, null, IP);
}

describe("Manufacturing & Quality Intelligence (Stage 9)", () => {
  let db;
  let tenant;
  let actor;
  let product;
  let operation;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    Foundation.ensureManufacturingQualityFoundation(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    product = ensurePart(db, tenant, "MQ-PROD-1");
    operation = ensureOperation(db, tenant, "MQ-OP-1");
  });

  after(() => {
    db?.close();
  });

  test("foundation is idempotent and exposes the module vocabulary", () => {
    const second = Foundation.ensureManufacturingQualityFoundation(db);
    assert.equal(second.source_module, SOURCE_MODULE);
    assert.equal(second.event_types, 0);
    const meta = Readiness.readinessMeta();
    assert.equal(meta.checks.length, READINESS_CHECKS.length);
    assert.ok(meta.results.includes("NOT_EVALUATED"));
  });

  test("exposes health counts scoped to the tenant", () => {
    const health = Foundation.manufacturingQualityHealth(db, tenant);
    assert.equal(health.source_module, SOURCE_MODULE);
    for (const key of ["issues", "inspections", "corrective_actions", "readiness_evaluations"]) {
      assert.equal(typeof health.counts[key], "number");
    }
  });

  test("creates a quality issue with defaults and a resolved subject", () => {
    const issue = Quality.createQualityIssue(
      db,
      tenant,
      { title: "Porosity on housing", code: "MQ-QI-1", severity: "HIGH", product_object_id: product.id, operation_object_id: operation.id },
      actor,
      IP
    );
    assert.equal(issue.code, "MQ-QI-1");
    assert.equal(issue.issue_ref, "QI-MQ-QI-1");
    assert.equal(issue.status, "OPEN");
    assert.equal(issue.issue_type, "NONCONFORMANCE");
    assert.equal(issue.product_object_id, product.id);
    assert.equal(issue.operation_object_id, operation.id);
    assert.equal(issue.version, 1);
  });

  test("rejects a duplicate issue code", () => {
    assert.throws(
      () => Quality.createQualityIssue(db, tenant, { title: "Duplicate", code: "MQ-QI-1" }, actor, IP),
      /already exists/i
    );
  });

  test("rejects an unknown or cross-tenant subject", () => {
    assert.throws(
      () => Quality.createQualityIssue(db, tenant, { title: "Bad subject", code: "MQ-QI-BAD", product_object_id: 999999 }, actor, IP),
      /subject not found/i
    );
    const other = ensureOrganization(db, "mq-other-tenant");
    const foreign = insertForeignObject(db, other, "MQ-FOREIGN-PART");
    assert.throws(
      () => Quality.createQualityIssue(db, tenant, { title: "Foreign", code: "MQ-QI-FOREIGN", product_object_id: foreign.id }, actor, IP),
      /subject not found/i
    );
  });

  test("requires a disposition to resolve/close an issue", () => {
    assert.throws(
      () => Quality.updateQualityIssue(db, tenant, "MQ-QI-1", { status: "RESOLVED" }, actor, IP),
      /disposition/i
    );
  });

  test("updates an issue with optimistic concurrency and emits a status change", () => {
    const updated = Quality.updateQualityIssue(
      db,
      tenant,
      "MQ-QI-1",
      { status: "RESOLVED", disposition: "REWORK", version: 1 },
      actor,
      IP
    );
    assert.equal(updated.status, "RESOLVED");
    assert.equal(updated.disposition, "REWORK");
    assert.equal(updated.version, 2);
    assert.throws(
      () => Quality.updateQualityIssue(db, tenant, "MQ-QI-1", { severity: "LOW", version: 1 }, actor, IP),
      /already exists/i
    );
  });

  test("creates an inspection linked to an issue and validates counts", () => {
    const issue = Quality.getQualityIssue(db, tenant, "MQ-QI-1");
    const inspection = Quality.createInspection(
      db,
      tenant,
      { title: "Final dimensional check", code: "MQ-IN-1", inspection_type: "FINAL", status: "PASSED", product_object_id: product.id, quality_issue_id: issue.id, sample_size: 10, passed_count: 9, failed_count: 1 },
      actor,
      IP
    );
    assert.equal(inspection.code, "MQ-IN-1");
    assert.equal(inspection.status, "PASSED");
    assert.equal(inspection.quality_issue_id, issue.id);
    assert.throws(
      () => Quality.createInspection(db, tenant, { title: "Bad counts", code: "MQ-IN-BAD", sample_size: 2, passed_count: 2, failed_count: 2 }, actor, IP),
      /cannot exceed sample_size/i
    );
  });

  test("creates and transitions a corrective action, enforcing effectiveness on verify", () => {
    const issue = Quality.getQualityIssue(db, tenant, "MQ-QI-1");
    const action = Quality.createCorrectiveAction(
      db,
      tenant,
      { quality_issue_id: issue.id, title: "Adjust mould temperature", code: "MQ-CA-1" },
      actor,
      IP
    );
    assert.equal(action.code, "MQ-CA-1");
    assert.equal(action.status, "OPEN");
    assert.equal(action.quality_issue_id, issue.id);
    assert.throws(
      () => Quality.updateCorrectiveAction(db, tenant, "MQ-CA-1", { status: "VERIFIED", version: 1 }, actor, IP),
      /effectiveness/i
    );
    const verified = Quality.updateCorrectiveAction(
      db,
      tenant,
      "MQ-CA-1",
      { status: "VERIFIED", effectiveness: "EFFECTIVE", version: 1 },
      actor,
      IP
    );
    assert.equal(verified.status, "VERIFIED");
    assert.equal(verified.effectiveness, "EFFECTIVE");
    assert.equal(verified.version, 2);
  });

  test("summarises product quality and detects gaps", () => {
    const summary = Quality.productQualitySummary(db, tenant, product.id);
    assert.equal(summary.product_object_id, product.id);
    assert.ok(summary.issue_summary.total >= 1);
    assert.equal(summary.inspection_summary.total, 1);
    assert.equal(summary.inspection_summary.passed, 1);
    assert.equal(summary.inspection_summary.failed, 0);

    const gaps = Quality.detectQualityGaps(db, tenant);
    assert.ok(Array.isArray(gaps.issues_without_inspection));
    assert.ok(Array.isArray(gaps.issues_without_corrective_action));
    assert.equal(typeof gaps.counts.issues_without_inspection, "number");
  });

  test("reports issue metrics grouped by status and severity", () => {
    const metrics = Quality.issueMetrics(db, tenant);
    assert.equal(metrics.source_module, SOURCE_MODULE);
    assert.equal(metrics.issues_by_severity.HIGH, 1);
    assert.ok(metrics.issues_by_status.RESOLVED >= 1);
  });

  test("recurrence detection only reports observed repeats", () => {
    const result = Quality.detectRecurrence(db, tenant, { windowDays: 3650 });
    assert.equal(result.source_module, SOURCE_MODULE);
    assert.ok(Array.isArray(result.patterns));
    assert.ok(result.limitations.length > 0);
  });

  test("readiness reports NOT_EVALUATED when inputs are genuinely absent", () => {
    const bare = ensurePart(db, tenant, "MQ-BARE-1");
    const result = Readiness.evaluateReadiness(db, tenant, { subject_type: "PRODUCT_REVISION", subject_ref: bare.id }, actor, IP);
    const byCode = Object.fromEntries(result.evaluation.checks.map((check) => [check.code, check]));
    assert.equal(byCode.BOM_STRUCTURE_PRESENT.result, "FAIL");
    assert.equal(byCode.BOM_STRUCTURE_VALID.result, "NOT_EVALUATED");
    assert.equal(byCode.INSPECTIONS_COMPLETE.result, "NOT_EVALUATED");
    assert.equal(byCode.REQUIRED_APPROVALS.result, "NOT_EVALUATED");
    assert.notEqual(result.evaluation.overall_result, "PASS");
    assert.equal(result.evaluation.stale, false);
  });

  test("readiness fails on an open critical issue and passes once the build is complete", () => {
    const subject = ensurePart(db, tenant, "MQ-READY-1");
    const op = ensureOperation(db, tenant, "MQ-READY-OP-1");

    const critical = Quality.createQualityIssue(
      db,
      tenant,
      { title: "Critical crack", code: "MQ-READY-QI-1", severity: "CRITICAL", product_object_id: subject.id, operation_object_id: op.id },
      actor,
      IP
    );
    const failing = Readiness.evaluateReadiness(db, tenant, { subject_type: "PRODUCT_REVISION", subject_ref: subject.id }, actor, IP);
    const openCheck = failing.evaluation.checks.find((check) => check.code === "OPEN_QUALITY_ISSUES");
    assert.equal(openCheck.result, "FAIL");
    assert.equal(failing.evaluation.overall_result, "FAIL");

    // Correct the deficiency: resolve the issue (with a disposition) and add the
    // authoritative upstream artefacts the remaining checks require.
    Quality.updateQualityIssue(db, tenant, critical.issue_ref, { status: "RESOLVED", disposition: "REWORK", version: 1 }, actor, IP);

    const ebom = bomFor(db, tenant, subject.id, "EBOM");
    BomLines.addLine(db, tenant, ebom.id, { child_object_id: "MQ-COMP-1", child_object_type: "part", quantity: 1, uom: "EA", find_number: "10" }, actor, IP);
    BomValidator.validateRevision(db, tenant, ebom.id, { actor, ip: IP });

    const mbom = bomFor(db, tenant, subject.id, "MBOM");
    BomLines.addLine(db, tenant, mbom.id, { child_object_id: "MQ-COMP-1", child_object_type: "part", quantity: 1, uom: "EA", find_number: "10" }, actor, IP);

    const bop = bomFor(db, tenant, subject.id, "BOP");
    BomLines.addLine(db, tenant, bop.id, { child_object_id: String(op.id), child_object_type: "operation", quantity: 1, uom: "EA", find_number: "20" }, actor, IP);
    attachDocument(db, tenant, "operation", op.id, "mq-work-instruction.pdf");

    const passing = Readiness.evaluateReadiness(db, tenant, { subject_type: "PRODUCT_REVISION", subject_ref: subject.id }, actor, IP);
    const byCode = Object.fromEntries(passing.evaluation.checks.map((check) => [check.code, check]));
    assert.equal(byCode.BOM_STRUCTURE_PRESENT.result, "PASS");
    assert.equal(byCode.MBOM_PRESENT.result, "PASS");
    assert.equal(byCode.BOP_PRESENT.result, "PASS");
    assert.equal(byCode.OPERATIONS_PRESENT.result, "PASS");
    assert.equal(byCode.OPEN_QUALITY_ISSUES.result, "PASS");
    assert.equal(byCode.CORRECTIVE_ACTIONS_COMPLETE.result, "PASS");
    assert.equal(byCode.OPERATIONS_HAVE_WORK_INSTRUCTIONS.result, "PASS");
    assert.ok(passing.evaluation.score > failing.evaluation.score);
  });

  test("marks prior evaluations stale without losing the recorded result", () => {
    const subject = ensurePart(db, tenant, "MQ-STALE-1");
    const first = Readiness.evaluateReadiness(db, tenant, { subject_type: "PRODUCT_REVISION", subject_ref: subject.id }, actor, IP);
    const result = Readiness.markReadinessStale(
      db,
      tenant,
      { subjectType: "PRODUCT_REVISION", subjectRef: String(subject.id), reason: "revision A -> B" },
      actor,
      IP
    );
    assert.equal(result.updated, 1);
    const reloaded = Readiness.getReadinessEvaluation(db, tenant, first.evaluation.evaluation_ref);
    assert.equal(reloaded.stale, true);
    assert.equal(reloaded.stale_reason, "revision A -> B");
    assert.equal(reloaded.overall_result, first.evaluation.overall_result);
  });

  test("readiness rejects an unresolved subject", () => {
    assert.throws(
      () => Readiness.evaluateReadiness(db, tenant, { subject_type: "PRODUCT_REVISION", subject_ref: 999999 }, actor, IP),
      /subject not found/i
    );
    assert.throws(() => Readiness.evaluateReadiness(db, tenant, { subject_type: "NOPE", subject_ref: 1 }, actor, IP), /Unknown subject_type/i);
  });

  test("lists readiness evaluations filtered by result", () => {
    const failList = Readiness.listReadinessEvaluations(db, { tenantId: tenant, overall_result: "FAIL" });
    assert.ok(failList.items.every((entry) => entry.overall_result === "FAIL"));
    assert.ok(failList.total >= 1);
  });

  test("does not leak another tenant's records", () => {
    const other = ensureOrganization(db, "mq-isolated");
    const otherProduct = insertForeignObject(db, other, "MQ-ISO-PART");
    Quality.createQualityIssue(db, other, { title: "Other tenant", code: "MQ-ISO-QI", product_object_id: otherProduct.id }, actor, IP);
    const isolated = Quality.listQualityIssues(db, { tenantId: other });
    assert.equal(isolated.total, 1);
    const mine = Quality.listQualityIssues(db, { tenantId: tenant, q: "MQ-ISO" });
    assert.equal(mine.total, 0);
    assert.equal(Quality.getIssueRow(db, tenant, "MQ-ISO-QI"), null);
    assert.equal(Quality.getQualityIssue(db, tenant, "MQ-ISO-QI"), null);
    assert.throws(() => Quality.requireIssueRow(db, tenant, "MQ-ISO-QI"), /not found/i);
  });

  test("resolves subjects through the owning module", () => {
    assert.throws(() => Subjects.resolveSubject(db, tenant, "PRODUCT_REVISION", 999999), /subject not found/i);
    const resolved = Subjects.resolveSubject(db, tenant, "PRODUCT_REVISION", product.id);
    assert.equal(resolved.subject_type, "PRODUCT_REVISION");
    assert.equal(resolved.row.id, product.id);
  });
});

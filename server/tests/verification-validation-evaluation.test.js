process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { ensureClassificationUnits, listUnits } from "../services/classification/units.js";
import { ensureRequirementsFoundation } from "../services/requirements/index.js";
import { createContent } from "../services/content.js";
import { TestCases, TestExecutions, TestResults, Evidence, Foundation, Evaluation } from "../services/verification-validation/index.js";

const IP = "127.0.0.1";

const { evaluateCriteria } = Evaluation;

describe("Verification & Validation acceptance-criteria evaluation", () => {
  test("evaluates exact, tolerance and ordered numeric comparisons", () => {
    assert.equal(evaluateCriteria({ operator: "eq", value: 10 }, "10").outcome, "PASS");
    assert.equal(evaluateCriteria({ operator: "eq", value: 10 }, "11").outcome, "FAIL");
    assert.equal(evaluateCriteria({ operator: "eq", value: 10, tolerance: 0.5 }, "10.4").outcome, "PASS");
    assert.equal(evaluateCriteria({ operator: "lte", value: 40 }, "38").outcome, "PASS");
    assert.equal(evaluateCriteria({ operator: "gte", value: 40 }, "38").outcome, "FAIL");
    assert.equal(evaluateCriteria({ operator: "gt", value: 40 }, "40").outcome, "FAIL");
  });

  test("evaluates inclusive and exclusive ranges", () => {
    assert.equal(evaluateCriteria({ min: 10, max: 20 }, "20").outcome, "PASS");
    assert.equal(evaluateCriteria({ operator: "between", min: 10, max: 20, maxInclusive: false }, "20").outcome, "FAIL");
    assert.equal(evaluateCriteria({ operator: "between", min: 10, max: 20, minInclusive: false }, "10").outcome, "FAIL");
    assert.equal(evaluateCriteria({ operator: "between", min: 10, max: 20 }, "15").outcome, "PASS");
  });

  test("evaluates categorical allowed-value sets and expected outcomes", () => {
    assert.equal(evaluateCriteria({ allowed: ["PASS", "OK"] }, "OK").outcome, "PASS");
    assert.equal(evaluateCriteria({ operator: "not_in", values: ["FAIL"] }, "OK").outcome, "PASS");
    assert.equal(evaluateCriteria({ expected_outcome: "COMPLETE" }, "complete").outcome, "PASS");
    assert.equal(evaluateCriteria({ expected_outcome: "COMPLETE" }, "INCOMPLETE").outcome, "FAIL");
  });

  test("evaluates booleans, step completion and text matching", () => {
    assert.equal(evaluateCriteria({ operator: "boolean", expected: true }, "yes").outcome, "PASS");
    assert.equal(evaluateCriteria({ operator: "boolean", expected: false }, "yes").outcome, "FAIL");
    assert.equal(evaluateCriteria({ operator: "step_complete" }, "true").outcome, "PASS");
    assert.equal(evaluateCriteria({ operator: "step_complete" }, "").outcome, "NOT_EVALUABLE");
    assert.equal(evaluateCriteria({ operator: "matches", regex: "^TC-\\d+$" }, "TC-42").outcome, "PASS");
    assert.equal(evaluateCriteria({ operator: "contains", substring: "ok" }, "status ok").outcome, "PASS");
  });

  test("evaluates logical combinations", () => {
    assert.equal(evaluateCriteria({ all: [{ operator: "gte", value: 10 }, { operator: "lte", value: 100 }] }, "50").outcome, "PASS");
    assert.equal(evaluateCriteria({ all: [{ operator: "gte", value: 10 }, { operator: "lte", value: 100 }] }, "150").outcome, "FAIL");
    assert.equal(evaluateCriteria({ any: [{ operator: "eq", value: 1 }, { operator: "eq", value: 2 }] }, "2").outcome, "PASS");
    assert.equal(evaluateCriteria({ not: { operator: "eq", value: 1 } }, "2").outcome, "PASS");
    assert.equal(evaluateCriteria({ any: [{ operator: "gte", value: 10 }, { operator: "lte", value: 5 }] }, "7").outcome, "FAIL");
  });

  test("never returns PASS for a missing measurement", () => {
    assert.equal(evaluateCriteria({ operator: "lte", value: 40 }, null).outcome, "NOT_EVALUABLE");
    assert.equal(evaluateCriteria({ operator: "lte", value: 40 }, "").outcome, "NOT_EVALUABLE");
    assert.equal(evaluateCriteria({}, "38").outcome, "NOT_EVALUABLE");
    assert.equal(evaluateCriteria({ operator: "unknown_op", value: 1 }, "1").outcome, "NOT_EVALUABLE");
  });

  test("converts units before comparison and rejects incompatible units", () => {
    const units = [
      { code: "MM", uom_class: "length", base_unit: "M", factor: 0.001, offset: 0 },
      { code: "M", uom_class: "length", base_unit: "M", factor: 1, offset: 0 },
      { code: "KG", uom_class: "mass", base_unit: "KG", factor: 1, offset: 0 },
    ];
    assert.equal(evaluateCriteria({ operator: "lte", value: 45, unit: "MM" }, "0.038", undefined, { actualUnit: "M", units }).outcome, "PASS");
    assert.equal(evaluateCriteria({ operator: "lte", value: 30, unit: "MM" }, "0.038", undefined, { actualUnit: "M", units }).outcome, "FAIL");
    assert.equal(evaluateCriteria({ operator: "lte", value: 45, unit: "KG" }, "0.038", undefined, { actualUnit: "M", units }).outcome, "NOT_EVALUABLE");
  });

  describe("integration with recorded results", () => {
    let db;
    let tenant;
    let actor;
    let contentId;

    before(async () => {
      db = openTestDatabase();
      migrate(db);
      seedDatabase(db);
      ensureRequirementsFoundation(db);
      Foundation.ensureVvFoundation(db);
      ensureClassificationUnits(db);
      tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
      actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
      TestCases.createTestCase(db, tenant, { code: "VV-TC-EVAL", name: "Evaluation case", method_code: "MEASUREMENT" }, actor, IP);
      TestCases.transitionTestCase(db, tenant, "VV-TC-EVAL", "IN_REVIEW", { actor, ip: IP });
      TestCases.transitionTestCase(db, tenant, "VV-TC-EVAL", "APPROVED", { actor, ip: IP });
      const content = await createContent(db, { fileName: "evidence.txt", mimeType: "text/plain", buffer: Buffer.from("evidence") }, { tenantId: tenant, actor, process: false });
      contentId = content.id;
    });

    after(() => db?.close());

    test("evaluates a recorded measurement across units and stores the rule", () => {
      const execution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-EVAL" }, actor, IP);
      TestExecutions.startExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
      const result = TestResults.recordResult(db, tenant, execution.execution_ref, { result_level: "MEASUREMENT", actual_value: "0.038", unit: "M", acceptance_criteria: { operator: "lte", value: 45, unit: "MM" } }, actor, IP);
      Evidence.attachEvidence(db, tenant, { result_ref: result.result_ref, content_id: contentId }, actor, IP);
      const evaluated = TestResults.evaluateResult(db, tenant, result.result_ref, {}, actor, IP);
      assert.equal(evaluated.result.outcome, "PASS");
      assert.equal(evaluated.result.evaluation_version, 2);
      assert.equal(evaluated.result.evaluation_rule.actual_unit, "M");

      const units = listUnits(db, { tenantId: tenant });
      assert.ok(units.some((u) => u.code === "MM"));
    });
  });
});

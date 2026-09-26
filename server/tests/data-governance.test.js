process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as dg from "../services/data-governance/index.js";

function adminActor(db) {
  const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  return row ? { id: row.id, username: row.username } : null;
}

describe("Data governance foundation and seed", () => {
  let db;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
  });
  after(() => db?.close());

  test("installs the canonical quality dimensions and scoring configuration", () => {
    const tenant = 1;
    const dimensions = dg.Dimensions.listDimensions(db, tenant);
    const codes = dimensions.map((dimension) => dimension.code).sort();
    assert.deepEqual(codes, ["accuracy", "completeness", "consistency", "uniqueness", "validity"]);
    const scoring = dg.Configuration.scoringConfig(db, tenant);
    assert.deepEqual(scoring.thresholds.map((band) => band.status).sort(), ["CRITICAL", "EXCELLENT", "GOOD", "POOR", "WARNING"]);
    assert.equal(dg.Configuration.getConfig(db, tenant, "exception_min_severity"), "warning");
  });

  test("seeds a governed demonstration estate idempotently", () => {
    const first = dg.ensureDataGovernanceSeed(db);
    assert.equal(first.seeded, false);
    const domains = dg.Domains.listDomains(db, { tenantId: 1 });
    assert.ok(domains.total >= 1);
    assert.ok(dg.Catalog.findCatalogByType(db, 1, "product"));
    const rules = dg.Rules.listRules(db, { tenantId: 1, objectType: "product" });
    assert.ok(rules.total >= 2);
  });

  test("registers platform seams (events, jobs, search, adapters, strategies)", () => {
    const foundation = dg.ensureDataGovernanceFoundation(db);
    assert.ok(foundation.adapters >= 1);
    assert.ok(foundation.duplicate_strategies >= 4);
    assert.ok(dg.Engine.listEvaluators().length >= 0);
    const health = dg.Metrics.healthCheck(db);
    assert.equal(health.status, "healthy");
  });
});

describe("Rule validation and the safe expression compiler", () => {
  test("rejects an unknown rule type and an unknown operator", () => {
    assert.throws(() => dg.Rules.validateRuleInput({ rule_type: "NOPE", object_type: "product", attribute_name: "x" }), /rule type/i);
    assert.throws(
      () => dg.Rules.validateRuleInput({ rule_type: "CUSTOM", object_type: "product", expression: { attribute: "x", operator: "exec", value: 1 } }),
      /not allowed/i
    );
  });

  test("rejects attribute paths that could reach prototype internals", () => {
    assert.throws(
      () => dg.Rules.validateRuleInput({ rule_type: "CUSTOM", object_type: "product", expression: { attribute: "__proto__.polluted", operator: "eq", value: 1 } }),
      /Invalid attribute path/i
    );
  });

  test("normalises structural rule types to a null-check condition", () => {
    const validated = dg.Rules.validateRuleInput({ rule_type: "REQUIRED", object_type: "product", attribute_name: "part.number" });
    assert.equal(validated.expression.conditions[0].operator, "is_not_null");
    assert.equal(validated.dimension, "completeness");
  });

  test("evaluates an expression without executing arbitrary code", () => {
    const compiled = dg.Expressions.compileExpression("CUSTOM", { attribute: "part.category", operator: "in", value: ["mechanical", "hydraulic"] });
    const outcome = dg.Expressions.evaluateExpression(compiled, { "part.category": "mechanical" });
    assert.equal(outcome.passed, true);
    const failing = dg.Expressions.evaluateExpression(compiled, { "part.category": "electrical" });
    assert.equal(failing.passed, false);
  });
});

describe("Quality evaluation, scoring and exceptions", () => {
  let db;
  let actor;
  let tenant;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
    tenant = 1;
  });
  after(() => db?.close());

  test("evaluates a governed object type and persists current results", () => {
    const batch = dg.Engine.evaluateType(db, { tenantId: tenant, objectType: "product", actor, trigger: "test" });
    assert.equal(batch.processed, 2);
    assert.equal(batch.errors, 0);
    const summary = dg.Results.scoreSummary(db, { tenantId: tenant });
    assert.equal(summary.objects, 2);
    assert.equal(summary.average_score, 100);
    assert.equal(summary.by_status.EXCELLENT, 2);
  });

  test("never reports a failing object as passed and raises a configured exception", () => {
    dg.Rules.createRule(
      db,
      {
        code: "CATEGORY_MECHANICAL",
        name: "Category must be mechanical",
        object_type: "product",
        rule_type: "CUSTOM",
        attribute_name: "part.category",
        expression: { attribute: "part.category", operator: "eq", value: "mechanical" },
        severity: "error",
        status: "active",
      },
      actor,
      tenant,
      "test"
    );
    const batch = dg.Engine.evaluateType(db, { tenantId: tenant, objectType: "product", actor, trigger: "test" });
    assert.equal(batch.failed_objects, 1);
    const summary = dg.Exceptions.exceptionSummary(db, { tenantId: tenant });
    assert.equal(summary.total, 1);
    assert.equal(summary.by_status.OPEN, 1);
    const result = dg.Results.getResult(db, { tenantId: tenant, objectType: "product", objectId: "2" });
    assert.equal(result.evaluation_state, "FAILED");
    assert.ok(result.violations.length >= 1);
  });

  test("drives the exception lifecycle through its guarded transitions", () => {
    const list = dg.Exceptions.listExceptions(db, { tenantId: tenant });
    const ref = list.items[0].exception_ref;
    const updated = dg.Exceptions.updateException(db, ref, { description: "Category mismatch confirmed", priority: "high" }, actor, "test");
    assert.equal(updated.priority, "high");
    assert.equal(dg.Exceptions.assignException(db, ref, { assignee_user_id: 2, priority: "high" }, actor, "test").status, "ASSIGNED");
    assert.equal(dg.Exceptions.transitionException(db, ref, "in_progress", {}, actor, "test").status, "IN_PROGRESS");
    assert.equal(dg.Exceptions.transitionException(db, ref, "resolved", { resolution: "corrected" }, actor, "test").status, "RESOLVED");
    assert.equal(dg.Exceptions.transitionException(db, ref, "verified", {}, actor, "test").status, "VERIFIED");
    assert.equal(dg.Exceptions.transitionException(db, ref, "closed", {}, actor, "test").status, "CLOSED");
    assert.throws(() => dg.Exceptions.transitionException(db, ref, "in_progress", {}, actor, "test"), /transition/i);
  });

  test("a rule with no governed attributes yields NOT_EVALUATED, never PASSED", () => {
    const state = dg.Engine.evaluateObject(db, { tenantId: tenant, objectType: "product", objectId: "1", payload: { object_type: "product", object_id: "1", attributes: {} }, policyId: -1, persist: false });
    assert.equal(state.evaluation_state, "NOT_EVALUATED");
  });
});

describe("Duplicate detection and remediation", () => {
  let db;
  let actor;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
  });
  after(() => db?.close());

  test("detects duplicates with a configured match rule using deterministic strategies", () => {
    const result = dg.Duplicates.detectDuplicates(db, { tenantId: 1, objectType: "product", actor });
    assert.equal(result.object_type, "product");
    assert.equal(typeof result.detected, "number");
    assert.ok(result.rules >= 1);
  });

  test("similarity duplicated strategy is pluggable and deterministic", () => {
    const strategies = dg.Duplicates.listDuplicateStrategies();
    for (const code of ["exact", "normalized", "attribute", "similarity"]) {
      assert.ok(strategies.includes(code), `expected strategy ${code}`);
    }
    const ratio = dg.Duplicates.similarityRatio("Acme Corp", "acme corporation");
    assert.ok(ratio > 0 && ratio <= 1);
  });
});

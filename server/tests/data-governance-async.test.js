process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as dg from "../services/data-governance/index.js";

function adminActor(db) {
  const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  return row ? { id: row.id, username: row.username } : null;
}

describe("data-governance async twins mirror the sync layer", () => {
  let db;
  let actor;
  const tenant = 1;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
    dg.ensureDataGovernanceSeed(db);
  });

  after(() => db?.close());

  test("dimensions and configuration read and write asynchronously", async () => {
    const dimensions = await dg.Dimensions.listDimensionsAsync(db, tenant);
    assert.deepEqual(
      dimensions.map((dimension) => dimension.code).sort(),
      ["accuracy", "completeness", "consistency", "uniqueness", "validity"]
    );

    await assert.rejects(() => dg.Configuration.setConfigAsync(db, tenant, "duplicate_threshold", 2), /between 0 and 1/i);
    const value = await dg.Configuration.setConfigAsync(db, tenant, "duplicate_threshold", 0.9);
    assert.equal(Number(value), 0.9);
    assert.equal(Number(await dg.Configuration.getConfigAsync(db, tenant, "duplicate_threshold")), 0.9);
    assert.equal(Number((await dg.Configuration.listConfigAsync(db, tenant)).duplicate_threshold), 0.9);

    const scoring = await dg.Configuration.scoringConfigAsync(db, tenant);
    assert.deepEqual(scoring.thresholds.map((band) => band.status).sort(), ["CRITICAL", "EXCELLENT", "GOOD", "POOR", "WARNING"]);
  });

  test("domains create, read, tree, update and delete asynchronously", async () => {
    const created = await dg.Domains.createDomainAsync(db, { code: "ASYNC_DOMAIN", name: "Async Domain", category: "master" }, actor, tenant);
    assert.equal(created.code, "ASYNC_DOMAIN");

    const fetched = await dg.Domains.getDomainAsync(db, "ASYNC_DOMAIN");
    assert.equal(fetched.code, "ASYNC_DOMAIN");

    const row = await dg.Domains.requireDomainAsync(db, "ASYNC_DOMAIN");
    const crumb = await dg.Domains.breadcrumbAsync(db, row);
    assert.ok(Array.isArray(crumb));

    const list = await dg.Domains.listDomainsAsync(db, { tenantId: tenant, q: "async" });
    assert.ok(list.items.some((domain) => domain.code === "ASYNC_DOMAIN"));

    const tree = await dg.Domains.domainTreeAsync(db, { tenantId: tenant });
    assert.ok(Array.isArray(tree));

    const updated = await dg.Domains.updateDomainAsync(db, "ASYNC_DOMAIN", { name: "Async Domain v2" }, actor);
    assert.equal(updated.name, "Async Domain v2");

    const suspended = await dg.Domains.setDomainStatusAsync(db, "ASYNC_DOMAIN", "inactive", actor);
    assert.equal(suspended.status, "inactive");

    const throwaway = await dg.Domains.createDomainAsync(db, { code: "ASYNC_DOMAIN_TMP", name: "Temp" }, actor, tenant);
    const removed = await dg.Domains.deleteDomainAsync(db, "ASYNC_DOMAIN_TMP", actor);
    assert.equal(removed.deleted ?? true, true);
    assert.ok(throwaway.id);
  });

  test("ownership assigns and resolves asynchronously", async () => {
    const domain = await dg.Domains.requireDomainAsync(db, "ASYNC_DOMAIN");
    const assignment = await dg.Ownership.createOwnershipAsync(
      db,
      { scope_type: "domain", domain_id: domain.id, relationship: "owner", subject_type: "user", subject_id: actor.id },
      actor,
      tenant
    );
    assert.equal(assignment.relationship, "owner");

    const list = await dg.Ownership.listOwnershipAsync(db, { tenantId: tenant, domainId: domain.id, relationship: "owner" });
    assert.ok(list.items.some((item) => item.id === assignment.id || item.subject_id === actor.id));

    const resolved = await dg.Ownership.resolveOwnershipAsync(db, { tenantId: tenant, domainId: domain.id, relationship: "owner" });
    assert.ok(Array.isArray(resolved));
    assert.ok(resolved.length >= 1);
  });

  test("catalogue registers objects and attributes asynchronously", async () => {
    const created = await dg.Catalog.registerCatalogObjectAsync(db, { object_type: "async_widget", name: "Async Widget" }, actor, tenant);
    assert.equal(created.object_type, "async_widget");

    assert.ok(await dg.Catalog.findCatalogByTypeAsync(db, tenant, "async_widget"));
    assert.equal(await dg.Catalog.hasGovernedTypeAsync(db, tenant, "async_widget"), true);

    const attribute = await dg.Catalog.registerAttributeAsync(db, created.id, { attribute_name: "serial", label: "Serial", data_type: "string" }, actor);
    assert.equal(attribute.attribute_name, "serial");

    const attributes = await dg.Catalog.listAttributesAsync(db, created.id);
    assert.ok(attributes.some((item) => item.attribute_name === "serial"));

    const fetched = await dg.Catalog.getCatalogAsync(db, created.id, { includeAttributes: true });
    assert.equal(fetched.object_type, "async_widget");

    const listed = await dg.Catalog.listCatalogAsync(db, { tenantId: tenant, q: "async" });
    assert.ok(listed.items.some((item) => item.object_type === "async_widget"));
  });

  test("policies create, version and transition asynchronously", async () => {
    const domain = await dg.Domains.requireDomainAsync(db, "ASYNC_DOMAIN");
    const policy = await dg.Policies.createPolicyAsync(
      db,
      {
        code: "ASYNC_POLICY",
        name: "Async policy",
        object_type: "async_widget",
        domain_id: domain.id,
        severity: "warning",
        status: "draft",
        rule_set: [{ code: "ASYNC_HAS_SERIAL", rule_type: "REQUIRED", attribute_name: "serial", severity: "warning" }],
      },
      actor,
      tenant
    );
    assert.equal(policy.code, "ASYNC_POLICY");

    const fetched = await dg.Policies.getPolicyAsync(db, "ASYNC_POLICY", { includeVersions: true });
    assert.equal(fetched.code, "ASYNC_POLICY");

    const updated = await dg.Policies.updatePolicyAsync(db, "ASYNC_POLICY", { name: "Async policy v2" }, actor);
    assert.equal(updated.name, "Async policy v2");
    const versions = await dg.Policies.listPolicyVersionsAsync(db, "ASYNC_POLICY");
    assert.ok((versions.items ?? versions).length >= 1);

    const activated = await dg.Policies.setPolicyStatusAsync(db, "ASYNC_POLICY", "active", actor);
    assert.equal(activated.status, "active");

    const listed = await dg.Policies.listPoliciesAsync(db, { tenantId: tenant, objectType: "async_widget" });
    assert.ok(listed.items.some((item) => item.code === "ASYNC_POLICY"));
  });

  test("rules are created and resolved asynchronously", async () => {
    const rule = await dg.Rules.createRuleAsync(
      db,
      {
        code: "ASYNC_RULE",
        name: "Serial required",
        object_type: "async_widget",
        rule_type: "CUSTOM",
        attribute_name: "serial",
        expression: { attribute: "serial", operator: "eq", value: "x" },
        severity: "error",
        status: "active",
      },
      actor,
      tenant
    );
    assert.equal(rule.code, "ASYNC_RULE");

    const fetched = await dg.Rules.getRuleAsync(db, "ASYNC_RULE");
    assert.equal(fetched.code, "ASYNC_RULE");

    const active = await dg.Rules.activeRulesForObjectAsync(db, tenant, "async_widget");
    assert.ok(active.some((item) => item.code === "ASYNC_RULE"));
  });

  test("quality evaluation, results and scoring run asynchronously", async () => {
    const batch = await dg.Engine.evaluateTypeAsync(db, { tenantId: tenant, objectType: "product", actor, trigger: "async-test" });
    assert.ok(batch.processed >= 2);
    assert.equal(batch.errors, 0);

    const summary = await dg.Results.scoreSummaryAsync(db, { tenantId: tenant });
    assert.ok(summary.objects >= 2);

    const result = await dg.Results.getResultAsync(db, { tenantId: tenant, objectType: "product", objectId: "1" });
    assert.ok(result.object_type ? result.object_type === "product" : result.evaluation_state);

    const history = await dg.Results.objectHistoryAsync(db, { tenantId: tenant, objectType: "product", objectId: "1" });
    assert.ok((history.items ?? history).length >= 1);

    const scores = await dg.Results.typeScoresAsync(db, { tenantId: tenant, objectType: "product" });
    assert.ok(Array.isArray(scores));

    const trend = await dg.Results.trendAsync(db, { tenantId: tenant, objectType: "product", days: 30 });
    assert.ok(Array.isArray(trend));
  });

  test("exceptions are raised and driven through guarded transitions asynchronously", async () => {
    await dg.Rules.createRuleAsync(
      db,
      {
        code: "ASYNC_CATEGORY_MECHANICAL",
        name: "Category must be mechanical",
        object_type: "product",
        rule_type: "CUSTOM",
        attribute_name: "part.category",
        expression: { attribute: "part.category", operator: "eq", value: "mechanical" },
        severity: "error",
        status: "active",
      },
      actor,
      tenant
    );
    const batch = await dg.Engine.evaluateTypeAsync(db, { tenantId: tenant, objectType: "product", actor, trigger: "async-test" });
    assert.ok(batch.failed_objects >= 1);

    const summary = await dg.Exceptions.exceptionSummaryAsync(db, { tenantId: tenant });
    assert.ok(summary.total >= 1);

    const list = await dg.Exceptions.listExceptionsAsync(db, { tenantId: tenant });
    const ref = list.items[0].exception_ref;
    const assigned = await dg.Exceptions.assignExceptionAsync(db, ref, { assignee_user_id: actor.id, priority: "high" }, actor);
    assert.equal(assigned.status, "ASSIGNED");
    assert.equal((await dg.Exceptions.transitionExceptionAsync(db, ref, "in_progress", {}, actor)).status, "IN_PROGRESS");
    assert.equal((await dg.Exceptions.transitionExceptionAsync(db, ref, "resolved", { resolution: "corrected" }, actor)).status, "RESOLVED");
    assert.equal((await dg.Exceptions.transitionExceptionAsync(db, ref, "verified", {}, actor)).status, "VERIFIED");
    assert.equal((await dg.Exceptions.transitionExceptionAsync(db, ref, "closed", {}, actor)).status, "CLOSED");
    await assert.rejects(() => dg.Exceptions.transitionExceptionAsync(db, ref, "in_progress", {}, actor), /transition/i);
  });

  test("duplicate detection and remediation run asynchronously", async () => {
    const rules = await dg.Duplicates.listMatchRulesAsync(db, { tenantId: tenant, objectType: "product" });
    assert.ok(rules.length >= 1);

    const detected = await dg.Duplicates.detectDuplicatesAsync(db, { tenantId: tenant, objectType: "product", actor });
    assert.equal(detected.object_type, "product");
    assert.equal(typeof detected.detected, "number");

    const candidates = await dg.Duplicates.listCandidatesAsync(db, { tenantId: tenant, objectType: "product" });
    assert.ok(candidates.items !== undefined || Array.isArray(candidates));

    const summary = await dg.Duplicates.duplicateSummaryAsync(db, { tenantId: tenant });
    assert.equal(typeof summary, "object");

    const remediation = await dg.Remediation.remediationSummaryAsync(db, { tenantId: tenant });
    assert.equal(typeof remediation, "object");
  });

  test("metrics, health and foundation mirror the sync layer", async () => {
    assert.equal((await dg.Metrics.healthCheckAsync(db, { tenantId: tenant })).status, dg.Metrics.healthCheck(db, { tenantId: tenant }).status);
    const asyncMetrics = await dg.Metrics.metricsSnapshotAsync(db, { tenantId: tenant });
    const syncMetrics = dg.Metrics.metricsSnapshot(db, { tenantId: tenant });
    assert.deepEqual(asyncMetrics.counters, syncMetrics.counters);

    const asyncHealth = await dg.Foundation.dataGovernanceHealthAsync(db);
    assert.deepEqual(asyncHealth.counts, dg.Foundation.dataGovernanceHealth(db).counts);
  });

  test("quality jobs submit and list asynchronously", async () => {
    const submitted = await dg.Jobs.submitBatchEvaluationAsync(db, { tenantId: tenant, objectTypes: ["product"], actor });
    assert.ok(submitted.job);
    assert.ok(submitted.tracking_id);

    const duplicateScan = await dg.Jobs.submitDuplicateScanAsync(db, { tenantId: tenant, objectType: "product", actor });
    assert.ok(duplicateScan.job);

    const listed = await dg.Jobs.listQualityJobsAsync(db, { tenantId: tenant });
    assert.ok(Array.isArray(listed));
    assert.ok(listed.length >= 1);
  });
});

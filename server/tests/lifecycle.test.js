import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as lifecycle from "../services/lifecycle.js";

// Service-level coverage for the lifecycle configuration model, the transition
// engine and the release/approval evaluator. These run against the same seeded
// fixtures the API layer uses.

describe("lifecycle management services", () => {
  let db;
  let actor;
  let tenantId;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
  });

  test("seed publishes a product lifecycle and assigns it to product objects", () => {
    const statuses = lifecycle.listStatuses(db, {}, tenantId);
    assert.equal(statuses.total, 6);
    assert.ok(statuses.items.some((s) => s.code === "released" && s.category === "released"));

    const definition = lifecycle.getDefinition(db, "product-lifecycle", tenantId);
    assert.equal(definition.status, "published");
    assert.equal(definition.published_version, 1);

    const graph = lifecycle.validateDefinition(db, "product-lifecycle", tenantId, {});
    assert.equal(graph.valid, true);
    assert.equal(graph.state_count, 6);
    assert.equal(graph.transition_count, 6);

    const view = lifecycle.objectLifecycle(db, "PROD-1000", tenantId);
    assert.equal(view.state.code, "draft");
    assert.equal(view.status.category, "draft");
    assert.ok(view.transitions.some((t) => t.code === "submit"));
  });

  test("published versions are immutable configuration", () => {
    const versions = lifecycle.listVersions(db, "product-lifecycle", tenantId);
    const published = versions.items.find((v) => v.status === "published");
    assert.throws(
      () =>
        lifecycle.createState(
          db,
          { code: "extra", name: "Extra", lifecycle_version_id: published.id, tenant_id: tenantId },
          actor,
          "test",
          tenantId
        ),
      (err) => err.status === 409
    );
  });

  test("rejects lifecycle versions whose graph cannot terminate", () => {
    const created = lifecycle.createDefinition(
      db,
      { code: "loop-lifecycle", name: "Loop", tenant_id: tenantId },
      actor,
      "test",
      tenantId
    );
    const versionId = created.version.id;
    lifecycle.createState(db, { code: "alpha", name: "Alpha", lifecycle_version_id: versionId, is_initial: true, tenant_id: tenantId }, actor, "test", tenantId);
    lifecycle.createState(db, { code: "beta", name: "Beta", lifecycle_version_id: versionId, tenant_id: tenantId }, actor, "test", tenantId);
    lifecycle.createTransition(db, { code: "ab-step", name: "AB", lifecycle_version_id: versionId, from_state: "alpha", to_state: "beta", tenant_id: tenantId }, actor, "test", tenantId);
    lifecycle.createTransition(db, { code: "ba-step", name: "BA", lifecycle_version_id: versionId, from_state: "beta", to_state: "alpha", tenant_id: tenantId }, actor, "test", tenantId);

    const report = lifecycle.validateDefinition(db, "loop-lifecycle", tenantId, {});
    assert.equal(report.valid, false);
    assert.ok(report.errors.length > 0);
    assert.throws(
      () => lifecycle.publishDefinition(db, "loop-lifecycle", {}, actor, "test", tenantId),
      (err) => err.status === 422
    );
  });

  test("transitions gated by approval resolve approvers, auto-transition and audit", () => {
    const submitted = lifecycle.transitionObject(db, "PROD-1000", { transition: "submit" }, actor, tenantId, "test");
    assert.equal(submitted.gated, false);
    assert.equal(submitted.state.code, "in-review");

    const gated = lifecycle.transitionObject(db, "PROD-1000", { transition: "approve" }, actor, tenantId, "test");
    assert.equal(gated.gated, true);
    assert.equal(gated.release.status, "pending");
    assert.equal(gated.release.approvals.length, 1);
    assert.equal(gated.release.approvals[0].approver_id, actor.id);

    const decided = lifecycle.decideApproval(
      db,
      "PROD-1000",
      gated.release.approvals[0].id,
      { decision: "approve", comment: "Looks good" },
      actor,
      tenantId,
      "test"
    );
    assert.equal(decided.status, "approved");

    const after = lifecycle.objectLifecycle(db, "PROD-1000", tenantId);
    assert.equal(after.state.code, "approved");

    const history = lifecycle.statusHistory(db, "PROD-1000", tenantId, {});
    assert.ok(history.total >= 3);
    assert.equal(history.items[0].to_state_code, "approved");
  });

  test("reject requires a comment when the rule mandates it", () => {
    lifecycle.transitionObject(db, "PROD-2000", { transition: "submit" }, actor, tenantId, "test");
    const gated = lifecycle.transitionObject(db, "PROD-2000", { transition: "approve" }, actor, tenantId, "test");
    const approvalId = gated.release.approvals[0].id;
    assert.throws(
      () => lifecycle.decideApproval(db, "PROD-2000", approvalId, { decision: "reject" }, actor, tenantId, "test"),
      (err) => err.status === 400
    );
    const rejected = lifecycle.decideApproval(
      db,
      "PROD-2000",
      approvalId,
      { decision: "reject", comment: "Missing tolerance data" },
      actor,
      tenantId,
      "test"
    );
    assert.equal(rejected.status, "rejected");
    assert.equal(lifecycle.objectLifecycle(db, "PROD-2000", tenantId).state.code, "draft");
  });
});

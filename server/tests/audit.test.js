import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, queryAll, run } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as audit from "../services/audit.js";

// Service-level coverage for the Audit & History Framework: rich capture,
// helper policy resolution and evaluation, before/after diffs, masking,
// immutability, querying, export and retention/archival.

describe("audit framework services", () => {
  let db;
  let actor;
  let tenantId;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = queryOne(db, "SELECT id, username, display_name FROM users WHERE username = 'admin'");
    actor.tenant_id = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    tenantId = actor.tenant_id;
  });

  test("captures a rich event with context, changes and derived type", () => {
    const result = audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "object.update",
      object_type: "part",
      object_id: "PART-TEST-1",
      object_name: "Test bracket",
      before: { "part.weight_kg": 1.0, "part.notes": null },
      after: { "part.weight_kg": 1.5, "part.notes": "tighter" },
      reason: "eco",
      source: "ui",
      ip: "10.0.0.1",
      correlation_id: "corr-1",
      request_id: "req-1",
    });
    assert.ok(result.id);
    assert.equal(result.event_type, "UPDATE");

    const event = audit.getEvent(db, result.id, { scopeAll: true });
    assert.equal(event.actor_username, "admin");
    assert.equal(event.user_display_name, actor.display_name);
    assert.equal(event.object_type, "part");
    assert.equal(event.object_id, "PART-TEST-1");
    assert.equal(event.source, "ui");
    assert.equal(event.reason, "eco");
    assert.equal(event.correlation_id, "corr-1");
    assert.deepEqual(event.changed_fields, ["part.notes", "part.weight_kg"]);
    assert.equal(event.before_values["part.weight_kg"], 1);
    assert.equal(event.after_values["part.weight_kg"], 1.5);
    assert.equal(event.changes.length, 2);
    assert.equal(event.changes.find((c) => c.attribute === "part.notes").new_value, "tighter");
  });

  test("never stores secrets, even without an explicit mask policy", () => {
    const result = audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "object.update",
      object_type: "user",
      object_id: "42",
      before: { password: "hunter2", api_token: "abc" },
      after: { password: "hunter3", api_token: "def", display_name: "Jane" },
    });
    const event = audit.getEvent(db, result.id, { scopeAll: true });
    assert.equal(event.after_values.password, "***");
    assert.equal(event.after_values.api_token, "***");
    assert.equal(event.after_values.display_name, "Jane");
    assert.equal(event.changes.find((c) => c.attribute === "password").masked, true);
  });

  test("links parent and correlation ids for cascading operations", () => {
    const parent = audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "object.create",
      object_type: "part",
      object_id: "PART-PARENT",
      correlation_id: "cascade-1",
    });
    const child = audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "relationship.create",
      object_type: "part",
      object_id: "PART-PARENT",
      parent_event_id: parent.id,
      correlation_id: "cascade-1",
    });
    const children = audit.listEvents(db, { parentEventId: parent.id }, { scopeAll: true });
    assert.equal(children.total, 1);
    assert.equal(children.items[0].id, child.id);
    const correlated = audit.listEvents(db, { correlationId: "cascade-1" }, { scopeAll: true });
    assert.equal(correlated.total, 2);
  });

  test("resolves policies from tenant-specific to system wildcard", () => {
    const seededPart = audit
      .listPolicies(db, { tenantId, includeSystem: false })
      .items.find((p) => p.object_type === "part");
    assert.ok(seededPart, "seed creates a tenant override for part");
    assert.equal(seededPart.visibility, "user");

    const tenantWildcard = audit.createPolicy(
      db,
      { tenant_id: tenantId, object_type: "*", name: "Tenant default", visibility: "manager" },
      actor,
      tenantId
    );

    const part = audit.resolvePolicy(db, tenantId, "part");
    assert.equal(part.scope, "tenant");
    assert.equal(part.policy.visibility, "user");
    assert.equal(part.policy.capture_views, true);
    assert.ok(part.policy.track_attributes.includes("part.name"));

    const other = audit.resolvePolicy(db, tenantId, "document");
    assert.equal(other.scope, "tenant");
    assert.equal(other.policy.visibility, "manager");

    const system = audit.resolvePolicy(db, null, "document");
    assert.equal(system.scope, "system");

    audit.deletePolicy(db, tenantWildcard.id);
    // With the tenant wildcard gone, unknown types fall back to the system
    // policy while the explicit part override still wins.
    assert.equal(audit.resolvePolicy(db, tenantId, "unknown-type").scope, "system");
    assert.equal(audit.resolvePolicy(db, tenantId, "part").scope, "tenant");
  });

  test("applies policy action allow-lists and read/view suppression", () => {
    const policy = audit.createPolicy(
      db,
      {
        tenant_id: tenantId,
        object_type: "policy-scoped",
        name: "Scoped",
        actions: ["CREATE", "UPDATE"],
        capture_views: false,
        record_failure: false,
      },
      actor,
      tenantId
    );
    const created = audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "object.create",
      object_type: "policy-scoped",
      object_id: "X1",
    });
    assert.ok(created, "allowed action is recorded");
    const viewed = audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "object.view",
      object_type: "policy-scoped",
      object_id: "X1",
    });
    assert.equal(viewed, null, "views suppressed by policy");
    const deleted = audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "object.delete",
      object_type: "policy-scoped",
      object_id: "X1",
    });
    assert.equal(deleted, null, "action outside the allow-list is dropped");
    const failed = audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "object.update",
      object_type: "policy-scoped",
      object_id: "X1",
      status: "failure",
    });
    assert.equal(failed, null, "failures suppressed by policy");
    audit.deletePolicy(db, policy.id);
  });

  test("audit records are immutable through normal data access", () => {
    const event = audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "object.create",
      object_type: "part",
      object_id: "IMMUTABLE-1",
    });
    assert.throws(
      () => run(db, "UPDATE audit_logs SET action = 'tampered' WHERE id = ?", [event.id]),
      /immutable/
    );
    assert.throws(() => run(db, "DELETE FROM audit_logs WHERE id = ?", [event.id]), /immutable/);
    const row = queryOne(db, "SELECT action FROM audit_logs WHERE id = ?", [event.id]);
    assert.equal(row.action, "object.create");
  });

  test("queries events with filters, ordering and pagination", () => {
    for (let i = 0; i < 3; i += 1) {
      audit.capture(db, {
        actor,
        tenant_id: tenantId,
        action: "object.export",
        object_type: "report",
        object_id: `R-${i}`,
        status: i === 2 ? "failure" : "success",
        error_message: i === 2 ? "boom" : null,
      });
    }
    const list = audit.listEvents(db, { objectType: "report", pageSize: 2, page: 1, order: "asc" }, { scopeAll: true });
    assert.equal(list.total, 3);
    assert.equal(list.items.length, 2);
    const failures = audit.listEvents(db, { objectType: "report", status: "failure" }, { scopeAll: true });
    assert.equal(failures.total, 1);
    assert.equal(failures.items[0].error_message, "boom");
    const search = audit.listEvents(db, { q: "boom" }, { scopeAll: true });
    assert.ok(search.total >= 1);
    const summary = audit.auditSummary(db, { objectType: "report" }, { scopeAll: true });
    assert.equal(summary.total, 3);
    assert.equal(summary.failure, 1);
  });

  test("exposes object history and user activity", () => {
    audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "object.create",
      object_type: "widget",
      object_id: "W-1",
      object_name: "Widget one",
    });
    const history = audit.objectHistory(db, { objectType: "widget", objectId: "W-1" }, {}, { scopeAll: true });
    assert.ok(history.total >= 1);
    assert.ok(history.items.every((e) => e.object_id === "W-1"));

    const activity = audit.userActivity(db, actor.id, {}, { scopeAll: true });
    assert.ok(activity.total >= 1);
    assert.ok(activity.items.every((e) => e.actor_id === actor.id));
  });

  test("enforces tenant isolation in scoped queries", () => {
    const acme = queryOne(db, "SELECT id FROM organizations WHERE code = 'apac'");
    audit.capture(db, {
      actor,
      tenant_id: acme.id,
      action: "object.create",
      object_type: "part",
      object_id: "APAC-1",
    });
    const ownTenant = audit.listEvents(db, { objectType: "part" }, { tenantId, scopeAll: false });
    assert.ok(ownTenant.items.every((e) => e.tenant_id === tenantId));
    assert.equal(ownTenant.items.some((e) => e.object_id === "APAC-1"), false);
    const global = audit.listEvents(db, { objectType: "part" }, { scopeAll: true });
    assert.ok(global.items.some((e) => e.object_id === "APAC-1"));
  });

  test("exports filtered events as CSV and Excel", () => {
    const csv = audit.exportEvents(db, { filters: { action: "object.export" }, scope: { scopeAll: true }, format: "csv" });
    assert.match(csv.content_type, /csv/);
    assert.match(csv.content, /Event ID,Timestamp \(UTC\)/);
    assert.equal(csv.count, 3);

    const excel = audit.exportEvents(db, {
      filters: { action: "object.export" },
      scope: { scopeAll: true },
      format: "excel",
    });
    assert.match(excel.content_type, /ms-excel/);
    assert.match(excel.content, /<Workbook/);
    assert.match(excel.filename, /\.xls$/);
    assert.throws(
      () => audit.exportEvents(db, { filters: {}, scope: { scopeAll: true }, format: "pdf" }),
      /Unsupported export format/
    );
  });

  test("archives and purges events per the retention policy", () => {
    const policy = audit.createPolicy(
      db,
      { tenant_id: tenantId, object_type: "retain-me", name: "Retain", retention_days: 1 },
      actor,
      tenantId
    );
    run(
      db,
      `INSERT INTO audit_logs (tenant_id, actor_id, actor_username, action, event_type, resource_type, resource_id, status, created_at)
       VALUES (?, ?, 'admin', 'object.create', 'CREATE', 'retain-me', 'OLD-1', 'success', '2000-01-01 00:00:00')`,
      [tenantId, actor.id]
    );
    const oldId = queryOne(db, "SELECT id FROM audit_logs WHERE resource_id = 'OLD-1'").id;

    const preview = audit.runRetention(db, { tenantId, policyId: policy.id, actor, dryRun: true });
    assert.equal(preview.dry_run, true);
    assert.ok(preview.runs[0].candidates >= 1);

    const result = audit.runRetention(db, { tenantId, policyId: policy.id, actor });
    assert.ok(result.archived >= 1);
    assert.equal(queryOne(db, "SELECT 1 AS x FROM audit_logs WHERE id = ?", [oldId]), null);
    assert.ok(queryOne(db, "SELECT 1 AS x FROM audit_logs_archive WHERE id = ?", [oldId]));

    const runs = audit.listRetentionRuns(db, { tenantId });
    assert.ok(runs.total >= 1);
    const stats = audit.archiveStats(db, { tenantId });
    assert.ok(stats.archived >= 1);
    audit.deletePolicy(db, policy.id);
  });

  test("deduplicates and validates policy input", () => {
    assert.throws(() => audit.createPolicy(db, { name: "", object_type: "x" }, actor, tenantId), /name is required/);
    assert.throws(
      () => audit.createPolicy(db, { name: "Bad", object_type: "x", retention_days: 0 }, actor, tenantId),
      /Retention days/
    );
    const policy = audit.createPolicy(
      db,
      { tenant_id: null, name: "Lists", object_type: "lists", actions: "CREATE, UPDATE, CREATE", masked_attributes: "a, a, b" },
      actor,
      null
    );
    assert.deepEqual(policy.actions, ["CREATE", "UPDATE"]);
    assert.deepEqual(policy.masked_attributes, ["a", "b"]);
    audit.deletePolicy(db, policy.id);
  });
});

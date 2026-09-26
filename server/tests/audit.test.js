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

// Coverage for the extended audit framework: classification and actor types,
// mandatory-event enforcement, batch capture, specialised history views,
// metrics, action registry, dedicated retention policies, async exports and
// saved filters.
describe("audit framework extensions", () => {
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

  test("classifies actor type, category and security classification", () => {
    const integration = audit.capture(db, {
      tenant_id: tenantId,
      action: "integration.sync.run",
      object_type: "integration_job",
      object_id: "INT-1",
      source: "integration",
      status: "success",
    });
    assert.ok(integration.id);
    assert.equal(integration.event_type, "INTEGRATION_EXECUTED");
    assert.equal(integration.category, "integration");
    assert.equal(integration.actor_type, "integration");

    const denied = audit.recordSecurityEvent(db, {
      actor,
      tenant_id: tenantId,
      action: "access.denied",
      object_type: "object",
      object_id: "OBJ-1",
      status: "denied",
      failure_category: "permission",
    });
    const event = audit.getEvent(db, denied.id, { scopeAll: true });
    assert.equal(event.category, "security");
    assert.equal(event.security_classification, "restricted");
    assert.equal(event.failure_category, "permission");
  });

  test("mandatory security events bypass restrictive capture policies", () => {
    const objectType = "mandatory_probe";
    audit.createPolicy(
      db,
      {
        tenant_id: tenantId,
        name: "Suppress everything",
        object_type: objectType,
        status: "active",
        record_success: false,
        record_failure: false,
        actions: ["CREATE"],
      },
      actor,
      tenantId
    );
    const view = audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "object.view",
      object_type: objectType,
      object_id: "PROBE-1",
      status: "success",
    });
    assert.equal(view, null, "non-mandatory view should be suppressed by the policy");

    const security = audit.recordAuthentication(db, {
      actor,
      tenant_id: tenantId,
      action: "login.failed",
      object_type: objectType,
      object_id: "PROBE-1",
      status: "failure",
    });
    assert.ok(security, "mandatory authentication event must still be captured");
    assert.equal(security.category, "authentication");
  });

  test("batch capture records multiple events", () => {
    const ids = audit.recordBatch(db, [
      { actor, tenant_id: tenantId, action: "object.create", object_type: "part", object_id: "B-1" },
      { actor, tenant_id: tenantId, action: "object.update", object_type: "part", object_id: "B-1" },
    ]);
    assert.equal(ids.length, 2);
  });

  test("attribute and relationship history return focused timelines", () => {
    audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "object.update",
      object_type: "part",
      object_id: "ATTR-1",
      before: { "part.weight_kg": 1.0 },
      after: { "part.weight_kg": 1.4 },
    });
    const attr = audit.attributeHistory(
      db,
      { objectType: "part", objectId: "ATTR-1", attribute: "part.weight_kg" },
      {},
      { tenantId }
    );
    assert.equal(attr.items.length, 1);
    assert.equal(attr.items[0].old_value, 1.0);
    assert.equal(attr.items[0].new_value, 1.4);

    audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "relationship.create",
      object_type: "part",
      object_id: "ATTR-1",
      related_resource_type: "assembly",
      related_resource_id: "ASM-9",
    });
    const rel = audit.relationshipHistory(db, { objectType: "part", objectId: "ATTR-1" }, {}, { tenantId });
    assert.ok(rel.items.some((item) => item.event_type === "RELATIONSHIP_CREATED"));
    const reverse = audit.relationshipHistory(db, { objectType: "assembly", objectId: "ASM-9" }, {}, { tenantId });
    assert.ok(reverse.total >= 1);
  });

  test("category views and metrics summarise activity", () => {
    const security = audit.securityActivity(db, {}, { tenantId });
    assert.ok(security.total >= 1);
    assert.ok(security.items.every((item) => item.category === "security"));

    const metrics = audit.auditMetrics(db, {}, { tenantId });
    assert.ok(metrics.total >= 1);
    assert.ok(Array.isArray(metrics.by_category));
    assert.ok(metrics.growth.last_30d >= 1);
  });

  test("action type registry classifies custom actions", () => {
    const custom = audit.createActionType(
      db,
      { code: "custom.flag", label: "Custom flag", category: "configuration", event_type: "CONFIGURATION_CHANGED" },
      actor
    );
    assert.equal(custom.system, false);
    const captured = audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "custom.flag",
      object_type: "feature",
      object_id: "F-1",
    });
    assert.equal(captured.event_type, "CONFIGURATION_CHANGED");
    assert.equal(captured.category, "configuration");
    const listed = audit.listActionTypes(db, { category: "configuration" });
    assert.ok(listed.items.some((item) => item.code === "custom.flag"));
    audit.deleteActionType(db, "custom.flag", actor);
  });

  test("policy validation reports warnings without persisting", () => {
    const result = audit.validatePolicy(db, { name: "Probe", capture_views: true, capture_reads: false });
    assert.equal(result.valid, true);
    assert.ok(result.warnings.length >= 1);
  });

  test("dedicated retention policies archive expired events and honour legal hold", () => {
    run(
      db,
      `INSERT INTO audit_logs (tenant_id, actor_username, actor_type, action, event_type, category, source,
         security_classification, retention_category, resource_type, resource_id, status, created_at)
       VALUES (?, 'system', 'system', 'compliance.record', 'ADMIN_ACTION', 'compliance', 'system',
         'confidential', 'extended', 'compliance_record', 'C-OLD', 'success', datetime('now', '-800 days'))`,
      [tenantId]
    );
    const policy = audit.createRetentionPolicy(
      db,
      {
        tenant_id: tenantId,
        name: "Compliance 2y",
        category: "compliance",
        object_type: "*",
        retention_days: 730,
        action: "archive",
      },
      actor,
      tenantId
    );
    const dry = audit.executeRetentionPolicies(db, { tenantId, policyId: policy.id, dryRun: true });
    assert.equal(dry.runs.length, 1);
    const applied = audit.executeRetentionPolicies(db, { tenantId, policyId: policy.id });
    assert.ok(applied.archived >= 1);
    const archived = queryOne(
      db,
      "SELECT COUNT(*) AS c FROM audit_logs_archive WHERE resource_id = 'C-OLD'"
    );
    assert.ok(archived.c >= 1);

    const hold = audit.updateRetentionPolicy(db, policy.id, { legal_hold: true }, actor, tenantId);
    assert.equal(hold.legal_hold, true);
    const held = audit.executeRetentionPolicies(db, { tenantId, policyId: policy.id });
    assert.equal(held.archived, 0);
  });

  test("async export requests materialise and download content", () => {
    audit.capture(db, {
      actor,
      tenant_id: tenantId,
      action: "object.update",
      object_type: "part",
      object_id: "EXPORT-1",
      before: { "part.weight_kg": 1 },
      after: { "part.weight_kg": 2 },
    });
    const request = audit.requestAuditExport(
      db,
      { format: "json", filters: { objectType: "part", objectId: "EXPORT-1" } },
      actor,
      tenantId,
      "10.0.0.9"
    );
    assert.equal(request.status, "pending");
    const done = audit.runAuditExport(db, request.id);
    assert.equal(done.status, "completed");
    assert.ok(done.row_count >= 1);
    const download = audit.getAuditExport(db, request.uuid, { tenantId, includeContent: true });
    assert.ok(download.filename.endsWith(".json"));
    assert.ok(JSON.parse(download.content).length >= 1);
  });

  test("saved filters are owner scoped", () => {
    const filter = audit.createSavedFilter(
      db,
      { name: "Security events", scope: "security", filters: { category: "security" }, shared: true },
      actor,
      tenantId
    );
    assert.equal(filter.scope, "security");
    const listed = audit.listSavedFilters(db, { tenantId, ownerId: actor.id });
    assert.ok(listed.items.some((item) => item.id === filter.id));
    const updated = audit.updateSavedFilter(db, filter.id, { name: "Security events v2" }, actor, tenantId);
    assert.equal(updated.name, "Security events v2");
    assert.throws(() => audit.updateSavedFilter(db, filter.id, { name: "nope" }, { id: 999999 }, tenantId));
    audit.deleteSavedFilter(db, filter.id, actor, tenantId);
  });
});

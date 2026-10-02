import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase, queryOne, queryAll } from "../db.js";
import { seedDatabase } from "../seed.js";
import { captureAsync, writeAuditAsync } from "../services/audit/events.js";
import { resolvePolicyAsync, resolvePolicy } from "../services/audit/policies.js";
import * as audit from "../services/audit.js";

function db() {
  const database = openTestDatabase();
  migrate(database);
  return database;
}

describe("async audit capture", () => {
  test("writeAuditAsync inserts an event with the legacy field mapping", async () => {
    const database = db();
    const outcome = await writeAuditAsync(database, {
      actor: { id: 1, username: "tester", tenant_id: 1 },
      action: "notification.archive",
      resourceType: "notification",
      resourceId: 42,
      ip: "127.0.0.1",
    });
    assert.ok(outcome && outcome.id > 0);
    const row = queryOne(database, "SELECT * FROM audit_logs WHERE id = ?", [outcome.id]);
    assert.equal(row.action, "notification.archive");
    assert.equal(String(row.resource_id), "42");
    assert.equal(row.resource_type, "notification");
    assert.equal(row.ip, "127.0.0.1");
  });

  test("captureAsync stores changed fields and masks sensitive attributes", async () => {
    const database = db();
    const outcome = await captureAsync(database, {
      actor: { id: 1, username: "tester" },
      action: "object.update",
      object_type: "object",
      object_id: "OBJ-1",
      before: { name: "old", api_token: "aaa" },
      after: { name: "new", api_token: "bbb" },
      mandatory: true,
    });
    assert.ok(outcome && outcome.id > 0);
    const changes = queryAll(
      database,
      "SELECT attribute, masked FROM audit_event_changes WHERE event_id = ?",
      [outcome.id]
    );
    const name = changes.find((c) => c.attribute === "name");
    assert.ok(name);
    assert.equal(name.masked, 0);
    const token = changes.find((c) => c.attribute === "api_token");
    assert.ok(token);
    assert.equal(token.masked, 1);
  });

  test("resolvePolicyAsync matches the synchronous resolution", async () => {
    const database = db();
    for (const [tenantId, objectType] of [[null, "object"], [1, "object"], [1, "does-not-exist"]]) {
      const sync = resolvePolicy(database, tenantId, objectType);
      const async_ = await resolvePolicyAsync(database, tenantId, objectType);
      assert.equal(async_.scope, sync.scope);
      assert.equal(async_.policy.enabled, sync.policy.enabled);
      assert.equal(async_.policy.object_type, sync.policy.object_type);
    }
  });
});

describe("async audit read twins mirror the synchronous service", () => {
  let database;
  let actor;
  let tenantId;
  const scope = { scopeAll: true };

  before(() => {
    database = db();
    seedDatabase(database);
    actor = queryOne(database, "SELECT id, username, display_name FROM users WHERE username = 'admin'");
    actor.tenant_id = queryOne(database, "SELECT id FROM organizations WHERE code = 'helix'").id;
    tenantId = actor.tenant_id;

    audit.capture(database, {
      actor,
      tenant_id: tenantId,
      action: "object.update",
      object_type: "part",
      object_id: "PARITY-1",
      before: { "part.weight_kg": 1 },
      after: { "part.weight_kg": 2 },
    });
    audit.recordSecurityEvent(database, {
      actor,
      tenant_id: tenantId,
      action: "access.denied",
      object_type: "object",
      object_id: "PARITY-1",
      status: "denied",
      failure_category: "permission",
    });
    audit.capture(database, {
      actor,
      tenant_id: tenantId,
      action: "relationship.create",
      object_type: "part",
      object_id: "PARITY-1",
      related_resource_type: "assembly",
      related_resource_id: "ASM-PARITY",
    });
  });

  test("event stream, facets and summary match", async () => {
    const syncList = audit.listEvents(database, { objectType: "part" }, scope);
    const asyncList = await audit.listEventsAsync(database, { objectType: "part" }, scope);
    assert.equal(asyncList.total, syncList.total);
    assert.deepEqual(asyncList.items.map((i) => i.id), syncList.items.map((i) => i.id));

    const syncFacets = audit.eventFacets(database, {}, scope);
    const asyncFacets = await audit.eventFacetsAsync(database, {}, scope);
    assert.deepEqual(asyncFacets, syncFacets);

    const syncSummary = audit.auditSummary(database, { objectType: "part" }, scope);
    const asyncSummary = await audit.auditSummaryAsync(database, { objectType: "part" }, scope);
    assert.deepEqual(asyncSummary, syncSummary);
  });

  test("object, user, attribute and relationship history match", async () => {
    const syncHistory = audit.objectHistory(database, { objectType: "part", objectId: "PARITY-1" }, {}, scope);
    const asyncHistory = await audit.objectHistoryAsync(database, { objectType: "part", objectId: "PARITY-1" }, {}, scope);
    assert.deepEqual(asyncHistory, syncHistory);

    const syncActivity = audit.userActivity(database, actor.id, {}, scope);
    const asyncActivity = await audit.userActivityAsync(database, actor.id, {}, scope);
    assert.deepEqual(asyncActivity, syncActivity);

    const params = { objectType: "part", objectId: "PARITY-1", attribute: "part.weight_kg" };
    const syncAttr = audit.attributeHistory(database, params, {}, scope);
    const asyncAttr = await audit.attributeHistoryAsync(database, params, {}, scope);
    assert.deepEqual(asyncAttr, syncAttr);

    const relParams = { objectType: "part", objectId: "PARITY-1" };
    const syncRel = audit.relationshipHistory(database, relParams, {}, scope);
    const asyncRel = await audit.relationshipHistoryAsync(database, relParams, {}, scope);
    assert.deepEqual(asyncRel, syncRel);
  });

  test("category views and metrics match", async () => {
    const syncSecurity = audit.securityActivity(database, {}, { tenantId });
    const asyncSecurity = await audit.securityActivityAsync(database, {}, { tenantId });
    assert.deepEqual(asyncSecurity, syncSecurity);

    const syncWorkflow = audit.workflowAudit(database, {}, { tenantId });
    const asyncWorkflow = await audit.workflowAuditAsync(database, {}, { tenantId });
    assert.deepEqual(asyncWorkflow, syncWorkflow);

    const syncMetrics = audit.auditMetrics(database, {}, { tenantId });
    const asyncMetrics = await audit.auditMetricsAsync(database, {}, { tenantId });
    assert.deepEqual(asyncMetrics, syncMetrics);
  });

  test("policy, action type and saved filter reads match", async () => {
    const syncPolicies = audit.listPolicies(database, { tenantId });
    const asyncPolicies = await audit.listPoliciesAsync(database, { tenantId });
    assert.deepEqual(asyncPolicies, syncPolicies);

    const policyId = syncPolicies.items[0].id;
    assert.deepEqual(await audit.getPolicyAsync(database, policyId, tenantId), audit.getPolicy(database, policyId, tenantId));

    const syncActions = audit.listActionTypes(database, {});
    const asyncActions = await audit.listActionTypesAsync(database, {});
    assert.deepEqual(asyncActions, syncActions);
    const code = syncActions.items[0].code;
    assert.deepEqual(await audit.getActionTypeAsync(database, code), audit.getActionType(database, code));

    const filter = audit.createSavedFilter(
      database,
      { name: "Parity filter", scope: "security", filters: { category: "security" }, shared: true },
      actor,
      tenantId
    );
    const syncFilters = audit.listSavedFilters(database, { tenantId, ownerId: actor.id });
    const asyncFilters = await audit.listSavedFiltersAsync(database, { tenantId, ownerId: actor.id });
    assert.deepEqual(asyncFilters, syncFilters);
    assert.deepEqual(
      await audit.getSavedFilterAsync(database, filter.id, { tenantId, ownerId: actor.id }),
      audit.getSavedFilter(database, filter.id, { tenantId, ownerId: actor.id })
    );
  });

  test("export and retention reads match", async () => {
    const request = audit.requestAuditExport(
      database,
      { format: "json", filters: { objectType: "part", objectId: "PARITY-1" } },
      actor,
      tenantId,
      "10.0.0.10"
    );
    audit.runAuditExport(database, request.id);

    const syncExports = audit.listAuditExports(database, { tenantId, limit: 100 });
    const asyncExports = await audit.listAuditExportsAsync(database, { tenantId, limit: 100 });
    assert.deepEqual(asyncExports, syncExports);

    const reference = request.uuid;
    assert.deepEqual(
      await audit.getAuditExportAsync(database, reference, { tenantId }),
      audit.getAuditExport(database, reference, { tenantId })
    );
    assert.deepEqual(
      await audit.getAuditExportAsync(database, reference, { tenantId, includeContent: true }),
      audit.getAuditExport(database, reference, { tenantId, includeContent: true })
    );

    const syncRetention = audit.listRetentionPolicies(database, { tenantId });
    const asyncRetention = await audit.listRetentionPoliciesAsync(database, { tenantId });
    assert.deepEqual(asyncRetention, syncRetention);
    const retentionId = syncRetention.items[0].id;
    assert.deepEqual(
      await audit.getRetentionPolicyAsync(database, retentionId, tenantId),
      audit.getRetentionPolicy(database, retentionId, tenantId)
    );

    assert.deepEqual(
      await audit.listRetentionRunsAsync(database, { tenantId }),
      audit.listRetentionRuns(database, { tenantId })
    );
    assert.deepEqual(
      await audit.archiveStatsAsync(database, { tenantId }),
      audit.archiveStats(database, { tenantId })
    );
  });
});

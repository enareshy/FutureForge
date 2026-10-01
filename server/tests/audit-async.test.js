import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase, queryOne, queryAll } from "../db.js";
import { captureAsync, writeAuditAsync } from "../services/audit/events.js";
import { resolvePolicyAsync, resolvePolicy } from "../services/audit/policies.js";

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

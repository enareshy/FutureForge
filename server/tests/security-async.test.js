process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as security from "../services/security/admin.js";

function db() {
  const database = openTestDatabase();
  migrate(database);
  return database;
}

function stable(decision) {
  return {
    decision: decision.decision,
    allowed: decision.allowed,
    reason: decision.reason,
    fields: (decision.fields || []).map((field) => ({
      field: field.field,
      effect: field.effect,
      strategy: field.strategy,
    })),
  };
}

describe("data security authorization debugger async twins", () => {
  let database;
  let admin;
  let tenantId;

  beforeEach(async () => {
    database = db();
    seedDatabase(database);
    admin = await queryOne(database, "SELECT id, username, tenant_id FROM users WHERE username = 'admin'");
    tenantId = admin.tenant_id;
  });

  test("explainAuthorizationAsync mirrors explainAuthorization for an allow", async () => {
    const input = { action: "read", resource_type: "iam.users", user_id: admin.id };
    const sync = security.explainAuthorization(database, admin, tenantId, input);
    const asyncResult = await security.explainAuthorizationAsync(database, admin, tenantId, input);
    assert.deepEqual(stable(asyncResult), stable(sync));
    assert.equal(asyncResult.allowed, true);
  });

  test("explainAuthorizationAsync mirrors explainAuthorization for a deny", async () => {
    const operator = await queryOne(database, "SELECT id, tenant_id FROM users WHERE username = 'j.patel'");
    const input = { action: "delete", resource_type: "iam.users", user_id: operator.id };
    const sync = security.explainAuthorization(database, operator, tenantId, input);
    const asyncResult = await security.explainAuthorizationAsync(database, operator, tenantId, input);
    assert.deepEqual(stable(asyncResult), stable(sync));
    assert.equal(asyncResult.allowed, false);
  });

  test("batch debugger preserves input order and count", async () => {
    const operator = await queryOne(database, "SELECT id FROM users WHERE username = 'j.patel'");
    const requests = [
      { action: "read", resource_type: "iam.users", user_id: admin.id },
      { action: "delete", resource_type: "iam.users", user_id: operator.id },
      { action: "read", resource_type: "iam.users", user_id: operator.id },
    ];
    const result = await security.explainAuthorizationBatchAsync(database, admin, tenantId, { requests });
    assert.equal(result.count, 3);
    assert.equal(result.decisions.length, 3);
    const sync = security.explainAuthorizationBatch(database, admin, tenantId, { requests });
    assert.deepEqual(result.decisions.map(stable), sync.decisions.map(stable));
  });

  test("batch debugger rejects oversized batches", async () => {
    const requests = Array.from({ length: 3 }, () => ({ action: "read", resource_type: "iam.users" }));
    await assert.rejects(() =>
      security.explainAuthorizationBatchAsync(database, admin, tenantId, { requests }, { maxBatch: 2 })
    );
  });

  test("async debugger journals a decision", async () => {
    const before = Number(
      (await queryOne(database, "SELECT COUNT(*) AS c FROM security_decisions WHERE tenant_id = ?", [tenantId])).c
    );
    await security.explainAuthorizationAsync(database, admin, tenantId, {
      action: "read",
      resource_type: "iam.users",
      user_id: admin.id,
    });
    const after = Number(
      (await queryOne(database, "SELECT COUNT(*) AS c FROM security_decisions WHERE tenant_id = ?", [tenantId])).c
    );
    assert.equal(after, before + 1);
  });
});

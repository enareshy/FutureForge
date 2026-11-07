process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as users from "../services/users.js";
import * as roles from "../services/roles.js";
import * as catalog from "../services/catalog.js";
import * as grants from "../services/grants.js";
import {
  checkPermissionAsync,
  checkPermissionAuditedAsync,
  effectivePermissionsAsync,
  permissionMatrixAsync,
} from "../services/authorization.js";

function db() {
  const database = openTestDatabase();
  migrate(database);
  return database;
}

async function userByName(database, username) {
  const listed = await users.listUsersAsync(database, { q: username });
  return listed.items.find((u) => u.username === username);
}

describe("authorization engine async twins mirror the sync layer", () => {
  let database;
  let admin;
  beforeEach(async () => {
    database = db();
    seedDatabase(database);
    admin = await queryOne(database, "SELECT id, username FROM users WHERE username = 'admin'");
  });

  test("denies by default when no grant matches", async () => {
    const operator = await userByName(database, "j.patel");
    const result = await checkPermissionAsync(database, operator.id, "finance.ledger", "update", {});
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "unmatched");
  });

  test("denies unknown resource and inactive user", async () => {
    const unknown = await checkPermissionAsync(database, admin.id, "does.not.exist", "read");
    assert.equal(unknown.allowed, false);
    assert.equal(unknown.reason, "unknown_resource");

    const contractor = await userByName(database, "c.nielsen");
    const inactive = await checkPermissionAsync(database, contractor.id, "iam.users", "read");
    assert.equal(inactive.allowed, false);
    assert.equal(inactive.reason, "inactive");

    const missing = await checkPermissionAsync(database, 99999, "iam.users", "read");
    assert.equal(missing.allowed, false);
    assert.equal(missing.reason, "unknown_user");
  });

  test("allows inherited module permission", async () => {
    const result = await checkPermissionAsync(database, admin.id, "iam.users", "create");
    assert.equal(result.allowed, true);
    assert.ok(result.matches.some((m) => m.inheritedResource || m.permissionCode.startsWith("iam")));
  });

  test("group reader role allows read only", async () => {
    const operator = await userByName(database, "j.patel");
    const read = await checkPermissionAsync(database, operator.id, "iam.users", "read");
    const write = await checkPermissionAsync(database, operator.id, "iam.users", "update");
    assert.equal(read.allowed, true);
    assert.equal(write.allowed, false);
  });

  test("explicit deny wins over allow", async () => {
    const analyst = await userByName(database, "m.okonkwo");
    const apac = await queryOne(database, "SELECT id FROM organizations WHERE code = 'apac'");
    const del = await checkPermissionAsync(database, analyst.id, "iam.users", "delete", { organizationId: apac.id });
    assert.equal(del.allowed, false);
    assert.equal(del.reason, "explicit_deny");
    const read = await checkPermissionAsync(database, analyst.id, "iam.users", "read", { organizationId: apac.id });
    assert.equal(read.allowed, true);
  });

  test("organization scope does not leak across sites", async () => {
    const operator = await userByName(database, "j.patel");
    const emea = await queryOne(database, "SELECT id FROM organizations WHERE code = 'emea'");
    const apac = await queryOne(database, "SELECT id FROM organizations WHERE code = 'apac'");
    const local = await checkPermissionAsync(database, operator.id, "site.ops", "execute", { organizationId: emea.id });
    const other = await checkPermissionAsync(database, operator.id, "site.ops", "execute", { organizationId: apac.id });
    assert.equal(local.allowed, true);
    assert.equal(other.allowed, false);
  });

  test("role inheritance carries permissions from parent role", async () => {
    const created = await users.createUserAsync(
      database,
      {
        username: "async.inherit.role",
        email: "async.inherit.role@helix.example",
        employee_id: "EMP-A80",
        display_name: "Async Inherit Role",
        password: "HelixAdmin!42",
      },
      admin
    );
    const child = await queryOne(database, "SELECT * FROM roles WHERE code = 'iam.admin'");
    await roles.assignUserRoleAsync(database, created.id, child.id, 0, admin, null);
    const result = await checkPermissionAsync(database, created.id, "finance.ledger", "read");
    assert.equal(result.allowed, true);
  });

  test("effective permissions exclude denies", async () => {
    const analyst = await userByName(database, "m.okonkwo");
    const apac = await queryOne(database, "SELECT id FROM organizations WHERE code = 'apac'");
    const effective = await effectivePermissionsAsync(database, analyst.id, { organizationId: apac.id });
    assert.ok(effective.permissions.some((p) => p.code === "iam.users:read" || p.resourceCode === "iam"));
    assert.ok(!effective.permissions.some((p) => p.code === "iam.users:delete"));
  });

  test("permission matrix returns resources, roles and cells", async () => {
    const matrix = await permissionMatrixAsync(database, {});
    assert.deepEqual(matrix.actions, ["create", "read", "update", "delete", "execute"]);
    assert.ok(matrix.resources.length >= 1);
    assert.ok(matrix.permissions.length >= 1);
    assert.ok(matrix.roles.length >= 1);
    assert.ok(matrix.cells.length >= 1);
    assert.ok(matrix.cells.every((c) => typeof c.effect === "string"));
  });

  test("audited async check records an authz audit entry", async () => {
    const analyst = await userByName(database, "m.okonkwo");
    const before = (await queryOne(database, "SELECT COUNT(*) AS c FROM audit_logs WHERE action IN ('authz.allow','authz.deny')")).c;
    const result = await checkPermissionAuditedAsync(database, analyst.id, "iam.users", "read", {}, admin, "127.0.0.1");
    assert.equal(result.allowed, true);
    const after = (await queryOne(database, "SELECT COUNT(*) AS c FROM audit_logs WHERE action IN ('authz.allow','authz.deny')")).c;
    assert.equal(Number(after), Number(before) + 1);
  });
});

describe("permission catalog and grants async twins", () => {
  test("maps role to permission with allow and deny", async () => {
    const database = db();
    seedDatabase(database);
    const admin = await queryOne(database, "SELECT id, username FROM users WHERE username = 'admin'");

    const user = await users.createUserAsync(
      database,
      {
        username: "authz.async.user",
        email: "authz.async.user@helix.example",
        employee_id: "EMP-A70",
        display_name: "Authz Async User",
        password: "HelixAdmin!42",
      },
      admin
    );
    const role = await roles.createRoleAsync(database, { code: "custom.async.role", name: "Custom Async" }, admin);
    await roles.assignUserRoleAsync(database, user.id, role.id, 0, admin, null);

    const app = await catalog.createApplicationAsync(database, { code: "docs-async", name: "Docs Async" }, admin);
    const resource = await catalog.createResourceAsync(database, {
      application_id: app.id,
      code: "docs.async.file",
      name: "Async File",
      kind: "object",
    }, admin);
    const perm = await catalog.createPermissionAsync(database, { resource_id: resource.id, action: "read" }, admin);

    await grants.grantRolePermissionAsync(database, role.id, { permission_id: perm.id, effect: "allow" }, admin);
    assert.equal((await checkPermissionAsync(database, user.id, "docs.async.file", "read")).allowed, true);

    await grants.grantRolePermissionAsync(database, role.id, { permission_id: perm.id, effect: "deny" }, admin);
    assert.equal((await checkPermissionAsync(database, user.id, "docs.async.file", "read")).reason, "explicit_deny");

    await assert.rejects(
      () => catalog.createPermissionAsync(database, { resource_id: resource.id, action: "read" }, admin)
    );
  });
});

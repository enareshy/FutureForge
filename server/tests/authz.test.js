import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as users from "../services/users.js";
import * as roles from "../services/roles.js";
import * as catalog from "../services/catalog.js";
import * as grants from "../services/grants.js";
import { checkPermission, effectivePermissions } from "../services/authorization.js";
import { HttpError } from "../validation.js";

function db() {
  const database = openDatabase(":memory:");
  migrate(database);
  return database;
}

function userByName(database, username) {
  return users.listUsers(database, { q: username }).items.find((u) => u.username === username);
}

describe("authorization engine", () => {
  let database;
  beforeEach(() => {
    database = db();
    seedDatabase(database);
  });

  test("denies by default when no grant matches", () => {
    const operator = userByName(database, "j.patel");
    const result = checkPermission(database, operator.id, "finance.ledger", "update", {});
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "unmatched");
  });

  test("denies unknown resource and inactive user", () => {
    const admin = userByName(database, "admin");
    const unknown = checkPermission(database, admin.id, "does.not.exist", "read");
    assert.equal(unknown.allowed, false);
    assert.equal(unknown.reason, "unknown_resource");

    const contractor = userByName(database, "c.nielsen");
    const inactive = checkPermission(database, contractor.id, "iam.users", "read");
    assert.equal(inactive.allowed, false);
    assert.equal(inactive.reason, "inactive");

    const missing = checkPermission(database, 99999, "iam.users", "read");
    assert.equal(missing.allowed, false);
    assert.equal(missing.reason, "unknown_user");
  });

  test("allows inherited module permission", () => {
    const admin = userByName(database, "admin");
    const result = checkPermission(database, admin.id, "iam.users", "create");
    assert.equal(result.allowed, true);
    assert.ok(result.matches.some((m) => m.inheritedResource || m.permissionCode.startsWith("iam")));
  });

  test("group reader role allows read only", () => {
    const operator = userByName(database, "j.patel");
    const read = checkPermission(database, operator.id, "iam.users", "read");
    const write = checkPermission(database, operator.id, "iam.users", "update");
    assert.equal(read.allowed, true);
    assert.equal(write.allowed, false);
  });

  test("explicit deny wins over allow", () => {
    const analyst = userByName(database, "m.okonkwo");
    const apac = database.prepare("SELECT id FROM organizations WHERE code = 'apac'").get();
    const del = checkPermission(database, analyst.id, "iam.users", "delete", {
      organizationId: apac.id,
    });
    assert.equal(del.allowed, false);
    assert.equal(del.reason, "explicit_deny");
    const read = checkPermission(database, analyst.id, "iam.users", "read", {
      organizationId: apac.id,
    });
    assert.equal(read.allowed, true);
  });

  test("organization scope does not leak across sites", () => {
    const operator = userByName(database, "j.patel");
    const emea = database.prepare("SELECT id FROM organizations WHERE code = 'emea'").get();
    const apac = database.prepare("SELECT id FROM organizations WHERE code = 'apac'").get();
    const local = checkPermission(database, operator.id, "site.ops", "execute", {
      organizationId: emea.id,
    });
    const other = checkPermission(database, operator.id, "site.ops", "execute", {
      organizationId: apac.id,
    });
    assert.equal(local.allowed, true);
    assert.equal(other.allowed, false);
  });

  test("role inheritance carries permissions from parent role", () => {
    const child = database.prepare("SELECT * FROM roles WHERE code = 'iam.admin'").get();
    const user = users.createUser(database, {
      username: "inherit.role",
      email: "inherit.role@helix.example",
      employee_id: "EMP-80",
      display_name: "Inherit Role",
      password: "HelixAdmin!42",
    });
    roles.assignUserRole(database, user.id, child.id, 0);
    const result = checkPermission(database, user.id, "finance.ledger", "read");
    assert.equal(result.allowed, true);
  });

  test("effective permissions exclude denies", () => {
    const analyst = userByName(database, "m.okonkwo");
    const apac = database.prepare("SELECT id FROM organizations WHERE code = 'apac'").get();
    const effective = effectivePermissions(database, analyst.id, { organizationId: apac.id });
    assert.ok(effective.permissions.some((p) => p.code === "iam.users:read" || p.resourceCode === "iam"));
    assert.ok(!effective.permissions.some((p) => p.code === "iam.users:delete"));
  });
});

describe("permission catalog and grants", () => {
  test("maps role to permission with allow and deny", () => {
    const database = db();
    const user = users.createUser(database, {
      username: "authz.user",
      email: "authz.user@helix.example",
      employee_id: "EMP-70",
      display_name: "Authz User",
      password: "HelixAdmin!42",
    });
    const role = roles.createRole(database, { code: "custom.role", name: "Custom" });
    roles.assignUserRole(database, user.id, role.id, 0);
    const app = catalog.createApplication(database, { code: "docs", name: "Docs" });
    const resource = catalog.createResource(database, {
      application_id: app.id,
      code: "docs.file",
      name: "File",
      kind: "object",
    });
    const perm = catalog.createPermission(database, { resource_id: resource.id, action: "read" });
    grants.grantRolePermission(database, role.id, { permission_id: perm.id, effect: "allow" });
    assert.equal(checkPermission(database, user.id, "docs.file", "read").allowed, true);
    grants.grantRolePermission(database, role.id, { permission_id: perm.id, effect: "deny" });
    assert.equal(checkPermission(database, user.id, "docs.file", "read").reason, "explicit_deny");
    assert.throws(() => catalog.createPermission(database, { resource_id: resource.id, action: "read" }), HttpError);
  });
});

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as users from "../services/users.js";
import * as groups from "../services/groups.js";
import * as roles from "../services/roles.js";
import * as policy from "../services/policy.js";
import { effectiveAccess } from "../services/access.js";
import { HttpError } from "../validation.js";
import { validatePasswordAgainstPolicy } from "../validation.js";
import { hashPassword, verifyPassword } from "../crypto.js";

function db() {
  const database = openDatabase(":memory:");
  migrate(database);
  return database;
}

describe("password hashing", () => {
  test("hashes and verifies", () => {
    const { hash, salt } = hashPassword("HelixAdmin!42");
    assert.equal(verifyPassword("HelixAdmin!42", hash, salt), true);
    assert.equal(verifyPassword("wrong", hash, salt), false);
  });
});

describe("password policy validation", () => {
  const p = {
    min_length: 10,
    require_uppercase: 1,
    require_lowercase: 1,
    require_digit: 1,
    require_special: 1,
  };

  test("rejects short passwords", () => {
    assert.throws(() => validatePasswordAgainstPolicy("Ab1!xx", p), HttpError);
  });

  test("accepts compliant passwords", () => {
    validatePasswordAgainstPolicy("HelixAdmin!42", p);
  });
});

describe("users", () => {
  let database;
  beforeEach(() => {
    database = db();
  });

  test("creates, updates, deactivates and locks", () => {
    const user = users.createUser(database, {
      username: "a.rivera",
      email: "a.rivera@helix.example",
      employee_id: "EMP-9",
      display_name: "Alex Rivera",
      password: "HelixAdmin!42",
    });
    assert.equal(user.status, "active");
    const updated = users.updateUser(database, user.id, { display_name: "Alex R." });
    assert.equal(updated.display_name, "Alex R.");
    assert.equal(users.setUserStatus(database, user.id, "inactive").status, "inactive");
    assert.equal(users.setUserStatus(database, user.id, "locked").status, "locked");
    assert.equal(users.setUserStatus(database, user.id, "active").status, "active");
  });

  test("enforces unique username and employee id", () => {
    const body = {
      username: "dup.user",
      email: "dup@helix.example",
      employee_id: "EMP-10",
      display_name: "Dup",
      password: "HelixAdmin!42",
    };
    users.createUser(database, body);
    assert.throws(
      () => users.createUser(database, { ...body, email: "other@helix.example", employee_id: "EMP-11" }),
      (err) => err instanceof HttpError && err.status === 409
    );
  });

  test("rejects password reuse on reset", () => {
    const user = users.createUser(database, {
      username: "reuse.me",
      email: "reuse@helix.example",
      employee_id: "EMP-12",
      display_name: "Reuse",
      password: "HelixAdmin!42",
    });
    assert.throws(() => users.resetPassword(database, user.id, "HelixAdmin!42"), HttpError);
    users.resetPassword(database, user.id, "HelixAdmin!43");
    users.authenticate(database, "reuse.me", "HelixAdmin!43");
  });

  test("locks after failed logins", () => {
    users.createUser(database, {
      username: "lock.me",
      email: "lock@helix.example",
      employee_id: "EMP-13",
      display_name: "Lock",
      password: "HelixAdmin!42",
    });
    const p = policy.getPolicy(database);
    for (let i = 0; i < p.lockout_threshold - 1; i++) {
      assert.throws(() => users.authenticate(database, "lock.me", "wrong"), HttpError);
    }
    assert.throws(
      () => users.authenticate(database, "lock.me", "wrong"),
      (err) => err instanceof HttpError && err.status === 403
    );
  });

  test("search and pagination", () => {
    for (let i = 0; i < 5; i++) {
      users.createUser(database, {
        username: `user.${i}`,
        email: `user.${i}@helix.example`,
        employee_id: `EMP-2${i}`,
        display_name: `User ${i}`,
        password: "HelixAdmin!42",
      });
    }
    const page = users.listUsers(database, { q: "user.1", page: 1, pageSize: 2 });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].username, "user.1");
  });
});

describe("groups and roles", () => {
  let database;
  beforeEach(() => {
    database = db();
  });

  test("group hierarchy and membership", () => {
    const parent = groups.createGroup(database, { code: "corp", name: "Corporate" });
    const child = groups.createGroup(database, { code: "eng", name: "Engineering", parent_id: parent.id });
    const user = users.createUser(database, {
      username: "eng.lead",
      email: "eng.lead@helix.example",
      employee_id: "EMP-30",
      display_name: "Eng Lead",
      password: "HelixAdmin!42",
    });
    groups.addGroupMember(database, child.id, user.id);
    const inherited = groups.groupsForUser(database, user.id);
    assert.ok(inherited.some((g) => g.code === "eng"));
    assert.ok(inherited.some((g) => g.code === "corp"));
    assert.throws(
      () => groups.updateGroup(database, parent.id, { parent_id: child.id }),
      HttpError
    );
  });

  test("role inheritance and org-scoped assignment", () => {
    const parent = roles.createRole(database, { code: "admin", name: "Admin" });
    const child = roles.createRole(database, { code: "iam.admin", name: "IAM Admin", parent_id: parent.id });
    const user = users.createUser(database, {
      username: "role.user",
      email: "role.user@helix.example",
      employee_id: "EMP-31",
      display_name: "Role User",
      password: "HelixAdmin!42",
    });
    roles.assignUserRole(database, user.id, child.id, 0);
    const access = effectiveAccess(database, user.id);
    assert.ok(access.roles.some((r) => r.code === "iam.admin" && r.inherited === false));
    assert.ok(access.roles.some((r) => r.code === "admin" && r.inherited === true));
  });

  test("cannot delete group with children", () => {
    const parent = groups.createGroup(database, { code: "root", name: "Root" });
    groups.createGroup(database, { code: "leaf", name: "Leaf", parent_id: parent.id });
    assert.throws(() => groups.deleteGroup(database, parent.id), HttpError);
  });
});

describe("seeded effective access", () => {
  test("admin inherits platform and group roles", () => {
    const database = db();
    seedDatabase(database);
    const admin = users.listUsers(database, { q: "admin" }).items[0];
    const access = effectiveAccess(database, admin.id);
    const codes = access.roles.map((r) => r.code);
    assert.ok(codes.includes("platform.admin"));
    assert.ok(codes.includes("iam.admin"));
    assert.ok(codes.includes("app.reader"));
  });
});

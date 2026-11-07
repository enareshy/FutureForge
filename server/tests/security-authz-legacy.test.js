import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import * as orgs from "../services/orgs.js";
import * as users from "../services/users.js";
import * as roles from "../services/roles.js";

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, path, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = data;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function login(port, username, password) {
  const response = await request(port, "POST", "/api/auth/login", {
    body: { username, password },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.token;
}

function userByName(db, username) {
  return queryOne(db, "SELECT * FROM users WHERE username = ?", [username]);
}

function roleByCode(db, code) {
  return queryOne(db, "SELECT * FROM roles WHERE code = ?", [code]);
}

describe("SEC-09 legacy authorization inspection routes", () => {
  let db;
  let server;
  let port;
  let admin;
  let adminToken;
  let operator;
  let operatorToken;
  let unprivileged;
  let unprivilegedToken;
  let tenantB;
  let tenantBUser;
  let tenantBToken;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);

    tenantB = orgs.createOrganization(db, {
      code: "tenant-b",
      name: "Tenant B",
      kind: "tenant",
    });
    const tenantBOrg = orgs.createOrganization(db, {
      code: "tenant-b-org",
      name: "Tenant B Org",
      kind: "enterprise",
      parent_id: tenantB.id,
    });
    tenantBUser = users.createUser(db, {
      username: "tenant.b.user",
      email: "tenant.b.user@example.test",
      employee_id: "EMP-B001",
      display_name: "Tenant B User",
      organization_id: tenantBOrg.id,
      password: "HelixUser!42",
    });
    roles.assignUserRole(db, tenantBUser.id, roleByCode(db, "app.reader").id, 0);

    unprivileged = users.createUser(db, {
      username: "no.perms.user",
      email: "no.perms.user@example.test",
      employee_id: "EMP-N001",
      display_name: "No Permissions User",
      organization_id: queryOne(db, "SELECT id FROM organizations WHERE code = 'emea'").id,
      password: "HelixUser!42",
    });

    const app = createApp(db);
    ({ server, port } = await listen(app));

    admin = userByName(db, "admin");
    operator = userByName(db, "j.patel");
    adminToken = await login(port, "admin", "HelixAdmin!42");
    operatorToken = await login(port, "j.patel", "HelixUser!42");
    tenantBToken = await login(port, "tenant.b.user", "HelixUser!42");
    unprivilegedToken = await login(port, "no.perms.user", "HelixUser!42");
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("self inspection succeeds even without an IAM read grant", async () => {
    const response = await request(
      port,
      "GET",
      `/api/authorization/effective/${unprivileged.id}`,
      { token: unprivilegedToken }
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.principal.id, unprivileged.id);
    assert.ok(Array.isArray(response.body.permissions));
  });

  test("cross-user inspection without iam.users:read is denied", async () => {
    const response = await request(
      port,
      "GET",
      `/api/authorization/effective/${admin.id}`,
      { token: unprivilegedToken }
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error, "Forbidden");
  });

  test("authorized administrator access is tenant scoped", async () => {
    const crossTenant = await request(
      port,
      "GET",
      `/api/authorization/effective/${tenantBUser.id}`,
      { token: adminToken }
    );
    assert.equal(crossTenant.status, 404);

    const scoped = await request(
      port,
      "GET",
      `/api/authorization/effective/${tenantBUser.id}`,
      { token: adminToken, headers: { "x-tenant-id": String(tenantB.id) } }
    );
    assert.equal(scoped.status, 200);
    assert.equal(scoped.body.principal.id, tenantBUser.id);
  });

  test("cross-tenant access with iam.users:read is denied", async () => {
    const response = await request(
      port,
      "GET",
      `/api/authorization/effective/${operator.id}`,
      { token: tenantBToken }
    );
    assert.equal(response.status, 404);
  });

  test("a non-admin cannot spoof the tenant header", async () => {
    const response = await request(
      port,
      "GET",
      `/api/authorization/effective/${tenantBUser.id}`,
      { token: operatorToken, headers: { "x-tenant-id": String(tenantB.id) } }
    );
    assert.equal(response.status, 403);
  });

  test("malformed and missing principal identities fail closed", async () => {
    const malformed = await request(
      port,
      "GET",
      "/api/authorization/effective/not-a-number",
      { token: adminToken }
    );
    assert.equal(malformed.status, 400);

    const zero = await request(port, "GET", "/api/authorization/effective/0", {
      token: adminToken,
    });
    assert.equal(zero.status, 400);

    const anonymous = await request(port, "GET", `/api/authorization/effective/${admin.id}`);
    assert.equal(anonymous.status, 401);
  });

  test("legacy decision probe requires the security-decision permission", async () => {
    const denied = await request(port, "POST", "/api/authorization/check", {
      token: operatorToken,
      body: { userId: operator.id, resource: "iam.users", action: "read" },
    });
    assert.equal(denied.status, 403);

    const allowed = await request(port, "POST", "/api/authorization/check", {
      token: adminToken,
      body: { userId: operator.id, resource: "iam.users", action: "read" },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.allowed, true);
  });

  test("legacy decision probe is tenant scoped and validates the subject", async () => {
    const crossTenant = await request(port, "POST", "/api/authorization/check", {
      token: adminToken,
      body: { userId: tenantBUser.id, resource: "iam.users", action: "read" },
    });
    assert.equal(crossTenant.status, 404);

    const scoped = await request(port, "POST", "/api/authorization/check", {
      token: adminToken,
      headers: { "x-tenant-id": String(tenantB.id) },
      body: { userId: tenantBUser.id, resource: "iam.users", action: "read" },
    });
    assert.equal(scoped.status, 200);
    assert.equal(scoped.body.allowed, true);

    const malformed = await request(port, "POST", "/api/authorization/check", {
      token: adminToken,
      body: { userId: "abc", resource: "iam.users", action: "read" },
    });
    assert.equal(malformed.status, 400);

    const missing = await request(port, "POST", "/api/authorization/check", {
      token: adminToken,
      body: { resource: "iam.users", action: "read" },
    });
    assert.equal(missing.status, 400);
  });

  test("legacy decision probe rejects a cross-tenant organization context", async () => {
    const response = await request(port, "POST", "/api/authorization/check", {
      token: adminToken,
      body: {
        userId: admin.id,
        resource: "iam.users",
        action: "read",
        organizationId: queryOne(
          db,
          "SELECT id FROM organizations WHERE code = 'tenant-b-org'"
        ).id,
      },
    });
    assert.equal(response.status, 404);
  });
});

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function request(port, method, path, { token, body } = {}) {
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
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("REST APIs", () => {
  let port;
  let server;
  let token;

  before(async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    seedDatabase(database);
    const app = createApp(database);
    const started = await listen(app);
    server = started.server;
    port = started.port;
    const login = await request(port, "POST", "/api/auth/login", {
      body: { username: "admin", password: "HelixAdmin!42" },
    });
    assert.equal(login.status, 200);
    token = login.body.token;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("health", async () => {
    const res = await request(port, "GET", "/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  test("rejects unauthenticated list", async () => {
    const res = await request(port, "GET", "/api/users");
    assert.equal(res.status, 401);
  });

  test("lists, creates, filters users", async () => {
    const list = await request(port, "GET", "/api/users?q=admin&pageSize=10", { token });
    assert.equal(list.status, 200);
    assert.ok(list.body.total >= 1);

    const created = await request(port, "POST", "/api/users", {
      token,
      body: {
        username: "n.garcia",
        email: "n.garcia@helix.example",
        employee_id: "EMP-0400",
        display_name: "Nova Garcia",
        password: "HelixUser!99",
      },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const deactivated = await request(port, "POST", `/api/users/${id}/deactivate`, { token });
    assert.equal(deactivated.body.status, "inactive");
    const activated = await request(port, "POST", `/api/users/${id}/activate`, { token });
    assert.equal(activated.body.status, "active");
    const locked = await request(port, "POST", `/api/users/${id}/lock`, { token });
    assert.equal(locked.body.status, "locked");
    const unlocked = await request(port, "POST", `/api/users/${id}/unlock`, { token });
    assert.equal(unlocked.body.status, "active");
  });

  test("groups CRUD and members", async () => {
    const created = await request(port, "POST", "/api/groups", {
      token,
      body: { code: "sec-ops", name: "Security Operations", description: "SOC" },
    });
    assert.equal(created.status, 201);
    const users = await request(port, "GET", "/api/users?q=j.patel", { token });
    const userId = users.body.items[0].id;
    const added = await request(port, "POST", `/api/groups/${created.body.id}/members`, {
      token,
      body: { userId },
    });
    assert.equal(added.status, 200);
    assert.ok(added.body.items.some((m) => m.id === userId));
    const detail = await request(port, "GET", `/api/groups/${created.body.id}`, { token });
    assert.equal(detail.body.code, "sec-ops");
  });

  test("roles assignment and principal access API", async () => {
    const role = await request(port, "POST", "/api/roles", {
      token,
      body: { code: "finance.viewer", name: "Finance Viewer" },
    });
    assert.equal(role.status, 201);
    const usersList = await request(port, "GET", "/api/users?q=j.patel", { token });
    const userId = usersList.body.items[0].id;
    const assigned = await request(port, "POST", `/api/users/${userId}/roles`, {
      token,
      body: { roleId: role.body.id, organizationId: 0 },
    });
    assert.equal(assigned.status, 200);
    const access = await request(port, "GET", `/api/iam/principals/${userId}/access`, { token });
    assert.equal(access.status, 200);
    assert.ok(access.body.roles.some((r) => r.code === "finance.viewer"));
    assert.ok(access.body.principal.username === "j.patel");
  });

  test("password policy and audit log", async () => {
    const current = await request(port, "GET", "/api/password-policy", { token });
    assert.equal(current.status, 200);
    const updated = await request(port, "PUT", "/api/password-policy", {
      token,
      body: { min_length: 12 },
    });
    assert.equal(updated.body.min_length, 12);
    const logs = await request(port, "GET", "/api/audit-logs?pageSize=50", { token });
    assert.equal(logs.status, 200);
    assert.ok(logs.body.total > 0);
  });

  test("permissions catalog, role grants and authorization check", async () => {
    const perms = await request(port, "GET", "/api/permissions?pageSize=50", { token });
    assert.equal(perms.status, 200);
    assert.ok(perms.body.total > 0);

    const matrix = await request(port, "GET", "/api/permissions/matrix", { token });
    assert.equal(matrix.status, 200);
    assert.ok(matrix.body.roles.length > 0);
    assert.ok(matrix.body.permissions.length > 0);

    const rolesList = await request(port, "GET", "/api/roles?q=app.reader", { token });
    const reader = rolesList.body.items.find((r) => r.code === "app.reader");
    const grantsRes = await request(port, "GET", `/api/roles/${reader.id}/permissions`, { token });
    assert.equal(grantsRes.status, 200);
    assert.ok(grantsRes.body.items.length > 0);

    const usersList = await request(port, "GET", "/api/users?q=j.patel", { token });
    const userId = usersList.body.items[0].id;
    const allowed = await request(port, "POST", "/api/authorization/check", {
      token,
      body: { userId, resource: "iam.users", action: "read" },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.allowed, true);

    const denied = await request(port, "POST", "/api/authorization/check", {
      token,
      body: { userId, resource: "finance.ledger", action: "delete" },
    });
    assert.equal(denied.status, 200);
    assert.equal(denied.body.allowed, false);

    const effective = await request(port, "GET", `/api/authorization/effective/${userId}`, { token });
    assert.equal(effective.status, 200);
    assert.ok(Array.isArray(effective.body.permissions));
  });

  test("fail-safe deny on unauthorized mutation", async () => {
    const login = await request(port, "POST", "/api/auth/login", {
      body: { username: "j.patel", password: "HelixUser!42" },
    });
    assert.equal(login.status, 200);
    const readerToken = login.body.token;
    const read = await request(port, "GET", "/api/users?pageSize=1", { token: readerToken });
    assert.equal(read.status, 200);
    const create = await request(port, "POST", "/api/users", {
      token: readerToken,
      body: {
        username: "blocked.user",
        email: "blocked@helix.example",
        employee_id: "EMP-9999",
        display_name: "Blocked",
        password: "HelixUser!99",
      },
    });
    assert.equal(create.status, 403);
  });

  test("organizations and sites CRUD", async () => {
    const list = await request(port, "GET", "/api/organizations?pageSize=50", { token });
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((o) => o.code === "corp-hq"));
    const emea = list.body.items.find((o) => o.code === "emea");
    const site = await request(port, "POST", `/api/organizations/${emea.id}/sites`, {
      token,
      body: { code: "emea-paris", name: "Paris Office" },
    });
    assert.equal(site.status, 201);
    assert.equal(site.body.kind, "site");
    const detail = await request(port, "GET", `/api/organizations/${emea.id}`, { token });
    assert.ok(detail.body.children.some((c) => c.code === "emea-paris"));
  });

  test("typed org collections, tree, members and context", async () => {
    const companies = await request(port, "GET", "/api/companies", { token });
    assert.equal(companies.status, 200);
    assert.ok(companies.body.items.some((o) => o.code === "emea" && o.kind === "company"));
    const sites = await request(port, "GET", "/api/sites", { token });
    assert.ok(sites.body.items.some((o) => o.code === "emea-london"));
    const depts = await request(port, "GET", "/api/departments", { token });
    assert.ok(depts.body.items.some((o) => o.kind === "department"));
    const tree = await request(port, "GET", "/api/organizations/tree", { token });
    assert.equal(tree.status, 200);
    assert.equal(tree.body.items[0].kind, "tenant");
    assert.equal(tree.body.items[0].code, "helix");
    const london = sites.body.items.find((o) => o.code === "emea-london");
    const users = await request(port, "GET", "/api/users?q=j.patel", { token });
    const operator = users.body.items.find((u) => u.username === "j.patel");
    const member = await request(port, "POST", `/api/organizations/${london.id}/members`, {
      token,
      body: { userId: operator.id },
    });
    assert.ok([200, 201].includes(member.status));
    const ctx = await request(port, "GET", `/api/organizations/${london.id}/context`, { token });
    assert.equal(ctx.status, 200);
    assert.equal(ctx.body.organization.kind, "site");
    assert.ok(ctx.body.path.includes("emea-london"));
  });

  test("super admin can change hierarchy properties; readers cannot", async () => {
    const current = await request(port, "GET", "/api/platform/hierarchy", { token });
    assert.equal(current.status, 200);
    assert.ok(current.body.levels.some((l) => l.code === "site"));
    const allowedParents = { ...current.body.allowedParents, region: ["enterprise", "organization"] };
    const updated = await request(port, "PUT", "/api/platform/hierarchy", {
      token,
      body: {
        levels: [
          ...current.body.levels,
          { code: "region", name: "Region", sort_order: 15, allow_root: 0, collection: "regions", active: 1 },
        ],
        allowedParents,
      },
    });
    assert.equal(updated.status, 200);
    assert.ok(updated.body.levels.some((l) => l.code === "region"));
    const settings = await request(port, "PUT", "/api/platform/settings", {
      token,
      body: { values: { "identity.session_hours": 8 } },
    });
    assert.equal(settings.status, 200);
    assert.equal(settings.body.values["identity.session_hours"], 8);

    const login = await request(port, "POST", "/api/auth/login", {
      body: { username: "j.patel", password: "HelixUser!42" },
    });
    const denied = await request(port, "PUT", "/api/platform/hierarchy", {
      token: login.body.token,
      body: current.body,
    });
    assert.equal(denied.status, 403);
  });

  test("authentication login, sessions, providers and MFA challenge APIs", async () => {
    const login = await request(port, "POST", "/api/authentication/login", {
      body: { username: "admin", password: "HelixAdmin!42" },
    });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
    assert.equal(login.body.user.password_hash, undefined);

    const mine = await request(port, "GET", "/api/sessions", { token: login.body.token });
    assert.equal(mine.status, 200);
    assert.ok(mine.body.items.length >= 1);
    assert.equal(mine.body.items[0].token, undefined);

    const pub = await request(port, "GET", "/api/authentication/providers");
    assert.equal(pub.status, 200);
    assert.ok(pub.body.items.some((p) => p.type === "password"));

    const created = await request(port, "POST", "/api/authentication/providers", {
      token,
      body: {
        code: "partner-oidc",
        name: "Partner OIDC",
        type: "oidc",
        client_secret: "not-in-response",
        config: { issuer: "https://partner.example", client_id: "helix" },
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.config.client_secret, undefined);
    assert.equal(created.body.config.client_secret_configured, true);

    const start = await request(port, "POST", "/api/sso/partner-oidc/start", { body: {} });
    assert.equal(start.status, 200);
    assert.ok(start.body.authorizationUrl);

    const enroll = await request(port, "POST", "/api/mfa/totp/enroll", { token: login.body.token });
    assert.equal(enroll.status, 200);
    assert.ok(enroll.body.secret);

    const reset = await request(port, "POST", "/api/authentication/password-reset/request", {
      body: { username: "no.such.user" },
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.ok, true);
    assert.equal(reset.body.token, undefined);

    const reader = await request(port, "POST", "/api/auth/login", {
      body: { username: "j.patel", password: "HelixUser!42" },
    });
    const deniedSettings = await request(port, "GET", "/api/authentication/settings", {
      token: reader.body.token,
    });
    assert.equal(deniedSettings.status, 403);
  });

  test("tenant catalog, context, isolation and audited switches", async () => {
    const list = await request(port, "GET", "/api/tenants", { token });
    assert.equal(list.status, 200);
    const helix = list.body.items.find((t) => t.code === "helix");
    assert.ok(helix);
    assert.ok(helix.org_count > 0);

    const ctx = await request(port, "GET", `/api/tenants/${helix.id}/context`, { token });
    assert.equal(ctx.status, 200);
    assert.equal(ctx.body.tenant.code, "helix");

    const created = await request(port, "POST", "/api/tenants", {
      token,
      body: { code: "acme-api", name: "Acme API" },
    });
    assert.equal(created.status, 201);
    const acme = created.body;

    const acmeOrgs = await request(port, "GET", `/api/organizations?tenantId=${acme.id}`, { token });
    assert.equal(acmeOrgs.status, 200);
    assert.equal(acmeOrgs.body.total, 1);

    const acmeEnterprise = await request(port, "POST", `/api/organizations?tenantId=${acme.id}`, {
      token,
      body: { code: "acme-ent", name: "Acme Enterprise", kind: "enterprise", parent_id: acme.id },
    });
    assert.equal(acmeEnterprise.status, 201);
    assert.equal(acmeEnterprise.body.tenant_id, acme.id);

    const scoped = await request(port, "GET", `/api/organizations?tenantId=${acme.id}`, { token });
    assert.equal(scoped.body.total, 2);

    const helixOrgs = await request(port, "GET", `/api/organizations?tenantId=${helix.id}`, { token });
    assert.ok(helixOrgs.body.total > 1);

    const foreign = await request(port, "GET", `/api/organizations/${acmeEnterprise.body.id}?tenantId=${helix.id}`, {
      token,
    });
    assert.equal(foreign.status, 404);

    const tenantScoped = await request(port, "GET", `/api/organizations?tenantId=${acme.id}`, {
      token: (await request(port, "POST", "/api/auth/login", {
        body: { username: "j.patel", password: "HelixUser!42" },
      })).body.token,
    });
    assert.equal(tenantScoped.status, 403);

    const events = await request(port, "GET", "/api/audit-logs?action=tenant.context.switch", { token });
    assert.equal(events.status, 200);
    assert.ok(events.body.items.length >= 1);
  });

  test("scoped configuration precedence over the API", async () => {
    const tenantsRes = await request(port, "GET", "/api/tenants", { token });
    const helix = tenantsRes.body.items.find((t) => t.code === "helix");
    const catalog = await request(port, "GET", "/api/config", { token });
    assert.equal(catalog.status, 200);
    assert.ok(catalog.body.definitions.some((d) => d.key === "identity.session_hours"));

    const save = await request(port, "PUT", `/api/tenants/${helix.id}/config`, {
      token,
      body: { values: { "identity.session_hours": 8 } },
    });
    assert.equal(save.status, 200);
    const tenantScoped = await request(port, "GET", `/api/config?tenantId=${helix.id}`, { token });
    const resolved = tenantScoped.body.effective.find((e) => e.key === "identity.session_hours");
    assert.equal(resolved.value, 8);
    assert.equal(resolved.source, "tenant");

    const systemOnly = await request(port, "PUT", `/api/tenants/${helix.id}/config`, {
      token,
      body: { values: { "auth.rate_limit_max": 42 } },
    });
    assert.equal(systemOnly.status, 400);
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as orgs from "../services/orgs.js";
import * as tenants from "../services/tenants.js";
import * as config from "../services/config.js";
import * as hierarchy from "../services/hierarchy.js";
import { HttpError } from "../validation.js";
import { queryOne } from "../db.js";

function db() {
  const database = openDatabase(":memory:");
  migrate(database);
  seedDatabase(database);
  return database;
}

describe("tenants", () => {
  test("seed creates the helix tenant above corp-hq", () => {
    const database = db();
    const helix = queryOne(database, "SELECT * FROM organizations WHERE code = 'helix'");
    const hq = queryOne(database, "SELECT * FROM organizations WHERE code = 'corp-hq'");
    assert.equal(helix.kind, "tenant");
    assert.equal(hq.kind, "enterprise");
    assert.equal(hq.parent_id, helix.id);
    assert.equal(hq.tenant_id, helix.id);
    assert.equal(helix.tenant_id, helix.id);
  });

  test("every seeded org is stamped with the helix tenant", () => {
    const database = db();
    const helix = queryOne(database, "SELECT * FROM organizations WHERE code = 'helix'");
    const unstamped = database
      .prepare("SELECT COUNT(*) AS c FROM organizations WHERE id != ? AND (tenant_id IS NULL OR tenant_id != ?)")
      .get(helix.id, helix.id).c;
    assert.equal(unstamped, 0);
    const london = queryOne(database, "SELECT * FROM organizations WHERE code = 'emea-london'");
    assert.equal(london.tenant_id, helix.id);
  });

  test("tenant administration counts and context", () => {
    const database = db();
    const helix = tenants.listTenants(database).items.find((t) => t.code === "helix");
    assert.ok(helix.org_count > 0);
    assert.ok(helix.user_count > 0);
    const ctx = tenants.tenantContext(database, helix.id);
    assert.equal(ctx.tenant.code, "helix");
    const flatten = (nodes) => nodes.flatMap((n) => [n, ...flatten(n.children || [])]);
    assert.ok(flatten(ctx.tree).some((node) => node.code === "corp-hq"));
    assert.ok(ctx.organizationIds.includes(ctx.tenant.id));
  });

  test("platform tenant creation and status changes audit", () => {
    const database = db();
    const actor = { id: 1, username: "admin" };
    const created = tenants.createTenant(
      database,
      { code: "acme", name: "Acme" },
      actor,
      "127.0.0.1"
    );
    assert.equal(created.kind, "tenant");
    assert.equal(created.status, "active");
    const inactive = tenants.setTenantStatus(database, created.id, "inactive", actor, "127.0.0.1");
    assert.equal(inactive.status, "inactive");
    const events = database
      .prepare("SELECT action FROM audit_logs WHERE resource_type = 'tenant' ORDER BY id")
      .all()
      .map((r) => r.action);
    assert.ok(events.includes("tenant.create"));
    assert.ok(events.includes("tenant.inactive"));
  });

  test("cross-tenant move is rejected", () => {
    const database = db();
    const actor = { id: 1, username: "admin" };
    const other = tenants.createTenant(database, { code: "globex", name: "Globex" }, actor, "127.0.0.1");
    const companies = orgs.listOrganizations(database, { kind: "company" }).items;
    assert.ok(companies.length > 0);
    assert.throws(
      () => orgs.moveOrganization(database, companies[0].id, other.id, actor, "127.0.0.1"),
      (err) => err instanceof HttpError && err.status === 409
    );
  });

  test("organization lookup is isolated by tenant", () => {
    const database = db();
    const actor = { id: 1, username: "admin" };
    const other = tenants.createTenant(database, { code: "initech", name: "Initech" }, actor, "127.0.0.1");
    const site = orgs.listOrganizations(database, { kind: "site" }).items[0];
    assert.doesNotThrow(() => orgs.getOrganization(database, site.id));
    assert.throws(
      () => orgs.getOrganization(database, site.id, { tenantId: other.id }),
      (err) => err instanceof HttpError && err.status === 404
    );
  });

  test("cross-tenant membership is rejected", () => {
    const database = db();
    const actor = { id: 1, username: "admin" };
    const other = tenants.createTenant(database, { code: "umbrella", name: "Umbrella" }, actor, "127.0.0.1");
    const company = orgs.createOrganization(
      database,
      { code: "umb-co", name: "Umbrella Co", kind: "company", parent_id: other.id },
      actor,
      "127.0.0.1"
    );
    const user = database.prepare("SELECT id FROM users WHERE username = 'j.patel'").get();
    assert.throws(
      () => orgs.addMember(database, company.id, user.id, 0, actor, "127.0.0.1"),
      (err) => err instanceof HttpError && err.status === 409
    );
  });
});

describe("scoped configuration", () => {
  test("precedence is default, then system, tenant, organization", () => {
    const database = db();
    const actor = { id: 1, username: "admin" };
    const helix = tenants.listTenants(database).items.find((t) => t.code === "helix");
    const site = orgs.listOrganizations(database, { kind: "site" }).items[0];

    hierarchy.updateSettings(database, { "identity.session_hours": 24 }, actor, "127.0.0.1");
    let resolved = config.resolveConfig(database, "identity.session_hours", { tenantId: helix.id });
    assert.equal(resolved.value, 24);
    assert.equal(resolved.source, "system");

    config.putValues(
      database,
      { scope: "tenant", scopeId: helix.id, values: { "identity.session_hours": 8 } },
      actor,
      "127.0.0.1"
    );
    resolved = config.resolveConfig(database, "identity.session_hours", { tenantId: helix.id });
    assert.equal(resolved.value, 8);
    assert.equal(resolved.source, "tenant");

    config.putValues(
      database,
      { scope: "organization", scopeId: site.id, values: { "org.allow_multi_site": false } },
      actor,
      "127.0.0.1"
    );
    resolved = config.resolveConfig(database, "org.allow_multi_site", {
      tenantId: helix.id,
      organizationId: site.id,
    });
    assert.equal(resolved.value, false);
    assert.equal(resolved.source, "organization");

    const org = orgs.listOrganizations(database, { kind: "company" }).items[0];
    resolved = config.resolveConfig(database, "org.allow_multi_site", { organizationId: org.id });
    assert.equal(resolved.value, true);
    assert.equal(resolved.source, "system");
  });

  test("rejects unknown keys, system-only overrides and invalid values", () => {
    const database = db();
    const actor = { id: 1, username: "admin" };
    const helix = tenants.listTenants(database).items.find((t) => t.code === "helix");
    assert.throws(
      () => config.putValues(database, { scope: "tenant", scopeId: helix.id, values: { "nope.key": 1 } }, actor, ""),
      (err) => err instanceof HttpError && err.status === 400
    );
    assert.throws(
      () =>
        config.putValues(
          database,
          { scope: "tenant", scopeId: helix.id, values: { "auth.rate_limit_max": 50 } },
          actor,
          ""
        ),
      (err) => err instanceof HttpError && err.status === 400
    );
    assert.throws(
      () =>
        config.putValues(
          database,
          { scope: "tenant", scopeId: helix.id, values: { "identity.session_hours": 9999 } },
          actor,
          ""
        ),
      (err) => err instanceof HttpError && err.status === 400
    );
  });

  test("tenant-scoped keys cannot be set at organization scope when not allowed", () => {
    const database = db();
    const actor = { id: 1, username: "admin" };
    const site = orgs.listOrganizations(database, { kind: "site" }).items[0];
    assert.throws(
      () =>
        config.putValues(
          database,
          { scope: "organization", scopeId: site.id, values: { "auth.mfa_required": true } },
          actor,
          ""
        ),
      (err) => err instanceof HttpError && err.status === 400
    );
  });
});

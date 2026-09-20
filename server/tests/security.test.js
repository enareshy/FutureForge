process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate, queryOne, run } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import * as search from "../services/search.js";
import * as security from "../services/security/index.js";
import { ensureSecurityFoundation } from "../services/security/foundation.js";

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
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
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const data = Buffer.concat(chunks).toString("utf8");
          let parsed = data;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function actorRow(db, username) {
  return queryOne(db, "SELECT * FROM users WHERE username = ?", [username]);
}

describe("Data Security & Entitlement Model services", () => {
  let db;
  let admin;
  let user;
  let tenantId;
  let orgA;
  let orgB;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    admin = actorRow(db, "admin");
    user = actorRow(db, "j.patel");
    tenantId = admin.tenant_id ?? admin.organization_id;
    search.initializeSearch(db);
    ensureSecurityFoundation(db);

    const orgs = db.prepare("SELECT id, kind FROM organizations WHERE tenant_id = ? ORDER BY id").all(tenantId);
    const plantsOrUnits = orgs.filter((o) => o.kind !== "tenant");
    orgA = (plantsOrUnits[0] || orgs[0]).id;
    orgB = (plantsOrUnits[1] || plantsOrUnits[0] || orgs[0]).id;
  });

  after(() => {
    db?.close();
  });

  test("masking engine supports every strategy", () => {
    const { applyMasking } = security;
    assert.deepEqual(applyMasking("HIDE", "secret").hidden, true);
    assert.equal(applyMasking("NULL", "secret").value, null);
    assert.equal(applyMasking("REDACT", "secret", { replacement: "X" }).value, "X");
    assert.equal(applyMasking("FIXED_MASK", "secret", { mask: "###" }).value, "###");
    assert.equal(applyMasking("PARTIAL", "1234567890", { visible_start: 2, visible_end: 2 }).value, "12******90");
    const hash = applyMasking("HASH", "secret", { salt: "s", length: 8 }).value;
    assert.equal(hash.length, 8);
    assert.notEqual(hash, "secret");
  });

  test("condition evaluator is deterministic and fails closed", () => {
    const { evaluateCondition } = security;
    const ctx = { request: { authentication_method: "sso" }, subject: { roles: ["reader"] } };
    assert.equal(evaluateCondition({ field: "request.authentication_method", operator: "eq", value: "sso" }, ctx), true);
    assert.equal(evaluateCondition({ field: "request.authentication_method", operator: "eq", value: "password" }, ctx), false);
    assert.equal(evaluateCondition({ field: "subject.roles", operator: "contains", value: "reader" }, ctx), true);
    assert.equal(evaluateCondition({ field: "missing.field", operator: "eq", value: 1 }, ctx), false);
  });

  test("denies cross-tenant access with TENANT_DENIED", () => {
    const decision = security.authorizeRequest(db, user, {
      action: "read",
      resource: { type: "report_doc", id: "r1", tenantId: tenantId + 999 },
      options: { tenantId, cache: false },
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, security.DECISION_REASONS.TENANT_DENIED);
  });

  test("explicit entitlement deny overrides the permission model", () => {
    security.createEntitlement(
      db,
      {
        subject_type: "user",
        subject_id: user.id,
        resource_type: "billing_doc",
        action: "read",
        effect: "deny",
        scope: "object_type",
      },
      admin,
      tenantId
    );
    const decision = security.authorizeRequest(db, user, {
      action: "read",
      resource: { type: "billing_doc", id: "b1" },
      options: { tenantId, cache: false },
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, security.DECISION_REASONS.ENTITLEMENT_DENIED);
  });

  test("explicit entitlement allow grants access", () => {
    security.createEntitlement(
      db,
      {
        subject_type: "user",
        subject_id: user.id,
        resource_type: "report_doc",
        action: "read",
        effect: "allow",
        scope: "object_type",
      },
      admin,
      tenantId
    );
    const decision = security.authorizeRequest(db, user, {
      action: "read",
      resource: { type: "report_doc", id: "r1" },
      options: { tenantId, cache: false },
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, security.DECISION_REASONS.ENTITLEMENT_ALLOWED);
  });

  test("classification rules deny restricted resources", () => {
    security.createClassificationRule(
      db,
      {
        classification: "restricted",
        subject_type: "user",
        subject_id: user.id,
        resource_type: "class_doc",
        action: "read",
        effect: "deny",
      },
      admin,
      tenantId
    );
    const decision = security.authorizeRequest(db, user, {
      action: "read",
      resource: { type: "class_doc", id: "c1", classification: "restricted" },
      options: { tenantId, cache: false },
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, security.DECISION_REASONS.CLASSIFICATION_DENIED);
  });

  test("policies support attribute conditions", () => {
    security.createPolicy(
      db,
      {
        code: "sso_only_report",
        name: "SSO only",
        scope: "object_type",
        subject_type: "everyone",
        resource_type: "policy_doc",
        action: "read",
        effect: "allow",
        priority: 500,
        condition: { field: "request.authentication_method", operator: "eq", value: "sso" },
      },
      admin,
      tenantId
    );
    const withSso = security.authorizeRequest(db, user, {
      action: "read",
      resource: { type: "policy_doc", id: "p1" },
      options: { tenantId, cache: false, authenticationMethod: "sso" },
    });
    assert.equal(withSso.allowed, true);
    const withPassword = security.authorizeRequest(db, user, {
      action: "read",
      resource: { type: "policy_doc", id: "p1" },
      options: { tenantId, cache: false, authenticationMethod: "password" },
    });
    assert.equal(withPassword.allowed, false);
  });

  test("field rules mask documents before serialization", () => {
    security.createFieldRule(
      db,
      {
        object_type: "secure_doc",
        field_name: "summary",
        action: "read",
        subject_type: "everyone",
        effect: "mask",
        masking_strategy: "PARTIAL",
        masking_config: { visible_start: 2, visible_end: 0 },
      },
      admin,
      tenantId
    );
    const decision = security.authorizeRequest(db, user, {
      action: "read",
      resource: { type: "secure_doc", id: "s1" },
      options: { tenantId, cache: false },
    });
    const masked = security.maskWithDecision({ summary: "topsecret" }, decision);
    assert.match(masked.summary, /^to\*+$/);
    assert.notEqual(masked.summary, "topsecret");
  });

  test("row level security filters search results by organization", () => {
    search.registerObjectType(
      db,
      {
        code: "secure_doc",
        name: "Secure documents",
        title_attribute: "title",
        permission_resource: "iam.search.global",
      },
      admin,
      tenantId,
      "127.0.0.1"
    );
    security.registerObjectType(db, { object_type: "secure_doc", enforcement: "entitlement" }, admin, tenantId);

    const insert = (objectId, title, organizationId, classification) =>
      run(
        db,
        `INSERT INTO search_index
           (tenant_id, organization_id, site_id, object_type, object_id, title, searchable_text, classification, indexed_at, updated_at)
         VALUES (?, ?, NULL, 'secure_doc', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [tenantId, organizationId, objectId, title, `${title} secret memo`, classification]
      );
    insert("sd-1", "Alpha secret plan", orgA, "internal");
    insert("sd-2", "Beta secret plan", orgB, "internal");

    security.createOrganizationRule(
      db,
      {
        subject_type: "user",
        subject_id: user.id,
        resource_type: "secure_doc",
        action: "read",
        organization_id: orgA,
        scope_mode: "specific",
        include_descendants: false,
        effect: "allow",
      },
      admin,
      tenantId
    );

    const userResult = search.search(db, { text: "secret plan", object_types: ["secure_doc"] }, user, {
      tenantId,
      recordHistory: false,
    });
    assert.equal(userResult.total, 1);
    assert.ok(userResult.items.every((item) => item.organization_id === orgA));

    const adminResult = search.search(db, { text: "secret plan", object_types: ["secure_doc"] }, admin, {
      tenantId,
      recordHistory: false,
    });
    assert.equal(adminResult.total, 2);
  });

  test("search suggestions respect row level security", () => {
    const userSuggestions = search.getSuggestions(
      db,
      { text: "secret plan", object_types: ["secure_doc"], limit: 10 },
      user,
      { tenantId }
    );
    const userTitles = userSuggestions.suggestions.filter((item) => item.type === "title").map((item) => item.text);
    assert.ok(userTitles.includes("Alpha secret plan"));
    assert.ok(!userTitles.includes("Beta secret plan"));

    const adminSuggestions = search.getSuggestions(
      db,
      { text: "secret plan", object_types: ["secure_doc"], limit: 10 },
      admin,
      { tenantId }
    );
    const adminTitles = adminSuggestions.suggestions.filter((item) => item.type === "title").map((item) => item.text);
    assert.ok(adminTitles.includes("Alpha secret plan"));
    assert.ok(adminTitles.includes("Beta secret plan"));
  });

  test("search masks protected fields in returned items", () => {
    const result = search.search(db, { text: "secret plan", object_types: ["secure_doc"] }, admin, {
      tenantId,
      recordHistory: false,
    });
    assert.ok(result.total >= 1);
    assert.ok(result.items.every((item) => item.__masked || item.summary === undefined || item.summary !== "topsecret"));
  });

  test("decision journal records authorization outcomes", () => {
    const decision = security.authorizeRequest(db, user, {
      action: "read",
      resource: { type: "billing_doc", id: "b1" },
      options: { tenantId, cache: false, journal: true },
    });
    assert.equal(decision.allowed, false);
    const decisions = security.listDecisions(db, tenantId, { limit: 10 });
    assert.ok(decisions.length >= 1);
    assert.ok(decisions[0].steps.length > 0);
  });
});

describe("Data Security REST APIs", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let userToken;
  let tenantId;

  before(async () => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;
    const admin = queryOne(db, "SELECT * FROM users WHERE username = 'admin'");
    tenantId = admin.tenant_id ?? admin.organization_id;
    search.reindexTenant(db, { tenantId, limit: 1000 }, admin, "test");
    adminToken = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
    userToken = (await request(port, "POST", "/api/auth/login", { body: { username: "j.patel", password: "HelixUser!42" } })).body.token;
  });

  after(() => {
    server?.close();
    db?.close();
  });

  test("admin can read the security overview and vocabulary", async () => {
    const overview = await request(port, "GET", "/api/v1/security/overview", { token: adminToken });
    assert.equal(overview.status, 200);
    assert.ok(overview.body.objectTypes >= 1);

    const vocab = await request(port, "GET", "/api/v1/security/vocabulary", { token: adminToken });
    assert.equal(vocab.status, 200);
    assert.ok(vocab.body.maskingStrategies.includes("HASH"));
  });

  test("non-admin without the permission cannot administer security", async () => {
    const res = await request(port, "GET", "/api/v1/security/overview", { token: userToken });
    assert.equal(res.status, 403);
  });

  test("policy lifecycle and authorization debugger", async () => {
    const created = await request(port, "POST", "/api/v1/security/policies", {
      token: adminToken,
      body: {
        code: "api_allow_export",
        name: "Allow export for admins",
        scope: "object_type",
        action: "export",
        resource_type: "object",
        effect: "allow",
        priority: 400,
        subject_type: "everyone",
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "api_allow_export");

    const list = await request(port, "GET", "/api/v1/security/policies", { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.some((policy) => policy.code === "api_allow_export"));

    const evaluated = await request(port, "POST", "/api/v1/security/evaluate", {
      token: adminToken,
      body: { action: "read", resource_type: "object", resource_id: 1 },
    });
    assert.equal(evaluated.status, 200);
    assert.ok(evaluated.body.reason);

    const decisions = await request(port, "GET", "/api/v1/security/decisions", { token: adminToken });
    assert.equal(decisions.status, 200);
    assert.ok(Array.isArray(decisions.body));
  });

  test("object type registration and entitlement APIs", async () => {
    const registered = await request(port, "POST", "/api/v1/security/object-types", {
      token: adminToken,
      body: { object_type: "api_doc", enforcement: "entitlement", permission_resource: "iam.search.global" },
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.enforcement, "entitlement");

    const entitlement = await request(port, "POST", "/api/v1/security/entitlements", {
      token: adminToken,
      body: {
        subject_type: "everyone",
        resource_type: "api_doc",
        action: "read",
        effect: "allow",
        scope: "object_type",
      },
    });
    assert.equal(entitlement.status, 201);
    assert.equal(entitlement.body.effect, "allow");
  });

  test("batch evaluation preserves order across both surfaces", async () => {
    const adminUser = queryOne(db, "SELECT id FROM users WHERE username = 'admin'");
    const batch = await request(port, "POST", "/api/v1/security/evaluate/batch", {
      token: adminToken,
      body: {
        requests: [
          { action: "read", resource_type: "object", resource_id: 1 },
          { action: "read", resource_type: "api_doc", resource_id: 2 },
          { action: "delete", resource_type: "object", resource_id: 3 },
        ],
      },
    });
    assert.equal(batch.status, 200);
    assert.equal(batch.body.count, 3);
    assert.equal(batch.body.decisions.length, 3);
    assert.deepEqual(
      batch.body.decisions.map((decision) => decision.resource.id),
      [1, 2, 3]
    );

    const checked = await request(port, "POST", "/api/v1/authorization/batch-check", {
      token: adminToken,
      body: { requests: [{ action: "READ", resource: { type: "object", id: 7 } }] },
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.body.count, 1);
    assert.equal(checked.body.decisions[0].action, "read");
    assert.equal(checked.body.decisions[0].resource.id, 7);

    const single = await request(port, "POST", "/api/v1/authorization/check", {
      token: adminToken,
      body: { subject: adminUser.id, action: "read", resource: { type: "object", id: 1 } },
    });
    assert.equal(single.status, 200);
    assert.equal(single.body.action, "read");

    const rejected = await request(port, "POST", "/api/v1/security/evaluate/batch", {
      token: adminToken,
      body: { requests: Array.from({ length: 501 }, (_, i) => ({ action: "read", resource_type: "object", resource_id: i })) },
    });
    assert.equal(rejected.status, 400);
  });
});

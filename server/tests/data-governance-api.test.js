process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";

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
          ...(payload !== null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

describe("Data Governance & Data Quality REST APIs", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;

  before(async () => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;
    adminToken = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
    readerToken = (await request(port, "POST", "/api/auth/login", { body: { username: "j.patel", password: "HelixUser!42" } })).body.token;
  });

  after(() => {
    server?.close();
    db?.close();
  });

  test("requires authentication", async () => {
    const res = await request(port, "GET", "/api/v1/data-quality/rules");
    assert.equal(res.status, 401);
  });

  test("serves governance and quality vocabularies", async () => {
    const governance = await request(port, "GET", "/api/v1/data-governance/meta", { token: adminToken });
    assert.equal(governance.status, 200);
    assert.equal(governance.body.source_module, "data-governance");
    assert.ok(governance.body.vocabularies.policy_statuses.includes("active"));

    const quality = await request(port, "GET", "/api/v1/data-quality/meta", { token: adminToken });
    assert.equal(quality.status, 200);
    assert.ok(quality.body.vocabularies.rule_types.includes("REQUIRED"));
    assert.ok(quality.body.duplicate_strategies.includes("similarity"));
  });

  test("manages domains, catalogue and policies through the admin API", async () => {
    const domain = await request(port, "POST", "/api/v1/data-governance/domains", {
      token: adminToken,
      body: { code: "API_DOMAIN", name: "API Domain" },
    });
    assert.equal(domain.status, 201);
    assert.equal(domain.body.code, "API_DOMAIN");

    const tree = await request(port, "GET", "/api/v1/data-governance/domains/tree", { token: adminToken });
    assert.equal(tree.status, 200);

    const catalogue = await request(port, "POST", "/api/v1/data-governance/catalog", {
      token: adminToken,
      body: { object_type: "product", name: "Product", domain_id: domain.body.id },
    });
    assert.ok([200, 201, 409].includes(catalogue.status));

    const policy = await request(port, "POST", "/api/v1/data-governance/policies", {
      token: adminToken,
      body: {
        code: "API_PRODUCT_COMPLETE",
        name: "API product completeness",
        object_type: "product",
        domain_id: domain.body.id,
        status: "active",
        rule_set: [{ code: "HAS_NUMBER", rule_type: "REQUIRED", attribute_name: "part.number", severity: "error" }],
      },
    });
    assert.equal(policy.status, 201);
    assert.equal(policy.body.status, "active");
  });

  test("validates and creates quality rules before activation", async () => {
    const invalid = await request(port, "POST", "/api/v1/data-quality/rules/validate", {
      token: adminToken,
      body: { rule_type: "CUSTOM", object_type: "product", expression: { attribute: "part.name", operator: "eval", value: "x" } },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.valid, false);

    const created = await request(port, "POST", "/api/v1/data-quality/rules", {
      token: adminToken,
      body: {
        code: "API_RULE_NAME",
        name: "Name present",
        object_type: "product",
        rule_type: "REQUIRED",
        attribute_name: "part.name",
        severity: "warning",
        status: "active",
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.rule_type, "REQUIRED");

    const listed = await request(port, "GET", "/api/v1/data-quality/rules?object_type=product", { token: adminToken });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((rule) => rule.code === "API_RULE_NAME"));
  });

  test("evaluates an object and exposes results, scores and exceptions", async () => {
    const evaluated = await request(port, "POST", "/api/v1/data-quality/evaluate", {
      token: adminToken,
      body: { object_type: "product", object_id: "1" },
    });
    assert.equal(evaluated.status, 200);
    assert.ok(["PASSED", "FAILED"].includes(evaluated.body.evaluation_state));

    const scores = await request(port, "GET", "/api/v1/data-quality/scores", { token: adminToken });
    assert.equal(scores.status, 200);
    assert.ok(scores.body.objects >= 1);

    const results = await request(port, "GET", "/api/v1/data-quality/results?object_type=product", { token: adminToken });
    assert.equal(results.status, 200);
    assert.ok(results.body.total >= 1);

    const exceptions = await request(port, "GET", "/api/v1/data-quality/exceptions", { token: adminToken });
    assert.equal(exceptions.status, 200);
    assert.ok(Array.isArray(exceptions.body.items));
  });

  test("enforces IAM permissions on write operations", async () => {
    const denied = await request(port, "POST", "/api/v1/data-quality/rules", {
      token: readerToken,
      body: { code: "SHOULD_FAIL", object_type: "product", rule_type: "REQUIRED", attribute_name: "part.name" },
    });
    assert.equal(denied.status, 403);
  });

  test("scopes reads by tenant so aggregates never leak across tenants", async () => {
    const before = await request(port, "GET", "/api/v1/data-quality/scores", { token: adminToken });
    const otherOrg = db.prepare("SELECT id FROM organizations WHERE id <> 1 ORDER BY id LIMIT 1").get();
    assert.ok(otherOrg, "expected a second organization to exist");
    db.prepare(
      "INSERT INTO dg_domains (domain_ref, tenant_id, code, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))"
    ).run("DG-DOM-other", otherOrg.id, "OTHER_TENANT_DOMAIN", "Other tenant domain");

    const domains = await request(port, "GET", "/api/v1/data-governance/domains", { token: adminToken });
    assert.equal(domains.status, 200);
    assert.ok(!domains.body.items.some((domain) => domain.code === "OTHER_TENANT_DOMAIN"));

    const metrics = await request(port, "GET", "/api/v1/data-governance/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.equal(metrics.body.counters.domains, domains.body.total);

    const after = await request(port, "GET", "/api/v1/data-quality/scores", { token: adminToken });
    assert.equal(after.body.objects, before.body.objects);
  });

  test("supports duplicate detection endpoints", async () => {
    const rules = await request(port, "GET", "/api/v1/data-quality/duplicates/match-rules?object_type=product", { token: adminToken });
    assert.equal(rules.status, 200);
    const detect = await request(port, "POST", "/api/v1/data-quality/duplicates/detect", {
      token: adminToken,
      body: { object_type: "product" },
    });
    assert.equal(detect.status, 200);
    assert.equal(typeof detect.body.detected, "number");
  });

  test("exposes the spec convenience aliases", async () => {
    const owners = await request(port, "GET", "/api/v1/data-governance/owners", { token: adminToken });
    assert.equal(owners.status, 200);
    const stewards = await request(port, "GET", "/api/v1/data-governance/stewards", { token: adminToken });
    assert.equal(stewards.status, 200);

    const policy = await request(port, "POST", "/api/v1/data-governance/policies", {
      token: adminToken,
      body: { code: "API_ALIAS_POLICY", name: "Alias policy", object_type: "product", status: "draft" },
    });
    assert.equal(policy.status, 201);
    const activate = await request(port, "POST", `/api/v1/data-governance/policies/${policy.body.policy_ref}/activate`, { token: adminToken, body: {} });
    assert.equal(activate.status, 200);
    assert.equal(activate.body.status, "active");
    const retire = await request(port, "POST", `/api/v1/data-governance/policies/${policy.body.policy_ref}/retire`, { token: adminToken, body: {} });
    assert.equal(retire.status, 200);
    assert.equal(retire.body.status, "retired");

    const rule = await request(port, "POST", "/api/v1/data-quality/rules", {
      token: adminToken,
      body: { code: "API_ALIAS_RULE", object_type: "product", rule_type: "REQUIRED", attribute_name: "part.number", status: "draft" },
    });
    assert.equal(rule.status, 201);
    const validate = await request(port, "POST", `/api/v1/data-quality/rules/${rule.body.rule_ref}/validate`, { token: adminToken, body: {} });
    assert.equal(validate.status, 200);
    assert.equal(validate.body.valid, true);
    const activateRule = await request(port, "POST", `/api/v1/data-quality/rules/${rule.body.rule_ref}/activate`, { token: adminToken, body: {} });
    assert.equal(activateRule.status, 200);
    assert.equal(activateRule.body.status, "active");

    const duplicates = await request(port, "GET", "/api/v1/data-quality/duplicates?object_type=product", { token: adminToken });
    assert.equal(duplicates.status, 200);
    assert.ok(Array.isArray(duplicates.body.match_rules));

    const objectScore = await request(port, "GET", "/api/v1/data-quality/scores/objects/product/1", { token: adminToken });
    assert.equal(objectScore.status, 200);

    const exceptions = await request(port, "GET", "/api/v1/data-quality/exceptions?status=open", { token: adminToken });
    assert.equal(exceptions.status, 200);
    if (exceptions.body.items.length) {
      const target = exceptions.body.items[0];
      const patched = await request(port, "PATCH", `/api/v1/data-quality/exceptions/${target.exception_ref}`, {
        token: adminToken,
        body: { priority: "high", description: "Triaged through the alias API" },
      });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.priority, "high");
    }
  });
});

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

describe("lifecycle REST APIs", () => {
  let port;
  let server;
  let token;

  before(async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    seedDatabase(database);
    const started = await listen(createApp(database));
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

  test("requires authentication", async () => {
    const res = await request(port, "GET", "/api/statuses");
    assert.equal(res.status, 401);
  });

  test("exposes configuration catalogs", async () => {
    const statuses = await request(port, "GET", "/api/statuses", { token });
    assert.equal(statuses.status, 200);
    assert.equal(statuses.body.total, 6);

    const definitions = await request(port, "GET", "/api/lifecycle-definitions", { token });
    assert.equal(definitions.status, 200);
    assert.ok(definitions.body.items.some((d) => d.code === "product-lifecycle"));

    const published = definitions.body.items.find((d) => d.code === "product-lifecycle");
    const validate = await request(port, "GET", `/api/lifecycle-definitions/${published.id}/validate`, { token });
    assert.equal(validate.status, 200);
    assert.equal(validate.body.valid, true);

    const assignments = await request(port, "GET", "/api/lifecycle-assignments", { token });
    assert.equal(assignments.status, 200);
    assert.ok(assignments.body.items.some((a) => a.type_code === "product"));

    const rules = await request(port, "GET", "/api/approval-rules", { token });
    assert.equal(rules.status, 200);
    assert.ok(rules.body.items.some((r) => r.code === "product-approval"));
  });

  test("creates a tenant status with validation", async () => {
    const invalid = await request(port, "POST", "/api/statuses", {
      token,
      body: { code: "BAD", name: "Bad" },
    });
    assert.equal(invalid.status, 400);

    const created = await request(port, "POST", "/api/statuses", {
      token,
      body: { code: "on-hold", name: "On Hold", category: "in_review", module: "pdm" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "on-hold");
    assert.equal(created.body.legacy_status, "active");
  });

  test("drives an object through the lifecycle and approvals", async () => {
    const view = await request(port, "GET", "/api/objects/PROD-1000/lifecycle", { token });
    assert.equal(view.status, 200);
    assert.equal(view.body.state.code, "draft");
    assert.ok(view.body.transitions.some((t) => t.code === "submit"));

    const submit = await request(port, "POST", "/api/objects/PROD-1000/transitions", {
      token,
      body: { transition: "submit" },
    });
    assert.equal(submit.status, 200);
    assert.equal(submit.body.gated, false);
    assert.equal(submit.body.state.code, "in-review");

    const release = await request(port, "POST", "/api/objects/PROD-1000/release", {
      token,
      body: { transition: "approve", comments: "Ship it" },
    });
    assert.equal(release.status, 201);
    assert.equal(release.body.status, "pending");
    assert.equal(release.body.approvals.length, 1);

    const releases = await request(port, "GET", "/api/objects/PROD-1000/releases", { token });
    assert.equal(releases.status, 200);
    assert.equal(releases.body.total, 1);

    const approvalId = release.body.approvals[0].id;
    const decided = await request(port, "POST", `/api/objects/PROD-1000/approvals/${approvalId}`, {
      token,
      body: { decision: "approve", comment: "Approved" },
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.status, "approved");

    const after = await request(port, "GET", "/api/objects/PROD-1000/lifecycle", { token });
    assert.equal(after.body.state.code, "approved");

    const history = await request(port, "GET", "/api/objects/PROD-1000/status-history", { token });
    assert.equal(history.status, 200);
    assert.ok(history.body.total >= 3);
  });

  test("returns 409 when driving a transition that is not allowed", async () => {
    const res = await request(port, "POST", "/api/objects/BOM-1000/transitions", {
      token,
      body: { transition: "submit" },
    });
    assert.equal(res.status, 409);
  });

  test("authors a lifecycle end to end through the configuration APIs", async () => {
    const created = await request(port, "POST", "/api/lifecycle-definitions", {
      token,
      body: { code: "doc-lifecycle", name: "Document Lifecycle", module: "pdm" },
    });
    assert.equal(created.status, 201);
    const definitionId = created.body.definition.id;
    const versionId = created.body.version.id;

    const stateOne = await request(port, "POST", "/api/lifecycle-states", {
      token,
      body: { code: "draft", name: "Draft", lifecycle_version_id: versionId, status_code: "draft", is_initial: true },
    });
    assert.equal(stateOne.status, 201);

    const stateTwo = await request(port, "POST", "/api/lifecycle-states", {
      token,
      body: { code: "published", name: "Published", lifecycle_version_id: versionId, status_code: "released", is_terminal: true },
    });
    assert.equal(stateTwo.status, 201);

    const transition = await request(port, "POST", "/api/lifecycle-transitions", {
      token,
      body: { code: "publish", name: "Publish", lifecycle_version_id: versionId, from_state: "draft", to_state: "published" },
    });
    assert.equal(transition.status, 201);

    const validate = await request(port, "GET", `/api/lifecycle-definitions/${definitionId}/validate`, { token });
    assert.equal(validate.body.valid, true);

    const publish = await request(port, "POST", `/api/lifecycle-definitions/${definitionId}/publish`, {
      token,
      body: {},
    });
    assert.equal(publish.status, 200);
    assert.equal(publish.body.version.version, 1);

    const nextVersion = await request(port, "POST", `/api/lifecycle-definitions/${definitionId}/versions`, {
      token,
      body: {},
    });
    assert.equal(nextVersion.status, 201);
    assert.equal(nextVersion.body.version.version, 2);

    const rule = await request(port, "POST", "/api/approval-rules", {
      token,
      body: {
        code: "doc-approval",
        name: "Document approval",
        kind: "approval",
        transition: "publish",
        steps: [{ code: "signoff", name: "Sign-off", approver_type: "role", approver_id: "iam.admin" }],
      },
    });
    assert.equal(rule.status, 201);
    assert.equal(rule.body.steps.length, 1);

    const assignment = await request(port, "POST", "/api/lifecycle-assignments", {
      token,
      body: { type: "document", lifecycle: "doc-lifecycle" },
    });
    assert.equal(assignment.status, 201);
    assert.equal(assignment.body.type_code, "document");
  });
});

process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, openTestDatabase } from "../db.js";
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

describe("Deployment & Edition framework REST APIs", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;

  before(async () => {
    db = openTestDatabase();
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
    const res = await request(port, "GET", "/api/v1/deployment/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without deployment privileges", async () => {
    const res = await request(port, "GET", "/api/v1/deployment/profile", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the deployment vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/deployment/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "deployment");
    assert.deepEqual(res.body.vocabulary.modes.map((m) => m.code), ["saas", "private_cloud", "local"]);
    assert.deepEqual(res.body.vocabulary.editions.map((e) => e.code), ["community", "standard", "enterprise"]);
  });

  test("resolves a default capability map from the installed posture", async () => {
    const res = await request(port, "GET", "/api/v1/deployment/capabilities", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.mode, "local");
    assert.equal(res.body.edition, "enterprise");
    assert.equal(res.body.features.iam_core, true);
    assert.equal(res.body.features.data_governance, true);
    // Topology-specific: self-service signup is Cloud-SaaS only.
    assert.equal(res.body.features.self_service_signup, false);
  });

  test("reads and updates the deployment profile", async () => {
    const initial = await request(port, "GET", "/api/v1/deployment/profile", { token: adminToken });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.profile.mode, "local");

    const updated = await request(port, "PUT", "/api/v1/deployment/profile", {
      token: adminToken,
      body: { mode: "saas", installation_name: "Acme Cloud" },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.profile.mode, "saas");
    assert.equal(updated.body.profile.installation_name, "Acme Cloud");
    // Switching topology adopts SaaS defaults.
    assert.equal(updated.body.profile.tenant_strategy, "multi");
    assert.equal(updated.body.profile.self_registration, true);

    const capabilities = await request(port, "GET", "/api/v1/deployment/capabilities", { token: adminToken });
    assert.equal(capabilities.body.mode, "saas");
    assert.equal(capabilities.body.features.self_service_signup, true);
  });

  test("lowers effective entitlements when the edition is downgraded", async () => {
    const res = await request(port, "PUT", "/api/v1/deployment/profile", {
      token: adminToken,
      body: { mode: "local", edition: "community" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.profile.edition, "community");

    const capabilities = await request(port, "GET", "/api/v1/deployment/capabilities", { token: adminToken });
    assert.equal(capabilities.body.features.iam_core, true);
    assert.equal(capabilities.body.features.pdm, false);
    assert.equal(capabilities.body.features.data_governance, false);
  });

  test("rejects invalid profile input", async () => {
    const badMode = await request(port, "PUT", "/api/v1/deployment/profile", {
      token: adminToken,
      body: { mode: "mainframe" },
    });
    assert.equal(badMode.status, 400);

    const badName = await request(port, "PUT", "/api/v1/deployment/profile", {
      token: adminToken,
      body: { installation_name: "" },
    });
    assert.equal(badName.status, 400);
  });

  test("toggles a feature entitlement and gates its API", async () => {
    // Restore the full edition so observability starts effective.
    await request(port, "PUT", "/api/v1/deployment/profile", { token: adminToken, body: { edition: "enterprise" } });

    const allowed = await request(port, "GET", "/api/v1/observability/providers", { token: adminToken });
    assert.equal(allowed.status, 200);

    const disabled = await request(port, "PUT", "/api/v1/deployment/features/observability", {
      token: adminToken,
      body: { enabled: false },
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.effective, false);
    assert.ok(disabled.body.reasons.includes("disabled_by_operator"));

    const capabilities = await request(port, "GET", "/api/v1/deployment/capabilities", { token: adminToken });
    assert.equal(capabilities.body.features.observability, false);

    const denied = await request(port, "GET", "/api/v1/observability/providers", { token: adminToken });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.details.feature, "observability");
    assert.equal(denied.body.details.reason, "feature_not_entitled");

    const restored = await request(port, "PUT", "/api/v1/deployment/features/observability", {
      token: adminToken,
      body: { enabled: true },
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.effective, true);

    const allowedAgain = await request(port, "GET", "/api/v1/observability/providers", { token: adminToken });
    assert.equal(allowedAgain.status, 200);
  });

  test("records notes, rejects unknown features and lists summary + history", async () => {
    const notes = await request(port, "PUT", "/api/v1/deployment/features/reporting", {
      token: adminToken,
      body: { notes: "Contracted add-on" },
    });
    assert.equal(notes.status, 200);
    assert.equal(notes.body.notes, "Contracted add-on");

    const unknown = await request(port, "PUT", "/api/v1/deployment/features/not_a_feature", {
      token: adminToken,
      body: { enabled: false },
    });
    assert.equal(unknown.status, 404);

    const list = await request(port, "GET", "/api/v1/deployment/features", { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.items.length >= 25);
    assert.ok(list.body.items.every((f) => typeof f.effective === "boolean"));

    const summary = await request(port, "GET", "/api/v1/deployment/features/summary", { token: adminToken });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.total, list.body.items.length);
    assert.ok(summary.body.by_category.core.effective >= 1);

    const history = await request(port, "GET", "/api/v1/deployment/history?pageSize=50", { token: adminToken });
    assert.equal(history.status, 200);
    assert.ok(history.body.items.some((h) => h.action === "profile.updated"));
    assert.ok(history.body.items.some((h) => h.action === "feature.updated"));
  });
});

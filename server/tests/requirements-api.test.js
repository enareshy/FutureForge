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
          ...(payload !== null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(headers || {}),
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
          resolve({ status: res.statusCode, body: parsed, text, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

describe("Requirements Manager REST APIs", () => {
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
    // Demo/test requirements do not always carry an owner; keep the lifecycle
    // independent of owner assignment for the API exercise.
    await request(port, "PUT", "/api/v1/requirements/config/require_owner", { token: adminToken, body: { value: false } });
  });

  after(() => {
    server?.close();
    db?.close();
  });

  test("requires authentication", async () => {
    const res = await request(port, "GET", "/api/v1/requirements/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without Requirements Manager privileges", async () => {
    const res = await request(port, "GET", "/api/v1/requirements/requirements", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the capability vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/requirements/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "requirements");
    assert.ok(res.body.vocabulary.requirement_statuses.includes("RELEASED"));
  });

  test("reports health and configuration", async () => {
    const health = await request(port, "GET", "/api/v1/requirements/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.ok(health.body.counts);

    const config = await request(port, "GET", "/api/v1/requirements/config", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(config.body.require_owner, false);
  });

  test("lists the configured requirement types", async () => {
    const res = await request(port, "GET", "/api/v1/requirements/types", { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.total >= 15);
    assert.ok(res.body.items.some((entry) => entry.code === "business_requirement"));
  });

  test("drives a requirement through the full lifecycle", async () => {
    const created = await request(port, "POST", "/api/v1/requirements/requirements", {
      token: adminToken,
      body: { title: "API lifecycle", requirement_type: "business_requirement", priority: "HIGH" },
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.requirement_number.startsWith("REQ-"));
    const ref = created.body.requirement_ref;

    const submitted = await request(port, "POST", `/api/v1/requirements/requirements/${ref}/submit`, { token: adminToken });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.status, "IN_REVIEW");

    const approved = await request(port, "POST", `/api/v1/requirements/requirements/${ref}/approve`, { token: adminToken, body: { reason: "CCB approves" } });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, "APPROVED");

    const released = await request(port, "POST", `/api/v1/requirements/requirements/${ref}/release`, { token: adminToken });
    assert.equal(released.status, 200);
    assert.equal(released.body.status, "RELEASED");

    const locked = await request(port, "PUT", `/api/v1/requirements/requirements/${ref}`, { token: adminToken, body: { title: "Nope" } });
    assert.equal(locked.status, 409);

    const history = await request(port, "GET", `/api/v1/requirements/requirements/${ref}/history`, { token: adminToken });
    assert.equal(history.status, 200);
    assert.ok(history.body.total >= 4);
  });

  test("creates and compares revisions", async () => {
    const created = (await request(port, "POST", "/api/v1/requirements/requirements", {
      token: adminToken,
      body: { title: "API revision", requirement_type: "system_requirement" },
    })).body;
    const ref = created.requirement_ref;

    await request(port, "PUT", `/api/v1/requirements/requirements/${ref}`, { token: adminToken, body: { title: "API revision v2" } });
    const revised = await request(port, "POST", `/api/v1/requirements/requirements/${ref}/revise`, { token: adminToken, body: { change_reason: "Tightened" } });
    assert.equal(revised.status, 201);
    assert.equal(revised.body.requirement.revision, "B");

    const revisions = await request(port, "GET", `/api/v1/requirements/requirements/${ref}/revisions`, { token: adminToken });
    assert.equal(revisions.status, 200);
    assert.equal(revisions.body.total, 2);

    const comparison = await request(port, "GET", `/api/v1/requirements/requirements/${ref}/revisions/compare?from=A&to=B`, { token: adminToken });
    assert.equal(comparison.status, 200);
    assert.ok(comparison.body.changes.some((change) => change.attribute === "title"));
  });

  test("manages hierarchy and traceability relationships", async () => {
    const parentRes = await request(port, "POST", "/api/v1/requirements/requirements", {
      token: adminToken,
      body: { title: "API parent", requirement_type: "business_requirement" },
    });
    assert.equal(parentRes.status, 201);
    const parent = parentRes.body;
    const childRes = await request(port, "POST", "/api/v1/requirements/requirements", {
      token: adminToken,
      body: { title: "API child", requirement_type: "system_requirement", parent_id: parent.id },
    });
    assert.equal(childRes.status, 201);
    const child = childRes.body;

    const children = await request(port, "GET", `/api/v1/requirements/requirements/${parent.requirement_ref}/children`, { token: adminToken });
    assert.equal(children.status, 200);
    assert.equal(children.body.length, 1);
    assert.equal(children.body[0].id, child.id);

    const rel = await request(port, "POST", "/api/v1/requirements/relationships", {
      token: adminToken,
      body: { relationship_type: "DERIVED_FROM", source_type: "requirement", source_id: child.id, target_type: "requirement", target_id: parent.id },
    });
    assert.equal(rel.status, 201);
    assert.ok(rel.body.relationship_ref);

    const forChild = await request(port, "GET", `/api/v1/requirements/requirements/${child.requirement_ref}/relationships`, { token: adminToken });
    assert.equal(forChild.status, 200);

    const removed = await request(port, "DELETE", `/api/v1/requirements/relationships/${rel.body.relationship_ref}`, { token: adminToken });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);

    const blocked = await request(port, "POST", "/api/v1/requirements/relationships", {
      token: adminToken,
      body: { relationship_type: "PARENT_OF", source_type: "requirement", source_id: parent.id, target_type: "requirement", target_id: parent.id },
    });
    assert.equal(blocked.status, 409);
  });

  test("creates, releases and diffs a baseline", async () => {
    const req = (await request(port, "POST", "/api/v1/requirements/requirements", {
      token: adminToken,
      body: { title: "API baseline member", requirement_type: "business_requirement" },
    })).body;
    await request(port, "POST", `/api/v1/requirements/requirements/${req.requirement_ref}/submit`, { token: adminToken });
    await request(port, "POST", `/api/v1/requirements/requirements/${req.requirement_ref}/approve`, { token: adminToken });
    await request(port, "POST", `/api/v1/requirements/requirements/${req.requirement_ref}/release`, { token: adminToken });

    const baseline = await request(port, "POST", "/api/v1/requirements/baselines", {
      token: adminToken,
      body: { name: "API baseline", requirement_ids: [req.id] },
    });
    assert.equal(baseline.status, 201);
    assert.equal(baseline.body.member_count, 1);
    const baselineRef = baseline.body.baseline_ref;

    const released = await request(port, "POST", `/api/v1/requirements/baselines/${baselineRef}/release`, { token: adminToken });
    assert.equal(released.status, 200);
    assert.equal(released.body.status, "RELEASED");

    const inSync = await request(port, "GET", `/api/v1/requirements/baselines/${baselineRef}/compare`, { token: adminToken });
    assert.equal(inSync.status, 200);
    assert.equal(inSync.body.in_sync, true);

    await request(port, "POST", `/api/v1/requirements/requirements/${req.requirement_ref}/revise`, { token: adminToken, body: { change_reason: "Drift" } });
    const drifted = await request(port, "GET", `/api/v1/requirements/baselines/${baselineRef}/compare`, { token: adminToken });
    assert.equal(drifted.body.in_sync, false);

    const members = await request(port, "GET", `/api/v1/requirements/baselines/${baselineRef}/members`, { token: adminToken });
    assert.equal(members.status, 200);
  });

  test("lists validation rules and validates a requirement", async () => {
    const rules = await request(port, "GET", "/api/v1/requirements/validation-rules", { token: adminToken });
    assert.equal(rules.status, 200);
    assert.ok(rules.body.total >= 3);

    const req = (await request(port, "POST", "/api/v1/requirements/requirements", {
      token: adminToken,
      body: { title: "API validation", requirement_type: "business_requirement" },
    })).body;
    const validation = await request(port, "GET", `/api/v1/requirements/requirements/${req.requirement_ref}/validate`, { token: adminToken });
    assert.equal(validation.status, 200);
    assert.equal(validation.body.valid, true);

    const sweep = await request(port, "POST", "/api/v1/requirements/validation/run", { token: adminToken, body: {} });
    assert.equal(sweep.status, 200);
    assert.ok(sweep.body.evaluated >= 1);
  });

  test("seeds the demo chain idempotently", async () => {
    const first = await request(port, "POST", "/api/v1/requirements/seed", { token: adminToken });
    assert.equal(first.status, 200);
    assert.equal(first.body.seeded, true);

    const again = await request(port, "POST", "/api/v1/requirements/seed", { token: adminToken });
    assert.equal(again.status, 200);
    assert.equal(again.body.seeded, false);
    assert.equal(again.body.reason, "already_seeded");
  });

  test("404s on an unknown requirement and rejects an out-of-sequence transition", async () => {
    const missing = await request(port, "GET", "/api/v1/requirements/requirements/does-not-exist", { token: adminToken });
    assert.equal(missing.status, 404);

    const req = (await request(port, "POST", "/api/v1/requirements/requirements", {
      token: adminToken,
      body: { title: "API out of sequence", requirement_type: "business_requirement" },
    })).body;
    const approve = await request(port, "POST", `/api/v1/requirements/requirements/${req.requirement_ref}/approve`, { token: adminToken });
    assert.equal(approve.status, 409);
  });
});

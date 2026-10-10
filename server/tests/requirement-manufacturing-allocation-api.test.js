process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { RequirementsManager, ensureRequirementsFoundation } from "../services/requirements/index.js";
import { ensureRequirementObject } from "../services/requirement-pdm/index.js";
import {
  ensureRequirementManufacturingFoundation,
  createManufacturingObject,
} from "../services/requirement-manufacturing/index.js";

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
          resolve({ status: res.statusCode, body: parsed, text });
        });
      }
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

describe("Requirement -> Manufacturing allocation API", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;
  let tenant;
  let actor;
  let requirementRef;
  let operationId;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureRequirementManufacturingFoundation(db);

    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");

    const requirement = RequirementsManager.createRequirement(db, tenant, { title: "API allocated requirement", requirement_type: "business_requirement" }, actor, null);
    ensureRequirementObject(db, tenant, requirement, actor, null);
    requirementRef = requirement.requirement_ref;
    operationId = createManufacturingObject(db, tenant, { object_type: "operation", code: "API-OP-1", name: "API operation" }, actor, null).id;

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
    const res = await request(port, "GET", "/api/v1/requirement-manufacturing/allocations");
    assert.equal(res.status, 401);
  });

  test("denies a reader without allocation privileges", async () => {
    const res = await request(port, "GET", "/api/v1/requirement-manufacturing/allocations", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("creates, lists, reads coverage and removes an allocation", async () => {
    const created = await request(port, "POST", "/api/v1/requirement-manufacturing/allocations", {
      token: adminToken,
      body: { requirement_id: requirementRef, relationship_type: "REALIZED_BY", target_type: "operation", target_id: operationId },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.created, true);
    assert.equal(created.body.relationship_type, "REALIZED_BY");

    const again = await request(port, "POST", "/api/v1/requirement-manufacturing/allocations", {
      token: adminToken,
      body: { requirement_id: requirementRef, relationship_type: "REALIZED_BY", target_type: "operation", target_id: operationId },
    });
    assert.equal(again.status, 201);
    assert.equal(again.body.created, false);

    const list = await request(port, "GET", `/api/v1/requirement-manufacturing/requirements/${requirementRef}/allocations`, { token: adminToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);

    const coverage = await request(port, "GET", `/api/v1/requirement-manufacturing/requirements/${requirementRef}/coverage`, { token: adminToken });
    assert.equal(coverage.status, 200);
    assert.equal(coverage.body.coverage, "ALLOCATED");

    const reverse = await request(port, "GET", `/api/v1/requirement-manufacturing/targets/requirements?target_type=operation&target_id=${operationId}`, { token: adminToken });
    assert.equal(reverse.status, 200);
    assert.ok(reverse.body.items.some((item) => item.requirement_ref === requirementRef));

    const removed = await request(port, "DELETE", `/api/v1/requirement-manufacturing/allocations/${created.body.allocation_ref}`, { token: adminToken });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);
  });

  test("batch allocates and reports failures", async () => {
    const res = await request(port, "POST", "/api/v1/requirement-manufacturing/allocations/batch", {
      token: adminToken,
      body: { requirement_id: requirementRef, target_type: "operation", targets: [operationId, 987654321] },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.failed, 1);
  });
});

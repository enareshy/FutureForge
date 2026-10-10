process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { ensureRequirementsFoundation } from "../services/requirements/index.js";
import { Definitions as BomDefinitions, Revisions as BomRevisions, ensureBomFoundation } from "../services/bom/index.js";
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

describe("Requirement -> Manufacturing BOP / operation API", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;
  let bopRevisionId;
  let op1Id;
  let op2Id;
  let wcId;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureBomFoundation(db);
    ensureRequirementManufacturingFoundation(db);

    const tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    const actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    const bop = BomDefinitions.createBom(db, tenant, { bom_number: "API-BOP", name: "Process", bom_type: "BOP" }, actor, null);
    bopRevisionId = BomRevisions.createRevision(db, tenant, bop.id, { revision_number: "A1" }, actor, null).id;
    op1Id = createManufacturingObject(db, tenant, { object_type: "operation", code: "API-OP-1", name: "Cut" }, actor, null).id;
    op2Id = createManufacturingObject(db, tenant, { object_type: "operation", code: "API-OP-2", name: "Weld" }, actor, null).id;
    wcId = createManufacturingObject(db, tenant, { object_type: "work_center", code: "API-WC-1", name: "Line" }, actor, null).id;

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

  test("requires authentication and denies a reader", async () => {
    const unauth = await request(port, "GET", `/api/v1/requirement-manufacturing/bop/${bopRevisionId}/operations`);
    assert.equal(unauth.status, 401);
    const denied = await request(port, "GET", `/api/v1/requirement-manufacturing/bop/${bopRevisionId}/operations`, { token: readerToken });
    assert.equal(denied.status, 403);
  });

  test("adds operations and reads the BOP operation list and sequence", async () => {
    const created = await request(port, "POST", `/api/v1/requirement-manufacturing/bop/${bopRevisionId}/operations`, {
      token: adminToken,
      body: { operation_id: op1Id, sequence: 10 },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.operation.code, "API-OP-1");

    await request(port, "POST", `/api/v1/requirement-manufacturing/bop/${bopRevisionId}/operations`, { token: adminToken, body: { operation_id: op2Id, sequence: 20 } });

    const list = await request(port, "GET", `/api/v1/requirement-manufacturing/bop/${bopRevisionId}/operations`, { token: adminToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.summary.operations, 2);
    assert.deepEqual(list.body.items.map((item) => item.operation.code), ["API-OP-1", "API-OP-2"]);

    const sequence = await request(port, "GET", `/api/v1/requirement-manufacturing/bop/${bopRevisionId}/sequence`, { token: adminToken });
    assert.equal(sequence.status, 200);
    assert.equal(sequence.body.valid, true);
  });

  test("links a work center and reads both directions", async () => {
    const created = await request(port, "POST", `/api/v1/requirement-manufacturing/operations/${op1Id}/work-centers`, {
      token: adminToken,
      body: { work_center_id: wcId },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.work_center.code, "API-WC-1");

    const ofOperation = await request(port, "GET", `/api/v1/requirement-manufacturing/operations/${op1Id}/work-centers`, { token: adminToken });
    assert.equal(ofOperation.status, 200);
    assert.deepEqual(ofOperation.body.items.map((wc) => wc.code), ["API-WC-1"]);

    const ofWorkCenter = await request(port, "GET", `/api/v1/requirement-manufacturing/work-centers/${wcId}/operations`, { token: adminToken });
    assert.equal(ofWorkCenter.status, 200);
    assert.deepEqual(ofWorkCenter.body.items.map((entry) => entry.operation.code), ["API-OP-1"]);
  });
});

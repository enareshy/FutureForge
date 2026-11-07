process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { ensureRequirementsFoundation } from "../services/requirements/index.js";
import { Definitions, Revisions, Transformation, Seed, Configuration, ensureBomFoundation } from "../services/bom/index.js";
import { ensureRequirementManufacturingFoundation } from "../services/requirement-manufacturing/index.js";

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

describe("Requirement -> Manufacturing transformation API", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;
  let sourceRevisionId;
  let targetRevisionId;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureBomFoundation(db);
    ensureRequirementManufacturingFoundation(db);

    const tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    Configuration.ensureBomConfig(db, tenant);
    Seed.seedBom(db, tenant);
    const ebom = Definitions.getBom(db, tenant, "DEMO-EBOM-PUMP");
    sourceRevisionId = Revisions.listRevisions(db, { tenantId: tenant, bomId: ebom.id }).items[0].id;
    const definition = Transformation.listTransformationDefinitions(db, { tenantId: tenant }).items[0];
    const executed = Transformation.transform(db, tenant, { definition_id: definition.id, source_revision_id: sourceRevisionId, mode: "EXECUTE" });
    targetRevisionId = executed.run.target_revision_id;

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
    const res = await request(port, "GET", `/api/v1/requirement-manufacturing/ebom/${sourceRevisionId}/mbom-mappings`);
    assert.equal(res.status, 401);
  });

  test("denies a reader without transformation privileges", async () => {
    const res = await request(port, "GET", `/api/v1/requirement-manufacturing/ebom/${sourceRevisionId}/mbom-mappings`, { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves EBOM -> MBOM mappings and MBOM -> EBOM sources", async () => {
    const mappings = await request(port, "GET", `/api/v1/requirement-manufacturing/ebom/${sourceRevisionId}/mbom-mappings`, { token: adminToken });
    assert.equal(mappings.status, 200);
    assert.equal(mappings.body.direction, "EBOM_TO_MBOM");
    assert.ok(mappings.body.summary.mappings >= 1);

    const sources = await request(port, "GET", `/api/v1/requirement-manufacturing/mbom/${targetRevisionId}/ebom-sources`, { token: adminToken });
    assert.equal(sources.status, 200);
    assert.equal(sources.body.direction, "MBOM_TO_EBOM");
    assert.ok(sources.body.summary.traced >= 1);

    const runs = await request(port, "GET", `/api/v1/requirement-manufacturing/bom-revisions/${sourceRevisionId}/transformations`, { token: adminToken });
    assert.equal(runs.status, 200);
    assert.ok(runs.body.total >= 1);
  });
});

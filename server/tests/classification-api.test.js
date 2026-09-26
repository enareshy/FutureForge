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

describe("Enterprise Classification Framework REST APIs", () => {
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
    await request(port, "POST", "/api/v1/classification/seed", { token: adminToken });
  });

  after(() => {
    server?.close();
    db?.close();
  });

  test("requires authentication", async () => {
    const res = await request(port, "GET", "/api/v1/classification/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without classification privileges", async () => {
    const res = await request(port, "GET", "/api/v1/classification/classifications", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the classification vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/classification/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "classification");
    assert.ok(res.body.vocabularies.classification_statuses.includes("DRAFT"));
    assert.ok(res.body.capabilities.characteristic_data_types.includes("UNIT_NUMERIC"));
    assert.ok(res.body.capabilities.search_types.includes("classification"));
    assert.ok(res.body.capabilities.job_types.includes("CLASSIFICATION_BULK_ASSIGN"));
    assert.equal(res.body.resources.module, "iam.classification");
  });

  test("reports health, metrics, coverage and configuration", async () => {
    const health = await request(port, "GET", "/api/v1/classification/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.ok(["healthy", "degraded"].includes(health.body.status));

    const metrics = await request(port, "GET", "/api/v1/classification/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.equal(typeof metrics.body.totals.classifications, "number");

    const coverage = await request(port, "GET", "/api/v1/classification/coverage?object_type=part&total_objects=10", { token: adminToken });
    assert.equal(coverage.status, 200);
    assert.equal(typeof coverage.body.classified_objects, "number");

    const config = await request(port, "GET", "/api/v1/classification/config", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(config.body.max_hierarchy_depth, 64);
  });

  test("exposes the seeded demonstration classification", async () => {
    const list = await request(port, "GET", "/api/v1/classification/classifications?q=MECH", { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((entry) => entry.code === "MECH_COMPONENTS"));

    const tree = await request(port, "GET", "/api/v1/classification/classifications/MECH_COMPONENTS/tree", { token: adminToken });
    assert.equal(tree.status, 200);
    assert.ok(tree.body.total >= 3);

    const assignments = await request(port, "GET", "/api/v1/classification/assignments?object_type=product", { token: adminToken });
    assert.equal(assignments.status, 200);
    assert.ok(assignments.body.items.some((entry) => entry.object_id === "DEMO-PUMP-001"));
  });

  test("performs the full definition lifecycle over REST", async () => {
    const create = await request(port, "POST", "/api/v1/classification/classifications", { token: adminToken, body: { code: "API_MECH", name: "API mechanical" } });
    assert.equal(create.status, 201);
    assert.equal(create.body.code, "API_MECH");
    const ref = create.body.id;

    const duplicate = await request(port, "POST", "/api/v1/classification/classifications", { token: adminToken, body: { code: "API_MECH", name: "dup" } });
    assert.equal(duplicate.status, 409);
    assert.ok(duplicate.body.code);

    const patch = await request(port, "PATCH", `/api/v1/classification/classifications/${ref}`, { token: adminToken, body: { name: "API mechanical (renamed)" } });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.name, "API mechanical (renamed)");

    const status = await request(port, "POST", `/api/v1/classification/classifications/${ref}/status`, { token: adminToken, body: { status: "ACTIVE" } });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, "ACTIVE");

    const approve = await request(port, "POST", `/api/v1/classification/classifications/${ref}/approve`, { token: adminToken });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.approval_status, "APPROVED");

    const version = await request(port, "POST", `/api/v1/classification/classifications/${ref}/versions`, { token: adminToken, body: { change_reason: "baseline" } });
    assert.equal(version.status, 201);
    assert.equal(version.body.version, 2);

    const versions = await request(port, "GET", `/api/v1/classification/classifications/${ref}/versions`, { token: adminToken });
    assert.equal(versions.status, 200);
    assert.ok(versions.body.total >= 1);

    const audit = await request(port, "GET", `/api/v1/classification/classifications/${ref}/audit`, { token: adminToken });
    assert.equal(audit.status, 200);
    assert.ok(audit.body.total >= 1);
  });

  test("manages classes, characteristics, allowed values and effective contracts", async () => {
    const classification = await request(port, "POST", "/api/v1/classification/classifications", { token: adminToken, body: { code: "API_TREE", name: "API tree" } });
    const classificationId = classification.body.id;

    const root = await request(port, "POST", "/api/v1/classification/classes", { token: adminToken, body: { classification_id: classificationId, code: "APIROOT", name: "Root" } });
    assert.equal(root.status, 201);
    const child = await request(port, "POST", "/api/v1/classification/classes", { token: adminToken, body: { classification_id: classificationId, parent_class_id: root.body.id, code: "APICHILD", name: "Child" } });
    assert.equal(child.status, 201);
    assert.equal(child.body.path, "APIROOT/APICHILD");

    const material = await request(port, "POST", "/api/v1/classification/characteristics", { token: adminToken, body: { code: "API_MATERIAL", name: "Material", data_type: "ENUMERATION" } });
    assert.equal(material.status, 201);
    const allowed = await request(port, "POST", `/api/v1/classification/characteristics/${material.body.id}/allowed-values`, { token: adminToken, body: { code: "SS", display_name: "Stainless" } });
    assert.equal(allowed.status, 201);

    const attach = await request(port, "POST", `/api/v1/classification/classes/${root.body.id}/characteristics`, { token: adminToken, body: { characteristic_id: material.body.id, required: true } });
    assert.equal(attach.status, 201);

    const effective = await request(port, "GET", `/api/v1/classification/classes/${child.body.id}/effective`, { token: adminToken });
    assert.equal(effective.status, 200);
    assert.ok(effective.body.items.some((entry) => entry.code === "API_MATERIAL" && entry.origin === "INHERITED"));

    const validate = await request(port, "POST", `/api/v1/classification/classes/${child.body.id}/validate`, { token: adminToken, body: { values: {} } });
    assert.equal(validate.status, 200);
    assert.equal(validate.body.valid, false);
    assert.ok(validate.body.missing_required.length >= 1);

    const tree = await request(port, "GET", `/api/v1/classification/classifications/${classificationId}/tree`, { token: adminToken });
    assert.equal(tree.status, 200);
    assert.equal(tree.body.total, 2);
  });

  test("assigns, validates, reads and removes object classifications", async () => {
    const classification = await request(port, "POST", "/api/v1/classification/classifications", { token: adminToken, body: { code: "API_ASN", name: "API assignment" } });
    const klass = await request(port, "POST", "/api/v1/classification/classes", { token: adminToken, body: { classification_id: classification.body.id, code: "APICLS", name: "Class" } });
    const material = await request(port, "POST", "/api/v1/classification/characteristics", { token: adminToken, body: { code: "API_ASN_MAT", name: "Material", data_type: "ENUMERATION" } });
    await request(port, "POST", `/api/v1/classification/characteristics/${material.body.id}/allowed-values`, { token: adminToken, body: { code: "SS" } });
    await request(port, "POST", `/api/v1/classification/classes/${klass.body.id}/characteristics`, { token: adminToken, body: { characteristic_id: material.body.id, required: true } });
    await request(port, "POST", `/api/v1/classification/classes/${klass.body.id}/status`, { token: adminToken, body: { status: "ACTIVE" } });

    const assign = await request(port, "POST", "/api/v1/classification/assignments", { token: adminToken, body: { object_type: "part", object_id: "API-PART-1", class_id: klass.body.id, values: { API_ASN_MAT: "SS" } } });
    assert.equal(assign.status, 201);
    const assignmentRef = assign.body.assignment.id;

    const duplicate = await request(port, "POST", "/api/v1/classification/assignments", { token: adminToken, body: { object_type: "part", object_id: "API-PART-1", class_id: klass.body.id } });
    assert.equal(duplicate.status, 409);

    const validateAssignment = await request(port, "POST", `/api/v1/classification/assignments/${assignmentRef}/validate`, { token: adminToken });
    assert.equal(validateAssignment.status, 200);
    assert.equal(validateAssignment.body.validation.valid, true);

    const invalidAssign = await request(port, "POST", "/api/v1/classification/assignments", { token: adminToken, body: { object_type: "part", object_id: "API-PART-BAD", class_id: klass.body.id, values: { API_ASN_MAT: "GOLD" } } });
    assert.equal(invalidAssign.status, 422);

    const values = await request(port, "GET", "/api/v1/classification/objects/part/API-PART-1/values", { token: adminToken });
    assert.equal(values.status, 200);

    const objectValidation = await request(port, "POST", "/api/v1/classification/objects/part/API-PART-1/validate", { token: adminToken });
    assert.equal(objectValidation.status, 200);
    assert.equal(objectValidation.body.valid, true);

    const batch = await request(port, "POST", "/api/v1/classification/objects/part/validate-batch", { token: adminToken, body: { object_ids: ["API-PART-1", "API-PART-BAD"] } });
    assert.equal(batch.status, 200);
    assert.equal(batch.body.total, 2);

    const remove = await request(port, "DELETE", `/api/v1/classification/assignments/${assignmentRef}`, { token: adminToken });
    assert.equal(remove.status, 200);
    assert.equal(remove.body.deleted, true);
  });

  test("converts units and reports duplicate signals", async () => {
    const units = await request(port, "GET", "/api/v1/classification/units", { token: adminToken });
    assert.equal(units.status, 200);
    assert.ok(units.body.some((unit) => unit.code === "KG"));

    const converted = await request(port, "POST", "/api/v1/classification/units/convert", { token: adminToken, body: { value: 1, from_unit: "KG", to_unit: "G" } });
    assert.equal(converted.status, 200);
    assert.equal(converted.body.value, 1000);

    const summary = await request(port, "GET", "/api/v1/classification/duplicates/summary", { token: adminToken });
    assert.equal(summary.status, 200);
    assert.equal(typeof summary.body.groups, "number");

    const scan = await request(port, "POST", "/api/v1/classification/duplicates/scan", { token: adminToken, body: {} });
    assert.equal(scan.status, 200);
    assert.equal(typeof scan.body.detected, "number");
  });

  test("updates configuration and enforces bounds", async () => {
    const update = await request(port, "PUT", "/api/v1/classification/config/bulk_batch_size", { token: adminToken, body: { value: 250 } });
    assert.equal(update.status, 200);
    assert.equal(update.body, 250);

    const invalid = await request(port, "PUT", "/api/v1/classification/config/max_hierarchy_depth", { token: adminToken, body: { value: 0 } });
    assert.equal(invalid.status, 400);

    const reread = await request(port, "GET", "/api/v1/classification/config", { token: adminToken });
    assert.equal(reread.body.bulk_batch_size, 250);
  });

  test("submits background jobs with idempotency", async () => {
    const first = await request(port, "POST", "/api/v1/classification/jobs/maintenance", { token: adminToken, headers: { "Idempotency-Key": "cla-api-idem-1" } });
    assert.equal(first.status, 202);
    const second = await request(port, "POST", "/api/v1/classification/jobs/maintenance", { token: adminToken, headers: { "Idempotency-Key": "cla-api-idem-1" } });
    assert.equal(second.status, 202);
    assert.equal(second.body.id, first.body.id);

    const bulk = await request(port, "POST", "/api/v1/classification/jobs/bulk-validate", { token: adminToken, body: { object_type: "product", object_ids: ["DEMO-PUMP-001"] } });
    assert.equal(bulk.status, 202);
    assert.ok(bulk.body.id);
  });

  test("serves history and lineage", async () => {
    const history = await request(port, "GET", "/api/v1/classification/history?entity_type=CLASSIFICATION", { token: adminToken });
    assert.equal(history.status, 200);
    assert.ok(history.body.total >= 1);

    const lineage = await request(port, "GET", "/api/v1/classification/lineage/product/DEMO-PUMP-001", { token: adminToken });
    assert.equal(lineage.status, 200);
  });
});

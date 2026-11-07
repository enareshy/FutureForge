process.env.FILE_STORAGE_PROVIDER = "memory";

// Stage 10 — Predictive Intelligence REST API tests.
//
// Proves the router is mounted on both prefixes, enforces authentication and IAM
// authorization, and returns the documented shapes for use cases, predictions,
// explanations, recommendations, evaluation gating and monitoring.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, queryOne, run, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import { createObject } from "../services/objects.js";
import { Foundation } from "../services/predictive-intelligence/index.js";

const IP = "127.0.0.1";

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

function ensureType(db, code, name, module) {
  const existing = queryOne(db, "SELECT id FROM metadata_types WHERE code = ? ORDER BY tenant_id NULLS LAST LIMIT 1", [code]);
  if (existing) return existing.id;
  return run(db, "INSERT INTO metadata_types (code, name, module, status, tenant_id) VALUES (?, ?, ?, 'active', NULL)", [code, name, module]).lastInsertId;
}

function requestChange(db, tenant, actor, objectId) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const inserted = run(
    db,
    `INSERT INTO change_requests
       (request_ref, tenant_id, request_number, title, category, priority, status, object_id, version, created_by, updated_by)
     VALUES (?, ?, ?, 'API change', 'DESIGN', 'HIGH', 'APPROVED', ?, 1, ?, ?)`,
    [`ECR-${stamp}`, tenant, `ECR-${stamp}`, objectId, actor.id, actor.id]
  );
  return queryOne(db, "SELECT * FROM change_requests WHERE id = ?", [inserted.lastInsertId]);
}

describe("Predictive Intelligence REST API (Stage 10)", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;
  let tenant;
  let actor;
  let product;
  let change;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    Foundation.ensurePredictiveFoundation(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    ensureType(db, "part", "Part", "plm");
    product = createObject(
      db,
      { type: "part", code: "PIAPI-PROD-1", name: "API product", status: "released", data: { "part.number": "PIAPI-PROD-1", "part.name": "API product", "part.category": "mechanical", "part.status": "released" } },
      actor,
      tenant,
      IP
    );
    change = requestChange(db, tenant, actor, product.id);
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
    const res = await request(port, "GET", "/api/v1/predictive-intelligence/meta");
    assert.equal(res.status, 401);
  });

  test("serves the capability vocabulary on both prefixes", async () => {
    const versioned = await request(port, "GET", "/api/v1/predictive-intelligence/meta", { token: adminToken });
    assert.equal(versioned.status, 200);
    assert.equal(versioned.body.source_module, "predictive-intelligence");
    assert.ok(versioned.body.methods.some((entry) => entry.method === "RULE_BASED"));
    assert.ok(versioned.body.built_in_use_cases.some((entry) => entry.code === "ENGINEERING_CHANGE_RISK"));
    assert.ok(versioned.body.dataset_requirements.ML_HOLDOUT);

    const unversioned = await request(port, "GET", "/api/predictive-intelligence/meta", { token: adminToken });
    assert.equal(unversioned.status, 200);
    assert.equal(unversioned.body.source_module, "predictive-intelligence");
  });

  test("denies a reader without predictive privileges", async () => {
    const res = await request(port, "GET", "/api/v1/predictive-intelligence/predictions", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("reports health and default configuration", async () => {
    const health = await request(port, "GET", "/api/v1/predictive-intelligence/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.ok(health.body.counts);

    const config = await request(port, "GET", "/api/v1/predictive-intelligence/config", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(config.body.prediction_ttl_hours, 168);
    assert.equal(config.body.min_data_volume, 50);
  });

  test("seeds and lists the built-in use cases", async () => {
    const seeded = await request(port, "POST", "/api/v1/predictive-intelligence/use-cases/seed", { token: adminToken, body: {} });
    assert.equal(seeded.status, 200);
    assert.ok(seeded.body.created >= 4);

    const listed = await request(port, "GET", "/api/v1/predictive-intelligence/use-cases", { token: adminToken });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((entry) => entry.code === "ENGINEERING_CHANGE_RISK"));
  });

  test("executes a prediction and returns method, risk, evidence and freshness", async () => {
    const res = await request(port, "POST", "/api/v1/predictive-intelligence/predictions", {
      token: adminToken,
      body: { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: "api-pred-1" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.prediction.method, "RULE_BASED");
    assert.equal(res.body.prediction.calibrated_probability, false);
    assert.ok(res.body.prediction.evidence.length >= 1);
    assert.ok(res.body.prediction.freshness_expires_at);
    assert.ok(res.body.prediction.explanation);

    const idempotent = await request(port, "POST", "/api/v1/predictive-intelligence/predictions", {
      token: adminToken,
      body: { use_case: "ENGINEERING_CHANGE_RISK", subject_type: "CHANGE", subject_ref: change.id, idempotency_key: "api-pred-1" },
    });
    assert.equal(idempotent.body.idempotent, true);
    assert.equal(idempotent.body.prediction.prediction_ref, res.body.prediction.prediction_ref);
  });

  test("lists prediction history and serves an explanation", async () => {
    const listed = await request(port, "GET", "/api/v1/predictive-intelligence/predictions?subject_type=CHANGE", { token: adminToken });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.total >= 1);
    const ref = listed.body.items[0].prediction_ref;

    const explanation = await request(port, "GET", `/api/v1/predictive-intelligence/predictions/${ref}/explanation`, { token: adminToken });
    assert.equal(explanation.status, 200);
    assert.equal(explanation.body.prediction_ref, ref);
    assert.equal(explanation.body.calibrated_probability, false);
    assert.ok(explanation.body.method_label);
  });

  test("generates and transitions recommendations", async () => {
    const prediction = await request(port, "POST", "/api/v1/predictive-intelligence/predictions", {
      token: adminToken,
      body: { use_case: "MANUFACTURING_READINESS_RISK", subject_type: "PRODUCT_REVISION", subject_ref: product.id, idempotency_key: "api-rec-pred" },
    });
    assert.equal(prediction.status, 200);

    const generated = await request(port, "POST", "/api/v1/predictive-intelligence/recommendations/generate", {
      token: adminToken,
      body: { prediction_ref: prediction.body.prediction.prediction_ref },
    });
    assert.equal(generated.status, 201);
    assert.ok(generated.body.count >= 1);
    const rec = generated.body.recommendations[0];
    assert.ok(rec.reason);
    assert.ok(Array.isArray(rec.evidence));

    const present = await request(port, "POST", `/api/v1/predictive-intelligence/recommendations/${rec.recommendation_ref}/transition`, { token: adminToken, body: { status: "PRESENTED" } });
    assert.equal(present.status, 200);
    assert.equal(present.body.status, "PRESENTED");

    const reject = await request(port, "POST", `/api/v1/predictive-intelligence/recommendations/${rec.recommendation_ref}/transition`, { token: adminToken, body: { status: "REJECTED", note: "not applicable" } });
    assert.equal(reject.status, 200);
    assert.equal(reject.body.status, "REJECTED");

    const invalid = await request(port, "POST", `/api/v1/predictive-intelligence/recommendations/${rec.recommendation_ref}/transition`, { token: adminToken, body: { status: "EXECUTED" } });
    assert.equal(invalid.status, 409);
    assert.equal(invalid.body.code, "PREDICTIVE_INVALID_TRANSITION");
  });

  test("records prediction feedback", async () => {
    const listed = await request(port, "GET", "/api/v1/predictive-intelligence/predictions?use_case=ENGINEERING_CHANGE_RISK", { token: adminToken });
    const ref = listed.body.items[0].prediction_ref;
    const res = await request(port, "POST", `/api/v1/predictive-intelligence/predictions/${ref}/feedback`, {
      token: adminToken,
      body: { outcome: "CONFIRMED", observed_risk_category: "HIGH", idempotency_key: "api-fbk" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.feedback.outcome, "CONFIRMED");
  });

  test("blocks marking a model validated without a measured evaluation", async () => {
    const res = await request(port, "POST", "/api/v1/predictive-intelligence/use-cases/QUALITY_RISK/evaluations", {
      token: adminToken,
      body: { validated: true, metrics: { accuracy: 0.9 } },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "PREDICTIVE_INVALID");

    const ok = await request(port, "POST", "/api/v1/predictive-intelligence/use-cases/QUALITY_RISK/evaluations", {
      token: adminToken,
      body: { validated: true, metrics: { accuracy: 0.9 }, baseline_metrics: { accuracy: 0.7 }, sample_size: 200, holdout_size: 40, leakage_checked: true, time_aware: true },
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.evaluation.validated, true);
  });

  test("serves model status and monitoring", async () => {
    const model = await request(port, "GET", "/api/v1/predictive-intelligence/use-cases/ENGINEERING_CHANGE_RISK/model", { token: adminToken });
    assert.equal(model.status, 200);
    assert.equal(model.body.ml_enabled, false);
    assert.match(model.body.reason, /rule/i);

    const monitoring = await request(port, "GET", "/api/v1/predictive-intelligence/monitoring", { token: adminToken });
    assert.equal(monitoring.status, 200);
    assert.ok(monitoring.body.freshness);
    assert.ok(["OK", "ALERT", "UNKNOWN"].includes(monitoring.body.drift.status));
    assert.ok(Array.isArray(monitoring.body.models));
  });

  test("rejects an unknown subject with a 404 and stable error code", async () => {
    const res = await request(port, "POST", "/api/v1/predictive-intelligence/predictions", {
      token: adminToken,
      body: { use_case: "QUALITY_RISK", subject_type: "PRODUCT_REVISION", subject_ref: 999999 },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "PREDICTIVE_SUBJECT_NOT_FOUND");
  });
});

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

describe("Migration & Onboarding Framework REST APIs", () => {
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
    const res = await request(port, "GET", "/api/v1/migration/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without migration privileges", async () => {
    const res = await request(port, "GET", "/api/v1/migration/projects", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the migration vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/migration/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "migration");
    assert.deepEqual(res.body.vocabularies.execution_modes, ["DRY_RUN", "EXECUTE", "VALIDATE"]);
    assert.ok(res.body.capabilities.source_adapter_types.length >= 10);
    assert.ok(res.body.capabilities.job_types.includes("DATA_MIGRATION"));
    assert.ok(res.body.capabilities.pipeline_stages.includes("RECONCILE"));
    assert.ok(res.body.security_actions.length > 0);
    assert.equal(res.body.resources.module, "iam.migration");
  });

  test("reports health and metrics", async () => {
    const health = await request(port, "GET", "/api/v1/migration/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.ok(["healthy", "degraded"].includes(health.body.status));

    const metrics = await request(port, "GET", "/api/v1/migration/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.equal(metrics.body.source_module, "migration");
    assert.equal(typeof metrics.body.projects, "number");
  });

  test("lists the pluggable source adapters", async () => {
    const res = await request(port, "GET", "/api/v1/migration/source-adapters", { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 10);
    assert.ok(res.body.items.some((adapter) => adapter.adapter_type === "LEGACY_TEAMCENTER"));
  });

  test("reads the seeded onboarding estate", async () => {
    const sources = await request(port, "GET", "/api/v1/migration/source-configurations", { token: adminToken });
    assert.equal(sources.status, 200);
    assert.ok(sources.body.items.some((source) => source.code === "LEGACY_TC"));

    const projects = await request(port, "GET", "/api/v1/migration/projects", { token: adminToken });
    assert.equal(projects.status, 200);
    assert.ok(projects.body.items.some((project) => project.code === "LEGACY_TC_ONBOARD"));

    const packages = await request(port, "GET", "/api/v1/migration/packages", { token: adminToken });
    assert.equal(packages.status, 200);
    assert.ok(packages.body.items.some((pkg) => pkg.code === "PART_MASTER"));

    const definitions = await request(port, "GET", "/api/v1/migration/definitions", { token: adminToken });
    assert.equal(definitions.status, 200);
    assert.ok(definitions.body.items.some((def) => def.code === "PART_MASTER_DEF"));

    const plans = await request(port, "GET", "/api/v1/migration/plans", { token: adminToken });
    assert.equal(plans.status, 200);
    assert.ok(plans.body.total >= 1);
  });

  test("tests and discovers a source configuration", async () => {
    const tested = await request(port, "POST", "/api/v1/migration/source-configurations/LEGACY_TC/test", { token: adminToken, body: {} });
    assert.equal(tested.status, 200);
    assert.equal(tested.body.code, "LEGACY_TC");
    assert.equal(typeof tested.body.connected, "boolean");

    const discovered = await request(port, "POST", "/api/v1/migration/source-configurations/LEGACY_TC/discover", { token: adminToken, body: {} });
    assert.equal(discovered.status, 200);
    assert.ok(Array.isArray(discovered.body.fields));
  });

  test("reports project and package readiness", async () => {
    const projects = await request(port, "GET", "/api/v1/migration/projects", { token: adminToken });
    const project = projects.body.items.find((entry) => entry.code === "LEGACY_TC_ONBOARD");
    const readiness = await request(port, "GET", `/api/v1/migration/projects/${project.id}/readiness`, { token: adminToken });
    assert.equal(readiness.status, 200);
    assert.equal(readiness.body.status, "READY");

    const packageReadiness = await request(port, "GET", "/api/v1/migration/packages/PART_MASTER/readiness", { token: adminToken });
    assert.equal(packageReadiness.status, 200);
    assert.equal(packageReadiness.body.readiness, "ready");
  });

  test("previews a migration package without persisting anything", async () => {
    const res = await request(port, "POST", "/api/v1/migration/packages/PART_MASTER/preview", { token: adminToken, body: { limit: 5 } });
    assert.equal(res.status, 200);
    assert.ok(res.body.record_count >= 1);
    assert.equal(res.body.invalid, 0);
  });

  test("creates a migration job and is idempotent", async () => {
    const res = await request(port, "POST", "/api/v1/migration/packages/PART_MASTER/jobs", { token: adminToken, body: { mode: "EXECUTE" } });
    assert.equal(res.status, 202);
    assert.ok(res.body.job.job_ref);
    assert.equal(res.body.platform_job.job_type_code, "DATA_MIGRATION");

    const again = await request(port, "POST", "/api/v1/migration/packages/PART_MASTER/jobs", {
      token: adminToken,
      body: { mode: "EXECUTE", idempotency_key: "api-migration-idem" },
      headers: { "Idempotency-Key": "api-migration-idem" },
    });
    assert.equal(again.status, 202);
    const repeat = await request(port, "POST", "/api/v1/migration/packages/PART_MASTER/jobs", {
      token: adminToken,
      body: { mode: "EXECUTE" },
      headers: { "Idempotency-Key": "api-migration-idem" },
    });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.job.job_ref, again.body.job.job_ref);
  });

  test("lists jobs and reconciles one", async () => {
    const jobs = await request(port, "GET", "/api/v1/migration/jobs", { token: adminToken });
    assert.equal(jobs.status, 200);
    assert.ok(jobs.body.total >= 1);
    const jobRef = jobs.body.items[0].job_ref;

    const detail = await request(port, "GET", `/api/v1/migration/jobs/${jobRef}`, { token: adminToken });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.job_ref, jobRef);

    const errors = await request(port, "GET", `/api/v1/migration/jobs/${jobRef}/errors`, { token: adminToken });
    assert.equal(errors.status, 200);
    assert.ok(Array.isArray(errors.body.items));

    const reconcile = await request(port, "POST", `/api/v1/migration/jobs/${jobRef}/reconcile`, { token: adminToken, body: { strategy: "COUNT" } });
    assert.equal(reconcile.status, 201);
    assert.ok(["COMPLETED", "VARIANCE"].includes(reconcile.body.status));
  });

  test("reads reconciliation, statistics and audit registers", async () => {
    const reconciliations = await request(port, "GET", "/api/v1/migration/reconciliations", { token: adminToken });
    assert.equal(reconciliations.status, 200);
    assert.ok(reconciliations.body.total >= 1);

    const statistics = await request(port, "GET", "/api/v1/migration/statistics", { token: adminToken });
    assert.equal(statistics.status, 200);

    const audit = await request(port, "GET", "/api/v1/migration/audit", { token: adminToken });
    assert.equal(audit.status, 200);
    assert.ok(Array.isArray(audit.body.items));
    assert.equal(typeof audit.body.total, "number");

    const lineage = await request(port, "GET", "/api/v1/migration/object-lineage", { token: adminToken });
    assert.equal(lineage.status, 400);
  });

  test("creates projects and packages over REST", async () => {
    const project = await request(port, "POST", "/api/v1/migration/projects", {
      token: adminToken,
      body: { code: "API_PROJECT", name: "API project", source_system: "Teamcenter" },
    });
    assert.equal(project.status, 201);
    assert.equal(project.body.code, "API_PROJECT");

    const pkg = await request(port, "POST", "/api/v1/migration/packages", {
      token: adminToken,
      body: {
        project_id: project.body.id,
        code: "API_PACKAGE",
        name: "API package",
        target_object_type: "product",
        source: { adapter_type: "DATABASE", settings: { records: [] } },
        mappings: [{ source_field: "part_number", target_field: "part.number", mapping_type: "DIRECT", required: true }],
      },
    });
    assert.equal(pkg.status, 201);
    assert.equal(pkg.body.code, "API_PACKAGE");

    const status = await request(port, "POST", `/api/v1/migration/projects/${project.body.id}/status`, { token: adminToken, body: { status: "READY" } });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, "READY");
  });

  test("maps identifiers over REST", async () => {
    const created = await request(port, "POST", "/api/v1/migration/identifier-mappings", {
      token: adminToken,
      body: { source_system: "Teamcenter", source_object_type: "Part", source_object_id: "API-SRC-1", target_object_type: "product", target_object_id: "API-TGT-1" },
    });
    assert.equal(created.status, 201);

    const resolved = await request(port, "GET", "/api/v1/migration/identifier-mappings/resolve?source_system=Teamcenter&source_object_type=Part&source_object_id=API-SRC-1", { token: adminToken });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.target_object_id, "API-TGT-1");

    const listed = await request(port, "GET", "/api/v1/migration/identifier-mappings", { token: adminToken });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.total >= 1);
  });

  test("reads and updates configuration with validated bounds", async () => {
    const config = await request(port, "GET", "/api/v1/migration/configuration", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(typeof config.body.config.default_batch_size, "number");

    const updated = await request(port, "PUT", "/api/v1/migration/configuration/default_batch_size", { token: adminToken, body: { value: 750 } });
    assert.equal(updated.status, 200);
    assert.equal(Number(updated.body.value), 750);

    const invalid = await request(port, "PUT", "/api/v1/migration/configuration/default_batch_size", { token: adminToken, body: { value: -5 } });
    assert.equal(invalid.status, 400);
    assert.ok(invalid.body.error);
  });

  test("standardizes error payloads", async () => {
    const res = await request(port, "GET", "/api/v1/migration/jobs/NOPE/errors", { token: adminToken });
    assert.equal(res.status, 404);
    assert.ok(res.body.error);

    const forbidden = await request(port, "POST", "/api/v1/migration/seed", { token: readerToken });
    assert.equal(forbidden.status, 403);
  });
});

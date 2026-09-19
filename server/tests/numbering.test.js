process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import * as numbering from "../services/numbering.js";

function actorRow(db, username) {
  return queryOne(db, "SELECT * FROM users WHERE username = ?", [username]);
}

function createTestScheme(db, actor, tenantId, overrides = {}) {
  const code = overrides.code || `T_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  return numbering.Schemes.createScheme(
    db,
    {
      name: `Test scheme ${code}`,
      object_type_code: "PART",
      pattern: "TST-{SEQ}",
      padding: 4,
      sequence_scope: "scheme",
      reset_policy: "never",
      numbering_mode: "automatic",
      status: "active",
      ...overrides,
      code,
    },
    actor,
    tenantId,
    "test"
  );
}

describe("Numbering token & scope engine", () => {
  let db;
  let admin;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    admin = actorRow(db, "admin");
  });

  after(() => db?.close());

  test("parses patterns into static text and known tokens", () => {
    const parsed = numbering.Tokens.parsePattern("PART-{YYYY}-{SEQ}");
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.tokens, ["YYYY", "SEQ"]);
    assert.equal(numbering.Tokens.renderPatternWithValues("PART-{YYYY}-{SEQ}", { YYYY: "2026", SEQ: "1" }), "PART-2026-1");
  });

  test("flags unknown tokens in a pattern", () => {
    const check = numbering.Tokens.checkPatternTokens(db, "{BOGUS}-{SEQ}");
    assert.equal(check.valid, false);
    assert.deepEqual(check.unknownTokens, ["BOGUS"]);
  });

  test("registers system tokens and default object types", () => {
    const tokens = numbering.Tokens.listTokens(db).map((t) => t.code);
    for (const code of ["SEQ", "YYYY", "YY", "MM", "DD", "ORG", "TYPE"]) assert.ok(tokens.includes(code), code);
    const types = numbering.Foundation.listObjectTypes(db, { tenantId: admin.tenant_id ?? null }).map((t) => t.code);
    for (const code of ["PART", "PRODUCT", "DOCUMENT", "BOM", "DRAWING", "CHANGE", "SUPPLIER"]) assert.ok(types.includes(code), code);
  });

  test("computes period keys and fiscal year deterministically", () => {
    assert.equal(numbering.Scopes.fiscalYearOf(new Date("2026-05-01T00:00:00Z")), 2026);
    assert.equal(numbering.Scopes.fiscalYearOf(new Date("2026-02-01T00:00:00Z")), 2025);
    assert.equal(numbering.Scopes.buildPeriodKey("yearly", new Date("2026-09-19T00:00:00Z")), "2026");
    assert.equal(numbering.Scopes.buildPeriodKey("monthly", new Date("2026-09-19T00:00:00Z")), "2026-09");
    assert.equal(numbering.Scopes.buildPeriodKey("never", new Date("2026-09-19T00:00:00Z")), "");
  });

  test("builds deterministic scope keys per sequence scope", () => {
    const orgA = numbering.Scopes.buildScopeKey({ sequenceScope: "organization", tenantId: 1, organizationId: 10 });
    const orgB = numbering.Scopes.buildScopeKey({ sequenceScope: "organization", tenantId: 1, organizationId: 11 });
    assert.notEqual(orgA, orgB);
    assert.equal(orgA, numbering.Scopes.buildScopeKey({ sequenceScope: "organization", tenantId: 1, organizationId: 10 }));
  });
});

describe("Numbering Service generation & lifecycle", () => {
  let db;
  let admin;
  let tenantId;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    admin = actorRow(db, "admin");
    tenantId = admin.tenant_id ?? admin.organization_id;
  });

  after(() => db?.close());

  test("generates sequentially padded identifiers", () => {
    const scheme = createTestScheme(db, admin, tenantId, { pattern: "SEQ-{YYYY}-{SEQ}", padding: 6 });
    const first = numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, admin, { tenantId });
    const second = numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, admin, { tenantId });
    assert.match(first.number, /^SEQ-\d{4}-000001$/);
    assert.match(second.number, /^SEQ-\d{4}-000002$/);
    assert.equal(first.status, "allocated");
    assert.equal(second.sequence_value, first.sequence_value + 1);
  });

  test("preview never consumes the sequence", () => {
    const scheme = createTestScheme(db, admin, tenantId, { pattern: "PRV-{SEQ}", padding: 5 });
    const a = numbering.previewIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, { tenantId });
    const b = numbering.previewIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, { tenantId });
    assert.equal(a.number, b.number);
    assert.equal(a.would_reset, false);
    const generated = numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, admin, { tenantId });
    assert.equal(generated.number, a.number);
  });

  test("yearly reset restarts the counter in a new period", () => {
    const scheme = createTestScheme(db, admin, tenantId, { pattern: "YR-{YYYY}-{SEQ}", padding: 3, reset_policy: "yearly" });
    const y2025 = numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, admin, {
      tenantId,
      now: new Date("2025-06-01T00:00:00Z"),
    });
    const y2026 = numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, admin, {
      tenantId,
      now: new Date("2026-06-01T00:00:00Z"),
    });
    assert.equal(y2025.number, "YR-2025-001");
    assert.equal(y2026.number, "YR-2026-001");
    assert.equal(y2026.sequence_value, 1);
  });

  test("isolates sequences per organization scope", () => {
    const scheme = createTestScheme(db, admin, tenantId, { pattern: "ORG-{SEQ}", padding: 4, sequence_scope: "organization" });
    const a = numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code, organizationId: 10 }, admin, { tenantId });
    const b = numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code, organizationId: 11 }, admin, { tenantId });
    const a2 = numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code, organizationId: 10 }, admin, { tenantId });
    assert.equal(a.number, "ORG-0001");
    assert.equal(b.number, "ORG-0001");
    assert.equal(a2.number, "ORG-0002");
  });

  test("idempotency key replays the same allocation", () => {
    const scheme = createTestScheme(db, admin, tenantId);
    const first = numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, admin, {
      tenantId,
      idempotencyKey: "idem-abc",
    });
    const replay = numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, admin, {
      tenantId,
      idempotencyKey: "idem-abc",
    });
    assert.equal(replay.id, first.id);
    assert.equal(replay.number, first.number);
  });

  test("concurrent-style burst yields unique identifiers", () => {
    const scheme = createTestScheme(db, admin, tenantId, { padding: 6 });
    const numbers = new Set();
    for (let i = 0; i < 40; i += 1) {
      const allocation = numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, admin, { tenantId });
      numbers.add(allocation.number);
    }
    assert.equal(numbers.size, 40);
  });

  test("reserve, consume, release and cancel move through the lifecycle", () => {
    const scheme = createTestScheme(db, admin, tenantId);
    const reserved = numbering.reserveIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, admin, { tenantId });
    assert.equal(reserved.status, "reserved");
    const consumed = numbering.consumeIdentifier(db, reserved.id, { reference: "PART-1" }, admin, { tenantId });
    assert.equal(consumed.status, "consumed");

    const toRelease = numbering.reserveIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, admin, { tenantId });
    const released = numbering.releaseIdentifier(db, toRelease.id, { reason: "not needed" }, admin, { tenantId });
    assert.equal(released.status, "released");

    const toCancel = numbering.reserveIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, admin, { tenantId });
    const cancelled = numbering.cancelIdentifier(db, toCancel.id, { reason: "error" }, admin, { tenantId });
    assert.equal(cancelled.status, "cancelled");
  });

  test("expires reservations past their timeout", () => {
    const scheme = createTestScheme(db, admin, tenantId);
    const reserved = numbering.reserveIdentifier(
      db,
      { objectType: "PART", schemeCode: scheme.code, reservationTimeoutSeconds: 1 },
      admin,
      { tenantId }
    );
    assert.equal(reserved.status, "reserved");
    const result = numbering.expireReservations(db, { now: new Date(Date.now() + 60000) });
    assert.ok(result.expired_count >= 1);
    const after = numbering.getAllocation(db, reserved.id);
    assert.equal(after.status, "expired");
  });

  test("accepts manual numbers when policy allows and rejects duplicates", () => {
    const scheme = createTestScheme(db, admin, tenantId, {
      numbering_mode: "automatic_with_manual_override",
      manual_policy: "allowed",
      manual_pattern: "^MAN-\\d{3}$",
      pattern: "AUTO-{SEQ}",
    });
    const manual = numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code, manualNumber: "MAN-001" }, admin, { tenantId });
    assert.equal(manual.number, "MAN-001");
    assert.throws(
      () => numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code, manualNumber: "MAN-001" }, admin, { tenantId }),
      (err) => err.status === 409 || /duplicate|exists|reuse/i.test(err.message)
    );
    assert.throws(
      () => numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code, manualNumber: "bad number" }, admin, { tenantId }),
      (err) => err.status === 422 || /format|rejected/i.test(err.message)
    );
  });

  test("validates identifiers against the scheme and reports existence", () => {
    const scheme = createTestScheme(db, admin, tenantId, { pattern: "{TYPE}-{SEQ}", padding: 4 });
    const generated = numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, admin, { tenantId });
    const existing = numbering.validateIdentifier(db, { objectType: "PART", schemeCode: scheme.code, number: generated.number }, { tenantId });
    assert.equal(existing.valid, true);
    assert.ok(existing.warnings.length >= 1);
    const malformed = numbering.validateIdentifier(db, { objectType: "PART", schemeCode: scheme.code, number: "!!!" }, { tenantId });
    assert.equal(malformed.valid, false);
  });

  test("records audit trail and domain events", () => {
    const scheme = createTestScheme(db, admin, tenantId);
    const allocation = numbering.generateIdentifier(db, { objectType: "PART", schemeCode: scheme.code }, admin, { tenantId });
    const audit = queryOne(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE resource_type = 'numbering_allocation' AND resource_id = ?", [
      String(allocation.id),
    ]);
    assert.ok(audit.n >= 1);
    const event = queryOne(db, "SELECT COUNT(*) AS n FROM event_outbox WHERE aggregate_id = ?", [String(allocation.id)]);
    assert.ok(event.n >= 1);
  });

  test("exposes metrics and a healthy readiness probe", () => {
    const metrics = numbering.metricsSnapshot(db, { tenantId });
    assert.ok(metrics.schemes.total >= 1);
    assert.ok(metrics.allocations.in_range >= 1);
    const health = numbering.Metrics.healthCheck(db, { tenantId });
    assert.equal(health.healthy, true);
    assert.equal(health.ready, true);
  });

  test("refuses ambiguous scheme resolution deterministically", () => {
    createTestScheme(db, admin, tenantId, { code: "AMB_A", is_default: false, priority: 50 });
    createTestScheme(db, admin, tenantId, { code: "AMB_B", is_default: false, priority: 50 });
    assert.throws(
      () => numbering.Scopes.resolveApplicableScheme(db, { objectTypeCode: "PART", tenantId, now: new Date() }),
      (err) => err.status === 409 || /ambiguous/i.test(err.message)
    );
  });
});

describe("Numbering REST API", () => {
  let db;
  let server;
  let port;

  before(async () => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    const app = createApp(db);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db?.close();
  });

  function request(method, path, { token, body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            let parsed = Buffer.concat(chunks).toString("utf8");
            try {
              parsed = parsed ? JSON.parse(parsed) : null;
            } catch {
              /* keep text */
            }
            resolve({ status: res.statusCode, body: parsed });
          });
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function login(username, password) {
    const res = await request("POST", "/api/auth/login", { body: { username, password } });
    return res.body.token;
  }

  test("lists seeded schemes and exposes metadata", async () => {
    const token = await login("admin", "HelixAdmin!42");
    const schemes = await request("GET", "/api/numbering/schemes", { token });
    assert.equal(schemes.status, 200);
    assert.ok(schemes.body.items.some((s) => s.code === "PART_STANDARD"));
    const meta = await request("GET", "/api/numbering/meta", { token });
    assert.equal(meta.status, 200);
    assert.ok(Array.isArray(meta.body.tokens));
  });

  test("generates, previews and validates through the API", async () => {
    const token = await login("admin", "HelixAdmin!42");
    const preview = await request("POST", "/api/numbering/preview", { token, body: { objectType: "PART" } });
    assert.equal(preview.status, 200);
    assert.match(preview.body.number, /^PART-\d{4}-\d{6}$/);

    const generated = await request("POST", "/api/numbering/generate", { token, body: { objectType: "PART" } });
    assert.equal(generated.status, 201);
    assert.match(generated.body.number, /^PART-\d{4}-\d{6}$/);

    const replay = await request("POST", "/api/numbering/generate", {
      token,
      body: { objectType: "PART" },
      headers: { "Idempotency-Key": "api-idem-1" },
    });
    const replay2 = await request("POST", "/api/numbering/generate", {
      token,
      body: { objectType: "PART" },
      headers: { "Idempotency-Key": "api-idem-1" },
    });
    assert.equal(replay.body.number, replay2.body.number);

    const validation = await request("POST", "/api/numbering/validate", { token, body: { objectType: "PART", number: generated.body.number } });
    assert.equal(validation.status, 200);
    assert.equal(validation.body.valid, true);
  });

  test("serves allocations, sequences and monitoring", async () => {
    const token = await login("admin", "HelixAdmin!42");
    const allocations = await request("GET", "/api/numbering/allocations?pageSize=5", { token });
    assert.equal(allocations.status, 200);
    assert.ok(allocations.body.total >= 1);

    const sequences = await request("GET", "/api/numbering/sequences", { token });
    assert.equal(sequences.status, 200);
    assert.ok(sequences.body.items.length >= 1);

    const metrics = await request("GET", "/api/numbering/metrics", { token });
    assert.equal(metrics.status, 200);

    const health = await request("GET", "/api/numbering/health", { token });
    assert.equal(health.status, 200);
    assert.equal(health.body.healthy, true);
  });

  test("enforces permissions for non-administrators", async () => {
    const token = await login("j.patel", "HelixUser!42");
    const schemes = await request("GET", "/api/numbering/schemes", { token });
    assert.equal(schemes.status, 200);
    const denied = await request("POST", "/api/numbering/schemes", {
      token,
      body: { code: "NOPE_SCHEME", name: "Nope", objectType: "PART" },
    });
    assert.equal(denied.status, 403);
  });

  test("supports scheme lifecycle administration", async () => {
    const token = await login("admin", "HelixAdmin!42");
    const created = await request("POST", "/api/numbering/schemes", {
      token,
      body: { code: "API_TEST_SCHEME", name: "API test", objectType: "PART", pattern: "API-{SEQ}", status: "draft" },
    });
    assert.equal(created.status, 201);
    const activated = await request("POST", "/api/numbering/schemes/API_TEST_SCHEME/activate", { token, body: {} });
    assert.equal(activated.status, 200);
    assert.equal(activated.body.status, "active");
    const cloned = await request("POST", "/api/numbering/schemes/API_TEST_SCHEME/clone", { token, body: { code: "API_TEST_CLONE" } });
    assert.equal(cloned.status, 201);
    const retired = await request("POST", "/api/numbering/schemes/API_TEST_CLONE/retire", { token, body: {} });
    assert.equal(retired.status, 200);
    assert.equal(retired.body.status, "retired");
    const removed = await request("DELETE", "/api/numbering/schemes/API_TEST_CLONE", { token });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);
  });
});

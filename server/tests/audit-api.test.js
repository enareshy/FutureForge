import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, path, { token, body, raw } = {}) {
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
          let parsed = data;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: raw ? data : parsed, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("audit REST APIs", () => {
  let port;
  let server;
  let token;
  let userToken;
  let database;
  let tenantId;

  before(async () => {
    database = openDatabase(":memory:");
    migrate(database);
    seedDatabase(database);
    tenantId = queryOne(database, "SELECT id FROM organizations WHERE code = 'helix'").id;
    const started = await listen(createApp(database));
    server = started.server;
    port = started.port;
    const login = await request(port, "POST", "/api/auth/login", {
      body: { username: "admin", password: "HelixAdmin!42" },
    });
    assert.equal(login.status, 200);
    token = login.body.token;
    const userLogin = await request(port, "POST", "/api/auth/login", {
      body: { username: "j.patel", password: "HelixUser!42" },
    });
    assert.equal(userLogin.status, 200);
    userToken = userLogin.body.token;
  });

  after(() => server?.close());

  test("requires authentication", async () => {
    const events = await request(port, "GET", "/api/audit/events");
    assert.equal(events.status, 401);
    const policies = await request(port, "GET", "/api/audit/policies");
    assert.equal(policies.status, 401);
  });

  test("lists events, summary and facets with filters", async () => {
    const events = await request(port, "GET", "/api/audit/events?pageSize=5&order=asc", { token });
    assert.equal(events.status, 200);
    assert.ok(events.body.total > 0);
    assert.ok(events.body.items.length <= 5);
    assert.ok("occurred_at" in events.body.items[0]);

    const partEvents = await request(port, "GET", "/api/audit/events?objectType=part", { token });
    assert.equal(partEvents.status, 200);
    assert.ok(partEvents.body.items.every((e) => e.object_type === "part"));

    const summary = await request(port, "GET", "/api/audit/summary", { token });
    assert.equal(summary.status, 200);
    assert.ok(summary.body.total > 0);
    assert.ok(Array.isArray(summary.body.by_type));

    const facets = await request(port, "GET", "/api/audit/facets", { token });
    assert.equal(facets.status, 200);
    assert.ok(facets.body.actions.length > 0);
  });

  test("manually records and reads back an audit event", async () => {
    const created = await request(port, "POST", "/api/audit/events", {
      token,
      body: {
        action: "integration.sync",
        objectType: "external_system",
        objectId: "erp-1",
        objectName: "ERP connector",
        status: "success",
        source: "integration",
        before: { state: "idle" },
        after: { state: "synced" },
        reason: "nightly sync",
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.action, "integration.sync");
    assert.equal(created.body.object_type, "external_system");
    assert.equal(created.body.source, "integration");
    assert.ok(created.body.changed_fields.includes("state"));

    const detail = await request(port, "GET", `/api/audit/events/${created.body.id}`, { token });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.reason, "nightly sync");

    const missing = await request(port, "GET", "/api/audit/events/999999", { token });
    assert.equal(missing.status, 404);
  });

  test("records object create/update with attribute-level before and after", async () => {
    const created = await request(port, "POST", "/api/objects", {
      token,
      body: {
        type: "part",
        name: "Audit integration part",
        data: { "part.number": "AUD-9001", "part.name": "Audit integration part", "part.category": "mechanical" },
      },
    });
    assert.equal(created.status, 201);
    const objectId = created.body.id;

    const updated = await request(port, "PUT", `/api/objects/${objectId}`, {
      token,
      body: { data: { "part.notes": "created for audit coverage" }, change_summary: "add note" },
    });
    assert.ok(updated.status === 200 || updated.status === 201, `unexpected status ${updated.status}`);

    const history = await request(port, "GET", `/api/audit/objects/object/${objectId}/history`, { token });
    assert.equal(history.status, 200);
    assert.ok(history.body.total >= 2);
    const update = history.body.items.find((e) => e.action === "object.update");
    assert.ok(update, "object update is audited");
    assert.equal(update.object_name, "Audit integration part");
    assert.ok(update.changed_fields.includes("part.notes"));
    assert.equal(update.after_values["part.notes"], "created for audit coverage");
  });

  test("enforces per-object audit visibility from the policy", async () => {
    // The seed sets the part policy to user visibility, so an end user may read
    // part history but not the default admin-only history of other types.
    const partHistory = await request(port, "GET", "/api/audit/objects/part/PART-000001/history", {
      token: userToken,
    });
    assert.equal(partHistory.status, 200);
    assert.ok(partHistory.body.total >= 1);

    const restricted = await request(port, "GET", "/api/audit/objects/bank_account/ACCT-1/history", {
      token: userToken,
    });
    assert.equal(restricted.status, 403);

    const events = await request(port, "GET", "/api/audit/events", { token: userToken });
    assert.equal(events.status, 403);

    const adminPart = await request(port, "GET", "/api/audit/objects/part/PART-000001/history", { token });
    assert.equal(adminPart.status, 200);
  });

  test("manages audit policies", async () => {
    const list = await request(port, "GET", "/api/audit/policies", { token });
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((p) => p.object_type === "*"));

    const created = await request(port, "POST", "/api/audit/policies", {
      token,
      body: {
        name: "Documents",
        object_type: "document",
        visibility: "manager",
        capture_downloads: true,
        masked_attributes: ["document.classification"],
        retention_days: 900,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.object_type, "document");
    assert.deepEqual(created.body.masked_attributes, ["document.classification"]);

    const updated = await request(port, "PUT", `/api/audit/policies/${created.body.id}`, {
      token,
      body: { visibility: "admin", retention_days: 365 },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.visibility, "admin");
    assert.equal(updated.body.retention_days, 365);

    const duplicate = await request(port, "POST", "/api/audit/policies", {
      token,
      body: { name: "Dup", object_type: "document" },
    });
    assert.equal(duplicate.status, 409);

    const removed = await request(port, "DELETE", `/api/audit/policies/${created.body.id}`, { token });
    assert.equal(removed.status, 200);
  });

  test("exports filtered history and audits the export itself", async () => {
    const csv = await request(port, "POST", "/api/audit/export", {
      token,
      raw: true,
      body: { format: "csv", filters: { objectType: "part" }, reason: "compliance review" },
    });
    assert.equal(csv.status, 200);
    assert.match(csv.headers["content-type"], /csv/);
    assert.match(csv.headers["content-disposition"], /attachment/);
    assert.match(csv.body, /Event ID,Timestamp \(UTC\)/);

    const excel = await request(port, "POST", "/api/audit/export", {
      token,
      raw: true,
      body: { format: "excel", filters: { objectType: "part" } },
    });
    assert.equal(excel.status, 200);
    assert.match(excel.headers["content-type"], /ms-excel/);
    assert.match(excel.body, /<Workbook/);

    const exportEvents = await request(port, "GET", "/api/audit/events?action=audit.export", { token });
    assert.ok(exportEvents.body.total >= 2);
    assert.equal(exportEvents.body.items[0].event_type, "EXPORT");
  });

  test("runs retention in dry-run mode and lists runs", async () => {
    const dryRun = await request(port, "POST", "/api/audit/retention/run", {
      token,
      body: { tenantId, dryRun: true },
    });
    assert.equal(dryRun.status, 200);
    assert.equal(dryRun.body.dry_run, true);

    const runs = await request(port, "GET", "/api/audit/retention/runs", { token });
    assert.equal(runs.status, 200);
    assert.ok(runs.body.total >= 1);
  });

  test("keeps tenants isolated while platform admins can cross-check", async () => {
    const other = database
      .prepare(
        "INSERT INTO organizations (code, name, kind, status) VALUES ('orbit', 'Orbit', 'tenant', 'active') RETURNING id"
      )
      .get();
    database
      .prepare(
        `INSERT INTO audit_logs (tenant_id, actor_username, action, event_type, source, status, resource_type, resource_id, created_at)
         VALUES (?, 'system', 'object.create', 'CREATE', 'system', 'success', 'part', 'PART-ORBIT-1', datetime('now'))`
      )
      .run(other.id);

    const crossCheck = await request(port, "GET", `/api/audit/events?tenantId=${other.id}&pageSize=50`, { token });
    assert.equal(crossCheck.status, 200);
    assert.ok(crossCheck.body.total >= 1);
    assert.ok(crossCheck.body.items.every((e) => e.tenant_id === other.id));

    // A plain tenant user cannot read the firehose nor another tenant's object.
    const userScoped = await request(port, "GET", "/api/audit/events", { token: userToken });
    assert.equal(userScoped.status, 403);

    const otherTenantHistory = await request(
      port,
      "GET",
      "/api/audit/objects/part/PART-ORBIT-1/history",
      { token: userToken }
    );
    assert.equal(otherTenantHistory.body.total, 0);
  });

  test("automatically records failed access attempts", async () => {
    const denied = await request(port, "GET", "/api/audit/events");
    assert.equal(denied.status, 401);
    await sleep(50);
    const recorded = await request(
      port,
      "GET",
      "/api/audit/events?action=access.unauthenticated&status=failure",
      { token }
    );
    assert.equal(recorded.status, 200);
    assert.ok(recorded.body.total >= 1);
    assert.equal(recorded.body.items[0].event_type, "ACCESS_DENIED");
  });

  test("audit events are read-only through the API", async () => {
    const events = await request(port, "GET", "/api/audit/events?pageSize=1", { token });
    const id = events.body.items[0].id;
    const update = await request(port, "PUT", `/api/audit/events/${id}`, { token, body: { action: "tamper" } });
    assert.equal(update.status, 404);
    const remove = await request(port, "DELETE", `/api/audit/events/${id}`, { token });
    assert.equal(remove.status, 404);
  });
});

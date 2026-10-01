import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, openTestDatabase, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
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
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const newProduct = (code, name) => ({
  type: "product",
  code,
  name,
  data: {
    "part.number": code,
    "part.name": name,
    "part.category": "mechanical",
    "part.status": "draft",
  },
});

describe("async object writes", () => {
  let database;
  let port;
  let server;
  let token;

  before(async () => {
    database = openTestDatabase();
    migrate(database);
    seedDatabase(database);
    const started = await listen(createApp(database));
    server = started.server;
    port = started.port;
    const login = await request(port, "POST", "/api/auth/login", {
      body: { username: "admin", password: "HelixAdmin!42" },
    });
    assert.equal(login.status, 200);
    token = login.body.token;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("lists object types through the async layer", async () => {
    const types = await request(port, "GET", "/api/object-types", { token });
    assert.equal(types.status, 200);
    assert.ok(types.body.items.some((t) => t.code === "product"));
  });

  test("create emits ObjectCreated through the outbox and audits", async () => {
    const invalid = await request(port, "POST", "/api/objects", {
      token,
      body: { type: "product", code: "ASYNC-7000", name: "Nope", data: {} },
    });
    assert.equal(invalid.status, 422);

    const created = await request(port, "POST", "/api/objects", {
      token,
      body: newProduct("ASYNC-7000", "Async Widget"),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.revision, 1);
    const id = created.body.id;

    const event = queryOne(
      database,
      "SELECT * FROM event_records WHERE event_type_code = 'ObjectCreated' AND source_object_id = ?",
      [String(id)]
    );
    assert.ok(event, "ObjectCreated event is stored");
    const outbox = queryOne(database, "SELECT * FROM event_outbox WHERE event_ref = ?", [event.event_ref]);
    assert.ok(outbox, "outbox row is enqueued for the event");

    const audit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'object.create' AND resource_id = ?",
      [String(id)]
    );
    assert.ok(audit, "object.create is audited");

    const version = queryOne(database, "SELECT * FROM object_versions WHERE object_id = ? AND change_type = 'create'", [
      id,
    ]);
    assert.ok(version, "create version row is recorded");
  });

  test("rejects duplicate codes with 409", async () => {
    const duplicate = await request(port, "POST", "/api/objects", {
      token,
      body: newProduct("ASYNC-7000", "Duplicate"),
    });
    assert.equal(duplicate.status, 409);
  });

  test("update emits ObjectUpdated and enforces optimistic locking", async () => {
    const created = await request(port, "POST", "/api/objects", {
      token,
      body: newProduct("ASYNC-7001", "Async Edit"),
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const update = await request(port, "PUT", `/api/objects/${id}`, {
      token,
      body: { name: "Async Edited", revision: created.body.revision },
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.name, "Async Edited");

    const stale = await request(port, "PUT", `/api/objects/${id}`, {
      token,
      body: { name: "Stale", revision: created.body.revision },
    });
    assert.equal(stale.status, 409);

    const event = queryOne(
      database,
      "SELECT * FROM event_records WHERE event_type_code = 'ObjectUpdated' AND source_object_id = ?",
      [String(id)]
    );
    assert.ok(event, "ObjectUpdated event is stored");
  });

  test("status, checkout, checkin and version reads run on the async layer", async () => {
    const created = await request(port, "POST", "/api/objects", {
      token,
      body: newProduct("ASYNC-7002", "Lifecycle"),
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const status = await request(port, "POST", `/api/objects/${id}/status`, {
      token,
      body: { status: "active" },
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, "active");

    const versions = await request(port, "GET", `/api/objects/${id}/versions`, { token });
    assert.equal(versions.status, 200);
    assert.equal(versions.body.total, 2);

    const version = await request(port, "GET", `/api/objects/${id}/versions/1`, { token });
    assert.equal(version.status, 200);
    assert.equal(version.body.change_type, "create");

    const checkout = await request(port, "POST", `/api/objects/${id}/checkout`, {
      token,
      body: { reason: "editing" },
    });
    assert.equal(checkout.status, 200);
    assert.equal(checkout.body.checkout.locked_by, 1);

    const locks = await request(port, "GET", `/api/objects/${id}/locks`, { token });
    assert.equal(locks.status, 200);
    assert.equal(locks.body.items.length, 1);

    const checkin = await request(port, "POST", `/api/objects/${id}/checkin`, { token, body: {} });
    assert.equal(checkin.status, 200);
    assert.equal(checkin.body.object.locked, false);
  });

  test("relationship writes, validation and traversal run on the async layer", async () => {
    const types = await request(port, "GET", "/api/relationship-types?q=has-revision", { token });
    assert.equal(types.status, 200);
    const hasRevision = types.body.items[0];
    assert.ok(hasRevision);

    const prod1 = (await request(port, "GET", "/api/objects?code=PROD-1000", { token })).body.items[0];
    const prod2 = (await request(port, "GET", "/api/objects?code=PROD-2000", { token })).body.items[0];

    const validate = await request(port, "POST", "/api/relationships/validate", {
      token,
      body: { type: hasRevision.id, source: prod1.id, target: prod2.id },
    });
    assert.equal(validate.status, 200);
    assert.equal(validate.body.valid, false);

    const self = await request(port, "POST", "/api/relationships", {
      token,
      body: { type: hasRevision.id, source: prod1.id, target: prod1.id },
    });
    assert.equal(self.status, 400);

    const rels = await request(port, "GET", `/api/objects/${prod1.id}/relationships`, { token });
    assert.equal(rels.status, 200);
    assert.ok(rels.body.outgoing.length >= 2);

    const tree = await request(port, "GET", `/api/objects/${prod1.id}/tree?depth=2`, { token });
    assert.equal(tree.status, 200);
    assert.equal(tree.body.root.id, prod1.id);

    const graph = await request(port, "GET", `/api/objects/${prod1.id}/graph?depth=2`, { token });
    assert.equal(graph.status, 200);
    assert.ok(graph.body.edge_count >= 5);
  });

  test("references, orphans and dependency analysis run on the async layer", async () => {
    const refs = await request(port, "GET", "/api/references", { token });
    assert.equal(refs.status, 200);
    assert.ok(refs.body.total >= 4);

    const orphans = await request(port, "GET", "/api/references/orphans", { token });
    assert.equal(orphans.status, 200);
    assert.ok(Array.isArray(orphans.body.items));

    const prod = (await request(port, "GET", "/api/objects?code=PROD-1000", { token })).body.items[0];

    const deps = await request(port, "GET", `/api/dependencies/${prod.id}`, { token });
    assert.equal(deps.status, 200);
    assert.ok(deps.body.depended_on_by.length >= 2);

    const impact = await request(port, "GET", `/api/dependencies/impact?objectId=${prod.id}`, { token });
    assert.equal(impact.status, 200);
    assert.ok(impact.body.impacted.some((o) => o.code === "BOM-1000"));

    const missing = await request(port, "GET", "/api/dependencies/impact", { token });
    assert.equal(missing.status, 400);

    const cycles = await request(port, "GET", "/api/dependencies/cycles", { token });
    assert.equal(cycles.status, 200);
    assert.equal(cycles.body.count, 0);
  });

  test("bulk create and bulk mutate run on the async layer", async () => {
    const bulk = await request(port, "POST", "/api/objects/bulk", {
      token,
      body: { items: [newProduct("ASYNC-8000", "Bulk A"), newProduct("ASYNC-8001", "Bulk B")] },
    });
    assert.equal(bulk.status, 201);
    assert.equal(bulk.body.created_count, 2);

    const mutate = await request(port, "PATCH", "/api/objects/bulk", {
      token,
      body: { ids: bulk.body.created.map((o) => o.id), operation: "status", patch: { status: "active" } },
    });
    assert.equal(mutate.status, 200);
    assert.equal(mutate.body.updated_count, 2);
  });

  test("force delete and restore run on the async layer", async () => {
    const prod = (await request(port, "GET", "/api/objects?code=PROD-1000", { token })).body.items[0];

    const report = await request(port, "GET", `/api/objects/${prod.id}/safe-delete`, { token });
    assert.equal(report.status, 200);
    assert.ok(report.body.blockers.length > 0);

    const blocked = await request(port, "DELETE", `/api/objects/${prod.id}`, { token });
    assert.equal(blocked.status, 409);

    const forced = await request(port, "DELETE", `/api/objects/${prod.id}?force=true`, { token });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.deleted, true);

    const restore = await request(port, "POST", `/api/objects/${prod.id}/restore`, { token });
    assert.equal(restore.status, 200);
    assert.equal(restore.body.deleted, false);
  });
});

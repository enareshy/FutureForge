import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate } from "../db.js";
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

function request(port, method, path, { token, body, tenant } = {}) {
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
          ...(tenant ? { "X-Tenant-Id": String(tenant) } : {}),
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

describe("object framework REST APIs", () => {
  let port;
  let server;
  let token;
  let createdId;

  before(async () => {
    const database = openDatabase(":memory:");
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

  test("requires authentication", async () => {
    const res = await request(port, "GET", "/api/objects");
    assert.equal(res.status, 401);
  });

  test("lists object types, objects and a summary", async () => {
    const types = await request(port, "GET", "/api/object-types", { token });
    assert.equal(types.status, 200);
    assert.ok(types.body.items.some((t) => t.code === "product"));

    const list = await request(port, "GET", "/api/objects?pageSize=50", { token });
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 7);

    const summary = await request(port, "GET", "/api/objects/summary", { token });
    assert.equal(summary.status, 200);
    assert.ok(summary.body.total >= 7);
  });

  test("creates an object and rejects invalid payloads", async () => {
    const invalid = await request(port, "POST", "/api/objects", {
      token,
      body: { type: "product", code: "PROD-7000", name: "Nope", data: {} },
    });
    assert.equal(invalid.status, 422);

    const created = await request(port, "POST", "/api/objects", {
      token,
      body: newProduct("PROD-7000", "API Widget"),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "PROD-7000");
    assert.equal(created.body.revision, 1);
    createdId = created.body.id;

    const duplicate = await request(port, "POST", "/api/objects", {
      token,
      body: newProduct("PROD-1000", "Duplicate"),
    });
    assert.equal(duplicate.status, 409);

    const missingType = await request(port, "POST", "/api/objects", {
      token,
      body: { type: "no-such-type", code: "X-1", name: "X", data: {} },
    });
    assert.equal(missingType.status, 404);
  });

  test("runs the update, status, version and lock lifecycle", async () => {
    const status = await request(port, "POST", `/api/objects/${createdId}/status`, {
      token,
      body: { status: "active" },
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, "active");

    const stale = await request(port, "PUT", `/api/objects/${createdId}`, {
      token,
      body: { name: "Stale", revision: 1 },
    });
    assert.equal(stale.status, 409);

    const update = await request(port, "PUT", `/api/objects/${createdId}`, {
      token,
      body: { name: "API Widget v2", revision: status.body.revision },
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.name, "API Widget v2");

    const versions = await request(port, "GET", `/api/objects/${createdId}/versions`, { token });
    assert.equal(versions.status, 200);
    assert.equal(versions.body.total, 3);

    const version = await request(port, "GET", `/api/objects/${createdId}/versions/1`, { token });
    assert.equal(version.status, 200);
    assert.equal(version.body.change_type, "create");

    const checkout = await request(port, "POST", `/api/objects/${createdId}/checkout`, {
      token,
      body: { reason: "editing" },
    });
    assert.equal(checkout.status, 200);
    assert.equal(checkout.body.checkout.locked_by, 1);

    const locks = await request(port, "GET", `/api/objects/${createdId}/locks`, { token });
    assert.equal(locks.body.items.length, 1);

    const checkin = await request(port, "POST", `/api/objects/${createdId}/checkin`, { token, body: {} });
    assert.equal(checkin.status, 200);
    assert.equal(checkin.body.object.locked, false);
  });

  test("exposes relationships, traversal and graphs", async () => {
    const list = await request(port, "GET", "/api/objects?code=PROD-1000", { token });
    const prod = list.body.items[0];
    assert.ok(prod);

    const rels = await request(port, "GET", `/api/objects/${prod.id}/relationships`, { token });
    assert.equal(rels.status, 200);
    assert.ok(rels.body.outgoing.length >= 2);

    const tree = await request(port, "GET", `/api/objects/${prod.id}/tree?depth=2`, { token });
    assert.equal(tree.status, 200);
    assert.equal(tree.body.root.id, prod.id);

    const graph = await request(port, "GET", `/api/objects/${prod.id}/graph?depth=2`, { token });
    assert.equal(graph.status, 200);
    assert.ok(graph.body.edge_count >= 5);
  });

  test("validates and creates relationships, rejecting duplicates", async () => {
    const prodList = await request(port, "GET", "/api/objects?code=PROD-1000", { token });
    const p1 = prodList.body.items[0];
    const prod2List = await request(port, "GET", "/api/objects?code=PROD-2000", { token });
    const p2 = prod2List.body.items[0];

    const relTypes = await request(port, "GET", "/api/relationship-types?q=has-revision", { token });
    const hasRevision = relTypes.body.items[0];
    assert.ok(hasRevision);

    const validate = await request(port, "POST", "/api/relationships/validate", {
      token,
      body: { type: hasRevision.id, source: p1.id, target: p2.id },
    });
    assert.equal(validate.status, 200);
    // PROD-2000 is a product, but this type expects a product-revision target.
    assert.equal(validate.body.valid, false);

    const create = await request(port, "POST", "/api/relationships", {
      token,
      body: { type: hasRevision.id, source: p1.id, target: p1.id },
    });
    assert.equal(create.status, 400);
  });

  test("lists references, orphans and dependency analysis", async () => {
    const refs = await request(port, "GET", "/api/references", { token });
    assert.equal(refs.status, 200);
    assert.ok(refs.body.total >= 4);

    const orphans = await request(port, "GET", "/api/references/orphans", { token });
    assert.equal(orphans.status, 200);
    assert.ok(Array.isArray(orphans.body.items));

    const prodList = await request(port, "GET", "/api/objects?code=PROD-1000", { token });
    const prod = prodList.body.items[0];

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

  test("renders a safe-delete report and enforces force deletion then restore", async () => {
    const prodList = await request(port, "GET", "/api/objects?code=PROD-1000", { token });
    const prod = prodList.body.items[0];

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

  test("manages relationship types over HTTP", async () => {
    const created = await request(port, "POST", "/api/relationship-types", {
      token,
      body: {
        code: "product.supersedes",
        name: "Product supersedes",
        cardinality: "N:N",
        semantic: "association",
        status: "active",
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "product.supersedes");

    const fetched = await request(port, "GET", `/api/relationship-types/${created.body.id}`, { token });
    assert.equal(fetched.status, 200);

    const disabled = await request(port, "POST", `/api/relationship-types/${created.body.id}/status`, {
      token,
      body: { status: "inactive" },
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.status, "inactive");

    const invalid = await request(port, "POST", "/api/relationship-types", {
      token,
      body: { code: "bad.cardinality", name: "Bad", cardinality: "many", semantic: "association" },
    });
    assert.equal(invalid.status, 400);
  });

  test("isolates objects by tenant context", async () => {
    const tenantsRes = await request(port, "GET", "/api/tenants", { token });
    const helix = tenantsRes.body.items.find((t) => t.code === "helix");

    const createdTenant = await request(port, "POST", "/api/tenants", {
      token,
      body: { code: "acme", name: "Acme Corp" },
    });
    assert.equal(createdTenant.status, 201);

    const sameTenant = await request(port, "GET", "/api/objects?code=PROD-1000", { token, tenant: helix.id });
    assert.equal(sameTenant.status, 200);
    assert.equal(sameTenant.body.items.length, 1);

    const otherTenant = await request(port, "GET", "/api/objects?code=PROD-1000", {
      token,
      tenant: createdTenant.body.id,
    });
    assert.equal(otherTenant.status, 200);
    assert.equal(otherTenant.body.items.length, 0);
  });
});

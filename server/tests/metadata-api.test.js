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

describe("metadata REST APIs", () => {
  let port;
  let server;
  let token;
  let typeId;

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
    const res = await request(port, "GET", "/api/metadata/types");
    assert.equal(res.status, 401);
  });

  test("lists seeded types and resolves the part contract", async () => {
    const list = await request(port, "GET", "/api/metadata/types?pageSize=50", { token });
    assert.equal(list.status, 200);
    const part = list.body.items.find((t) => t.code === "part");
    assert.ok(part, "seeded part type is listed");
    typeId = part.id;

    const resolved = await request(port, "GET", `/api/metadata/types/${typeId}/resolve`, { token });
    assert.equal(resolved.status, 200);
    assert.ok(resolved.body.attributes.length >= 10);

    const contract = await request(port, "GET", `/api/metadata/types/${typeId}/contract`, { token });
    assert.equal(contract.status, 200);
    assert.ok(contract.body.items.some((a) => a.code === "part.number" && a.required));

    const tree = await request(port, "GET", "/api/metadata/types/tree", { token });
    assert.equal(tree.status, 200);
    assert.ok(Array.isArray(tree.body.items));
  });

  test("creates a type, attaches an attribute and rejects a bad one", async () => {
    const created = await request(port, "POST", "/api/metadata/types", {
      token,
      body: { code: "machine", name: "Machine", status: "active" },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const attribute = await request(port, "POST", "/api/metadata/attributes", {
      token,
      body: { code: "machine.serial", name: "Serial", data_type: "string", required: true },
    });
    assert.equal(attribute.status, 201);

    const attach = await request(port, "POST", `/api/metadata/types/${id}/attributes`, {
      token,
      body: { attribute_id: attribute.body.id },
    });
    assert.equal(attach.status, 201);

    const bad = await request(port, "POST", "/api/metadata/attributes", {
      token,
      body: { code: "machine.bad", name: "Bad", data_type: "currency" },
    });
    assert.equal(bad.status, 400);

    const statusChange = await request(port, "POST", `/api/metadata/types/${id}/status`, {
      token,
      body: { status: "inactive" },
    });
    assert.equal(statusChange.status, 200);
    assert.equal(statusChange.body.status, "inactive");
  });

  test("validates a record through the API", async () => {
    const good = await request(port, "POST", "/api/metadata/validate", {
      token,
      body: {
        typeId: "part",
        values: {
          "part.number": "PN-100",
          "part.name": "Bearing",
          "part.category": "mechanical",
          "part.status": "draft",
          "part.weight_kg": 2.5,
        },
      },
    });
    assert.equal(good.status, 200);
    assert.equal(good.body.valid, true);

    const bad = await request(port, "POST", "/api/metadata/validate", {
      token,
      body: { typeId: "part", values: { "part.number": "PN-101" } },
    });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.valid, false);
    assert.ok(bad.body.errors.length > 0);
  });

  test("renders the seeded create form", async () => {
    const list = await request(port, "GET", "/api/metadata/forms?mode=create", { token });
    assert.equal(list.status, 200);
    const form = list.body.items.find((f) => f.code === "part.create");
    assert.ok(form);

    const rendered = await request(port, "POST", `/api/metadata/forms/${form.id}/render`, {
      token,
      body: { values: {} },
    });
    assert.equal(rendered.status, 200);
    assert.equal(rendered.body.form.mode, "create");
    assert.ok(rendered.body.fields.some((f) => f.code === "part.number"));
  });

  test("validate without a type is a client error, not a crash", async () => {
    const res = await request(port, "POST", "/api/metadata/validate", { token, body: { values: {} } });
    assert.equal(res.status, 400);
  });

  test("tests a stored rule against submitted context", async () => {
    const list = await request(port, "GET", "/api/metadata/rules?q=weight", { token });
    assert.equal(list.status, 200);
    const rule = list.body.items.find((r) => r.code === "weight.positive");
    assert.ok(rule);

    const matched = await request(port, "POST", `/api/metadata/rules/${rule.id}/test`, {
      token,
      body: { context: { values: { "part.weight_kg": -1 } } },
    });
    assert.equal(matched.status, 200);
    assert.equal(matched.body.matched, true);

    const unmatched = await request(port, "POST", `/api/metadata/rules/${rule.id}/test`, {
      token,
      body: { context: { values: { "part.weight_kg": 2 } } },
    });
    assert.equal(unmatched.body.matched, false);
  });

  test("scoped configuration can disable a type for a tenant", async () => {
    const tenantsRes = await request(port, "GET", "/api/tenants", { token });
    assert.equal(tenantsRes.status, 200);
    const helix = tenantsRes.body.items.find((t) => t.code === "helix");
    assert.ok(helix);

    const off = await request(port, "POST", "/api/metadata/configurations", {
      token,
      body: { scope: "tenant", scopeId: helix.id, artifactType: "type", artifactId: typeId, enabled: false },
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);

    const effective = await request(port, "GET", `/api/metadata/configurations/effective?artifactType=type`, {
      token,
    });
    assert.equal(effective.status, 200);
    const entry = effective.body.items.find((i) => i.artifact_id === typeId && i.artifact_type === "type");
    assert.equal(entry.config.enabled, false);
    assert.equal(entry.config.source, "tenant");
  });
});

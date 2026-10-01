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
      const { port } = server.address();
      resolve({ server, port });
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

describe("async layered configuration", () => {
  let database;
  let port;
  let server;
  let token;
  let orgId;

  before(async () => {
    database = openTestDatabase();
    migrate(database);
    seedDatabase(database);
    const app = createApp(database);
    const started = await listen(app);
    server = started.server;
    port = started.port;
    const login = await request(port, "POST", "/api/auth/login", {
      body: { username: "admin", password: "HelixAdmin!42" },
    });
    assert.equal(login.status, 200);
    token = login.body.token;
    const orgs = await request(port, "GET", "/api/organizations", { token });
    assert.equal(orgs.status, 200);
    orgId = orgs.body.items[0].id;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("organization config resolves through the layered resolver", async () => {
    const read = await request(port, "GET", `/api/organizations/${orgId}/config`, { token });
    assert.equal(read.status, 200);
    assert.equal(read.body.scope, "organization");
    assert.ok(read.body.items.length >= 0);
    const before = read.body.effective.find((e) => e.key === "org.allow_multi_site");
    assert.ok(before);

    const save = await request(port, "PUT", `/api/organizations/${orgId}/config`, {
      token,
      body: { values: { "org.allow_multi_site": false } },
    });
    assert.equal(save.status, 200);
    assert.equal(save.body.scope, "organization");

    const after = await request(port, "GET", `/api/organizations/${orgId}/config`, { token });
    const resolved = after.body.effective.find((e) => e.key === "org.allow_multi_site");
    assert.equal(resolved.value, false);
    assert.equal(resolved.source, "organization");

    const audit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'config.update' AND resource_id = ?",
      [`organization:${orgId}`]
    );
    assert.ok(audit, "organization config update is audited");

    const catalog = await request(port, "GET", `/api/config?organizationId=${orgId}`, { token });
    assert.equal(catalog.status, 200);
    const effective = catalog.body.effective.find((e) => e.key === "org.allow_multi_site");
    assert.equal(effective.source, "organization");
  });
});

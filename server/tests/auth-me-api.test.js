import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";

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
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// The current-user endpoint is served by the asynchronous request pipeline
// (requireAuthAsync + the async service twins), so this locks in parity of its
// response shape.
describe("current-user API (async pipeline)", () => {
  let port;
  let server;
  let adminToken;
  let userToken;

  before(async () => {
    const db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;

    const adminLogin = await request(port, "POST", "/api/auth/login", {
      body: { username: "admin", password: "HelixAdmin!42" },
    });
    assert.equal(adminLogin.status, 200);
    adminToken = adminLogin.body.token;

    const userLogin = await request(port, "POST", "/api/auth/login", {
      body: { username: "j.patel", password: "HelixUser!42" },
    });
    assert.equal(userLogin.status, 200);
    userToken = userLogin.body.token;
  });

  after(() => server?.close());

  test("requires authentication", async () => {
    const res = await request(port, "GET", "/api/auth/me");
    assert.equal(res.status, 401);
  });

  test("returns the actor, access, session and deployment context", async () => {
    const res = await request(port, "GET", "/api/auth/me", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, "admin");
    assert.ok(Array.isArray(res.body.access.roles));
    assert.ok(res.body.access.roles.length >= 1);
    assert.ok(res.body.session.public_id);
    assert.equal(res.body.session.token, undefined);
    assert.equal(typeof res.body.mfa.enrolled, "boolean");
    assert.ok(res.body.deployment.edition);
    assert.ok(Array.isArray(res.body.tenants));
  });

  test("scopes access per principal", async () => {
    const res = await request(port, "GET", "/api/auth/me", { token: userToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, "j.patel");
    assert.ok(res.body.access.roles.length >= 1);
  });
});

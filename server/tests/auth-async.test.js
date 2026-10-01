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

describe("async authentication routes", () => {
  let database;
  let port;
  let server;

  before(async () => {
    database = openTestDatabase();
    migrate(database);
    seedDatabase(database);
    const app = createApp(database);
    const started = await listen(app);
    server = started.server;
    port = started.port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("login, session listing and logout run through the async layer", async () => {
    const login = await request(port, "POST", "/api/auth/login", {
      body: { username: "admin", password: "HelixAdmin!42" },
    });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
    assert.equal(login.body.user.username, "admin");
    const token = login.body.token;

    const sessionAudit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'auth.session.create' AND resource_id = ?",
      [login.body.session.public_id]
    );
    assert.ok(sessionAudit, "session creation is audited through the async writer");

    const me = await request(port, "GET", "/api/auth/me", { token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, "admin");

    const sessions = await request(port, "GET", "/api/sessions", { token });
    assert.equal(sessions.status, 200);
    assert.ok(sessions.body.items.some((s) => s.public_id === login.body.session.public_id));

    const logout = await request(port, "POST", "/api/auth/logout", { token });
    assert.equal(logout.status, 200);
    assert.equal(logout.body.ok, true);
    const logoutAudit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'auth.logout' AND resource_id = ?",
      [login.body.session.public_id]
    );
    assert.ok(logoutAudit, "logout is audited");

    const after = await request(port, "GET", "/api/auth/me", { token });
    assert.equal(after.status, 401, "revoked token is rejected");
  });

  test("provider admin listing and settings use the async provider layer", async () => {
    const login = await request(port, "POST", "/api/authentication/login", {
      body: { username: "admin", password: "HelixAdmin!42" },
    });
    assert.equal(login.status, 200);
    const token = login.body.token;

    const providers = await request(port, "GET", "/api/authentication/providers/admin", { token });
    assert.equal(providers.status, 200);
    assert.ok(providers.body.items.some((p) => p.code === "password"));

    const updated = await request(port, "PUT", "/api/authentication/settings", {
      token,
      body: { sessionHours: 8 },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.sessionHours, 8);

    const read = await request(port, "GET", "/api/authentication/settings", { token });
    assert.equal(read.status, 200);
    assert.equal(read.body.sessionHours, 8);
  });

  test("password reset request and complete run through the async layer", async () => {
    const asked = await request(port, "POST", "/api/authentication/password-reset/request", {
      body: { username: "j.patel" },
    });
    assert.equal(asked.status, 200);
    assert.equal(asked.body.ok, true);

    const row = queryOne(
      database,
      "SELECT * FROM password_reset_tokens WHERE user_id = (SELECT id FROM users WHERE username = 'j.patel') ORDER BY id DESC"
    );
    assert.ok(row, "a reset token row is stored");
    assert.ok(!row.consumed_at);

    const audit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'auth.password_reset.request' AND resource_id = ?",
      [String(row.user_id)]
    );
    assert.ok(audit, "reset request is audited");
  });
});

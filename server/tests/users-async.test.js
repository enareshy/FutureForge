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

describe("async user writes", () => {
  let database;
  let port;
  let server;
  let token;

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
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("create emits UserCreated through the outbox and audits", async () => {
    const created = await request(port, "POST", "/api/users", {
      token,
      body: {
        username: "async.user",
        email: "async.user@helix.example",
        employee_id: "EMP-9001",
        display_name: "Async User",
        password: "HelixUser!77",
      },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const event = queryOne(
      database,
      "SELECT * FROM event_records WHERE event_type_code = 'UserCreated' AND source_object_id = ?",
      [String(id)]
    );
    assert.ok(event, "UserCreated event is stored");
    const outbox = queryOne(database, "SELECT * FROM event_outbox WHERE event_ref = ?", [event.event_ref]);
    assert.ok(outbox, "outbox row is enqueued for the event");
    const audit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'user.create' AND resource_id = ?",
      [String(id)]
    );
    assert.ok(audit, "user.create is audited");
  });

  test("update emits UserUpdated and reset-password rehashes", async () => {
    const created = await request(port, "POST", "/api/users", {
      token,
      body: {
        username: "async.edit",
        email: "async.edit@helix.example",
        employee_id: "EMP-9002",
        display_name: "Async Edit",
        password: "HelixUser!78",
      },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const updated = await request(port, "PUT", `/api/users/${id}`, {
      token,
      body: { display_name: "Async Edited" },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.display_name, "Async Edited");

    const event = queryOne(
      database,
      "SELECT * FROM event_records WHERE event_type_code = 'UserUpdated' AND source_object_id = ?",
      [String(id)]
    );
    assert.ok(event, "UserUpdated event is stored");

    const reset = await request(port, "POST", `/api/users/${id}/reset-password`, {
      token,
      body: { password: "HelixUser!79" },
    });
    assert.equal(reset.status, 200);
    const audit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'user.reset_password' AND resource_id = ?",
      [String(id)]
    );
    assert.ok(audit, "user.reset_password is audited");
  });
});

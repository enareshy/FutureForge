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

describe("notification REST APIs", () => {
  let port;
  let server;
  let db;
  let adminToken;
  let userToken;
  let tenantId;
  let adminUserId;
  let userId;

  before(async () => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    adminUserId = queryOne(db, "SELECT id FROM users WHERE username = 'admin'").id;
    userId = queryOne(db, "SELECT id FROM users WHERE username = 'j.patel'").id;
    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;

    const adminLogin = await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } });
    assert.equal(adminLogin.status, 200);
    adminToken = adminLogin.body.token;

    const userLogin = await request(port, "POST", "/api/auth/login", { body: { username: "j.patel", password: "HelixUser!42" } });
    assert.equal(userLogin.status, 200);
    userToken = userLogin.body.token;
  });

  after(() => server?.close());

  describe("inbox", () => {
    let notificationId;

    test("lists the current user's notifications", async () => {
      const res = await request(port, "GET", "/api/notifications", { token: userToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.total >= 1);
      notificationId = res.body.items[0].id;
    });

    test("returns an unread count", async () => {
      const res = await request(port, "GET", "/api/notifications/unread-count", { token: userToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.unread >= 1);
    });

    test("exposes vocabulary metadata", async () => {
      const res = await request(port, "GET", "/api/notifications/meta", { token: userToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.channels.includes("in_app"));
      assert.ok(res.body.recipient_types.includes("role"));
    });

    test("marks a notification read and unread", async () => {
      const read = await request(port, "PUT", `/api/notifications/${notificationId}/read`, { token: userToken });
      assert.equal(read.status, 200);
      assert.equal(read.body.read, true);
      const unread = await request(port, "PUT", `/api/notifications/${notificationId}/unread`, { token: userToken });
      assert.equal(unread.status, 200);
      assert.equal(unread.body.read, false);
    });

    test("does not expose another user's notification", async () => {
      const adminInbox = await request(port, "GET", "/api/notifications", { token: adminToken });
      const adminNotificationId = adminInbox.body.items[0].id;
      const res = await request(port, "GET", `/api/notifications/${adminNotificationId}`, { token: userToken });
      assert.equal(res.status, 404);
    });

    test("marks all as read", async () => {
      const res = await request(port, "POST", "/api/notifications/mark-all-read", { token: userToken });
      assert.equal(res.status, 200);
      const count = await request(port, "GET", "/api/notifications/unread-count", { token: userToken });
      assert.equal(count.body.unread, 0);
    });

    test("archives and deletes own notification", async () => {
      const archived = await request(port, "PUT", `/api/notifications/${notificationId}/archive`, { token: userToken });
      assert.equal(archived.status, 200);
      const removed = await request(port, "DELETE", `/api/notifications/${notificationId}`, { token: userToken });
      assert.equal(removed.status, 200);
    });
  });

  describe("preferences", () => {
    test("reads and updates preferences", async () => {
      const before = await request(port, "GET", "/api/notification-preferences", { token: userToken });
      assert.equal(before.status, 200);
      assert.equal(before.body.email, true);
      const updated = await request(port, "PUT", "/api/notification-preferences", {
        token: userToken,
        body: { email: false, frequency: "daily" },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.email, false);
      assert.equal(updated.body.frequency, "daily");
      await request(port, "PUT", "/api/notification-preferences", { token: userToken, body: { email: true, frequency: "immediate" } });
    });

    test("lists mandatory event types", async () => {
      const res = await request(port, "GET", "/api/notification-preferences/mandatory", { token: userToken });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.items));
    });
  });

  describe("templates", () => {
    let templateId;

    test("rejects template management for non-admins", async () => {
      const res = await request(port, "POST", "/api/notification-templates", {
        token: userToken,
        body: { code: "nope", name: "Nope", channel: "in_app", subject: "s", html_body: "<p>x</p>" },
      });
      assert.equal(res.status, 403);
    });

    test("creates, lists and previews a template", async () => {
      const created = await request(port, "POST", "/api/notification-templates", {
        token: adminToken,
        body: {
          code: "api.test.template",
          name: "API test template",
          event_type: "api.test",
          channel: "in_app",
          subject: "Hi {{recipient.username}}",
          html_body: "<p>{{object.name}}</p>",
        },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.code, "api.test.template");
      templateId = created.body.id;

      const list = await request(port, "GET", "/api/notification-templates?q=api.test.template", { token: adminToken });
      assert.equal(list.status, 200);
      assert.ok(list.body.items.some((item) => item.id === templateId));

      const preview = await request(port, "POST", `/api/notification-templates/${templateId}/preview`, {
        token: adminToken,
        body: { context: { object: { name: "Preview object" } } },
      });
      assert.equal(preview.status, 200);
      assert.match(preview.body.rendered.html, /Preview object/);

      const versions = await request(port, "GET", `/api/notification-templates/${templateId}/versions`, { token: adminToken });
      assert.equal(versions.status, 200);
      assert.ok(versions.body.items.length >= 1);
    });

    test("rejects unsafe template content", async () => {
      const res = await request(port, "POST", "/api/notification-templates", {
        token: adminToken,
        body: { code: "api.unsafe", name: "Unsafe", channel: "in_app", subject: "x", html_body: "<script>alert(1)</script>" },
      });
      assert.equal(res.status, 400);
    });

    test("sends a test notification to a user", async () => {
      const res = await request(port, "POST", `/api/notification-templates/${templateId}/test-send`, {
        token: adminToken,
        body: { recipient_id: userId },
      });
      assert.equal(res.status, 201);
      assert.ok(res.body.notification_id);
      assert.equal(res.body.recipient.id, userId);
    });
  });

  describe("rules", () => {
    let ruleId;

    test("creates and simulates a rule", async () => {
      const created = await request(port, "POST", "/api/notification-rules", {
        token: adminToken,
        body: {
          code: "api-test-rule",
          name: "API test rule",
          event_type: "api.test",
          template_code: "api.test.template",
          channels: ["in_app"],
          recipient: { items: [{ type: "user", id: userId }] },
        },
      });
      assert.equal(created.status, 201);
      ruleId = created.body.id;
      assert.equal(created.body.event_type, "api.test");

      const simulated = await request(port, "POST", `/api/notification-rules/${ruleId}/simulate`, {
        token: adminToken,
        body: { event_type: "api.test", object_type: "widget", object_id: "W-9", object_name: "Simulated widget" },
      });
      assert.equal(simulated.status, 200);
      assert.equal(simulated.body.created, 1);
    });

    test("requires rule permission for end users", async () => {
      const res = await request(port, "GET", "/api/notification-rules", { token: userToken });
      assert.equal(res.status, 403);
    });
  });

  describe("providers", () => {
    let providerId;

    test("creates a provider and masks secrets", async () => {
      const created = await request(port, "POST", "/api/notification-providers", {
        token: adminToken,
        body: {
          code: "api-smtp",
          name: "API SMTP",
          channel: "email",
          type: "smtp",
          config: { host: "smtp.example.com", from_email: "no-reply@example.com", password: "top-secret" },
        },
      });
      assert.equal(created.status, 201);
      providerId = created.body.id;
      assert.equal(created.body.secrets_configured.password, true);
      assert.equal(created.body.config.password, undefined);
      const row = queryOne(db, "SELECT * FROM notification_providers WHERE id = ?", [providerId]);
      assert.ok(!row.secrets_enc.includes("top-secret"));
    });

    test("tests provider configuration", async () => {
      const res = await request(port, "POST", `/api/notification-providers/${providerId}/test`, { token: adminToken, body: {} });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });

    test("forbids provider access for end users", async () => {
      const res = await request(port, "GET", "/api/notification-providers", { token: userToken });
      assert.equal(res.status, 403);
    });
  });

  describe("publish, history and delivery", () => {
    test("publishes an event and processes the queue", async () => {
      const published = await request(port, "POST", "/api/notification-events/publish", {
        token: adminToken,
        body: {
          event_type: "task.assigned",
          source_module: "workflow",
          object_type: "task",
          object_id: "TASK-API-1",
          object_name: "API published task",
          payload: { assignee_id: userId, link: "/workflow/tasks/api-1" },
        },
      });
      assert.equal(published.status, 201);
      assert.equal(published.body.published, true);
      assert.ok(published.body.notifications.length >= 1);

      const processed = await request(port, "POST", "/api/notification-deliveries/process", { token: adminToken, body: {} });
      assert.equal(processed.status, 200);
      assert.ok(typeof processed.body.processed === "number");
    });

    test("returns history and delivery stats", async () => {
      const history = await request(port, "GET", "/api/notification-history?q=API", { token: adminToken });
      assert.equal(history.status, 200);
      assert.ok(history.body.total >= 1);
      const stats = await request(port, "GET", "/api/notification-deliveries/stats", { token: adminToken });
      assert.equal(stats.status, 200);
      assert.ok(stats.body.total >= 1);
    });

    test("sweeps reminders", async () => {
      const res = await request(port, "POST", "/api/notification-reminders/sweep", { token: adminToken, body: {} });
      assert.equal(res.status, 200);
      assert.ok(typeof res.body.processed === "number");
    });

    test("forbids history access for end users", async () => {
      const res = await request(port, "GET", "/api/notification-history", { token: userToken });
      assert.equal(res.status, 403);
    });
  });
});

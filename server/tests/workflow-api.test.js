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

describe("workflow REST APIs", () => {
  let port;
  let server;
  let token;
  let userToken;
  let adminId;
  let database;

  before(async () => {
    database = openDatabase(":memory:");
    migrate(database);
    seedDatabase(database);
    const started = await listen(createApp(database));
    server = started.server;
    port = started.port;
    adminId = queryOne(database, "SELECT id FROM users WHERE username = 'admin'").id;
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

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("requires authentication", async () => {
    const res = await request(port, "GET", "/api/workflow-templates");
    assert.equal(res.status, 401);
  });

  test("exposes the seeded template catalog and validates it", async () => {
    const templates = await request(port, "GET", "/api/workflow-templates", { token });
    assert.equal(templates.status, 200);
    const demo = templates.body.items.find((d) => d.code === "change-request-review");
    assert.ok(demo);

    const detail = await request(port, "GET", `/api/workflow-templates/${demo.id}`, { token });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.status, "published");

    const versions = await request(port, "GET", `/api/workflow-templates/${demo.id}/versions`, { token });
    assert.equal(versions.status, 200);
    assert.equal(versions.body[0].status, "published");

    const validate = await request(port, "POST", `/api/workflow-templates/${demo.id}/validate`, { token, body: {} });
    assert.equal(validate.status, 200);
    assert.equal(validate.body.valid, true);
  });

  test("creates a template, edits the designer graph and publishes it", async () => {
    const created = await request(port, "POST", "/api/workflow-templates", {
      token,
      body: {
        code: "api-flow",
        name: "API Flow",
        graph: {
          nodes: [
            { node_key: "start", type: "start", name: "Start" },
            { node_key: "review", type: "task", name: "Review", config: { assignee_type: "role", assignee_ref: "iam.admin" } },
            { node_key: "end", type: "end", name: "End" },
          ],
          transitions: [
            { transition_key: "e1", from_node_key: "start", to_node_key: "review" },
            { transition_key: "e2", from_node_key: "review", to_node_key: "end" },
          ],
        },
      },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const designer = await request(port, "GET", `/api/workflow-templates/${id}/designer`, { token });
    assert.equal(designer.status, 200);
    assert.equal(designer.body.graph.nodes.length, 3);

    const reviewNode = designer.body.graph.nodes.find((n) => n.node_key === "review");
    const patched = await request(port, "PATCH", `/api/workflow-templates/${id}/designer/nodes/${reviewNode.id}`, {
      token,
      body: { name: "Peer Review" },
    });
    assert.equal(patched.status, 200);

    const layout = await request(port, "POST", `/api/workflow-templates/${id}/designer/auto-layout`, { token, body: {} });
    assert.equal(layout.status, 200);

    const validate = await request(port, "POST", `/api/workflow-templates/${id}/designer/validate`, { token, body: {} });
    assert.equal(validate.status, 200);

    const publish = await request(port, "POST", `/api/workflow-templates/${id}/publish`, { token, body: {} });
    assert.equal(publish.status, 200);
    assert.equal(publish.body.version.status, "published");

    const start = await request(port, "POST", "/api/workflow-instances", {
      token,
      body: { workflow_code: "api-flow", title: "API flow run" },
    });
    assert.equal(start.status, 201);
    const started = await request(port, "GET", `/api/workflow-instances/${start.body.id}`, { token });
    assert.equal(started.body.status, "running");
  });

  test("drives an instance through task, approval and completion", async () => {
    const start = await request(port, "POST", "/api/workflow-instances", {
      token,
      body: { workflow_code: "change-request-review", title: "API change", context: { priority: "low" } },
    });
    assert.equal(start.status, 201);
    const instanceId = start.body.id;

    const detail = await request(port, "GET", `/api/workflow-instances/${instanceId}`, { token });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.status, "running");

    const nodes = await request(port, "GET", `/api/workflow-instances/${instanceId}/nodes`, { token });
    assert.equal(nodes.status, 200);

    const tasks = await request(port, "GET", `/api/tasks?scope=all`, { token });
    const task = tasks.body.items.find((t) => t.instance_id === instanceId);
    assert.ok(task);

    const complete = await request(port, "POST", `/api/tasks/${task.id}/complete`, {
      token,
      body: { outcome: "assessed" },
    });
    assert.equal(complete.status, 200);

    const approvals = await request(port, "GET", "/api/workflow-approvals", { token });
    const approval = approvals.body.items.find((a) => a.instance_id === instanceId);
    assert.ok(approval);
    assert.equal(approval.status, "pending");

    const missingComment = await request(port, "POST", `/api/workflow-approvals/${approval.id}/reject`, { token, body: {} });
    assert.equal(missingComment.status, 400);

    const approve = await request(port, "POST", `/api/workflow-approvals/${approval.id}/approve`, {
      token,
      body: { comment: "ok" },
    });
    assert.equal(approve.status, 200);

    const history = await request(port, "GET", `/api/workflow-instances/${instanceId}/history`, { token });
    assert.equal(history.status, 200);
    const finished = await request(port, "GET", `/api/workflow-instances/${instanceId}`, { token });
    assert.equal(finished.body.status, "completed");
  });

  test("supports task collaboration endpoints", async () => {
    const tasks = await request(port, "GET", "/api/tasks?scope=all", { token });
    const task = tasks.body.items[0];
    assert.ok(task);

    const comment = await request(port, "POST", `/api/tasks/${task.id}/comments`, { token, body: { body: "ping" } });
    assert.equal(comment.status, 201);

    const attachment = await request(port, "POST", `/api/tasks/${task.id}/attachments`, {
      token,
      body: { filename: "a.txt", url: "https://example.test/a.txt" },
    });
    assert.equal(attachment.status, 201);

    const subtask = await request(port, "POST", `/api/tasks/${task.id}/subtasks`, {
      token,
      body: { title: "child" },
    });
    assert.equal(subtask.status, 201);

    const updated = await request(port, "PATCH", `/api/tasks/${task.id}/subtasks/${subtask.body.id}`, {
      token,
      body: { status: "done" },
    });
    assert.equal(updated.status, 200);

    const detail = await request(port, "GET", `/api/tasks/${task.id}`, { token });
    assert.equal(detail.body.comments.length >= 1, true);
    assert.equal(detail.body.attachments.length >= 1, true);
    assert.equal(detail.body.subtasks.some((s) => s.status === "done"), true);
  });

  test("lets end users work their inbox without authoring access", async () => {
    const templates = await request(port, "GET", "/api/workflow-templates", { token: userToken });
    assert.equal(templates.status, 200);
    assert.ok(templates.body.items.some((d) => d.code === "change-request-review"));

    const tasks = await request(port, "GET", "/api/tasks?scope=mine", { token: userToken });
    assert.equal(tasks.status, 200);
    assert.equal(tasks.body.scope, "mine");

    const approvals = await request(port, "GET", "/api/workflow-approvals", { token: userToken });
    assert.equal(approvals.status, 200);

    const instances = await request(port, "GET", "/api/workflow-instances", { token: userToken });
    assert.equal(instances.status, 200);

    const start = await request(port, "POST", "/api/workflow-instances", {
      token: userToken,
      body: { workflow_code: "change-request-review", title: "end user run" },
    });
    assert.equal(start.status, 201);

    const delegation = await request(port, "POST", "/api/workflow-delegations", {
      token: userToken,
      body: { to_user_id: adminId, reason: "out of office" },
    });
    assert.equal(delegation.status, 403);

    const createTemplate = await request(port, "POST", "/api/workflow-templates", {
      token: userToken,
      body: { code: "end-user-flow", name: "Nope" },
    });
    assert.equal(createTemplate.status, 403);

    const routing = await request(port, "GET", "/api/workflow-routing-rules", { token: userToken });
    assert.equal(routing.status, 403);

    const demoId = templates.body.items.find((d) => d.code === "change-request-review").id;
    const designer = await request(port, "GET", `/api/workflow-templates/${demoId}/designer`, { token: userToken });
    assert.equal(designer.status, 403);

    const escalations = await request(port, "POST", "/api/workflow-escalations/sweep", { token: userToken, body: {} });
    assert.equal(escalations.status, 403);
  });

  test("manages routing and escalation configuration and sweeps overdue tasks", async () => {
    const routing = await request(port, "POST", "/api/workflow-routing-rules", {
      token,
      body: { code: "api-route", name: "API Route", assignee_type: "role", assignee_ref: "iam.admin", priority: 5 },
    });
    assert.equal(routing.status, 201);

    const rules = await request(port, "GET", "/api/workflow-routing-rules", { token });
    assert.ok(rules.body.items.some((r) => r.code === "api-route"));

    const escalation = await request(port, "POST", "/api/workflow-escalation-rules", {
      token,
      body: { code: "api-escalate", name: "API Escalate", after_minutes: 60, action: "reassign" },
    });
    assert.equal(escalation.status, 201);

    const sweep = await request(port, "POST", "/api/workflow-escalations/sweep", { token, body: {} });
    assert.equal(sweep.status, 200);
    assert.ok(typeof sweep.body.swept === "number");
  });

  test("exposes notifications, templates, bindings and delegations", async () => {
    const notifications = await request(port, "GET", "/api/workflow-notifications", { token });
    assert.equal(notifications.status, 200);
    if (notifications.body.items.length) {
      const read = await request(port, "POST", `/api/workflow-notifications/${notifications.body.items[0].id}/read`, { token, body: {} });
      assert.equal(read.status, 200);
    }

    const templates = await request(port, "GET", "/api/workflow-notification-templates", { token });
    assert.equal(templates.status, 200);
    assert.ok(templates.body.items.some((t) => t.code === "task-assigned"));

    const createdTemplate = await request(port, "POST", "/api/workflow-notification-templates", {
      token,
      body: { code: "api-note", name: "API Note", subject: "Hi", body: "Hello" },
    });
    assert.equal(createdTemplate.status, 201);

    const bindings = await request(port, "GET", "/api/workflow-bindings", { token });
    assert.equal(bindings.status, 200);
    assert.ok(bindings.body.items.some((b) => b.code === "release-to-change-review"));

    const definition = queryOne(database, "SELECT id FROM workflow_definitions WHERE code = 'change-request-review'");
    const createdBinding = await request(port, "POST", "/api/workflow-bindings", {
      token,
      body: { code: "api-binding", name: "API Binding", event: "lifecycle.release.approved", definition_id: definition.id },
    });
    assert.equal(createdBinding.status, 201);

    const delegation = await request(port, "POST", "/api/workflow-delegations", {
      token,
      body: { to_user_id: adminId, reason: "backup" },
    });
    assert.equal(delegation.status, 201);

    const revoke = await request(port, "DELETE", `/api/workflow-delegations/${delegation.body.id}`, { token, body: {} });
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body.status, "revoked");
  });
});

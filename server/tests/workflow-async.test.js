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

describe("async workflow read surface", () => {
  let database;
  let server;
  let port;
  let token;
  let userToken;

  before(async () => {
    database = openTestDatabase();
    migrate(database);
    seedDatabase(database);
    const started = await listen(createApp(database));
    server = started.server;
    port = started.port;
    token = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
    userToken = (await request(port, "POST", "/api/auth/login", { body: { username: "j.patel", password: "HelixUser!42" } })).body.token;
  });

  after(() => {
    server?.close();
    database?.close();
  });

  test("template and designer reads run on the async layer", async () => {
    const templates = await request(port, "GET", "/api/workflow-templates", { token });
    assert.equal(templates.status, 200);
    const demo = templates.body.items.find((d) => d.code === "change-request-review");
    assert.ok(demo, "seeded template is listed");

    const detail = await request(port, "GET", `/api/workflow-templates/${demo.id}`, { token });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.code, "change-request-review");
    assert.ok(Array.isArray(detail.body.versions));

    const versions = await request(port, "GET", `/api/workflow-templates/${demo.id}/versions`, { token });
    assert.equal(versions.status, 200);
    assert.ok(versions.body.length >= 1);

    const version = await request(port, "GET", `/api/workflow-templates/${demo.id}/versions/${versions.body[0].version}`, { token });
    assert.equal(version.status, 200);
    assert.ok(version.body.graph.nodes.length >= 2);

    const validate = await request(port, "POST", `/api/workflow-templates/${demo.id}/validate`, { token, body: {} });
    assert.equal(validate.status, 200);
    assert.equal(validate.body.valid, true);

    const designer = await request(port, "GET", `/api/workflow-templates/${demo.id}/designer`, { token });
    assert.equal(designer.status, 200);
    assert.equal(designer.body.editable, false);
    assert.ok(designer.body.graph.nodes.length >= 2);

    const designerValidate = await request(port, "POST", `/api/workflow-templates/${demo.id}/designer/validate`, { token, body: {} });
    assert.equal(designerValidate.status, 200);
  });

  test("instance, task and approval reads run on the async layer", async () => {
    const start = await request(port, "POST", "/api/workflow-instances", {
      token,
      body: { workflow_code: "change-request-review", title: "Async read run", context: { priority: "low" } },
    });
    assert.equal(start.status, 201);
    const instanceId = start.body.id;

    const list = await request(port, "GET", "/api/workflow-instances", { token });
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((i) => i.id === instanceId));

    const detail = await request(port, "GET", `/api/workflow-instances/${instanceId}`, { token });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.title, "Async read run");
    assert.ok(detail.body.definition, "instance detail includes its definition");
    assert.ok(Array.isArray(detail.body.nodes));

    const nodes = await request(port, "GET", `/api/workflow-instances/${instanceId}/nodes`, { token });
    assert.equal(nodes.status, 200);
    assert.ok(nodes.body.items.length >= 1);

    const history = await request(port, "GET", `/api/workflow-instances/${instanceId}/history`, { token });
    assert.equal(history.status, 200);
    assert.equal(history.body.instance.id, instanceId);
    assert.ok(Array.isArray(history.body.items));

    const tasks = await request(port, "GET", "/api/tasks?scope=all", { token });
    assert.equal(tasks.status, 200);
    const task = tasks.body.items.find((t) => t.instance_id === instanceId);
    assert.ok(task, "the instance created a task");

    const taskDetail = await request(port, "GET", `/api/tasks/${task.id}`, { token });
    assert.equal(taskDetail.status, 200);
    assert.equal(taskDetail.body.id, task.id);
    assert.ok(taskDetail.body.workflow, "task detail includes the workflow graph");

    await request(port, "POST", `/api/tasks/${task.id}/comments`, { token, body: { body: "async comment" } });
    const comments = await request(port, "GET", `/api/tasks/${task.id}/comments`, { token });
    assert.equal(comments.status, 200);
    assert.ok(comments.body.items.some((c) => c.body === "async comment"));

    await request(port, "POST", `/api/tasks/${task.id}/attachments`, {
      token,
      body: { filename: "async.txt", url: "https://example.test/async.txt" },
    });
    const attachments = await request(port, "GET", `/api/tasks/${task.id}/attachments`, { token });
    assert.equal(attachments.status, 200);
    assert.ok(attachments.body.items.some((a) => a.filename === "async.txt"));

    const complete = await request(port, "POST", `/api/tasks/${task.id}/complete`, { token, body: { outcome: "assessed" } });
    assert.equal(complete.status, 200);

    const approvals = await request(port, "GET", "/api/workflow-approvals", { token });
    assert.equal(approvals.status, 200);
    const approval = approvals.body.items.find((a) => a.instance_id === instanceId);
    assert.ok(approval, "advancing the instance created an approval");

    const approvalDetail = await request(port, "GET", `/api/workflow-approvals/${approval.id}`, { token });
    assert.equal(approvalDetail.status, 200);
    assert.equal(approvalDetail.body.id, approval.id);
    assert.ok(approvalDetail.body.instance, "approval detail includes its instance");
  });

  test("delegations read and end-user access checks run on the async layer", async () => {
    const delegations = await request(port, "GET", "/api/workflow-delegations", { token });
    assert.equal(delegations.status, 200);
    assert.ok(Array.isArray(delegations.body.items));

    const userTasks = await request(port, "GET", "/api/tasks?scope=mine", { token: userToken });
    assert.equal(userTasks.status, 200);
    assert.equal(userTasks.body.scope, "mine");

    const userInstances = await request(port, "GET", "/api/workflow-instances", { token: userToken });
    assert.equal(userInstances.status, 200);

    const templates = await request(port, "GET", "/api/workflow-templates", { token: userToken });
    assert.equal(templates.status, 200);
    const demo = templates.body.items.find((d) => d.code === "change-request-review");
    const designer = await request(port, "GET", `/api/workflow-templates/${demo.id}/designer`, { token: userToken });
    assert.equal(designer.status, 403);
  });

  test("template, designer and configuration writes run on the async layer", async () => {
    const created = await request(port, "POST", "/api/workflow-templates", {
      token,
      body: { code: "async-authoring", name: "Async Authoring", description: "created on the async layer" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "async-authoring");
    const id = created.body.id;

    const updated = await request(port, "PATCH", `/api/workflow-templates/${id}`, {
      token,
      body: { name: "Async Authoring v2" },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, "Async Authoring v2");

    const designer = await request(port, "GET", `/api/workflow-templates/${id}/designer`, { token });
    assert.equal(designer.status, 200);
    assert.equal(designer.body.editable, true);
    const startNode = designer.body.graph.nodes.find((n) => n.type === "start");
    assert.ok(startNode);

    const node = await request(port, "POST", `/api/workflow-templates/${id}/designer/nodes`, {
      token,
      body: { type: "task", name: "Async Node" },
    });
    assert.equal(node.status, 201);
    assert.equal(node.body.type, "task");

    const patched = await request(port, "PATCH", `/api/workflow-templates/${id}/designer/nodes/${node.body.id}`, {
      token,
      body: { name: "Async Node Renamed" },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.name, "Async Node Renamed");

    const endNode = designer.body.graph.nodes.find((n) => n.type === "end");
    const edge1 = await request(port, "POST", `/api/workflow-templates/${id}/designer/transitions`, {
      token,
      body: { from_node_id: startNode.id, to_node_id: node.body.id, transition_key: "async-start" },
    });
    assert.equal(edge1.status, 201);
    const edge = await request(port, "POST", `/api/workflow-templates/${id}/designer/transitions`, {
      token,
      body: { from_node_id: node.body.id, to_node_id: endNode.id, transition_key: "async-edge" },
    });
    assert.equal(edge.status, 201);
    assert.equal(edge.body.transition_key, "async-edge");

    const layout = await request(port, "POST", `/api/workflow-templates/${id}/designer/auto-layout`, { token, body: {} });
    assert.equal(layout.status, 200);

    const version = await request(port, "POST", `/api/workflow-templates/${id}/versions`, { token, body: {} });
    assert.equal(version.status, 201);
    assert.equal(version.body.definition_id, id);

    const publish = await request(port, "POST", `/api/workflow-templates/${id}/publish`, { token, body: {} });
    assert.equal(publish.status, 200);
    assert.equal(publish.body.definition.status, "published");

    const clone = await request(port, "POST", `/api/workflow-templates/${id}/clone`, {
      token,
      body: { code: "async-authoring-copy" },
    });
    assert.equal(clone.status, 201);
    assert.equal(clone.body.code, "async-authoring-copy");

    const status = await request(port, "POST", `/api/workflow-templates/${id}/status`, { token, body: { status: "inactive" } });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, "inactive");

    const removedEdge = await request(port, "DELETE", `/api/workflow-templates/${id}/designer/transitions/${edge.body.id}`, { token });
    assert.equal(removedEdge.status, 200);
    const removedEdge2 = await request(port, "DELETE", `/api/workflow-templates/${id}/designer/transitions/${edge1.body.id}`, { token });
    assert.equal(removedEdge2.status, 200);
    const removedNode = await request(port, "DELETE", `/api/workflow-templates/${id}/designer/nodes/${node.body.id}`, { token });
    assert.equal(removedNode.status, 200);

    const freshDesigner = await request(port, "GET", `/api/workflow-templates/${id}/designer`, { token });
    assert.equal(freshDesigner.status, 200);
    const save = await request(port, "PUT", `/api/workflow-templates/${id}/designer`, {
      token,
      body: { graph: freshDesigner.body.graph },
    });
    assert.equal(save.status, 200);

    const rule = await request(port, "POST", "/api/workflow-routing-rules", {
      token,
      body: { code: "async-route", name: "Async Route", assignee_type: "role", assignee_ref: "iam.admin" },
    });
    assert.equal(rule.status, 201);
    const ruleUpdate = await request(port, "PATCH", `/api/workflow-routing-rules/${rule.body.id}`, {
      token,
      body: { description: "routed on the async layer" },
    });
    assert.equal(ruleUpdate.status, 200);
    const ruleList = await request(port, "GET", "/api/workflow-routing-rules", { token });
    assert.equal(ruleList.status, 200);
    assert.ok(ruleList.body.items.some((r) => r.code === "async-route"));
    assert.equal((await request(port, "DELETE", `/api/workflow-routing-rules/${rule.body.id}`, { token })).status, 200);

    const escalation = await request(port, "POST", "/api/workflow-escalation-rules", {
      token,
      body: { code: "async-escalate", name: "Async Escalate", after_minutes: 5, action: "raise_priority" },
    });
    assert.equal(escalation.status, 201);
    const escalationList = await request(port, "GET", "/api/workflow-escalation-rules", { token });
    assert.equal(escalationList.status, 200);
    assert.ok(escalationList.body.items.some((r) => r.code === "async-escalate"));

    const template = await request(port, "POST", "/api/workflow-notification-templates", {
      token,
      body: { code: "async-notify", name: "Async Notify", channel: "in_app", subject: "Hello {{username}}", body: "Body" },
    });
    assert.equal(template.status, 201);
    const templateUpdate = await request(port, "PATCH", `/api/workflow-notification-templates/${template.body.id}`, {
      token,
      body: { subject: "Updated subject" },
    });
    assert.equal(templateUpdate.status, 200);
    assert.equal(templateUpdate.body.subject, "Updated subject");
    assert.equal((await request(port, "DELETE", `/api/workflow-notification-templates/${template.body.id}`, { token })).status, 200);

    const binding = await request(port, "POST", "/api/workflow-bindings", {
      token,
      body: { code: "async-binding", name: "Async Binding", event: "object.released", definition_id: id },
    });
    assert.equal(binding.status, 201);
    const bindingList = await request(port, "GET", "/api/workflow-bindings", { token });
    assert.equal(bindingList.status, 200);
    assert.ok(bindingList.body.items.some((b) => b.code === "async-binding"));
    assert.equal((await request(port, "DELETE", `/api/workflow-bindings/${binding.body.id}`, { token })).status, 200);

    const me = await request(port, "GET", "/api/auth/me", { token });
    const delegation = await request(port, "POST", "/api/workflow-delegations", {
      token,
      body: { to_user_id: me.body.user.id, reason: "async delegation" },
    });
    assert.equal(delegation.status, 201);
    const delegationList = await request(port, "GET", "/api/workflow-delegations", { token });
    assert.equal(delegationList.status, 200);
    assert.ok(delegationList.body.items.some((d) => d.id === delegation.body.id));
    assert.equal((await request(port, "DELETE", `/api/workflow-delegations/${delegation.body.id}`, { token })).status, 200);

    const cleanup = await request(port, "DELETE", `/api/workflow-templates/${id}`, { token });
    assert.equal(cleanup.status, 200);
  });

  test("workflow runtime execution writes run on the async layer", async () => {
    const started = await request(port, "POST", "/api/workflow-instances", {
      token,
      body: { workflow_code: "change-request-review", title: "Async runtime run" },
    });
    assert.equal(started.status, 201);
    const instanceId = started.body.id;

    const taskList = await request(port, "GET", `/api/tasks?scope=all&instance_id=${instanceId}`, { token });
    assert.equal(taskList.status, 200);
    const task = taskList.body.items.find((t) => t.instance_id === instanceId);
    assert.ok(task, "runtime instance created a task");

    const claim = await request(port, "POST", `/api/tasks/${task.id}/claim`, { token });
    assert.equal(claim.status, 200);
    assert.equal(claim.body.status, "in_progress");

    const status = await request(port, "POST", `/api/tasks/${task.id}/status`, { token, body: { status: "in_progress" } });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, "in_progress");

    const me = await request(port, "GET", "/api/auth/me", { token });
    const adminId = me.body.user.id;

    const assign = await request(port, "POST", `/api/tasks/${task.id}/assign`, {
      token,
      body: { assignee_type: "user", assignee_id: adminId },
    });
    assert.equal(assign.status, 200);
    assert.equal(assign.body.assignee_id, adminId);

    const delegate = await request(port, "POST", `/api/tasks/${task.id}/delegate`, {
      token,
      body: { to_user_id: adminId, reason: "async runtime delegation" },
    });
    assert.equal(delegate.status, 200);
    assert.ok(delegate.body.delegation_id);

    const subtask = await request(port, "POST", `/api/tasks/${task.id}/subtasks`, { token, body: { title: "Async subtask" } });
    assert.equal(subtask.status, 201);
    const subtaskUpdate = await request(port, "PATCH", `/api/tasks/${task.id}/subtasks/${subtask.body.id}`, {
      token,
      body: { status: "done" },
    });
    assert.equal(subtaskUpdate.status, 200);
    assert.equal(subtaskUpdate.body.status, "done");
    assert.equal((await request(port, "DELETE", `/api/tasks/${task.id}/subtasks/${subtask.body.id}`, { token })).status, 200);

    const complete = await request(port, "POST", `/api/tasks/${task.id}/complete`, { token, body: { outcome: "runtime" } });
    assert.equal(complete.status, 200);
    assert.equal(complete.body.status, "completed");

    const approvals = await request(port, "GET", `/api/workflow-approvals?instance_id=${instanceId}`, { token });
    assert.equal(approvals.status, 200);
    const approval = approvals.body.items.find((a) => a.instance_id === instanceId);
    assert.ok(approval, "completing the task created an approval");

    const decision = await request(port, "POST", `/api/workflow-approvals/${approval.id}/decision`, {
      token,
      body: { decision: "approve", comment: "approved on the async layer" },
    });
    assert.equal(decision.status, 200);
    assert.equal(decision.body.status, "approved");

    const afterDecision = await request(port, "GET", `/api/workflow-instances/${instanceId}`, { token });
    assert.equal(afterDecision.status, 200);
    assert.notEqual(afterDecision.body.status, "failed");

    const second = await request(port, "POST", "/api/workflow-instances", {
      token,
      body: { workflow_code: "change-request-review", title: "Async control run" },
    });
    assert.equal(second.status, 201);
    const sid = second.body.id;

    const paused = await request(port, "POST", `/api/workflow-instances/${sid}/pause`, { token, body: { reason: "async pause" } });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.status, "paused");

    const resumed = await request(port, "POST", `/api/workflow-instances/${sid}/resume`, { token, body: {} });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.status, "running");

    const pausedAgain = await request(port, "POST", `/api/workflow-instances/${sid}/pause`, { token, body: {} });
    assert.equal(pausedAgain.status, 200);
    assert.equal(pausedAgain.body.status, "paused");

    const retried = await request(port, "POST", `/api/workflow-instances/${sid}/retry`, { token, body: { reason: "async retry" } });
    assert.equal(retried.status, 200);
    assert.equal(retried.body.status, "running");

    const cancelled = await request(port, "POST", `/api/workflow-instances/${sid}/cancel`, { token, body: { reason: "async cancel" } });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");
  });
});

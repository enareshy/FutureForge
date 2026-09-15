import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, queryAll, run } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as workflow from "../services/workflow.js";
import * as lifecycle from "../services/lifecycle.js";

// Service-level coverage for the Workflow & Process Engine: template
// versioning, graph validation, the runtime engine, routing, escalation,
// tasks/approvals and lifecycle integration.

describe("workflow engine services", () => {
  let db;
  let actor;
  let tenantId;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
  });

  test("seed publishes a demo workflow and starts an instance with a task", () => {
    const definitions = workflow.listDefinitions(db, {}, tenantId);
    assert.ok(definitions.items.some((d) => d.code === "change-request-review"));
    const definition = workflow.getDefinition(db, "change-request-review", tenantId);
    assert.equal(definition.status, "published");
    assert.equal(definition.published_version, 1);

    const instances = workflow.listInstances(db, {}, tenantId);
    assert.ok(instances.total >= 1);
    const instance = instances.items.find((i) => i.title.includes("ECN-1000"));
    assert.equal(instance.status, "running");

    const detail = workflow.getInstance(db, instance.id, tenantId);
    const task = detail.tasks.find((t) => t.status !== "completed");
    assert.ok(task);
    assert.equal(task.assignee_ref, "iam.admin");
  });

  test("validates workflow graphs before they can be published", () => {
    const valid = workflow.validateGraph({
      nodes: [
        { id: 1, node_key: "start", type: "start" },
        { id: 2, node_key: "end", type: "end" },
      ],
      transitions: [{ id: 1, transition_key: "e1", from_node_id: 1, to_node_id: 2 }],
    });
    assert.equal(valid.valid, true);

    const missingEnd = workflow.validateGraph({
      nodes: [{ id: 1, node_key: "start", type: "start" }],
      transitions: [],
    });
    assert.equal(missingEnd.valid, false);
    assert.ok(missingEnd.errors.some((e) => e.includes("end node")));

    const disconnected = workflow.validateGraph({
      nodes: [
        { id: 1, node_key: "start", type: "start" },
        { id: 2, node_key: "orphan", type: "task" },
        { id: 3, node_key: "end", type: "end" },
      ],
      transitions: [{ id: 1, transition_key: "e1", from_node_id: 1, to_node_id: 3 }],
    });
    assert.ok(disconnected.errors.some((e) => e.includes("orphan")));

    const badDecision = workflow.validateGraph({
      nodes: [
        { id: 1, node_key: "start", type: "start" },
        { id: 2, node_key: "route", type: "decision" },
        { id: 3, node_key: "end", type: "end" },
      ],
      transitions: [
        { id: 1, transition_key: "e1", from_node_id: 1, to_node_id: 2 },
        { id: 2, transition_key: "e2", from_node_id: 2, to_node_id: 3 },
      ],
    });
    assert.ok(badDecision.errors.some((e) => e.includes("default branch")));
  });

  test("auto layout positions nodes by depth", () => {
    const graph = workflow.validateGraph({ nodes: [], transitions: [] });
    assert.equal(graph.valid, false);
    const nodes = [
      { id: 1, node_key: "start", type: "start", display_order: 0 },
      { id: 2, node_key: "task", type: "task", display_order: 1 },
      { id: 3, node_key: "end", type: "end", display_order: 2 },
    ];
    const transitions = [
      { from_node_id: 1, to_node_id: 2 },
      { from_node_id: 2, to_node_id: 3 },
    ];
    const positions = workflow.autoLayout(nodes, transitions);
    const byId = new Map(positions.map((p) => [p.id, p]));
    assert.ok(byId.get(2).position_x > byId.get(1).position_x);
    assert.ok(byId.get(3).position_x > byId.get(2).position_x);
  });

  test("published versions are immutable and can be versioned", () => {
    const created = workflow.createDefinition(
      db,
      { code: "unit-flow", name: "Unit Flow", tenant_id: tenantId },
      actor,
      "test",
      tenantId
    );
    const published = workflow.publishDefinition(db, created.id, {}, actor, "test", tenantId);
    assert.equal(published.version.status, "published");

    assert.throws(
      () =>
        workflow.saveDesignerGraph(
          db,
          created.id,
          { version: published.version.id, graph: { nodes: [], transitions: [] } },
          actor,
          "test",
          tenantId
        ),
      (err) => err.status === 409
    );

    const draft = workflow.createVersion(db, created.id, { notes: "next" }, actor, "test", tenantId);
    assert.equal(draft.status, "draft");
    assert.ok(draft.graph.nodes.length >= 2);
  });

  test("runs a workflow to completion through task and approval nodes", () => {
    const instance = workflow.startInstance(
      db,
      { workflow_code: "change-request-review", title: "Unit change", context: { priority: "low" } },
      actor,
      tenantId,
      "test"
    );
    assert.equal(instance.status, "running");
    const task = workflow.listTasks(db, {}, tenantId, actor, { scope: "all" }).items.find((t) => t.instance_id === instance.id);
    assert.ok(task);

    workflow.completeTask(db, task.id, { outcome: "assessed" }, actor, tenantId, "test");
    const approval = queryOne(db, "SELECT * FROM workflow_approvals WHERE instance_id = ?", [instance.id]);
    assert.ok(approval);
    assert.equal(approval.status, "pending");

    workflow.decideApproval(db, approval.id, { decision: "approve", comment: "ok" }, actor, tenantId, "test");
    const finished = workflow.getInstance(db, instance.id, tenantId);
    assert.equal(finished.status, "completed");
    assert.ok(finished.events.some((e) => e.event_type === "workflow.completed"));
  });

  test("a rejected approval fails the instance and requires a comment", () => {
    const instance = workflow.startInstance(
      db,
      { workflow_code: "change-request-review", title: "Reject change", context: { priority: "low" } },
      actor,
      tenantId,
      "test"
    );
    const task = workflow.listTasks(db, {}, tenantId, actor, { scope: "all" }).items.find((t) => t.instance_id === instance.id);
    workflow.completeTask(db, task.id, { outcome: "assessed" }, actor, tenantId, "test");
    const approval = queryOne(db, "SELECT * FROM workflow_approvals WHERE instance_id = ?", [instance.id]);

    assert.throws(
      () => workflow.decideApproval(db, approval.id, { decision: "reject" }, actor, tenantId, "test"),
      (err) => err.status === 400
    );
    workflow.decideApproval(db, approval.id, { decision: "reject", comment: "missing data" }, actor, tenantId, "test");
    const failed = workflow.getInstance(db, instance.id, tenantId);
    assert.equal(failed.status, "failed");

    workflow.retryInstance(db, instance.id, { reason: "fixed" }, actor, tenantId, "test");
    assert.equal(workflow.getInstance(db, instance.id, tenantId).status, "running");
  });

  test("validates approval approve and reject outcome paths", () => {
    const result = workflow.validateGraph({
      nodes: [
        { id: 1, node_key: "start", type: "start" },
        { id: 2, node_key: "approve", type: "approval", config: { approval_rule_code: "x", approve_transition_key: "missing" } },
        { id: 3, node_key: "end", type: "end" },
      ],
      transitions: [
        { id: 1, transition_key: "e1", from_node_id: 1, to_node_id: 2 },
        { id: 2, transition_key: "e2", from_node_id: 2, to_node_id: 3 },
      ],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("approve path")));
  });

  test("routes approvals down configured approve and reject paths", () => {
    const rule = queryOne(db, "SELECT id FROM approval_rules WHERE code = 'change-approval'");
    const graph = {
      nodes: [
        { node_key: "start", type: "start", name: "Start" },
        {
          node_key: "approve",
          type: "approval",
          name: "Approve",
          config: { approval_rule_id: rule.id, approve_transition_key: "approve-yes", reject_transition_key: "approve-no" },
        },
        { node_key: "do-approve", type: "task", name: "Apply change", config: { assignee_type: "role", assignee_ref: "iam.admin" } },
        { node_key: "do-reject", type: "task", name: "Rework request", config: { assignee_type: "role", assignee_ref: "iam.admin" } },
        { node_key: "end", type: "end", name: "End" },
      ],
      transitions: [
        { transition_key: "e-start", from_node_key: "start", to_node_key: "approve" },
        { transition_key: "approve-yes", from_node_key: "approve", to_node_key: "do-approve" },
        { transition_key: "approve-no", from_node_key: "approve", to_node_key: "do-reject" },
        { transition_key: "e-yes-end", from_node_key: "do-approve", to_node_key: "end" },
        { transition_key: "e-no-end", from_node_key: "do-reject", to_node_key: "end" },
      ],
    };
    const definition = workflow.createDefinition(
      db,
      { code: "approval-paths", name: "Approval Paths", tenant_id: tenantId, graph },
      actor,
      "test",
      tenantId
    );
    workflow.publishDefinition(db, definition.id, {}, actor, "test", tenantId);

    const approved = workflow.startInstance(db, { workflow_code: "approval-paths", title: "Approve path" }, actor, tenantId, "test");
    const approvalA = queryOne(db, "SELECT * FROM workflow_approvals WHERE instance_id = ?", [approved.id]);
    workflow.decideApproval(db, approvalA.id, { decision: "approve", comment: "ok" }, actor, tenantId, "test");
    let tasks = workflow.listTasks(db, { instanceId: approved.id }, tenantId, actor, { scope: "all" }).items;
    const approveTask = tasks.find((t) => t.node_key === "do-approve");
    assert.ok(approveTask, "approve branch task should be created");
    assert.equal(tasks.some((t) => t.node_key === "do-reject"), false);
    workflow.completeTask(db, approveTask.id, { outcome: "done" }, actor, tenantId, "test");
    assert.equal(workflow.getInstance(db, approved.id, tenantId).status, "completed");

    const rejected = workflow.startInstance(db, { workflow_code: "approval-paths", title: "Reject path" }, actor, tenantId, "test");
    const approvalB = queryOne(db, "SELECT * FROM workflow_approvals WHERE instance_id = ?", [rejected.id]);
    workflow.decideApproval(db, approvalB.id, { decision: "reject", comment: "needs rework" }, actor, tenantId, "test");
    const rejectedDetail = workflow.getInstance(db, rejected.id, tenantId);
    assert.equal(rejectedDetail.status, "running");
    const rejectedTasks = workflow.listTasks(db, { instanceId: rejected.id }, tenantId, actor, { scope: "all" }).items;
    const rejectTask = rejectedTasks.find((t) => t.node_key === "do-reject");
    assert.ok(rejectTask, "reject branch task should be created");
    assert.equal(rejectedTasks.some((t) => t.node_key === "do-approve"), false);
    workflow.completeTask(db, rejectTask.id, { outcome: "done" }, actor, tenantId, "test");
    assert.equal(workflow.getInstance(db, rejected.id, tenantId).status, "completed");
  });

  test("routes a conditional task by matching context properties", () => {
    const graph = {
      nodes: [
        { node_key: "start", type: "start", name: "Start" },
        { node_key: "triage", type: "task", name: "Triage", config: { assignee_type: "role", assignee_ref: "iam.admin" } },
        { node_key: "high", type: "task", name: "High risk", config: { assignee_type: "role", assignee_ref: "iam.admin" } },
        { node_key: "low", type: "task", name: "Low risk", config: { assignee_type: "role", assignee_ref: "iam.admin" } },
        { node_key: "end", type: "end", name: "End" },
      ],
      transitions: [
        { transition_key: "e1", from_node_key: "start", to_node_key: "triage" },
        { transition_key: "e2", from_node_key: "triage", to_node_key: "high", condition: { field: "priority", operator: "eq", value: "high" } },
        { transition_key: "e3", from_node_key: "triage", to_node_key: "low", is_default: true },
        { transition_key: "e4", from_node_key: "high", to_node_key: "end" },
        { transition_key: "e5", from_node_key: "low", to_node_key: "end" },
      ],
    };
    const definition = workflow.createDefinition(
      db,
      { code: "conditional-task", name: "Conditional Task", tenant_id: tenantId, graph },
      actor,
      "test",
      tenantId
    );
    workflow.publishDefinition(db, definition.id, {}, actor, "test", tenantId);

    const high = workflow.startInstance(db, { workflow_code: "conditional-task", title: "High", context: { priority: "high" } }, actor, tenantId, "test");
    let tasks = workflow.listTasks(db, { instanceId: high.id }, tenantId, actor, { scope: "all" }).items;
    workflow.completeTask(db, tasks.find((t) => t.node_key === "triage").id, { outcome: "done" }, actor, tenantId, "test");
    tasks = workflow.listTasks(db, { instanceId: high.id }, tenantId, actor, { scope: "all" }).items;
    assert.ok(tasks.some((t) => t.node_key === "high"));
    assert.equal(tasks.some((t) => t.node_key === "low"), false);

    const low = workflow.startInstance(db, { workflow_code: "conditional-task", title: "Low", context: { priority: "low" } }, actor, tenantId, "test");
    tasks = workflow.listTasks(db, { instanceId: low.id }, tenantId, actor, { scope: "all" }).items;
    workflow.completeTask(db, tasks.find((t) => t.node_key === "triage").id, { outcome: "done" }, actor, tenantId, "test");
    tasks = workflow.listTasks(db, { instanceId: low.id }, tenantId, actor, { scope: "all" }).items;
    assert.ok(tasks.some((t) => t.node_key === "low"));
    assert.equal(tasks.some((t) => t.node_key === "high"), false);
  });

  test("resolves assignees from explicit config and routing rules", () => {
    const definition = workflow.getDefinition(db, "change-request-review", tenantId);
    const explicit = workflow.resolveAssignee(db, {
      definitionId: definition.id,
      nodeType: "task",
      nodeConfig: { assignee_type: "role", assignee_ref: "iam.admin" },
      context: {},
      tenantId,
    });
    assert.equal(explicit.source, "node");

    const routed = workflow.resolveAssignee(db, {
      definitionId: definition.id,
      nodeType: "task",
      nodeConfig: {},
      context: { priority: "high" },
      tenantId,
    });
    assert.equal(routed.source, "rule");
    assert.equal(routed.assignee_ref, "iam.admin");

    const none = workflow.resolveAssignee(db, { definitionId: definition.id, nodeType: "task", nodeConfig: {}, context: {}, tenantId });
    assert.equal(none.assignee_type, "unassigned");
  });

  test("escalation sweep raises priority for overdue tasks", () => {
    const task = queryOne(db, "SELECT * FROM workflow_tasks WHERE status != 'completed' ORDER BY id LIMIT 1");
    assert.ok(task);
    run(db, "UPDATE workflow_tasks SET escalation_at = '2000-01-01 00:00:00', escalated = 0, priority = 'normal' WHERE id = ?", [
      task.id,
    ]);
    const result = workflow.sweepEscalations(db, { tenantId, now: "2100-01-01 00:00:00" });
    assert.ok(result.swept >= 1);
    const updated = queryOne(db, "SELECT escalated, priority FROM workflow_tasks WHERE id = ?", [task.id]);
    assert.equal(updated.escalated, 1);
    assert.equal(updated.priority, "urgent");
  });

  test("supports subtasks, comments, attachments and task scopes", () => {
    const task = queryOne(db, "SELECT * FROM workflow_tasks WHERE status != 'completed' ORDER BY id LIMIT 1");
    const subtask = workflow.addSubtask(db, task.id, { title: "Check impact" }, actor, tenantId);
    assert.equal(subtask.status, "todo");
    workflow.updateSubtask(db, task.id, subtask.id, { status: "done" }, actor, tenantId);
    assert.equal(workflow.getTask(db, task.id, tenantId, actor).subtasks[0].status, "done");

    workflow.addComment(db, task.id, { body: "Please prioritise" }, actor, tenantId);
    assert.equal(workflow.listComments(db, task.id, tenantId).length, 1);

    workflow.addAttachment(db, task.id, { filename: "spec.pdf", url: "https://example.test/spec.pdf" }, actor, tenantId);
    assert.equal(workflow.listAttachments(db, task.id, tenantId).length, 1);

    const mine = workflow.listTasks(db, {}, tenantId, actor, { scope: "mine" });
    assert.ok(mine.total >= 1);
    const all = workflow.listTasks(db, {}, tenantId, actor, { scope: "all" });
    assert.ok(all.total >= mine.total);
  });

  test("executes parallel branches through a join", () => {
    const graph = {
      nodes: [
        { node_key: "start", type: "start", name: "Start" },
        { node_key: "split", type: "parallel", name: "Split" },
        { node_key: "task-a", type: "task", name: "A", config: { assignee_type: "role", assignee_ref: "iam.admin" } },
        { node_key: "task-b", type: "task", name: "B", config: { assignee_type: "role", assignee_ref: "iam.admin" } },
        { node_key: "join", type: "join", name: "Join" },
        { node_key: "end", type: "end", name: "End" },
      ],
      transitions: [
        { transition_key: "e1", from_node_key: "start", to_node_key: "split" },
        { transition_key: "e2", from_node_key: "split", to_node_key: "task-a" },
        { transition_key: "e3", from_node_key: "split", to_node_key: "task-b" },
        { transition_key: "e4", from_node_key: "task-a", to_node_key: "join" },
        { transition_key: "e5", from_node_key: "task-b", to_node_key: "join" },
        { transition_key: "e6", from_node_key: "join", to_node_key: "end" },
      ],
    };
    const definition = workflow.createDefinition(
      db,
      { code: "parallel-flow", name: "Parallel Flow", tenant_id: tenantId, graph },
      actor,
      "test",
      tenantId
    );
    workflow.publishDefinition(db, definition.id, {}, actor, "test", tenantId);
    const instance = workflow.startInstance(
      db,
      { workflow_code: "parallel-flow", title: "Parallel run" },
      actor,
      tenantId,
      "test"
    );
    const tasks = workflow.listTasks(db, { instanceId: instance.id }, tenantId, actor, { scope: "all" }).items;
    assert.equal(tasks.length, 2);
    for (const task of tasks) {
      workflow.completeTask(db, task.id, { outcome: "done" }, actor, tenantId, "test");
    }
    assert.equal(workflow.getInstance(db, instance.id, tenantId).status, "completed");
  });

  test("elapses an immediate timer and completes", () => {
    const graph = {
      nodes: [
        { node_key: "start", type: "start", name: "Start" },
        { node_key: "wait", type: "timer", name: "Wait", config: { duration_minutes: 0 } },
        { node_key: "end", type: "end", name: "End" },
      ],
      transitions: [
        { transition_key: "e1", from_node_key: "start", to_node_key: "wait" },
        { transition_key: "e2", from_node_key: "wait", to_node_key: "end" },
      ],
    };
    const definition = workflow.createDefinition(
      db,
      { code: "timer-flow", name: "Timer Flow", tenant_id: tenantId, graph },
      actor,
      "test",
      tenantId
    );
    workflow.publishDefinition(db, definition.id, {}, actor, "test", tenantId);
    const instance = workflow.startInstance(db, { workflow_code: "timer-flow", title: "Timer run" }, actor, tenantId, "test");
    assert.equal(workflow.getInstance(db, instance.id, tenantId).status, "completed");
  });

  test("starts a bound workflow when a lifecycle release is approved", () => {
    const before = workflow.listInstances(db, {}, tenantId).total;
    const object = queryOne(db, "SELECT id FROM objects WHERE code = 'PROD-1000'");
    const result = workflow.onLifecycleApprovalComplete(db, {
      release: { id: 999, status: "approved", tenant_id: tenantId, object_id: object.id },
      object: { id: object.id, code: "PROD-1000", organization_id: null },
      rule: { code: "product-approval" },
    });
    assert.equal(result.delegated, true);
    assert.ok(result.started.length >= 1);
    assert.ok(workflow.listInstances(db, {}, tenantId).total > before);
    // The lifecycle module now delegates approver resolution to the engine.
    const resolved = lifecycle.resolveApprovers(db, {
      step: { approver_type: "role", approver_id: "iam.admin" },
      object: { organization_id: null },
      tenantId,
    });
    assert.ok(resolved.some((u) => u.username === "admin"));
  });
});

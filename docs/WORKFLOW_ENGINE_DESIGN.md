# Workflow & Process Engine Design

The Workflow & Process Engine is a configuration-driven orchestration layer for
Helix. Business modules (Change Management, Product Data, BOM, Quality,
Document Control) describe *what* has to happen in versioned workflow templates
authored in a visual designer; the engine executes those templates as isolated
runtime instances, hands work to people through tasks, approvals, routing and
escalation, and records a complete audit trail.

Nothing about a customer process is hard-coded. Templates are data, published
versions are immutable, and a running instance pins the exact template version
it started with so future authoring never mutates history.

## 1. Architecture

```
                 +-------------------------+        +-------------------------+
  Designer UI -> | workflow templates API  | -----> | workflow_definitions     |
                 | designer / publish      |        | workflow_versions        |
                 +-------------------------+        | workflow_nodes           |
                                                     | workflow_transitions     |
                                                     +-------------------------+
                                                                  |
                                          start(version pin)      v
                 +-------------------------+        +-------------------------+
  Runtime UI  -> | workflow instances API  | -----> | workflow_instances       |
  Task inbox     | engine.advance()        |        | workflow_instance_nodes  |
  Approvals      | task & approval services|        | workflow_tasks           |
                 +-------------------------+        | workflow_approvals       |
                         |        |                 | workflow_task_subtasks   |
                         |        |                 | workflow_task_comments   |
                         v        v                 +-------------------------+
                 +-----------------+  +--------------------+
                 | routing engine  |  | escalation sweep   |
                 | (rules->assignee)| | (timers -> actions)|
                 +-----------------+  +--------------------+
                         |                     |
                         v                     v
                 +-----------------------------------------+
                 | notifications + workflow event history  |
                 +-----------------------------------------+
```

Layers:

- **Template layer** (`workflow_definitions`, `workflow_versions`,
  `workflow_nodes`, `workflow_transitions`) - authoring, validation, versioning
  and publishing. A definition owns an incrementing version series; a published
  version is frozen.
- **Runtime layer** (`workflow_instances`, `workflow_instance_nodes`,
  `workflow_tasks`, `workflow_task_*`) - one instance per execution. `context`
  (form data, referenced object, decision values) lives on the instance; node
  tokens live on `workflow_instance_nodes`.
- **Work assignment layer** (`workflow_tasks`, routing and escalation rules,
  delegations) - turns engine nodes into human work.
- **Integration layer** (`workflow_bindings`, `workflow_notifications`,
  `approval_rules` reuse, lifecycle workflow seam) - lets other modules start
  workflows and lets lifecycle approvals flow into the engine.

### Design principles

- **CQRS-ish separation**: authored templates are versioned and immutable once
  published; instances are append-only event streams plus mutable task state.
- **Instance pinning**: `workflow_instances.version_id` is set at start time.
  The engine only ever reads nodes/transitions for that version id.
- **Idempotent advancement**: `advance(instanceId)` is safe to call repeatedly;
  it processes ready tokens and stops at the first blocking element.
- **No duplicated lifecycle logic**: approval rules and their steps are the same
  `approval_rules` / `approval_rule_steps` tables the Lifecycle module owns.
  The engine *consumes* them; it never re-implements lifecycle transitions.
- **Reuse before build**: tenant scoping (`metadata/scope.js`), condition
  evaluation (`metadata/expression.js`), metadata validation, IAM, and audit are
  all reused.

## 2. Data Model

### Template layer

| Table | Purpose | Key columns |
| --- | --- | --- |
| `workflow_definitions` | Logical workflow, owns version series | `code`, `name`, `category`, `module`, `current_version`, `published_version`, `status`, `tenant_id`, `is_system` |
| `workflow_versions` | Immutable snapshot | `definition_id`, `version`, `status(draft/published/archived)`, `snapshot` (full JSON graph), `published_at/by`, `created_by` |
| `workflow_nodes` | Node of a draft version | `version_id`, `node_key`, `type`, `name`, `config_json`, `position_x`, `position_y`, `display_order` |
| `workflow_transitions` | Directed edge of a draft version | `version_id`, `transition_key`, `from_node_id`, `to_node_id`, `condition_json`, `is_default`, `display_order` |

Node types (extensible vocabulary):

| Type | Behaviour |
| --- | --- |
| `start` | Single entry token, auto-advances |
| `end` | Completes the instance when reached |
| `task` | Creates a human task; engine pauses until completed |
| `approval` | Creates approval work using a lifecycle `approval_rule`; pauses until resolved |
| `decision` | Exclusive gateway: first matching outgoing condition, else default |
| `parallel` | Splits into all outgoing branches |
| `join` | Waits for all incoming branches before continuing |
| `notification` | Emits a notification and auto-advances |
| `timer` | Pauses until a due time, then auto-advances |
| `subprocess` | Starts a child instance of another definition and waits |
| `service` | Calls a registered server-side handler, then advances |
| `terminate` | Cancels the instance |

### Runtime layer

| Table | Purpose |
| --- | --- |
| `workflow_instances` | Execution header: `code`, `definition_id`, `version_id`, `object_id`, `status`, `context_json`, `current_node_id`, `started_by`, `ended_at`, `tenant_id` |
| `workflow_instance_nodes` | Token/visit log: `node_key`, `type`, `status(pending/active/completed/skipped/failed/cancelled)`, `outcome`, `entered_at`, `completed_at`, `data_json` |
| `workflow_tasks` | Work item: `status`, `priority`, `assignee_type/id`, `claimed_by`, `due_at`, `escalation_at`, `escalated`, `outcome`, `parent_task_id`, `object_id` |
| `workflow_task_subtasks` | Checklist rows |
| `workflow_task_comments` | Discussion per task |
| `workflow_task_attachments` | Attachment metadata (id/name/url/size) |
| `workflow_approvals` | Approval decision per approver for an `approval` node |
| `workflow_events` | Append-only instance history (progress, decisions, escalations) |

### Configuration layer

| Table | Purpose |
| --- | --- |
| `workflow_routing_rules` | Priority-ordered condition -> assignee/queue resolution |
| `workflow_escalation_rules` | After N minutes: reassign / notify / raise priority |
| `workflow_delegations` | User-to-user delegation window |
| `workflow_notification_templates` | Channel/subject/body templates |
| `workflow_notifications` | Outbound message log |
| `workflow_bindings` | Event -> workflow trigger (e.g. `lifecycle.release.approved`) |

All tables carry `tenant_id` (NULL = global/platform) and reuse
`metadata/scope.js` semantics. Published versions are readable across tenants
only when global; tenant-local templates are isolated.

## 3. Visual Designer Architecture

The designer is a controlled React canvas that edits a **draft** version's node
and transition rows. The server is the source of truth; the client keeps an
optimistic working graph and commits explicitly.

- **Canvas**: absolutely-positioned node cards over an SVG edge layer, wrapped in
  a CSS `transform` (pan/zoom) container. Drag uses pointer events; zoom via
  wheel/buttons; a minimap renders a scaled overview with a viewport rectangle.
- **Palette**: click or drag a node type onto the canvas to create a node with a
  generated `node_key` and default config.
- **Connectors**: drag from a node's output port to another node's input port to
  create a transition. Decision/approval nodes label edges with conditions and a
  default; parallel/join support multiple in/out edges.
- **Editing**: property panel edits name, description, assignee, approval rule,
  due/escalation offsets, condition expression, notification template and
  position. Copy/paste/duplicate/delete and multi-select operate on the working
  graph.
- **Undo/redo**: a bounded history stack of graph snapshots.
- **Auto-layout**: deterministic layered (topological) layout assigns stable
  positions for start/task/decision/end chains and staggers parallel branches.
- **Validation**: client mirrors server rules (single start, at least one end,
  no orphan nodes, every non-end node has an outgoing transition, decision
  needs a default or a condition, join/parallel consistency, no undefined
  references). Save is blocked on errors; warnings are informational.
- **Save / publish**: save writes the graph back to the draft version (replace
  nodes/transitions transactionally). Publish runs server-side validation,
  snapshots the version, freezes it and bumps `published_version`.

## 4. Execution & Routing Flow

```
start() -> resolve published version -> insert instance -> advance()

advance(instanceId):
  loop:
    ready = active/pending tokens that can progress
    for each token:
      start        -> complete, follow outgoing
      service      -> run handler, complete, follow outgoing
      notification -> emit, complete, follow outgoing
      decision     -> pick first true condition (else default), follow that edge
      parallel     -> complete, activate every outgoing edge
      join         -> if all incoming branches completed: complete, follow outgoing
                      else: stay pending
      task         -> create task(s), block token
      approval     -> create approvals from approval rule steps, block token
      timer        -> set due_at, block token
      subprocess   -> start child, block until child completes
      terminate    -> cancel instance
    if no token progressed -> stop
```

- **Routing**: when a `task`/`approval` node materializes, the routing engine
  resolves an assignee. Precedence: routing rules (priority, condition match,
  first match wins) -> explicit node `assignee` -> configured fallback role.
  Assignee kinds mirror approvals: `user`, `role`, `organization`, `group`,
  `queue`.
- **Completion**: completing a task signals its token; if a `join` gate becomes
  satisfied, the engine resumes. Reaching `end` (with no outstanding tokens)
  marks the instance `completed`.
- **Pause/resume/cancel**: pause stops new work materializing; resume calls
  `advance`; cancel closes every open task and token.
- **Subprocess**: the child records `parent_instance_id`; on completion the
  parent token advances with the child result in `data_json`.
- **Error handling**: a failing service handler marks the token `failed` and the
  instance `failed`, leaving enough context for retry.

## 5. Approvals, Escalation and Notifications

- **Approvals** reuse the lifecycle `approval_rules` and `approval_rule_steps`
  definition format (sequential/parallel steps, `any|all|min` quorums,
  mandatory rejection comments, self-approval policy). The engine creates one
  `workflow_approvals` row per resolved approver, evaluates completion with the
  same semantics, and records the decision on the token.
- **Delegation**: an assigned user may delegate a task; the delegation table is
  consulted when listing "my tasks" so a delegate sees delegated work.
- **Escalation**: a scheduler sweep (`sweepEscalations`) looks at open tasks
  whose `escalation_at`/`due_at` has passed and applies matching escalation
  rules: reassign to a target, raise priority, or notify. Every action writes a
  `workflow_events` row and stamps `escalated`.
- **Notifications**: the notification service renders a template, records a
  `workflow_notifications` row and dispatches through a pluggable transport
  (default: stored-only, so the platform has no external dependency).

## 6. Lifecycle Integration

The Lifecycle module exposes a workflow seam in
`server/services/lifecycle/workflow.js`:

- `registerWorkflowExecutor(impl)` - the Workflow Engine registers itself at
  startup via `registerLifecycleExecutor()`.
- `resolveApprovers` - the engine can extend approver resolution (groups,
  queues) while falling back to lifecycle's built-in resolver.
- `onApprovalComplete` - when a lifecycle release is approved/rejected the
  engine looks up active `workflow_bindings` for the matching event and starts
  the bound workflow, seeding `context.object_id`/`context.release_id`.
- `startApproval` - reserved for delegating approval orchestration.

This keeps lifecycle release/approval rules authoritative for status
transitions while allowing automated follow-on processes. The engine never
mutates lifecycle state machine tables directly; it calls the existing
`applyTransition`/`release` services.

## 7. API Surface

| Area | Routes |
| --- | --- |
| Templates | `GET/POST /api/workflow-templates`, `GET/PATCH/DELETE /api/workflow-templates/:id` |
| Versions | `GET/POST /api/workflow-templates/:id/versions`, `GET /api/workflow-templates/:id/versions/:version`, `POST /api/workflow-templates/:id/validate`, `POST /api/workflow-templates/:id/publish`, `POST /api/workflow-templates/:id/clone` |
| Designer | `GET/PUT /api/workflow-templates/:id/designer`, `POST .../designer/nodes`, `PATCH/DELETE .../designer/nodes/:nodeId`, `POST .../designer/transitions`, `PATCH/DELETE .../designer/transitions/:transitionId`, `POST .../designer/auto-layout`, `POST .../designer/validate` |
| Instances | `GET /api/workflow-instances`, `GET /api/workflow-instances/:id`, `POST /api/workflow-instances`, `POST /api/workflow-instances/:id/cancel|pause|resume|retry`, `GET /api/workflow-instances/:id/history|nodes` |
| Tasks | `GET /api/tasks` (`scope=mine|team|all`), `GET /api/tasks/:id`, `POST /api/tasks/:id/complete|assign|claim|delegate|status`, `GET/POST /api/tasks/:id/comments|attachments`, `POST /api/tasks/:id/subtasks`, `PATCH/DELETE /api/tasks/:id/subtasks/:subtaskId` |
| Approvals | `GET /api/workflow-approvals` (`scope=mine|team|all`), `GET /api/workflow-approvals/:id`, `POST /api/workflow-approvals/:id/decision|approve|reject|request-changes` |
| Routing | `GET/POST /api/workflow-routing-rules`, `PATCH/DELETE /api/workflow-routing-rules/:id` |
| Escalation | `GET/POST /api/workflow-escalation-rules`, `PATCH/DELETE /api/workflow-escalation-rules/:id`, `POST /api/workflow-escalations/sweep` |
| Notifications | `GET /api/workflow-notifications`, `POST /api/workflow-notifications/:id/read`, `GET/POST /api/workflow-notification-templates`, `PATCH/DELETE /api/workflow-notification-templates/:id` |
| Bindings | `GET/POST /api/workflow-bindings`, `PATCH/DELETE /api/workflow-bindings/:id` |
| Delegation | `GET/POST /api/workflow-delegations`, `DELETE /api/workflow-delegations/:id` |

All list endpoints support pagination, filtering, sorting and tenant scoping;
all mutations are gated by IAM (`iam.workflow` and sub-resources) and audited.

## 8. Implementation Plan

1. Migration `011_workflow` in `server/schema.sql` + `db.js` marker.
2. Services under `server/services/workflow/`: `validation`, `templates`,
   `designer`, `engine`, `tasks`, `routing`, `approvals`, `escalations`,
   `notifications`, `bindings`, `lifecycle-bridge`.
3. Facade `server/services/workflow.js` + `platform.js` re-exports.
4. IAM resources and demo workflow in `seed.js`.
5. REST routes in `server/app.js`.
6. Unit tests (`workflow.test.js`) and HTTP tests (`workflow-api.test.js`).
7. React pages: template list, visual designer, instance monitor, My Tasks,
   approvals inbox; API client + navigation.

## 9. Known Limitations

- The default notification transport stores messages; wiring SMTP/webhook is a
  deployment concern behind the transport interface.
- The scheduler is pull-based (`POST /api/workflow-escalations/sweep` or an
  external cron); the platform intentionally does not run an in-process timer.
- Service-node handlers are registered in-process; distributed workers are out
  of scope for this iteration.
- Auto-layout is deterministic but simple; manual positioning is always
  preserved.

## 10. Implementation Status

Implemented end to end:

- Migration `011_workflow` (`server/schema.sql`, `server/db.js`).
- Services in `server/services/workflow/` plus the facade
  `server/services/workflow.js` (re-exported through `server/platform.js`).
- Seed data: approval rule `change-approval`, published template
  `change-request-review` (start → task → approval → decision → notification →
  end), routing rule `change-high-priority`, escalation rule `change-overdue`,
  notification template `task-assigned`, binding `release-to-change-review`, and
  a demo instance for `ECN-1000`.
- IAM resources `iam.workflow` (+ `.templates`, `.designer`, `.instances`,
  `.tasks`, `.approvals`, `.config`) granted to `platform.admin` and
  `iam.admin`.
- Unit coverage `server/tests/workflow.test.js` and HTTP coverage
  `server/tests/workflow-api.test.js`.
- Console UI under `/workflows` (`web/src/pages/WorkflowPage.jsx`) with My
  Tasks, Team Tasks, Approvals, the visual designer
  (`web/src/components/WorkflowDesigner.jsx`: zoom/pan, minimap, palette,
  connectors, copy/paste, undo/redo, auto-layout, validation, save/publish) and
  the instance monitor.

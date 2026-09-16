# Background Job Management Design

The Background Job Management module is the platform's centralized job registry,
submission, monitoring, control and tracking service. Every long-running
operation in the platform - bulk imports, CAD processing, BOM validation,
report generation, data synchronization, search indexing, workflow execution and
integration syncs - is submitted here and immediately returns a **Job ID**. A
caller never executes long-running work inside an HTTP request, and no business
module builds its own job management, status tracking or history.

## Scope boundary: this module does not execute work

The actual **Job Scheduling & Execution Engine** (queues, workers, scheduling
algorithms, retry execution, resource allocation) is a separate system and is
**out of scope** here. This module owns:

- the durable job record and its lifecycle,
- the job-type registry (metadata + handler reference only),
- submission with idempotency,
- monitoring, search, filtering and pagination,
- control operations (`cancel`, `retry`, `pause`, `resume`),
- status history / timeline, dependencies and parent/child trees,
- results and artifact references,
- metrics for the dashboard.

The engine reports progress and outcomes back through the service
(`updateProgress`, `transition`, `setJobResult`). This module stores and serves
that state; it never runs a handler, owns a queue, or decides when work runs.

```
  business modules                          job management                    storage
+--------------------+        +----------------------------------+     +----------------+
| Bulk Import        |        |  submitJob  -> Job ID (immediate)|     | jobs           |
| CAD Processing     |------->|   - validate type + idempotency  |---->| job_types      |
| BOM Validation     |        |   - tenant/org scope            |     | job_dependencies|
| Report Generation  |        |   - dependency edges            |     | job_history    |
| Data Sync          |        +----------------------------------+     | job_artifacts  |
| Search Indexing    |                        ^                        +----------------+
| Workflow           |                        | report state
| Integrations       |        +----------------------------------+
+--------------------+        |  Job Scheduling & Execution      |
                              |  Engine (separate system)        |
                              |   updateProgress / transition    |
                              |   setJobResult / addArtifact     |
                              +----------------------------------+
                                             |
                                             v
                              +----------------------------------+
                              |  monitoring & control            |
                              |   listJobs  jobMetrics           |
                              |   cancel/retry/pause/resume      |
                              |   history  dependencies  result   |
                              +----------------------------------+
```

## 1. Layers

- **Vocabulary** (`server/services/jobs/validation.js`) - the canonical status
  set and labels, terminal/active sets, the transition graph, priorities
  (re-exported from the Notification module so they never drift), submission
  origins, artifact kinds, queue/code guards, progress clamping and small shared
  helpers.
- **Type registry** (`types.js`) - job-type CRUD, queues, required permissions,
  timeout/retry defaults, retry policy, activation, and
  `ensureDefaultJobTypes` which seeds the standard business-module types.
- **Job service** (`jobs.js`) - the core record: submission, retrieval, listing,
  the status machine (`transitionJob`), engine progress (`updateProgress`),
  control operations, dependency management and dependent evaluation.
- **History** (`history.js`) - append-only status/event timeline and paged
  history queries.
- **Artifacts** (`artifacts.js`) - result payloads and artifact references
  (never bytes); `resultPayload` assembles the result + error + artifact view.
- **Metrics** (`metrics.js`) - dashboard counters, status/type/module/module
  breakdowns, queue depth, durations, retry totals, recent failures and daily
  throughput.
- **Facade** (`server/services/jobs.js`) - the public surface re-exported (also
  aliased) through `server/platform.js` for other modules.

## 2. Data model

| Table | Purpose |
| --- | --- |
| `job_types` | Registry: unique `code`, `name`, `source_module`, `handler`, `queues_json`, `required_permissions_json`, `timeout_seconds`, `max_retries`, `default_priority`, `retry_policy_json`, `active`. |
| `jobs` | Canonical record: `job_ref`, type/module/tenant scope, submitter/origin, queue/priority, status/progress/stage/message, input, related object, parent, correlation, idempotency, retry/timeout, schedule and lifecycle timestamps, worker, error and result fields. |
| `job_dependencies` | Directed edges (`job_id` depends on `depends_on_job_id`) with a `required` flag. |
| `job_history` | Immutable timeline: event type, from/to status, progress, stage, message, detail, actor and source. |
| `job_artifacts` | Result references (kind, name, filename, content type, size, url/storage ref, checksum, secure) into the Document & File Management storage abstraction. |

Indexes cover the engine's claim path (`status, queue, priority, scheduled_at`),
tenant listing, type/module/submitter, correlation, parent, related object and
the unique partial index on `idempotency_key` that enforces duplicate
prevention at the database level.

## 3. Status model

Statuses (stored lower-case, exposed upper-case):

`CREATED, QUEUED, WAITING_FOR_DEPENDENCY, SCHEDULED, RUNNING, PAUSED, COMPLETED,
FAILED, RETRYING, CANCEL_REQUESTED, CANCELLED, TIMED_OUT, SKIPPED`

Terminal: `COMPLETED, FAILED, CANCELLED, TIMED_OUT, SKIPPED`.

The transition graph lives in `JOB_TRANSITIONS`. `transitionJob` and the status
branch of `updateProgress` reject illegal edges with HTTP 409, so the stored
lifecycle and timeline stay consistent. Side effects are applied centrally:
`started_at` on the first move to RUNNING, `completed_at` on any terminal move,
`error_code/message/json` on FAILED/TIMED_OUT, and `cancelled_at` on CANCELLED.
Every terminal move triggers `evaluateDependents`.

`updateProgress` is the engine's normal entry point: without a `status` it
updates `progress` (clamped 0-100), `stage`, `message` and `worker_id`; with a
`status` it validates and applies the transition in one call.

## 4. JobService interface

| Operation | Function | Behaviour |
| --- | --- | --- |
| submit | `submitJob` / `submit` | Validate type, resolve defaults, persist, write `created` history + audit, return immediately. Idempotent on `idempotency_key`. |
| getStatus | `getStatus` | Compact status snapshot (status, progress, stage, message, retries, timestamps). |
| cancel | `cancelJob` | Not-started jobs are cancelled immediately; running jobs move to `CANCEL_REQUESTED` for cooperative stop by the engine. |
| retry | `retryJob` | Re-queues a failed/timed-out/cancelled/skipped job, increments `retry_count`, clears error. |
| pause | `pauseJob` | Moves a queued/running/retrying/scheduled job to `PAUSED`. |
| resume | `resumeJob` | Moves a `PAUSED` job back to `QUEUED`. |

Additional engine/management surface: `transitionJob`, `updateProgress`,
`getJob`, `listJobs`, `listHistory`/`jobTimeline`, `listDependencies`/
`addDependencies`/`removeDependency`, `listChildren`, `resultPayload`/
`setJobResult`, `addArtifact`/`listArtifacts`, `jobMetrics`/`jobTimeseries`.

## 5. Dependencies and parent/child

- Submitting with `dependencies: [...]` creates edges and starts the job in
  `WAITING_FOR_DEPENDENCY`.
- When a dependency reaches a terminal state, `evaluateDependents` either
  releases the dependent to `QUEUED`/`SCHEDULED` (all required dependencies
  completed) or fails it with `error_code = dependency_failed` (a required
  dependency failed, timed out or was cancelled).
- Dependencies and dependents are both listed by `listDependencies`; edges can
  be added/removed through the API.
- `parent_job_id` links child jobs to a parent for composite operations;
  `listChildren` returns them.

This is bookkeeping only - it does not schedule or execute anything.

## 6. Idempotency and tenant isolation

- `jobs.idempotency_key` has a unique partial index. `submitJob` first looks up
  an existing job by key and returns it flagged `duplicate`; the index is the
  final guard against races.
- Every query is tenant-scoped. `jobScope(req)` resolves the caller's tenant and
  only platform admins may request `?all=true`. `getJob`/`getJobRow` return 404
  (not 403) for a job outside the caller's tenant so existence is not leaked.
- Dependencies and parents are validated to belong to the same tenant.

## 7. Results, artifacts and secure access

- The engine records structured results with `setJobResult` (`result_json` plus
  an optional secure `result_ref`).
- Large or binary outputs are registered as `job_artifacts`. Only references
  (storage ref / URL / checksum) are stored - file bytes live in the Document &
  File Management storage abstraction. `secure` flags artifacts that require the
  `iam.jobs.results` capability to read.
- Errors are captured as `error_code`, `error_message` and `error_json` and
  surfaced in the Error & Result view.

## 8. Permissions

Resources: `iam.jobs` (module) with `iam.jobs.list`, `iam.jobs.details`,
`iam.jobs.control`, `iam.jobs.types`, `iam.jobs.results`, `iam.jobs.monitoring`.

| Route group | Resource / action |
| --- | --- |
| `GET /api/jobs`, `POST /api/jobs`, `GET /api/jobs/meta` | `iam.jobs.list` `read` / `create` |
| `GET /api/jobs/:id`, `/status`, `/history`, `/dependencies`, `/children` | `iam.jobs.details` `read` |
| `/cancel`, `/retry`, `/pause`, `/resume`, `/progress`, dependency writes | `iam.jobs.control` `execute` |
| `/result`, `/artifacts` | `iam.jobs.results` `read` / `create` |
| `/api/job-types*` | `iam.jobs.types` `read` / `create` / `update` |
| `/api/job-metrics*` | `iam.jobs.monitoring` `read` |

`platform.admin` and `iam.admin` receive full grants; `app.reader` receives
`list` read+create, `details` read, `control` execute, `results` read, `types`
read and `monitoring` read so operators can submit, watch and control their own
tenant's jobs without administrative access. Administrative actions are audited
(`jobs.submit`, `jobs.cancel`, `jobs.retry`, `jobs.pause`, `jobs.resume`,
`jobs.result.record`, `jobs.type.*`, `jobs.dependency.*`).

## 9. REST API

- `GET /api/jobs/meta` - statuses, labels, transitions, priorities, origins,
  artifact kinds.
- `GET /api/jobs` - list with `q`, `status`/`statuses`, `type`, `queue`,
  `priority`, `module`, `submittedBy`, `parentJobId`, `correlationId`,
  `objectType`/`objectId`, `from`/`to`, `active`/`terminal`, `page`,
  `pageSize`, `sort`, `order`.
- `POST /api/jobs` - submit (returns 201 with the Job ID immediately).
- `GET /api/jobs/{id}` (by id or `job_ref`) - details + dependency state.
- `GET /api/jobs/{id}/status`, `/history`, `/dependencies`, `/children`.
- `POST /api/jobs/{id}/cancel`, `/retry`, `/pause`, `/resume`, `/progress`.
- `POST /api/jobs/{id}/dependencies`, `DELETE /api/jobs/{id}/dependencies/{dependsOnId}`.
- `GET /api/jobs/{id}/result`, `POST /api/jobs/{id}/result`.
- `GET /api/jobs/{id}/artifacts`, `POST /api/jobs/{id}/artifacts`.
- `GET /api/job-types`, `GET /api/job-types/{code}`, `POST /api/job-types`,
  `PATCH /api/job-types/{code}`, `POST /api/job-types/{code}/status`.
- `GET /api/job-metrics`, `GET /api/job-metrics/timeseries`.

## 10. Frontend

- **Job dashboard** (`/jobs`) - stat cards, status breakdown, queue depth,
  per-type breakdown, active jobs, 14-day throughput and recent failures, with
  an all-tenants toggle.
- **Jobs** (`/jobs/list`) - submit panel, search/filter/sort, paged table with
  progress bars, status badges and inline control actions.
- **Job details** (`/jobs/:id`) - metadata chips, progress, action buttons,
  status timeline, dependencies (add/remove), dependents, child jobs and the
  Error & Result view.
- **Job types** (`/jobs/admin`) - registry list, create form, inline editing of
  queues/priority/retries/timeout/description and activate/deactivate.
- **Error & result view** - reusable `JobResultPanel` rendering result/error
  JSON and artifact references.

The client API namespace is `web/src/api.js → jobs`; status badge/progress
helpers live in `web/src/components/JobStatusBadge.jsx`.

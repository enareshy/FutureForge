# Background Job Management Operations

Day-2 guide for operating the Background Job Management module: submitting and
watching jobs, investigating failures, controlling running work, and managing
the job-type registry. Design and internals are in
`docs/JOB_MANAGEMENT_DESIGN.md`.

> This module manages and tracks jobs. The actual execution infrastructure is the
> separate Job Scheduling & Execution Engine; this guide covers the management
> surface the engine and operators share.

## 1. Where to find it

- **Job dashboard** - `/jobs` (all users).
- **Jobs** - `/jobs/list` (all users; submit, filter, control).
- **Job details** - `/jobs/{id}` (opened from the list or dashboard).
- **Job types** - `/jobs/admin` (administrators).
- Platform admins can switch on **All tenants** on the dashboard and list.

## 2. Submitting a job

From the console: open `/jobs/list`, pick a **job type** and an optional name,
and press **Submit job**. The new job opens immediately at its details page.

From the API:

```bash
# Submit a report-generation job
curl -s -X POST http://localhost:3001/api/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "job_type_code": "REPORT_GENERATION",
    "name": "Quarterly cost rollup",
    "priority": "high",
    "related_object_type": "report",
    "related_object_id": "42",
    "input": { "period": "2026-Q3" },
    "idempotency_key": "report:2026-Q3:42"
  }'
```

Key points:

- Submission returns **immediately** with the Job ID (`id` + `job_ref`); the
  caller does not wait for the work to finish.
- Always send an `idempotency_key` for retryable callers. Resubmitting the same
  key returns the existing job flagged `duplicate` instead of creating a second.
- The job's queue, priority, retry limit and timeout default from the job type
  unless overridden.
- Pass `dependencies: [<job id or ref>]` to hold a job until others complete; it
  starts in `WAITING_FOR_DEPENDENCY`.
- Jobs are tenant-scoped; the submitter's tenant is applied automatically.

## 3. Watching progress

- The dashboard summarises totals, active/finished counts, success rate,
  retries, average duration, queue depth, per-type breakdown, throughput and the
  most recent failures.
- The list supports search plus status/type/priority/active filters, sorting and
  pagination, with inline progress bars and status badges.
- The details page shows the full status timeline, current stage/message,
  retries, dependencies/dependents, child jobs and results. Reload the page (or
  re-open it) to pick up engine updates.

Machine-readable monitoring:

```bash
# Compact status snapshot
curl -s "http://localhost:3001/api/jobs/$JOB/status" -H "Authorization: Bearer $TOKEN"

# Tenant metrics and 14-day throughput
curl -s "http://localhost:3001/api/job-metrics" -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3001/api/job-metrics/timeseries?days=14" -H "Authorization: Bearer $TOKEN"
```

## 4. Investigating a failure

1. Open the job from **Recent failures** on the dashboard or filter the list by
   status `failed` / `timed_out`.
2. On the details page read the **Error & Result** panel: `error_code`,
   `error_message`, `error_json` and any artifacts (logs, error reports).
3. Read the **Status timeline** to see the last stage and progress before
   failure, and whether a retry already occurred (`retry_count` / `max_retries`).
4. If the failure is a dependency failure the job shows
   `error_code = dependency_failed`; check the **Dependencies** section and fix
   or retry the upstream job first.

## 5. Controlling jobs

Available on the list and details pages (authorization: `iam.jobs.control`):

- **Cancel** - not-started jobs are cancelled immediately; running jobs move to
  `CANCEL_REQUESTED` and stop when the engine acknowledges.
- **Pause** - holds a queued/running/retrying/scheduled job; **Resume** returns
  it to the queue.
- **Retry** - re-queues a failed/timed-out/cancelled/skipped job, clears the
  error and increments `retry_count`.

```bash
curl -s -X POST "http://localhost:3001/api/jobs/$JOB/cancel" -H "Authorization: Bearer $TOKEN" -d '{"reason":"superseded"}'
curl -s -X POST "http://localhost:3001/api/jobs/$JOB/retry"  -H "Authorization: Bearer $TOKEN"
```

Control actions are audited (`jobs.cancel`, `jobs.retry`, `jobs.pause`,
`jobs.resume`) and appended to the job timeline.

## 6. Engine integration contract

The execution engine reports state back through the same service the API wraps:

- `updateProgress(job, { progress, stage, message, worker_id })` for periodic
  updates.
- `updateProgress(job, { status, progress })` / `transitionJob(job, status, …)`
  to move through the state machine. Illegal transitions are rejected (409).
- `setJobResult(job, { result, result_ref })` at completion.
- `addArtifact(job, { kind, name, filename, size, storage_ref })` for outputs.

Terminal transitions automatically evaluate dependent jobs and append history.

## 7. Managing job types

Administrators manage the registry at `/jobs/admin` (`iam.jobs.types`):

- **Create** a type with a unique `CODE`, name, source module, handler, queues,
  default priority, max retries, timeout and description.
- **Edit** name, module, handler, queues, priority, retries, timeout and
  description.
- **Enable/Disable** a type. Disabled types reject new submissions but existing
  jobs are unaffected.

Seeded types cover the standard business modules: `BULK_IMPORT`,
`CAD_PROCESSING`, `BOM_VALIDATION`, `REPORT_GENERATION`, `DATA_SYNC`,
`SEARCH_INDEXING`, `WORKFLOW_EXECUTION`, `INTEGRATION_SYNC`.

Business modules should register their own types (metadata + handler reference)
instead of submitting an untyped job.

## 8. Permissions

| Capability | Resource / action |
| --- | --- |
| List and submit jobs | `iam.jobs.list` `read` / `create` |
| View details, history, dependencies, children | `iam.jobs.details` `read` |
| Cancel / retry / pause / resume / progress / dependencies | `iam.jobs.control` `execute` |
| Read results and artifacts | `iam.jobs.results` `read` |
| Write results and artifacts | `iam.jobs.results` `create` |
| Manage job types | `iam.jobs.types` `read` / `create` / `update` |
| View metrics | `iam.jobs.monitoring` `read` |

`platform.admin` and `iam.admin` have full access. `app.reader` can submit,
watch and control jobs in its own tenant and read the registry and metrics, but
cannot create or edit job types. Platform admins can view across tenants with
`?all=true` (or the **All tenants** toggle).

## 9. Troubleshooting

| Symptom | Check |
| --- | --- |
| `400 Unknown job type` / `not active` | The type does not exist or is disabled; register/enable it under `/jobs/admin`. |
| `409 Invalid job status transition` | The engine attempted an illegal move; verify against the status model in the design doc. |
| Duplicate jobs created | The caller omitted `idempotency_key`; resubmits without a key are always new jobs. |
| Job stuck in `WAITING_FOR_DEPENDENCY` | A required dependency has not completed; inspect the **Dependencies** section. |
| Job stuck in `CANCEL_REQUESTED` | The engine has not yet acknowledged; it stops the job when it next reports in. |
| `404` on a job you can see elsewhere | The job belongs to another tenant; only platform admins may use `?all=true`. |
| Empty dashboard | No jobs yet, or you are scoped to a tenant with none; try **All tenants** as a platform admin. |

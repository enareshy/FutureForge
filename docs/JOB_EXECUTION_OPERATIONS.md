# Job Scheduling & Execution Engine Operations

Day-2 guide for operating the execution engine: running workers, tuning queues,
managing schedules, watching throughput, recovering failed work and handling
dead letters. Design and internals are in `docs/JOB_EXECUTION_DESIGN.md`; the
job registry/submission surface is in `docs/JOB_MANAGEMENT_OPERATIONS.md`.

## 1. Where to find it

| Page | Route | Audience |
| --- | --- | --- |
| Execution dashboard | `/jobs/execution` | operators |
| Worker monitoring | `/jobs/workers` | operators |
| Dead-letter management | `/jobs/dead-letter` | operators |
| Queue administration | `/jobs/queues` | administrators |
| Schedule administration | `/jobs/schedules` | administrators |

Platform admins can toggle **All tenants** on the dashboard, worker and
dead-letter pages.

## 2. Starting a worker

The API submits and tracks jobs; a worker process executes them. Run at least one
worker per environment:

```bash
# All queues, 4-way concurrency (default)
npm run worker

# Restrict to specific queues and raise concurrency
node scripts/job-worker.js --queues=IMPORT,REPORTING --concurrency=8

# Give the worker a stable name for monitoring
node scripts/job-worker.js --name=worker-eu-1
```

For a local demo of the engine itself (progress, retry, timeout, cancellation and
dead-letter flows) start the worker with the bundled simulation handlers:

```bash
node scripts/job-worker.js --demo
```

Supported flags: `--queues`, `--concurrency`, `--poll`, `--heartbeat`,
`--maintenance`, `--drain`, `--name`, `--id`, `--demo`. The same settings are
available as environment variables: `IAM_DB`, `JOB_WORKER_QUEUES`,
`JOB_WORKER_CONCURRENCY`, `JOB_WORKER_POLL_MS`, `JOB_WORKER_HEARTBEAT_MS`,
`JOB_WORKER_MAINTENANCE_MS`, `JOB_WORKER_DRAIN_MS`, `JOB_DEMO_HANDLERS`.

Workers shut down gracefully on `SIGINT`/`SIGTERM`: they stop claiming, heartbeat
`draining`, wait up to the drain budget for in-flight jobs, then deregister.

```bash
# Stop a worker cleanly (send SIGTERM, do not kill -9)
kill -TERM <worker-pid>
```

If no worker is running, submitted jobs stay queued and the **Worker monitoring**
page shows none registered. As a stopgap an operator with `iam.jobs.execution`
`execute` can drain ready work synchronously:

```bash
# Process up to 10 ready jobs in the API process
curl -s -X POST http://localhost:3001/api/job-execution/tick \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"run": true, "limit": 10}'

# Run every maintenance sweep (recovery, timeouts, dependencies, schedules)
curl -s -X POST http://localhost:3001/api/job-execution/maintenance \
  -H "Authorization: Bearer $TOKEN"
```

## 3. Monitoring execution

- **Execution dashboard** - active/running/queued/waiting counts, 24-hour
  completed/failed/retried totals, failure rate, average duration, utilisation,
  per-queue depth and saturation, dead-letter breakdown and recent configuration
  audit. Use **Run engine tick** / **Run maintenance** for a manual nudge.
- **Worker monitoring** - online/busy/idle workers, capacity, active jobs,
  utilisation, processed/failed totals, heartbeat age and the queues each worker
  serves. Turn on **Auto refresh** while investigating.
- **Queue health** - `GET /api/job-queues/{id}/health` reports status
  (`healthy`, `disabled`, `paused`, `saturated`, `rate_limited`, `degraded`),
  depth, available slots, rate usage and active workers.

```bash
# Engine status and metrics
curl -s "http://localhost:3001/api/job-execution/status"  -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3001/api/job-execution/metrics" -H "Authorization: Bearer $TOKEN"

# Registered workers and handlers
curl -s "http://localhost:3001/api/job-execution/workers"  -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3001/api/job-execution/handlers" -H "Authorization: Bearer $TOKEN"
```

## 4. Tuning queues

Administrators edit queue policy at `/jobs/queues` (`iam.jobs.queues`):

- **Priority** - higher runs first (subject to anti-starvation aging).
- **Max concurrency** - parallel jobs allowed for the queue.
- **Worker allocation** - informational target for worker placement.
- **Rate limit per minute** - cap on executions started per minute.
- **Retry policy** - max attempts, strategy (`none`/`fixed`/`exponential`) and
  base/max delay.
- **Timeout** - default timeout for jobs in the queue.
- **Enable/Disable** and **Pause/Resume** - disable rejects claiming entirely;
  pause temporarily stops new claims while the queue drains.

```bash
# Raise IMPORT concurrency and tighten its rate limit
curl -s -X PUT "http://localhost:3001/api/job-queues/IMPORT" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"max_concurrency": 4, "rate_limit_per_minute": 30}'

# Pause a queue during a downstream incident
curl -s -X POST "http://localhost:3001/api/job-queues/INTEGRATION/status" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"paused": true}'
```

Every change is recorded in the engine audit trail
(`GET /api/job-execution/audit`). Queue codes are `A-Z0-9_`; legacy business
queue names are still accepted and normalised onto the nine logical queues.

## 5. Managing schedules

Administrators manage recurring work at `/jobs/schedules`
(`iam.jobs.schedules`). A schedule defines a job type, cadence (`once`,
`interval`, `daily`, `weekly`, `monthly`, `cron`), an IANA time zone, optional
start/end dates and a maximum execution count, plus:

- **Failure policy** - `continue` (default), `pause` or `disable`. The engine
  only pauses/disables when the policy explicitly asks; schedules otherwise keep
  firing and record failures.
- **Concurrency policy** - `allow`, `skip`, `queue` or `cancel_previous`.
- **Catch-up policy** - `skip` (default), `run_once` or `run_all` for missed
  occurrences (for example while the engine was down).

Actions: **Enable/Disable**, **Pause/Resume**, **Run now** (fires an immediate
occurrence without moving the next scheduled time) and **Run history**
(`GET /api/schedules/{id}/runs`).

```bash
# Create a weekday 06:00 report in a specific time zone
curl -s -X POST "http://localhost:3001/api/schedules" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "code": "DAILY_COST_REPORT",
    "name": "Daily cost report",
    "job_type_code": "REPORT_GENERATION",
    "schedule_type": "weekly",
    "weekdays": [1,2,3,4,5],
    "daily_time": "06:00",
    "timezone": "Europe/London",
    "failure_policy": "pause"
  }'

# Fire it once now
curl -s -X POST "http://localhost:3001/api/schedules/DAILY_COST_REPORT/run-now" \
  -H "Authorization: Bearer $TOKEN"
```

Occurrences are materialised exactly once even with multiple workers, because
`job_schedule_runs` enforces `UNIQUE(schedule_id, scheduled_for)`.

## 6. Handling failures and timeouts

1. Find the failed job on the dashboard or `/jobs/list` and read its **Error &
   Result** panel and timeline.
2. Failures are classified so the engine applies the right retry:
   `temporary`, `infrastructure`, `external_provider`, `timeout` and `unknown`
   are retryable; `business_validation`, `authorization` and `cancelled` are
   **permanent** and are never auto-retried.
3. Retries use the queue strategy (`fixed` or `exponential` with a cap) unless the
   job or type overrides the attempt count. A `max_retries` of 0 on the job means
   "inherit the queue policy".
4. Timeouts are cooperative: the handler observes the deadline via its context
   and stops at the next checkpoint. If a worker dies mid-job, the expired lease
   is reclaimed on the next maintenance sweep and the job is retried while
   attempts remain.

Manual recovery:

```bash
# Re-queue a stopped job
curl -s -X POST "http://localhost:3001/api/jobs/$JOB/retry" -H "Authorization: Bearer $TOKEN"

# Run one specific job immediately through an API worker
curl -s -X POST "http://localhost:3001/api/job-execution/jobs/$JOB/execute" -H "Authorization: Bearer $TOKEN"
```

## 7. Dead-letter management

Jobs that exhaust retries or fail permanently with a non-retryable category land
in the dead-letter store. Operators manage them at `/jobs/dead-letter` or via the
API.

```bash
# List open dead letters, optionally by category or queue
curl -s "http://localhost:3001/api/job-execution/dead-letter?status=open&category=external_provider" \
  -H "Authorization: Bearer $TOKEN"

# Requeue (creates a fresh job attempt) with a resolution note
curl -s -X POST "http://localhost:3001/api/job-execution/dead-letter/$ID/retry" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"note": "provider recovered, retrying"}'

# Discard (record a terminal resolution without retrying)
curl -s -X POST "http://localhost:3001/api/job-execution/dead-letter/$ID/discard" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"note": "superseded by manual import"}'
```

Always requeue only after the underlying cause is fixed; a permanent
`business_validation` or `authorization` failure will simply fail again until the
input or permissions change.

## 8. Permissions

| Capability | Resource / action |
| --- | --- |
| Read queues / queue health | `iam.jobs.queues` `read` |
| Create / update / enable / pause queues | `iam.jobs.queues` `create` / `update` |
| Read schedules / runs | `iam.jobs.schedules` `read` |
| Create / update / enable / pause / resume schedules | `iam.jobs.schedules` `create` / `update` |
| Run a schedule now | `iam.jobs.schedules` `execute` |
| View execution status / metrics / workers / dead letters / audit | `iam.jobs.execution` `read` |
| Tick, maintain, run a job, retry/discard dead letters | `iam.jobs.execution` `execute` |

`platform.admin` and `iam.admin` receive full grants. `app.reader` receives the
execution `read` grants so operators can monitor workers and metrics, but queue
and schedule administration stays with administrators. All administrative
changes are audited.

## 9. Troubleshooting

| Symptom | Check |
| --- | --- |
| Jobs stay queued, worker page is empty | No worker process is running; start `npm run worker`. |
| Worker shows `offline` | The process stopped heartbeating; restart it. Its running jobs were reclaimed when the lease expired. |
| `No handler registered for job type X` | The owning module did not `registerHandler` for the type's handler code; register it on the worker. |
| Queue `saturated` | All concurrency slots are busy; wait, raise `max_concurrency` or add workers. |
| Queue `rate_limited` | The queue hit its per-minute cap; wait for the window to roll or raise the limit. |
| Queue `degraded` | The oldest queued job is older than 15 minutes; add workers or rebalance queues. |
| Job repeatedly retries then dead-letters | Check the error category; retryable failures exhaust `max_retries`, permanent ones never retry. |
| Job stuck in `cancel_requested` | The handler has not reached a cancellation checkpoint; the engine finalises it at timeout or lease recovery. |
| Schedule did not fire | Check `enabled`/status, `start_at`/`end_at`, `max_executions` and `next_run_at`; missed windows obey `catchup_policy`. |
| Schedule fired twice | Occurrences are unique per `scheduled_for`; verify no external system submits the same job type directly. |
| `SQLITE_BUSY` under load | Set a higher `busy_timeout` or run workers against the shared database over WAL (already enabled). |

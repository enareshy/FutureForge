# Job Scheduling & Execution Engine Design

The Job Scheduling & Execution Engine is the platform's centralized execution
infrastructure. It turns the durable job records owned by the Background Job
Management module into actually-executed work: it owns logical queues, worker
pools, scheduling and recurrence, dependency release, retries/backoff, timeouts,
cooperative cancellation, concurrency, distributed locking, dead-letter handling,
metrics and health.

The engine contains **no business logic**. A business module registers a handler
for its job type and submits jobs through the Job Management module; the engine
resolves the job type to its handler and invokes it with a cancellation-aware
execution context.

```
  business modules                Job Management                 Execution Engine
+-----------------+     +--------------------------+     +---------------------------+
| registerHandler |     |  jobs / job_types         |     |  queues + policies        |
| submitJob  ---->|---->|  job_history / deps       |<--->|  workers + leases         |
+-----------------+     |  job_artifacts            |     |  schedules + recurrence   |
                        +--------------------------+     |  retry / timeout / cancel |
                                                         |  dead-letter / metrics    |
                                                         |  distributed locks        |
                                                         +---------------------------+
                                                                    |
                                                         +---------------------------+
                                                         |  handler(context)         |
                                                         |   checkCancelled / step / |
                                                         |   reportProgress / lock   |
                                                         +---------------------------+
```

## 1. Layers

Everything lives under `server/services/job-execution/` with a single facade at
`server/services/job-execution.js` (also re-exported through
`server/platform.js`).

| File | Responsibility |
| --- | --- |
| `validation.js` | Vocabulary and input normalisation: the nine logical queues, aliases, enums (schedule types/statuses, retry strategies, failure/concurrency/catchup policies, worker/dead-letter statuses), queue and schedule validators. |
| `timezone.js` | IANA time-zone math and SQL-time helpers used by recurrence and leases. |
| `cron.js` | Cron parser/next-occurrence calculation (no external dependency). |
| `recurrence.js` | Next/last run computation for `once`, `interval`, `daily`, `weekly`, `monthly` and `cron` schedules. |
| `errors.js` | Error taxonomy (`temporary`, `infrastructure`, `external_provider`, `timeout`, `business_validation`, `authorization`, `cancelled`, `unknown`), `JobError`/`JobTimeoutError`/`JobCancelledError`, classification helpers. |
| `retry.js` | Effective retry limit, delay computation (fixed/exponential with cap) and the retry decision. |
| `queues.js` | Queue administration, load accounting, health and the anti-starvation claim ordering. |
| `locks.js` | Durable distributed locks with TTL and expiry purge. |
| `signals.js` | In-process cancellation signals (cooperative cancellation / timeout notification). |
| `handlers.js` | Handler registry, `handlerKeyForJob` resolution, and the rich `createJobContext` execution context. |
| `audit.js` | Engine configuration audit trail (`job_engine_audit`). |
| `worker-registry.js` | Worker registration, heartbeat, listing and stale-worker reaping. |
| `engine.js` | The execution core: claim/lease, `executeClaimedJob`, retries, timeouts, cancellation, dependency promotion, stale/timeout recovery, `processOnce`, `tick`, `engineStatus`. |
| `deadletter.js` | Dead-letter listing, requeue and discard. |
| `schedules.js` | Schedule CRUD, next-run materialisation, catch-up/concurrency/failure policies and run reconciliation. |
| `worker.js` | The long-running `EngineWorker` loop with graceful shutdown. |
| `metrics.js` | Execution metrics, queue utilisation, worker summary, dead-letter breakdown and engine leader. |
| `demo-handlers.js` | Simulation handlers used only by tests/dev demos; never required in production. |

## 2. Data model

The engine adds its own tables and augments the shared `jobs` table.

| Table | Purpose |
| --- | --- |
| `job_queues` | Logical queue policy: `priority`, `max_concurrency`, `worker_allocation`, `rate_limit_per_minute`, retry policy (`retry_max_attempts`, `retry_strategy`, delays), `timeout_seconds`, `enabled`, `paused`, `is_system`, `last_claimed_at`, `config_json`. |
| `job_workers` | Registered workers: `name`, `hostname`, `pid`, `concurrency`, `queues_json`, `status`, `active_jobs`, processed/failed counters, `last_heartbeat`, `started_at`, `stopped_at`. |
| `job_schedules` | Recurring definitions: cadence fields, `timezone`, `start_at`/`end_at`, `max_executions`, retry/timeout overrides, `failure_policy`, `concurrency_policy`, `catchup_policy`, `payload_json`, status/enabled, `next_run_at`, `last_run_at`, execution/failure counters. |
| `job_schedule_runs` | Materialised occurrences with `UNIQUE(schedule_id, scheduled_for)` to guarantee exactly-once materialisation; links the schedule to the created `job_id`. |
| `job_executions` | Per-attempt execution facts used by metrics: worker, queue, attempt, status, `started_at`/`finished_at`, `duration_ms`, error category. |
| `job_dead_letters` | Exhausted/permanent failures: reason, category, attempts, error, payload snapshot, status (`open`/`requeued`/`discarded`) and resolution metadata. |
| `job_locks` | Distributed locks (name, owner, purpose, `expires_at`). |
| `job_engine_audit` | Append-only configuration audit: entity, action, actor, before/after detail, IP. |

`jobs` gains engine columns: `execution_group`, `schedule_id`, `attempts`,
`lease_owner`, `lease_expires_at`, `heartbeat_at`, `next_retry_at`,
`dead_lettered_at`, plus indexes `idx_jobs_lease`, `idx_jobs_heartbeat`,
`idx_jobs_schedule`. Migration `016_job_engine` adds these idempotently; the
shared-table lookup indexes are created in `db.js` **after** the columns are
ensured, so an existing database upgrades cleanly.

## 3. Logical queues and policy

Nine system queues are seeded by `ensureDefaultQueues`:

`DEFAULT, HIGH_PRIORITY, IMPORT, CAD_PROCESSING, REPORTING, INTEGRATION,
SEARCH_INDEXING, WORKFLOW, MAINTENANCE`

Each owns its concurrency, rate limit, retry policy and timeout (for example
`HIGH_PRIORITY` priority 100 / concurrency 4 / 300 per minute / timeout 300s;
`MAINTENANCE` priority 20 / concurrency 1 / 12 per minute). Job types reference
queues by code and legacy/business codes are normalised through
`canonicalQueue` aliases (`bulk -> IMPORT`, `cad -> CAD_PROCESSING`,
`sync -> INTEGRATION`, ...) so pre-existing types keep working without a data
migration.

**Anti-starvation.** `orderQueuesForClaim` visits queues by
`priority + aging_bonus`, where the aging bonus is `min(60, idle_seconds / 10)`.
A saturated high-priority queue therefore cannot indefinitely starve lower
priority work. A worker restricted to specific queues canonicalises and
intersects the restriction.

Queue health (`queueHealth`) reports `healthy`, `disabled`, `paused`,
`saturated` (running >= capacity), `rate_limited` (executions in the last minute
at the limit) or `degraded` (depth with the oldest job older than 15 minutes).

## 4. Worker lifecycle, leases and duplicate prevention

- **Worker engine** (`EngineWorker`): registers in `job_workers`, heartbeats on
  an interval with `status` (`idle`/`busy`/`draining`), and runs a poll loop. Its
  concurrency caps in-flight jobs; workers restricted to `queues` never claim
  outside them.
- **Claiming** (`claimJob`): selects the next ready job in priority/aging order
  and performs a conditional `UPDATE ... WHERE id = ? AND status = ? AND
  (lease_owner = '' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`. The
  guard is atomic, so two workers can never claim the same job.
- **Leases**: each claim sets `lease_owner`, `lease_expires_at` and
  `heartbeat_at`. The lease window is at least `DEFAULT_LEASE_SECONDS` (120s) and
  extends to `timeout + 60s` when a timeout is configured. A lease heartbeat
  renews the lease while the job runs.
- **Recovery**: `recoverStaleJobs` reclaims jobs whose lease expired (worker
  crash/restart), retrying them while attempts remain and dead-lettering
  otherwise. `reapStaleWorkers` marks silent workers `offline`.
- **Graceful shutdown**: `worker.stop({ timeoutMs })` stops claiming, heartbeats
  `draining`, waits for in-flight jobs up to the drain budget, marks the worker
  `stopped` and closes cleanly on `SIGINT`/`SIGTERM` (see
  `scripts/job-worker.js`).

## 5. Scheduling and recurrence

`job_schedules` supports `once`, `interval`, `daily`, `weekly`, `monthly` and
`cron`, each with an IANA `timezone`, optional `start_at`/`end_at`,
`max_executions` and per-schedule retry/timeout overrides. `computeNextRun`
advances `next_run_at`; the last run, execution count and failure count are
stored on the schedule.

`sweepSchedules` (run by workers and maintenance) materialises due occurrences
under the scheduler lock:

- **Exactly-once materialisation**: `job_schedule_runs` has a
  `UNIQUE(schedule_id, scheduled_for)` constraint and insertions use
  `INSERT OR IGNORE`, so concurrent schedulers cannot double-fire.
- **Catch-up** (`catchup_policy`): `skip` (default) drops missed occurrences,
  `run_once` fires one makeup run, `run_all` materialises every missed
  occurrence.
- **Concurrency** (`concurrency_policy`): `allow`, `skip` (skip while a previous
  run is active), `queue`, `cancel_previous`.
- **Failure** (`failure_policy`): `continue` (default), `pause` or `disable`
  after consecutive failures. The engine **never auto-disables a schedule unless
  the policy explicitly says so**.
- **Run now/manual**: `runScheduleNow` materialises an immediate occurrence and
  submits the job without disturbing `next_run_at`.

Materialised occurrences create a job instance, apply the schedule's
tenant/security context, enqueue it, append history and update the run row.
`reconcileScheduleRuns` reconciles run rows with their job's terminal status and
applies the failure policy.

## 6. Dependencies

The engine promotes dependency-gated jobs:

- `promoteReadyJobs` releases jobs in `WAITING_FOR_DEPENDENCY` to `QUEUED` (or
  `SCHEDULED`) once all required dependencies complete, and fails them with
  `error_code = dependency_failed` when a required dependency fails, times out
  or is cancelled.
- Dependents stay `WAITING_FOR_DEPENDENCY` until the promotion sweep runs; the
  sweep is idempotent and safe to run frequently.
- Cancellation propagates to children when requested with `propagate: true`.

Circular-dependency detection and edge management are owned by the Job
Management module; the engine only evaluates terminal state.

## 7. Retry policy and error taxonomy

The queue owns the retry strategy; the job/type owns the maximum attempts (a
job-level `max_retries` of `0` means "inherit the queue policy").

- `computeRetryDelay`: `none` -> no retry; `fixed` -> `retry_delay_seconds`;
  `exponential` -> `base * 2^(attempt-1)` capped at `retry_max_delay_seconds`.
  A provider `retryAfterSeconds` is honoured via `max(delay, retryAfter)`.
- `decideRetry` returns `retry_disabled`, `retries_exhausted` or
  `permanent_failure` for non-retryable categories.
- **Permanent categories** (`business_validation`, `authorization`,
  `cancelled`) are **never retried automatically**; a permanent failure goes
  straight to the dead-letter store.
- Manual retry is available via `POST /api/jobs/{id}/retry` and
  `requestManualRetry`; dead-letter requeue is available via
  `POST /api/job-execution/dead-letter/{id}/retry`.

A classified failure is recorded on `job_executions` and, when exhausted or
permanent, written to `job_dead_letters` with the category, attempts, error and
a payload snapshot.

## 8. Timeout and cancellation

- **Timeouts** resolve from job override -> `job_types.timeout_seconds` ->
  queue `timeout_seconds` (`resolveEffectiveTimeout`). The engine tracks a
  deadline, `reapTimedOutJobs` finalises overdue jobs, and within a running
  handler `context.checkCancelled()` throws `JobTimeoutError` at the deadline.
- **Cooperative, never force-killed**: handlers poll
  `context.checkCancelled()`; when a cancellation is requested the engine
  signals the process and finalises the durable record. Handlers that respect the
  context stop promptly; the engine never terminates a handler thread.
- `requestCancellation` sets `cancel_requested` (or `cancelled` when the job has
  not started), records the reason and optionally propagates to children.
  `requestManualRetry` re-queues a stopped job.

## 9. Progress reporting

Handlers call `context.reportProgress({ progress, stage, message, processed,
total, failed, skipped, eta_seconds })` and `context.step(name, ...)`. Writes are
throttled (`progressIntervalMs`, default 800ms, forced on stage change or
completion) and persisted through the Job Management module's `updateProgress`
so the timeline and dashboard stay consistent.

## 10. Reliability

- **Durable queue** - all state is in SQLite (WAL) with a `busy_timeout`, so
  jobs survive API/worker restarts and multiple processes coordinate safely.
- **Idempotency** - submission idempotency and schedule-occurrence uniqueness
  are both enforced at the database level.
- **Duplicate-execution prevention** - atomic lease-guarded claims plus
  `UNIQUE(schedule_id, scheduled_for)`.
- **Distributed locking** - `job_locks` guards the scheduler (`engine:scheduler`)
  and is exposed to handlers via `context.lock(name, ttl, fn)`; expired locks are
  purged.
- **Health and observability** - structured JSON logs with `job_id`,
  `job_ref`, `correlation_id`, `worker`; `engineStatus`/`executionMetrics`
  expose depth, utilisation, throughput, retries and dead-letter pressure;
  queue health, worker health and the engine leader are all queryable.
- **Dead-letter** - exhausted/permanent failures are durable, classified, can be
  requeued (creating a fresh job) or discarded with a resolution note.

## 11. Security

- Every queue, schedule, worker, dead-letter and audit read is tenant-scoped
  through `execScope(req)`; only platform admins may request `?all=true`.
  `getSchedule` returns 404 for another tenant's schedule so existence is not
  leaked.
- Administrative operations require the engine RBAC resources
  (`iam.jobs.queues`, `iam.jobs.schedules`, `iam.jobs.execution`); all queue and
  schedule configuration changes are written to `job_engine_audit` with actor,
  IP and before/after detail.
- Payloads and execution context are snapshotted only where necessary
  (dead-letter payload, schedule payload) and secrets are never logged.

## 12. REST API

Queue administration (`iam.jobs.queues`):

- `GET /api/job-queues/meta` - logical queues, strategies and enums.
- `GET /api/job-queues` - list with load/utilisation (`q`, `enabled`, `paused`,
  `sort`, `order`, paging).
- `POST /api/job-queues`, `PUT|PATCH /api/job-queues/{id}` - create/update.
- `POST /api/job-queues/{id}/status` - `{ enabled }` or `{ paused }`.
- `GET /api/job-queues/{id}`, `GET /api/job-queues/{id}/health`.

Schedule administration (`iam.jobs.schedules`):

- `GET /api/schedules`, `POST /api/schedules`, `GET /api/schedules/{id}`,
  `PUT|PATCH /api/schedules/{id}`.
- `POST /api/schedules/{id}/enable|disable|pause|resume`, `POST
  /api/schedules/{id}/run-now` (`execute`), `GET /api/schedules/{id}/runs`.

Execution observability and control (`iam.jobs.execution`):

- `GET /api/job-execution/status`, `/metrics`, `/workers`, `/handlers`,
  `/dead-letter`, `/audit`.
- `POST /api/job-execution/dead-letter/{id}/retry|discard`.
- `POST /api/job-execution/jobs/{id}/execute` - run one job now (manual drain).
- `POST /api/job-execution/tick` - process ready work (`run`, `limit`, `queues`).
- `POST /api/job-execution/maintenance` - run recovery/maintenance sweeps.

## 13. Frontend

- **Queue administration** (`/jobs/queues`) - queue policy list, create/edit,
  enable/disable/pause/resume and a health panel.
- **Schedule administration** (`/jobs/schedules`) - recurring definitions,
  cadence display, create/edit, enable/disable/pause/resume, run-now and run
  history.
- **Worker monitoring** (`/jobs/workers`) - worker cards, per-worker capacity,
  utilisation, processed/failed totals, heartbeat age and queue assignment.
- **Execution dashboard** (`/jobs/execution`) - throughput/utilisation cards,
  per-queue depth and saturation, recent engine audit, dead-letter breakdown and
  tick/maintenance actions.
- **Dead-letter management** (`/jobs/dead-letter`) - filter by status/category
  and requeue or discard with a resolution note.

Shared badge/format helpers live in `web/src/components/JobEngineBadges.jsx`;
the client namespace is `web/src/api.js → jobExecution`. Queue and schedule
administration is restricted to platform admins/administrators (`platformOrAdmin`
nav flag).

## 14. Running workers

Workers run as separate processes against the same database:

```bash
# All queues, 4-way concurrency
npm run worker

# Restrict queues and raise concurrency
node scripts/job-worker.js --queues=IMPORT,REPORTING --concurrency=8

# Local demo with the bundled simulation handlers
node scripts/job-worker.js --demo
```

Configuration is also available through `IAM_DB`, `JOB_WORKER_QUEUES`,
`JOB_WORKER_CONCURRENCY`, `JOB_WORKER_POLL_MS`, `JOB_WORKER_HEARTBEAT_MS`,
`JOB_WORKER_MAINTENANCE_MS` and `JOB_WORKER_DRAIN_MS`. Production deployments
register their real handlers and leave `JOB_DEMO_HANDLERS` unset.

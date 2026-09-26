import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, queryAll, run } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as j from "../services/jobs.js";
import * as e from "../services/job-execution.js";

const TEST_TYPES = [
  { code: "ENGINE_SUCCESS", max_retries: 0, timeout_seconds: 0, queues: ["default"] },
  { code: "ENGINE_TEMP", max_retries: 1, timeout_seconds: 0, queues: ["default"] },
  { code: "ENGINE_PERM", max_retries: 3, timeout_seconds: 0, queues: ["default"] },
  { code: "ENGINE_SLOW", max_retries: 0, timeout_seconds: 1, queues: ["default"] },
  { code: "ENGINE_CANCEL", max_retries: 0, timeout_seconds: 0, queues: ["default"] },
  { code: "ENGINE_FLAKY", max_retries: 2, timeout_seconds: 0, queues: ["default"] },
];

describe("job scheduling & execution engine", () => {
  let db;
  let tenantId;
  let admin;
  const flakyAttempts = new Map();

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    admin = queryOne(db, "SELECT * FROM users WHERE username = 'admin'");

    for (const type of TEST_TYPES) {
      j.createJobType(db, { ...type, name: type.code, source_module: "test" }, admin);
    }

    e.registerHandler("ENGINE_SUCCESS", (context) => {
      context.reportProgress({ progress: 50, stage: "half" });
      context.step("finalize", { message: "wrapping up" });
      return {
        message: "done",
        result: { ok: true },
        artifacts: [{ kind: "output", name: "out.json", filename: "out.json", content_type: "application/json", size: 12 }],
        last_step: "finalize",
      };
    });
    e.registerHandler("ENGINE_TEMP", () => {
      throw new e.JobError("temporary glitch", { category: "temporary", code: "glitch" });
    });
    e.registerHandler("ENGINE_PERM", () => {
      throw new e.JobError("invalid payload", { category: "business_validation", code: "invalid_payload" });
    });
    e.registerHandler("ENGINE_SLOW", (context) =>
      new Promise((resolve) => {
        let check;
        const timer = setTimeout(() => {
          if (check) clearInterval(check);
          resolve({ message: "late finish" });
        }, 1500);
        check = setInterval(() => {
          if (context.signal.cancelled) {
            clearInterval(check);
            clearTimeout(timer);
            resolve({ message: "stopped" });
          }
        }, 15);
      })
    );
    e.registerHandler("ENGINE_CANCEL", async (context) => {
      for (let i = 0; i < 400; i += 1) {
        context.checkCancelled();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { message: "finished anyway" };
    });
    e.registerHandler("ENGINE_FLAKY", (context) => {
      const attempt = (flakyAttempts.get(context.job_id) || 0) + 1;
      flakyAttempts.set(context.job_id, attempt);
      if (attempt < 2) throw new e.JobError("infrastructure wobble", { category: "infrastructure", code: "wobble" });
      return { message: "recovered" };
    });
  });

  after(() => {
    e.unregisterHandler("ENGINE_SUCCESS");
    e.unregisterHandler("ENGINE_TEMP");
    e.unregisterHandler("ENGINE_PERM");
    e.unregisterHandler("ENGINE_SLOW");
    e.unregisterHandler("ENGINE_CANCEL");
    e.unregisterHandler("ENGINE_FLAKY");
    db?.close();
  });

  const submit = (code, extra = {}) =>
    j.submitJob(db, { job_type_code: code, name: `${code} run`, tenant_id: tenantId, ...extra }, { actor: admin });

  describe("queue registry", () => {
    test("seeds exactly the nine required logical queues", () => {
      const queues = e.listQueues(db, { pageSize: 100 }).items;
      const codes = queues.map((queue) => queue.code).sort();
      assert.deepEqual(codes, [...e.LOGICAL_QUEUES].sort());
      const high = queues.find((queue) => queue.code === "HIGH_PRIORITY");
      assert.equal(high.priority, 100);
      assert.equal(high.enabled, true);
    });

    test("normalises historical business queue codes onto logical queues", () => {
      assert.equal(e.canonicalQueue("imports"), "IMPORT");
      assert.equal(e.canonicalQueue("reports"), "REPORTING");
      assert.equal(e.canonicalQueue("math"), "DEFAULT");
      assert.equal(e.canonicalQueue("unknown-queue"), "DEFAULT");
      assert.equal(e.canonicalQueue("HIGH_PRIORITY"), "HIGH_PRIORITY");
    });

    test("creates, updates and toggles a custom queue", () => {
      const created = e.createQueue(
        db,
        { code: "ENGINE_TEST", name: "Engine test", priority: 77, max_concurrency: 1, retry_strategy: "fixed", retry_delay_seconds: 5 },
        admin
      );
      assert.equal(created.code, "ENGINE_TEST");
      assert.equal(created.priority, 77);
      assert.equal(created.retry_strategy, "fixed");
      assert.throws(() => e.createQueue(db, { code: "ENGINE_TEST", name: "dup" }, admin), /already exists/);
      assert.throws(() => e.createQueue(db, { code: "bad code" }, admin), /must start with a letter/);

      const updated = e.updateQueue(db, "ENGINE_TEST", { name: "Renamed", max_concurrency: 3 }, admin);
      assert.equal(updated.name, "Renamed");
      assert.equal(updated.max_concurrency, 3);

      const disabled = e.setQueueEnabled(db, "ENGINE_TEST", false, admin);
      assert.equal(disabled.enabled, false);
      const health = e.queueHealth(db, "ENGINE_TEST");
      assert.equal(health.status, "disabled");
      assert.equal(health.capacity, 3);
    });

    test("orders queues by priority and caps the aging bonus", () => {
      const { scored } = e.orderQueuesForClaim(db, ["MAINTENANCE", "HIGH_PRIORITY"]);
      assert.equal(scored[0].policy.code, "HIGH_PRIORITY");
      assert.equal(scored[1].policy.code, "MAINTENANCE");
      for (const entry of scored) assert.ok(entry.aging_bonus <= 60);
    });
  });

  describe("retry policy", () => {
    test("retries transient failures and never retries business validation", () => {
      const queue = e.resolveQueuePolicy(db, "DEFAULT");
      const transient = e.resolveQueuePolicy(db, "DEFAULT");
      const job = { max_retries: 0, retry_count: 0 };
      const retry = e.decideRetry({
        job,
        queue: { ...transient, retry_strategy: "exponential", retry_delay_seconds: 10, retry_max_delay_seconds: 100 },
        classification: { category: "temporary", retryable: true },
      });
      assert.equal(retry.retry, true);
      assert.equal(retry.delay_seconds, 10);
      assert.equal(retry.next_retry_count, 1);

      const permanent = e.decideRetry({
        job: { max_retries: 5, retry_count: 0 },
        queue,
        classification: { category: "business_validation", retryable: false },
      });
      assert.equal(permanent.retry, false);
      assert.equal(permanent.reason, "permanent_failure");
    });

    test("classifies errors into the engine taxonomy", () => {
      assert.equal(e.classifyError(new e.JobTimeoutError("slow")).category, "timeout");
      assert.equal(e.classifyError(new e.JobCancelledError()).category, "cancelled");
      assert.equal(e.classifyError(new e.JobError("x", { category: "authorization" })).category, "authorization");
      assert.equal(e.isRetryableCategory("temporary"), true);
      assert.equal(e.isRetryableCategory("authorization"), false);
    });
  });

  describe("recurrence", () => {
    test("computes next runs for interval, daily, weekly, monthly and cron", () => {
      const from = new Date("2026-01-05T00:00:00Z");
      const iso = (schedule) => e.computeNextRun(schedule, from)?.toISOString();
      assert.equal(iso({ schedule_type: "interval", interval_seconds: 3600, start_at: "2026-01-01 00:00:00", timezone: "UTC" }), "2026-01-05T01:00:00.000Z");
      assert.equal(iso({ schedule_type: "daily", daily_time: "06:00", timezone: "UTC" }), "2026-01-05T06:00:00.000Z");
      assert.equal(iso({ schedule_type: "weekly", weekdays_json: "[1]", daily_time: "08:00", timezone: "UTC" }), "2026-01-05T08:00:00.000Z");
      assert.equal(iso({ schedule_type: "monthly", day_of_month: 10, daily_time: "09:00", timezone: "UTC" }), "2026-01-10T09:00:00.000Z");
      assert.equal(iso({ schedule_type: "cron", cron_expression: "*/15 * * * *", timezone: "UTC" }), "2026-01-05T00:15:00.000Z");
    });

    test("describes a schedule in human terms", () => {
      assert.match(e.describeSchedule({ schedule_type: "cron", cron_expression: "0 2 * * *", timezone: "UTC" }), /cron/i);
      assert.match(e.describeSchedule({ schedule_type: "interval", interval_seconds: 60, timezone: "UTC" }), /every/i);
    });
  });

  describe("distributed locks", () => {
    test("grants a lock to a single owner and releases it", () => {
      assert.equal(e.acquireLock(db, "engine:test", "owner-a", { ttlSeconds: 30 }), true);
      assert.equal(e.acquireLock(db, "engine:test", "owner-b", { ttlSeconds: 30 }), false);
      assert.equal(e.acquireLock(db, "engine:test", "owner-a", { ttlSeconds: 30 }), true);
      assert.equal(e.getLock(db, "engine:test").owner, "owner-a");
      assert.equal(e.releaseLock(db, "engine:test", "owner-a"), true);
      assert.equal(e.acquireLock(db, "engine:test", "owner-b", { ttlSeconds: 30 }), true);
    });
  });

  describe("claiming and execution", () => {
    test("executes a successful job and records the execution", async () => {
      const job = submit("ENGINE_SUCCESS");
      const outcome = await e.runJobNow(db, job.id);
      assert.equal(outcome.status, "completed");

      const row = j.getJobRow(db, job.id);
      assert.equal(row.status, "completed");
      assert.equal(row.attempts, 1);
      assert.equal(row.progress, 100);

      const execution = queryOne(db, "SELECT * FROM job_executions WHERE job_id = ? ORDER BY id DESC LIMIT 1", [job.id]);
      assert.equal(execution.status, "completed");
      assert.ok(execution.duration_ms >= 0);
      assert.ok(queryAll(db, "SELECT * FROM job_artifacts WHERE job_id = ?", [job.id]).length >= 1);
    });

    test("rejects claiming a job that is already running", async () => {
      const job = submit("ENGINE_CANCEL");
      const pending = e.runJobNow(db, job.id);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await assert.rejects(() => e.runJobNow(db, job.id), /cannot be claimed/);
      await e.requestCancellation(db, job.id, { reason: "test cleanup", actor: admin });
      await pending;
    });

    test("retries transient failures then dead-letters once exhausted", async () => {
      const job = submit("ENGINE_TEMP");
      const first = await e.runJobNow(db, job.id);
      assert.equal(first.status, "retrying");
      let row = j.getJobRow(db, job.id);
      assert.equal(row.retry_count, 1);
      assert.ok(row.next_retry_at);

      const second = await e.runJobNow(db, job.id);
      assert.equal(second.status, "failed");
      row = j.getJobRow(db, job.id);
      assert.equal(row.status, "failed");

      const letters = e.listDeadLetters(db, { pageSize: 50 }).items;
      const letter = letters.find((item) => item.job_id === job.id);
      assert.ok(letter);
      assert.equal(letter.category, "temporary");
      assert.equal(letter.status, "open");
    });

    test("dead-letters permanent failures without retrying", async () => {
      const job = submit("ENGINE_PERM");
      const outcome = await e.runJobNow(db, job.id);
      assert.equal(outcome.status, "failed");
      const row = j.getJobRow(db, job.id);
      assert.equal(row.retry_count, 0);

      const letter = e.listDeadLetters(db, { pageSize: 50 }).items.find((item) => item.job_id === job.id);
      assert.ok(letter);
      assert.equal(letter.category, "business_validation");

      const requeued = e.requeueDeadLetter(db, letter.id, { actor: admin, note: "fixed input" });
      assert.equal(requeued.requeued, true);
      assert.equal(requeued.dead_letter.status, "requeued");
      assert.equal(j.getJobRow(db, job.id).status, "queued");

      const other = submit("ENGINE_PERM");
      await e.runJobNow(db, other.id);
      const otherLetter = e.listDeadLetters(db, { pageSize: 50 }).items.find((item) => item.job_id === other.id);
      const discarded = e.discardDeadLetter(db, otherLetter.id, { actor: admin, note: "not needed" });
      assert.equal(discarded.discarded, true);
      assert.equal(e.listDeadLetters(db, { status: "open", pageSize: 100 }).items.some((item) => item.job_id === other.id), false);
    });

    test("times out a slow job and schedules a retry", async () => {
      const job = submit("ENGINE_SLOW");
      const outcome = await e.runJobNow(db, job.id);
      assert.equal(outcome.status, "retrying");
      const row = j.getJobRow(db, job.id);
      assert.equal(row.timeout_seconds, 1);

      const history = j.listHistory(db, job.id, { pageSize: 50 }).items;
      assert.ok(history.some((event) => event.event_type === "timeout"));
    });

    test("recovers a flaky job on the second attempt", async () => {
      const job = submit("ENGINE_FLAKY");
      const first = await e.runJobNow(db, job.id);
      assert.equal(first.status, "retrying");
      const second = await e.runJobNow(db, job.id);
      assert.equal(second.status, "completed");
      assert.equal(j.getJobRow(db, job.id).status, "completed");
    });

    test("cooperatively cancels a running job", async () => {
      const job = submit("ENGINE_CANCEL");
      const pending = e.runJobNow(db, job.id);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const requested = e.requestCancellation(db, job.id, { reason: "user changed their mind", actor: admin });
      assert.equal(requested.job.status, "cancel_requested");
      const outcome = await pending;
      assert.equal(outcome.status, "cancelled");
      const row = j.getJobRow(db, job.id);
      assert.equal(row.status, "cancelled");
      assert.match(row.cancel_reason, /changed their mind/);
    });

    test("recovers stale leases from crashed workers", async () => {
      const job = submit("ENGINE_SUCCESS");
      const claim = e.claimJob(db, { workerId: "crashed-worker", queueCodes: ["DEFAULT"] });
      assert.ok(claim);
      run(db, "UPDATE jobs SET lease_expires_at = datetime('now', '-10 minutes'), heartbeat_at = datetime('now', '-10 minutes') WHERE id = ?", [claim.job.id]);
      const summary = e.recoverStaleJobs(db);
      assert.ok(summary.recovered + summary.failed >= 1);
      const row = j.getJobRow(db, claim.job.id);
      assert.ok(["queued", "retrying"].includes(row.status));
      assert.equal(row.lease_owner, "");
      assert.ok(job.id);
    });

    test("processOnce claims and completes queued work in a queue scope", async () => {
      const job = submit("ENGINE_SUCCESS", { queue: "maintenance" });
      const summary = await e.processOnce(db, { workerId: "test-tick", limit: 1, queueCodes: ["MAINTENANCE"] });
      assert.equal(summary.claimed, 1);
      assert.equal(summary.completed, 1);
      assert.equal(j.getJobRow(db, job.id).status, "completed");
    });

    test("promotes ready jobs and blocks dependents of failed parents", () => {
      const solo = submit("ENGINE_SUCCESS", { idempotency_key: "engine-promote-solo" });
      run(db, "UPDATE jobs SET status = 'created' WHERE id = ?", [solo.id]);
      const summary = e.promoteReadyJobs(db);
      assert.ok(summary.promoted >= 1);
      assert.equal(j.getJobRow(db, solo.id).status, "queued");

      const parent = submit("ENGINE_SUCCESS", { idempotency_key: "engine-dep-parent" });
      const child = submit("ENGINE_SUCCESS", { idempotency_key: "engine-dep-child", dependencies: [parent.id] });
      assert.equal(j.getJobRow(db, child.id).status, "waiting_for_dependency");

      j.transitionJob(db, parent.id, "running", { source: "engine" });
      j.transitionJob(db, parent.id, "completed", { source: "engine" });
      e.promoteReadyJobs(db);
      assert.equal(j.getJobRow(db, child.id).status, "queued");
    });
  });

  describe("schedules", () => {
    test("creates schedules with computed next runs and validates cadence", () => {
      const cron = e.createSchedule(
        db,
        { code: "ENGINE_CRON", name: "Cron schedule", job_type_code: "ENGINE_SUCCESS", schedule_type: "cron", cron_expression: "0 3 * * *", timezone: "UTC" },
        admin
      );
      assert.equal(cron.schedule_type, "cron");
      assert.ok(cron.next_run_at);
      assert.equal(cron.status, "active");

      const interval = e.createSchedule(
        db,
        { code: "ENGINE_INTERVAL", job_type_code: "ENGINE_SUCCESS", schedule_type: "interval", interval_seconds: 300 },
        admin
      );
      assert.equal(interval.interval_seconds, 300);

      assert.throws(() => e.createSchedule(db, { code: "ENGINE_BAD1", job_type_code: "ENGINE_SUCCESS", schedule_type: "interval", interval_seconds: 0 }, admin), /greater than zero/);
      assert.throws(() => e.createSchedule(db, { code: "ENGINE_BAD2", job_type_code: "ENGINE_SUCCESS", schedule_type: "cron" }, admin), /cron_expression is required/);
      assert.throws(() => e.createSchedule(db, { code: "ENGINE_BAD3", job_type_code: "ENGINE_SUCCESS", schedule_type: "weekly" }, admin), /weekdays is required/);
      assert.throws(() => e.createSchedule(db, { code: "ENGINE_BAD4", job_type_code: "ENGINE_SUCCESS", timezone: "Mars/Olympus" }, admin), /not a recognised IANA time zone/);
    });

    test("sweeps due schedules exactly once", () => {
      const schedule = e.createSchedule(
        db,
        { code: "ENGINE_SWEEP", job_type_code: "ENGINE_SUCCESS", schedule_type: "interval", interval_seconds: 3600 },
        admin
      );
      run(db, "UPDATE job_schedules SET next_run_at = datetime('now', '-2 minutes') WHERE id = ?", [schedule.id]);
      const first = e.sweepSchedules(db);
      assert.equal(first.locked, true);
      assert.equal(first.due, 1);
      assert.equal(first.enqueued, 1);

      const jobs = queryAll(db, "SELECT * FROM jobs WHERE schedule_id = ?", [schedule.id]);
      assert.equal(jobs.length, 1);
      const fresh = e.getSchedule(db, "ENGINE_SWEEP");
      assert.equal(fresh.execution_count, 1);
      assert.ok(fresh.next_run_at > queryOne(db, "SELECT datetime('now') AS now").now);

      const runs = e.listScheduleRuns(db, "ENGINE_SWEEP", { pageSize: 10 }).items;
      assert.equal(runs.length, 1);
      assert.equal(runs[0].status, "enqueued");

      // Re-running the same occurrence must not duplicate work.
      run(db, "UPDATE job_schedules SET next_run_at = datetime('now', '-2 minutes') WHERE id = ?", [schedule.id]);
      const second = e.sweepSchedules(db);
      assert.equal(second.enqueued, 0);
      assert.equal(queryAll(db, "SELECT * FROM jobs WHERE schedule_id = ?", [schedule.id]).length, 1);
    });

    test("run-now dispatches immediately without changing cadence", () => {
      const schedule = e.createSchedule(
        db,
        { code: "ENGINE_RUNNOW", job_type_code: "ENGINE_SUCCESS", schedule_type: "daily", daily_time: "03:00" },
        admin
      );
      const before = e.getSchedule(db, "ENGINE_RUNNOW").next_run_at;
      const result = e.runScheduleNow(db, "ENGINE_RUNNOW", { actor: admin });
      assert.equal(result.job.status, "queued");
      assert.equal(result.schedule.execution_count, 1);
      assert.equal(e.getSchedule(db, "ENGINE_RUNNOW").next_run_at, before);
      assert.ok(result.job.id);
      assert.ok(schedule.id);
    });

    test("applies the failure policy without auto-disabling by default", () => {
      const soft = e.createSchedule(
        db,
        { code: "ENGINE_FAIL_SOFT", job_type_code: "ENGINE_SUCCESS", schedule_type: "interval", interval_seconds: 600, failure_policy: "continue" },
        admin
      );
      const softRun = e.runScheduleNow(db, "ENGINE_FAIL_SOFT", { actor: admin });
      j.transitionJob(db, softRun.job.id, "running", { source: "engine" });
      j.transitionJob(db, softRun.job.id, "failed", { source: "engine", errorMessage: "boom" });
      e.reconcileScheduleRuns(db, [soft.id]);
      let fresh = e.getSchedule(db, "ENGINE_FAIL_SOFT");
      assert.equal(fresh.status, "active");
      assert.equal(fresh.failure_count, 1);
      assert.equal(fresh.consecutive_failures, 1);

      const strict = e.createSchedule(
        db,
        { code: "ENGINE_FAIL_PAUSE", job_type_code: "ENGINE_SUCCESS", schedule_type: "interval", interval_seconds: 600, failure_policy: "pause" },
        admin
      );
      const strictRun = e.runScheduleNow(db, "ENGINE_FAIL_PAUSE", { actor: admin });
      j.transitionJob(db, strictRun.job.id, "running", { source: "engine" });
      j.transitionJob(db, strictRun.job.id, "failed", { source: "engine", errorMessage: "boom" });
      e.reconcileScheduleRuns(db, [strict.id]);
      fresh = e.getSchedule(db, "ENGINE_FAIL_PAUSE");
      assert.equal(fresh.status, "paused");
    });

    test("enable/disable toggles schedule eligibility", () => {
      const schedule = e.createSchedule(
        db,
        { code: "ENGINE_TOGGLE", job_type_code: "ENGINE_SUCCESS", schedule_type: "interval", interval_seconds: 600 },
        admin
      );
      const paused = e.setScheduleEnabled(db, schedule.id, false, admin);
      assert.equal(paused.enabled, false);
      assert.equal(paused.status, "disabled");
      const resumed = e.setScheduleEnabled(db, schedule.id, true, admin);
      assert.equal(resumed.enabled, true);
      assert.equal(resumed.status, "active");
    });
  });

  describe("workers and metrics", () => {
    test("registers, heartbeats and reaps workers", () => {
      const worker = e.registerWorker(db, { id: "test-worker-1", name: "Test worker", concurrency: 2, queues: ["DEFAULT"] });
      assert.equal(worker.status, "starting");
      const beat = e.heartbeatWorker(db, "test-worker-1", { status: "idle", activeJobs: 0 });
      assert.equal(beat.status, "idle");
      const listed = e.listWorkers(db, { pageSize: 50 });
      assert.ok(listed.items.some((item) => item.id === "test-worker-1"));
      assert.ok(listed.summary.total >= 1);

      run(db, "UPDATE job_workers SET last_heartbeat = datetime('now', '-10 minutes') WHERE id = 'test-worker-1'");
      const reaped = e.reapStaleWorkers(db, { offlineAfterSeconds: 0 });
      assert.ok(reaped.length >= 1);
      assert.ok(reaped.some((item) => item.id === "test-worker-1" && item.status === "offline"));
    });

    test("aggregates execution metrics and engine status", () => {
      const metrics = e.executionMetrics(db);
      assert.ok(metrics.queue_count >= 9);
      assert.ok(metrics.totals);
      assert.ok(Array.isArray(metrics.queues));
      assert.ok(Array.isArray(metrics.handlers));
      assert.ok(metrics.handlers.includes("ENGINE_SUCCESS"));

      const status = e.engineStatus(db);
      assert.ok(Array.isArray(status.queues) && status.queues.includes("DEFAULT"));
      assert.equal(typeof status.online_workers, "number");
      assert.ok(status.handlers.includes("ENGINE_SUCCESS"));
      assert.ok(status.checked_at);
    });
  });
});

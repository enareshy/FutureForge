import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, queryAll } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as j from "../services/jobs.js";

describe("background job management services", () => {
  let db;
  let tenantId;
  let otherTenantId;
  let admin;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    otherTenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'emea'").id;
    admin = queryOne(db, "SELECT * FROM users WHERE username = 'admin'");
  });

  after(() => db?.close());

  describe("job type registry", () => {
    test("seeds the standard enterprise job types once", () => {
      const before = j.listJobTypes(db, { pageSize: 100 }).total;
      assert.ok(before >= 8);
      j.ensureDefaultJobTypes(db);
      assert.equal(j.listJobTypes(db, { pageSize: 100 }).total, before);
      const bulk = j.getJobType(db, "BULK_IMPORT");
      assert.equal(bulk.source_module, "bulk-import");
      assert.ok(bulk.queues.includes("imports"));
      assert.equal(bulk.active, true);
    });

    test("creates, updates and deactivates a custom job type", () => {
      const created = j.createJobType(
        db,
        { code: "CUSTOM_ETL", name: "Custom ETL", source_module: "test", queues: ["etl", "default"], max_retries: 3, default_priority: "high", timeout_seconds: 600 },
        admin
      );
      assert.equal(created.code, "CUSTOM_ETL");
      assert.equal(created.default_priority, "high");
      assert.throws(() => j.createJobType(db, { code: "CUSTOM_ETL", name: "dup" }, admin), /already exists/);
      const updated = j.updateJobType(db, "CUSTOM_ETL", { name: "Custom ETL v2", max_retries: 5 }, admin);
      assert.equal(updated.name, "Custom ETL v2");
      assert.equal(updated.max_retries, 5);
      const off = j.setJobTypeStatus(db, "CUSTOM_ETL", false, admin);
      assert.equal(off.active, false);
      assert.throws(() => j.getJobType(db, "NOPE"), /not found/);
    });

    test("validates job type codes", () => {
      assert.throws(() => j.createJobType(db, { code: "bad code", name: "x" }, admin), /must start with a letter/);
    });
  });

  describe("submission and lifecycle", () => {
    test("submits a job and returns immediately with a Job ID", () => {
      const job = j.submitJob(
        db,
        { job_type_code: "REPORT_GENERATION", name: "Service report", tenant_id: tenantId, related_object_type: "report", related_object_id: "42" },
        { actor: admin }
      );
      assert.ok(job.id > 0);
      assert.match(job.job_ref, /^JOB-[A-Z0-9]+$/);
      assert.equal(job.status, "queued");
      assert.equal(job.status_label, "QUEUED");
      assert.equal(job.source_module, "reports");
      assert.equal(job.max_retries, 2);
      assert.equal(job.submitted_as, "user");
    });

    test("rejects unknown or inactive job types", () => {
      assert.throws(() => j.submitJob(db, { job_type_code: "DOES_NOT_EXIST", tenant_id: tenantId }, { actor: admin }), /Unknown job type/);
      assert.throws(() => j.submitJob(db, { job_type_code: "CUSTOM_ETL", tenant_id: tenantId }, { actor: admin }), /not active/);
    });

    test("is idempotent on idempotency_key", () => {
      const first = j.submitJob(db, { job_type_code: "DATA_SYNC", tenant_id: tenantId, idempotency_key: "svc-idem-1" }, { actor: admin });
      const second = j.submitJob(db, { job_type_code: "DATA_SYNC", tenant_id: tenantId, idempotency_key: "svc-idem-1" }, { actor: admin });
      assert.equal(second.id, first.id);
      assert.equal(second.duplicate, true);
    });

    test("walks the status machine and reports progress", () => {
      const job = j.submitJob(db, { job_type_code: "BOM_VALIDATION", tenant_id: tenantId }, { actor: admin });
      assert.throws(() => j.transitionJob(db, job.id, "completed"), /Invalid job status transition/);
      const running = j.transitionJob(db, job.id, "running", { workerId: "worker-7" });
      assert.equal(running.status, "running");
      assert.ok(running.started_at);
      const progressed = j.updateProgress(db, job.id, { progress: 150, stage: "scan", message: "halfway" }, {});
      assert.equal(progressed.progress, 100);
      assert.equal(progressed.stage, "scan");
      const done = j.transitionJob(db, job.id, "completed", {});
      assert.equal(done.status, "completed");
      assert.ok(done.completed_at);
      assert.equal(j.getStatus(db, job.id, tenantId).status, "completed");
      assert.throws(() => j.updateProgress(db, job.id, { progress: 10 }, {}), /Cannot update a COMPLETED job/);
    });

    test("cancels queued jobs immediately and requests cancellation for running jobs", () => {
      const queued = j.submitJob(db, { job_type_code: "SEARCH_INDEXING", tenant_id: tenantId }, { actor: admin });
      const cancelled = j.cancelJob(db, queued.id, { reason: "no longer needed", actor: admin });
      assert.equal(cancelled.cancelled, true);
      assert.equal(cancelled.requested, false);
      assert.equal(cancelled.job.status, "cancelled");

      const running = j.submitJob(db, { job_type_code: "SEARCH_INDEXING", tenant_id: tenantId }, { actor: admin });
      j.transitionJob(db, running.id, "running", {});
      const requested = j.cancelJob(db, running.id, { actor: admin });
      assert.equal(requested.cancelled, true);
      assert.equal(requested.requested, true);
      assert.equal(requested.job.status, "cancel_requested");
      const finished = j.transitionJob(db, running.id, "cancelled", {});
      assert.equal(finished.status, "cancelled");
    });

    test("retries failed jobs and ignores healthy ones", () => {
      const job = j.submitJob(db, { job_type_code: "DATA_SYNC", tenant_id: tenantId }, { actor: admin });
      j.transitionJob(db, job.id, "running", {});
      j.transitionJob(db, job.id, "failed", { errorCode: "timeout", errorMessage: "boom" });
      const retried = j.retryJob(db, job.id, { actor: admin });
      assert.equal(retried.retried, true);
      assert.equal(retried.job.status, "queued");
      assert.equal(retried.job.retry_count, 1);
      assert.equal(retried.job.error_code, "");
      const again = j.retryJob(db, job.id, { actor: admin });
      assert.equal(again.retried, false);
      assert.equal(again.reason, "not_retryable");
    });

    test("pauses and resumes active jobs", () => {
      const job = j.submitJob(db, { job_type_code: "DATA_SYNC", tenant_id: tenantId }, { actor: admin });
      const paused = j.pauseJob(db, job.id, { actor: admin });
      assert.equal(paused.paused, true);
      assert.equal(paused.job.status, "paused");
      const resumed = j.resumeJob(db, job.id, { actor: admin });
      assert.equal(resumed.resumed, true);
      assert.equal(resumed.job.status, "queued");
      assert.equal(j.resumeJob(db, job.id, { actor: admin }).reason, "not_paused");
    });

    test("lists, filters, sorts and scopes jobs", () => {
      j.submitJob(db, { job_type_code: "BULK_IMPORT", name: "Findable import", tenant_id: tenantId }, { actor: admin });
      const byType = j.listJobs(db, { type: "BULK_IMPORT", tenantId }, tenantId);
      assert.ok(byType.items.every((job) => job.job_type_code === "BULK_IMPORT"));
      const filtered = j.listJobs(db, { q: "Findable", tenantId }, tenantId);
      assert.ok(filtered.items.some((job) => job.name === "Findable import"));
      const paged = j.listJobs(db, { pageSize: 2, page: 1, sort: "created_at", order: "asc", tenantId }, tenantId);
      assert.equal(paged.pageSize, 2);
      assert.ok(paged.items.length <= 2);
      const active = j.listJobs(db, { active: "true", tenantId }, tenantId);
      assert.ok(active.items.every((job) => !job.is_terminal));
    });

    test("isolates jobs by tenant", () => {
      const foreign = j.submitJob(db, { job_type_code: "DATA_SYNC", name: "Foreign job", tenant_id: otherTenantId }, { actor: null });
      assert.throws(() => j.getJob(db, foreign.id, tenantId), /not found/);
      const list = j.listJobs(db, { tenantId }, tenantId);
      assert.ok(!list.items.some((job) => job.id === foreign.id));
      assert.equal(j.getJob(db, foreign.id, otherTenantId).name, "Foreign job");
    });
  });

  describe("dependencies", () => {
    test("holds dependent jobs until their dependencies complete", () => {
      const parent = j.submitJob(db, { job_type_code: "CAD_PROCESSING", tenant_id: tenantId }, { actor: admin });
      const child = j.submitJob(db, { job_type_code: "BOM_VALIDATION", tenant_id: tenantId, dependencies: [parent.id] }, { actor: admin });
      assert.equal(child.status, "waiting_for_dependency");
      const deps = j.listDependencies(db, child.id, tenantId);
      assert.equal(deps.depends_on.length, 1);
      assert.equal(deps.state.satisfied, false);

      j.transitionJob(db, parent.id, "running", {});
      j.transitionJob(db, parent.id, "completed", {});
      const released = j.getJob(db, child.id, tenantId);
      assert.equal(released.status, "queued");
      const dependents = j.listDependencies(db, parent.id, tenantId).dependents;
      assert.ok(dependents.some((entry) => entry.id === child.id));
    });

    test("fails dependent jobs when a required dependency fails", () => {
      const parent = j.submitJob(db, { job_type_code: "CAD_PROCESSING", tenant_id: tenantId }, { actor: admin });
      const child = j.submitJob(db, { job_type_code: "BOM_VALIDATION", tenant_id: tenantId, dependencies: [parent.id] }, { actor: admin });
      j.transitionJob(db, parent.id, "running", {});
      j.transitionJob(db, parent.id, "failed", { errorCode: "cad_error" });
      const blocked = j.getJob(db, child.id, tenantId);
      assert.equal(blocked.status, "failed");
      assert.equal(blocked.error_code, "dependency_failed");
    });

    test("adds and removes dependencies explicitly", () => {
      const a = j.submitJob(db, { job_type_code: "DATA_SYNC", tenant_id: tenantId }, { actor: admin });
      const b = j.submitJob(db, { job_type_code: "DATA_SYNC", tenant_id: tenantId }, { actor: admin });
      j.addDependencies(db, b.id, [a.id], { actor: admin });
      assert.equal(j.dependencyState(db, b.id).total, 1);
      j.removeDependency(db, b.id, a.id, { actor: admin });
      assert.equal(j.dependencyState(db, b.id).total, 0);
      assert.throws(() => j.addDependencies(db, a.id, [a.id], { actor: admin }), /cannot depend on itself/);
    });

    test("supports parent/child job trees", () => {
      const parent = j.submitJob(db, { job_type_code: "BULK_IMPORT", tenant_id: tenantId }, { actor: admin });
      j.submitJob(db, { job_type_code: "BULK_IMPORT", tenant_id: tenantId, parent_job_id: parent.id }, { actor: admin });
      const children = j.listChildren(db, parent.id, tenantId);
      assert.equal(children.length, 1);
      assert.equal(children[0].parent_job_id, parent.id);
    });
  });

  describe("results and history", () => {
    test("records results, artifacts and a timeline", () => {
      const job = j.submitJob(db, { job_type_code: "REPORT_GENERATION", tenant_id: tenantId }, { actor: admin });
      j.transitionJob(db, job.id, "running", {});
      j.transitionJob(db, job.id, "completed", {});
      const row = j.getJobRow(db, job.id, tenantId);
      const payload = j.setJobResult(db, row, { result: { rows: 10 }, result_ref: "doc://x" }, { actor: admin });
      assert.equal(payload.result.rows, 10);
      assert.equal(payload.result_ref, "doc://x");
      const artifact = j.addArtifact(db, job.id, { kind: "report", name: "Report", filename: "r.pdf", size: 100 }, admin);
      assert.equal(artifact.kind, "report");
      assert.equal(j.listArtifacts(db, job.id).length, 1);
      assert.equal(j.resultPayload(db, j.getJobRow(db, job.id)).artifacts.length, 1);
      const history = j.jobTimeline(db, job.id);
      assert.ok(history.length >= 3);
      assert.equal(history[0].event_type, "created");
      assert.ok(history.some((entry) => entry.event_type === "result"));
      const paged = j.listHistory(db, job.id, { pageSize: 2 });
      assert.equal(paged.items.length, 2);
      assert.throws(() => j.addArtifact(db, job.id, { kind: "nonsense" }, admin), /kind must be one of/);
    });
  });

  describe("metrics", () => {
    test("aggregates dashboard counters", () => {
      const metrics = j.jobMetrics(db, tenantId);
      assert.ok(metrics.total >= 1);
      assert.equal(typeof metrics.statuses.completed, "number");
      assert.ok(Array.isArray(metrics.by_status));
      assert.ok(Array.isArray(metrics.by_type));
      assert.ok(Array.isArray(metrics.queue_depth));
      assert.ok(metrics.success_rate === null || (metrics.success_rate >= 0 && metrics.success_rate <= 100));
      const series = j.jobTimeseries(db, tenantId, { days: 7 });
      assert.ok(Array.isArray(series));
      const scoped = j.jobMetrics(db, otherTenantId);
      assert.ok(scoped.total <= metrics.total);
    });
  });
});

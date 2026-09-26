// Background worker: claims and executes jobs until stopped.
//
// The loop is intentionally simple and horizontally scalable: run one or more
// processes (see scripts/job-worker.js). All coordination happens through the
// durable queue + leases, so no shared memory is required.

import { claimJob, executeClaimedJob, engineMaintenance } from "./engine.js";
import { sweepSchedules } from "./schedules.js";
import {
  registerWorker,
  heartbeatWorker,
  markWorkerStopped,
  generateWorkerId,
} from "./worker-registry.js";
import { purgeExpiredLocks } from "./locks.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class EngineWorker {
  constructor(db, options = {}) {
    this.db = db;
    this.id = options.id || generateWorkerId(options.prefix || "worker");
    this.name = options.name || this.id;
    this.queues = Array.isArray(options.queues) && options.queues.length ? options.queues.map((code) => String(code).toUpperCase()) : null;
    this.concurrency = Math.max(1, Number(options.concurrency) || 1);
    this.pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || 1000);
    this.heartbeatIntervalMs = Math.max(2000, Number(options.heartbeatIntervalMs) || 10000);
    this.maintenanceIntervalMs = Math.max(5000, Number(options.maintenanceIntervalMs) || 15000);
    this.version = options.version || "";
    this.active = new Map();
    this.timers = [];
    this.running = false;
    this.stopping = false;
    this.lastMaintenance = 0;
    this.stats = { claimed: 0, completed: 0, failed: 0, retried: 0, cancelled: 0 };
  }

  async start() {
    if (this.running) return this;
    this.running = true;
    this.stopping = false;
    registerWorker(this.db, {
      id: this.id,
      name: this.name,
      hostname: process.env.HOSTNAME || "",
      pid: process.pid,
      concurrency: this.concurrency,
      queues: this.queues || [],
      version: this.version,
    });
    this.timers.push(setInterval(() => this.beat(), this.heartbeatIntervalMs));
    this.beat();
    this.loopPromise = this.loop();
    return this;
  }

  beat() {
    try {
      heartbeatWorker(this.db, this.id, {
        status: this.stopping ? "draining" : this.active.size > 0 ? "busy" : "idle",
        activeJobs: this.active.size,
        queues: this.queues || [],
      });
    } catch {
      /* heartbeat is best effort */
    }
  }

  async loop() {
    while (!this.stopping) {
      try {
        await this.cycle();
      } catch (error) {
        console.error(JSON.stringify({ level: "error", component: "job-engine", worker: this.id, message: "Worker cycle failed", error: error.message }));
        await sleep(this.pollIntervalMs);
      }
    }
  }

  async cycle() {
    if (Date.now() - this.lastMaintenance >= this.maintenanceIntervalMs) {
      this.lastMaintenance = Date.now();
      try {
        engineMaintenance(this.db);
        sweepSchedules(this.db, { limit: 25 });
        purgeExpiredLocks(this.db);
      } catch (error) {
        console.error(JSON.stringify({ level: "error", component: "job-engine", worker: this.id, message: "Maintenance failed", error: error.message }));
      }
    }

    const free = Math.max(0, this.concurrency - this.active.size);
    for (let i = 0; i < free; i += 1) {
      const claim = claimJob(this.db, { workerId: this.id, queueCodes: this.queues });
      if (!claim) break;
      this.launch(claim);
    }
    await sleep(this.active.size > 0 ? Math.min(this.pollIntervalMs, 250) : this.pollIntervalMs);
  }

  launch(claim) {
    const key = claim.job.id;
    this.stats.claimed += 1;
    const promise = executeClaimedJob(this.db, claim, { hooks: this.hooks })
      .then((outcome) => {
        if (outcome.status === "completed") this.stats.completed += 1;
        else if (outcome.status === "retrying") this.stats.retried += 1;
        else if (outcome.status === "cancelled") this.stats.cancelled += 1;
        else if (outcome.status === "failed" || outcome.status === "timed_out") this.stats.failed += 1;
        return outcome;
      })
      .catch((error) => {
        console.error(JSON.stringify({ level: "error", component: "job-engine", worker: this.id, job_id: key, message: "Execution crashed", error: error.message }));
        return null;
      })
      .finally(() => {
        this.active.delete(key);
      });
    this.active.set(key, promise);
  }

  // Processes at most `limit` jobs synchronously (used by tests / manual ticks).
  async runOnce(limit = 1) {
    engineMaintenance(this.db);
    sweepSchedules(this.db, { limit: 25 });
    let processed = 0;
    for (let i = 0; i < limit; i += 1) {
      const claim = claimJob(this.db, { workerId: this.id, queueCodes: this.queues });
      if (!claim) break;
      await executeClaimedJob(this.db, claim, { hooks: this.hooks });
      processed += 1;
    }
    return processed;
  }

  async stop({ timeoutMs = 30000 } = {}) {
    if (!this.running) return;
    this.stopping = true;
    this.beat();
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await sleep(100);
    }
    this.running = false;
    markWorkerStopped(this.db, this.id, this.active.size > 0 ? "stopped" : "stopped");
    return { stopped: true, abandoned: this.active.size };
  }

  snapshot() {
    return {
      id: this.id,
      running: this.running,
      stopping: this.stopping,
      concurrency: this.concurrency,
      active_jobs: this.active.size,
      queues: this.queues || [],
      stats: { ...this.stats },
    };
  }
}

export function createWorker(db, options = {}) {
  return new EngineWorker(db, options);
}

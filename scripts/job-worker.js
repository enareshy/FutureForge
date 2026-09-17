// Job Scheduling & Execution Engine worker process.
//
// Runs a durable worker loop against the shared SQLite database: it reclaims
// expired leases, sweeps due schedules, claims ready jobs, invokes the
// registered handler and records the outcome (retry / dead-letter / complete).
//
// Usage:
//   node scripts/job-worker.js [--queues=A,B] [--concurrency=4] [--demo]
//
// Environment:
//   IAM_DB                     database path (default ./data/iam.db)
//   JOB_WORKER_QUEUES          comma separated queue restriction, e.g. IMPORT,DEFAULT
//   JOB_WORKER_CONCURRENCY     max parallel jobs (default 4)
//   JOB_WORKER_POLL_MS         idle poll interval (default 1000)
//   JOB_WORKER_HEARTBEAT_MS    heartbeat interval (default 10000)
//   JOB_WORKER_MAINTENANCE_MS  maintenance sweep interval (default 15000)
//   JOB_WORKER_DRAIN_MS        graceful shutdown budget (default 30000)
//   JOB_DEMO_HANDLERS=1        register the bundled demo handlers (local demos only)

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, migrate } from "../server/db.js";
import { ensureDefaultQueues, createWorker, registerDemoHandlers } from "../server/services/job-execution.js";
import { registerFileProcessingHandlers, expireUploads, releaseExpiredLocks } from "../server/services/files.js";
import { registerSearchHandlers, runSearchMaintenance } from "../server/services/search.js";
import { registerAuditHandlers, runAuditMaintenance } from "../server/services/audit.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { queues: "", concurrency: 0, poll: 0, heartbeat: 0, maintenance: 0, drain: 0, name: "", id: "", demo: false };
  for (const token of argv) {
    const [key, value = ""] = token.replace(/^--/, "").split("=");
    switch (key) {
      case "queues": args.queues = value; break;
      case "concurrency": args.concurrency = Number(value) || 0; break;
      case "poll": args.poll = Number(value) || 0; break;
      case "heartbeat": args.heartbeat = Number(value) || 0; break;
      case "maintenance": args.maintenance = Number(value) || 0; break;
      case "drain": args.drain = Number(value) || 0; break;
      case "name": args.name = value; break;
      case "id": args.id = value; break;
      case "demo": args.demo = true; break;
      default: break;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const dbPath = process.env.IAM_DB || join(root, "data", "iam.db");
const queuesCsv = args.queues || process.env.JOB_WORKER_QUEUES || "";

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function log(level, message, detail = {}) {
  const line = { ts: new Date().toISOString(), level, component: "job-engine", worker: args.name || args.id || "worker", message, ...detail };
  const serialized = JSON.stringify(line);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);
}

const db = openDatabase(dbPath);
migrate(db);
ensureDefaultQueues(db);

const demo = args.demo || /^(1|true|yes)$/i.test(String(process.env.JOB_DEMO_HANDLERS || ""));
if (demo) {
  registerDemoHandlers();
  log("warn", "Demo handlers registered; do not use in production");
}

// Document & File Management processing handlers (virus scan / preview). These
// are production handlers and are always registered.
registerFileProcessingHandlers();

// Search & Discovery background handlers (index maintenance, rebuild, export).
registerSearchHandlers();

// Audit & History background handlers (event export, retention execution).
registerAuditHandlers();

// Periodic file housekeeping: expire abandoned upload sessions and auto-release
// stale check-out locks so operators never fight a lock nobody is using.
const fileMaintenanceMs = positive(process.env.FILE_MAINTENANCE_MS, 60000);
const fileMaintenance = setInterval(async () => {
  try {
    const locks = releaseExpiredLocks(db);
    const uploads = await expireUploads(db);
    if (locks.released_count || uploads.expired_count) {
      log("info", "File housekeeping", { expired_locks: locks.released_count, expired_uploads: uploads.expired_count });
    }
  } catch (error) {
    log("warn", "File housekeeping failed", { error: error.message });
  }
}, fileMaintenanceMs);
fileMaintenance.unref?.();

// Periodic search housekeeping: converge the index queue and prune expired
// search history / exports.
const searchMaintenanceMs = positive(process.env.SEARCH_MAINTENANCE_MS, 30000);
const searchMaintenance = setInterval(() => {
  try {
    const summary = runSearchMaintenance(db);
    if (summary.drained.succeeded || summary.drained.failed || summary.history_pruned || summary.exports_expired) {
      log("info", "Search housekeeping", {
        indexed: summary.drained.succeeded,
        failed: summary.drained.failed,
        dead_lettered: summary.drained.dead_lettered,
        history_pruned: summary.history_pruned,
        exports_expired: summary.exports_expired,
      });
    }
  } catch (error) {
    log("warn", "Search housekeeping failed", { error: error.message });
  }
}, searchMaintenanceMs);
searchMaintenance.unref?.();

// Periodic audit housekeeping: expire stale exports and apply retention
// policies for tenants that have configured them.
const auditMaintenanceMs = positive(process.env.AUDIT_MAINTENANCE_MS, 120000);
const auditMaintenance = setInterval(() => {
  try {
    const summary = runAuditMaintenance(db);
    if (summary.exports_expired || summary.purged) {
      log("info", "Audit housekeeping", {
        exports_expired: summary.exports_expired,
        tenants: summary.tenants,
        archived: summary.archived,
        purged: summary.purged,
      });
    }
  } catch (error) {
    log("warn", "Audit housekeeping failed", { error: error.message });
  }
}, auditMaintenanceMs);
auditMaintenance.unref?.();

const worker = createWorker(db, {
  id: args.id || undefined,
  name: args.name || undefined,
  queues: queuesCsv ? queuesCsv.split(",").map((code) => code.trim()).filter(Boolean) : null,
  concurrency: positive(args.concurrency, positive(process.env.JOB_WORKER_CONCURRENCY, 4)),
  pollIntervalMs: positive(args.poll, positive(process.env.JOB_WORKER_POLL_MS, 1000)),
  heartbeatIntervalMs: positive(args.heartbeat, positive(process.env.JOB_WORKER_HEARTBEAT_MS, 10000)),
  maintenanceIntervalMs: positive(args.maintenance, positive(process.env.JOB_WORKER_MAINTENANCE_MS, 15000)),
});

const drainMs = positive(args.drain, positive(process.env.JOB_WORKER_DRAIN_MS, 30000));
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(fileMaintenance);
  clearInterval(searchMaintenance);
  clearInterval(auditMaintenance);
  log("info", "Worker draining", { signal, drain_ms: drainMs, active_jobs: worker.active.size });
  try {
    await worker.stop({ timeoutMs: drainMs });
    log("info", "Worker stopped", { stats: worker.stats });
  } catch (error) {
    log("error", "Worker shutdown failed", { error: error.message });
  } finally {
    db.close();
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await worker.start();
log("info", "Worker started", {
  id: worker.id,
  db: dbPath,
  concurrency: worker.concurrency,
  queues: worker.queues || "all",
  demo_handlers: demo,
});

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
import { registerIntegrationHandlers, runIntegrationMaintenance } from "../server/services/integration/jobs.js";
import { registerEventHandlers, runEventMaintenance } from "../server/services/events/jobs.js";
import { registerNumberingHandlers, runNumberingMaintenance } from "../server/services/numbering/jobs.js";
import { registerVersioningHandlers, runVersioningMaintenance } from "../server/services/versioning/jobs.js";
import { registerReferenceHandlers } from "../server/services/reference/jobs.js";
import { registerContentProcessingHandlers, registerContentHandlers, runContentMaintenance } from "../server/services/content.js";
import { registerDataGovernanceHandlers, runGovernanceMaintenance } from "../server/services/data-governance/index.js";

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

// Integration & API Framework background handlers (message delivery, event
// fan-out, webhooks, imports/exports, health probes, dead-letter retry).
registerIntegrationHandlers();

// Event & Messaging Framework background handlers (outbox publish, consumer
// drain, controlled replay, retention and lease maintenance).
registerEventHandlers();

// Numbering Service background handlers (reservation expiry and idempotency
// bookkeeping convergence).
registerNumberingHandlers();

// Effectivity & Versioning Kernel background handlers (effectivity expiry and
// resolution bookkeeping convergence).
registerVersioningHandlers();

// Enterprise Reference Data Management background handlers (export pruning and
// stale search index convergence).
registerReferenceHandlers();

// File & Content Management background handlers (security scan, rendition
// generation, retention evaluation and estate maintenance).
registerContentProcessingHandlers();
registerContentHandlers();

// Data Governance & Data Quality background handlers (batch/scheduled quality
// evaluation, duplicate scans and governance housekeeping).
registerDataGovernanceHandlers();

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

// Periodic content housekeeping: expire abandoned upload staging, release stale
// check-out locks, evaluate retention and converge the search index.
const contentMaintenanceMs = positive(process.env.CONTENT_MAINTENANCE_MS, 60000);
const contentMaintenance = setInterval(async () => {
  try {
    const summary = await runContentMaintenance(db);
    if (summary.uploads_expired || summary.locks_released || summary.retention_processed || summary.reindexed) {
      log("info", "Content housekeeping", summary);
    }
  } catch (error) {
    log("warn", "Content housekeeping failed", { error: error.message });
  }
}, contentMaintenanceMs);
contentMaintenance.unref?.();

// Periodic data governance housekeeping: escalate overdue exceptions, run
// scheduled quality evaluations and converge background job bookkeeping.
const governanceMaintenanceMs = positive(process.env.GOVERNANCE_MAINTENANCE_MS, 60000);
const governanceMaintenance = setInterval(() => {
  try {
    const summary = runGovernanceMaintenance(db);
    if (summary.escalated || summary.history_pruned) {
      log("info", "Data governance housekeeping", {
        escalated: summary.escalated,
        history_pruned: summary.history_pruned,
      });
    }
  } catch (error) {
    log("warn", "Data governance housekeeping failed", { error: error.message });
  }
}, governanceMaintenanceMs);
governanceMaintenance.unref?.();

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

// Periodic integration housekeeping: converge event deliveries, outbound
// webhooks and queued messages so async integrations complete without an
// operator having to submit jobs manually.
const integrationMaintenanceMs = positive(process.env.INTEGRATION_MAINTENANCE_MS, 15000);
const integrationMaintenance = setInterval(async () => {
  try {
    const summary = await runIntegrationMaintenance(db);
    if (summary.events.delivered || summary.webhooks.delivered || summary.messages.succeeded) {
      log("info", "Integration housekeeping", {
        events: summary.events.delivered,
        webhooks: summary.webhooks.delivered,
        messages: summary.messages.succeeded,
      });
    }
  } catch (error) {
    log("warn", "Integration housekeeping failed", { error: error.message });
  }
}, integrationMaintenanceMs);
integrationMaintenance.unref?.();

// Periodic event housekeeping: converge the transactional outbox and consumer
// queue, reclaim crashed leases and prune resolved bookkeeping.
const eventMaintenanceMs = positive(process.env.EVENT_MAINTENANCE_MS, 15000);
const eventMaintenance = setInterval(async () => {
  try {
    const summary = await runEventMaintenance(db);
    if (summary.outbox.published || summary.deliveries.delivered || summary.deliveries.dead_lettered) {
      log("info", "Event housekeeping", {
        outbox_published: summary.outbox.published,
        delivered: summary.deliveries.delivered,
        dead_lettered: summary.deliveries.dead_lettered,
        reclaimed_outbox: summary.reclaimedOutbox.reclaimed,
        released_deliveries: summary.releasedDeliveries.reclaimed,
      });
    }
  } catch (error) {
    log("warn", "Event housekeeping failed", { error: error.message });
  }
}, eventMaintenanceMs);
eventMaintenance.unref?.();

// Periodic numbering housekeeping: expire reservations that outlived their
// timeout and prune stale idempotency records so replays stay bounded.
const numberingMaintenanceMs = positive(process.env.NUMBERING_MAINTENANCE_MS, 30000);
const numberingMaintenance = setInterval(() => {
  try {
    const summary = runNumberingMaintenance(db);
    if (summary.expired_reservations || summary.idempotency_pruned) {
      log("info", "Numbering housekeeping", {
        expired_reservations: summary.expired_reservations,
        idempotency_pruned: summary.idempotency_pruned,
      });
    }
  } catch (error) {
    log("warn", "Numbering housekeeping failed", { error: error.message });
  }
}, numberingMaintenanceMs);
numberingMaintenance.unref?.();

// Periodic versioning housekeeping: emit EffectivityExpired for ranges that
// ended and prune resolution bookkeeping.
const versioningMaintenanceMs = positive(process.env.VERSIONING_MAINTENANCE_MS, 30000);
const versioningMaintenance = setInterval(() => {
  try {
    const summary = runVersioningMaintenance(db);
    if (summary.expired_effectivities || summary.resolution_results_pruned) {
      log("info", "Versioning housekeeping", {
        expired_effectivities: summary.expired_effectivities,
        resolution_results_pruned: summary.resolution_results_pruned,
      });
    }
  } catch (error) {
    log("warn", "Versioning housekeeping failed", { error: error.message });
  }
}, versioningMaintenanceMs);
versioningMaintenance.unref?.();

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
  clearInterval(integrationMaintenance);
  clearInterval(eventMaintenance);
  clearInterval(numberingMaintenance);
  clearInterval(governanceMaintenance);
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

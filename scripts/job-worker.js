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
import { registerCatalogHandlers, runCatalogMaintenance } from "../server/services/data-catalog/index.js";
import { registerLifecycleHandlers, runLifecycleMaintenance } from "../server/services/data-lifecycle/index.js";
import { registerExchangeHandlers, runExchangeMaintenance } from "../server/services/data-exchange/index.js";
import { registerMigrationHandlers, runMigrationMaintenance, ensureMigrationJobTypes } from "../server/services/migration/index.js";
import { registerClassificationHandlers, runClassificationMaintenance, ensureClassificationJobTypes } from "../server/services/classification/index.js";

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

// Data Catalog & Business Glossary background handlers (metadata import/export,
// lineage convergence and search reindex).
registerCatalogHandlers();

// Data Lifecycle & Archival background handlers (eligibility evaluation,
// archive/cold-storage/restore/purge/recovery batches and housekeeping).
registerLifecycleHandlers();

// Import & Export Framework background handlers (import/export execution,
// validation, reconciliation, retry of failed records and housekeeping).
registerExchangeHandlers();

// Migration & Onboarding Framework background handlers (migration execution,
// validation, reconciliation, retry, replanning and housekeeping).
ensureMigrationJobTypes(db);
registerMigrationHandlers();

// Enterprise Classification Framework background handlers (bulk assignment,
// bulk validation, duplicate scans and housekeeping).
ensureClassificationJobTypes(db);
registerClassificationHandlers();

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

// Periodic data catalog housekeeping: converge lineage metadata so expired
// effectivities retire and edges orphaned by retired entries are pruned.
const catalogMaintenanceMs = positive(process.env.CATALOG_MAINTENANCE_MS, 60000);
const catalogMaintenance = setInterval(() => {
  try {
    const summary = runCatalogMaintenance(db);
    if (summary.deactivated || summary.pruned) {
      log("info", "Data catalog housekeeping", {
        tenants: summary.tenants,
        deactivated: summary.deactivated,
        pruned: summary.pruned,
      });
    }
  } catch (error) {
    log("warn", "Data catalog housekeeping failed", { error: error.message });
  }
}, catalogMaintenanceMs);
catalogMaintenance.unref?.();

// Periodic data lifecycle housekeeping: expire legal holds, converge retention
// dates for stale objects and reconcile archive integrity.
const lifecycleMaintenanceMs = positive(process.env.LIFECYCLE_MAINTENANCE_MS, 60000);
const lifecycleMaintenance = setInterval(async () => {
  try {
    const summary = await runLifecycleMaintenance(db);
    if (summary.expired_holds || summary.retention_recomputed || summary.archive_failures) {
      log("info", "Data lifecycle housekeeping", {
        tenants: summary.tenants,
        expired_holds: summary.expired_holds,
        retention_recomputed: summary.retention_recomputed,
        archives_verified: summary.archives_verified,
        archive_failures: summary.archive_failures,
      });
    }
  } catch (error) {
    log("warn", "Data lifecycle housekeeping failed", { error: error.message });
  }
}, lifecycleMaintenanceMs);
lifecycleMaintenance.unref?.();

// Periodic data exchange housekeeping: expire export artifacts and prune stale
// import checkpoints so storage never grows unbounded.
const exchangeMaintenanceMs = positive(process.env.EXCHANGE_MAINTENANCE_MS, 60000);
const exchangeMaintenance = setInterval(() => {
  try {
    const summary = runExchangeMaintenance(db);
    if (summary.exports_expired || summary.blobs_pruned || summary.checkpoints_pruned) {
      log("info", "Data exchange housekeeping", {
        tenants: summary.tenants,
        exports_expired: summary.exports_expired,
        blobs_pruned: summary.blobs_pruned,
        checkpoints_pruned: summary.checkpoints_pruned,
      });
    }
  } catch (error) {
    log("warn", "Data exchange housekeeping failed", { error: error.message });
  }
}, exchangeMaintenanceMs);
exchangeMaintenance.unref?.();

// Periodic migration housekeeping: prune stale checkpoints, promote dependents
// of completed packages and archive stale non-retryable errors.
const migrationMaintenanceMs = positive(process.env.MIGRATION_MAINTENANCE_MS, 60000);
const migrationMaintenance = setInterval(() => {
  try {
    const summary = runMigrationMaintenance(db);
    if (summary.checkpoints_pruned || summary.errors_archived || summary.dependencies_promoted) {
      log("info", "Migration housekeeping", {
        tenants: summary.tenants,
        checkpoints_pruned: summary.checkpoints_pruned,
        errors_archived: summary.errors_archived,
        dependencies_promoted: summary.dependencies_promoted,
      });
    }
  } catch (error) {
    log("warn", "Migration housekeeping failed", { error: error.message });
  }
}, migrationMaintenanceMs);
migrationMaintenance.unref?.();

// Periodic classification housekeeping: prune change history beyond retention
// and remove orphaned assignment values.
const classificationMaintenanceMs = positive(process.env.CLASSIFICATION_MAINTENANCE_MS, 120000);
const classificationMaintenance = setInterval(() => {
  try {
    const summary = runClassificationMaintenance(db);
    if (summary.history_pruned || summary.orphans_pruned) {
      log("info", "Classification housekeeping", {
        tenants: summary.tenants,
        history_pruned: summary.history_pruned,
        orphans_pruned: summary.orphans_pruned,
      });
    }
  } catch (error) {
    log("warn", "Classification housekeeping failed", { error: error.message });
  }
}, classificationMaintenanceMs);
classificationMaintenance.unref?.();

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
  clearInterval(catalogMaintenance);
  clearInterval(lifecycleMaintenance);
  clearInterval(classificationMaintenance);
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

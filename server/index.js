import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import {
  openDatabase,
  migrate,
  acquireBootstrapLock,
  releaseBootstrapLock,
} from "./db.js";
import { seedDatabase } from "./seed.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT || 3001);

if (process.env.NODE_ENV === "production" && !process.env.HELIX_AUTH_SECRET) {
  console.error(
    "[helix] Refusing to start: HELIX_AUTH_SECRET is not set. This key protects " +
      "every encrypted secret in the database and must not use the built-in dev " +
      "fallback in production. Set HELIX_AUTH_SECRET and restart " +
      "(see docs/INTEGRATION_OPERATIONS.md)."
  );
  process.exit(1);
}

// Web replicas. Because the synchronous database bridge serializes every query
// within a process, one process cannot use more than one core; running several
// independent replicas is how the API scales. Default 1 (single process, as in
// development and the preview environment); production defaults to the number
// of cores, capped so a large host does not open an excessive number of pools.
function webConcurrency() {
  const raw = process.env.HELIX_WEB_CONCURRENCY;
  if (raw !== undefined && raw !== "") {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
  }
  if (process.env.NODE_ENV === "production") {
    return Math.max(1, Math.min(availableParallelism(), 4));
  }
  return 1;
}

const CONCURRENCY = webConcurrency();
const clustered = CONCURRENCY > 1;

// Startup bootstrap (schema migration plus the idempotent seed) under a
// database advisory lock, so any number of processes can start against the same
// database without racing the DDL or each other's seed.
function bootstrap(db) {
  acquireBootstrapLock(db);
  try {
    migrate(db);
    seedDatabase(db);
  } finally {
    releaseBootstrapLock(db);
  }
}

function startServer({ seed }) {
  const db = openDatabase();
  if (seed) bootstrap(db);
  const app = createApp(db);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Helix IAM API listening on http://0.0.0.0:${PORT}`);
  });
}

// Cluster primary: bootstrap once, then fork workers that only serve traffic.
async function supervise() {
  const db = openDatabase();
  try {
    bootstrap(db);
  } finally {
    db.close();
  }

  for (let i = 0; i < CONCURRENCY; i += 1) cluster.fork();

  let shuttingDown = false;
  cluster.on("exit", (worker, code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[helix] worker ${worker.process.pid} exited (${signal || code}); restarting`
    );
    cluster.fork();
  });

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[helix] supervisor received ${signal}; stopping ${CONCURRENCY} workers`);
    for (const worker of Object.values(cluster.workers)) {
      if (worker) worker.kill(signal);
    }
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log(`Helix IAM API supervisor started with ${CONCURRENCY} workers`);
}

if (clustered && cluster.isPrimary) {
  supervise().catch((err) => {
    console.error("[helix] supervisor bootstrap failed:", err);
    process.exit(1);
  });
} else {
  // Cluster workers are forked only after the primary has bootstrapped, so they
  // skip it; a standalone process owns its own bootstrap.
  startServer({ seed: !clustered });
}

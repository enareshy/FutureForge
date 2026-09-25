// Demonstration seed for the P1 Digital Thread.
//
// Idempotent: installs the foundation (providers, event/job types, search
// sources, default definition and rules, per-tenant configuration) and then
// materialises a demonstration snapshot and released baseline over the seeded
// product structure, so the capability is visible immediately after boot. The
// demo objects themselves come from the platform object seed; the thread seed
// only derives from them and never duplicates business data.
import { queryOne } from "../../db.js";
import { withEventSuppression } from "../events/emit.js";
import { ensureThreadFoundation } from "./foundation.js";
import { createSnapshot } from "./snapshots.js";
import { createBaseline, releaseBaseline } from "./baselines.js";
import { resolveDefinition } from "./definitions.js";

const DEMO_SNAPSHOT = "Demonstration product thread snapshot";
const DEMO_BASELINE = "Demonstration product thread baseline A";
const DEMO_ROOT_CODE = "PROD-1000";
const DEMO_ROOT_TYPE = "product";

export function seedThread(db, tenantId) {
  return withEventSuppression(() => {
    const tenant = resolveTenantId(db, tenantId);
    const foundation = ensureThreadFoundation(db);
    const created = { snapshots: 0, baselines: 0 };
    if (!tenant) return { foundation, created, seeded: false, reason: "no_tenant" };

    const root = queryOne(
      db,
      `SELECT o.id, t.code AS type_code
         FROM objects o JOIN metadata_types t ON t.id = o.object_type_id
        WHERE o.tenant_id = ? AND o.code = ? AND t.code = ?
        LIMIT 1`,
      [tenant, DEMO_ROOT_CODE, DEMO_ROOT_TYPE]
    );
    if (!root) return { foundation, created, seeded: false, reason: "no_demo_root" };

    const definition = resolveDefinition(db, tenant, {});
    const rootRef = `${root.type_code}:${root.id}`;
    const actor = resolveSeedActor(db);

    let snapshot = queryOne(db, "SELECT id FROM thread_snapshots WHERE tenant_id = ? AND name = ?", [tenant, DEMO_SNAPSHOT]);
    if (!snapshot) {
      snapshot = createSnapshot(db, tenant, {
        root: rootRef,
        direction: "DOWNSTREAM",
        max_depth: 10,
        includeInactive: true,
        name: DEMO_SNAPSHOT,
        description: "Snapshot of the seeded product, its revisions and bill of materials.",
        definition_code: definition?.code,
      }, actor, null);
      created.snapshots += 1;
    }

    let baseline = queryOne(db, "SELECT id FROM thread_baselines WHERE tenant_id = ? AND name = ?", [tenant, DEMO_BASELINE]);
    if (!baseline) {
      baseline = createBaseline(db, tenant, {
        name: DEMO_BASELINE,
        description: "Released baseline derived from the demonstration product thread.",
        snapshot_id: snapshot.id,
        definition_code: definition?.code,
      }, actor, null);
      created.baselines += 1;
      releaseBaseline(db, tenant, baseline.id, actor, null);
    }

    return { foundation, created, seeded: true, snapshot_id: snapshot.id, baseline_id: baseline.id };
  });
}

// Seeding runs without an HTTP actor. The thread engine is deny-by-default, so
// we resolve a real administrator to authorize the derived snapshot/baseline.
function resolveSeedActor(db) {
  const admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin' LIMIT 1");
  if (admin) return { id: admin.id, username: admin.username };
  const any = queryOne(db, "SELECT id, username FROM users ORDER BY id LIMIT 1");
  return any ? { id: any.id, username: any.username } : null;
}

function resolveTenantId(db, tenantId) {
  const explicit = Number(tenantId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  return helix?.id ?? null;
}

export function ensureThreadSeed(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  if (!tenant) return { seeded: false, reason: "no_tenant" };
  const existing = queryOne(db, "SELECT id FROM thread_baselines WHERE tenant_id = ? AND name = ?", [tenant, DEMO_BASELINE]);
  if (existing) return { seeded: false, reason: "already_present" };
  return seedThread(db, tenant);
}

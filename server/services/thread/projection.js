// Derived Digital Thread projection.
//
// The projection is a read-optimised materialisation of thread nodes keyed by
// business object. It is updated from source events (Object/PDM/BOM/Lifecycle)
// through the `thread.project` job handler and can be rebuilt from scratch. The
// projection is derived data: it never becomes the source of truth.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { resolveRefs } from "./providers.js";
import { ensureProviders } from "./traversal.js";
import { publicProjection, publicProjectionState, parseJson } from "./repository.js";
import { bumpEpoch } from "./cache.js";
import { publishThreadEvent, threadEventCode } from "./events.js";
import { paginate } from "./validation.js";
import { DOMAIN_TYPES, PROJECTION_CONSISTENCY } from "./constants.js";

export const PROJECTION_KEY = "default";

export function getProjection(db, tenantId, objectType, objectId) {
  const row = queryOne(
    db,
    "SELECT * FROM thread_projections WHERE tenant_id = ? AND projection_key = ? AND object_type = ? AND object_id = ?",
    [Number(tenantId), PROJECTION_KEY, String(objectType), String(objectId)]
  );
  return publicProjection(row);
}

export function listProjections(db, tenantId, query = {}) {
  const clauses = ["tenant_id = ?", "projection_key = ?"];
  const params = [Number(tenantId), PROJECTION_KEY];
  if (query.object_type || query.objectType) {
    clauses.push("object_type = ?");
    params.push(String(query.object_type || query.objectType).toLowerCase());
  }
  if (query.status) {
    clauses.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page } = paginate(query, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM thread_projections ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM thread_projections ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicProjection), total, page, page_size: limit, source_module: "thread" };
}

export function projectionState(db, tenantId) {
  const row = queryOne(db, "SELECT * FROM thread_projection_state WHERE tenant_id = ? AND projection_key = ?", [Number(tenantId), PROJECTION_KEY]);
  if (row) return publicProjectionState(row);
  return {
    tenant_id: Number(tenantId),
    projection_key: PROJECTION_KEY,
    consistency: "CURRENT",
    last_event_type: "",
    last_event_at: null,
    processed_count: 0,
    failed_count: 0,
    lag_ms: 0,
    error: "",
    updated_at: null,
  };
}

function upsertState(db, tenantId, { consistency, lastEventType, processedDelta = 0, failedDelta = 0, error = "", lagMs = 0 }) {
  const ts = nowIso();
  run(
    db,
    `INSERT INTO thread_projection_state (tenant_id, projection_key, consistency, last_event_type, last_event_at, processed_count, failed_count, lag_ms, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, projection_key) DO UPDATE SET
       consistency = excluded.consistency,
       last_event_type = excluded.last_event_type,
       last_event_at = excluded.last_event_at,
       processed_count = thread_projection_state.processed_count + excluded.processed_count,
       failed_count = thread_projection_state.failed_count + excluded.failed_count,
       lag_ms = excluded.lag_ms,
       error = excluded.error,
       updated_at = excluded.updated_at`,
    [Number(tenantId), PROJECTION_KEY, consistency, lastEventType || "", ts, Number(processedDelta) || 0, Number(failedDelta) || 0, Number(lagMs) || 0, error || "", ts]
  );
}

function recordProcessed(db, tenantId, { eventId = null, eventType = "", objectType = "", objectId = "", status = "PROCESSED", error = "" }) {
  run(
    db,
    `INSERT OR IGNORE INTO thread_events_processed (tenant_id, projection_key, event_id, event_type, object_type, object_id, status, error, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [Number(tenantId), PROJECTION_KEY, eventId != null ? Number(eventId) : null, eventType || "", objectType || "", objectId || "", status, error || "", nowIso()]
  );
}

// Projects one business object into the derived projection. Safe to call for an
// object that no longer exists (marks the projection STALE).
export function projectObject(db, tenantId, { objectType, objectId, eventType = "" }) {
  ensureProviders();
  const ref = { objectType: String(objectType).toLowerCase(), objectId: String(objectId) };
  const { nodes } = resolveRefs(db, Number(tenantId), [ref], { includeInactive: true });
  const node = nodes.get(`${ref.objectType}:${ref.objectId}`);
  const ts = nowIso();
  if (!node) {
    run(
      db,
      `INSERT INTO thread_projections (tenant_id, projection_key, object_type, object_id, status, node_json, last_event_type, last_event_at, updated_at)
       VALUES (?, ?, ?, ?, 'STALE', '{}', ?, ?, ?)
       ON CONFLICT (tenant_id, projection_key, object_type, object_id) DO UPDATE SET status = 'STALE', last_event_type = excluded.last_event_type, last_event_at = excluded.last_event_at, updated_at = excluded.updated_at`,
      [Number(tenantId), PROJECTION_KEY, ref.objectType, ref.objectId, eventType, ts, ts]
    );
    recordProcessed(db, tenantId, { eventType, objectType: ref.objectType, objectId: ref.objectId, status: "SKIPPED" });
    return null;
  }
  run(
    db,
    `INSERT INTO thread_projections (tenant_id, projection_key, object_type, object_id, status, node_json, last_event_type, last_event_at, updated_at)
     VALUES (?, ?, ?, ?, 'CURRENT', ?, ?, ?, ?)
     ON CONFLICT (tenant_id, projection_key, object_type, object_id) DO UPDATE SET status = 'CURRENT', node_json = excluded.node_json, last_event_type = excluded.last_event_type, last_event_at = excluded.last_event_at, updated_at = excluded.updated_at`,
    [Number(tenantId), PROJECTION_KEY, ref.objectType, ref.objectId, JSON.stringify(node), eventType, ts, ts]
  );
  recordProcessed(db, tenantId, { eventType, objectType: ref.objectType, objectId: ref.objectId, status: "PROCESSED" });
  bumpEpoch(Number(tenantId));
  return node;
}

// Event handler core. `event` is a routed platform event with source object and
// type information. Failures are recorded and never thrown to the caller.
export function handleSourceEvent(db, event = {}) {
  const tenantId = Number(event.tenant_id ?? event.tenantId);
  const objectType = event.source_object_type || event.object_type || event.objectType || "";
  const objectId = event.source_object_id ?? event.object_id ?? event.objectId;
  const eventType = event.event_type_code || event.eventType || "";
  if (!tenantId || !objectType || objectId === null || objectId === undefined) {
    return { skipped: true, reason: "incomplete_event" };
  }
  try {
    const node = projectObject(db, tenantId, { objectType, objectId, eventType });
    upsertState(db, tenantId, { consistency: node ? "CURRENT" : "STALE", lastEventType: eventType, processedDelta: 1 });
    publishThreadEvent(db, { eventType: threadEventCode("PROJECTION_UPDATED"), objectType: "thread_projection", objectId: null, tenantId, payload: { object_type: objectType, object_id: String(objectId), source_event: eventType } }, null);
    return { projected: Boolean(node), object_type: objectType, object_id: String(objectId) };
  } catch (error) {
    try {
      recordProcessed(db, tenantId, { eventType, objectType, objectId: String(objectId), status: "FAILED", error: error.message });
      upsertState(db, tenantId, { consistency: "FAILED", lastEventType: eventType, failedDelta: 1, error: error.message });
      publishThreadEvent(db, { eventType: threadEventCode("PROJECTION_FAILED"), objectType: "thread_projection", objectId: null, tenantId, payload: { object_type: objectType, object_id: String(objectId), error: error.message } }, null);
    } catch {
      // Best-effort error handling.
    }
    return { projected: false, error: error.message };
  }
}

// Object types the projection tracks. Derived from the domain catalog so a new
// domain object type is projected without code changes.
export function projectionObjectTypes() {
  const types = new Set();
  for (const domain of DOMAIN_TYPES) for (const type of domain.object_types) types.add(type);
  return [...types];
}

export function rebuildProjection(db, tenantId, { objectTypes = null, limit = 5000, actor = null } = {}) {
  ensureProviders();
  const tenant = Number(tenantId);
  const types = (objectTypes && objectTypes.length ? objectTypes : projectionObjectTypes()).map((type) => String(type).toLowerCase());
  let processed = 0;
  let failed = 0;
  for (const type of types) {
    const rows = queryAll(
      db,
      `SELECT o.id FROM objects o JOIN metadata_types t ON t.id = o.object_type_id WHERE o.tenant_id = ? AND LOWER(t.code) = ? AND o.deleted_at IS NULL LIMIT ?`,
      [tenant, type, Number(limit)]
    );
    for (const row of rows) {
      try {
        projectObject(db, tenant, { objectType: type, objectId: row.id, eventType: "ProjectionRebuild" });
        processed += 1;
      } catch {
        failed += 1;
      }
    }
  }
  for (const type of ["pdm_item", "pdm_revision"]) {
    const table = type === "pdm_item" ? "pdm_items" : "pdm_item_revisions";
    const rows = queryAll(db, `SELECT id FROM ${table} WHERE tenant_id = ? LIMIT ?`, [tenant, Number(limit)]);
    for (const row of rows) {
      try {
        projectObject(db, tenant, { objectType: type, objectId: row.id, eventType: "ProjectionRebuild" });
        processed += 1;
      } catch {
        failed += 1;
      }
    }
  }
  upsertState(db, tenant, { consistency: failed ? "STALE" : "CURRENT", lastEventType: "ProjectionRebuild", processedDelta: 0, failedDelta: 0 });
  publishThreadEvent(db, { eventType: threadEventCode("PROJECTION_REBUILT"), objectType: "thread_projection", objectId: null, tenantId: tenant, payload: { processed, failed } }, actor);
  return { object_types: types, processed, failed, consistency: failed ? "STALE" : "CURRENT" };
}

export function projectionHealth(db, tenantId) {
  const state = projectionState(db, tenantId);
  const counts = queryOne(
    db,
    "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'CURRENT' THEN 1 ELSE 0 END) AS current, SUM(CASE WHEN status = 'STALE' THEN 1 ELSE 0 END) AS stale, SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed FROM thread_projections WHERE tenant_id = ? AND projection_key = ?",
    [Number(tenantId), PROJECTION_KEY]
  );
  return {
    state,
    counts: {
      total: Number(counts?.total || 0),
      current: Number(counts?.current || 0),
      stale: Number(counts?.stale || 0),
      failed: Number(counts?.failed || 0),
    },
    consistency: PROJECTION_CONSISTENCY.includes(state.consistency) ? state.consistency : "STALE",
  };
}

export { parseJson };

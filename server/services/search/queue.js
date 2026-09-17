// Durable change queue for the search index. Business modules emit lightweight
// change notifications here (no audit, no jobs) so that object mutations never
// pay the cost of indexing or risk failing because of it. The indexer drains
// the queue either inline, from the worker maintenance loop, or via the
// background job engine.
import { run, nowIso, randomUuid } from "../../db.js";

export function enqueueIndexChange(db, input = {}) {
  const tenantId = Number(input.tenantId ?? input.tenant_id);
  const objectType = String(input.objectType ?? input.object_type ?? "").trim();
  const objectId = input.objectId ?? input.object_id;
  if (!Number.isFinite(tenantId) || tenantId <= 0 || !objectType || objectId === undefined || objectId === null) {
    return null;
  }
  const operation = input.operation === "delete" ? "delete" : "upsert";
  const reason = String(input.reason || "change").slice(0, 200);
  const correlationId = String(input.correlationId ?? input.correlation_id ?? randomUuid());
  const ts = nowIso();
  run(
    db,
    `INSERT INTO search_index_status
       (tenant_id, object_type, object_id, operation, reason, status, attempts,
        available_at, correlation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, object_type, object_id) DO UPDATE SET
       operation = excluded.operation,
       reason = excluded.reason,
       status = CASE
         WHEN search_index_status.status = 'processing' THEN search_index_status.status
         ELSE 'pending'
       END,
       attempts = CASE
         WHEN search_index_status.status IN ('failed', 'dead_letter') THEN 0
         ELSE search_index_status.attempts
       END,
       available_at = excluded.available_at,
       correlation_id = excluded.correlation_id,
       last_error = CASE
         WHEN search_index_status.status IN ('failed', 'dead_letter') THEN NULL
         ELSE search_index_status.last_error
       END,
       updated_at = excluded.updated_at`,
    [tenantId, objectType, String(objectId), operation, reason, ts, correlationId, ts, ts]
  );
  return { tenantId, objectType, objectId: String(objectId), operation, reason, correlationId };
}

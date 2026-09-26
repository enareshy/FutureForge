// Ordering Manager.
//
// The framework only enforces ordering where a business requirement demands it
// (for example ProductCreated → ProductUpdated → ProductReleased). Ordering is
// scoped to a partition key so consumers never block on a global lock. Events
// that arrive before an earlier unprocessed event are buffered as
// `out_of_order` until either the gap is filled or the configured timeout
// elapses, after which they are processed regardless and the gap is recorded.
import { queryOne, queryAll, nowIso } from "../../db.js";
import { addSecondsIso } from "./validation.js";

// Allocates the next sequence number within a partition. Called when a
// publishable event is stored so the sequence is stable across retries/replays.
export function nextSequence(db, partitionKey) {
  if (!partitionKey) return null;
  const row = queryOne(db, "SELECT MAX(sequence_number) AS m FROM event_records WHERE partition_key = ?", [partitionKey]);
  return Number(row?.m || 0) + 1;
}

// True when an earlier non-terminal delivery exists for the same partition.
export function findBlockingDelivery(db, delivery) {
  if (!delivery.partition_key || delivery.sequence_number === null || delivery.sequence_number === undefined) return null;
  return queryOne(
    db,
    `SELECT id, event_ref, sequence_number, status, available_at
     FROM event_deliveries
     WHERE partition_key = ?
       AND sequence_number < ?
       AND id != ?
       AND status NOT IN ('delivered','ignored','skipped','duplicate','cancelled','dead_letter','failed')
     ORDER BY sequence_number LIMIT 1`,
    [delivery.partition_key, delivery.sequence_number, delivery.id]
  );
}

// Decides whether a delivery may run now. `buffered` means it was parked as
// out_of_order; `forced` means the ordering timeout elapsed and it must run.
export function orderingDecision(db, delivery, { timeoutSeconds = 30 } = {}) {
  const blocking = findBlockingDelivery(db, delivery);
  if (!blocking) return { ok: true, reason: "in_order", blocking: null };
  const firstSeen = delivery.created_at || nowIso();
  const deadline = new Date(new Date(`${firstSeen}`.replace(" ", "T") + "Z").getTime() + Number(timeoutSeconds) * 1000);
  const timedOut = Number.isFinite(deadline.getTime()) && Date.now() > deadline.getTime();
  if (timedOut) {
    return { ok: true, reason: "ordering_timeout", forced: true, blocking };
  }
  return { ok: false, reason: "out_of_order", blocking, available_at: addSecondsIso(Math.max(1, Number(timeoutSeconds) || 30)) };
}

// Detects a sequence gap for a partition over a window (used by monitoring).
export function detectSequenceGaps(db, { partitionKey, limit = 100 } = {}) {
  if (!partitionKey) return [];
  const rows = queryAll(
    db,
    `SELECT sequence_number FROM event_records WHERE partition_key = ? AND sequence_number IS NOT NULL ORDER BY sequence_number DESC LIMIT ?`,
    [partitionKey, Number(limit)]
  );
  const numbers = rows.map((r) => Number(r.sequence_number)).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] !== numbers[i - 1] + 1) gaps.push({ from: numbers[i - 1], to: numbers[i] });
  }
  return gaps;
}

export function orderingState(db, { tenantId = null } = {}) {
  const clause = tenantId !== undefined && tenantId !== null ? "AND tenant_id = ?" : "";
  const params = tenantId !== undefined && tenantId !== null ? [Number(tenantId)] : [];
  const buffered = queryOne(db, `SELECT COUNT(*) AS c FROM event_deliveries WHERE status = 'out_of_order' ${clause}`, params).c;
  const partitions = queryOne(
    db,
    `SELECT COUNT(DISTINCT partition_key) AS c FROM event_deliveries WHERE partition_key IS NOT NULL ${clause}`,
    params
  ).c;
  return { buffered, partitions };
}

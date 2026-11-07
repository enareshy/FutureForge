// Monitoring surface for the Requirement <-> PLM integration (Prompt 4 section
// 28). Every figure is derived from data the platform already persists
// (requirement relationships, Change Management records, the event outbox, the
// integration hub and the job engine); the integration adds no telemetry store.
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import {
  ALLOCATION_CODES,
  REQUIREMENT_SOURCE_TYPE,
  REQUIREMENT_PDM_INTEGRATION,
  REQUIREMENT_PDM_EVENT_MAP,
  INTEGRATION_STATUSES,
  SOURCE_MODULE,
} from "./constants.js";

const ALLOCATION_PLACEHOLDERS = ALLOCATION_CODES.map(() => "?").join(", ");
const PLM_EVENT_TYPES = [
  REQUIREMENT_PDM_EVENT_MAP.IMPACT_DETECTED,
  REQUIREMENT_PDM_EVENT_MAP.PLM_IMPACT_DETECTED,
  REQUIREMENT_PDM_EVENT_MAP.PLM_CHANGE_SYNCHRONIZED,
  REQUIREMENT_PDM_EVENT_MAP.PLM_SYNCHRONIZATION_FAILED,
];

function marks(count) {
  return Array.from({ length: count }, () => "?").join(", ");
}

// Derives a single integration status from the observed work-queue state.
function deriveStatus({ failed, retrying, processing, pending, deadLetters }) {
  if (deadLetters > 0) return "DEAD_LETTER";
  if (failed > 0) return "FAILED";
  if (processing > 0) return "PROCESSING";
  if (pending > 0) return "PENDING";
  if (retrying > 0) return "RETRYING";
  return "SUCCESS";
}

function shape(tenant, { allocation, changeLinks, autoChange, changeRequests, orders, notices, events, messages, jobs, deadLetters, latency }) {
  const eventOf = (code) => Number(events.get(code) || 0);
  const messageOf = (status) => Number(messages.get(status) || 0);
  const jobsOf = (status) => Number(jobs.get(status) || 0);
  const failed = messageOf("failed");
  const retrying = messageOf("retrying");
  const processing = messageOf("processing");
  const pending = messageOf("pending");
  const status = deriveStatus({ failed, retrying, processing, pending, deadLetters });
  return {
    source_module: SOURCE_MODULE,
    tenant_id: tenant,
    generated_at: new Date().toISOString(),
    status,
    allowed_statuses: [...INTEGRATION_STATUSES],
    allocations: {
      total: Number(allocation?.c || 0),
      requirements: Number(allocation?.r || 0),
    },
    change_links: {
      total: Number(changeLinks?.c || 0),
      automatic: Number(autoChange?.c || 0),
    },
    change_requests: { total: Number(changeRequests?.c || 0) },
    change_orders: { total: orders },
    change_notices: { total: notices },
    events: {
      impact_detected: eventOf(REQUIREMENT_PDM_EVENT_MAP.IMPACT_DETECTED) + eventOf(REQUIREMENT_PDM_EVENT_MAP.PLM_IMPACT_DETECTED),
      synchronized: eventOf(REQUIREMENT_PDM_EVENT_MAP.PLM_CHANGE_SYNCHRONIZED),
      failures: eventOf(REQUIREMENT_PDM_EVENT_MAP.PLM_SYNCHRONIZATION_FAILED),
    },
    messages: {
      pending,
      processing,
      completed: messageOf("completed") + messageOf("delivered") + messageOf("processed"),
      failed,
      retrying,
    },
    jobs: {
      pending: jobsOf("created") + jobsOf("queued") + jobsOf("scheduled") + jobsOf("waiting_for_dependency"),
      running: jobsOf("running"),
      completed: jobsOf("completed"),
      failed: jobsOf("failed") + jobsOf("timed_out"),
      retrying: jobsOf("retrying"),
    },
    dead_letters: deadLetters,
    event_latency_seconds: latency,
  };
}

function linksQuery() {
  return `SELECT DISTINCT target_id FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type = 'CHANGED_BY' AND target_type = 'change_request'`;
}

function finalShape(tenant, base, linked, one, db) {
  const requestIds = (linked || []).map((row) => Number(row.target_id)).filter((id) => Number.isInteger(id));
  let orders = 0;
  let notices = 0;
  if (requestIds.length) {
    const orderRow = one(db, `SELECT COUNT(*) AS c FROM change_orders WHERE tenant_id = ? AND change_request_id IN (${marks(requestIds.length)})`, [tenant, ...requestIds]);
    orders = Number(orderRow?.c || 0);
    const noticeRow = one(
      db,
      `SELECT COUNT(*) AS c FROM change_notices WHERE tenant_id = ? AND change_order_id IN (SELECT id FROM change_orders WHERE tenant_id = ? AND change_request_id IN (${marks(requestIds.length)}))`,
      [tenant, tenant, ...requestIds]
    );
    notices = Number(noticeRow?.c || 0);
  }
  return shape(tenant, { ...base, orders, notices });
}

function collect(queryOneF, queryAllF, db, tenant) {
  const allocation = queryOneF(
    db,
    `SELECT COUNT(*) AS c, COUNT(DISTINCT source_id) AS r FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type IN (${ALLOCATION_PLACEHOLDERS}) AND status = 'ACTIVE'`,
    [tenant, ...ALLOCATION_CODES]
  );
  const changeLinks = queryOneF(
    db,
    `SELECT COUNT(*) AS c FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type = 'CHANGED_BY' AND status = 'ACTIVE'`,
    [tenant]
  );
  const autoChange = queryOneF(
    db,
    `SELECT COUNT(*) AS c FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type = 'CHANGED_BY' AND status = 'ACTIVE' AND attributes_json LIKE '%"auto":true%'`,
    [tenant]
  );
  const changeRequests = queryOneF(
    db,
    `SELECT COUNT(DISTINCT target_id) AS c FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type = 'CHANGED_BY' AND target_type = 'change_request' AND status = 'ACTIVE'`,
    [tenant]
  );
  const linked = queryAllF(db, linksQuery(), [tenant]);
  const eventRows = queryAllF(
    db,
    `SELECT event_type_code, COUNT(*) AS c FROM event_outbox WHERE tenant_id = ? AND event_type_code IN (${marks(PLM_EVENT_TYPES.length)}) GROUP BY event_type_code`,
    [tenant, ...PLM_EVENT_TYPES]
  );
  const events = new Map(eventRows.map((row) => [row.event_type_code, Number(row.c || 0)]));
  const messageRows = queryAllF(
    db,
    "SELECT status, COUNT(*) AS c FROM integration_messages WHERE tenant_id = ? AND message_type = ? GROUP BY status",
    [tenant, REQUIREMENT_PDM_INTEGRATION.plmSyncHandler]
  );
  const messages = new Map(messageRows.map((row) => [row.status, Number(row.c || 0)]));
  const jobRows = queryAllF(
    db,
    "SELECT status, COUNT(*) AS c FROM jobs WHERE tenant_id = ? AND source_module = ? GROUP BY status",
    [tenant, SOURCE_MODULE]
  );
  const jobs = new Map(jobRows.map((row) => [row.status, Number(row.c || 0)]));
  const deadRow = queryOneF(db, "SELECT COUNT(*) AS c FROM integration_dead_letters WHERE tenant_id = ? AND status IN ('open', 'retrying')", [tenant]);
  const latencyRow = queryOneF(
    db,
    "SELECT AVG(EXTRACT(EPOCH FROM (published_at::timestamp - created_at::timestamp))) AS avg FROM event_outbox WHERE tenant_id = ? AND published_at IS NOT NULL",
    [tenant]
  );
  return finalShape(
    tenant,
    {
      allocation,
      changeLinks,
      autoChange,
      changeRequests,
      events,
      messages,
      jobs,
      deadLetters: Number(deadRow?.c || 0),
      latency: latencyRow?.avg === null || latencyRow?.avg === undefined ? null : Number(latencyRow.avg),
    },
    linked,
    queryOneF,
    db
  );
}

async function collectAsync(db, tenant) {
  const allocation = await queryOneAsync(
    db,
    `SELECT COUNT(*) AS c, COUNT(DISTINCT source_id) AS r FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type IN (${ALLOCATION_PLACEHOLDERS}) AND status = 'ACTIVE'`,
    [tenant, ...ALLOCATION_CODES]
  );
  const changeLinks = await queryOneAsync(
    db,
    `SELECT COUNT(*) AS c FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type = 'CHANGED_BY' AND status = 'ACTIVE'`,
    [tenant]
  );
  const autoChange = await queryOneAsync(
    db,
    `SELECT COUNT(*) AS c FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type = 'CHANGED_BY' AND status = 'ACTIVE' AND attributes_json LIKE '%"auto":true%'`,
    [tenant]
  );
  const changeRequests = await queryOneAsync(
    db,
    `SELECT COUNT(DISTINCT target_id) AS c FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type = 'CHANGED_BY' AND target_type = 'change_request' AND status = 'ACTIVE'`,
    [tenant]
  );
  const linked = await queryAllAsync(db, linksQuery(), [tenant]);
  const eventRows = await queryAllAsync(
    db,
    `SELECT event_type_code, COUNT(*) AS c FROM event_outbox WHERE tenant_id = ? AND event_type_code IN (${marks(PLM_EVENT_TYPES.length)}) GROUP BY event_type_code`,
    [tenant, ...PLM_EVENT_TYPES]
  );
  const events = new Map(eventRows.map((row) => [row.event_type_code, Number(row.c || 0)]));
  const messageRows = await queryAllAsync(
    db,
    "SELECT status, COUNT(*) AS c FROM integration_messages WHERE tenant_id = ? AND message_type = ? GROUP BY status",
    [tenant, REQUIREMENT_PDM_INTEGRATION.plmSyncHandler]
  );
  const messages = new Map(messageRows.map((row) => [row.status, Number(row.c || 0)]));
  const jobRows = await queryAllAsync(
    db,
    "SELECT status, COUNT(*) AS c FROM jobs WHERE tenant_id = ? AND source_module = ? GROUP BY status",
    [tenant, SOURCE_MODULE]
  );
  const jobs = new Map(jobRows.map((row) => [row.status, Number(row.c || 0)]));
  const deadRow = await queryOneAsync(db, "SELECT COUNT(*) AS c FROM integration_dead_letters WHERE tenant_id = ? AND status IN ('open', 'retrying')", [tenant]);
  const latencyRow = await queryOneAsync(
    db,
    "SELECT AVG(EXTRACT(EPOCH FROM (published_at::timestamp - created_at::timestamp))) AS avg FROM event_outbox WHERE tenant_id = ? AND published_at IS NOT NULL",
    [tenant]
  );
  const requestIds = (linked || []).map((row) => Number(row.target_id)).filter((id) => Number.isInteger(id));
  let orders = 0;
  let notices = 0;
  if (requestIds.length) {
    const orderRow = await queryOneAsync(db, `SELECT COUNT(*) AS c FROM change_orders WHERE tenant_id = ? AND change_request_id IN (${marks(requestIds.length)})`, [tenant, ...requestIds]);
    orders = Number(orderRow?.c || 0);
    const noticeRow = await queryOneAsync(
      db,
      `SELECT COUNT(*) AS c FROM change_notices WHERE tenant_id = ? AND change_order_id IN (SELECT id FROM change_orders WHERE tenant_id = ? AND change_request_id IN (${marks(requestIds.length)}))`,
      [tenant, tenant, ...requestIds]
    );
    notices = Number(noticeRow?.c || 0);
  }
  return shape(tenant, {
    allocation,
    changeLinks,
    autoChange,
    changeRequests,
    orders,
    notices,
    events,
    messages,
    jobs,
    deadLetters: Number(deadRow?.c || 0),
    latency: latencyRow?.avg === null || latencyRow?.avg === undefined ? null : Number(latencyRow.avg),
  });
}

export function plmMetrics(db, tenantId) {
  const tenant = Number(tenantId);
  return collect(queryOne, queryAll, db, tenant);
}

export async function plmMetricsAsync(db, tenantId) {
  const tenant = Number(tenantId);
  return collectAsync(db, tenant);
}

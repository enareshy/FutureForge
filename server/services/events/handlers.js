// Handler abstraction and registry.
//
// A handler is the business action taken for an event ("update the search
// index", "notify configured users", "start a workflow", "forward to the
// Integration Hub"). Handlers belong to the consuming module; the framework
// only routes to them and guarantees at-least-once delivery with idempotency.
import { queryAll, queryOne } from "../../db.js";
import { writeAudit } from "../audit.js";
import { safeParse } from "./validation.js";
import { log } from "./hooks.js";

const registry = new Map();

export function registerHandler(code, handler, options = {}) {
  const key = String(code || "").trim().toLowerCase();
  if (!key) throw new Error("Handler code is required");
  if (typeof handler !== "function") throw new Error(`Handler ${key} must be a function`);
  registry.set(key, {
    code: key,
    handler,
    description: String(options.description || ""),
    module: String(options.module || "platform"),
    builtin: Boolean(options.builtin),
  });
  return registry.get(key);
}

export function unregisterHandler(code) {
  return registry.delete(String(code || "").trim().toLowerCase());
}

export function getHandler(code) {
  return registry.get(String(code || "").trim().toLowerCase()) || null;
}

export function hasHandler(code) {
  return registry.has(String(code || "").trim().toLowerCase());
}

export function listHandlers() {
  return [...registry.values()].map((entry) => ({
    code: entry.code,
    description: entry.description,
    module: entry.module,
    builtin: entry.builtin,
  }));
}

export function clearHandlers() {
  registry.clear();
}

// Invokes a registered handler. Unknown handlers are a configuration error and
// are surfaced as such so they dead-letter immediately instead of retrying.
export async function invokeHandler(db, code, context = {}) {
  const entry = getHandler(code);
  if (!entry) {
    const error = new Error(`No handler registered for ${code}`);
    error.category = "configuration";
    error.code = "handler_not_registered";
    throw error;
  }
  return entry.handler({ db, ...context });
}

// ── Built-in handlers ───────────────────────────────────────────────────────
// These are thin, provider-independent bridges to other platform modules. They
// are deliberately best-effort for optional targets (notifications, workflow)
// and idempotent so redelivery is safe.
function registerBuiltinHandlers() {
  registerHandler(
    "search.index",
    async ({ db, event, payload, subscription, delivery }) => {
      const { emitObjectChanged } = await import("../search/hooks.js");
      await emitObjectChanged(db, {
        objectType: event.source_object_type || event.event_type_code,
        object: {
          type: event.source_object_type || event.event_type_code,
          id: event.source_object_id || event.event_ref,
          name: payload?.name || payload?.title || null,
          revision: event.source_object_revision || null,
          tenant_id: event.tenant_id,
          organization_id: event.organization_id,
        },
        operation: operationFor(event.event_type_code),
        reason: `event:${event.event_type_code}`,
        actor: null,
      });
      return { indexed: true, object_id: event.source_object_id || event.event_ref };
    },
    { description: "Update the search index for the affected object", module: "search", builtin: true }
  );

  registerHandler(
    "notification.dispatch",
    async ({ db, event, payload }) => {
      const notifications = await import("../notifications.js");
      const result = notifications.publish(
        db,
        {
          event_type: event.event_type_code,
          source_module: event.source_module,
          tenant_id: event.tenant_id,
          organization_id: event.organization_id,
          plant_id: event.plant_id,
          site_id: event.site_id,
          object_type: event.source_object_type,
          object_id: event.source_object_id,
          object_name: payload?.name || payload?.title || null,
          payload,
          correlation_id: event.correlation_id,
          idempotency_key: `event:${event.event_ref}`,
        },
        { actor: null }
      );
      return { published: result.published, notifications: result.notifications?.length || 0 };
    },
    { description: "Dispatch notifications for the event", module: "notifications", builtin: true }
  );

  registerHandler(
    "workflow.trigger",
    async ({ db, event, payload, delivery }) => {
      const workflow = await import("../workflow.js");
      if (typeof workflow.triggerEvent !== "function") return { skipped: true, reason: "workflow trigger unavailable" };
      const result = await workflow.triggerEvent(
        db,
        {
          event: event.event_type_code,
          object_type: event.source_object_type,
          object_id: event.source_object_id,
          payload,
          tenant_id: event.tenant_id,
          correlation_id: event.correlation_id || delivery?.correlation_id,
        },
        { actor: null }
      );
      return { triggered: result?.triggered ?? result?.instances?.length ?? 0 };
    },
    { description: "Evaluate workflow bindings for the event", module: "workflow", builtin: true }
  );

  registerHandler(
    "integration.forward",
    async ({ db, event, payload }) => {
      const integration = await import("../integration.js");
      const result = integration.Events.publishEvent(
        db,
        {
          event_type_code: event.event_type_code,
          payload,
          source_module: event.source_module,
          correlation_id: event.correlation_id,
          organization_id: event.organization_id,
          metadata: {
            ...safeParse(event.metadata_json, {}),
            parent_event_ref: event.event_ref,
            trace_id: event.trace_id,
          },
        },
        null
      );
      return { forwarded: true, integration_event_ref: result.event_ref, subscribers: result.deliveries?.length || 0 };
    },
    { description: "Forward the event to the Integration Hub", module: "integration", builtin: true }
  );

  registerHandler(
    "analytics.record",
    async ({ event, payload }) => {
      // Analytics owns the sink; this handler records a compact fact that the
      // analytics module can pick up from the delivery history.
      return {
        recorded: true,
        metric: event.event_type_code,
        category: event.source_module,
        occurred_at: event.occurred_at,
        dimensions: {
          object_type: event.source_object_type,
          object_id: event.source_object_id,
          priority: event.priority,
        },
        measure: Number(payload?.value ?? 1),
      };
    },
    { description: "Record the event as an analytics fact", module: "analytics", builtin: true }
  );

  registerHandler(
    "audit.record",
    async ({ db, event, payload, actor }) => {
      writeAudit(db, {
        actor,
        action: `event.${event.event_type_code}`,
        resourceType: event.source_object_type || "event",
        resourceId: event.source_object_id || event.event_ref,
        details: { event_ref: event.event_ref, correlation_id: event.correlation_id, payload: undefined },
        source: "events",
        correlationId: event.correlation_id,
        eventType: event.event_type_code,
      });
      return { audited: true };
    },
    { description: "Write an audit entry for the event", module: "audit", builtin: true }
  );
}

function operationFor(eventTypeCode) {
  const code = String(eventTypeCode || "").toLowerCase();
  if (code.includes("deleted") || code.includes("removed")) return "delete";
  if (code.includes("created") || code.includes("started")) return "create";
  return "upsert";
}

registerBuiltinHandlers();

// ── Handler monitoring ──────────────────────────────────────────────────────
export function handlerStats(db, { tenantId = null, windowHours = 24 } = {}) {
  const since = new Date(Date.now() - Number(windowHours || 24) * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const clause = tenantId !== undefined && tenantId !== null ? "AND tenant_id = ?" : "";
  const params = tenantId !== undefined && tenantId !== null ? [since, Number(tenantId)] : [since];
  const rows = queryAll(
    db,
    `SELECT
       COALESCE(NULLIF(handler,''),'(unbound)') AS handler,
       event_type_code,
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS succeeded,
       SUM(CASE WHEN status IN ('failed','dead_letter') THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retrying,
       SUM(CASE WHEN status = 'duplicate' THEN 1 ELSE 0 END) AS duplicates,
       SUM(CASE WHEN status = 'out_of_order' THEN 1 ELSE 0 END) AS out_of_order,
       SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) AS retried,
       AVG(duration_ms) AS avg_duration_ms,
       MAX(duration_ms) AS max_duration_ms,
       MAX(delivered_at) AS last_success_at,
       MAX(updated_at) AS last_activity_at
     FROM event_deliveries
     WHERE updated_at >= ? ${clause}
     GROUP BY handler, event_type_code
     ORDER BY failed DESC, total DESC`,
    params
  );
  return rows.map((r) => ({
    handler: r.handler,
    event_type_code: r.event_type_code,
    registered: r.handler !== "(unbound)" && hasHandler(r.handler),
    total: r.total,
    succeeded: r.succeeded || 0,
    failed: r.failed || 0,
    retrying: r.retrying || 0,
    duplicates: r.duplicates || 0,
    out_of_order: r.out_of_order || 0,
    retried: r.retried || 0,
    avg_duration_ms: r.avg_duration_ms ? Math.round(r.avg_duration_ms) : null,
    max_duration_ms: r.max_duration_ms ?? null,
    success_rate: r.total ? Number((((r.succeeded || 0) / r.total) * 100).toFixed(2)) : null,
    last_success_at: r.last_success_at || null,
    last_activity_at: r.last_activity_at || null,
  }));
}

export function slowHandlers(db, { tenantId = null, windowHours = 24, limit = 10 } = {}) {
  return handlerStats(db, { tenantId, windowHours })
    .filter((row) => row.avg_duration_ms !== null)
    .sort((a, b) => (b.avg_duration_ms || 0) - (a.avg_duration_ms || 0))
    .slice(0, Number(limit));
}

export function handlerDetail(db, code, { tenantId = null, windowHours = 24 } = {}) {
  const entry = getHandler(code);
  const stats = handlerStats(db, { tenantId, windowHours }).filter((row) => row.handler === code);
  const recent = queryAll(
    db,
    `SELECT * FROM event_deliveries WHERE handler = ? ORDER BY updated_at DESC LIMIT 25`,
    [code]
  );
  if (!entry && !stats.length) {
    log("warn", "event.handler.unknown", { handler: code });
  }
  return {
    handler: code,
    registered: Boolean(entry),
    description: entry?.description || "",
    module: entry?.module || "",
    builtin: Boolean(entry?.builtin),
    stats,
    recent_delivery_ids: recent.map((r) => r.id),
  };
}

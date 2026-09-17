// Audit event publishing. The audit framework emits lifecycle and
// classification events (AuditEventCreated, AuditPolicyChanged,
// AuditExportRequested/Completed, AuditRetentionStarted/Completed) so other
// platform capabilities can react without polling the audit store.
//
// Delivery is deliberately decoupled: consumers subscribe with `onAuditEvent`
// (used by tests and embedders) or register the optional notifications bridge
// via `createNotificationBridge`. Publishing is best-effort and never affects
// the audit write path.

export const AUDIT_EVENT_TYPES = {
  EVENT_CREATED: "audit.event.created",
  POLICY_CHANGED: "audit.policy.changed",
  EXPORT_REQUESTED: "audit.export.requested",
  EXPORT_COMPLETED: "audit.export.completed",
  RETENTION_STARTED: "audit.retention.started",
  RETENTION_COMPLETED: "audit.retention.completed",
};

const listeners = new Set();

// Subscribes to all audit lifecycle events. Returns an unsubscribe function.
export function onAuditEvent(listener) {
  if (typeof listener !== "function") throw new TypeError("listener must be a function");
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function safeLog(event, fields) {
  try {
    console.log(JSON.stringify({ level: "error", scope: "audit.publisher", event, ...fields }));
  } catch {
    /* logging must never throw */
  }
}

export function publishAuditEvent(eventType, payload = {}) {
  const event = { event_type: eventType, ...payload };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      safeLog("listener.failed", { message: err?.message, event_type: eventType });
    }
  }
  return event;
}

// Registers the audit-to-notifications bridge. `db` is used by the
// notifications module to resolve rules, templates and recipients. Enable in a
// deployment by calling this once during bootstrap (see app.js / worker).
export function createNotificationBridge(db, { minSeverity = "confidential" } = {}) {
  const severityRank = { public: 0, internal: 1, confidential: 2, restricted: 3 };
  const threshold = severityRank[minSeverity] ?? 2;
  const significant = new Set([
    AUDIT_EVENT_TYPES.EVENT_CREATED,
    AUDIT_EVENT_TYPES.POLICY_CHANGED,
    AUDIT_EVENT_TYPES.EXPORT_REQUESTED,
    AUDIT_EVENT_TYPES.EXPORT_COMPLETED,
    AUDIT_EVENT_TYPES.RETENTION_STARTED,
    AUDIT_EVENT_TYPES.RETENTION_COMPLETED,
  ]);
  return onAuditEvent(async (event) => {
    try {
      if (!significant.has(event.event_type)) return;
      const rank = severityRank[event.security_classification] ?? 1;
      if (event.event_type === AUDIT_EVENT_TYPES.EVENT_CREATED && rank < threshold) return;
      const { publish } = await import("../notifications.js");
      publish(
        db,
        {
          event_type: event.event_type,
          source_module: "audit",
          tenant_id: event.tenant_id ?? null,
          organization_id: event.organization_id ?? null,
          object_type: event.object_type || "audit_event",
          object_id: event.object_id == null ? "" : String(event.object_id),
          object_name: event.object_name || "",
          payload: event,
        },
        { actor: event.actor || null, ip: event.ip || null }
      );
    } catch (err) {
      safeLog("bridge.failed", { message: err?.message, event_type: event.event_type });
    }
  });
}

export function listenerCount() {
  return listeners.size;
}

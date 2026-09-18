// Domain event emitter.
//
// Business modules call this to publish a domain event through the Event &
// Messaging Framework instead of calling other modules directly. It uses the
// Transactional Outbox by default so the event is persisted in the caller's
// transaction (when one is open) and delivered asynchronously by the worker.
//
// Emission is best-effort, mirroring the platform's other change hooks: a
// framework hiccup (for example a disabled event type) must never fail the
// business write. Modules that require strict atomicity can call
// `Events.publish` directly.
import { publishEvent } from "./publisher.js";
import { log } from "./hooks.js";

function typeCodeOf(input) {
  return input.event_type_code || input.eventTypeCode || input.event_type || input.eventType || null;
}

export function emitDomainEvent(db, input = {}, actor = null, options = {}) {
  const eventTypeCode = typeCodeOf(input);
  if (!eventTypeCode) {
    log("warn", "event.domain.emit_skipped", { reason: "missing_event_type" });
    return null;
  }
  try {
    return publishEvent(db, { ...input, event_type_code: eventTypeCode }, actor, {
      useOutbox: true,
      ...options,
    });
  } catch (error) {
    log("warn", "event.domain.emit_failed", { event_type: eventTypeCode, error: error.message });
    return null;
  }
}

// Convenience wrapper for object-centric events. Callers pass the persisted
// object row plus the event code and optional extra payload fields.
export function emitObjectEvent(db, row, eventTypeCode, extra = {}, actor = null) {
  if (!row) return null;
  return emitDomainEvent(
    db,
    {
      event_type_code: eventTypeCode,
      source_module: extra.source_module || "objects",
      source_object_type: extra.source_object_type || "object",
      source_object_id: row.id,
      source_object_revision: row.revision,
      organization_id: row.organization_id ?? null,
      tenant_id: row.tenant_id ?? null,
      payload: {
        id: row.id,
        code: row.code,
        name: row.name,
        status: row.status,
        revision: row.revision,
        ...extra.payload,
      },
      metadata: extra.metadata,
      correlation_id: extra.correlation_id,
      idempotency_key: extra.idempotency_key,
    },
    actor
  );
}

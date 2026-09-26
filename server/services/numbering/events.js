// Domain events published by the Numbering Service. Registration is idempotent
// and safe on every boot; emission is best-effort through the shared Event &
// Messaging Framework (transactional outbox), so an event hiccup never fails an
// allocation.
import { emitDomainEvent } from "../events/emit.js";
import { createEventType, getEventTypeRow } from "../events/registry.js";

export const NUMBERING_EVENT_TYPES = [
  { code: "NumberAllocated", category: "system", source_module: "numbering", description: "A number was allocated from a numbering scheme." },
  { code: "NumberReserved", category: "system", source_module: "numbering", description: "A number was reserved ahead of object creation." },
  { code: "NumberConsumed", category: "system", source_module: "numbering", description: "An allocated number was consumed by a business object." },
  { code: "NumberReleased", category: "system", source_module: "numbering", description: "A reserved number was released back to policy." },
  { code: "NumberExpired", category: "system", source_module: "numbering", description: "A reservation expired without being consumed." },
  { code: "NumberCancelled", category: "system", source_module: "numbering", description: "An allocation was cancelled before consumption." },
  { code: "NumberingSchemeCreated", category: "system", source_module: "numbering", description: "A numbering scheme was created." },
  { code: "NumberingSchemeChanged", category: "system", source_module: "numbering", description: "A numbering scheme was modified and a new version recorded." },
  { code: "NumberingSchemeActivated", category: "system", source_module: "numbering", description: "A numbering scheme was activated." },
  { code: "NumberingSchemeDeactivated", category: "system", source_module: "numbering", description: "A numbering scheme was deactivated or retired." },
];

export function ensureNumberingEventTypes(db) {
  let created = 0;
  for (const type of NUMBERING_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(db, { ...type, system: true, status: "active", enabled: true }, null, null);
    created += 1;
  }
  return created;
}

function baseAllocationEvent(input = {}) {
  return {
    source_module: "numbering",
    source_object_type: "numbering_allocation",
    source_object_id: input.allocationId ?? null,
    tenant_id: input.tenantId ?? null,
    organization_id: input.organizationId ?? null,
    correlation_id: input.correlationId ?? null,
    idempotency_key: input.idempotencyKey ?? null,
  };
}

export function emitNumberAllocated(db, allocation, actor = null) {
  if (!allocation) return null;
  return emitDomainEvent(
    db,
    {
      ...baseAllocationEvent({
        allocationId: allocation.id,
        tenantId: allocation.tenant_id,
        organizationId: allocation.organization_id,
        correlationId: allocation.correlation_id,
        idempotencyKey: allocation.idempotency_key,
      }),
      event_type_code: "NumberAllocated",
      payload: {
        allocation_id: allocation.id,
        allocation_ref: allocation.allocation_ref,
        number: allocation.number,
        object_type: allocation.object_type_code,
        object_id: allocation.object_id,
        scheme_id: allocation.scheme_id,
        scheme_version: allocation.scheme_version,
        sequence_value: allocation.sequence_value,
        status: allocation.status,
        scope_key: allocation.scope_key,
        is_manual: allocation.is_manual,
      },
    },
    actor
  );
}

export function emitNumberReserved(db, allocation, actor = null) {
  if (!allocation) return null;
  return emitDomainEvent(
    db,
    {
      ...baseAllocationEvent({
        allocationId: allocation.id,
        tenantId: allocation.tenant_id,
        organizationId: allocation.organization_id,
        correlationId: allocation.correlation_id,
      }),
      event_type_code: "NumberReserved",
      payload: {
        allocation_id: allocation.id,
        allocation_ref: allocation.allocation_ref,
        number: allocation.number,
        object_type: allocation.object_type_code,
        expires_at: allocation.expires_at,
        scope_key: allocation.scope_key,
      },
    },
    actor
  );
}

export function emitNumberConsumed(db, allocation, actor = null) {
  if (!allocation) return null;
  return emitDomainEvent(
    db,
    {
      ...baseAllocationEvent({
        allocationId: allocation.id,
        tenantId: allocation.tenant_id,
        organizationId: allocation.organization_id,
        correlationId: allocation.correlation_id,
      }),
      event_type_code: "NumberConsumed",
      payload: {
        allocation_id: allocation.id,
        allocation_ref: allocation.allocation_ref,
        number: allocation.number,
        object_type: allocation.object_type_code,
        object_id: allocation.object_id,
        object_ref: allocation.object_ref,
        consumed_by: allocation.consumed_by,
        scope_key: allocation.scope_key,
      },
    },
    actor
  );
}

export function emitNumberReleased(db, allocation, actor = null) {
  if (!allocation) return null;
  return emitDomainEvent(
    db,
    {
      ...baseAllocationEvent({
        allocationId: allocation.id,
        tenantId: allocation.tenant_id,
        organizationId: allocation.organization_id,
        correlationId: allocation.correlation_id,
      }),
      event_type_code: "NumberReleased",
      payload: {
        allocation_id: allocation.id,
        allocation_ref: allocation.allocation_ref,
        number: allocation.number,
        object_type: allocation.object_type_code,
        reusable: allocation.reusable,
        reason: allocation.reason,
        scope_key: allocation.scope_key,
      },
    },
    actor
  );
}

export function emitNumberExpired(db, allocation, actor = null) {
  if (!allocation) return null;
  return emitDomainEvent(
    db,
    {
      ...baseAllocationEvent({
        allocationId: allocation.id,
        tenantId: allocation.tenant_id,
        organizationId: allocation.organization_id,
      }),
      event_type_code: "NumberExpired",
      payload: {
        allocation_id: allocation.id,
        allocation_ref: allocation.allocation_ref,
        number: allocation.number,
        object_type: allocation.object_type_code,
        reusable: allocation.reusable,
        scope_key: allocation.scope_key,
      },
    },
    actor
  );
}

export function emitNumberCancelled(db, allocation, actor = null) {
  if (!allocation) return null;
  return emitDomainEvent(
    db,
    {
      ...baseAllocationEvent({
        allocationId: allocation.id,
        tenantId: allocation.tenant_id,
        organizationId: allocation.organization_id,
      }),
      event_type_code: "NumberCancelled",
      payload: {
        allocation_id: allocation.id,
        allocation_ref: allocation.allocation_ref,
        number: allocation.number,
        reason: allocation.reason,
        scope_key: allocation.scope_key,
      },
    },
    actor
  );
}

export function emitSchemeEvent(db, code, scheme, actor = null) {
  if (!scheme) return null;
  return emitDomainEvent(
    db,
    {
      source_module: "numbering",
      source_object_type: "numbering_scheme",
      source_object_id: scheme.id,
      tenant_id: scheme.tenant_id ?? null,
      event_type_code: code,
      payload: {
        scheme_id: scheme.id,
        code: scheme.code,
        name: scheme.name,
        object_type: scheme.object_type_code,
        status: scheme.status,
        version: scheme.current_version,
        pattern: scheme.pattern,
      },
    },
    actor
  );
}

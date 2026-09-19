// Domain events published by the Effectivity & Versioning Kernel. Registration
// is idempotent and safe on every boot; emission is best-effort through the
// shared Event & Messaging Framework (transactional outbox).
import { createEventType, getEventTypeRow } from "../events/registry.js";

export const VERSIONING_EVENT_TYPES = [
  { code: "RevisionCreated", category: "product", source_module: "versioning", description: "A revision was created." },
  { code: "RevisionChanged", category: "product", source_module: "versioning", description: "Revision metadata changed." },
  { code: "RevisionActivated", category: "product", source_module: "versioning", description: "A revision was activated.", ordering_scope: "object", ordering_required: true },
  { code: "RevisionSuperseded", category: "product", source_module: "versioning", description: "A revision was superseded.", ordering_scope: "object", ordering_required: true },
  { code: "VersionCreated", category: "product", source_module: "versioning", description: "A version was created." },
  { code: "VersionActivated", category: "product", source_module: "versioning", description: "A version was activated.", ordering_scope: "object", ordering_required: true },
  { code: "VersionSuperseded", category: "product", source_module: "versioning", description: "A version was superseded.", ordering_scope: "object", ordering_required: true },
  { code: "EffectivityCreated", category: "product", source_module: "versioning", description: "An effectivity definition was created." },
  { code: "EffectivityChanged", category: "product", source_module: "versioning", description: "Effectivity was changed or assigned." },
  { code: "EffectivityExpired", category: "product", source_module: "versioning", description: "An effectivity range expired." },
  { code: "BaselineCreated", category: "product", source_module: "versioning", description: "A baseline was created." },
  { code: "BaselineFrozen", category: "product", source_module: "versioning", description: "A baseline was frozen.", ordering_scope: "object", ordering_required: true },
  { code: "SnapshotCreated", category: "product", source_module: "versioning", description: "A historical snapshot was created." },
  { code: "VariantCreated", category: "product", source_module: "versioning", description: "A variant was created." },
  { code: "VariantChanged", category: "product", source_module: "versioning", description: "A variant or its options/rules changed." },
  { code: "ConfigurationContextCreated", category: "product", source_module: "versioning", description: "A configuration context was created." },
  { code: "ConfigurationContextChanged", category: "product", source_module: "versioning", description: "A configuration context changed." },
];

export function ensureVersioningEventTypes(db) {
  let created = 0;
  for (const type of VERSIONING_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(db, { ...type, system: true, status: "active", enabled: true }, null, null);
    created += 1;
  }
  return created;
}

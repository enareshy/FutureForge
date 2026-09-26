// Change hooks called by business modules. They are intentionally tiny and
// best-effort: a search indexing hiccup must never fail the business write.
import { enqueueIndexChange } from "./queue.js";
import { isRegisteredObjectType, isSearchEnabled } from "./state.js";

export function emitObjectIndexChange(db, input = {}) {
  try {
    if (!isSearchEnabled()) return null;
    const objectType = String(input.objectType ?? input.object_type ?? "");
    if (!objectType || !isRegisteredObjectType(objectType)) return null;
    return enqueueIndexChange(db, {
      tenantId: input.tenantId ?? input.tenant_id,
      objectType,
      objectId: input.objectId ?? input.object_id,
      operation: input.operation,
      reason: input.reason,
      correlationId: input.correlationId ?? input.correlation_id,
    });
  } catch {
    return null;
  }
}

export function emitObjectChanged(db, { objectType = "object", object, operation = "upsert", reason = "object", actor } = {}) {
  if (!object) return null;
  return emitObjectIndexChange(db, {
    tenantId: object.tenant_id ?? actor?.tenant_id,
    objectType,
    objectId: object.id,
    operation,
    reason,
  });
}

export function emitFileChanged(db, { file, operation = "upsert", reason = "file" } = {}) {
  if (!file) return null;
  return emitObjectIndexChange(db, {
    tenantId: file.tenant_id,
    objectType: "file",
    objectId: file.id,
    operation,
    reason,
  });
}

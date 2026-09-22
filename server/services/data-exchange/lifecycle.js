// Lifecycle & Archival integration (spec §56). The framework never re-implements
// lifecycle rules; it asks the P1 Data Lifecycle service what the current state
// allows. States carry `update`/`export` capability flags, so an administrator
// can change the policy without a deployment.
import { DataLifecycle } from "../data-lifecycle/index.js";
import { lifecycleBlocked } from "./errors.js";

export function lifecycleStateOf(db, tenantId, objectType, objectId) {
  if (!objectType || objectId === null || objectId === undefined || objectId === "") return null;
  try {
    const row = DataLifecycle.getObject(db, tenantId, objectType, objectId);
    return row?.current_state || null;
  } catch {
    // Not every object type is onboarded to lifecycle management.
    return null;
  }
}

export function stateCapabilitiesFor(db, tenantId, state) {
  if (!state) return null;
  try {
    return DataLifecycle.stateCapabilities(db, tenantId, state);
  } catch {
    return null;
  }
}

// Import guard: refuse to write into a state whose update capability is off
// (for example ARCHIVED / COLD_STORAGE / PURGED) unless an explicit recovery
// operation sets `permit`.
export function assertImportStateAllowed(db, tenantId, { objectType, objectId, permit = false } = {}) {
  const state = lifecycleStateOf(db, tenantId, objectType, objectId);
  if (!state) return { state: null, allowed: true };
  const capabilities = stateCapabilitiesFor(db, tenantId, state);
  if (permit || !capabilities || capabilities.update) return { state, allowed: true };
  throw lifecycleBlocked({ object_type: objectType, object_id: String(objectId), state, action: "IMPORT" });
}

// Export guard: drop records the lifecycle policy does not allow to leave the
// platform. Records that are not lifecycle-managed are always exportable.
export function lifecycleAllowsExport(db, tenantId, { objectType, objectId } = {}) {
  const state = lifecycleStateOf(db, tenantId, objectType, objectId);
  if (!state) return true;
  const capabilities = stateCapabilitiesFor(db, tenantId, state);
  return capabilities ? capabilities.export : true;
}

export function filterExportableRecords(db, tenantId, objectType, records = []) {
  if (!objectType) return { records, excluded: [] };
  const kept = [];
  const excluded = [];
  for (const record of records) {
    const objectId = record?.id ?? record?.object_id ?? record?.objectId ?? record?.code ?? record?.object_ref;
    if (lifecycleAllowsExport(db, tenantId, { objectType, objectId })) kept.push(record);
    else excluded.push(objectId);
  }
  return { records: kept, excluded };
}

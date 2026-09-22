// Data Catalog integration.
//
// The catalog surfaces lifecycle context for cataloged objects. The lifecycle
// service remains the single source of truth: the catalog reads through this
// module rather than storing a duplicate of lifecycle policy, retention, tier,
// archive state or accountability.
import { queryAll, queryOne } from "../../db.js";
import { resolveOwnership as governanceOwnership } from "../data-governance/ownership.js";
import { resolvePolicy } from "./policies.js";
import { activeHoldsForObject } from "./legal-holds.js";
import { getLatestArchiveRow } from "./archive.js";
import { normalizeText } from "./validation.js";

function ownershipFor(db, { tenantId, objectType, domainId = null }) {
  try {
    const owner = governanceOwnership(db, { tenantId, domainId, objectType, relationship: "owner" });
    const steward = governanceOwnership(db, { tenantId, domainId, objectType, relationship: "steward" });
    const pick = (rows) => (Array.isArray(rows) && rows.length ? { subject_type: rows[0].subject_type, subject_id: rows[0].subject_id, name: rows[0].name || rows[0].subject_name || null } : null);
    return { owner: pick(owner), steward: pick(steward) };
  } catch {
    return { owner: null, steward: null };
  }
}

// Read-only lifecycle snapshot for a business object.
export function lifecycleSnapshot(db, { tenantId, objectType, objectId, domainId = null, includeOwnership = true } = {}) {
  const tid = Number(tenantId);
  const ledger = queryOne(db, "SELECT * FROM lc_object_lifecycle WHERE tenant_id = ? AND object_type = ? AND object_id = ?", [
    tid,
    normalizeText(objectType, { max: 120 }),
    String(objectId),
  ]);
  if (!ledger) {
    return {
      object_type: objectType,
      object_id: String(objectId),
      tracked: false,
      lifecycle_state: null,
      data_tier: null,
      retention: null,
      archive_state: "NOT_ARCHIVED",
      legal_hold: { active: false, holds: [] },
      policy: null,
      ownership: includeOwnership ? ownershipFor(db, { tenantId: tid, objectType, domainId }) : { owner: null, steward: null },
    };
  }
  const resolution = resolvePolicy(db, {
    tenantId: tid,
    objectType: ledger.object_type,
    objectId: ledger.object_id,
    organizationId: ledger.organization_id,
    plantId: ledger.plant_id,
    classification: ledger.classification,
    lifecycleState: ledger.current_state,
  });
  const holds = activeHoldsForObject(db, { tenantId: tid, objectType: ledger.object_type, objectId: ledger.object_id, organizationId: ledger.organization_id, classification: ledger.classification });
  const archive = getLatestArchiveRow(db, { tenantId: tid, objectType: ledger.object_type, objectId: ledger.object_id });
  return {
    tracked: true,
    object_type: ledger.object_type,
    object_id: String(ledger.object_id),
    object_ref: ledger.object_ref || "",
    lifecycle_state: ledger.current_state,
    previous_state: ledger.previous_state || null,
    data_tier: ledger.data_tier,
    classification: ledger.classification,
    retention: {
      basis: ledger.retention_basis,
      anchor: ledger.retention_anchor,
      archive_eligible_at: ledger.archive_eligible_at,
      cold_storage_at: ledger.cold_storage_at,
      purge_eligible_at: ledger.purge_eligible_at,
      policy_ref: resolution.policy?.policy_ref ?? null,
    },
    policy: resolution.policy
      ? { policy_ref: resolution.policy.policy_ref, code: resolution.policy.code, retention_period_days: resolution.policy.retention_period_days, retention_basis: resolution.policy.retention_basis, data_tier: resolution.policy.data_tier }
      : null,
    archive_state: archive ? (String(ledger.current_state).toUpperCase() === "PURGED" ? "PURGED" : archive.status === "restored" ? "RESTORED" : "ARCHIVED") : "NOT_ARCHIVED",
    archive_ref: archive?.archive_ref ?? null,
    legal_hold: { active: holds.length > 0, holds: holds.map((h) => h.hold_ref) },
    ownership: includeOwnership ? ownershipFor(db, { tenantId: tid, objectType, domainId }) : { owner: null, steward: null },
    last_evaluated_at: ledger.last_evaluated_at,
  };
}

export function bulkLifecycleSnapshots(db, { tenantId, objects = [] } = {}) {
  return objects.map((entry) =>
    lifecycleSnapshot(db, {
      tenantId,
      objectType: entry.object_type ?? entry.objectType,
      objectId: entry.object_id ?? entry.objectId,
      domainId: entry.domain_id ?? entry.domainId ?? null,
      includeOwnership: entry.include_ownership !== false,
    })
  );
}

// Object types that lifecycle can expose to the catalog as lifecycle-aware.
export function lifecycleAwareTypes(db, { tenantId } = {}) {
  return queryAll(
    db,
    "SELECT object_type, COUNT(*) AS tracked FROM lc_object_lifecycle WHERE tenant_id = ? GROUP BY object_type ORDER BY tracked DESC, object_type",
    [Number(tenantId)]
  ).map((row) => ({ object_type: row.object_type, tracked: Number(row.tracked) }));
}

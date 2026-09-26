// Demonstration seed for the Data Lifecycle & Archival service. Idempotent and
// safe to run on an existing database: it installs the default state model and a
// small, realistic lifecycle estate so an administrator can see the capability
// working immediately. Real organizations configure their own policies.
import { queryOne } from "../../db.js";
import { withEventSuppression } from "../events/emit.js";
import { ensureLifecycleFoundation } from "./foundation.js";
import { ensureDefaultStates } from "./states.js";
import { createPolicy } from "./policies.js";
import { registerObjectLifecycle } from "./objects.js";
import { createLegalHold } from "./legal-holds.js";
import { addDays, nowIso } from "./validation.js";

const POLICIES = [
  {
    code: "CUSTOMER_RETENTION",
    name: "Customer master retention",
    description: "Keep customer master data for seven years, archiving after one.",
    scope_type: "OBJECT_TYPE",
    object_type: "customer",
    retention_period_days: 2555,
    retention_basis: "LAST_MODIFIED_DATE",
    archive_after_days: 365,
    cold_storage_after_days: 1095,
    purge_after_days: 2555,
    data_tier: "WARM",
    status: "active",
    priority: 100,
  },
  {
    code: "PRODUCT_RETENTION",
    name: "Product master retention",
    description: "Retain product master data for ten years.",
    scope_type: "OBJECT_TYPE",
    object_type: "product",
    retention_period_days: 3650,
    retention_basis: "LAST_MODIFIED_DATE",
    archive_after_days: 1095,
    cold_storage_after_days: 1825,
    purge_after_days: 3650,
    data_tier: "HOT",
    status: "active",
    priority: 100,
  },
  {
    code: "FINANCE_ORDER_RETENTION",
    name: "Purchase order retention",
    description: "Retain purchase orders for seven years, purge after.",
    scope_type: "OBJECT_TYPE",
    object_type: "purchase_order",
    retention_period_days: 2555,
    retention_basis: "COMPLETION_DATE",
    archive_after_days: 730,
    cold_storage_after_days: 1460,
    purge_after_days: 2555,
    data_tier: "ARCHIVE",
    status: "active",
    priority: 90,
  },
];

const OBJECTS = [
  { object_type: "customer", object_id: "CUST-1001", object_ref: "Acme Corporation", classification: "confidential", current_state: "INACTIVE", anchor: -420 },
  { object_type: "customer", object_id: "CUST-1002", object_ref: "Globex Corporation", classification: "confidential", current_state: "INACTIVE", anchor: -200 },
  { object_type: "product", object_id: "PART-2001", object_ref: "Hydraulic pump", classification: "internal", current_state: "ACTIVE", anchor: -30 },
  { object_type: "purchase_order", object_id: "PO-3001", object_ref: "PO 3001", classification: "internal", current_state: "ARCHIVED", anchor: -900 },
  { object_type: "purchase_order", object_id: "PO-3002", object_ref: "PO 3002", classification: "internal", current_state: "INACTIVE", anchor: -800 },
];

export function seedDataLifecycle(db, tenantId) {
  return withEventSuppression(() => {
    const tenant = resolveTenantId(db, tenantId);
    const foundation = ensureLifecycleFoundation(db);
    const created = { states: 0, policies: 0, objects: 0, legal_holds: 0 };
    if (!tenant) return { foundation, created, seeded: false, reason: "no_tenant" };

    created.states = ensureDefaultStates(db, tenant).states;

    const policyRows = {};
    for (const policy of POLICIES) {
      const existing = queryOne(db, "SELECT * FROM lc_policies WHERE tenant_id = ? AND code = ?", [tenant, policy.code]);
      if (existing) {
        policyRows[policy.code] = existing;
        continue;
      }
      policyRows[policy.code] = createPolicy(db, tenant, policy, null, null);
      created.policies += 1;
    }

    for (const object of OBJECTS) {
      const existing = queryOne(db, "SELECT id FROM lc_object_lifecycle WHERE tenant_id = ? AND object_type = ? AND object_id = ?", [
        tenant,
        object.object_type,
        object.object_id,
      ]);
      if (existing) continue;
      registerObjectLifecycle(
        db,
        tenant,
        {
          object_type: object.object_type,
          object_id: object.object_id,
          object_ref: object.object_ref,
          classification: object.classification,
          current_state: object.current_state,
          retention_anchor: addDays(nowIso(), object.anchor),
          retention_basis: policyRows[`${object.object_type.toUpperCase()}_RETENTION`]?.retention_basis || "LAST_MODIFIED_DATE",
        },
        null,
        null
      );
      created.objects += 1;
    }

    const holds = [
      {
        code: "LITIGATION_HOLD_CUST",
        name: "Litigation hold - customer disputes",
        reason: "Pending litigation; preserve all customer master records.",
        scope_type: "OBJECT",
        object_type: "customer",
        object_ids: [{ object_type: "customer", object_id: "CUST-1002" }],
      },
    ];
    for (const hold of holds) {
      const existing = queryOne(db, "SELECT id FROM lc_legal_holds WHERE tenant_id = ? AND code = ?", [tenant, hold.code]);
      if (existing) continue;
      createLegalHold(db, tenant, hold, null, null);
      created.legal_holds += 1;
    }

    return { foundation, created, seeded: true };
  });
}

function resolveTenantId(db, tenantId) {
  const explicit = Number(tenantId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  return helix?.id ?? null;
}

export function ensureDataLifecycleSeed(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  if (!tenant) return { seeded: false, reason: "no_tenant" };
  const existing = queryOne(db, "SELECT id FROM lc_policies WHERE tenant_id = ? AND code = 'CUSTOMER_RETENTION'", [tenant]);
  if (existing) return { seeded: false, reason: "already_present" };
  return seedDataLifecycle(db, tenant);
}

// Foundation bootstrap for Enterprise Reference Data Management. Idempotent on
// every boot: cache epoch, default scope policy, the mandatory domain set,
// event types and search registration. Safe to call repeatedly.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { ensureCacheEpoch } from "./cache.js";
import { ensureReferenceEventTypes } from "./events.js";
import { ensureReferenceSearchRegistration } from "./search.js";
import { DEFAULT_PRECEDENCE } from "./scope.js";
import { ensureReferenceDomains } from "./seed.js";
import { scopePolicyRef } from "./refs.js";

export function ensureDefaultScopePolicy(db, { tenantId = null } = {}) {
  const existing = queryOne(
    db,
    "SELECT id FROM reference_scope_policies WHERE code = 'default' AND COALESCE(tenant_id, 0) = COALESCE(?, 0)",
    [tenantId]
  );
  if (existing) return 0;
  const ts = nowIso();
  run(
    db,
    `INSERT INTO reference_scope_policies
      (policy_ref, code, name, description, precedence_json, allow_global_fallback, conflict_strategy, status, is_default, tenant_id, created_at, updated_at)
     VALUES (?, 'default', 'Default scope policy', 'Plant -> Organization -> Tenant -> Global', ?, 1, 'highest_precedence', 'active', 1, ?, ?, ?)`,
    [scopePolicyRef(tenantId ? `default-${tenantId}` : "default"), JSON.stringify(DEFAULT_PRECEDENCE), tenantId, ts, ts]
  );
  return 1;
}

export function ensureReferenceFoundation(db) {
  const epoch = ensureCacheEpoch(db);
  const tenants = queryAll(db, "SELECT id FROM organizations");
  let scopePolicies = 0;
  for (const tenant of tenants) scopePolicies += ensureDefaultScopePolicy(db, { tenantId: tenant.id });
  if (!tenants.length) scopePolicies += ensureDefaultScopePolicy(db, { tenantId: null });
  let domains = null;
  try {
    domains = ensureReferenceDomains(db, { tenantId: null });
  } catch {
    domains = null;
  }
  let events = 0;
  let search = null;
  try {
    events = ensureReferenceEventTypes(db);
  } catch {
    events = 0;
  }
  try {
    search = ensureReferenceSearchRegistration(db);
  } catch {
    search = null;
  }
  return { cache_epoch: epoch, scope_policies: scopePolicies, domains, event_types: events, search };
}

export function vocabulary() {
  return {
    categories: [
      "measurement",
      "finance",
      "geography",
      "localization",
      "manufacturing",
      "pdm",
      "master-data",
      "documents",
      "standards",
      "lifecycle",
      "general",
    ],
    domain_scope_types: ["GLOBAL", "TENANT", "ORGANIZATION", "COMPANY", "BUSINESS_UNIT", "PLANT", "SITE"],
    mandatory_domains: [
      "UNIT_OF_MEASURE",
      "CURRENCY",
      "COUNTRY",
      "LANGUAGE",
      "TIME_ZONE",
      "PLANT_TYPE",
      "PRODUCT_CATEGORY",
      "MATERIAL_TYPE",
      "DOCUMENT_TYPE",
      "INDUSTRY_CODE",
      "STANDARD",
      "STATUS_CODE",
      "REASON_CODE",
    ],
    default_scope_precedence: DEFAULT_PRECEDENCE,
  };
}

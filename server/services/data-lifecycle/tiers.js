// Lifecycle state -> logical data tier mapping.
//
// The tier is a policy decision (HOT/WARM/ARCHIVE/COLD) independent of physical
// storage. Physical location is the archive provider's concern. Keeping the two
// apart lets an object be logically ARCHIVED while storage still serves reads
// from a warm provider.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { DEFAULT_STATE_TIER_MAP, DATA_TIERS } from "./constants.js";
import { assertDataTier, normalizeText, normalizeUpper } from "./validation.js";
import { requireState } from "./states.js";

function publicTierPolicy(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    state_code: row.state_code,
    data_tier: row.data_tier,
    description: row.description || "",
    system: Boolean(Number(row.system)),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getTierPolicyRow(db, tenantId, stateCode) {
  return queryOne(db, "SELECT * FROM lc_tier_policies WHERE tenant_id = ? AND state_code = ?", [Number(tenantId), normalizeUpper(stateCode)]);
}

export function listTierPolicies(db, { tenantId } = {}) {
  const rows = queryAll(db, "SELECT * FROM lc_tier_policies WHERE tenant_id = ? ORDER BY state_code", [Number(tenantId)]);
  return { items: rows.map(publicTierPolicy), total: rows.length, tiers: DATA_TIERS };
}

export function setTierPolicy(db, tenantId, stateCode, dataTier, { description = "", actor = null, ip = null } = {}) {
  const code = normalizeUpper(stateCode);
  requireState(db, tenantId, code);
  const tier = assertDataTier(dataTier);
  const existing = getTierPolicyRow(db, tenantId, code);
  const ts = nowIso();
  if (existing) {
    run(db, "UPDATE lc_tier_policies SET data_tier = ?, description = ?, updated_at = ? WHERE id = ?", [
      tier,
      normalizeText(description) || existing.description,
      ts,
      existing.id,
    ]);
    writeAudit(db, { actor, action: "data_lifecycle.tier.update", resourceType: "lc_tier_policies", resourceId: code, details: { data_tier: tier }, ip });
    return publicTierPolicy(queryOne(db, "SELECT * FROM lc_tier_policies WHERE id = ?", [existing.id]));
  }
  const result = run(
    db,
    "INSERT INTO lc_tier_policies (tenant_id, state_code, data_tier, description, system, status, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'active', ?, ?)",
    [Number(tenantId), code, tier, normalizeText(description), ts, ts]
  );
  writeAudit(db, { actor, action: "data_lifecycle.tier.create", resourceType: "lc_tier_policies", resourceId: code, details: { data_tier: tier }, ip });
  return publicTierPolicy(queryOne(db, "SELECT * FROM lc_tier_policies WHERE id = ?", [Number(result.lastInsertRowid)]));
}

// Resolution order: explicit tenant mapping, then the platform default map.
export function resolveTier(db, tenantId, stateCode) {
  const code = normalizeUpper(stateCode);
  const row = getTierPolicyRow(db, tenantId, code);
  if (row && row.status === "active") return row.data_tier;
  return DEFAULT_STATE_TIER_MAP[code] || "HOT";
}

export { publicTierPolicy };

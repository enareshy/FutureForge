// Baseline content retention policies. Retention is configuration, not code, but
// a safe default set is seeded per tenant so the retention job has something to
// evaluate. Policies only mark content eligible for review; they never delete.
import { queryAll } from "../../db.js";
import { createRetentionPolicy, listRetentionPolicies } from "./retention.js";

export const DEFAULT_RETENTION_POLICIES = [
  {
    policyCode: "content-default",
    name: "Default content retention",
    description: "Baseline retention for active, non-classified content. Review after 2555 days (7 years).",
    retentionDays: 2555,
    retentionStartBasis: "created",
    disposition: "review",
  },
  {
    policyCode: "content-quarantine",
    name: "Quarantined content retention",
    description: "Quarantined or infected content is reviewed for disposition after 90 days.",
    retentionDays: 90,
    retentionStartBasis: "modified",
    disposition: "review",
  },
  {
    policyCode: "content-staging",
    name: "Upload staging retention",
    description: "Abandoned upload staging artifacts are eligible for cleanup after 30 days.",
    retentionDays: 30,
    retentionStartBasis: "created",
    disposition: "purge",
  },
];

export function ensureDefaultRetentionPolicies(db, { tenantId = null, actor = null } = {}) {
  const existing = listRetentionPolicies(db, { tenantId }).items.map((policy) => policy.policy_code);
  let created = 0;
  for (const policy of DEFAULT_RETENTION_POLICIES) {
    if (existing.includes(policy.policyCode)) continue;
    createRetentionPolicy(db, policy, { actor, tenantId });
    created += 1;
  }
  return created;
}

export function seedContent(db, { actor = null } = {}) {
  const tenants = queryAll(db, "SELECT id FROM organizations");
  let policies = 0;
  for (const tenant of tenants) policies += ensureDefaultRetentionPolicies(db, { tenantId: tenant.id, actor });
  if (!tenants.length) policies += ensureDefaultRetentionPolicies(db, { tenantId: null, actor });
  return { retention_policies: policies };
}

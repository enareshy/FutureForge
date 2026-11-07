// Demonstration seed for the Requirements Manager. Idempotent: it walks a
// realistic business -> system -> functional requirement chain with hierarchy,
// traceability relationships, a revision and a released baseline, so the
// integration with numbering, history, events, search and baselines is visible
// immediately after boot. Numbers come from the shared numbering SDK.
import { queryOne } from "../../db.js";
import { queryOneAsync } from "../../db-async.js";
import { ensureRequirementsFoundation, ensureRequirementsFoundationAsync } from "./foundation.js";
import {
  createRequirement,
  createRequirementAsync,
  submitRequirement,
  submitRequirementAsync,
  approveRequirement,
  approveRequirementAsync,
  releaseRequirement,
  releaseRequirementAsync,
  reviseRequirement,
  reviseRequirementAsync,
} from "./requirements.js";
import { createRelationship, createRelationshipAsync } from "./relationships.js";
import { createBaseline, createBaselineAsync, releaseBaseline, releaseBaselineAsync } from "./baselines.js";

function resolveTenantId(db, tenantId) {
  const explicit = Number(tenantId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  return helix?.id ?? null;
}

async function resolveTenantIdAsync(db, tenantId) {
  const explicit = Number(tenantId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const helix = await queryOneAsync(db, "SELECT id FROM organizations WHERE code = 'helix'");
  return helix?.id ?? null;
}

function resolveOwnerId(db, tenant) {
  const admin = queryOne(db, "SELECT id FROM users WHERE username = 'admin'");
  if (admin?.id) return admin.id;
  return queryOne(db, "SELECT id FROM users WHERE tenant_id = ? ORDER BY id LIMIT 1", [tenant])?.id ?? null;
}

async function resolveOwnerIdAsync(db, tenant) {
  const admin = await queryOneAsync(db, "SELECT id FROM users WHERE username = 'admin'");
  if (admin?.id) return admin.id;
  return (await queryOneAsync(db, "SELECT id FROM users WHERE tenant_id = ? ORDER BY id LIMIT 1", [tenant]))?.id ?? null;
}

export function seedRequirements(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  const foundation = ensureRequirementsFoundation(db);
  if (!tenant) return { foundation, seeded: false, reason: "no_tenant" };

  const existing = queryOne(db, "SELECT id FROM requirements WHERE tenant_id = ? AND title = 'Reduce pump seal leakage rate'", [tenant]);
  if (existing) return { foundation, seeded: false, reason: "already_seeded" };

  const ownerId = resolveOwnerId(db, tenant);
  const actor = ownerId ? { id: ownerId, username: "admin" } : null;

  const business = createRequirement(
    db,
    tenant,
    { title: "Reduce pump seal leakage rate", description: "The product family must reduce field seal leakage below the warranty threshold.", requirement_type: "business_requirement", priority: "HIGH", category: "PRODUCT", source: "CUSTOMER", owner_user_id: ownerId },
    actor,
    null
  );
  submitRequirement(db, tenant, business.id, actor, null);
  approveRequirement(db, tenant, business.id, actor, null);
  releaseRequirement(db, tenant, business.id, actor, null);

  const system = createRequirement(
    db,
    tenant,
    { title: "Mechanical seal shall sustain 5000 operating hours", description: "Derived from the business requirement to reduce leakage.", requirement_type: "system_requirement", priority: "HIGH", category: "ENGINEERING", parent_id: business.id, owner_user_id: ownerId },
    actor,
    null
  );
  createRelationship(db, tenant, { relationship_type: "DERIVED_FROM", source_type: "requirement", source_id: system.id, target_type: "requirement", target_id: business.id, status: "ACTIVE" }, actor, null);
  createRelationship(db, tenant, { relationship_type: "SATISFIES", source_type: "requirement", source_id: system.id, target_type: "requirement", target_id: business.id, status: "ACTIVE" }, actor, null);

  reviseRequirement(db, tenant, system.id, { change_reason: "Tightened duration to 5000 hours after field data review." }, actor, null);

  const baseline = createBaseline(db, tenant, { name: "Release 1.0 Requirements Baseline", description: "Initial controlled baseline of released requirements.", requirement_ids: [business.id, system.id] }, actor, null);
  const releasedBaseline = releaseBaseline(db, tenant, baseline.id, actor, null);

  return { foundation, seeded: true, business, system, baseline: releasedBaseline };
}

export async function seedRequirementsAsync(db, tenantId) {
  const tenant = await resolveTenantIdAsync(db, tenantId);
  const foundation = await ensureRequirementsFoundationAsync(db);
  if (!tenant) return { foundation, seeded: false, reason: "no_tenant" };

  const existing = await queryOneAsync(db, "SELECT id FROM requirements WHERE tenant_id = ? AND title = 'Reduce pump seal leakage rate'", [tenant]);
  if (existing) return { foundation, seeded: false, reason: "already_seeded" };

  const ownerId = await resolveOwnerIdAsync(db, tenant);
  const actor = ownerId ? { id: ownerId, username: "admin" } : null;

  const business = await createRequirementAsync(
    db,
    tenant,
    { title: "Reduce pump seal leakage rate", description: "The product family must reduce field seal leakage below the warranty threshold.", requirement_type: "business_requirement", priority: "HIGH", category: "PRODUCT", source: "CUSTOMER", owner_user_id: ownerId },
    actor,
    null
  );
  await submitRequirementAsync(db, tenant, business.id, actor, null);
  await approveRequirementAsync(db, tenant, business.id, actor, null);
  await releaseRequirementAsync(db, tenant, business.id, actor, null);

  const system = await createRequirementAsync(
    db,
    tenant,
    { title: "Mechanical seal shall sustain 5000 operating hours", description: "Derived from the business requirement to reduce leakage.", requirement_type: "system_requirement", priority: "HIGH", category: "ENGINEERING", parent_id: business.id, owner_user_id: ownerId },
    actor,
    null
  );
  await createRelationshipAsync(db, tenant, { relationship_type: "DERIVED_FROM", source_type: "requirement", source_id: system.id, target_type: "requirement", target_id: business.id, status: "ACTIVE" }, actor, null);
  await createRelationshipAsync(db, tenant, { relationship_type: "SATISFIES", source_type: "requirement", source_id: system.id, target_type: "requirement", target_id: business.id, status: "ACTIVE" }, actor, null);

  await reviseRequirementAsync(db, tenant, system.id, { change_reason: "Tightened duration to 5000 hours after field data review." }, actor, null);

  const baseline = await createBaselineAsync(db, tenant, { name: "Release 1.0 Requirements Baseline", description: "Initial controlled baseline of released requirements.", requirement_ids: [business.id, system.id] }, actor, null);
  const releasedBaseline = await releaseBaselineAsync(db, tenant, baseline.id, actor, null);

  return { foundation, seeded: true, business, system, baseline: releasedBaseline };
}

export { ensureRequirementsFoundation, ensureRequirementsFoundationAsync };

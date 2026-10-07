process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase } from "../db.js";
// Side-effect import: registers the seed template builder openTestDatabase needs.
import "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import {
  Configuration,
  Foundation,
  Types,
  Requirements,
  Relationships,
  Baselines,
  ValidationRules,
  Seed,
  ensureRequirementsFoundation,
} from "../services/requirements/index.js";

const TENANT = 1;

function stripTimestamps(value) {
  if (Array.isArray(value)) return value.map(stripTimestamps);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/_at$/.test(key)) continue;
      out[key] = stripTimestamps(entry);
    }
    return out;
  }
  return value;
}

function bootstrap(db) {
  migrate(db);
  db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('test-org', 'Test Org', 'organization')").run();
  const org = db.prepare("SELECT id FROM organizations WHERE code = 'test-org'").get();
  db.prepare("UPDATE organizations SET tenant_id = id WHERE id = ?").run(org.id);
  ensureNumberingFoundation(db);
  ensureRequirementsFoundation(db);
  Configuration.setConfig(db, org.id, "require_owner", false, null, null);
  return org.id;
}

// Relationship references are random, so parity comparisons ignore them.
function comparableRelationship(row) {
  const { relationship_ref, ...rest } = row;
  return rest;
}

describe("async requirements read twins mirror the synchronous service", () => {
  let db;
  const refs = {};

  before(() => {
    db = openTestDatabase();
    bootstrap(db);

    const business = Requirements.createRequirement(db, TENANT, { title: "Async read business", requirement_type: "business_requirement", priority: "HIGH" }, null, null);
    const system = Requirements.createRequirement(db, TENANT, { title: "Async read system", requirement_type: "system_requirement", parent_id: business.id }, null, null);
    Requirements.submitRequirement(db, TENANT, business.id, null, null);
    Requirements.approveRequirement(db, TENANT, business.id, null, null);
    Requirements.releaseRequirement(db, TENANT, business.id, null, null);
    Requirements.reviseRequirement(db, TENANT, system.id, { change_reason: "Parity revision" }, null, null);
    Relationships.createRelationship(db, TENANT, { relationship_type: "DERIVED_FROM", source_type: "requirement", source_id: system.id, target_type: "requirement", target_id: business.id }, null, null);
    const baseline = Baselines.createBaseline(db, TENANT, { name: "Async read baseline", requirement_ids: [business.id, system.id] }, null, null);
    Baselines.releaseBaseline(db, TENANT, baseline.id, null, null);
    ValidationRules.createValidationRule(db, TENANT, { code: "PARITY_RULE", name: "Parity rule", rule_type: "LENGTH", target_attribute: "title", parameters: { max: 400 }, severity: "WARNING" }, null, null);
    Configuration.setConfig(db, TENANT, "history_retention_days", 90, null, null);

    refs.businessId = business.id;
    refs.systemId = system.id;
    refs.baselineId = baseline.id;
  });

  after(() => db?.close());

  test("type reads match", async () => {
    assert.deepEqual(await Types.listTypesAsync(db, { tenantId: TENANT }), Types.listTypes(db, { tenantId: TENANT }));
    assert.deepEqual(await Types.getTypeAsync(db, TENANT, "business_requirement"), Types.getType(db, TENANT, "business_requirement"));
  });

  test("requirement reads match", async () => {
    assert.deepEqual(await Requirements.listRequirementsAsync(db, { tenantId: TENANT }), Requirements.listRequirements(db, { tenantId: TENANT }));
    assert.deepEqual(await Requirements.getRequirementAsync(db, TENANT, refs.businessId), Requirements.getRequirement(db, TENANT, refs.businessId));
    assert.deepEqual(await Requirements.listChildrenAsync(db, TENANT, refs.businessId), Requirements.listChildren(db, TENANT, refs.businessId));
  });

  test("revision reads match", async () => {
    assert.deepEqual(await Requirements.listRevisionsAsync(db, TENANT, refs.systemId), Requirements.listRevisions(db, TENANT, refs.systemId));
    assert.deepEqual(await Requirements.compareRevisionsAsync(db, TENANT, refs.systemId, "A", "B"), Requirements.compareRevisions(db, TENANT, refs.systemId, "A", "B"));
  });

  test("relationship reads match", async () => {
    assert.deepEqual(await Relationships.listRelationshipsAsync(db, { tenantId: TENANT }), Relationships.listRelationships(db, { tenantId: TENANT }));
    assert.deepEqual(
      await Relationships.relationshipsForRequirementAsync(db, TENANT, refs.systemId),
      Relationships.relationshipsForRequirement(db, TENANT, refs.systemId)
    );
    assert.deepEqual(await Relationships.traverseAsync(db, TENANT, refs.businessId), Relationships.traverse(db, TENANT, refs.businessId));
  });

  test("baseline reads match", async () => {
    assert.deepEqual(await Baselines.listBaselinesAsync(db, { tenantId: TENANT }), Baselines.listBaselines(db, { tenantId: TENANT }));
    assert.deepEqual(await Baselines.getBaselineAsync(db, TENANT, refs.baselineId), Baselines.getBaseline(db, TENANT, refs.baselineId));
    assert.deepEqual(await Baselines.listBaselineMembersAsync(db, TENANT, refs.baselineId), Baselines.listBaselineMembers(db, TENANT, refs.baselineId));
    assert.deepEqual(await Baselines.compareBaselineAsync(db, TENANT, refs.baselineId), Baselines.compareBaseline(db, TENANT, refs.baselineId));
  });

  test("validation reads match", async () => {
    assert.deepEqual(await ValidationRules.listValidationRulesAsync(db, { tenantId: TENANT }), ValidationRules.listValidationRules(db, { tenantId: TENANT }));
    assert.deepEqual(await ValidationRules.validateRequirementAsync(db, TENANT, refs.systemId), ValidationRules.validateRequirement(db, TENANT, refs.systemId));
    assert.deepEqual(await ValidationRules.runValidationAsync(db, TENANT, {}), ValidationRules.runValidation(db, TENANT, {}));
  });

  test("history, configuration and health reads match", async () => {
    assert.deepEqual(await Requirements.listRequirementHistoryAsync(db, TENANT, refs.businessId), Requirements.listRequirementHistory(db, TENANT, refs.businessId));
    assert.deepEqual(await Configuration.listConfigAsync(db, TENANT), Configuration.listConfig(db, TENANT));
    assert.deepEqual(await Foundation.requirementsHealthAsync(db, TENANT), Foundation.requirementsHealth(db, TENANT));
  });
});

describe("async requirements write twins mirror the synchronous service", () => {
  let asyncDb;
  let syncDb;

  before(() => {
    asyncDb = openTestDatabase();
    syncDb = openTestDatabase();
    bootstrap(asyncDb);
    bootstrap(syncDb);
  });

  after(() => {
    asyncDb?.close();
    syncDb?.close();
  });

  test("createRequirement produces the same result and enforces the title", async () => {
    const asyncResult = await Requirements.createRequirementAsync(asyncDb, TENANT, { title: "Parity create", requirement_type: "business_requirement", priority: "HIGH" }, null, null);
    const syncResult = Requirements.createRequirement(syncDb, TENANT, { title: "Parity create", requirement_type: "business_requirement", priority: "HIGH" }, null, null);
    assert.deepEqual(stripTimestamps(asyncResult), stripTimestamps(syncResult));
    assert.equal(asyncResult.status, "DRAFT");

    await assert.rejects(() => Requirements.createRequirementAsync(asyncDb, TENANT, { requirement_type: "business_requirement" }, null, null), (err) => err.code === "REQUIREMENT_INVALID");
    assert.throws(() => Requirements.createRequirement(syncDb, TENANT, { requirement_type: "business_requirement" }, null, null), (err) => err.code === "REQUIREMENT_INVALID");
  });

  test("updateRequirement matches and the optimistic lock rejects stale versions", async () => {
    const asyncReq = await Requirements.createRequirementAsync(asyncDb, TENANT, { title: "Update parity", requirement_type: "business_requirement" }, null, null);
    const syncReq = Requirements.createRequirement(syncDb, TENANT, { title: "Update parity", requirement_type: "business_requirement" }, null, null);

    const asyncUpdated = await Requirements.updateRequirementAsync(asyncDb, TENANT, asyncReq.id, { title: "Updated", priority: "URGENT" }, null, null);
    const syncUpdated = Requirements.updateRequirement(syncDb, TENANT, syncReq.id, { title: "Updated", priority: "URGENT" }, null, null);
    assert.deepEqual(stripTimestamps(asyncUpdated), stripTimestamps(syncUpdated));

    await assert.rejects(() => Requirements.updateRequirementAsync(asyncDb, TENANT, asyncReq.id, { title: "x", version: 99 }, null, null), (err) => err.code === "REQUIREMENT_CONFLICT");
    assert.throws(() => Requirements.updateRequirement(syncDb, TENANT, syncReq.id, { title: "x", version: 99 }, null, null), (err) => err.code === "REQUIREMENT_CONFLICT");
  });

  test("reviseRequirement matches", async () => {
    const asyncReq = await Requirements.createRequirementAsync(asyncDb, TENANT, { title: "Revise parity", requirement_type: "system_requirement" }, null, null);
    const syncReq = Requirements.createRequirement(syncDb, TENANT, { title: "Revise parity", requirement_type: "system_requirement" }, null, null);

    const asyncRevised = await Requirements.reviseRequirementAsync(asyncDb, TENANT, asyncReq.id, { change_reason: "Parity" }, null, null);
    const syncRevised = Requirements.reviseRequirement(syncDb, TENANT, syncReq.id, { change_reason: "Parity" }, null, null);
    assert.deepEqual(stripTimestamps(asyncRevised), stripTimestamps(syncRevised));
    assert.equal(asyncRevised.requirement.revision, "B");
  });

  test("submit/approve/release chain matches", async () => {
    const asyncReq = await Requirements.createRequirementAsync(asyncDb, TENANT, { title: "Lifecycle parity", requirement_type: "business_requirement" }, null, null);
    await Requirements.submitRequirementAsync(asyncDb, TENANT, asyncReq.id, null, null);
    await Requirements.approveRequirementAsync(asyncDb, TENANT, asyncReq.id, null, null);
    const asyncReleased = await Requirements.releaseRequirementAsync(asyncDb, TENANT, asyncReq.id, null, null);

    const syncReq = Requirements.createRequirement(syncDb, TENANT, { title: "Lifecycle parity", requirement_type: "business_requirement" }, null, null);
    Requirements.submitRequirement(syncDb, TENANT, syncReq.id, null, null);
    Requirements.approveRequirement(syncDb, TENANT, syncReq.id, null, null);
    const syncReleased = Requirements.releaseRequirement(syncDb, TENANT, syncReq.id, null, null);

    assert.deepEqual(stripTimestamps(asyncReleased), stripTimestamps(syncReleased));
    assert.equal(asyncReleased.status, "RELEASED");
  });

  test("setVerificationStatus and transitionRequirement match", async () => {
    const asyncReq = await Requirements.createRequirementAsync(asyncDb, TENANT, { title: "Transition parity", requirement_type: "system_requirement" }, null, null);
    await Requirements.submitRequirementAsync(asyncDb, TENANT, asyncReq.id, null, null);
    await Requirements.approveRequirementAsync(asyncDb, TENANT, asyncReq.id, null, null);
    await Requirements.releaseRequirementAsync(asyncDb, TENANT, asyncReq.id, null, null);
    const asyncImpl = await Requirements.transitionRequirementAsync(asyncDb, TENANT, asyncReq.id, "IMPLEMENTED");
    const asyncVerified = await Requirements.setVerificationStatusAsync(asyncDb, TENANT, asyncReq.id, "VERIFIED");

    const syncReq = Requirements.createRequirement(syncDb, TENANT, { title: "Transition parity", requirement_type: "system_requirement" }, null, null);
    Requirements.submitRequirement(syncDb, TENANT, syncReq.id, null, null);
    Requirements.approveRequirement(syncDb, TENANT, syncReq.id, null, null);
    Requirements.releaseRequirement(syncDb, TENANT, syncReq.id, null, null);
    const syncImpl = Requirements.transitionRequirement(syncDb, TENANT, syncReq.id, "IMPLEMENTED");
    const syncVerified = Requirements.setVerificationStatus(syncDb, TENANT, syncReq.id, "VERIFIED");

    assert.deepEqual(stripTimestamps(asyncImpl), stripTimestamps(syncImpl));
    assert.deepEqual(stripTimestamps(asyncVerified), stripTimestamps(syncVerified));
  });

  test("relationship create/list/delete match", async () => {
    const asyncSource = await Requirements.createRequirementAsync(asyncDb, TENANT, { title: "Rel async source", requirement_type: "system_requirement" }, null, null);
    const asyncTarget = await Requirements.createRequirementAsync(asyncDb, TENANT, { title: "Rel async target", requirement_type: "business_requirement" }, null, null);
    const syncSource = Requirements.createRequirement(syncDb, TENANT, { title: "Rel async source", requirement_type: "system_requirement" }, null, null);
    const syncTarget = Requirements.createRequirement(syncDb, TENANT, { title: "Rel async target", requirement_type: "business_requirement" }, null, null);

    const asyncRel = await Relationships.createRelationshipAsync(asyncDb, TENANT, { relationship_type: "DERIVED_FROM", source_type: "requirement", source_id: asyncSource.id, target_type: "requirement", target_id: asyncTarget.id }, null, null);
    const syncRel = Relationships.createRelationship(syncDb, TENANT, { relationship_type: "DERIVED_FROM", source_type: "requirement", source_id: syncSource.id, target_type: "requirement", target_id: syncTarget.id }, null, null);
    assert.deepEqual(comparableRelationship(asyncRel), comparableRelationship(syncRel));

    await assert.rejects(
      () => Relationships.createRelationshipAsync(asyncDb, TENANT, { relationship_type: "DERIVED_FROM", source_type: "requirement", source_id: asyncSource.id, target_type: "requirement", target_id: asyncTarget.id }, null, null),
      (err) => err.code === "REQUIREMENT_RELATIONSHIP_CONFLICT"
    );

    assert.equal((await Relationships.deleteRelationshipAsync(asyncDb, TENANT, asyncRel.id)).deleted, true);
    assert.equal(Relationships.deleteRelationship(syncDb, TENANT, syncRel.id).deleted, true);
  });

  test("baseline create/release/compare match", async () => {
    const asyncReq = await Requirements.createRequirementAsync(asyncDb, TENANT, { title: "Baseline async", requirement_type: "business_requirement" }, null, null);
    await Requirements.submitRequirementAsync(asyncDb, TENANT, asyncReq.id, null, null);
    await Requirements.approveRequirementAsync(asyncDb, TENANT, asyncReq.id, null, null);
    await Requirements.releaseRequirementAsync(asyncDb, TENANT, asyncReq.id, null, null);

    const syncReq = Requirements.createRequirement(syncDb, TENANT, { title: "Baseline async", requirement_type: "business_requirement" }, null, null);
    Requirements.submitRequirement(syncDb, TENANT, syncReq.id, null, null);
    Requirements.approveRequirement(syncDb, TENANT, syncReq.id, null, null);
    Requirements.releaseRequirement(syncDb, TENANT, syncReq.id, null, null);

    const asyncBaseline = await Baselines.createBaselineAsync(asyncDb, TENANT, { name: "Parity baseline", requirement_ids: [asyncReq.id] }, null, null);
    const syncBaseline = Baselines.createBaseline(syncDb, TENANT, { name: "Parity baseline", requirement_ids: [syncReq.id] }, null, null);
    assert.deepEqual(stripTimestamps(asyncBaseline), stripTimestamps(syncBaseline));

    const asyncReleased = await Baselines.releaseBaselineAsync(asyncDb, TENANT, asyncBaseline.id, null, null);
    const syncReleased = Baselines.releaseBaseline(syncDb, TENANT, syncBaseline.id, null, null);
    assert.deepEqual(stripTimestamps(asyncReleased), stripTimestamps(syncReleased));

    assert.deepEqual(await Baselines.compareBaselineAsync(asyncDb, TENANT, asyncBaseline.id), Baselines.compareBaseline(syncDb, TENANT, syncBaseline.id));
  });

  test("validation rule create/update/delete match", async () => {
    const body = { code: "PARITY_VALIDATION", name: "Parity validation", rule_type: "REQUIRED", target_attribute: "description", severity: "WARNING" };
    const asyncRule = await ValidationRules.createValidationRuleAsync(asyncDb, TENANT, body, null, null);
    const syncRule = ValidationRules.createValidationRule(syncDb, TENANT, body, null, null);
    assert.deepEqual(stripTimestamps(asyncRule), stripTimestamps(syncRule));

    const asyncUpdated = await ValidationRules.updateValidationRuleAsync(asyncDb, TENANT, asyncRule.code, { name: "Renamed", severity: "ERROR" }, null, null);
    const syncUpdated = ValidationRules.updateValidationRule(syncDb, TENANT, syncRule.code, { name: "Renamed", severity: "ERROR" }, null, null);
    assert.deepEqual(stripTimestamps(asyncUpdated), stripTimestamps(syncUpdated));

    assert.deepEqual(await ValidationRules.deleteValidationRuleAsync(asyncDb, TENANT, asyncRule.code), ValidationRules.deleteValidationRule(syncDb, TENANT, syncRule.code));
  });

  test("configuration set/list matches", async () => {
    const asyncValue = await Configuration.setConfigAsync(asyncDb, TENANT, "history_retention_days", 30, null, null);
    const syncValue = Configuration.setConfig(syncDb, TENANT, "history_retention_days", 30, null, null);
    assert.deepEqual(asyncValue, syncValue);
    assert.deepEqual(await Configuration.listConfigAsync(asyncDb, TENANT), Configuration.listConfig(syncDb, TENANT));
  });

  test("requirement type create matches", async () => {
    const body = { code: "parity_type", name: "Parity Type", category: "OTHER", sequence: 999 };
    const asyncType = await Types.createTypeAsync(asyncDb, TENANT, body, null, null);
    const syncType = Types.createType(syncDb, TENANT, body, null, null);
    assert.deepEqual(stripTimestamps(asyncType), stripTimestamps(syncType));
  });

  test("seedRequirements runs identically on both layers", async () => {
    const asyncSeed = await Seed.seedRequirementsAsync(asyncDb, TENANT);
    const syncSeed = Seed.seedRequirements(syncDb, TENANT);
    assert.equal(asyncSeed.seeded, true);
    assert.equal(syncSeed.seeded, true);
    assert.deepEqual(stripTimestamps(asyncSeed.baseline), stripTimestamps(syncSeed.baseline));

    const asyncAgain = await Seed.seedRequirementsAsync(asyncDb, TENANT);
    const syncAgain = Seed.seedRequirements(syncDb, TENANT);
    assert.equal(asyncAgain.reason, "already_seeded");
    assert.equal(syncAgain.reason, "already_seeded");
  });
});

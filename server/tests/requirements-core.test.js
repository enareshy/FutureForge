process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase } from "../db.js";
// Side-effect import: registers the seed template builder that openTestDatabase
// relies on when the cached template has been invalidated by a schema bump.
import "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import {
  Constants,
  Validation,
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

describe("Requirements Manager domain core services", () => {
  let db;
  let tenant;
  let foundation;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('test-org', 'Test Org', 'organization')").run();
    const org = db.prepare("SELECT id FROM organizations WHERE code = 'test-org'").get();
    tenant = org.id;
    // A tenant is any organization that carries a non-null tenant_id; the
    // Requirements foundation discovers tenants that way, exactly like the
    // search registry does.
    db.prepare("UPDATE organizations SET tenant_id = id WHERE id = ?").run(tenant);
    ensureNumberingFoundation(db);
    foundation = ensureRequirementsFoundation(db);
    // Release/approve must not be blocked by the owner requirement in these
    // pure-domain tests (the seed test exercises the owner path separately).
    Configuration.setConfig(db, tenant, "require_owner", false, null, null);
  });

  after(() => db?.close());

  test("foundation installs the Requirements domain idempotently", () => {
    assert.equal(foundation.source_module, "requirements");
    assert.ok(foundation.event_types > 0);
    assert.equal(foundation.numbering.object_types, 2);
    assert.equal(foundation.numbering.schemes, 2);
    assert.ok(foundation.types > 0);
    assert.ok(foundation.validation_rules > 0);

    // A second boot must be a safe no-op rather than a re-seed.
    const again = Foundation.ensureRequirementsFoundation(db);
    assert.equal(again.source_module, "requirements");
    assert.equal(again.event_types, 0);

    const config = Configuration.listConfig(db, tenant);
    assert.equal(config.default_status, "DRAFT");
    assert.equal(config.default_revision, "A");
  });

  test("registers live numbering schemes for REQUIREMENT and REQUIREMENT_BASELINE", () => {
    const req = db.prepare("SELECT * FROM numbering_schemes WHERE code = 'REQUIREMENT_DEFAULT'").get();
    const base = db.prepare("SELECT * FROM numbering_schemes WHERE code = 'REQUIREMENT_BASELINE_DEFAULT'").get();
    assert.ok(req && req.status === "active");
    assert.ok(base && base.status === "active");
  });

  test("exposes a coherent capability vocabulary and seeded types", () => {
    const vocab = Validation.vocabulary();
    assert.equal(Constants.SOURCE_MODULE, "requirements");
    assert.ok(vocab.requirement_statuses.includes("DRAFT"));
    assert.ok(vocab.requirement_statuses.includes("RELEASED"));

    const types = Types.listTypes(db, { tenantId: tenant });
    assert.equal(types.source_module, "requirements");
    assert.ok(types.total >= 15);
    assert.ok(types.items.some((entry) => entry.code === "business_requirement"));
  });

  test("creates a requirement with a generated, unique number", () => {
    const first = Requirements.createRequirement(db, tenant, { title: "Core create", requirement_type: "business_requirement" }, null, null);
    assert.ok(first.requirement_number.startsWith("REQ-"));
    assert.equal(first.status, "DRAFT");
    assert.equal(first.revision, "A");

    const second = Requirements.createRequirement(db, tenant, { title: "Core create 2", requirement_type: "system_requirement" }, null, null);
    assert.notEqual(second.requirement_number, first.requirement_number);

    assert.throws(
      () => Requirements.createRequirement(db, tenant, { title: "Dup", requirement_type: "business_requirement", requirement_number: first.requirement_number }, null, null),
      (err) => err.code === "REQUIREMENT_CONFLICT"
    );
  });

  test("rejects invalid create payloads", () => {
    assert.throws(
      () => Requirements.createRequirement(db, tenant, { requirement_type: "business_requirement" }, null, null),
      (err) => err.code === "REQUIREMENT_INVALID"
    );
    assert.throws(
      () => Requirements.createRequirement(db, tenant, { title: "No type" }, null, null),
      (err) => err.code === "REQUIREMENT_INVALID"
    );
    assert.throws(
      () => Requirements.createRequirement(db, tenant, { title: "Bad type", requirement_type: "does_not_exist" }, null, null),
      (err) => err.code === "REQUIREMENT_TYPE_NOT_FOUND"
    );
  });

  test("rejects an out-of-sequence status transition", () => {
    const req = Requirements.createRequirement(db, tenant, { title: "Transition guard", requirement_type: "business_requirement" }, null, null);
    assert.throws(
      () => Requirements.transitionRequirement(db, tenant, req.id, "APPROVED"),
      (err) => err.code === "REQUIREMENT_STATUS_INVALID"
    );
  });

  test("drives a requirement through submit -> approve -> release", () => {
    const req = Requirements.createRequirement(db, tenant, { title: "Lifecycle", requirement_type: "business_requirement" }, null, null);
    const submitted = Requirements.submitRequirement(db, tenant, req.id, null, null);
    assert.equal(submitted.status, "IN_REVIEW");
    const approved = Requirements.approveRequirement(db, tenant, req.id, null, null);
    assert.equal(approved.status, "APPROVED");
    const released = Requirements.releaseRequirement(db, tenant, req.id, null, null);
    assert.equal(released.status, "RELEASED");

    const revisions = Requirements.listRevisions(db, tenant, req.id);
    assert.ok(revisions.items.some((entry) => entry.revision === "A" && entry.revision_status === "RELEASED"));

    // A released requirement is immutable for ordinary edits.
    assert.throws(
      () => Requirements.updateRequirement(db, tenant, req.id, { title: "Nope" }, null, null),
      (err) => err.code === "REQUIREMENT_IMMUTABLE"
    );
  });

  test("enforces verification before validation", () => {
    const req = Requirements.createRequirement(db, tenant, { title: "Verify gate", requirement_type: "system_requirement" }, null, null);
    Requirements.submitRequirement(db, tenant, req.id, null, null);
    Requirements.approveRequirement(db, tenant, req.id, null, null);
    Requirements.releaseRequirement(db, tenant, req.id, null, null);
    Requirements.transitionRequirement(db, tenant, req.id, "IMPLEMENTED");
    Requirements.transitionRequirement(db, tenant, req.id, "VERIFIED");

    assert.throws(
      () => Requirements.transitionRequirement(db, tenant, req.id, "VALIDATED"),
      (err) => err.code === "REQUIREMENT_INVALID"
    );

    Requirements.setVerificationStatus(db, tenant, req.id, "VERIFIED");
    const validated = Requirements.transitionRequirement(db, tenant, req.id, "VALIDATED");
    assert.equal(validated.status, "VALIDATED");
  });

  test("optimistic locking rejects a stale version", () => {
    const req = Requirements.createRequirement(db, tenant, { title: "Lock", requirement_type: "business_requirement" }, null, null);
    assert.throws(
      () => Requirements.updateRequirement(db, tenant, req.id, { title: "Locked", version: 99 }, null, null),
      (err) => err.code === "REQUIREMENT_CONFLICT"
    );
  });

  test("creates and compares revisions", () => {
    const req = Requirements.createRequirement(db, tenant, { title: "Original", requirement_type: "business_requirement" }, null, null);
    Requirements.updateRequirement(db, tenant, req.id, { title: "Revised" }, null, null);
    const revised = Requirements.reviseRequirement(db, tenant, req.id, { change_reason: "Title reworked" }, null, null);
    assert.equal(revised.requirement.revision, "B");
    assert.equal(revised.requirement.status, "DRAFT");
    assert.equal(revised.revision.revision, "B");

    const comparison = Requirements.compareRevisions(db, tenant, req.id, "A", "B");
    assert.ok(comparison.changes.some((change) => change.attribute === "title"));
    assert.throws(
      () => Requirements.compareRevisions(db, tenant, req.id, "A", "Z"),
      (err) => err.code === "REQUIREMENT_REVISION_NOT_FOUND"
    );
  });

  test("maintains hierarchy and rejects cycles", () => {
    const parent = Requirements.createRequirement(db, tenant, { title: "Parent", requirement_type: "business_requirement" }, null, null);
    const child = Requirements.createRequirement(db, tenant, { title: "Child", requirement_type: "system_requirement" }, null, null);
    Requirements.updateRequirement(db, tenant, child.id, { parent_id: parent.id }, null, null);

    const children = Requirements.listChildren(db, tenant, parent.id);
    assert.equal(children.length, 1);
    assert.equal(children[0].id, child.id);

    assert.throws(
      () => Requirements.updateRequirement(db, tenant, parent.id, { parent_id: child.id }, null, null),
      (err) => err.code === "REQUIREMENT_HIERARCHY_CYCLE"
    );
  });

  test("creates, lists and deletes traceability relationships", () => {
    const source = Requirements.createRequirement(db, tenant, { title: "Rel source", requirement_type: "system_requirement" }, null, null);
    const target = Requirements.createRequirement(db, tenant, { title: "Rel target", requirement_type: "business_requirement" }, null, null);
    const body = { relationship_type: "DERIVED_FROM", source_type: "requirement", source_id: source.id, target_type: "requirement", target_id: target.id };

    const rel = Relationships.createRelationship(db, tenant, body, null, null);
    assert.ok(rel.relationship_ref);

    assert.throws(
      () => Relationships.createRelationship(db, tenant, body, null, null),
      (err) => err.code === "REQUIREMENT_RELATIONSHIP_CONFLICT"
    );

    const forSource = Relationships.relationshipsForRequirement(db, tenant, source.id);
    assert.ok(forSource.total >= 1);

    const deleted = Relationships.deleteRelationship(db, tenant, rel.id, null, null);
    assert.equal(deleted.deleted, true);

    assert.throws(
      () => Relationships.createRelationship(db, tenant, { relationship_type: "PARENT_OF", source_type: "requirement", source_id: source.id, target_type: "requirement", target_id: source.id }, null, null),
      (err) => err.code === "REQUIREMENT_HIERARCHY_CYCLE"
    );
  });

  test("creates, releases and diffs a baseline", () => {
    const req = Requirements.createRequirement(db, tenant, { title: "Baseline member", requirement_type: "business_requirement" }, null, null);
    Requirements.submitRequirement(db, tenant, req.id, null, null);
    Requirements.approveRequirement(db, tenant, req.id, null, null);
    Requirements.releaseRequirement(db, tenant, req.id, null, null);

    const baseline = Baselines.createBaseline(db, tenant, { name: "Core baseline", requirement_ids: [req.id] }, null, null);
    assert.equal(baseline.member_count, 1);
    assert.equal(baseline.status, "DRAFT");

    const released = Baselines.releaseBaseline(db, tenant, baseline.id, null, null);
    assert.equal(released.status, "RELEASED");

    const inSync = Baselines.compareBaseline(db, tenant, baseline.id);
    assert.equal(inSync.in_sync, true);

    Requirements.reviseRequirement(db, tenant, req.id, { change_reason: "Moved to B" }, null, null);
    const drifted = Baselines.compareBaseline(db, tenant, baseline.id);
    assert.equal(drifted.in_sync, false);
    assert.ok(drifted.differences.some((diff) => diff.change === "REVISED"));

    assert.throws(
      () => Baselines.addBaselineMember(db, tenant, baseline.id, { requirement_id: req.id }, null, null),
      (err) => err.code === "REQUIREMENT_INVALID_BASELINE"
    );
  });

  test("evaluates configurable validation rules", () => {
    const rules = ValidationRules.listValidationRules(db, { tenantId: tenant });
    assert.ok(rules.total >= 3);
    assert.ok(rules.items.some((rule) => rule.code === "REQ_TITLE_REQUIRED"));

    const req = Requirements.createRequirement(db, tenant, { title: "Validation subject", requirement_type: "business_requirement" }, null, null);
    const result = ValidationRules.validateRequirement(db, tenant, req.id);
    assert.equal(result.valid, true);
    assert.ok(result.violations.some((violation) => violation.rule_code === "REQ_OWNER_REQUIRED"));

    const sweep = ValidationRules.runValidation(db, tenant, {});
    assert.ok(sweep.evaluated >= 1);
    assert.ok(sweep.rule_count >= 3);
  });

  test("delete guardrails: children block deletion, released requirements are immutable", () => {
    const parent = Requirements.createRequirement(db, tenant, { title: "Delete parent", requirement_type: "business_requirement" }, null, null);
    Requirements.createRequirement(db, tenant, { title: "Delete child", requirement_type: "system_requirement", parent_id: parent.id }, null, null);
    assert.throws(
      () => Requirements.deleteRequirement(db, tenant, parent.id, null, null),
      (err) => err.code === "REQUIREMENT_CONFLICT"
    );

    const released = Requirements.createRequirement(db, tenant, { title: "Un-deletable", requirement_type: "business_requirement" }, null, null);
    Requirements.submitRequirement(db, tenant, released.id, null, null);
    Requirements.approveRequirement(db, tenant, released.id, null, null);
    Requirements.releaseRequirement(db, tenant, released.id, null, null);
    assert.throws(
      () => Requirements.deleteRequirement(db, tenant, released.id, null, null),
      (err) => err.code === "REQUIREMENT_IMMUTABLE"
    );

    const draft = Requirements.createRequirement(db, tenant, { title: "Deletable", requirement_type: "business_requirement" }, null, null);
    assert.equal(Requirements.deleteRequirement(db, tenant, draft.id, null, null).deleted, true);
  });

  test("standardized 404s for unknown refs", () => {
    assert.throws(() => Requirements.getRequirement(db, tenant, "does-not-exist"), (err) => err.code === "REQUIREMENT_NOT_FOUND");
    assert.equal(Relationships.getRelationship(db, tenant, "does-not-exist"), null);
    assert.throws(() => Baselines.getBaseline(db, tenant, "does-not-exist"), (err) => err.code === "REQUIREMENT_BASELINE_NOT_FOUND");
  });

  test("seedRequirements installs an idempotent demo chain", () => {
    const result = Seed.seedRequirements(db, tenant);
    assert.equal(result.seeded, true);
    assert.equal(Requirements.getRequirement(db, tenant, result.business.id).status, "RELEASED");
    assert.equal(result.baseline.status, "RELEASED");

    const again = Seed.seedRequirements(db, tenant);
    assert.equal(again.seeded, false);
    assert.equal(again.reason, "already_seeded");
  });

  test("reports health across the domain tables", () => {
    const health = Foundation.requirementsHealth(db, tenant);
    assert.equal(health.source_module, "requirements");
    assert.ok(health.counts.requirements > 0);
    assert.ok(health.counts.revisions > 0);
    assert.ok(health.counts.baselines > 0);
  });
});

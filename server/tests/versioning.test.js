process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import * as versioning from "../services/versioning.js";

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

function actorRow(db, username) {
  return queryOne(db, "SELECT * FROM users WHERE username = ?", [username]);
}

function rev(db, objectId, code, extra = {}) {
  return versioning.Revisions.createRevision(
    db,
    { objectType: "Part", objectId, revisionCode: code, status: "active", ...extra },
    null,
    extra.tenantId ?? null,
    "test"
  );
}

function dateDef(db, code, from, to, extra = {}) {
  return versioning.Effectivities.createDefinition(
    db,
    { code, name: code, typeCode: "DATE_EFFECTIVITY", dimension: "date", effectiveFrom: from, effectiveTo: to, ...extra },
    null,
    null,
    "test"
  );
}

function serialDef(db, code, from, to, extra = {}) {
  return versioning.Effectivities.createDefinition(
    db,
    {
      code,
      name: code,
      typeCode: "SERIAL_EFFECTIVITY",
      dimension: "serial",
      serialFrom: from,
      serialTo: to,
      serialMode: "numeric",
      ...extra,
    },
    null,
    null,
    "test"
  );
}

function plantDef(db, code, values, extra = {}) {
  return versioning.Effectivities.createDefinition(
    db,
    {
      code,
      name: code,
      typeCode: "PLANT_EFFECTIVITY",
      dimension: "plant",
      values: values.map((value) => ({ dimension: "plant", value })),
      ...extra,
    },
    null,
    null,
    "test"
  );
}

function modelDef(db, code, values, extra = {}) {
  return versioning.Effectivities.createDefinition(
    db,
    {
      code,
      name: code,
      typeCode: "MODEL_EFFECTIVITY",
      dimension: "model",
      values: values.map((value) => ({ dimension: "model", value })),
      ...extra,
    },
    null,
    null,
    "test"
  );
}

describe("Versioning foundation & revisions", () => {
  let db;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
  });
  after(() => db?.close());

  test("seeds effectivity types, default policy and demo data", () => {
    const types = versioning.Effectivities.listEffectivityTypes(db).map((t) => t.code);
    for (const code of ["DATE_EFFECTIVITY", "SERIAL_EFFECTIVITY", "PLANT_EFFECTIVITY", "MODEL_EFFECTIVITY", "REVISION_EFFECTIVITY"]) {
      assert.ok(types.includes(code), code);
    }
    const policy = versioning.Policies.defaultPolicyRow(db);
    assert.ok(policy);
    assert.equal(policy.is_default, 1);
    const seeded = versioning.Revisions.listRevisions(db, { objectId: "PART-DEMO-DATE" });
    assert.equal(seeded.total, 2);
  });

  test("creates revisions with monotonic sequence and a single default", () => {
    const objectId = nextId("REVOBJ");
    const a = rev(db, objectId, "A", { isDefault: true });
    const b = rev(db, objectId, "B");
    assert.equal(a.revision_sequence, 1);
    assert.equal(b.revision_sequence, 2);
    assert.equal(a.is_default, true);
    const fetched = versioning.Revisions.getRevision(db, a.id);
    assert.equal(fetched.revision_code, "A");
    const updated = versioning.Revisions.setDefaultRevision(db, b.id);
    assert.equal(updated.is_default, true);
    assert.equal(versioning.Revisions.getRevision(db, a.id).is_default, false);
  });

  test("rejects duplicate revision codes for the same object", () => {
    const objectId = nextId("REVOBJ");
    rev(db, objectId, "A");
    assert.throws(() => rev(db, objectId, "A"), /already exists|INVALID_REVISION/);
  });

  test("activates and supersedes revisions with lifecycle transitions", () => {
    const objectId = nextId("REVOBJ");
    const a = rev(db, objectId, "A", { status: "draft" });
    const active = versioning.Revisions.activateRevision(db, a.revision_ref);
    assert.equal(active.status, "active");
    assert.ok(active.released_at);
    const superseded = versioning.Revisions.supersedeRevision(db, a.revision_ref);
    assert.equal(superseded.status, "superseded");
    assert.ok(superseded.superseded_at);
  });

  test("prevents circular revision relationships", () => {
    const objectId = nextId("REVOBJ");
    const a = rev(db, objectId, "A");
    const b = rev(db, objectId, "B");
    versioning.Revisions.createRelationship(db, a.revision_ref, { toRevisionId: b.revision_ref, relationshipType: "effective_after" });
    assert.throws(
      () => versioning.Revisions.createRelationship(db, b.revision_ref, { toRevisionId: a.revision_ref, relationshipType: "effective_after" }),
      /circular/i
    );
  });

  test("creates and compares versions inside a revision", () => {
    const objectId = nextId("REVOBJ");
    const a = rev(db, objectId, "A");
    const v1 = versioning.Versions.createVersion(db, a.revision_ref, { versionNumber: "1", status: "active", isDefault: true });
    const v2 = versioning.Versions.createVersion(db, a.revision_ref, { versionNumber: "2" });
    assert.equal(v1.version_sequence, 1);
    const listed = versioning.Versions.listVersions(db, a.revision_ref);
    assert.equal(listed.total, 2);
    const compared = versioning.Versions.compareVersions(db, v1.version_ref, v2.version_ref);
    assert.equal(compared.same_revision, true);
    assert.ok(compared.changes.some((c) => c.field === "version_sequence"));
  });
});

describe("Effectivity validation and definitions", () => {
  let db;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
  });
  after(() => db?.close());

  test("rejects inverted date and serial ranges", () => {
    assert.throws(() => dateDef(db, nextId("BAD"), "2026-06-01", "2026-01-01"), /effectiveFrom must be <= effectiveTo/);
    assert.throws(() => serialDef(db, nextId("BAD"), "0500", "0100"), /serialFrom must be <= serialTo/);
  });

  test("rejects prohibited overlapping effectivity on the same revision", () => {
    const objectId = nextId("OVLOBJ");
    const revision = rev(db, objectId, "A");
    const first = dateDef(db, nextId("OVL"), "2026-01-01", "2026-06-30");
    versioning.Effectivities.createAssignment(db, first.definition_ref, {
      objectType: "Part",
      objectId,
      revisionId: revision.id,
    });
    const overlapping = dateDef(db, nextId("OVL"), "2026-03-01", "2026-09-30");
    assert.throws(
      () =>
        versioning.Effectivities.createAssignment(db, overlapping.definition_ref, {
          objectType: "Part",
          objectId,
          revisionId: revision.id,
        }),
      /overlap/i
    );
  });

  test("allows overlap when explicitly permitted", () => {
    const a = dateDef(db, nextId("OVLOK"), "2026-01-01", "2026-06-30");
    const b = dateDef(db, nextId("OVLOK"), "2026-03-01", "2026-09-30", { overlapAllowed: true });
    assert.ok(a.id && b.id);
  });

  test("assigns effectivity to a revision and validates target ownership", () => {
    const objectId = nextId("ASGOBJ");
    const a = rev(db, objectId, "A");
    const def = plantDef(db, nextId("ASG"), ["PLANT01"]);
    const assignment = versioning.Effectivities.createAssignment(
      db,
      def.definition_ref,
      { objectType: "Part", objectId, revisionId: a.id },
      null,
      null
    );
    assert.ok(assignment.assignment_ref);
    assert.throws(
      () =>
        versioning.Effectivities.createAssignment(
          db,
          def.definition_ref,
          { objectType: "Part", objectId: "OTHER", revisionId: a.id },
          null,
          null
        ),
      /does not belong/
    );
  });

  test("inspects an object for overlaps, gaps and open-ended effectivity", () => {
    const objectId = nextId("INSPECT");
    const a = rev(db, objectId, "A");
    const b = rev(db, objectId, "B");
    const jan = dateDef(db, nextId("INS"), "2026-01-01", "2026-03-31");
    versioning.Effectivities.createAssignment(db, jan.definition_ref, { objectType: "Part", objectId, revisionId: a.id });
    const jun = dateDef(db, nextId("INS"), "2026-06-01", null, { overlapAllowed: true });
    versioning.Effectivities.createAssignment(db, jun.definition_ref, { objectType: "Part", objectId, revisionId: b.id });
    const inspection = versioning.Effectivities.inspectObject(db, { objectType: "Part", objectId, asOf: "2026-05-01" });
    assert.equal(inspection.has_conflicts, false);
    assert.ok(inspection.gaps.length >= 1);
    assert.ok(inspection.open_ended.length >= 1);
    assert.ok(jan.definition_ref);
  });
});

describe("As-of resolution engine", () => {
  let db;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
  });
  after(() => db?.close());

  test("resolves by date across two revisions", () => {
    const objectId = nextId("RESDATE");
    rev(db, objectId, "A", { effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30", isDefault: true });
    rev(db, objectId, "B", { effectiveFrom: "2026-07-01" });
    const may = versioning.resolveEffectivity(db, { objectType: "Part", objectId, context: { asOfDate: "2026-05-01" } });
    assert.equal(may.resolutionStatus, "RESOLVED");
    assert.equal(may.revisionCode, "A");
    assert.equal(may.resolutionReason, "DATE_EFFECTIVITY");
    const aug = versioning.resolveEffectivity(db, { objectType: "Part", objectId, context: { asOfDate: "2026-08-01" } });
    assert.equal(aug.revisionCode, "B");
  });

  test("resolves numeric serial ranges", () => {
    const objectId = nextId("RESSER");
    const a = rev(db, objectId, "A", { isDefault: true });
    const b = rev(db, objectId, "B");
    const defA = serialDef(db, nextId("SER"), "0001", "0500");
    const defB = serialDef(db, nextId("SER"), "0501", "1000");
    versioning.Effectivities.createAssignment(db, defA.definition_ref, { objectType: "Part", objectId, revisionId: a.id });
    versioning.Effectivities.createAssignment(db, defB.definition_ref, { objectType: "Part", objectId, revisionId: b.id });
    assert.equal(versioning.resolveEffectivity(db, { objectType: "Part", objectId, context: { serialNumber: "0250" } }).revisionCode, "A");
    assert.equal(versioning.resolveEffectivity(db, { objectType: "Part", objectId, context: { serialNumber: "0750" } }).revisionCode, "B");
  });

  test("resolves alphanumeric serial ranges", () => {
    const objectId = nextId("RESALPHA");
    const a = rev(db, objectId, "A", { isDefault: true });
    const b = rev(db, objectId, "B");
    const defA = serialDef(db, nextId("ALP"), "A-001", "A-100", { serialMode: "alphanumeric" });
    const defB = serialDef(db, nextId("ALP"), "A-101", "A-999", { serialMode: "alphanumeric" });
    versioning.Effectivities.createAssignment(db, defA.definition_ref, { objectType: "Part", objectId, revisionId: a.id });
    versioning.Effectivities.createAssignment(db, defB.definition_ref, { objectType: "Part", objectId, revisionId: b.id });
    assert.equal(versioning.resolveEffectivity(db, { objectType: "Part", objectId, context: { serialNumber: "A-050" } }).revisionCode, "A");
    assert.equal(versioning.resolveEffectivity(db, { objectType: "Part", objectId, context: { serialNumber: "A-500" } }).revisionCode, "B");
  });

  test("resolves by plant and by model", () => {
    const plantObj = nextId("RESPLANT");
    const pA = rev(db, plantObj, "A", { isDefault: true });
    const pB = rev(db, plantObj, "B");
    versioning.Effectivities.createAssignment(db, plantDef(db, nextId("PL"), ["PLANT01"]).definition_ref, {
      objectType: "Part",
      objectId: plantObj,
      revisionId: pA.id,
    });
    versioning.Effectivities.createAssignment(db, plantDef(db, nextId("PL"), ["PLANT02"]).definition_ref, {
      objectType: "Part",
      objectId: plantObj,
      revisionId: pB.id,
    });
    assert.equal(versioning.resolveEffectivity(db, { objectType: "Part", objectId: plantObj, context: { plantId: "PLANT01" } }).revisionCode, "A");
    assert.equal(versioning.resolveEffectivity(db, { objectType: "Part", objectId: plantObj, context: { plantId: "PLANT02" } }).revisionCode, "B");

    const modelObj = nextId("RESMODEL");
    const mA = rev(db, modelObj, "A", { isDefault: true });
    const mB = rev(db, modelObj, "B");
    versioning.Effectivities.createAssignment(db, modelDef(db, nextId("MD"), ["MODEL-X", "MODEL-Y"]).definition_ref, {
      objectType: "Part",
      objectId: modelObj,
      revisionId: mA.id,
    });
    versioning.Effectivities.createAssignment(db, modelDef(db, nextId("MD"), ["MODEL-Z"]).definition_ref, {
      objectType: "Part",
      objectId: modelObj,
      revisionId: mB.id,
    });
    assert.equal(versioning.resolveEffectivity(db, { objectType: "Part", objectId: modelObj, context: { modelId: "MODEL-X" } }).revisionCode, "A");
    assert.equal(versioning.resolveEffectivity(db, { objectType: "Part", objectId: modelObj, context: { modelId: "MODEL-Z" } }).revisionCode, "B");
  });

  test("resolves a combined context deterministically", () => {
    const objectId = nextId("RESCOMBO");
    const a = rev(db, objectId, "A", { isDefault: true });
    const b = rev(db, objectId, "B");
    const dA = serialDef(db, nextId("CMB"), "0001", "0500", { effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" });
    const dB = serialDef(db, nextId("CMB"), "0501", "1000", { effectiveFrom: "2026-07-01", effectiveTo: null });
    versioning.Effectivities.createAssignment(db, dA.definition_ref, { objectType: "Part", objectId, revisionId: a.id });
    versioning.Effectivities.createAssignment(db, dB.definition_ref, { objectType: "Part", objectId, revisionId: b.id });
    const result = versioning.resolveEffectivity(db, {
      objectType: "Part",
      objectId,
      context: { asOfDate: "2026-05-01", serialNumber: "0250", plantId: "PLANT01", modelId: "MODEL-X" },
    });
    assert.equal(result.resolutionStatus, "RESOLVED");
    assert.equal(result.revisionCode, "A");
  });

  test("returns NOT_FOUND when no revision applies", () => {
    const objectId = nextId("RESNONE");
    rev(db, objectId, "A", { isDefault: true });
    const result = versioning.resolveEffectivity(db, { objectType: "Part", objectId, context: { plantId: "PLANT99" } });
    assert.equal(result.resolutionStatus, "NOT_FOUND");
  });

  test("returns AMBIGUOUS instead of choosing arbitrarily", () => {
    const objectId = nextId("RESAMB");
    const a = rev(db, objectId, "A", { isDefault: true });
    const b = rev(db, objectId, "B");
    versioning.Effectivities.createAssignment(db, plantDef(db, nextId("AMB"), ["PLANT01"]).definition_ref, {
      objectType: "Part",
      objectId,
      revisionId: a.id,
    });
    versioning.Effectivities.createAssignment(db, plantDef(db, nextId("AMB"), ["PLANT01"]).definition_ref, {
      objectType: "Part",
      objectId,
      revisionId: b.id,
    });
    const result = versioning.resolveEffectivity(db, { objectType: "Part", objectId, context: { plantId: "PLANT01" } });
    assert.equal(result.resolutionStatus, "AMBIGUOUS");
    assert.equal(result.code, "AMBIGUOUS_RESOLUTION");
  });

  test("returns CONFLICT for overlapping competing effectivity", () => {
    const objectId = nextId("RESCONF");
    const a = rev(db, objectId, "A", { isDefault: true });
    const b = rev(db, objectId, "B");
    const dA = dateDef(db, nextId("CONF"), "2026-01-01", "2026-06-30");
    const dB = dateDef(db, nextId("CONF"), "2026-03-01", "2026-09-30", { overlapAllowed: true });
    versioning.Effectivities.createAssignment(db, dA.definition_ref, { objectType: "Part", objectId, revisionId: a.id });
    versioning.Effectivities.createAssignment(db, dB.definition_ref, { objectType: "Part", objectId, revisionId: b.id });
    const result = versioning.resolveEffectivity(db, { objectType: "Part", objectId, context: { asOfDate: "2026-05-01" } });
    assert.equal(result.resolutionStatus, "CONFLICT");
    assert.equal(result.code, "EFFECTIVITY_CONFLICT");
  });

  test("returns INVALID_CONTEXT for an unknown revision reference", () => {
    const objectId = nextId("RESBAD");
    rev(db, objectId, "A", { isDefault: true });
    const result = versioning.resolveEffectivity(db, { objectType: "Part", objectId, context: { revisionId: "REV-DOES-NOT-EXIST" } });
    assert.equal(result.resolutionStatus, "INVALID_CONTEXT");
  });

  test("falls back to the default revision for an empty context", () => {
    const objectId = nextId("RESDEF");
    rev(db, objectId, "A", { isDefault: true });
    rev(db, objectId, "B");
    const result = versioning.resolveEffectivity(db, { objectType: "Part", objectId, context: {} });
    assert.equal(result.resolutionStatus, "RESOLVED");
    assert.equal(result.resolutionReason, "DEFAULT_REVISION");
    assert.equal(result.revisionCode, "A");
  });

  test("honours a configurable precedence policy", () => {
    const objectId = nextId("RESPOL");
    const a = rev(db, objectId, "A", { isDefault: true });
    const b = rev(db, objectId, "B");
    const serialA = serialDef(db, nextId("POL"), "0001", "0500", { effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" });
    const serialB = serialDef(db, nextId("POL"), "0501", "1000", { effectiveFrom: "2026-07-01", effectiveTo: null });
    versioning.Effectivities.createAssignment(db, serialA.definition_ref, { objectType: "Part", objectId, revisionId: a.id });
    versioning.Effectivities.createAssignment(db, serialB.definition_ref, { objectType: "Part", objectId, revisionId: b.id });
    const withDefault = versioning.resolveEffectivity(db, { objectType: "Part", objectId, context: { asOfDate: "2026-05-01", serialNumber: "0750" } });
    // Default precedence: serial before date -> B.
    assert.equal(withDefault.revisionCode, "B");
    const policy = versioning.Policies.createResolutionPolicy(
      db,
      { code: nextId("DATE-FIRST"), name: "Date first", precedence: ["date", "serial", "default"], ambiguityStrategy: "error" },
      null
    );
    const withPolicy = versioning.resolveEffectivity(db, {
      objectType: "Part",
      objectId,
      policy: policy.code,
      context: { asOfDate: "2026-05-01", serialNumber: "0750" },
    });
    assert.equal(withPolicy.revisionCode, "A");
  });

  test("resolves bulk without N+1 and reports per-object results", () => {
    const objA = nextId("BULK");
    const objB = nextId("BULK");
    rev(db, objA, "A", { effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30", isDefault: true });
    rev(db, objA, "B", { effectiveFrom: "2026-07-01" });
    rev(db, objB, "A", { effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30", isDefault: true });
    rev(db, objB, "B", { effectiveFrom: "2026-07-01" });
    const bulk = versioning.resolveEffectivityBulk(db, {
      context: { asOfDate: "2026-08-01" },
      objects: [
        { objectType: "Part", objectId: objA },
        { objectType: "Part", objectId: objB },
      ],
    });
    assert.equal(bulk.count, 2);
    assert.equal(bulk.resolved, 2);
    assert.equal(bulk.results[0].revisionCode, "B");
    assert.equal(bulk.results[1].revisionCode, "B");
  });

  test("records resolution results for observability", () => {
    const objectId = nextId("RESMETRIC");
    rev(db, objectId, "A", { isDefault: true });
    versioning.resolveEffectivity(db, { objectType: "Part", objectId, context: {} });
    const metrics = versioning.Metrics.metricsSnapshot(db);
    assert.ok(metrics.resolution_requests >= 1);
    assert.ok(metrics.resolution_latency.max_ms !== null);
    const health = versioning.Metrics.healthCheck(db);
    assert.equal(health.service, "versioning");
    assert.equal(health.healthy, true);
  });
});

describe("Variants, configuration contexts, baselines and snapshots", () => {
  let db;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
  });
  after(() => db?.close());

  test("creates a variant with options and evaluates applicability", () => {
    const code = nextId("VAR");
    const variant = versioning.Variants.createVariant(
      db,
      {
        code,
        name: "Test variant",
        options: [{ code: "BASE" }, { code: "ELECTRIC" }],
        rules: [{ code: "ONLY-ELECTRIC", ruleType: "inclusion", expression: { dimension: "variantCode", operator: "in", values: ["ELECTRIC"] } }],
      },
      null
    );
    assert.equal(variant.options.length, 2);
    const included = versioning.Variants.evaluateVariant(db, variant.variant_ref, { variantCode: "ELECTRIC" });
    assert.equal(included.applicable, true);
    const excluded = versioning.Variants.evaluateVariant(db, variant.variant_ref, { variantCode: "BASE" });
    assert.equal(excluded.applicable, false);
  });

  test("creates a configuration context and resolves using it", () => {
    const objectId = nextId("CFGRES");
    const a = rev(db, objectId, "A", { isDefault: true });
    const b = rev(db, objectId, "B");
    versioning.Effectivities.createAssignment(db, plantDef(db, nextId("CFG"), ["PLANT01"]).definition_ref, {
      objectType: "Part",
      objectId,
      revisionId: a.id,
    });
    versioning.Effectivities.createAssignment(db, plantDef(db, nextId("CFG"), ["PLANT02"]).definition_ref, {
      objectType: "Part",
      objectId,
      revisionId: b.id,
    });
    const context = versioning.ConfigurationContexts.createConfigurationContext(
      db,
      { code: nextId("CFGCTX"), name: "Plant 02 context", plantId: "PLANT02" },
      null
    );
    const result = versioning.resolveEffectivity(db, { objectType: "Part", objectId, context: { configurationId: context.context_ref } });
    assert.equal(result.resolutionStatus, "RESOLVED");
    assert.equal(result.revisionCode, "B");
  });

  test("freezes a baseline and keeps it reproducible after new revisions", () => {
    const objectId = nextId("BLOBJ");
    rev(db, objectId, "A", { effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30", isDefault: true });
    rev(db, objectId, "B", { effectiveFrom: "2026-07-01" });
    const baseline = versioning.Baselines.createBaseline(
      db,
      { code: nextId("BL"), name: "Release baseline", context: { asOfDate: "2026-05-01" }, objects: [{ objectType: "Part", objectId }] },
      null
    );
    assert.equal(baseline.objects[0].revision_code, "A");
    const frozen = versioning.Baselines.freezeBaseline(db, baseline.baseline_ref);
    assert.equal(frozen.status, "frozen");
    assert.equal(frozen.locked, true);
    // A later revision must not change the frozen baseline.
    rev(db, objectId, "C", { effectiveFrom: "2027-01-01" });
    const restored = versioning.Baselines.restoreBaseline(db, baseline.baseline_ref);
    assert.equal(restored.restorable, true);
    assert.equal(restored.objects[0].revision_code, "A");
    assert.throws(() => versioning.Baselines.addBaselineObjects(db, baseline.baseline_ref, [{ objectType: "Part", objectId }]), /frozen/i);
  });

  test("creates an immutable snapshot and reconstructs it", () => {
    const objectId = nextId("SNAPOBJ");
    rev(db, objectId, "A", { effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30", isDefault: true });
    const snapshot = versioning.Snapshots.createSnapshot(
      db,
      { code: nextId("SNAP"), name: "Historical snapshot", context: { asOfDate: "2026-05-01" }, objects: [{ objectType: "Part", objectId }] },
      null
    );
    assert.equal(snapshot.objects[0].revision_code, "A");
    assert.ok(snapshot.content_hash);
    const reconstructed = versioning.Snapshots.reconstructSnapshot(db, snapshot.snapshot_ref);
    assert.equal(reconstructed.immutable, true);
    assert.equal(reconstructed.objects[0].revision_code, "A");
    const archived = versioning.Snapshots.archiveSnapshot(db, snapshot.snapshot_ref);
    assert.equal(archived.status, "archived");
  });
});

describe("Versioning REST API", () => {
  let db;
  let server;
  let port;

  before(async () => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    const app = createApp(db);
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db?.close();
  });

  function request(method, path, { token, body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            let parsed = Buffer.concat(chunks).toString("utf8");
            try {
              parsed = parsed ? JSON.parse(parsed) : null;
            } catch {
              /* keep text */
            }
            resolve({ status: res.statusCode, body: parsed });
          });
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function login(username, password) {
    const res = await request("POST", "/api/auth/login", { body: { username, password } });
    return res.body.token;
  }

  test("requires authentication", async () => {
    const res = await request("GET", "/api/v1/revisions");
    assert.equal(res.status, 401);
  });

  test("creates and reads a revision through the versioned API", async () => {
    const token = await login("admin", "HelixAdmin!42");
    const objectId = nextId("API");
    const created = await request("POST", "/api/v1/revisions", {
      token,
      body: { objectType: "Part", objectId, revisionCode: "A", status: "active" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.revision_code, "A");
    const fetched = await request("GET", `/api/v1/revisions/${created.body.revision_ref}`, { token });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.object_id, objectId);
    const listed = await request("GET", `/api/v1/revisions?objectId=${objectId}`, { token });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.total, 1);
  });

  test("rejects invalid effectivity with a structured error", async () => {
    const token = await login("admin", "HelixAdmin!42");
    const res = await request("POST", "/api/v1/versioning/effectivities", {
      token,
      body: { code: nextId("BAD"), name: "bad", typeCode: "DATE_EFFECTIVITY", dimension: "date", effectiveFrom: "2026-06-01", effectiveTo: "2026-01-01" },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "INVALID_EFFECTIVITY");
  });

  test("resolves and bulk-resolves through the API", async () => {
    const token = await login("admin", "HelixAdmin!42");
    const objectId = nextId("APIRES");
    await request("POST", "/api/v1/revisions", { token, body: { objectType: "Part", objectId, revisionCode: "A", effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30", isDefault: true } });
    await request("POST", "/api/v1/revisions", { token, body: { objectType: "Part", objectId, revisionCode: "B", effectiveFrom: "2026-07-01" } });
    const resolved = await request("POST", "/api/v1/effectivity/resolve", {
      token,
      body: { objectType: "Part", objectId, context: { asOfDate: "2026-08-01" } },
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.resolutionStatus, "RESOLVED");
    assert.equal(resolved.body.revisionCode, "B");
    const bulk = await request("POST", "/api/v1/effectivity/resolve/bulk", {
      token,
      body: { context: { asOfDate: "2026-05-01" }, objects: [{ objectType: "Part", objectId }] },
    });
    assert.equal(bulk.status, 200);
    assert.equal(bulk.body.results[0].revisionCode, "A");
  });

  test("exposes metadata, dashboard and health", async () => {
    const token = await login("admin", "HelixAdmin!42");
    const meta = await request("GET", "/api/v1/versioning/meta", { token });
    assert.equal(meta.status, 200);
    assert.ok(meta.body.resolution_statuses.includes("RESOLVED"));
    assert.ok(meta.body.effectivity_types.length >= 5);
    const dashboard = await request("GET", "/api/v1/versioning/dashboard", { token });
    assert.equal(dashboard.status, 200);
    assert.ok(dashboard.body.metrics);
    const health = await request("GET", "/api/v1/versioning/health/ready", { token });
    assert.equal(health.status, 200);
    assert.equal(health.body.service, "versioning");
  });

  test("enforces authorization for privileged operations", async () => {
    const token = await login("j.patel", "HelixUser!42");
    const res = await request("POST", "/api/v1/resolution-policies", {
      token,
      body: { code: nextId("POL"), name: "nope", precedence: ["date"] },
    });
    assert.equal(res.status, 403);
  });
});

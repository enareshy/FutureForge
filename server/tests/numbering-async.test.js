process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as numbering from "../services/numbering.js";

describe("async numbering read twins mirror the synchronous service", () => {
  let db;
  let admin;
  let tenant;
  let scheme;
  let allocation;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    admin = queryOne(db, "SELECT * FROM users WHERE username = ?", ["admin"]);
    tenant = admin.tenant_id ?? null;
    scheme = numbering.Schemes.createScheme(
      db,
      {
        code: `ASYNC_${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        name: "Async parity scheme",
        object_type_code: "PART",
        pattern: "ASY-{SEQ}",
        padding: 4,
        sequence_scope: "scheme",
        reset_policy: "never",
        numbering_mode: "automatic",
        status: "active",
      },
      admin,
      tenant,
      "test"
    );
    allocation = numbering.Allocations.generateNumber(
      db,
      { object_type_code: "PART", scheme_code: scheme.code },
      admin,
      { tenantId: tenant, ip: "test" }
    );
  });

  after(() => db?.close());

  test("token reads match", async () => {
    assert.deepEqual(await numbering.Tokens.listTokensAsync(db), numbering.Tokens.listTokens(db));
    assert.deepEqual(
      await numbering.Tokens.listTokensAsync(db, { activeOnly: true }),
      numbering.Tokens.listTokens(db, { activeOnly: true })
    );
    assert.deepEqual(await numbering.Tokens.getTokenAsync(db, "SEQ"), numbering.Tokens.getToken(db, "SEQ"));
    assert.deepEqual(
      await numbering.Tokens.checkPatternTokensAsync(db, "{PART}-{SEQ}"),
      numbering.Tokens.checkPatternTokens(db, "{PART}-{SEQ}")
    );
    const at = new Date("2026-09-19T00:00:00Z");
    assert.deepEqual(
      await numbering.Tokens.resolveTokenValuesAsync(db, { now: at, sequence: "0001", objectType: "PART" }),
      numbering.Tokens.resolveTokenValues(db, { now: at, sequence: "0001", objectType: "PART" })
    );
  });

  test("scope and foundation reads match", async () => {
    assert.deepEqual(await numbering.Scopes.listScopesAsync(db), numbering.Scopes.listScopes(db));
    assert.deepEqual(await numbering.Scopes.getSchemeRowAsync(db, scheme.code), numbering.Scopes.getSchemeRow(db, scheme.code));
    const request = { objectTypeCode: "PART", tenantId: tenant, schemeCode: scheme.code };
    assert.deepEqual(
      await numbering.Scopes.resolveApplicableSchemeAsync(db, request),
      numbering.Scopes.resolveApplicableScheme(db, request)
    );
    assert.deepEqual(
      await numbering.Foundation.listObjectTypesAsync(db, { tenantId: tenant }),
      numbering.Foundation.listObjectTypes(db, { tenantId: tenant })
    );
  });

  test("scheme reads match", async () => {
    assert.deepEqual(
      await numbering.Schemes.listSchemesAsync(db, { tenantId: tenant }),
      numbering.Schemes.listSchemes(db, { tenantId: tenant })
    );
    assert.deepEqual(await numbering.Schemes.getSchemeAsync(db, scheme.code), numbering.Schemes.getScheme(db, scheme.code));
    assert.deepEqual(
      await numbering.Schemes.listVersionsAsync(db, scheme.id),
      numbering.Schemes.listVersions(db, scheme.id)
    );
    assert.deepEqual(
      await numbering.Schemes.validateSchemeAsync(db, scheme.code),
      numbering.Schemes.validateScheme(db, scheme.code)
    );
  });

  test("sequence reads match", async () => {
    const sequence = queryOne(db, "SELECT * FROM numbering_sequences WHERE scheme_id = ?", [scheme.id]);
    assert.deepEqual(await numbering.Sequences.getSequenceRowAsync(db, sequence.id), numbering.Sequences.getSequenceRow(db, sequence.id));
    assert.deepEqual(
      await numbering.Sequences.publicSequenceAsync(db, sequence),
      numbering.Sequences.publicSequence(db, sequence)
    );
    assert.deepEqual(
      await numbering.Sequences.listSequencesAsync(db, { schemeId: scheme.id, tenantId: tenant }),
      numbering.Sequences.listSequences(db, { schemeId: scheme.id, tenantId: tenant })
    );
  });

  test("allocation reads match", async () => {
    assert.deepEqual(
      await numbering.Allocations.listAllocationsAsync(db, { tenantId: tenant }),
      numbering.Allocations.listAllocations(db, { tenantId: tenant })
    );
    assert.deepEqual(
      await numbering.Allocations.getAllocationAsync(db, allocation.allocation_ref),
      numbering.Allocations.getAllocation(db, allocation.allocation_ref)
    );
    assert.deepEqual(
      await numbering.Allocations.previewNumberAsync(
        db,
        { object_type_code: "PART", scheme_code: scheme.code },
        { tenantId: tenant }
      ),
      numbering.Allocations.previewNumber(db, { object_type_code: "PART", scheme_code: scheme.code }, { tenantId: tenant })
    );
    assert.deepEqual(
      await numbering.Allocations.validateIdentifierAsync(
        db,
        { object_type_code: "PART", scheme_code: scheme.code, number: allocation.number },
        { tenantId: tenant }
      ),
      numbering.Allocations.validateIdentifier(
        db,
        { object_type_code: "PART", scheme_code: scheme.code, number: allocation.number },
        { tenantId: tenant }
      )
    );
  });

  test("metrics reads match", async () => {
    assert.deepEqual(
      await numbering.Allocations.metricsSnapshotAsync(db, { tenantId: tenant }),
      numbering.Allocations.metricsSnapshot(db, { tenantId: tenant })
    );
    assert.deepEqual(
      await numbering.Metrics.generationLatencyAsync(db, { tenantId: tenant }),
      numbering.Metrics.generationLatency(db, { tenantId: tenant })
    );
    assert.deepEqual(
      await numbering.Metrics.dashboardSummaryAsync(db, { tenantId: tenant }),
      numbering.Metrics.dashboardSummary(db, { tenantId: tenant })
    );
    const asyncHealth = await numbering.Metrics.healthCheckAsync(db, { tenantId: tenant });
    const syncHealth = numbering.Metrics.healthCheck(db, { tenantId: tenant });
    delete asyncHealth.timestamp;
    delete syncHealth.timestamp;
    assert.deepEqual(asyncHealth, syncHealth);
  });

  test("async scheme resolution rejects unknown object types like the sync path", async () => {
    await assert.rejects(
      () => numbering.Scopes.resolveApplicableSchemeAsync(db, { objectTypeCode: "NOPE" }),
      (err) => /NOPE/.test(err.message)
    );
  });
});

describe("async numbering write twins mirror the synchronous service", () => {
  let db;
  let admin;
  let tenant;
  let activeScheme;

  const uniqueCode = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    admin = queryOne(db, "SELECT * FROM users WHERE username = ?", ["admin"]);
    tenant = admin.tenant_id ?? null;
  });

  after(() => db?.close());

  test("createSchemeAsync persists and projects like the sync writer", async () => {
    const code = uniqueCode("AW");
    const created = await numbering.Schemes.createSchemeAsync(
      db,
      {
        code,
        name: "Async write scheme",
        object_type_code: "PART",
        pattern: "AW-{SEQ}",
        padding: 5,
        sequence_scope: "scheme",
        reset_policy: "never",
        numbering_mode: "automatic",
        status: "active",
      },
      admin,
      tenant,
      "test"
    );
    assert.equal(created.code, code);
    assert.equal(created.object_type, "PART");
    assert.equal(created.status, "active");
    assert.equal(created.version, 1);
    assert.equal(created.versions.length, 1);
    const fetched = await numbering.Schemes.getSchemeAsync(db, code);
    assert.deepEqual(fetched, created);
    activeScheme = created;
  });

  test("updateSchemeAsync bumps the version when configuration changes", async () => {
    const before = await numbering.Schemes.getSchemeAsync(db, activeScheme.code);
    const updated = await numbering.Schemes.updateSchemeAsync(
      db,
      activeScheme.code,
      { padding: 7, change_summary: "widen padding" },
      admin,
      "test"
    );
    assert.equal(updated.padding, 7);
    assert.equal(updated.version, before.version + 1);
  });

  test("setSchemeStatusAsync deactivates and reactivates", async () => {
    const inactive = await numbering.Schemes.setSchemeStatusAsync(db, activeScheme.code, "inactive", admin, "test");
    assert.equal(inactive.status, "inactive");
    const active = await numbering.Schemes.setSchemeStatusAsync(db, activeScheme.code, "active", admin, "test");
    assert.equal(active.status, "active");
  });

  test("cloneSchemeAsync copies the scheme into a draft", async () => {
    const cloneCode = uniqueCode("AWCOPY");
    const clone = await numbering.Schemes.cloneSchemeAsync(
      db,
      activeScheme.code,
      { code: cloneCode },
      admin,
      tenant,
      "test"
    );
    assert.equal(clone.code, cloneCode);
    assert.equal(clone.status, "draft");
    assert.equal(clone.is_default, false);
  });

  test("generateNumberAsync allocates, consumes and releases", async () => {
    const allocation = await numbering.Allocations.generateNumberAsync(
      db,
      { object_type_code: "PART", scheme_code: activeScheme.code },
      admin,
      { tenantId: tenant, ip: "test" }
    );
    assert.match(allocation.number, /^AW-\d+$/);
    assert.equal(allocation.status, "allocated");

    const consumed = await numbering.Allocations.consumeNumberAsync(
      db,
      allocation.allocation_ref,
      { object_id: 4242 },
      admin,
      { tenantId: tenant, ip: "test" }
    );
    assert.equal(consumed.status, "consumed");
    assert.equal(String(consumed.object_id), "4242");

    const second = await numbering.Allocations.reserveNumberAsync(
      db,
      { object_type_code: "PART", scheme_code: activeScheme.code },
      admin,
      { tenantId: tenant, ip: "test" }
    );
    assert.equal(second.status, "reserved");
    const released = await numbering.Allocations.releaseNumberAsync(
      db,
      second.allocation_ref,
      {},
      admin,
      { tenantId: tenant, ip: "test" }
    );
    assert.equal(released.status, "released");
  });

  test("generateNumberAsync is idempotent for a repeated key", async () => {
    const key = `idem-${Math.random().toString(36).slice(2)}`;
    const first = await numbering.Allocations.generateNumberAsync(
      db,
      { object_type_code: "PART", scheme_code: activeScheme.code },
      admin,
      { tenantId: tenant, ip: "test", idempotencyKey: key }
    );
    const second = await numbering.Allocations.generateNumberAsync(
      db,
      { object_type_code: "PART", scheme_code: activeScheme.code },
      admin,
      { tenantId: tenant, ip: "test", idempotencyKey: key }
    );
    assert.equal(second.number, first.number);
    assert.equal(second.idempotent_replay, true);
  });

  test("createObjectTypeAsync and setObjectTypeStatusAsync", async () => {
    const code = uniqueCode("AOT");
    const created = await numbering.Foundation.createObjectTypeAsync(
      db,
      { code, name: "Async object type" },
      admin,
      tenant,
      "test"
    );
    assert.equal(created.code, code);
    assert.equal(created.status, "active");
    const inactive = await numbering.Foundation.setObjectTypeStatusAsync(db, code, "inactive", admin, "test");
    assert.equal(inactive.status, "inactive");
  });

  test("createTokenAsync registers a custom token", async () => {
    const code = uniqueCode("ATK");
    const created = await numbering.Tokens.createTokenAsync(db, { code, resolver: "object_type" });
    assert.equal(created.code, code);
    assert.equal(created.resolver, "object_type");
    assert.equal(Number(created.is_system), 0);
  });

  test("deleteSchemeAsync removes an unused scheme", async () => {
    const code = uniqueCode("ADEL");
    await numbering.Schemes.createSchemeAsync(
      db,
      {
        code,
        name: "Disposable scheme",
        object_type_code: "PART",
        pattern: "AD-{SEQ}",
        sequence_scope: "scheme",
        reset_policy: "never",
        numbering_mode: "automatic",
        status: "draft",
      },
      admin,
      tenant,
      "test"
    );
    const result = await numbering.Schemes.deleteSchemeAsync(db, code, admin, "test");
    assert.equal(result.deleted, true);
    assert.equal(await numbering.Schemes.getSchemeAsync(db, code).catch(() => null), null);
  });
});

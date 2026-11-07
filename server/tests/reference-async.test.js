process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as reference from "../services/reference.js";

function adminActor(db) {
  const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  return row ? { id: row.id, username: row.username } : null;
}

function stripTimestamps(value) {
  if (Array.isArray(value)) return value.map(stripTimestamps);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "generated_at" || key === "timestamp") continue;
      out[key] = stripTimestamps(entry);
    }
    return out;
  }
  return value;
}

describe("async reference read twins mirror the synchronous service", () => {
  let db;
  let actor;
  let domain;
  let item;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
    reference.Domains.createDomain(db, { code: "ASYNC_REF", name: "Async reference domain" }, actor);
    domain = reference.Domains.requireDomain(db, "ASYNC_REF");
    item = reference.Items.createItem(db, { domain_code: "ASYNC_REF", code: "A1", name: "Async item one" }, actor);
    reference.Items.setItemStatus(db, item.item_ref, "active", actor);
  });

  after(() => db?.close());

  test("domain reads match", async () => {
    assert.deepEqual(await reference.Domains.listDomainsAsync(db, {}), reference.Domains.listDomains(db, {}));
    assert.deepEqual(await reference.Domains.getDomainAsync(db, "ASYNC_REF"), reference.Domains.getDomain(db, "ASYNC_REF"));
    assert.deepEqual(await reference.Domains.getDomainRowAsync(db, "ASYNC_REF"), reference.Domains.getDomainRow(db, "ASYNC_REF"));
    assert.deepEqual(
      await reference.Domains.listOwnershipHistoryAsync(db, { domainId: domain.id }),
      reference.Domains.listOwnershipHistory(db, { domainId: domain.id })
    );
  });

  test("governance reads match", async () => {
    assert.deepEqual(
      await reference.Governance.getActiveGovernancePolicyAsync(db, domain.id),
      reference.Governance.getActiveGovernancePolicy(db, domain.id)
    );
    assert.deepEqual(
      await reference.Governance.listGovernanceVersionsAsync(db, domain.id),
      reference.Governance.listGovernanceVersions(db, domain.id)
    );
  });

  test("item and version reads match", async () => {
    assert.deepEqual(
      await reference.Items.listItemsAsync(db, { domain_code: "ASYNC_REF" }),
      reference.Items.listItems(db, { domain_code: "ASYNC_REF" })
    );
    assert.deepEqual(await reference.Items.getItemAsync(db, item.item_ref), reference.Items.getItem(db, item.item_ref));
    assert.deepEqual(await reference.Versions.listVersionsAsync(db, item.id), reference.Versions.listVersions(db, item.id));
  });

  test("code, alias and translation reads match", async () => {
    assert.deepEqual(await reference.Codes.listCodesAsync(db, {}), reference.Codes.listCodes(db, {}));
    assert.deepEqual(await reference.Aliases.listAliasesAsync(db, {}), reference.Aliases.listAliases(db, {}));
    assert.deepEqual(await reference.Translations.listTranslationsAsync(db, {}), reference.Translations.listTranslations(db, {}));
  });

  test("hierarchy and relationship reads match", async () => {
    assert.deepEqual(await reference.Hierarchy.listEdgesAsync(db, {}), reference.Hierarchy.listEdges(db, {}));
    assert.deepEqual(await reference.Relationships.listRelationshipsAsync(db, {}), reference.Relationships.listRelationships(db, {}));
  });

  test("scope policy and resolution reads match", async () => {
    assert.deepEqual(
      await reference.Scopes.listScopePoliciesAsync(db, {}),
      reference.Scopes.listScopePolicies(db, {})
    );
    const input = { domainId: domain.id, code: "A1" };
    assert.deepEqual(
      await reference.Resolution.resolveValueAsync(db, input),
      reference.Resolution.resolveValue(db, input)
    );
    assert.deepEqual(
      await reference.Resolution.listValuesAsync(db, { domainId: domain.id }),
      reference.Resolution.listValues(db, { domainId: domain.id })
    );
  });

  test("approval, import/export and metrics reads match", async () => {
    assert.deepEqual(await reference.Approvals.listApprovalsAsync(db, {}), reference.Approvals.listApprovals(db, {}));
    assert.deepEqual(await reference.Approvals.listChangeRequestsAsync(db, {}), reference.Approvals.listChangeRequests(db, {}));
    assert.deepEqual(await reference.ImportExport.listImportsAsync(db, {}), reference.ImportExport.listImports(db, {}));
    assert.deepEqual(await reference.ImportExport.listExportsAsync(db, {}), reference.ImportExport.listExports(db, {}));
    assert.deepEqual(
      stripTimestamps(await reference.Metrics.metricsSnapshotAsync(db, {})),
      stripTimestamps(reference.Metrics.metricsSnapshot(db, {}))
    );
    assert.deepEqual(
      stripTimestamps(await reference.Metrics.dashboardSummaryAsync(db, {})),
      stripTimestamps(reference.Metrics.dashboardSummary(db, {}))
    );
    assert.deepEqual(
      stripTimestamps(await reference.Metrics.healthCheckAsync(db, {})),
      stripTimestamps(reference.Metrics.healthCheck(db, {}))
    );
  });
});

describe("async reference write twins mirror the synchronous service", () => {
  let db;
  let actor;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
  });

  after(() => db?.close());

  test("domain write lifecycle", async () => {
    const created = await reference.Domains.createDomainAsync(db, { code: "AW_DOMAIN", name: "Async write domain" }, actor);
    assert.equal(created.code, "AW_DOMAIN");
    const updated = await reference.Domains.updateDomainAsync(db, "AW_DOMAIN", { name: "Renamed domain" }, actor);
    assert.equal(updated.name, "Renamed domain");
    const inactive = await reference.Domains.setDomainStatusAsync(db, "AW_DOMAIN", "inactive", actor);
    assert.equal(inactive.status, "inactive");
    const version = await reference.Governance.publishGovernanceVersionAsync(
      db,
      reference.Domains.requireDomain(db, "AW_DOMAIN"),
      { approval_required: true, versioning_enabled: true },
      actor
    );
    assert.ok(version.version >= 1);
  });

  test("item write lifecycle with codes, aliases and translations", async () => {
    await reference.Domains.createDomainAsync(db, { code: "AW_ITEM", name: "Async item domain" }, actor);
    const item = await reference.Items.createItemAsync(
      db,
      { domain_code: "AW_ITEM", code: "I1", name: "Async item" },
      actor
    );
    assert.equal(item.code, "I1");
    const updated = await reference.Items.updateItemAsync(db, item.item_ref, { name: "Async item renamed" }, actor);
    assert.equal(updated.name, "Async item renamed");
    const active = await reference.Items.setItemStatusAsync(db, item.item_ref, "active", actor);
    assert.equal(active.status, "active");
    const code = await reference.Codes.createCodeAsync(db, active, { code: "I1-ALT", code_type: "alternate", code_system: "internal" }, actor);
    assert.equal(code.code, "I1-ALT");
    const alias = await reference.Aliases.createAliasAsync(db, active, { alias: "async-one", alias_type: "synonym", language: "fr" }, actor);
    assert.equal(alias.alias, "async-one");
    const translation = await reference.Translations.upsertTranslationAsync(db, active, { language: "fr", name: "Article" }, actor);
    assert.equal(translation.name, "Article");
  });

  test("scope policy, hierarchy and relationship writes", async () => {
    const policy = await reference.Scopes.createScopePolicyAsync(db, { code: "AW_PREC", precedence: ["GLOBAL"] }, actor);
    assert.ok(policy.id);
    await reference.Domains.createDomainAsync(db, { code: "AW_HIER", name: "Async hierarchy" }, actor);
    const parent = await reference.Items.createItemAsync(db, { domain_code: "AW_HIER", code: "P1", name: "Parent" }, actor);
    const child = await reference.Items.createItemAsync(db, { domain_code: "AW_HIER", code: "C1", name: "Child" }, actor);
    const edge = await reference.Hierarchy.createEdgeAsync(db, { parentId: parent.id, childId: child.id }, actor);
    assert.ok(edge.id ?? edge.edge_ref);
    const relation = await reference.Relationships.createRelationshipAsync(
      db,
      { sourceItemId: parent.id, targetItemId: child.id, relationship_type: "reference" },
      actor
    );
    assert.ok(relation.id ?? relation.relationship_ref);
  });

  test("import and export writes", async () => {
    await reference.Domains.createDomainAsync(db, { code: "AW_IO", name: "Async IO" }, actor);
    const imp = await reference.ImportExport.createImportAsync(
      db,
      { domain_code: "AW_IO", rows: [{ code: "X1", name: "Export one" }, { code: "", name: "bad" }] },
      actor
    );
    assert.equal(imp.status, "validated");
    assert.equal(imp.valid_rows, 1);
    const committed = await reference.ImportExport.commitImportAsync(db, imp.import_ref, {}, actor);
    assert.equal(committed.created, 1);
    assert.equal(committed.status, "committed");
    const exp = await reference.ImportExport.createExportAsync(db, { domain_code: "AW_IO", format: "json" }, actor);
    assert.ok(exp.row_count >= 1);
    assert.ok(exp.content.includes("X1"));
  });
});

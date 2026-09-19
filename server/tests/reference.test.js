process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import * as reference from "../services/reference.js";

function adminActor(db) {
  const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  return row ? { id: row.id, username: row.username } : null;
}

describe("Reference data foundation and mandatory domains", () => {
  let db;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
  });
  after(() => db?.close());

  test("installs the mandatory domain catalogue", () => {
    const mandatory = reference.Foundation.vocabulary().mandatory_domains;
    for (const code of mandatory) {
      const domain = queryOne(db, "SELECT * FROM reference_domains WHERE code = ? AND tenant_id IS NULL", [code]);
      assert.ok(domain, `expected domain ${code}`);
      assert.equal(domain.status, "active");
    }
  });

  test("every domain carries a versioned governance policy", () => {
    const domains = reference.Domains.listDomains(db, {}).items;
    assert.ok(domains.length >= 13);
    for (const domain of domains) {
      const policy = reference.Governance.getActiveGovernancePolicy(db, domain.id);
      assert.ok(policy, `expected governance for ${domain.code}`);
      assert.ok(Number(policy.version) >= 1);
    }
  });

  test("foundation is idempotent and bootstraps a default scope policy per tenant", () => {
    const before = reference.Scopes.listScopePolicies(db, {}).total;
    const result = reference.ensureReferenceFoundation(db);
    assert.equal(typeof result.cache_epoch, "number");
    const after = reference.Scopes.listScopePolicies(db, {}).total;
    assert.equal(after, before);
  });

  test("seeds demonstration values without duplicating on reseed", () => {
    const first = reference.seedReference(db);
    assert.equal(first.items_created, 0);
    const second = reference.seedReference(db);
    assert.equal(second.items_created, 0);
    assert.ok(reference.Metrics.metricsSnapshot(db).totals.items >= 40);
  });
});

describe("Reference domain ownership, governance and versioning", () => {
  let db;
  let actor;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
  });
  after(() => db?.close());

  test("creates a domain with ownership and records ownership history", () => {
    const domain = reference.Domains.createDomain(
      db,
      { code: "PAYMENT_TERM", name: "Payment Term", category: "finance", owner_label: "Finance Ops" },
      actor
    );
    assert.equal(domain.code, "PAYMENT_TERM");
    assert.equal(domain.status, "active");
    reference.Domains.updateDomain(db, domain.domain_ref, { owner_label: "Treasury" }, actor);
    const history = reference.Domains.listOwnershipHistory(db, { domainId: domain.id });
    assert.ok(history.length >= 1);
    assert.ok(history.some((entry) => entry.field === "owner_label"));
  });

  test("publishes governance versions and exposes the active policy", () => {
    reference.Domains.createDomain(db, { code: "SERVICE_LEVEL", name: "Service Level" }, actor);
    const row = reference.Domains.requireDomain(db, "SERVICE_LEVEL");
    const initial = reference.Governance.getActiveGovernancePolicy(db, row.id).version;
    const v1 = reference.Governance.publishGovernanceVersion(db, row, { approval_required: false, versioning_enabled: true }, actor);
    const v2 = reference.Governance.publishGovernanceVersion(db, row, { approval_required: true, versioning_enabled: true }, actor);
    assert.equal(v1.version, initial + 1);
    assert.equal(v2.version, v1.version + 1);
    const active = reference.Governance.getActiveGovernancePolicy(db, row.id);
    assert.equal(active.version, v2.version);
    assert.equal(Boolean(active.approval_required), true);
    assert.ok(reference.Governance.listGovernanceVersions(db, row.id).length >= 2);
  });
});

describe("Reference items, codes, aliases, translations and versions", () => {
  let db;
  let actor;
  let domain;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
    reference.Domains.createDomain(db, { code: "COLOR", name: "Color" }, actor);
    domain = reference.Domains.requireDomain(db, "COLOR");
  });
  after(() => db?.close());

  test("creates an item and increments versions on update", () => {
    const item = reference.Items.createItem(db, { domain_code: "COLOR", code: "RED", name: "Red" }, actor);
    assert.equal(item.status, "draft");
    assert.equal(item.current_version_number, 1);
    const updated = reference.Items.updateItem(db, item.item_ref, { name: "Red (warm)" }, actor);
    assert.equal(updated.current_version_number, 2);
    assert.equal(reference.Versions.listVersions(db, item.id).total, 2);
  });

  test("enforces lifecycle transitions", () => {
    const item = reference.Items.createItem(db, { domain_code: "COLOR", code: "BLUE", name: "Blue" }, actor);
    const activated = reference.Items.setItemStatus(db, item.item_ref, "active", actor);
    assert.equal(activated.status, "active");
    assert.deepEqual([...activated.next_statuses].sort(), ["inactive", "retired", "under_review"]);
    reference.Items.setItemStatus(db, item.item_ref, "retired", actor);
    assert.throws(
      () => reference.Items.setItemStatus(db, item.item_ref, "active", actor),
      (err) => err.status === 422 || err.status === 409
    );
  });

  test("stores alternate codes, aliases and translations", () => {
    const item = reference.Items.createItem(db, { domain_code: "COLOR", code: "GREEN", name: "Green" }, actor);
    reference.Items.setItemStatus(db, item.item_ref, "active", actor);
    const code = reference.Codes.createCode(db, item, { code: "GRN", code_type: "alternate", code_system: "internal" }, actor);
    assert.equal(code.code, "GRN");
    const alias = reference.Aliases.createAlias(db, item, { alias: "vert", alias_type: "synonym", language: "fr" }, actor);
    assert.equal(alias.alias, "vert");
    reference.Translations.upsertTranslation(db, item, { language: "de", name: "Gruen" }, actor);
    const translations = reference.Translations.listTranslations(db, { itemId: item.id });
    assert.equal(translations.items[0].name, "Gruen");

    const byCode = reference.Codes.findItemsByCode(db, domain.id, "GRN", { statuses: ["active"] });
    assert.equal(byCode.length, 1);
    const byAlias = reference.Aliases.findItemsByAlias(db, domain.id, "vert");
    assert.equal(byAlias.length, 1);
  });

  test("rejects duplicate codes within the same scope", () => {
    reference.Items.createItem(db, { domain_code: "COLOR", code: "DUP", name: "Dup" }, actor);
    assert.throws(
      () => reference.Items.createItem(db, { domain_code: "COLOR", code: "DUP", name: "Dup again" }, actor),
      (err) => err.status === 409
    );
  });
});

describe("Reference hierarchy, relationships and search", () => {
  let db;
  let actor;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
    reference.Domains.createDomain(db, { code: "GEAR", name: "Gear" }, actor);
  });
  after(() => db?.close());

  test("builds and traverses a hierarchy", () => {
    const root = reference.Items.createItem(db, { domain_code: "GEAR", code: "ALL", name: "All Gears", status: "active" }, actor);
    const childA = reference.Items.createItem(db, { domain_code: "GEAR", code: "SPUR", name: "Spur Gear", status: "active" }, actor);
    const childB = reference.Items.createItem(db, { domain_code: "GEAR", code: "HELICAL", name: "Helical Gear", status: "active" }, actor);
    reference.Hierarchy.createEdge(db, { parentId: root.id, childId: childA.id }, actor);
    reference.Hierarchy.createEdge(db, { parentId: root.id, childId: childB.id }, actor);
    const tree = reference.Hierarchy.tree(db, reference.Domains.requireDomain(db, "GEAR").id);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].children.length, 2);
    const descended = reference.Hierarchy.descendants(db, root.id);
    assert.equal(descended.length, 2);
  });

  test("detects hierarchy cycles", () => {
    const parent = reference.Items.createItem(db, { domain_code: "GEAR", code: "P1", name: "P1" }, actor);
    const child = reference.Items.createItem(db, { domain_code: "GEAR", code: "C1", name: "C1" }, actor);
    reference.Hierarchy.createEdge(db, { parentId: parent.id, childId: child.id }, actor);
    assert.throws(
      () => reference.Hierarchy.createEdge(db, { parentId: child.id, childId: parent.id }, actor),
      (err) => err.status === 409 || err.status === 422
    );
  });

  test("creates cross-domain relationships", () => {
    const a = reference.Items.createItem(db, { domain_code: "GEAR", code: "REL-A", name: "A", status: "active" }, actor);
    const b = reference.Items.createItem(db, { domain_code: "UNIT_OF_MEASURE", code: "REL-B", name: "B", status: "active" }, actor);
    const rel = reference.Relationships.createRelationship(
      db,
      { sourceItemId: a.id, targetItemId: b.id, relationship_type: "reference" },
      actor
    );
    assert.equal(rel.relationship_type, "reference");
    const related = reference.Relationships.relatedItems(db, a.id, { relationshipType: "reference" });
    assert.equal(related.length, 1);
  });

  test("searches across code, name and aliases", () => {
    const item = reference.Items.createItem(db, { domain_code: "GEAR", code: "PLANET", name: "Planetary Gear", status: "active" }, actor);
    reference.Aliases.createAlias(db, item, { alias: "epicyclic", alias_type: "synonym" }, actor);
    const byName = reference.Resolution.searchValues(db, { text: "planetary" });
    assert.ok(byName.items.some((entry) => entry.code === "PLANET"));
    const byAlias = reference.Resolution.searchValues(db, { text: "epicyclic" });
    assert.ok(byAlias.items.some((entry) => entry.code === "PLANET"));
    const none = reference.Resolution.searchValues(db, { text: "zzz-not-there" });
    assert.equal(none.total, 0);
  });
});

describe("Reference resolution, scope precedence and effectivity", () => {
  let db;
  let actor;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
    reference.Domains.createDomain(db, { code: "CURRENCY_X", name: "Currency X" }, actor);
  });
  after(() => db?.close());

  test("resolves by code, alias and explicit item ref", () => {
    reference.Items.createItem(db, { domain_code: "CURRENCY_X", code: "USD", name: "US Dollar", status: "active" }, actor);
    const item = reference.Items.getItem(db, "RDM-CURRENCY_X-USD");
    reference.Aliases.createAlias(db, item, { alias: "US$", alias_type: "symbol" }, actor);

    const byCode = reference.resolveValue(db, { domain_code: "CURRENCY_X", code: "USD" });
    assert.equal(byCode.resolution_status, "RESOLVED");
    assert.equal(byCode.value.code, "USD");

    const byAlias = reference.resolveValue(db, { domain_code: "CURRENCY_X", alias: "US$" });
    assert.equal(byAlias.resolution, "alias");
    assert.equal(byAlias.value.code, "USD");

    const byRef = reference.resolveValue(db, { domain_code: "CURRENCY_X", itemRef: item.item_ref });
    assert.equal(byRef.value.code, "USD");
  });

  test("returns a structured not-found result for silent lookup", () => {
    const missing = reference.lookupValue(db, { domain_code: "CURRENCY_X", code: "ZZZ" });
    assert.equal(missing, null);
    const validated = reference.validateValue(db, { domain_code: "CURRENCY_X", code: "ZZZ" });
    assert.equal(validated.valid, false);
    assert.equal(validated.reason, "NOT_FOUND");
  });

  test("applies scope precedence so organization values beat global values", () => {
    const tenant = queryOne(db, "SELECT id FROM organizations ORDER BY id LIMIT 1").id;
    reference.Items.createItem(db, { domain_code: "CURRENCY_X", code: "PREC", name: "Global Prec", status: "active" }, actor);
    reference.Items.createItem(
      db,
      { domain_code: "CURRENCY_X", code: "PREC", name: "Org Prec", status: "active", scope_type: "ORGANIZATION" },
      actor,
      tenant
    );

    const orgScoped = reference.resolveValue(db, { domain_code: "CURRENCY_X", code: "PREC" }, { tenantId: tenant });
    assert.equal(orgScoped.value.name, "Org Prec");
    assert.equal(orgScoped.value.scope_type, "ORGANIZATION");

    const globalOnly = reference.resolveValue(db, { domain_code: "CURRENCY_X", code: "PREC" });
    assert.equal(globalOnly.value.name, "Global Prec");
  });

  test("honours effective dates", () => {
    const future = "2999-01-01";
    reference.Items.createItem(
      db,
      { domain_code: "CURRENCY_X", code: "FUT", name: "Future", status: "active", effective_from: future },
      actor
    );
    const asOfNow = reference.lookupValue(db, { domain_code: "CURRENCY_X", code: "FUT", asOf: "2026-01-01" });
    assert.equal(asOfNow, null);
    const asOfFuture = reference.resolveValue(db, { domain_code: "CURRENCY_X", code: "FUT", asOf: "3000-01-01" });
    assert.equal(asOfFuture.resolution_status, "RESOLVED");
  });
});

describe("Reference approvals, change requests and bulk resolution", () => {
  let db;
  let actor;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
    reference.Domains.createDomain(db, { code: "APPROVAL_DOMAIN", name: "Approval Domain" }, actor);
    reference.Governance.publishGovernanceVersion(
      db,
      reference.Domains.requireDomain(db, "APPROVAL_DOMAIN"),
      { approval_required: true },
      actor
    );
  });
  after(() => db?.close());

  test("blocks activation until an approval decision is recorded", () => {
    const item = reference.Items.createItem(db, { domain_code: "APPROVAL_DOMAIN", code: "A1", name: "A1" }, actor);
    assert.throws(
      () => reference.Items.setItemStatus(db, item.item_ref, "active", actor),
      (err) => err.code === "REFERENCE_APPROVAL_REQUIRED"
    );
    const approval = reference.Approvals.submitForApproval(db, item.item_ref, { assignee_id: actor.id }, actor);
    assert.equal(approval.status, "submitted");
    const decided = reference.Approvals.decideApproval(db, approval.approval_ref, { decision: "approve", comment: "ok" }, actor);
    assert.equal(decided.status, "approved");
    const after = reference.Items.getItem(db, item.item_ref);
    assert.equal(after.status, "approved");
  });

  test("rejects an approval and notifies the returned lifecycle state", () => {
    const item = reference.Items.createItem(db, { domain_code: "APPROVAL_DOMAIN", code: "A2", name: "A2" }, actor);
    const approval = reference.Approvals.submitForApproval(db, item.item_ref, {}, actor);
    const decided = reference.Approvals.decideApproval(db, approval.approval_ref, { decision: "reject", comment: "no" }, actor);
    assert.equal(decided.status, "rejected");
  });

  test("records change requests and bulk-resolves values", () => {
    const domain = reference.Domains.requireDomain(db, "APPROVAL_DOMAIN");
    const cr = reference.Approvals.createChangeRequest(
      db,
      { title: "Fix A1", change_type: "update", domain_id: domain.id, payload: { name: "A1 revised" }, description: "typo" },
      actor
    );
    assert.equal(cr.status, "submitted");
    const listed = reference.Approvals.listChangeRequests(db, {});
    assert.ok(listed.total >= 1);

    reference.Items.createItem(db, { domain_code: "APPROVAL_DOMAIN", code: "B1", name: "B1", status: "active" }, actor);
    const bulk = reference.resolveValues(db, {
      items: [
        { domainId: domain.id, code: "B1" },
        { domainId: domain.id, code: "MISSING" },
      ],
    });
    assert.equal(bulk.total, 2);
    assert.equal(bulk.items.filter((entry) => entry.resolution_status === "RESOLVED").length, 1);
  });
});

describe("Reference import and export", () => {
  let db;
  let actor;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
    reference.Domains.createDomain(db, { code: "IMPEX_DOMAIN", name: "Import Export" }, actor);
  });
  after(() => db?.close());

  test("exports a domain to JSON and CSV", () => {
    reference.Items.createItem(db, { domain_code: "IMPEX_DOMAIN", code: "E1", name: "E1", status: "active" }, actor);
    const json = reference.ImportExport.createExport(db, { domain_code: "IMPEX_DOMAIN", format: "json" }, actor);
    assert.ok(json.row_count >= 1);
    assert.ok(json.content.includes("E1"));
    const csv = reference.ImportExport.createExport(db, { domain_code: "IMPEX_DOMAIN", format: "csv" }, actor);
    assert.equal(csv.format, "csv");
  });

  test("validates then commits an import without partial writes", () => {
    const created = reference.ImportExport.createImport(
      db,
      { domain_code: "IMPEX_DOMAIN", rows: [{ code: "I1", name: "I One" }, { code: "", name: "bad" }] },
      actor
    );
    assert.equal(created.status, "validated");
    assert.equal(created.valid_rows, 1);
    assert.equal(created.invalid_rows, 1);
    assert.equal(reference.Items.listItems(db, { domain_code: "IMPEX_DOMAIN", code: "I1" }).total, 0);
    const committed = reference.ImportExport.commitImport(db, created.import_ref, {}, actor);
    assert.equal(committed.created, 1);
    assert.equal(committed.status, "committed");
    assert.equal(reference.Items.listItems(db, { domain_code: "IMPEX_DOMAIN", code: "I1" }).total, 1);
  });
});

describe("Reference metrics and health", () => {
  let db;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
  });
  after(() => db?.close());

  test("reports snapshot, dashboard and readiness", () => {
    const snapshot = reference.Metrics.metricsSnapshot(db);
    assert.ok(snapshot.totals.domains >= 13);
    const dashboard = reference.Metrics.dashboardSummary(db);
    assert.ok(Array.isArray(dashboard.top_domains));
    assert.ok(Array.isArray(dashboard.recent_items));
    const health = reference.Metrics.healthCheck(db);
    assert.equal(health.ready, true);
    assert.equal(health.status, "ok");
  });
});

describe("Reference data REST API", () => {
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
    const res = await request("GET", "/api/reference-data/domains");
    assert.equal(res.status, 401);
  });

  test("exposes catalogue meta and mandatory domains", async () => {
    const token = await login("admin", "HelixAdmin!42");
    const meta = await request("GET", "/api/reference-data/meta", { token });
    assert.equal(meta.status, 200);
    assert.ok(meta.body.mandatory_domains.includes("UNIT_OF_MEASURE"));
    const domains = await request("GET", "/api/reference-data/domains", { token });
    assert.equal(domains.status, 200);
    assert.ok(domains.body.total >= 13);
    const v1 = await request("GET", "/api/v1/reference-data/domains", { token });
    assert.equal(v1.status, 200);
  });

  test("creates an item and resolves it through the API", async () => {
    const token = await login("admin", "HelixAdmin!42");
    const created = await request("POST", "/api/reference-data/domains", {
      token,
      body: { code: "API_DOMAIN", name: "API Domain" },
    });
    assert.equal(created.status, 201);
    await request("POST", `/api/reference-data/domains/${created.body.domain_ref}/status`, { token, body: { status: "active" } });

    const item = await request("POST", "/api/reference-data/items", {
      token,
      body: { domain_code: "API_DOMAIN", code: "A1", name: "Alpha", status: "active" },
    });
    assert.equal(item.status, 201);
    assert.equal(item.body.code, "A1");

    const resolved = await request("POST", "/api/reference-data/resolve", {
      token,
      body: { domain_code: "API_DOMAIN", code: "A1" },
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.resolution_status, "RESOLVED");
    assert.equal(resolved.body.value.code, "A1");

    const values = await request("GET", "/api/reference-data/values?domain_code=API_DOMAIN", { token });
    assert.equal(values.status, 200);
    assert.equal(values.body.total, 1);

    const search = await request("GET", "/api/reference-data/search?text=alpha", { token });
    assert.equal(search.status, 200);
    assert.ok(search.body.items.some((entry) => entry.code === "A1"));
  });

  test("exposes health, metrics and dashboard", async () => {
    const token = await login("admin", "HelixAdmin!42");
    const live = await request("GET", "/api/reference-data/health/live", { token });
    assert.equal(live.status, 200);
    assert.equal(live.body.live, true);
    const ready = await request("GET", "/api/reference-data/health/ready", { token });
    assert.equal(ready.status, 200);
    assert.equal(ready.body.ready, true);
    const metrics = await request("GET", "/api/reference-data/metrics", { token });
    assert.equal(metrics.status, 200);
    const dashboard = await request("GET", "/api/reference-data/dashboard", { token });
    assert.equal(dashboard.status, 200);
    assert.ok(Array.isArray(dashboard.body.recent_items));
  });

  test("returns structured validation errors for unknown domains", async () => {
    const token = await login("admin", "HelixAdmin!42");
    const res = await request("POST", "/api/reference-data/items", {
      token,
      body: { domain_code: "NOPE", code: "X", name: "X" },
    });
    assert.ok([400, 404, 422].includes(res.status));
    assert.ok(res.body.code);
  });
});

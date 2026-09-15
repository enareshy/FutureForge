import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as metadata from "../services/metadata.js";
import * as tenants from "../services/tenants.js";
import { HttpError } from "../validation.js";

const ACTOR = { id: 1, username: "admin" };
const IP = "127.0.0.1";

function db() {
  const database = openDatabase(":memory:");
  migrate(database);
  seedDatabase(database);
  return database;
}

function helixId(database) {
  return tenants.listTenants(database).items.find((t) => t.code === "helix").id;
}

function makeType(database, code, extra = {}) {
  return metadata.createType(
    database,
    { code, name: code, status: "active", ...extra },
    ACTOR,
    IP,
    helixId(database)
  );
}

describe("metadata types", () => {
  test("seeded demo metadata is present and active", () => {
    const database = db();
    const part = metadata.getType(database, "part", helixId(database));
    assert.equal(part.status, "active");
    assert.ok(part.attributes.length >= 10);
    assert.ok(part.attributes.some((a) => a.code === "part.number" && a.required));
    const forms = metadata.listForms(database, {}, helixId(database));
    assert.ok(forms.items.some((f) => f.code === "part.create"));
  });

  test("types can be created, activated and deactivated", () => {
    const database = db();
    const tenantId = helixId(database);
    const created = metadata.createType(database, { code: "tool", name: "Tool" }, ACTOR, IP, tenantId);
    assert.equal(created.status, "draft");
    const active = metadata.setTypeStatus(database, created.id, "active", ACTOR, IP, tenantId);
    assert.equal(active.status, "active");
    const inactive = metadata.setTypeStatus(database, created.id, "inactive", ACTOR, IP, tenantId);
    assert.equal(inactive.status, "inactive");
  });

  test("child types inherit attributes from ancestors", () => {
    const database = db();
    const tenantId = helixId(database);
    const base = makeType(database, "drawing");
    const attribute = metadata.createAttribute(
      database,
      { code: "drawing.title", name: "Title", data_type: "string", required: true },
      ACTOR,
      IP,
      tenantId
    );
    metadata.addTypeAttribute(database, base.id, { attribute_id: attribute.id }, ACTOR, IP, tenantId);
    const child = metadata.createType(
      database,
      { code: "certificate", name: "Certificate", parent_type_id: base.id, status: "active" },
      ACTOR,
      IP,
      tenantId
    );
    const own = metadata.createAttribute(
      database,
      { code: "certificate.issuer", name: "Issuer", data_type: "string" },
      ACTOR,
      IP,
      tenantId
    );
    metadata.addTypeAttribute(database, child.id, { attribute_id: own.id }, ACTOR, IP, tenantId);
    const resolved = metadata.resolveType(database, "certificate", tenantId);
    const codes = resolved.attributes.map((a) => a.code);
    assert.ok(codes.includes("drawing.title"), "inherited attribute is present");
    assert.ok(codes.includes("certificate.issuer"), "own attribute is present");
  });

  test("circular inheritance is rejected", () => {
    const database = db();
    const tenantId = helixId(database);
    const a = makeType(database, "node-a");
    const b = metadata.createType(
      database,
      { code: "node-b", name: "Node B", parent_type_id: a.id, status: "active" },
      ACTOR,
      IP,
      tenantId
    );
    assert.throws(
      () => metadata.updateType(database, a.id, { parent_type_id: b.id }, ACTOR, IP, tenantId),
      (err) => err instanceof HttpError && err.status === 400
    );
  });

  test("a type referenced by a form cannot be deleted", () => {
    const database = db();
    const tenantId = helixId(database);
    const type = makeType(database, "linked");
    metadata.createForm(
      database,
      { code: "linked.form", name: "Linked", type_id: type.id, tenant_id: tenantId },
      ACTOR,
      IP,
      tenantId
    );
    assert.throws(
      () => metadata.deleteType(database, type.id, ACTOR, IP, tenantId),
      (err) => err instanceof HttpError && err.status === 409
    );
  });

  test("global metadata is shared while tenant metadata stays isolated", () => {
    const database = db();
    const tenantId = helixId(database);
    const global = metadata.createType(database, { code: "shared-global", name: "Shared" }, ACTOR, IP, null);
    assert.equal(global.tenant_id, null);
    const other = tenants.createTenant(database, { code: "other-co", name: "Other" }, ACTOR, IP);
    const visible = metadata.getType(database, global.id, other.id);
    assert.equal(visible.code, "shared-global");
    const scoped = metadata.createType(database, { code: "local-only", name: "Local" }, ACTOR, IP, tenantId);
    assert.throws(
      () => metadata.getType(database, scoped.id, other.id),
      (err) => err instanceof HttpError && err.status === 404
    );
  });
});

describe("metadata attributes", () => {
  test("data types, ranges and validation payloads are enforced", () => {
    const database = db();
    const tenantId = helixId(database);
    assert.throws(
      () =>
        metadata.createAttribute(
          database,
          { code: "bad.type", name: "Bad", data_type: "currency" },
          ACTOR,
          IP,
          tenantId
        ),
      (err) => err instanceof HttpError && err.status === 400
    );
    assert.throws(
      () =>
        metadata.createAttribute(
          database,
          { code: "bad.range", name: "Bad", data_type: "integer", min_value: 10, max_value: 1 },
          ACTOR,
          IP,
          tenantId
        ),
      (err) => err instanceof HttpError && err.status === 400
    );
    assert.throws(
      () =>
        metadata.createAttribute(
          database,
          { code: "bad.pattern", name: "Bad", data_type: "string", validation: { pattern: "([" } },
          ACTOR,
          IP,
          tenantId
        ),
      (err) => err instanceof HttpError && err.status === 400
    );
    const ok = metadata.createAttribute(
      database,
      {
        code: "dimension.length",
        name: "Length",
        data_type: "decimal",
        min_value: 0,
        max_value: 5000,
        validation: { scale: 2 },
      },
      ACTOR,
      IP,
      tenantId
    );
    assert.equal(ok.data_type, "decimal");
    assert.equal(ok.validation.scale, 2);
  });

  test("validation engine coerces and rejects invalid values", () => {
    const database = db();
    const tenantId = helixId(database);
    const type = makeType(database, "measure");
    const integer = metadata.createAttribute(
      database,
      { code: "measure.count", name: "Count", data_type: "integer", min_value: 1, max_value: 10, required: true },
      ACTOR,
      IP,
      tenantId
    );
    metadata.addTypeAttribute(database, type.id, { attribute_id: integer.id }, ACTOR, IP, tenantId);

    const ok = metadata.validateRecord(database, { typeId: type.id, values: { "measure.count": 5 } }, tenantId);
    assert.equal(ok.valid, true);
    assert.equal(ok.values["measure.count"], 5);

    const notInteger = metadata.validateRecord(
      database,
      { typeId: type.id, values: { "measure.count": 5.5 } },
      tenantId
    );
    assert.equal(notInteger.valid, false);
    assert.ok(notInteger.errors.some((e) => e.code === "integer"));

    const outOfRange = metadata.validateRecord(
      database,
      { typeId: type.id, values: { "measure.count": 99 } },
      tenantId
    );
    assert.ok(outOfRange.errors.some((e) => e.code === "max_value"));

    const missing = metadata.validateRecord(database, { typeId: type.id, values: {} }, tenantId);
    assert.ok(missing.errors.some((e) => e.code === "required"));

    const unknown = metadata.validateRecord(
      database,
      { typeId: type.id, values: { "measure.count": 2, "measure.nope": 1 } },
      tenantId
    );
    assert.ok(unknown.errors.some((e) => e.code === "unknown_field"));
  });

  test("reference attributes must resolve to an existing entity", () => {
    const database = db();
    const tenantId = helixId(database);
    const type = makeType(database, "ref-host");
    const reference = metadata.createAttribute(
      database,
      { code: "ref.owner", name: "Owner", data_type: "reference", validation: { reference_type: "organization" } },
      ACTOR,
      IP,
      tenantId
    );
    metadata.addTypeAttribute(database, type.id, { attribute_id: reference.id }, ACTOR, IP, tenantId);
    const good = queryOne(database, "SELECT id FROM organizations LIMIT 1");
    const valid = metadata.validateRecord(
      database,
      { typeId: type.id, values: { "ref.owner": good.id } },
      tenantId
    );
    assert.equal(valid.valid, true);
    const invalid = metadata.validateRecord(
      database,
      { typeId: type.id, values: { "ref.owner": 999999 } },
      tenantId
    );
    assert.ok(invalid.errors.some((e) => e.code === "reference"));
  });
});

describe("metadata LOVs", () => {
  test("values, cascading options and usage protection", () => {
    const database = db();
    const tenantId = helixId(database);
    const lov = metadata.createLov(
      database,
      { code: "plant-region", name: "Plant region", selection_type: "single" },
      ACTOR,
      IP,
      tenantId
    );
    const emea = metadata.addValue(database, lov.id, { code: "emea", label: "EMEA" }, ACTOR, IP, tenantId);
    metadata.addValue(database, lov.id, { code: "emea-uk", label: "UK", parent_value_id: emea.id }, ACTOR, IP, tenantId);
    metadata.addValue(database, lov.id, { code: "apac", label: "APAC" }, ACTOR, IP, tenantId);

    const roots = metadata.cascadeOptions(database, lov.id, null, tenantId);
    assert.deepEqual(roots.map((v) => v.code).sort(), ["apac", "emea"]);
    const children = metadata.cascadeOptions(database, lov.id, emea.id, tenantId);
    assert.deepEqual(children.map((v) => v.code), ["emea-uk"]);

    const uk = children[0];
    metadata.markUsage(database, lov.id, uk.id, "record", "rec-1");
    const retired = metadata.removeValue(database, lov.id, uk.id, ACTOR, IP, tenantId);
    assert.equal(retired.deleted, false);
    assert.equal(retired.retired, true);
    const stillThere = queryOne(database, "SELECT * FROM metadata_lov_values WHERE id = ?", [uk.id]);
    assert.equal(stillThere.active, 0);

    assert.throws(
      () => metadata.deleteLov(database, lov.id, ACTOR, IP, tenantId),
      (err) => err instanceof HttpError && err.status === 409
    );
  });

  test("attribute LOV values are validated", () => {
    const database = db();
    const tenantId = helixId(database);
    const lov = metadata.createLov(database, { code: "priority", name: "Priority" }, ACTOR, IP, tenantId);
    metadata.addValue(database, lov.id, { code: "high", label: "High" }, ACTOR, IP, tenantId);
    const type = makeType(database, "ticket");
    const attribute = metadata.createAttribute(
      database,
      { code: "ticket.priority", name: "Priority", data_type: "string", lov_id: lov.id },
      ACTOR,
      IP,
      tenantId
    );
    metadata.addTypeAttribute(database, type.id, { attribute_id: attribute.id }, ACTOR, IP, tenantId);
    assert.equal(
      metadata.validateRecord(database, { typeId: type.id, values: { "ticket.priority": "high" } }, tenantId).valid,
      true
    );
    assert.equal(
      metadata.validateRecord(database, { typeId: type.id, values: { "ticket.priority": "urgent" } }, tenantId).valid,
      false
    );
  });
});

describe("metadata forms", () => {
  test("layout rejects attributes that are not on the type", () => {
    const database = db();
    const tenantId = helixId(database);
    const type = makeType(database, "form-host");
    const other = makeType(database, "form-other");
    const foreign = metadata.createAttribute(
      database,
      { code: "foreign.attr", name: "Foreign", data_type: "string" },
      ACTOR,
      IP,
      tenantId
    );
    metadata.addTypeAttribute(database, other.id, { attribute_id: foreign.id }, ACTOR, IP, tenantId);
    const form = metadata.createForm(
      database,
      { code: "host.form", name: "Host", type_id: type.id, tenant_id: tenantId },
      ACTOR,
      IP,
      tenantId
    );
    assert.throws(
      () => metadata.replaceLayout(database, form.id, { nodes: [], fields: [{ code: "foreign.attr" }] }, ACTOR, IP, tenantId),
      (err) => err instanceof HttpError && err.status === 400
    );
  });

  test("renderer orders fields and evaluates conditional visibility", () => {
    const database = db();
    const tenantId = helixId(database);
    const partType = metadata.getType(database, "part", tenantId);
    const form = metadata.listForms(database, { mode: "create" }, tenantId).items.find(
      (f) => f.code === "part.create"
    );
    const rendered = metadata.renderForm(database, form.id, tenantId, { values: {} });
    assert.equal(rendered.form.mode, "create");
    const fieldCodes = rendered.fields.map((f) => f.code);
    assert.ok(fieldCodes.includes("part.number"));
    assert.ok(fieldCodes.includes("part.category"));
    assert.equal(rendered.nodes[0].kind, "section");
    assert.equal(rendered.type.code, "part");
    assert.ok(partType.attributes.length > 0);
  });

  test("view mode makes all fields non-editable", () => {
    const database = db();
    const tenantId = helixId(database);
    const form = metadata.listForms(database, { mode: "view" }, tenantId).items.find((f) => f.code === "part.view");
    const rendered = metadata.renderForm(database, form.id, tenantId, { mode: "view", values: {} });
    assert.ok(rendered.fields.every((f) => f.editable === false));
  });

  test("type renderer produces a contract without a form", () => {
    const database = db();
    const tenantId = helixId(database);
    const rendered = metadata.renderType(database, "part", tenantId, {});
    assert.equal(rendered.form, null);
    assert.ok(rendered.fields.some((f) => f.code === "part.number"));
  });

  test("activating an empty form is rejected", () => {
    const database = db();
    const tenantId = helixId(database);
    const type = makeType(database, "empty-form-host");
    const form = metadata.createForm(
      database,
      { code: "empty.form", name: "Empty", type_id: type.id, tenant_id: tenantId },
      ACTOR,
      IP,
      tenantId
    );
    assert.throws(
      () => metadata.setFormStatus(database, form.id, "active", ACTOR, IP, tenantId),
      (err) => err instanceof HttpError && err.status === 409
    );
  });
});

describe("metadata rules", () => {
  test("validation rules fire when their condition matches", () => {
    const database = db();
    const tenantId = helixId(database);
    const result = metadata.validateRecord(
      database,
      { typeId: "part", values: { "part.number": "PN-1", "part.name": "Pump", "part.category": "mechanical", "part.status": "draft", "part.weight_kg": -3 } },
      tenantId
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === "weight.positive"));
  });

  test("dependency rules require conditional fields", () => {
    const database = db();
    const tenantId = helixId(database);
    const result = metadata.validateRecord(
      database,
      {
        typeId: "part",
        values: {
          "part.number": "PN-2",
          "part.name": "Bracket",
          "part.category": "mechanical",
          "part.status": "draft",
          "part.is_critical": true,
        },
      },
      tenantId
    );
    assert.ok(result.errors.some((e) => e.code === "required" && e.field === "part.notes"));
  });

  test("editability rules feed the renderer", () => {
    const database = db();
    const tenantId = helixId(database);
    const applied = metadata.applyRules(
      database,
      { typeId: "part", values: { "part.status": "obsolete" } },
      tenantId
    );
    assert.equal(applied.editability["part.revision"], false);
  });

  test("rules cannot execute arbitrary code and unknown operators are rejected", () => {
    const database = db();
    const tenantId = helixId(database);
    assert.throws(
      () =>
        metadata.createRule(
          database,
          {
            code: "danger.rule",
            name: "Danger",
            category: "condition",
            type_id: metadata.getType(database, "part", tenantId).id,
            condition: { op: "eval", code: "process.exit(1)" },
            actions: [],
          },
          ACTOR,
          IP,
          tenantId
        ),
      (err) => err instanceof HttpError && err.status === 400
    );
    const value = metadata.evaluateValue(
      { op: "value", path: "constructor.constructor.constructor" },
      { values: {} }
    );
    assert.equal(value, undefined);
    assert.equal(metadata.evaluateValue({ op: "value", path: "values.__proto__" }, { values: {} }), undefined);
  });

  test("rule test endpoint helper evaluates a condition", () => {
    const result = metadata.testRule(
      { condition: { op: "eq", left: { op: "value", path: "values.status" }, right: "ok" } },
      { values: { status: "ok" } }
    );
    assert.equal(result.matched, true);
  });
});

describe("metadata versioning and configuration", () => {
  test("versions are created and old versions archived on publish", () => {
    const database = db();
    const tenantId = helixId(database);
    const type = makeType(database, "versioned");
    metadata.updateType(database, type.id, { name: "Versioned v2" }, ACTOR, IP, tenantId);
    const versions = metadata.listVersions(database, "type", type.id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].status, "active");
    assert.equal(versions[1].status, "archived");
    const snapshot = metadata.getVersion(database, "type", type.id, 1);
    assert.equal(snapshot.snapshot.name, "versioned");
  });

  test("configuration precedence is system then tenant then organization", () => {
    const database = db();
    const tenantId = helixId(database);
    const org = queryOne(database, "SELECT id FROM organizations WHERE kind = 'site' ORDER BY id LIMIT 1");
    const type = makeType(database, "configurable");

    metadata.setConfiguration(
      database,
      { scope: "system", artifactType: "type", artifactId: type.id, enabled: false },
      ACTOR,
      IP
    );
    let resolved = metadata.resolveArtifactConfig(database, "type", type.id, { tenantId });
    assert.equal(resolved.enabled, false);
    assert.equal(resolved.source, "system");

    metadata.setConfiguration(
      database,
      { scope: "tenant", scopeId: tenantId, artifactType: "type", artifactId: type.id, enabled: true },
      ACTOR,
      IP
    );
    resolved = metadata.resolveArtifactConfig(database, "type", type.id, { tenantId });
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.source, "tenant");

    metadata.setConfiguration(
      database,
      { scope: "organization", scopeId: org.id, artifactType: "type", artifactId: type.id, enabled: false },
      ACTOR,
      IP
    );
    resolved = metadata.resolveArtifactConfig(database, "type", type.id, {
      tenantId,
      organizationId: org.id,
    });
    assert.equal(resolved.enabled, false);
    assert.equal(resolved.source, "organization");

    assert.throws(
      () => metadata.assertEnabled(database, "type", type.id, { tenantId, organizationId: org.id }),
      (err) => err instanceof HttpError && err.status === 409
    );
  });

  test("effective catalog reports global and scoped artifacts", () => {
    const database = db();
    const tenantId = helixId(database);
    const items = metadata.effectiveCatalog(database, { tenantId });
    assert.ok(items.some((i) => i.artifact_type === "type" && i.code === "part"));
  });
});

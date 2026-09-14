import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate } from "../db.js";
import * as orgs from "../services/orgs.js";
import * as users from "../services/users.js";
import * as hierarchy from "../services/hierarchy.js";
import { HttpError } from "../validation.js";

function db() {
  const database = openDatabase(":memory:");
  migrate(database);
  return database;
}

function tree() {
  const database = db();
  const enterprise = orgs.createOrganization(database, {
    code: "ent",
    name: "Enterprise",
    kind: "enterprise",
  });
  const company = orgs.createOrganization(database, {
    code: "co",
    name: "Company",
    kind: "company",
    parent_id: enterprise.id,
  });
  const bu = orgs.createOrganization(database, {
    code: "bu",
    name: "BU",
    kind: "business_unit",
    parent_id: company.id,
  });
  const plant = orgs.createOrganization(database, {
    code: "pl",
    name: "Plant",
    kind: "plant",
    parent_id: bu.id,
  });
  const site = orgs.createOrganization(database, {
    code: "st",
    name: "Site",
    kind: "site",
    parent_id: plant.id,
  });
  const dept = orgs.createOrganization(database, {
    code: "dp",
    name: "Dept",
    kind: "department",
    parent_id: site.id,
  });
  return { database, enterprise, company, bu, plant, site, dept };
}

describe("organizations", () => {
  test("hierarchy, sites and delete guards", () => {
    const database = db();
    const hq = orgs.createOrganization(database, { code: "hq", name: "HQ" });
    const region = orgs.createOrganization(database, { code: "west", name: "West", parent_id: hq.id });
    const site = orgs.createOrganization(database, {
      code: "west-1",
      name: "West Site",
      kind: "site",
      parent_id: region.id,
    });
    assert.equal(site.kind, "site");
    assert.throws(() => orgs.updateOrganization(database, hq.id, { parent_id: site.id }), HttpError);
    assert.throws(() => orgs.deleteOrganization(database, hq.id), HttpError);
    orgs.deleteOrganization(database, site.id);
    orgs.deleteOrganization(database, region.id);
    orgs.deleteOrganization(database, hq.id);
    const listed = orgs.listOrganizations(database, {});
    assert.equal(listed.total, 0);
  });

  test("enforces six-level parent kinds", () => {
    const { database, enterprise, company, plant, site } = tree();
    assert.throws(
      () => orgs.createOrganization(database, { code: "bad-ent", name: "Bad", kind: "enterprise", parent_id: company.id }),
      HttpError
    );
    assert.throws(
      () => orgs.createOrganization(database, { code: "bad-co", name: "Bad Co", kind: "company", parent_id: plant.id }),
      HttpError
    );
    assert.throws(
      () => orgs.createOrganization(database, { code: "bad-dept", name: "Bad Dept", kind: "department", parent_id: enterprise.id }),
      HttpError
    );
    const moved = orgs.moveOrganization(database, site.id, plant.id);
    assert.equal(moved.parent_id, plant.id);
    assert.throws(() => orgs.moveOrganization(database, company.id, site.id), HttpError);
  });

  test("prevents cycles and invalid moves", () => {
    const { database, company, plant, site } = tree();
    assert.throws(() => orgs.updateOrganization(database, company.id, { parent_id: company.id }), HttpError);
    assert.throws(() => orgs.moveOrganization(database, company.id, site.id), HttpError);
    assert.throws(() => orgs.moveOrganization(database, plant.id, site.id), HttpError);
  });

  test("users can belong to multiple sites", () => {
    const { database, site, plant } = tree();
    const other = orgs.createOrganization(database, {
      code: "st-2",
      name: "Site 2",
      kind: "site",
      parent_id: plant.id,
    });
    const user = users.createUser(database, {
      username: "multi.site",
      email: "multi.site@helix.example",
      employee_id: "EMP-70",
      display_name: "Multi Site",
      password: "HelixUser!42",
      organization_id: site.id,
    });
    const members = orgs.addMember(database, other.id, user.id, false);
    assert.equal(members.length, 1);
    const assigned = orgs.listUserOrganizations(database, user.id);
    assert.equal(assigned.length, 2);
    assert.ok(assigned.some((o) => o.code === "st" && o.is_primary === 1));
    assert.ok(assigned.some((o) => o.code === "st-2" && o.is_primary === 0));
  });

  test("context and tree for consuming modules", () => {
    const { database, enterprise, site } = tree();
    const ctx = orgs.organizationContext(database, site.id);
    assert.equal(ctx.organization.code, "st");
    assert.ok(ctx.ancestorIds.includes(enterprise.id));
    assert.ok(ctx.descendantIds.includes(site.id));
    assert.match(ctx.path, /ent \/ co \/ bu \/ pl \/ st/);
    const nested = orgs.organizationTree(database, {});
    assert.equal(nested.items[0].code, "ent");
    assert.equal(nested.items[0].children[0].children[0].children[0].children[0].code, "st");
  });

  test("super admin can add a hierarchy level and parent rule", () => {
    const { database, enterprise } = tree();
    const current = hierarchy.getHierarchy(database, { includeInactive: true });
    const allowedParents = { ...current.allowedParents, region: ["enterprise", "organization"] };
    const next = hierarchy.replaceHierarchy(database, {
      levels: [
        ...current.levels,
        { code: "region", name: "Region", sort_order: 15, allow_root: 0, collection: "regions", active: 1 },
      ],
      allowedParents,
    });
    assert.ok(next.levels.some((l) => l.code === "region"));
    const region = orgs.createOrganization(database, {
      code: "na",
      name: "North America",
      kind: "region",
      parent_id: enterprise.id,
    });
    assert.equal(region.kind, "region");
    assert.throws(
      () => orgs.createOrganization(database, { code: "bad-region", name: "Bad", kind: "region" }),
      HttpError
    );
  });

  test("cannot deactivate a level still used by organizations", () => {
    const { database } = tree();
    const current = hierarchy.getHierarchy(database, { includeInactive: true });
    const levels = current.levels.map((l) => (l.code === "site" ? { ...l, active: 0 } : l));
    assert.throws(
      () => hierarchy.replaceHierarchy(database, { levels, allowedParents: current.allowedParents }),
      HttpError
    );
  });
});

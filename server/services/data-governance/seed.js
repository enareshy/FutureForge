// Demonstration seed for Data Governance & Data Quality. Idempotent and safe to
// run on an existing database: it creates a small, realistic governed estate so
// an administrator can see the capability working immediately. Real
// organizations register their own domains, catalogue and rules.
import { queryOne } from "../../db.js";
import { withEventSuppression } from "../events/emit.js";
import { ensureDataGovernanceFoundation } from "./foundation.js";
import { createDomain } from "./domains.js";
import { registerCatalogObject, registerAttribute, findCatalogByType } from "./catalog.js";
import { createMatchRule, listMatchRules } from "./duplicates.js";
import { createPolicy } from "./policies.js";

export function seedDataGovernance(db, tenantId) {
  return withEventSuppression(() => {
    const tenant = resolveTenantId(db, tenantId);
    const foundation = ensureDataGovernanceFoundation(db);
    const created = { domains: 0, catalog: 0, attributes: 0, policies: 0, match_rules: 0 };

    let master = queryOne(db, "SELECT * FROM dg_domains WHERE tenant_id = ? AND code = 'MASTER_DATA'", [tenant]);
    if (!master) {
      master = createDomain(
        db,
        { code: "MASTER_DATA", name: "Master Data", description: "Core enterprise master data governed centrally.", category: "master" },
        null,
        tenant
      );
      created.domains += 1;
    }

    let catalogue = findCatalogByType(db, tenant, "product");
    if (!catalogue) {
      registerCatalogObject(
        db,
        { object_type: "product", name: "Product", description: "Governed product master record", domain_id: master.id },
        null,
        tenant
      );
      created.catalog += 1;
    }
    catalogue = findCatalogByType(db, tenant, "product");
    for (const attribute of [
      { attribute_name: "part.number", label: "Part number", data_type: "string", is_required: true },
      { attribute_name: "part.name", label: "Part name", data_type: "string", is_required: true },
      { attribute_name: "part.category", label: "Part category", data_type: "string" },
    ]) {
      const exists = queryOne(db, "SELECT id FROM dg_catalog_attributes WHERE object_id = ? AND attribute_name = ?", [catalogue.id, attribute.attribute_name]);
      if (exists) continue;
      registerAttribute(db, catalogue.id, attribute, null);
      created.attributes += 1;
    }

    if (!queryOne(db, "SELECT id FROM dg_policies WHERE tenant_id = ? AND code = 'PRODUCT_COMPLETENESS'", [tenant])) {
      createPolicy(
        db,
        {
          code: "PRODUCT_COMPLETENESS",
          name: "Product completeness",
          description: "Every product must carry a part number and a name.",
          object_type: "product",
          domain_id: master.id,
          severity: "error",
          status: "active",
          attributes: ["part.number", "part.name"],
          rule_set: [
            { code: "HAS_NUMBER", rule_type: "REQUIRED", attribute_name: "part.number", severity: "error" },
            { code: "HAS_NAME", rule_type: "REQUIRED", attribute_name: "part.name", severity: "warning" },
          ],
        },
        null,
        tenant
      );
      created.policies += 1;
    }

    const existingRules = listMatchRules(db, { tenantId: tenant, objectType: "product" });
    if (!existingRules.some((rule) => rule.code === "PRODUCT_NUMBER_NAME")) {
      createMatchRule(
        db,
        { code: "PRODUCT_NUMBER_NAME", name: "Product number and name", object_type: "product", attributes: ["part.number", "part.name"], strategy: "normalized" },
        null,
        tenant
      );
      created.match_rules += 1;
    }

    return { foundation, created };
  });
}

// Resolves the demo tenant (the `helix` organization) when the caller does not
// supply one, mirroring how the other platform seed routines resolve scope.
function resolveTenantId(db, tenantId) {
  const explicit = Number(tenantId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const helixes = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  if (!helixes) return null;
  return helixes.id;
}

export function ensureDataGovernanceSeed(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  if (!tenant) return { seeded: false, reason: "no_tenant" };
  const existing = queryOne(db, "SELECT id FROM dg_domains WHERE tenant_id = ? AND code = 'MASTER_DATA'", [tenant]);
  if (existing) return { seeded: false, reason: "already_present" };
  return { seeded: true, ...seedDataGovernance(db, tenant) };
}

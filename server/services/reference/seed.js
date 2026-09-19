// Mandatory enterprise reference domains and representative sample values.
// New domains are configuration, not code; these cover the P0 baseline set and
// demonstrate every framework capability (scope, hierarchy, translation,
// aliases, codes, effective dating, approval, versions).
import { queryOne } from "../../db.js";
import { createDomain, getDomainRow } from "./domains.js";
import { createItem, getItemRow, setItemStatus } from "./items.js";
import { createAlias } from "./aliases.js";
import { createCode } from "./codes.js";
import { upsertTranslation } from "./translations.js";
import { createEdge } from "./hierarchy.js";
import { publishGovernanceVersion } from "./governance.js";
import { getActiveGovernancePolicy } from "./governance.js";

export const MANDATORY_DOMAINS = [
  { code: "UNIT_OF_MEASURE", name: "Unit of Measure", category: "measurement", scope_type: "GLOBAL", description: "Physical and commercial units of measure." },
  { code: "CURRENCY", name: "Currency", category: "finance", scope_type: "GLOBAL", description: "ISO 4217 currencies." },
  { code: "COUNTRY", name: "Country", category: "geography", scope_type: "GLOBAL", description: "Country and territory codes." },
  { code: "LANGUAGE", name: "Language", category: "localization", scope_type: "GLOBAL", description: "ISO languages." },
  { code: "TIME_ZONE", name: "Time Zone", category: "localization", scope_type: "GLOBAL", description: "IANA time zones." },
  { code: "PLANT_TYPE", name: "Plant Type", category: "manufacturing", scope_type: "TENANT", description: "Classification of manufacturing plants." },
  { code: "PRODUCT_CATEGORY", name: "Product Category", category: "pdm", scope_type: "TENANT", hierarchy: true, description: "Hierarchical product categorization." },
  { code: "MATERIAL_TYPE", name: "Material Type", category: "master-data", scope_type: "TENANT", description: "Material type codes." },
  { code: "DOCUMENT_TYPE", name: "Document Type", category: "documents", scope_type: "TENANT", description: "Controlled document types." },
  { code: "INDUSTRY_CODE", name: "Industry Codes", category: "standards", scope_type: "GLOBAL", description: "Industry classification codes." },
  { code: "STANDARD", name: "Standards", category: "standards", scope_type: "GLOBAL", description: "External standards and specifications." },
  { code: "STATUS_CODE", name: "Status Codes", category: "lifecycle", scope_type: "GLOBAL", description: "Canonical status codes." },
  { code: "REASON_CODE", name: "Reason Codes", category: "lifecycle", scope_type: "GLOBAL", description: "Canonical reason codes." },
];

const SAMPLE_ITEMS = {
  UNIT_OF_MEASURE: [
    { code: "EA", name: "Each", attributes: { uom_class: "count" } },
    { code: "KG", name: "Kilogram", attributes: { uom_class: "mass" } },
    { code: "M", name: "Metre", attributes: { uom_class: "length" } },
    { code: "L", name: "Litre", attributes: { uom_class: "volume" } },
  ],
  CURRENCY: [
    { code: "USD", name: "US Dollar", attributes: { minor_unit: 2, symbol: "$" } },
    { code: "EUR", name: "Euro", attributes: { minor_unit: 2, symbol: "€" } },
    { code: "GBP", name: "Pound Sterling", attributes: { minor_unit: 2, symbol: "£" } },
    { code: "JPY", name: "Japanese Yen", attributes: { minor_unit: 0, symbol: "¥" } },
  ],
  COUNTRY: [
    { code: "US", name: "United States", attributes: { iso3: "USA", region: "Americas" } },
    { code: "GB", name: "United Kingdom", attributes: { iso3: "GBR", region: "Europe" } },
    { code: "DE", name: "Germany", attributes: { iso3: "DEU", region: "Europe" } },
    { code: "SG", name: "Singapore", attributes: { iso3: "SGP", region: "Asia" } },
  ],
  LANGUAGE: [
    { code: "en", name: "English", attributes: { iso639_1: "en" } },
    { code: "de", name: "German", attributes: { iso639_1: "de" } },
    { code: "fr", name: "French", attributes: { iso639_1: "fr" } },
  ],
  TIME_ZONE: [
    { code: "UTC", name: "Coordinated Universal Time", attributes: { offset: "+00:00" } },
    { code: "Europe/London", name: "London", attributes: { offset: "+00:00/+01:00" } },
    { code: "Asia/Singapore", name: "Singapore", attributes: { offset: "+08:00" } },
  ],
  PLANT_TYPE: [
    { code: "ASSEMBLY", name: "Assembly plant" },
    { code: "MACHINING", name: "Machining plant" },
    { code: "WAREHOUSE", name: "Warehouse" },
  ],
  PRODUCT_CATEGORY: [
    { code: "VEHICLES", name: "Vehicles" },
    { code: "COMPONENTS", name: "Components" },
    { code: "SOFTWARE", name: "Software" },
  ],
  MATERIAL_TYPE: [
    { code: "RAW", name: "Raw material" },
    { code: "SEMI", name: "Semi-finished" },
    { code: "FINISHED", name: "Finished good" },
  ],
  DOCUMENT_TYPE: [
    { code: "DRAWING", name: "Engineering drawing" },
    { code: "SPEC", name: "Specification" },
    { code: "PROCEDURE", name: "Procedure" },
  ],
  INDUSTRY_CODE: [
    { code: "MANUFACTURING", name: "Manufacturing" },
    { code: "AEROSPACE", name: "Aerospace" },
  ],
  STANDARD: [
    { code: "ISO_9001", name: "ISO 9001", attributes: { body: "ISO" } },
    { code: "ISO_14001", name: "ISO 14001", attributes: { body: "ISO" } },
  ],
  STATUS_CODE: [
    { code: "DRAFT", name: "Draft" },
    { code: "RELEASED", name: "Released" },
    { code: "OBSOLETE", name: "Obsolete" },
  ],
  REASON_CODE: [
    { code: "NEW", name: "New" },
    { code: "CHANGE", name: "Engineering change" },
    { code: "CORRECTION", name: "Correction" },
  ],
};

export function ensureReferenceDomains(db, { tenantId = null, actor = null } = {}) {
  let created = 0;
  const codes = [];
  for (const domain of MANDATORY_DOMAINS) {
    const existing = queryOne(
      db,
      "SELECT id FROM reference_domains WHERE code = ? AND COALESCE(tenant_id, 0) = COALESCE(?, 0)",
      [domain.code, tenantId]
    );
    if (existing) continue;
    try {
      createDomain(db, { ...domain, is_system: true }, actor, tenantId, "seed");
      if (domain.hierarchy) {
        const row = getDomainRow(db, domain.code);
        publishGovernanceVersion(db, row, { hierarchy_enabled: true, approval_required: false }, actor, "seed");
      }
      created += 1;
      codes.push(domain.code);
    } catch {
      /* a partially migrated database must not fail seeding */
    }
  }
  return { created, codes };
}

function seedItemsForDomain(db, domain, actor, tenantId) {
  const created = [];
  for (const item of SAMPLE_ITEMS[domain.code] || []) {
    const row = getDomainRow(db, domain.code);
    if (!row) continue;
    const existing = queryOne(db, "SELECT id FROM reference_data_items WHERE domain_id = ? AND scope_key = 'GLOBAL' AND code = ?", [
      row.id,
      item.code,
    ]);
    if (existing) continue;
    try {
      const created_item = createItem(db, { ...item, domain_id: row.id, scope_type: "GLOBAL", status: "active" }, actor, tenantId, "seed");
      if (created_item.status !== "active") setItemStatus(db, created_item.item_ref, "active", actor, "seed", { changeSummary: "Seeded active" });
      created.push(created_item.item_ref);
    } catch {
      /* skip individual seed failures so one bad row never blocks seeding */
    }
  }
  return created;
}

function seedEnrichment(db, actor, tenantId) {
  const uom = getDomainRow(db, "UNIT_OF_MEASURE");
  if (!uom) return;
  const each = queryOne(db, "SELECT * FROM reference_data_items WHERE domain_id = ? AND code = 'EA'", [uom.id]);
  if (each) {
    if (!queryOne(db, "SELECT id FROM reference_aliases WHERE item_id = ? AND alias = 'UNIT'", [each.id])) {
      try {
        createAlias(db, each, { alias: "UNIT", alias_type: "synonym" }, actor, tenantId, "seed");
        createAlias(db, each, { alias: "PCS", alias_type: "abbreviation" }, actor, tenantId, "seed");
      } catch {
        /* ignore duplicate seed aliases */
      }
    }
    if (!queryOne(db, "SELECT id FROM reference_codes WHERE item_id = ? AND code = 'C62'", [each.id])) {
      try {
        createCode(db, each, { code: "C62", code_type: "external", code_system: "UN/CEFACT" }, actor, tenantId, "seed");
      } catch {
        /* ignore duplicate seed codes */
      }
    }
    if (!queryOne(db, "SELECT id FROM reference_translations WHERE item_id = ? AND language = 'de'", [each.id])) {
      try {
        upsertTranslation(db, each, { language: "de", name: "Stück", description: "Einheit Stück" }, actor, tenantId, "seed");
      } catch {
        /* ignore duplicate seed translations */
      }
    }
  }
  const category = getDomainRow(db, "PRODUCT_CATEGORY");
  if (category) {
    const vehicles = queryOne(db, "SELECT * FROM reference_data_items WHERE domain_id = ? AND code = 'VEHICLES'", [category.id]);
    const components = queryOne(db, "SELECT * FROM reference_data_items WHERE domain_id = ? AND code = 'COMPONENTS'", [category.id]);
    if (vehicles && components && !queryOne(db, "SELECT id FROM reference_hierarchy WHERE parent_id = ? AND child_id = ?", [vehicles.id, components.id])) {
      try {
        createEdge(db, { parentId: vehicles.id, childId: components.id }, actor, tenantId, "seed");
      } catch {
        /* ignore duplicate seed hierarchy */
      }
    }
  }
}

export function seedReference(db, { actor = null, tenantId = null } = {}) {
  const existing = queryOne(db, "SELECT COUNT(*) AS c FROM reference_data_items WHERE is_system = 1 OR item_ref LIKE 'RDM-%'");
  const domains = ensureReferenceDomains(db, { tenantId, actor });
  let items = 0;
  for (const domain of MANDATORY_DOMAINS) {
    items += seedItemsForDomain(db, domain, actor, tenantId).length;
  }
  seedEnrichment(db, actor, tenantId);
  return { domains_created: domains.created, items_created: items, already_seeded: Number(existing?.c ?? 0) > 0 };
}

export { getActiveGovernancePolicy };

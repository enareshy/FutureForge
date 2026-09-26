// Demonstration seed for the Data Catalog & Business Glossary. Idempotent and
// safe to run on an existing database: it creates a small, realistic cataloged
// estate so an administrator can see the capability working immediately. Real
// organizations register their own domains, objects, glossary and lineage.
import { queryOne } from "../../db.js";
import { withEventSuppression } from "../events/emit.js";
import { ensureCatalogFoundation } from "./foundation.js";
import { createDomain } from "../data-governance/domains.js";
import { createCatalogObject, createAttribute, findObjectByType } from "./objects.js";
import { createTerm, findTermByCode, upsertDefinition, addSynonym, addRelation, addMapping } from "./glossary.js";
import { createSource, addSourceMapping, findSourceByCode } from "./sources.js";
import { createConsumer, findConsumerByCode, addConsumerMapping } from "./consumers.js";
import { createLineage } from "./lineage.js";
import { createClassification, getClassificationRow } from "./classifications.js";
import { assignOwnership } from "./ownership.js";

const DOMAINS = [
  { code: "CUSTOMER", name: "Customer", description: "Customer master data and relationships.", category: "master" },
  { code: "PRODUCT", name: "Product", description: "Product and part master data.", category: "master" },
  { code: "FINANCE", name: "Finance", description: "Financial transactions and reporting data.", category: "business" },
];

const CLASSIFICATIONS = [
  { code: "PII", name: "Personal data", category: "regulatory", security_classification: "confidential", description: "Data that identifies a natural person." },
  { code: "FINANCIAL", name: "Financial data", category: "business", security_classification: "confidential", description: "Financial records and reporting figures." },
  { code: "INTERNAL", name: "Internal only", category: "business", security_classification: "internal", description: "Not for external distribution." },
];

export function seedDataCatalog(db, tenantId) {
  return withEventSuppression(() => {
    const tenant = resolveTenantId(db, tenantId);
    const foundation = ensureCatalogFoundation(db);
    const created = { domains: 0, classifications: 0, objects: 0, attributes: 0, terms: 0, sources: 0, consumers: 0, lineage: 0, ownership: 0, mappings: 0 };
    if (!tenant) return { foundation, created, seeded: false, reason: "no_tenant" };

    const domainIds = {};
    for (const domain of DOMAINS) {
      const existing = queryOne(db, "SELECT id FROM dg_domains WHERE tenant_id = ? AND code = ?", [tenant, domain.code]);
      if (existing) {
        domainIds[domain.code] = existing.id;
        continue;
      }
      const row = createDomain(db, domain, null, tenant);
      domainIds[domain.code] = row.id;
      created.domains += 1;
    }

    const classificationIds = {};
    for (const classification of CLASSIFICATIONS) {
      const existing = getClassificationRow(db, classification.code, tenant);
      if (existing) {
        classificationIds[classification.code] = existing.id;
        continue;
      }
      const row = createClassification(db, classification, null, tenant);
      classificationIds[classification.code] = row.id;
      created.classifications += 1;
    }

    const objects = [
      {
        object_type: "customer",
        display_name: "Customer",
        description: "A party that buys products or services.",
        domain_id: domainIds.CUSTOMER,
        target_object_type: "customer",
        attributes: [
          { attribute_name: "customer.number", display_name: "Customer number", data_type: "string", mandatory: true, business_definition: "Unique identifier for a customer." },
          { attribute_name: "customer.name", display_name: "Customer name", data_type: "string", mandatory: true },
          { attribute_name: "customer.email", display_name: "Email address", data_type: "string", classification: "confidential" },
          { attribute_name: "customer.country", display_name: "Country", data_type: "string" },
        ],
      },
      {
        object_type: "product",
        display_name: "Product",
        description: "A sellable or manufacturable item.",
        domain_id: domainIds.PRODUCT,
        target_object_type: "product",
        attributes: [
          { attribute_name: "part.number", display_name: "Part number", data_type: "string", mandatory: true },
          { attribute_name: "part.name", display_name: "Part name", data_type: "string", mandatory: true },
          { attribute_name: "part.category", display_name: "Category", data_type: "string" },
          { attribute_name: "part.unit_cost", display_name: "Unit cost", data_type: "decimal", classification: "confidential" },
        ],
      },
      {
        object_type: "purchase_order",
        display_name: "Purchase order",
        description: "A commitment to purchase goods or services.",
        domain_id: domainIds.FINANCE,
        target_object_type: "purchase_order",
        attributes: [
          { attribute_name: "po.number", display_name: "PO number", data_type: "string", mandatory: true },
          { attribute_name: "po.supplier", display_name: "Supplier", data_type: "string", mandatory: true },
          { attribute_name: "po.total_amount", display_name: "Total amount", data_type: "decimal", classification: "confidential" },
        ],
      },
    ];

    const objectRows = {};
    for (const object of objects) {
      const existing = findObjectByType(db, tenant, object.object_type);
      if (existing) {
        objectRows[object.object_type] = existing;
        continue;
      }
      const row = createCatalogObject(
        db,
        { ...object, attributes: undefined, classification: object.object_type === "customer" ? "confidential" : "internal" },
        null,
        tenant
      );
      // createCatalogObject accepts an attributes array; passing it inline keeps
      // the seed concise.
      for (const attribute of object.attributes) {
        createAttribute(db, row.id, attribute, null, tenant);
        created.attributes += 1;
      }
      objectRows[object.object_type] = row;
      created.objects += 1;
    }

    const terms = [
      {
        code: "CUSTOMER",
        name: "Customer",
        definition: "A party that has purchased, is purchasing or may purchase products or services from the enterprise.",
        domain_id: domainIds.CUSTOMER,
        status: "active",
        synonyms: ["Client", "Account"],
        mappings: [{ target_type: "OBJECT", target_id: objectRows.customer?.entry_id }],
      },
      {
        code: "PART_NUMBER",
        name: "Part number",
        definition: "A unique alphanumeric identifier assigned to a part for identification and inventory purposes.",
        domain_id: domainIds.PRODUCT,
        status: "active",
        synonyms: ["Item number", "SKU"],
        mappings: [{ target_type: "ATTRIBUTE" }],
      },
      {
        code: "PURCHASE_ORDER",
        name: "Purchase order",
        definition: "A commercial document issued by a buyer to a seller indicating types, quantities and agreed prices for products or services.",
        domain_id: domainIds.FINANCE,
        status: "draft",
      },
    ];

    const termRows = {};
    for (const term of terms) {
      let existing = findTermByCode(db, tenant, term.code);
      if (!existing) {
        const row = createTerm(db, { ...term, mappings: undefined, definition: term.definition }, null, tenant);
        existing = queryOne(db, "SELECT * FROM dc_business_terms WHERE id = ?", [row.id]);
        created.terms += 1;
      }
      termRows[term.code] = existing;
      upsertDefinition(db, existing, { definition_type: "BUSINESS", definition: term.definition }, null, tenant);
      for (const synonym of term.synonyms || []) addSynonym(db, existing, synonym, null, tenant);
      for (const mapping of term.mappings || []) {
        if (!mapping.target_id) continue;
        addMapping(db, existing, mapping, null, tenant);
        created.mappings += 1;
      }
    }

    if (termRows.CUSTOMER && termRows.PURCHASE_ORDER) {
      addRelation(db, termRows.PURCHASE_ORDER, { related_term_id: termRows.CUSTOMER.id, relationship_type: "RELATED_TO" }, null, tenant);
    }

    const sources = [
      { code: "ERP", name: "Enterprise resource planning", source_type: "APPLICATION", system: "SAP", description: "System of record for products and purchasing.", connection_reference: "integration/credentials/erp" },
      { code: "CRM", name: "Customer relationship management", source_type: "APPLICATION", system: "Salesforce", description: "System of record for customer master data.", connection_reference: "integration/credentials/crm" },
    ];
    const sourceRows = {};
    for (const source of sources) {
      let existing = findSourceByCode(db, tenant, source.code);
      if (!existing) {
        const row = createSource(db, source, null, tenant);
        existing = queryOne(db, "SELECT * FROM dc_sources WHERE id = ?", [row.id]);
        created.sources += 1;
      }
      sourceRows[source.code] = existing;
    }
    if (sourceRows.CRM && objectRows.customer?.entry_id) {
      addSourceMapping(db, sourceRows.CRM, { target_entry_id: objectRows.customer.entry_id, mapping_type: "SOURCE_TO_OBJECT", source_object_ref: "crm.account" }, null, tenant);
      created.mappings += 1;
    }
    if (sourceRows.ERP && objectRows.product?.entry_id) {
      addSourceMapping(db, sourceRows.ERP, { target_entry_id: objectRows.product.entry_id, mapping_type: "SOURCE_TO_OBJECT", source_object_ref: "sap.mara" }, null, tenant);
      created.mappings += 1;
    }

    const consumers = [
      { code: "ANALYTICS", name: "Analytics warehouse", consumer_type: "ANALYTICS", purpose: "Enterprise reporting and analytics.", frequency: "daily" },
      { code: "SALES_APP", name: "Sales application", consumer_type: "APPLICATION", purpose: "Sales order capture and customer lookup.", frequency: "realtime" },
    ];
    const consumerRows = {};
    for (const consumer of consumers) {
      let existing = findConsumerByCode(db, tenant, consumer.code);
      if (!existing) {
        const row = createConsumer(db, consumer, null, tenant);
        existing = queryOne(db, "SELECT * FROM dc_consumers WHERE id = ?", [row.id]);
        created.consumers += 1;
      }
      consumerRows[consumer.code] = existing;
    }
    if (consumerRows.ANALYTICS && objectRows.customer?.entry_id) {
      addConsumerMapping(db, consumerRows.ANALYTICS, { object_id: objectRows.customer.entry_id, purpose: "Customer analytics", frequency: "daily" }, null, tenant);
      created.mappings += 1;
    }
    if (consumerRows.SALES_APP && objectRows.purchase_order?.entry_id) {
      addConsumerMapping(db, consumerRows.SALES_APP, { object_id: objectRows.purchase_order.entry_id, purpose: "Order capture", frequency: "realtime" }, null, tenant);
      created.mappings += 1;
    }

    // Lineage: CRM source -> Customer object -> Analytics warehouse consumer.
    if (sourceRows.CRM && objectRows.customer?.entry_id && consumerRows.ANALYTICS) {
      const crmEntry = queryOne(db, "SELECT id FROM dc_entries WHERE tenant_id = ? AND entry_type = 'SOURCE' AND code = 'CRM'", [tenant]);
      const analyticsEntry = queryOne(db, "SELECT id FROM dc_entries WHERE tenant_id = ? AND entry_type = 'CONSUMER' AND code = 'ANALYTICS'", [tenant]);
      if (crmEntry && analyticsEntry) {
        createLineage(db, { from_type: "SOURCE", from_id: String(crmEntry.id), to_type: "OBJECT", to_id: String(objectRows.customer.entry_id), relationship_type: "SOURCE_OF", transformation_reference: "integration/jobs/crm-sync" }, null, tenant);
        createLineage(db, { from_type: "OBJECT", from_id: String(objectRows.customer.entry_id), to_type: "CONSUMER", to_id: String(analyticsEntry.id), relationship_type: "CONSUMED_BY" }, null, tenant);
        created.lineage += 2;
      }
    }

    // Seed accountability: the administrator owns and stewards the catalog.
    const admin = queryOne(db, "SELECT id FROM users WHERE username = 'admin'");
    if (admin) {
      for (const object of Object.values(objectRows)) {
        if (!object?.entry_id) continue;
        const hasOwner = queryOne(db, "SELECT id FROM dc_ownership WHERE tenant_id = ? AND entry_id = ? AND relationship = 'owner'", [tenant, object.entry_id]);
        if (hasOwner) continue;
        assignOwnership(db, object.entry_id, { ownership_kind: "DATA_OWNER", relationship: "owner", subject_type: "user", subject_id: admin.id, is_primary: true }, null, tenant);
        assignOwnership(db, object.entry_id, { ownership_kind: "DATA_STEWARD", relationship: "steward", subject_type: "user", subject_id: admin.id, is_primary: true }, null, tenant);
        created.ownership += 2;
      }
    }

    return { foundation, created, seeded: true };
  });
}

function resolveTenantId(db, tenantId) {
  const explicit = Number(tenantId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  return helix?.id ?? null;
}

export function ensureDataCatalogSeed(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  if (!tenant) return { seeded: false, reason: "no_tenant" };
  const existing = queryOne(db, "SELECT id FROM dc_business_terms WHERE tenant_id = ? AND code = 'CUSTOMER'", [tenant]);
  if (existing) return { seeded: false, reason: "already_present" };
  return seedDataCatalog(db, tenant);
}

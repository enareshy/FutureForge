// Demonstration seed for the P1 PDM domain. Idempotent: it installs the
// foundation plus a realistic product structure (a product, its parts and
// revisions, datasets, a representation, a CAD association, an active revision
// rule and configuration rule, a released baseline and a validation run) so the
// capability is visible immediately after boot.
import { queryOne } from "../../db.js";
import { withEventSuppression } from "../events/emit.js";
import { ensurePdmFoundation } from "./foundation.js";
import { createItem } from "./items.js";
import { createRevision, setRevisionStatus } from "./revisions.js";
import { createDataset, linkDatasetContent } from "./datasets.js";
import { createRepresentation } from "./representations.js";
import { createDesignData } from "./design-data.js";
import { createCadAssociation } from "./cad.js";
import { createRelationship } from "./relationships.js";
import { createRevisionRule, activateRevisionRule } from "./revision-rules.js";
import { createConfigurationRule, activateConfigurationRule } from "./configuration-rules.js";
import { createBaseline, releaseBaseline, addBaselineMember } from "./baselines.js";
import { validateTenant } from "./validator.js";

const PARTS = [
  { item_number: "DEMO-HOUSING-001", name: "Pump housing", item_type: "PART" },
  { item_number: "DEMO-SHAFT-002", name: "Drive shaft", item_type: "PART" },
  { item_number: "DEMO-IMPELLER-003", name: "Impeller", item_type: "PART" },
  { item_number: "DEMO-SEAL-004", name: "Mechanical seal", item_type: "PART" },
];

export function seedPdm(db, tenantId) {
  return withEventSuppression(() => {
    const tenant = resolveTenantId(db, tenantId);
    const foundation = ensurePdmFoundation(db);
    const created = { items: 0, revisions: 0, datasets: 0, representations: 0, design_data: 0, cad: 0, relationships: 0, revision_rules: 0, configuration_rules: 0, baselines: 0, validations: 0 };
    if (!tenant) return { foundation, created, seeded: false, reason: "no_tenant" };

    const product = ensureItem(db, tenant, created, {
      item_number: "DEMO-PUMP-ASSY",
      name: "Demonstration pump assembly",
      description: "Product assembly seeded to showcase the PDM domain.",
      item_type: "PRODUCT",
      classification_code: "PUMP",
    });

    const partRows = PARTS.map((part) => ensureItem(db, tenant, created, { ...part, description: `Seeded ${part.name}.` }));

    const productRevision = ensureRevision(db, tenant, created, product.id, "A1", "Initial release");
    const partRevisions = partRows.map((part) => ensureRevision(db, tenant, created, part.id, "A1", "Initial release"));

    for (let i = 0; i < partRows.length; i += 1) {
      ensureRelationship(db, tenant, created, {
        relationship_type: "PRODUCT_HAS_PART",
        source_type: "ITEM",
        source_id: String(product.id),
        target_type: "ITEM",
        target_id: String(partRows[i].id),
        attributes: { quantity: i === 3 ? 2 : 1, find_number: String((i + 1) * 10) },
      });
    }

    const cadDataset = ensureDataset(db, tenant, created, {
      dataset_number: "DEMO-PUMP-CAD",
      name: "Pump assembly CAD",
      description: "Native CAD dataset for the demonstration pump.",
      dataset_type: "CAD_MODEL",
      item_id: product.id,
      revision_id: productRevision.id,
    });
    linkDatasetContent(db, tenant, cadDataset.id, { content_id: "demo-pump-cad", content_type: "application/x-step", content_reference: "demo://pump-assembly.step" }, null, null);

    ensureRepresentation(db, tenant, created, {
      name: "Pump assembly 3D",
      representation_type: "3D",
      item_id: product.id,
      revision_id: productRevision.id,
      dataset_id: cadDataset.id,
    });

    ensureDesignData(db, tenant, created, {
      code: "DEMO-PUMP-BOM",
      name: "Pump design BOM data",
      data_type: "DRAWING",
      item_id: product.id,
      revision_id: productRevision.id,
    });

    ensureCad(db, tenant, created, {
      item_id: product.id,
      source_revision_id: productRevision.id,
      source_object_id: "DEMO-PUMP-ASSY:A1",
      dataset_id: cadDataset.id,
      cad_type: "NATIVE",
      association_type: "MASTER",
      is_primary: true,
      application: "DemoCAD",
    });

    let revisionRule = queryOne(db, "SELECT * FROM pdm_revision_rules WHERE tenant_id = ? AND code = 'DEMO-LATEST-RELEASED'", [tenant]);
    if (!revisionRule) {
      revisionRule = createRevisionRule(db, tenant, { code: "DEMO-LATEST-RELEASED", name: "Latest released", description: "Selects the latest released revision.", rule_type: "LATEST_RELEASED", status: "ACTIVE", is_default: true }, null, null);
      created.revision_rules += 1;
    }
    if (revisionRule.status !== "ACTIVE") activateRevisionRule(db, tenant, revisionRule.id, null, null);

    let configurationRule = queryOne(db, "SELECT * FROM pdm_configuration_rules WHERE tenant_id = ? AND code = 'DEMO-VARIANT'", [tenant]);
    if (!configurationRule) {
      configurationRule = createConfigurationRule(db, tenant, {
        code: "DEMO-VARIANT",
        name: "Variant selection",
        description: "Matches the standard product variant.",
        rule_type: "VARIANT",
        status: "ACTIVE",
        is_default: true,
        config: { match: "ALL", conditions: [{ field: "variant_code", operator: "EQUALS", value: "STANDARD" }] },
      }, null, null);
      created.configuration_rules += 1;
    }
    if (configurationRule.status !== "ACTIVE") activateConfigurationRule(db, tenant, configurationRule.id, null, null);

    let baseline = queryOne(db, "SELECT * FROM pdm_baselines WHERE tenant_id = ? AND baseline_number = 'DEMO-PUMP-BL-A'", [tenant]);
    if (!baseline) {
      baseline = createBaseline(db, tenant, { baseline_number: "DEMO-PUMP-BL-A", name: "Pump assembly baseline A", item_id: product.id, baseline_date: null }, null, null);
      created.baselines += 1;
    }
    const baselineMembers = Number(queryOne(db, "SELECT COUNT(*) AS c FROM pdm_baseline_members WHERE baseline_id = ?", [baseline.id])?.c || 0);
    if (baselineMembers === 0) {
      addBaselineMember(db, tenant, baseline.id, { member_type: "ITEM", member_id: product.id, item_id: product.id, member_ref: "DEMO-PUMP-ASSY", level: 0, path: "0" }, null, null);
      addBaselineMember(db, tenant, baseline.id, { member_type: "REVISION", member_id: productRevision.id, item_id: product.id, revision_id: productRevision.id, member_ref: "DEMO-PUMP-ASSY:A1", level: 1, path: "0.0" }, null, null);
      for (let i = 0; i < partRows.length; i += 1) {
        addBaselineMember(db, tenant, baseline.id, { member_type: "REVISION", member_id: partRevisions[i].id, item_id: partRows[i].id, revision_id: partRevisions[i].id, member_ref: `${partRows[i].item_number}:A1`, level: 2, path: `0.${i + 1}` }, null, null);
      }
    }
    if (baseline.status === "DRAFT") releaseBaseline(db, tenant, baseline.id, null, null);

    if (productRevision.status === "DRAFT") {
      try {
        setRevisionStatus(db, tenant, productRevision.id, "IN_WORK", null, null);
        setRevisionStatus(db, tenant, productRevision.id, "IN_REVIEW", null, null);
        setRevisionStatus(db, tenant, productRevision.id, "RELEASED", null, null);
      } catch {
        // A partially released revision is still a valid demo state.
      }
    }

    const validation = queryOne(db, "SELECT id FROM pdm_validation_results WHERE tenant_id = ? AND scope = 'TENANT'", [tenant]);
    if (!validation) {
      validateTenant(db, tenant, { actor: null });
      created.validations += 1;
    }

    return { foundation, created, seeded: true };
  });
}

function ensureItem(db, tenant, created, body) {
  let row = queryOne(db, "SELECT * FROM pdm_items WHERE tenant_id = ? AND item_number = ?", [tenant, body.item_number]);
  if (!row) {
    row = createItem(db, tenant, body, null, null);
    created.items += 1;
  }
  return row;
}

function ensureRevision(db, tenant, created, itemId, revisionNumber, description) {
  let row = queryOne(db, "SELECT * FROM pdm_item_revisions WHERE tenant_id = ? AND item_id = ? AND revision_number = ?", [tenant, itemId, revisionNumber]);
  if (!row) {
    row = createRevision(db, tenant, itemId, { revision_number: revisionNumber, description }, null, null);
    created.revisions += 1;
  }
  return row;
}

function ensureDataset(db, tenant, created, body) {
  let row = queryOne(db, "SELECT * FROM pdm_datasets WHERE tenant_id = ? AND dataset_number = ?", [tenant, body.dataset_number]);
  if (!row) {
    row = createDataset(db, tenant, body, null, null);
    created.datasets += 1;
  }
  return row;
}

function ensureRepresentation(db, tenant, created, body) {
  const existing = queryOne(db, "SELECT id FROM pdm_representations WHERE tenant_id = ? AND revision_id = ? AND representation_type = ?", [tenant, body.revision_id, body.representation_type]);
  if (existing) return existing;
  created.representations += 1;
  return createRepresentation(db, tenant, body, null, null);
}

function ensureDesignData(db, tenant, created, body) {
  const existing = queryOne(db, "SELECT id FROM pdm_design_data WHERE tenant_id = ? AND revision_id = ? AND code = ?", [tenant, body.revision_id, body.code]);
  if (existing) return existing;
  created.design_data += 1;
  return createDesignData(db, tenant, body, null, null);
}

function ensureCad(db, tenant, created, body) {
  const existing = queryOne(db, "SELECT id FROM pdm_cad_associations WHERE tenant_id = ? AND source_revision_id = ? AND dataset_id = ?", [tenant, body.source_revision_id, body.dataset_id]);
  if (existing) return existing;
  created.cad += 1;
  return createCadAssociation(db, tenant, body, null, null);
}

function ensureRelationship(db, tenant, created, body) {
  const existing = queryOne(db, "SELECT id FROM pdm_relationships WHERE tenant_id = ? AND relationship_type = ? AND source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?", [tenant, body.relationship_type, body.source_type, body.source_id, body.target_type, body.target_id]);
  if (existing) return existing;
  created.relationships += 1;
  return createRelationship(db, tenant, body, null, null);
}

function resolveTenantId(db, tenantId) {
  const explicit = Number(tenantId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  return helix?.id ?? null;
}

export function ensurePdmSeed(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  if (!tenant) return { seeded: false, reason: "no_tenant" };
  const existing = queryOne(db, "SELECT id FROM pdm_items WHERE tenant_id = ? AND item_number = 'DEMO-PUMP-ASSY'", [tenant]);
  if (existing) return { seeded: false, reason: "already_present" };
  return seedPdm(db, tenant);
}

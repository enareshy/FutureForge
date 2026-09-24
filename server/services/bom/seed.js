// Demonstration seed for the P1 BOM Engine. Idempotent: it installs the
// foundation plus a realistic multi-level EBOM (header, released revision, lines,
// a substitute, a frozen baseline, an EBOM->MBOM transformation definition and a
// validation run) so the capability is visible immediately after boot.
import { queryOne } from "../../db.js";
import { withEventSuppression } from "../events/emit.js";
import { ensureBomFoundation } from "./foundation.js";
import { createBom } from "./definitions.js";
import { createRevision, setRevisionStatus } from "./revisions.js";
import { addLine } from "./lines.js";
import { addSubstitute } from "./substitutes.js";
import { createBaseline, freezeBaseline } from "./baseline.js";
import { createTransformationDefinition, createMapping } from "./transformation.js";
import { validateRevision } from "./validator.js";

const LINES = [
  { child_object_id: "DEMO-HOUSING-001", child_object_type: "part", quantity: 1, uom: "EA", find_number: "10", usage: "DESIGN", reference_designator: "" },
  { child_object_id: "DEMO-SHAFT-002", child_object_type: "part", quantity: 1, uom: "EA", find_number: "20", usage: "DESIGN", reference_designator: "" },
  { child_object_id: "DEMO-IMPELLER-003", child_object_type: "part", quantity: 1, uom: "EA", find_number: "30", usage: "DESIGN", reference_designator: "" },
  { child_object_id: "DEMO-SEAL-004", child_object_type: "part", quantity: 2, uom: "EA", find_number: "40", usage: "DESIGN", reference_designator: "" },
  { child_object_id: "DEMO-BEARING-005", child_object_type: "part", quantity: 2, uom: "EA", find_number: "50", usage: "DESIGN", reference_designator: "" },
  { child_object_id: "DEMO-BOLT-M8", child_object_type: "part", quantity: 8, uom: "EA", find_number: "60", usage: "DESIGN", reference_designator: "" },
];

export function seedBom(db, tenantId) {
  return withEventSuppression(() => {
    const tenant = resolveTenantId(db, tenantId);
    const foundation = ensureBomFoundation(db);
    const created = { boms: 0, revisions: 0, lines: 0, substitutes: 0, baselines: 0, transformations: 0, validations: 0 };
    if (!tenant) return { foundation, created, seeded: false, reason: "no_tenant" };

    let bom = queryOne(db, "SELECT * FROM bom_headers WHERE tenant_id = ? AND bom_number = 'DEMO-EBOM-PUMP'", [tenant]);
    if (!bom) {
      bom = createBom(db, tenant, {
        bom_number: "DEMO-EBOM-PUMP",
        name: "Demonstration pump assembly (EBOM)",
        description: "Multi-level engineering BOM seeded to showcase the BOM Engine.",
        bom_type: "EBOM",
        owner_object_id: null,
      }, null, null);
      created.boms += 1;
    }

    let revision = queryOne(db, "SELECT * FROM bom_revisions WHERE tenant_id = ? AND bom_id = ? AND revision_number = 'A1'", [tenant, bom.id]);
    if (!revision) {
      revision = createRevision(db, tenant, bom.id, { revision_number: "A1", valid_from: null, valid_to: null }, null, null);
      created.revisions += 1;
    }

    const lineCount = Number(queryOne(db, "SELECT COUNT(*) AS c FROM bom_lines WHERE bom_revision_id = ?", [revision.id])?.c || 0);
    if (lineCount === 0) {
      for (const line of LINES) {
        addLine(db, tenant, revision.id, line, null, null);
        created.lines += 1;
      }
    }

    if (!queryOne(db, "SELECT id FROM bom_substitutes WHERE tenant_id = ? AND bom_revision_id = ? AND substitute_object_id = 'DEMO-SEAL-ALT'", [tenant, revision.id])) {
      addSubstitute(db, tenant, revision.id, { substitute_object_id: "DEMO-SEAL-ALT", substitute_object_type: "part", substitute_group: "SEAL", priority: 1, ratio: 1 }, null, null);
      created.substitutes += 1;
    }

    let baseline = queryOne(db, "SELECT * FROM bom_baselines WHERE tenant_id = ? AND bom_id = ? AND baseline_number = 'DEMO-EBOM-PUMP-BL-A'", [tenant, bom.id]);
    if (!baseline) {
      baseline = createBaseline(db, tenant, { bom_id: bom.id, revision_id: revision.id, baseline_number: "DEMO-EBOM-PUMP-BL-A", name: "Pump EBOM revision A baseline", status: "DRAFT" }, null, null);
      created.baselines += 1;
    }
    if (baseline.status !== "FROZEN") {
      baseline = freezeBaseline(db, tenant, baseline.id, null, null);
    }

    let definition = queryOne(db, "SELECT * FROM bom_transformation_definitions WHERE tenant_id = ? AND code = 'EBOM_TO_MBOM_DEMO'", [tenant]);
    if (!definition) {
      definition = createTransformationDefinition(db, tenant, {
        code: "EBOM_TO_MBOM_DEMO",
        name: "EBOM to MBOM (demonstration)",
        description: "Maps design usage to manufacturing usage and scales bulk fasteners.",
        source_bom_type: "EBOM",
        target_bom_type: "MBOM",
        status: "ACTIVE",
        config: { usage_map: { DESIGN: "MANUFACTURING" } },
      }, null, null);
      createMapping(db, tenant, definition.id, { mapping_type: "CONSTANT", target_path: "plant", default_value: "PLANT-01", sequence: 10 }, null, null);
      createMapping(db, tenant, definition.id, { mapping_type: "LINE", source_path: "DESIGN", target_path: "usage", sequence: 20 }, null, null);
      created.transformations += 1;
    }

    const validation = queryOne(db, "SELECT id FROM bom_validation_results WHERE tenant_id = ? AND revision_id = ?", [tenant, revision.id]);
    if (!validation) {
      validateRevision(db, tenant, revision.id, { scope: "REVISION", actor: null });
      created.validations += 1;
    }

    if (revision.status === "DRAFT") {
      try {
        setRevisionStatus(db, tenant, revision.id, "IN_REVIEW", null, null);
        setRevisionStatus(db, tenant, revision.id, "RELEASED", null, null);
      } catch {
        // A partially released revision is still a valid demo state.
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

export function ensureBomSeed(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  if (!tenant) return { seeded: false, reason: "no_tenant" };
  const existing = queryOne(db, "SELECT id FROM bom_headers WHERE tenant_id = ? AND bom_number = 'DEMO-EBOM-PUMP'", [tenant]);
  if (existing) return { seeded: false, reason: "already_present" };
  return seedBom(db, tenant);
}

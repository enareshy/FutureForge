// Demonstration seed for the Migration & Onboarding Framework. Idempotent: it
// installs the foundation plus a small, realistic onboarding estate (a legacy
// source configuration, a project, a package and an active definition) so an
// administrator can see the capability working immediately. Real organizations
// connect their own legacy systems.
import { queryOne } from "../../db.js";
import { withEventSuppression } from "../events/emit.js";
import { ensureMigrationFoundation } from "./foundation.js";
import { createProject, setProjectStatus } from "./projects.js";
import { createPackage, setPackageStatus } from "./packages.js";
import { createDefinition, setDefinitionStatus } from "./definitions.js";
import { createSourceConfiguration } from "./source-configurations.js";
import { generatePlan } from "./planning.js";

const DEMO_RECORDS = [
  {
    source_id: "TC-1001",
    part_number: "P-1001",
    part_name: "Gearbox housing",
    part_category: "mechanical",
    part_status: "released",
    notes: "Legacy Teamcenter part",
  },
];

const PRODUCT_MAPPINGS = [
  { source_field: "part_number", target_field: "code", mapping_type: "DIRECT", required: true },
  { source_field: "part_number", target_field: "part.number", mapping_type: "DIRECT", required: true },
  { source_field: "part_name", target_field: "name", mapping_type: "DIRECT", required: true },
  { source_field: "part_name", target_field: "part.name", mapping_type: "DIRECT", required: true },
  { source_field: "part_category", target_field: "part.category", mapping_type: "DIRECT", required: true },
  { source_field: "part_status", target_field: "part.status", mapping_type: "DIRECT", required: true },
  { source_field: "notes", target_field: "description", mapping_type: "DIRECT" },
];

const PRODUCT_RULES = [
  { level: "FIELD", target_field: "part.number", rule_type: "REQUIRED", message: "Part number is required" },
  { level: "FIELD", target_field: "part.name", rule_type: "REQUIRED", message: "Part name is required" },
];

export function seedMigration(db, tenantId) {
  return withEventSuppression(() => {
    const tenant = resolveTenantId(db, tenantId);
    const foundation = ensureMigrationFoundation(db);
    const created = { source_configurations: 0, projects: 0, packages: 0, definitions: 0, plans: 0 };
    if (!tenant) return { foundation, created, seeded: false, reason: "no_tenant" };

    if (!queryOne(db, "SELECT id FROM mig_source_configurations WHERE tenant_id = ? AND code = 'LEGACY_TC'", [tenant])) {
      createSourceConfiguration(
        db,
        tenant,
        {
          code: "LEGACY_TC",
          name: "Legacy Teamcenter extract",
          description: "Read-only extract of the legacy Teamcenter part master.",
          adapter_type: "DATABASE",
          settings: { source_system: "Teamcenter", records: DEMO_RECORDS },
        },
        null,
        null
      );
      created.source_configurations += 1;
    }

    let project = queryOne(db, "SELECT * FROM mig_projects WHERE tenant_id = ? AND code = 'LEGACY_TC_ONBOARD'", [tenant]);
    if (!project) {
      project = createProject(
        db,
        tenant,
        {
          code: "LEGACY_TC_ONBOARD",
          name: "Legacy Teamcenter onboarding",
          description: "Migrate the legacy Teamcenter part master into the platform.",
          source_system: "Teamcenter",
          source_version: "11.6",
          scope: { mode: "FULL" },
        },
        null,
        null
      );
      created.projects += 1;
    }
    const projectRow = queryOne(db, "SELECT * FROM mig_projects WHERE id = ?", [project.id]);

    let pkg = queryOne(db, "SELECT * FROM mig_packages WHERE tenant_id = ? AND code = 'PART_MASTER'", [tenant]);
    if (!pkg) {
      pkg = createPackage(
        db,
        tenant,
        {
          project_id: projectRow.id,
          code: "PART_MASTER",
          name: "Part master",
          description: "Legacy part master records.",
          source_object_type: "Part",
          target_object_type: "product",
          source: { adapter_type: "DATABASE", source_system: "Teamcenter", settings: { records: DEMO_RECORDS } },
          mappings: PRODUCT_MAPPINGS,
          duplicate_strategy: "UPSERT",
          execution_order: 1,
        },
        null,
        null
      );
      created.packages += 1;
    }

    if (!queryOne(db, "SELECT id FROM mig_definitions WHERE tenant_id = ? AND code = 'PART_MASTER_DEF'", [tenant])) {
      const definition = createDefinition(
        db,
        tenant,
        {
          code: "PART_MASTER_DEF",
          name: "Part master migration",
          description: "Map legacy Teamcenter parts to platform products.",
          source_object_type: "Part",
          target_object_type: "product",
          source: { adapter_type: "DATABASE", source_system: "Teamcenter", settings: { records: DEMO_RECORDS } },
          mappings: PRODUCT_MAPPINGS,
          validation_rules: PRODUCT_RULES,
          duplicate_strategy: "UPSERT",
          status: "DRAFT",
        },
        null,
        null
      );
      setDefinitionStatus(db, tenant, definition.id, "ACTIVE", null, null);
      created.definitions += 1;
    }

    try {
      if (projectRow.status === "DRAFT") {
        setProjectStatus(db, tenant, projectRow.id, "READY", null, null);
      }
      const packageRow = queryOne(db, "SELECT * FROM mig_packages WHERE tenant_id = ? AND code = 'PART_MASTER'", [tenant]);
      if (packageRow && packageRow.status === "DRAFT") {
        setPackageStatus(db, tenant, packageRow.id, "READY", null, null);
      }
      generatePlan(db, tenant, projectRow.id, {});
      created.plans += 1;
    } catch {
      // Planning is advisory in the seed; a configuration issue must not fail boot.
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

export function ensureMigrationSeed(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  if (!tenant) return { seeded: false, reason: "no_tenant" };
  const existing = queryOne(db, "SELECT id FROM mig_projects WHERE tenant_id = ? AND code = 'LEGACY_TC_ONBOARD'", [tenant]);
  if (existing) return { seeded: false, reason: "already_present" };
  return seedMigration(db, tenant);
}

// Idempotent sample data for the Effectivity & Versioning Kernel. Demonstrates
// the mandatory acceptance scenarios (date, serial, plant, model) without
// polluting a real object domain: demo objects use a dedicated PART-DEMO-* id
// namespace.
import { queryOne } from "../../db.js";
import * as revisions from "./revisions.js";
import * as versions from "./versions.js";
import * as effectivities from "./effectivities.js";
import * as variants from "./variants.js";
import * as contexts from "./contexts.js";

function ensureRevision(db, input) {
  const existing = queryOne(
    db,
    "SELECT * FROM versioning_revisions WHERE object_type = ? AND object_id = ? AND revision_code = ?",
    [input.objectType, input.objectId, input.revisionCode]
  );
  if (existing) return existing;
  const created = revisions.createRevision(db, input, null, input.tenantId ?? null, null);
  return queryOne(db, "SELECT * FROM versioning_revisions WHERE id = ?", [created.id]);
}

function ensureVersion(db, revisionRow, input) {
  const existing = queryOne(db, "SELECT * FROM versioning_versions WHERE revision_id = ? AND version_number = ?", [
    revisionRow.id,
    input.versionNumber,
  ]);
  if (existing) return existing;
  const created = versions.createVersion(db, revisionRow.revision_ref, input, null, null);
  return queryOne(db, "SELECT * FROM versioning_versions WHERE id = ?", [created.id]);
}

function ensureDefinition(db, input, assignment) {
  const existing = queryOne(db, "SELECT * FROM versioning_effectivity_definitions WHERE code = ?", [input.code]);
  const row = existing ?? queryOne(db, "SELECT * FROM versioning_effectivity_definitions WHERE id = ?", [effectivities.createDefinition(db, input, null, input.tenantId ?? null, null).id]);
  if (assignment) {
    const already = queryOne(
      db,
      "SELECT id FROM versioning_effectivity_assignments WHERE definition_id = ? AND object_type = ? AND object_id = ? AND COALESCE(revision_id, 0) = COALESCE(?, 0)",
      [row.id, assignment.objectType, assignment.objectId, assignment.revisionId ?? null]
    );
    if (!already) effectivities.createAssignment(db, row.definition_ref, assignment, null, input.tenantId ?? null, null);
  }
  return row;
}

export function seedVersioning(db) {
  const existing = queryOne(db, "SELECT COUNT(*) AS c FROM versioning_revisions WHERE object_id LIKE 'PART-DEMO-%'");
  if (Number(existing?.c ?? 0) > 0) return { seeded: false };

  // Date effectivity: Revision A Jan-Jun, Revision B Jul-open.
  const dateA = ensureRevision(db, {
    objectType: "Part",
    objectId: "PART-DEMO-DATE",
    revisionCode: "A",
    name: "Date effectivity revision A",
    status: "active",
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-06-30",
    isDefault: true,
  });
  const dateB = ensureRevision(db, {
    objectType: "Part",
    objectId: "PART-DEMO-DATE",
    revisionCode: "B",
    name: "Date effectivity revision B",
    status: "active",
    effectiveFrom: "2026-07-01",
  });
  ensureVersion(db, dateA, { versionNumber: "1", name: "Initial release", status: "active", isDefault: true, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" });
  ensureVersion(db, dateB, { versionNumber: "1", name: "Mid-year release", status: "active", isDefault: true, effectiveFrom: "2026-07-01" });

  // Serial effectivity: Rev A 0001-0500, Rev B 0501-1000.
  const serialA = ensureRevision(db, {
    objectType: "Part",
    objectId: "PART-DEMO-SERIAL",
    revisionCode: "A",
    name: "Serial effectivity revision A",
    status: "active",
    isDefault: true,
  });
  const serialB = ensureRevision(db, {
    objectType: "Part",
    objectId: "PART-DEMO-SERIAL",
    revisionCode: "B",
    name: "Serial effectivity revision B",
    status: "active",
  });
  ensureDefinition(
    db,
    { code: "DEMO-SERIAL-A", name: "Serials 0001-0500", typeCode: "SERIAL_EFFECTIVITY", dimension: "serial", serialFrom: "0001", serialTo: "0500", serialMode: "numeric" },
    { objectType: "Part", objectId: "PART-DEMO-SERIAL", revisionId: serialA.id, role: "primary" }
  );
  ensureDefinition(
    db,
    { code: "DEMO-SERIAL-B", name: "Serials 0501-1000", typeCode: "SERIAL_EFFECTIVITY", dimension: "serial", serialFrom: "0501", serialTo: "1000", serialMode: "numeric" },
    { objectType: "Part", objectId: "PART-DEMO-SERIAL", revisionId: serialB.id, role: "primary" }
  );

  // Plant effectivity: Rev A PLANT01, Rev B PLANT02.
  const plantA = ensureRevision(db, {
    objectType: "Part",
    objectId: "PART-DEMO-PLANT",
    revisionCode: "A",
    name: "Plant effectivity revision A",
    status: "active",
    isDefault: true,
  });
  const plantB = ensureRevision(db, {
    objectType: "Part",
    objectId: "PART-DEMO-PLANT",
    revisionCode: "B",
    name: "Plant effectivity revision B",
    status: "active",
  });
  ensureDefinition(
    db,
    { code: "DEMO-PLANT-A", name: "Plant 01 applicability", typeCode: "PLANT_EFFECTIVITY", dimension: "plant", values: [{ dimension: "plant", value: "PLANT01" }] },
    { objectType: "Part", objectId: "PART-DEMO-PLANT", revisionId: plantA.id, role: "primary" }
  );
  ensureDefinition(
    db,
    { code: "DEMO-PLANT-B", name: "Plant 02 applicability", typeCode: "PLANT_EFFECTIVITY", dimension: "plant", values: [{ dimension: "plant", value: "PLANT02" }] },
    { objectType: "Part", objectId: "PART-DEMO-PLANT", revisionId: plantB.id, role: "primary" }
  );

  // Model effectivity: Rev A MODEL-X/Y, Rev B MODEL-Z.
  const modelA = ensureRevision(db, {
    objectType: "Part",
    objectId: "PART-DEMO-MODEL",
    revisionCode: "A",
    name: "Model effectivity revision A",
    status: "active",
    isDefault: true,
  });
  const modelB = ensureRevision(db, {
    objectType: "Part",
    objectId: "PART-DEMO-MODEL",
    revisionCode: "B",
    name: "Model effectivity revision B",
    status: "active",
  });
  ensureDefinition(
    db,
    {
      code: "DEMO-MODEL-A",
      name: "Models X and Y",
      typeCode: "MODEL_EFFECTIVITY",
      dimension: "model",
      values: [
        { dimension: "model", value: "MODEL-X" },
        { dimension: "model", value: "MODEL-Y" },
      ],
    },
    { objectType: "Part", objectId: "PART-DEMO-MODEL", revisionId: modelA.id, role: "primary" }
  );
  ensureDefinition(
    db,
    { code: "DEMO-MODEL-B", name: "Model Z", typeCode: "MODEL_EFFECTIVITY", dimension: "model", values: [{ dimension: "model", value: "MODEL-Z" }] },
    { objectType: "Part", objectId: "PART-DEMO-MODEL", revisionId: modelB.id, role: "primary" }
  );

  // Demo variant + options + rule.
  if (!queryOne(db, "SELECT id FROM versioning_variants WHERE code = 'VEHICLE'")) {
    variants.createVariant(
      db,
      {
        code: "VEHICLE",
        name: "Vehicle platform",
        description: "Demo variant with base, electric and hybrid options.",
        options: [
          { code: "BASE", name: "Base", sequence: 1 },
          { code: "ELECTRIC", name: "Electric", sequence: 2 },
          { code: "HYBRID", name: "Hybrid", sequence: 3 },
        ],
        rules: [{ code: "APPLIES-ELECTRIC", name: "Applies to electric variants", ruleType: "applicability", expression: { dimension: "variantCode", operator: "in", values: ["BASE", "ELECTRIC", "HYBRID"] } }],
      },
      null
    );
  }

  // Demo configuration context.
  if (!queryOne(db, "SELECT id FROM versioning_configuration_contexts WHERE code = 'CFG-DEMO-2026'")) {
    contexts.createConfigurationContext(
      db,
      { code: "CFG-DEMO-2026", name: "Demo 2026 configuration", asOfDate: "2026-08-01", modelId: "MODEL-X", plantId: "PLANT01" },
      null
    );
  }

  return { seeded: true };
}

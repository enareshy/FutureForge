// Demonstration seed for the Enterprise Classification Framework. Idempotent: it
// installs the foundation plus a realistic mechanical classification (hierarchy,
// characteristics, allowed values, inherited contract, a rule and a classified
// object) so the capability is visible immediately after boot.
import { queryOne } from "../../db.js";
import { withEventSuppression } from "../events/emit.js";
import { ensureClassificationFoundation } from "./foundation.js";
import { createClassification, setClassificationStatus } from "./definitions.js";
import { createClass, setClassStatus } from "./hierarchy.js";
import { createCharacteristic, createAllowedValue, addClassCharacteristic } from "./characteristics.js";
import { createRule } from "./rules.js";
import { assignClass } from "./assignments.js";

const CHARACTERISTICS = [
  { code: "MATERIAL", name: "Material", data_type: "ENUMERATION", required: true, searchable: true },
  { code: "FLOW_RATE", name: "Flow rate", data_type: "UNIT_NUMERIC", unit: "L/MIN", base_unit: "L/MIN", scale: 2, min_value: 0, searchable: true },
  { code: "PRESSURE", name: "Operating pressure", data_type: "UNIT_NUMERIC", unit: "BAR", base_unit: "BAR", scale: 2, min_value: 0, max_value: 400, searchable: true },
  { code: "WEIGHT", name: "Weight", data_type: "UNIT_NUMERIC", unit: "KG", base_unit: "KG", scale: 3, min_value: 0, searchable: true },
  { code: "SPEED", name: "Rotational speed", data_type: "UNIT_NUMERIC", unit: "RPM", base_unit: "RPM", min_value: 0, searchable: true },
  { code: "POWER", name: "Power", data_type: "UNIT_NUMERIC", unit: "KW", base_unit: "KW", scale: 3, min_value: 0, searchable: true },
  { code: "FINISH", name: "Surface finish", data_type: "STRING", searchable: true },
  { code: "PORTABLE", name: "Portable", data_type: "BOOLEAN", searchable: true },
];

const MATERIAL_VALUES = [
  { code: "CARBON_STEEL", display_name: "Carbon steel" },
  { code: "STAINLESS_STEEL", display_name: "Stainless steel" },
  { code: "CAST_IRON", display_name: "Cast iron" },
  { code: "BRONZE", display_name: "Bronze" },
  { code: "ALUMINIUM", display_name: "Aluminium" },
];

export function seedClassification(db, tenantId) {
  return withEventSuppression(() => {
    const tenant = resolveTenantId(db, tenantId);
    const foundation = ensureClassificationFoundation(db);
    const created = { classifications: 0, classes: 0, characteristics: 0, allowed_values: 0, rules: 0, assignments: 0 };
    if (!tenant) return { foundation, created, seeded: false, reason: "no_tenant" };

    let classification = queryOne(db, "SELECT * FROM cla_classifications WHERE tenant_id = ? AND code = 'MECH_COMPONENTS'", [tenant]);
    if (!classification) {
      classification = createClassification(
        db,
        tenant,
        {
          code: "MECH_COMPONENTS",
          name: "Mechanical components",
          description: "Enterprise classification of mechanical components (pumps, valves, drives).",
          status: "DRAFT",
        },
        null,
        null
      );
      created.classifications += 1;
    }
    if (classification.status !== "ACTIVE") {
      setClassificationStatus(db, tenant, classification.id, "ACTIVE", null, null);
    }

    const root = ensureClass(db, tenant, classification.id, { code: "MECH", name: "Mechanical" }, null);
    const rotating = ensureClass(db, tenant, classification.id, { code: "ROTATING", name: "Rotating equipment" }, root.id);
    const pump = ensureClass(db, tenant, classification.id, { code: "PUMP", name: "Pump" }, rotating.id);

    const characteristics = {};
    for (const def of CHARACTERISTICS) {
      let row = queryOne(db, "SELECT * FROM cla_characteristics WHERE tenant_id = ? AND code = ?", [tenant, def.code]);
      if (!row) {
        row = createCharacteristic(db, tenant, def, null, null);
        created.characteristics += 1;
      }
      characteristics[def.code] = row;
    }

    const material = characteristics.MATERIAL;
    for (const value of MATERIAL_VALUES) {
      const existing = queryOne(db, "SELECT id FROM cla_allowed_values WHERE characteristic_id = ? AND code = ?", [material.id, value.code]);
      if (!existing) {
        createAllowedValue(db, tenant, material.id, value, null, null);
        created.allowed_values += 1;
      }
    }

    // Root defines material (inherited everywhere); the pump adds the rest.
    ensureClassCharacteristic(db, tenant, root.id, characteristics.MATERIAL.id, { required: true, sequence: 0 });
    const pumpCharacteristics = ["FLOW_RATE", "PRESSURE", "WEIGHT", "SPEED", "POWER", "FINISH", "PORTABLE"];
    pumpCharacteristics.forEach((code, index) => {
      ensureClassCharacteristic(db, tenant, pump.id, characteristics[code].id, {
        required: code === "FLOW_RATE" || code === "PRESSURE",
        sequence: index,
      });
    });

    if (!queryOne(db, "SELECT id FROM cla_rules WHERE tenant_id = ? AND class_id = ? AND characteristic_id = ? AND rule_type = 'RANGE'", [tenant, pump.id, characteristics.PRESSURE.id])) {
      createRule(
        db,
        tenant,
        {
          class_id: pump.id,
          characteristic_id: characteristics.PRESSURE.id,
          rule_type: "RANGE",
          config: { min: 1, max: 400 },
          severity: "ERROR",
          message: "Pump operating pressure must be between 1 and 400 bar",
        },
        null,
        null
      );
      created.rules += 1;
    }

    const existingAssignment = queryOne(
      db,
      "SELECT id FROM cla_assignments WHERE tenant_id = ? AND object_type = 'product' AND object_id = 'DEMO-PUMP-001' AND class_id = ?",
      [tenant, pump.id]
    );
    if (!existingAssignment) {
      assignClass(
        db,
        tenant,
        {
          object_type: "product",
          object_id: "DEMO-PUMP-001",
          class_id: pump.id,
          values: {
            MATERIAL: "STAINLESS_STEEL",
            FLOW_RATE: { value: 120, unit: "L/MIN" },
            PRESSURE: { value: 16, unit: "BAR" },
            WEIGHT: { value: 42.5, unit: "KG" },
            SPEED: { value: 2900, unit: "RPM" },
            POWER: { value: 7.5, unit: "KW" },
            FINISH: "Ra 3.2",
            PORTABLE: false,
          },
        },
        null,
        null
      );
      created.assignments += 1;
    }

    return { foundation, created, seeded: true };
  });
}

function ensureClass(db, tenant, classificationId, def, parentId) {
  let row = queryOne(db, "SELECT * FROM cla_classes WHERE tenant_id = ? AND classification_id = ? AND code = ?", [tenant, classificationId, def.code]);
  if (!row) {
    row = createClass(db, tenant, { classification_id: classificationId, parent_class_id: parentId, code: def.code, name: def.name }, null, null);
  }
  if (row.status !== "ACTIVE") setClassStatus(db, tenant, row.id, "ACTIVE", null, null);
  return queryOne(db, "SELECT * FROM cla_classes WHERE id = ?", [row.id]);
}

function ensureClassCharacteristic(db, tenant, classId, characteristicId, options) {
  const existing = queryOne(db, "SELECT id FROM cla_class_characteristics WHERE class_id = ? AND characteristic_id = ?", [classId, characteristicId]);
  if (existing) return existing;
  return addClassCharacteristic(db, tenant, classId, { characteristic_id: characteristicId, ...options }, null, null);
}

function resolveTenantId(db, tenantId) {
  const explicit = Number(tenantId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  return helix?.id ?? null;
}

export function ensureClassificationSeed(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  if (!tenant) return { seeded: false, reason: "no_tenant" };
  const existing = queryOne(db, "SELECT id FROM cla_classifications WHERE tenant_id = ? AND code = 'MECH_COMPONENTS'", [tenant]);
  if (existing) return { seeded: false, reason: "already_present" };
  return seedClassification(db, tenant);
}

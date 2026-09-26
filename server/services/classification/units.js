// Unit of Measure integration.
//
// Classification does NOT own a UOM engine. The enterprise unit master lives in
// the Reference Data Framework (domain `UNIT_OF_MEASURE`); this module registers
// the physical/commercial units classification characteristics need and performs
// conversion using the unit metadata stored on those governed reference items.
// Values are normalized to the characteristic's base unit for search and
// duplicate comparison.
import { listItems, createItem } from "../reference/items.js";
import { getDomainRow } from "../reference/domains.js";
import { ensureReferenceDomains } from "../reference/seed.js";
import { UNIT_DOMAIN_CODE } from "./constants.js";
import { normalizeText, normalizeUpper, parseObject } from "./validation.js";
import { invalidUnit, incompatibleUnit } from "./errors.js";

// factor converts a unit value to its class base unit; offset applies for
// affine scales (temperature). Metadata only — the engine is generic.
export const DEFAULT_UNITS = [
  { code: "EA", name: "Each", uom_class: "count", base_unit: "EA", factor: 1, offset: 0 },
  { code: "KG", name: "Kilogram", uom_class: "mass", base_unit: "KG", factor: 1, offset: 0 },
  { code: "G", name: "Gram", uom_class: "mass", base_unit: "KG", factor: 0.001, offset: 0 },
  { code: "M", name: "Metre", uom_class: "length", base_unit: "M", factor: 1, offset: 0 },
  { code: "MM", name: "Millimetre", uom_class: "length", base_unit: "M", factor: 0.001, offset: 0 },
  { code: "CM", name: "Centimetre", uom_class: "length", base_unit: "M", factor: 0.01, offset: 0 },
  { code: "L", name: "Litre", uom_class: "volume", base_unit: "L", factor: 1, offset: 0 },
  { code: "ML", name: "Millilitre", uom_class: "volume", base_unit: "L", factor: 0.001, offset: 0 },
  { code: "M3", name: "Cubic metre", uom_class: "volume", base_unit: "L", factor: 1000, offset: 0 },
  { code: "L/MIN", name: "Litre per minute", uom_class: "flow", base_unit: "L/MIN", factor: 1, offset: 0 },
  { code: "M3/H", name: "Cubic metre per hour", uom_class: "flow", base_unit: "L/MIN", factor: 1000 / 60, offset: 0 },
  { code: "GPM", name: "US gallon per minute", uom_class: "flow", base_unit: "L/MIN", factor: 3.785411784, offset: 0 },
  { code: "BAR", name: "Bar", uom_class: "pressure", base_unit: "BAR", factor: 1, offset: 0 },
  { code: "KPA", name: "Kilopascal", uom_class: "pressure", base_unit: "BAR", factor: 0.01, offset: 0 },
  { code: "MPA", name: "Megapascal", uom_class: "pressure", base_unit: "BAR", factor: 10, offset: 0 },
  { code: "PSI", name: "Pound per square inch", uom_class: "pressure", base_unit: "BAR", factor: 0.0689475729, offset: 0 },
  { code: "KW", name: "Kilowatt", uom_class: "power", base_unit: "KW", factor: 1, offset: 0 },
  { code: "W", name: "Watt", uom_class: "power", base_unit: "KW", factor: 0.001, offset: 0 },
  { code: "HP", name: "Horsepower", uom_class: "power", base_unit: "KW", factor: 0.745699872, offset: 0 },
  { code: "RPM", name: "Revolutions per minute", uom_class: "rotational_speed", base_unit: "RPM", factor: 1, offset: 0 },
  { code: "S", name: "Second", uom_class: "time", base_unit: "S", factor: 1, offset: 0 },
  { code: "MIN", name: "Minute", uom_class: "time", base_unit: "S", factor: 60, offset: 0 },
  { code: "H", name: "Hour", uom_class: "time", base_unit: "S", factor: 3600, offset: 0 },
  { code: "HZ", name: "Hertz", uom_class: "frequency", base_unit: "HZ", factor: 1, offset: 0 },
  { code: "C", name: "Degree Celsius", uom_class: "temperature", base_unit: "C", factor: 1, offset: 0 },
  { code: "K", name: "Kelvin", uom_class: "temperature", base_unit: "C", factor: 1, offset: -273.15 },
  { code: "DEG", name: "Degree", uom_class: "angle", base_unit: "DEG", factor: 1, offset: 0 },
  { code: "PCT", name: "Percent", uom_class: "ratio", base_unit: "PCT", factor: 1, offset: 0 },
];

function attributesOf(row) {
  return parseObject(row?.attributes_json ?? row?.attributes, {});
}

export function publicUnit(row) {
  if (!row) return null;
  const attributes = attributesOf(row);
  return {
    code: row.code,
    name: row.name || row.code,
    description: row.description || "",
    uom_class: attributes.uom_class || "",
    base_unit: attributes.base_unit || row.code,
    factor: attributes.factor === undefined ? 1 : Number(attributes.factor),
    offset: attributes.offset === undefined ? 0 : Number(attributes.offset),
    status: row.status,
    item_ref: row.item_ref,
  };
}

export function listUnits(db, { tenantId = null, uomClass = null, q = null, limit = 1000 } = {}) {
  let rows;
  try {
    rows = listItems(db, { domainCode: UNIT_DOMAIN_CODE, status: "active", q, limit, tenantId }).items;
  } catch {
    rows = [];
  }
  return rows
    .map(publicUnit)
    .filter((unit) => unit && (!uomClass || unit.uom_class === String(uomClass).toLowerCase()));
}

export function getUnit(db, code) {
  const normalized = normalizeUpper(code);
  if (!normalized) return null;
  let rows;
  try {
    rows = listItems(db, { domainCode: UNIT_DOMAIN_CODE, code: normalized, limit: 5 }).items;
  } catch {
    return null;
  }
  return rows.map(publicUnit).find((unit) => normalizeUpper(unit.code) === normalized) || null;
}

// Registers the classification unit catalogue into the shared Reference Data
// UOM domain. Idempotent: existing governed units are never overwritten.
export function ensureClassificationUnits(db) {
  ensureReferenceDomains(db, { tenantId: null });
  const domain = getDomainRow(db, UNIT_DOMAIN_CODE);
  if (!domain) return { created: 0, domain: UNIT_DOMAIN_CODE };
  let created = 0;
  for (const unit of DEFAULT_UNITS) {
    let existing;
    try {
      existing = listItems(db, { domainCode: UNIT_DOMAIN_CODE, code: unit.code, limit: 1 }).items[0];
    } catch {
      existing = null;
    }
    if (existing) continue;
    try {
      createItem(
        db,
        {
          domain_code: UNIT_DOMAIN_CODE,
          code: unit.code,
          name: unit.name,
          description: `Classification unit: ${unit.name}`,
          status: "active",
          attributes: { uom_class: unit.uom_class, base_unit: unit.base_unit, factor: unit.factor, offset: unit.offset },
          metadata: { system: true, source_module: "classification" },
          is_system: true,
        },
        null,
        null,
        null
      );
      created += 1;
    } catch {
      // A unit may already exist from another module's registration; never block boot.
    }
  }
  return { created, domain: UNIT_DOMAIN_CODE };
}

// Converts a numeric value between two units. Units must exist in the shared UOM
// domain and belong to the same UOM class. Returns the value expressed in the
// target unit plus the value expressed in the class base unit.
export function convertValue(value, fromUnit, toUnit, { units = null, strict = true } = {}) {
  const from = typeof fromUnit === "object" && fromUnit ? fromUnit : (units || []).find((u) => normalizeUpper(u.code) === normalizeUpper(fromUnit)) || null;
  const to = typeof toUnit === "object" && toUnit ? toUnit : (units || []).find((u) => normalizeUpper(u.code) === normalizeUpper(toUnit)) || null;
  if (!from || !to) {
    if (strict) throw invalidUnit(`Unknown unit: ${from ? toUnit : fromUnit}`, { from_unit: fromUnit, to_unit: toUnit });
    return { value: Number(value), unit: toUnit || fromUnit || "", normalized_value: Number(value), normalized_unit: from?.base_unit || fromUnit || "" };
  }
  if (from.uom_class && to.uom_class && from.uom_class !== to.uom_class) {
    if (strict) throw incompatibleUnit({ from_unit: from.code, from_class: from.uom_class, to_unit: to.code, to_class: to.uom_class });
    return { value: Number(value), unit: to.code, normalized_value: Number(value), normalized_unit: from.base_unit, compatible: false };
  }
  const baseValue = Number(value) * Number(from.factor || 1) + Number(from.offset || 0);
  const converted = (baseValue - Number(to.offset || 0)) / Number(to.factor || 1);
  return {
    value: round(converted),
    unit: to.code,
    normalized_value: round(baseValue),
    normalized_unit: from.base_unit || to.base_unit || to.code,
    compatible: true,
  };
}

function round(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1e9) / 1e9;
}

// Resolves a unit by code, throwing a stable error when missing.
export function requireUnit(db, code) {
  const unit = getUnit(db, code);
  if (!unit) throw invalidUnit(`Unknown unit: ${code}`, { unit: code });
  return unit;
}

// Normalizes a raw value + unit to the characteristic's base unit metadata.
export function normalizeValue(db, { value, unit, baseUnit }) {
  const units = listUnits(db, { limit: 2000 });
  const result = convertValue(value, unit || baseUnit, baseUnit || unit, { units, strict: false });
  return result;
}

export { attributesOf };

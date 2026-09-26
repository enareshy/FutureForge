// Unit-of-measure integration for the BOM Engine.
//
// Quantities are never stored without a valid UOM. The enterprise unit list is
// owned by the shared Reference Data domain (UNIT_OF_MEASURE) and served by the
// classification framework's unit module; the BOM Engine reuses it rather than
// creating a second unit master.
import * as ClassificationUnits from "../classification/units.js";
import { UNIT_DOMAIN_CODE as CLASSIFICATION_UNIT_DOMAIN_CODE } from "../classification/constants.js";
import { invalidUnit as bomInvalidUnit, incompatibleUnit as bomIncompatibleUnit } from "./errors.js";

export const UNIT_DOMAIN_CODE = CLASSIFICATION_UNIT_DOMAIN_CODE;

export function listUnits(db, { tenantId = null, uomClass = null, q = null, limit = 1000 } = {}) {
  return ClassificationUnits.listUnits(db, { tenantId, uomClass, q, limit });
}

export function getUnit(db, code) {
  return ClassificationUnits.getUnit(db, code);
}

export function requireUnit(db, code) {
  try {
    return ClassificationUnits.requireUnit(db, code);
  } catch (error) {
    throw bomInvalidUnit(error.message, { unit: code });
  }
}

export function convertValue(value, fromUnit, toUnit, options = {}) {
  const units = options.units ?? ClassificationUnits.DEFAULT_UNITS;
  const result = ClassificationUnits.convertValue(value, fromUnit, toUnit, { ...options, units });
  if (result && result.compatible === false) {
    throw bomIncompatibleUnit({ value, from: fromUnit, to: toUnit });
  }
  return result;
}

// Normalizes a quantity to the characteristic's base unit when compatible; when
// the units are incompatible it leaves the quantity untouched and reports it.
export function normalizeQuantityValue(db, { value, uom, baseUom }) {
  const quantity = Number(value);
  const from = String(uom || "").toUpperCase();
  const to = String(baseUom || from || "").toUpperCase();
  if (!Number.isFinite(quantity) || !from || !to || from === to) {
    return { quantity, uom: from, normalized_quantity: quantity, normalized_uom: to || from, compatible: true };
  }
  const converted = ClassificationUnits.convertValue(quantity, from, to, { strict: false, units: ClassificationUnits.DEFAULT_UNITS });
  if (!converted || converted.compatible === false) {
    return { quantity, uom: from, normalized_quantity: quantity, normalized_uom: from, compatible: false };
  }
  return { quantity, uom: from, normalized_quantity: converted.normalized_value ?? converted.value, normalized_uom: to, compatible: true };
}

export function ensureBomUnits(db) {
  return ClassificationUnits.ensureClassificationUnits(db);
}

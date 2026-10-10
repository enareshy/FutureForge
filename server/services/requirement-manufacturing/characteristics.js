// Manufacturing characteristics, CTQ designation and process constraints.
//
// No quality/constraint engine is introduced: a manufacturing/CTQ characteristic
// IS an existing Classification characteristic. This module only designates
// which existing characteristics are critical-to-quality (stored in the
// characteristic's own `metadata_json`) and reads the inclusive/exclusive limits
// that Classification already models (characteristic-level min/max and the
// per-class `min_value`/`max_value` overrides). Everything is written through the
// Classification facade so its validation, versioning, audit and events apply.
import { Classification, Characteristics } from "../classification/index.js";
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { characteristicNotFound } from "./errors.js";

const CTQ_KEY = "ctq";
const CTQ_SEVERITY_KEY = "ctq_severity";
const CTQ_RATIONALE_KEY = "ctq_rationale";

function mergeMetadata(row, patch) {
  let current = {};
  try {
    current = JSON.parse(row.metadata_json || "{}") || {};
  } catch {
    current = {};
  }
  return { ...current, ...patch };
}

async function loadCharacteristicAsync(db, tenantId, ref) {
  const row = await queryOneAsync(db, "SELECT * FROM cla_characteristics WHERE tenant_id = ? AND (id = ? OR characteristic_ref = ? OR lower(code) = lower(?))", [Number(tenantId), Number(ref) || -1, String(ref), String(ref)]);
  if (!row) throw characteristicNotFound(ref);
  return row;
}

// Designates (or clears) a characteristic as critical-to-quality. Stored in the
// classification characteristic's existing metadata; no parallel quality model.
export function designateCtq(db, tenantId, ref, { ctq = true, severity = "", rationale = "" } = {}, actor = null, ip = null) {
  const row = queryOne(db, "SELECT * FROM cla_characteristics WHERE tenant_id = ? AND (id = ? OR characteristic_ref = ? OR lower(code) = lower(?))", [Number(tenantId), Number(ref) || -1, String(ref), String(ref)]);
  if (!row) throw characteristicNotFound(ref);
  const patch = {
    [CTQ_KEY]: Boolean(ctq),
    [CTQ_SEVERITY_KEY]: String(severity || ""),
    [CTQ_RATIONALE_KEY]: String(rationale || ""),
  };
  return Classification.updateCharacteristic(db, Number(tenantId), row.id, { metadata: mergeMetadata(row, patch) }, actor, ip);
}

export async function designateCtqAsync(db, tenantId, ref, options = {}, actor = null, ip = null) {
  const row = await loadCharacteristicAsync(db, tenantId, ref);
  const patch = {
    [CTQ_KEY]: Boolean(options.ctq ?? true),
    [CTQ_SEVERITY_KEY]: String(options.severity || ""),
    [CTQ_RATIONALE_KEY]: String(options.rationale || ""),
  };
  return Characteristics.updateCharacteristicAsync(db, Number(tenantId), row.id, { metadata: mergeMetadata(row, patch) }, actor, ip);
}

// Sets machine-readable process-constraint limits on the characteristic. The
// Classification model already stores inclusive/exclusive bounds; this is a
// convenience around the existing update path.
export function setCharacteristicLimits(db, tenantId, ref, limits = {}, actor = null, ip = null) {
  const row = queryOne(db, "SELECT * FROM cla_characteristics WHERE tenant_id = ? AND (id = ? OR characteristic_ref = ? OR lower(code) = lower(?))", [Number(tenantId), Number(ref) || -1, String(ref), String(ref)]);
  if (!row) throw characteristicNotFound(ref);
  const body = {};
  if (limits.min_value !== undefined || limits.minValue !== undefined) body.min_value = limits.min_value ?? limits.minValue;
  if (limits.max_value !== undefined || limits.maxValue !== undefined) body.max_value = limits.max_value ?? limits.maxValue;
  if (limits.min_inclusive !== undefined) body.min_inclusive = limits.min_inclusive;
  if (limits.max_inclusive !== undefined) body.max_inclusive = limits.max_inclusive;
  return Classification.updateCharacteristic(db, Number(tenantId), row.id, body, actor, ip);
}

export async function setCharacteristicLimitsAsync(db, tenantId, ref, limits = {}, actor = null, ip = null) {
  const row = await loadCharacteristicAsync(db, tenantId, ref);
  const body = {};
  if (limits.min_value !== undefined || limits.minValue !== undefined) body.min_value = limits.min_value ?? limits.minValue;
  if (limits.max_value !== undefined || limits.maxValue !== undefined) body.max_value = limits.max_value ?? limits.maxValue;
  if (limits.min_inclusive !== undefined) body.min_inclusive = limits.min_inclusive;
  if (limits.max_inclusive !== undefined) body.max_inclusive = limits.max_inclusive;
  return Characteristics.updateCharacteristicAsync(db, Number(tenantId), row.id, body, actor, ip);
}

// Reads the effective CTQ + constraint view of a characteristic for the
// traceability/coverage projections.
export function characteristicConstraints(db, tenantId, ref) {
  const row = queryOne(db, "SELECT * FROM cla_characteristics WHERE tenant_id = ? AND (id = ? OR characteristic_ref = ? OR lower(code) = lower(?))", [Number(tenantId), Number(ref) || -1, String(ref), String(ref)]);
  if (!row) throw characteristicNotFound(ref);
  let metadata = {};
  try {
    metadata = JSON.parse(row.metadata_json || "{}") || {};
  } catch {
    metadata = {};
  }
  return {
    characteristic_ref: row.characteristic_ref,
    id: row.id,
    code: row.code,
    ctq: Boolean(metadata[CTQ_KEY]),
    ctq_severity: metadata[CTQ_SEVERITY_KEY] || "",
    min_value: row.min_value,
    max_value: row.max_value,
    min_inclusive: Boolean(Number(row.min_inclusive)),
    max_inclusive: Boolean(Number(row.max_inclusive)),
    unit: row.unit,
  };
}

// Lists CTQ-designated characteristics (bounded, for coverage readers).
export function listCriticalCharacteristics(db, tenantId, { limit = 500 } = {}) {
  const rows = queryAll(db, "SELECT * FROM cla_characteristics WHERE tenant_id = ? ORDER BY id DESC LIMIT ?", [Number(tenantId), Math.min(Number(limit) || 500, 2000)]);
  return rows.filter((row) => {
    try {
      return Boolean(JSON.parse(row.metadata_json || "{}")?.[CTQ_KEY]);
    } catch {
      return false;
    }
  }).map((row) => characteristicConstraints(db, tenantId, row.id));
}

export async function listCriticalCharacteristicsAsync(db, tenantId, { limit = 500 } = {}) {
  const rows = await queryAllAsync(db, "SELECT * FROM cla_characteristics WHERE tenant_id = ? ORDER BY id DESC LIMIT ?", [Number(tenantId), Math.min(Number(limit) || 500, 2000)]);
  const result = [];
  for (const row of rows) {
    let ctq = false;
    try {
      ctq = Boolean(JSON.parse(row.metadata_json || "{}")?.[CTQ_KEY]);
    } catch {
      ctq = false;
    }
    if (ctq) result.push(characteristicConstraints(db, tenantId, row.id));
  }
  return result;
}

export const CTQ_METADATA_KEYS = Object.freeze({ ctq: CTQ_KEY, severity: CTQ_SEVERITY_KEY, rationale: CTQ_RATIONALE_KEY });

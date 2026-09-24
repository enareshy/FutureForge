// Effectivity resolution (dates, serial ranges, lot ranges and change numbers).
//
// Effectivity is stored as JSON on both revisions and lines. Resolving it is a
// pure function so the same rules power structure filtering, rollup, where-used,
// comparison and validation without duplication.
import { parseObject, normalizeText, normalizeUpper } from "./validation.js";
import { invalidEffectivity } from "./errors.js";

const DATE_KEYS = ["start", "start_date", "valid_from", "effective_from"];
const END_KEYS = ["end", "end_date", "valid_to", "effective_to"];

function firstValue(source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
  }
  return null;
}

function asDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : time;
}

export function normalizeEffectivity(input) {
  const source = parseObject(input, {});
  const start = firstValue(source, DATE_KEYS);
  const end = firstValue(source, END_KEYS);
  const startTime = asDate(start);
  const endTime = asDate(end);
  if (startTime !== null && endTime !== null && startTime > endTime) {
    throw invalidEffectivity("Effectivity start must not be after end", { start, end });
  }
  return {
    start: start !== null ? String(start) : null,
    end: end !== null ? String(end) : null,
    serial_from: normalizeUpper(source.serial_from ?? source.serialFrom ?? "", { max: 80 }) || null,
    serial_to: normalizeUpper(source.serial_to ?? source.serialTo ?? "", { max: 80 }) || null,
    lot_from: normalizeUpper(source.lot_from ?? source.lotFrom ?? "", { max: 80 }) || null,
    lot_to: normalizeUpper(source.lot_to ?? source.lotTo ?? "", { max: 80 }) || null,
    change_number: normalizeText(source.change_number ?? source.changeNumber ?? source.change ?? "", { max: 80 }) || null,
    changes: Array.isArray(source.changes) ? source.changes.map((value) => String(value)) : [],
  };
}

export function isEmptyEffectivity(effectivity) {
  const e = effectivity || {};
  return !e.start && !e.end && !e.serial_from && !e.serial_to && !e.lot_from && !e.lot_to && !e.change_number && !(e.changes && e.changes.length);
}

// A context carries { at, serial, lot, change } and returns whether effectivity
// is currently active. Absent context dimensions are treated as wildcards.
export function isEffectivityActive(effectivity, context = {}) {
  const effectivityValue = parseObject(effectivity, {});
  if (isEmptyEffectivity(effectivityValue)) return true;
  const at = context.at ? asDate(context.at) : context.now ? asDate(context.now) : null;
  if (at !== null) {
    const start = asDate(effectivityValue.start);
    const end = asDate(effectivityValue.end);
    if (start !== null && at < start) return false;
    if (end !== null && at > end) return false;
  }
  const serial = context.serial ? normalizeUpper(context.serial, { max: 80 }) : null;
  if (serial) {
    if (effectivityValue.serial_from && serial < effectivityValue.serial_from) return false;
    if (effectivityValue.serial_to && serial > effectivityValue.serial_to) return false;
  }
  const lot = context.lot ? normalizeUpper(context.lot, { max: 80 }) : null;
  if (lot) {
    if (effectivityValue.lot_from && lot < effectivityValue.lot_from) return false;
    if (effectivityValue.lot_to && lot > effectivityValue.lot_to) return false;
  }
  const change = context.change ? String(context.change) : null;
  if (change && effectivityValue.change_number && effectivityValue.change_number !== change) return false;
  if (change && Array.isArray(effectivityValue.changes) && effectivityValue.changes.length && !effectivityValue.changes.includes(change)) return false;
  return true;
}

export function filterByEffectivity(lines, context = {}) {
  return (lines || []).filter((line) => isEffectivityActive(line.effectivity ?? line.effectivity_json, context));
}

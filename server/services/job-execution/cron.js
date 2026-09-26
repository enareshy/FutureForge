// Minimal, dependency-free 5-field cron parser + matcher.
//
// Supported syntax per field: `*`, `a`, `a-b`, `a-b/step`, `*/step`, lists
// `a,b,c`. Fields are minute (0-59), hour (0-23), day-of-month (1-31),
// month (1-12) and day-of-week (0-6, Sunday = 0).

import { HttpError } from "./errors.js";

const FIELDS = [
  { key: "minute", min: 0, max: 59, label: "minute" },
  { key: "hour", min: 0, max: 23, label: "hour" },
  { key: "dayOfMonth", min: 1, max: 31, label: "day-of-month" },
  { key: "month", min: 1, max: 12, label: "month" },
  { key: "dayOfWeek", min: 0, max: 6, label: "day-of-week" },
];

function parseField(raw, spec) {
  const field = String(raw || "").trim();
  if (!field) {
    throw new HttpError(400, `cron_expression is missing the ${spec.label} field`);
  }
  if (field === "*") return { any: true, set: null };
  const set = new Set();
  for (const chunk of field.split(",")) {
    if (!chunk) {
      throw new HttpError(400, `cron_expression ${spec.label} field has an empty term`);
    }
    const [rangePart, stepPart] = chunk.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) {
        throw new HttpError(400, `cron_expression ${spec.label} step must be a positive integer`);
      }
    }
    let start;
    let end;
    if (rangePart === "*") {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(rangePart);
      end = stepPart === undefined ? start : spec.max;
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < spec.min ||
      end > spec.max ||
      start > end
    ) {
      throw new HttpError(400, `cron_expression ${spec.label} term "${chunk}" is out of range`);
    }
    for (let value = start; value <= end; value += step) set.add(value);
  }
  if (!set.size) {
    throw new HttpError(400, `cron_expression ${spec.label} field matches no values`);
  }
  return { any: false, set };
}

export function parseCron(expression) {
  const parts = String(expression || "").trim().split(/\s+/);

  // Accept an optional leading seconds field, normalising it away: the engine
  // schedules at minute granularity.
  let fields = parts;
  if (parts.length === 6) fields = parts.slice(1);
  if (fields.length !== 5) {
    throw new HttpError(
      400,
      "cron_expression must contain 5 fields (minute hour day-of-month month day-of-week)"
    );
  }
  const parsed = {
    minute: parseField(fields[0], FIELDS[0]),
    hour: parseField(fields[1], FIELDS[1]),
    dayOfMonth: parseField(fields[2], FIELDS[2]),
    month: parseField(fields[3], FIELDS[3]),
    dayOfWeek: parseField(fields[4], FIELDS[4]),
    domRestricted: String(fields[2]).trim() !== "*",
    dowRestricted: String(fields[4]).trim() !== "*",
  };
  return parsed;
}

function matches(field, value) {
  return field.any || field.set.has(value);
}

export function cronMatches(fields, parts) {
  if (!matches(fields.minute, parts.minute)) return false;
  if (!matches(fields.hour, parts.hour)) return false;
  if (!matches(fields.month, parts.month)) return false;
  const dom = matches(fields.dayOfMonth, parts.day);
  const dow = matches(fields.dayOfWeek, parts.weekday);
  // Standard cron semantics: when both day fields are restricted they are
  // OR-ed, otherwise they are AND-ed.
  if (fields.domRestricted && fields.dowRestricted) return dom || dow;
  return dom && dow;
}

export function isValidCron(expression) {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

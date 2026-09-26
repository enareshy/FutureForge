// Structured validation results (§9).
//
// A validation run returns one normalized result object. Individual findings
// carry the level (FILE/STANDARDS/ENTERPRISE), severity (ERROR/WARNING/INFO),
// stable code, human message, source path, target object/attribute and an
// optional recommendation so the UI can explain how to fix the payload.
import { VALIDATION_LEVELS, VALIDATION_STATUSES, SEVERITIES } from "./constants.js";

export function finding({
  level = "ENTERPRISE",
  severity = "ERROR",
  code = "",
  message = "",
  sourcePath = "",
  targetObject = "",
  attribute = "",
  rule = "",
  recommendation = "",
  value = undefined,
  details = null,
} = {}) {
  return {
    level: VALIDATION_LEVELS.includes(String(level).toUpperCase()) ? String(level).toUpperCase() : "ENTERPRISE",
    severity: SEVERITIES.includes(String(severity).toUpperCase()) ? String(severity).toUpperCase() : "ERROR",
    code,
    message,
    source_path: sourcePath,
    target_object: targetObject,
    attribute,
    rule,
    recommendation,
    value,
    details,
  };
}

export function emptyValidationResult() {
  return {
    status: "PASSED",
    severity: "INFO",
    findings: [],
    errors: 0,
    warnings: 0,
    infos: 0,
    levels: { FILE: 0, STANDARDS: 0, ENTERPRISE: 0 },
  };
}

export function summarizeValidation(findings = []) {
  const result = emptyValidationResult();
  result.findings = findings;
  for (const entry of findings) {
    if (entry.severity === "ERROR") result.errors += 1;
    else if (entry.severity === "WARNING") result.warnings += 1;
    else result.infos += 1;
    if (result.levels[entry.level] !== undefined) result.levels[entry.level] += 1;
  }
  if (result.errors > 0) {
    result.status = "FAILED";
    result.severity = "ERROR";
  } else if (result.warnings > 0) {
    result.status = "WARNING";
    result.severity = "WARNING";
  } else {
    result.status = "PASSED";
    result.severity = "INFO";
  }
  if (!VALIDATION_STATUSES.includes(result.status)) result.status = "PASSED";
  return result;
}

export function mergeValidationResults(...results) {
  const findings = results.flatMap((result) => (result && Array.isArray(result.findings) ? result.findings : []));
  return summarizeValidation(findings);
}

export function findingFromError(error, level = "ENTERPRISE") {
  return finding({
    level,
    severity: error && error.code && /_warning$/.test(error.code) ? "WARNING" : "ERROR",
    code: (error && error.code) || "validation_error",
    message: (error && error.message) || "Validation error",
    sourcePath: (error && error.details && error.details.source_path) || "",
  });
}

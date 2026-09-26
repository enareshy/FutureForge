// Data Governance & Quality integration (spec §54). Import does not re-implement
// a quality engine: it hands created/updated objects to the shared Data Quality
// service and records the resulting score on the job summary. When the quality
// gate is enabled the import fails if the aggregate score is below the configured
// minimum.
import { DataQuality } from "../data-governance/index.js";
import { qualityBlocked } from "./errors.js";

export function qualityGateEnabled(config) {
  return Boolean(config?.quality_gate_enabled);
}

export function evaluateImportedObjects(db, tenantId, { objectType, objectIds = [], actor = null, ip = null } = {}) {
  const unique = [...new Set((objectIds || []).filter((id) => id !== null && id !== undefined && id !== ""))];
  const results = [];
  for (const objectId of unique) {
    try {
      results.push(DataQuality.evaluate(db, { tenantId, objectType, objectId, actor, trigger: "import", ip }));
    } catch {
      // The object type may not be onboarded to data quality; that is not fatal.
    }
  }
  return summarizeQuality(results);
}

export function summarizeQuality(results = []) {
  const scores = results.map((result) => Number(result?.overall_score)).filter((value) => Number.isFinite(value));
  const score = scores.length ? Math.round(scores.reduce((total, value) => total + value, 0) / scores.length) : null;
  const failed = results.filter((result) => result?.evaluation_state === "FAILED").length;
  return { evaluated: results.length, score, failed, results };
}

export function assertQualityGate(summary, config) {
  if (!qualityGateEnabled(config) || summary?.score === null || summary?.score === undefined) return summary;
  const minimum = Number(config?.quality_min_score ?? 0);
  if (summary.score < minimum) throw qualityBlocked({ score: summary.score, minimum });
  return summary;
}

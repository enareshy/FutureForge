// Optional, configurable quality gate for archive and purge.
//
// When enabled, the lifecycle service consults the Data Governance & Quality
// engine's current result for an object and may block archiving objects whose
// quality status or score is too low. This is a configurable policy switch, not
// a hard-coded rule: both the gate and its thresholds are tenant configuration.
import { listConfig } from "./configuration.js";
import { getCurrentResultRow } from "../data-governance/results.js";

export function qualityGate(db, { tenantId, objectType, objectId, action = "ARCHIVE" } = {}) {
  const config = listConfig(db, tenantId);
  const enabled = Boolean(config.quality_gate_enabled) || (action === "ARCHIVE" && Boolean(config.archive_requires_quality));
  if (!enabled) {
    return { applicable: false, enabled: false, blocked: false, reasons: [], quality_status: null, overall_score: null };
  }
  let row = null;
  try {
    row = getCurrentResultRow(db, { tenantId, objectType, objectId });
  } catch {
    row = null;
  }
  if (!row) {
    return {
      applicable: true,
      enabled: true,
      blocked: false,
      evaluated: false,
      reasons: [{ code: "QUALITY_NOT_EVALUATED", severity: "WARNING", message: "No quality result is available for this object" }],
      quality_status: null,
      overall_score: null,
    };
  }
  const blockStatuses = (config.quality_block_statuses || []).map((s) => String(s).toUpperCase());
  const minScore = Number(config.quality_min_score);
  const reasons = [];
  const status = String(row.quality_status || "").toUpperCase();
  const score = Number(row.overall_score);
  if (blockStatuses.includes(status)) {
    reasons.push({ code: "QUALITY_GATE_BLOCKED", severity: "BLOCKED", message: `Quality status ${status} is blocked by policy`, details: { quality_status: status } });
  }
  if (Number.isFinite(minScore) && Number.isFinite(score) && score < minScore) {
    reasons.push({
      code: "QUALITY_GATE_BLOCKED",
      severity: "BLOCKED",
      message: `Quality score ${score} is below the configured minimum ${minScore}`,
      details: { overall_score: score, min_score: minScore },
    });
  }
  return {
    applicable: true,
    enabled: true,
    evaluated: true,
    blocked: reasons.length > 0,
    reasons,
    quality_status: status || null,
    overall_score: Number.isFinite(score) ? score : null,
    result_ref: row.result_ref || null,
  };
}

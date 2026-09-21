// Quality dimensions and the score computation.
//
// Five dimensions ship as defaults (completeness, validity, consistency,
// accuracy, uniqueness) but dimensions are rows, so an organization can add or
// reweight them. The score is a pure function of the per-dimension pass rate,
// the configured weights and the configured status bands.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  CONFIG_DEFAULTS,
  DEFAULT_DIMENSION_WEIGHTS,
  DEFAULT_STATUS_THRESHOLDS,
  DIMENSION_LABELS,
  QUALITY_DIMENSIONS,
  QUALITY_STATUSES,
} from "./constants.js";
import { invalidConfiguration } from "./errors.js";
import { normalizeText, parseJson } from "./validation.js";
import { publicDimension } from "./repository.js";
import { getConfig, scoringConfig } from "./configuration.js";

export { publicDimension };

export function ensureDefaultDimensions(db, tenantId) {
  let created = 0;
  QUALITY_DIMENSIONS.forEach((code, index) => {
    const existing = queryOne(db, "SELECT id FROM dg_dimensions WHERE tenant_id = ? AND code = ?", [Number(tenantId), code]);
    if (existing) return;
    const ts = nowIso();
    run(
      db,
      `INSERT INTO dg_dimensions (tenant_id, code, name, description, weight, display_order, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        Number(tenantId),
        code,
        DIMENSION_LABELS[code] || code,
        `Default quality dimension: ${code}`,
        DEFAULT_DIMENSION_WEIGHTS[code] ?? 1,
        index * 10,
        ts,
        ts,
      ]
    );
    created += 1;
  });
  return { created };
}

export function listDimensions(db, tenantId, { status } = {}) {
  const params = [Number(tenantId)];
  let sql = "SELECT * FROM dg_dimensions WHERE tenant_id = ?";
  if (status) {
    sql += " AND status = ?";
    params.push(String(status));
  }
  sql += " ORDER BY display_order, code";
  return queryAll(db, sql, params).map(publicDimension);
}

export function upsertDimension(db, tenantId, code, patch = {}, actor = null, ip = null) {
  const normalized = normalizeText(code).toLowerCase();
  const existing = queryOne(db, "SELECT * FROM dg_dimensions WHERE tenant_id = ? AND code = ?", [Number(tenantId), normalized]);
  const weight = patch.weight !== undefined ? Number(patch.weight) : existing?.weight ?? 1;
  if (!Number.isFinite(weight) || weight < 0) throw invalidConfiguration("Dimension weight must be a non-negative number");
  const ts = nowIso();
  if (existing) {
    run(db, "UPDATE dg_dimensions SET name = ?, description = ?, weight = ?, display_order = ?, status = ?, updated_at = ? WHERE id = ?", [
      normalizeText(patch.name, existing.name),
      normalizeText(patch.description, existing.description),
      weight,
      patch.display_order !== undefined ? Number(patch.display_order) : existing.display_order,
      normalizeText(patch.status, existing.status).toLowerCase() === "inactive" ? "inactive" : "active",
      ts,
      existing.id,
    ]);
  } else {
    run(
      db,
      `INSERT INTO dg_dimensions (tenant_id, code, name, description, weight, display_order, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [Number(tenantId), normalized, normalizeText(patch.name, DIMENSION_LABELS[normalized] || normalized), normalizeText(patch.description), weight, Number(patch.display_order ?? 100), ts, ts]
    );
  }
  writeAudit(db, {
    actor,
    action: "data_governance.dimension.upsert",
    resourceType: "dg_dimension",
    resourceId: normalized,
    details: { code: normalized, weight },
    ip,
  });
  return publicDimension(queryOne(db, "SELECT * FROM dg_dimensions WHERE tenant_id = ? AND code = ?", [Number(tenantId), normalized]));
}

// Maps a numeric score to a configurable status band. Thresholds are sorted
// descending by `min`, so the first band the score clears wins.
export function statusForScore(score, thresholds = DEFAULT_STATUS_THRESHOLDS) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return "UNKNOWN";
  const sorted = [...(thresholds || DEFAULT_STATUS_THRESHOLDS)].sort((a, b) => Number(b.min) - Number(a.min));
  const value = Number(score);
  for (const band of sorted) {
    if (value >= Number(band.min)) return band.status;
  }
  return "CRITICAL";
}

// Aggregates per-dimension results into an overall score.
//
// `dimensions` is a map of dimension code -> { total, passed }. Only dimensions
// that actually had rules evaluated contribute; when no rules ran the score is
// null and the status is UNKNOWN (never silently shown as a pass).
export function computeScore(result, { tenantId = null, db = null, weights = null, thresholds = null, strategy = null } = {}) {
  const dimensionResults = result.dimensions || {};
  const dimensionScores = {};
  let weightedSum = 0;
  let weightTotal = 0;
  let totalRules = 0;
  let totalPassed = 0;

  const weightMap = weights || (db ? getConfig(db, tenantId, "dimension_weights") : DEFAULT_DIMENSION_WEIGHTS) || {};
  const bands = thresholds || (db ? getConfig(db, tenantId, "status_thresholds") : DEFAULT_STATUS_THRESHOLDS);
  const scoringStrategy = strategy || (db ? getConfig(db, tenantId, "scoring_strategy") : CONFIG_DEFAULTS.scoring_strategy);

  for (const [dimension, entry] of Object.entries(dimensionResults)) {
    const total = Number(entry.total) || 0;
    const passed = Number(entry.passed) || 0;
    totalRules += total;
    totalPassed += passed;
    if (total === 0) {
      dimensionScores[dimension] = { total: 0, passed: 0, rate: null, score: null };
      continue;
    }
    const rate = passed / total;
    const score = Math.round(rate * 10000) / 100;
    dimensionScores[dimension] = { total, passed, failed: total - passed, rate: Math.round(rate * 10000) / 10000, score };
    const weight = Number(weightMap[dimension] ?? 1);
    if (weight > 0) {
      weightedSum += score * weight;
      weightTotal += weight;
    }
  }

  let overall = null;
  if (totalRules > 0) {
    if (scoringStrategy === "simple_average") {
      const dims = Object.values(dimensionScores).filter((entry) => entry.score !== null);
      overall = dims.length ? Math.round((dims.reduce((sum, entry) => sum + entry.score, 0) / dims.length) * 100) / 100 : null;
    } else if (weightTotal > 0) {
      overall = Math.round((weightedSum / weightTotal) * 100) / 100;
    } else {
      overall = Math.round((totalPassed / totalRules) * 10000) / 100;
    }
  }

  return {
    overall_score: overall,
    quality_status: overall === null ? "UNKNOWN" : statusForScore(overall, bands),
    dimensions: dimensionScores,
    rule_count: totalRules,
    violation_count: totalRules - totalPassed,
    scoring_strategy: scoringStrategy,
  };
}

export function validStatuses() {
  return [...QUALITY_STATUSES];
}

export { QUALITY_DIMENSIONS, DIMENSION_LABELS, DEFAULT_STATUS_THRESHOLDS, DEFAULT_DIMENSION_WEIGHTS, getConfig, scoringConfig, parseJson };

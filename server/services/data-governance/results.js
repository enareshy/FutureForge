// Read model for quality results, violations, scores and dashboards. Every
// query is tenant scoped so an aggregate can never leak another tenant's data.
import { queryAll, queryOne } from "../../db.js";
import { resultNotFound } from "./errors.js";
import { paginate } from "./validation.js";
import { publicResult, publicViolation } from "./repository.js";

export { publicResult, publicViolation };

function evaluationState(row, violationCount) {
  if (!row) return "UNKNOWN";
  if (Number(row.rule_count) === 0) return "NOT_EVALUATED";
  return Number(violationCount ?? row.violation_count) > 0 ? "FAILED" : "PASSED";
}

export function getCurrentResultRow(db, { tenantId, objectType, objectId }) {
  return queryOne(
    db,
    `SELECT * FROM dg_quality_results WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND is_current = 1 ORDER BY id DESC LIMIT 1`,
    [Number(tenantId), String(objectType), String(objectId)]
  );
}

export function getResult(db, { tenantId, objectType, objectId, includeViolations = true }) {
  const row = getCurrentResultRow(db, { tenantId, objectType, objectId });
  if (!row) throw resultNotFound(objectType, objectId);
  const currentViolations = queryAll(
    db,
    `SELECT * FROM dg_quality_violations WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND is_current = 1 ORDER BY severity DESC, rule_code`,
    [Number(tenantId), String(objectType), String(objectId)]
  );
  return {
    ...publicResult(row),
    evaluation_state: evaluationState(row, currentViolations.length),
    ...(includeViolations ? { violations: currentViolations.map(publicViolation) } : {}),
  };
}

export function listResults(db, { tenantId, objectType, domainId, qualityStatus, minScore, maxScore, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?", "is_current = 1"];
  const params = [Number(tenantId)];
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(String(objectType).toLowerCase());
  }
  if (domainId) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  if (qualityStatus) {
    clauses.push("quality_status = ?");
    params.push(String(qualityStatus).toUpperCase());
  }
  if (minScore !== undefined) {
    clauses.push("overall_score >= ?");
    params.push(Number(minScore));
  }
  if (maxScore !== undefined) {
    clauses.push("overall_score <= ?");
    params.push(Number(maxScore));
  }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    clauses.push("(LOWER(object_type) LIKE ? OR LOWER(object_id) LIKE ? OR LOWER(object_name) LIKE ?)");
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dg_quality_results ${where}`, params)?.c ?? 0);
  const rows = queryAll(db, `SELECT * FROM dg_quality_results ${where} ORDER BY evaluated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return {
    items: rows.map((row) => ({ ...publicResult(row), evaluation_state: evaluationState(row) })),
    total,
    page: currentPage,
    page_size: limit,
  };
}

export function listViolations(db, { tenantId, objectType, objectId, dimension, severity, ruleCode, domainId, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?", "is_current = 1"];
  const params = [Number(tenantId)];
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(String(objectType).toLowerCase());
  }
  if (objectId) {
    clauses.push("object_id = ?");
    params.push(String(objectId));
  }
  if (dimension) {
    clauses.push("dimension = ?");
    params.push(String(dimension).toLowerCase());
  }
  if (severity) {
    clauses.push("severity = ?");
    params.push(String(severity).toLowerCase());
  }
  if (ruleCode) {
    clauses.push("rule_code = ?");
    params.push(String(ruleCode).toUpperCase());
  }
  if (domainId) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dg_quality_violations ${where}`, params)?.c ?? 0);
  const rows = queryAll(db, `SELECT * FROM dg_quality_violations ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicViolation), total, page: currentPage, page_size: limit };
}

export function objectHistory(db, { tenantId, objectType, objectId, limit = 50 } = {}) {
  const rows = queryAll(
    db,
    `SELECT * FROM dg_quality_results WHERE tenant_id = ? AND object_type = ? AND object_id = ? ORDER BY evaluated_at DESC LIMIT ?`,
    [Number(tenantId), String(objectType), String(objectId), Number(limit) || 50]
  );
  return rows.map((row) => ({ ...publicResult(row), evaluation_state: evaluationState(row) }));
}

function distribution(db, where, params) {
  const rows = queryAll(db, `SELECT quality_status, COUNT(*) AS c, AVG(overall_score) AS avg_score FROM dg_quality_results ${where} GROUP BY quality_status`, params);
  const byStatus = {};
  let total = 0;
  let weighted = 0;
  for (const row of rows) {
    const count = Number(row.c);
    total += count;
    weighted += (row.avg_score || 0) * count;
    byStatus[row.quality_status] = count;
  }
  return { total, average_score: total ? Math.round((weighted / total) * 100) / 100 : null, by_status: byStatus };
}

export function scoreSummary(db, { tenantId } = {}) {
  const base = "WHERE tenant_id = ? AND is_current = 1";
  const params = [Number(tenantId)];
  const summary = distribution(db, base, params);
  const objects = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dg_quality_results ${base}`, params)?.c ?? 0);
  const dimensionRows = queryAll(
    db,
    `SELECT dimensions_json FROM dg_quality_results ${base}`,
    params
  );
  const dimensions = {};
  for (const row of dimensionRows) {
    let parsed = {};
    try {
      parsed = JSON.parse(row.dimensions_json || "{}");
    } catch {
      parsed = {};
    }
    for (const [dimension, entry] of Object.entries(parsed)) {
      if (entry?.score === null || entry?.score === undefined) continue;
      const bucket = dimensions[dimension] || { total: 0, sum: 0 };
      bucket.total += 1;
      bucket.sum += entry.score;
      dimensions[dimension] = bucket;
    }
  }
  const dimensionScores = {};
  for (const [dimension, bucket] of Object.entries(dimensions)) {
    dimensionScores[dimension] = bucket.total ? Math.round((bucket.sum / bucket.total) * 100) / 100 : null;
  }
  return { objects, ...summary, dimension_scores: dimensionScores };
}

export function domainScores(db, { tenantId, domainId } = {}) {
  const clauses = ["tenant_id = ?", "is_current = 1"];
  const params = [Number(tenantId)];
  if (domainId) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const rows = queryAll(
    db,
    `SELECT domain_id, quality_status, COUNT(*) AS c, AVG(overall_score) AS avg_score
       FROM dg_quality_results ${where} GROUP BY domain_id, quality_status`,
    params
  );
  const byDomain = new Map();
  for (const row of rows) {
    const key = row.domain_id ?? 0;
    const entry = byDomain.get(key) || { domain_id: row.domain_id ?? null, total: 0, weighted: 0, by_status: {} };
    entry.total += Number(row.c);
    entry.weighted += (row.avg_score || 0) * Number(row.c);
    entry.by_status[row.quality_status] = Number(row.c);
    byDomain.set(key, entry);
  }
  return [...byDomain.values()].map((entry) => ({
    domain_id: entry.domain_id,
    objects: entry.total,
    average_score: entry.total ? Math.round((entry.weighted / entry.total) * 100) / 100 : null,
    by_status: entry.by_status,
  }));
}

export function typeScores(db, { tenantId, objectType } = {}) {
  const clauses = ["tenant_id = ?", "is_current = 1"];
  const params = [Number(tenantId)];
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(String(objectType).toLowerCase());
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const rows = queryAll(
    db,
    `SELECT object_type, quality_status, COUNT(*) AS c, AVG(overall_score) AS avg_score
       FROM dg_quality_results ${where} GROUP BY object_type, quality_status`,
    params
  );
  const byType = new Map();
  for (const row of rows) {
    const entry = byType.get(row.object_type) || { object_type: row.object_type, total: 0, weighted: 0, by_status: {} };
    entry.total += Number(row.c);
    entry.weighted += (row.avg_score || 0) * Number(row.c);
    entry.by_status[row.quality_status] = Number(row.c);
    byType.set(row.object_type, entry);
  }
  return [...byType.values()].map((entry) => ({
    object_type: entry.object_type,
    objects: entry.total,
    average_score: entry.total ? Math.round((entry.weighted / entry.total) * 100) / 100 : null,
    by_status: entry.by_status,
  }));
}

export function trend(db, { tenantId, objectType = null, days = 30 } = {}) {
  const clauses = ["tenant_id = ?", `evaluated_at >= datetime('now', ?)`];
  const params = [Number(tenantId), `-${Number(days) || 30} days`];
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(String(objectType).toLowerCase());
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  return queryAll(
    db,
    `SELECT substr(evaluated_at, 1, 10) AS day, COUNT(*) AS evaluations, AVG(overall_score) AS average_score,
            SUM(CASE WHEN violation_count > 0 THEN 1 ELSE 0 END) AS failed
       FROM dg_quality_results ${where} GROUP BY day ORDER BY day`,
    params
  );
}

// Deterministic, explainable assessments for the built-in predictive use cases
// (Stage 10).
//
// Every function here is a RULE-BASED assessment. Nothing in this file trains or
// runs an ML model, and nothing fabricates a probability: the reported value is a
// transparent weighted score derived from authoritative records, and the
// uncertainty field states explicitly that it is not a calibrated probability
// (prompt §7.3). When the inputs required for a use case are genuinely absent the
// assessment reports INSUFFICIENT_DATA together with the dataset requirements
// needed to enable a real model later (prompt §7.3).
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { impactOf, impactOfAsync } from "../objects.js";
import { parseObject } from "../data-lifecycle/validation.js";
import { METHODS, RISK_CATEGORIES, DATASET_REQUIREMENTS, SOURCE_MODULE } from "./constants.js";

const ACTIVE_ISSUE_STATUSES = ["OPEN", "INVESTIGATING", "CONTAINED"];
const OPEN_ACTION_STATUSES = ["OPEN", "IN_PROGRESS"];

function riskFromScore(score, { high, critical }) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return "UNKNOWN";
  const value = Number(score);
  if (value >= critical) return "CRITICAL";
  if (value >= high) return "HIGH";
  if (value >= high * 0.5) return "MEDIUM";
  return "LOW";
}

function evidence(source, detail, value) {
  return { source, detail, value };
}

function notAvailable(missing, datasetRequirements) {
  return {
    available: false,
    score: null,
    risk_category: "UNKNOWN",
    features: {},
    evidence: [],
    explanation: `Insufficient data to assess this subject: ${missing.join(", ")}.`,
    limitations: missing,
    dataset_requirements: datasetRequirements,
    uncertainty: { kind: "NOT_EVALUATED", statement: "No assessment was produced because required inputs are unavailable." },
  };
}

// ── A. Engineering change risk ───────────────────────────────────────────────

function collectChangeRisk(db, tenant, subject, thresholds) {
  const change = subject.row;
  const orders = queryAll(db, "SELECT id, order_number, status FROM change_orders WHERE tenant_id = ? AND change_request_id = ?", [tenant, Number(change.id)]);
  const orderIds = orders.map((row) => Number(row.id));
  let affected = [];
  if (orderIds.length) {
    const marks = orderIds.map(() => "?").join(",");
    affected = queryAll(db, `SELECT object_type, object_id, disposition FROM change_affected_items WHERE tenant_id = ? AND change_order_id IN (${marks})`, [tenant, ...orderIds]);
  }
  const linkedObjectId = change.object_id != null ? Number(change.object_id) : null;
  const impacted = new Set();
  let dependencyDepth = 0;
  let impactAvailable = false;
  const impactRoots = [];
  if (linkedObjectId) impactRoots.push(linkedObjectId);
  for (const item of affected) {
    const id = Number(item.object_id);
    if (Number.isInteger(id)) impactRoots.push(id);
  }
  for (const root of [...new Set(impactRoots)]) {
    try {
      const analysis = impactOf(db, root, tenant, { depth: 5 });
      impactAvailable = true;
      for (const node of analysis.impacted) {
        impacted.add(Number(node.id));
        dependencyDepth = Math.max(dependencyDepth, Number(node.depth) || 0);
      }
    } catch {
      // Not an Object-framework row; skip rather than inventing impact.
    }
  }

  const impactedIds = [...impacted].filter((id) => Number.isInteger(id));
  let openQuality = 0;
  let openCritical = 0;
  const issueMarks = ACTIVE_ISSUE_STATUSES.map(() => "?").join(",");
  if (impactedIds.length) {
    const marks = impactedIds.map(() => "?").join(",");
    openQuality = Number(
      queryOne(
        db,
        `SELECT COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? AND status IN (${issueMarks}) AND (product_object_id IN (${marks}) OR component_object_id IN (${marks}) OR operation_object_id IN (${marks}))`,
        [tenant, ...ACTIVE_ISSUE_STATUSES, ...impactedIds, ...impactedIds, ...impactedIds]
      )?.c || 0
    );
    openCritical = Number(
      queryOne(
        db,
        `SELECT COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? AND severity = 'CRITICAL' AND status IN (${issueMarks}) AND (product_object_id IN (${marks}) OR component_object_id IN (${marks}) OR operation_object_id IN (${marks}))`,
        [tenant, ...ACTIVE_ISSUE_STATUSES, ...impactedIds, ...impactedIds, ...impactedIds]
      )?.c || 0
    );
  }

  // Only the latest evaluation per subject counts: a subject that failed and was
  // later re-evaluated must not keep contributing its superseded failure.
  const failedReadiness = impactedIds.length
    ? Number(
        queryOne(
          db,
          `SELECT COUNT(*) AS c FROM quality_readiness_evaluations q
            WHERE q.tenant_id = ? AND q.overall_result IN ('FAIL','WARNING')
              AND q.subject_object_id IN (${impactedIds.map(() => "?").join(",")})
              AND q.id = (
                SELECT MAX(latest.id) FROM quality_readiness_evaluations latest
                 WHERE latest.tenant_id = q.tenant_id AND latest.subject_object_id = q.subject_object_id
              )`,
          [tenant, ...impactedIds]
        )?.c || 0
      )
    : 0;

  const affectedCount = affected.length;
  const impactedCount = impactedIds.length;
  const priority = String(change.priority || "NORMAL").toUpperCase();
  const priorityWeight = { LOW: 0, NORMAL: 5, HIGH: 15, URGENT: 25 }[priority] ?? 5;

  if (!impactAvailable && affectedCount === 0) {
    return notAvailable(
      ["no affected items or resolvable dependency graph for this change"],
      [DATASET_REQUIREMENTS.ML_MIN_LABELLED_OUTCOMES, DATASET_REQUIREMENTS.ML_BASELINE]
    );
  }

  const score = Math.min(
    100,
    priorityWeight +
      Math.min(25, affectedCount * 5) +
      Math.min(25, impactedCount * 2) +
      Math.min(20, openQuality * 5) +
      Math.min(20, openCritical * 10) +
      Math.min(15, failedReadiness * 5) +
      Math.min(10, dependencyDepth * 2)
  );

  return {
    available: true,
    score,
    risk_category: riskFromScore(score, thresholds),
    features: {
      change_priority: priority,
      affected_items: affectedCount,
      impacted_objects: impactedCount,
      dependency_depth: dependencyDepth,
      open_quality_issues: openQuality,
      open_critical_issues: openCritical,
      failed_readiness: failedReadiness,
    },
    evidence: [
      evidence("change_requests", `change priority ${priority}`, priorityWeight),
      evidence("change_affected_items", `${affectedCount} affected item(s)`, affectedCount),
      evidence("objects.impact", `${impactedCount} impacted downstream object(s)`, impactedCount),
      evidence("quality_issues", `${openQuality} open issue(s) on impacted objects`, openQuality),
      evidence("quality_readiness_evaluations", `${failedReadiness} failing/warning readiness evaluation(s)`, failedReadiness),
    ],
    explanation:
      `Rule-based change risk ${score}/100 (${riskFromScore(score, thresholds)}). ` +
      `Derived from change priority (${priority}), ${affectedCount} affected item(s), ${impactedCount} impacted object(s) at depth ${dependencyDepth}, ` +
      `${openQuality} open quality issue(s) (${openCritical} critical) and ${failedReadiness} failing readiness evaluation(s).`,
    limitations: impactAvailable ? [] : ["Dependency graph unavailable for some affected items; impact breadth may be understated."],
    dataset_requirements: [],
    uncertainty: {
      kind: "RULE_BASED_SCORE",
      statement: "Deterministic weighted score, not a calibrated probability. No ML model has been validated for this use case.",
    },
  };
}

// ── B. Manufacturing readiness risk ─────────────────────────────────────────

function productBomRevisions(db, tenant, productObjectId, bomType) {
  if (!productObjectId) return [];
  return queryAll(
    db,
    `SELECT r.id, r.revision_number, r.status, h.bom_type
       FROM bom_headers h JOIN bom_revisions r ON r.bom_id = h.id
      WHERE h.tenant_id = ? AND h.owner_object_id = ? AND h.bom_type = ?`,
    [tenant, Number(productObjectId), bomType]
  );
}

function collectManufacturingReadinessRisk(db, tenant, subject, thresholds) {
  const productObjectId = subject.subject_type === "PRODUCT_REVISION" ? subject.row.id : null;
  if (!productObjectId) {
    return notAvailable(["a product revision subject is required for manufacturing readiness risk"], [DATASET_REQUIREMENTS.ML_MIN_LABELLED_OUTCOMES]);
  }
  const mboms = productBomRevisions(db, tenant, productObjectId, "MBOM");
  const bops = productBomRevisions(db, tenant, productObjectId, "BOP");
  const bopIds = bops.map((row) => Number(row.id));
  let operations = [];
  if (bopIds.length) {
    operations = queryAll(
      db,
      `SELECT DISTINCT child_object_id AS operation_object_id FROM bom_lines
        WHERE tenant_id = ? AND bom_revision_id IN (${bopIds.map(() => "?").join(",")})
          AND child_object_type = 'operation' AND child_object_id IS NOT NULL AND child_object_id != ''`,
      [tenant, ...bopIds]
    );
  }
  const operationIds = operations.map((row) => String(row.operation_object_id));
  let documented = 0;
  if (operationIds.length) {
    documented = Number(
      queryOne(
        db,
        `SELECT COUNT(DISTINCT object_id) AS c FROM content_associations
          WHERE tenant_id = ? AND object_type = 'operation' AND status = 'active' AND object_id IN (${operationIds.map(() => "?").join(",")})`,
        [tenant, ...operationIds]
      )?.c || 0
    );
  }
  const openCritical = Number(
    queryOne(
      db,
      `SELECT COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? AND product_object_id = ? AND severity IN ('CRITICAL','HIGH') AND status IN (${ACTIVE_ISSUE_STATUSES.map(() => "?").join(",")})`,
      [tenant, Number(productObjectId), ...ACTIVE_ISSUE_STATUSES]
    )?.c || 0
  );

  const missingOperations = operationIds.length === 0;
  const undocumented = Math.max(0, operationIds.length - documented);
  const score = Math.min(
    100,
    (mboms.length ? 0 : 30) +
      (bops.length ? 0 : 25) +
      (missingOperations ? 20 : 0) +
      Math.min(15, undocumented * 5) +
      Math.min(20, openCritical * 10)
  );

  return {
    available: true,
    score,
    risk_category: riskFromScore(score, thresholds),
    features: {
      mbom_present: mboms.length > 0,
      bop_present: bops.length > 0,
      operations: operationIds.length,
      operations_with_work_instructions: documented,
      open_critical_issues: openCritical,
    },
    evidence: [
      evidence("bom_headers", mboms.length ? "manufacturing BOM present" : "no manufacturing BOM", mboms.length),
      evidence("bom_headers", bops.length ? "bill of process present" : "no bill of process", bops.length),
      evidence("bom_lines", `${operationIds.length} operation(s) in the bill of process`, operationIds.length),
      evidence("content_associations", `${documented}/${operationIds.length} operation(s) have a work instruction`, documented),
      evidence("quality_issues", `${openCritical} open critical/high issue(s)`, openCritical),
    ],
    explanation:
      `Rule-based manufacturing readiness risk ${score}/100 (${riskFromScore(score, thresholds)}). ` +
      `MBOM ${mboms.length ? "present" : "missing"}, BOP ${bops.length ? "present" : "missing"}, ${operationIds.length} operation(s) with ${undocumented} missing work instruction(s), ${openCritical} open critical/high quality issue(s).`,
    limitations: [],
    dataset_requirements: [],
    uncertainty: {
      kind: "RULE_BASED_SCORE",
      statement: "Deterministic weighted score derived from authoritative readiness inputs, not a calibrated probability.",
    },
  };
}

// ── C. Quality risk ─────────────────────────────────────────────────────────

function collectQualityRisk(db, tenant, subject, thresholds) {
  const productObjectId = subject.subject_type === "PRODUCT_REVISION" ? subject.row.id : null;
  const operationObjectId = subject.subject_type === "OPERATION" ? subject.row.id : null;
  if (!productObjectId && !operationObjectId) {
    return notAvailable(["a product revision or operation subject is required for quality risk"], [DATASET_REQUIREMENTS.ML_MIN_LABELLED_OUTCOMES]);
  }
  const scopeClause = productObjectId ? "product_object_id = ?" : "operation_object_id = ?";
  const scopeId = productObjectId || operationObjectId;
  const issueMarks = ACTIVE_ISSUE_STATUSES.map(() => "?").join(",");
  const openIssues = Number(queryOne(db, `SELECT COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? AND ${scopeClause} AND status IN (${issueMarks})`, [tenant, scopeId, ...ACTIVE_ISSUE_STATUSES])?.c || 0);
  const criticalIssues = Number(queryOne(db, `SELECT COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? AND ${scopeClause} AND severity = 'CRITICAL' AND status IN (${issueMarks})`, [tenant, scopeId, ...ACTIVE_ISSUE_STATUSES])?.c || 0);
  const failedInspections = Number(queryOne(db, `SELECT COUNT(*) AS c FROM quality_inspections WHERE tenant_id = ? AND ${scopeClause} AND status = 'FAILED'`, [tenant, scopeId])?.c || 0);
  const openActions = Number(
    queryOne(
      db,
      `SELECT COUNT(*) AS c FROM quality_corrective_actions a
         JOIN quality_issues i ON i.id = a.quality_issue_id AND i.tenant_id = a.tenant_id
        WHERE a.tenant_id = ? AND i.${scopeClause} AND a.status IN (${OPEN_ACTION_STATUSES.map(() => "?").join(",")})`,
      [tenant, scopeId, ...OPEN_ACTION_STATUSES]
    )?.c || 0
  );
  const historical = Number(queryOne(db, `SELECT COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? AND ${scopeClause}`, [tenant, scopeId])?.c || 0);

  if (historical === 0) {
    return notAvailable(
      ["no historical quality records exist for this subject"],
      [DATASET_REQUIREMENTS.ML_MIN_LABELLED_OUTCOMES, DATASET_REQUIREMENTS.ML_HOLDOUT, DATASET_REQUIREMENTS.ML_METRICS, DATASET_REQUIREMENTS.ML_CALIBRATION]
    );
  }

  const score = Math.min(100, Math.min(30, openIssues * 6) + Math.min(30, criticalIssues * 15) + Math.min(20, failedInspections * 8) + Math.min(20, openActions * 5));
  return {
    available: true,
    score,
    risk_category: riskFromScore(score, thresholds),
    features: {
      open_issues: openIssues,
      critical_issues: criticalIssues,
      failed_inspections: failedInspections,
      open_corrective_actions: openActions,
      historical_issues: historical,
    },
    evidence: [
      evidence("quality_issues", `${openIssues} open issue(s) (${criticalIssues} critical)`, openIssues),
      evidence("quality_inspections", `${failedInspections} failed inspection(s)`, failedInspections),
      evidence("quality_corrective_actions", `${openActions} open corrective action(s)`, openActions),
      evidence("quality_issues", `${historical} historical issue(s) recorded`, historical),
    ],
    explanation:
      `Rule-based quality risk ${score}/100 (${riskFromScore(score, thresholds)}). ` +
      `Based on ${historical} historical issue(s), ${openIssues} open (${criticalIssues} critical), ${failedInspections} failed inspection(s) and ${openActions} open corrective action(s).`,
    limitations: ["Rule-based weighting over observed records; not a trained predictive model."],
    dataset_requirements: [DATASET_REQUIREMENTS.ML_MIN_LABELLED_OUTCOMES, DATASET_REQUIREMENTS.ML_HOLDOUT],
    uncertainty: {
      kind: "RULE_BASED_SCORE",
      statement: "Deterministic weighted score, not a calibrated probability. ML requires labelled outcomes and a temporally separated holdout.",
    },
  };
}

// ── D. Delivery / schedule risk ─────────────────────────────────────────────

function collectScheduleRisk() {
  return notAvailable(
    ["no authoritative schedule, duration, dependency and historical outcome data is available"],
    [DATASET_REQUIREMENTS.SCHEDULE_DATA]
  );
}

const COLLECTORS = Object.freeze({
  ENGINEERING_CHANGE_RISK: collectChangeRisk,
  MANUFACTURING_READINESS_RISK: collectManufacturingReadinessRisk,
  QUALITY_RISK: collectQualityRisk,
  DELIVERY_SCHEDULE_RISK: collectScheduleRisk,
});

const ASYNC_COLLECTORS = Object.freeze({
  ENGINEERING_CHANGE_RISK: collectChangeRiskAsync,
  MANUFACTURING_READINESS_RISK: collectManufacturingReadinessRiskAsync,
  QUALITY_RISK: collectQualityRiskAsync,
  DELIVERY_SCHEDULE_RISK: async () => collectScheduleRisk(),
});

export function assessUseCase(db, tenant, useCaseCode, subject, thresholds) {
  const collector = COLLECTORS[useCaseCode];
  if (!collector) return notAvailable([`no rule-based assessment is registered for ${useCaseCode}`], []);
  return collector(db, tenant, subject, thresholds);
}

export async function assessUseCaseAsync(db, tenant, useCaseCode, subject, thresholds) {
  const collector = ASYNC_COLLECTORS[useCaseCode];
  if (!collector) return notAvailable([`no rule-based assessment is registered for ${useCaseCode}`], []);
  return collector(db, tenant, subject, thresholds);
}

// ── Async twins ─────────────────────────────────────────────────────────────

async function collectChangeRiskAsync(db, tenant, subject, thresholds) {
  const change = subject.row;
  const orders = await queryAllAsync(db, "SELECT id, order_number, status FROM change_orders WHERE tenant_id = ? AND change_request_id = ?", [tenant, Number(change.id)]);
  const orderIds = orders.map((row) => Number(row.id));
  let affected = [];
  if (orderIds.length) {
    const marks = orderIds.map(() => "?").join(",");
    affected = await queryAllAsync(db, `SELECT object_type, object_id, disposition FROM change_affected_items WHERE tenant_id = ? AND change_order_id IN (${marks})`, [tenant, ...orderIds]);
  }
  const linkedObjectId = change.object_id != null ? Number(change.object_id) : null;
  const impacted = new Set();
  let dependencyDepth = 0;
  let impactAvailable = false;
  const impactRoots = [];
  if (linkedObjectId) impactRoots.push(linkedObjectId);
  for (const item of affected) {
    const id = Number(item.object_id);
    if (Number.isInteger(id)) impactRoots.push(id);
  }
  for (const root of [...new Set(impactRoots)]) {
    try {
      const analysis = await impactOfAsync(db, root, tenant, { depth: 5 });
      impactAvailable = true;
      for (const node of analysis.impacted) {
        impacted.add(Number(node.id));
        dependencyDepth = Math.max(dependencyDepth, Number(node.depth) || 0);
      }
    } catch {
      // Not an Object-framework row; skip rather than inventing impact.
    }
  }
  const impactedIds = [...impacted].filter((id) => Number.isInteger(id));
  let openQuality = 0;
  let openCritical = 0;
  const issueMarks = ACTIVE_ISSUE_STATUSES.map(() => "?").join(",");
  if (impactedIds.length) {
    const marks = impactedIds.map(() => "?").join(",");
    openQuality = Number(
      (await queryOneAsync(
        db,
        `SELECT COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? AND status IN (${issueMarks}) AND (product_object_id IN (${marks}) OR component_object_id IN (${marks}) OR operation_object_id IN (${marks}))`,
        [tenant, ...ACTIVE_ISSUE_STATUSES, ...impactedIds, ...impactedIds, ...impactedIds]
      ))?.c || 0
    );
    openCritical = Number(
      (await queryOneAsync(
        db,
        `SELECT COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? AND severity = 'CRITICAL' AND status IN (${issueMarks}) AND (product_object_id IN (${marks}) OR component_object_id IN (${marks}) OR operation_object_id IN (${marks}))`,
        [tenant, ...ACTIVE_ISSUE_STATUSES, ...impactedIds, ...impactedIds, ...impactedIds]
      ))?.c || 0
    );
  }
  // Only the latest evaluation per subject counts (see the sync twin).
  const failedReadiness = impactedIds.length
    ? Number(
        (await queryOneAsync(
          db,
          `SELECT COUNT(*) AS c FROM quality_readiness_evaluations q
            WHERE q.tenant_id = ? AND q.overall_result IN ('FAIL','WARNING')
              AND q.subject_object_id IN (${impactedIds.map(() => "?").join(",")})
              AND q.id = (
                SELECT MAX(latest.id) FROM quality_readiness_evaluations latest
                 WHERE latest.tenant_id = q.tenant_id AND latest.subject_object_id = q.subject_object_id
              )`,
          [tenant, ...impactedIds]
        ))?.c || 0
      )
    : 0;
  const affectedCount = affected.length;
  const impactedCount = impactedIds.length;
  const priority = String(change.priority || "NORMAL").toUpperCase();
  const priorityWeight = { LOW: 0, NORMAL: 5, HIGH: 15, URGENT: 25 }[priority] ?? 5;
  if (!impactAvailable && affectedCount === 0) {
    return notAvailable(
      ["no affected items or resolvable dependency graph for this change"],
      [DATASET_REQUIREMENTS.ML_MIN_LABELLED_OUTCOMES, DATASET_REQUIREMENTS.ML_BASELINE]
    );
  }
  const score = Math.min(
    100,
    priorityWeight +
      Math.min(25, affectedCount * 5) +
      Math.min(25, impactedCount * 2) +
      Math.min(20, openQuality * 5) +
      Math.min(20, openCritical * 10) +
      Math.min(15, failedReadiness * 5) +
      Math.min(10, dependencyDepth * 2)
  );
  return {
    available: true,
    score,
    risk_category: riskFromScore(score, thresholds),
    features: {
      change_priority: priority,
      affected_items: affectedCount,
      impacted_objects: impactedCount,
      dependency_depth: dependencyDepth,
      open_quality_issues: openQuality,
      open_critical_issues: openCritical,
      failed_readiness: failedReadiness,
    },
    evidence: [
      evidence("change_requests", `change priority ${priority}`, priorityWeight),
      evidence("change_affected_items", `${affectedCount} affected item(s)`, affectedCount),
      evidence("objects.impact", `${impactedCount} impacted downstream object(s)`, impactedCount),
      evidence("quality_issues", `${openQuality} open issue(s) on impacted objects`, openQuality),
      evidence("quality_readiness_evaluations", `${failedReadiness} failing/warning readiness evaluation(s)`, failedReadiness),
    ],
    explanation:
      `Rule-based change risk ${score}/100 (${riskFromScore(score, thresholds)}). ` +
      `Derived from change priority (${priority}), ${affectedCount} affected item(s), ${impactedCount} impacted object(s) at depth ${dependencyDepth}, ` +
      `${openQuality} open quality issue(s) (${openCritical} critical) and ${failedReadiness} failing readiness evaluation(s).`,
    limitations: impactAvailable ? [] : ["Dependency graph unavailable for some affected items; impact breadth may be understated."],
    dataset_requirements: [],
    uncertainty: {
      kind: "RULE_BASED_SCORE",
      statement: "Deterministic weighted score, not a calibrated probability. No ML model has been validated for this use case.",
    },
  };
}

async function collectManufacturingReadinessRiskAsync(db, tenant, subject, thresholds) {
  const productObjectId = subject.subject_type === "PRODUCT_REVISION" ? subject.row.id : null;
  if (!productObjectId) {
    return notAvailable(["a product revision subject is required for manufacturing readiness risk"], [DATASET_REQUIREMENTS.ML_MIN_LABELLED_OUTCOMES]);
  }
  const productBoms = async (bomType) =>
    queryAllAsync(
      db,
      `SELECT r.id, r.revision_number, r.status, h.bom_type
         FROM bom_headers h JOIN bom_revisions r ON r.bom_id = h.id
        WHERE h.tenant_id = ? AND h.owner_object_id = ? AND h.bom_type = ?`,
      [tenant, Number(productObjectId), bomType]
    );
  const mboms = await productBoms("MBOM");
  const bops = await productBoms("BOP");
  const bopIds = bops.map((row) => Number(row.id));
  let operations = [];
  if (bopIds.length) {
    operations = await queryAllAsync(
      db,
      `SELECT DISTINCT child_object_id AS operation_object_id FROM bom_lines
        WHERE tenant_id = ? AND bom_revision_id IN (${bopIds.map(() => "?").join(",")})
          AND child_object_type = 'operation' AND child_object_id IS NOT NULL AND child_object_id != ''`,
      [tenant, ...bopIds]
    );
  }
  const operationIds = operations.map((row) => String(row.operation_object_id));
  let documented = 0;
  if (operationIds.length) {
    documented = Number(
      (await queryOneAsync(
        db,
        `SELECT COUNT(DISTINCT object_id) AS c FROM content_associations
          WHERE tenant_id = ? AND object_type = 'operation' AND status = 'active' AND object_id IN (${operationIds.map(() => "?").join(",")})`,
        [tenant, ...operationIds]
      ))?.c || 0
    );
  }
  const openCritical = Number(
    (await queryOneAsync(
      db,
      `SELECT COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? AND product_object_id = ? AND severity IN ('CRITICAL','HIGH') AND status IN (${ACTIVE_ISSUE_STATUSES.map(() => "?").join(",")})`,
      [tenant, Number(productObjectId), ...ACTIVE_ISSUE_STATUSES]
    ))?.c || 0
  );
  const missingOperations = operationIds.length === 0;
  const undocumented = Math.max(0, operationIds.length - documented);
  const score = Math.min(
    100,
    (mboms.length ? 0 : 30) + (bops.length ? 0 : 25) + (missingOperations ? 20 : 0) + Math.min(15, undocumented * 5) + Math.min(20, openCritical * 10)
  );
  return {
    available: true,
    score,
    risk_category: riskFromScore(score, thresholds),
    features: {
      mbom_present: mboms.length > 0,
      bop_present: bops.length > 0,
      operations: operationIds.length,
      operations_with_work_instructions: documented,
      open_critical_issues: openCritical,
    },
    evidence: [
      evidence("bom_headers", mboms.length ? "manufacturing BOM present" : "no manufacturing BOM", mboms.length),
      evidence("bom_headers", bops.length ? "bill of process present" : "no bill of process", bops.length),
      evidence("bom_lines", `${operationIds.length} operation(s) in the bill of process`, operationIds.length),
      evidence("content_associations", `${documented}/${operationIds.length} operation(s) have a work instruction`, documented),
      evidence("quality_issues", `${openCritical} open critical/high issue(s)`, openCritical),
    ],
    explanation:
      `Rule-based manufacturing readiness risk ${score}/100 (${riskFromScore(score, thresholds)}). ` +
      `MBOM ${mboms.length ? "present" : "missing"}, BOP ${bops.length ? "present" : "missing"}, ${operationIds.length} operation(s) with ${undocumented} missing work instruction(s), ${openCritical} open critical/high quality issue(s).`,
    limitations: [],
    dataset_requirements: [],
    uncertainty: {
      kind: "RULE_BASED_SCORE",
      statement: "Deterministic weighted score derived from authoritative readiness inputs, not a calibrated probability.",
    },
  };
}

async function collectQualityRiskAsync(db, tenant, subject, thresholds) {
  const productObjectId = subject.subject_type === "PRODUCT_REVISION" ? subject.row.id : null;
  const operationObjectId = subject.subject_type === "OPERATION" ? subject.row.id : null;
  if (!productObjectId && !operationObjectId) {
    return notAvailable(["a product revision or operation subject is required for quality risk"], [DATASET_REQUIREMENTS.ML_MIN_LABELLED_OUTCOMES]);
  }
  const scopeClause = productObjectId ? "product_object_id = ?" : "operation_object_id = ?";
  const scopeId = productObjectId || operationObjectId;
  const issueMarks = ACTIVE_ISSUE_STATUSES.map(() => "?").join(",");
  const openIssues = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? AND ${scopeClause} AND status IN (${issueMarks})`, [tenant, scopeId, ...ACTIVE_ISSUE_STATUSES]))?.c || 0);
  const criticalIssues = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? AND ${scopeClause} AND severity = 'CRITICAL' AND status IN (${issueMarks})`, [tenant, scopeId, ...ACTIVE_ISSUE_STATUSES]))?.c || 0);
  const failedInspections = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM quality_inspections WHERE tenant_id = ? AND ${scopeClause} AND status = 'FAILED'`, [tenant, scopeId]))?.c || 0);
  const openActions = Number(
    (await queryOneAsync(
      db,
      `SELECT COUNT(*) AS c FROM quality_corrective_actions a
         JOIN quality_issues i ON i.id = a.quality_issue_id AND i.tenant_id = a.tenant_id
        WHERE a.tenant_id = ? AND i.${scopeClause} AND a.status IN (${OPEN_ACTION_STATUSES.map(() => "?").join(",")})`,
      [tenant, scopeId, ...OPEN_ACTION_STATUSES]
    ))?.c || 0
  );
  const historical = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM quality_issues WHERE tenant_id = ? AND ${scopeClause}`, [tenant, scopeId]))?.c || 0);
  if (historical === 0) {
    return notAvailable(
      ["no historical quality records exist for this subject"],
      [DATASET_REQUIREMENTS.ML_MIN_LABELLED_OUTCOMES, DATASET_REQUIREMENTS.ML_HOLDOUT, DATASET_REQUIREMENTS.ML_METRICS, DATASET_REQUIREMENTS.ML_CALIBRATION]
    );
  }
  const score = Math.min(100, Math.min(30, openIssues * 6) + Math.min(30, criticalIssues * 15) + Math.min(20, failedInspections * 8) + Math.min(20, openActions * 5));
  return {
    available: true,
    score,
    risk_category: riskFromScore(score, thresholds),
    features: {
      open_issues: openIssues,
      critical_issues: criticalIssues,
      failed_inspections: failedInspections,
      open_corrective_actions: openActions,
      historical_issues: historical,
    },
    evidence: [
      evidence("quality_issues", `${openIssues} open issue(s) (${criticalIssues} critical)`, openIssues),
      evidence("quality_inspections", `${failedInspections} failed inspection(s)`, failedInspections),
      evidence("quality_corrective_actions", `${openActions} open corrective action(s)`, openActions),
      evidence("quality_issues", `${historical} historical issue(s) recorded`, historical),
    ],
    explanation:
      `Rule-based quality risk ${score}/100 (${riskFromScore(score, thresholds)}). ` +
      `Based on ${historical} historical issue(s), ${openIssues} open (${criticalIssues} critical), ${failedInspections} failed inspection(s) and ${openActions} open corrective action(s).`,
    limitations: ["Rule-based weighting over observed records; not a trained predictive model."],
    dataset_requirements: [DATASET_REQUIREMENTS.ML_MIN_LABELLED_OUTCOMES, DATASET_REQUIREMENTS.ML_HOLDOUT],
    uncertainty: {
      kind: "RULE_BASED_SCORE",
      statement: "Deterministic weighted score, not a calibrated probability. ML requires labelled outcomes and a temporally separated holdout.",
    },
  };
}

export function assessmentMeta() {
  return {
    source_module: SOURCE_MODULE,
    method: METHODS.RULE_BASED,
    risk_categories: [...RISK_CATEGORIES],
    use_case_codes: Object.keys(COLLECTORS),
    dataset_requirements: { ...DATASET_REQUIREMENTS },
  };
}

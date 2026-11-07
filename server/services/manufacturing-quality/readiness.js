// Deterministic release-readiness evaluation (Stage 9).
//
// Readiness is a projection, never a second source of truth: every check reads
// the authoritative owning module (Object framework, BOM engine, Content,
// Workflow approvals, this layer's own quality records). A check whose inputs
// cannot be obtained reports NOT_EVALUATED instead of silently passing, and a
// failed evaluation never mutates the subject it assesses (prompt §6.3/§6.4).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { updateRow, updateRowAsync } from "../requirements/sql.js";
import { normalizeText, normalizeUpper, paginate, parseObject, parseArray, toNumber } from "../data-lifecycle/validation.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { publishManufacturingQualityEvent, publishManufacturingQualityEventAsync } from "./events.js";
import { getConfig, getConfigAsync } from "./configuration.js";
import { resolveSubject, resolveSubjectAsync } from "./subjects.js";
import {
  SOURCE_MODULE,
  SUBJECT_TYPES,
  READINESS_CHECKS,
  READINESS_CHECK_CODES,
  READINESS_RESULTS,
  READINESS_DIMENSIONS,
  ACTIVE_ISSUE_STATUSES,
  OPEN_ACTION_STATUSES,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
} from "./constants.js";
import { mqNotFound, invalidMq } from "./errors.js";
import { evaluationRef } from "./refs.js";

const CHECK_BY_CODE = Object.freeze(Object.fromEntries(READINESS_CHECKS.map((check) => [check.code, check])));
const SEVERITY_WEIGHT = Object.freeze({ CRITICAL: 4, ERROR: 3, WARNING: 2, INFO: 1 });
const BLOCKING_SEVERITIES = new Set(["CRITICAL", "ERROR"]);

export function publicEvaluation(row) {
  if (!row) return null;
  return {
    id: row.id,
    evaluation_ref: row.evaluation_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    subject_type: row.subject_type,
    subject_object_id: row.subject_object_id ?? null,
    subject_revision: row.subject_revision || "",
    subject_ref: row.subject_ref || "",
    profile_code: row.profile_code,
    overall_result: row.overall_result,
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    threshold: row.threshold === null || row.threshold === undefined ? null : Number(row.threshold),
    checks: parseArray(row.checks_json, []),
    source_versions: parseObject(row.source_versions_json, {}),
    stale: Boolean(Number(row.stale || 0)),
    stale_reason: row.stale_reason || "",
    ruleset_version: row.ruleset_version || "",
    evaluated_by: row.evaluated_by ?? null,
    evaluated_at: row.evaluated_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function result(code, passed, { severity = "INFO", message = "", details = null, evaluated = true } = {}) {
  return {
    code,
    severity,
    result: evaluated ? (passed ? "PASS" : "FAIL") : "NOT_EVALUATED",
    message,
    details,
  };
}

function getProductObjectId(db, subject) {
  switch (subject.subject_type) {
    case SUBJECT_TYPES.PRODUCT_REVISION:
    case SUBJECT_TYPES.OPERATION:
      return subject.row?.id ?? null;
    case SUBJECT_TYPES.MBOM_REVISION: {
      const owner = queryOne(db, "SELECT h.owner_object_id FROM bom_headers h JOIN bom_revisions r ON r.bom_id = h.id WHERE r.id = ?", [subject.row.id]);
      return owner?.owner_object_id ?? null;
    }
    default:
      return null;
  }
}

function releaseStatus(subject) {
  const row = subject.row || {};
  if (subject.subject_type === SUBJECT_TYPES.MBOM_REVISION) return row.status || "";
  return row.status || "";
}

function productBomRevisions(db, tenant, productObjectId, bomType) {
  return queryAll(
    db,
    `SELECT r.id, r.revision_number, r.status, r.version, h.bom_type
       FROM bom_headers h JOIN bom_revisions r ON r.bom_id = h.id
      WHERE h.tenant_id = ? AND h.owner_object_id = ? AND h.bom_type = ?`,
    [Number(tenant), Number(productObjectId), bomType]
  );
}

function operationsForBop(db, tenant, bopRevisionIds) {
  if (!bopRevisionIds.length) return [];
  const marks = bopRevisionIds.map(() => "?").join(",");
  return queryAll(
    db,
    `SELECT DISTINCT child_object_id AS operation_object_id
       FROM bom_lines
      WHERE tenant_id = ? AND bom_revision_id IN (${marks})
        AND child_object_type = 'operation' AND child_object_id IS NOT NULL AND child_object_id != ''`,
    [Number(tenant), ...bopRevisionIds.map(Number)]
  );
}

// ── Individual checks ───────────────────────────────────────────────────────

function checkProductRevisionPresent(db, tenant, ctx) {
  const present = Boolean(ctx.subject?.row);
  return result("PRODUCT_REVISION_PRESENT", present, {
    severity: "CRITICAL",
    message: present ? "Subject product revision resolved." : "Subject product revision could not be resolved.",
  });
}

function checkProductRevisionReleased(db, tenant, ctx) {
  const subject = ctx.subject;
  if (!subject?.row) {
    return result("PRODUCT_REVISION_RELEASED", false, { severity: "ERROR", evaluated: false, message: "No subject revision to assess." });
  }
  const strict = getConfig(db, tenant, "require_released_revision");
  if (!strict) {
    return result("PRODUCT_REVISION_RELEASED", true, { severity: "ERROR", message: "Release requirement disabled by configuration." });
  }
  const status = releaseStatus(subject);
  const released = status === "RELEASED" || status === "released";
  return result("PRODUCT_REVISION_RELEASED", released, {
    severity: "ERROR",
    message: released ? "Subject revision is released." : `Subject revision is ${status || "unknown"}, not released.`,
    details: { status },
  });
}

function checkBomStructurePresent(db, tenant, ctx) {
  if (!ctx.productObjectId) {
    return result("BOM_STRUCTURE_PRESENT", false, { severity: "ERROR", evaluated: false, message: "No product object is associated with this subject." });
  }
  const revisions = [...productBomRevisions(db, tenant, ctx.productObjectId, "EBOM"), ...productBomRevisions(db, tenant, ctx.productObjectId, "MBOM")];
  ctx.bomRevisionIds = revisions.map((r) => Number(r.id));
  const present = revisions.length > 0;
  return result("BOM_STRUCTURE_PRESENT", present, {
    severity: "ERROR",
    message: present ? "A BOM structure exists for the product." : "No EBOM or MBOM structure is linked to the product.",
    details: { revisions: revisions.length },
  });
}

function checkBomStructureValid(db, tenant, ctx) {
  if (!ctx.bomRevisionIds?.length) {
    return result("BOM_STRUCTURE_VALID", false, { severity: "ERROR", evaluated: false, message: "No BOM revision to validate." });
  }
  const marks = ctx.bomRevisionIds.map(() => "?").join(",");
  const rows = queryAll(
    db,
    `SELECT r.revision_id, r.status FROM bom_validation_results r
      WHERE r.tenant_id = ? AND r.revision_id IN (${marks})
      ORDER BY r.id DESC`,
    [Number(tenant), ...ctx.bomRevisionIds]
  );
  if (!rows.length) {
    return result("BOM_STRUCTURE_VALID", false, { severity: "ERROR", evaluated: false, message: "No BOM validation run has been recorded." });
  }
  const latestByRevision = new Map();
  for (const row of rows) if (!latestByRevision.has(row.revision_id)) latestByRevision.set(row.revision_id, row.status);
  const errored = [...latestByRevision.values()].filter((status) => status === "ERROR");
  return result("BOM_STRUCTURE_VALID", errored.length === 0, {
    severity: "ERROR",
    message: errored.length ? "The latest BOM validation reported errors." : "Latest BOM validation reports no errors.",
    details: { revisions_checked: latestByRevision.size, revisions_with_errors: errored.length },
  });
}

function checkMbomPresent(db, tenant, ctx) {
  if (!ctx.productObjectId) {
    return result("MBOM_PRESENT", false, { severity: "WARNING", evaluated: false, message: "No product object is associated with this subject." });
  }
  const mboms = productBomRevisions(db, tenant, ctx.productObjectId, "MBOM");
  ctx.mbomRevisionIds = mboms.map((r) => Number(r.id));
  return result("MBOM_PRESENT", mboms.length > 0, {
    severity: "WARNING",
    message: mboms.length ? "Manufacturing BOM present." : "No manufacturing BOM is linked to the product.",
    details: { revisions: mboms.length },
  });
}

function checkBopPresent(db, tenant, ctx) {
  if (!ctx.productObjectId) {
    return result("BOP_PRESENT", false, { severity: "WARNING", evaluated: false, message: "No product object is associated with this subject." });
  }
  const bops = productBomRevisions(db, tenant, ctx.productObjectId, "BOP");
  ctx.bopRevisionIds = bops.map((r) => Number(r.id));
  return result("BOP_PRESENT", bops.length > 0, {
    severity: "WARNING",
    message: bops.length ? "Bill of process present." : "No bill of process is linked to the product.",
    details: { revisions: bops.length },
  });
}

function checkOperationsPresent(db, tenant, ctx) {
  if (!ctx.bopRevisionIds?.length) {
    return result("OPERATIONS_PRESENT", false, { severity: "WARNING", evaluated: false, message: "No bill of process to inspect for operations." });
  }
  const operations = operationsForBop(db, tenant, ctx.bopRevisionIds);
  ctx.operationObjectIds = operations.map((row) => String(row.operation_object_id));
  return result("OPERATIONS_PRESENT", operations.length > 0, {
    severity: "WARNING",
    message: operations.length ? "The bill of process defines operations." : "The bill of process defines no operations.",
    details: { operations: operations.length },
  });
}

function checkWorkInstructions(db, tenant, ctx) {
  if (ctx.operationObjectIds === null || ctx.operationObjectIds === undefined) {
    return result("OPERATIONS_HAVE_WORK_INSTRUCTIONS", false, { severity: "WARNING", evaluated: false, message: "No operations to check." });
  }
  const required = getConfig(db, tenant, "require_work_instructions");
  if (!required) {
    return result("OPERATIONS_HAVE_WORK_INSTRUCTIONS", true, { severity: "WARNING", message: "Work-instruction requirement disabled by configuration." });
  }
  if (!ctx.operationObjectIds.length) {
    return result("OPERATIONS_HAVE_WORK_INSTRUCTIONS", false, { severity: "WARNING", evaluated: false, message: "No operations to check." });
  }
  const marks = ctx.operationObjectIds.map(() => "?").join(",");
  const rows = queryAll(
    db,
    `SELECT object_id, COUNT(*) AS c FROM content_associations
      WHERE tenant_id = ? AND object_type = 'operation' AND status = 'active'
        AND object_id IN (${marks})
      GROUP BY object_id`,
    [Number(tenant), ...ctx.operationObjectIds]
  );
  const documented = new Set(rows.map((row) => String(row.object_id)));
  const missing = ctx.operationObjectIds.filter((id) => !documented.has(id));
  return result("OPERATIONS_HAVE_WORK_INSTRUCTIONS", missing.length === 0, {
    severity: "WARNING",
    message: missing.length ? `${missing.length} operation(s) have no work instruction.` : "Every operation has a work instruction.",
    details: { operations: ctx.operationObjectIds.length, missing: missing.length },
  });
}

function checkOpenQualityIssues(db, tenant, ctx) {
  if (!ctx.productObjectId) {
    return result("OPEN_QUALITY_ISSUES", false, { severity: "ERROR", evaluated: false, message: "No product object is associated with this subject." });
  }
  const active = ACTIVE_ISSUE_STATUSES;
  const marks = active.map(() => "?").join(",");
  const row = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM quality_issues
      WHERE tenant_id = ? AND product_object_id = ? AND severity IN ('CRITICAL','HIGH') AND status IN (${marks})`,
    [Number(tenant), Number(ctx.productObjectId), ...active]
  );
  const blocking = Number(row?.c || 0);
  const enforced = getConfig(db, tenant, "block_on_critical_issues");
  if (!enforced && blocking > 0) {
    return result("OPEN_QUALITY_ISSUES", true, {
      severity: "ERROR",
      message: `${blocking} critical/high issue(s) open; blocking disabled by configuration.`,
      details: { open_critical_high: blocking, enforced: false },
    });
  }
  return result("OPEN_QUALITY_ISSUES", blocking === 0, {
    severity: "ERROR",
    message: blocking ? `${blocking} critical/high quality issue(s) remain open.` : "No critical/high quality issue is open.",
    details: { open_critical_high: blocking },
  });
}

function checkCorrectiveActions(db, tenant, ctx) {
  if (!ctx.productObjectId) {
    return result("CORRECTIVE_ACTIONS_COMPLETE", false, { severity: "WARNING", evaluated: false, message: "No product object is associated with this subject." });
  }
  const open = OPEN_ACTION_STATUSES;
  const marks = open.map(() => "?").join(",");
  const row = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM quality_corrective_actions a
       JOIN quality_issues i ON i.id = a.quality_issue_id AND i.tenant_id = a.tenant_id
      WHERE a.tenant_id = ? AND i.product_object_id = ? AND a.status IN (${marks})`,
    [Number(tenant), Number(ctx.productObjectId), ...open]
  );
  const openCount = Number(row?.c || 0);
  return result("CORRECTIVE_ACTIONS_COMPLETE", openCount === 0, {
    severity: "WARNING",
    message: openCount ? `${openCount} corrective action(s) are still open.` : "All corrective actions for linked issues are closed.",
    details: { open_actions: openCount },
  });
}

function checkInspectionsComplete(db, tenant, ctx) {
  if (!ctx.productObjectId) {
    return result("INSPECTIONS_COMPLETE", false, { severity: "WARNING", evaluated: false, message: "No product object is associated with this subject." });
  }
  const required = getConfig(db, tenant, "require_inspections");
  const rows = queryAll(db, "SELECT status FROM quality_inspections WHERE tenant_id = ? AND product_object_id = ?", [Number(tenant), Number(ctx.productObjectId)]);
  if (!rows.length) {
    return result("INSPECTIONS_COMPLETE", false, {
      severity: "WARNING",
      evaluated: false,
      message: "No inspections are recorded for this product.",
      details: { required: Boolean(required) },
    });
  }
  if (!required) {
    return result("INSPECTIONS_COMPLETE", true, { severity: "WARNING", message: "Inspection requirement disabled by configuration.", details: { inspections: rows.length } });
  }
  const pending = rows.filter((row) => row.status === "PLANNED" || row.status === "IN_PROGRESS");
  const failed = rows.filter((row) => row.status === "FAILED");
  const ok = pending.length === 0 && failed.length === 0;
  return result("INSPECTIONS_COMPLETE", ok, {
    severity: "WARNING",
    message: ok ? "All planned inspections have a passing or waived outcome." : `${pending.length} pending and ${failed.length} failed inspection(s).`,
    details: { pending: pending.length, failed: failed.length, total: rows.length },
  });
}

function checkRequiredApprovals(db, tenant, ctx) {
  if (!ctx.productObjectId) {
    return result("REQUIRED_APPROVALS", false, { severity: "ERROR", evaluated: false, message: "No product object is associated with this subject." });
  }
  const instances = queryAll(db, "SELECT id FROM workflow_instances WHERE tenant_id = ? AND object_id = ?", [Number(tenant), Number(ctx.productObjectId)]);
  if (!instances.length) {
    return result("REQUIRED_APPROVALS", false, { severity: "ERROR", evaluated: false, message: "No approval workflow instance is linked to the product." });
  }
  const marks = instances.map(() => "?").join(",");
  const row = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM workflow_approvals
      WHERE tenant_id = ? AND instance_id IN (${marks}) AND status IN ('pending','rejected','changes_requested')`,
    [Number(tenant), ...instances.map((instance) => Number(instance.id))]
  );
  const outstanding = Number(row?.c || 0);
  return result("REQUIRED_APPROVALS", outstanding === 0, {
    severity: "ERROR",
    message: outstanding ? `${outstanding} approval(s) are not approved.` : "Required approvals are recorded.",
    details: { outstanding },
  });
}

function checkDocumentCompleteness(db, tenant, ctx) {
  if (!ctx.productObjectId) {
    return result("DOCUMENT_COMPLETENESS", false, { severity: "INFO", evaluated: false, message: "No product object is associated with this subject." });
  }
  const ids = [String(ctx.productObjectId)];
  if (ctx.subject?.subject_type === SUBJECT_TYPES.MBOM_REVISION) ids.push(String(ctx.subject.row.id));
  const marks = ids.map(() => "?").join(",");
  const row = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM content_associations
      WHERE tenant_id = ? AND status = 'active' AND object_type IN ('product','pdm_revision','bom_revision') AND object_id IN (${marks})`,
    [Number(tenant), ...ids]
  );
  const count = Number(row?.c || 0);
  return result("DOCUMENT_COMPLETENESS", count > 0, {
    severity: "INFO",
    message: count ? `${count} document(s) are associated.` : "No specification document is associated with the product.",
    details: { documents: count },
  });
}

const CHECK_RUNNERS = Object.freeze({
  PRODUCT_REVISION_PRESENT: checkProductRevisionPresent,
  PRODUCT_REVISION_RELEASED: checkProductRevisionReleased,
  BOM_STRUCTURE_PRESENT: checkBomStructurePresent,
  BOM_STRUCTURE_VALID: checkBomStructureValid,
  MBOM_PRESENT: checkMbomPresent,
  BOP_PRESENT: checkBopPresent,
  OPERATIONS_PRESENT: checkOperationsPresent,
  OPERATIONS_HAVE_WORK_INSTRUCTIONS: checkWorkInstructions,
  OPEN_QUALITY_ISSUES: checkOpenQualityIssues,
  CORRECTIVE_ACTIONS_COMPLETE: checkCorrectiveActions,
  INSPECTIONS_COMPLETE: checkInspectionsComplete,
  REQUIRED_APPROVALS: checkRequiredApprovals,
  DOCUMENT_COMPLETENESS: checkDocumentCompleteness,
});

function enabledChecks(db, tenant) {
  const configured = String(getConfig(db, tenant, "readiness_checks") || "");
  const wanted = configured
    .split(",")
    .map((code) => normalizeUpper(code, { max: 64 }))
    .filter((code) => CHECK_BY_CODE[code]);
  return wanted.length ? wanted : [...READINESS_CHECK_CODES];
}

function scoreChecks(db, tenant, checks) {
  const threshold = Number(getConfig(db, tenant, "readiness_pass_threshold"));
  let earned = 0;
  let possible = 0;
  let blockingFailure = false;
  let notEvaluated = 0;
  for (const check of checks) {
    const weight = SEVERITY_WEIGHT[check.severity] || 1;
    if (check.result === "NOT_EVALUATED") {
      notEvaluated += 1;
      continue;
    }
    possible += weight;
    if (check.result === "PASS") earned += weight;
    if (check.result === "FAIL" && BLOCKING_SEVERITIES.has(check.severity)) blockingFailure = true;
  }
  const score = possible > 0 ? Math.round((earned / possible) * 10000) / 100 : null;
  let overall;
  if (blockingFailure) overall = "FAIL";
  else if (score === null) overall = "NOT_EVALUATED";
  else if (score >= threshold) overall = notEvaluated > 0 ? "WARNING" : "PASS";
  else overall = "FAIL";
  return { score, threshold, overall, not_evaluated: notEvaluated };
}

function dimensionView(checks) {
  return READINESS_DIMENSIONS.map((dimension) => {
    const members = checks.filter((check) => check.dimension === dimension.code);
    return {
      code: dimension.code,
      label: dimension.label,
      checks: members.length,
      failed: members.filter((check) => check.result === "FAIL").length,
      not_evaluated: members.filter((check) => check.result === "NOT_EVALUATED").length,
    };
  });
}

// ── Persistence ────────────────────────────────────────────────────────────

function evaluationFilters({ tenantId, subject_type, subject_ref, overall_result, stale } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (subject_type) {
    clauses.push("subject_type = ?");
    params.push(normalizeUpper(subject_type));
  }
  if (subject_ref) {
    clauses.push("subject_ref = ?");
    params.push(String(subject_ref));
  }
  if (overall_result) {
    clauses.push("overall_result = ?");
    params.push(normalizeUpper(overall_result));
  }
  if (stale !== undefined && stale !== null && stale !== "") {
    clauses.push("stale = ?");
    params.push(stale === true || stale === "true" || stale === "1" ? 1 : 0);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listReadinessEvaluations(db, opts = {}) {
  const { where, params } = evaluationFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM quality_readiness_evaluations ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM quality_readiness_evaluations ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicEvaluation), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listReadinessEvaluationsAsync(db, opts = {}) {
  const { where, params } = evaluationFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM quality_readiness_evaluations ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM quality_readiness_evaluations ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicEvaluation), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export function getEvaluationRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM quality_readiness_evaluations WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOne(db, "SELECT * FROM quality_readiness_evaluations WHERE tenant_id = ? AND evaluation_ref = ?", [Number(tenantId), String(ref)]);
}

export async function getEvaluationRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM quality_readiness_evaluations WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOneAsync(db, "SELECT * FROM quality_readiness_evaluations WHERE tenant_id = ? AND evaluation_ref = ?", [Number(tenantId), String(ref)]);
}

export function requireEvaluationRow(db, tenantId, ref) {
  const row = getEvaluationRow(db, tenantId, ref);
  if (!row) throw mqNotFound(ref);
  return row;
}

export async function requireEvaluationRowAsync(db, tenantId, ref) {
  const row = await getEvaluationRowAsync(db, tenantId, ref);
  if (!row) throw mqNotFound(ref);
  return row;
}

export function getReadinessEvaluation(db, tenantId, ref) {
  return publicEvaluation(getEvaluationRow(db, tenantId, ref));
}

export async function getReadinessEvaluationAsync(db, tenantId, ref) {
  return publicEvaluation(await getEvaluationRowAsync(db, tenantId, ref));
}

function buildContext(db, tenant, subjectType, ref) {
  const subject = resolveSubject(db, tenant, subjectType, ref);
  return {
    subject,
    productObjectId: getProductObjectId(db, subject),
    bomRevisionIds: [],
    mbomRevisionIds: [],
    bopRevisionIds: [],
    operationObjectIds: null,
  };
}

async function buildContextAsync(db, tenant, subjectType, ref) {
  const subject = await resolveSubjectAsync(db, tenant, subjectType, ref);
  let productObjectId = null;
  if (subject.subject_type === SUBJECT_TYPES.PRODUCT_REVISION || subject.subject_type === SUBJECT_TYPES.OPERATION) {
    productObjectId = subject.row?.id ?? null;
  } else if (subject.subject_type === SUBJECT_TYPES.MBOM_REVISION) {
    const owner = await queryOneAsync(db, "SELECT h.owner_object_id FROM bom_headers h JOIN bom_revisions r ON r.bom_id = h.id WHERE r.id = ?", [subject.row.id]);
    productObjectId = owner?.owner_object_id ?? null;
  }
  return { subject, productObjectId, bomRevisionIds: [], mbomRevisionIds: [], bopRevisionIds: [], operationObjectIds: null };
}

function sourceVersions(subject, ctx) {
  const versions = { subject_type: subject.subject_type, subject_ref: subject.ref, subject_revision: subject.revision || "" };
  if (ctx.productObjectId) versions.product_object_id = Number(ctx.productObjectId);
  if (ctx.bomRevisionIds?.length) versions.bom_revision_ids = [...ctx.bomRevisionIds];
  return versions;
}

function insertEvaluation(db, tenant, input) {
  const ts = nowIso();
  const ref = evaluationRef(`${subjectSlug(input.subject)}-${Date.now().toString(36)}`);
  const result2 = run(
    db,
    `INSERT INTO quality_readiness_evaluations
       (evaluation_ref, tenant_id, organization_id, subject_type, subject_object_id, subject_revision, subject_ref,
        profile_code, overall_result, score, threshold, checks_json, source_versions_json, stale, stale_reason,
        ruleset_version, evaluated_by, evaluated_at, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?, ?, ?, ?, ?, ?)`,
    [
      ref,
      tenant,
      input.organization_id,
      input.subject_type,
      input.subject_object_id,
      input.subject_revision,
      input.subject_ref,
      input.profile_code,
      input.overall_result,
      input.score,
      input.threshold,
      JSON.stringify(input.checks),
      JSON.stringify(input.source_versions),
      input.ruleset_version,
      input.actor_id,
      input.evaluated_at,
      input.actor_id,
      input.actor_id,
      ts,
      ts,
    ]
  );
  return queryOne(db, "SELECT * FROM quality_readiness_evaluations WHERE id = ?", [Number(result2.lastInsertId)]);
}

async function insertEvaluationAsync(db, tenant, input) {
  const ts = nowIso();
  const ref = evaluationRef(`${subjectSlug(input.subject)}-${Date.now().toString(36)}`);
  const result2 = await runAsync(
    db,
    `INSERT INTO quality_readiness_evaluations
       (evaluation_ref, tenant_id, organization_id, subject_type, subject_object_id, subject_revision, subject_ref,
        profile_code, overall_result, score, threshold, checks_json, source_versions_json, stale, stale_reason,
        ruleset_version, evaluated_by, evaluated_at, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?, ?, ?, ?, ?, ?)`,
    [
      ref,
      tenant,
      input.organization_id,
      input.subject_type,
      input.subject_object_id,
      input.subject_revision,
      input.subject_ref,
      input.profile_code,
      input.overall_result,
      input.score,
      input.threshold,
      JSON.stringify(input.checks),
      JSON.stringify(input.source_versions),
      input.ruleset_version,
      input.actor_id,
      input.evaluated_at,
      input.actor_id,
      input.actor_id,
      ts,
      ts,
    ]
  );
  return queryOneAsync(db, "SELECT * FROM quality_readiness_evaluations WHERE id = ?", [Number(result2.lastInsertId)]);
}

function subjectSlug(subject) {
  return `${subject.subject_type}-${subject.ref}`;
}

function runChecks(db, tenant, ctx) {
  const codes = enabledChecks(db, tenant);
  const checks = [];
  for (const code of codes) {
    const meta = CHECK_BY_CODE[code];
    const runner = CHECK_RUNNERS[code];
    if (!runner) continue;
    const outcome = runner(db, tenant, ctx);
    checks.push({ ...outcome, dimension: meta.dimension, description: meta.description });
  }
  return checks;
}

export function evaluateReadiness(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const subjectType = normalizeUpper(body.subject_type ?? body.subjectType ?? SUBJECT_TYPES.PRODUCT_REVISION);
  const subjectRef = body.subject_ref ?? body.subjectRef ?? body.subject_object_id ?? body.subjectObjectId;
  if (!subjectRef) throw invalidMq("subject_ref is required");
  const ctx = buildContext(db, tenant, subjectType, subjectRef);
  const checks = runChecks(db, tenant, ctx);
  const scoring = scoreChecks(db, tenant, checks);
  const row = insertEvaluation(db, tenant, {
    organization_id: body.organization_id !== undefined ? toNumber(body.organization_id) : ctx.subject.row?.organization_id ?? null,
    subject_type: subjectType,
    subject_object_id: ctx.productObjectId,
    subject_revision: ctx.subject.revision || "",
    subject_ref: String(subjectRef),
    profile_code: normalizeText(body.profile_code ?? body.profileCode ?? getConfig(db, tenant, "readiness_profile"), { max: 40 }) || "DEFAULT",
    overall_result: scoring.overall,
    score: scoring.score,
    threshold: scoring.threshold,
    checks,
    source_versions: sourceVersions(ctx.subject, ctx),
    ruleset_version: normalizeText(body.ruleset_version ?? body.rulesetVersion, { max: 40 }) || "readiness-v1",
    actor_id: actor?.id ?? null,
    evaluated_at: nowIso(),
    subject: ctx.subject,
  });
  writeAudit(db, { actor, action: "manufacturing-quality.readiness.evaluate", resourceType: "quality_readiness_evaluation", resourceId: row.evaluation_ref, details: { subject_type: subjectType, subject_ref: String(subjectRef), overall_result: row.overall_result, score: Number(row.score) }, ip });
  publishManufacturingQualityEvent(
    db,
    { eventType: "ReleaseReadinessEvaluated", objectType: "quality_readiness_evaluation", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { evaluation_ref: row.evaluation_ref, subject_type: subjectType, subject_ref: String(subjectRef), overall_result: row.overall_result } },
    actor
  );
  return { evaluation: publicEvaluation(row), dimensions: dimensionView(checks), scoring };
}

export async function evaluateReadinessAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const subjectType = normalizeUpper(body.subject_type ?? body.subjectType ?? SUBJECT_TYPES.PRODUCT_REVISION);
  const subjectRef = body.subject_ref ?? body.subjectRef ?? body.subject_object_id ?? body.subjectObjectId;
  if (!subjectRef) throw invalidMq("subject_ref is required");
  const ctx = await buildContextAsync(db, tenant, subjectType, subjectRef);
  const configured = String((await getConfigAsync(db, tenant, "readiness_checks")) || "");
  const wanted = configured
    .split(",")
    .map((code) => normalizeUpper(code, { max: 64 }))
    .filter((code) => CHECK_BY_CODE[code]);
  const codes = wanted.length ? wanted : [...READINESS_CHECK_CODES];
  const checks = [];
  for (const code of codes) {
    const meta = CHECK_BY_CODE[code];
    const outcome = await runCheckAsync(db, code, tenant, ctx);
    if (!outcome) continue;
    checks.push({ ...outcome, dimension: meta.dimension, description: meta.description });
  }
  const scoring = await scoreChecksAsync(db, tenant, checks);
  const profile = normalizeText(body.profile_code ?? body.profileCode ?? (await getConfigAsync(db, tenant, "readiness_profile")), { max: 40 }) || "DEFAULT";
  const row = await insertEvaluationAsync(db, tenant, {
    organization_id: body.organization_id !== undefined ? toNumber(body.organization_id) : ctx.subject.row?.organization_id ?? null,
    subject_type: subjectType,
    subject_object_id: ctx.productObjectId,
    subject_revision: ctx.subject.revision || "",
    subject_ref: String(subjectRef),
    profile_code: profile,
    overall_result: scoring.overall,
    score: scoring.score,
    threshold: scoring.threshold,
    checks,
    source_versions: sourceVersions(ctx.subject, ctx),
    ruleset_version: normalizeText(body.ruleset_version ?? body.rulesetVersion, { max: 40 }) || "readiness-v1",
    actor_id: actor?.id ?? null,
    evaluated_at: nowIso(),
    subject: ctx.subject,
  });
  await writeAuditAsync(db, { actor, action: "manufacturing-quality.readiness.evaluate", resourceType: "quality_readiness_evaluation", resourceId: row.evaluation_ref, details: { subject_type: subjectType, subject_ref: String(subjectRef), overall_result: row.overall_result, score: Number(row.score) }, ip });
  await publishManufacturingQualityEventAsync(
    db,
    { eventType: "ReleaseReadinessEvaluated", objectType: "quality_readiness_evaluation", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { evaluation_ref: row.evaluation_ref, subject_type: subjectType, subject_ref: String(subjectRef), overall_result: row.overall_result } },
    actor
  );
  return { evaluation: publicEvaluation(row), dimensions: dimensionView(checks), scoring };
}

async function scoreChecksAsync(db, tenant, checks) {
  const threshold = Number(await getConfigAsync(db, tenant, "readiness_pass_threshold"));
  let earned = 0;
  let possible = 0;
  let blockingFailure = false;
  let notEvaluated = 0;
  for (const check of checks) {
    const weight = SEVERITY_WEIGHT[check.severity] || 1;
    if (check.result === "NOT_EVALUATED") {
      notEvaluated += 1;
      continue;
    }
    possible += weight;
    if (check.result === "PASS") earned += weight;
    if (check.result === "FAIL" && BLOCKING_SEVERITIES.has(check.severity)) blockingFailure = true;
  }
  const score = possible > 0 ? Math.round((earned / possible) * 10000) / 100 : null;
  let overall;
  if (blockingFailure) overall = "FAIL";
  else if (score === null) overall = "NOT_EVALUATED";
  else if (score >= threshold) overall = notEvaluated > 0 ? "WARNING" : "PASS";
  else overall = "FAIL";
  return { score, threshold, overall, not_evaluated: notEvaluated };
}

// Async check runner: mirrors the sync checks but resolves every input through
// the async database layer so the API request path never blocks the event loop.
async function runCheckAsync(db, code, tenant, ctx) {
  const q1 = (sql, params) => queryOneAsync(db, sql, params);
  const qa = (sql, params) => queryAllAsync(db, sql, params);
  const productBoms = async (bomType) =>
    ctx.productObjectId
      ? qa(
          `SELECT r.id, r.revision_number, r.status, r.version, h.bom_type
             FROM bom_headers h JOIN bom_revisions r ON r.bom_id = h.id
            WHERE h.tenant_id = ? AND h.owner_object_id = ? AND h.bom_type = ?`,
          [tenant, Number(ctx.productObjectId), bomType]
        )
      : [];

  switch (code) {
    case "PRODUCT_REVISION_PRESENT":
      return checkProductRevisionPresent(db, tenant, ctx);
    case "PRODUCT_REVISION_RELEASED": {
      if (!ctx.subject?.row) return result("PRODUCT_REVISION_RELEASED", false, { severity: "ERROR", evaluated: false, message: "No subject revision to assess." });
      const strict = await getConfigAsync(db, tenant, "require_released_revision");
      if (!strict) return result("PRODUCT_REVISION_RELEASED", true, { severity: "ERROR", message: "Release requirement disabled by configuration." });
      const status = releaseStatus(ctx.subject);
      const released = status === "RELEASED" || status === "released";
      return result("PRODUCT_REVISION_RELEASED", released, { severity: "ERROR", message: released ? "Subject revision is released." : `Subject revision is ${status || "unknown"}, not released.`, details: { status } });
    }
    case "BOM_STRUCTURE_PRESENT": {
      if (!ctx.productObjectId) return result("BOM_STRUCTURE_PRESENT", false, { severity: "ERROR", evaluated: false, message: "No product object is associated with this subject." });
      const revisions = [...(await productBoms("EBOM")), ...(await productBoms("MBOM"))];
      ctx.bomRevisionIds = revisions.map((r) => Number(r.id));
      return result("BOM_STRUCTURE_PRESENT", revisions.length > 0, { severity: "ERROR", message: revisions.length ? "A BOM structure exists for the product." : "No EBOM or MBOM structure is linked to the product.", details: { revisions: revisions.length } });
    }
    case "BOM_STRUCTURE_VALID": {
      if (!ctx.bomRevisionIds?.length) return result("BOM_STRUCTURE_VALID", false, { severity: "ERROR", evaluated: false, message: "No BOM revision to validate." });
      const marks = ctx.bomRevisionIds.map(() => "?").join(",");
      const rows = await qa(
        `SELECT r.revision_id, r.status FROM bom_validation_results r WHERE r.tenant_id = ? AND r.revision_id IN (${marks}) ORDER BY r.id DESC`,
        [tenant, ...ctx.bomRevisionIds]
      );
      if (!rows.length) return result("BOM_STRUCTURE_VALID", false, { severity: "ERROR", evaluated: false, message: "No BOM validation run has been recorded." });
      const latest = new Map();
      for (const row of rows) if (!latest.has(row.revision_id)) latest.set(row.revision_id, row.status);
      const errored = [...latest.values()].filter((status) => status === "ERROR");
      return result("BOM_STRUCTURE_VALID", errored.length === 0, { severity: "ERROR", message: errored.length ? "The latest BOM validation reported errors." : "Latest BOM validation reports no errors.", details: { revisions_checked: latest.size, revisions_with_errors: errored.length } });
    }
    case "MBOM_PRESENT": {
      if (!ctx.productObjectId) return result("MBOM_PRESENT", false, { severity: "WARNING", evaluated: false, message: "No product object is associated with this subject." });
      const mboms = await productBoms("MBOM");
      ctx.mbomRevisionIds = mboms.map((r) => Number(r.id));
      return result("MBOM_PRESENT", mboms.length > 0, { severity: "WARNING", message: mboms.length ? "Manufacturing BOM present." : "No manufacturing BOM is linked to the product.", details: { revisions: mboms.length } });
    }
    case "BOP_PRESENT": {
      if (!ctx.productObjectId) return result("BOP_PRESENT", false, { severity: "WARNING", evaluated: false, message: "No product object is associated with this subject." });
      const bops = await productBoms("BOP");
      ctx.bopRevisionIds = bops.map((r) => Number(r.id));
      return result("BOP_PRESENT", bops.length > 0, { severity: "WARNING", message: bops.length ? "Bill of process present." : "No bill of process is linked to the product.", details: { revisions: bops.length } });
    }
    case "OPERATIONS_PRESENT": {
      if (!ctx.bopRevisionIds?.length) return result("OPERATIONS_PRESENT", false, { severity: "WARNING", evaluated: false, message: "No bill of process to inspect for operations." });
      const marks = ctx.bopRevisionIds.map(() => "?").join(",");
      const operations = await qa(
        `SELECT DISTINCT child_object_id AS operation_object_id FROM bom_lines
          WHERE tenant_id = ? AND bom_revision_id IN (${marks})
            AND child_object_type = 'operation' AND child_object_id IS NOT NULL AND child_object_id != ''`,
        [tenant, ...ctx.bopRevisionIds.map(Number)]
      );
      ctx.operationObjectIds = operations.map((row) => String(row.operation_object_id));
      return result("OPERATIONS_PRESENT", operations.length > 0, { severity: "WARNING", message: operations.length ? "The bill of process defines operations." : "The bill of process defines no operations.", details: { operations: operations.length } });
    }
    case "OPERATIONS_HAVE_WORK_INSTRUCTIONS": {
      if (ctx.operationObjectIds === null || ctx.operationObjectIds === undefined) return result("OPERATIONS_HAVE_WORK_INSTRUCTIONS", false, { severity: "WARNING", evaluated: false, message: "No operations to check." });
      const required = await getConfigAsync(db, tenant, "require_work_instructions");
      if (!required) return result("OPERATIONS_HAVE_WORK_INSTRUCTIONS", true, { severity: "WARNING", message: "Work-instruction requirement disabled by configuration." });
      if (!ctx.operationObjectIds.length) return result("OPERATIONS_HAVE_WORK_INSTRUCTIONS", false, { severity: "WARNING", evaluated: false, message: "No operations to check." });
      const marks = ctx.operationObjectIds.map(() => "?").join(",");
      const rows = await qa(
        `SELECT object_id, COUNT(*) AS c FROM content_associations
          WHERE tenant_id = ? AND object_type = 'operation' AND status = 'active' AND object_id IN (${marks})
          GROUP BY object_id`,
        [tenant, ...ctx.operationObjectIds]
      );
      const documented = new Set(rows.map((row) => String(row.object_id)));
      const missing = ctx.operationObjectIds.filter((id) => !documented.has(id));
      return result("OPERATIONS_HAVE_WORK_INSTRUCTIONS", missing.length === 0, { severity: "WARNING", message: missing.length ? `${missing.length} operation(s) have no work instruction.` : "Every operation has a work instruction.", details: { operations: ctx.operationObjectIds.length, missing: missing.length } });
    }
    case "OPEN_QUALITY_ISSUES": {
      if (!ctx.productObjectId) return result("OPEN_QUALITY_ISSUES", false, { severity: "ERROR", evaluated: false, message: "No product object is associated with this subject." });
      const marks = ACTIVE_ISSUE_STATUSES.map(() => "?").join(",");
      const row = await q1(
        `SELECT COUNT(*) AS c FROM quality_issues
          WHERE tenant_id = ? AND product_object_id = ? AND severity IN ('CRITICAL','HIGH') AND status IN (${marks})`,
        [tenant, Number(ctx.productObjectId), ...ACTIVE_ISSUE_STATUSES]
      );
      const blocking = Number(row?.c || 0);
      const enforced = await getConfigAsync(db, tenant, "block_on_critical_issues");
      if (!enforced && blocking > 0) return result("OPEN_QUALITY_ISSUES", true, { severity: "ERROR", message: `${blocking} critical/high issue(s) open; blocking disabled by configuration.`, details: { open_critical_high: blocking, enforced: false } });
      return result("OPEN_QUALITY_ISSUES", blocking === 0, { severity: "ERROR", message: blocking ? `${blocking} critical/high quality issue(s) remain open.` : "No critical/high quality issue is open.", details: { open_critical_high: blocking } });
    }
    case "CORRECTIVE_ACTIONS_COMPLETE": {
      if (!ctx.productObjectId) return result("CORRECTIVE_ACTIONS_COMPLETE", false, { severity: "WARNING", evaluated: false, message: "No product object is associated with this subject." });
      const marks = OPEN_ACTION_STATUSES.map(() => "?").join(",");
      const row = await q1(
        `SELECT COUNT(*) AS c FROM quality_corrective_actions a
           JOIN quality_issues i ON i.id = a.quality_issue_id AND i.tenant_id = a.tenant_id
          WHERE a.tenant_id = ? AND i.product_object_id = ? AND a.status IN (${marks})`,
        [tenant, Number(ctx.productObjectId), ...OPEN_ACTION_STATUSES]
      );
      const openCount = Number(row?.c || 0);
      return result("CORRECTIVE_ACTIONS_COMPLETE", openCount === 0, { severity: "WARNING", message: openCount ? `${openCount} corrective action(s) are still open.` : "All corrective actions for linked issues are closed.", details: { open_actions: openCount } });
    }
    case "INSPECTIONS_COMPLETE": {
      if (!ctx.productObjectId) return result("INSPECTIONS_COMPLETE", false, { severity: "WARNING", evaluated: false, message: "No product object is associated with this subject." });
      const required = await getConfigAsync(db, tenant, "require_inspections");
      const rows = await qa("SELECT status FROM quality_inspections WHERE tenant_id = ? AND product_object_id = ?", [tenant, Number(ctx.productObjectId)]);
      if (!rows.length) return result("INSPECTIONS_COMPLETE", false, { severity: "WARNING", evaluated: false, message: "No inspections are recorded for this product.", details: { required: Boolean(required) } });
      if (!required) return result("INSPECTIONS_COMPLETE", true, { severity: "WARNING", message: "Inspection requirement disabled by configuration.", details: { inspections: rows.length } });
      const pending = rows.filter((row) => row.status === "PLANNED" || row.status === "IN_PROGRESS");
      const failed = rows.filter((row) => row.status === "FAILED");
      const ok = pending.length === 0 && failed.length === 0;
      return result("INSPECTIONS_COMPLETE", ok, { severity: "WARNING", message: ok ? "All planned inspections have a passing or waived outcome." : `${pending.length} pending and ${failed.length} failed inspection(s).`, details: { pending: pending.length, failed: failed.length, total: rows.length } });
    }
    case "REQUIRED_APPROVALS": {
      if (!ctx.productObjectId) return result("REQUIRED_APPROVALS", false, { severity: "ERROR", evaluated: false, message: "No product object is associated with this subject." });
      const instances = await qa("SELECT id FROM workflow_instances WHERE tenant_id = ? AND object_id = ?", [tenant, Number(ctx.productObjectId)]);
      if (!instances.length) return result("REQUIRED_APPROVALS", false, { severity: "ERROR", evaluated: false, message: "No approval workflow instance is linked to the product." });
      const marks = instances.map(() => "?").join(",");
      const row = await q1(
        `SELECT COUNT(*) AS c FROM workflow_approvals
          WHERE tenant_id = ? AND instance_id IN (${marks}) AND status IN ('pending','rejected','changes_requested')`,
        [tenant, ...instances.map((instance) => Number(instance.id))]
      );
      const outstanding = Number(row?.c || 0);
      return result("REQUIRED_APPROVALS", outstanding === 0, { severity: "ERROR", message: outstanding ? `${outstanding} approval(s) are not approved.` : "Required approvals are recorded.", details: { outstanding } });
    }
    case "DOCUMENT_COMPLETENESS": {
      if (!ctx.productObjectId) return result("DOCUMENT_COMPLETENESS", false, { severity: "INFO", evaluated: false, message: "No product object is associated with this subject." });
      const ids = [String(ctx.productObjectId)];
      if (ctx.subject?.subject_type === SUBJECT_TYPES.MBOM_REVISION) ids.push(String(ctx.subject.row.id));
      const marks = ids.map(() => "?").join(",");
      const row = await q1(
        `SELECT COUNT(*) AS c FROM content_associations
          WHERE tenant_id = ? AND status = 'active' AND object_type IN ('product','pdm_revision','bom_revision') AND object_id IN (${marks})`,
        [tenant, ...ids]
      );
      const count = Number(row?.c || 0);
      return result("DOCUMENT_COMPLETENESS", count > 0, { severity: "INFO", message: count ? `${count} document(s) are associated.` : "No specification document is associated with the product.", details: { documents: count } });
    }
    default:
      return null;
  }
}

// Mark prior evaluations for a subject stale after an upstream source change.
// This never deletes or rewrites the recorded result: the historical assessment
// stays auditable and only gains an explicit staleness marker.
export function markReadinessStale(db, tenantId, { subjectType, subjectRef, reason = "Source changed" }, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const stale = Number(getConfig(db, tenant, "stale_on_source_change")) ? 1 : 0;
  if (!stale) return { updated: 0, disabled: true };
  const rows = queryAll(
    db,
    "SELECT id, evaluation_ref FROM quality_readiness_evaluations WHERE tenant_id = ? AND subject_type = ? AND subject_ref = ? AND stale = 0",
    [tenant, normalizeUpper(subjectType), String(subjectRef)]
  );
  for (const row of rows) {
    updateRow(db, "quality_readiness_evaluations", row.id, { stale: 1, stale_reason: normalizeText(reason, { max: 300 }) }, { columns: ["stale", "stale_reason"] });
    writeAudit(db, { actor, action: "manufacturing-quality.readiness.stale", resourceType: "quality_readiness_evaluation", resourceId: row.evaluation_ref, details: { reason }, ip });
    publishManufacturingQualityEvent(
      db,
      { eventType: "ReleaseReadinessStale", objectType: "quality_readiness_evaluation", objectId: String(row.id), tenantId: tenant, payload: { evaluation_ref: row.evaluation_ref, reason } },
      actor
    );
  }
  return { updated: rows.length };
}

export async function markReadinessStaleAsync(db, tenantId, { subjectType, subjectRef, reason = "Source changed" }, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const stale = Number(await getConfigAsync(db, tenant, "stale_on_source_change")) ? 1 : 0;
  if (!stale) return { updated: 0, disabled: true };
  const rows = await queryAllAsync(
    db,
    "SELECT id, evaluation_ref FROM quality_readiness_evaluations WHERE tenant_id = ? AND subject_type = ? AND subject_ref = ? AND stale = 0",
    [tenant, normalizeUpper(subjectType), String(subjectRef)]
  );
  for (const row of rows) {
    await updateRowAsync(db, "quality_readiness_evaluations", row.id, { stale: 1, stale_reason: normalizeText(reason, { max: 300 }) }, { columns: ["stale", "stale_reason"] });
    await writeAuditAsync(db, { actor, action: "manufacturing-quality.readiness.stale", resourceType: "quality_readiness_evaluation", resourceId: row.evaluation_ref, details: { reason }, ip });
    await publishManufacturingQualityEventAsync(
      db,
      { eventType: "ReleaseReadinessStale", objectType: "quality_readiness_evaluation", objectId: String(row.id), tenantId: tenant, payload: { evaluation_ref: row.evaluation_ref, reason } },
      actor
    );
  }
  return { updated: rows.length };
}

export function readinessMeta() {
  return {
    source_module: SOURCE_MODULE,
    results: [...READINESS_RESULTS],
    dimensions: READINESS_DIMENSIONS.map((entry) => ({ ...entry })),
    checks: READINESS_CHECKS.map((entry) => ({ ...entry })),
  };
}

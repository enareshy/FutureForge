// Requirement status & coverage engine.
//
// V&V never introduces a competing requirement lifecycle. This service computes a
// requirement's verification/validation coverage and outcome from the test cases
// linked to it (Requirements Manager `VERIFIED_BY`/`VALIDATED_BY` edges), their
// executions, results and valid waivers, then writes the existing
// `requirements.verification_status` / `.validation_status` columns through the
// Requirements Manager and publishes a V&V status-change event.
//
// It distinguishes the concepts the spec calls out:
//   - planning coverage      (are mandatory tests defined/approved)
//   - execution coverage     (have required executions run to completion)
//   - verification outcome   (aggregated over mandatory verification tests)
//   - validation outcome     (aggregated over mandatory validation tests)
//   - exception status       (a valid approved waiver, never a false PASS)
import { queryAll, queryOne, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { parseObject, normalizeUpper, paginate } from "../data-lifecycle/validation.js";
import { Requirements as RequirementService } from "../requirements/index.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { publishVvEvent, publishVvEventAsync } from "./events.js";
import { getConfig, getConfigAsync } from "./configuration.js";
import { SOURCE_MODULE, REQUIREMENT_VNV_RELATIONSHIPS, REQUIREMENT_VERIFICATION_STATUS_MAP, COVERAGE_AGGREGATION_RULES } from "./constants.js";
import { requirementNotFound } from "./errors.js";

const PLANNED_DEFINITION_STATUSES = ["APPROVED", "RELEASED"];
const STARTED_EXECUTION_STATUSES = ["READY", "IN_PROGRESS", "COMPLETED", "EVALUATED", "REVIEWED", "FAILED"];
const EVALUATED_EXECUTION_STATUSES = ["EVALUATED", "REVIEWED"];

// ── Pure aggregation ─────────────────────────────────────────────────────────

// Aggregate per-test-case outcomes into a single outcome for one verification
// kind. `entries` are `{ outcome }` where outcome is one of PASS, FAIL, PENDING,
// BLOCKED, WAIVED, NOT_STARTED. A PASS is only returned when the configured rule
// is actually satisfied for every mandatory test.
export function aggregateOutcomes(entries = [], rule = "ALL_MANDATORY") {
  const total = entries.length;
  const count = (value) => entries.filter((e) => e.outcome === value).length;
  const pass = count("PASS");
  const fail = count("FAIL");
  const blocked = count("BLOCKED");
  const waived = count("WAIVED");
  const notStarted = count("NOT_STARTED");
  const pending = total - pass - fail - blocked - waived - notStarted;
  const summary = { total, pass, fail, blocked, waived, pending, not_started: notStarted };

  if (total === 0) return { outcome: "NOT_STARTED", ...summary };
  const effectiveRule = COVERAGE_AGGREGATION_RULES.includes(rule) ? rule : "ALL_MANDATORY";

  if (effectiveRule === "ANY") {
    if (pass > 0) return { outcome: "PASS", ...summary };
    if (fail > 0) return { outcome: "FAIL", ...summary };
    if (blocked > 0) return { outcome: "BLOCKED", ...summary };
    return { outcome: notStarted === total ? "NOT_STARTED" : "PENDING", ...summary };
  }
  if (effectiveRule === "MAJORITY") {
    const needed = Math.floor(total / 2) + 1;
    if (pass >= needed) return { outcome: "PASS", ...summary };
    if (fail > 0 && pass < needed) return { outcome: "FAIL", ...summary };
    if (blocked > 0) return { outcome: "BLOCKED", ...summary };
    return { outcome: notStarted === total ? "NOT_STARTED" : "PENDING", ...summary };
  }
  // ALL_MANDATORY (default): one unwaived failure or an incomplete mandatory test
  // prevents a successful verification.
  if (fail > 0) return { outcome: "FAIL", ...summary };
  if (blocked > 0) return { outcome: "BLOCKED", ...summary };
  if (pass + waived === total) return { outcome: "PASS", ...summary };
  if (pass + waived > 0) return { outcome: "PENDING", ...summary };
  return { outcome: notStarted === total ? "NOT_STARTED" : "PENDING", ...summary };
}

export function planningCoverage(testCases = []) {
  const total = testCases.length;
  if (total === 0) return { status: "NOT_PLANNED", total: 0, planned: 0, drafts: 0 };
  const planned = testCases.filter((tc) => PLANNED_DEFINITION_STATUSES.includes(tc.status)).length;
  const status = planned === total ? "PLANNED" : planned > 0 ? "PARTIAL" : "NOT_PLANNED";
  return { status, total, planned, drafts: total - planned };
}

export function executionCoverage(aggregate) {
  const total = aggregate.total;
  if (total === 0) return "NOT_STARTED";
  if (aggregate.not_started === total) return "NOT_STARTED";
  const settled = aggregate.pass + aggregate.fail + aggregate.waived;
  if (settled === total) return "COMPLETE";
  if (aggregate.blocked > 0 && settled === 0) return "BLOCKED";
  return "IN_PROGRESS";
}

// Map the rich V&V status onto the Requirements Manager vocabularies.
export function mapRequirementStatuses(vnvStatus, validationAggregate) {
  const verificationStatus = REQUIREMENT_VERIFICATION_STATUS_MAP[vnvStatus] || "NOT_VERIFIED";
  let validationStatus = "NOT_VALIDATED";
  if (validationAggregate) {
    if (validationAggregate.outcome === "PASS") validationStatus = "VALIDATED";
    else if (validationAggregate.outcome === "FAIL") validationStatus = "FAILED";
    else if (["PENDING", "BLOCKED", "WAIVED"].includes(validationAggregate.outcome)) validationStatus = "IN_PROGRESS";
  }
  if (vnvStatus === "VALIDATION_COMPLETE") validationStatus = "VALIDATED";
  return { verification_status: verificationStatus, validation_status: validationStatus };
}

// Deterministic composite status ladder. Waiver beats failure; a completed
// validation beats plain verification; otherwise the strongest available
// evidence-oriented state is used.
export function compositeStatus({ verification, validation, waived, planning }) {
  const active = [verification, validation].filter((entry) => entry && entry.total > 0);
  if (active.length === 0) return "NOT_PLANNED";
  if (planning && planning.status === "NOT_PLANNED") return "NOT_PLANNED";
  if (waived && active.every((entry) => entry.outcome === "WAIVED" || entry.outcome === "PASS")) return "WAIVED";
  if (active.some((entry) => entry.outcome === "FAIL")) return "FAILED";
  if (active.every((entry) => entry.outcome === "NOT_STARTED")) return "PLANNED";
  if (
    active.some((entry) => entry.outcome === "BLOCKED") &&
    active.every((entry) => entry.outcome === "BLOCKED" || entry.outcome === "NOT_STARTED")
  ) {
    return "BLOCKED";
  }

  const hasVerification = Boolean(verification && verification.total > 0);
  const hasValidation = Boolean(validation && validation.total > 0);
  const verificationPass = hasVerification && verification.outcome === "PASS";
  const validationPass = hasValidation && validation.outcome === "PASS";

  if (validationPass && (!hasVerification || verificationPass)) return "VALIDATION_COMPLETE";
  if (verificationPass && !hasValidation) return "VERIFIED";
  // Verification is complete but validation is outstanding, or some tests passed
  // while others remain pending: never report a full verification/validation.
  if (verificationPass || validationPass || active.some((entry) => entry.pass > 0)) return "PARTIALLY_VERIFIED";
  return "IN_PROGRESS";
}

// ── Data access ──────────────────────────────────────────────────────────────

function edgePlaceholders() {
  return REQUIREMENT_VNV_RELATIONSHIPS.map(() => "?").join(", ");
}

function linkedEdges(db, tenant, requirementId) {
  return queryAll(
    db,
    `SELECT * FROM requirement_relationships WHERE tenant_id = ? AND source_type = 'requirement' AND source_id = ? AND relationship_type IN (${edgePlaceholders()}) AND (status IS NULL OR lower(status) IN ('active','approved'))`,
    [tenant, String(requirementId), ...REQUIREMENT_VNV_RELATIONSHIPS]
  );
}

async function linkedEdgesAsync(db, tenant, requirementId) {
  return queryAllAsync(
    db,
    `SELECT * FROM requirement_relationships WHERE tenant_id = ? AND source_type = 'requirement' AND source_id = ? AND relationship_type IN (${edgePlaceholders()}) AND (status IS NULL OR lower(status) IN ('active','approved'))`,
    [tenant, String(requirementId), ...REQUIREMENT_VNV_RELATIONSHIPS]
  );
}

function testCaseRowsFor(db, tenant, ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = queryAll(db, `SELECT * FROM vv_test_cases WHERE tenant_id = ? AND id IN (${placeholders})`, [tenant, ...ids]);
  return new Map(rows.map((row) => [String(row.id), row]));
}

async function testCaseRowsForAsync(db, tenant, ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await queryAllAsync(db, `SELECT * FROM vv_test_cases WHERE tenant_id = ? AND id IN (${placeholders})`, [tenant, ...ids]);
  return new Map(rows.map((row) => [String(row.id), row]));
}

function activeWaiverFor(db, tenant, requirementId, testCaseId) {
  return queryOne(
    db,
    `SELECT id, waiver_ref FROM vv_waivers WHERE tenant_id = ? AND requirement_id = ? AND test_case_id = ? AND status = 'APPROVED' AND (expires_at IS NULL OR expires_at = '' OR expires_at >= ?) ORDER BY id DESC LIMIT 1`,
    [tenant, requirementId, testCaseId, nowIso()]
  );
}

async function activeWaiverForAsync(db, tenant, requirementId, testCaseId) {
  return queryOneAsync(
    db,
    `SELECT id, waiver_ref FROM vv_waivers WHERE tenant_id = ? AND requirement_id = ? AND test_case_id = ? AND status = 'APPROVED' AND (expires_at IS NULL OR expires_at = '' OR expires_at >= ?) ORDER BY id DESC LIMIT 1`,
    [tenant, requirementId, testCaseId, nowIso()]
  );
}

function outcomeFromExecutions(executions) {
  const evaluated = executions.filter((e) => EVALUATED_EXECUTION_STATUSES.includes(e.status));
  if (evaluated.some((e) => e.overall_outcome === "PASS")) return "PASS";
  if (executions.some((e) => e.overall_outcome === "FAIL" || e.status === "FAILED")) return "FAIL";
  if (executions.some((e) => e.status === "BLOCKED")) return "BLOCKED";
  if (executions.some((e) => STARTED_EXECUTION_STATUSES.includes(e.status))) return "PENDING";
  return "PENDING";
}

function testCaseOutcome(db, tenant, requirementId, testCase) {
  if (activeWaiverFor(db, tenant, requirementId, testCase.id)) return "WAIVED";
  const executions = queryAll(db, "SELECT * FROM vv_executions WHERE tenant_id = ? AND test_case_id = ? ORDER BY id DESC", [tenant, testCase.id]);
  if (!executions.length) return "NOT_STARTED";
  return outcomeFromExecutions(executions);
}

async function testCaseOutcomeAsync(db, tenant, requirementId, testCase) {
  if (await activeWaiverForAsync(db, tenant, requirementId, testCase.id)) return "WAIVED";
  const executions = await queryAllAsync(db, "SELECT * FROM vv_executions WHERE tenant_id = ? AND test_case_id = ? ORDER BY id DESC", [tenant, testCase.id]);
  if (!executions.length) return "NOT_STARTED";
  return outcomeFromExecutions(executions);
}

function computeFromEntries(entries, rule, requireExecution) {
  const verificationEntries = entries.filter((e) => e.kind === "VERIFICATION");
  const validationEntries = entries.filter((e) => e.kind === "VALIDATION");
  const planning = planningCoverage(entries.map((entry) => entry.testCase));
  const verification = aggregateOutcomes(verificationEntries.map((e) => ({ outcome: e.outcome })), rule);
  const validation = aggregateOutcomes(validationEntries.map((e) => ({ outcome: e.outcome })), rule);
  const waived = entries.length > 0 && entries.some((e) => e.outcome === "WAIVED") && entries.every((e) => e.outcome === "WAIVED" || e.outcome === "PASS");
  const vnv_status = compositeStatus({ verification, validation, waived, planning });
  const mapped = mapRequirementStatuses(vnv_status, validation);
  const gaps = entries
    .filter((e) => e.mandatory && (e.outcome === "NOT_STARTED" || e.outcome === "PENDING" || e.outcome === "FAIL"))
    .map((e) => ({ test_case_ref: e.testCase.test_case_ref, code: e.testCase.code, verification_kind: e.kind, outcome: e.outcome }));
  return {
    planning_coverage: planning,
    execution_coverage: { verification: executionCoverage(verification), validation: executionCoverage(validation) },
    verification,
    validation,
    waived,
    vnv_status,
    ...mapped,
    gaps,
    aggregation_rule: rule,
    require_execution_for_verification: Boolean(requireExecution),
  };
}

function entriesFrom(edges, testCasesById, outcomeFor) {
  const entries = [];
  for (const edge of edges) {
    const testCase = testCasesById.get(String(edge.target_id));
    if (!testCase) continue;
    const attributes = parseObject(edge.attributes_json, {});
    entries.push({
      edge,
      testCase,
      mandatory: attributes.mandatory !== false,
      kind: testCase.verification_kind === "VALIDATION" ? "VALIDATION" : "VERIFICATION",
      outcome: outcomeFor(testCase),
    });
  }
  return entries;
}

export function computeRequirementCoverage(db, tenantId, ref, { rule } = {}) {
  const tenant = Number(tenantId);
  const requirement = ref && typeof ref === "object" ? ref : RequirementService.getRequirementRow(db, tenant, ref);
  if (!requirement) throw requirementNotFound(ref);
  const edges = linkedEdges(db, tenant, requirement.id);
  const ids = edges.map((e) => Number(e.target_id)).filter((id) => Number.isInteger(id));
  const testCasesById = testCaseRowsFor(db, tenant, ids);
  const cache = new Map();
  const outcomeFor = (testCase) => {
    if (!cache.has(testCase.id)) cache.set(testCase.id, testCaseOutcome(db, tenant, requirement.id, testCase));
    return cache.get(testCase.id);
  };
  const entries = entriesFrom(edges, testCasesById, outcomeFor);
  const effectiveRule = rule || getConfig(db, tenant, "aggregation_rule");
  const coverage = computeFromEntries(entries, effectiveRule, getConfig(db, tenant, "require_execution_for_verification"));
  return { requirement_id: requirement.id, requirement_ref: requirement.requirement_ref, tenant_id: tenant, source_module: SOURCE_MODULE, ...coverage };
}

export async function computeRequirementCoverageAsync(db, tenantId, ref, { rule } = {}) {
  const tenant = Number(tenantId);
  const requirement = ref && typeof ref === "object" ? ref : await RequirementService.getRequirementRowAsync(db, tenant, ref);
  if (!requirement) throw requirementNotFound(ref);
  const edges = await linkedEdgesAsync(db, tenant, requirement.id);
  const ids = edges.map((e) => Number(e.target_id)).filter((id) => Number.isInteger(id));
  const testCasesById = await testCaseRowsForAsync(db, tenant, ids);
  const cache = new Map();
  const outcomeFor = async (testCase) => {
    if (!cache.has(testCase.id)) cache.set(testCase.id, await testCaseOutcomeAsync(db, tenant, requirement.id, testCase));
    return cache.get(testCase.id);
  };
  const entries = [];
  for (const edge of edges) {
    const testCase = testCasesById.get(String(edge.target_id));
    if (!testCase) continue;
    const attributes = parseObject(edge.attributes_json, {});
    entries.push({ edge, testCase, mandatory: attributes.mandatory !== false, kind: testCase.verification_kind === "VALIDATION" ? "VALIDATION" : "VERIFICATION", outcome: await outcomeFor(testCase) });
  }
  const effectiveRule = rule || (await getConfigAsync(db, tenant, "aggregation_rule"));
  const coverage = computeFromEntries(entries, effectiveRule, await getConfigAsync(db, tenant, "require_execution_for_verification"));
  return { requirement_id: requirement.id, requirement_ref: requirement.requirement_ref, tenant_id: tenant, source_module: SOURCE_MODULE, ...coverage };
}

// ── Recalculation & persistence ──────────────────────────────────────────────

export function recalculateRequirement(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const requirement = RequirementService.getRequirementRow(db, tenant, ref);
  if (!requirement) throw requirementNotFound(ref);
  const coverage = computeRequirementCoverage(db, tenant, requirement);
  let changed = false;
  let updated = requirement;
  if (coverage.verification_status !== requirement.verification_status) {
    updated = RequirementService.setVerificationStatus(db, tenant, requirement.id, coverage.verification_status, actor, ip);
    changed = true;
  }
  if (coverage.validation_status !== requirement.validation_status) {
    updated = RequirementService.setValidationStatus(db, tenant, requirement.id, coverage.validation_status, actor, ip);
    changed = true;
  }
  if (changed) {
    writeAudit(db, { actor, action: "verification-validation.coverage.recalculate", resourceType: "requirement", resourceId: requirement.requirement_ref, details: { vnv_status: coverage.vnv_status }, ip });
    publishVvEvent(db, { eventType: "RequirementVnVStatusChanged", objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, organizationId: requirement.organization_id, payload: { requirement_ref: requirement.requirement_ref, vnv_status: coverage.vnv_status, verification_status: coverage.verification_status, validation_status: coverage.validation_status } }, actor);
  }
  return { ...coverage, changed };
}

export async function recalculateRequirementAsync(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const requirement = await RequirementService.getRequirementRowAsync(db, tenant, ref);
  if (!requirement) throw requirementNotFound(ref);
  const coverage = await computeRequirementCoverageAsync(db, tenant, requirement);
  let changed = false;
  if (coverage.verification_status !== requirement.verification_status) {
    await RequirementService.setVerificationStatusAsync(db, tenant, requirement.id, coverage.verification_status, actor, ip);
    changed = true;
  }
  if (coverage.validation_status !== requirement.validation_status) {
    await RequirementService.setValidationStatusAsync(db, tenant, requirement.id, coverage.validation_status, actor, ip);
    changed = true;
  }
  if (changed) {
    await writeAuditAsync(db, { actor, action: "verification-validation.coverage.recalculate", resourceType: "requirement", resourceId: requirement.requirement_ref, details: { vnv_status: coverage.vnv_status }, ip });
    await publishVvEventAsync(db, { eventType: "RequirementVnVStatusChanged", objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, organizationId: requirement.organization_id, payload: { requirement_ref: requirement.requirement_ref, vnv_status: coverage.vnv_status, verification_status: coverage.verification_status, validation_status: coverage.validation_status } }, actor);
  }
  return { ...coverage, changed };
}

// Recalculate every requirement linked to the given test cases. Used after
// executions/results/waivers change so downstream coverage never drifts.
function linkedRequirementIds(db, tenant, testCaseIds) {
  const placeholders = testCaseIds.map(() => "?").join(", ");
  return queryAll(
    db,
    `SELECT DISTINCT source_id FROM requirement_relationships WHERE tenant_id = ? AND source_type = 'requirement' AND target_type = 'test_case' AND target_id IN (${placeholders}) AND relationship_type IN ('VERIFIED_BY','VALIDATED_BY')`,
    [tenant, ...testCaseIds.map((id) => String(id))]
  );
}

async function linkedRequirementIdsAsync(db, tenant, testCaseIds) {
  const placeholders = testCaseIds.map(() => "?").join(", ");
  return queryAllAsync(
    db,
    `SELECT DISTINCT source_id FROM requirement_relationships WHERE tenant_id = ? AND source_type = 'requirement' AND target_type = 'test_case' AND target_id IN (${placeholders}) AND relationship_type IN ('VERIFIED_BY','VALIDATED_BY')`,
    [tenant, ...testCaseIds.map((id) => String(id))]
  );
}

export function recalculateForTestCases(db, tenantId, testCaseIds, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const ids = [...new Set((testCaseIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id)))];
  if (!ids.length) return { requirements: [], count: 0 };
  const results = linkedRequirementIds(db, tenant, ids).map((edge) => recalculateRequirement(db, tenant, Number(edge.source_id), actor, ip));
  return { requirements: results, count: results.length };
}

export async function recalculateForTestCasesAsync(db, tenantId, testCaseIds, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const ids = [...new Set((testCaseIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id)))];
  if (!ids.length) return { requirements: [], count: 0 };
  const results = [];
  for (const edge of await linkedRequirementIdsAsync(db, tenant, ids)) results.push(await recalculateRequirementAsync(db, tenant, Number(edge.source_id), actor, ip));
  return { requirements: results, count: results.length };
}

// Tenant-wide recalculation, paged so a background job never loads every
// requirement at once. Runs the same per-requirement engine, so the persisted
// status is always identical to an interactive recalculation.
function coverageBatchSize(db, tenant, batchSize) {
  return Math.max(1, Math.min(Number(batchSize) || Number(getConfig(db, tenant, "coverage_batch_size")) || 200, 1000));
}

export function recalculateTenantCoverage(db, tenantId, { batchSize } = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const size = coverageBatchSize(db, tenant, batchSize);
  let offset = 0;
  let processed = 0;
  let changed = 0;
  for (;;) {
    const rows = queryAll(db, "SELECT id FROM requirements WHERE tenant_id = ? ORDER BY id ASC LIMIT ? OFFSET ?", [tenant, size, offset]);
    if (!rows.length) break;
    for (const row of rows) {
      const result = recalculateRequirement(db, tenant, row.id, actor, ip);
      processed += 1;
      if (result.changed) changed += 1;
    }
    offset += rows.length;
    if (rows.length < size) break;
  }
  return { source_module: SOURCE_MODULE, processed, changed };
}

export async function recalculateTenantCoverageAsync(db, tenantId, { batchSize } = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const configured = Number(await getConfigAsync(db, tenant, "coverage_batch_size")) || 200;
  const size = Math.max(1, Math.min(Number(batchSize) || configured, 1000));
  let offset = 0;
  let processed = 0;
  let changed = 0;
  for (;;) {
    const rows = await queryAllAsync(db, "SELECT id FROM requirements WHERE tenant_id = ? ORDER BY id ASC LIMIT ? OFFSET ?", [tenant, size, offset]);
    if (!rows.length) break;
    for (const row of rows) {
      const result = await recalculateRequirementAsync(db, tenant, row.id, actor, ip);
      processed += 1;
      if (result.changed) changed += 1;
    }
    offset += rows.length;
    if (rows.length < size) break;
  }
  return { source_module: SOURCE_MODULE, processed, changed };
}

// ── Listing / dashboards ─────────────────────────────────────────────────────

function coverageFilters(tenantId, opts = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (opts.status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(opts.status));
  }
  if (opts.verification_status) {
    clauses.push("verification_status = ?");
    params.push(normalizeUpper(opts.verification_status));
  }
  if (opts.validation_status) {
    clauses.push("validation_status = ?");
    params.push(normalizeUpper(opts.validation_status));
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listRequirementCoverage(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const { where, params } = coverageFilters(tenant, opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 25, maxPageSize: 200 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM requirements ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM requirements ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map((row) => computeRequirementCoverage(db, tenant, row)), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listRequirementCoverageAsync(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const { where, params } = coverageFilters(tenant, opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 25, maxPageSize: 200 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM requirements ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM requirements ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const items = [];
  for (const row of rows) items.push(await computeRequirementCoverageAsync(db, tenant, row));
  return { items, total, page, page_size: limit, source_module: SOURCE_MODULE };
}

function summarizeRows(rows) {
  const byVerification = {};
  const byValidation = {};
  let total = 0;
  for (const row of rows) {
    total += Number(row.c);
    byVerification[row.verification_status] = (byVerification[row.verification_status] || 0) + Number(row.c);
    byValidation[row.validation_status] = (byValidation[row.validation_status] || 0) + Number(row.c);
  }
  return { total, by_verification_status: byVerification, by_validation_status: byValidation, source_module: SOURCE_MODULE };
}

export function coverageSummary(db, tenantId) {
  const rows = queryAll(db, "SELECT verification_status, validation_status, COUNT(*) AS c FROM requirements WHERE tenant_id = ? GROUP BY verification_status, validation_status", [Number(tenantId)]);
  return summarizeRows(rows);
}

export async function coverageSummaryAsync(db, tenantId) {
  const rows = await queryAllAsync(db, "SELECT verification_status, validation_status, COUNT(*) AS c FROM requirements WHERE tenant_id = ? GROUP BY verification_status, validation_status", [Number(tenantId)]);
  return summarizeRows(rows);
}

// Manufacturing traceability matrix, gap analysis, coverage and bidirectional
// navigation (Boundary 6).
//
// This is a projection layer, not a second traceability engine. Domain-level
// traversal/matrix/monitoring delegates to the existing Generic Traceability
// Engine and Digital Thread (`Traceability.forward/backward/matrix`); the
// manufacturing columns are computed from the existing allocation, EBOM->MBOM
// transformation and process-linkage readers. Gap rules are configuration-
// driven (`requirement_manufacturing.coverage_rules`) and never hard-code a
// universal notion of "complete". Reads are bounded and paginated; inaccessible
// objects are never reported as confirmed missing.
//
// Every public function has a synchronous twin (CLI/seeders/tests) and an
// `*Async` twin (async request transactions); a caller uses one layer, never
// both.
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { Service as TraceabilityService } from "../traceability/index.js";
import { getConfig } from "./configuration.js";
import { ALLOCATION_CODES, REQUIREMENT_SOURCE_TYPE, TARGET_NODE_TYPES, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "./constants.js";
import { paginate } from "./validation.js";
import { resolveTarget, resolveTargetAsync } from "./targets.js";
import { listMbomBops, listMbomBopsAsync } from "./process-linkage.js";
import { mbomEbomSources, mbomEbomSourcesAsync } from "./transformation-trace.js";
import { ctqCoverage, ctqCoverageAsync } from "./coverage.js";
import { invalidTarget } from "./errors.js";

const MAX_ROWS = 20000;
const DEFAULT_MBOM_SCAN = 200;

const GAP_STATUS = "MISSING_LINK";
const COVERAGE_STATUSES = Object.freeze(["COVERED", "PARTIAL", "GAP", "UNALLOCATED"]);

// Recognised coverage rule tokens (config `coverage_rules`). Object-level rules
// are evaluated by scanning the relevant structures; requirement-level rules are
// evaluated per matrix row.
const RULE_TOKENS = Object.freeze(["REQUIREMENT_IMPLEMENTATION", "EBOM_MBOM_MAPPING", "MBOM_BOP_ASSIGNMENT", "CTQ_COVERAGE"]);

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function chunk(values, size = 800) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function uniqueNumbers(values) {
  const set = new Set();
  for (const value of values) {
    const num = Number(value);
    if (Number.isInteger(num) && num > 0) set.add(num);
  }
  return [...set];
}

function parseMetadata(row) {
  try {
    return JSON.parse(row?.metadata_json || "{}") || {};
  } catch {
    return {};
  }
}

function severityFor(category) {
  if (category === "MUST") return "ERROR";
  if (category === "SHOULD") return "WARNING";
  return "INFO";
}

function coverageRules(db, tenantId) {
  const text = String(getConfig(db, tenantId, "coverage_rules") || "");
  const rules = {};
  for (const entry of text.split(",")) {
    const [category, rule] = entry.split(":").map((part) => String(part || "").trim().toUpperCase());
    if (rule) rules[rule] = category || "OPTIONAL";
  }
  return rules;
}

function requirementDescriptor(row) {
  return {
    requirement_id: row.id,
    id: row.id,
    requirement_ref: row.requirement_ref || "",
    requirement_number: row.requirement_number || "",
    name: row.name || row.title || "",
    title: row.title || "",
    status: row.status || "",
    lifecycle_state: row.lifecycle_state || row.status || "",
    criticality: row.criticality || "",
    category: row.category || "",
    revision: row.revision || "",
  };
}

// ── Requirement scope ────────────────────────────────────────────────────────

const REQUIREMENT_COLUMNS = "id, requirement_ref, requirement_number, name, title, status, lifecycle_state, criticality, category, revision";

function listRequirements(db, tenantId, opts = {}, { async: isAsync = false } = {}) {
  const { limit, offset, page, pageSize } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  const clauses = ["tenant_id = ?", "status NOT IN ('OBSOLETE','WITHDRAWN')"];
  const params = [Number(tenantId)];
  if (opts.requirementId != null && String(opts.requirementId).trim() !== "") {
    clauses.push("id = ?");
    params.push(Number(opts.requirementId) || -1);
  }
  if (opts.criticality) {
    clauses.push("upper(criticality) = ?");
    params.push(String(opts.criticality).toUpperCase());
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const sqlRows = `SELECT ${REQUIREMENT_COLUMNS} FROM requirements ${where} ORDER BY id DESC LIMIT ? OFFSET ?`;
  const sqlCount = `SELECT COUNT(*) AS c FROM requirements ${where}`;
  if (isAsync) {
    return Promise.all([queryAllAsync(db, sqlRows, [...params, limit, offset]), queryOneAsync(db, sqlCount, params)]).then(([rows, total]) => ({
      rows,
      total: Number(total?.c || 0),
      page,
      pageSize,
    }));
  }
  return { rows: queryAll(db, sqlRows, [...params, limit, offset]), total: Number(queryOne(db, sqlCount, params)?.c || 0), page, pageSize };
}

const ALLOCATIONS_SQL = `
  SELECT source_id, target_type, target_id, relationship_type
    FROM requirement_relationships
   WHERE tenant_id = ? AND status = 'ACTIVE' AND source_type = ?
     AND relationship_type IN (${placeholders(ALLOCATION_CODES)})
     AND source_id IN (%s)
   LIMIT ${MAX_ROWS}`;

function allocationsForRequirements(db, tenantId, ids, { async: isAsync = false } = {}) {
  if (!ids.length) return isAsync ? Promise.resolve([]) : [];
  if (isAsync) {
    return Promise.all(
      chunk(ids).map((batch) => queryAllAsync(db, ALLOCATIONS_SQL.replace("%s", placeholders(batch)), [Number(tenantId), REQUIREMENT_SOURCE_TYPE, ...ALLOCATION_CODES, ...batch.map(String)]))
    ).then((results) => results.flat());
  }
  return chunk(ids).flatMap((batch) => queryAll(db, ALLOCATIONS_SQL.replace("%s", placeholders(batch)), [Number(tenantId), REQUIREMENT_SOURCE_TYPE, ...ALLOCATION_CODES, ...batch.map(String)]));
}

const CHARACTERISTICS_SQL = `SELECT id, metadata_json FROM cla_characteristics WHERE tenant_id = ? AND id IN (%s)`;

function characteristicsForTargets(db, tenantId, ids, { async: isAsync = false } = {}) {
  const numeric = uniqueNumbers(ids);
  if (!numeric.length) return isAsync ? Promise.resolve(new Map()) : new Map();
  const loader = (batch) => (isAsync ? queryAllAsync(db, CHARACTERISTICS_SQL.replace("%s", placeholders(batch)), [Number(tenantId), ...batch]) : queryAll(db, CHARACTERISTICS_SQL.replace("%s", placeholders(batch)), [Number(tenantId), ...batch]));
  if (isAsync) {
    return Promise.all(chunk(numeric).map(loader)).then((results) => {
      const map = new Map();
      for (const rows of results) for (const row of rows) map.set(String(row.id), { ctq: Boolean(parseMetadata(row).ctq) });
      return map;
    });
  }
  const map = new Map();
  for (const batch of chunk(numeric)) for (const row of loader(batch)) map.set(String(row.id), { ctq: Boolean(parseMetadata(row).ctq) });
  return map;
}

function columnFor(targetType, target, ctqByTarget) {
  switch (String(targetType || "").toLowerCase()) {
    case "pdm_item":
    case "pdm_revision":
      return "product";
    case "bom_revision": {
      const bomType = String(target?.bom_type || "").toUpperCase();
      if (bomType === "EBOM") return "ebom";
      if (bomType === "MBOM") return "mbom";
      if (bomType === "BOP") return "bop";
      return "other";
    }
    case "operation":
      return "operation";
    case "work_center":
      return "work_center";
    case "characteristic":
      return ctqByTarget.get(String(target?.target_id ?? ""))?.ctq ? "ctq" : "characteristic";
    case "content":
      return "document";
    default:
      return "other";
  }
}

function emptyColumns() {
  return { product: [], ebom: [], mbom: [], bop: [], operation: [], work_center: [], characteristic: [], ctq: [], document: [], other: [] };
}

function targetColumns(allocations, ctqByTarget) {
  const columns = emptyColumns();
  for (const allocation of allocations) {
    const column = columnFor(allocation.target_type, { ...allocation.target, target_id: allocation.target_id }, ctqByTarget);
    if (column && columns[column]) columns[column].push(allocation.target);
  }
  return columns;
}

function evaluateRules(columns, rules) {
  const has = (key) => (columns[key] || []).length > 0;
  const implemented = has("ebom") || has("mbom") || has("bop") || has("operation") || has("work_center");
  const checks = {
    REQUIREMENT_IMPLEMENTATION: { met: implemented, column: "manufacturing_implementation" },
    CTQ_COVERAGE: { met: has("ctq"), column: "ctq" },
    EBOM_MBOM_MAPPING: { met: !has("mbom") || has("ebom"), column: "ebom" },
    MBOM_BOP_ASSIGNMENT: { met: !has("mbom") || has("bop"), column: "bop" },
  };
  const evaluation = [];
  for (const rule of RULE_TOKENS) {
    const category = rules[rule];
    if (!category || category === "FORBIDDEN") continue;
    const check = checks[rule];
    if (!check) continue;
    evaluation.push({ rule, category, severity: severityFor(category), met: check.met, column: check.column });
  }
  return evaluation;
}

function coverageStatus(columns, evaluation) {
  const anyColumn = Object.values(columns).some((list) => list.length > 0);
  if (!anyColumn) return "UNALLOCATED";
  if (evaluation.some((entry) => entry.category === "MUST" && !entry.met)) return "GAP";
  if (evaluation.some((entry) => entry.category === "SHOULD" && !entry.met)) return "PARTIAL";
  return "COVERED";
}

function buildMatrixRow(requirementRow, allocations, ctqByTarget, rules) {
  const columns = targetColumns(allocations, ctqByTarget);
  const evaluation = evaluateRules(columns, rules);
  const status = coverageStatus(columns, evaluation);
  const counts = Object.fromEntries(Object.entries(columns).map(([key, list]) => [key, list.length]));
  return {
    requirement: requirementDescriptor(requirementRow),
    columns,
    counts,
    coverage_status: status,
    rule_results: evaluation.map((entry) => ({ rule: entry.rule, category: entry.category, severity: entry.severity, met: entry.met })),
    gaps: evaluation
      .filter((entry) => !entry.met)
      .map((entry) => ({ rule: entry.rule, category: entry.category, severity: entry.severity, column: entry.column, status: GAP_STATUS })),
  };
}

function summarizeRows(rows) {
  const summary = Object.fromEntries(COVERAGE_STATUSES.map((status) => [status, 0]));
  for (const row of rows) summary[row.coverage_status] = (summary[row.coverage_status] || 0) + 1;
  const total = rows.length;
  summary.requirements = total;
  summary.coverage_pct = total ? Math.round(((summary.COVERED + summary.PARTIAL * 0.5) / total) * 1000) / 10 : 100;
  return summary;
}

// ── Manufacturing matrix ─────────────────────────────────────────────────────

export function manufacturingMatrix(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const rules = coverageRules(db, tenant);
  const { rows, total, page, pageSize } = listRequirements(db, tenant, opts);
  const ids = rows.map((row) => row.id);
  const allocations = allocationsForRequirements(db, tenant, ids);
  const ctqByTarget = characteristicsForTargets(db, tenant, allocations.filter((a) => String(a.target_type).toLowerCase() === "characteristic").map((a) => a.target_id));
  const byRequirement = new Map();
  for (const allocation of allocations) {
    if (!byRequirement.has(Number(allocation.source_id))) byRequirement.set(Number(allocation.source_id), []);
    const list = byRequirement.get(Number(allocation.source_id));
    list.push({ ...allocation, target: resolveTarget(db, tenant, allocation.target_type, allocation.target_id) || { target_type: allocation.target_type, target_id: allocation.target_id, missing: true } });
  }
  const items = rows.map((row) => buildMatrixRow(row, byRequirement.get(Number(row.id)) || [], ctqByTarget, rules));
  return {
    items,
    total,
    page,
    page_size: pageSize,
    columns: ["product", "ebom", "mbom", "bop", "operation", "work_center", "characteristic", "ctq", "document"],
    rules,
    summary: summarizeRows(items),
    source_module: "requirement-manufacturing",
  };
}

export async function manufacturingMatrixAsync(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const rules = coverageRules(db, tenant);
  const { rows, total, page, pageSize } = await listRequirements(db, tenant, opts, { async: true });
  const ids = rows.map((row) => row.id);
  const allocations = await allocationsForRequirements(db, tenant, ids, { async: true });
  const ctqByTarget = await characteristicsForTargets(db, tenant, allocations.filter((a) => String(a.target_type).toLowerCase() === "characteristic").map((a) => a.target_id), { async: true });
  const byRequirement = new Map();
  for (const allocation of allocations) {
    if (!byRequirement.has(Number(allocation.source_id))) byRequirement.set(Number(allocation.source_id), []);
    const list = byRequirement.get(Number(allocation.source_id));
    list.push({ ...allocation, target: (await resolveTargetAsync(db, tenant, allocation.target_type, allocation.target_id)) || { target_type: allocation.target_type, target_id: allocation.target_id, missing: true } });
  }
  const items = rows.map((row) => buildMatrixRow(row, byRequirement.get(Number(row.id)) || [], ctqByTarget, rules));
  return {
    items,
    total,
    page,
    page_size: pageSize,
    columns: ["product", "ebom", "mbom", "bop", "operation", "work_center", "characteristic", "ctq", "document"],
    rules,
    summary: summarizeRows(items),
    source_module: "requirement-manufacturing",
  };
}

// ── Coverage aggregate ───────────────────────────────────────────────────────

function requirementCoverageSummary(db, tenantId, { async: isAsync = false } = {}) {
  const rules = coverageRules(db, tenantId);
  const scope = listRequirements(db, tenantId, { page: 1, pageSize: MAX_PAGE_SIZE }, { async: isAsync });
  const finish = (result, allocations, ctqByTarget) => {
    const byRequirement = new Map();
    for (const allocation of allocations) {
      if (!byRequirement.has(Number(allocation.source_id))) byRequirement.set(Number(allocation.source_id), []);
      byRequirement.get(Number(allocation.source_id)).push(allocation);
    }
    const rows = result.rows.map((row) => buildMatrixRow(row, byRequirement.get(Number(row.id)) || [], ctqByTarget, rules));
    return summarizeRows(rows);
  };
  if (isAsync) {
    return Promise.resolve(scope).then(async (result) => {
      const allocations = await allocationsForRequirements(db, tenantId, result.rows.map((row) => row.id), { async: true });
      const ctqByTarget = await characteristicsForTargets(db, tenantId, allocations.filter((a) => String(a.target_type).toLowerCase() === "characteristic").map((a) => a.target_id), { async: true });
      return finish(result, allocations, ctqByTarget);
    });
  }
  const result = scope;
  const allocations = allocationsForRequirements(db, tenantId, result.rows.map((row) => row.id));
  const ctqByTarget = characteristicsForTargets(db, tenantId, allocations.filter((a) => String(a.target_type).toLowerCase() === "characteristic").map((a) => a.target_id));
  return finish(result, allocations, ctqByTarget);
}

export function manufacturingCoverage(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const requirements = requirementCoverageSummary(db, tenant);
  const ctq = ctqCoverage(db, tenant, opts);
  return {
    requirements,
    ctq: {
      total: ctq.summary.ctq_total,
      with_requirement: ctq.summary.ctq_with_requirement,
      without_requirement: ctq.summary.ctq_without_requirement,
      with_operation: ctq.summary.ctq_with_operation,
      without_operation: ctq.summary.ctq_without_operation,
    },
    overall_coverage: requirements.coverage_pct,
    source_module: "requirement-manufacturing",
  };
}

export async function manufacturingCoverageAsync(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const [requirements, ctq] = await Promise.all([requirementCoverageSummary(db, tenant, { async: true }), ctqCoverageAsync(db, tenant, opts)]);
  return {
    requirements,
    ctq: {
      total: ctq.summary.ctq_total,
      with_requirement: ctq.summary.ctq_with_requirement,
      without_requirement: ctq.summary.ctq_without_requirement,
      with_operation: ctq.summary.ctq_with_operation,
      without_operation: ctq.summary.ctq_without_operation,
    },
    overall_coverage: requirements.coverage_pct,
    source_module: "requirement-manufacturing",
  };
}

// ── Gap analysis ─────────────────────────────────────────────────────────────

function enabledRules(rules, requested) {
  const allow = requested ? new Set(requested.map((rule) => String(rule).toUpperCase())) : null;
  return RULE_TOKENS.filter((rule) => rules[rule] && rules[rule] !== "FORBIDDEN" && (!allow || allow.has(rule)));
}

const MBOM_REVISIONS_SQL = `
  SELECT br.id, br.revision_ref, br.revision_number, br.status, bh.id AS bom_id, bh.bom_number, bh.name
    FROM bom_revisions br
    JOIN bom_headers bh ON bh.id = br.bom_id
   WHERE br.tenant_id = ? AND bh.bom_type = 'MBOM'
   ORDER BY br.id DESC LIMIT ?`;

function requirementGaps(db, tenantId, rules, enabled, filterId = null) {
  const scope = listRequirements(db, tenantId, { page: 1, pageSize: MAX_PAGE_SIZE });
  const rows = filterId === null ? scope.rows : scope.rows.filter((row) => Number(row.id) === Number(filterId));
  const allocations = allocationsForRequirements(db, tenantId, rows.map((row) => row.id));
  const ctqByTarget = characteristicsForTargets(db, tenantId, allocations.filter((a) => String(a.target_type).toLowerCase() === "characteristic").map((a) => a.target_id));
  const byRequirement = new Map();
  for (const allocation of allocations) {
    if (!byRequirement.has(Number(allocation.source_id))) byRequirement.set(Number(allocation.source_id), []);
    byRequirement.get(Number(allocation.source_id)).push({ ...allocation, target: resolveTarget(db, tenantId, allocation.target_type, allocation.target_id) || {} });
  }
  const items = [];
  for (const row of rows) {
    const built = buildMatrixRow(row, byRequirement.get(Number(row.id)) || [], ctqByTarget, rules);
    for (const gap of built.gaps) {
      if (!enabled.includes(gap.rule)) continue;
      items.push({ rule: gap.rule, category: gap.category, severity: gap.severity, object: { type: "requirement", id: row.id, ref: row.requirement_ref, number: row.requirement_number }, column: gap.column, status: GAP_STATUS });
    }
  }
  return items;
}

async function requirementGapsAsync(db, tenantId, rules, enabled, filterId = null) {
  const scope = await listRequirements(db, tenantId, { page: 1, pageSize: MAX_PAGE_SIZE }, { async: true });
  const rows = filterId === null ? scope.rows : scope.rows.filter((row) => Number(row.id) === Number(filterId));
  const allocations = await allocationsForRequirements(db, tenantId, rows.map((row) => row.id), { async: true });
  const ctqByTarget = await characteristicsForTargets(db, tenantId, allocations.filter((a) => String(a.target_type).toLowerCase() === "characteristic").map((a) => a.target_id), { async: true });
  const byRequirement = new Map();
  for (const allocation of allocations) {
    if (!byRequirement.has(Number(allocation.source_id))) byRequirement.set(Number(allocation.source_id), []);
    byRequirement.get(Number(allocation.source_id)).push({ ...allocation, target: (await resolveTargetAsync(db, tenantId, allocation.target_type, allocation.target_id)) || {} });
  }
  const items = [];
  for (const row of rows) {
    const built = buildMatrixRow(row, byRequirement.get(Number(row.id)) || [], ctqByTarget, rules);
    for (const gap of built.gaps) {
      if (!enabled.includes(gap.rule)) continue;
      items.push({ rule: gap.rule, category: gap.category, severity: gap.severity, object: { type: "requirement", id: row.id, ref: row.requirement_ref, number: row.requirement_number }, column: gap.column, status: GAP_STATUS });
    }
  }
  return items;
}

function mbomRevisionGapItems(revision, bops, sources) {
  const items = [];
  if ((bops.total || 0) === 0) {
    items.push({ rule: "MBOM_BOP_ASSIGNMENT", category: "SHOULD", severity: "WARNING", object: { type: "bom_revision", id: revision.id, ref: revision.revision_ref, number: revision.revision_number, bom_number: revision.bom_number }, column: "bop", status: GAP_STATUS });
  }
  const unmapped = Number(sources.summary?.unlinked_target_items || 0) + Number(sources.summary?.invalid || 0);
  if (unmapped > 0) {
    items.push({ rule: "EBOM_MBOM_MAPPING", category: "MUST", severity: "ERROR", object: { type: "bom_revision", id: revision.id, ref: revision.revision_ref, number: revision.revision_number, bom_number: revision.bom_number }, column: "ebom", status: GAP_STATUS, unmapped_items: unmapped });
  }
  return items;
}

function mbomMappingGaps(db, tenantId, limit) {
  const revisions = queryAll(db, MBOM_REVISIONS_SQL, [Number(tenantId), limit]);
  const items = [];
  for (const revision of revisions) {
    const bops = listMbomBops(db, tenantId, revision.id, { page: 1, pageSize: 1 });
    const sources = mbomEbomSources(db, tenantId, revision.id, { page: 1, pageSize: MAX_PAGE_SIZE });
    items.push(...mbomRevisionGapItems(revision, bops, sources));
  }
  return items;
}

async function mbomMappingGapsAsync(db, tenantId, limit) {
  const revisions = await queryAllAsync(db, MBOM_REVISIONS_SQL, [Number(tenantId), limit]);
  const items = [];
  for (const revision of revisions) {
    const [bops, sources] = await Promise.all([
      listMbomBopsAsync(db, tenantId, revision.id, { page: 1, pageSize: 1 }),
      mbomEbomSourcesAsync(db, tenantId, revision.id, { page: 1, pageSize: MAX_PAGE_SIZE }),
    ]);
    items.push(...mbomRevisionGapItems(revision, bops, sources));
  }
  return items;
}

function ctqGaps(db, tenantId, opts, { async: isAsync = false } = {}) {
  const report = isAsync ? ctqCoverageAsync(db, tenantId, opts) : ctqCoverage(db, tenantId, opts);
  const finish = (result) => {
    const items = [];
    for (const ctq of result.ctq_without_requirement || []) {
      items.push({ rule: "CTQ_COVERAGE", category: "SHOULD", severity: "WARNING", object: { type: "characteristic", id: ctq.characteristic_id, ref: ctq.characteristic_ref, code: ctq.code }, column: "requirement", status: GAP_STATUS });
    }
    for (const ctq of result.ctq_without_operation || []) {
      items.push({ rule: "CTQ_COVERAGE", category: "SHOULD", severity: "WARNING", object: { type: "characteristic", id: ctq.characteristic_id, ref: ctq.characteristic_ref, code: ctq.code }, column: "operation", status: GAP_STATUS });
    }
    for (const req of result.requirements_missing_ctq || []) {
      items.push({ rule: "CTQ_COVERAGE", category: "SHOULD", severity: "WARNING", object: { type: "requirement", id: req.requirement_id, ref: req.requirement_ref, number: req.requirement_number }, column: "ctq", status: GAP_STATUS });
    }
    return items;
  };
  return isAsync ? Promise.resolve(report).then(finish) : finish(report);
}

function paginateGaps(items, opts) {
  const { limit, offset, page, pageSize } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
  return { items: items.slice(offset, offset + limit), total: items.length, page, page_size: pageSize };
}

function summarizeGaps(items) {
  const byRule = {};
  const bySeverity = {};
  for (const item of items) {
    byRule[item.rule] = (byRule[item.rule] || 0) + 1;
    bySeverity[item.severity] = (bySeverity[item.severity] || 0) + 1;
  }
  return { total: items.length, by_rule: byRule, by_severity: bySeverity };
}

export function manufacturingGaps(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const rules = coverageRules(db, tenant);
  const enabled = enabledRules(rules, opts.rules);
  const filterId = opts.requirementId ?? opts.requirement_id ?? null;
  const limit = Math.min(Number(opts.mbomScanLimit) || DEFAULT_MBOM_SCAN, MAX_PAGE_SIZE * 40);
  const items = [
    ...requirementGaps(db, tenant, rules, enabled, filterId),
    ...(filterId === null && (enabled.includes("MBOM_BOP_ASSIGNMENT") || enabled.includes("EBOM_MBOM_MAPPING")) ? mbomMappingGaps(db, tenant, limit) : []),
    ...(filterId === null && enabled.includes("CTQ_COVERAGE") ? ctqGaps(db, tenant, opts) : []),
  ];
  const paged = paginateGaps(items, opts);
  return { items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, rules, enabled_rules: enabled, summary: summarizeGaps(items), source_module: "requirement-manufacturing" };
}

export async function manufacturingGapsAsync(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const rules = coverageRules(db, tenant);
  const enabled = enabledRules(rules, opts.rules);
  const filterId = opts.requirementId ?? opts.requirement_id ?? null;
  const limit = Math.min(Number(opts.mbomScanLimit) || DEFAULT_MBOM_SCAN, MAX_PAGE_SIZE * 40);
  const parts = [await requirementGapsAsync(db, tenant, rules, enabled, filterId)];
  if (filterId === null && (enabled.includes("MBOM_BOP_ASSIGNMENT") || enabled.includes("EBOM_MBOM_MAPPING"))) parts.push(await mbomMappingGapsAsync(db, tenant, limit));
  if (filterId === null && enabled.includes("CTQ_COVERAGE")) parts.push(await ctqGaps(db, tenant, opts, { async: true }));
  const items = parts.flat();
  const paged = paginateGaps(items, opts);
  return { items: paged.items, total: paged.total, page: paged.page, page_size: paged.page_size, rules, enabled_rules: enabled, summary: summarizeGaps(items), source_module: "requirement-manufacturing" };
}

// ── Bidirectional navigation (delegates to the Digital Thread) ───────────────

// Bidirectional navigation accepts the requirement side plus every
// manufacturing target node type the Digital Thread can resolve.
const NAVIGATION_TYPES = Object.freeze([REQUIREMENT_SOURCE_TYPE, ...TARGET_NODE_TYPES]);

function assertNavigationType(objectType) {
  const type = String(objectType || "").toLowerCase();
  if (!NAVIGATION_TYPES.includes(type)) {
    throw invalidTarget(`Unsupported manufacturing navigation type: ${objectType}`, { object_type: objectType, allowed: NAVIGATION_TYPES });
  }
  return type;
}

// Manufacturing traceability is a design-time view: draft requirements and
// structures are expected, so inactive nodes are included unless the caller
// explicitly opts out. Callers may pass a boolean or a query-style string.
function navigationParams(params = {}) {
  const raw = params.includeInactive ?? params.include_inactive;
  const includeInactive = raw === undefined ? true : !(raw === false || raw === "false" || raw === "0" || raw === 0);
  return { ...params, includeInactive };
}

export function manufacturingTrace(db, tenantId, params = {}, actor = null) {
  assertNavigationType(params.objectType ?? params.object_type);
  const options = navigationParams(params);
  const direction = String(params.direction || "forward").toLowerCase();
  return direction === "backward"
    ? TraceabilityService.backward(db, tenantId, options, actor)
    : TraceabilityService.forward(db, tenantId, options, actor);
}

export function manufacturingTraceAsync(db, tenantId, params = {}, actor = null) {
  assertNavigationType(params.objectType ?? params.object_type);
  const options = navigationParams(params);
  const direction = String(params.direction || "forward").toLowerCase();
  return direction === "backward"
    ? TraceabilityService.backwardAsync(db, tenantId, options, actor)
    : TraceabilityService.forwardAsync(db, tenantId, options, actor);
}

export function manufacturingTraceMatrix(db, tenantId, params = {}, actor = null) {
  assertNavigationType(params.objectType ?? params.object_type);
  return TraceabilityService.matrix(db, tenantId, navigationParams(params), actor);
}

export function manufacturingTraceMatrixAsync(db, tenantId, params = {}, actor = null) {
  assertNavigationType(params.objectType ?? params.object_type);
  return TraceabilityService.matrixAsync(db, tenantId, navigationParams(params), actor);
}

export { COVERAGE_STATUSES as MANUFACTURING_COVERAGE_STATUSES, GAP_STATUS };

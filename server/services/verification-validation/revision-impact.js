// Revision, configuration & change impact for the V&V Engine.
//
// Executions pin the exact requirement / test case / procedure revision they
// ran. When a definition or requirement is revised, previously recorded evidence
// may no longer apply. This service reports that applicability and flags
// potentially stale evidence WITHOUT deleting history and WITHOUT auto-invalidating
// every execution (spec §13): it only writes a flag into the execution's metadata
// and publishes `VerificationEvidenceInvalidated`, leaving any formal review/retest
// to the existing workflow / retest seams.
//
// Impact itself is not a second engine: it reuses the Digital Thread impact
// traversal, which (thanks to the V&V thread provider) now reaches the
// TestCase -> Procedure -> Execution -> Result -> Evidence chain, then classifies
// the affected nodes.
import { queryAll, queryOne, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { parseArray, parseObject, paginate } from "../data-lifecycle/validation.js";
import { updateRow, updateRowAsync, bumpVersion } from "../requirements/sql.js";
import { Requirements as RequirementService } from "../requirements/index.js";
import { Impact as ThreadImpact, Traversal as ThreadTraversal } from "../thread/index.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { publishVvEvent, publishVvEventAsync } from "./events.js";
import { getConfig, getConfigAsync } from "./configuration.js";
import { requireExecutionRow, requireExecutionRowAsync } from "./test-executions.js";
import { SOURCE_MODULE, VV_NODE_TYPES, VV_EVENT_MAP } from "./constants.js";
import { requirementNotFound } from "./errors.js";

export const APPLICABILITY_STATUSES = Object.freeze(["APPLICABLE", "STALE", "UNKNOWN"]);
export const APPLICABILITY_REASONS = Object.freeze(["revision_changed", "configuration_mismatch", "no_pinned_revision"]);

const VV_IMPACT_CATEGORIES = Object.freeze(["TEST_CASE", "TEST_PROCEDURE", "TEST_EXECUTION", "TEST_RESULT", "WAIVER", "EVIDENCE", "OTHER"]);
const RELEASED_STATES = new Set(["RELEASED", "APPROVED", "ISSUED", "PRODUCTION"]);

function upper(value) {
  return String(value || "").toUpperCase();
}

function text(value) {
  return String(value ?? "").trim();
}

// ── Pure revision / configuration applicability ───────────────────────────────

// Compare a set of pinned references (`pins`) against the current revisions and
// configuration (`current`). Pure and DB-free so it is exhaustively unit-testable.
// A blank pin or blank current revision is UNKNOWN (we cannot judge), never STALE.
export function assessRevisionApplicability(pins = {}, current = {}) {
  const reasons = [];
  const checks = [];
  const compareRevision = (label, pinnedValue, currentValue) => {
    const pinned = text(pinnedValue);
    const currentText = text(currentValue);
    if (!pinned || !currentText) {
      checks.push({ label, status: "UNKNOWN", pinned, current: currentText });
      return;
    }
    if (pinned === currentText) {
      checks.push({ label, status: "APPLICABLE", pinned, current: currentText });
      return;
    }
    checks.push({ label, status: "STALE", pinned, current: currentText });
    reasons.push("revision_changed");
  };

  compareRevision("test_case_revision", pins.test_case_revision, current.test_case_revision);
  compareRevision("procedure_revision", pins.procedure_revision, current.procedure_revision);
  compareRevision("requirement_revision", pins.requirement_revision, current.requirement_revision);

  const pinnedConfig = text(pins.configuration_context);
  const currentConfig = text(current.configuration);
  if (pinnedConfig && currentConfig && pinnedConfig.toUpperCase() !== currentConfig.toUpperCase()) {
    checks.push({ label: "configuration", status: "STALE", pinned: pinnedConfig, current: currentConfig });
    reasons.push("configuration_mismatch");
  }

  const judged = checks.filter((check) => check.status !== "UNKNOWN");
  const uniqueReasons = [...new Set(reasons)];
  let status = "APPLICABLE";
  if (judged.some((check) => check.status === "STALE")) status = "STALE";
  else if (judged.length === 0) status = "UNKNOWN";
  return { status, stale: status === "STALE", reasons: uniqueReasons, checks };
}

// ── Data access ───────────────────────────────────────────────────────────────

function currentTestCases(db, tenant, ids) {
  const map = new Map();
  const list = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (!list.length) return map;
  const placeholders = list.map(() => "?").join(", ");
  for (const row of queryAll(db, `SELECT id, revision, status FROM vv_test_cases WHERE tenant_id = ? AND id IN (${placeholders})`, [tenant, ...list])) map.set(String(row.id), row);
  return map;
}

async function currentTestCasesAsync(db, tenant, ids) {
  const map = new Map();
  const list = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (!list.length) return map;
  const placeholders = list.map(() => "?").join(", ");
  const rows = await queryAllAsync(db, `SELECT id, revision, status FROM vv_test_cases WHERE tenant_id = ? AND id IN (${placeholders})`, [tenant, ...list]);
  for (const row of rows) map.set(String(row.id), row);
  return map;
}

function currentProcedures(db, tenant, ids) {
  const map = new Map();
  const list = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (!list.length) return map;
  const placeholders = list.map(() => "?").join(", ");
  for (const row of queryAll(db, `SELECT id, revision, status FROM vv_test_procedures WHERE tenant_id = ? AND id IN (${placeholders})`, [tenant, ...list])) map.set(String(row.id), row);
  return map;
}

async function currentProceduresAsync(db, tenant, ids) {
  const map = new Map();
  const list = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (!list.length) return map;
  const placeholders = list.map(() => "?").join(", ");
  const rows = await queryAllAsync(db, `SELECT id, revision, status FROM vv_test_procedures WHERE tenant_id = ? AND id IN (${placeholders})`, [tenant, ...list]);
  for (const row of rows) map.set(String(row.id), row);
  return map;
}

// ── Per-execution applicability ───────────────────────────────────────────────

function executionApplicability(db, tenant, execution) {
  const testCase = execution.test_case_id ? currentTestCases(db, tenant, [Number(execution.test_case_id)]).get(String(execution.test_case_id)) : null;
  const procedure = execution.procedure_id ? currentProcedures(db, tenant, [Number(execution.procedure_id)]).get(String(execution.procedure_id)) : null;
  const requirementIds = parseArray(execution.requirement_ids_json, []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  const requirements = [];
  let latestRequirementRevision = "";
  for (const id of requirementIds) {
    const requirement = RequirementService.getRequirementRow(db, tenant, id);
    if (!requirement) continue;
    const resultRevisions = queryAll(db, "SELECT DISTINCT requirement_revision FROM vv_results WHERE tenant_id = ? AND execution_id = ? AND requirement_id = ? AND requirement_revision <> ''", [tenant, execution.id, id]).map((row) => row.requirement_revision);
    const pinnedRevision = resultRevisions[0] || "";
    const assessment = assessRevisionApplicability(
      { test_case_revision: execution.test_case_revision, procedure_revision: execution.procedure_revision, requirement_revision: pinnedRevision, configuration_context: execution.configuration_context },
      { test_case_revision: testCase?.revision, procedure_revision: procedure?.revision, requirement_revision: requirement.revision, configuration: execution.configuration_context }
    );
    requirements.push({ requirement_id: requirement.id, requirement_ref: requirement.requirement_ref, current_revision: requirement.revision, pinned_revision: pinnedRevision, ...assessment });
    if (requirement.revision) latestRequirementRevision = requirement.revision;
  }
  const base = assessRevisionApplicability(
    { test_case_revision: execution.test_case_revision, procedure_revision: execution.procedure_revision, configuration_context: execution.configuration_context },
    { test_case_revision: testCase?.revision, procedure_revision: procedure?.revision, configuration: execution.configuration_context }
  );
  const requirementStale = requirements.some((entry) => entry.stale);
  const reasons = [...new Set([...base.reasons, ...requirements.flatMap((entry) => entry.reasons)])];
  const status = base.stale || requirementStale ? "STALE" : base.status;
  return {
    execution_id: execution.id,
    execution_ref: execution.execution_ref,
    status,
    stale: status === "STALE",
    reasons,
    checks: base.checks,
    test_case: { id: execution.test_case_id, pinned_revision: execution.test_case_revision, current_revision: testCase?.revision || "" },
    procedure: { id: execution.procedure_id, pinned_revision: execution.procedure_revision, current_revision: procedure?.revision || "" },
    requirements,
    flagged: Boolean(parseObject(execution.metadata_json, {}).stale_evidence),
  };
}

async function executionApplicabilityAsync(db, tenant, execution) {
  const testCase = execution.test_case_id ? (await currentTestCasesAsync(db, tenant, [Number(execution.test_case_id)])).get(String(execution.test_case_id)) : null;
  const procedure = execution.procedure_id ? (await currentProceduresAsync(db, tenant, [Number(execution.procedure_id)])).get(String(execution.procedure_id)) : null;
  const requirementIds = parseArray(execution.requirement_ids_json, []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  const requirements = [];
  for (const id of requirementIds) {
    const requirement = await RequirementService.getRequirementRowAsync(db, tenant, id);
    if (!requirement) continue;
    const resultRows = await queryAllAsync(db, "SELECT DISTINCT requirement_revision FROM vv_results WHERE tenant_id = ? AND execution_id = ? AND requirement_id = ? AND requirement_revision <> ''", [tenant, execution.id, id]);
    const pinnedRevision = resultRows[0]?.requirement_revision || "";
    const assessment = assessRevisionApplicability(
      { test_case_revision: execution.test_case_revision, procedure_revision: execution.procedure_revision, requirement_revision: pinnedRevision, configuration_context: execution.configuration_context },
      { test_case_revision: testCase?.revision, procedure_revision: procedure?.revision, requirement_revision: requirement.revision, configuration: execution.configuration_context }
    );
    requirements.push({ requirement_id: requirement.id, requirement_ref: requirement.requirement_ref, current_revision: requirement.revision, pinned_revision: pinnedRevision, ...assessment });
  }
  const base = assessRevisionApplicability(
    { test_case_revision: execution.test_case_revision, procedure_revision: execution.procedure_revision, configuration_context: execution.configuration_context },
    { test_case_revision: testCase?.revision, procedure_revision: procedure?.revision, configuration: execution.configuration_context }
  );
  const requirementStale = requirements.some((entry) => entry.stale);
  const reasons = [...new Set([...base.reasons, ...requirements.flatMap((entry) => entry.reasons)])];
  const status = base.stale || requirementStale ? "STALE" : base.status;
  return {
    execution_id: execution.id,
    execution_ref: execution.execution_ref,
    status,
    stale: status === "STALE",
    reasons,
    checks: base.checks,
    test_case: { id: execution.test_case_id, pinned_revision: execution.test_case_revision, current_revision: testCase?.revision || "" },
    procedure: { id: execution.procedure_id, pinned_revision: execution.procedure_revision, current_revision: procedure?.revision || "" },
    requirements,
    flagged: Boolean(parseObject(execution.metadata_json, {}).stale_evidence),
  };
}

export function assessExecutionApplicability(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const execution = requireExecutionRow(db, tenant, ref);
  return { source_module: SOURCE_MODULE, ...executionApplicability(db, tenant, execution) };
}

export async function assessExecutionApplicabilityAsync(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const execution = await requireExecutionRowAsync(db, tenant, ref);
  return { source_module: SOURCE_MODULE, ...(await executionApplicabilityAsync(db, tenant, execution)) };
}

// ── Stale evidence discovery ─────────────────────────────────────────────────

// Optional scope that narrows the scan to the executions reached from one
// requirement. The subquery reuses the requirement -> test_case trace links and
// stays index friendly; the `~` guard keeps a malformed link from breaking the
// cast. When no requirement is supplied the scan stays tenant-wide.
function requirementScope(tenant, requirementId) {
  const id = requirementId === undefined || requirementId === null ? null : String(requirementId).trim();
  if (!id) return { clause: "", params: [] };
  return {
    clause:
      " AND e.test_case_id IN (SELECT CAST(target_id AS BIGINT) FROM requirement_relationships WHERE tenant_id = ? AND source_type = 'requirement' AND target_type = 'test_case' AND relationship_type IN ('VERIFIED_BY','VALIDATED_BY') AND target_id ~ '^[0-9]+$' AND source_id = ?)",
    params: [Number(tenant), id],
  };
}

// Executions whose pinned test-case/procedure revision no longer matches the
// current definition revision. The join is index-friendly (PK lookups) so this
// never full-scans `vv_executions`.
function staleCandidateRows(db, tenant, { limit, offset, requirementId }) {
  const scope = requirementScope(tenant, requirementId);
  return queryAll(
    db,
    `SELECT e.*, tc.revision AS current_test_case_revision, p.revision AS current_procedure_revision
       FROM vv_executions e
       LEFT JOIN vv_test_cases tc ON tc.id = e.test_case_id
       LEFT JOIN vv_test_procedures p ON p.id = e.procedure_id
      WHERE e.tenant_id = ?
        AND (
          (tc.id IS NOT NULL AND e.test_case_revision <> '' AND tc.revision <> e.test_case_revision)
          OR (p.id IS NOT NULL AND e.procedure_revision <> '' AND p.revision <> e.procedure_revision)
        )${scope.clause}
      ORDER BY e.id DESC LIMIT ? OFFSET ?`,
    [tenant, ...scope.params, limit, offset]
  );
}

async function staleCandidateRowsAsync(db, tenant, { limit, offset, requirementId }) {
  const scope = requirementScope(tenant, requirementId);
  return queryAllAsync(
    db,
    `SELECT e.*, tc.revision AS current_test_case_revision, p.revision AS current_procedure_revision
       FROM vv_executions e
       LEFT JOIN vv_test_cases tc ON tc.id = e.test_case_id
       LEFT JOIN vv_test_procedures p ON p.id = e.procedure_id
      WHERE e.tenant_id = ?
        AND (
          (tc.id IS NOT NULL AND e.test_case_revision <> '' AND tc.revision <> e.test_case_revision)
          OR (p.id IS NOT NULL AND e.procedure_revision <> '' AND p.revision <> e.procedure_revision)
        )${scope.clause}
      ORDER BY e.id DESC LIMIT ? OFFSET ?`,
    [tenant, ...scope.params, limit, offset]
  );
}

function staleCandidateCount(db, tenant, { requirementId } = {}) {
  const scope = requirementScope(tenant, requirementId);
  return Number(
    queryOne(
      db,
      `SELECT COUNT(*) AS c
         FROM vv_executions e
         LEFT JOIN vv_test_cases tc ON tc.id = e.test_case_id
         LEFT JOIN vv_test_procedures p ON p.id = e.procedure_id
        WHERE e.tenant_id = ?
          AND (
            (tc.id IS NOT NULL AND e.test_case_revision <> '' AND tc.revision <> e.test_case_revision)
            OR (p.id IS NOT NULL AND e.procedure_revision <> '' AND p.revision <> e.procedure_revision)
          )${scope.clause}`,
      [tenant, ...scope.params]
    )?.c || 0
  );
}

async function staleCandidateCountAsync(db, tenant, { requirementId } = {}) {
  const scope = requirementScope(tenant, requirementId);
  const row = await queryOneAsync(
    db,
    `SELECT COUNT(*) AS c
       FROM vv_executions e
       LEFT JOIN vv_test_cases tc ON tc.id = e.test_case_id
       LEFT JOIN vv_test_procedures p ON p.id = e.procedure_id
      WHERE e.tenant_id = ?
        AND (
          (tc.id IS NOT NULL AND e.test_case_revision <> '' AND tc.revision <> e.test_case_revision)
          OR (p.id IS NOT NULL AND e.procedure_revision <> '' AND p.revision <> e.procedure_revision)
        )${scope.clause}`,
    [tenant, ...scope.params]
  );
  return Number(row?.c || 0);
}

function staleItem(execution) {
  const metadata = parseObject(execution.metadata_json, {});
  return {
    execution_id: execution.id,
    execution_ref: execution.execution_ref,
    status: execution.status,
    overall_outcome: execution.overall_outcome || "",
    test_case_id: execution.test_case_id,
    test_case_revision: execution.test_case_revision,
    current_test_case_revision: execution.current_test_case_revision || "",
    procedure_id: execution.procedure_id,
    procedure_revision: execution.procedure_revision,
    current_procedure_revision: execution.current_procedure_revision || "",
    flagged: Boolean(metadata.stale_evidence),
    flagged_at: metadata.stale_evidence?.flagged_at || "",
    reasons: ["revision_changed"],
  };
}

export function listStaleEvidence(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 25, maxPageSize: 200 });
  const requirementId = opts.requirementId ?? opts.requirement_id ?? null;
  const rows = staleCandidateRows(db, tenant, { limit, offset, requirementId });
  const items = rows.map(staleItem);
  return { items, total: staleCandidateCount(db, tenant, { requirementId }), page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listStaleEvidenceAsync(db, tenantId, opts = {}) {
  const tenant = Number(tenantId);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 25, maxPageSize: 200 });
  const requirementId = opts.requirementId ?? opts.requirement_id ?? null;
  const rows = await staleCandidateRowsAsync(db, tenant, { limit, offset, requirementId });
  const items = rows.map(staleItem);
  return { items, total: await staleCandidateCountAsync(db, tenant, { requirementId }), page, page_size: limit, source_module: SOURCE_MODULE };
}

// ── Flagging (never deletes history) ─────────────────────────────────────────

function writeStaleFlag(db, execution, reason) {
  const metadata = parseObject(execution.metadata_json, {});
  metadata.stale_evidence = {
    flagged_at: nowIso(),
    reason: reason || "revision_changed",
    test_case_revision: execution.test_case_revision || "",
    procedure_revision: execution.procedure_revision || "",
  };
  updateRow(db, "vv_executions", execution.id, { metadata_json: JSON.stringify(metadata), version: bumpVersion(execution) });
  return metadata.stale_evidence;
}

async function writeStaleFlagAsync(db, execution, reason) {
  const metadata = parseObject(execution.metadata_json, {});
  metadata.stale_evidence = {
    flagged_at: nowIso(),
    reason: reason || "revision_changed",
    test_case_revision: execution.test_case_revision || "",
    procedure_revision: execution.procedure_revision || "",
  };
  await updateRowAsync(db, "vv_executions", execution.id, { metadata_json: JSON.stringify(metadata), version: bumpVersion(execution) });
  return metadata.stale_evidence;
}

export function flagStaleEvidence(db, tenantId, ref, { reason = "revision_changed", actor = null, ip = null } = {}) {
  const tenant = Number(tenantId);
  const execution = requireExecutionRow(db, tenant, ref);
  const assessment = executionApplicability(db, tenant, execution);
  const flag = writeStaleFlag(db, execution, reason);
  writeAudit(db, { actor, action: "verification-validation.stale-evidence.flag", resourceType: "vv_test_execution", resourceId: execution.execution_ref, details: { reasons: assessment.reasons, reason }, ip });
  publishVvEvent(db, { eventType: VV_EVENT_MAP.EVIDENCE_INVALIDATED, objectType: VV_NODE_TYPES.TEST_EXECUTION, objectId: String(execution.id), tenantId: tenant, organizationId: execution.organization_id, payload: { execution_ref: execution.execution_ref, reasons: assessment.reasons, reason } }, actor);
  return { source_module: SOURCE_MODULE, ...assessment, flagged: true, flag };
}

export async function flagStaleEvidenceAsync(db, tenantId, ref, { reason = "revision_changed", actor = null, ip = null } = {}) {
  const tenant = Number(tenantId);
  const execution = await requireExecutionRowAsync(db, tenant, ref);
  const assessment = await executionApplicabilityAsync(db, tenant, execution);
  const flag = await writeStaleFlagAsync(db, execution, reason);
  await writeAuditAsync(db, { actor, action: "verification-validation.stale-evidence.flag", resourceType: "vv_test_execution", resourceId: execution.execution_ref, details: { reasons: assessment.reasons, reason }, ip });
  await publishVvEventAsync(db, { eventType: VV_EVENT_MAP.EVIDENCE_INVALIDATED, objectType: VV_NODE_TYPES.TEST_EXECUTION, objectId: String(execution.id), tenantId: tenant, organizationId: execution.organization_id, payload: { execution_ref: execution.execution_ref, reasons: assessment.reasons, reason } }, actor);
  return { source_module: SOURCE_MODULE, ...assessment, flagged: true, flag };
}

// Batch scan. Honours `stale_evidence_on_revision_change` (detection on/off) and
// `auto_invalidate_evidence` (whether to persist the flag + publish the event).
// Defaults keep history intact: detection on, auto-invalidation off.
export function scanStaleEvidence(db, tenantId, opts = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  if (!getConfig(db, tenant, "stale_evidence_on_revision_change")) {
    return { source_module: SOURCE_MODULE, enabled: false, scanned: 0, stale: 0, flagged: 0, items: [] };
  }
  const autoInvalidate = Boolean(getConfig(db, tenant, "auto_invalidate_evidence"));
  const batchSize = Number(getConfig(db, tenant, "coverage_batch_size")) || 200;
  const limit = Math.max(1, Math.min(Number(opts.limit) || batchSize, 5000));
  const requirementId = opts.requirementId ?? opts.requirement_id ?? null;
  const rows = staleCandidateRows(db, tenant, { limit, offset: 0, requirementId });
  const items = [];
  let flagged = 0;
  for (const row of rows) {
    const item = staleItem(row);
    if (autoInvalidate) {
      writeStaleFlag(db, row, "revision_changed");
      publishVvEvent(db, { eventType: VV_EVENT_MAP.EVIDENCE_INVALIDATED, objectType: VV_NODE_TYPES.TEST_EXECUTION, objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { execution_ref: row.execution_ref, reasons: item.reasons } }, actor);
      item.flagged = true;
      item.flagged_at = nowIso();
      flagged += 1;
    }
    items.push(item);
  }
  return { source_module: SOURCE_MODULE, enabled: true, auto_invalidate: autoInvalidate, scanned: rows.length, stale: items.length, flagged, items };
}

export async function scanStaleEvidenceAsync(db, tenantId, opts = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  if (!(await getConfigAsync(db, tenant, "stale_evidence_on_revision_change"))) {
    return { source_module: SOURCE_MODULE, enabled: false, scanned: 0, stale: 0, flagged: 0, items: [] };
  }
  const autoInvalidate = Boolean(await getConfigAsync(db, tenant, "auto_invalidate_evidence"));
  const batchSize = Number(await getConfigAsync(db, tenant, "coverage_batch_size")) || 200;
  const limit = Math.max(1, Math.min(Number(opts.limit) || batchSize, 5000));
  const requirementId = opts.requirementId ?? opts.requirement_id ?? null;
  const rows = await staleCandidateRowsAsync(db, tenant, { limit, offset: 0, requirementId });
  const items = [];
  let flagged = 0;
  for (const row of rows) {
    const item = staleItem(row);
    if (autoInvalidate) {
      await writeStaleFlagAsync(db, row, "revision_changed");
      await publishVvEventAsync(db, { eventType: VV_EVENT_MAP.EVIDENCE_INVALIDATED, objectType: VV_NODE_TYPES.TEST_EXECUTION, objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { execution_ref: row.execution_ref, reasons: item.reasons } }, actor);
      item.flagged = true;
      item.flagged_at = nowIso();
      flagged += 1;
    }
    items.push(item);
  }
  return { source_module: SOURCE_MODULE, enabled: true, auto_invalidate: autoInvalidate, scanned: rows.length, stale: items.length, flagged, items };
}

// ── Change impact (reuses the Digital Thread engine) ─────────────────────────

function permissiveAuthorizer() {
  return {
    allowsNode: () => true,
    filter: (nodes) => nodes,
    allowsNodeAsync: async () => true,
    filterAsync: async (nodes) => nodes,
  };
}

function classifyNode(node) {
  const type = String(node.object_type || node.node_type || "").toLowerCase();
  switch (type) {
    case VV_NODE_TYPES.TEST_CASE:
      return "TEST_CASE";
    case VV_NODE_TYPES.TEST_PROCEDURE:
      return "TEST_PROCEDURE";
    case VV_NODE_TYPES.TEST_EXECUTION:
      return "TEST_EXECUTION";
    case VV_NODE_TYPES.TEST_RESULT:
      return "TEST_RESULT";
    case VV_NODE_TYPES.WAIVER:
      return "WAIVER";
    case "content":
      return "EVIDENCE";
    default:
      return "OTHER";
  }
}

function summarizeImpact(requirement, graph, options) {
  const items = [];
  const categoryTotals = Object.fromEntries(VV_IMPACT_CATEGORIES.map((code) => [code, 0]));
  let releasedCount = 0;
  let maxDepth = 0;
  for (const node of graph.nodes || []) {
    const depth = Number(node.depth || 0);
    if (depth === 0) continue;
    maxDepth = Math.max(maxDepth, depth);
    const category = classifyNode(node);
    categoryTotals[category] = (categoryTotals[category] || 0) + 1;
    const released = RELEASED_STATES.has(upper(node.lifecycle_state) || upper(node.status));
    if (released) releasedCount += 1;
    items.push({ node_ref: node.node_ref, object_type: String(node.object_type || node.node_type || "").toLowerCase(), object_id: node.object_id, display_name: node.display_name || "", revision: node.revision || "", lifecycle_state: node.lifecycle_state || "", depth, released, category });
  }
  return {
    requirement: { id: requirement.id, requirement_ref: requirement.requirement_ref, revision: requirement.revision || "", status: requirement.status || "" },
    root: `requirement:${requirement.object_id}`,
    impacted_count: items.length,
    node_count: Number(graph.node_count || items.length),
    edge_count: Number(graph.edge_count || 0),
    depth_reached: maxDepth,
    truncated: Boolean(graph.truncated),
    released_count: releasedCount,
    category_totals: categoryTotals,
    items,
    generated_at: nowIso(),
  };
}

function buildImpactOptions(db, tenant, options) {
  const maxDepth = Number(options.maxDepth ?? options.max_depth ?? getConfig(db, tenant, "impact_max_depth")) || 10;
  return { maxDepth, authorizer: options.authorizer || permissiveAuthorizer(), includeInactive: options.includeInactive ?? true, asOf: options.asOf || null };
}

export function analyzeRequirementImpact(db, tenantId, requirementRef, options = {}, _actor = null, _ip = null) {
  const tenant = Number(tenantId);
  const requirement = RequirementService.getRequirementRow(db, tenant, requirementRef);
  if (!requirement) throw requirementNotFound(requirementRef);
  if (!requirement.object_id) throw new Error("Requirement has no mirrored Object identity; run the requirement mirror first");
  const resolved = buildImpactOptions(db, tenant, options);
  const graph = ThreadImpact.impactAnalysis(db, tenant, { root: `requirement:${requirement.object_id}`, maxDepth: resolved.maxDepth, includeInactive: resolved.includeInactive, asOf: resolved.asOf, authorizer: resolved.authorizer }, _actor);
  return { source_module: SOURCE_MODULE, ...summarizeImpact(requirement, graph, resolved) };
}

export async function analyzeRequirementImpactAsync(db, tenantId, requirementRef, options = {}, _actor = null, _ip = null) {
  const tenant = Number(tenantId);
  const requirement = await RequirementService.getRequirementRowAsync(db, tenant, requirementRef);
  if (!requirement) throw requirementNotFound(requirementRef);
  if (!requirement.object_id) throw new Error("Requirement has no mirrored Object identity; run the requirement mirror first");
  const resolved = await buildImpactOptionsAsync(db, tenant, options);
  const graph = await ThreadImpact.impactAnalysisAsync(db, tenant, { root: `requirement:${requirement.object_id}`, maxDepth: resolved.maxDepth, includeInactive: resolved.includeInactive, asOf: resolved.asOf, authorizer: resolved.authorizer }, _actor);
  return { source_module: SOURCE_MODULE, ...summarizeImpact(requirement, graph, resolved) };
}

async function buildImpactOptionsAsync(db, tenant, options) {
  const maxDepth = Number(options.maxDepth ?? options.max_depth ?? (await getConfigAsync(db, tenant, "impact_max_depth"))) || 10;
  return { maxDepth, authorizer: options.authorizer || permissiveAuthorizer(), includeInactive: options.includeInactive ?? true, asOf: options.asOf || null };
}

// ── Forward / backward trace (reuses the Digital Thread traversal) ────────────
//
// `DOWNSTREAM` walks Requirement -> TestCase -> Procedure -> Execution ->
// Result -> Evidence; `UPSTREAM` walks the reverse. No second graph is built:
// the V&V thread provider feeds the shared traversal engine.
function normalizeTraceDirection(value) {
  const direction = upper(value || "DOWNSTREAM");
  return direction === "UPSTREAM" ? "UPSTREAM" : "DOWNSTREAM";
}

function traceRoot(requirement) {
  if (!requirement.object_id) throw new Error("Requirement has no mirrored Object identity; run the requirement mirror first");
  return `requirement:${requirement.object_id}`;
}

function summarizeTrace(requirement, direction, graph) {
  const nodes = (graph.nodes || []).map((node) => ({
    node_ref: node.node_ref,
    object_type: String(node.object_type || node.node_type || "").toLowerCase(),
    object_id: node.object_id,
    display_name: node.display_name || "",
    revision: node.revision || "",
    lifecycle_state: node.lifecycle_state || "",
    domain: node.domain || "",
    depth: Number(node.depth || 0),
    category: node.depth ? classifyNode(node) : "REQUIREMENT",
  }));
  const categoryTotals = Object.fromEntries(VV_IMPACT_CATEGORIES.map((code) => [code, 0]));
  for (const node of graph.nodes || []) {
    if (!node.depth) continue;
    const category = classifyNode(node);
    categoryTotals[category] = (categoryTotals[category] || 0) + 1;
  }
  return {
    requirement: { id: requirement.id, requirement_ref: requirement.requirement_ref, revision: requirement.revision || "", status: requirement.status || "" },
    root: traceRoot(requirement),
    direction,
    node_count: Number(graph.node_count || nodes.length),
    edge_count: Number(graph.edge_count || 0),
    depth_reached: Number(graph.depth_reached || 0),
    truncated: Boolean(graph.truncated),
    category_totals: categoryTotals,
    domains: graph.domains || [],
    nodes,
    edges: graph.edges || [],
    generated_at: nowIso(),
  };
}

function buildTraceOptions(db, tenant, options) {
  const maxDepth = Number(options.maxDepth ?? options.max_depth ?? getConfig(db, tenant, "impact_max_depth")) || 10;
  return { maxDepth, includeInactive: options.includeInactive ?? true, asOf: options.asOf || null };
}

async function buildTraceOptionsAsync(db, tenant, options) {
  const maxDepth = Number(options.maxDepth ?? options.max_depth ?? (await getConfigAsync(db, tenant, "impact_max_depth"))) || 10;
  return { maxDepth, includeInactive: options.includeInactive ?? true, asOf: options.asOf || null };
}

export function traceRequirement(db, tenantId, requirementRef, options = {}, actor = null) {
  const tenant = Number(tenantId);
  const requirement = RequirementService.getRequirementRow(db, tenant, requirementRef);
  if (!requirement) throw requirementNotFound(requirementRef);
  const direction = normalizeTraceDirection(options.direction);
  const resolved = buildTraceOptions(db, tenant, options);
  const graph = ThreadTraversal.traverseThread(db, tenant, { root: traceRoot(requirement), direction, maxDepth: resolved.maxDepth, includeInactive: resolved.includeInactive, asOf: resolved.asOf }, actor);
  return { source_module: SOURCE_MODULE, ...summarizeTrace(requirement, direction, graph) };
}

export async function traceRequirementAsync(db, tenantId, requirementRef, options = {}, actor = null) {
  const tenant = Number(tenantId);
  const requirement = await RequirementService.getRequirementRowAsync(db, tenant, requirementRef);
  if (!requirement) throw requirementNotFound(requirementRef);
  const direction = normalizeTraceDirection(options.direction);
  const resolved = await buildTraceOptionsAsync(db, tenant, options);
  const graph = await ThreadTraversal.traverseThreadAsync(db, tenant, { root: traceRoot(requirement), direction, maxDepth: resolved.maxDepth, includeInactive: resolved.includeInactive, asOf: resolved.asOf }, actor);
  return { source_module: SOURCE_MODULE, ...summarizeTrace(requirement, direction, graph) };
}

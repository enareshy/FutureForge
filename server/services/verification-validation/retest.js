// Retest service.
//
// A retest never overwrites the original attempt: it creates a new execution that
// points at the failed one through `previous_execution_id` (owned by
// `test-executions.js`). This module adds the configurable retest policy and the
// retest-chain/plan views the UI and jobs need, so callers can see what to rerun
// and can navigate the full history of attempts.
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { getConfig, getConfigAsync } from "./configuration.js";
import { requireExecutionRow, requireExecutionRowAsync, requestRetest, requestRetestAsync, publicExecution } from "./test-executions.js";
import { RETEST_POLICIES, SOURCE_MODULE } from "./constants.js";
import { invalidVv } from "./errors.js";

export function resolveRetestPolicy(db, tenantId, override = null) {
  const policy = String(override ?? getConfig(db, tenantId, "retest_policy") ?? "FULL_TEST").toUpperCase();
  if (!RETEST_POLICIES.includes(policy)) throw invalidVv(`Invalid retest policy: ${policy}`, { allowed: [...RETEST_POLICIES] });
  return policy;
}

export async function resolveRetestPolicyAsync(db, tenantId, override = null) {
  const policy = String(override ?? (await getConfigAsync(db, tenantId, "retest_policy")) ?? "FULL_TEST").toUpperCase();
  if (!RETEST_POLICIES.includes(policy)) throw invalidVv(`Invalid retest policy: ${policy}`, { allowed: [...RETEST_POLICIES] });
  return policy;
}

function failedResults(db, tenantId, executionId) {
  return queryAll(db, "SELECT * FROM vv_results WHERE tenant_id = ? AND execution_id = ? AND outcome = 'FAIL' ORDER BY id", [Number(tenantId), Number(executionId)]);
}

async function failedResultsAsync(db, tenantId, executionId) {
  return queryAllAsync(db, "SELECT * FROM vv_results WHERE tenant_id = ? AND execution_id = ? AND outcome = 'FAIL' ORDER BY id", [Number(tenantId), Number(executionId)]);
}

function ancestors(db, tenantId, row) {
  const chain = [];
  let cursor = row.previous_execution_id ? queryOne(db, "SELECT * FROM vv_executions WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(row.previous_execution_id)]) : null;
  const guard = new Set();
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    chain.push(publicExecution(cursor));
    cursor = cursor.previous_execution_id ? queryOne(db, "SELECT * FROM vv_executions WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(cursor.previous_execution_id)]) : null;
  }
  return chain;
}

async function ancestorsAsync(db, tenantId, row) {
  const chain = [];
  let cursor = row.previous_execution_id ? await queryOneAsync(db, "SELECT * FROM vv_executions WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(row.previous_execution_id)]) : null;
  const guard = new Set();
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    chain.push(publicExecution(cursor));
    cursor = cursor.previous_execution_id ? await queryOneAsync(db, "SELECT * FROM vv_executions WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(cursor.previous_execution_id)]) : null;
  }
  return chain;
}

function descendants(db, tenantId, rootId) {
  const out = [];
  const queue = [Number(rootId)];
  const guard = new Set();
  while (queue.length) {
    const parent = queue.shift();
    const children = queryAll(db, "SELECT * FROM vv_executions WHERE tenant_id = ? AND previous_execution_id = ? ORDER BY id", [Number(tenantId), parent]);
    for (const child of children) {
      if (guard.has(child.id)) continue;
      guard.add(child.id);
      out.push(publicExecution(child));
      queue.push(child.id);
    }
  }
  return out;
}

async function descendantsAsync(db, tenantId, rootId) {
  const out = [];
  const queue = [Number(rootId)];
  const guard = new Set();
  while (queue.length) {
    const parent = queue.shift();
    const children = await queryAllAsync(db, "SELECT * FROM vv_executions WHERE tenant_id = ? AND previous_execution_id = ? ORDER BY id", [Number(tenantId), parent]);
    for (const child of children) {
      if (guard.has(child.id)) continue;
      guard.add(child.id);
      out.push(publicExecution(child));
      queue.push(child.id);
    }
  }
  return out;
}

export function getRetestChain(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const row = requireExecutionRow(db, tenant, ref);
  const up = ancestors(db, tenant, row);
  const down = descendants(db, tenant, row.id);
  return { execution: publicExecution(row), ancestors: up, descendants: down, total: up.length + down.length + 1, source_module: SOURCE_MODULE };
}

export async function getRetestChainAsync(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const row = await requireExecutionRowAsync(db, tenant, ref);
  const up = await ancestorsAsync(db, tenant, row);
  const down = await descendantsAsync(db, tenant, row.id);
  return { execution: publicExecution(row), ancestors: up, descendants: down, total: up.length + down.length + 1, source_module: SOURCE_MODULE };
}

export function planRetest(db, tenantId, ref, { policy } = {}) {
  const tenant = Number(tenantId);
  const row = requireExecutionRow(db, tenant, ref);
  const resolved = resolveRetestPolicy(db, tenant, policy ?? null);
  const failures = failedResults(db, tenant, row.id);
  return {
    execution_ref: row.execution_ref,
    policy: resolved,
    failed_result_refs: failures.map((r) => r.result_ref),
    failed_step_ids: failures.map((r) => r.procedure_step_id).filter((id) => id != null),
    rerun_all_steps: resolved === "FULL_TEST",
    source_module: SOURCE_MODULE,
  };
}

export async function planRetestAsync(db, tenantId, ref, { policy } = {}) {
  const tenant = Number(tenantId);
  const row = await requireExecutionRowAsync(db, tenant, ref);
  const resolved = await resolveRetestPolicyAsync(db, tenant, policy ?? null);
  const failures = await failedResultsAsync(db, tenant, row.id);
  return {
    execution_ref: row.execution_ref,
    policy: resolved,
    failed_result_refs: failures.map((r) => r.result_ref),
    failed_step_ids: failures.map((r) => r.procedure_step_id).filter((id) => id != null),
    rerun_all_steps: resolved === "FULL_TEST",
    source_module: SOURCE_MODULE,
  };
}

export { requestRetest, requestRetestAsync };

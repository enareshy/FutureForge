// Remediation. A failed check can be fixed by applying a controlled remedial
// action to the governed object. Every action records the before/after value and
// the operator, so quality history and audit can prove what changed. This
// module never deletes data: duplicates are merged by copying values and
// retiring the losing record, not by destroying it.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { remediationFailed, remediationNotAllowed, exceptionNotFound } from "./errors.js";
import { normalizeText, parseArray, readAttribute, valuePreview } from "./validation.js";
import { REMEDIATION_ACTIONS } from "./constants.js";
import { publicRemediation } from "./repository.js";
import { findCatalogByType } from "./catalog.js";
import { requireAdapter } from "./adapter.js";
import { resolveCandidate } from "./duplicates.js";
import { publishGovernanceEvent } from "./events.js";
import { updateObject, setObjectStatus, getObject } from "../objects.js";

export { publicRemediation };

export function listRemediations(db, { tenantId, exceptionId, objectType, objectId, limit = 100 } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (exceptionId) {
    clauses.push("exception_id = ?");
    params.push(Number(exceptionId));
  }
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(String(objectType).toLowerCase());
  }
  if (objectId) {
    clauses.push("object_id = ?");
    params.push(String(objectId));
  }
  return queryAll(
    db,
    `SELECT * FROM dg_remediations WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    [...params, Number(limit) || 100]
  ).map(publicRemediation);
}

function record(db, input) {
  const result = run(
    db,
    `INSERT INTO dg_remediations
      (tenant_id, exception_id, object_type, object_id, action_type, attribute_name, before_value, after_value, status, message, requested_by, executed_by, executed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(input.tenantId),
      input.exceptionId ?? null,
      normalizeText(input.objectType),
      normalizeText(input.objectId),
      normalizeText(input.actionType).toUpperCase(),
      normalizeText(input.attributeName),
      valuePreview(input.beforeValue),
      valuePreview(input.afterValue),
      normalizeText(input.status, "applied"),
      normalizeText(input.message),
      input.requestedBy ?? null,
      input.executedBy ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  return publicRemediation(queryOne(db, "SELECT * FROM dg_remediations WHERE id = ?", [Number(result.lastInsertRowid)]));
}

function applyAttribute(db, { tenantId, objectType, objectId, attributeName, afterValue, actor, ip }) {
  const catalog = findCatalogByType(db, tenantId, objectType);
  const adapterCode = catalog?.source_adapter || "platform.objects";
  const adapter = requireAdapter(adapterCode);
  const before = adapter.load(db, { tenantId, objectType, objectId });
  if (!before) throw remediationFailed(`Object ${objectType}/${objectId} could not be loaded`);
  if (adapterCode !== "platform.objects") {
    throw remediationNotAllowed(`Adapter ${adapterCode} does not support in-platform remediation`);
  }
  const beforeValue = readAttribute(before.attributes, attributeName);
  try {
    updateObject(db, objectId, { data: { [attributeName]: afterValue } }, actor, Number(tenantId), ip);
  } catch (error) {
    throw remediationFailed(`Could not set ${attributeName}: ${error.message}`, { object_type: objectType, object_id: objectId });
  }
  return { beforeValue, afterValue };
}

function mergeDuplicate(db, { tenantId, objectType, objectId, afterValue, actor, ip }) {
  const candidateRef = normalizeText(afterValue);
  if (!candidateRef) throw remediationFailed("MERGE_DUPLICATE requires the surviving candidate_ref as after_value");
  const candidate = queryOne(db, "SELECT * FROM dg_duplicate_candidates WHERE candidate_ref = ?", [candidateRef]);
  if (!candidate) throw remediationFailed(`Duplicate candidate not found: ${candidateRef}`);
  const survivor = getObject(db, candidate.object_id, Number(tenantId));
  const loser = getObject(db, candidate.matched_object_id, Number(tenantId));
  if (!survivor || !loser) throw remediationFailed("Both duplicate objects must be readable");
  const merged = { ...loser.data, ...survivor.data };
  try {
    updateObject(db, survivor.id, { data: merged }, actor, Number(tenantId), ip);
    setObjectStatus(db, loser.id, "obsolete", actor, Number(tenantId), ip);
  } catch (error) {
    throw remediationFailed(`Could not merge duplicate: ${error.message}`);
  }
  resolveCandidate(db, candidateRef, { status: "MERGED", resolution: normalizeText(afterValue) }, actor, ip);
  return { beforeValue: candidateRef, afterValue: candidateRef };
}

// Applies a remedial action. `action` must be a registered remediation action.
export function applyRemediation(db, input = {}, actor = null, ip = null) {
  const tenantId = Number(input.tenant_id ?? input.tenantId);
  const actionType = normalizeText(input.action_type || input.action).toUpperCase();
  if (!REMEDIATION_ACTIONS.includes(actionType)) {
    throw remediationNotAllowed(`Unknown remediation action: ${actionType}`, { allowed: REMEDIATION_ACTIONS });
  }
  const objectType = normalizeText(input.object_type).toLowerCase();
  const objectId = normalizeText(input.object_id);
  if (!objectType || !objectId) throw remediationFailed("object_type and object_id are required");

  let exceptionId = null;
  if (input.exception_id || input.exceptionId) {
    const exception = queryOne(db, "SELECT * FROM dg_quality_exceptions WHERE exception_ref = ? OR id = ?", [
      String(input.exception_id ?? input.exceptionId),
      Number(input.exception_id ?? input.exceptionId) || -1,
    ]);
    if (!exception) throw exceptionNotFound(input.exception_id ?? input.exceptionId);
    exceptionId = exception.id;
  }

  const attributeName = normalizeText(input.attribute_name || input.attribute);
  const afterValue = input.after_value ?? input.value;

  let outcome;
  try {
    if (actionType === "MERGE_DUPLICATE") {
      outcome = mergeDuplicate(db, { tenantId, objectType, objectId, afterValue, actor, ip });
    } else if (actionType === "ASSIGN_OWNER") {
      const ownerId = Number(input.owner_user_id ?? afterValue);
      if (!Number.isInteger(ownerId)) throw remediationFailed("ASSIGN_OWNER requires owner_user_id");
      updateObject(db, objectId, { owner_id: ownerId }, actor, tenantId, ip);
      outcome = { beforeValue: "", afterValue: ownerId };
    } else {
      if (!attributeName) throw remediationFailed(`${actionType} requires attribute_name`);
      outcome = applyAttribute(db, { tenantId, objectType, objectId, attributeName, afterValue, actor, ip });
    }
  } catch (error) {
    record(db, {
      tenantId,
      exceptionId,
      objectType,
      objectId,
      actionType,
      attributeName,
      beforeValue: "",
      afterValue,
      status: "failed",
      message: error.message,
      requestedBy: actor?.id ?? null,
      executedBy: actor?.id ?? null,
    });
    if (error.code) throw error;
    throw remediationFailed(error.message);
  }

  const remediation = record(db, {
    tenantId,
    exceptionId,
    objectType,
    objectId,
    actionType,
    attributeName,
    beforeValue: outcome.beforeValue,
    afterValue: outcome.afterValue,
    status: "applied",
    message: normalizeText(input.message),
    requestedBy: actor?.id ?? null,
    executedBy: actor?.id ?? null,
  });
  writeAudit(db, {
    actor,
    action: "data_quality.remediation.apply",
    resourceType: "dg_remediation",
    resourceId: remediation.id,
    details: { action_type: actionType, object_type: objectType, object_id: objectId, attribute_name: attributeName },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DataRemediationApplied",
    tenantId,
    objectType,
    objectId,
    payload: { action_type: actionType, attribute_name: attributeName, before: remediation.before_value, after: remediation.after_value },
  }, actor);
  return remediation;
}

export function remediationSummary(db, { tenantId } = {}) {
  const rows = queryAll(
    db,
    "SELECT action_type, status, COUNT(*) AS c FROM dg_remediations WHERE tenant_id = ? GROUP BY action_type, status",
    [Number(tenantId)]
  );
  const byAction = {};
  let total = 0;
  for (const row of rows) {
    total += Number(row.c);
    byAction[row.action_type] = (byAction[row.action_type] || 0) + Number(row.c);
  }
  return { total, by_action: byAction };
}

export { parseArray };

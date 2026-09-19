import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { Errors } from "./errors.js";
import {
  assertRetentionDisposition,
  assertRetentionStartBasis,
  normalizeText,
} from "./validation.js";
import {
  publicRetentionPolicy,
  publicRetentionRecord,
  publicLegalHold,
  assertTenant,
  activeLegalHoldRow,
} from "./repository.js";
import { policyRef as newPolicyRef } from "./refs.js";
import { recordContentEvent, auditContent } from "./events.js";

// Retention & legal hold (spec §25-§27). Expiry never deletes content: it marks
// content eligible so an authorized, audited deletion can be performed. Legal
// hold always wins over retention and blocks deletion.

function addDays(baseIso, days) {
  const base = new Date(String(baseIso || nowIso()).replace(" ", "T") + (String(baseIso || "").includes("Z") ? "" : "Z"));
  const date = Number.isNaN(base.getTime()) ? new Date() : base;
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export function listRetentionPolicies(db, { tenantId = null, activeOnly = false, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (tenantId !== null && tenantId !== undefined) {
    where.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (activeOnly) where.push("active = 1");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = queryAll(
    db,
    `SELECT * FROM content_retention_policies ${clause} ORDER BY policy_code LIMIT ?`,
    [...params, Math.min(500, Math.max(1, Number(limit) || 200))]
  );
  return { items: rows.map(publicRetentionPolicy), total: rows.length };
}

export function getRetentionPolicy(db, reference, tenantId = null) {
  const row = queryOne(
    db,
    "SELECT * FROM content_retention_policies WHERE (policy_ref = ? OR id = ? OR policy_code = ?)",
    [String(reference || ""), Number(reference) || -1, String(reference || "")]
  );
  if (!row) throw Errors.notFound("Retention policy not found");
  if (tenantId !== null && tenantId !== undefined && row.tenant_id !== null && Number(row.tenant_id) !== Number(tenantId)) {
    throw Errors.notFound("Retention policy not found");
  }
  return publicRetentionPolicy(row);
}

export function createRetentionPolicy(db, input = {}, { actor = null, tenantId = null, ip = null } = {}) {
  return transaction(db, () => {
    const scope = tenantId ?? input.tenantId ?? null;
    const code = normalizeText(input.policyCode ?? input.policy_code).toLowerCase();
    if (!code) throw Errors.retentionViolation("policy_code is required");
    const disposition = assertRetentionDisposition(input.disposition || "review");
    const basis = assertRetentionStartBasis(input.retentionStartBasis ?? input.retention_start_basis ?? "created");
    const existing = queryOne(
      db,
      "SELECT * FROM content_retention_policies WHERE COALESCE(tenant_id, 0) = COALESCE(?, 0) AND policy_code = ?",
      [scope, code]
    );
    if (existing) return publicRetentionPolicy(existing);
    const result = run(
      db,
      `INSERT INTO content_retention_policies
        (policy_ref, tenant_id, policy_code, name, description, retention_days, retention_start_basis, disposition,
         applies_to_role, applies_to_object_type, applies_to_classification, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newPolicyRef(scope, code),
        scope,
        code,
        normalizeText(input.name, code),
        normalizeText(input.description),
        Math.max(0, Number(input.retentionDays ?? input.retention_days) || 0),
        basis,
        disposition,
        normalizeText(input.appliesToRole ?? input.applies_to_role).toUpperCase(),
        normalizeText(input.appliesToObjectType ?? input.applies_to_object_type),
        normalizeText(input.appliesToClassification ?? input.applies_to_classification),
        input.active === false ? 0 : 1,
        actor?.id ?? null,
        nowIso(),
        nowIso(),
      ]
    );
    const row = queryOne(db, "SELECT * FROM content_retention_policies WHERE id = ?", [Number(result.lastInsertRowid)]);
    auditContent(db, { actor, tenantId: scope, action: "content.retention_policy.created", objectType: "content_retention_policy", objectId: row.id, objectName: code, details: { retention_days: row.retention_days, disposition }, ip });
    return publicRetentionPolicy(row);
  });
}

export function updateRetentionPolicy(db, reference, patch = {}, { actor = null, tenantId = null, ip = null } = {}) {
  return transaction(db, () => {
    const current = getRetentionPolicy(db, reference, tenantId);
    const row = queryOne(db, "SELECT * FROM content_retention_policies WHERE id = ?", [Number(current.id)]);
    run(
      db,
      `UPDATE content_retention_policies SET name = ?, description = ?, retention_days = ?, retention_start_basis = ?,
         disposition = ?, applies_to_role = ?, applies_to_object_type = ?, applies_to_classification = ?, active = ?, updated_at = ?
       WHERE id = ?`,
      [
        patch.name ?? row.name,
        patch.description ?? row.description,
        patch.retentionDays ?? patch.retention_days ?? row.retention_days,
        patch.retentionStartBasis || patch.retention_start_basis ? assertRetentionStartBasis(patch.retentionStartBasis ?? patch.retention_start_basis) : row.retention_start_basis,
        patch.disposition ? assertRetentionDisposition(patch.disposition) : row.disposition,
        ((patch.appliesToRole ?? patch.applies_to_role ?? row.applies_to_role) || "").toUpperCase(),
        patch.appliesToObjectType ?? patch.applies_to_object_type ?? row.applies_to_object_type,
        patch.appliesToClassification ?? patch.applies_to_classification ?? row.applies_to_classification,
        (patch.active === undefined ? row.active : patch.active ? 1 : 0),
        nowIso(),
        row.id,
      ]
    );
    const updated = queryOne(db, "SELECT * FROM content_retention_policies WHERE id = ?", [row.id]);
    auditContent(db, { actor, tenantId: row.tenant_id, action: "content.retention_policy.updated", objectType: "content_retention_policy", objectId: row.id, objectName: row.policy_code, details: { changes: Object.keys(patch) }, ip });
    return publicRetentionPolicy(updated);
  });
}

export function resolveRetentionPolicy(db, content) {
  if (!content) return null;
  const candidates = queryAll(
    db,
    `SELECT * FROM content_retention_policies WHERE active = 1 AND (tenant_id IS NULL OR tenant_id = ?)`,
    [content.tenant_id]
  );
  const matches = candidates.filter((policy) => {
    if (policy.applies_to_role && policy.applies_to_role !== String(content.content_role || "").toUpperCase()) return false;
    if (policy.applies_to_object_type && policy.applies_to_object_type !== content.object_type) return false;
    if (policy.applies_to_classification && policy.applies_to_classification !== content.security_classification) return false;
    return true;
  });
  return matches[0] ? publicRetentionPolicy(matches[0]) : null;
}

export function ensureRetentionRecord(db, content, { actor = null, policy = null } = {}) {
  const resolved = policy || resolveRetentionPolicy(db, content);
  if (!resolved) return null;
  const existing = queryOne(db, "SELECT * FROM content_retention_records WHERE content_id = ? AND policy_id = ?", [
    Number(content.id),
    Number(resolved.id),
  ]);
  if (existing) return publicRetentionRecord(existing);
  const basis = resolved.retention_start_basis;
  const start = basis === "modified" ? content.updated_at : basis === "superseded" ? content.updated_at : content.created_at;
  const end = resolved.retention_days > 0 ? addDays(start, resolved.retention_days) : null;
  const result = run(
    db,
    `INSERT INTO content_retention_records
      (tenant_id, content_id, policy_id, retention_start, retention_end, disposition, status, legal_hold, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
    [content.tenant_id, Number(content.id), Number(resolved.id), start, end, resolved.disposition, actor?.id ?? null, nowIso(), nowIso()]
  );
  return publicRetentionRecord(queryOne(db, "SELECT * FROM content_retention_records WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function retentionForContent(db, content) {
  const records = queryAll(db, "SELECT * FROM content_retention_records WHERE content_id = ? ORDER BY id DESC", [Number(content.id)]).map(publicRetentionRecord);
  const hold = activeLegalHoldRow(db, content.id);
  const holds = queryAll(db, "SELECT * FROM content_legal_holds WHERE content_id = ? ORDER BY id DESC", [Number(content.id)]).map(publicLegalHold);
  const policy = resolveRetentionPolicy(db, content);
  const eligible = records.some((record) => ["expired", "eligible"].includes(record.status)) && !hold;
  return {
    content_id: content.content_id,
    policy,
    records,
    legal_hold: hold ? publicLegalHold(hold) : null,
    holds,
    deletion_eligible: eligible,
    deletion_blocked: Boolean(hold),
    archived: content.status === "archived",
  };
}

export function applyLegalHold(db, content, { reason = "", caseRef = "", actor = null, tenantId = null, ip = null } = {}) {
  return transaction(db, () => {
    const scope = assertTenant(tenantId ?? content.tenant_id);
    const existing = activeLegalHoldRow(db, content.id);
    if (existing) return publicLegalHold(existing);
    const ts = nowIso();
    const result = run(
      db,
      `INSERT INTO content_legal_holds (tenant_id, content_id, reason, case_ref, status, applied_by, applied_at, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      [scope, Number(content.id), normalizeText(reason), normalizeText(caseRef), actor?.id ?? null, ts, ts]
    );
    run(db, "UPDATE content_retention_records SET legal_hold = 1, updated_at = ? WHERE content_id = ?", [ts, Number(content.id)]);
    const row = queryOne(db, "SELECT * FROM content_legal_holds WHERE id = ?", [Number(result.lastInsertRowid)]);
    recordContentEvent(db, { eventType: "ContentLegalHoldApplied", content, actor, tenantId: scope, payload: { reason, case_ref: caseRef } });
    auditContent(db, { actor, tenantId: scope, action: "content.legal_hold.applied", content, details: { reason, case_ref: caseRef }, ip });
    return publicLegalHold(row);
  });
}

export function releaseLegalHold(db, content, { actor = null, tenantId = null, reason = "", ip = null } = {}) {
  return transaction(db, () => {
    const scope = assertTenant(tenantId ?? content.tenant_id);
    const existing = activeLegalHoldRow(db, content.id);
    if (!existing) throw Errors.notFound("No active legal hold for this content");
    const ts = nowIso();
    run(
      db,
      "UPDATE content_legal_holds SET status = 'released', released_by = ?, released_at = ? WHERE id = ?",
      [actor?.id ?? null, ts, Number(existing.id)]
    );
    run(db, "UPDATE content_retention_records SET legal_hold = 0, updated_at = ? WHERE content_id = ?", [ts, Number(content.id)]);
    recordContentEvent(db, { eventType: "ContentLegalHoldReleased", content, actor, tenantId: scope, payload: { reason } });
    auditContent(db, { actor, tenantId: scope, action: "content.legal_hold.released", content, details: { reason }, ip });
    return publicLegalHold(queryOne(db, "SELECT * FROM content_legal_holds WHERE id = ?", [Number(existing.id)]));
  });
}

// Retention evaluation used by the job worker. Marks expired records eligible
// and moves content to 'retained'; it never purges bytes.
export function evaluateRetention(db, { tenantId = null, now = nowIso(), limit = 500 } = {}) {
  const where = ["status = 'active'", "retention_end IS NOT NULL", "retention_end <= ?", "legal_hold = 0"];
  const params = [now];
  if (tenantId !== null && tenantId !== undefined) {
    where.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  const expired = queryAll(
    db,
    `SELECT * FROM content_retention_records WHERE ${where.join(" AND ")} ORDER BY retention_end LIMIT ?`,
    [...params, Math.min(5000, Math.max(1, Number(limit) || 500))]
  );
  let processed = 0;
  for (const record of expired) {
    const content = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(record.content_id)]);
    if (!content || content.deleted_at) continue;
    run(
      db,
      "UPDATE content_retention_records SET status = ?, disposition = COALESCE(disposition, 'review'), evaluated_at = ?, updated_at = ? WHERE id = ?",
      [record.disposition === "purge" ? "eligible" : "expired", nowIso(), nowIso(), Number(record.id)]
    );
    run(db, "UPDATE content SET status = 'retained', updated_at = ?, revision = revision + 1 WHERE id = ?", [nowIso(), Number(content.id)]);
    recordContentEvent(db, { eventType: "ContentRetentionExpired", content, actor: null, tenantId: content.tenant_id, payload: { retention_record_id: record.id, retention_end: record.retention_end, disposition: record.disposition } });
    processed += 1;
  }
  return { evaluated: expired.length, processed };
}

export function canDeleteContent(db, content) {
  const hold = activeLegalHoldRow(db, content.id);
  if (hold) return { allowed: false, reason: "LEGAL_HOLD_ACTIVE" };
  const blocking = queryOne(
    db,
    "SELECT * FROM content_retention_records WHERE content_id = ? AND status = 'active' AND retention_end IS NOT NULL AND retention_end > ? LIMIT 1",
    [Number(content.id), nowIso()]
  );
  if (blocking) {
    return { allowed: false, reason: "RETENTION_POLICY_VIOLATION", retention_end: blocking.retention_end };
  }
  return { allowed: true };
}

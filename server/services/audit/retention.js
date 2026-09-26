import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { HttpError } from "../../validation.js";
import { publicPolicy } from "./policies.js";
import { structuredLog, capture } from "./events.js";
import { validateRetentionPolicyInput } from "./validation.js";
import { publishAuditEvent, AUDIT_EVENT_TYPES } from "./publisher.js";

// Retention and archival. Events older than a policy's retention window are
// moved to audit_logs_archive and removed from the live table. Removal is only
// possible while the immutability guard flag is set, and the whole operation
// runs in a single transaction.

const ARCHIVE_COLUMNS = [
  "id",
  "tenant_id",
  "organization_id",
  "plant_id",
  "site_id",
  "department_id",
  "actor_id",
  "actor_username",
  "user_display_name",
  "actor_type",
  "actor_ref",
  "action",
  "event_type",
  "category",
  "source",
  "security_classification",
  "retention_category",
  "resource_type",
  "resource_id",
  "object_name",
  "object_revision",
  "session_id",
  "related_resource_type",
  "related_resource_id",
  "details",
  "changed_fields",
  "before_values",
  "after_values",
  "related_json",
  "status",
  "failure_category",
  "error_message",
  "reason",
  "correlation_id",
  "request_id",
  "parent_event_id",
  "ip",
  "device",
  "duration_ms",
  "created_at",
];

function cutoffFor(days, now) {
  const ms = Number(days) * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms).toISOString().replace("T", " ").slice(0, 19);
}

function policySelection(policy, cutoff) {
  const where = ["created_at < ?"];
  const params = [cutoff];
  if (policy.tenant_id != null) {
    where.push("tenant_id = ?");
    params.push(Number(policy.tenant_id));
  }
  if (policy.object_type && policy.object_type !== "*") {
    where.push("resource_type = ?");
    params.push(policy.object_type);
  }
  return { where, params };
}

function archiveAndPurge(db, where, params, { archive = true } = {}) {
  const clause = where.join(" AND ");
  const ids = queryAll(db, `SELECT id FROM audit_logs WHERE ${clause}`, params).map((r) => r.id);
  if (!ids.length) return { archived: 0, purged: 0 };
  if (archive) {
    for (const id of ids) {
      run(
        db,
        `INSERT OR IGNORE INTO audit_logs_archive (${ARCHIVE_COLUMNS.join(", ")})
         SELECT ${ARCHIVE_COLUMNS.join(", ")} FROM audit_logs WHERE id = ?`,
        [id]
      );
    }
  }
  run(db, "UPDATE audit_guard SET allow_delete = 1 WHERE id = 1");
  try {
    run(db, `DELETE FROM audit_logs WHERE ${clause}`, params);
  } finally {
    run(db, "UPDATE audit_guard SET allow_delete = 0 WHERE id = 1");
  }
  return { archived: archive ? ids.length : 0, purged: ids.length };
}

export function listRetentionRuns(db, { tenantId, page = 1, pageSize = 25 } = {}) {
  const where = [];
  const params = [];
  if (tenantId) {
    where.push("(tenant_id = ? OR tenant_id IS NULL)");
    params.push(Number(tenantId));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(200, Math.max(1, Number(pageSize) || 25));
  const offset = (Math.max(1, Number(page) || 1) - 1) * limit;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM audit_retention_runs ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT * FROM audit_retention_runs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  ).map((row) => {
    let details = {};
    try {
      details = row.details_json ? JSON.parse(row.details_json) : {};
    } catch {
      details = {};
    }
    return { ...row, dry_run: !!row.dry_run, details };
  });
  return { items, total, page: Number(page) || 1, pageSize: limit };
}

export function runRetention(db, { tenantId, policyId, actor, dryRun = false, now = new Date() } = {}) {
  const where = ["status = 'active'"];
  const params = [];
  if (policyId) {
    where.push("id = ?");
    params.push(Number(policyId));
  }
  if (tenantId) {
    where.push("(tenant_id = ? OR tenant_id IS NULL)");
    params.push(Number(tenantId));
  }
  const policies = queryAll(db, `SELECT * FROM audit_policies WHERE ${where.join(" AND ")}`, params);
  const runs = [];
  let archivedTotal = 0;
  let purgedTotal = 0;

  for (const row of policies) {
    const policy = publicPolicy(row);
    if (!policy.retention_days || policy.retention_days < 1) continue;
    const cutoff = cutoffFor(policy.retention_days, now);
    const selection = policySelection(policy, cutoff);
    const clause = selection.where.join(" AND ");
    const count = queryOne(db, `SELECT COUNT(*) AS c FROM audit_logs WHERE ${clause}`, selection.params).c;
    let archived = 0;
    let purged = 0;
    let status = "success";
    if (!dryRun && count > 0) {
      try {
        const outcome = transaction(db, () => archiveAndPurge(db, selection.where, selection.params));
        archived = outcome.archived;
        purged = outcome.purged;
      } catch (err) {
        status = "failed";
        structuredLog("audit.retention.failed", { policy_id: policy.id, message: err?.message });
      }
    }
    archivedTotal += archived;
    purgedTotal += purged;
    const runResult = run(
      db,
      `INSERT INTO audit_retention_runs
        (tenant_id, policy_id, cutoff, archived, purged, status, dry_run, actor_id, details_json, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        policy.tenant_id,
        policy.id,
        cutoff,
        archived,
        purged,
        status,
        dryRun ? 1 : 0,
        actor?.id ?? null,
        JSON.stringify({ object_type: policy.object_type, candidates: count, retention_days: policy.retention_days }),
        nowIso(),
        nowIso(),
      ]
    );
    runs.push({
      id: Number(runResult.lastInsertRowid),
      policy_id: policy.id,
      object_type: policy.object_type,
      cutoff,
      candidates: count,
      archived,
      purged,
      status,
      dry_run: !!dryRun,
    });
  }
  return { archived: archivedTotal, purged: purgedTotal, dry_run: !!dryRun, runs };
}

export function archiveStats(db, { tenantId } = {}) {
  const where = [];
  const params = [];
  if (tenantId) {
    where.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const live = queryOne(db, `SELECT COUNT(*) AS c FROM audit_logs ${clause}`, params).c;
  const archiveClause = clause ? `${clause} AND 1=1` : "";
  const archived = queryOne(db, `SELECT COUNT(*) AS c FROM audit_logs_archive ${archiveClause}`, params).c;
  return { live, archived };
}

// ── Dedicated retention policies ───────────────────────────────────────────
// Capture policies (audit_policies) decide what is recorded; retention policies
// decide how long it is kept. Separating them lets compliance teams manage
// lifecycle and legal hold without touching capture behaviour.

export function publicRetentionPolicy(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id ?? null,
    name: row.name || "",
    description: row.description || "",
    category: row.category || "*",
    object_type: row.object_type || "*",
    retention_days: Number(row.retention_days),
    action: row.action || "archive",
    legal_hold: row.legal_hold === 1,
    status: row.status || "active",
    priority: Number(row.priority ?? 100),
    system: row.system === 1,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getRetentionPolicyRow(db, id) {
  return queryOne(db, "SELECT * FROM audit_retention_policies WHERE id = ?", [Number(id)]);
}

export function getRetentionPolicy(db, id, tenantId = null) {
  const row = getRetentionPolicyRow(db, id);
  if (!row) throw new HttpError(404, "Retention policy not found");
  if (tenantId != null && row.tenant_id != null && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Retention policy not found");
  }
  return publicRetentionPolicy(row);
}

export function listRetentionPolicies(db, { tenantId, status, category, objectType, includeSystem = true } = {}) {
  const where = [];
  const params = [];
  if (tenantId) {
    where.push(includeSystem ? "(tenant_id = ? OR tenant_id IS NULL)" : "tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (status) {
    where.push("status = ?");
    params.push(String(status));
  }
  if (category) {
    where.push("category = ?");
    params.push(String(category).toLowerCase());
  }
  if (objectType) {
    where.push("object_type = ?");
    params.push(String(objectType));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = queryAll(
    db,
    `SELECT * FROM audit_retention_policies ${clause}
      ORDER BY COALESCE(tenant_id, 0) DESC, priority ASC, id ASC`,
    params
  ).map(publicRetentionPolicy);
  return { items, total: items.length };
}

export function createRetentionPolicy(db, body = {}, actor = null, tenantId = null) {
  const input = validateRetentionPolicyInput(body, { partial: false });
  const effectiveTenant =
    body.tenant_id === null || body.tenantId === null
      ? null
      : (() => {
          const raw = body.tenant_id ?? body.tenantId ?? tenantId;
          return raw === null || raw === undefined || raw === "" ? null : Number(raw);
        })();
  const existing = queryOne(
    db,
    `SELECT id FROM audit_retention_policies
      WHERE COALESCE(tenant_id, 0) = COALESCE(?, 0) AND category = ? AND object_type = ?`,
    [effectiveTenant, input.category, input.object_type]
  );
  if (existing) throw new HttpError(409, "A retention policy already exists for this scope");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO audit_retention_policies
       (tenant_id, name, description, category, object_type, retention_days, action, legal_hold,
        status, priority, system, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      effectiveTenant,
      input.name,
      input.description || "",
      input.category,
      input.object_type,
      input.retention_days ?? 2555,
      input.action || "archive",
      body.legal_hold === true || body.legalHold === true ? 1 : 0,
      input.status || "active",
      input.priority ?? 100,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  capture(db, {
    actor,
    tenant_id: effectiveTenant,
    action: "audit.retention_policy.create",
    event_type: "CONFIGURATION_CHANGED",
    category: "configuration",
    object_type: "audit_retention_policy",
    object_id: result.lastInsertRowid,
    object_name: input.name,
    details: { category: input.category, object_type: input.object_type, retention_days: input.retention_days },
    reason: body.reason,
  });
  return getRetentionPolicy(db, result.lastInsertRowid, null);
}

export function updateRetentionPolicy(db, id, body = {}, actor = null, tenantId = null) {
  const row = getRetentionPolicyRow(db, id);
  if (!row) throw new HttpError(404, "Retention policy not found");
  if (tenantId != null && row.tenant_id != null && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Retention policy not found");
  }
  const input = validateRetentionPolicyInput(body, { partial: true });
  const next = {
    name: input.name ?? row.name,
    description: input.description ?? row.description,
    category: input.category ?? row.category,
    object_type: input.object_type ?? row.object_type,
    retention_days: input.retention_days ?? row.retention_days,
    action: input.action ?? row.action,
    legal_hold: body.legal_hold === undefined && body.legalHold === undefined ? row.legal_hold : (body.legal_hold ?? body.legalHold) ? 1 : 0,
    status: input.status ?? row.status,
    priority: input.priority ?? row.priority,
  };
  if (row.system === 1 && next.status !== "active") {
    throw new HttpError(409, "System retention policies cannot be disabled");
  }
  run(
    db,
    `UPDATE audit_retention_policies SET
       name = ?, description = ?, category = ?, object_type = ?, retention_days = ?, action = ?,
       legal_hold = ?, status = ?, priority = ?, updated_at = ?
     WHERE id = ?`,
    [
      next.name,
      next.description,
      next.category,
      next.object_type,
      next.retention_days,
      next.action,
      next.legal_hold,
      next.status,
      next.priority,
      nowIso(),
      id,
    ]
  );
  capture(db, {
    actor,
    tenant_id: row.tenant_id,
    action: "audit.retention_policy.update",
    event_type: "CONFIGURATION_CHANGED",
    category: "configuration",
    object_type: "audit_retention_policy",
    object_id: id,
    object_name: next.name,
    details: { before: publicRetentionPolicy(row), after: next },
    reason: body.reason,
  });
  return getRetentionPolicy(db, id, null);
}

export function deleteRetentionPolicy(db, id, actor = null, tenantId = null) {
  const row = getRetentionPolicyRow(db, id);
  if (!row) throw new HttpError(404, "Retention policy not found");
  if (tenantId != null && row.tenant_id != null && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Retention policy not found");
  }
  if (row.system === 1) throw new HttpError(409, "System retention policies cannot be deleted");
  run(db, "DELETE FROM audit_retention_policies WHERE id = ?", [id]);
  capture(db, {
    actor,
    tenant_id: row.tenant_id,
    action: "audit.retention_policy.delete",
    event_type: "CONFIGURATION_CHANGED",
    category: "configuration",
    object_type: "audit_retention_policy",
    object_id: id,
    object_name: row.name,
  });
  return { ok: true, id: Number(id) };
}

// Seeds the baseline retention policies. Safe to call on every seed.
export function ensureDefaultRetentionPolicies(db) {
  const existing = queryOne(
    db,
    "SELECT id FROM audit_retention_policies WHERE tenant_id IS NULL AND category = '*' AND object_type = '*'"
  );
  if (!existing) {
    run(
      db,
      `INSERT INTO audit_retention_policies
         (tenant_id, name, description, category, object_type, retention_days, action, legal_hold,
          status, priority, system, created_by, created_at, updated_at)
       VALUES (NULL, ?, ?, '*', '*', 2555, 'archive', 0, 'active', 100, 1, NULL, ?, ?)`,
      [
        "System default retention",
        "Retain all audit events for seven years, then move them to the archive store.",
        nowIso(),
        nowIso(),
      ]
    );
  }
  const security = queryOne(
    db,
    "SELECT id FROM audit_retention_policies WHERE tenant_id IS NULL AND category = 'security' AND object_type = '*'"
  );
  if (!security) {
    run(
      db,
      `INSERT INTO audit_retention_policies
         (tenant_id, name, description, category, object_type, retention_days, action, legal_hold,
          status, priority, system, created_by, created_at, updated_at)
       VALUES (NULL, ?, ?, 'security', '*', 3650, 'archive', 0, 'active', 10, 1, NULL, ?, ?)`,
      [
        "Security event retention",
        "Retain security events for ten years to satisfy compliance requirements.",
        nowIso(),
        nowIso(),
      ]
    );
  }
  return listRetentionPolicies(db, { includeSystem: true });
}

// Applies each active retention policy: eligible events are archived and/or
// purged according to the policy action. Legal hold and "permanent" retention
// category rows are always skipped. Published events mark the start and end of
// each run for observability.
export function executeRetentionPolicies(db, { tenantId, policyId, actor, dryRun = false, now = new Date() } = {}) {
  const where = ["status = 'active'"];
  const params = [];
  if (policyId) {
    where.push("id = ?");
    params.push(Number(policyId));
  }
  if (tenantId) {
    where.push("(tenant_id = ? OR tenant_id IS NULL)");
    params.push(Number(tenantId));
  }
  const policies = queryAll(
    db,
    `SELECT * FROM audit_retention_policies WHERE ${where.join(" AND ")} ORDER BY priority ASC, id ASC`,
    params
  );
  const runIds = [];
  let archivedTotal = 0;
  let purgedTotal = 0;
  publishAuditEvent(AUDIT_EVENT_TYPES.RETENTION_STARTED, {
    tenant_id: tenantId ?? null,
    policies: policies.length,
    dry_run: !!dryRun,
    actor: actor ? { id: actor.id, username: actor.username } : null,
  });
  for (const row of policies) {
    const policy = publicRetentionPolicy(row);
    if (policy.legal_hold) {
      runIds.push(recordRetentionRun(db, policy, { status: "skipped", dryRun, actor, reason: "legal_hold" }));
      continue;
    }
    if (!policy.retention_days || policy.retention_days < 1) continue;
    const cutoff = cutoffFor(policy.retention_days, now);
    const selection = retentionSelection(policy, cutoff);
    const clause = selection.where.join(" AND ");
    const count = queryOne(db, `SELECT COUNT(*) AS c FROM audit_logs WHERE ${clause}`, selection.params).c;
    let archived = 0;
    let purged = 0;
    let status = "success";
    if (!dryRun && count > 0) {
      try {
        const outcome = transaction(db, () =>
          archiveAndPurge(db, selection.where, selection.params, { archive: policy.action !== "purge" })
        );
        archived = outcome.archived;
        purged = outcome.purged;
      } catch (err) {
        status = "failed";
        structuredLog("audit.retention.policy.failed", { policy_id: policy.id, message: err?.message });
      }
    }
    archivedTotal += archived;
    purgedTotal += purged;
    runIds.push(
      recordRetentionRun(db, policy, { status, dryRun, actor, archived, purged, candidates: count, cutoff })
    );
  }
  publishAuditEvent(AUDIT_EVENT_TYPES.RETENTION_COMPLETED, {
    tenant_id: tenantId ?? null,
    archived: archivedTotal,
    purged: purgedTotal,
    dry_run: !!dryRun,
    runs: runIds.length,
    actor: actor ? { id: actor.id, username: actor.username } : null,
  });
  return { archived: archivedTotal, purged: purgedTotal, dry_run: !!dryRun, runs: runIds };
}

function retentionSelection(policy, cutoff) {
  const where = ["created_at < ?", "(retention_category IS NULL OR retention_category <> 'permanent')"];
  const params = [cutoff];
  if (policy.tenant_id != null) {
    where.push("tenant_id = ?");
    params.push(Number(policy.tenant_id));
  }
  if (policy.category && policy.category !== "*") {
    where.push("category = ?");
    params.push(String(policy.category));
  }
  if (policy.object_type && policy.object_type !== "*") {
    where.push("resource_type = ?");
    params.push(String(policy.object_type));
  }
  return { where, params };
}

function recordRetentionRun(db, policy, { status = "success", dryRun = false, actor = null, archived = 0, purged = 0, candidates = 0, cutoff = null, reason = null } = {}) {
  const result = run(
    db,
    `INSERT INTO audit_retention_runs
       (tenant_id, policy_id, cutoff, archived, purged, status, dry_run, actor_id, details_json, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      policy.tenant_id,
      policy.id,
      cutoff || cutoffFor(policy.retention_days, new Date()),
      archived,
      purged,
      status,
      dryRun ? 1 : 0,
      actor?.id ?? null,
      JSON.stringify({
        retention_policy_id: policy.id,
        retention_policy_name: policy.name,
        action: policy.action,
        category: policy.category,
        object_type: policy.object_type,
        retention_days: policy.retention_days,
        candidates,
        reason,
      }),
      nowIso(),
      nowIso(),
    ]
  );
  return Number(result.lastInsertRowid);
}

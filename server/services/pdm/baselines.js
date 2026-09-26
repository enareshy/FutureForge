// PDM baseline service.
//
// A baseline is an immutable, numbered snapshot of a PDM structure at a point in
// time. Baselines freeze the resolved members (items / revisions / datasets) so
// downstream consumers (BOM, manufacturing, quality) can always reproduce the
// exact configuration that was agreed. Once released or frozen a baseline is
// immutable; only DRAFT baselines can change.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow, bumpVersion } from "./sql.js";
import { publicBaseline, publicBaselineMember } from "./repository.js";
import { baselineRef, baselineMemberRef } from "./refs.js";
import { bumpEpoch, invalidate } from "./cache.js";
import { recordChange } from "./history.js";
import { publishPdmEvent, pdmEventCode } from "./events.js";
import { getConfig } from "./configuration.js";
import { requireItemRow } from "./items.js";
import { normalizeBaselineInput, normalizeText, normalizeUpper, assertBaselineStatus, paginate } from "./validation.js";
import { baselineNotFound, baselineConflict, baselineImmutable, invalidBaseline } from "./errors.js";
import { SOURCE_MODULE, IMMUTABLE_BASELINE_STATUSES } from "./constants.js";

export function getBaselineRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM pdm_baselines WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(db, "SELECT * FROM pdm_baselines WHERE tenant_id = ? AND (baseline_ref = ? OR baseline_number = ? COLLATE NOCASE)", [Number(tenantId), String(ref), String(ref)]);
}

export function requireBaselineRow(db, tenantId, ref) {
  const row = getBaselineRow(db, tenantId, ref);
  if (!row) throw baselineNotFound(ref);
  return row;
}

export function getBaseline(db, tenantId, ref) {
  return publicBaseline(requireBaselineRow(db, tenantId, ref));
}

export function listBaselines(db, { tenantId, status, itemId, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(assertBaselineStatus(status));
  }
  if (itemId != null) {
    clauses.push("item_id = ?");
    params.push(Number(itemId));
  }
  if (q) {
    clauses.push("(baseline_number LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${normalizeText(q, { max: 120 })}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pdm_baselines ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pdm_baselines ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicBaseline), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

function assertBaselineMutable(row) {
  if (IMMUTABLE_BASELINE_STATUSES.includes(String(row.status).toUpperCase())) throw baselineImmutable(row.baseline_ref || row.id, row.status);
}

export function createBaseline(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeBaselineInput(body, {});
  if (queryOne(db, "SELECT id FROM pdm_baselines WHERE tenant_id = ? AND baseline_number = ?", [tenant, normalized.baseline_number])) throw baselineConflict(normalized.baseline_number);
  if (normalized.item_id != null) normalized.item_id = requireItemRow(db, tenant, normalized.item_id).id;
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO pdm_baselines
       (baseline_ref, tenant_id, organization_id, baseline_number, name, description, status, source_object_id, source_revision_id,
        item_id, revision_rule_id, configuration_rule_id, baseline_date, immutable, member_count, snapshot_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '{}', ?, ?, ?)`,
    [
      baselineRef(normalized.baseline_number),
      tenant,
      body.organization_id ?? body.organizationId ?? null,
      normalized.baseline_number,
      normalized.name,
      normalized.description,
      normalized.status,
      normalized.source_object_id,
      normalized.source_revision_id,
      normalized.item_id,
      normalized.revision_rule_id,
      normalized.configuration_rule_id,
      normalized.baseline_date || ts,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM pdm_baselines WHERE id = ?", [Number(result.lastInsertRowid)]);
  const members = Array.isArray(body.members) ? body.members : [];
  if (members.length) addMembersInternal(db, tenant, row.id, members);
  if (normalized.source_revision_id && !members.length) {
    addMembersInternal(db, tenant, row.id, [{ member_type: "REVISION", member_id: normalized.source_revision_id, revision_id: normalized.source_revision_id, level: 0, path: "0" }]);
  }
  const finalRow = queryOne(db, "SELECT * FROM pdm_baselines WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "BASELINE", entityId: row.id, entityRef: row.baseline_ref, action: "CREATED", version: 1, status: row.status, after: publicBaseline(finalRow), actor, ip, details: { member_count: finalRow.member_count } });
  publishPdmEvent(db, { eventType: pdmEventCode("BASELINE_CREATED"), objectType: "pdm_baseline", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { baseline_ref: row.baseline_ref, baseline_number: row.baseline_number, member_count: finalRow.member_count } }, actor);
  return publicBaseline(finalRow);
}

export function updateBaseline(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireBaselineRow(db, tenant, ref);
  assertBaselineMutable(row);
  const before = publicBaseline(row);
  const normalized = normalizeBaselineInput(body, row);
  updateRow(
    db,
    "pdm_baselines",
    row.id,
    {
      name: normalized.name,
      description: normalized.description,
      source_object_id: normalized.source_object_id,
      source_revision_id: normalized.source_revision_id,
      item_id: normalized.item_id,
      revision_rule_id: normalized.revision_rule_id,
      configuration_rule_id: normalized.configuration_rule_id,
      baseline_date: normalized.baseline_date,
      updated_at: nowIso(),
    },
    { columns: ["name", "description", "source_object_id", "source_revision_id", "item_id", "revision_rule_id", "configuration_rule_id", "baseline_date", "updated_at"] }
  );
  const updated = queryOne(db, "SELECT * FROM pdm_baselines WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "BASELINE", entityId: row.id, entityRef: row.baseline_ref, action: "UPDATED", version: updated.version ?? 0, status: updated.status, before, after: publicBaseline(updated), actor, ip });
  return publicBaseline(updated);
}

export function releaseBaseline(db, tenantId, ref, actor = null, ip = null) {
  return transitionBaseline(db, tenantId, ref, "RELEASED", actor, ip);
}

export function freezeBaseline(db, tenantId, ref, actor = null, ip = null) {
  return transitionBaseline(db, tenantId, ref, "FROZEN", actor, ip);
}

export function retireBaseline(db, tenantId, ref, actor = null, ip = null) {
  return transitionBaseline(db, tenantId, ref, "RETIRED", actor, ip);
}

function transitionBaseline(db, tenantId, ref, status, actor, ip) {
  const tenant = Number(tenantId);
  const row = requireBaselineRow(db, tenant, ref);
  const next = assertBaselineStatus(status);
  if (IMMUTABLE_BASELINE_STATUSES.includes(String(row.status).toUpperCase()) && next !== "RETIRED") throw baselineImmutable(row.baseline_ref || row.id, row.status);
  const before = publicBaseline(row);
  const ts = nowIso();
  const patch = { status: next, immutable: IMMUTABLE_BASELINE_STATUSES.includes(next) ? 1 : 0 };
  if (next === "RELEASED") {
    patch.released_at = ts;
    patch.released_by = actor?.id ?? null;
  }
  if (next === "FROZEN") {
    patch.frozen_at = ts;
    patch.frozen_by = actor?.id ?? null;
  }
  const snapshot = JSON.parse(row.snapshot_json || "{}");
  patch.snapshot_json = JSON.stringify({ ...snapshot, status: next, captured_at: snapshot.captured_at || ts, finalized_at: ts });
  updateRow(db, "pdm_baselines", row.id, patch, { columns: ["status", "immutable", "released_at", "released_by", "frozen_at", "frozen_by", "snapshot_json"] });
  const updated = queryOne(db, "SELECT * FROM pdm_baselines WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "BASELINE", entityId: row.id, entityRef: row.baseline_ref, action: `STATUS_${next}`, version: updated.version ?? 0, status: next, before, after: publicBaseline(updated), actor, ip });
  const eventKey = next === "RELEASED" ? "BASELINE_RELEASED" : next === "FROZEN" ? "BASELINE_FROZEN" : null;
  if (eventKey) {
    publishPdmEvent(db, { eventType: pdmEventCode(eventKey), objectType: "pdm_baseline", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { baseline_ref: row.baseline_ref, status: next } }, actor);
  }
  return publicBaseline(updated);
}

export function deleteBaseline(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireBaselineRow(db, tenant, ref);
  assertBaselineMutable(row);
  const before = publicBaseline(row);
  run(db, "DELETE FROM pdm_baseline_members WHERE baseline_id = ?", [row.id]);
  run(db, "DELETE FROM pdm_baselines WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "BASELINE", entityId: row.id, entityRef: row.baseline_ref, action: "DELETED", version: 0, status: row.status, before, actor, ip });
  return { deleted: true, id: row.id, baseline_ref: row.baseline_ref };
}

// ── Members ─────────────────────────────────────────────────────────────────— 

export function listBaselineMembers(db, tenantId, ref, { memberType, page, pageSize } = {}) {
  const baseline = requireBaselineRow(db, tenantId, ref);
  const clauses = ["baseline_id = ?"];
  const params = [baseline.id];
  if (memberType) {
    clauses.push("member_type = ?");
    params.push(normalizeUpper(memberType, { max: 60 }));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 200, maxPageSize: 2000 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pdm_baseline_members ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pdm_baseline_members ${where} ORDER BY level, id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicBaselineMember), total, page: currentPage, page_size: limit, baseline_id: baseline.id, source_module: SOURCE_MODULE };
}

function addMembersInternal(db, tenantId, baselineId, members) {
  let count = 0;
  for (const member of members) {
    if (!member || !member.member_type) continue;
    const memberType = normalizeUpper(member.member_type ?? member.type, { max: 60 });
    const memberId = member.member_id ?? member.memberId ?? null;
    run(
      db,
      `INSERT INTO pdm_baseline_members
         (tenant_id, baseline_id, member_type, member_id, member_ref, item_id, revision_id, dataset_id, representation_id, relationship_id, level, path, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(tenantId),
        baselineId,
        memberType,
        memberId != null ? Number(memberId) : null,
        normalizeText(member.member_ref ?? member.memberRef ?? "", { max: 300 }),
        member.item_id ?? member.itemId ?? null,
        member.revision_id ?? member.revisionId ?? null,
        member.dataset_id ?? member.datasetId ?? null,
        member.representation_id ?? member.representationId ?? null,
        member.relationship_id ?? member.relationshipId ?? null,
        Number.isInteger(member.level) ? member.level : 0,
        normalizeText(member.path ?? "", { max: 1000 }),
        JSON.stringify(member.metadata || {}),
        nowIso(),
      ]
    );
    count += 1;
  }
  if (count) {
    const row = queryOne(db, "SELECT * FROM pdm_baselines WHERE id = ?", [baselineId]);
    updateRow(db, "pdm_baselines", baselineId, { member_count: Number(row.member_count || 0) + count }, { columns: ["member_count"] });
  }
  return count;
}

export function addBaselineMember(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const baseline = requireBaselineRow(db, tenant, ref);
  assertBaselineMutable(baseline);
  if (!body.member_type && !body.memberType) throw invalidBaseline("member_type is required");
  addMembersInternal(db, tenant, baseline.id, [body]);
  bumpEpoch(tenant);
  invalidate(tenant);
  const updated = queryOne(db, "SELECT * FROM pdm_baselines WHERE id = ?", [baseline.id]);
  recordChange(db, { tenantId: tenant, entityType: "BASELINE", entityId: baseline.id, entityRef: baseline.baseline_ref, action: "MEMBER_ADDED", version: 0, status: baseline.status, after: publicBaseline(updated), actor, ip });
  return publicBaseline(updated);
}

export function removeBaselineMember(db, tenantId, ref, memberId, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const baseline = requireBaselineRow(db, tenant, ref);
  assertBaselineMutable(baseline);
  const member = queryOne(db, "SELECT * FROM pdm_baseline_members WHERE id = ? AND baseline_id = ?", [Number(memberId), baseline.id]);
  if (!member) throw baselineNotFound(`member ${memberId}`);
  run(db, "DELETE FROM pdm_baseline_members WHERE id = ?", [member.id]);
  updateRow(db, "pdm_baselines", baseline.id, { member_count: Math.max(0, Number(baseline.member_count || 1) - 1) }, { columns: ["member_count"] });
  bumpEpoch(tenant);
  invalidate(tenant);
  const updated = queryOne(db, "SELECT * FROM pdm_baselines WHERE id = ?", [baseline.id]);
  recordChange(db, { tenantId: tenant, entityType: "BASELINE", entityId: baseline.id, entityRef: baseline.baseline_ref, action: "MEMBER_REMOVED", version: 0, status: baseline.status, after: publicBaseline(updated), actor, ip });
  return publicBaseline(updated);
}

export function updateBaselineSnapshot(db, tenantId, ref, snapshot = {}, actor = null) {
  const tenant = Number(tenantId);
  const baseline = requireBaselineRow(db, tenant, ref);
  assertBaselineMutable(baseline);
  const merged = { ...JSON.parse(baseline.snapshot_json || "{}"), ...snapshot };
  updateRow(db, "pdm_baselines", baseline.id, { snapshot_json: JSON.stringify(merged) }, { columns: ["snapshot_json"] });
  void actor;
  return publicBaseline(queryOne(db, "SELECT * FROM pdm_baselines WHERE id = ?", [baseline.id]));
}

export function baselineSnapshotMeta(db, tenantId, ref) {
  const baseline = requireBaselineRow(db, tenantId, ref);
  const snapshot = JSON.parse(baseline.snapshot_json || "{}");
  return {
    source_module: SOURCE_MODULE,
    baseline: publicBaseline(baseline),
    snapshot,
    default_revision_rule_id: Number(getConfig(db, tenantId, "revision_rule_default_id") || 0) || null,
  };
}

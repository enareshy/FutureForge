// Digital thread baselines.
//
// A baseline is a controlled, named snapshot of a thread that can be released
// and frozen for change control. Members are copied from a snapshot so a
// baseline is a self-contained, immutable record even if the source objects
// later change.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { publicBaseline, publicBaselineMember, parseJson } from "./repository.js";
import { baselineRef } from "./identifiers.js";
import { recordChange } from "./history.js";
import { publishThreadEvent, threadEventCode } from "./events.js";
import { createSnapshot, getSnapshotRow, snapshotNodes, getSnapshot } from "./snapshots.js";
import { baselineNotFound, baselineConflict, baselineImmutable, invalidBaseline } from "./errors.js";
import { IMMUTABLE_BASELINE_STATUSES, BASELINE_STATUSES } from "./constants.js";
import { normalizeText, paginate } from "./validation.js";
import { bumpEpoch } from "./cache.js";

export function getBaselineRow(db, tenantId, ref) {
  const text = String(ref ?? "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return queryOne(db, "SELECT * FROM thread_baselines WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(text)]);
  return queryOne(db, "SELECT * FROM thread_baselines WHERE tenant_id = ? AND baseline_ref = ?", [Number(tenantId), text]);
}

export function requireBaselineRow(db, tenantId, ref) {
  const row = getBaselineRow(db, tenantId, ref);
  if (!row) throw baselineNotFound(ref);
  return row;
}

export function baselineMembers(db, baselineId) {
  return queryAll(db, "SELECT * FROM thread_baseline_members WHERE baseline_id = ? ORDER BY id", [Number(baselineId)]).map(publicBaselineMember);
}

export function getBaseline(db, tenantId, ref, { includeMembers = false } = {}) {
  const row = requireBaselineRow(db, tenantId, ref);
  const baseline = publicBaseline(row);
  if (includeMembers) baseline.members = baselineMembers(db, row.id);
  return baseline;
}

export function listBaselines(db, tenantId, query = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    clauses.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.definition_code || query.definitionCode) {
    clauses.push("definition_code = ?");
    params.push(normalizeText(query.definition_code || query.definitionCode, { max: 64 }));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page } = paginate(query, { defaultPageSize: 50, maxPageSize: 200 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM thread_baselines ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM thread_baselines ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicBaseline), total, page, page_size: limit, source_module: "thread" };
}

function copyMembersFromSnapshot(db, baselineId, snapshotId) {
  const nodes = snapshotNodes(db, snapshotId);
  for (const node of nodes) {
    run(
      db,
      `INSERT INTO thread_baseline_members
         (baseline_id, node_ref, domain, source_object_type, source_object_id, revision, lifecycle_state, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [Number(baselineId), node.node_ref, node.domain || "", node.source_object_type || "", node.source_object_id || "", node.revision || "", node.lifecycle_state || "", JSON.stringify(node.metadata || {})]
    );
  }
  return nodes.length;
}

export function createBaseline(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const name = normalizeText(body.name, { max: 200 });
  if (!name) throw invalidBaseline("A baseline name is required");
  const status = String(body.status || "DRAFT").toUpperCase();
  if (!BASELINE_STATUSES.includes(status)) throw invalidBaseline(`Unknown baseline status: ${status}`);

  let snapshotRow = null;
  if (body.snapshot_id != null || body.snapshot_ref) {
    snapshotRow = getSnapshotRow(db, tenant, body.snapshot_id ?? body.snapshot_ref);
    if (!snapshotRow) throw invalidBaseline("The referenced snapshot was not found");
  } else {
    if (!body.root) throw invalidBaseline("A baseline needs a snapshot_id or a root object");
    const created = createSnapshot(db, tenant, { ...body, name: `${name} snapshot` }, actor, ip);
    snapshotRow = getSnapshotRow(db, tenant, created.id);
  }

  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO thread_baselines
       (baseline_ref, tenant_id, organization_id, snapshot_id, name, description, definition_code, query_context_json, status, immutable, member_count, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
    [
      baselineRef(name),
      tenant,
      body.organization_id != null ? Number(body.organization_id) : (snapshotRow.organization_id ?? null),
      snapshotRow.id,
      name,
      normalizeText(body.description, { max: 2000 }),
      normalizeText(body.definition_code || body.definitionCode || snapshotRow.definition_code, { max: 64 }),
      JSON.stringify(body.query_context && typeof body.query_context === "object" ? body.query_context : {}),
      status,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const baselineId = Number(result.lastInsertRowid);
  const memberCount = copyMembersFromSnapshot(db, baselineId, snapshotRow.id);
  run(db, "UPDATE thread_baselines SET member_count = ? WHERE id = ?", [memberCount, baselineId]);
  if (IMMUTABLE_BASELINE_STATUSES.includes(status)) {
    run(db, "UPDATE thread_baselines SET immutable = 1, released_by = ?, released_at = ? WHERE id = ?", [actor?.id ?? null, ts, baselineId]);
  }
  bumpEpoch(tenant);
  const baseline = getBaseline(db, tenant, baselineId, { includeMembers: true });
  recordChange(db, { tenantId: tenant, entityType: "BASELINE", entityId: baselineId, entityRef: baseline.baseline_ref, action: "CREATED", status: baseline.status, after: { baseline_ref: baseline.baseline_ref, member_count: memberCount }, summary: `Baseline ${baseline.baseline_ref} created`, actor, ip });
  publishThreadEvent(db, { eventType: threadEventCode("BASELINE_CREATED"), objectType: "thread_baseline", objectId: baselineId, tenantId: tenant, payload: { baseline_ref: baseline.baseline_ref, member_count: memberCount } }, actor);
  return baseline;
}

export function releaseBaseline(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireBaselineRow(db, tenant, ref);
  if (IMMUTABLE_BASELINE_STATUSES.includes(row.status)) return getBaseline(db, tenant, row.id, { includeMembers: true });
  const ts = nowIso();
  run(db, "UPDATE thread_baselines SET status = 'RELEASED', immutable = 1, released_by = ?, released_at = ?, updated_at = ? WHERE id = ?", [actor?.id ?? null, ts, ts, row.id]);
  bumpEpoch(tenant);
  const baseline = getBaseline(db, tenant, row.id, { includeMembers: true });
  recordChange(db, { tenantId: tenant, entityType: "BASELINE", entityId: row.id, entityRef: row.baseline_ref, action: "RELEASED", status: "RELEASED", summary: `Baseline ${row.baseline_ref} released`, actor, ip });
  publishThreadEvent(db, { eventType: threadEventCode("BASELINE_RELEASED"), objectType: "thread_baseline", objectId: row.id, tenantId: tenant, payload: { baseline_ref: row.baseline_ref } }, actor);
  return baseline;
}

export function freezeBaseline(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireBaselineRow(db, tenant, ref);
  if (row.status === "FROZEN") return getBaseline(db, tenant, row.id, { includeMembers: true });
  const ts = nowIso();
  run(db, "UPDATE thread_baselines SET status = 'FROZEN', immutable = 1, frozen_at = ?, updated_at = ? WHERE id = ?", [ts, ts, row.id]);
  bumpEpoch(tenant);
  const baseline = getBaseline(db, tenant, row.id, { includeMembers: true });
  recordChange(db, { tenantId: tenant, entityType: "BASELINE", entityId: row.id, entityRef: row.baseline_ref, action: "FROZEN", status: "FROZEN", summary: `Baseline ${row.baseline_ref} frozen`, actor, ip });
  publishThreadEvent(db, { eventType: threadEventCode("BASELINE_FROZEN"), objectType: "thread_baseline", objectId: row.id, tenantId: tenant, payload: { baseline_ref: row.baseline_ref } }, actor);
  return baseline;
}

export function updateBaseline(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireBaselineRow(db, tenant, ref);
  if (row.immutable === 1) throw baselineImmutable(row.baseline_ref);
  run(db, "UPDATE thread_baselines SET name = ?, description = ?, updated_at = ? WHERE id = ?", [
    normalizeText(body.name, { max: 200 }) || row.name,
    body.description !== undefined ? normalizeText(body.description, { max: 2000 }) : row.description,
    nowIso(),
    row.id,
  ]);
  bumpEpoch(tenant);
  return getBaseline(db, tenant, row.id, { includeMembers: true });
}

export function deleteBaseline(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireBaselineRow(db, tenant, ref);
  if (row.immutable === 1) {
    run(db, "UPDATE thread_baselines SET status = 'ARCHIVED', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
    bumpEpoch(tenant);
    return { archived: true, id: row.id, baseline_ref: row.baseline_ref };
  }
  run(db, "DELETE FROM thread_baselines WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  return { deleted: true, id: row.id, baseline_ref: row.baseline_ref };
}

export function baselineSummary(db, tenantId) {
  const rows = queryAll(db, "SELECT status, COUNT(*) AS c, COALESCE(SUM(member_count),0) AS members FROM thread_baselines WHERE tenant_id = ? GROUP BY status", [Number(tenantId)]);
  return {
    total: rows.reduce((sum, row) => sum + Number(row.c), 0),
    total_members: rows.reduce((sum, row) => sum + Number(row.members), 0),
    by_status: Object.fromEntries(rows.map((row) => [row.status, Number(row.c)])),
  };
}

export { getSnapshot, parseJson, baselineConflict };

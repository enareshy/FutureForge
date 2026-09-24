// BOM baseline service.
//
// A baseline is an immutable, flattened snapshot of a revision's structure taken
// at a point in time. It is the artifact released to manufacturing and used as a
// stable comparison target. Once frozen it can no longer be edited.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow } from "./sql.js";
import { publicBaseline, publicBaselineLine } from "./repository.js";
import { baselineRef } from "./refs.js";
import { bumpEpoch, invalidate } from "./cache.js";
import { recordChange } from "./history.js";
import { publishBomEvent, bomEventCode } from "./events.js";
import { getBomRow, requireBomRow } from "./definitions.js";
import { requireRevisionRow } from "./revisions.js";
import { flatStructure } from "./structure.js";
import { getConfig } from "./configuration.js";
import { normalizeText, normalizeUpper, toBool, toInt, paginate } from "./validation.js";
import { baselineNotFound, baselineConflict, invalidBaseline, baselineImmutable } from "./errors.js";
import { SOURCE_MODULE } from "./constants.js";

export function getBaselineRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM bom_baselines WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(db, "SELECT * FROM bom_baselines WHERE tenant_id = ? AND (baseline_ref = ? OR baseline_number = ? COLLATE NOCASE)", [Number(tenantId), String(ref), String(ref)]);
}

export function requireBaselineRow(db, tenantId, ref) {
  const row = getBaselineRow(db, tenantId, ref);
  if (!row) throw baselineNotFound(ref);
  return row;
}

export function getBaseline(db, tenantId, ref) {
  return publicBaseline(requireBaselineRow(db, tenantId, ref));
}

export function listBaselines(db, { tenantId, bomId, bomRef, revisionId, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  let resolvedBomId = bomId != null ? Number(bomId) : null;
  if (resolvedBomId == null && bomRef) {
    const header = getBomRow(db, tenantId, bomRef);
    if (!header) return { items: [], total: 0, page: 1, page_size: 50, source_module: SOURCE_MODULE };
    resolvedBomId = header.id;
  }
  if (resolvedBomId != null) {
    clauses.push("bom_id = ?");
    params.push(resolvedBomId);
  }
  if (revisionId != null) {
    clauses.push("revision_id = ?");
    params.push(Number(revisionId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM bom_baselines ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM bom_baselines ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicBaseline), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function createBaseline(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const bom = requireBomRow(db, tenant, body.bom_id ?? body.bomId ?? body.bom_ref ?? body.bomRef ?? body.bom_number ?? body.bomNumber);
  let revisionId = body.revision_id ?? body.revisionId ?? null;
  if (revisionId == null && (body.revision_ref || body.revisionRef || body.revision)) {
    revisionId = requireRevisionRow(db, tenant, body.revision_ref ?? body.revisionRef ?? body.revision, { bomId: bom.id }).id;
  }
  if (revisionId == null) throw invalidBaseline("revision_id (or revision_ref) is required");
  const revision = requireRevisionRow(db, tenant, revisionId, { bomId: bom.id });
  if (Number(revision.bom_id) !== Number(bom.id)) throw invalidBaseline("The revision does not belong to this BOM");
  const baselineNumber = normalizeText(body.baseline_number ?? body.baselineNumber ?? body.number ?? "", { max: 120 }) || `${bom.bom_number}-BL-${Date.now()}`;
  if (getBaselineRow(db, tenant, baselineNumber)) throw baselineConflict(baselineNumber);

  const snapshot = flatStructure(db, tenant, revision.id, { includeInactive: true });
  const status = normalizeUpper(body.status ?? "DRAFT");
  const immutable = toBool(body.immutable, toBool(getConfig(db, tenant, "baseline_immutable"), true));
  const ts = nowIso();
  const insert = run(
    db,
    `INSERT INTO bom_baselines
       (baseline_ref, tenant_id, organization_id, bom_id, revision_id, baseline_number, name, description, status,
        source_revision_number, immutable, line_count, snapshot_json, created_by, frozen_at, frozen_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [baselineRef(baselineNumber), tenant, bom.organization_id, bom.id, revision.id, baselineNumber,
      normalizeText(body.name ?? "", { max: 300 }), normalizeText(body.description ?? "", { max: 4000 }), status,
      revision.revision_number, immutable ? 1 : 0, snapshot.length,
      JSON.stringify({ revision_id: revision.id, revision_number: revision.revision_number, line_count: snapshot.length }),
      actor?.id ?? null, status === "FROZEN" ? ts : null, status === "FROZEN" ? actor?.id ?? null : null, ts, ts]
  );
  const baselineId = Number(insert.lastInsertRowid);
  for (const entry of snapshot) {
    const line = entry.line;
    run(
      db,
      `INSERT INTO bom_baseline_lines
         (tenant_id, baseline_id, line_ref, find_number, sequence, parent_object_id, parent_object_type, child_object_id, child_object_type,
          child_revision, quantity, uom, usage, optional, substitute, reference_designator, effectivity_json, variant_code, attributes_json, level, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenant, baselineId, line.line_ref, line.find_number, line.sequence, line.parent_object_id, line.parent_object_type,
        line.child_object_id, line.child_object_type, line.child_revision, line.quantity, line.uom, line.usage,
        line.optional ? 1 : 0, line.substitute ? 1 : 0, line.reference_designator, JSON.stringify(line.effectivity || {}),
        line.variant_code, JSON.stringify(line.attributes || {}), toInt(entry.level, 0), normalizeText(entry.path, { max: 1000 }), ts]
    );
  }
  const row = queryOne(db, "SELECT * FROM bom_baselines WHERE id = ?", [baselineId]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "BASELINE", entityId: baselineId, entityRef: row.baseline_ref, action: status === "FROZEN" ? "FROZEN" : "CREATED", status, after: publicBaseline(row), actor, ip, details: { bom_id: bom.id, revision_id: revision.id, line_count: snapshot.length } });
  publishBomEvent(db, { eventType: status === "FROZEN" ? bomEventCode("BASELINE_FROZEN") : bomEventCode("BASELINE_CREATED"), objectType: "bom_baseline", objectId: baselineId, tenantId: tenant, organizationId: row.organization_id, payload: { baseline_ref: row.baseline_ref, bom_ref: bom.bom_ref, line_count: snapshot.length } }, actor);
  return publicBaseline(row);
}

export function freezeBaseline(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireBaselineRow(db, tenant, ref);
  if (row.status === "RETIRED") throw baselineImmutable(row.baseline_ref);
  const before = publicBaseline(row);
  const ts = nowIso();
  updateRow(db, "bom_baselines", row.id, { status: "FROZEN", immutable: 1, frozen_at: ts, frozen_by: actor?.id ?? null }, { columns: ["status", "immutable", "frozen_at", "frozen_by"] });
  const updated = queryOne(db, "SELECT * FROM bom_baselines WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "BASELINE", entityId: row.id, entityRef: row.baseline_ref, action: "FROZEN", status: "FROZEN", before, after: publicBaseline(updated), actor, ip });
  publishBomEvent(db, { eventType: bomEventCode("BASELINE_FROZEN"), objectType: "bom_baseline", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { baseline_ref: row.baseline_ref } }, actor);
  return publicBaseline(updated);
}

export function deleteBaseline(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireBaselineRow(db, tenant, ref);
  if (row.status === "FROZEN" || (toBool(row.immutable, false) && row.status !== "DRAFT")) throw baselineImmutable(row.baseline_ref);
  const before = publicBaseline(row);
  run(db, "DELETE FROM bom_baseline_lines WHERE baseline_id = ?", [row.id]);
  run(db, "DELETE FROM bom_baselines WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "BASELINE", entityId: row.id, entityRef: row.baseline_ref, action: "DELETED", status: row.status, before, actor, ip });
  return { deleted: true, id: row.id, baseline_ref: row.baseline_ref };
}

export function listBaselineLines(db, tenantId, baselineId, { changeType, level, page, pageSize } = {}) {
  const row = requireBaselineRow(db, tenantId, baselineId);
  const clauses = ["tenant_id = ?", "baseline_id = ?"];
  const params = [Number(tenantId), row.id];
  if (level != null) {
    clauses.push("level = ?");
    params.push(Number(level));
  }
  void changeType;
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 200, maxPageSize: 5000 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM bom_baseline_lines ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM bom_baseline_lines ${where} ORDER BY sequence, id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicBaselineLine), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function baselineSnapshot(db, tenantId, baselineId) {
  const row = requireBaselineRow(db, tenantId, baselineId);
  const lines = queryAll(db, "SELECT * FROM bom_baseline_lines WHERE baseline_id = ? ORDER BY sequence, id", [row.id]).map(publicBaselineLine);
  return { baseline: publicBaseline(row), lines };
}

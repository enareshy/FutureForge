// BaselineService — frozen, historically reproducible logical state of selected
// enterprise data. Once frozen a baseline is immutable; later revisions never
// change what a baseline resolves to.
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync, transactionAsync } from "../../db-async.js";
import { writeAudit, recordStateChange, writeAuditAsync, recordStateChangeAsync } from "../audit.js";
import { emitDomainEvent, emitDomainEventAsync } from "../events/emit.js";
import { publicBaseline, publicBaselineObject, normalizeText, safeParse } from "./validation.js";
import { baselineRef } from "./refs.js";
import { baselineNotFound, baselineImmutable, invalidEffectivity } from "./errors.js";
import { resolveOne, resolveOneAsync } from "./engine.js";
import { resolvePolicy, resolvePolicyAsync } from "./policies.js";
import { getRevisionRow, getRevisionRowAsync } from "./revisions.js";
import { getVersionRow, getVersionRowAsync } from "./versions.js";

function objectsFor(db, baselineId) {
  return queryAll(db, "SELECT * FROM versioning_baseline_objects WHERE baseline_id = ? ORDER BY object_type, object_id", [baselineId]);
}

async function objectsForAsync(db, baselineId) {
  return queryAllAsync(db, "SELECT * FROM versioning_baseline_objects WHERE baseline_id = ? ORDER BY object_type, object_id", [baselineId]);
}

export function getBaselineRow(db, ref) {
  if (ref === undefined || ref === null || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref)) {
    return queryOne(db, "SELECT * FROM versioning_baselines WHERE id = ?", [numeric]);
  }
  return queryOne(db, "SELECT * FROM versioning_baselines WHERE baseline_ref = ? OR code = ?", [String(ref), String(ref)]);
}

export async function getBaselineRowAsync(db, ref) {
  if (ref === undefined || ref === null || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref)) {
    return queryOneAsync(db, "SELECT * FROM versioning_baselines WHERE id = ?", [numeric]);
  }
  return queryOneAsync(db, "SELECT * FROM versioning_baselines WHERE baseline_ref = ? OR code = ?", [String(ref), String(ref)]);
}

export function getBaseline(db, ref) {
  const row = getBaselineRow(db, ref);
  if (!row) throw baselineNotFound(ref);
  return publicBaseline(row, objectsFor(db, row.id));
}

export async function getBaselineAsync(db, ref) {
  const row = await getBaselineRowAsync(db, ref);
  if (!row) throw baselineNotFound(ref);
  return publicBaseline(row, await objectsForAsync(db, row.id));
}

export function listBaselines(db, { status, tenantId, q, page = 1, pageSize = 50 } = {}) {
  const clauses = ["1 = 1"];
  const params = [];
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (q) {
    clauses.push("(code ILIKE ? OR name ILIKE ? OR description ILIKE ?)");
    const like = `%${String(q)}%`;
    params.push(like, like, like);
  }
  const where = clauses.join(" AND ");
  const total = queryOne(db, `SELECT COUNT(*) AS count FROM versioning_baselines WHERE ${where}`, params)?.count ?? 0;
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const rows = queryAll(db, `SELECT * FROM versioning_baselines WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  return { items: rows.map((row) => publicBaseline(row, objectsFor(db, row.id))), total, page: Number(page) || 1, page_size: limit };
}

export async function listBaselinesAsync(db, { status, tenantId, q, page = 1, pageSize = 50 } = {}) {
  const clauses = ["1 = 1"];
  const params = [];
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (q) {
    clauses.push("(code ILIKE ? OR name ILIKE ? OR description ILIKE ?)");
    const like = `%${String(q)}%`;
    params.push(like, like, like);
  }
  const where = clauses.join(" AND ");
  const total = (await queryOneAsync(db, `SELECT COUNT(*) AS count FROM versioning_baselines WHERE ${where}`, params))?.count ?? 0;
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const rows = await queryAllAsync(db, `SELECT * FROM versioning_baselines WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  const items = await Promise.all(rows.map(async (row) => publicBaseline(row, await objectsForAsync(db, row.id))));
  return { items, total, page: Number(page) || 1, page_size: limit };
}

function snapshotObject(db, entry, context, policyRow, actor, tenantId) {
  const objectType = normalizeText(entry.objectType ?? entry.object_type);
  const objectId = normalizeText(entry.objectId ?? entry.object_id ?? entry.id);
  if (!objectType || !objectId) throw invalidEffectivity("Each baseline object requires objectType and objectId");
  let revision = entry.revisionId || entry.revision_id ? getRevisionRow(db, entry.revisionId ?? entry.revision_id, { objectType }) : null;
  let version = entry.versionId || entry.version_id ? getVersionRow(db, entry.versionId ?? entry.version_id) : null;
  let status = "RESOLVED";
  let reason = "EXPLICIT";
  if (!revision) {
    const result = resolveOne(db, {
      objectType,
      objectId,
      rawContext: context,
      policyRow,
      actor,
      tenantId,
      record: false,
    });
    status = result.resolutionStatus;
    reason = result.resolutionReason;
    revision = result.revision ? getRevisionRow(db, result.revision.id) : null;
    version = result.version ? getVersionRow(db, result.version.id) : null;
  }
  if (!revision && status === "RESOLVED") status = "NOT_FOUND";
  return {
    objectType,
    objectId,
    revisionId: revision?.id ?? null,
    versionId: version?.id ?? null,
    revisionCode: revision?.revision_code ?? "",
    versionNumber: version?.version_number ?? "",
    resolutionStatus: status,
    resolutionReason: reason,
    metadata: entry.metadata ?? {},
  };
}

async function snapshotObjectAsync(db, entry, context, policyRow, actor, tenantId) {
  const objectType = normalizeText(entry.objectType ?? entry.object_type);
  const objectId = normalizeText(entry.objectId ?? entry.object_id ?? entry.id);
  if (!objectType || !objectId) throw invalidEffectivity("Each baseline object requires objectType and objectId");
  let revision = entry.revisionId || entry.revision_id ? await getRevisionRowAsync(db, entry.revisionId ?? entry.revision_id, { objectType }) : null;
  let version = entry.versionId || entry.version_id ? await getVersionRowAsync(db, entry.versionId ?? entry.version_id) : null;
  let status = "RESOLVED";
  let reason = "EXPLICIT";
  if (!revision) {
    const result = await resolveOneAsync(db, {
      objectType,
      objectId,
      rawContext: context,
      policyRow,
      actor,
      tenantId,
      record: false,
    });
    status = result.resolutionStatus;
    reason = result.resolutionReason;
    revision = result.revision ? await getRevisionRowAsync(db, result.revision.id) : null;
    version = result.version ? await getVersionRowAsync(db, result.version.id) : null;
  }
  if (!revision && status === "RESOLVED") status = "NOT_FOUND";
  return {
    objectType,
    objectId,
    revisionId: revision?.id ?? null,
    versionId: version?.id ?? null,
    revisionCode: revision?.revision_code ?? "",
    versionNumber: version?.version_number ?? "",
    resolutionStatus: status,
    resolutionReason: reason,
    metadata: entry.metadata ?? {},
  };
}

export function createBaseline(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = normalizeText(input.code);
  if (!code) throw invalidEffectivity("Baseline code is required");
  const objects = Array.isArray(input.objects) ? input.objects : [];
  const context = input.context ?? {};
  return transaction(db, () => {
    const existing = queryOne(
      db,
      "SELECT id FROM versioning_baselines WHERE code = ? AND (tenant_id IS NULL OR ?::bigint IS NULL OR tenant_id = ?)",
      [code, tenantId, tenantId]
    );
    if (existing) throw invalidEffectivity(`Baseline ${code} already exists`);
    const policyRow = resolvePolicy(db, input.policy ?? input.policyCode);
    const ts = nowIso();
    const result = run(
      db,
      `INSERT INTO versioning_baselines
        (baseline_ref, code, name, description, owner_id, owner_name, status, context_json, object_count, locked,
         tenant_id, organization_id, version, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, 0, 0, ?, ?, 1, ?, ?, ?, ?)`,
      [
        baselineRef(code),
        code,
        normalizeText(input.name, code),
        normalizeText(input.description),
        input.ownerId ?? input.owner_id ?? actor?.id ?? null,
        normalizeText(input.ownerName ?? input.owner_name ?? actor?.name),
        JSON.stringify(context),
        input.tenantId ?? input.tenant_id ?? tenantId,
        input.organizationId ?? input.organization_id ?? null,
        actor?.id ?? null,
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
    const id = Number(result.lastInsertId);
    for (const entry of objects) {
      const snap = snapshotObject(db, entry, context, policyRow, actor, tenantId);
      run(
        db,
        `INSERT INTO versioning_baseline_objects
          (baseline_id, object_type, object_id, revision_id, version_id, revision_code, version_number, resolution_status, resolution_reason, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          snap.objectType,
          snap.objectId,
          snap.revisionId,
          snap.versionId,
          snap.revisionCode,
          snap.versionNumber,
          snap.resolutionStatus,
          snap.resolutionReason,
          JSON.stringify(snap.metadata),
          ts,
        ]
      );
    }
    run(db, "UPDATE versioning_baselines SET object_count = ? WHERE id = ?", [objects.length, id]);
    const row = queryOne(db, "SELECT * FROM versioning_baselines WHERE id = ?", [id]);
    writeAudit(db, {
      actor,
      action: "versioning.baseline.create",
      resourceType: "versioning_baseline",
      resourceId: id,
      details: { code, objects: objects.length, context },
      ip,
    });
    emitDomainEvent(
      db,
      {
        event_type_code: "BaselineCreated",
        source_module: "versioning",
        source_object_type: "versioning_baseline",
        source_object_id: id,
        tenant_id: row.tenant_id,
        organization_id: row.organization_id,
        payload: { baseline_id: id, code, object_count: objects.length },
      },
      actor
    );
    return publicBaseline(row, objectsFor(db, id));
  });
}

export async function createBaselineAsync(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = normalizeText(input.code);
  if (!code) throw invalidEffectivity("Baseline code is required");
  const objects = Array.isArray(input.objects) ? input.objects : [];
  const context = input.context ?? {};
  return transactionAsync(db, async () => {
    const existing = await queryOneAsync(
      db,
      "SELECT id FROM versioning_baselines WHERE code = ? AND (tenant_id IS NULL OR ?::bigint IS NULL OR tenant_id = ?)",
      [code, tenantId, tenantId]
    );
    if (existing) throw invalidEffectivity(`Baseline ${code} already exists`);
    const policyRow = await resolvePolicyAsync(db, input.policy ?? input.policyCode);
    const ts = nowIso();
    const result = await runAsync(
      db,
      `INSERT INTO versioning_baselines
        (baseline_ref, code, name, description, owner_id, owner_name, status, context_json, object_count, locked,
         tenant_id, organization_id, version, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, 0, 0, ?, ?, 1, ?, ?, ?, ?)`,
      [
        baselineRef(code),
        code,
        normalizeText(input.name, code),
        normalizeText(input.description),
        input.ownerId ?? input.owner_id ?? actor?.id ?? null,
        normalizeText(input.ownerName ?? input.owner_name ?? actor?.name),
        JSON.stringify(context),
        input.tenantId ?? input.tenant_id ?? tenantId,
        input.organizationId ?? input.organization_id ?? null,
        actor?.id ?? null,
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
    const id = Number(result.lastInsertId);
    for (const entry of objects) {
      const snap = await snapshotObjectAsync(db, entry, context, policyRow, actor, tenantId);
      await runAsync(
        db,
        `INSERT INTO versioning_baseline_objects
          (baseline_id, object_type, object_id, revision_id, version_id, revision_code, version_number, resolution_status, resolution_reason, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          snap.objectType,
          snap.objectId,
          snap.revisionId,
          snap.versionId,
          snap.revisionCode,
          snap.versionNumber,
          snap.resolutionStatus,
          snap.resolutionReason,
          JSON.stringify(snap.metadata),
          ts,
        ]
      );
    }
    await runAsync(db, "UPDATE versioning_baselines SET object_count = ? WHERE id = ?", [objects.length, id]);
    const row = await queryOneAsync(db, "SELECT * FROM versioning_baselines WHERE id = ?", [id]);
    await writeAuditAsync(db, {
      actor,
      action: "versioning.baseline.create",
      resourceType: "versioning_baseline",
      resourceId: id,
      details: { code, objects: objects.length, context },
      ip,
    });
    await emitDomainEventAsync(
      db,
      {
        event_type_code: "BaselineCreated",
        source_module: "versioning",
        source_object_type: "versioning_baseline",
        source_object_id: id,
        tenant_id: row.tenant_id,
        organization_id: row.organization_id,
        payload: { baseline_id: id, code, object_count: objects.length },
      },
      actor
    );
    return publicBaseline(row, await objectsForAsync(db, id));
  });
}

export function addBaselineObjects(db, ref, objects = [], actor = null, ip = null) {
  const row = getBaselineRow(db, ref);
  if (!row) throw baselineNotFound(ref);
  if (row.locked || row.status === "frozen") throw baselineImmutable(row.baseline_ref);
  const context = safeParse(row.context_json, {});
  const policyRow = resolvePolicy(db, null);
  return transaction(db, () => {
    let added = 0;
    for (const entry of objects) {
      const snap = snapshotObject(db, entry, context, policyRow, actor, row.tenant_id);
      const existing = queryOne(
        db,
        "SELECT id FROM versioning_baseline_objects WHERE baseline_id = ? AND object_type = ? AND object_id = ?",
        [row.id, snap.objectType, snap.objectId]
      );
      if (existing) {
        run(
          db,
          `UPDATE versioning_baseline_objects SET revision_id = ?, version_id = ?, revision_code = ?, version_number = ?,
             resolution_status = ?, resolution_reason = ?, metadata_json = ? WHERE id = ?`,
          [
            snap.revisionId,
            snap.versionId,
            snap.revisionCode,
            snap.versionNumber,
            snap.resolutionStatus,
            snap.resolutionReason,
            JSON.stringify(snap.metadata),
            existing.id,
          ]
        );
      } else {
        run(
          db,
          `INSERT INTO versioning_baseline_objects
            (baseline_id, object_type, object_id, revision_id, version_id, revision_code, version_number, resolution_status, resolution_reason, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            snap.objectType,
            snap.objectId,
            snap.revisionId,
            snap.versionId,
            snap.revisionCode,
            snap.versionNumber,
            snap.resolutionStatus,
            snap.resolutionReason,
            JSON.stringify(snap.metadata),
            nowIso(),
          ]
        );
        added += 1;
      }
    }
    const count = queryOne(db, "SELECT COUNT(*) AS c FROM versioning_baseline_objects WHERE baseline_id = ?", [row.id])?.c ?? 0;
    run(db, "UPDATE versioning_baselines SET object_count = ?, updated_at = ? WHERE id = ?", [Number(count), nowIso(), row.id]);
    writeAudit(db, {
      actor,
      action: "versioning.baseline.objects.add",
      resourceType: "versioning_baseline",
      resourceId: row.id,
      details: { added, object_count: Number(count) },
      ip,
    });
    return getBaseline(db, row.id);
  });
}

export async function addBaselineObjectsAsync(db, ref, objects = [], actor = null, ip = null) {
  const row = await getBaselineRowAsync(db, ref);
  if (!row) throw baselineNotFound(ref);
  if (row.locked || row.status === "frozen") throw baselineImmutable(row.baseline_ref);
  const context = safeParse(row.context_json, {});
  const policyRow = await resolvePolicyAsync(db, null);
  return transactionAsync(db, async () => {
    let added = 0;
    for (const entry of objects) {
      const snap = await snapshotObjectAsync(db, entry, context, policyRow, actor, row.tenant_id);
      const existing = await queryOneAsync(
        db,
        "SELECT id FROM versioning_baseline_objects WHERE baseline_id = ? AND object_type = ? AND object_id = ?",
        [row.id, snap.objectType, snap.objectId]
      );
      if (existing) {
        await runAsync(
          db,
          `UPDATE versioning_baseline_objects SET revision_id = ?, version_id = ?, revision_code = ?, version_number = ?,
             resolution_status = ?, resolution_reason = ?, metadata_json = ? WHERE id = ?`,
          [
            snap.revisionId,
            snap.versionId,
            snap.revisionCode,
            snap.versionNumber,
            snap.resolutionStatus,
            snap.resolutionReason,
            JSON.stringify(snap.metadata),
            existing.id,
          ]
        );
      } else {
        await runAsync(
          db,
          `INSERT INTO versioning_baseline_objects
            (baseline_id, object_type, object_id, revision_id, version_id, revision_code, version_number, resolution_status, resolution_reason, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            snap.objectType,
            snap.objectId,
            snap.revisionId,
            snap.versionId,
            snap.revisionCode,
            snap.versionNumber,
            snap.resolutionStatus,
            snap.resolutionReason,
            JSON.stringify(snap.metadata),
            nowIso(),
          ]
        );
        added += 1;
      }
    }
    const count = (await queryOneAsync(db, "SELECT COUNT(*) AS c FROM versioning_baseline_objects WHERE baseline_id = ?", [row.id]))?.c ?? 0;
    await runAsync(db, "UPDATE versioning_baselines SET object_count = ?, updated_at = ? WHERE id = ?", [Number(count), nowIso(), row.id]);
    await writeAuditAsync(db, {
      actor,
      action: "versioning.baseline.objects.add",
      resourceType: "versioning_baseline",
      resourceId: row.id,
      details: { added, object_count: Number(count) },
      ip,
    });
    return getBaselineAsync(db, row.id);
  });
}

export function removeBaselineObject(db, ref, objectType, objectId, actor = null, ip = null) {
  const row = getBaselineRow(db, ref);
  if (!row) throw baselineNotFound(ref);
  if (row.locked || row.status === "frozen") throw baselineImmutable(row.baseline_ref);
  run(db, "DELETE FROM versioning_baseline_objects WHERE baseline_id = ? AND object_type = ? AND object_id = ?", [
    row.id,
    String(objectType),
    String(objectId),
  ]);
  const count = queryOne(db, "SELECT COUNT(*) AS c FROM versioning_baseline_objects WHERE baseline_id = ?", [row.id])?.c ?? 0;
  run(db, "UPDATE versioning_baselines SET object_count = ?, updated_at = ? WHERE id = ?", [Number(count), nowIso(), row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.baseline.objects.remove",
    resourceType: "versioning_baseline",
    resourceId: row.id,
    details: { objectType, objectId },
    ip,
  });
  return getBaseline(db, row.id);
}

export async function removeBaselineObjectAsync(db, ref, objectType, objectId, actor = null, ip = null) {
  const row = await getBaselineRowAsync(db, ref);
  if (!row) throw baselineNotFound(ref);
  if (row.locked || row.status === "frozen") throw baselineImmutable(row.baseline_ref);
  await runAsync(db, "DELETE FROM versioning_baseline_objects WHERE baseline_id = ? AND object_type = ? AND object_id = ?", [
    row.id,
    String(objectType),
    String(objectId),
  ]);
  const count = (await queryOneAsync(db, "SELECT COUNT(*) AS c FROM versioning_baseline_objects WHERE baseline_id = ?", [row.id]))?.c ?? 0;
  await runAsync(db, "UPDATE versioning_baselines SET object_count = ?, updated_at = ? WHERE id = ?", [Number(count), nowIso(), row.id]);
  await writeAuditAsync(db, {
    actor,
    action: "versioning.baseline.objects.remove",
    resourceType: "versioning_baseline",
    resourceId: row.id,
    details: { objectType, objectId },
    ip,
  });
  return getBaselineAsync(db, row.id);
}

export function freezeBaseline(db, ref, actor = null, ip = null) {
  const row = getBaselineRow(db, ref);
  if (!row) throw baselineNotFound(ref);
  if (row.locked) throw baselineImmutable(row.baseline_ref);
  const ts = nowIso();
  run(
    db,
    "UPDATE versioning_baselines SET status = 'frozen', locked = 1, frozen_at = ?, frozen_by = ?, updated_at = ?, version = version + 1 WHERE id = ?",
    [ts, actor?.id ?? null, ts, row.id]
  );
  const updated = queryOne(db, "SELECT * FROM versioning_baselines WHERE id = ?", [row.id]);
  recordStateChange(db, {
    actor,
    tenantId: updated.tenant_id,
    organizationId: updated.organization_id,
    action: "versioning.baseline.freeze",
    objectType: "versioning_baseline",
    objectId: row.id,
    objectName: row.code,
    before: { status: row.status, locked: Boolean(row.locked) },
    after: { status: "frozen", locked: true },
    ip,
  });
  emitDomainEvent(
    db,
    {
      event_type_code: "BaselineFrozen",
      source_module: "versioning",
      source_object_type: "versioning_baseline",
      source_object_id: row.id,
      tenant_id: updated.tenant_id,
      organization_id: updated.organization_id,
      payload: { baseline_id: row.id, code: row.code, object_count: updated.object_count },
    },
    actor
  );
  return publicBaseline(updated, objectsFor(db, row.id));
}

export async function freezeBaselineAsync(db, ref, actor = null, ip = null) {
  const row = await getBaselineRowAsync(db, ref);
  if (!row) throw baselineNotFound(ref);
  if (row.locked) throw baselineImmutable(row.baseline_ref);
  const ts = nowIso();
  await runAsync(
    db,
    "UPDATE versioning_baselines SET status = 'frozen', locked = 1, frozen_at = ?, frozen_by = ?, updated_at = ?, version = version + 1 WHERE id = ?",
    [ts, actor?.id ?? null, ts, row.id]
  );
  const updated = await queryOneAsync(db, "SELECT * FROM versioning_baselines WHERE id = ?", [row.id]);
  await recordStateChangeAsync(db, {
    actor,
    tenantId: updated.tenant_id,
    organizationId: updated.organization_id,
    action: "versioning.baseline.freeze",
    objectType: "versioning_baseline",
    objectId: row.id,
    objectName: row.code,
    before: { status: row.status, locked: Boolean(row.locked) },
    after: { status: "frozen", locked: true },
    ip,
  });
  await emitDomainEventAsync(
    db,
    {
      event_type_code: "BaselineFrozen",
      source_module: "versioning",
      source_object_type: "versioning_baseline",
      source_object_id: row.id,
      tenant_id: updated.tenant_id,
      organization_id: updated.organization_id,
      payload: { baseline_id: row.id, code: row.code, object_count: updated.object_count },
    },
    actor
  );
  return publicBaseline(updated, await objectsForAsync(db, row.id));
}

export function deleteBaseline(db, ref, actor = null, ip = null) {
  const row = getBaselineRow(db, ref);
  if (!row) throw baselineNotFound(ref);
  if (row.locked) throw baselineImmutable(row.baseline_ref);
  run(db, "DELETE FROM versioning_baseline_objects WHERE baseline_id = ?", [row.id]);
  run(db, "DELETE FROM versioning_baselines WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.baseline.delete",
    resourceType: "versioning_baseline",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return { deleted: true, id: row.id };
}

export async function deleteBaselineAsync(db, ref, actor = null, ip = null) {
  const row = await getBaselineRowAsync(db, ref);
  if (!row) throw baselineNotFound(ref);
  if (row.locked) throw baselineImmutable(row.baseline_ref);
  await runAsync(db, "DELETE FROM versioning_baseline_objects WHERE baseline_id = ?", [row.id]);
  await runAsync(db, "DELETE FROM versioning_baselines WHERE id = ?", [row.id]);
  await writeAuditAsync(db, {
    actor,
    action: "versioning.baseline.delete",
    resourceType: "versioning_baseline",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return { deleted: true, id: row.id };
}

export function compareBaselines(db, leftRef, rightRef) {
  const left = getBaselineRow(db, leftRef);
  const right = getBaselineRow(db, rightRef);
  if (!left) throw baselineNotFound(leftRef);
  if (!right) throw baselineNotFound(rightRef);
  const leftObjects = objectsFor(db, left.id);
  const rightObjects = objectsFor(db, right.id);
  const key = (o) => `${o.object_type}:${o.object_id}`;
  const leftMap = new Map(leftObjects.map((o) => [key(o), o]));
  const rightMap = new Map(rightObjects.map((o) => [key(o), o]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, r] of rightMap.entries()) {
    if (!leftMap.has(k)) {
      added.push(publicBaselineObject(r));
    } else {
      const l = leftMap.get(k);
      if (String(l.revision_id ?? "") !== String(r.revision_id ?? "") || String(l.version_id ?? "") !== String(r.version_id ?? "")) {
        changed.push({ object: k, left: publicBaselineObject(l), right: publicBaselineObject(r) });
      }
    }
  }
  for (const [k, l] of leftMap.entries()) {
    if (!rightMap.has(k)) removed.push(publicBaselineObject(l));
  }
  return { left: publicBaseline(left), right: publicBaseline(right), added, removed, changed, identical: !added.length && !removed.length && !changed.length };
}

export async function compareBaselinesAsync(db, leftRef, rightRef) {
  const left = await getBaselineRowAsync(db, leftRef);
  const right = await getBaselineRowAsync(db, rightRef);
  if (!left) throw baselineNotFound(leftRef);
  if (!right) throw baselineNotFound(rightRef);
  const leftObjects = await objectsForAsync(db, left.id);
  const rightObjects = await objectsForAsync(db, right.id);
  const key = (o) => `${o.object_type}:${o.object_id}`;
  const leftMap = new Map(leftObjects.map((o) => [key(o), o]));
  const rightMap = new Map(rightObjects.map((o) => [key(o), o]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, r] of rightMap.entries()) {
    if (!leftMap.has(k)) {
      added.push(publicBaselineObject(r));
    } else {
      const l = leftMap.get(k);
      if (String(l.revision_id ?? "") !== String(r.revision_id ?? "") || String(l.version_id ?? "") !== String(r.version_id ?? "")) {
        changed.push({ object: k, left: publicBaselineObject(l), right: publicBaselineObject(r) });
      }
    }
  }
  for (const [k, l] of leftMap.entries()) {
    if (!rightMap.has(k)) removed.push(publicBaselineObject(l));
  }
  return { left: publicBaseline(left), right: publicBaseline(right), added, removed, changed, identical: !added.length && !removed.length && !changed.length };
}

// Return the frozen mapping — usable to reconstruct the exact state later even
// after newer revisions exist.
export function restoreBaseline(db, ref) {
  const baseline = getBaseline(db, ref);
  return {
    baseline: baseline.baseline_ref,
    status: baseline.status,
    locked: baseline.locked,
    context: baseline.context,
    objects: baseline.objects,
    restorable: baseline.status === "frozen",
  };
}

export async function restoreBaselineAsync(db, ref) {
  const baseline = await getBaselineAsync(db, ref);
  return {
    baseline: baseline.baseline_ref,
    status: baseline.status,
    locked: baseline.locked,
    context: baseline.context,
    objects: baseline.objects,
    restorable: baseline.status === "frozen",
  };
}

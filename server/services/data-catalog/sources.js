// Data sources and source mappings.
//
// A source is metadata about a system that originates or stores enterprise
// data. Credentials are NEVER stored here: `connection_reference` points at the
// Integration/API credential model. Source mappings describe which catalog
// objects/attributes the source provides; the Integration framework owns any
// actual movement or transformation.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  assertCatalogStatus,
  assertMappingType,
  assertSecurityClassification,
  assertSourceType,
  normalizeLower,
  normalizeText,
  normalizeUpper,
  paginate,
  parseObject,
  requireName,
} from "./validation.js";
import { sourceRef } from "./refs.js";
import { publicSource, publicSourceMapping } from "./repository.js";
import { sourceNotFound, sourceConflict, invalidSource, mappingNotFound, invalidMapping } from "./errors.js";
import { registerEntry, syncEntry, commitEntryChange, getEntryRow, subjectTableFor } from "./entries.js";
import { publishCatalogEvent } from "./events.js";

export { publicSource, publicSourceMapping };

export function getSourceRow(db, ref, tenantId = null) {
  if (ref === null || ref === undefined || ref === "") return null;
  if (typeof ref === "object") return ref;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    return tenantId
      ? queryOne(db, "SELECT * FROM dc_sources WHERE id = ? AND tenant_id = ?", [numeric, Number(tenantId)])
      : queryOne(db, "SELECT * FROM dc_sources WHERE id = ?", [numeric]);
  }
  const text = String(ref);
  const scoped = tenantId ? " AND tenant_id = ?" : "";
  return (
    queryOne(db, `SELECT * FROM dc_sources WHERE source_ref = ?${scoped}`, [text, ...(tenantId ? [Number(tenantId)] : [])]) ||
    queryOne(db, `SELECT * FROM dc_sources WHERE code = ?${scoped}`, [normalizeUpper(text), ...(tenantId ? [Number(tenantId)] : [])]) ||
    null
  );
}

export function findSourceByCode(db, tenantId, code) {
  return queryOne(db, "SELECT * FROM dc_sources WHERE tenant_id = ? AND code = ?", [Number(tenantId), normalizeUpper(code)]);
}

export function requireSource(db, ref, tenantId = null) {
  const row = getSourceRow(db, ref, tenantId);
  if (!row) throw sourceNotFound(ref);
  return row;
}

export function listSources(db, { tenantId, sourceType, status, classification, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (sourceType) {
    clauses.push("source_type = ?");
    params.push(assertSourceType(normalizeUpper(sourceType)));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(assertCatalogStatus(normalizeLower(status)));
  }
  if (classification) {
    clauses.push("classification = ?");
    params.push(assertSecurityClassification(normalizeLower(classification)));
  }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(system) LIKE ? OR LOWER(description) LIKE ?)");
    params.push(like, like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dc_sources ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM dc_sources ${where} ORDER BY code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map((row) => publicSource(row)), total, page: currentPage, page_size: limit };
}

export function listSourceMappings(db, sourceId, { status = null } = {}) {
  const clauses = ["source_id = ?"];
  const params = [Number(sourceId)];
  if (status) {
    clauses.push("status = ?");
    params.push(assertCatalogStatus(normalizeLower(status)));
  }
  return queryAll(db, `SELECT * FROM dc_source_mappings WHERE ${clauses.join(" AND ")} ORDER BY id`, params).map(publicSourceMapping);
}

export function getSource(db, ref, { includeMappings = true, tenantId = null } = {}) {
  const row = requireSource(db, ref, tenantId);
  const mappings = includeMappings ? listSourceMappings(db, row.id) : null;
  return publicSource(row, { mappings });
}

export function createSource(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = normalizeUpper(requireName(input.code, "Source code"));
  if (findSourceByCode(db, tenantId, code)) throw sourceConflict(code);
  const name = normalizeText(input.name) || code;
  const status = assertCatalogStatus(normalizeLower(input.status || "active"));
  const sourceType = assertSourceType(normalizeUpper(input.source_type || "APPLICATION"));
  const classification = assertSecurityClassification(normalizeLower(input.classification || "internal"));
  const connectionReference = normalizeText(input.connection_reference);
  assertConnectionReference(connectionReference);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dc_sources
      (source_ref, tenant_id, code, name, source_type, description, system, connection_reference, owner_user_id,
       classification, status, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sourceRef(code),
      Number(tenantId),
      code,
      name,
      sourceType,
      normalizeText(input.description),
      normalizeText(input.system),
      connectionReference,
      input.owner_user_id ?? null,
      classification,
      status,
      JSON.stringify(input.metadata ?? {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM dc_sources WHERE id = ?", [Number(result.lastInsertRowid)]);
  const entry = registerEntry(
    db,
    {
      entry_type: "SOURCE",
      code,
      name,
      display_name: name,
      description: row.description,
      source_id: row.id,
      classification,
      owner_user_id: row.owner_user_id,
      subject_table: subjectTableFor("SOURCE"),
      subject_id: row.id,
      metadata: parseObject(row.metadata_json, {}),
    },
    actor,
    tenantId
  );
  run(db, "UPDATE dc_sources SET entry_id = ? WHERE id = ?", [entry.id, row.id]);
  if (Array.isArray(input.mappings)) {
    for (const mapping of input.mappings) addSourceMapping(db, row.id, mapping, actor, tenantId);
  }
  writeAudit(db, {
    actor,
    action: "data_catalog.source.create",
    resourceType: "dc_source",
    resourceId: row.id,
    details: { code, source_type: sourceType, entry_id: entry.id },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "DataSourceCataloged",
    tenantId: Number(tenantId),
    objectType: "data_source",
    objectId: row.id,
    payload: { id: row.id, code, source_type: sourceType, entry_id: entry.id, entry_ref: entry.entry_ref },
  }, actor);
  return getSource(db, row.id, { tenantId });
}

function assertConnectionReference(reference) {
  const text = normalizeText(reference, { max: 200 });
  if (!text) return text;
  const lowered = text.toLowerCase();
  if (lowered.startsWith("http://") || lowered.startsWith("https://") || lowered.includes("password=") || lowered.includes("://") && lowered.includes("@")) {
    throw invalidSource("Connection reference must be an opaque integration credential reference, not a connection string or URL", {
      connection_reference: reference,
    });
  }
  return text;
}

export function updateSource(db, ref, patch = {}, actor = null, tenantId = null, ip = null) {
  const row = requireSource(db, ref, tenantId);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.code !== undefined) {
    const code = normalizeUpper(requireName(patch.code, "Source code"));
    const clash = queryOne(db, "SELECT id FROM dc_sources WHERE tenant_id = ? AND code = ? AND id <> ?", [row.tenant_id, code, row.id]);
    if (clash) throw sourceConflict(code);
    assign("code", code);
  }
  if (patch.name !== undefined) assign("name", normalizeText(patch.name) || row.code);
  if (patch.source_type !== undefined) assign("source_type", assertSourceType(normalizeUpper(patch.source_type)));
  if (patch.description !== undefined) assign("description", normalizeText(patch.description));
  if (patch.system !== undefined) assign("system", normalizeText(patch.system));
  if (patch.connection_reference !== undefined) assign("connection_reference", assertConnectionReference(patch.connection_reference));
  if (patch.owner_user_id !== undefined) assign("owner_user_id", patch.owner_user_id ?? null);
  if (patch.classification !== undefined) assign("classification", assertSecurityClassification(normalizeLower(patch.classification)));
  if (patch.status !== undefined) assign("status", assertCatalogStatus(normalizeLower(patch.status)));
  if (patch.metadata !== undefined) assign("metadata_json", JSON.stringify(parseObject(patch.metadata, {})));
  if (!changes.length) return getSource(db, row.id, { tenantId });

  assign("updated_by", actor?.id ?? null);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dc_sources SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = queryOne(db, "SELECT * FROM dc_sources WHERE id = ?", [row.id]);
  if (row.entry_id) {
    syncEntry(
      db,
      row.entry_id,
      {
        name: updated.name,
        description: updated.description,
        classification: updated.classification,
        owner_user_id: updated.owner_user_id,
        status: updated.status,
        metadata: parseObject(updated.metadata_json, {}),
      },
      actor
    );
    commitEntryChange(db, row.entry_id, { change_summary: `source updated: ${Object.keys(patch).join(", ")}` }, actor);
  }
  writeAudit(db, {
    actor,
    action: "data_catalog.source.update",
    resourceType: "dc_source",
    resourceId: row.id,
    details: { code: updated.code, fields: Object.keys(patch) },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "DataSourceCataloged",
    tenantId: row.tenant_id,
    objectType: "data_source",
    objectId: row.id,
    payload: { id: row.id, code: updated.code, fields: Object.keys(patch) },
  }, actor);
  return publicSource(updated);
}

export function setSourceStatus(db, ref, status, actor = null, tenantId = null, ip = null) {
  const row = requireSource(db, ref, tenantId);
  const next = assertCatalogStatus(normalizeLower(status));
  run(db, "UPDATE dc_sources SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [next, actor?.id ?? null, nowIso(), row.id]);
  if (row.entry_id) syncEntry(db, row.entry_id, { status: next }, actor);
  writeAudit(db, {
    actor,
    action: "data_catalog.source.status",
    resourceType: "dc_source",
    resourceId: row.id,
    details: { from: row.status, to: next },
    ip,
  });
  return publicSource(queryOne(db, "SELECT * FROM dc_sources WHERE id = ?", [row.id]));
}

export function getSourceMappingRow(db, id, tenantId = null) {
  return tenantId
    ? queryOne(db, "SELECT * FROM dc_source_mappings WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)])
    : queryOne(db, "SELECT * FROM dc_source_mappings WHERE id = ?", [Number(id)]);
}

export function addSourceMapping(db, sourceRefValue, input = {}, actor = null, tenantId = null, ip = null) {
  const source = requireSource(db, sourceRefValue, tenantId);
  const mappingType = assertMappingType(normalizeUpper(input.mapping_type || "SOURCE_TO_OBJECT"));
  const targetEntry = resolveMappingTarget(db, source.tenant_id, input.target_entry_id ?? input.target_entry_ref);
  if (!targetEntry && mappingType === "SOURCE_TO_OBJECT") {
    throw invalidMapping("A source-to-object mapping requires a valid target catalog entry", { target: input.target_entry_id ?? null });
  }
  const transformationReference = normalizeText(input.transformation_reference);
  const duplicate = queryOne(
    db,
    "SELECT id FROM dc_source_mappings WHERE tenant_id = ? AND source_id = ? AND COALESCE(target_entry_id, 0) = COALESCE(?, 0) AND mapping_type = ?",
    [source.tenant_id, source.id, targetEntry?.id ?? null, mappingType]
  );
  if (duplicate) throw invalidMapping("This source mapping already exists", { mapping_id: duplicate.id });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dc_source_mappings
      (tenant_id, source_id, source_object_type, source_object_ref, target_entry_id, mapping_type, transformation_reference,
       owner_user_id, status, effective_date, metadata_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      source.tenant_id,
      source.id,
      normalizeText(input.source_object_type),
      normalizeText(input.source_object_ref),
      targetEntry?.id ?? null,
      mappingType,
      transformationReference,
      input.owner_user_id ?? source.owner_user_id ?? null,
      assertCatalogStatus(normalizeLower(input.status || "active")),
      normalizeText(input.effective_date) || null,
      JSON.stringify(input.metadata ?? {}),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  writeAudit(db, {
    actor,
    action: "data_catalog.source.map",
    resourceType: "dc_source_mapping",
    resourceId: Number(result.lastInsertRowid),
    details: { source_id: source.id, mapping_type: mappingType, target_entry_id: targetEntry?.id ?? null },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "LineageCreated",
    tenantId: source.tenant_id,
    objectType: "data_source",
    objectId: source.id,
    payload: { source_id: source.id, target_entry_id: targetEntry?.id ?? null, mapping_type: mappingType },
  }, actor);
  return publicSourceMapping(queryOne(db, "SELECT * FROM dc_source_mappings WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function updateSourceMapping(db, mappingId, patch = {}, actor = null, tenantId = null, ip = null) {
  const row = getSourceMappingRow(db, mappingId, tenantId);
  if (!row) throw mappingNotFound(mappingId);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.mapping_type !== undefined) assign("mapping_type", assertMappingType(normalizeUpper(patch.mapping_type)));
  if (patch.transformation_reference !== undefined) assign("transformation_reference", normalizeText(patch.transformation_reference));
  if (patch.source_object_type !== undefined) assign("source_object_type", normalizeText(patch.source_object_type));
  if (patch.source_object_ref !== undefined) assign("source_object_ref", normalizeText(patch.source_object_ref));
  if (patch.status !== undefined) assign("status", assertCatalogStatus(normalizeLower(patch.status)));
  if (patch.effective_date !== undefined) assign("effective_date", normalizeText(patch.effective_date) || null);
  if (patch.owner_user_id !== undefined) assign("owner_user_id", patch.owner_user_id ?? null);
  if (patch.metadata !== undefined) assign("metadata_json", JSON.stringify(parseObject(patch.metadata, {})));
  if (patch.target_entry_id !== undefined || patch.target_entry_ref !== undefined) {
    const targetEntry = resolveMappingTarget(db, row.tenant_id, patch.target_entry_id ?? patch.target_entry_ref);
    assign("target_entry_id", targetEntry?.id ?? null);
  }
  if (!changes.length) return publicSourceMapping(row);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dc_source_mappings SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  return publicSourceMapping(queryOne(db, "SELECT * FROM dc_source_mappings WHERE id = ?", [row.id]));
}

export function removeSourceMapping(db, mappingId, actor = null, tenantId = null, ip = null) {
  const row = getSourceMappingRow(db, mappingId, tenantId);
  if (!row) throw mappingNotFound(mappingId);
  run(db, "DELETE FROM dc_source_mappings WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "data_catalog.source.unmap",
    resourceType: "dc_source_mapping",
    resourceId: row.id,
    details: { source_id: row.source_id },
    ip,
  });
  return { deleted: true, id: row.id };
}

function resolveMappingTarget(db, tenantId, target) {
  if (target === null || target === undefined || target === "") return null;
  const numeric = Number(target);
  if (Number.isInteger(numeric) && String(numeric) === String(target).trim()) {
    const row = getEntryRow(db, numeric, { tenantId });
    if (row) return row;
  }
  return getEntryRow(db, target, { tenantId });
}

export { sourceConflict, invalidSource, getEntryRow };

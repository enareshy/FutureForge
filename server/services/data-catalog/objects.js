// Catalog data objects and attributes.
//
// A catalog object describes an enterprise object type (Product, Customer,
// Equipment...) as metadata. It references the object types owned by business
// modules (target_object_type) but never stores or duplicates their data.
// Attributes describe the fields that object carries and link to business terms,
// sources and classifications.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  assertAttributeStatus,
  assertObjectStatus,
  assertSecurityClassification,
  normalizeLower,
  normalizeText,
  normalizeUpper,
  paginate,
  parseObject,
  requireName,
} from "./validation.js";
import { objectRef, attributeRef } from "./refs.js";
import { publicCatalogObject, publicCatalogAttribute } from "./repository.js";
import { objectNotFound, objectConflict, invalidObject, invalidAttribute, attributeNotFound, attributeConflict } from "./errors.js";
import { registerEntry, syncEntry, commitEntryChange, getEntryRow, subjectTableFor } from "./entries.js";
import { publishCatalogEvent } from "./events.js";

export { publicCatalogObject, publicCatalogAttribute };

export function getObjectRow(db, ref, tenantId = null) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    return tenantId
      ? queryOne(db, "SELECT * FROM dc_catalog_objects WHERE id = ? AND tenant_id = ?", [numeric, Number(tenantId)])
      : queryOne(db, "SELECT * FROM dc_catalog_objects WHERE id = ?", [numeric]);
  }
  const text = String(ref);
  const scoped = tenantId ? " AND tenant_id = ?" : "";
  const params = tenantId ? [text, Number(tenantId)] : [text];
  return (
    queryOne(db, `SELECT * FROM dc_catalog_objects WHERE object_ref = ?${scoped}`, params) ||
    queryOne(db, `SELECT * FROM dc_catalog_objects WHERE object_type = ?${scoped}`, [normalizeLower(text), ...(tenantId ? [Number(tenantId)] : [])]) ||
    null
  );
}

export function findObjectByType(db, tenantId, objectType) {
  return queryOne(db, "SELECT * FROM dc_catalog_objects WHERE tenant_id = ? AND object_type = ?", [
    Number(tenantId),
    normalizeLower(objectType),
  ]);
}

export function requireObject(db, ref, tenantId = null) {
  const row = getObjectRow(db, ref, tenantId);
  if (!row) throw objectNotFound(ref);
  return row;
}

export function listObjects(db, { tenantId, domainId, status, sourceId, classification, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (domainId) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeLower(status));
  }
  if (sourceId) {
    clauses.push("source_id = ?");
    params.push(Number(sourceId));
  }
  if (classification) {
    clauses.push("classification = ?");
    params.push(assertSecurityClassification(normalizeLower(classification)));
  }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    clauses.push("(LOWER(object_type) LIKE ? OR LOWER(display_name) LIKE ? OR LOWER(description) LIKE ?)");
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dc_catalog_objects ${where}`, params)?.c ?? 0);
  const rows = queryAll(db, `SELECT * FROM dc_catalog_objects ${where} ORDER BY object_type LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  return { items: rows.map((row) => publicCatalogObject(row)), total, page: currentPage, page_size: limit };
}

export function getObject(db, ref, { includeAttributes = true, tenantId = null } = {}) {
  const row = requireObject(db, ref, tenantId);
  const attributes = includeAttributes ? listAttributes(db, row.id) : null;
  return publicCatalogObject(row, { attributes });
}

export function createCatalogObject(db, input = {}, actor = null, tenantId = null, ip = null) {
  const objectType = normalizeLower(requireName(input.object_type || input.code, "Object type"));
  const existing = findObjectByType(db, tenantId, objectType);
  if (existing) throw objectConflict(objectType);
  const displayName = normalizeText(input.display_name || input.name) || objectType;
  const status = assertObjectStatus(normalizeLower(input.status || "active"));
  const classification = assertSecurityClassification(normalizeLower(input.classification || "internal"));
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dc_catalog_objects
      (object_ref, tenant_id, domain_id, object_type, display_name, description, target_object_type, source_id,
       classification, status, owner_user_id, steward_user_id, version, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      objectRef(objectType),
      Number(tenantId),
      input.domain_id ? Number(input.domain_id) : null,
      objectType,
      displayName,
      normalizeText(input.description),
      normalizeText(input.target_object_type),
      input.source_id ? Number(input.source_id) : null,
      classification,
      status,
      input.owner_user_id ?? null,
      input.steward_user_id ?? null,
      JSON.stringify(input.metadata ?? {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM dc_catalog_objects WHERE id = ?", [Number(result.lastInsertRowid)]);
  const entry = registerEntry(
    db,
    {
      entry_type: "OBJECT",
      code: objectType,
      name: displayName,
      display_name: displayName,
      description: row.description,
      domain_id: row.domain_id,
      source_id: row.source_id,
      classification,
      owner_user_id: row.owner_user_id,
      steward_user_id: row.steward_user_id,
      subject_table: subjectTableFor("OBJECT"),
      subject_id: row.id,
      metadata: parseObject(row.metadata_json, {}),
    },
    actor,
    tenantId
  );
  run(db, "UPDATE dc_catalog_objects SET entry_id = ? WHERE id = ?", [entry.id, row.id]);
  if (input.attributes && Array.isArray(input.attributes)) {
    for (const attribute of input.attributes) {
      createAttribute(db, row.id, attribute, actor, tenantId);
    }
  }
  writeAudit(db, {
    actor,
    action: "data_catalog.object.create",
    resourceType: "dc_catalog_object",
    resourceId: row.id,
    details: { object_type: objectType, entry_id: entry.id },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "CatalogObjectCreated",
    tenantId: Number(tenantId),
    objectType: "data_catalog_object",
    objectId: row.id,
    payload: { id: row.id, object_type: objectType, entry_id: entry.id, entry_ref: entry.entry_ref },
  }, actor);
  return getObject(db, row.id, { tenantId });
}

export function updateCatalogObject(db, ref, patch = {}, actor = null, tenantId = null, ip = null) {
  const row = requireObject(db, ref, tenantId);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.object_type !== undefined) {
    const objectType = normalizeLower(requireName(patch.object_type, "Object type"));
    const clash = queryOne(db, "SELECT id FROM dc_catalog_objects WHERE tenant_id = ? AND object_type = ? AND id <> ?", [
      row.tenant_id,
      objectType,
      row.id,
    ]);
    if (clash) throw objectConflict(objectType);
    assign("object_type", objectType);
  }
  if (patch.display_name !== undefined || patch.name !== undefined) assign("display_name", normalizeText(patch.display_name ?? patch.name) || row.object_type);
  if (patch.description !== undefined) assign("description", normalizeText(patch.description));
  if (patch.domain_id !== undefined) assign("domain_id", patch.domain_id === null ? null : Number(patch.domain_id));
  if (patch.target_object_type !== undefined) assign("target_object_type", normalizeText(patch.target_object_type));
  if (patch.source_id !== undefined) assign("source_id", patch.source_id === null ? null : Number(patch.source_id));
  if (patch.classification !== undefined) assign("classification", assertSecurityClassification(normalizeLower(patch.classification)));
  if (patch.status !== undefined) assign("status", assertObjectStatus(normalizeLower(patch.status)));
  if (patch.owner_user_id !== undefined) assign("owner_user_id", patch.owner_user_id ?? null);
  if (patch.steward_user_id !== undefined) assign("steward_user_id", patch.steward_user_id ?? null);
  if (patch.metadata !== undefined) assign("metadata_json", JSON.stringify(parseObject(patch.metadata, {})));
  if (!changes.length) return getObject(db, row.id, { tenantId });

  const nextVersion = Number(row.version || 1) + 1;
  assign("version", nextVersion);
  assign("updated_by", actor?.id ?? null);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dc_catalog_objects SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = queryOne(db, "SELECT * FROM dc_catalog_objects WHERE id = ?", [row.id]);

  if (row.entry_id) {
    syncEntry(
      db,
      row.entry_id,
      {
        name: updated.display_name,
        display_name: updated.display_name,
        description: updated.description,
        domain_id: updated.domain_id,
        source_id: updated.source_id,
        classification: updated.classification,
        owner_user_id: updated.owner_user_id,
        steward_user_id: updated.steward_user_id,
        status: updated.status,
        metadata: parseObject(updated.metadata_json, {}),
      },
      actor
    );
    commitEntryChange(db, row.entry_id, { change_summary: `object updated: ${Object.keys(patch).join(", ")}` }, actor);
  }

  writeAudit(db, {
    actor,
    action: "data_catalog.object.update",
    resourceType: "dc_catalog_object",
    resourceId: row.id,
    details: { object_type: updated.object_type, fields: Object.keys(patch) },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "CatalogObjectUpdated",
    tenantId: row.tenant_id,
    objectType: "data_catalog_object",
    objectId: row.id,
    payload: { id: row.id, object_type: updated.object_type, fields: Object.keys(patch) },
  }, actor);
  return publicCatalogObject(updated);
}

export function setObjectStatus(db, ref, status, actor = null, tenantId = null, ip = null) {
  const row = requireObject(db, ref, tenantId);
  const next = assertObjectStatus(normalizeLower(status));
  run(db, "UPDATE dc_catalog_objects SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    next,
    actor?.id ?? null,
    nowIso(),
    row.id,
  ]);
  if (row.entry_id) syncEntry(db, row.entry_id, { status: next }, actor);
  writeAudit(db, {
    actor,
    action: "data_catalog.object.status",
    resourceType: "dc_catalog_object",
    resourceId: row.id,
    details: { from: row.status, to: next },
    ip,
  });
  return publicCatalogObject(queryOne(db, "SELECT * FROM dc_catalog_objects WHERE id = ?", [row.id]));
}

export function listAttributes(db, objectRefValue, { status = null, tenantId = null } = {}) {
  const object = requireObject(db, objectRefValue, tenantId);
  const clauses = ["object_id = ?"];
  const params = [object.id];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeLower(status));
  }
  return queryAll(db, `SELECT * FROM dc_catalog_attributes WHERE ${clauses.join(" AND ")} ORDER BY attribute_name`, params).map(
    publicCatalogAttribute
  );
}

export function getAttributeRow(db, ref, tenantId = null) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    return tenantId
      ? queryOne(db, "SELECT * FROM dc_catalog_attributes WHERE id = ? AND tenant_id = ?", [numeric, Number(tenantId)])
      : queryOne(db, "SELECT * FROM dc_catalog_attributes WHERE id = ?", [numeric]);
  }
  const scoped = tenantId ? " AND tenant_id = ?" : "";
  const params = tenantId ? [String(ref), Number(tenantId)] : [String(ref)];
  return queryOne(db, `SELECT * FROM dc_catalog_attributes WHERE attribute_ref = ?${scoped}`, params);
}

export function requireAttribute(db, ref, tenantId = null) {
  const row = getAttributeRow(db, ref, tenantId);
  if (!row) throw attributeNotFound(ref);
  return row;
}

export function createAttribute(db, objectRefValue, input = {}, actor = null, tenantId = null, ip = null) {
  const object = requireObject(db, objectRefValue, tenantId);
  const attributeName = normalizeText(input.attribute_name || input.name);
  if (!attributeName) throw invalidAttribute("An attribute name is required");
  const existing = queryOne(db, "SELECT id FROM dc_catalog_attributes WHERE tenant_id = ? AND object_id = ? AND attribute_name = ?", [
    object.tenant_id,
    object.id,
    attributeName,
  ]);
  if (existing) throw attributeConflict(`${object.object_type}.${attributeName}`);

  const status = assertAttributeStatus(normalizeLower(input.status || "active"));
  const classification = assertSecurityClassification(normalizeLower(input.classification || object.classification || "internal"));
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dc_catalog_attributes
      (attribute_ref, tenant_id, object_id, attribute_name, display_name, description, data_type, mandatory,
       business_definition, domain_id, source_id, classification, owner_user_id, steward_user_id, status,
       version, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      attributeRef(object.object_type, attributeName),
      object.tenant_id,
      object.id,
      attributeName,
      normalizeText(input.display_name || input.label) || attributeName,
      normalizeText(input.description),
      normalizeLower(input.data_type || "string"),
      input.mandatory || input.is_required ? 1 : 0,
      normalizeText(input.business_definition),
      input.domain_id ? Number(input.domain_id) : object.domain_id ?? null,
      input.source_id ? Number(input.source_id) : object.source_id ?? null,
      classification,
      input.owner_user_id ?? object.owner_user_id ?? null,
      input.steward_user_id ?? object.steward_user_id ?? null,
      status,
      JSON.stringify(input.metadata ?? {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM dc_catalog_attributes WHERE id = ?", [Number(result.lastInsertRowid)]);
  const entry = registerEntry(
    db,
    {
      entry_type: "ATTRIBUTE",
      code: `${object.object_type}.${attributeName}`,
      name: row.display_name || attributeName,
      display_name: row.display_name,
      description: row.description,
      domain_id: row.domain_id,
      source_id: row.source_id,
      classification,
      owner_user_id: row.owner_user_id,
      steward_user_id: row.steward_user_id,
      subject_table: subjectTableFor("ATTRIBUTE"),
      subject_id: row.id,
      metadata: parseObject(row.metadata_json, {}),
    },
    actor,
    tenantId
  );
  run(db, "UPDATE dc_catalog_attributes SET entry_id = ? WHERE id = ?", [entry.id, row.id]);
  writeAudit(db, {
    actor,
    action: "data_catalog.attribute.create",
    resourceType: "dc_catalog_attribute",
    resourceId: row.id,
    details: { object_id: object.id, attribute_name: attributeName, entry_id: entry.id },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "CatalogAttributeChanged",
    tenantId: object.tenant_id,
    objectType: "data_catalog_attribute",
    objectId: row.id,
    payload: { id: row.id, object_id: object.id, attribute_name: attributeName, entry_id: entry.id },
  }, actor);
  return publicCatalogAttribute(queryOne(db, "SELECT * FROM dc_catalog_attributes WHERE id = ?", [row.id]));
}

export function updateAttribute(db, ref, patch = {}, actor = null, tenantId = null, ip = null) {
  const row = requireAttribute(db, ref, tenantId);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.attribute_name !== undefined || patch.name !== undefined) {
    const attributeName = normalizeText(patch.attribute_name ?? patch.name);
    if (!attributeName) throw invalidAttribute("An attribute name is required");
    const clash = queryOne(
      db,
      "SELECT id FROM dc_catalog_attributes WHERE tenant_id = ? AND object_id = ? AND attribute_name = ? AND id <> ?",
      [row.tenant_id, row.object_id, attributeName, row.id]
    );
    if (clash) throw attributeConflict(attributeName);
    assign("attribute_name", attributeName);
  }
  if (patch.display_name !== undefined || patch.label !== undefined) assign("display_name", normalizeText(patch.display_name ?? patch.label) || row.attribute_name);
  if (patch.description !== undefined) assign("description", normalizeText(patch.description));
  if (patch.data_type !== undefined) assign("data_type", normalizeLower(patch.data_type || "string"));
  if (patch.mandatory !== undefined || patch.is_required !== undefined) assign("mandatory", patch.mandatory ?? patch.is_required ? 1 : 0);
  if (patch.business_definition !== undefined) assign("business_definition", normalizeText(patch.business_definition));
  if (patch.domain_id !== undefined) assign("domain_id", patch.domain_id === null ? null : Number(patch.domain_id));
  if (patch.source_id !== undefined) assign("source_id", patch.source_id === null ? null : Number(patch.source_id));
  if (patch.classification !== undefined) assign("classification", assertSecurityClassification(normalizeLower(patch.classification)));
  if (patch.owner_user_id !== undefined) assign("owner_user_id", patch.owner_user_id ?? null);
  if (patch.steward_user_id !== undefined) assign("steward_user_id", patch.steward_user_id ?? null);
  if (patch.status !== undefined) assign("status", assertAttributeStatus(normalizeLower(patch.status)));
  if (patch.metadata !== undefined) assign("metadata_json", JSON.stringify(parseObject(patch.metadata, {})));
  if (!changes.length) return publicCatalogAttribute(row);

  const nextVersion = Number(row.version || 1) + 1;
  assign("version", nextVersion);
  assign("updated_by", actor?.id ?? null);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dc_catalog_attributes SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = queryOne(db, "SELECT * FROM dc_catalog_attributes WHERE id = ?", [row.id]);

  if (row.entry_id) {
    syncEntry(
      db,
      row.entry_id,
      {
        name: updated.display_name || updated.attribute_name,
        display_name: updated.display_name,
        description: updated.description,
        domain_id: updated.domain_id,
        source_id: updated.source_id,
        classification: updated.classification,
        owner_user_id: updated.owner_user_id,
        steward_user_id: updated.steward_user_id,
        status: updated.status,
        metadata: parseObject(updated.metadata_json, {}),
      },
      actor
    );
    commitEntryChange(db, row.entry_id, { change_summary: `attribute updated: ${Object.keys(patch).join(", ")}` }, actor);
  }

  writeAudit(db, {
    actor,
    action: "data_catalog.attribute.update",
    resourceType: "dc_catalog_attribute",
    resourceId: row.id,
    details: { attribute_name: updated.attribute_name, fields: Object.keys(patch) },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "CatalogAttributeChanged",
    tenantId: row.tenant_id,
    objectType: "data_catalog_attribute",
    objectId: row.id,
    payload: { id: row.id, fields: Object.keys(patch) },
  }, actor);
  return publicCatalogAttribute(updated);
}

export function setAttributeStatus(db, ref, status, actor = null, tenantId = null, ip = null) {
  const row = requireAttribute(db, ref, tenantId);
  const next = assertAttributeStatus(normalizeLower(status));
  run(db, "UPDATE dc_catalog_attributes SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    next,
    actor?.id ?? null,
    nowIso(),
    row.id,
  ]);
  if (row.entry_id) syncEntry(db, row.entry_id, { status: next }, actor);
  writeAudit(db, {
    actor,
    action: "data_catalog.attribute.status",
    resourceType: "dc_catalog_attribute",
    resourceId: row.id,
    details: { from: row.status, to: next },
    ip,
  });
  return publicCatalogAttribute(queryOne(db, "SELECT * FROM dc_catalog_attributes WHERE id = ?", [row.id]));
}

export { getEntryRow, objectConflict, invalidObject };

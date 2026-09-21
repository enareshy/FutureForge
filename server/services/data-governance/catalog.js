// Governed data catalogue. Business modules register the object types and
// attributes they own so the governance and quality engines know what exists,
// what is required and which reference domain validates a value. This is
// declarative metadata: no module-specific evaluation logic lives here.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { catalogConflict, catalogNotFound, invalidCatalog } from "./errors.js";
import { normalizeText, paginate, parseArray, parseObject, requireCode } from "./validation.js";
import { publicCatalogObject, publicCatalogAttribute } from "./repository.js";
import { publishGovernanceEvent } from "./events.js";

export { publicCatalogObject, publicCatalogAttribute };

export function getCatalogRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM dg_catalog_objects WHERE id = ?", [numeric]);
  }
  return null;
}

export function findCatalogByType(db, tenantId, objectType) {
  return queryOne(db, "SELECT * FROM dg_catalog_objects WHERE tenant_id = ? AND object_type = ?", [Number(tenantId), String(objectType)]);
}

export function requireCatalog(db, ref) {
  const row = getCatalogRow(db, ref);
  if (!row) throw catalogNotFound(ref);
  return row;
}

export function listCatalog(db, { tenantId, domainId, status, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (domainId) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status).toLowerCase());
  }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    clauses.push("(LOWER(object_type) LIKE ? OR LOWER(name) LIKE ? OR LOWER(description) LIKE ?)");
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dg_catalog_objects ${where}`, params)?.c ?? 0);
  const rows = queryAll(db, `SELECT * FROM dg_catalog_objects ${where} ORDER BY object_type LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map((row) => publicCatalogObject(row)), total, page: currentPage, page_size: limit };
}

export function getCatalog(db, ref, { includeAttributes = true } = {}) {
  const row = requireCatalog(db, ref);
  const attributes = includeAttributes ? listAttributes(db, row.id) : null;
  return publicCatalogObject(row, attributes);
}

export function registerCatalogObject(db, input = {}, actor = null, tenantId = null, ip = null) {
  const objectType = requireCode(input.object_type, "Object type code").toLowerCase();
  const existing = findCatalogByType(db, tenantId, objectType);
  if (existing) throw catalogConflict(objectType);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dg_catalog_objects
      (tenant_id, domain_id, object_type, name, description, source_adapter, event_trigger, schedule, status, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(tenantId),
      input.domain_id ? Number(input.domain_id) : null,
      objectType,
      normalizeText(input.name, objectType),
      normalizeText(input.description),
      normalizeText(input.source_adapter, "platform.objects"),
      input.event_trigger === false ? 0 : 1,
      normalizeText(input.schedule),
      normalizeText(input.status).toLowerCase() === "inactive" ? "inactive" : "active",
      JSON.stringify(input.metadata ?? {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM dg_catalog_objects WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, {
    actor,
    action: "data_governance.catalog.register",
    resourceType: "dg_catalog_object",
    resourceId: row.id,
    details: { object_type: objectType },
    ip,
  });
  return publicCatalogObject(row);
}

export function updateCatalogObject(db, ref, patch = {}, actor = null, ip = null) {
  const row = requireCatalog(db, ref);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.domain_id !== undefined) assign("domain_id", patch.domain_id === null ? null : Number(patch.domain_id));
  if (patch.name !== undefined) assign("name", normalizeText(patch.name, row.object_type));
  if (patch.description !== undefined) assign("description", normalizeText(patch.description));
  if (patch.source_adapter !== undefined) assign("source_adapter", normalizeText(patch.source_adapter, "platform.objects"));
  if (patch.event_trigger !== undefined) assign("event_trigger", patch.event_trigger ? 1 : 0);
  if (patch.schedule !== undefined) assign("schedule", normalizeText(patch.schedule));
  if (patch.status !== undefined) assign("status", normalizeText(patch.status).toLowerCase() === "inactive" ? "inactive" : "active");
  if (patch.metadata !== undefined) assign("metadata_json", JSON.stringify(patch.metadata ?? {}));
  if (!changes.length) return publicCatalogObject(row);
  assign("updated_by", actor?.id ?? null);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dg_catalog_objects SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  writeAudit(db, {
    actor,
    action: "data_governance.catalog.update",
    resourceType: "dg_catalog_object",
    resourceId: row.id,
    details: { object_type: row.object_type, fields: Object.keys(patch) },
    ip,
  });
  return publicCatalogObject(queryOne(db, "SELECT * FROM dg_catalog_objects WHERE id = ?", [row.id]));
}

export function listAttributes(db, objectId) {
  return queryAll(db, "SELECT * FROM dg_catalog_attributes WHERE object_id = ? AND status = 'active' ORDER BY attribute_name", [Number(objectId)]).map(
    publicCatalogAttribute
  );
}

export function registerAttribute(db, objectRef, input = {}, actor = null) {
  const object = requireCatalog(db, objectRef);
  const attributeName = normalizeText(input.attribute_name || input.name);
  if (!attributeName) throw invalidCatalog("An attribute name is required");
  const existing = queryOne(db, "SELECT id FROM dg_catalog_attributes WHERE tenant_id = ? AND object_id = ? AND attribute_name = ?", [
    object.tenant_id,
    object.id,
    attributeName,
  ]);
  if (existing) throw catalogConflict(`${object.object_type}.${attributeName}`);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dg_catalog_attributes
      (tenant_id, object_id, attribute_name, label, data_type, is_required, reference_domain, enum_values_json, status, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      object.tenant_id,
      object.id,
      attributeName,
      normalizeText(input.label, attributeName),
      normalizeText(input.data_type, "string"),
      input.is_required ? 1 : 0,
      normalizeText(input.reference_domain),
      JSON.stringify(parseArray(input.enum_values, [])),
      JSON.stringify(input.metadata ?? {}),
      ts,
      ts,
    ]
  );
  return publicCatalogAttribute(queryOne(db, "SELECT * FROM dg_catalog_attributes WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function updateAttribute(db, objectRef, attributeId, patch = {}) {
  const object = requireCatalog(db, objectRef);
  const row = queryOne(db, "SELECT * FROM dg_catalog_attributes WHERE id = ? AND object_id = ?", [Number(attributeId), object.id]);
  if (!row) throw catalogNotFound(attributeId);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.label !== undefined) assign("label", normalizeText(patch.label, row.attribute_name));
  if (patch.data_type !== undefined) assign("data_type", normalizeText(patch.data_type, "string"));
  if (patch.is_required !== undefined) assign("is_required", patch.is_required ? 1 : 0);
  if (patch.reference_domain !== undefined) assign("reference_domain", normalizeText(patch.reference_domain));
  if (patch.enum_values !== undefined) assign("enum_values_json", JSON.stringify(parseArray(patch.enum_values, [])));
  if (patch.status !== undefined) assign("status", normalizeText(patch.status).toLowerCase() === "inactive" ? "inactive" : "active");
  if (patch.metadata !== undefined) assign("metadata_json", JSON.stringify(parseObject(patch.metadata, {})));
  if (!changes.length) return publicCatalogAttribute(row);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dg_catalog_attributes SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  return publicCatalogAttribute(queryOne(db, "SELECT * FROM dg_catalog_attributes WHERE id = ?", [row.id]));
}

export function hasGovernedType(db, tenantId, objectType) {
  const row = findCatalogByType(db, tenantId, objectType);
  return Boolean(row && row.status === "active");
}

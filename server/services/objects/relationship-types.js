import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import * as metadata from "../metadata.js";
import {
  readTenant,
  writeTenant,
  tenantClause,
  assertReadable,
  assertMutable,
} from "../metadata/scope.js";
import { CARDINALITIES, SEMANTICS, normalizeEdgeDefinitions } from "./validation.js";

// Relationship type definitions: typed, cardinality-aware edges with an inline
// attribute contract. Global definitions (tenant_id NULL) are shared read-only;
// tenant definitions are isolated, mirroring the metadata scope model.

export const RELATIONSHIP_TYPE_STATUSES = ["draft", "active", "inactive"];

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function publicRelationshipType(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    module: row.module,
    source_type_id: row.source_type_id ?? null,
    target_type_id: row.target_type_id ?? null,
    source_type_code: row.source_type_code ?? null,
    target_type_code: row.target_type_code ?? null,
    cardinality: row.cardinality,
    directed: row.directed === 1,
    bidirectional: row.bidirectional === 1,
    inverse_code: row.inverse_code || "",
    semantic: row.semantic,
    required: row.required === 1,
    min_occurrences: row.min_occurrences,
    max_occurrences: row.max_occurrences ?? null,
    allow_self: row.allow_self === 1,
    cascade_delete: row.cascade_delete === 1,
    attributes: safeParse(row.attributes_json, []),
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    is_system: row.is_system === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const TYPE_SELECT = `
  SELECT rt.*,
    st.code AS source_type_code, tt.code AS target_type_code
  FROM relationship_types rt
  LEFT JOIN metadata_types st ON st.id = rt.source_type_id
  LEFT JOIN metadata_types tt ON tt.id = rt.target_type_id
`;

export function getRelationshipTypeRow(db, id) {
  return queryOne(db, `${TYPE_SELECT} WHERE rt.id = ?`, [Number(id)]);
}

export function findRelationshipType(db, idOrCode, tenantId) {
  if (idOrCode === undefined || idOrCode === null || idOrCode === "") return null;
  const text = String(idOrCode);
  if (/^\d+$/.test(text)) {
    const byId = getRelationshipTypeRow(db, Number(text));
    if (byId) {
      assertReadable(byId, tenantId, "Relationship type not found");
      return byId;
    }
  }
  const scope = tenantClause("rt", tenantId);
  const byCode = queryOne(
    db,
    `${TYPE_SELECT} WHERE rt.code = ? AND ${scope.sql} ORDER BY rt.tenant_id IS NULL LIMIT 1`,
    [text, ...scope.params]
  );
  if (!byCode) throw new HttpError(404, "Relationship type not found");
  return byCode;
}

export function getRelationshipType(db, idOrCode, tenantId) {
  return publicRelationshipType(findRelationshipType(db, idOrCode, tenantId));
}

export function listRelationshipTypes(db, query = {}, tenantId) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("rt", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.status) {
    where.push("rt.status = ?");
    params.push(query.status);
  }
  if (query.semantic) {
    where.push("rt.semantic = ?");
    params.push(query.semantic);
  }
  if (query.module) {
    where.push("rt.module = ?");
    params.push(query.module);
  }
  if (query.sourceTypeId || query.source_type_id) {
    where.push("rt.source_type_id = ?");
    params.push(Number(query.sourceTypeId || query.source_type_id));
  }
  if (query.targetTypeId || query.target_type_id) {
    where.push("rt.target_type_id = ?");
    params.push(Number(query.targetTypeId || query.target_type_id));
  }
  if (query.q) {
    where.push("(rt.code LIKE ? OR rt.name LIKE ? OR rt.description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM relationship_types rt ${clause}`, params).c;
  const items = queryAll(
    db,
    `${TYPE_SELECT} ${clause} ORDER BY rt.code LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicRelationshipType);
  return { items, total, page, pageSize };
}

function resolveTypeRef(db, value, tenantId, label) {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0" || value === "any") {
    return null;
  }
  const typeRow = metadata.findType(db, value, tenantId);
  if (!typeRow) throw new HttpError(400, `${label} not found`);
  return typeRow.id;
}

function normalizeBounds(body, current = {}) {
  const min = body.min_occurrences === undefined && body.minOccurrences === undefined
    ? current.min_occurrences ?? 0
    : Number(body.min_occurrences ?? body.minOccurrences ?? 0);
  if (!Number.isInteger(min) || min < 0) {
    throw new HttpError(400, "min_occurrences must be a non-negative integer");
  }
  let max = body.max_occurrences === undefined && body.maxOccurrences === undefined
    ? current.max_occurrences ?? null
    : body.max_occurrences ?? body.maxOccurrences ?? null;
  if (max !== null && max !== undefined && max !== "") {
    max = Number(max);
    if (!Number.isInteger(max) || max < 0) {
      throw new HttpError(400, "max_occurrences must be a non-negative integer");
    }
    if (max < min) throw new HttpError(400, "max_occurrences cannot be less than min_occurrences");
  } else {
    max = null;
  }
  return { min, max };
}

export function createRelationshipType(db, body, actor, ip, reqTenantId, query = {}) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "Relationship type code");
  const tenantId = writeTenant(db, actor, body, reqTenantId);
  const sourceTypeId = resolveTypeRef(db, body.source_type_id ?? body.sourceTypeId, tenantId, "Source type");
  const targetTypeId = resolveTypeRef(db, body.target_type_id ?? body.targetTypeId, tenantId, "Target type");
  const cardinality = body.cardinality || "N:N";
  if (!CARDINALITIES.includes(cardinality)) {
    throw new HttpError(400, `cardinality must be one of: ${CARDINALITIES.join(", ")}`);
  }
  const semantic = body.semantic || "association";
  if (!SEMANTICS.includes(semantic)) {
    throw new HttpError(400, `semantic must be one of: ${SEMANTICS.join(", ")}`);
  }
  const status = body.status || "draft";
  if (!RELATIONSHIP_TYPE_STATUSES.includes(status)) {
    throw new HttpError(400, "status must be draft, active or inactive");
  }
  const { min, max } = normalizeBounds(body);
  const attributes = normalizeEdgeDefinitions(body.attributes ?? body.attributes_json);
  const cascadeDefault = semantic === "composition";
  const cascade = body.cascade_delete === undefined && body.cascadeDelete === undefined
    ? cascadeDefault
    : Boolean(body.cascade_delete ?? body.cascadeDelete);
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO relationship_types
        (code, name, description, module, source_type_id, target_type_id, cardinality, directed,
         bidirectional, inverse_code, semantic, required, min_occurrences, max_occurrences,
         allow_self, cascade_delete, attributes_json, status, tenant_id, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.description || "",
        body.module || "platform",
        sourceTypeId,
        targetTypeId,
        cardinality,
        body.directed === false || body.directed === 0 ? 0 : 1,
        body.bidirectional ? 1 : 0,
        body.inverse_code || body.inverseCode || "",
        semantic,
        body.required ? 1 : 0,
        min,
        max,
        body.allow_self || body.allowSelf ? 1 : 0,
        cascade ? 1 : 0,
        JSON.stringify(attributes),
        status,
        tenantId ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Relationship type code already exists in this scope");
    }
    throw err;
  }
  const row = getRelationshipTypeRow(db, result.lastInsertRowid);
  writeAudit(db, {
    actor,
    action: "relationship_type.create",
    resourceType: "relationship_type",
    resourceId: row.id,
    details: { code: row.code, cardinality, semantic, tenant_id: tenantId ?? null },
    ip,
  });
  return publicRelationshipType(row);
}

export function updateRelationshipType(db, id, body, actor, ip, tenantId) {
  const row = getRelationshipTypeRow(db, id);
  assertMutable(db, row, tenantId, actor, "Relationship type not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "Relationship type code");
  const cardinality = body.cardinality ?? row.cardinality;
  if (!CARDINALITIES.includes(cardinality)) {
    throw new HttpError(400, `cardinality must be one of: ${CARDINALITIES.join(", ")}`);
  }
  const semantic = body.semantic ?? row.semantic;
  if (!SEMANTICS.includes(semantic)) {
    throw new HttpError(400, `semantic must be one of: ${SEMANTICS.join(", ")}`);
  }
  const status = body.status ?? row.status;
  if (!RELATIONSHIP_TYPE_STATUSES.includes(status)) {
    throw new HttpError(400, "status must be draft, active or inactive");
  }
  const sourceTypeId = body.source_type_id === undefined && body.sourceTypeId === undefined
    ? row.source_type_id
    : resolveTypeRef(db, body.source_type_id ?? body.sourceTypeId, tenantId, "Source type");
  const targetTypeId = body.target_type_id === undefined && body.targetTypeId === undefined
    ? row.target_type_id
    : resolveTypeRef(db, body.target_type_id ?? body.targetTypeId, tenantId, "Target type");
  const { min, max } = normalizeBounds(body, row);
  const attributes = body.attributes === undefined && body.attributes_json === undefined
    ? row.attributes_json
    : JSON.stringify(normalizeEdgeDefinitions(body.attributes ?? body.attributes_json));
  try {
    run(
      db,
      `UPDATE relationship_types SET
        code = ?, name = ?, description = ?, module = ?, source_type_id = ?, target_type_id = ?,
        cardinality = ?, directed = ?, bidirectional = ?, inverse_code = ?, semantic = ?, required = ?,
        min_occurrences = ?, max_occurrences = ?, allow_self = ?, cascade_delete = ?, attributes_json = ?,
        status = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? row.code,
        String(body.name ?? row.name).trim(),
        body.description ?? row.description,
        body.module ?? row.module,
        sourceTypeId,
        targetTypeId,
        cardinality,
        body.directed === undefined ? row.directed : body.directed ? 1 : 0,
        body.bidirectional === undefined ? row.bidirectional : body.bidirectional ? 1 : 0,
        body.inverse_code ?? body.inverseCode ?? row.inverse_code,
        semantic,
        body.required === undefined ? row.required : body.required ? 1 : 0,
        min,
        max,
        body.allow_self === undefined && body.allowSelf === undefined ? row.allow_self : body.allow_self || body.allowSelf ? 1 : 0,
        body.cascade_delete === undefined && body.cascadeDelete === undefined
          ? row.cascade_delete
          : body.cascade_delete ?? body.cascadeDelete ? 1 : 0,
        attributes,
        status,
        nowIso(),
        row.id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Relationship type code already exists in this scope");
    }
    throw err;
  }
  const next = getRelationshipTypeRow(db, row.id);
  writeAudit(db, {
    actor,
    action: "relationship_type.update",
    resourceType: "relationship_type",
    resourceId: row.id,
    details: { code: next.code },
    ip,
  });
  return publicRelationshipType(next);
}

export function setRelationshipTypeStatus(db, id, status, actor, ip, tenantId) {
  if (!RELATIONSHIP_TYPE_STATUSES.includes(status)) {
    throw new HttpError(400, "status must be draft, active or inactive");
  }
  const row = getRelationshipTypeRow(db, id);
  assertMutable(db, row, tenantId, actor, "Relationship type not found");
  run(db, "UPDATE relationship_types SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), row.id]);
  writeAudit(db, {
    actor,
    action: `relationship_type.${status}`,
    resourceType: "relationship_type",
    resourceId: row.id,
    ip,
  });
  return publicRelationshipType(getRelationshipTypeRow(db, row.id));
}

export function deleteRelationshipType(db, id, actor, ip, tenantId) {
  const row = getRelationshipTypeRow(db, id);
  assertMutable(db, row, tenantId, actor, "Relationship type not found");
  const used = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM object_relationships WHERE relationship_type_id = ?",
    [row.id]
  ).c;
  if (used) throw new HttpError(409, "Cannot delete a relationship type in use by existing relationships");
  run(db, "DELETE FROM relationship_types WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "relationship_type.delete",
    resourceType: "relationship_type",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return { deleted: true, id: row.id };
}

export function readRelationshipTypeTenant(db, actor, query, reqTenantId) {
  return readTenant(db, actor, query, reqTenantId);
}

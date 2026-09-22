// Export definition administration.
//
// An export definition declares what leaves the platform: the object type, the
// selected fields, filters, transformations, output format and destination.
// Like imports, definitions are versioned and immutable once ACTIVE.
import { queryAll, queryOne, run, transaction, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { MAX_FIELDS, MAX_FILTERS } from "./constants.js";
import { exportDefinitionRef as makeDefinitionRef } from "./refs.js";
import {
  publicExportDefinition,
  publicExportFieldSelection,
  publicExportFilter,
  publicExportTransformation,
  publicDefinitionVersion,
} from "./repository.js";
import { definitionConflict, definitionImmutable, definitionNotFound, invalidDefinition } from "./errors.js";
import {
  normalizeText,
  normalizeUpper,
  paginate,
  parseArray,
  parseObject,
  requireCode,
  requireName,
  assertDefinitionStatus,
  assertExportFormat,
  assertExportDestination,
  assertFilterType,
  assertFilterOperator,
  assertTransformationType,
} from "./validation.js";
import { publishExchangeEvent } from "./events.js";
import { recordHistory } from "./history.js";

const EDITABLE_STATUSES = new Set(["DRAFT"]);

export function getExportDefinitionRow(db, tenantId, ref) {
  return queryOne(
    db,
    "SELECT * FROM ie_export_definitions WHERE tenant_id = ? AND (definition_ref = ? OR code = ? OR CAST(id AS TEXT) = ?)",
    [Number(tenantId), String(ref), normalizeUpper(ref), String(ref)]
  );
}

export function requireExportDefinitionRow(db, tenantId, ref) {
  const row = getExportDefinitionRow(db, tenantId, ref);
  if (!row) throw definitionNotFound(ref);
  return row;
}

function fieldsOf(db, definitionId) {
  return queryAll(db, "SELECT * FROM ie_export_field_selections WHERE definition_id = ? ORDER BY sequence, id", [Number(definitionId)]).map(publicExportFieldSelection);
}
function filtersOf(db, definitionId) {
  return queryAll(db, "SELECT * FROM ie_export_filters WHERE definition_id = ? ORDER BY sequence, id", [Number(definitionId)]).map(publicExportFilter);
}
function transformationsOf(db, definitionId) {
  return queryAll(db, "SELECT * FROM ie_export_transformations WHERE definition_id = ? ORDER BY sequence, id", [Number(definitionId)]).map(publicExportTransformation);
}

export function withExportChildren(db, row) {
  if (!row) return null;
  return { ...publicExportDefinition(row), field_selections: fieldsOf(db, row.id), export_filters: filtersOf(db, row.id), export_transformations: transformationsOf(db, row.id) };
}

export function getExportDefinition(db, tenantId, ref) {
  return withExportChildren(db, requireExportDefinitionRow(db, tenantId, ref));
}

function normalizeFieldSelections(fields) {
  if (!Array.isArray(fields)) return [];
  if (fields.length > MAX_FIELDS) throw invalidDefinition(`At most ${MAX_FIELDS} fields are allowed`);
  return fields.map((field, index) => ({
    sequence: Number(field.sequence ?? index),
    field_path: normalizeText(field.field_path ?? field.fieldPath ?? field.name, { max: 400 }),
    display_name: normalizeText(field.display_name ?? field.displayName ?? field.label, { max: 200 }),
    data_type: normalizeText(field.data_type ?? field.dataType ?? "string", { max: 40 }),
    transformation_json: JSON.stringify(parseArray(field.transformation ?? field.transformations, [])),
    nested: field.nested ? 1 : 0,
    status: normalizeText(field.status, { max: 16 }).toLowerCase() || "active",
  }));
}

function normalizeFilters(filters) {
  if (!Array.isArray(filters)) return [];
  if (filters.length > MAX_FILTERS) throw invalidDefinition(`At most ${MAX_FILTERS} filters are allowed`);
  return filters.map((filter, index) => ({
    sequence: Number(filter.sequence ?? index),
    filter_type: assertFilterType(filter.filter_type || filter.filterType || "ATTRIBUTE"),
    field: normalizeText(filter.field ?? filter.field_path ?? filter.fieldPath, { max: 400 }),
    operator: assertFilterOperator(filter.operator || "eq"),
    value_json: JSON.stringify(filter.value === undefined ? null : filter.value),
    conjunction: normalizeUpper(filter.conjunction || "AND") === "OR" ? "OR" : "AND",
    status: normalizeText(filter.status, { max: 16 }).toLowerCase() || "active",
  }));
}

function normalizeTransformations(transformations) {
  if (!Array.isArray(transformations)) return [];
  return transformations.map((entry, index) => ({
    sequence: Number(entry.sequence ?? index),
    field_path: normalizeText(entry.field_path ?? entry.fieldPath, { max: 400 }),
    transformation_type: assertTransformationType(entry.transformation_type || entry.transformationType),
    config_json: JSON.stringify(parseObject(entry.config, {})),
    status: normalizeText(entry.status, { max: 16 }).toLowerCase() || "active",
  }));
}

function writeFieldSelections(db, tenantId, definitionId, entries) {
  run(db, "DELETE FROM ie_export_field_selections WHERE definition_id = ?", [definitionId]);
  for (const entry of entries) {
    run(
      db,
      `INSERT INTO ie_export_field_selections (definition_id, tenant_id, sequence, field_path, display_name, data_type, transformation_json, nested, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [definitionId, Number(tenantId), entry.sequence, entry.field_path, entry.display_name, entry.data_type, entry.transformation_json, entry.nested, entry.status, nowIso()]
    );
  }
}

function writeFilters(db, tenantId, definitionId, entries) {
  run(db, "DELETE FROM ie_export_filters WHERE definition_id = ?", [definitionId]);
  for (const entry of entries) {
    run(
      db,
      `INSERT INTO ie_export_filters (definition_id, tenant_id, sequence, filter_type, field, operator, value_json, conjunction, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [definitionId, Number(tenantId), entry.sequence, entry.filter_type, entry.field, entry.operator, entry.value_json, entry.conjunction, entry.status, nowIso()]
    );
  }
}

function writeTransformations(db, tenantId, definitionId, entries) {
  run(db, "DELETE FROM ie_export_transformations WHERE definition_id = ?", [definitionId]);
  for (const entry of entries) {
    run(
      db,
      `INSERT INTO ie_export_transformations (definition_id, tenant_id, sequence, field_path, transformation_type, config_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [definitionId, Number(tenantId), entry.sequence, entry.field_path, entry.transformation_type, entry.config_json, entry.status, nowIso()]
    );
  }
}

function normalizeDefinitionInput(input = {}, existing = null) {
  const objectType = normalizeText(input.object_type ?? input.objectType ?? existing?.object_type, { max: 120 });
  if (!objectType) throw invalidDefinition("An object_type is required for an export definition");
  return {
    object_type: objectType,
    format: assertExportFormat(input.format || existing?.format || "CSV"),
    destination: assertExportDestination(input.destination || existing?.destination || "DOWNLOAD"),
    destination_config: parseObject(input.destination_config ?? input.destinationConfig, existing ? parseObject(existing.destination_json, {}) : {}),
    sort: parseArray(input.sort, existing ? parseArray(existing.sort_json, []) : []),
    transformation: parseObject(input.transformation, existing ? parseObject(existing.transformation_json, {}) : {}),
    security: parseObject(input.security, existing ? parseObject(existing.security_json, {}) : {}),
    catalog_refs: parseObject(input.catalog_refs ?? input.catalogRefs, existing ? parseObject(existing.catalog_refs_json, {}) : {}),
    schedule: parseObject(input.schedule, existing ? parseObject(existing.schedule_json, {}) : {}),
    max_records: Number(input.max_records ?? input.maxRecords ?? existing?.max_records ?? 100000),
    owner_user_id: input.owner_user_id ?? input.ownerUserId ?? existing?.owner_user_id ?? null,
  };
}

function snapshotVersion(db, row, actor, changeSummary) {
  run(
    db,
    `INSERT OR REPLACE INTO ie_export_definition_versions (definition_id, tenant_id, version, status, snapshot_json, change_summary, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.tenant_id, row.version, row.status, JSON.stringify(withExportChildren(db, row)), normalizeText(changeSummary, { max: 500 }), actor?.id ?? null, nowIso()]
  );
}

export function createExportDefinition(db, tenantId, input = {}, actor = null, ip = null) {
  const code = requireCode(input.code, "Definition code");
  if (queryOne(db, "SELECT id FROM ie_export_definitions WHERE tenant_id = ? AND code = ?", [Number(tenantId), code])) throw definitionConflict(code);
  const normalized = normalizeDefinitionInput(input);
  const fields = normalizeFieldSelections(input.field_selections || input.fields);
  const filters = normalizeFilters(input.export_filters || input.filters);
  const transformations = normalizeTransformations(input.export_transformations || input.transformations);
  const status = assertDefinitionStatus(input.status || "DRAFT");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO ie_export_definitions (definition_ref, tenant_id, organization_id, code, name, description, object_type, fields_json, filters_json, sort_json, transformation_json, format, destination, destination_json, schedule_json, security_json, catalog_refs_json, max_records, status, version, owner_user_id, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      makeDefinitionRef(code),
      Number(tenantId),
      input.organization_id ?? input.organizationId ?? null,
      code,
      requireName(input.name, "Definition name"),
      normalizeText(input.description),
      normalized.object_type,
      JSON.stringify(fields.map((field) => field.field_path)),
      JSON.stringify(filters.map((filter) => ({ filter_type: filter.filter_type, field: filter.field, operator: filter.operator }))),
      JSON.stringify(normalized.sort),
      JSON.stringify(normalized.transformation),
      normalized.format,
      normalized.destination,
      JSON.stringify(normalized.destination_config),
      JSON.stringify(normalized.schedule),
      JSON.stringify(normalized.security),
      JSON.stringify(normalized.catalog_refs),
      normalized.max_records,
      status,
      normalized.owner_user_id,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const id = Number(result.lastInsertRowid);
  writeFieldSelections(db, tenantId, id, fields);
  writeFilters(db, tenantId, id, filters);
  writeTransformations(db, tenantId, id, transformations);
  const row = queryOne(db, "SELECT * FROM ie_export_definitions WHERE id = ?", [id]);
  snapshotVersion(db, row, actor, "initial version");
  writeAudit(db, { actor, action: "data_exchange.export_definition.create", resourceType: "ie_export_definitions", resourceId: code, details: { object_type: normalized.object_type }, ip });
  recordHistory(db, { direction: "EXPORT", tenantId, definitionId: id, definitionVersion: 1, action: "DEFINITION_CREATED", status, objectType: normalized.object_type, format: normalized.format, actor, details: { code } });
  publishExchangeEvent(db, { eventType: "ExportDefinitionCreated", tenantId, objectType: "ie_export_definition", objectId: row.definition_ref, payload: { code } }, actor);
  return withExportChildren(db, row);
}

export function updateExportDefinition(db, tenantId, ref, patch = {}, actor = null, ip = null) {
  const row = requireExportDefinitionRow(db, tenantId, ref);
  if (!EDITABLE_STATUSES.has(row.status)) throw definitionImmutable(row.definition_ref, row.status);
  const normalized = normalizeDefinitionInput(patch, row);
  const hasFields = patch.field_selections !== undefined || patch.fields !== undefined;
  const hasFilters = patch.export_filters !== undefined || patch.filters !== undefined;
  const hasTransformations = patch.export_transformations !== undefined || patch.transformations !== undefined;
  transaction(db, () => {
    run(
      db,
      `UPDATE ie_export_definitions SET name = ?, description = ?, object_type = ?, fields_json = ?, filters_json = ?, sort_json = ?, transformation_json = ?, format = ?, destination = ?, destination_json = ?, schedule_json = ?, security_json = ?, catalog_refs_json = ?, max_records = ?, owner_user_id = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      [
        normalizeText(patch.name ?? row.name, { max: 200 }) || row.code,
        normalizeText(patch.description ?? row.description),
        normalized.object_type,
        hasFields ? JSON.stringify(normalizeFieldSelections(patch.field_selections || patch.fields).map((field) => field.field_path)) : row.fields_json,
        hasFilters ? JSON.stringify(normalizeFilters(patch.export_filters || patch.filters).map((filter) => ({ filter_type: filter.filter_type, field: filter.field, operator: filter.operator }))) : row.filters_json,
        JSON.stringify(normalized.sort),
        JSON.stringify(normalized.transformation),
        normalized.format,
        normalized.destination,
        JSON.stringify(normalized.destination_config),
        JSON.stringify(normalized.schedule),
        JSON.stringify(normalized.security),
        JSON.stringify(normalized.catalog_refs),
        normalized.max_records,
        normalized.owner_user_id,
        actor?.id ?? null,
        nowIso(),
        row.id,
      ]
    );
    if (hasFields) writeFieldSelections(db, tenantId, row.id, normalizeFieldSelections(patch.field_selections || patch.fields));
    if (hasFilters) writeFilters(db, tenantId, row.id, normalizeFilters(patch.export_filters || patch.filters));
    if (hasTransformations) writeTransformations(db, tenantId, row.id, normalizeTransformations(patch.export_transformations || patch.transformations));
  });
  const updated = queryOne(db, "SELECT * FROM ie_export_definitions WHERE id = ?", [row.id]);
  snapshotVersion(db, updated, actor, patch.change_summary || "definition updated");
  writeAudit(db, { actor, action: "data_exchange.export_definition.update", resourceType: "ie_export_definitions", resourceId: row.code, details: {}, ip });
  recordHistory(db, { direction: "EXPORT", tenantId, definitionId: row.id, definitionVersion: updated.version, action: "DEFINITION_UPDATED", status: updated.status, objectType: updated.object_type, format: updated.format, actor, details: { code: row.code } });
  publishExchangeEvent(db, { eventType: "ExportDefinitionUpdated", tenantId, objectType: "ie_export_definition", objectId: updated.definition_ref, payload: { code: row.code } }, actor);
  return withExportChildren(db, updated);
}

export function createExportDefinitionVersion(db, tenantId, ref, input = {}, actor = null, ip = null) {
  const row = requireExportDefinitionRow(db, tenantId, ref);
  snapshotVersion(db, row, actor, input.change_summary || `snapshot before version ${Number(row.version) + 1}`);
  const normalized = normalizeDefinitionInput(input, row);
  const hasFields = input.field_selections !== undefined || input.fields !== undefined;
  const hasFilters = input.export_filters !== undefined || input.filters !== undefined;
  const hasTransformations = input.export_transformations !== undefined || input.transformations !== undefined;
  const nextVersion = Number(row.version) + 1;
  transaction(db, () => {
    run(
      db,
      `UPDATE ie_export_definitions SET name = ?, description = ?, object_type = ?, fields_json = ?, filters_json = ?, sort_json = ?, transformation_json = ?, format = ?, destination = ?, destination_json = ?, schedule_json = ?, security_json = ?, catalog_refs_json = ?, max_records = ?, owner_user_id = ?, status = 'DRAFT', version = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      [
        normalizeText(input.name ?? row.name, { max: 200 }) || row.code,
        normalizeText(input.description !== undefined ? input.description : row.description),
        normalized.object_type,
        hasFields ? JSON.stringify(normalizeFieldSelections(input.field_selections || input.fields).map((field) => field.field_path)) : row.fields_json,
        hasFilters ? JSON.stringify(normalizeFilters(input.export_filters || input.filters).map((filter) => ({ filter_type: filter.filter_type, field: filter.field, operator: filter.operator }))) : row.filters_json,
        JSON.stringify(normalized.sort),
        JSON.stringify(normalized.transformation),
        normalized.format,
        normalized.destination,
        JSON.stringify(normalized.destination_config),
        JSON.stringify(normalized.schedule),
        JSON.stringify(normalized.security),
        JSON.stringify(normalized.catalog_refs),
        normalized.max_records,
        normalized.owner_user_id,
        nextVersion,
        actor?.id ?? null,
        nowIso(),
        row.id,
      ]
    );
    if (hasFields) writeFieldSelections(db, tenantId, row.id, normalizeFieldSelections(input.field_selections || input.fields));
    if (hasFilters) writeFilters(db, tenantId, row.id, normalizeFilters(input.export_filters || input.filters));
    if (hasTransformations) writeTransformations(db, tenantId, row.id, normalizeTransformations(input.export_transformations || input.transformations));
  });
  const updated = queryOne(db, "SELECT * FROM ie_export_definitions WHERE id = ?", [row.id]);
  snapshotVersion(db, updated, actor, input.change_summary || `version ${nextVersion}`);
  writeAudit(db, { actor, action: "data_exchange.export_definition.version", resourceType: "ie_export_definitions", resourceId: row.code, details: { version: nextVersion }, ip });
  return withExportChildren(db, updated);
}

export function setExportDefinitionStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = requireExportDefinitionRow(db, tenantId, ref);
  const next = assertDefinitionStatus(status);
  if (next === row.status) return withExportChildren(db, row);
  if (next === "ACTIVE") {
    const check = validateExportDefinition(db, tenantId, ref);
    if (!check.valid) throw invalidDefinition("Definition cannot be activated while blocking issues exist", { errors: check.errors });
  }
  run(db, "UPDATE ie_export_definitions SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [next, actor?.id ?? null, nowIso(), row.id]);
  const updated = queryOne(db, "SELECT * FROM ie_export_definitions WHERE id = ?", [row.id]);
  snapshotVersion(db, updated, actor, `status ${row.status} -> ${next}`);
  writeAudit(db, { actor, action: "data_exchange.export_definition.status", resourceType: "ie_export_definitions", resourceId: row.code, details: { status: next }, ip });
  return withExportChildren(db, updated);
}

export function listExportDefinitionVersions(db, tenantId, ref) {
  const row = requireExportDefinitionRow(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM ie_export_definition_versions WHERE definition_id = ? ORDER BY version DESC", [row.id]);
  return { items: rows.map(publicDefinitionVersion), total: rows.length };
}

export function listExportDefinitions(db, { tenantId, status, objectType, format, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(assertDefinitionStatus(status));
  }
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(normalizeText(objectType, { max: 120 }));
  }
  if (format) {
    clauses.push("format = ?");
    params.push(assertExportFormat(format));
  }
  const term = normalizeText(q);
  if (term) {
    clauses.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${term}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM ie_export_definitions ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM ie_export_definitions ${where} ORDER BY code, version DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicExportDefinition), total, page: currentPage, page_size: limit };
}

export function validateExportDefinition(db, tenantId, ref) {
  const definition = getExportDefinition(db, tenantId, ref);
  const errors = [];
  const warnings = [];
  if (!definition.object_type) errors.push({ code: "missing_object_type", message: "An object_type is required" });
  if (!definition.field_selections.length) warnings.push({ code: "no_fields", message: "No fields selected; all fields will be exported" });
  if (definition.max_records <= 0) errors.push({ code: "invalid_max_records", message: "max_records must be positive" });
  return { valid: errors.length === 0, errors, warnings };
}

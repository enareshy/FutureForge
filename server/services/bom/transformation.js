// BOM transformation (for example EBOM -> MBOM).
//
// A transformation definition is a named, versioned set of field/object mappings.
// Running it in DRY_RUN mode returns a preview; EXECUTE mode materializes a target
// BOM/revision. Every run is persisted in bom_transformation_runs for audit.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow } from "./sql.js";
import {
  publicTransformationDefinition,
  publicTransformationMapping,
  publicTransformationRun,
} from "./repository.js";
import { transformationRef, mappingRef, runRef } from "./refs.js";
import { bumpEpoch, invalidate } from "./cache.js";
import { recordChange } from "./history.js";
import { publishBomEvent, bomEventCode } from "./events.js";
import { requireRevisionRow } from "./revisions.js";
import { requireBomRow, createBom } from "./definitions.js";
import { createRevision } from "./revisions.js";
import { addLine } from "./lines.js";
import { flatStructure } from "./structure.js";
import {
  assertMappingType,
  assertTransformationMode,
  assertTransformationDefinitionStatus,
  normalizeText,
  normalizeUpper,
  parseObject,
  toBool,
  toInt,
  paginate,
} from "./validation.js";
import { transformationNotFound, transformationConflict, invalidTransformation, transformationFailed } from "./errors.js";
import { SOURCE_MODULE } from "./constants.js";

const DEFINITION_UPDATE_COLUMNS = ["name", "description", "source_bom_type", "target_bom_type", "status", "config_json", "version", "updated_by"];
const MAPPING_UPDATE_COLUMNS = ["source_path", "target_path", "mapping_type", "expression", "default_value", "required", "sequence", "config_json", "status"];

function definitionRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM bom_transformation_definitions WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(db, "SELECT * FROM bom_transformation_definitions WHERE tenant_id = ? AND (definition_ref = ? OR code = ? COLLATE NOCASE)", [Number(tenantId), String(ref), String(ref)]);
}

export function requireTransformationDefinition(db, tenantId, ref) {
  const row = definitionRow(db, tenantId, ref);
  if (!row) throw transformationNotFound(ref);
  return row;
}

export function listTransformationDefinitions(db, { tenantId, status, sourceBomType, targetBomType, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(assertTransformationDefinitionStatus(status));
  }
  if (sourceBomType) {
    clauses.push("source_bom_type = ?");
    params.push(normalizeUpper(sourceBomType));
  }
  if (targetBomType) {
    clauses.push("target_bom_type = ?");
    params.push(normalizeUpper(targetBomType));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM bom_transformation_definitions ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM bom_transformation_definitions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicTransformationDefinition), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function getTransformationDefinition(db, tenantId, ref) {
  const row = requireTransformationDefinition(db, tenantId, ref);
  return { ...publicTransformationDefinition(row), mappings: listMappings(db, tenantId, row.id).items };
}

export function createTransformationDefinition(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const code = normalizeUpper(body.code ?? "", { max: 120 });
  if (!code) throw invalidTransformation("code is required");
  if (definitionRow(db, tenant, code)) throw transformationConflict(code);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO bom_transformation_definitions
       (definition_ref, tenant_id, organization_id, code, name, description, source_bom_type, target_bom_type, status, mapping_count, config_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?)`,
    [transformationRef(code), tenant, body.organization_id != null ? Number(body.organization_id) : null, code,
      normalizeText(body.name ?? code, { max: 300 }), normalizeText(body.description ?? "", { max: 4000 }),
      normalizeUpper(body.source_bom_type ?? body.sourceBomType ?? "EBOM"), normalizeUpper(body.target_bom_type ?? body.targetBomType ?? "MBOM"),
      assertTransformationDefinitionStatus(body.status ?? "DRAFT"), JSON.stringify(parseObject(body.config ?? body.config_json, {})),
      actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const row = queryOne(db, "SELECT * FROM bom_transformation_definitions WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordChange(db, { tenantId: tenant, entityType: "TRANSFORMATION", entityId: row.id, entityRef: row.definition_ref, action: "CREATED", status: row.status, after: publicTransformationDefinition(row), actor, ip });
  return publicTransformationDefinition(row);
}

export function updateTransformationDefinition(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireTransformationDefinition(db, tenant, ref);
  const before = publicTransformationDefinition(row);
  updateRow(
    db,
    "bom_transformation_definitions",
    row.id,
    {
      name: normalizeText(body.name ?? row.name, { max: 300 }),
      description: normalizeText(body.description ?? row.description, { max: 4000 }),
      source_bom_type: body.source_bom_type ? normalizeUpper(body.source_bom_type ?? body.sourceBomType) : row.source_bom_type,
      target_bom_type: body.target_bom_type ? normalizeUpper(body.target_bom_type ?? body.targetBomType) : row.target_bom_type,
      status: body.status !== undefined ? assertTransformationDefinitionStatus(body.status) : row.status,
      config_json: JSON.stringify(parseObject(body.config ?? body.config_json ?? row.config_json, {})),
      version: Number(row.version) + 1,
      updated_by: actor?.id ?? null,
    },
    { columns: DEFINITION_UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM bom_transformation_definitions WHERE id = ?", [row.id]);
  recordChange(db, { tenantId: tenant, entityType: "TRANSFORMATION", entityId: row.id, entityRef: row.definition_ref, action: "UPDATED", status: updated.status, before, after: publicTransformationDefinition(updated), actor, ip });
  return publicTransformationDefinition(updated);
}

export function deleteTransformationDefinition(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireTransformationDefinition(db, tenant, ref);
  const before = publicTransformationDefinition(row);
  run(db, "DELETE FROM bom_transformation_mappings WHERE definition_id = ?", [row.id]);
  run(db, "DELETE FROM bom_transformation_definitions WHERE id = ?", [row.id]);
  recordChange(db, { tenantId: tenant, entityType: "TRANSFORMATION", entityId: row.id, entityRef: row.definition_ref, action: "DELETED", status: row.status, before, actor, ip });
  return { deleted: true, id: row.id, code: row.code };
}

export function listMappings(db, tenantId, definitionId, { page, pageSize } = {}) {
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 200, maxPageSize: 1000 });
  const total = Number(queryOne(db, "SELECT COUNT(*) AS c FROM bom_transformation_mappings WHERE tenant_id = ? AND definition_id = ?", [Number(tenantId), Number(definitionId)])?.c || 0);
  const rows = queryAll(db, "SELECT * FROM bom_transformation_mappings WHERE tenant_id = ? AND definition_id = ? ORDER BY sequence, id LIMIT ? OFFSET ?", [Number(tenantId), Number(definitionId), limit, offset]);
  return { items: rows.map(publicTransformationMapping), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

function normalizeMappingInput(body = {}, current = {}) {
  return {
    source_path: normalizeText(body.source_path ?? body.sourcePath ?? current.source_path ?? "", { max: 500 }),
    target_path: normalizeText(body.target_path ?? body.targetPath ?? current.target_path ?? "", { max: 500 }),
    mapping_type: assertMappingType(body.mapping_type ?? body.mappingType ?? current.mapping_type ?? "LINE"),
    expression: normalizeText(body.expression ?? current.expression ?? "", { max: 1000 }),
    default_value: normalizeText(body.default_value ?? body.defaultValue ?? current.default_value ?? "", { max: 1000 }),
    required: toBool(body.required ?? current.required, false),
    sequence: toInt(body.sequence ?? current.sequence ?? 0, 0),
    config: parseObject(body.config ?? current.config_json, {}),
    status: normalizeUpper(body.status ?? current.status ?? "ACTIVE"),
  };
}

export function createMapping(db, tenantId, definitionId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const definition = requireTransformationDefinition(db, tenant, definitionId);
  const normalized = normalizeMappingInput(body, {});
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO bom_transformation_mappings
       (tenant_id, definition_id, mapping_ref, source_path, target_path, mapping_type, expression, default_value, required, sequence, config_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenant, definition.id, mappingRef(normalized.source_path), normalized.source_path, normalized.target_path, normalized.mapping_type,
      normalized.expression, normalized.default_value, normalized.required ? 1 : 0, normalized.sequence, JSON.stringify(normalized.config || {}),
      normalized.status, ts, ts]
  );
  refreshMappingCount(db, definition.id);
  const row = queryOne(db, "SELECT * FROM bom_transformation_mappings WHERE id = ?", [Number(result.lastInsertRowid)]);
  return publicTransformationMapping(row);
}

export function updateMapping(db, tenantId, definitionId, mappingId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const definition = requireTransformationDefinition(db, tenant, definitionId);
  const row = queryOne(db, "SELECT * FROM bom_transformation_mappings WHERE id = ? AND definition_id = ?", [Number(mappingId), definition.id]);
  if (!row) throw transformationNotFound(mappingId);
  const normalized = normalizeMappingInput(body, row);
  updateRow(
    db,
    "bom_transformation_mappings",
    row.id,
    {
      source_path: normalized.source_path,
      target_path: normalized.target_path,
      mapping_type: normalized.mapping_type,
      expression: normalized.expression,
      default_value: normalized.default_value,
      required: normalized.required ? 1 : 0,
      sequence: normalized.sequence,
      config_json: JSON.stringify(normalized.config || {}),
      status: normalized.status,
    },
    { columns: MAPPING_UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM bom_transformation_mappings WHERE id = ?", [row.id]);
  return publicTransformationMapping(updated);
}

export function deleteMapping(db, tenantId, definitionId, mappingId) {
  const tenant = Number(tenantId);
  const definition = requireTransformationDefinition(db, tenant, definitionId);
  const row = queryOne(db, "SELECT * FROM bom_transformation_mappings WHERE id = ? AND definition_id = ?", [Number(mappingId), definition.id]);
  if (!row) throw transformationNotFound(mappingId);
  run(db, "DELETE FROM bom_transformation_mappings WHERE id = ?", [row.id]);
  refreshMappingCount(db, definition.id);
  return { deleted: true, id: row.id };
}

function refreshMappingCount(db, definitionId) {
  const count = Number(queryOne(db, "SELECT COUNT(*) AS c FROM bom_transformation_mappings WHERE definition_id = ?", [Number(definitionId)])?.c || 0);
  run(db, "UPDATE bom_transformation_definitions SET mapping_count = ? WHERE id = ?", [count, Number(definitionId)]);
}

// ── Execution ────────────────────────────────────────────────────────────────

function applyMappings(sourceLine, targetObjectId, mappings) {
  const attributes = parseObject(sourceLine.attributes_json, {});
  const applied = [];
  let quantity = Number(sourceLine.quantity) || 1;
  let usage = sourceLine.usage;
  let uom = sourceLine.uom;
  let childId = targetObjectId ?? sourceLine.child_object_id;
  const byType = (type) => mappings.filter((m) => m.mapping_type === type && String(m.status).toUpperCase() === "ACTIVE");

  for (const mapping of byType("OBJECT")) {
    if (mapping.source_path === String(sourceLine.child_object_id) && mapping.target_path) {
      childId = mapping.target_path;
      applied.push(`object:${mapping.source_path}->${mapping.target_path}`);
    }
  }
  for (const mapping of byType("QUANTITY")) {
    const multiplier = Number(mapping.expression || mapping.config?.multiplier || mapping.default_value || 1);
    if (Number.isFinite(multiplier) && multiplier !== 0) {
      quantity = Number((quantity * multiplier).toFixed(6));
      applied.push(`quantity:x${multiplier}`);
    }
  }
  for (const mapping of byType("LINE")) {
    if (mapping.target_path === "usage" && mapping.source_path) usage = normalizeUpper(mapping.source_path);
    if (mapping.target_path === "uom" && mapping.source_path) uom = normalizeUpper(mapping.source_path);
    applied.push(`line:${mapping.target_path}`);
  }
  for (const mapping of byType("ATTRIBUTE")) {
    const sourceKey = mapping.source_path;
    const targetKey = mapping.target_path || sourceKey;
    const value = attributes[sourceKey] ?? mapping.default_value ?? null;
    if (value !== null && value !== "") attributes[targetKey] = value;
    applied.push(`attribute:${targetKey}`);
  }
  for (const mapping of byType("CONSTANT")) {
    const targetKey = mapping.target_path || mapping.source_path;
    if (targetKey) attributes[targetKey] = mapping.default_value;
    applied.push(`constant:${targetKey}`);
  }
  return { child_object_id: childId, quantity, usage, uom, attributes, applied };
}

export function transform(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const definition = requireTransformationDefinition(db, tenant, body.definition_id ?? body.definitionId ?? body.definition ?? body.code);
  if (String(definition.status).toUpperCase() === "INACTIVE") throw invalidTransformation("The transformation definition is inactive");
  const mode = assertTransformationMode(body.mode ?? "DRY_RUN");
  const sourceRevision = requireRevisionRow(db, tenant, body.source_revision_id ?? body.sourceRevisionId ?? body.source_revision ?? body.sourceRevision ?? body.revision_id);
  const mappings = listMappings(db, tenant, definition.id, { pageSize: 1000 }).items;
  const sourceLines = flatStructure(db, tenant, sourceRevision.id, { includeInactive: true });
  const config = parseObject(definition.config_json, {});
  const usageMap = parseObject(config.usage_map ?? config.usageMap, { DESIGN: "MANUFACTURING" });

  const preview = [];
  const warnings = [];
  let mappedCount = 0;
  let unmappedCount = 0;
  for (const entry of sourceLines) {
    const line = entry.line;
    const objectMappings = mappings.filter((m) => m.mapping_type === "OBJECT");
    const hasObjectMapping = objectMappings.some((m) => m.source_path === String(line.child_object_id));
    const result = applyMappings(line, null, mappings);
    if (objectMappings.length && !hasObjectMapping && !toBool(config.allow_unmapped, false)) {
      unmappedCount += 1;
      warnings.push({ line_ref: line.line_ref, child_object_id: line.child_object_id, reason: "NO_OBJECT_MAPPING" });
      if (toBool(config.skip_unmapped, false)) continue;
    } else {
      mappedCount += 1;
    }
    const usage = usageMap[result.usage] ?? result.usage ?? config.default_usage ?? "MANUFACTURING";
    preview.push({
      source_line_ref: line.line_ref,
      child_object_id: result.child_object_id,
      child_object_type: line.child_object_type,
      child_revision: line.child_revision,
      quantity: result.quantity,
      uom: result.uom,
      usage: normalizeUpper(usage, { max: 40 }) || "MANUFACTURING",
      find_number: line.find_number,
      reference_designator: line.reference_designator,
      optional: Boolean(Number(line.optional)),
      attributes: result.attributes,
      applied_mappings: result.applied,
    });
  }

  const ts = nowIso();
  const summary = { mode, source_revision_id: sourceRevision.id, mapped: mappedCount, unmapped: unmappedCount, warnings: warnings.length, lines: preview.length };
  let targetBomId = body.target_bom_id != null ? Number(body.target_bom_id) : null;
  let targetRevisionId = null;
  let status = mode === "DRY_RUN" ? "COMPLETED" : "RUNNING";

  if (mode === "EXECUTE") {
    try {
      if (!targetBomId) {
        const bomNumber = normalizeText(body.target_bom_number ?? body.targetBomNumber ?? `${definition.code}-${Date.now()}`, { max: 120 });
        const header = createBom(db, tenant, {
          bom_number: bomNumber,
          name: normalizeText(body.target_name ?? `${definition.name} target`, { max: 300 }),
          bom_type: definition.target_bom_type,
          organization_id: sourceRevision.organization_id,
          owner_object_id: sourceRevision.object_id,
        }, actor, ip);
        targetBomId = header.id;
      } else {
        requireBomRow(db, tenant, targetBomId);
      }
      const revisionNumber = normalizeText(body.target_revision_number ?? body.targetRevisionNumber ?? sourceRevision.revision_number, { max: 60 });
      const revision = createRevision(db, tenant, targetBomId, {
        revision_number: revisionNumber,
        valid_from: sourceRevision.valid_from,
        valid_to: sourceRevision.valid_to,
        effectivity: parseObject(sourceRevision.effectivity_json, {}),
        configuration_context: sourceRevision.configuration_context,
      }, actor, ip);
      targetRevisionId = revision.id;
      for (const item of preview) {
        addLine(db, tenant, targetRevisionId, {
          child_object_id: item.child_object_id,
          child_object_type: item.child_object_type,
          child_revision: item.child_revision,
          quantity: item.quantity,
          uom: item.uom,
          usage: item.usage,
          find_number: item.find_number,
          reference_designator: item.reference_designator,
          optional: item.optional,
          attributes: item.attributes,
        }, actor, ip);
      }
      status = "COMPLETED";
    } catch (error) {
      status = "FAILED";
      summary.error = error.message;
    }
  }

  const insert = run(
    db,
    `INSERT INTO bom_transformation_runs
       (run_ref, tenant_id, organization_id, definition_id, source_revision_id, target_bom_id, target_revision_id, mode, status,
        summary_json, mapped_count, unmapped_count, warning_count, error_count, created_by, started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [runRef(), tenant, sourceRevision.organization_id, definition.id, sourceRevision.id, targetBomId, targetRevisionId, mode, status,
      JSON.stringify(summary), mappedCount, unmappedCount, warnings.length, status === "FAILED" ? 1 : 0, actor?.id ?? null, ts, nowIso(), ts]
  );
  const row = queryOne(db, "SELECT * FROM bom_transformation_runs WHERE id = ?", [Number(insert.lastInsertRowid)]);
  if (mode === "EXECUTE" && status === "FAILED") {
    publishBomEvent(db, { eventType: bomEventCode("TRANSFORMED"), objectType: "bom_transformation_run", objectId: row.id, tenantId: tenant, payload: { status, error: summary.error } }, actor);
    throw transformationFailed(summary.error || "Transformation failed", { run_ref: row.run_ref, summary });
  }
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "TRANSFORMATION_RUN", entityId: row.id, entityRef: row.run_ref, action: "TRANSFORMED", status, after: summary, actor, ip, details: { definition_id: definition.id, source_revision_id: sourceRevision.id, target_bom_id: targetBomId } });
  publishBomEvent(db, { eventType: bomEventCode("TRANSFORMED"), objectType: "bom_transformation_run", objectId: row.id, tenantId: tenant, organizationId: sourceRevision.organization_id, payload: { definition_code: definition.code, ...summary } }, actor);
  return { run: publicTransformationRun(row), preview: mode === "DRY_RUN" ? preview : undefined, summary };
}

export function listTransformationRuns(db, { tenantId, definitionId, sourceRevisionId, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (definitionId != null) {
    clauses.push("definition_id = ?");
    params.push(Number(definitionId));
  }
  if (sourceRevisionId != null) {
    clauses.push("source_revision_id = ?");
    params.push(Number(sourceRevisionId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM bom_transformation_runs ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM bom_transformation_runs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicTransformationRun), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function getTransformationRun(db, tenantId, ref) {
  const row = queryOne(db, "SELECT * FROM bom_transformation_runs WHERE tenant_id = ? AND (id = ? OR run_ref = ?)", [Number(tenantId), Number(ref) || -1, String(ref)]);
  return row ? publicTransformationRun(row) : null;
}

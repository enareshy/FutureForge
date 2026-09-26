// Migration definitions: the reusable, versioned contract that says how one
// source object type becomes one target object type (mapping, transformation,
// validation, duplicate handling, dependency strategy, batch/retry policy).
//
// A definition is data. Once ACTIVE it is immutable: changes create a new
// version so an in-flight migration can always be explained by the version it
// ran against (spec §9, §10).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { Engines } from "../data-exchange/engines/index.js";
import { SOURCE_MODULE } from "./constants.js";
import { definitionNotFound, definitionConflict, definitionImmutable, definitionBlocked, invalidDefinition } from "./errors.js";
import { definitionRef as makeDefinitionRef } from "./refs.js";
import {
  publicDefinition,
  publicDefinitionVersion,
  publicMapping,
  publicTransformation,
  publicValidationRule,
} from "./repository.js";
import {
  normalizeText,
  normalizeUpper,
  parseObject,
  paginate,
  requireCode,
  requireName,
  assertDefinitionStatus,
  assertDuplicateStrategy,
  assertDependencyStrategy,
  assertBatchSize,
  assertMappings,
  assertTransformations,
  assertValidationRules,
} from "./validation.js";
import { updateRow } from "./sql.js";
import { MAX_CHILDREN } from "./constants.js";

const MUTABLE = ["DRAFT", "INACTIVE"];

export function getDefinitionRow(db, tenantId, ref) {
  return queryOne(
    db,
    "SELECT * FROM mig_definitions WHERE tenant_id = ? AND (definition_ref = ? OR CAST(id AS TEXT) = ? OR code = ?)",
    [Number(tenantId), String(ref), String(ref), normalizeUpper(ref)]
  );
}

export function withDefinitionChildren(db, row) {
  if (!row) return null;
  const mappings = queryAll(db, "SELECT * FROM mig_mappings WHERE definition_id = ? ORDER BY sequence, id", [Number(row.id)]).map(publicMapping);
  const transformations = queryAll(db, "SELECT * FROM mig_transformations WHERE definition_id = ? ORDER BY sequence, id", [Number(row.id)]).map(publicTransformation);
  const validation_rules = queryAll(db, "SELECT * FROM mig_validation_rules WHERE definition_id = ? ORDER BY sequence, id", [Number(row.id)]).map(publicValidationRule);
  return { ...publicDefinition(row), mappings, transformations, validation_rules };
}

export function createDefinition(db, tenantId, input = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const code = requireCode(input.code, "Definition code");
  if (getDefinitionRow(db, tenant, code)) throw definitionConflict(code);
  const ts = nowIso();
  const source = parseObject(input.source, {});
  const targetSchema = parseObject(input.target_schema ?? input.targetSchema, {});
  const result = run(
    db,
    `INSERT INTO mig_definitions (definition_ref, tenant_id, organization_id, code, name, description, source_object_type, target_object_type,
       source_json, target_schema_json, duplicate_strategy, duplicate_key_json, dependency_strategy, batch_size, retry_json, error_policy,
       reconciliation_policy, status, version, owner_user_id, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 1, ?, ?, ?, ?, ?)`,
    [
      makeDefinitionRef(code),
      tenant,
      input.organization_id ?? input.organizationId ?? null,
      code,
      requireName(input.name || code, "Definition name"),
      normalizeText(input.description, { max: 2000 }),
      normalizeText(input.source_object_type ?? input.sourceObjectType, { max: 120 }),
      normalizeText(input.target_object_type ?? input.targetObjectType, { max: 120 }),
      JSON.stringify(source),
      JSON.stringify(targetSchema),
      assertDuplicateStrategy(input.duplicate_strategy ?? input.duplicateStrategy ?? "REJECT"),
      JSON.stringify(parseObject(input.duplicate_key ?? input.duplicateKey, {})),
      assertDependencyStrategy(input.dependency_strategy ?? input.dependencyStrategy ?? "STRICT"),
      assertBatchSize(input.batch_size ?? input.batchSize, { max: 100000, fallback: 500 }),
      JSON.stringify(parseObject(input.retry, {})),
      normalizeUpper(input.error_policy ?? input.errorPolicy ?? "CONTINUE") === "STOP_ON_ERROR" ? "STOP_ON_ERROR" : normalizeUpper(input.error_policy ?? input.errorPolicy ?? "CONTINUE") === "ROLLBACK_BATCH" ? "ROLLBACK_BATCH" : "CONTINUE",
      normalizeUpper(input.reconciliation_policy ?? input.reconciliationPolicy ?? "COUNT"),
      input.owner_user_id ?? input.ownerUserId ?? actor?.id ?? null,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const definitionId = Number(result.lastInsertRowid);
  replaceChildren(db, tenant, definitionId, input);
  const created = withDefinitionChildren(db, queryOne(db, "SELECT * FROM mig_definitions WHERE id = ?", [definitionId]));
  writeDefinitionVersion(db, created, actor, "Initial version");
  writeAudit(db, { actor, action: "migration.definition.create", resourceType: "mig_definitions", resourceId: created.definition_ref, details: { code }, ip });
  return created;
}

// Replaces the mapping/transformation/validation child rows atomically. Only
// called while the definition is mutable.
function replaceChildren(db, tenantId, definitionId, input = {}) {
  if (input.mappings !== undefined || input.mapping !== undefined) {
    const mappings = assertMappings(input.mappings ?? extractMappings(input.mapping));
    run(db, "DELETE FROM mig_mappings WHERE definition_id = ?", [definitionId]);
    for (const mapping of mappings.slice(0, MAX_CHILDREN)) {
      run(
        db,
        `INSERT INTO mig_mappings (definition_id, tenant_id, sequence, source_field, target_field, mapping_type, config_json, required, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [definitionId, tenantId, mapping.sequence, mapping.source_field, mapping.target_field, mapping.mapping_type, JSON.stringify(mapping.config), mapping.required ? 1 : 0, mapping.status, nowIso()]
      );
    }
  }
  if (input.transformations !== undefined || input.transformation !== undefined) {
    const transformations = assertTransformations(input.transformations ?? extractTransformations(input.transformation));
    run(db, "DELETE FROM mig_transformations WHERE definition_id = ?", [definitionId]);
    for (const transformation of transformations.slice(0, MAX_CHILDREN)) {
      run(
        db,
        `INSERT INTO mig_transformations (definition_id, tenant_id, sequence, stage, target_field, transformation_type, config_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [definitionId, tenantId, transformation.sequence, transformation.stage, transformation.target_field, transformation.transformation_type, JSON.stringify(transformation.config), transformation.status, nowIso()]
      );
    }
  }
  if (input.validation_rules !== undefined || input.validationRules !== undefined || input.validation !== undefined) {
    const rules = assertValidationRules(input.validation_rules ?? input.validationRules ?? extractRules(input.validation));
    run(db, "DELETE FROM mig_validation_rules WHERE definition_id = ?", [definitionId]);
    for (const rule of rules.slice(0, MAX_CHILDREN)) {
      run(
        db,
        `INSERT INTO mig_validation_rules (definition_id, tenant_id, sequence, level, target_field, rule_type, config_json, severity, message, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [definitionId, tenantId, rule.sequence, rule.level, rule.target_field, rule.rule_type, JSON.stringify(rule.config), rule.severity, rule.message, rule.status, nowIso()]
      );
    }
  }
}

function extractMappings(mapping) {
  if (Array.isArray(mapping)) return mapping;
  const object = parseObject(mapping, {});
  return Array.isArray(object.mappings) ? object.mappings : [];
}

function extractTransformations(transformation) {
  if (Array.isArray(transformation)) return transformation;
  const object = parseObject(transformation, {});
  return Array.isArray(object.transformations) ? object.transformations : [];
}

function extractRules(validation) {
  if (Array.isArray(validation)) return validation;
  const object = parseObject(validation, {});
  return Array.isArray(object.rules) ? object.rules : [];
}

export function getDefinition(db, tenantId, ref) {
  return withDefinitionChildren(db, getDefinitionRow(db, tenantId, ref));
}

export function listDefinitions(db, { tenantId, status, sourceObjectType, targetObjectType, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(assertDefinitionStatus(status));
  }
  if (sourceObjectType) {
    clauses.push("source_object_type = ?");
    params.push(normalizeText(sourceObjectType, { max: 120 }));
  }
  if (targetObjectType) {
    clauses.push("target_object_type = ?");
    params.push(normalizeText(targetObjectType, { max: 120 }));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_definitions ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_definitions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicDefinition), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function updateDefinition(db, tenantId, ref, patch = {}, actor = null, ip = null) {
  const row = getDefinitionRow(db, tenantId, ref);
  if (!row) throw definitionNotFound(ref);
  if (!MUTABLE.includes(row.status)) throw definitionImmutable(row.definition_ref, row.status);
  const fields = {};
  const assign = (value, key, transform) => {
    if (value !== undefined) fields[key] = transform ? transform(value) : value;
  };
  assign(patch.name, "name", (v) => requireName(v, "Definition name"));
  assign(patch.description, "description", (v) => normalizeText(v, { max: 2000 }));
  assign(patch.source_object_type ?? patch.sourceObjectType, "source_object_type", (v) => normalizeText(v, { max: 120 }));
  assign(patch.target_object_type ?? patch.targetObjectType, "target_object_type", (v) => normalizeText(v, { max: 120 }));
  assign(patch.source, "source_json", (v) => JSON.stringify(parseObject(v, {})));
  assign(patch.target_schema ?? patch.targetSchema, "target_schema_json", (v) => JSON.stringify(parseObject(v, {})));
  assign(patch.duplicate_strategy ?? patch.duplicateStrategy, "duplicate_strategy", (v) => assertDuplicateStrategy(v));
  assign(patch.duplicate_key ?? patch.duplicateKey, "duplicate_key_json", (v) => JSON.stringify(parseObject(v, {})));
  assign(patch.dependency_strategy ?? patch.dependencyStrategy, "dependency_strategy", (v) => assertDependencyStrategy(v));
  assign(patch.batch_size ?? patch.batchSize, "batch_size", (v) => assertBatchSize(v, { max: 100000, fallback: row.batch_size }));
  assign(patch.retry, "retry_json", (v) => JSON.stringify(parseObject(v, {})));
  assign(patch.error_policy ?? patch.errorPolicy, "error_policy", (v) => normalizeUpper(v));
  assign(patch.reconciliation_policy ?? patch.reconciliationPolicy, "reconciliation_policy", (v) => normalizeUpper(v));
  assign(patch.owner_user_id ?? patch.ownerUserId, "owner_user_id", (v) => (v != null ? Number(v) : null));
  if (Object.keys(fields).length) {
    fields.updated_by = actor?.id ?? null;
    updateRow(db, "mig_definitions", row.id, fields);
  }
  replaceChildren(db, Number(tenantId), row.id, patch);
  const updated = withDefinitionChildren(db, queryOne(db, "SELECT * FROM mig_definitions WHERE id = ?", [row.id]));
  writeAudit(db, { actor, action: "migration.definition.update", resourceType: "mig_definitions", resourceId: updated.definition_ref, details: { fields: Object.keys(fields) }, ip });
  return updated;
}

export function setDefinitionStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = getDefinitionRow(db, tenantId, ref);
  if (!row) throw definitionNotFound(ref);
  const next = assertDefinitionStatus(status);
  if (next === "ACTIVE") {
    const validation = validateDefinition(db, tenantId, row.definition_ref);
    if (!validation.valid) throw definitionBlocked(validation);
  }
  updateRow(db, "mig_definitions", row.id, { status: next, updated_by: actor?.id ?? null });
  const updated = withDefinitionChildren(db, queryOne(db, "SELECT * FROM mig_definitions WHERE id = ?", [row.id]));
  if (next === "ACTIVE") bumpVersion(db, Number(tenantId), row.id, actor, `Activated version ${row.version}`);
  writeAudit(db, { actor, action: "migration.definition.status", resourceType: "mig_definitions", resourceId: updated.definition_ref, details: { status: next }, ip });
  return updated;
}

// Static validation: mapping shape, transformation handlers, validation rules.
// Returns blocking errors and advisory warnings so operators know exactly what
// is wrong before a million-row run.
export function validateDefinition(db, tenantId, ref) {
  const definition = getDefinition(db, tenantId, ref);
  if (!definition) throw definitionNotFound(ref);
  const errors = [];
  const warnings = [];

  const mappingResult = Engines.validateMappings(
    definition.mappings.map((mapping) => ({
      source_field: mapping.source_field,
      target_field: mapping.target_field,
      mapping_type: mapping.mapping_type,
      config: mapping.config,
      expression: mapping.config?.expression,
      lookup: mapping.config?.lookup || mapping.config?.map,
      constant_value: mapping.config?.constant_value,
      required: mapping.required,
      status: mapping.status,
    })),
    {}
  );
  errors.push(...mappingResult.errors);
  warnings.push(...mappingResult.warnings);

  const knownTransformations = new Set(Engines.transformationTypes());
  for (const transformation of definition.transformations) {
    if (!knownTransformations.has(normalizeUpper(transformation.transformation_type))) {
      errors.push({ code: "unknown_transformation", field: transformation.target_field, message: `Unknown transformation type: ${transformation.transformation_type}` });
    }
  }
  const knownRules = new Set(Engines.validationTypes());
  for (const rule of definition.validation_rules) {
    if (!knownRules.has(normalizeUpper(rule.rule_type))) {
      errors.push({ code: "unknown_rule", field: rule.target_field, message: `Unknown validation rule type: ${rule.rule_type}` });
    }
  }
  if (!definition.target_object_type) warnings.push({ code: "missing_target_type", message: "No target object type is set" });
  if (!definition.source_object_type) warnings.push({ code: "missing_source_type", message: "No source object type is set" });

  return { valid: errors.length === 0, errors, warnings, definition_ref: definition.definition_ref };
}

export function createDefinitionVersion(db, tenantId, ref, { changeSummary = "", actor = null } = {}) {
  const row = getDefinitionRow(db, tenantId, ref);
  if (!row) throw definitionNotFound(ref);
  const nextVersion = Number(row.version) + 1;
  const definition = withDefinitionChildren(db, row);
  run(
    db,
    `INSERT INTO mig_definition_versions (definition_id, tenant_id, version, status, snapshot_json, change_summary, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, Number(tenantId), nextVersion, row.status, JSON.stringify(definition), normalizeText(changeSummary, { max: 500 }), actor?.id ?? null, nowIso()]
  );
  updateRow(db, "mig_definitions", row.id, { version: nextVersion, updated_by: actor?.id ?? null });
  writeAudit(db, { actor, action: "migration.definition.version", resourceType: "mig_definitions", resourceId: row.definition_ref, details: { version: nextVersion }, ip: null });
  return queryOne(db, "SELECT * FROM mig_definition_versions WHERE definition_id = ? AND version = ?", [row.id, nextVersion]);
}

function bumpVersion(db, tenantId, definitionId, actor, changeSummary) {
  const row = queryOne(db, "SELECT * FROM mig_definitions WHERE id = ?", [definitionId]);
  const nextVersion = Number(row.version) + 1;
  const definition = withDefinitionChildren(db, row);
  run(
    db,
    `INSERT INTO mig_definition_versions (definition_id, tenant_id, version, status, snapshot_json, change_summary, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, tenantId, nextVersion, "ACTIVE", JSON.stringify(definition), changeSummary, actor?.id ?? null, nowIso()]
  );
  updateRow(db, "mig_definitions", row.id, { version: nextVersion });
}

function writeDefinitionVersion(db, definition, actor, changeSummary) {
  run(
    db,
    `INSERT INTO mig_definition_versions (definition_id, tenant_id, version, status, snapshot_json, change_summary, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [definition.id, definition.tenant_id, definition.version, definition.status, JSON.stringify(definition), changeSummary, actor?.id ?? null, nowIso()]
  );
}

export function listDefinitionVersions(db, tenantId, ref, { page, pageSize } = {}) {
  const row = getDefinitionRow(db, tenantId, ref);
  if (!row) throw definitionNotFound(ref);
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, "SELECT COUNT(*) AS c FROM mig_definition_versions WHERE definition_id = ?", [row.id])?.c || 0);
  const rows = queryAll(db, "SELECT * FROM mig_definition_versions WHERE definition_id = ? ORDER BY version DESC LIMIT ? OFFSET ?", [row.id, limit, offset]);
  return { items: rows.map(publicDefinitionVersion), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function definitionExists(db, tenantId, id) {
  return Boolean(queryOne(db, "SELECT id FROM mig_definitions WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]));
}

export { invalidDefinition };

// Import definition administration.
//
// A definition declares *what* moves and *how*: the source connector, the target
// object type, the mapping/transformation/validation rules, duplicate handling
// and execution policy. Definitions are versioned; once a definition is ACTIVE
// its content is immutable and changes are made by creating a new version. The
// framework never stores business data or connector secrets here.
import { queryAll, queryOne, run, transaction, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { CONNECTOR_TYPES, MAX_MAPPINGS, MAX_FIELDS } from "./constants.js";
import { importDefinitionRef as makeDefinitionRef } from "./refs.js";
import {
  publicImportDefinition,
  publicImportMapping,
  publicImportTransformation,
  publicImportValidationRule,
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
  assertDuplicateStrategy,
  assertDuplicateKeyType,
  assertErrorStrategy,
  assertExecutionMode,
  assertDefinitionStatus,
  assertReconciliationStrategy,
  assertTransactionStrategy,
  assertBatchSize,
  assertConnectorType,
  assertMappingType,
  assertTransformationType,
  assertTransformationStage,
  assertValidationLevel,
  assertSeverity,
} from "./validation.js";
import { publishExchangeEvent } from "./events.js";
import { recordHistory } from "./history.js";

const EDITABLE_STATUSES = new Set(["DRAFT"]);

export function getImportDefinitionRow(db, tenantId, ref) {
  return queryOne(
    db,
    "SELECT * FROM ie_import_definitions WHERE tenant_id = ? AND (definition_ref = ? OR code = ? OR CAST(id AS TEXT) = ?)",
    [Number(tenantId), String(ref), normalizeUpper(ref), String(ref)]
  );
}

export function requireImportDefinitionRow(db, tenantId, ref) {
  const row = getImportDefinitionRow(db, tenantId, ref);
  if (!row) throw definitionNotFound(ref);
  return row;
}

function mappingsOf(db, definitionId) {
  return queryAll(db, "SELECT * FROM ie_import_mappings WHERE definition_id = ? ORDER BY sequence, id", [Number(definitionId)]).map(publicImportMapping);
}

function transformationsOf(db, definitionId) {
  return queryAll(db, "SELECT * FROM ie_import_transformations WHERE definition_id = ? ORDER BY sequence, id", [Number(definitionId)]).map(publicImportTransformation);
}

function rulesOf(db, definitionId) {
  return queryAll(db, "SELECT * FROM ie_import_validation_rules WHERE definition_id = ? ORDER BY sequence, id", [Number(definitionId)]).map(publicImportValidationRule);
}

export function withImportChildren(db, row) {
  if (!row) return null;
  return { ...publicImportDefinition(row), mappings: mappingsOf(db, row.id), transformations: transformationsOf(db, row.id), validation_rules: rulesOf(db, row.id) };
}

export function getImportDefinition(db, tenantId, ref) {
  return withImportChildren(db, requireImportDefinitionRow(db, tenantId, ref));
}

// ── Child collections ────────────────────────────────────────────────────────

function normalizeMappingCollection(mappings) {
  if (!Array.isArray(mappings)) return [];
  if (mappings.length > MAX_MAPPINGS) throw invalidDefinition(`At most ${MAX_MAPPINGS} mappings are allowed`);
  return mappings.map((mapping, index) => ({
    sequence: Number(mapping.sequence ?? index),
    source_field: normalizeText(mapping.source_field ?? mapping.sourceField, { max: 400 }),
    target_field: normalizeText(mapping.target_field ?? mapping.targetField, { max: 400 }),
    mapping_type: assertMappingType(mapping.mapping_type || mapping.mappingType || "DIRECT"),
    data_type: normalizeText(mapping.data_type || mapping.dataType || "string", { max: 40 }),
    required: mapping.required ? 1 : 0,
    default_value: mapping.default_value ?? mapping.defaultValue ?? null,
    constant_value: mapping.constant_value ?? mapping.constantValue ?? null,
    expression: normalizeText(mapping.expression, { max: 4000 }),
    lookup_json: JSON.stringify(parseObject(mapping.lookup, {})),
    condition_json: JSON.stringify(parseObject(mapping.condition, {})),
    concat_json: JSON.stringify(parseArray(mapping.concat, [])),
    split_json: JSON.stringify(parseObject(mapping.split, {})),
    nested_json: JSON.stringify(parseObject(mapping.nested, {})),
    transform_json: JSON.stringify(parseArray(mapping.transform, [])),
    status: normalizeText(mapping.status, { max: 16 }).toLowerCase() || "active",
  }));
}

function normalizeTransformationCollection(transformations) {
  if (!Array.isArray(transformations)) return [];
  return transformations.map((entry, index) => ({
    sequence: Number(entry.sequence ?? index),
    stage: assertTransformationStage(entry.stage || "FIELD"),
    target_field: normalizeText(entry.target_field ?? entry.targetField, { max: 400 }),
    transformation_type: assertTransformationType(entry.transformation_type || entry.transformationType),
    config_json: JSON.stringify(parseObject(entry.config, {})),
    status: normalizeText(entry.status, { max: 16 }).toLowerCase() || "active",
  }));
}

function normalizeRuleCollection(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.map((rule, index) => ({
    sequence: Number(rule.sequence ?? index),
    level: assertValidationLevel(rule.level || "FIELD"),
    target_field: normalizeText(rule.target_field ?? rule.targetField, { max: 400 }),
    rule_type: normalizeUpper(rule.rule_type || rule.ruleType),
    config_json: JSON.stringify(parseObject(rule.config, {})),
    severity: assertSeverity(rule.severity || "ERROR"),
    message: normalizeText(rule.message, { max: 500 }),
    status: normalizeText(rule.status, { max: 16 }).toLowerCase() || "active",
  }));
}

function writeMappings(db, tenantId, definitionId, entries) {
  run(db, "DELETE FROM ie_import_mappings WHERE definition_id = ?", [definitionId]);
  for (const entry of entries) {
    run(
      db,
      `INSERT INTO ie_import_mappings (definition_id, tenant_id, sequence, source_field, target_field, mapping_type, data_type, required, default_value, constant_value, expression, lookup_json, condition_json, concat_json, split_json, nested_json, transform_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        definitionId,
        Number(tenantId),
        entry.sequence,
        entry.source_field,
        entry.target_field,
        entry.mapping_type,
        entry.data_type,
        entry.required,
        entry.default_value === undefined ? null : entry.default_value,
        entry.constant_value === undefined ? null : entry.constant_value,
        entry.expression,
        entry.lookup_json,
        entry.condition_json,
        entry.concat_json,
        entry.split_json,
        entry.nested_json,
        entry.transform_json,
        entry.status,
        nowIso(),
        nowIso(),
      ]
    );
  }
}

function writeTransformations(db, tenantId, definitionId, entries) {
  run(db, "DELETE FROM ie_import_transformations WHERE definition_id = ?", [definitionId]);
  for (const entry of entries) {
    run(
      db,
      `INSERT INTO ie_import_transformations (definition_id, tenant_id, sequence, stage, target_field, transformation_type, config_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [definitionId, Number(tenantId), entry.sequence, entry.stage, entry.target_field, entry.transformation_type, entry.config_json, entry.status, nowIso(), nowIso()]
    );
  }
}

function writeRules(db, tenantId, definitionId, entries) {
  run(db, "DELETE FROM ie_import_validation_rules WHERE definition_id = ?", [definitionId]);
  for (const entry of entries) {
    run(
      db,
      `INSERT INTO ie_import_validation_rules (definition_id, tenant_id, sequence, level, target_field, rule_type, config_json, severity, message, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [definitionId, Number(tenantId), entry.sequence, entry.level, entry.target_field, entry.rule_type, entry.config_json, entry.severity, entry.message, entry.status, nowIso(), nowIso()]
    );
  }
}

// ── Definition CRUD ──────────────────────────────────────────────────────────

function normalizeDefinitionInput(input = {}, existing = null) {
  const targetObjectType = normalizeText(input.target_object_type ?? input.targetObjectType ?? existing?.target_object_type, { max: 120 });
  if (!targetObjectType) throw invalidDefinition("A target_object_type is required");
  const sourceType = assertConnectorType(input.source_type || input.sourceType || existing?.source_type || "CSV");
  const duplicateKey = input.duplicate_key || input.duplicateKey || (existing ? parseObject(existing.duplicate_key_json, {}) : {});
  return {
    target_object_type: targetObjectType,
    target_subtype: normalizeText(input.target_subtype ?? input.targetSubtype ?? existing?.target_subtype, { max: 120 }),
    source_type: sourceType,
    connector_config_id: input.connector_config_id ?? input.connectorConfigId ?? existing?.connector_config_id ?? null,
    source_config: parseObject(input.source_config ?? input.sourceConfig, existing ? parseObject(existing.source_config_json, {}) : {}),
    mapping: parseObject(input.mapping, existing ? parseObject(existing.mapping_json, {}) : {}),
    transformation: parseObject(input.transformation, existing ? parseObject(existing.transformation_json, {}) : {}),
    validation: parseObject(input.validation, existing ? parseObject(existing.validation_json, {}) : {}),
    duplicate_strategy: assertDuplicateStrategy(input.duplicate_strategy || input.duplicateStrategy || existing?.duplicate_strategy || "REJECT"),
    duplicate_key: duplicateKey,
    batch_size: assertBatchSize(input.batch_size ?? input.batchSize ?? existing?.batch_size ?? 500),
    error_strategy: assertErrorStrategy(input.error_strategy || input.errorStrategy || existing?.error_strategy || "CONTINUE"),
    reconciliation_strategy: assertReconciliationStrategy(input.reconciliation_strategy || input.reconciliationStrategy || existing?.reconciliation_strategy || "COUNT"),
    transaction_strategy: assertTransactionStrategy(input.transaction_strategy || input.transactionStrategy || existing?.transaction_strategy || "PER_BATCH"),
    mode: assertExecutionMode(input.mode || existing?.mode || "IMPORT"),
    template_id: input.template_id ?? input.templateId ?? existing?.template_id ?? null,
    owner_user_id: input.owner_user_id ?? input.ownerUserId ?? existing?.owner_user_id ?? null,
    catalog_refs: parseObject(input.catalog_refs ?? input.catalogRefs, existing ? parseObject(existing.catalog_refs_json, {}) : {}),
    schedule: parseObject(input.schedule, existing ? parseObject(existing.schedule_json, {}) : {}),
  };
}

function snapshotVersion(db, row, actor, changeSummary) {
  const snapshot = withImportChildren(db, row);
  run(
    db,
    `INSERT OR REPLACE INTO ie_import_definition_versions (definition_id, tenant_id, version, status, snapshot_json, change_summary, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.tenant_id, row.version, row.status, JSON.stringify(snapshot), normalizeText(changeSummary, { max: 500 }), actor?.id ?? null, nowIso()]
  );
}

export function createImportDefinition(db, tenantId, input = {}, actor = null, ip = null) {
  const code = requireCode(input.code, "Definition code");
  if (queryOne(db, "SELECT id FROM ie_import_definitions WHERE tenant_id = ? AND code = ?", [Number(tenantId), code])) throw definitionConflict(code);
  const normalized = normalizeDefinitionInput(input);
  const mappings = normalizeMappingCollection(input.mappings);
  const transformations = normalizeTransformationCollection(input.transformations);
  const rules = normalizeRuleCollection(input.validation_rules || input.validationRules);
  const status = assertDefinitionStatus(input.status || "DRAFT");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO ie_import_definitions
      (definition_ref, tenant_id, organization_id, code, name, description, target_object_type, target_subtype, source_type, connector_config_id, source_config_json, mapping_json, transformation_json, validation_json,
       duplicate_strategy, duplicate_key_json, batch_size, error_strategy, reconciliation_strategy, transaction_strategy, mode, template_id, status, version, owner_user_id, catalog_refs_json, schedule_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      makeDefinitionRef(code),
      Number(tenantId),
      input.organization_id ?? input.organizationId ?? null,
      code,
      requireName(input.name, "Definition name"),
      normalizeText(input.description),
      normalized.target_object_type,
      normalized.target_subtype,
      normalized.source_type,
      normalized.connector_config_id,
      JSON.stringify(normalized.source_config),
      JSON.stringify(normalized.mapping),
      JSON.stringify(normalized.transformation),
      JSON.stringify(normalized.validation),
      normalized.duplicate_strategy,
      JSON.stringify(normalized.duplicate_key),
      normalized.batch_size,
      normalized.error_strategy,
      normalized.reconciliation_strategy,
      normalized.transaction_strategy,
      normalized.mode,
      normalized.template_id,
      status,
      normalized.owner_user_id,
      JSON.stringify(normalized.catalog_refs),
      JSON.stringify(normalized.schedule),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const id = Number(result.lastInsertRowid);
  writeMappings(db, tenantId, id, mappings);
  writeTransformations(db, tenantId, id, transformations);
  writeRules(db, tenantId, id, rules);
  const row = queryOne(db, "SELECT * FROM ie_import_definitions WHERE id = ?", [id]);
  snapshotVersion(db, row, actor, "initial version");
  writeAudit(db, { actor, action: "data_exchange.import_definition.create", resourceType: "ie_import_definitions", resourceId: code, details: { target_object_type: normalized.target_object_type }, ip });
  recordHistory(db, { direction: "IMPORT", tenantId, definitionId: id, definitionVersion: 1, action: "DEFINITION_CREATED", status, targetObjectType: normalized.target_object_type, actor, details: { code } });
  publishExchangeEvent(db, { eventType: "ImportDefinitionCreated", tenantId, objectType: "ie_import_definition", objectId: row.definition_ref, payload: { code } }, actor);
  return withImportChildren(db, row);
}

export function updateImportDefinition(db, tenantId, ref, patch = {}, actor = null, ip = null) {
  const row = requireImportDefinitionRow(db, tenantId, ref);
  if (!EDITABLE_STATUSES.has(row.status)) throw definitionImmutable(row.definition_ref, row.status);
  if (patch.code !== undefined && normalizeUpper(patch.code) !== row.code) {
    throw invalidDefinition("A definition code is immutable; create a new definition instead");
  }
  const normalized = normalizeDefinitionInput(patch, row);
  const hasMappings = patch.mappings !== undefined;
  const hasTransformations = patch.transformations !== undefined;
  const hasRules = patch.validation_rules !== undefined || patch.validationRules !== undefined;
  transaction(db, () => {
    run(
      db,
      `UPDATE ie_import_definitions SET name = ?, description = ?, target_object_type = ?, target_subtype = ?, source_type = ?, connector_config_id = ?, source_config_json = ?, mapping_json = ?, transformation_json = ?, validation_json = ?,
        duplicate_strategy = ?, duplicate_key_json = ?, batch_size = ?, error_strategy = ?, reconciliation_strategy = ?, transaction_strategy = ?, mode = ?, template_id = ?, owner_user_id = ?, catalog_refs_json = ?, schedule_json = ?, updated_by = ?, updated_at = ?
       WHERE id = ?`,
      [
        normalizeText(patch.name ?? row.name, { max: 200 }) || row.code,
        normalizeText(patch.description ?? row.description),
        normalized.target_object_type,
        normalized.target_subtype,
        normalized.source_type,
        normalized.connector_config_id,
        JSON.stringify(normalized.source_config),
        JSON.stringify(normalized.mapping),
        JSON.stringify(normalized.transformation),
        JSON.stringify(normalized.validation),
        normalized.duplicate_strategy,
        JSON.stringify(normalized.duplicate_key),
        normalized.batch_size,
        normalized.error_strategy,
        normalized.reconciliation_strategy,
        normalized.transaction_strategy,
        normalized.mode,
        normalized.template_id,
        normalized.owner_user_id,
        JSON.stringify(normalized.catalog_refs),
        JSON.stringify(normalized.schedule),
        actor?.id ?? null,
        nowIso(),
        row.id,
      ]
    );
    if (hasMappings) writeMappings(db, tenantId, row.id, normalizeMappingCollection(patch.mappings));
    if (hasTransformations) writeTransformations(db, tenantId, row.id, normalizeTransformationCollection(patch.transformations));
    if (hasRules) writeRules(db, tenantId, row.id, normalizeRuleCollection(patch.validation_rules || patch.validationRules));
  });
  const updated = queryOne(db, "SELECT * FROM ie_import_definitions WHERE id = ?", [row.id]);
  snapshotVersion(db, updated, actor, patch.change_summary || "definition updated");
  writeAudit(db, { actor, action: "data_exchange.import_definition.update", resourceType: "ie_import_definitions", resourceId: row.code, details: {}, ip });
  recordHistory(db, { direction: "IMPORT", tenantId, definitionId: row.id, definitionVersion: updated.version, action: "DEFINITION_UPDATED", status: updated.status, targetObjectType: updated.target_object_type, actor, details: { code: row.code } });
  publishExchangeEvent(db, { eventType: "ImportDefinitionUpdated", tenantId, objectType: "ie_import_definition", objectId: updated.definition_ref, payload: { code: row.code } }, actor);
  return withImportChildren(db, updated);
}

export function setImportDefinitionStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = requireImportDefinitionRow(db, tenantId, ref);
  const next = assertDefinitionStatus(status);
  if (next === row.status) return withImportChildren(db, row);
  if (next === "ACTIVE") {
    const check = validateImportDefinition(db, tenantId, ref, { status: row.status });
    if (!check.valid) throw invalidDefinition("Definition cannot be activated while blocking issues exist", { errors: check.errors });
  }
  const ts = nowIso();
  run(db, "UPDATE ie_import_definitions SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [next, actor?.id ?? null, ts, row.id]);
  const updated = queryOne(db, "SELECT * FROM ie_import_definitions WHERE id = ?", [row.id]);
  snapshotVersion(db, updated, actor, `status ${row.status} -> ${next}`);
  writeAudit(db, { actor, action: "data_exchange.import_definition.status", resourceType: "ie_import_definitions", resourceId: row.code, details: { status: next }, ip });
  return withImportChildren(db, updated);
}

export function createImportDefinitionVersion(db, tenantId, ref, input = {}, actor = null, ip = null) {
  const row = requireImportDefinitionRow(db, tenantId, ref);
  snapshotVersion(db, row, actor, input.change_summary || `snapshot before version ${Number(row.version) + 1}`);
  const normalized = normalizeDefinitionInput(input, row);
  const hasMappings = input.mappings !== undefined;
  const hasTransformations = input.transformations !== undefined;
  const hasRules = input.validation_rules !== undefined || input.validationRules !== undefined;
  const nextVersion = Number(row.version) + 1;
  transaction(db, () => {
    run(
      db,
      `UPDATE ie_import_definitions SET name = ?, description = ?, target_object_type = ?, target_subtype = ?, source_type = ?, connector_config_id = ?, source_config_json = ?, mapping_json = ?, transformation_json = ?, validation_json = ?,
        duplicate_strategy = ?, duplicate_key_json = ?, batch_size = ?, error_strategy = ?, reconciliation_strategy = ?, transaction_strategy = ?, mode = ?, template_id = ?, owner_user_id = ?, catalog_refs_json = ?, schedule_json = ?,
        status = 'DRAFT', version = ?, updated_by = ?, updated_at = ?
       WHERE id = ?`,
      [
        normalizeText(input.name ?? row.name, { max: 200 }) || row.code,
        normalizeText(input.description !== undefined ? input.description : row.description),
        normalized.target_object_type,
        normalized.target_subtype,
        normalized.source_type,
        normalized.connector_config_id,
        JSON.stringify(normalized.source_config),
        JSON.stringify(normalized.mapping),
        JSON.stringify(normalized.transformation),
        JSON.stringify(normalized.validation),
        normalized.duplicate_strategy,
        JSON.stringify(normalized.duplicate_key),
        normalized.batch_size,
        normalized.error_strategy,
        normalized.reconciliation_strategy,
        normalized.transaction_strategy,
        normalized.mode,
        normalized.template_id,
        normalized.owner_user_id,
        JSON.stringify(normalized.catalog_refs),
        JSON.stringify(normalized.schedule),
        nextVersion,
        actor?.id ?? null,
        nowIso(),
        row.id,
      ]
    );
    if (hasMappings) writeMappings(db, tenantId, row.id, normalizeMappingCollection(input.mappings));
    if (hasTransformations) writeTransformations(db, tenantId, row.id, normalizeTransformationCollection(input.transformations));
    if (hasRules) writeRules(db, tenantId, row.id, normalizeRuleCollection(input.validation_rules || input.validationRules));
  });
  const updated = queryOne(db, "SELECT * FROM ie_import_definitions WHERE id = ?", [row.id]);
  snapshotVersion(db, updated, actor, input.change_summary || `version ${nextVersion}`);
  writeAudit(db, { actor, action: "data_exchange.import_definition.version", resourceType: "ie_import_definitions", resourceId: row.code, details: { version: nextVersion }, ip });
  recordHistory(db, { direction: "IMPORT", tenantId, definitionId: row.id, definitionVersion: nextVersion, action: "DEFINITION_VERSIONED", status: "DRAFT", targetObjectType: updated.target_object_type, actor, details: { code: row.code } });
  publishExchangeEvent(db, { eventType: "ImportDefinitionUpdated", tenantId, objectType: "ie_import_definition", objectId: updated.definition_ref, payload: { code: row.code, version: nextVersion } }, actor);
  return withImportChildren(db, updated);
}

export function listImportDefinitionVersions(db, tenantId, ref) {
  const row = requireImportDefinitionRow(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM ie_import_definition_versions WHERE definition_id = ? ORDER BY version DESC", [row.id]);
  return { items: rows.map(publicDefinitionVersion), total: rows.length };
}

export function listImportDefinitions(db, { tenantId, status, targetObjectType, sourceType, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(assertDefinitionStatus(status));
  }
  if (targetObjectType) {
    clauses.push("target_object_type = ?");
    params.push(normalizeText(targetObjectType, { max: 120 }));
  }
  if (sourceType) {
    clauses.push("source_type = ?");
    params.push(assertConnectorType(sourceType));
  }
  const term = normalizeText(q);
  if (term) {
    clauses.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${term}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM ie_import_definitions ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM ie_import_definitions ${where} ORDER BY code, version DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicImportDefinition), total, page: currentPage, page_size: limit };
}

// ── Static validation ────────────────────────────────────────────────────────

export function validateImportDefinition(db, tenantId, ref, { sourceFields = null } = {}) {
  const row = requireImportDefinitionRow(db, tenantId, ref);
  const definition = withImportChildren(db, row);
  const errors = [];
  const warnings = [];
  if (!definition.target_object_type) errors.push({ code: "missing_target", message: "A target object type is required" });
  if (!CONNECTOR_TYPES.includes(definition.source_type)) errors.push({ code: "invalid_source", message: `Unknown source type: ${definition.source_type}` });
  if (!definition.mappings.length) errors.push({ code: "no_mappings", message: "At least one mapping is required" });
  const targets = new Map();
  for (const mapping of definition.mappings) {
    if (!mapping.target_field) errors.push({ code: "missing_target_field", message: "A mapping requires a target_field" });
    if (mapping.target_field) {
      const count = (targets.get(mapping.target_field) || 0) + 1;
      targets.set(mapping.target_field, count);
      if (count > 1) errors.push({ code: "duplicate_target", field: mapping.target_field, message: `Multiple mappings write to "${mapping.target_field}"` });
    }
    if (mapping.mapping_type === "EXPRESSION" && !mapping.expression) errors.push({ code: "missing_expression", field: mapping.target_field, message: "An EXPRESSION mapping requires an expression" });
    if (mapping.mapping_type === "LOOKUP" && !mapping.lookup?.map && !mapping.lookup?.source && !mapping.lookup?.lookup_definition) {
      errors.push({ code: "missing_lookup", field: mapping.target_field, message: "A LOOKUP mapping requires a source or map" });
    }
  }
  if (["UPDATE", "UPSERT", "MERGE", "REJECT", "SKIP"].includes(definition.duplicate_strategy)) {
    const key = definition.duplicate_key || {};
    const hasKey = (Array.isArray(key.fields) && key.fields.length) || key.type === "OBJECT_ID" || key.expression;
    if (!hasKey && !definition.duplicate_key.key_expression) warnings.push({ code: "no_duplicate_key", message: `Duplicate strategy ${definition.duplicate_strategy} works best with a duplicate_key` });
    else if (key.type) assertDuplicateKeyType(key.type);
  }
  const sourceSet = sourceFields ? new Set(sourceFields) : null;
  if (sourceSet) {
    for (const mapping of definition.mappings) {
      if (mapping.source_field && sourceSet.size && !sourceSet.has(mapping.source_field) && ["DIRECT", "RENAME", "DEFAULT", "SPLIT"].includes(mapping.mapping_type)) {
        warnings.push({ code: "unknown_source", field: mapping.source_field, message: `Source field "${mapping.source_field}" was not found in the discovered schema` });
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings, definition: { code: definition.code, version: definition.version, fields: MAX_FIELDS } };
}

export { MAX_MAPPINGS };

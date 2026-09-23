// Normalization, assertion and vocabulary helpers for the Migration &
// Onboarding Framework.
//
// The pure helpers (text/number parsing, pagination, the safe expression
// evaluator) are shared with the Import & Export Framework — there is exactly
// one implementation of them on the platform. This module adds the migration
// vocabulary assertions and the meta vocabulary exposed by /migration/meta.
import { HttpError } from "../../validation.js";
import {
  normalizeText,
  normalizeUpper,
  normalizeLower,
  parseJson,
  parseObject,
  parseArray,
  toBool,
  toNumber,
  toInt,
  paginate,
  sortParams,
  requireCode,
  requireName,
  assertEnum,
  assertBatchSize,
  assertTenantId,
  applyTemplate,
  evaluateExpression,
  validateExpression,
  resolveValueExpression,
} from "../data-exchange/validation.js";
import {
  PROJECT_STATUSES,
  PACKAGE_STATUSES,
  DEFINITION_STATUSES,
  EXECUTION_MODES,
  JOB_STATUSES,
  BATCH_STATUSES,
  DUPLICATE_STRATEGIES,
  DUPLICATE_KEY_TYPES,
  ERROR_STRATEGIES,
  DEPENDENCY_STRATEGIES,
  DEPENDENCY_TYPES,
  PLAN_STATUSES,
  PLAN_STEP_STATUSES,
  READINESS_STATES,
  RECONCILIATION_STRATEGIES,
  RECONCILIATION_STATUSES,
  RECONCILIATION_EXCEPTION_TYPES,
  SOURCE_ADAPTER_TYPES,
  SOURCE_ADAPTER_CAPABILITIES,
  MIGRATION_SCOPES,
  ERROR_CATEGORIES,
  ERROR_TYPES,
  ERROR_STATUSES,
  RETRY_STRATEGIES,
  IDENTIFIER_STATUSES,
  RELATIONSHIP_STATUSES,
  FILE_MIGRATION_STATUSES,
  PIPELINE_STAGES,
  CONFIG_DEFAULTS,
  CONFIG_BOUNDS,
} from "./constants.js";
import {
  invalidProject,
  invalidPackage,
  invalidDefinition,
  invalidSource,
  invalidDependency,
  invalidPlan,
  invalidMode,
  invalidDuplicateStrategy,
  invalidMapping,
  invalidTransformation,
  invalidValidation,
  invalidIdentifier,
  invalidReconciliation,
  invalidConfiguration,
} from "./errors.js";

export {
  normalizeText,
  normalizeUpper,
  normalizeLower,
  parseJson,
  parseObject,
  parseArray,
  toBool,
  toNumber,
  toInt,
  paginate,
  sortParams,
  requireCode,
  requireName,
  assertEnum,
  assertBatchSize,
  assertTenantId,
  applyTemplate,
  evaluateExpression,
  validateExpression,
  resolveValueExpression,
};

// ── Vocabulary assertions ────────────────────────────────────────────────────

export const assertProjectStatus = (value) => assertEnum(normalizeUpper(value), PROJECT_STATUSES, "Project status", invalidProject);
export const assertPackageStatus = (value) => assertEnum(normalizeUpper(value), PACKAGE_STATUSES, "Package status", invalidPackage);
export const assertDefinitionStatus = (value) => assertEnum(normalizeUpper(value), DEFINITION_STATUSES, "Definition status", invalidDefinition);
export const assertExecutionMode = (value) => assertEnum(normalizeUpper(value), EXECUTION_MODES, "Execution mode", invalidMode);
export const assertJobStatus = (value) => assertEnum(normalizeUpper(value), JOB_STATUSES, "Job status", invalidDefinition);
export const assertBatchStatus = (value) => assertEnum(normalizeUpper(value), BATCH_STATUSES, "Batch status", invalidDefinition);
export const assertDuplicateStrategy = (value) => assertEnum(normalizeUpper(value), DUPLICATE_STRATEGIES, "Duplicate strategy", invalidDuplicateStrategy);
export const assertDuplicateKeyType = (value) => assertEnum(normalizeUpper(value), DUPLICATE_KEY_TYPES, "Duplicate key type", invalidDefinition);
export const assertErrorStrategy = (value) => assertEnum(normalizeUpper(value), ERROR_STRATEGIES, "Error strategy", invalidDefinition);
export const assertDependencyStrategy = (value) => assertEnum(normalizeUpper(value), DEPENDENCY_STRATEGIES, "Dependency strategy", invalidDefinition);
export const assertDependencyType = (value) => assertEnum(normalizeUpper(value), DEPENDENCY_TYPES, "Dependency type", invalidDependency);
export const assertPlanStatus = (value) => assertEnum(normalizeUpper(value), PLAN_STATUSES, "Plan status", invalidPlan);
export const assertPlanStepStatus = (value) => assertEnum(normalizeUpper(value), PLAN_STEP_STATUSES, "Plan step status", invalidPlan);
export const assertReadiness = (value) => assertEnum(normalizeLower(value), READINESS_STATES, "Readiness", invalidPlan);
export const assertReconciliationStrategy = (value) => assertEnum(normalizeUpper(value), RECONCILIATION_STRATEGIES, "Reconciliation strategy", invalidReconciliation);
export const assertReconciliationStatus = (value) => assertEnum(normalizeUpper(value), RECONCILIATION_STATUSES, "Reconciliation status", invalidReconciliation);
export const assertReconciliationExceptionType = (value) => assertEnum(normalizeUpper(value), RECONCILIATION_EXCEPTION_TYPES, "Reconciliation exception type", invalidReconciliation);
export const assertAdapterType = (value) => assertEnum(normalizeUpper(value), SOURCE_ADAPTER_TYPES, "Source adapter type", invalidSource);
export const assertAdapterCapability = (value) => assertEnum(normalizeUpper(value), SOURCE_ADAPTER_CAPABILITIES, "Adapter capability", invalidSource);
export const assertMigrationScope = (value) => assertEnum(normalizeUpper(value), MIGRATION_SCOPES, "Migration scope", invalidDefinition);
export const assertErrorCategory = (value) => assertEnum(normalizeUpper(value), ERROR_CATEGORIES, "Error category", invalidDefinition);
export const assertErrorType = (value) => assertEnum(normalizeUpper(value), ERROR_TYPES, "Error type", invalidDefinition);
export const assertErrorStatus = (value) => assertEnum(normalizeUpper(value), ERROR_STATUSES, "Error status", invalidDefinition);
export const assertRetryStrategy = (value) => assertEnum(normalizeUpper(value), RETRY_STRATEGIES, "Retry strategy", invalidDefinition);
export const assertIdentifierStatus = (value) => assertEnum(normalizeUpper(value), IDENTIFIER_STATUSES, "Identifier status", invalidIdentifier);
export const assertRelationshipStatus = (value) => assertEnum(normalizeUpper(value), RELATIONSHIP_STATUSES, "Relationship status", invalidDefinition);
export const assertFileMigrationStatus = (value) => assertEnum(normalizeUpper(value), FILE_MIGRATION_STATUSES, "File migration status", invalidDefinition);
export const assertMappingType = (value) => assertEnum(normalizeUpper(value), ["DIRECT", "RENAME", "DEFAULT", "CONSTANT", "LOOKUP", "CONDITIONAL", "CONCAT", "SPLIT", "EXPRESSION", "NESTED", "ARRAY"], "Mapping type", invalidMapping);
export const assertTransformationType = (value) => assertEnum(normalizeUpper(value), ["TRIM", "UPPERCASE", "LOWERCASE", "SUBSTRING", "REPLACE", "CONCAT", "SPLIT", "DATE_CONVERT", "UNIT_CONVERT", "LOOKUP", "DEFAULT", "EXPRESSION", "MASK"], "Transformation type", invalidTransformation);
export const assertTransformationStage = (value) => assertEnum(normalizeUpper(value), ["RECORD", "FIELD"], "Transformation stage", invalidTransformation);
export const assertValidationLevel = (value) => assertEnum(normalizeUpper(value), ["FIELD", "RECORD", "RELATIONSHIP", "BUSINESS"], "Validation level", invalidValidation);
export const assertSeverity = (value) => assertEnum(normalizeUpper(value), ["ERROR", "WARNING", "INFO"], "Validation severity", invalidValidation);

// Configuration values are validated against the type of their default so a bad
// value can never reach the engine.
export function assertConfigurationValue(key, value) {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)) {
    throw invalidConfiguration(`Unknown configuration key: ${key}`, { key, allowed: Object.keys(CONFIG_DEFAULTS) });
  }
  const fallback = CONFIG_DEFAULTS[key];
  if (Array.isArray(fallback)) {
    if (!Array.isArray(value)) throw invalidConfiguration(`${key} must be an array`, { key });
    return value.map((entry) => normalizeText(entry, { max: 200 }));
  }
  if (typeof fallback === "boolean") return toBool(value, fallback);
  if (typeof fallback === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw invalidConfiguration(`${key} must be a number`, { key });
    const bounds = CONFIG_BOUNDS[key];
    if (bounds && (n < bounds.min || n > bounds.max)) {
      throw invalidConfiguration(`${key} must be between ${bounds.min} and ${bounds.max}`, { key, min: bounds.min, max: bounds.max, value: n });
    }
    return n;
  }
  if (typeof fallback === "string") {
    const text = normalizeText(value, { max: 200 });
    if (!text) throw invalidConfiguration(`${key} must be a non-empty string`, { key });
    return text;
  }
  return value;
}

// ── Structured field validation ──────────────────────────────────────────────

// Validates and normalizes a list of mapping definitions. Children are bounded
// (spec §6: no unbounded configuration) and every mapping is a documented,
// data-only operation.
export function assertMappings(mappings, { max = 2000 } = {}) {
  const list = Array.isArray(mappings) ? mappings : [];
  if (list.length > max) throw invalidMapping(`At most ${max} mappings are allowed`);
  return list.map((mapping, index) => {
    const target = normalizeText(mapping.target_field ?? mapping.targetField, { max: 200 });
    if (!target) throw invalidMapping(`Mapping at position ${index} requires a target_field`);
    const type = assertMappingType(mapping.mapping_type ?? mapping.mappingType ?? mapping.type ?? "DIRECT");
    return {
      sequence: toInt(mapping.sequence, index),
      source_field: normalizeText(mapping.source_field ?? mapping.sourceField ?? "", { max: 200 }),
      target_field: target,
      mapping_type: type,
      config: parseObject(mapping.config ?? mapping.config_json, {}),
      required: toBool(mapping.required, false),
      status: normalizeLower(mapping.status || "active") === "inactive" ? "inactive" : "active",
    };
  });
}

export function assertTransformations(transformations, { max = 5000 } = {}) {
  const list = Array.isArray(transformations) ? transformations : [];
  if (list.length > max) throw invalidTransformation(`At most ${max} transformations are allowed`);
  return list.map((transformation, index) => {
    const type = assertTransformationType(transformation.transformation_type ?? transformation.transformationType ?? transformation.type);
    return {
      sequence: toInt(transformation.sequence, index),
      stage: assertTransformationStage(transformation.stage || "FIELD"),
      target_field: normalizeText(transformation.target_field ?? transformation.targetField ?? "", { max: 200 }),
      transformation_type: type,
      config: parseObject(transformation.config ?? transformation.config_json, {}),
      status: normalizeLower(transformation.status || "active") === "inactive" ? "inactive" : "active",
    };
  });
}

export function assertValidationRules(rules, { max = 5000 } = {}) {
  const list = Array.isArray(rules) ? rules : [];
  if (list.length > max) throw invalidValidation(`At most ${max} validation rules are allowed`);
  return list.map((rule, index) => {
    const type = normalizeUpper(rule.rule_type ?? rule.ruleType ?? rule.type);
    if (!type) throw invalidValidation(`Validation rule at position ${index} requires a rule_type`);
    return {
      sequence: toInt(rule.sequence, index),
      level: assertValidationLevel(rule.level || "FIELD"),
      target_field: normalizeText(rule.target_field ?? rule.targetField ?? "", { max: 200 }),
      rule_type: type,
      config: parseObject(rule.config ?? rule.config_json, {}),
      severity: assertSeverity(rule.severity || "ERROR"),
      message: normalizeText(rule.message ?? "", { max: 500 }),
      status: normalizeLower(rule.status || "active") === "inactive" ? "inactive" : "active",
    };
  });
}

// A dependency edge references another package by id or code, or an external
// object/relationship/file reference.
export function normalizeDependency(dependency = {}, index = 0) {
  const type = assertDependencyType(dependency.dependency_type ?? dependency.dependencyType ?? "PACKAGE");
  const code = normalizeUpper(dependency.depends_on ?? dependency.dependsOn ?? dependency.package_code ?? dependency.packageCode ?? "");
  return {
    sequence: toInt(dependency.sequence, index),
    dependency_type: type,
    depends_on_package_id: dependency.depends_on_package_id != null ? Number(dependency.depends_on_package_id) : null,
    depends_on: code,
    source_ref: normalizeText(dependency.source_ref ?? dependency.sourceRef ?? "", { max: 300 }),
    target_ref: normalizeText(dependency.target_ref ?? dependency.targetRef ?? "", { max: 300 }),
    required: toBool(dependency.required, true),
  };
}

// The meta endpoint vocabulary, mirroring /data-exchange/meta.
export function vocabulary() {
  return {
    project_statuses: PROJECT_STATUSES,
    package_statuses: PACKAGE_STATUSES,
    definition_statuses: DEFINITION_STATUSES,
    execution_modes: EXECUTION_MODES,
    job_statuses: JOB_STATUSES,
    batch_statuses: BATCH_STATUSES,
    duplicate_strategies: DUPLICATE_STRATEGIES,
    duplicate_key_types: DUPLICATE_KEY_TYPES,
    error_strategies: ERROR_STRATEGIES,
    error_categories: ERROR_CATEGORIES,
    error_types: ERROR_TYPES,
    error_statuses: ERROR_STATUSES,
    retry_strategies: RETRY_STRATEGIES,
    dependency_strategies: DEPENDENCY_STRATEGIES,
    dependency_types: DEPENDENCY_TYPES,
    plan_statuses: PLAN_STATUSES,
    plan_step_statuses: PLAN_STEP_STATUSES,
    readiness_states: READINESS_STATES,
    reconciliation_strategies: RECONCILIATION_STRATEGIES,
    reconciliation_statuses: RECONCILIATION_STATUSES,
    reconciliation_exception_types: RECONCILIATION_EXCEPTION_TYPES,
    source_adapter_types: SOURCE_ADAPTER_TYPES,
    source_adapter_capabilities: SOURCE_ADAPTER_CAPABILITIES,
    migration_scopes: MIGRATION_SCOPES,
    identifier_statuses: IDENTIFIER_STATUSES,
    relationship_statuses: RELATIONSHIP_STATUSES,
    file_migration_statuses: FILE_MIGRATION_STATUSES,
    pipeline_stages: PIPELINE_STAGES,
  };
}

export function publicError(error) {
  if (!error) return null;
  return { error: error.message, code: error.code || null, details: error.details || null };
}

export { HttpError };

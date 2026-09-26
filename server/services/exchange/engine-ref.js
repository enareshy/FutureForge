// Single import point for the reused Import & Export Framework engines (§7, §8).
//
// Standards & Exchange intentionally delegates generic mapping, transformation,
// validation-rule, lookup, duplicate and schema evaluation to the existing
// engines rather than creating a second rules engine.
import { Engines } from "../data-exchange/engines/index.js";

export const EngineRef = Engines;

export function mappingEngine() {
  return {
    applyMappings: Engines.applyMappings,
    mapRecord: Engines.mapRecord,
    validateMappings: Engines.validateMappings,
  };
}

export function transformationEngine() {
  return {
    applyTransformation: Engines.applyTransformation,
    applyTransformations: Engines.applyTransformations,
    applyDefinitionTransformations: Engines.applyDefinitionTransformations,
    transformationTypes: Engines.transformationTypes,
    registerTransformation: Engines.registerTransformation,
    applyTemplate: Engines.applyTemplate,
  };
}

export function validationEngine() {
  return {
    evaluateRules: Engines.evaluateRules,
    evaluateRule: Engines.evaluateRule,
    validateRule: Engines.validateRule,
    validationTypes: Engines.validationTypes,
    registerValidation: Engines.registerValidation,
  };
}

export function lookupEngine() {
  return {
    registerLookupSource: Engines.registerLookupSource,
    listLookupSources: Engines.listLookupSources,
    createLookupResolver: Engines.createLookupResolver,
  };
}

export function duplicateEngine() {
  return {
    computeDuplicateKey: Engines.computeDuplicateKey,
    decideDuplicate: Engines.decideDuplicate,
    mergeRecords: Engines.mergeRecords,
  };
}

export function schemaEngine() {
  return {
    targetSchema: Engines.targetSchema,
    discoverSourceSchema: Engines.discoverSourceSchema,
    validateTargetRecord: Engines.validateTargetRecord,
  };
}

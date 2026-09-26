// Engine subsystem facade.
import * as Transform from "./transform.js";
import * as Mapping from "./mapping.js";
import * as ValidationRules from "./validation.js";
import * as Lookup from "./lookup.js";
import * as Duplicate from "./duplicate.js";
import * as Schema from "./schema.js";

export { Transform, Mapping, ValidationRules, Lookup, Duplicate, Schema };

export const Engines = {
  // transformations
  registerTransformation: Transform.registerTransformationHandler,
  transformationTypes: Transform.transformationTypes,
  applyTransformation: Transform.applyTransformation,
  applyTransformations: Transform.applyTransformations,
  applyDefinitionTransformations: Transform.applyDefinitionTransformations,
  applyTemplate: Transform.applyTemplateString,
  getPath: Transform.getPath,
  setPath: Transform.setPath,
  maskValue: Transform.maskValue,
  // mappings
  applyMappings: Mapping.applyMappings,
  mapRecord: Mapping.mapRecord,
  validateMappings: Mapping.validateMappings,
  // validation rules
  registerValidation: ValidationRules.registerValidationHandler,
  validationTypes: ValidationRules.validationTypes,
  evaluateRules: ValidationRules.evaluateRules,
  evaluateRule: ValidationRules.evaluateRule,
  validateRule: ValidationRules.validateRule,
  // lookups
  registerLookupSource: Lookup.registerLookupSource,
  listLookupSources: Lookup.listLookupSources,
  createLookupResolver: Lookup.createLookupResolver,
  // duplicates
  computeDuplicateKey: Duplicate.computeDuplicateKey,
  decideDuplicate: Duplicate.decideDuplicate,
  mergeRecords: Duplicate.mergeRecords,
  // schema
  targetSchema: Schema.targetSchema,
  discoverSourceSchema: Schema.discoverSourceSchema,
  validateTargetRecord: Schema.validateTargetRecord,
};

export default Engines;

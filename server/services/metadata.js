// Public facade for the Configuration & Metadata Management module. Business
// modules should depend on this file rather than reaching into the individual
// services, so the internal layout can evolve without breaking consumers.

export {
  DATA_TYPES,
  listAttributes,
  getAttribute,
  createAttribute,
  updateAttribute,
  setAttributeStatus,
  resolveAttribute,
  ancestorAttributes,
  referencedEntity,
} from "./metadata/attributes.js";

export {
  TYPE_STATUSES,
  listTypes,
  getType,
  findType,
  createType,
  updateType,
  setTypeStatus,
  deleteType,
  addTypeAttribute,
  updateTypeAttribute,
  removeTypeAttribute,
  effectiveAttributes,
  resolveType,
  ancestorTypes,
  typeTree,
} from "./metadata/types.js";

export {
  SELECTION_TYPES,
  listLovs,
  getLov,
  findLov,
  createLov,
  updateLov,
  setLovStatus,
  deleteLov,
  listValues,
  addValue,
  updateValue,
  removeValue,
  cascadeOptions,
  markUsage,
  releaseUsage,
  listUsage,
  assertValueInLov,
  resolveLov,
} from "./metadata/lovs.js";

export {
  FORM_MODES,
  FORM_STATUSES,
  NODE_KINDS,
  listForms,
  getForm,
  findForm,
  createForm,
  updateForm,
  setFormStatus,
  deleteForm,
  replaceLayout,
  formVersions,
} from "./metadata/forms.js";

export { renderForm, renderType, formByTypeAndMode } from "./metadata/renderer.js";

export {
  RULE_CATEGORIES,
  RULE_STATUSES,
  listRules,
  getRule,
  createRule,
  updateRule,
  setRuleStatus,
  deleteRule,
  rulesFor,
  testRule,
  applyRules,
} from "./metadata/rules.js";

export { validateRecord, assertValidRecord, attributeContract } from "./metadata/validation.js";
export { evaluate, evaluateValue, validateExpression } from "./metadata/expression.js";

export {
  listVersions,
  getVersion,
  latestVersion,
  recordVersion,
} from "./metadata/versions.js";

export {
  SCOPES,
  ARTIFACT_TYPES,
  listConfigurations,
  resolveArtifactConfig,
  setConfiguration,
  deleteConfiguration,
  effectiveCatalog,
  assertEnabled,
} from "./metadata/configurations.js";

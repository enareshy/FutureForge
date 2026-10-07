// Public facade for the Requirements Manager domain.
//
// Every consumer (API layer, jobs, search, other domains) depends on this file
// rather than the internal layout so the implementation can evolve safely.
// Databases are always passed first so a call can participate in the caller's
// transaction (mirrors server/services/change/index.js).
import * as Constants from "./constants.js";
import * as Validation from "./validation.js";
import * as Errors from "./errors.js";
import * as Refs from "./refs.js";
import * as Repository from "./repository.js";
import * as Configuration from "./configuration.js";
import * as Events from "./events.js";
import * as History from "./history.js";
import * as Types from "./types.js";
import * as Requirements from "./requirements.js";
import * as Relationships from "./relationships.js";
import * as Baselines from "./baselines.js";
import * as ValidationRules from "./validation-rules.js";
import * as Search from "./search.js";
import * as Security from "./security.js";
import * as Foundation from "./foundation.js";
import * as Seed from "./seed.js";

export {
  Constants,
  Validation,
  Errors,
  Refs,
  Repository,
  Configuration,
  Events,
  History,
  Types,
  Requirements,
  Relationships,
  Baselines,
  ValidationRules,
  Search,
  Security,
  Foundation,
  Seed,
};

export { createRequirementsRouter } from "./router-requirements.js";

// Flat, stable SDK surface.
export const RequirementsManager = {
  // Requirement types
  listTypes: Types.listTypes,
  getType: Types.getType,
  createType: Types.createType,
  updateType: Types.updateType,
  setTypeStatus: Types.setTypeStatus,
  // Requirements
  createRequirement: Requirements.createRequirement,
  getRequirement: Requirements.getRequirement,
  listRequirements: Requirements.listRequirements,
  updateRequirement: Requirements.updateRequirement,
  deleteRequirement: Requirements.deleteRequirement,
  transitionRequirement: Requirements.transitionRequirement,
  submitRequirement: Requirements.submitRequirement,
  approveRequirement: Requirements.approveRequirement,
  rejectRequirement: Requirements.rejectRequirement,
  releaseRequirement: Requirements.releaseRequirement,
  obsoleteRequirement: Requirements.obsoleteRequirement,
  setVerificationStatus: Requirements.setVerificationStatus,
  // Revisions
  reviseRequirement: Requirements.reviseRequirement,
  listRevisions: Requirements.listRevisions,
  compareRevisions: Requirements.compareRevisions,
  // Hierarchy & relationships
  listChildren: Requirements.listChildren,
  createRelationship: Relationships.createRelationship,
  getRelationship: Relationships.getRelationship,
  listRelationships: Relationships.listRelationships,
  deleteRelationship: Relationships.deleteRelationship,
  relationshipsForRequirement: Relationships.relationshipsForRequirement,
  traverse: Relationships.traverse,
  // Baselines
  createBaseline: Baselines.createBaseline,
  getBaseline: Baselines.getBaseline,
  listBaselines: Baselines.listBaselines,
  addBaselineMember: Baselines.addBaselineMember,
  removeBaselineMember: Baselines.removeBaselineMember,
  releaseBaseline: Baselines.releaseBaseline,
  compareBaseline: Baselines.compareBaseline,
  listBaselineMembers: Baselines.listBaselineMembers,
  // Validation rules & reviews
  listValidationRules: ValidationRules.listValidationRules,
  getValidationRule: ValidationRules.getValidationRule,
  createValidationRule: ValidationRules.createValidationRule,
  updateValidationRule: ValidationRules.updateValidationRule,
  deleteValidationRule: ValidationRules.deleteValidationRule,
  validateRequirement: ValidationRules.validateRequirement,
  runValidation: ValidationRules.runValidation,
  // History
  listRequirementHistory: Requirements.listRequirementHistory,
  listHistory: History.listHistory,
  // Configuration & vocabulary
  getConfig: Configuration.getConfig,
  setConfig: Configuration.setConfig,
  listConfig: Configuration.listConfig,
  vocabulary: Validation.vocabulary,
};

// Async SDK surface for the fully-async request path.
export const RequirementsManagerAsync = {
  listTypes: Types.listTypesAsync,
  getType: Types.getTypeAsync,
  createType: Types.createTypeAsync,
  updateType: Types.updateTypeAsync,
  setTypeStatus: Types.setTypeStatusAsync,
  createRequirement: Requirements.createRequirementAsync,
  getRequirement: Requirements.getRequirementAsync,
  listRequirements: Requirements.listRequirementsAsync,
  updateRequirement: Requirements.updateRequirementAsync,
  deleteRequirement: Requirements.deleteRequirementAsync,
  transitionRequirement: Requirements.transitionRequirementAsync,
  submitRequirement: Requirements.submitRequirementAsync,
  approveRequirement: Requirements.approveRequirementAsync,
  rejectRequirement: Requirements.rejectRequirementAsync,
  releaseRequirement: Requirements.releaseRequirementAsync,
  obsoleteRequirement: Requirements.obsoleteRequirementAsync,
  setVerificationStatus: Requirements.setVerificationStatusAsync,
  reviseRequirement: Requirements.reviseRequirementAsync,
  listRevisions: Requirements.listRevisionsAsync,
  compareRevisions: Requirements.compareRevisionsAsync,
  listChildren: Requirements.listChildrenAsync,
  createRelationship: Relationships.createRelationshipAsync,
  getRelationship: Relationships.getRelationshipAsync,
  listRelationships: Relationships.listRelationshipsAsync,
  deleteRelationship: Relationships.deleteRelationshipAsync,
  relationshipsForRequirement: Relationships.relationshipsForRequirementAsync,
  traverse: Relationships.traverseAsync,
  createBaseline: Baselines.createBaselineAsync,
  getBaseline: Baselines.getBaselineAsync,
  listBaselines: Baselines.listBaselinesAsync,
  addBaselineMember: Baselines.addBaselineMemberAsync,
  removeBaselineMember: Baselines.removeBaselineMemberAsync,
  releaseBaseline: Baselines.releaseBaselineAsync,
  compareBaseline: Baselines.compareBaselineAsync,
  listBaselineMembers: Baselines.listBaselineMembersAsync,
  listValidationRules: ValidationRules.listValidationRulesAsync,
  getValidationRule: ValidationRules.getValidationRuleAsync,
  createValidationRule: ValidationRules.createValidationRuleAsync,
  updateValidationRule: ValidationRules.updateValidationRuleAsync,
  deleteValidationRule: ValidationRules.deleteValidationRuleAsync,
  validateRequirement: ValidationRules.validateRequirementAsync,
  runValidation: ValidationRules.runValidationAsync,
  listRequirementHistory: Requirements.listRequirementHistoryAsync,
  listHistory: History.listHistoryAsync,
  getConfig: Configuration.getConfigAsync,
  setConfig: Configuration.setConfigAsync,
  listConfig: Configuration.listConfigAsync,
};

export const ensureRequirementsFoundation = Foundation.ensureRequirementsFoundation;
export const ensureRequirementsFoundationAsync = Foundation.ensureRequirementsFoundationAsync;
export const requirementsHealth = Foundation.requirementsHealth;
export const requirementsHealthAsync = Foundation.requirementsHealthAsync;
export const seedRequirements = Seed.seedRequirements;
export const seedRequirementsAsync = Seed.seedRequirementsAsync;

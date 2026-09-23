// Public facade for the Enterprise Classification Framework.
//
// Every consumer (API layer, PDM/BOM/Documents/Manufacturing/Quality/Supplier/
// Product modules, jobs, search, imports) depends on this file rather than the
// internal layout so the implementation can evolve safely. Databases are always
// passed first so a call can participate in the caller's transaction.
import * as constants from "./constants.js";
import * as Validation from "./validation.js";
import * as Errors from "./errors.js";
import * as Refs from "./refs.js";
import * as Repository from "./repository.js";
import * as Units from "./units.js";
import * as Configuration from "./configuration.js";
import * as Events from "./events.js";
import * as History from "./history.js";
import * as Security from "./security.js";
import * as Definitions from "./definitions.js";
import * as Hierarchy from "./hierarchy.js";
import * as Characteristics from "./characteristics.js";
import * as Inheritance from "./inheritance.js";
import * as Assignments from "./assignments.js";
import * as Rules from "./rules.js";
import * as ValidationService from "./validation-service.js";
import * as Duplicates from "./duplicates.js";
import * as Metrics from "./metrics.js";
import * as Jobs from "./jobs.js";
import * as Search from "./search.js";
import * as Foundation from "./foundation.js";
import * as Seed from "./seed.js";

export {
  constants,
  Validation,
  Errors,
  Refs,
  Repository,
  Units,
  Configuration,
  Events,
  History,
  Security,
  Definitions,
  Hierarchy,
  Characteristics,
  Inheritance,
  Assignments,
  Rules,
  ValidationService,
  Duplicates,
  Metrics,
  Jobs,
  Search,
  Foundation,
  Seed,
};

export * as Constants from "./constants.js";

// Flat, stable SDK surface.
export const Classification = {
  // Definitions
  createClassification: Definitions.createClassification,
  getClassification: Definitions.getClassification,
  listClassifications: Definitions.listClassifications,
  updateClassification: Definitions.updateClassification,
  setClassificationStatus: Definitions.setClassificationStatus,
  approveClassification: Definitions.approveClassification,
  deleteClassification: Definitions.deleteClassification,
  createClassificationVersion: Definitions.createClassificationVersion,
  listClassificationVersions: Definitions.listClassificationVersions,
  // Classes & hierarchy
  createClass: Hierarchy.createClass,
  getClass: Hierarchy.getClass,
  listClasses: Hierarchy.listClasses,
  updateClass: Hierarchy.updateClass,
  moveClass: Hierarchy.moveClass,
  reorderClasses: Hierarchy.reorderClasses,
  copyClass: Hierarchy.copyClass,
  deleteClass: Hierarchy.deleteClass,
  setClassStatus: Hierarchy.setClassStatus,
  classTree: Hierarchy.classTree,
  classChildren: Hierarchy.classChildren,
  classAncestors: Hierarchy.classAncestors,
  classDescendants: Hierarchy.classDescendants,
  createClassVersion: Hierarchy.createClassVersion,
  listClassVersions: Hierarchy.listClassVersions,
  // Characteristics
  createCharacteristic: Characteristics.createCharacteristic,
  getCharacteristic: Characteristics.getCharacteristic,
  listCharacteristics: Characteristics.listCharacteristics,
  updateCharacteristic: Characteristics.updateCharacteristic,
  setCharacteristicStatus: Characteristics.setCharacteristicStatus,
  deleteCharacteristic: Characteristics.deleteCharacteristic,
  listAllowedValues: Characteristics.listAllowedValues,
  createAllowedValue: Characteristics.createAllowedValue,
  updateAllowedValue: Characteristics.updateAllowedValue,
  deleteAllowedValue: Characteristics.deleteAllowedValue,
  // Groups
  createGroup: Characteristics.createGroup,
  listGroups: Characteristics.listGroups,
  getGroup: Characteristics.getGroupRow,
  updateGroup: Characteristics.updateGroup,
  deleteGroup: Characteristics.deleteGroup,
  addGroupMember: Characteristics.addGroupMember,
  removeGroupMember: Characteristics.removeGroupMember,
  listGroupMembers: Characteristics.listGroupMembers,
  // Class characteristics & inheritance
  addClassCharacteristic: Characteristics.addClassCharacteristic,
  updateClassCharacteristic: Characteristics.updateClassCharacteristic,
  removeClassCharacteristic: Characteristics.removeClassCharacteristic,
  listClassCharacteristics: Characteristics.listClassCharacteristics,
  resolveEffectiveCharacteristics: Inheritance.resolveEffectiveCharacteristics,
  effectiveCharacteristic: Inheritance.effectiveCharacteristic,
  validateAllowedValueModes: Inheritance.validateAllowedValueModes,
  // Assignment
  assignClass: Assignments.assignClass,
  getAssignment: Assignments.getAssignment,
  listAssignments: Assignments.listAssignments,
  setAssignmentValues: Assignments.setAssignmentValues,
  setAssignmentStatus: Assignments.setAssignmentStatus,
  reclassify: Assignments.reclassify,
  unassign: Assignments.unassign,
  validateAssignment: Assignments.validateAssignment,
  objectClassifications: Assignments.objectClassifications,
  resolveObjectValues: Assignments.resolveObjectValues,
  effectiveCharacteristicsForObject: Assignments.effectiveCharacteristicsForObject,
  // Validation
  validateClassValues: ValidationService.validateClassValues,
  validateAssignmentValues: ValidationService.validateAssignmentValues,
  validateObject: ValidationService.validateObject,
  validateBatch: ValidationService.validateBatch,
  storedValuesForAssignment: ValidationService.storedValuesForAssignment,
  // Rules
  createRule: Rules.createRule,
  listRules: Rules.listRules,
  updateRule: Rules.updateRule,
  deleteRule: Rules.deleteRule,
  evaluateRules: Rules.evaluateRules,
  // Duplicates
  detectDuplicates: Duplicates.detectClassificationDuplicates,
  duplicateSummary: Duplicates.duplicateSummary,
  classificationSignature: Duplicates.classificationSignature,
  registerDuplicateStrategies: Duplicates.registerClassificationDuplicateStrategies,
  // Units
  listUnits: Units.listUnits,
  convertValue: Units.convertValue,
  // Search
  ensureSearch: Search.ensureClassificationSearch,
  // Configuration
  getConfig: Configuration.getConfig,
  setConfig: Configuration.setConfig,
  listConfig: Configuration.listConfig,
  // History & audit
  listHistory: History.listHistory,
  objectLineage: History.objectLineage,
  listAudit: Definitions.listClassificationAudit,
  // Jobs
  submitBulkAssignJob: Jobs.submitBulkAssignJob,
  submitBulkValidateJob: Jobs.submitBulkValidateJob,
  submitDuplicateScanJob: Jobs.submitDuplicateScanJob,
  submitMaintenanceJob: Jobs.submitMaintenanceJob,
  bulkAssign: Jobs.bulkAssign,
  bulkValidate: Jobs.bulkValidate,
  runMaintenance: Jobs.runMaintenance,
  // Metrics
  metrics: Metrics.metricsSnapshot,
  health: Metrics.healthCheck,
  coverage: Metrics.coverageReport,
};

export const ensureClassificationFoundation = Foundation.ensureClassificationFoundation;
export const classificationHealth = Foundation.classificationHealth;
export const registerClassificationHandlers = Jobs.registerClassificationHandlers;
export const ensureClassificationJobTypes = Jobs.ensureClassificationJobTypes;
export const runClassificationMaintenance = Jobs.runMaintenance;
export const registerClassificationSources = Search.registerClassificationSources;
export const ensureClassificationSearch = Search.ensureClassificationSearch;
export const registerClassificationDuplicateStrategies = Duplicates.registerClassificationDuplicateStrategies;
export const ensureClassificationUnits = Units.ensureClassificationUnits;
export const ensureClassificationConfig = Configuration.ensureClassificationConfig;
export const seedClassification = Seed.seedClassification;
export const ensureClassificationSeed = Seed.ensureClassificationSeed;

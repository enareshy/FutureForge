// Public facade for the P1 BOM Engine.
//
// Every consumer (API layer, PDM/Manufacturing/Quality modules, jobs, search,
// imports) depends on this file rather than the internal layout so the
// implementation can evolve safely. Databases are always passed first so a call
// can participate in the caller's transaction.
import * as Constants from "./constants.js";
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
import * as Revisions from "./revisions.js";
import * as Lines from "./lines.js";
import * as Structure from "./structure.js";
import * as Effectivity from "./effectivity.js";
import * as Variants from "./variants.js";
import * as Substitutes from "./substitutes.js";
import * as WhereUsed from "./where-used.js";
import * as Rollup from "./rollup.js";
import * as Compare from "./compare.js";
import * as Transformation from "./transformation.js";
import * as Validator from "./validator.js";
import * as Baselines from "./baseline.js";
import * as Metrics from "./metrics.js";
import * as Jobs from "./jobs.js";
import * as Search from "./search.js";
import * as Foundation from "./foundation.js";
import * as Seed from "./seed.js";

export {
  Constants,
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
  Revisions,
  Lines,
  Structure,
  Effectivity,
  Variants,
  Substitutes,
  WhereUsed,
  Rollup,
  Compare,
  Transformation,
  Validator,
  Baselines,
  Metrics,
  Jobs,
  Search,
  Foundation,
  Seed,
};

// Flat, stable SDK surface.
export const Bom = {
  // Headers
  createBom: Definitions.createBom,
  getBom: Definitions.getBom,
  listBoms: Definitions.listBoms,
  updateBom: Definitions.updateBom,
  setBomStatus: Definitions.setBomStatus,
  deleteBom: Definitions.deleteBom,
  // Revisions
  createRevision: Revisions.createRevision,
  getRevision: Revisions.getRevision,
  listRevisions: Revisions.listRevisions,
  updateRevision: Revisions.updateRevision,
  setRevisionStatus: Revisions.setRevisionStatus,
  reviseRevision: Revisions.reviseRevision,
  deleteRevision: Revisions.deleteRevision,
  // Lines
  addLine: Lines.addLine,
  getLine: Lines.getLine,
  listLines: Lines.listLines,
  updateLine: Lines.updateLine,
  removeLine: Lines.removeLine,
  reorderLines: Lines.reorderLines,
  setLineAttributes: Lines.setLineAttributes,
  listLineAttributes: Lines.listLineAttributes,
  // Structure
  buildTree: Structure.buildTree,
  flatStructure: Structure.flatStructure,
  flattenTree: Structure.flattenTree,
  // Substitutes
  addSubstitute: Substitutes.addSubstitute,
  updateSubstitute: Substitutes.updateSubstitute,
  removeSubstitute: Substitutes.removeSubstitute,
  listSubstitutes: Substitutes.listSubstitutes,
  resolveSubstitutes: Substitutes.resolveSubstitutes,
  substituteSummary: Substitutes.substituteSummary,
  // Analysis
  whereUsed: WhereUsed.whereUsed,
  uses: WhereUsed.uses,
  multiLevelWhereUsed: WhereUsed.multiLevelWhereUsed,
  componentUsageSummary: WhereUsed.componentUsageSummary,
  rollup: Rollup.rollup,
  rollupTotals: Rollup.rollupTotals,
  compare: Compare.compare,
  compareRevisions: Compare.compareRevisions,
  compareRevisionToBaseline: Compare.compareRevisionToBaseline,
  getComparison: Compare.getComparison,
  listComparisons: Compare.listComparisons,
  listComparisonResults: Compare.listComparisonResults,
  // Transformation
  createTransformationDefinition: Transformation.createTransformationDefinition,
  getTransformationDefinition: Transformation.getTransformationDefinition,
  listTransformationDefinitions: Transformation.listTransformationDefinitions,
  updateTransformationDefinition: Transformation.updateTransformationDefinition,
  deleteTransformationDefinition: Transformation.deleteTransformationDefinition,
  createMapping: Transformation.createMapping,
  updateMapping: Transformation.updateMapping,
  deleteMapping: Transformation.deleteMapping,
  listMappings: Transformation.listMappings,
  transform: Transformation.transform,
  listTransformationRuns: Transformation.listTransformationRuns,
  getTransformationRun: Transformation.getTransformationRun,
  // Validation
  validateRevision: Validator.validateRevision,
  assertRevisionValid: Validator.assertRevisionValid,
  listValidationRules: Validator.listValidationRules,
  createValidationRule: Validator.createValidationRule,
  updateValidationRule: Validator.updateValidationRule,
  deleteValidationRule: Validator.deleteValidationRule,
  listValidationResults: Validator.listValidationResults,
  listValidationIssues: Validator.listValidationIssues,
  // Baselines
  createBaseline: Baselines.createBaseline,
  getBaseline: Baselines.getBaseline,
  listBaselines: Baselines.listBaselines,
  freezeBaseline: Baselines.freezeBaseline,
  deleteBaseline: Baselines.deleteBaseline,
  listBaselineLines: Baselines.listBaselineLines,
  baselineSnapshot: Baselines.baselineSnapshot,
  // Effectivity & variants
  normalizeEffectivity: Effectivity.normalizeEffectivity,
  isEffectivityActive: Effectivity.isEffectivityActive,
  filterByEffectivity: Effectivity.filterByEffectivity,
  normalizeContext: Variants.normalizeContext,
  isApplicable: Variants.isApplicable,
  filterByVariant: Variants.filterByVariant,
  // Units
  listUnits: Units.listUnits,
  convertValue: Units.convertValue,
  ensureUnits: Units.ensureBomUnits,
  // Configuration
  getConfig: Configuration.getConfig,
  setConfig: Configuration.setConfig,
  listConfig: Configuration.listConfig,
  // History & audit
  listHistory: History.listHistory,
  objectLineage: History.objectLineage,
  listAudit: Definitions.listBomAudit,
  // Jobs
  submitRollupJob: Jobs.submitRollupJob,
  submitWhereUsedJob: Jobs.submitWhereUsedJob,
  submitTransformJob: Jobs.submitTransformJob,
  submitValidateJob: Jobs.submitValidateJob,
  submitCompareJob: Jobs.submitCompareJob,
  submitMaintenanceJob: Jobs.submitMaintenanceJob,
  bulkValidate: Jobs.bulkValidate,
  runMaintenance: Jobs.runBomMaintenance,
  // Search
  ensureSearch: Search.ensureBomSearch,
  // Metrics
  metrics: Metrics.metricsSnapshot,
  health: Metrics.healthCheck,
  compareSummary: Metrics.compareSummary,
};

export const ensureBomFoundation = Foundation.ensureBomFoundation;
export const bomHealth = Foundation.bomHealth;
export const registerBomHandlers = Jobs.registerBomHandlers;
export const ensureBomJobTypes = Jobs.ensureBomJobTypes;
export const runBomMaintenance = Jobs.runBomMaintenance;
export const registerBomSources = Search.registerBomSources;
export const ensureBomSearch = Search.ensureBomSearch;
export const ensureBomUnits = Units.ensureBomUnits;
export const ensureBomConfig = Configuration.ensureBomConfig;
export const ensureDefaultValidationRules = Validator.ensureDefaultValidationRules;
export const seedBom = Seed.seedBom;
export const ensureBomSeed = Seed.ensureBomSeed;

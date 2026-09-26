// Public facade for the P1 PDM domain.
//
// Every consumer (API layer, BOM/Manufacturing/Quality modules, jobs, search,
// imports) depends on this file rather than the internal layout so the
// implementation can evolve safely. Databases are always passed first so a call
// can participate in the caller's transaction.
import * as Constants from "./constants.js";
import * as Validation from "./validation.js";
import * as Errors from "./errors.js";
import * as Refs from "./refs.js";
import * as Repository from "./repository.js";
import * as Configuration from "./configuration.js";
import * as Events from "./events.js";
import * as History from "./history.js";
import * as Security from "./security.js";
import * as Items from "./items.js";
import * as Revisions from "./revisions.js";
import * as Datasets from "./datasets.js";
import * as Representations from "./representations.js";
import * as DesignData from "./design-data.js";
import * as Cad from "./cad.js";
import * as RevisionRules from "./revision-rules.js";
import * as ConfigurationRules from "./configuration-rules.js";
import * as Baselines from "./baselines.js";
import * as Relationships from "./relationships.js";
import * as References from "./references.js";
import * as WhereUsed from "./where-used.js";
import * as WhereReferenced from "./where-referenced.js";
import * as Structure from "./structure.js";
import * as Validator from "./validator.js";
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
  Configuration,
  Events,
  History,
  Security,
  Items,
  Revisions,
  Datasets,
  Representations,
  DesignData,
  Cad,
  RevisionRules,
  ConfigurationRules,
  Baselines,
  Relationships,
  References,
  WhereUsed,
  WhereReferenced,
  Structure,
  Validator,
  Metrics,
  Jobs,
  Search,
  Foundation,
  Seed,
};

// Flat, stable SDK surface.
export const Pdm = {
  // Items
  createItem: Items.createItem,
  getItem: Items.getItem,
  listItems: Items.listItems,
  updateItem: Items.updateItem,
  setItemStatus: Items.setItemStatus,
  deleteItem: Items.deleteItem,
  listItemAudit: Items.listItemAudit,
  // Revisions
  createRevision: Revisions.createRevision,
  getRevision: Revisions.getRevision,
  listRevisions: Revisions.listRevisions,
  updateRevision: Revisions.updateRevision,
  setRevisionStatus: Revisions.setRevisionStatus,
  reviseRevision: Revisions.reviseRevision,
  deleteRevision: Revisions.deleteRevision,
  isRevisionEditable: Revisions.isRevisionEditable,
  // Datasets
  createDataset: Datasets.createDataset,
  getDataset: Datasets.getDataset,
  listDatasets: Datasets.listDatasets,
  updateDataset: Datasets.updateDataset,
  setDatasetStatus: Datasets.setDatasetStatus,
  linkDatasetContent: Datasets.linkDatasetContent,
  deleteDataset: Datasets.deleteDataset,
  datasetsForRevision: Datasets.datasetsForRevision,
  // Representations
  createRepresentation: Representations.createRepresentation,
  getRepresentation: Representations.getRepresentation,
  listRepresentations: Representations.listRepresentations,
  updateRepresentation: Representations.updateRepresentation,
  deleteRepresentation: Representations.deleteRepresentation,
  representationsForRevision: Representations.representationsForRevision,
  // Design data
  createDesignData: DesignData.createDesignData,
  getDesignData: DesignData.getDesignData,
  listDesignData: DesignData.listDesignData,
  updateDesignData: DesignData.updateDesignData,
  deleteDesignData: DesignData.deleteDesignData,
  designDataForRevision: DesignData.designDataForRevision,
  // CAD
  createCadAssociation: Cad.createCadAssociation,
  getCadAssociation: Cad.getCadAssociation,
  listCadAssociations: Cad.listCadAssociations,
  updateCadAssociation: Cad.updateCadAssociation,
  deleteCadAssociation: Cad.deleteCadAssociation,
  cadAssociationsForRevision: Cad.cadAssociationsForRevision,
  primaryCadForRevision: Cad.primaryCadForRevision,
  // Rules
  createRevisionRule: RevisionRules.createRevisionRule,
  getRevisionRule: RevisionRules.getRevisionRule,
  listRevisionRules: RevisionRules.listRevisionRules,
  updateRevisionRule: RevisionRules.updateRevisionRule,
  activateRevisionRule: RevisionRules.activateRevisionRule,
  setRevisionRuleStatus: RevisionRules.setRevisionRuleStatus,
  publishRevisionRuleVersion: RevisionRules.publishRevisionRuleVersion,
  listRevisionRuleVersions: RevisionRules.listRevisionRuleVersions,
  deleteRevisionRule: RevisionRules.deleteRevisionRule,
  resolveRevisionRule: RevisionRules.resolveRevisionRule,
  createConfigurationRule: ConfigurationRules.createConfigurationRule,
  getConfigurationRule: ConfigurationRules.getConfigurationRule,
  listConfigurationRules: ConfigurationRules.listConfigurationRules,
  updateConfigurationRule: ConfigurationRules.updateConfigurationRule,
  activateConfigurationRule: ConfigurationRules.activateConfigurationRule,
  setConfigurationRuleStatus: ConfigurationRules.setConfigurationRuleStatus,
  publishConfigurationRuleVersion: ConfigurationRules.publishConfigurationRuleVersion,
  listConfigurationRuleVersions: ConfigurationRules.listConfigurationRuleVersions,
  deleteConfigurationRule: ConfigurationRules.deleteConfigurationRule,
  evaluateConfigurationRule: ConfigurationRules.evaluateConfigurationRule,
  evaluateConfigurationRules: ConfigurationRules.evaluateConfigurationRules,
  // Baselines
  createBaseline: Baselines.createBaseline,
  getBaseline: Baselines.getBaseline,
  listBaselines: Baselines.listBaselines,
  updateBaseline: Baselines.updateBaseline,
  releaseBaseline: Baselines.releaseBaseline,
  freezeBaseline: Baselines.freezeBaseline,
  retireBaseline: Baselines.retireBaseline,
  deleteBaseline: Baselines.deleteBaseline,
  listBaselineMembers: Baselines.listBaselineMembers,
  addBaselineMember: Baselines.addBaselineMember,
  removeBaselineMember: Baselines.removeBaselineMember,
  baselineSnapshotMeta: Baselines.baselineSnapshotMeta,
  // Relationships & references
  createRelationship: Relationships.createRelationship,
  getRelationship: Relationships.getRelationship,
  listRelationships: Relationships.listRelationships,
  updateRelationship: Relationships.updateRelationship,
  deleteRelationship: Relationships.deleteRelationship,
  listReferences: References.listReferences,
  recordReference: References.recordReference,
  removeReference: References.removeReference,
  // Analysis
  whereUsed: WhereUsed.whereUsed,
  whereReferenced: WhereReferenced.whereReferenced,
  referencesSummary: WhereReferenced.referencesSummary,
  rebuildReferences: WhereReferenced.rebuildReferences,
  resolveStructure: Structure.resolveStructure,
  validateStructureGraph: Structure.validateStructureGraph,
  // Validation
  validateItem: Validator.validateItem,
  validateRevision: Validator.validateRevision,
  validateDataset: Validator.validateDataset,
  validateTenant: Validator.validateTenant,
  listValidationRules: Validator.listValidationRules,
  createValidationRule: Validator.createValidationRule,
  updateValidationRule: Validator.updateValidationRule,
  deleteValidationRule: Validator.deleteValidationRule,
  listValidationResults: Validator.listValidationResults,
  getValidationResult: Validator.getValidationResult,
  // Configuration
  getConfig: Configuration.getConfig,
  setConfig: Configuration.setConfig,
  listConfig: Configuration.listConfig,
  // History & audit
  listHistory: History.listHistory,
  objectLineage: History.objectLineage,
  listAudit: Items.listItemAudit,
  // Jobs
  submitStructureResolveJob: Jobs.submitStructureResolveJob,
  submitWhereUsedJob: Jobs.submitWhereUsedJob,
  submitWhereReferencedJob: Jobs.submitWhereReferencedJob,
  submitBaselineJob: Jobs.submitBaselineJob,
  submitValidateJob: Jobs.submitValidateJob,
  submitReindexJob: Jobs.submitReindexJob,
  submitMaintenanceJob: Jobs.submitMaintenanceJob,
  bulkValidate: Jobs.bulkValidate,
  runMaintenance: Jobs.runPdmMaintenance,
  // Search
  ensureSearch: Search.ensurePdmSearch,
  // Metrics
  metrics: Metrics.metricsSnapshot,
  health: Metrics.healthCheck,
  ruleUsage: Metrics.ruleUsageStats,
};

export const ensurePdmFoundation = Foundation.ensurePdmFoundation;
export const pdmHealth = Foundation.pdmHealth;
export const registerPdmHandlers = Jobs.registerPdmHandlers;
export const ensurePdmJobTypes = Jobs.ensurePdmJobTypes;
export const runPdmMaintenance = Jobs.runPdmMaintenance;
export const registerPdmSources = Search.registerPdmSources;
export const ensurePdmSearch = Search.ensurePdmSearch;
export const ensurePdmConfig = Configuration.ensurePdmConfig;
export const ensureDefaultValidationRules = Validator.ensureDefaultValidationRules;
export const seedPdm = Seed.seedPdm;
export const ensurePdmSeed = Seed.ensurePdmSeed;

// Public facade for the Migration & Onboarding Framework.
//
// Business modules and the API layer depend on this file rather than the
// internal layout, so the implementation can evolve safely. Databases are always
// passed first so a call can participate in the caller's transaction.
import * as constants from "./constants.js";
import * as Validation from "./validation.js";
import * as Errors from "./errors.js";
import * as Refs from "./refs.js";
import * as Repository from "./repository.js";
import * as Configuration from "./configuration.js";
import * as Events from "./events.js";
import * as Audit from "./audit.js";
import * as Security from "./security.js";
import * as SourceConfigurations from "./source-configurations.js";
import * as SourceAdapters from "./source-adapters/index.js";
import * as Definitions from "./definitions.js";
import * as Projects from "./projects.js";
import * as Packages from "./packages.js";
import * as Dependencies from "./dependencies.js";
import * as Planning from "./planning.js";
import * as IdentifierMapping from "./identifier-mapping.js";
import * as Relationships from "./relationships.js";
import * as Execution from "./execution.js";
import * as Reconciliation from "./reconciliation.js";
import * as Statistics from "./statistics.js";
import * as Files from "./files.js";
import * as Jobs from "./jobs.js";
import * as Foundation from "./foundation.js";
import * as Seed from "./seed.js";
import * as Search from "./search.js";

export {
  constants,
  Validation,
  Errors,
  Refs,
  Repository,
  Configuration,
  Events,
  Audit,
  Security,
  SourceConfigurations,
  SourceAdapters,
  Definitions,
  Projects,
  Packages,
  Dependencies,
  Planning,
  IdentifierMapping,
  Relationships,
  Execution,
  Reconciliation,
  Statistics,
  Files,
  Jobs,
  Foundation,
  Seed,
  Search,
};

export * as Constants from "./constants.js";

// Flat, stable SDK surface.
export const Migration = {
  // Source adapters
  sourceAdapters: SourceAdapters.Registry.listSourceAdapters,
  sourceAdapterTypes: SourceAdapters.Registry.sourceAdapterTypes,
  registerSourceAdapter: SourceAdapters.Registry.registerSourceAdapter,
  // Source configurations
  createSourceConfiguration: SourceConfigurations.createSourceConfiguration,
  getSourceConfiguration: SourceConfigurations.getSourceConfiguration,
  listSourceConfigurations: SourceConfigurations.listSourceConfigurations,
  updateSourceConfiguration: SourceConfigurations.updateSourceConfiguration,
  setSourceConfigurationStatus: SourceConfigurations.setSourceConfigurationStatus,
  testSourceConfiguration: SourceConfigurations.testSourceConfiguration,
  discoverSourceConfigurationSchema: SourceConfigurations.discoverSourceConfigurationSchema,
  // Projects
  createProject: Projects.createProject,
  getProject: Projects.getProject,
  listProjects: Projects.listProjects,
  updateProject: Projects.updateProject,
  setProjectStatus: Projects.setProjectStatus,
  listProjectPackages: Projects.listProjectPackages,
  // Packages
  createPackage: Packages.createPackage,
  getPackage: Packages.getPackage,
  listPackages: Packages.listPackages,
  updatePackage: Packages.updatePackage,
  setPackageStatus: Packages.setPackageStatus,
  listPackageVersions: Packages.listPackageVersions,
  // Definitions
  createDefinition: Definitions.createDefinition,
  getDefinition: Definitions.getDefinition,
  listDefinitions: Definitions.listDefinitions,
  updateDefinition: Definitions.updateDefinition,
  setDefinitionStatus: Definitions.setDefinitionStatus,
  validateDefinition: Definitions.validateDefinition,
  createDefinitionVersion: Definitions.createDefinitionVersion,
  listDefinitionVersions: Definitions.listDefinitionVersions,
  // Dependencies & planning
  listPackageDependencies: Dependencies.listPackageDependencies,
  listProjectDependencies: Dependencies.listProjectDependencies,
  resolveDependencies: Dependencies.resolveDependencies,
  topologicalOrder: Dependencies.topologicalOrder,
  generatePlan: Planning.generatePlan,
  getPlan: Planning.getPlan,
  listPlans: Planning.listPlans,
  approvePlan: Planning.approvePlan,
  readinessReport: Planning.readinessReport,
  // Execution
  previewMigration: Execution.previewMigration,
  validateMigration: Execution.validateMigration,
  createMigrationJob: Execution.createMigrationJob,
  runMigrationJob: Execution.runMigrationJob,
  getMigrationJob: Execution.getMigrationJob,
  listMigrationJobs: Execution.listMigrationJobs,
  listBatches: Execution.listBatches,
  listObjectResults: Execution.listObjectResults,
  listErrors: Execution.listErrors,
  listCheckpoints: Execution.listCheckpoints,
  cancelMigrationJob: Execution.cancelMigrationJob,
  pauseMigrationJob: Execution.pauseMigrationJob,
  resumeMigrationJob: Execution.resumeMigrationJob,
  retryMigrationJob: Execution.retryMigrationJob,
  // Identifier & relationship mapping
  mapIdentifier: IdentifierMapping.mapIdentifier,
  bulkMapIdentifiers: IdentifierMapping.bulkMapIdentifiers,
  resolveIdentifier: IdentifierMapping.resolveIdentifier,
  buildIdentifierMap: IdentifierMapping.buildIdentifierMap,
  listIdentifierMappings: IdentifierMapping.listIdentifierMappings,
  migrateRelationship: Relationships.migrateRelationship,
  bulkMigrateRelationships: Relationships.bulkMigrateRelationships,
  listRelationshipMappings: Relationships.listRelationshipMappings,
  retryMissingRelationships: Relationships.retryMissingRelationships,
  // Files
  migrateRecordFiles: Files.migrateRecordFiles,
  listFileMigrations: Files.listFileMigrations,
  // Reconciliation & statistics
  reconcileJob: Reconciliation.reconcileJob,
  getReconciliation: Reconciliation.getReconciliation,
  listReconciliations: Reconciliation.listReconciliations,
  listReconciliationExceptions: Reconciliation.listExceptions,
  listStatistics: Statistics.listStatistics,
  metrics: Statistics.metricsSnapshot,
  health: Statistics.healthCheck,
  // Audit
  listAudit: Audit.listMigrationAudit,
  objectLineage: Audit.objectLineage,
  // Configuration
  getConfig: Configuration.getConfig,
  setConfig: Configuration.setConfig,
  listConfig: Configuration.listConfig,
  // Jobs
  listJobs: Jobs.listMigrationJobs,
  submitMigrationJob: Jobs.submitMigrationJob,
  submitValidateJob: Jobs.submitValidateJob,
  submitReconcileJob: Jobs.submitReconcileJob,
  submitRetryJob: Jobs.submitRetryJob,
  submitReplanJob: Jobs.submitReplanJob,
  submitMaintenanceJob: Jobs.submitMaintenanceJob,
};

export const ensureMigrationFoundation = Foundation.ensureMigrationFoundation;
export const migrationHealth = Foundation.migrationHealth;
export const registerMigrationSources = Search.registerMigrationSources;
export const ensureMigrationSearch = Search.ensureMigrationSearch;
export const registerMigrationHandlers = Jobs.registerMigrationHandlers;
export const ensureMigrationJobTypes = Jobs.ensureMigrationJobTypes;
export const runMigrationMaintenance = Jobs.runMigrationMaintenance;
export const seedMigration = Seed.seedMigration;
export const ensureMigrationSeed = Seed.ensureMigrationSeed;
export const ensureSourceAdapters = SourceAdapters.ensureSourceAdapters;

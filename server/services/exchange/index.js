// Public facade for the P2 Standards & Exchange capability.
//
// Every consumer (API layer, jobs, search, reporting, other modules) depends on
// this file rather than the internal layout so the implementation can evolve
// safely. Databases are always passed first so a call can participate in the
// caller's transaction.
import * as Constants from "./constants.js";
import * as Errors from "./errors.js";
import * as Identifiers from "./identifiers.js";
import * as Repository from "./repository.js";
import * as Canonical from "./canonical.js";
import * as Parsing from "./parsing.js";
import * as Xml from "./xml.js";
import * as JsonSchema from "./json-schema.js";
import * as ValidationResult from "./validation-result.js";
import * as EngineRef from "./engine-ref.js";
import * as Integrations from "./integrations.js";
import * as Formats from "./formats.js";
import * as Detection from "./detection.js";
import * as Definitions from "./definitions.js";
import * as Mappings from "./mappings.js";
import * as Transformations from "./transformations.js";
import * as Validation from "./validation.js";
import * as Security from "./security.js";
import * as Events from "./events.js";
import * as History from "./history.js";
import * as Reconciliation from "./reconciliation.js";
import * as Processor from "./processor.js";
import * as Jobs from "./jobs.js";
import * as Metrics from "./metrics.js";
import * as Configuration from "./configuration.js";
import * as Search from "./search.js";
import * as Foundation from "./foundation.js";
import * as Seed from "./seed.js";
import * as Adapters from "./adapters/index.js";

export {
  Constants,
  Errors,
  Identifiers,
  Repository,
  Canonical,
  Parsing,
  Xml,
  JsonSchema,
  ValidationResult,
  EngineRef,
  Integrations,
  Formats,
  Detection,
  Definitions,
  Mappings,
  Transformations,
  Validation,
  Security,
  Events,
  History,
  Reconciliation,
  Processor,
  Jobs,
  Metrics,
  Configuration,
  Search,
  Foundation,
  Seed,
  Adapters,
};

// Flat, stable SDK surface. Consumers should prefer these named functions so
// the internal module layout can evolve without breaking callers.
export const Exchange = {
  // Formats & adapters
  listFormats: Formats.listFormats,
  getFormat: Formats.getFormat,
  createFormat: Formats.createFormat,
  updateFormat: Formats.updateFormat,
  setFormatStatus: Formats.setFormatStatus,
  deleteFormat: Formats.deleteFormat,
  listFormatVersions: Formats.listFormatVersions,
  createFormatVersion: Formats.createFormatVersion,
  listAdapters: Adapters.listAdapters,
  adapterCatalog: Adapters.adapterCatalog,
  detectFormat: Detection.detectFormat,
  // Definitions
  createDefinition: Definitions.createDefinition,
  getDefinition: Definitions.getDefinition,
  listDefinitions: Definitions.listDefinitions,
  updateDefinition: Definitions.updateDefinition,
  publishDefinition: Definitions.publishDefinition,
  setDefinitionStatus: Definitions.setDefinitionStatus,
  deleteDefinition: Definitions.deleteDefinition,
  resolveDefinition: Definitions.resolveDefinition,
  definitionSummary: Definitions.definitionSummary,
  listDefinitionVersions: Definitions.listDefinitionVersions,
  getDefinitionVersion: Definitions.getDefinitionVersion,
  // Mappings
  createMapping: Mappings.createMapping,
  getMapping: Mappings.getMapping,
  listMappings: Mappings.listMappings,
  updateMapping: Mappings.updateMapping,
  publishMapping: Mappings.publishMapping,
  deleteMapping: Mappings.deleteMapping,
  validateMapping: Mappings.validateMapping,
  applyMappingRecord: Mappings.applyMappingRecord,
  listMappingVersions: Mappings.listMappingVersions,
  // Transformations
  createTransformation: Transformations.createTransformation,
  getTransformation: Transformations.getTransformation,
  listTransformations: Transformations.listTransformations,
  updateTransformation: Transformations.updateTransformation,
  publishTransformation: Transformations.publishTransformation,
  deleteTransformation: Transformations.deleteTransformation,
  validateTransformation: Transformations.validateTransformation,
  applyTransformationProfile: Transformations.applyTransformationProfile,
  listTransformationVersions: Transformations.listTransformationVersions,
  // Validation
  createValidationProfile: Validation.createValidationProfile,
  getValidationProfile: Validation.getValidationProfile,
  listValidationProfiles: Validation.listValidationProfiles,
  updateValidationProfile: Validation.updateValidationProfile,
  addValidationRule: Validation.addValidationRule,
  deleteValidationRule: Validation.deleteValidationRule,
  setValidationProfileStatus: Validation.setValidationProfileStatus,
  deleteValidationProfile: Validation.deleteValidationProfile,
  // Execution
  execute: Processor.execute,
  getTransaction: Processor.getTransaction,
  listTransactions: Processor.listTransactions,
  cancelTransaction: Processor.cancelTransaction,
  transactionSummary: Processor.transactionSummary,
  reconcileTransaction: Reconciliation.reconcileTransaction,
  listReconciliations: Reconciliation.listReconciliations,
  getReconciliation: Reconciliation.getReconciliation,
  // History & errors
  listErrors: History.listErrors,
  errorSummary: History.errorSummary,
  setErrorStatus: History.setErrorStatus,
  listHistory: History.listHistory,
  transactionTimeline: History.transactionTimeline,
  // Jobs
  listExchangeJobs: Jobs.listExchangeJobs,
  getExchangeJob: Jobs.getExchangeJob,
  submitImportJob: Jobs.submitImportJob,
  submitExportJob: Jobs.submitExportJob,
  submitValidateJob: Jobs.submitValidateJob,
  submitReconcileJob: Jobs.submitReconcileJob,
  submitMaintenanceJob: Jobs.submitMaintenanceJob,
  // Metrics
  metrics: Metrics.metricsSnapshot,
  throughput: Metrics.throughput,
  health: Metrics.healthCheck,
  // Configuration
  getConfig: Configuration.getConfig,
  setConfig: Configuration.setConfig,
  listConfig: Configuration.listConfig,
  // Integrations
  listIntegrations: Integrations.listIntegrations,
  registerIntegration: Integrations.registerIntegration,
};

export const ensureExchangeFoundation = Foundation.ensureExchangeFoundation;
export const exchangeHealth = Foundation.exchangeHealth;
export const ensureExchangeSeed = Seed.ensureExchangeSeed;
export const seedExchange = Seed.seedExchange;
export const ensureDefaultExchangeArtifacts = Seed.ensureDefaultExchangeArtifacts;
export const registerExchangeHandlers = Jobs.registerExchangeHandlers;
export const ensureExchangeJobTypes = Jobs.ensureExchangeJobTypes;
export const runExchangeMaintenance = Jobs.runExchangeMaintenance;
export const registerExchangeSources = Search.registerExchangeSources;
export const ensureExchangeSearch = Search.ensureExchangeSearch;
export const ensureExchangeConfig = Configuration.ensureExchangeConfig;
export const registerEnterpriseValidationHandlers = Validation.registerEnterpriseValidationHandlers;

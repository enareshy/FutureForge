// Public facade for the centralized Import & Export Framework.
//
// Business modules depend on this file rather than the internal layout, so the
// implementation can evolve safely. Databases are always passed first so a call
// can participate in the caller's transaction.
import * as constants from "./constants.js";
import * as Validation from "./validation.js";
import * as Errors from "./errors.js";
import * as Refs from "./refs.js";
import * as Repository from "./repository.js";
import * as Configuration from "./configuration.js";
import * as Events from "./events.js";
import * as History from "./history.js";
import * as Security from "./security.js";
import * as ConnectorConfigs from "./connector-configs.js";
import * as ImportDefinitions from "./import-definitions.js";
import * as ExportDefinitions from "./export-definitions.js";
import * as Importer from "./importer.js";
import * as Exporter from "./exporter.js";
import * as Templates from "./templates.js";
import * as Jobs from "./jobs.js";
import * as Metrics from "./metrics.js";
import * as Foundation from "./foundation.js";
import * as Seed from "./seed.js";
import * as Lifecycle from "./lifecycle.js";
import * as Quality from "./quality.js";
import * as Catalog from "./catalog.js";
import * as Search from "./search.js";
import { Connectors } from "./connectors/index.js";
import { Engines } from "./engines/index.js";

export {
  constants,
  Validation,
  Errors,
  Refs,
  Repository,
  Configuration,
  Events,
  History,
  Security,
  ConnectorConfigs,
  ImportDefinitions,
  ExportDefinitions,
  Importer,
  Exporter,
  Templates,
  Jobs,
  Metrics,
  Foundation,
  Seed,
  Lifecycle,
  Quality,
  Catalog,
  Search,
  Connectors,
  Engines,
};

export * as Constants from "./constants.js";

// Flat, stable SDK surface.
export const DataExchange = {
  // Connectors
  connectors: Connectors.list,
  connectorCatalog: Connectors.catalog,
  registerConnector: Connectors.register,
  connectorTypes: Connectors.types,
  // Connector configuration & secrets
  createConnectorConfiguration: ConnectorConfigs.createConnectorConfiguration,
  getConnectorConfiguration: ConnectorConfigs.getConnectorConfiguration,
  listConnectorConfigurations: ConnectorConfigs.listConnectorConfigurations,
  updateConnectorConfiguration: ConnectorConfigs.updateConnectorConfiguration,
  setConnectorConfigurationStatus: ConnectorConfigs.setConnectorConfigurationStatus,
  testConnectorConfiguration: ConnectorConfigs.testConnectorConfiguration,
  discoverConnectorConfigurationSchema: ConnectorConfigs.discoverConnectorConfigurationSchema,
  createCredentialReference: ConnectorConfigs.createCredentialReference,
  listCredentialReferences: ConnectorConfigs.listCredentialReferences,
  // Import definitions
  createImportDefinition: ImportDefinitions.createImportDefinition,
  getImportDefinition: ImportDefinitions.getImportDefinition,
  listImportDefinitions: ImportDefinitions.listImportDefinitions,
  updateImportDefinition: ImportDefinitions.updateImportDefinition,
  setImportDefinitionStatus: ImportDefinitions.setImportDefinitionStatus,
  createImportDefinitionVersion: ImportDefinitions.createImportDefinitionVersion,
  listImportDefinitionVersions: ImportDefinitions.listImportDefinitionVersions,
  validateImportDefinition: ImportDefinitions.validateImportDefinition,
  // Import execution
  previewImport: Importer.previewImport,
  validateImport: Importer.validateImport,
  createImportJob: Importer.createImportJob,
  runImportJob: Importer.runImportJob,
  getImportJob: Importer.getImportJob,
  listImportJobs: Importer.listImportJobs,
  listImportRecordResults: Importer.listImportRecordResults,
  listImportErrors: Importer.listImportErrors,
  cancelImportJob: Importer.cancelImportJob,
  reconcileImport: Importer.reconcileImport,
  reconcileImportJob: Jobs.reconcileImportJob,
  retryImportJob: Jobs.retryImportJob,
  // Export definitions
  createExportDefinition: ExportDefinitions.createExportDefinition,
  getExportDefinition: ExportDefinitions.getExportDefinition,
  listExportDefinitions: ExportDefinitions.listExportDefinitions,
  updateExportDefinition: ExportDefinitions.updateExportDefinition,
  setExportDefinitionStatus: ExportDefinitions.setExportDefinitionStatus,
  createExportDefinitionVersion: ExportDefinitions.createExportDefinitionVersion,
  listExportDefinitionVersions: ExportDefinitions.listExportDefinitionVersions,
  validateExportDefinition: ExportDefinitions.validateExportDefinition,
  // Export execution
  previewExport: Exporter.previewExport,
  createExportJob: Exporter.createExportJob,
  runExportJob: Exporter.runExportJob,
  getExportJob: Exporter.getExportJob,
  listExportJobs: Exporter.listExportJobs,
  listExportResults: Exporter.listExportResults,
  downloadExportResult: Exporter.downloadExportResult,
  cancelExportJob: Exporter.cancelExportJob,
  // Templates
  createTemplate: Templates.createTemplate,
  getTemplate: Templates.getTemplate,
  listTemplates: Templates.listTemplates,
  updateTemplate: Templates.updateTemplate,
  setTemplateStatus: Templates.setTemplateStatus,
  createTemplateVersion: Templates.createTemplateVersion,
  validateTemplate: Templates.validateTemplate,
  // History & configuration
  listHistory: History.listHistory,
  getConfig: Configuration.getConfig,
  setConfig: Configuration.setConfig,
  listConfig: Configuration.listConfig,
  // Jobs
  listExchangeJobs: Jobs.listExchangeJobs,
  getExchangeJob: Jobs.getExchangeJob,
  submitImportJob: Jobs.submitImportJob,
  submitExportJob: Jobs.submitExportJob,
  // Metrics & health
  metrics: Metrics.metricsSnapshot,
  health: Metrics.healthCheck,
  // Integrations
  lifecycleStateOf: Lifecycle.lifecycleStateOf,
  filterExportableRecords: Lifecycle.filterExportableRecords,
  resolveCatalogRefs: Catalog.resolveCatalogRefs,
  evaluateImportedObjects: Quality.evaluateImportedObjects,
};

export const ensureDataExchangeFoundation = Foundation.ensureExchangeFoundation;
export const exchangeHealth = Foundation.exchangeHealth;
export const registerDataExchangeSources = Search.registerDataExchangeSources;
export const ensureDataExchangeSearch = Search.ensureDataExchangeSearch;
export const registerExchangeHandlers = Jobs.registerExchangeHandlers;
export const runExchangeMaintenance = Jobs.runExchangeMaintenance;
export const seedDataExchange = Seed.seedDataExchange;
export const ensureDataExchangeSeed = Seed.ensureDataExchangeSeed;
export const ensureConnectors = Connectors.ensure;

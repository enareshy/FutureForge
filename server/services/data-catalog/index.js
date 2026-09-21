// Public facade for the centralized Data Catalog & Business Glossary
// capability.
//
// Business modules depend on this file (or the platform re-exports) rather than
// the internal layout, so the implementation can evolve safely. The flat SDK
// objects below are the stable surface other modules should code against.
import * as constants from "./constants.js";
import * as Validation from "./validation.js";
import * as Errors from "./errors.js";
import * as Refs from "./refs.js";
import * as Repository from "./repository.js";
import * as Entries from "./entries.js";
import * as Objects from "./objects.js";
import * as Glossary from "./glossary.js";
import * as Sources from "./sources.js";
import * as Consumers from "./consumers.js";
import * as Lineage from "./lineage.js";
import * as Relationships from "./relationships.js";
import * as Classifications from "./classifications.js";
import * as Ownership from "./ownership.js";
import * as Configuration from "./configuration.js";
import * as ImportExport from "./importexport.js";
import * as Events from "./events.js";
import * as Jobs from "./jobs.js";
import * as Search from "./search.js";
import * as Notifications from "./notifications.js";
import * as Metrics from "./metrics.js";
import * as Foundation from "./foundation.js";
import * as Seed from "./seed.js";

export {
  constants,
  Validation,
  Errors,
  Refs,
  Repository,
  Entries,
  Objects,
  Glossary,
  Sources,
  Consumers,
  Lineage,
  Relationships,
  Classifications,
  Ownership,
  Configuration,
  ImportExport,
  Events,
  Jobs,
  Search,
  Notifications,
  Metrics,
  Foundation,
  Seed,
};

export * as Constants from "./constants.js";

// Flat, stable SDK. Databases are always passed first so a call can participate
// in the caller's transaction.
export const DataCatalog = {
  // Unified registry
  registerEntry: Entries.registerEntry,
  getEntry: Entries.getEntry,
  listEntries: Entries.listEntries,
  commitEntryChange: Entries.commitEntryChange,
  metadataVersions: Entries.listMetadataVersions,
  // Objects & attributes
  createObject: Objects.createCatalogObject,
  getObject: Objects.getObject,
  listObjects: Objects.listObjects,
  updateObject: Objects.updateCatalogObject,
  createAttribute: Objects.createAttribute,
  listAttributes: Objects.listAttributes,
  // Glossary
  createTerm: Glossary.createTerm,
  getTerm: Glossary.getTerm,
  listTerms: Glossary.listTerms,
  updateTerm: Glossary.updateTerm,
  submitTerm: Glossary.submitTerm,
  approveTerm: Glossary.approveTerm,
  rejectTerm: Glossary.rejectTerm,
  setTermStatus: Glossary.setTermStatus,
  upsertDefinition: Glossary.upsertDefinition,
  addSynonym: Glossary.addSynonym,
  addTermRelation: Glossary.addRelation,
  mapTerm: Glossary.addMapping,
  termsForTarget: Glossary.termsForTarget,
  glossarySnapshot: Glossary.glossarySnapshot,
  // Sources & consumers
  createSource: Sources.createSource,
  getSource: Sources.getSource,
  listSources: Sources.listSources,
  mapSource: Sources.addSourceMapping,
  createConsumer: Consumers.createConsumer,
  getConsumer: Consumers.getConsumer,
  listConsumers: Consumers.listConsumers,
  mapConsumer: Consumers.addConsumerMapping,
  consumersForObject: Consumers.consumersForObject,
  // Lineage
  createLineage: Lineage.createLineage,
  lineageGraph: Lineage.lineageGraph,
  upstream: Lineage.upstream,
  downstream: Lineage.downstream,
  impact: Lineage.impact,
  // Relationships
  createRelationshipType: Relationships.createRelationshipType,
  createRelationship: Relationships.createRelationship,
  listRelationships: Relationships.listRelationships,
  // Classifications
  createClassification: Classifications.createClassification,
  assignClassification: Classifications.assignClassification,
  classificationsForEntry: Classifications.classificationsForEntry,
  // Ownership
  assignOwnership: Ownership.assignOwnership,
  resolveOwnership: Ownership.resolveOwnership,
  ownershipGaps: Ownership.ownershipGaps,
  // Configuration
  getConfig: Configuration.getConfig,
  setConfig: Configuration.setConfig,
  // Import/export
  importCatalog: ImportExport.importCatalog,
  exportCatalog: ImportExport.exportCatalog,
  // Metrics
  metrics: Metrics.metricsSnapshot,
  health: Metrics.healthCheck,
};

export const ensureDataCatalogFoundation = Foundation.ensureCatalogFoundation;
export const registerCatalogHandlers = Jobs.registerCatalogHandlers;
export const runCatalogMaintenance = Jobs.runCatalogMaintenance;
export const registerCatalogSources = Search.registerCatalogSources;
export const seedDataCatalog = Seed.seedDataCatalog;
export const ensureDataCatalogSeed = Seed.ensureDataCatalogSeed;

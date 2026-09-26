// Public facade for the P1 Digital Thread.
//
// Every consumer (API layer, jobs, search, reporting, other modules) depends on
// this file rather than the internal layout so the implementation can evolve
// safely. Databases are always passed first so a call can participate in the
// caller's transaction.
import * as Constants from "./constants.js";
import * as Validation from "./validation.js";
import * as Errors from "./errors.js";
import * as Refs from "./refs.js";
import * as Identifiers from "./identifiers.js";
import * as Repository from "./repository.js";
import * as Cache from "./cache.js";
import * as Configuration from "./configuration.js";
import * as Events from "./events.js";
import * as History from "./history.js";
import * as Security from "./security.js";
import * as Domains from "./domains.js";
import * as Providers from "./providers.js";
import * as ProviderObject from "./provider-object.js";
import * as ProviderPdm from "./provider-pdm.js";
import * as ProviderBom from "./provider-bom.js";
import * as ProviderBuiltins from "./provider-builtins.js";
import * as Definitions from "./definitions.js";
import * as Rules from "./rules.js";
import * as Traversal from "./traversal.js";
import * as Engine from "./engine.js";
import * as Traceability from "./traceability.js";
import * as Impact from "./impact.js";
import * as Dependency from "./dependency.js";
import * as Paths from "./paths.js";
import * as Completeness from "./completeness.js";
import * as Snapshots from "./snapshots.js";
import * as Baselines from "./baselines.js";
import * as Compare from "./compare.js";
import * as Projection from "./projection.js";
import * as Search from "./search.js";
import * as Jobs from "./jobs.js";
import * as Metrics from "./metrics.js";
import * as Foundation from "./foundation.js";
import * as Seed from "./seed.js";

export {
  Constants,
  Validation,
  Errors,
  Refs,
  Identifiers,
  Repository,
  Cache,
  Configuration,
  Events,
  History,
  Security,
  Domains,
  Providers,
  ProviderObject,
  ProviderPdm,
  ProviderBom,
  ProviderBuiltins,
  Definitions,
  Rules,
  Traversal,
  Engine,
  Traceability,
  Impact,
  Dependency,
  Paths,
  Completeness,
  Snapshots,
  Baselines,
  Compare,
  Projection,
  Search,
  Jobs,
  Metrics,
  Foundation,
  Seed,
};

// Flat, stable SDK surface.
export const Thread = {
  // Traversal & explorer
  traverse: Traversal.traverseThread,
  executeTraversal: Engine.executeTraversal,
  publicGraph: Engine.publicGraph,
  // Traceability
  traceabilityGraph: Traceability.traceabilityGraph,
  traceabilityMatrix: Traceability.traceabilityMatrix,
  buildMatrix: Traceability.buildMatrix,
  // Impact, dependency & paths
  impactAnalysis: Impact.impactAnalysis,
  directImpact: Impact.directImpact,
  dependencyAnalysis: Dependency.dependencyAnalysis,
  directDependencyAnalysis: Dependency.directDependencyAnalysis,
  findPaths: Paths.findPaths,
  // Completeness
  evaluateCompleteness: Completeness.evaluateCompleteness,
  // Definitions
  createDefinition: Definitions.createDefinition,
  getDefinition: Definitions.getDefinition,
  listDefinitions: Definitions.listDefinitions,
  updateDefinition: Definitions.updateDefinition,
  setDefinitionStatus: Definitions.setDefinitionStatus,
  deleteDefinition: Definitions.deleteDefinition,
  resolveDefinition: Definitions.resolveDefinition,
  definitionSummary: Definitions.definitionSummary,
  builtinRelationships: Definitions.builtinRelationships,
  relationshipTypesForDefinition: Definitions.relationshipTypesForDefinition,
  // Rules
  createRule: Rules.createRule,
  getRule: Rules.getRule,
  listRules: Rules.listRules,
  updateRule: Rules.updateRule,
  setRuleStatus: Rules.setRuleStatus,
  deleteRule: Rules.deleteRule,
  activeRules: Rules.activeRules,
  ruleSummary: Rules.ruleSummary,
  // Domains & providers
  builtinDomains: Domains.builtinDomains,
  domainCatalog: Domains.domainCatalog,
  domainForType: Domains.domainForType,
  registerProvider: Providers.registerProvider,
  listProviders: Providers.listProviders,
  resetProviders: Providers.resetProviders,
  // Snapshots
  createSnapshot: Snapshots.createSnapshot,
  getSnapshot: Snapshots.getSnapshot,
  listSnapshots: Snapshots.listSnapshots,
  snapshotGraph: Snapshots.snapshotGraph,
  setSnapshotStatus: Snapshots.setSnapshotStatus,
  deleteSnapshot: Snapshots.deleteSnapshot,
  snapshotSummary: Snapshots.snapshotSummary,
  // Baselines
  createBaseline: Baselines.createBaseline,
  getBaseline: Baselines.getBaseline,
  listBaselines: Baselines.listBaselines,
  updateBaseline: Baselines.updateBaseline,
  releaseBaseline: Baselines.releaseBaseline,
  freezeBaseline: Baselines.freezeBaseline,
  deleteBaseline: Baselines.deleteBaseline,
  listBaselineMembers: Baselines.baselineMembers,
  baselineSummary: Baselines.baselineSummary,
  // Compare
  compareProjections: Compare.compareProjections,
  compareSnapshots: Compare.compareSnapshots,
  compareBaselines: Compare.compareBaselines,
  // Projection
  getProjection: Projection.getProjection,
  listProjections: Projection.listProjections,
  projectionState: Projection.projectionState,
  projectionHealth: Projection.projectionHealth,
  projectObject: Projection.projectObject,
  handleSourceEvent: Projection.handleSourceEvent,
  rebuildProjection: Projection.rebuildProjection,
  // Configuration
  getConfig: Configuration.getConfig,
  setConfig: Configuration.setConfig,
  listConfig: Configuration.listConfig,
  // History & audit
  listHistory: History.listHistory,
  listQueryHistory: History.listQueryHistory,
  objectLineage: History.objectLineage,
  // Search
  registerSearchSources: Search.registerThreadSources,
  ensureSearch: Search.ensureThreadSearch,
  // Jobs
  submitTraversalJob: Jobs.submitTraversalJob,
  submitImpactJob: Jobs.submitImpactJob,
  submitPathJob: Jobs.submitPathJob,
  submitSnapshotJob: Jobs.submitSnapshotJob,
  submitBaselineJob: Jobs.submitBaselineJob,
  submitCompletenessJob: Jobs.submitCompletenessJob,
  submitReindexJob: Jobs.submitReindexJob,
  submitProjectionRebuildJob: Jobs.submitProjectionRebuildJob,
  submitMaintenanceJob: Jobs.submitMaintenanceJob,
  runMaintenance: Jobs.runThreadMaintenance,
  // Metrics
  metrics: Metrics.metricsSnapshot,
  health: Metrics.healthCheck,
  activity: Metrics.activitySummary,
};

export const ensureThreadFoundation = Foundation.ensureThreadFoundation;
export const threadHealth = Foundation.threadHealth;
export const registerThreadHandlers = Jobs.registerThreadHandlers;
export const ensureThreadJobTypes = Jobs.ensureThreadJobTypes;
export const runThreadMaintenance = Jobs.runThreadMaintenance;
export const registerThreadSources = Search.registerThreadSources;
export const ensureThreadSearch = Search.ensureThreadSearch;
export const ensureThreadConfig = Configuration.ensureThreadConfig;
export const ensureDefaultDefinitions = Definitions.ensureDefaultDefinitions;
export const ensureDefaultRules = Rules.ensureDefaultRules;
export const registerBuiltinProviders = ProviderBuiltins.registerBuiltinProviders;
export const seedThread = Seed.seedThread;
export const ensureThreadSeed = Seed.ensureThreadSeed;

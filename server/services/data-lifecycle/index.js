// Public facade for the centralized Data Lifecycle & Archival capability.
//
// Business modules depend on this file (or the platform re-exports) rather than
// the internal layout, so the implementation can evolve safely. The flat SDK
// objects below are the stable surface other modules should code against.
import * as constants from "./constants.js";
import * as Validation from "./validation.js";
import * as Errors from "./errors.js";
import * as Refs from "./refs.js";
import * as Repository from "./repository.js";
import * as States from "./states.js";
import * as Tiers from "./tiers.js";
import * as Policies from "./policies.js";
import * as Objects from "./objects.js";
import * as History from "./history.js";
import * as LegalHolds from "./legal-holds.js";
import * as Dependencies from "./dependencies.js";
import * as Eligibility from "./eligibility.js";
import * as Providers from "./providers.js";
import * as Archive from "./archive.js";
import * as Restore from "./restore.js";
import * as Recovery from "./recovery.js";
import * as Purge from "./purge.js";
import * as Configuration from "./configuration.js";
import * as QualityGate from "./quality-gate.js";
import * as CatalogIntegration from "./catalog.js";
import * as Events from "./events.js";
import * as Notifications from "./notifications.js";
import * as Search from "./search.js";
import * as Metrics from "./metrics.js";
import * as Jobs from "./jobs.js";
import * as Foundation from "./foundation.js";
import * as Seed from "./seed.js";

export {
  constants,
  Validation,
  Errors,
  Refs,
  Repository,
  States,
  Tiers,
  Policies,
  Objects,
  History,
  LegalHolds,
  Dependencies,
  Eligibility,
  Providers,
  Archive,
  Restore,
  Recovery,
  Purge,
  Configuration,
  QualityGate,
  CatalogIntegration,
  Events,
  Notifications,
  Search,
  Metrics,
  Jobs,
  Foundation,
  Seed,
};

export * as Constants from "./constants.js";

// Flat, stable SDK. Databases are always passed first so a call can participate
// in the caller's transaction.
export const DataLifecycle = {
  // States & transitions
  listStates: States.listStates,
  getStateRow: States.getStateRow,
  createState: States.createState,
  updateState: States.updateState,
  listTransitions: States.listTransitions,
  createTransition: States.createTransition,
  setTransitionStatus: States.setTransitionStatus,
  allowedTransitions: States.allowedTransitions,
  assertTransition: States.assertTransition,
  stateCapabilities: Objects.stateCapabilities,
  // Tiers
  listTierPolicies: Tiers.listTierPolicies,
  setTierPolicy: Tiers.setTierPolicy,
  resolveTier: Tiers.resolveTier,
  // Policies
  createPolicy: Policies.createPolicy,
  getPolicy: Policies.getPolicy,
  listPolicies: Policies.listPolicies,
  updatePolicy: Policies.updatePolicy,
  setPolicyStatus: Policies.setPolicyStatus,
  listPolicyVersions: Policies.listPolicyVersions,
  resolvePolicy: Policies.resolvePolicy,
  computeRetentionSchedule: Policies.computeRetentionSchedule,
  // Objects (lifecycle ledger)
  registerObject: Objects.registerObjectLifecycle,
  getObject: Objects.getObjectLifecycle,
  listObjects: Objects.listObjectLifecycles,
  changeObjectState: Objects.changeState,
  applyRetention: Objects.applyRetention,
  setObjectTier: Objects.setObjectTier,
  // Eligibility
  evaluateEligibility: Eligibility.evaluateEligibility,
  evaluateBatch: Eligibility.evaluateBatch,
  evaluatePurge: Eligibility.evaluatePurge,
  listDueObjects: Eligibility.listDueObjects,
  // Legal holds
  createLegalHold: LegalHolds.createLegalHold,
  getLegalHold: LegalHolds.getLegalHold,
  listLegalHolds: LegalHolds.listLegalHolds,
  releaseLegalHold: LegalHolds.releaseLegalHold,
  cancelLegalHold: LegalHolds.cancelLegalHold,
  activeHoldsForObject: LegalHolds.activeHoldsForObject,
  expireLegalHolds: LegalHolds.expireLegalHolds,
  // Dependencies
  listDependencies: Dependencies.listDependencies,
  recordDependency: Dependencies.recordDependency,
  resolveDependency: Dependencies.resolveDependency,
  refreshDependencies: Dependencies.refreshDependencies,
  evaluateDependencies: Dependencies.evaluateDependencies,
  // Archive & cold storage
  archiveObject: Archive.archiveObject,
  verifyArchiveIntegrity: Archive.verifyArchiveIntegrity,
  moveToColdStorage: Archive.moveToColdStorage,
  getArchiveRecord: Archive.getArchiveRecord,
  listArchiveRecords: Archive.listArchiveRecords,
  buildArchivePayload: Archive.buildArchivePayload,
  archiveSummary: Archive.archiveSummary,
  // Restore
  requestRestore: Restore.requestRestore,
  executeRestore: Restore.executeRestore,
  restoreObject: Restore.restoreObject,
  getRestoreRecord: Restore.getRestoreRecord,
  listRestoreRecords: Restore.listRestoreRecords,
  // Recovery
  requestRecovery: Recovery.requestRecovery,
  executeRecovery: Recovery.executeRecovery,
  recoverObject: Recovery.recoverObject,
  getRecoveryRecord: Recovery.getRecoveryRecord,
  listRecoveryRecords: Recovery.listRecoveryRecords,
  // Purge
  evaluatePurgeEligibility: Purge.evaluatePurgeEligibility,
  executePurge: Purge.executePurge,
  getPurgeRecord: Purge.getPurgeRecord,
  listPurgeRecords: Purge.listPurgeRecords,
  purgeSummary: Purge.purgeSummary,
  // History
  listHistory: History.listHistory,
  recordHistory: History.recordHistory,
  // Configuration
  getConfig: Configuration.getConfig,
  setConfig: Configuration.setConfig,
  listConfig: Configuration.listConfig,
  // Catalog & quality integrations
  lifecycleSnapshot: CatalogIntegration.lifecycleSnapshot,
  bulkLifecycleSnapshots: CatalogIntegration.bulkLifecycleSnapshots,
  lifecycleAwareTypes: CatalogIntegration.lifecycleAwareTypes,
  qualityGate: QualityGate.qualityGate,
  // Providers
  listArchiveProviders: Providers.listArchiveProviders,
  // Jobs
  listLifecycleJobs: Jobs.listLifecycleJobs,
  getLifecycleJob: Jobs.getLifecycleJob,
  // Metrics
  metrics: Metrics.metricsSnapshot,
  health: Metrics.healthCheck,
};

export const ensureDataLifecycleFoundation = Foundation.ensureLifecycleFoundation;
export const registerLifecycleHandlers = Jobs.registerLifecycleHandlers;
export const runLifecycleMaintenance = Jobs.runLifecycleMaintenance;
export const registerLifecycleSources = Search.registerLifecycleSources;
export const seedDataLifecycle = Seed.seedDataLifecycle;
export const ensureDataLifecycleSeed = Seed.ensureDataLifecycleSeed;

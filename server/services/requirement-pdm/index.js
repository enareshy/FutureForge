// Public facade for the Requirement -> PDM integration.
//
// Every consumer (API layer, jobs, Digital Thread provider, other domains)
// depends on this file rather than the internal layout so the implementation can
// evolve safely. Databases are always passed first so a call can participate in
// the caller's transaction (mirrors requirements/index.js).
import * as Constants from "./constants.js";
import * as Errors from "./errors.js";
import * as Refs from "./refs.js";
import * as Validation from "./validation.js";
import * as Configuration from "./configuration.js";
import * as Events from "./events.js";
import * as Security from "./security.js";
import * as Foundation from "./foundation.js";
import * as Targets from "./targets.js";
import * as Allocations from "./allocations.js";
import * as Compatibility from "./compatibility.js";
import * as Mirror from "./mirror.js";
import * as Provider from "./provider.js";
import * as Synchronization from "./synchronization.js";
import * as Jobs from "./jobs.js";
import * as Integration from "./integration.js";
import * as Subscriptions from "./subscriptions.js";

export {
  Constants,
  Errors,
  Refs,
  Validation,
  Configuration,
  Events,
  Security,
  Foundation,
  Targets,
  Allocations,
  Compatibility,
  Mirror,
  Provider,
  Synchronization,
  Jobs,
  Integration,
  Subscriptions,
};

export {
  SOURCE_MODULE,
  ALLOCATION_TYPES,
  ALLOCATION_CODES,
  TARGET_NODE_TYPES,
  PDM_NODE_TYPES,
  REQUIREMENT_PDM_RESOURCES,
  REQUIREMENT_PDM_EVENT_TYPES,
  COVERAGE_STATUSES,
  COMPATIBILITY_STATUSES,
  SYNC_STATUSES,
  REQUIREMENT_PDM_JOB_TYPES,
  REQUIREMENT_PDM_HANDLER_CODES,
  REQUIREMENT_PDM_INTEGRATION,
  CONFIG_KEYS,
  CONFIG_DEFAULTS,
  CONFIG_BOUNDS,
} from "./constants.js";

export { RequirementPdmError } from "./errors.js";
export { REQUIREMENT_PDM_ERROR_CODES } from "./errors.js";

export const ensureRequirementPdmFoundation = Foundation.ensureRequirementPdmFoundation;
export const ensureRequirementPdmFoundationAsync = Foundation.ensureRequirementPdmFoundationAsync;
export const requirementPdmHealth = Foundation.requirementPdmHealth;
export const requirementPdmHealthAsync = Foundation.requirementPdmHealthAsync;
export const requirementPdmMeta = Foundation.requirementPdmMeta;

export const getConfig = Configuration.getConfig;
export const listConfig = Configuration.listConfig;
export const describeConfig = Configuration.describeConfig;
export const setConfig = Configuration.setConfig;
export const configCatalog = Configuration.configCatalog;

export const publishRequirementPdmEvent = Events.publishRequirementPdmEvent;
export const publishRequirementPdmEventAsync = Events.publishRequirementPdmEventAsync;

export const authorizeRequirementPdmAction = Security.authorizeRequirementPdmAction;
export const authorizeRequirementPdmActionAsync = Security.authorizeRequirementPdmActionAsync;
export const requireRequirementPdmAction = Security.requireRequirementPdmAction;
export const requireRequirementPdmActionAsync = Security.requireRequirementPdmActionAsync;
export const buildRequirementPdmContext = Security.buildRequirementPdmContext;
export const buildRequirementPdmContextAsync = Security.buildRequirementPdmContextAsync;

export const resolveTarget = Targets.resolveTarget;
export const resolveTargetAsync = Targets.resolveTargetAsync;
export const requireTarget = Targets.requireTarget;
export const requireTargetAsync = Targets.requireTargetAsync;

export const createAllocation = Allocations.createAllocation;
export const createAllocationAsync = Allocations.createAllocationAsync;
export const getAllocation = Allocations.getAllocation;
export const getAllocationAsync = Allocations.getAllocationAsync;
export const listAllocations = Allocations.listAllocations;
export const listAllocationsAsync = Allocations.listAllocationsAsync;
export const removeAllocation = Allocations.removeAllocation;
export const removeAllocationAsync = Allocations.removeAllocationAsync;
export const listRequirementAllocations = Allocations.listRequirementAllocations;
export const listRequirementAllocationsAsync = Allocations.listRequirementAllocationsAsync;
export const allocationCoverage = Allocations.allocationCoverage;
export const allocationCoverageAsync = Allocations.allocationCoverageAsync;

export const evaluateAllocation = Compatibility.evaluateAllocation;
export const evaluateAllocationAsync = Compatibility.evaluateAllocationAsync;
export const checkAllocation = Compatibility.checkAllocation;
export const checkAllocationAsync = Compatibility.checkAllocationAsync;
export const checkRequirementCompatibilities = Compatibility.checkRequirementCompatibilities;
export const checkRequirementCompatibilitiesAsync = Compatibility.checkRequirementCompatibilitiesAsync;

export const ensureRequirementObject = Mirror.ensureRequirementObject;
export const ensureRequirementObjectAsync = Mirror.ensureRequirementObjectAsync;
export const backfillRequirementObjects = Mirror.backfillRequirementObjects;
export const backfillRequirementObjectsAsync = Mirror.backfillRequirementObjectsAsync;
export const requirementObjectId = Mirror.requirementObjectId;
export const requirementObjectIdAsync = Mirror.requirementObjectIdAsync;

export const registerRequirementPdmProvider = Provider.registerRequirementPdmProvider;

export const synchronize = Synchronization.synchronize;
export const synchronizeAsync = Synchronization.synchronizeAsync;
export const synchronizeAllocation = Synchronization.synchronizeAllocation;
export const synchronizeAllocationAsync = Synchronization.synchronizeAllocationAsync;
export const impactedAllocations = Synchronization.impactedAllocations;
export const impactedAllocationsAsync = Synchronization.impactedAllocationsAsync;
export const impactedRequirements = Synchronization.impactedRequirements;
export const impactedRequirementsAsync = Synchronization.impactedRequirementsAsync;

export const ensureRequirementPdmJobTypes = Jobs.ensureRequirementPdmJobTypes;
export const ensureRequirementPdmJobTypesAsync = Jobs.ensureRequirementPdmJobTypesAsync;
export const registerRequirementPdmHandlers = Jobs.registerRequirementPdmHandlers;
export const submitSynchronization = Jobs.submitSynchronization;
export const submitSynchronizationAsync = Jobs.submitSynchronizationAsync;
export const submitImpactSweep = Jobs.submitImpactSweep;
export const submitImpactSweepAsync = Jobs.submitImpactSweepAsync;

export const registerRequirementPdmIntegrationHandlers = Integration.registerRequirementPdmIntegrationHandlers;
export const enqueueSynchronization = Integration.enqueueSynchronization;
export const enqueueSynchronizationAsync = Integration.enqueueSynchronizationAsync;
export const recordSynchronizationFailure = Integration.recordSynchronizationFailure;
export const recordSynchronizationFailureAsync = Integration.recordSynchronizationFailureAsync;
export const integrationSummary = Integration.integrationSummary;
export const integrationSummaryAsync = Integration.integrationSummaryAsync;

export const registerRequirementPdmEventHandler = Subscriptions.registerRequirementPdmEventHandler;
export const ensureRequirementPdmSubscriptions = Subscriptions.ensureRequirementPdmSubscriptions;
export const ensureRequirementPdmSubscriptionsAsync = Subscriptions.ensureRequirementPdmSubscriptionsAsync;

export { createRequirementPdmRouter } from "./router-requirement-pdm.js";

// Flat, stable SDK surface.
export const RequirementPdm = {
  health: Foundation.requirementPdmHealth,
  meta: Foundation.requirementPdmMeta,
  getConfig: Configuration.getConfig,
  listConfig: Configuration.listConfig,
  setConfig: Configuration.setConfig,
  publishEvent: Events.publishRequirementPdmEvent,
  resolveTarget: Targets.resolveTarget,
  createAllocation: Allocations.createAllocation,
  getAllocation: Allocations.getAllocation,
  listAllocations: Allocations.listAllocations,
  removeAllocation: Allocations.removeAllocation,
  listRequirementAllocations: Allocations.listRequirementAllocations,
  allocationCoverage: Allocations.allocationCoverage,
  evaluateAllocation: Compatibility.evaluateAllocation,
  checkAllocation: Compatibility.checkAllocation,
  checkRequirementCompatibilities: Compatibility.checkRequirementCompatibilities,
  synchronize: Synchronization.synchronize,
  impactedRequirements: Synchronization.impactedRequirements,
  integrationSummary: Integration.integrationSummary,
};

export const RequirementPdmAsync = {
  health: Foundation.requirementPdmHealthAsync,
  meta: Foundation.requirementPdmMeta,
  resolveTarget: Targets.resolveTargetAsync,
  createAllocation: Allocations.createAllocationAsync,
  getAllocation: Allocations.getAllocationAsync,
  listAllocations: Allocations.listAllocationsAsync,
  removeAllocation: Allocations.removeAllocationAsync,
  listRequirementAllocations: Allocations.listRequirementAllocationsAsync,
  allocationCoverage: Allocations.allocationCoverageAsync,
  evaluateAllocation: Compatibility.evaluateAllocationAsync,
  checkAllocation: Compatibility.checkAllocationAsync,
  checkRequirementCompatibilities: Compatibility.checkRequirementCompatibilitiesAsync,
  synchronize: Synchronization.synchronizeAsync,
  impactedRequirements: Synchronization.impactedRequirementsAsync,
  integrationSummary: Integration.integrationSummaryAsync,
};

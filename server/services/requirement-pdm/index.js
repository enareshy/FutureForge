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
import * as Changes from "./changes.js";
import * as ChangeInitiation from "./change-initiation.js";
import * as Products from "./products.js";
import * as BomProjection from "./bom-projection.js";
import * as Documents from "./documents.js";
import * as Compatibility from "./compatibility.js";
import * as Mirror from "./mirror.js";
import * as Provider from "./provider.js";
import * as Impact from "./impact.js";
import * as PlmSync from "./plm-sync.js";
import * as PlmNotifications from "./plm-notifications.js";
import * as PlmMetrics from "./plm-metrics.js";
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
  Changes,
  ChangeInitiation,
  Products,
  BomProjection,
  Documents,
  Compatibility,
  Mirror,
  Provider,
  Impact,
  PlmSync,
  PlmNotifications,
  PlmMetrics,
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
  CHANGE_NODE_TYPES,
  CHANGE_NODE_CODES,
  PLM_NODE_TYPES,
  PLM_LINK_TYPES,
  PLM_LINK_CODES,
  IMPACT_CATEGORIES,
  CHANGE_INITIATION_STATUSES,
  CHANGE_SEVERITIES,
  PRIORITY_TO_SEVERITY,
  CRITICALITY_TO_SEVERITY,
  CHANGE_INITIATION_RULES,
  PLM_SYNC_DIRECTIONS,
  PLM_DOCUMENT_CATEGORIES,
  INTEGRATION_STATUSES,
  PLM_NOTIFICATION_RULES,
  PRODUCT_ITEM_TYPE,
  REALIZATION_STAGES,
  LIFECYCLE_CATEGORY_TO_STAGE,
  PDM_STATUS_CATEGORY,
  REQUIREMENT_PDM_RESOURCES,
  REQUIREMENT_PDM_EVENT_TYPES,
  REQUIREMENT_PLM_EVENT_SUBSCRIPTIONS,
  REQUIREMENT_PLM_CHANGE_SUBSCRIPTIONS,
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

export const linkChange = Changes.linkChange;
export const linkChangeAsync = Changes.linkChangeAsync;
export const unlinkChange = Changes.unlinkChange;
export const unlinkChangeAsync = Changes.unlinkChangeAsync;
export const listRequirementChanges = Changes.listRequirementChanges;
export const listRequirementChangesAsync = Changes.listRequirementChangesAsync;
export const listChangeRequirements = Changes.listChangeRequirements;
export const listChangeRequirementsAsync = Changes.listChangeRequirementsAsync;
export const resolveChange = Changes.resolveChange;
export const resolveChangeAsync = Changes.resolveChangeAsync;

export const severityFor = ChangeInitiation.severityFor;
export const changeInitiationConfig = ChangeInitiation.changeInitiationConfig;
export const evaluateChangeInitiation = ChangeInitiation.evaluateChangeInitiation;
export const evaluateRequirementChangeInitiation = ChangeInitiation.evaluateRequirementChangeInitiation;
export const evaluateRequirementChangeInitiationAsync = ChangeInitiation.evaluateRequirementChangeInitiationAsync;
export const initiateChangeRequest = ChangeInitiation.initiateChangeRequest;
export const initiateChangeRequestAsync = ChangeInitiation.initiateChangeRequestAsync;
export const requirementChangeChain = ChangeInitiation.requirementChangeChain;
export const requirementChangeChainAsync = ChangeInitiation.requirementChangeChainAsync;

export const analyzeRequirementImpact = Impact.analyzeRequirementImpact;
export const analyzeRequirementImpactAsync = Impact.analyzeRequirementImpactAsync;

export const resolvePlmNodeTargets = PlmSync.resolvePlmNodeTargets;
export const resolvePlmNodeTargetsAsync = PlmSync.resolvePlmNodeTargetsAsync;
export const requirementsForPlmNode = PlmSync.requirementsForPlmNode;
export const requirementsForPlmNodeAsync = PlmSync.requirementsForPlmNodeAsync;
export const synchronizeFromPlm = PlmSync.synchronizeFromPlm;
export const synchronizeFromPlmAsync = PlmSync.synchronizeFromPlmAsync;

export const ensurePlmNotificationRules = PlmNotifications.ensurePlmNotificationRules;
export const ensurePlmNotificationRulesAsync = PlmNotifications.ensurePlmNotificationRulesAsync;
export const notifyRequirementOwners = PlmNotifications.notifyRequirementOwners;
export const notifyRequirementOwnersAsync = PlmNotifications.notifyRequirementOwnersAsync;

export const plmMetrics = PlmMetrics.plmMetrics;
export const plmMetricsAsync = PlmMetrics.plmMetricsAsync;

export const listRequirementProducts = Products.listRequirementProducts;
export const listRequirementProductsAsync = Products.listRequirementProductsAsync;
export const listProductRequirements = Products.listProductRequirements;
export const listProductRequirementsAsync = Products.listProductRequirementsAsync;
export const productLifecycle = Products.productLifecycle;
export const productLifecycleAsync = Products.productLifecycleAsync;

export const listRequirementStructures = BomProjection.listRequirementStructures;
export const listRequirementStructuresAsync = BomProjection.listRequirementStructuresAsync;
export const structureCoverage = BomProjection.structureCoverage;
export const structureCoverageAsync = BomProjection.structureCoverageAsync;
export const bomRevisionStructure = BomProjection.bomRevisionStructure;
export const bomRevisionStructureAsync = BomProjection.bomRevisionStructureAsync;
export const listStructureRequirements = BomProjection.listStructureRequirements;
export const listStructureRequirementsAsync = BomProjection.listStructureRequirementsAsync;

export const requirementDocuments = Documents.requirementDocuments;
export const requirementDocumentsAsync = Documents.requirementDocumentsAsync;
export const documentCategoryFor = Documents.documentCategoryFor;

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
export const submitImpactAnalysis = Jobs.submitImpactAnalysis;
export const submitImpactAnalysisAsync = Jobs.submitImpactAnalysisAsync;
export const submitChangeInitiation = Jobs.submitChangeInitiation;
export const submitChangeInitiationAsync = Jobs.submitChangeInitiationAsync;
export const submitPlmSynchronization = Jobs.submitPlmSynchronization;
export const submitPlmSynchronizationAsync = Jobs.submitPlmSynchronizationAsync;

export const registerRequirementPdmIntegrationHandlers = Integration.registerRequirementPdmIntegrationHandlers;
export const enqueueSynchronization = Integration.enqueueSynchronization;
export const enqueueSynchronizationAsync = Integration.enqueueSynchronizationAsync;
export const enqueueChangeInitiation = Integration.enqueueChangeInitiation;
export const enqueueChangeInitiationAsync = Integration.enqueueChangeInitiationAsync;
export const enqueuePlmSynchronization = Integration.enqueuePlmSynchronization;
export const enqueuePlmSynchronizationAsync = Integration.enqueuePlmSynchronizationAsync;
export const recordSynchronizationFailure = Integration.recordSynchronizationFailure;
export const recordSynchronizationFailureAsync = Integration.recordSynchronizationFailureAsync;
export const integrationSummary = Integration.integrationSummary;
export const integrationSummaryAsync = Integration.integrationSummaryAsync;

export const registerRequirementPdmEventHandler = Subscriptions.registerRequirementPdmEventHandler;
export const ensureRequirementPdmSubscriptions = Subscriptions.ensureRequirementPdmSubscriptions;
export const ensureRequirementPdmSubscriptionsAsync = Subscriptions.ensureRequirementPdmSubscriptionsAsync;
export const registerRequirementPdmPlmSyncHandler = Subscriptions.registerRequirementPdmPlmSyncHandler;
export const ensureRequirementPdmPlmSubscriptions = Subscriptions.ensureRequirementPdmPlmSubscriptions;
export const ensureRequirementPdmPlmSubscriptionsAsync = Subscriptions.ensureRequirementPdmPlmSubscriptionsAsync;
export const registerRequirementPdmChangeEventHandler = Subscriptions.registerRequirementPdmChangeEventHandler;
export const ensureRequirementPdmChangeSubscriptions = Subscriptions.ensureRequirementPdmChangeSubscriptions;
export const ensureRequirementPdmChangeSubscriptionsAsync = Subscriptions.ensureRequirementPdmChangeSubscriptionsAsync;

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
  listRequirementProducts: Products.listRequirementProducts,
  listProductRequirements: Products.listProductRequirements,
  productLifecycle: Products.productLifecycle,
  listRequirementStructures: BomProjection.listRequirementStructures,
  structureCoverage: BomProjection.structureCoverage,
  bomRevisionStructure: BomProjection.bomRevisionStructure,
  listStructureRequirements: BomProjection.listStructureRequirements,
  requirementDocuments: Documents.requirementDocuments,
  linkChange: Changes.linkChange,
  listRequirementChanges: Changes.listRequirementChanges,
  listChangeRequirements: Changes.listChangeRequirements,
  evaluateChangeInitiation: ChangeInitiation.evaluateRequirementChangeInitiation,
  initiateChangeRequest: ChangeInitiation.initiateChangeRequest,
  requirementChangeChain: ChangeInitiation.requirementChangeChain,
  evaluateAllocation: Compatibility.evaluateAllocation,
  checkAllocation: Compatibility.checkAllocation,
  checkRequirementCompatibilities: Compatibility.checkRequirementCompatibilities,
  synchronize: Synchronization.synchronize,
  impactedRequirements: Synchronization.impactedRequirements,
  impactAnalysis: Impact.analyzeRequirementImpact,
  requirementsForPlmNode: PlmSync.requirementsForPlmNode,
  synchronizeFromPlm: PlmSync.synchronizeFromPlm,
  plmMetrics: PlmMetrics.plmMetrics,
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
  listRequirementProducts: Products.listRequirementProductsAsync,
  listProductRequirements: Products.listProductRequirementsAsync,
  productLifecycle: Products.productLifecycleAsync,
  listRequirementStructures: BomProjection.listRequirementStructuresAsync,
  structureCoverage: BomProjection.structureCoverageAsync,
  bomRevisionStructure: BomProjection.bomRevisionStructureAsync,
  listStructureRequirements: BomProjection.listStructureRequirementsAsync,
  requirementDocuments: Documents.requirementDocumentsAsync,
  linkChange: Changes.linkChangeAsync,
  listRequirementChanges: Changes.listRequirementChangesAsync,
  listChangeRequirements: Changes.listChangeRequirementsAsync,
  evaluateChangeInitiation: ChangeInitiation.evaluateRequirementChangeInitiationAsync,
  initiateChangeRequest: ChangeInitiation.initiateChangeRequestAsync,
  requirementChangeChain: ChangeInitiation.requirementChangeChainAsync,
  evaluateAllocation: Compatibility.evaluateAllocationAsync,
  checkAllocation: Compatibility.checkAllocationAsync,
  checkRequirementCompatibilities: Compatibility.checkRequirementCompatibilitiesAsync,
  synchronize: Synchronization.synchronizeAsync,
  impactedRequirements: Synchronization.impactedRequirementsAsync,
  impactAnalysis: Impact.analyzeRequirementImpactAsync,
  requirementsForPlmNode: PlmSync.requirementsForPlmNodeAsync,
  synchronizeFromPlm: PlmSync.synchronizeFromPlmAsync,
  plmMetrics: PlmMetrics.plmMetricsAsync,
  integrationSummary: Integration.integrationSummaryAsync,
};

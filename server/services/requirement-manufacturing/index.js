// Public facade for the Requirement -> Manufacturing traceability layer.
//
// Every consumer (API layer, jobs, Digital Thread projections, other domains)
// depends on this file rather than the internal layout so the implementation can
// evolve safely. Databases are always passed first so a call can participate in
// the caller's transaction (mirrors requirement-pdm/index.js).
import * as Constants from "./constants.js";
import * as Errors from "./errors.js";
import * as Configuration from "./configuration.js";
import * as Events from "./events.js";
import * as Security from "./security.js";
import * as Foundation from "./foundation.js";
import * as Provider from "./provider.js";
import * as ManufacturingObjects from "./manufacturing-objects.js";
import * as Characteristics from "./characteristics.js";
import * as Targets from "./targets.js";
import * as Allocations from "./allocations.js";
import * as Validation from "./validation.js";
import * as TransformationTrace from "./transformation-trace.js";
import * as ProcessLinkage from "./process-linkage.js";
import * as Coverage from "./coverage.js";
import * as Matrix from "./matrix.js";
import * as Impact from "./impact.js";
import * as Jobs from "./jobs.js";
import * as Subscriptions from "./subscriptions.js";

export {
  Constants,
  Errors,
  Configuration,
  Events,
  Security,
  Foundation,
  Provider,
  ManufacturingObjects,
  Characteristics,
  Targets,
  Allocations,
  Validation,
  TransformationTrace,
  ProcessLinkage,
  Coverage,
  Matrix,
  Impact,
  Jobs,
  Subscriptions,
};

export {
  SOURCE_MODULE,
  REQUIREMENT_SOURCE_TYPE,
  MANUFACTURING_OBJECT_TYPES,
  OPERATION_OBJECT_TYPE,
  WORK_CENTER_OBJECT_TYPE,
  MANUFACTURING_NODE_TYPES,
  TARGET_NODE_TYPES,
  TARGET_SOURCES,
  ALLOCATION_TYPES,
  ALLOCATION_CODES,
  MANUFACTURING_RELATIONSHIP_TYPES,
  MANUFACTURING_RELATIONSHIP_CODES,
  MANUFACTURING_STAGES,
  VALIDATION_STATUSES,
  VALIDATION_SEVERITIES,
  RULE_CATEGORIES,
  COVERAGE_STATUSES,
  COMPATIBILITY_STATUSES,
  SYNC_STATUSES,
  REQUIREMENT_MANUFACTURING_RESOURCES,
  REQUIREMENT_MANUFACTURING_EVENT_TYPES,
  REQUIREMENT_MANUFACTURING_EVENT_MAP,
  CONFIG_KEYS,
  CONFIG_DEFAULTS,
  CONFIG_BOUNDS,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  MAX_IMPACT_DEPTH,
  MANUFACTURING_IMPACT_CATEGORIES,
  MANUFACTURING_IMPACT_PRECEDENCE,
  MANUFACTURING_IMPACT_STATUSES,
  CHANGE_NODE_TYPES,
  REQUIREMENT_MANUFACTURING_HANDLER_CODES,
  REQUIREMENT_MANUFACTURING_JOB_TYPES,
  REQUIREMENT_MANUFACTURING_QUEUE,
  REQUIREMENT_MANUFACTURING_INTEGRATION,
  REQUIREMENT_MANUFACTURING_NODE_SUBSCRIPTIONS,
  REQUIREMENT_MANUFACTURING_TRACE_SUBSCRIPTIONS,
} from "./constants.js";

export { RequirementManufacturingError, REQUIREMENT_MANUFACTURING_ERROR_CODES } from "./errors.js";

export const ensureRequirementManufacturingFoundation = Foundation.ensureRequirementManufacturingFoundation;
export const ensureRequirementManufacturingFoundationAsync = Foundation.ensureRequirementManufacturingFoundationAsync;
export const registerRequirementManufacturingObjectTypes = Foundation.registerRequirementManufacturingObjectTypes;
export const registerRequirementManufacturingRelationshipTypes = Foundation.registerRequirementManufacturingRelationshipTypes;
export const requirementManufacturingHealth = Foundation.requirementManufacturingHealth;
export const requirementManufacturingHealthAsync = Foundation.requirementManufacturingHealthAsync;
export const requirementManufacturingMeta = Foundation.requirementManufacturingMeta;

export const getConfig = Configuration.getConfig;
export const listConfig = Configuration.listConfig;
export const describeConfig = Configuration.describeConfig;
export const setConfig = Configuration.setConfig;
export const configCatalog = Configuration.configCatalog;

export const publishRequirementManufacturingEvent = Events.publishRequirementManufacturingEvent;
export const publishRequirementManufacturingEventAsync = Events.publishRequirementManufacturingEventAsync;

export const authorizeRequirementManufacturingAction = Security.authorizeRequirementManufacturingAction;
export const authorizeRequirementManufacturingActionAsync = Security.authorizeRequirementManufacturingActionAsync;
export const requireRequirementManufacturingAction = Security.requireRequirementManufacturingAction;
export const requireRequirementManufacturingActionAsync = Security.requireRequirementManufacturingActionAsync;
export const buildRequirementManufacturingContext = Security.buildRequirementManufacturingContext;
export const buildRequirementManufacturingContextAsync = Security.buildRequirementManufacturingContextAsync;

export const registerRequirementManufacturingProvider = Provider.registerRequirementManufacturingProvider;
export const requirementManufacturingProvider = Provider.requirementManufacturingProvider;

export const createManufacturingObject = ManufacturingObjects.createManufacturingObject;
export const createManufacturingObjectAsync = ManufacturingObjects.createManufacturingObjectAsync;
export const getManufacturingObject = ManufacturingObjects.getManufacturingObject;
export const getManufacturingObjectAsync = ManufacturingObjects.getManufacturingObjectAsync;
export const listManufacturingObjects = ManufacturingObjects.listManufacturingObjects;
export const listManufacturingObjectsAsync = ManufacturingObjects.listManufacturingObjectsAsync;
export const linkManufacturingObjects = ManufacturingObjects.linkManufacturingObjects;
export const linkManufacturingObjectsAsync = ManufacturingObjects.linkManufacturingObjectsAsync;

export const designateCtq = Characteristics.designateCtq;
export const designateCtqAsync = Characteristics.designateCtqAsync;
export const setCharacteristicLimits = Characteristics.setCharacteristicLimits;
export const setCharacteristicLimitsAsync = Characteristics.setCharacteristicLimitsAsync;
export const characteristicConstraints = Characteristics.characteristicConstraints;
export const listCriticalCharacteristics = Characteristics.listCriticalCharacteristics;
export const listCriticalCharacteristicsAsync = Characteristics.listCriticalCharacteristicsAsync;

// Targets (manufacturing target resolution)
export const resolveTarget = Targets.resolveTarget;
export const resolveTargetAsync = Targets.resolveTargetAsync;
export const requireTarget = Targets.requireTarget;
export const requireTargetAsync = Targets.requireTargetAsync;

// Allocations (Boundary 2)
export const createAllocation = Allocations.createAllocation;
export const createAllocationAsync = Allocations.createAllocationAsync;
export const createAllocations = Allocations.createAllocations;
export const createAllocationsAsync = Allocations.createAllocationsAsync;
export const listAllocations = Allocations.listAllocations;
export const listAllocationsAsync = Allocations.listAllocationsAsync;
export const getAllocation = Allocations.getAllocation;
export const getAllocationAsync = Allocations.getAllocationAsync;
export const removeAllocation = Allocations.removeAllocation;
export const removeAllocationAsync = Allocations.removeAllocationAsync;
export const listRequirementAllocations = Allocations.listRequirementAllocations;
export const listRequirementAllocationsAsync = Allocations.listRequirementAllocationsAsync;
export const listTargetRequirements = Allocations.listTargetRequirements;
export const listTargetRequirementsAsync = Allocations.listTargetRequirementsAsync;
export const allocationCoverage = Allocations.allocationCoverage;
export const allocationCoverageAsync = Allocations.allocationCoverageAsync;
export const publicAllocation = Allocations.publicAllocation;

// EBOM -> MBOM transformation trace (Boundary 3)
export const ebomMbomMappings = TransformationTrace.ebomMbomMappings;
export const ebomMbomMappingsAsync = TransformationTrace.ebomMbomMappingsAsync;
export const mbomEbomSources = TransformationTrace.mbomEbomSources;
export const mbomEbomSourcesAsync = TransformationTrace.mbomEbomSourcesAsync;
export const listTransformationsForRevision = TransformationTrace.listTransformationsForRevision;
export const listTransformationsForRevisionAsync = TransformationTrace.listTransformationsForRevisionAsync;

// BOP -> Operation -> Work-center linkage (Boundary 4)
export const bopOperations = ProcessLinkage.bopOperations;
export const bopOperationsAsync = ProcessLinkage.bopOperationsAsync;
export const operationWorkCenters = ProcessLinkage.operationWorkCenters;
export const operationWorkCentersAsync = ProcessLinkage.operationWorkCentersAsync;
export const workCenterOperations = ProcessLinkage.workCenterOperations;
export const workCenterOperationsAsync = ProcessLinkage.workCenterOperationsAsync;
export const operationMbomItems = ProcessLinkage.operationMbomItems;
export const operationMbomItemsAsync = ProcessLinkage.operationMbomItemsAsync;
export const mbomItemOperations = ProcessLinkage.mbomItemOperations;
export const mbomItemOperationsAsync = ProcessLinkage.mbomItemOperationsAsync;
export const listBopMboms = ProcessLinkage.listBopMboms;
export const listBopMbomsAsync = ProcessLinkage.listBopMbomsAsync;
export const listMbomBops = ProcessLinkage.listMbomBops;
export const listMbomBopsAsync = ProcessLinkage.listMbomBopsAsync;
export const bopProcessSequence = ProcessLinkage.bopProcessSequence;
export const bopProcessSequenceAsync = ProcessLinkage.bopProcessSequenceAsync;
export const bopProcessCoverage = ProcessLinkage.bopProcessCoverage;
export const bopProcessCoverageAsync = ProcessLinkage.bopProcessCoverageAsync;
export const mbomProcessCoverage = ProcessLinkage.mbomProcessCoverage;
export const mbomProcessCoverageAsync = ProcessLinkage.mbomProcessCoverageAsync;
export const addOperationToBop = ProcessLinkage.addOperationToBop;
export const addOperationToBopAsync = ProcessLinkage.addOperationToBopAsync;
export const linkOperationToWorkCenter = ProcessLinkage.linkOperationToWorkCenter;
export const linkOperationToWorkCenterAsync = ProcessLinkage.linkOperationToWorkCenterAsync;
export const linkOperationToMbomItem = ProcessLinkage.linkOperationToMbomItem;
export const linkOperationToMbomItemAsync = ProcessLinkage.linkOperationToMbomItemAsync;
export const linkOperationPrecedence = ProcessLinkage.linkOperationPrecedence;
export const linkOperationPrecedenceAsync = ProcessLinkage.linkOperationPrecedenceAsync;

// Manufacturing characteristics, process constraints & CTQ coverage (Boundary 5)
export const operationCharacteristics = Coverage.operationCharacteristics;
export const operationCharacteristicsAsync = Coverage.operationCharacteristicsAsync;
export const operationConstraints = Coverage.operationConstraints;
export const operationConstraintsAsync = Coverage.operationConstraintsAsync;
export const characteristicOperations = Coverage.characteristicOperations;
export const characteristicOperationsAsync = Coverage.characteristicOperationsAsync;
export const constraintOperations = Coverage.constraintOperations;
export const constraintOperationsAsync = Coverage.constraintOperationsAsync;
export const characteristicRequirements = Coverage.characteristicRequirements;
export const characteristicRequirementsAsync = Coverage.characteristicRequirementsAsync;
export const requirementCtqs = Coverage.requirementCtqs;
export const requirementCtqsAsync = Coverage.requirementCtqsAsync;
export const ctqCoverage = Coverage.ctqCoverage;
export const ctqCoverageAsync = Coverage.ctqCoverageAsync;
export const validateConstraintCompatibility = Coverage.validateConstraintCompatibility;
export const validateConstraintCompatibilityAsync = Coverage.validateConstraintCompatibilityAsync;

// Traceability matrix, coverage, gap analysis & bidirectional navigation (Boundary 6)
export const manufacturingMatrix = Matrix.manufacturingMatrix;
export const manufacturingMatrixAsync = Matrix.manufacturingMatrixAsync;
export const manufacturingCoverage = Matrix.manufacturingCoverage;
export const manufacturingCoverageAsync = Matrix.manufacturingCoverageAsync;
export const manufacturingGaps = Matrix.manufacturingGaps;
export const manufacturingGapsAsync = Matrix.manufacturingGapsAsync;
export const manufacturingTrace = Matrix.manufacturingTrace;
export const manufacturingTraceAsync = Matrix.manufacturingTraceAsync;
export const manufacturingTraceMatrix = Matrix.manufacturingTraceMatrix;
export const manufacturingTraceMatrixAsync = Matrix.manufacturingTraceMatrixAsync;
export const MANUFACTURING_COVERAGE_STATUSES = Matrix.MANUFACTURING_COVERAGE_STATUSES;
export const MANUFACTURING_GAP_STATUS = Matrix.GAP_STATUS;

// Change impact classification (Boundary 7)
export const analyzeRequirementImpact = Impact.analyzeRequirementImpact;
export const analyzeRequirementImpactAsync = Impact.analyzeRequirementImpactAsync;
export const analyzeNodeImpact = Impact.analyzeNodeImpact;
export const analyzeNodeImpactAsync = Impact.analyzeNodeImpactAsync;
export const impactCategoryForNodeType = Impact.impactCategoryForNodeType;

// Background jobs (Boundary 7)
export const ensureRequirementManufacturingJobTypes = Jobs.ensureRequirementManufacturingJobTypes;
export const ensureRequirementManufacturingJobTypesAsync = Jobs.ensureRequirementManufacturingJobTypesAsync;
export const submitImpactAnalysis = Jobs.submitImpactAnalysis;
export const submitImpactAnalysisAsync = Jobs.submitImpactAnalysisAsync;
export const submitGapSweep = Jobs.submitGapSweep;
export const submitGapSweepAsync = Jobs.submitGapSweepAsync;
export const submitNodeImpact = Jobs.submitNodeImpact;
export const submitNodeImpactAsync = Jobs.submitNodeImpactAsync;
export const sweepManufacturingGaps = Jobs.sweepManufacturingGaps;
export const registerRequirementManufacturingHandlers = Jobs.registerRequirementManufacturingHandlers;

// Event subscriptions (Boundary 7)
export const registerRequirementManufacturingNodeEventHandler = Subscriptions.registerRequirementManufacturingNodeEventHandler;
export const registerRequirementManufacturingTraceEventHandler = Subscriptions.registerRequirementManufacturingTraceEventHandler;
export const ensureRequirementManufacturingNodeSubscriptions = Subscriptions.ensureRequirementManufacturingNodeSubscriptions;
export const ensureRequirementManufacturingNodeSubscriptionsAsync = Subscriptions.ensureRequirementManufacturingNodeSubscriptionsAsync;
export const ensureRequirementManufacturingTraceSubscriptions = Subscriptions.ensureRequirementManufacturingTraceSubscriptions;
export const ensureRequirementManufacturingTraceSubscriptionsAsync = Subscriptions.ensureRequirementManufacturingTraceSubscriptionsAsync;

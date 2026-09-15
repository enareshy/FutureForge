// Public facade for the Lifecycle Management module. Business modules should
// depend on this file (or the platform.js re-exports) rather than the internal
// services, so the layout can evolve without breaking consumers.

export {
  STATUS_CATEGORIES,
  LEGACY_OBJECT_STATUSES,
  DEFINITION_STATUSES,
  VERSION_STATUSES,
  TRANSITION_STATUSES,
  APPROVAL_RULE_KINDS,
  APPROVER_TYPES,
  APPROVAL_MODES,
  RELEASE_STATUSES,
  APPROVAL_STATUSES,
  APPROVAL_DECISIONS,
} from "./lifecycle/validation.js";

export {
  publicStatus,
  getStatusRow,
  findStatus,
  getStatus,
  listStatuses,
  createStatus,
  updateStatus,
  setStatusStatus,
  deleteStatus,
  defaultStatusRow,
  legacyForCategory,
  readStatusTenant,
} from "./lifecycle/statuses.js";

export {
  publicDefinition,
  publicVersion,
  publicState,
  publicTransition,
  publicAssignment,
  getDefinitionRow,
  findDefinition,
  getDefinition,
  listDefinitions,
  createDefinition,
  updateDefinition,
  setDefinitionStatus,
  deleteDefinition,
  listVersions,
  createVersion,
  currentVersionRow,
  publishedVersionRow,
  getVersionRow,
  validateDefinitionVersion,
  validateDefinition,
  publishDefinition,
  getStateRow,
  listStates,
  createState,
  updateState,
  deleteState,
  getTransitionRow,
  listTransitions,
  createTransition,
  updateTransition,
  deleteTransition,
  listAssignments,
  createAssignment,
  deleteAssignment,
  resolveAssignment,
  initialStateForVersion,
  stateByCode,
  transitionsFrom,
  readDefinitionTenant,
} from "./lifecycle/definitions.js";

export {
  applyInitialLifecycle,
  availableTransitions,
  objectLifecycle,
  transitionObject,
  statusHistory,
  requestObjectRelease,
  objectReleases,
  actorRoleCodes,
} from "./lifecycle/engine.js";

export {
  recordStatusHistory,
  applyTransition,
  assignLifecycle,
  conditionContext,
  evaluateGuard,
} from "./lifecycle/apply.js";

export {
  publicRule,
  publicStep,
  publicApproval,
  publicRelease,
  getRuleRow,
  findRule,
  getRule,
  listRules,
  listReleaseRules,
  listApprovalRules,
  stepsFor,
  createRule,
  updateRule,
  deleteRule,
  resolveRule,
  requestRelease,
  decideApproval,
  resubmit,
  listReleases,
  readRuleTenant,
} from "./lifecycle/approvals.js";

export {
  registerWorkflowExecutor,
  workflowExecutor,
  resolveApprovers,
  startApproval,
  onApprovalComplete,
} from "./lifecycle/workflow.js";

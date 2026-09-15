// Public facade for the Workflow & Process Engine. Business modules depend on
// this file (or the platform.js re-exports) rather than the internal services so
// the layout can evolve safely.

import { registerLifecycleExecutor } from "./workflow/lifecycle-bridge.js";

export {
  NODE_TYPES,
  NODE_TYPE_LABELS,
  WORKFLOW_STATUSES,
  VERSION_STATUSES,
  INSTANCE_STATUSES,
  INSTANCE_NODE_STATUSES,
  TASK_STATUSES,
  TASK_OPEN_STATUSES,
  TASK_PRIORITIES,
  ASSIGNEE_TYPES,
  ROUTING_ASSIGNEE_TYPES,
  ROUTING_STRATEGIES,
  APPROVAL_STATUSES,
  APPROVAL_DECISIONS,
  ESCALATION_ACTIONS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_EVENTS,
  BINDING_EVENTS,
  validateGraph,
  assertValidGraph,
  autoLayout,
  evaluateCondition,
  safeParse,
  slugifyKey,
  publicGraph,
} from "./workflow/validation.js";

export {
  publicDefinition,
  publicVersion,
  getDefinitionRow,
  findDefinition,
  getDefinition,
  listDefinitions,
  createDefinition,
  updateDefinition,
  setDefinitionStatus,
  deleteDefinition,
  getVersionRow,
  getVersionByNumber,
  publishedVersionRow,
  listVersions,
  getVersion,
  createVersion,
  validateDefinition,
  publishDefinition,
  cloneDefinition,
  defaultGraph,
  readDefinitionTenant,
} from "./workflow/templates.js";

export {
  designerContext,
  saveDesignerGraph,
  addNode,
  patchNode,
  removeNode,
  addTransition,
  patchTransition,
  removeTransition,
  applyAutoLayout,
  validateDesignerGraph,
} from "./workflow/designer.js";

export {
  recordEvent,
  listEvents,
  publicEvent,
} from "./workflow/events.js";

export {
  publicRoutingRule,
  getRoutingRuleRow,
  listRoutingRules,
  createRoutingRule,
  updateRoutingRule,
  deleteRoutingRule,
  resolveAssignee,
  usersForAssignee,
  usersForRole,
  readRoutingTenant,
} from "./workflow/routing.js";

export {
  publicEscalationRule,
  getEscalationRuleRow,
  listEscalationRules,
  createEscalationRule,
  updateEscalationRule,
  deleteEscalationRule,
  applyEscalation,
  sweepEscalations,
  readEscalationTenant,
} from "./workflow/escalations.js";

export {
  publicTemplate,
  publicNotification,
  getTemplateRow,
  findTemplate,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  dispatch,
  renderTemplate,
  sendToAssignees,
  listNotifications,
  markNotificationRead,
  readNotificationTenant,
} from "./workflow/notifications.js";

export {
  publicTask,
  publicSubtask,
  publicComment,
  publicAttachment,
  getTaskRow,
  taskDetail,
  listTasks,
  getTask,
  createTask,
  completeTask,
  assignTask,
  claimTask,
  updateTaskStatus,
  delegateTask,
  addSubtask,
  updateSubtask,
  deleteSubtask,
  addComment,
  listComments,
  addAttachment,
  listAttachments,
  listDelegations,
  createDelegation,
  revokeDelegation,
  publicDelegation,
} from "./workflow/tasks.js";

export {
  publicApproval,
  getApprovalRow,
  resolveApprovalRule,
  createApprovalsForNode,
  listApprovals,
  getApproval,
  decideApproval,
} from "./workflow/approvals.js";

export {
  publicInstance,
  publicInstanceNode,
  getInstanceRow,
  listInstances,
  getInstance,
  startInstance,
  advance,
  pauseInstance,
  resumeInstance,
  cancelInstance,
  retryInstance,
  instanceNodes,
  instanceHistory,
  registerServiceHandler,
  serviceHandler,
} from "./workflow/engine.js";

export {
  publicBinding,
  getBindingRow,
  listBindings,
  createBinding,
  updateBinding,
  deleteBinding,
  triggerEvent,
  readBindingTenant,
} from "./workflow/bindings.js";

export {
  resolveLifecycleApprovers,
  onLifecycleApprovalComplete,
  lifecycleExecutor,
  registerLifecycleExecutor,
} from "./workflow/lifecycle-bridge.js";

registerLifecycleExecutor();

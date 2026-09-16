// Public facade for the Notification & Communication Framework. Business
// modules (workflow, tasks, lifecycle, ...) should import from this module
// instead of reaching into the internal layout, so the implementation can
// evolve without touching call sites. The primary entry point for producing a
// notification is `publish(db, event)`.

export {
  CHANNELS,
  CHANNEL_LABELS,
  NOTIFICATION_STATUSES,
  OPEN_STATUSES,
  PRIORITIES,
  DELIVERY_MODES,
  FREQUENCIES,
  PROVIDER_TYPES,
  EVENT_STATUSES,
  REMINDER_STATUSES,
  RECIPIENT_TYPES,
  TEMPLATE_ROOTS,
  safeParse,
  assertChannel,
  assertStatus,
  assertPriority,
  assertDeliveryMode,
  assertFrequency,
  assertProviderType,
  normalizeChannels,
  extractVariables,
  validateTemplateVariables,
  escapeHtml,
  resolvePathSafe,
  renderTemplate,
  sanitizeHtml,
  templateHasScript,
  assertTemplateInput,
  evaluateCondition,
  normalizeRecipientDefinition,
  normalizeRecipientItem,
} from "./notifications/validation.js";

export { resolveRecipients } from "./notifications/recipients.js";

export {
  publicTemplate,
  getTemplateRow,
  findTemplate,
  listTemplates,
  createTemplate,
  updateTemplate,
  setTemplateStatus,
  deleteTemplate,
  listTemplateVersions,
  sampleContext,
  renderTemplateRow,
  previewTemplate,
  testSendTemplate,
  findTemplateForEvent,
} from "./notifications/templates.js";

export {
  publicRule,
  getRuleRow,
  listRules,
  createRule,
  updateRule,
  setRuleStatus,
  deleteRule,
  matchRules,
  buildRuleContext,
} from "./notifications/rules.js";

export {
  DEFAULT_PREFERENCES,
  publicPreferences,
  getPreferenceRow,
  getPreferences,
  updatePreferences,
  mandatoryEvents,
  ensureDefaultPreferences,
  evaluatePreference,
  isReminderAllowed,
  isEscalationAllowed,
} from "./notifications/preferences.js";

export {
  SECRET_KEYS,
  publicProvider,
  getProviderRow,
  getProvider,
  listProviders,
  providerSecrets,
  providerConfig,
  createProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  providerForChannel,
  ensureDefaultProviders,
} from "./notifications/providers.js";

export {
  BACKOFF_BASE_SECONDS,
  MAX_ATTEMPTS,
  handlerFor,
  enqueue,
  deliverDirect,
  processQueue,
  retryDelivery,
  listDeliveries,
  deliveryStats,
} from "./notifications/delivery.js";

export {
  publicEvent,
  publish,
  notifyUser,
  notifyGroup,
  notifyRole,
  listEvents,
  getEvent,
  simulateRule,
} from "./notifications/events.js";

export {
  addMinutes,
  scheduleReminder,
  scheduleReminderForRule,
  sweepReminders,
  cancelRemindersForObject,
  listReminders,
  getReminder,
} from "./notifications/reminders.js";

export {
  publicNotification,
  listInbox,
  unreadCount,
  getNotification,
  markRead,
  markUnread,
  markAllRead,
  archiveNotification,
  deleteNotification,
  archiveAllRead,
  listHistory,
} from "./notifications/inbox.js";

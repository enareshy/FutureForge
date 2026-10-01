// Communication & Delivery Services module (public facade).
//
// Centralized outbound delivery infrastructure for the enterprise platform:
// delivery request intake, provider abstraction and configuration, queue and
// worker processing, retry/backoff and dead-letter handling, delivery tracking,
// reminder/escalation execution and operational monitoring.
//
// The Notification Management module hands off *rendered* requests here; this
// module owns none of its rules, templates, recipient definitions or user
// preferences.

export {
  DELIVERY_STATUSES,
  DELIVERY_STATUS_LABELS,
  OPEN_STATUSES,
  TERMINAL_STATUSES,
  SUCCESS_STATUSES,
  REMINDER_STATUSES,
  REMINDER_KINDS,
  ESCALATION_STATUSES,
  ALERT_SEVERITIES,
  ESCALATION_RECIPIENT_TYPES,
  CHANNELS,
  PRIORITIES,
  PROVIDER_TYPES,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BACKOFF_SECONDS,
  MAX_BACKOFF_SECONDS,
  PERMANENT_ERROR_CODES,
  assertChannel,
  assertProviderType,
  assertDeliveryStatus,
  assertPriority,
  assertReminderStatus,
  assertReminderKind,
  assertEscalationStatus,
  assertAlertSeverity,
  normalizePriority,
  normalizeRetryConfig,
  statusLabel,
  classifyFailure,
  nextBackoff,
  addSeconds,
  addMinutes,
  isEmail,
  safeParse,
} from "./delivery/validation.js";

export {
  SECRET_KEYS,
  publicDeliveryProvider,
  listDeliveryProviders,
  listDeliveryProvidersAsync,
  getDeliveryProvider,
  getDeliveryProviderAsync,
  createDeliveryProvider,
  createDeliveryProviderAsync,
  updateDeliveryProvider,
  updateDeliveryProviderAsync,
  deleteDeliveryProvider,
  deleteDeliveryProviderAsync,
  setDeliveryProviderStatus,
  setDeliveryProviderStatusAsync,
  testDeliveryProvider,
  testDeliveryProviderAsync,
  resolveProviderChain,
  defaultDeliveryProvider,
  recordProviderFailure,
  listProviderFailures,
  listProviderFailuresAsync,
  providerHealth,
  providerHealthAsync,
  ensureDefaultProviders,
  getProviderRow,
  getProvider,
  providerConfig,
  providerSecrets,
} from "./delivery/providers.js";

export {
  publicRequest,
  submitRequest,
  submitRequestAsync,
  getRequest,
  getRequestRow,
  getRequestAsync,
  listRequests,
  listRequestsAsync,
  listAttemptsAsync,
  cancelRequest,
  cancelRequestAsync,
  retryRequest,
  retryRequestAsync,
  listAttempts,
  requestsForNotification,
  ingestNotification,
} from "./delivery/requests.js";

export {
  registerTransport,
  registerCustomTransport,
  hasTransport,
  transportTypes,
  resolveTransport,
  outcome,
} from "./delivery/transports.js";

export {
  processDue,
  processDueAsync,
  pendingCount,
  createWorker,
} from "./delivery/worker.js";

export {
  deliveryMetrics,
  deliveryMetricsAsync,
  deliveryStats,
  deliveryStatsAsync,
  deliveryTimeseries,
  deliveryTimeseriesAsync,
  providerFailureSummary,
  providerFailureSummaryAsync,
} from "./delivery/tracking.js";

export {
  publicReminder,
  scheduleReminder,
  scheduleReminderAsync,
  listReminders,
  listRemindersAsync,
  getReminder,
  getReminderAsync,
  updateReminder,
  updateReminderAsync,
  cancelReminder,
  cancelReminderAsync,
  completeRemindersForObject,
  sweepReminders,
  listRuns,
  listRunsAsync,
} from "./delivery/reminders.js";

export {
  ESCALATION_MAX_LEVEL,
  publicEscalation,
  scheduleEscalation,
  scheduleEscalationAsync,
  listEscalations,
  listEscalationsAsync,
  getEscalation,
  getEscalationAsync,
  cancelEscalation,
  cancelEscalationAsync,
  sweepEscalations,
  completeEscalationsForObject,
} from "./delivery/escalations.js";

export {
  publicAlert,
  createAlert,
  listAlerts,
  listAlertsAsync,
  acknowledgeAlert,
  acknowledgeAlertAsync,
} from "./delivery/alerts.js";

export {
  rateLimitStatus,
  recordRateEvent,
  assertDeliveryRateLimit,
  pruneRateEvents,
} from "./delivery/ratelimit.js";

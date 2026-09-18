// Event & Messaging Framework (public facade).
//
// A shared platform capability that gives every module an event-driven
// backbone: a registry of event types and schema versions, a transactional
// outbox, a provider-independent bus with topics/queues/consumer groups,
// subscriptions with filters, ordered at-least-once delivery, idempotent
// handlers, retry/backoff, dead-letter handling, controlled replay, retention
// and full monitoring/traceability.
//
// The framework never duplicates platform capabilities: long-running work is
// scheduled by the Background Job engine, auditing is delegated to the Audit
// service, secrets to the crypto service and change propagation to the Search
// and Integration modules. Consumers should depend on the namespaced exports
// below (or the flat `Events` helper for publishing).
export * as Validation from "./events/validation.js";
export * as Repository from "./events/repository.js";
export * as Hooks from "./events/hooks.js";
export * as Bus from "./events/bus.js";
export * as Registry from "./events/registry.js";
export * as Outbox from "./events/outbox.js";
export * as Subscriptions from "./events/subscriptions.js";
export * as Handlers from "./events/handlers.js";
export * as Ordering from "./events/ordering.js";
export * as Publisher from "./events/publisher.js";
export * as Router from "./events/router.js";
export * as Consumer from "./events/consumer.js";
export * as DeadLetter from "./events/deadletter.js";
export * as Replay from "./events/replay.js";
export * as Monitoring from "./events/monitoring.js";
export * as Retention from "./events/retention.js";

import * as validation from "./events/validation.js";
import * as repository from "./events/repository.js";
import * as hooks from "./events/hooks.js";
import * as bus from "./events/bus.js";
import * as registry from "./events/registry.js";
import * as outbox from "./events/outbox.js";
import * as subscriptions from "./events/subscriptions.js";
import * as handlers from "./events/handlers.js";
import * as ordering from "./events/ordering.js";
import * as publisher from "./events/publisher.js";
import * as router from "./events/router.js";
import * as consumer from "./events/consumer.js";
import * as deadletter from "./events/deadletter.js";
import * as replay from "./events/replay.js";
import * as monitoring from "./events/monitoring.js";
import * as retention from "./events/retention.js";

// Flat, stable API for other platform modules. `publishEvent` is the primary
// integration point: call it inside your business transaction and the outbox
// guarantees the event is delivered.
export const Events = {
  publish: publisher.publishEvent,
  publishEvent: publisher.publishEvent,
  publishBatch: publisher.publishBatch,
  publishAsync: publisher.publishAsync,
  publishWithCorrelation: publisher.publishWithCorrelation,
  validate: publisher.validateEvent,
  serialize: publisher.serializeEvent,
  route: publisher.routeStoredEvent,
  getEvent: publisher.getEvent,
  listEvents: publisher.listEvents,
  listDeliveries: publisher.listDeliveries,

  // Consumer contract
  consume: consumer.processDeliveries,
  processDelivery: consumer.processDelivery,
  retryDelivery: consumer.retryDelivery,
  skipDelivery: consumer.skipDelivery,

  // Topology / subscriptions
  enqueueMessage: router.enqueueMessage,
  subscribe: subscriptions.createSubscription,

  // Operations
  processOutbox: outbox.processOutbox,
  replay: replay.runReplay,
  applyRetention: retention.applyRetention,
  health: monitoring.healthCheck,
  dashboard: monitoring.dashboardSummary,
};

// Idempotently installs the default event catalogue, topology and retention
// policies. Safe to call on every boot (each step checks for existing rows).
export function ensureEventFoundation(db) {
  const types = registry.ensureDefaultEventTypes(db);
  const topology = bus.ensureDefaultTopology(db);
  const policies = retention.ensureDefaultRetentionPolicies(db);
  const subscriptionsCreated = subscriptions.ensureDefaultSubscriptions(db);
  return { event_types: types, topology, retention_policies: policies, subscriptions: subscriptionsCreated };
}

// Convenience top-level re-exports so business modules can import the primary
// operations directly (`import { publishEvent } from "../services/events.js"`)
// without reaching into a namespace.
export const publishEvent = publisher.publishEvent;
export const publishBatch = publisher.publishBatch;
export const publishAsync = publisher.publishAsync;
export const publishWithCorrelation = publisher.publishWithCorrelation;
export const subscribe = subscriptions.createSubscription;
export const enqueueMessage = router.enqueueMessage;
export const consume = consumer.processDeliveries;
export const processOutbox = outbox.processOutbox;
export const runReplay = replay.runReplay;
export const healthCheck = monitoring.healthCheck;
export const dashboardSummary = monitoring.dashboardSummary;

export { validation, repository, hooks, bus, registry, outbox, subscriptions, handlers, ordering, publisher, router, consumer, deadletter, replay, monitoring, retention };

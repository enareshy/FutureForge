// Integration & API Framework (public facade).
//
// A shared platform service that centralises everything required to connect the
// platform to external systems: a versioned REST/API framework, API authn/authz
// and docs, webhooks, event publish/subscribe, message queues, pluggable
// adapters, transformation/mapping, import/export, external object mapping,
// scheduled integrations, monitoring, retry/error handling and dead-letter
// queues.
//
// The framework never re-implements platform capabilities: scheduling is
// delegated to the Background Job engine, secrets to the crypto service,
// auditing to the Audit service and change notification to the Search service.
// Consumers should depend on the namespaced exports below.

export * as Validation from "./integration/validation.js";
export * as Repository from "./integration/repository.js";
export * as Hooks from "./integration/hooks.js";
export * as Adapters from "./integration/adapters.js";
export * as Transform from "./integration/transform.js";
export * as Systems from "./integration/systems.js";
export * as Endpoints from "./integration/endpoints.js";
export * as Schedules from "./integration/schedules.js";
export * as Definitions from "./integration/definitions.js";
export * as Events from "./integration/events.js";
export * as Webhooks from "./integration/webhooks.js";
export * as Messages from "./integration/messages.js";
export * as DeadLetter from "./integration/deadletter.js";
export * as Mappings from "./integration/mappings.js";
export * as Transfers from "./integration/transfers.js";
export * as Monitoring from "./integration/monitoring.js";
export * as ApiCatalog from "./integration/apicatalog.js";
export * as Jobs from "./integration/jobs.js";

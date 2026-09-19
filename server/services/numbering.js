// Enterprise Numbering & Identifier Service (public facade).
//
// A shared platform capability that gives every module configurable,
// concurrency-safe, auditable identifier generation: versioned numbering
// schemes, a token/pattern engine, deterministic scope resolution, atomic
// sequence allocation, reservations, consumption, reuse policy, idempotency,
// history, audit, events, background expiry and full metrics.
//
// Business modules never own sequence state. They depend on the flat API below
// (`generateIdentifier`, `reserveIdentifier`, `previewIdentifier`,
// `validateIdentifier`, `consumeIdentifier`, `releaseIdentifier`) or the
// namespaced exports for administration.
import * as validation from "./numbering/validation.js";
import * as tokens from "./numbering/tokens.js";
import * as scopes from "./numbering/scopes.js";
import * as schemes from "./numbering/schemes.js";
import * as sequences from "./numbering/sequences.js";
import * as allocations from "./numbering/allocations.js";
import * as foundation from "./numbering/foundation.js";
import * as metrics from "./numbering/metrics.js";
import * as events from "./numbering/events.js";
import * as jobs from "./numbering/jobs.js";
import * as search from "./numbering/search.js";
import * as errors from "./numbering/errors.js";

export * as Validation from "./numbering/validation.js";
export * as Tokens from "./numbering/tokens.js";
export * as Scopes from "./numbering/scopes.js";
export * as Schemes from "./numbering/schemes.js";
export * as Sequences from "./numbering/sequences.js";
export * as Allocations from "./numbering/allocations.js";
export * as Foundation from "./numbering/foundation.js";
export * as Metrics from "./numbering/metrics.js";
export * as Events from "./numbering/events.js";
export * as Jobs from "./numbering/jobs.js";
export * as Search from "./numbering/search.js";
export * as Errors from "./numbering/errors.js";

export { validation, tokens, scopes, schemes, sequences, allocations, foundation, metrics, events, jobs, search, errors };

// Flat, stable SDK for business modules. All operations take the database first
// so they can participate in the caller's transaction when needed.
export const Numbers = {
  generate: allocations.generateNumber,
  reserve: allocations.reserveNumber,
  preview: allocations.previewNumber,
  validate: allocations.validateIdentifier,
  consume: allocations.consumeNumber,
  release: allocations.releaseNumber,
  cancel: allocations.cancelNumber,
  getAllocation: allocations.getAllocation,
  listAllocations: allocations.listAllocations,
  metrics: allocations.metricsSnapshot,
  health: metrics.healthCheck,
};

export const generateIdentifier = allocations.generateNumber;
export const reserveIdentifier = allocations.reserveNumber;
export const previewIdentifier = allocations.previewNumber;
export const validateIdentifier = allocations.validateIdentifier;
export const consumeIdentifier = allocations.consumeNumber;
export const releaseIdentifier = allocations.releaseNumber;
export const cancelIdentifier = allocations.cancelNumber;
export const listAllocations = allocations.listAllocations;
export const getAllocation = allocations.getAllocation;
export const expireReservations = allocations.expireReservations;
export const metricsSnapshot = allocations.metricsSnapshot;

export const ensureNumberingFoundation = foundation.ensureNumberingFoundation;
export const registerNumberingHandlers = jobs.registerNumberingHandlers;
export const runNumberingMaintenance = jobs.runNumberingMaintenance;

// Convenience: returns just the generated string for simple call sites.
export function nextNumber(db, input = {}, actor = null, options = {}) {
  const allocation = allocations.generateNumber(db, input, actor, options);
  return allocation?.number ?? null;
}

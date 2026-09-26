// Enterprise Effectivity & Versioning Kernel (public facade).
//
// The single source of truth for revision, version, applicability, baseline,
// variant, configuration context and as-of resolution. Business modules (PDM,
// BOM, MBOM, BOP, Change, Manufacturing, Requirements, Documents, Product
// Configuration) consume the flat SDK below instead of owning effectivity logic.
import * as validation from "./versioning/validation.js";
import * as revisions from "./versioning/revisions.js";
import * as versions from "./versioning/versions.js";
import * as effectivities from "./versioning/effectivities.js";
import * as variants from "./versioning/variants.js";
import * as contexts from "./versioning/contexts.js";
import * as policies from "./versioning/policies.js";
import * as baselines from "./versioning/baselines.js";
import * as snapshots from "./versioning/snapshots.js";
import * as engine from "./versioning/engine.js";
import * as foundation from "./versioning/foundation.js";
import * as metrics from "./versioning/metrics.js";
import * as events from "./versioning/events.js";
import * as search from "./versioning/search.js";
import * as jobs from "./versioning/jobs.js";
import * as errors from "./versioning/errors.js";
import * as seed from "./versioning/seed.js";

export * as Validation from "./versioning/validation.js";
export * as Revisions from "./versioning/revisions.js";
export * as Versions from "./versioning/versions.js";
export * as Effectivities from "./versioning/effectivities.js";
export * as Variants from "./versioning/variants.js";
export * as ConfigurationContexts from "./versioning/contexts.js";
export * as Policies from "./versioning/policies.js";
export * as Baselines from "./versioning/baselines.js";
export * as Snapshots from "./versioning/snapshots.js";
export * as Engine from "./versioning/engine.js";
export * as Foundation from "./versioning/foundation.js";
export * as Metrics from "./versioning/metrics.js";
export * as Events from "./versioning/events.js";
export * as Search from "./versioning/search.js";
export * as Jobs from "./versioning/jobs.js";
export * as Errors from "./versioning/errors.js";
export * as Seed from "./versioning/seed.js";

export {
  validation,
  revisions,
  versions,
  effectivities,
  variants,
  contexts,
  policies,
  baselines,
  snapshots,
  engine,
  foundation,
  metrics,
  events,
  search,
  jobs,
  errors,
  seed,
};

// Flat, stable SDK for business modules. All operations take the database first
// so they can participate in the caller's transaction when needed.
export const Effectivity = {
  resolve: engine.EffectivityResolver.resolve,
  resolveBulk: engine.EffectivityResolver.resolveBulk,
  validate: effectivities.validateDefinition,
  inspect: effectivities.inspectObject,
  defaultRevision: revisions.getRevisionRow,
  defaultVersion: versions.defaultVersionForRevision,
};

export const resolveEffectivity = engine.EffectivityResolver.resolve;
export const resolveEffectivityBulk = engine.EffectivityResolver.resolveBulk;
export const validateEffectivity = effectivities.validateDefinition;
export const inspectEffectivity = effectivities.inspectObject;

export const ensureVersioningFoundation = foundation.ensureVersioningFoundation;
export const registerVersioningHandlers = jobs.registerVersioningHandlers;
export const runVersioningMaintenance = jobs.runVersioningMaintenance;
export const seedVersioning = seed.seedVersioning;

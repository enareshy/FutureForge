// Enterprise Reference Data Management (public facade).
//
// A shared platform capability for governed, reusable enterprise master and
// reference values: domains, governance policy versions, versioned items with
// effective dating, scope precedence, codes, aliases, translations, hierarchy,
// cross-domain relationships, approvals, change requests, import/export, audit,
// events, search, background maintenance and metrics.
//
// This is intentionally distinct from Metadata & Configuration LOVs: LOVs are
// UI/config-controlled value lists, while reference data is enterprise-owned,
// governed, versioned and consumable through a stable API/SDK. Business modules
// depend on the flat SDK below rather than reading reference tables directly.
import * as validation from "./reference/validation.js";
import * as errors from "./reference/errors.js";
import * as refs from "./reference/refs.js";
import * as cache from "./reference/cache.js";
import * as events from "./reference/events.js";
import * as governance from "./reference/governance.js";
import * as domains from "./reference/domains.js";
import * as items from "./reference/items.js";
import * as codes from "./reference/codes.js";
import * as aliases from "./reference/aliases.js";
import * as translations from "./reference/translations.js";
import * as hierarchy from "./reference/hierarchy.js";
import * as relationships from "./reference/relationships.js";
import * as versions from "./reference/versions.js";
import * as scopes from "./reference/scope.js";
import * as resolution from "./reference/resolution.js";
import * as approvals from "./reference/approvals.js";
import * as importexport from "./reference/importexport.js";
import * as search from "./reference/search.js";
import * as metrics from "./reference/metrics.js";
import * as jobs from "./reference/jobs.js";
import * as seed from "./reference/seed.js";
import * as foundation from "./reference/foundation.js";

export * as Validation from "./reference/validation.js";
export * as Errors from "./reference/errors.js";
export * as Refs from "./reference/refs.js";
export * as Cache from "./reference/cache.js";
export * as Events from "./reference/events.js";
export * as Governance from "./reference/governance.js";
export * as Domains from "./reference/domains.js";
export * as Items from "./reference/items.js";
export * as Codes from "./reference/codes.js";
export * as Aliases from "./reference/aliases.js";
export * as Translations from "./reference/translations.js";
export * as Hierarchy from "./reference/hierarchy.js";
export * as Relationships from "./reference/relationships.js";
export * as Versions from "./reference/versions.js";
export * as Scopes from "./reference/scope.js";
export * as Resolution from "./reference/resolution.js";
export * as Approvals from "./reference/approvals.js";
export * as ImportExport from "./reference/importexport.js";
export * as Search from "./reference/search.js";
export * as Metrics from "./reference/metrics.js";
export * as Jobs from "./reference/jobs.js";
export * as Seed from "./reference/seed.js";
export * as Foundation from "./reference/foundation.js";

export {
  validation,
  errors,
  refs,
  cache,
  events,
  governance,
  domains,
  items,
  codes,
  aliases,
  translations,
  hierarchy,
  relationships,
  versions,
  scopes,
  resolution,
  approvals,
  importexport,
  search,
  metrics,
  jobs,
  seed,
  foundation,
};

// Flat, stable SDK for business modules. All operations take the database first
// so they can participate in the caller's transaction when needed.
export const ReferenceData = {
  resolve: resolution.resolveValue,
  resolveBulk: resolution.resolveBulk,
  lookup: resolution.lookupValue,
  validate: resolution.validateValue,
  listValues: resolution.listValues,
  searchValues: resolution.searchValues,
  getItem: items.getItem,
  listItems: items.listItems,
  createItem: items.createItem,
  updateItem: items.updateItem,
  setStatus: items.setItemStatus,
  getDomain: domains.getDomain,
  listDomains: domains.listDomains,
  createDomain: domains.createDomain,
  metrics: metrics.metricsSnapshot,
  health: metrics.healthCheck,
};

export const resolveValue = resolution.resolveValue;
export const resolveValues = resolution.resolveBulk;
export const lookupValue = resolution.lookupValue;
export const validateValue = resolution.validateValue;
export const listValues = resolution.listValues;
export const searchValues = resolution.searchValues;
export const getReferenceItem = items.getItem;
export const listReferenceItems = items.listItems;

export const ensureReferenceFoundation = foundation.ensureReferenceFoundation;
export const ensureReferenceDomains = seed.ensureReferenceDomains;
export const seedReference = seed.seedReference;
export const registerReferenceHandlers = jobs.registerReferenceHandlers;
export const runReferenceMaintenance = jobs.runReferenceMaintenance;

// Public facade for the centralized Data Governance & Data Quality capability.
//
// Business modules depend on this file (or the platform re-exports) rather than
// the internal layout, so the implementation can evolve safely. The flat `SDK`
// object below is the stable surface other modules should code against.
import * as constants from "./constants.js";
import * as Validation from "./validation.js";
import * as Errors from "./errors.js";
import * as Refs from "./refs.js";
import * as Repository from "./repository.js";
import * as Domains from "./domains.js";
import * as Ownership from "./ownership.js";
import * as Catalog from "./catalog.js";
import * as Policies from "./policies.js";
import * as Configuration from "./configuration.js";
import * as Dimensions from "./dimensions.js";
import * as Expressions from "./expressions.js";
import * as Rules from "./rules.js";
import * as Adapter from "./adapter.js";
import * as Engine from "./engine.js";
import * as Results from "./results.js";
import * as Exceptions from "./exceptions.js";
import * as Duplicates from "./duplicates.js";
import * as Remediation from "./remediation.js";
import * as Events from "./events.js";
import * as Jobs from "./jobs.js";
import * as Search from "./search.js";
import * as Notifications from "./notifications.js";
import * as Metrics from "./metrics.js";
import * as Foundation from "./foundation.js";
import * as Seed from "./seed.js";

export {
  constants,
  Validation,
  Errors,
  Refs,
  Repository,
  Domains,
  Ownership,
  Catalog,
  Policies,
  Configuration,
  Dimensions,
  Expressions,
  Rules,
  Adapter,
  Engine,
  Results,
  Exceptions,
  Duplicates,
  Remediation,
  Events,
  Jobs,
  Search,
  Notifications,
  Metrics,
  Foundation,
  Seed,
};

export * as Constants from "./constants.js";

// Flat, stable SDK. Databases are always passed first so a call can participate
// in the caller's transaction.
export const DataGovernance = {
  // Domains
  createDomain: Domains.createDomain,
  getDomain: Domains.getDomain,
  listDomains: Domains.listDomains,
  updateDomain: Domains.updateDomain,
  setDomainStatus: Domains.setDomainStatus,
  domainTree: Domains.domainTree,
  // Ownership
  createOwnership: Ownership.createOwnership,
  listOwnership: Ownership.listOwnership,
  resolveOwnership: Ownership.resolveOwnership,
  // Catalogue
  registerCatalogObject: Catalog.registerCatalogObject,
  findCatalogByType: Catalog.findCatalogByType,
  registerAttribute: Catalog.registerAttribute,
  listAttributes: Catalog.listAttributes,
  // Policies
  createPolicy: Policies.createPolicy,
  updatePolicy: Policies.updatePolicy,
  setPolicyStatus: Policies.setPolicyStatus,
  getPolicy: Policies.getPolicy,
  // Configuration
  getConfig: Configuration.getConfig,
  setConfig: Configuration.setConfig,
  scoringConfig: Configuration.scoringConfig,
  // Metrics
  metrics: Metrics.metricsSnapshot,
  health: Metrics.healthCheck,
};

export const DataQuality = {
  // Rules
  createRule: Rules.createRule,
  updateRule: Rules.updateRule,
  setRuleStatus: Rules.setRuleStatus,
  validateRuleInput: Rules.validateRuleInput,
  listRules: Rules.listRules,
  // Adapters & strategies
  registerAdapter: Adapter.registerAdapter,
  registerEvaluator: Engine.registerEvaluator,
  registerDuplicateStrategy: Duplicates.registerDuplicateStrategy,
  // Evaluation
  evaluate: Engine.evaluateObject,
  evaluateType: Engine.evaluateType,
  evaluateOnEvent: Jobs.evaluateOnEvent,
  // Results & scores
  getResult: Results.getResult,
  objectHistory: Results.objectHistory,
  listResults: Results.listResults,
  scoreSummary: Results.scoreSummary,
  domainScores: Results.domainScores,
  typeScores: Results.typeScores,
  // Exceptions
  createException: Exceptions.createException,
  updateException: Exceptions.updateException,
  assignException: Exceptions.assignException,
  transitionException: Exceptions.transitionException,
  listExceptions: Exceptions.listExceptions,
  // Duplicates
  detectDuplicates: Duplicates.detectDuplicates,
  resolveCandidate: Duplicates.resolveCandidate,
  // Remediation
  applyRemediation: Remediation.applyRemediation,
};

export const ensureDataGovernanceFoundation = Foundation.ensureDataGovernanceFoundation;
export const registerEventEvaluationHandler = Foundation.registerEventEvaluationHandler;
export const registerDataGovernanceHandlers = Jobs.registerDataGovernanceHandlers;
export const seedDataGovernance = Seed.seedDataGovernance;
export const ensureDataGovernanceSeed = Seed.ensureDataGovernanceSeed;
export const registerDataGovernanceSources = Search.registerDataGovernanceSources;

// Public facade for the Deployment & Edition framework.
//
// Every consumer (API layer, middleware, other modules) depends on this file
// rather than the internal layout so the implementation can evolve safely.
// Databases are always passed first so a call can participate in the caller's
// transaction (mirrors server/services/change/index.js).
import * as Constants from "./constants.js";
import * as Errors from "./errors.js";
import * as History from "./history.js";
import * as Profile from "./profile.js";
import * as Features from "./features.js";
import * as Foundation from "./foundation.js";

export { Constants, Errors, History, Profile, Features, Foundation };

// Flat, stable SDK surface.
export const Deployment = {
  getProfile: Profile.getProfile,
  updateProfile: Profile.updateProfile,
  publicProfile: Profile.publicProfile,
  listFeatures: Features.listFeatures,
  getFeature: Features.featureRow,
  setFeature: Features.setFeature,
  featureSummary: Features.featureSummary,
  resolveCapabilities: Features.resolveCapabilities,
  isFeatureEnabled: Features.isFeatureEnabled,
  listHistory: History.listDeploymentHistory,
  recordChange: History.recordDeploymentChange,
  vocabulary: () => ({
    modes: Constants.DEPLOYMENT_MODES,
    editions: Constants.EDITIONS,
    tenant_strategies: Constants.TENANT_STRATEGIES,
    resources: Constants.DEPLOYMENT_RESOURCES,
  }),
};

export const ensureDeploymentFoundation = Foundation.ensureDeploymentFoundation;
export const ensureDeploymentFoundationAsync = Foundation.ensureDeploymentFoundationAsync;
export const deploymentHealth = Foundation.deploymentHealth;
export const deploymentHealthAsync = Foundation.deploymentHealthAsync;

// Named exports for the few consumers that need a single function (the
// `requireFeature` middleware resolves entitlements directly).
export const isFeatureEnabled = Features.isFeatureEnabled;
export const resolveCapabilities = Features.resolveCapabilities;
export const resolveCapabilitiesAsync = Features.resolveCapabilitiesAsync;

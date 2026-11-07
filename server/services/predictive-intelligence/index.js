// Public facade for the Predictive Intelligence & Recommendations layer
// (Stage 10). Every consumer (API layer, other domains, jobs) depends on this
// file rather than the internal layout so the implementation can evolve safely.
// Databases are always passed first so a call can participate in the caller's
// transaction (mirrors manufacturing-quality/index.js).
import * as Constants from "./constants.js";
import * as Errors from "./errors.js";
import * as Refs from "./refs.js";
import * as Configuration from "./configuration.js";
import * as Events from "./events.js";
import * as Security from "./security.js";
import * as Subjects from "./subjects.js";
import * as UseCases from "./use-cases.js";
import * as Assessment from "./assessment.js";
import * as Predictions from "./predictions.js";
import * as Recommendations from "./recommendations.js";
import * as Monitoring from "./monitoring.js";
import * as Foundation from "./foundation.js";

export {
  Constants,
  Errors,
  Refs,
  Configuration,
  Events,
  Security,
  Subjects,
  UseCases,
  Assessment,
  Predictions,
  Recommendations,
  Monitoring,
  Foundation,
};

export * from "./constants.js";
export * from "./errors.js";
export {
  configKey,
  getConfig,
  getConfigAsync,
  listConfig,
  listConfigAsync,
  describeConfig,
  setConfig,
  configCatalog,
  ensurePredictiveConfig,
  ensurePredictiveConfigAsync,
} from "./configuration.js";
export {
  ensurePredictiveEventTypes,
  ensurePredictiveEventTypesAsync,
  publishPredictiveEvent,
  publishPredictiveEventAsync,
} from "./events.js";
export { normalizeSubjectType, resolveSubject, resolveSubjectAsync } from "./subjects.js";
export {
  publicUseCase,
  listUseCases,
  listUseCasesAsync,
  getUseCase,
  getUseCaseAsync,
  createUseCase,
  createUseCaseAsync,
  updateUseCase,
  updateUseCaseAsync,
  getUseCaseRow,
  getUseCaseRowAsync,
  requireUseCaseRow,
  requireUseCaseRowAsync,
  ensureBuiltInUseCases,
  ensureBuiltInUseCasesAsync,
  builtInCatalog,
} from "./use-cases.js";
export { assessUseCase, assessUseCaseAsync, assessmentMeta } from "./assessment.js";
export {
  publicPrediction,
  predictionAvailable,
  listPredictions,
  listPredictionsAsync,
  getPrediction,
  getPredictionAsync,
  getPredictionRow,
  getPredictionRowAsync,
  requirePredictionRow,
  requirePredictionRowAsync,
  executePrediction,
  executePredictionAsync,
  markPredictionStale,
  markPredictionStaleAsync,
  recordPredictionFeedback,
  recordPredictionFeedbackAsync,
} from "./predictions.js";
export {
  publicRecommendation,
  listRecommendations,
  listRecommendationsAsync,
  getRecommendation,
  getRecommendationAsync,
  getRecommendationRow,
  getRecommendationRowAsync,
  requireRecommendationRow,
  requireRecommendationRowAsync,
  createRecommendation,
  createRecommendationAsync,
  transitionRecommendation,
  transitionRecommendationAsync,
  generateRecommendations,
  generateRecommendationsAsync,
} from "./recommendations.js";
export {
  publicEvaluation,
  listEvaluations,
  listEvaluationsAsync,
  createEvaluation,
  createEvaluationAsync,
  modelStatus,
  modelStatusAsync,
  monitoringSummary,
  monitoringSummaryAsync,
  predictionsHealth,
  predictionsHealthAsync,
} from "./monitoring.js";
export { ensurePredictiveFoundation, ensurePredictiveFoundationAsync } from "./foundation.js";

// Vocabulary, defaults and platform wiring codes for the Predictive
// Intelligence & Recommendations layer (Stage 10).
//
// This is a governance layer, not a second analytics stack. It composes the
// authoritative data produced by the Object framework, the Digital Thread, the
// BOM engine and the Manufacturing & Quality layer, and it reuses the platform
// configuration store, audit trail, event framework and IAM. Every stored
// result records the METHOD and VERSION that produced it so a deterministic rule
// assessment can never be presented as a validated ML prediction (prompt §7.1).
export const SOURCE_MODULE = "predictive-intelligence";

// Result-generation methods. Kept deliberately explicit so frontends can label
// facts, rule results, statistical estimates, ML predictions and LLM
// explanations differently.
export const METHODS = Object.freeze({
  RULE_BASED: "RULE_BASED",
  STATISTICAL: "STATISTICAL",
  ML: "ML",
  LLM_EXPLANATION: "LLM_EXPLANATION",
});

export const METHOD_VALUES = Object.freeze(Object.values(METHODS));
export const METHOD_LABELS = Object.freeze({
  RULE_BASED: "Deterministic rule assessment",
  STATISTICAL: "Statistical estimate",
  ML: "Machine-learning prediction",
  LLM_EXPLANATION: "LLM-generated explanation",
});

export const PROBLEM_TYPES = Object.freeze(["classification", "regression", "ranking"]);
export const USE_CASE_STATUSES = Object.freeze(["ACTIVE", "INACTIVE", "DEPRECATED"]);

export const RISK_CATEGORIES = Object.freeze(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const RISK_ORDER = Object.freeze({ UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 });

export const PREDICTION_STATUSES = Object.freeze(["ACTIVE", "STALE", "SUPERSEDED"]);

export const RECOMMENDATION_STATUSES = Object.freeze([
  "GENERATED",
  "PRESENTED",
  "ACCEPTED",
  "REJECTED",
  "DISMISSED",
  "EXECUTED",
  "OUTCOME_RECORDED",
]);

// Recommendations never mutate authoritative objects. `EXECUTED` records that a
// human carried out the action through the owning module's authorised workflow;
// it is not performed by this layer (prompt §7.4).
export const RECOMMENDATION_TRANSITIONS = Object.freeze({
  GENERATED: Object.freeze(["PRESENTED", "ACCEPTED", "REJECTED", "DISMISSED"]),
  PRESENTED: Object.freeze(["ACCEPTED", "REJECTED", "DISMISSED"]),
  ACCEPTED: Object.freeze(["EXECUTED", "DISMISSED"]),
  EXECUTED: Object.freeze(["OUTCOME_RECORDED"]),
  REJECTED: Object.freeze([]),
  DISMISSED: Object.freeze([]),
  OUTCOME_RECORDED: Object.freeze([]),
});

export const TERMINAL_RECOMMENDATION_STATUSES = Object.freeze(["REJECTED", "DISMISSED", "OUTCOME_RECORDED"]);

// ── Built-in use cases ───────────────────────────────────────────────────────
//
// Each use case is registered as data, not hard-coded logic, so an operator can
// inspect it through the API and (later) attach a validated ML model to the same
// stable code. The deterministic assessment functions below are the rule-based
// implementations available today.
export const BUILT_IN_USE_CASES = Object.freeze([
  {
    code: "ENGINEERING_CHANGE_RISK",
    name: "Engineering change risk",
    description: "Estimates the risk of a proposed engineering change from impact breadth, quality history, readiness failures and missing dependencies.",
    problem_type: "classification",
    method: METHODS.RULE_BASED,
    ruleset_version: "ecr-rules-v1",
    feature_schema_json: "{\"affected_items\":\"number\",\"impacted_objects\":\"number\",\"open_quality_issues\":\"number\",\"failed_readiness\":\"number\",\"missing_dependencies\":\"number\"}",
    min_data_volume: 0,
  },
  {
    code: "MANUFACTURING_READINESS_RISK",
    name: "Manufacturing readiness risk",
    description: "Identifies likely manufacturing-readiness problems from the authoritative readiness checks (missing MBOM/BOP, operations, work instructions).",
    problem_type: "classification",
    method: METHODS.RULE_BASED,
    ruleset_version: "mrr-rules-v1",
    feature_schema_json: "{\"mbom_present\":\"boolean\",\"bop_present\":\"boolean\",\"operations\":\"number\",\"operations_with_work_instructions\":\"number\",\"open_critical_issues\":\"number\"}",
    min_data_volume: 0,
  },
  {
    code: "QUALITY_RISK",
    name: "Quality risk",
    description: "Estimates quality risk for a product or operation from recorded issues, inspection outcomes and recurrence patterns.",
    problem_type: "classification",
    method: METHODS.RULE_BASED,
    ruleset_version: "qr-rules-v1",
    feature_schema_json: "{\"open_issues\":\"number\",\"critical_issues\":\"number\",\"failed_inspections\":\"number\",\"recurrence_count\":\"number\",\"open_corrective_actions\":\"number\"}",
    min_data_volume: 0,
  },
  {
    code: "DELIVERY_SCHEDULE_RISK",
    name: "Schedule / delivery risk",
    description: "Schedule risk is only produced when real schedule, duration, dependency and historical outcome data is available.",
    problem_type: "classification",
    method: METHODS.RULE_BASED,
    ruleset_version: "dsr-rules-v1",
    feature_schema_json: "{\"planned_duration\":\"number\",\"remaining_duration\":\"number\",\"dependency_depth\":\"number\",\"historical_slip_days\":\"number\"}",
    min_data_volume: 0,
  },
]);

export const USE_CASE_CODES = Object.freeze(BUILT_IN_USE_CASES.map((entry) => entry.code));

export const SUBJECT_TYPES = Object.freeze({
  PRODUCT_REVISION: "PRODUCT_REVISION",
  CHANGE: "CHANGE",
  OPERATION: "OPERATION",
  MBOM_REVISION: "MBOM_REVISION",
});

export const SUBJECT_TYPE_VALUES = Object.freeze(Object.values(SUBJECT_TYPES));

// Dataset requirements published when a model cannot be enabled. These are
// exposed on the API so an operator knows exactly what is missing (prompt §7.3).
export const DATASET_REQUIREMENTS = Object.freeze({
  ML_MIN_LABELLED_OUTCOMES: "At least 50 labelled historical outcomes for this use case and subject class.",
  ML_HOLDOUT: "A temporally separated holdout set (no future information leakage).",
  ML_METRICS: "Measured classification or regression metrics on the holdout set.",
  ML_BASELINE: "A recorded baseline comparison (for example the deterministic rule result).",
  ML_CALIBRATION: "Calibration checks for reported probabilities.",
  SCHEDULE_DATA: "Real schedule, duration, dependency and historical outcome data is required before schedule risk can be produced.",
});

// ── IAM resources ────────────────────────────────────────────────────────────

export const PREDICTIVE_RESOURCES = Object.freeze({
  module: "iam.predictive-intelligence",
  overview: "iam.predictive-intelligence.overview",
  useCases: "iam.predictive-intelligence.use-cases",
  predictions: "iam.predictive-intelligence.predictions",
  explanations: "iam.predictive-intelligence.explanations",
  recommendations: "iam.predictive-intelligence.recommendations",
  feedback: "iam.predictive-intelligence.feedback",
  evaluations: "iam.predictive-intelligence.evaluations",
  monitoring: "iam.predictive-intelligence.monitoring",
  admin: "iam.predictive-intelligence.admin",
});

export const PREDICTIVE_SECURITY_ACTIONS = Object.freeze([
  "VIEW_PREDICTIVE_INTELLIGENCE",
  "REQUEST_PREDICTION",
  "REGISTER_PREDICTION_USE_CASE",
  "EVALUATE_PREDICTION_MODEL",
  "MANAGE_RECOMMENDATION",
  "RECORD_PREDICTION_FEEDBACK",
  "CONFIGURE_PREDICTIVE_INTELLIGENCE",
]);

// ── Domain events ────────────────────────────────────────────────────────────

export const PREDICTIVE_EVENT_TYPES = Object.freeze([
  { code: "PredictionExecuted", description: "A prediction or rule-based assessment was produced." },
  { code: "PredictionStale", description: "A prediction became stale after expiry or a source change." },
  { code: "PredictionSuperseded", description: "A prediction was superseded by a newer result." },
  { code: "PredictionModelEvaluated", description: "A model evaluation was recorded." },
  { code: "RecommendationGenerated", description: "A recommendation was generated from observed evidence." },
  { code: "RecommendationStatusChanged", description: "A recommendation changed lifecycle status." },
  { code: "RecommendationOutcomeRecorded", description: "The measured outcome of an executed recommendation was recorded." },
]);

export const PREDICTIVE_EVENT_MAP = Object.freeze({
  PREDICTION_EXECUTED: "PredictionExecuted",
  PREDICTION_STALE: "PredictionStale",
  PREDICTION_SUPERSEDED: "PredictionSuperseded",
  MODEL_EVALUATED: "PredictionModelEvaluated",
  RECOMMENDATION_GENERATED: "RecommendationGenerated",
  RECOMMENDATION_STATUS_CHANGED: "RecommendationStatusChanged",
  RECOMMENDATION_OUTCOME_RECORDED: "RecommendationOutcomeRecorded",
});

// ── Configuration keys ───────────────────────────────────────────────────────

export const CONFIG_PREFIX = "predictive_intelligence.";

export const CONFIG_KEYS = Object.freeze({
  predictionTtlHours: "predictive_intelligence.prediction_ttl_hours",
  minDataVolume: "predictive_intelligence.min_data_volume",
  riskHighThreshold: "predictive_intelligence.risk_high_threshold",
  riskCriticalThreshold: "predictive_intelligence.risk_critical_threshold",
  maxRecommendations: "predictive_intelligence.max_recommendations",
  staleOnSourceChange: "predictive_intelligence.stale_on_source_change",
  driftAlertRatio: "predictive_intelligence.drift_alert_ratio",
});

export const CONFIG_DEFAULTS = Object.freeze({
  prediction_ttl_hours: 168,
  min_data_volume: 50,
  risk_high_threshold: 60,
  risk_critical_threshold: 80,
  max_recommendations: 10,
  stale_on_source_change: true,
  drift_alert_ratio: 0.1,
});

export const CONFIG_BOUNDS = Object.freeze({
  prediction_ttl_hours: { min: 1, max: 8760 },
  min_data_volume: { min: 0, max: 1000000 },
  risk_high_threshold: { min: 1, max: 100 },
  risk_critical_threshold: { min: 1, max: 100 },
  max_recommendations: { min: 1, max: 100 },
  drift_alert_ratio: { min: 0, max: 1 },
});

export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 100;

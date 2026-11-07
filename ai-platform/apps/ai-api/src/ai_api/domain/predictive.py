"""Predictive intelligence domain vocabulary (Stage 10 / Step 8).

Pure data, no behaviour. This vocabulary mirrors the existing enterprise
predictive-intelligence engine so the AI platform speaks the same language as
the system of record, while remaining explicit about *what kind* of answer a
result is.

The central rule from the specification: a prediction is never presented as a
confirmed fact. Every result records the ``method`` that produced it — a
deterministic ``rule_based`` score, a ``statistical`` estimate, a supervised
``ml`` prediction, or an ``llm_explanation`` — plus the strategy/ruleset
version and an explicit ``insufficient_data`` status when the evidence does not
support a score.
"""

from __future__ import annotations

# --- Prediction methods ---------------------------------------------------
# Deliberately explicit so a rule result can never be relabelled as a validated
# ML prediction in the UI or API.
METHODS: tuple[str, ...] = (
    "rule_based",
    "statistical",
    "ml",
    "llm_explanation",
)

METHOD_LABELS: dict[str, str] = {
    "rule_based": "Deterministic rule assessment",
    "statistical": "Statistical estimate",
    "ml": "Machine-learning prediction",
    "llm_explanation": "LLM-generated explanation",
}

# --- Risk vocabulary ------------------------------------------------------
RISK_CATEGORIES: tuple[str, ...] = (
    "unknown",
    "low",
    "medium",
    "high",
    "critical",
)

RISK_ORDER: dict[str, int] = {
    "unknown": 0,
    "low": 1,
    "medium": 2,
    "high": 3,
    "critical": 4,
}

PREDICTION_STATUSES: tuple[str, ...] = (
    "active",
    "stale",
    "superseded",
    "insufficient_data",
)

# A prediction is only usable while active and inside its freshness window.
USABLE_PREDICTION_STATUSES: frozenset[str] = frozenset({"active"})

# --- Prediction types -----------------------------------------------------
PREDICTION_TYPES: tuple[str, ...] = (
    "defect_risk",
    "repeat_nonconformance_risk",
    "part_quality_risk",
    "supplier_quality_risk",
    "plant_quality_risk",
    "work_centre_quality_risk",
    "capa_overdue_risk",
    "capa_effectiveness",
    "quality_anomaly",
    "process_deviation_risk",
    "operation_quality_risk",
    "work_centre_bottleneck",
    "manufacturing_anomaly",
    "production_trend",
    "resource_risk",
    "bom_inconsistency_risk",
    "product_completeness_risk",
    "component_obsolescence_risk",
    "change_impact_risk",
    "downstream_manufacturing_risk",
    "component_issue_risk",
    "product_quality_exposure",
)

SUBJECT_TYPES: tuple[str, ...] = (
    "product_item",
    "product_revision",
    "bom_header",
    "plant",
    "work_centre",
    "process",
    "operation",
    "quality_issue",
    "supplier",
    "change",
    "component",
)

# --- Feature / dataset / model lifecycle ---------------------------------
FEATURE_DATA_TYPES: tuple[str, ...] = ("number", "boolean", "string", "json")

FEATURE_LIFECYCLE_STATES: tuple[str, ...] = ("active", "deprecated", "archived")

DATASET_LIFECYCLE_STATES: tuple[str, ...] = ("draft", "ready", "archived")
DATASET_SPLITS: tuple[str, ...] = ("train", "eval", "holdout")

MODEL_LIFECYCLE_STATES: tuple[str, ...] = (
    "draft",
    "active",
    "deprecated",
    "retired",
)

MODEL_LIFECYCLE_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "draft": ("active", "retired"),
    "active": ("deprecated", "retired"),
    "deprecated": ("retired", "active"),
    "retired": (),
}

# --- Recommendation lifecycle --------------------------------------------
RECOMMENDATION_STATUSES: tuple[str, ...] = (
    "new",
    "under_review",
    "accepted",
    "rejected",
    "deferred",
    "completed",
    "cancelled",
)

RECOMMENDATION_STATUS_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "new": ("under_review", "accepted", "rejected", "deferred", "cancelled"),
    "under_review": ("accepted", "rejected", "deferred", "cancelled"),
    "accepted": ("completed", "deferred", "cancelled"),
    "deferred": ("under_review", "accepted", "rejected", "cancelled"),
    "rejected": (),
    "completed": (),
    "cancelled": (),
}

# States in which a recommendation is still actionable.
OPEN_RECOMMENDATION_STATUSES: frozenset[str] = frozenset(
    {"new", "under_review", "accepted", "deferred"}
)
TERMINAL_RECOMMENDATION_STATUSES: frozenset[str] = frozenset(
    {"rejected", "completed", "cancelled"}
)

RECOMMENDATION_SEVERITIES: tuple[str, ...] = (
    "unknown",
    "low",
    "medium",
    "high",
    "critical",
)

RECOMMENDATION_FEEDBACK_DECISIONS: tuple[str, ...] = (
    "accept",
    "reject",
    "defer",
    "complete",
    "comment",
)

# --- Bounds ---------------------------------------------------------------
MAX_FEATURE_ROWS = 2_000
MAX_PREDICTION_ROWS = 2_000
MAX_RECOMMENDATION_ROWS = 1_000
MAX_EVIDENCE_ITEMS = 100
MAX_ANALYTICS_ROWS = 2_000
DEFAULT_FRESHNESS_TTL_HOURS = 168
DEFAULT_OBSERVATION_WINDOW_DAYS = 90
DEFAULT_MAX_RECOMMENDATIONS = 10

# --- Graph entity type per kind ------------------------------------------
GRAPH_TYPE_BY_KIND: dict[str, str] = {
    "prediction": "prediction",
    "recommendation": "recommendation",
}


def normalise_key(value: str) -> str:
    """Stable, case/space-insensitive identity key."""

    return " ".join(str(value or "").split()).strip().lower()


def normalise_choice(value: str) -> str:
    return str(value or "").strip().lower()


def is_transition_allowed(
    transitions: dict[str, tuple[str, ...]], current: str, target: str
) -> bool:
    if current == target:
        return True
    return target in transitions.get(current, ())


def risk_category_for_score(
    score: float | None,
    *,
    high_threshold: float = 60.0,
    critical_threshold: float = 80.0,
) -> str:
    """Bucket a bounded 0-100 score, but never invent a category without data."""

    if score is None:
        return "unknown"
    if score >= critical_threshold:
        return "critical"
    if score >= high_threshold:
        return "high"
    if score >= 40.0:
        return "medium"
    if score > 0.0:
        return "low"
    return "low"


def worst_risk(*categories: str) -> str:
    best = "unknown"
    for value in categories:
        if value in RISK_ORDER and RISK_ORDER[value] > RISK_ORDER.get(best, -1):
            best = value
    return best

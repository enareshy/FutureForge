"""Quality domain vocabulary (Stage 9 / Step 7).

Pure data, no behaviour. The vocabulary mirrors the existing enterprise quality
engine (quality issues, inspections, CAPA) so the AI platform speaks the same
language as the system of record.

Quality records are separate rows that *link* to knowledge graph entities
through `graph_entity_id`; the services create/update the graph entity
alongside but never duplicate the graph model.
"""

from __future__ import annotations

# --- Issue lifecycle ------------------------------------------------------
ISSUE_TYPES: tuple[str, ...] = (
    "nonconformance",
    "deviation",
    "complaint",
    "defect",
    "observation",
)

ISSUE_SEVERITIES: tuple[str, ...] = ("low", "medium", "high", "critical")

ISSUE_STATUSES: tuple[str, ...] = (
    "open",
    "investigating",
    "contained",
    "resolved",
    "closed",
    "cancelled",
)

ISSUE_STATUS_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "open": ("investigating", "contained", "resolved", "cancelled"),
    "investigating": ("contained", "resolved", "cancelled"),
    "contained": ("investigating", "resolved", "cancelled"),
    "resolved": ("closed", "investigating"),
    "closed": (),
    "cancelled": (),
}

ACTIVE_ISSUE_STATUSES: frozenset[str] = frozenset({"open", "investigating", "contained"})
CLOSED_ISSUE_STATUSES: frozenset[str] = frozenset({"resolved", "closed"})

ISSUE_DISPOSITIONS: tuple[str, ...] = (
    "none",
    "use_as_is",
    "rework",
    "repair",
    "scrap",
    "return_to_supplier",
    "sort",
)

ROOT_CAUSE_STATUSES: tuple[str, ...] = (
    "not_investigated",
    "hypothesis",
    "confirmed",
)

ROOT_CAUSE_CLASSIFICATIONS: tuple[str, ...] = (
    "design",
    "material",
    "process",
    "machine",
    "human",
    "measurement",
    "environment",
    "supplier",
    "other",
)

# --- Inspection -----------------------------------------------------------
INSPECTION_TYPES: tuple[str, ...] = (
    "incoming",
    "in_process",
    "final",
    "audit",
    "supplier",
    "periodic",
)

INSPECTION_STATUSES: tuple[str, ...] = (
    "planned",
    "in_progress",
    "passed",
    "failed",
    "waived",
    "cancelled",
)

TERMINAL_INSPECTION_STATUSES: frozenset[str] = frozenset(
    {"passed", "failed", "waived", "cancelled"}
)

INSPECTION_STATUS_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "planned": ("in_progress", "passed", "failed", "waived", "cancelled"),
    "in_progress": ("passed", "failed", "waived", "cancelled"),
    "passed": (),
    "failed": ("in_progress", "waived", "cancelled"),
    "waived": (),
    "cancelled": (),
}

RESULT_STATUSES: tuple[str, ...] = ("pass", "fail", "unknown", "waived")

# --- CAPA -----------------------------------------------------------------
ACTION_TYPES: tuple[str, ...] = ("corrective", "preventive", "containment")

ACTION_STATUSES: tuple[str, ...] = (
    "open",
    "in_progress",
    "implemented",
    "verified",
    "closed",
    "cancelled",
)

ACTION_STATUS_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "open": ("in_progress", "implemented", "closed", "cancelled"),
    "in_progress": ("implemented", "closed", "cancelled"),
    "implemented": ("verified", "closed", "cancelled"),
    "verified": ("closed",),
    "closed": (),
    "cancelled": (),
}

OPEN_ACTION_STATUSES: frozenset[str] = frozenset({"open", "in_progress"})

ACTION_EFFECTIVENESS: tuple[str, ...] = ("pending", "effective", "not_effective")

# --- Analytics / intelligence -------------------------------------------
# Similarity is advisory; repeat detection is a heuristic that always reports
# its reason rather than silently asserting a confirmed duplicate.
REPEAT_WINDOW_DAYS_DEFAULT = 90
MAX_REPEAT_GROUPS = 200
MAX_ANALYTICS_ROWS = 2_000

# Graph entity type for each quality record kind.
GRAPH_TYPE_BY_KIND: dict[str, str] = {
    "issue": "quality_issue",
    "nonconformance": "nonconformance",
    "inspection": "quality_issue",
    "action": "corrective_action",
}


def normalise_key(value: str) -> str:
    """Stable, case/space-insensitive identity key for quality records."""

    return " ".join(str(value or "").split()).strip().lower()


def normalise_issue_key(value: str) -> str:
    """Issue numbers are compared without surrounding/interior whitespace."""

    return " ".join(str(value or "").split()).strip().upper()


def normalise_choice(value: str) -> str:
    return str(value or "").strip().lower()


def is_transition_allowed(
    transitions: dict[str, tuple[str, ...]], current: str, target: str
) -> bool:
    if current == target:
        return True
    return target in transitions.get(current, ())

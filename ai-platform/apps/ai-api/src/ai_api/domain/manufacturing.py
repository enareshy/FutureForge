"""Manufacturing domain vocabulary (Stage 9 / Step 7).

Pure data, no behaviour. The vocabulary mirrors the existing enterprise
manufacturing engine so the AI platform speaks the same language as the system
of record, and the services never hardcode values an administrator could tune.

Manufacturing structure records are separate rows that *link* to knowledge graph
entities through `graph_entity_id`. The services create/update the graph entity
alongside, but never duplicate the graph model; process structure is stored only
here.
"""

from __future__ import annotations

from dataclasses import dataclass

# --- Lifecycle ------------------------------------------------------------
STRUCTURE_LIFECYCLE_STATES: tuple[str, ...] = (
    "draft",
    "active",
    "released",
    "obsolete",
    "archived",
)

STRUCTURE_LIFECYCLE_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "draft": ("active", "obsolete"),
    "active": ("released", "obsolete"),
    "released": ("obsolete",),
    "obsolete": ("archived",),
    "archived": (),
}

PROCESS_LIFECYCLE_STATES: tuple[str, ...] = (
    "draft",
    "in_review",
    "released",
    "superseded",
    "obsolete",
    "archived",
)

PROCESS_LIFECYCLE_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "draft": ("in_review", "obsolete"),
    "in_review": ("draft", "released", "obsolete"),
    "released": ("superseded", "obsolete"),
    "superseded": ("obsolete",),
    "obsolete": ("archived",),
    "archived": (),
}

IMMUTABLE_PROCESS_STATES: frozenset[str] = frozenset(
    {"superseded", "obsolete", "archived"}
)

# --- Manufacturing vocabulary --------------------------------------------
PROCESS_TYPES: tuple[str, ...] = (
    "assembly",
    "machining",
    "fabrication",
    "test",
    "packaging",
    "other",
)

WORK_CENTRE_TYPES: tuple[str, ...] = (
    "assembly",
    "machining",
    "fabrication",
    "test",
    "packaging",
    "other",
)

OPERATION_TYPES: tuple[str, ...] = (
    "value_add",
    "setup",
    "inspection",
    "transport",
    "storage",
    "rework",
    "other",
)

DEPENDENCY_TYPES: tuple[str, ...] = (
    "finish_to_start",
    "start_to_start",
    "finish_to_finish",
    "start_to_finish",
)

CONSUMPTION_TYPES: tuple[str, ...] = (
    "component",
    "material",
    "consumable",
    "tooling",
)

INSTRUCTION_TYPES: tuple[str, ...] = ("text", "visual", "video", "checklist")

RESOURCE_KINDS: tuple[str, ...] = (
    "tooling",
    "equipment",
    "fixture",
    "gauge",
    "machine",
    "other",
)

# Graph entity type for each manufacturing record kind.
GRAPH_TYPE_BY_KIND: dict[str, str] = {
    "plant": "plant",
    "line": "plant",
    "work_centre": "work_center",
    "process": "manufacturing_process",
    "revision": "manufacturing_process",
    "operation": "operation",
    "instruction": "work_instruction",
    "resource": "operation",
    "production_version": "manufacturing_process",
}

# Safe recursion / result bounds for traversal and analytics.
MAX_PROCESS_DEPTH = 20
MAX_OPERATIONS = 5_000
MAX_STRUCTURE_ROWS = 5_000
MAX_INTELLIGENCE_ROWS = 2_000


@dataclass(frozen=True, slots=True)
class OperationSequence:
    """Canonical ordering key for an operation within a process."""

    sequence: int
    operation_key: str


def normalise_key(value: str) -> str:
    """Stable, case/space-insensitive identity key for manufacturing records."""

    return " ".join(str(value or "").split()).strip().lower()


def normalise_process_key(value: str) -> str:
    """Process numbers are compared without surrounding/interior whitespace."""

    return " ".join(str(value or "").split()).strip().upper()


def normalise_revision(value: str) -> str:
    return str(value or "").strip().upper()


def normalise_choice(value: str) -> str:
    return str(value or "").strip().lower()


def is_transition_allowed(
    transitions: dict[str, tuple[str, ...]], current: str, target: str
) -> bool:
    if current == target:
        return True
    return target in transitions.get(current, ())


def operation_sort_key(operation: dict) -> tuple[int, str]:
    return (int(operation.get("sequence") or 0), str(operation.get("operation_key") or ""))
